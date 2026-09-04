// TypTap multiplayer — realtime hub (WebSocket).
//
// Транспорт: ws на тому ж http.Server, шлях /ws (клієнт стукає у /api/ws,
// Caddy зрізає /api). Стан — у памяті одного процесу api (деплой однопроцесний,
// цього достатньо). Сервер авторитетний за: текст гонки, час старту, рух ботів
// і фінальний рейтинг. Клієнти лише шлють свій прогрес набору.
//
// Ідентифікація — тільки за ніком (як і решта застосунку). Це свідомий
// компроміс: нік можна підмінити, але для дитячого тренажера цього досить.

const { WebSocketServer } = require('ws');
const { pickText } = require('./texts');

const MAX_PLAYERS = 8;         // жорсткий стеля розміру кімнати (розмір кімнати обирає хост: 2..8)
const RACE_DUR = 60;           // секунд
const TICK_MS = 250;           // 4 рази/сек — і бордова стрічка, і рух ботів
const HEARTBEAT_MS = 25000;    // пінг, щоб ловити мертві зʼєднання (і не давати nginx закрити idle)
const GRACE_MS = 15000;        // скільки тримати гравця в кімнаті після обриву звʼязку (reconnect)
const MAX_CPM = 600;           // стеля відображуваного CPM
const MAX_CPS = 12;            // правдоподібна стеля швидкості (симв/с) — анти-чит
const PRESENCE_MAX = 60;       // скільки онлайн-гравців віддаємо у список
const MAX_CONN_PER_IP = 8;     // ліміт одночасних зʼєднань з одного IP (за X-Forwarded-For)
const ANIMALS = ['Hippo','Cat','Chick','Bunny','Mouse','Bear','Dog','Fish','Snake','Monkey'];
const BOT_NAMES = ['Max','Nina','Leo','Kira','Sam','Zoe','Rex','Mia','Tom','Eva'];
// Ігри, доступні в мультиплеєрі. 'race' — чесна гонка одним текстом (сервер
// шле однаковий текст усім). Решта — міні-ігри: кожен грає свою партію, рейтинг
// за кількістю натиснень (швидкість друку). Клієнт вміє запускати всі ці id.
const MP_GAMES = ['race','falling','boss','combo','defense','balloon','climber','piano','maze','horde','flash','cipher','chain','garden','ladder'];
const BOT_TIERS = { easy: [24, 52], medium: [40, 82], hard: [70, 112] };
const NONTEXT_CAP = (RACE_DUR / 60) * 180; // умовна «повна» шкала прогресу для міні-ігор
const REACTIONS = ['👍','😂','🔥','😮','😅','🎉','💪','🐢'];

// ---------- дрібні утиліти ----------

function normNick(raw) {
  if (typeof raw !== 'string') return null;
  const n = raw.trim().slice(0, 20);
  return n.length ? n : null;
}
function normAnimal(raw) { return ANIMALS.includes(raw) ? raw : 'Cat'; }
function clampNum(v, min, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}
let _seq = 0;
function genId(prefix) { _seq += 1; return prefix + Date.now().toString(36) + '-' + _seq.toString(36); }
function send(ws, type, payload) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(Object.assign({ type }, payload))); } catch (_) {}
}
function clientIp(req) {
  const xff = req && req.headers && req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim();
  return (req && req.socket && req.socket.remoteAddress) || 'unknown';
}

// ---------- хаб ----------

function attach(server, opts) {
  opts = opts || {};
  // Дозволені Origin: за замовчуванням той самий хост, що й запит, або список із
  // env TYPTAP_WS_ORIGINS (через кому). Запити без Origin (не-браузер) пропускаємо.
  let _ao = opts.allowOrigins || process.env.TYPTAP_WS_ORIGINS || [];
  if (typeof _ao === 'string') _ao = _ao.split(',');
  const allowOrigins = _ao.map(s => String(s).trim().toLowerCase()).filter(Boolean);
  function originOk(req) {
    const origin = req.headers && req.headers.origin;
    if (!origin) return true; // не-браузерний клієнт (тести/скрипти)
    let host = '';
    try { host = new URL(origin).host.toLowerCase(); } catch (_) { return false; }
    if (host === String(req.headers.host || '').toLowerCase()) return true;
    return allowOrigins.includes(host) || allowOrigins.includes(origin.toLowerCase());
  }

  const ipCounts = new Map();
  const wss = new WebSocketServer({
    server, path: '/ws',
    verifyClient: (info, cb) => {
      if (!originOk(info.req)) return cb(false, 403, 'forbidden origin');
      const ip = clientIp(info.req);
      const n = ipCounts.get(ip) || 0;
      if (n >= MAX_CONN_PER_IP) return cb(false, 429, 'too many connections');
      cb(true);
    },
  });

  const clients = new Map();   // connId -> client
  const rooms = new Map();     // roomId -> room
  const codeIndex = new Map(); // CODE -> roomId
  let waiting = [];            // connId[] у черзі quick-match

  // --- присутність ---
  let presenceTimer = null;
  function schedulePresence() {
    if (presenceTimer) return;
    presenceTimer = setTimeout(() => { presenceTimer = null; broadcastPresence(); }, 200);
  }
  function presenceList() {
    const byNick = new Map(); // дедуп за ніком: остання жива вкладка перемагає
    for (const c of clients.values()) {
      if (!c.nickname) continue;
      byNick.set(c.nickname, { nickname: c.nickname, animal: c.animal, bestWpm: c.bestWpm || 0, busy: !!c.roomId });
    }
    return Array.from(byNick.values()).slice(0, PRESENCE_MAX);
  }
  function isRacingClient(c) {
    const room = c.roomId && rooms.get(c.roomId);
    return !!(room && (room.state === 'racing' || room.state === 'countdown'));
  }
  function broadcastPresence() {
    const users = presenceList();
    for (const c of clients.values()) {
      if (!c.nickname) continue;
      if (isRacingClient(c)) continue; // під час гонки список онлайн не потрібен
      send(c.ws, 'presence', { users });
    }
  }

  // --- кімнати ---
  function genCode() {
    const A = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    let code;
    do { code = ''; for (let i = 0; i < 4; i++) code += A[Math.floor(Math.random() * A.length)]; }
    while (codeIndex.has(code));
    return code;
  }
  function capacity(room) { return Math.min(MAX_PLAYERS, (room.settings && room.settings.maxPlayers) || MAX_PLAYERS); }
  function roomView(room) {
    return {
      id: room.id, code: room.code, hostConnId: room.hostConnId,
      settings: room.settings, state: room.state, count: room.players.length, max: capacity(room),
      players: room.players.map(p => ({
        connId: p.connId, nickname: p.nickname, animal: p.animal,
        ready: p.ready, isBot: p.isBot, isHost: p.connId === room.hostConnId, disconnected: !!p.disconnected,
      })),
    };
  }
  function pushRoom(room) {
    const view = roomView(room);
    for (const p of room.players) {
      if (p.isBot || p.disconnected) continue;
      const c = clients.get(p.connId);
      if (c) send(c.ws, 'room:state', { room: view });
    }
  }
  function newPlayer(c, extra) {
    return Object.assign({
      connId: c ? c.connId : genId('bot-'),
      nickname: c ? c.nickname : '', animal: c ? c.animal : 'Cat',
      ready: false, isBot: false, correct: 0, total: 0, cpm: 0,
      finished: false, finishAt: 0, disconnected: false, dcTimer: null,
    }, extra || {});
  }
  function cancelCountdown(room) {
    if (room.cdTimer) { clearInterval(room.cdTimer); room.cdTimer = null; }
    if (room.state === 'countdown') {
      room.state = 'lobby';
      for (const p of room.players) { if (!p.isBot) p.ready = false; }
      for (const p of room.players) { if (!p.isBot && !p.disconnected) { const c = clients.get(p.connId); if (c) send(c.ws, 'countdown:cancel', {}); } }
      pushRoom(room);
    }
  }
  // remove — повне видалення гравця (вихід/кінець грейсу)
  function removePlayer(room, connId, opts) {
    const p = room.players.find(x => x.connId === connId);
    if (p && p.dcTimer) { clearTimeout(p.dcTimer); p.dcTimer = null; }
    room.players = room.players.filter(x => x.connId !== connId);
    const humans = room.players.filter(x => !x.isBot);
    if (!humans.length) { destroyRoom(room); return; }
    if (room.hostConnId === connId) room.hostConnId = humans[0].connId;
    if (room.state === 'countdown' && room.players.length < 2) cancelCountdown(room);
    if (room.state === 'racing') maybeFinish(room);
    if (!(opts && opts.silent)) pushRoom(room);
  }
  function leaveRoom(c, opts) {
    const room = c.roomId && rooms.get(c.roomId);
    c.roomId = null;
    if (!room) return;
    removePlayer(room, c.connId, opts);
  }
  function destroyRoom(room) {
    if (room.tick) clearInterval(room.tick);
    if (room.cdTimer) clearInterval(room.cdTimer);
    room.players.forEach(p => { if (p.dcTimer) clearTimeout(p.dcTimer); });
    codeIndex.delete(room.code);
    rooms.delete(room.id);
  }

  // --- старт/гонка ---
  function maybeStart(room) {
    if (room.state !== 'lobby') return;
    const humans = room.players.filter(p => !p.isBot);
    if (room.players.length < 2) return;
    if (!humans.length || !humans.every(p => p.ready)) return;
    startCountdown(room);
  }
  function startCountdown(room) {
    room.state = 'countdown';
    let n = 3;
    pushRoom(room);
    const emit = () => {
      for (const p of room.players) { if (p.isBot || p.disconnected) continue; const c = clients.get(p.connId); if (c) send(c.ws, 'countdown', { n }); }
    };
    emit();
    room.cdTimer = setInterval(() => {
      n -= 1;
      if (n <= 0) { clearInterval(room.cdTimer); room.cdTimer = null; startRace(room); return; }
      emit();
    }, 1000);
  }
  function startRace(room) {
    room.state = 'racing';
    let game = room.settings.game || 'race';
    if (game === 'random') game = MP_GAMES[Math.floor(Math.random() * MP_GAMES.length)];
    room.game = game;
    room.text = (game === 'race') ? pickText(room.settings.lang, room.settings.len) : '';
    room.startAt = Date.now();
    const tier = BOT_TIERS[room.settings.botDifficulty] || BOT_TIERS.medium;
    for (const p of room.players) {
      p.correct = 0; p.total = 0; p.cpm = 0; p.finished = false; p.finishAt = 0;
      if (p.isBot) p.target = tier[0] + Math.floor(Math.random() * (tier[1] - tier[0]));
    }
    for (const p of room.players) {
      if (p.isBot || p.disconnected) continue;
      const c = clients.get(p.connId);
      if (c) send(c.ws, 'race:start', { game: room.game, text: room.text, startAt: room.startAt, dur: RACE_DUR });
    }
    room.tick = setInterval(() => raceTick(room), TICK_MS);
  }
  function raceTick(room) {
    if (room.state !== 'racing') return;
    const now = Date.now();
    const elapsed = (now - room.startAt) / 1000;
    const isText = !!room.text;
    const len = room.text.length;
    for (const p of room.players) {
      if (!p.isBot || p.finished) continue;
      const jitter = 0.85 + Math.random() * 0.3;
      p.correct = p.correct + (p.target / 60) * (TICK_MS / 1000) * jitter;
      p.cpm = Math.round(p.target * (0.9 + Math.random() * 0.15));
      if (isText && p.correct >= len) { p.finished = true; p.finishAt = now; p.correct = len; }
    }
    broadcastTick(room, elapsed);
    if (elapsed >= RACE_DUR) { finishRace(room); return; }
    maybeFinish(room);
  }
  function broadcastTick(room, elapsed) {
    const remaining = Math.max(0, RACE_DUR - elapsed);
    const isText = !!room.text;
    const cap = isText ? room.text.length : NONTEXT_CAP;
    const players = room.players.map(p => ({
      id: p.connId, name: p.nickname, animal: p.animal,
      progress: cap ? Math.min(1, p.correct / cap) : 0,
      cpm: Math.round(p.cpm || 0), finished: p.finished, disconnected: !!p.disconnected,
    }));
    for (const p of room.players) {
      if (p.isBot || p.disconnected) continue;
      const c = clients.get(p.connId);
      if (c) send(c.ws, 'race:tick', { players, remaining: Math.round(remaining) });
    }
  }
  function maybeFinish(room) {
    if (room.state !== 'racing') return;
    const humans = room.players.filter(p => !p.isBot);
    // достатньо, щоб усі ПІДКЛЮЧЕНІ люди фінішували (відключені не блокують)
    const active = humans.filter(p => !p.disconnected);
    if (active.length && active.every(p => p.finished)) finishRace(room);
    else if (!active.length && humans.length) finishRace(room); // всі відпали — завершуємо
  }
  function finishRace(room) {
    if (room.state !== 'racing') return;
    room.state = 'done';
    if (room.tick) { clearInterval(room.tick); room.tick = null; }
    const ranking = room.players.slice().map(p => {
      const secs = p.finished && p.finishAt ? (p.finishAt - room.startAt) / 1000 : RACE_DUR;
      const cpm = secs > 0 ? Math.round(p.correct / (secs / 60)) : 0;
      return { connId: p.connId, name: p.nickname, animal: p.animal, isBot: p.isBot,
        correct: Math.round(p.correct), finished: p.finished, cpm: clampNum(cpm, 0, MAX_CPM) };
    }).sort((a, b) => (b.correct - a.correct) || (b.cpm - a.cpm));
    ranking.forEach((r, i) => { r.rank = i + 1; });
    const winner = ranking[0];
    for (const p of room.players) {
      if (p.isBot || p.disconnected) continue;
      const c = clients.get(p.connId);
      if (c) send(c.ws, 'race:done', { ranking, youId: p.connId, won: winner && winner.connId === p.connId });
    }
    setTimeout(() => {
      if (!rooms.has(room.id)) return;
      room.state = 'lobby';
      room.players = room.players.filter(p => !p.isBot);
      room.players.forEach(p => { p.ready = false; p.correct = 0; p.finished = false; p.cpm = 0; });
      if (!room.players.length) { destroyRoom(room); return; }
      pushRoom(room);
    }, 1200);
  }

  // --- reconnect: повернути гравця у його кімнату за ніком ---
  function tryReattach(c) {
    if (c.roomId) return false;
    for (const room of rooms.values()) {
      const p = room.players.find(x => !x.isBot && x.disconnected && x.nickname === c.nickname);
      if (!p) continue;
      if (p.dcTimer) { clearTimeout(p.dcTimer); p.dcTimer = null; }
      if (room.hostConnId === p.connId) room.hostConnId = c.connId;
      p.connId = c.connId; p.disconnected = false; p.animal = c.animal || p.animal;
      c.roomId = room.id;
      pushRoom(room);
      if (room.state === 'racing') {
        send(c.ws, 'race:start', { game: room.game, text: room.text, startAt: room.startAt, dur: RACE_DUR, resumed: true });
      }
      return true;
    }
    return false;
  }

  // ---------- обробка повідомлень ----------

  const HANDLERS = {
    hello(c, m) {
      c.nickname = normNick(m.nickname) || c.nickname;
      c.animal = normAnimal(m.animal);
      c.lang = typeof m.lang === 'string' ? m.lang.slice(0, 5) : 'en';
      c.bestWpm = clampNum(m.bestWpm, 0, 400);
      send(c.ws, 'hello:ok', { connId: c.connId });
      if (c.nickname) tryReattach(c); // повернути у кімнату після обриву
      schedulePresence();
      send(c.ws, 'presence', { users: presenceList() });
    },
    'presence:refresh'(c) { send(c.ws, 'presence', { users: presenceList() }); },
    'char:set'(c, m) {
      c.animal = normAnimal(m.animal);
      const room = c.roomId && rooms.get(c.roomId);
      if (room) { const p = room.players.find(x => x.connId === c.connId); if (p) p.animal = c.animal; pushRoom(room); }
      schedulePresence();
    },
    'room:create'(c, m) {
      leaveRoom(c);
      const ms = (m && m.settings) || {};
      const settings = {
        lang: ms.lang || 'en',
        len: ms.len || 'medium',
        game: MP_GAMES.includes(ms.game) ? ms.game : (ms.game === 'random' ? 'random' : 'race'),
        maxPlayers: clampNum(ms.maxPlayers, 2, MAX_PLAYERS),
        botDifficulty: BOT_TIERS[ms.botDifficulty] ? ms.botDifficulty : 'medium',
      };
      const id = genId('room-'); const code = genCode();
      const room = { id, code, hostConnId: c.connId, settings, state: 'lobby', players: [], text: '', startAt: 0 };
      room.players.push(newPlayer(c, { ready: false }));
      rooms.set(id, room); codeIndex.set(code, id); c.roomId = id;
      pushRoom(room); schedulePresence();
    },
    'room:join'(c, m) {
      const code = String(m.code || '').toUpperCase().trim();
      const id = codeIndex.get(code);
      const room = id && rooms.get(id);
      if (!room) return send(c.ws, 'error', { msg: 'room_not_found' });
      if (room.state !== 'lobby') return send(c.ws, 'error', { msg: 'room_started' });
      if (room.players.length >= capacity(room)) return send(c.ws, 'error', { msg: 'room_full' });
      if (room.players.some(p => p.connId === c.connId)) return;
      leaveRoom(c, { silent: true });
      room.players.push(newPlayer(c)); c.roomId = room.id;
      pushRoom(room); schedulePresence();
    },
    'room:leave'(c) { leaveRoom(c); schedulePresence(); },
    'room:start'(c) { // форс-старт хостом (не чекаючи всіх «готово»)
      const room = c.roomId && rooms.get(c.roomId);
      if (!room || room.state !== 'lobby') return;
      if (room.hostConnId !== c.connId) return;
      if (room.players.length < 2) return send(c.ws, 'error', { msg: 'need_players' });
      startCountdown(room);
    },
    invite(c, m) {
      const room = c.roomId && rooms.get(c.roomId);
      if (!room || room.state !== 'lobby') return;
      if (room.players.length >= capacity(room)) return send(c.ws, 'error', { msg: 'room_full' });
      const toNick = normNick(m.toNickname);
      if (!toNick) return;
      let target = null;
      for (const cc of clients.values()) { if (cc.nickname === toNick) { target = cc; } }
      if (!target) return send(c.ws, 'error', { msg: 'user_offline' });
      send(target.ws, 'invite', { from: c.nickname, fromAnimal: c.animal, roomId: room.id, code: room.code, settings: room.settings });
    },
    'invite:accept'(c, m) {
      const room = rooms.get(m.roomId);
      if (!room) return send(c.ws, 'error', { msg: 'room_gone' });
      if (room.state !== 'lobby') return send(c.ws, 'error', { msg: 'room_started' });
      if (room.players.length >= capacity(room)) return send(c.ws, 'error', { msg: 'room_full' });
      if (room.players.some(p => p.connId === c.connId)) { c.roomId = room.id; pushRoom(room); return; }
      leaveRoom(c, { silent: true });
      room.players.push(newPlayer(c)); c.roomId = room.id;
      pushRoom(room); schedulePresence();
    },
    'invite:decline'(c, m) {
      const room = rooms.get(m.roomId);
      if (!room) return;
      const host = clients.get(room.hostConnId);
      if (host) send(host.ws, 'invite:declined', { nickname: c.nickname });
    },
    'ready:set'(c, m) {
      const room = c.roomId && rooms.get(c.roomId);
      if (!room || room.state !== 'lobby') return;
      const p = room.players.find(x => x.connId === c.connId);
      if (!p) return;
      p.ready = !!m.ready;
      pushRoom(room);
      maybeStart(room);
    },
    addbot(c) {
      const room = c.roomId && rooms.get(c.roomId);
      if (!room || room.state !== 'lobby') return;
      if (room.players.length >= capacity(room)) return send(c.ws, 'error', { msg: 'room_full' });
      const used = new Set(room.players.map(p => p.nickname));
      const name = BOT_NAMES.find(n => !used.has(n)) || ('Bot' + room.players.length);
      const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
      room.players.push(newPlayer(null, { nickname: name, animal, isBot: true, ready: true }));
      pushRoom(room);
      maybeStart(room);
    },
    react(c, m) {
      const room = c.roomId && rooms.get(c.roomId);
      if (!room) return;
      const emoji = REACTIONS.includes(m.emoji) ? m.emoji : null;
      if (!emoji) return;
      for (const p of room.players) {
        if (p.isBot || p.disconnected) continue;
        const cc = clients.get(p.connId);
        if (cc) send(cc.ws, 'react', { from: c.connId, name: c.nickname, emoji });
      }
    },
    quickmatch(c) {
      leaveRoom(c, { silent: true });
      waiting = waiting.filter(id => id !== c.connId && clients.has(id));
      const otherId = waiting.shift();
      const other = otherId && clients.get(otherId);
      if (other && !other.roomId) {
        const id = genId('room-'); const code = genCode();
        const settings = { lang: c.lang || other.lang || 'en', len: 'medium', game: 'race', maxPlayers: MAX_PLAYERS, botDifficulty: 'medium' };
        const room = { id, code, hostConnId: other.connId, settings, state: 'lobby', players: [], text: '', startAt: 0 };
        room.players.push(newPlayer(other, { ready: true }));
        room.players.push(newPlayer(c, { ready: true }));
        rooms.set(id, room); codeIndex.set(code, id);
        other.roomId = id; c.roomId = id;
        pushRoom(room); schedulePresence();
        startCountdown(room);
      } else {
        waiting.push(c.connId);
        send(c.ws, 'quickmatch:waiting', {});
      }
    },
    'quickmatch:cancel'(c) { waiting = waiting.filter(id => id !== c.connId); },
    progress(c, m) {
      const room = c.roomId && rooms.get(c.roomId);
      if (!room || room.state !== 'racing') return;
      const p = room.players.find(x => x.connId === c.connId);
      if (!p || p.isBot || p.finished) return;
      const isText = !!room.text; const len = room.text.length;
      const secs = Math.max(0.1, (Date.now() - room.startAt) / 1000);
      // Анти-чит: правдоподібна стеля = минулий час * MAX_CPS; плюс монотонність.
      const plausible = Math.floor(secs * MAX_CPS) + 3;
      const hardMax = isText ? len : 100000;
      const val = Math.min(clampNum(m.correct, 0, hardMax), plausible);
      p.correct = Math.max(p.correct, val); // тільки вгору (щоб reconnect не обнуляв)
      p.total = clampNum(m.total, 0, hardMax * 2);
      p.cpm = clampNum(Math.round(p.correct / (secs / 60)), 0, MAX_CPM);
      if (isText && p.correct >= len) { p.finished = true; p.finishAt = Date.now(); }
    },
    pong(c) { c.alive = true; },
  };

  wss.on('connection', (ws, req) => {
    const ip = clientIp(req);
    ipCounts.set(ip, (ipCounts.get(ip) || 0) + 1);
    const connId = genId('c-');
    const c = { connId, ws, ip, nickname: null, animal: 'Cat', lang: 'en', bestWpm: 0, roomId: null, alive: true, msgTimes: [] };
    clients.set(connId, c);
    send(ws, 'welcome', { connId });

    ws.on('message', (raw) => {
      const now = Date.now();
      c.msgTimes = c.msgTimes.filter(t => now - t < 1000);
      if (c.msgTimes.length > 40) return; // мʼякий rate-limit (~40 повід/с; progress іде 4/с)
      c.msgTimes.push(now);
      let m; try { m = JSON.parse(raw); } catch (_) { return; }
      if (!m || typeof m.type !== 'string') return;
      const h = HANDLERS[m.type];
      if (h) { try { h(c, m); } catch (e) { console.error('[ws] handler error', m.type, e.message); } }
    });

    ws.on('close', () => {
      waiting = waiting.filter(id => id !== connId);
      const roomId = c.roomId;
      const room = roomId && rooms.get(roomId);
      if (room) {
        const p = room.players.find(x => x.connId === connId);
        if (p) {
          // грейс: тримаємо гравця в кімнаті GRACE_MS — раптом перепідключиться
          p.disconnected = true;
          p.dcTimer = setTimeout(() => { const r = rooms.get(roomId); if (r) removePlayer(r, connId); }, GRACE_MS);
          if (room.state === 'racing') maybeFinish(room); // раптом решта вже фінішувала
          pushRoom(room);
        }
      }
      c.roomId = null;
      clients.delete(connId);
      const n = (ipCounts.get(ip) || 1) - 1;
      if (n <= 0) ipCounts.delete(ip); else ipCounts.set(ip, n);
      schedulePresence();
    });
    ws.on('error', () => {});
  });

  const hb = setInterval(() => {
    for (const c of clients.values()) {
      if (c.alive === false) { try { c.ws.terminate(); } catch (_) {} continue; }
      c.alive = false;
      send(c.ws, 'ping', {});
    }
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(hb));

  console.log('[ws] realtime hub attached on /ws');
  return wss;
}

module.exports = { attach };
