// @ts-check
// End-to-end multiplayer: two real browser pages (Alice + Bob) talk to the real
// WebSocket hub (backend/realtime.js) through the real frontend code
// (TypTapMP + the DC component's _mp* methods). Verifies presence, invite,
// accept, ready → countdown → same-text race → server-ranked results.
const { test, expect } = require('@playwright/test');
const http = require('http');
const { attach } = require('../backend/realtime.js');

let wsServer, WS_PORT;

const FIND_LOGIC = `
(function(){
  const all = document.querySelectorAll('*');
  for (const el of all) {
    for (const k in el) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) {
        let f = el[k];
        while (f) { const sn=f.stateNode; if (sn && sn.logic && sn.logic.state && ('falling' in sn.logic.state)) return sn.logic; f=f.return; }
      }
    }
  }
  return null;
})()`;

async function newPlayer(browser, nick) {
  const ctx = await browser.newContext({ locale: 'en-US' });
  const page = await ctx.newPage();
  await page.addInitScript((port) => {
    try { localStorage.clear(); } catch (e) {}
    window.TYPTAP_WS_BASE = 'ws://127.0.0.1:' + port + '/ws';
  }, WS_PORT);
  await page.goto('/index.html');
  await expect.poll(() => page.evaluate(FIND_LOGIC + ' !== null')).toBe(true);
  const logic = await page.evaluateHandle(FIND_LOGIC);
  // register + open multiplayer (this connects to the WS hub)
  await logic.evaluate((l, n) => { l._login(n); l._openMp(); }, nick);
  return { ctx, page, logic };
}

test.beforeAll(async () => {
  wsServer = http.createServer();
  attach(wsServer, { allowOrigins: ['127.0.0.1:8123', 'localhost:8123'] });
  await new Promise((r) => wsServer.listen(0, '127.0.0.1', r));
  WS_PORT = wsServer.address().port;
});
test.afterAll(async () => { if (wsServer) await new Promise((r) => wsServer.close(r)); });

test('two players: presence → invite → race → ranked results', async ({ browser }) => {
  const A = await newPlayer(browser, 'Alice');
  const B = await newPlayer(browser, 'Bob');

  // both connect
  await expect.poll(() => A.logic.evaluate((l) => l.state.mpConnected)).toBe(true);
  await expect.poll(() => B.logic.evaluate((l) => l.state.mpConnected)).toBe(true);

  // presence: each sees the other online
  await expect.poll(() => A.logic.evaluate((l) => (l.state.mpLobby.online||[]).some(u=>u.nickname==='Bob'))).toBe(true);
  await expect.poll(() => B.logic.evaluate((l) => (l.state.mpLobby.online||[]).some(u=>u.nickname==='Alice'))).toBe(true);

  // Alice creates a short-race room
  await A.logic.evaluate((l) => { l._mpPickLen('short'); l._mpCreate(); });
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mpLobby && l.state.mpLobby.room))).toBe(true);

  // Alice invites Bob → Bob gets a global invite popup
  await A.logic.evaluate((l) => l._mpInvite('Bob'));
  await expect.poll(() => B.logic.evaluate((l) => !!l.state.mpInvite)).toBe(true);

  // Bob accepts → both rooms show 2 players
  await B.logic.evaluate((l) => l._mpAcceptInvite());
  await expect.poll(() => A.logic.evaluate((l) => l.state.mpLobby.room.players.length)).toBe(2);
  await expect.poll(() => B.logic.evaluate((l) => l.state.mpLobby.room && l.state.mpLobby.room.players.length)).toBe(2);

  // both ready → countdown → race:start (identical text delivered to both)
  await A.logic.evaluate((l) => l._mpReadyToggle());
  await B.logic.evaluate((l) => l._mpReadyToggle());
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mp && l.state.mp.text)), { timeout: 12000 }).toBe(true);
  await expect.poll(() => B.logic.evaluate(() => true)).toBe(true);
  await expect.poll(() => B.logic.evaluate((l) => !!(l.state.mp && l.state.mp.text)), { timeout: 12000 }).toBe(true);

  const textA = await A.logic.evaluate((l) => l.state.mp.text);
  const textB = await B.logic.evaluate((l) => l.state.mp.text);
  expect(textA, 'both players race the SAME text').toBe(textB);
  expect(textA.length).toBeGreaterThan(10);

  // Alice types the whole text correctly (finishes first)
  await A.logic.evaluate((l) => { const t=l.state.mp.text; for(const ch of t){ l._mpKey({key:ch, preventDefault(){}}); } });
  // small gap so Alice's finish timestamp is strictly earlier
  await A.page.waitForTimeout(300);
  // Bob also finishes (fully correct) but later
  await B.logic.evaluate((l) => { const t=l.state.mp.text; for(const ch of t){ l._mpKey({key:ch, preventDefault(){}}); } });

  // race ends (all humans finished) → results with server ranking
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mp && l.state.mp.over)), { timeout: 15000 }).toBe(true);
  const rank = await A.logic.evaluate((l) => l.state.mp.ranking.map(r=>({name:r.name, rank:r.rank, cpm:r.cpm})));
  expect(rank.length, 'two racers ranked').toBe(2);
  expect(rank[0].name, 'Alice finished first → ranked #1').toBe('Alice');
  expect(rank[0].cpm).toBeGreaterThan(0);

  await A.ctx.close();
  await B.ctx.close();
});

test('mini-game selection: chosen game runs (no shared text) and live board updates', async ({ browser }) => {
  const A = await newPlayer(browser, 'Gina');
  await expect.poll(() => A.logic.evaluate((l) => l.state.mpConnected)).toBe(true);
  // choose the "boss" mini-game, create, add a bot, ready
  await A.logic.evaluate((l) => { l._mpPickGame('boss'); l._mpCreate(); });
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mpLobby && l.state.mpLobby.room))).toBe(true);
  expect(await A.logic.evaluate((l) => l.state.mpLobby.room.settings.game)).toBe('boss');
  await A.logic.evaluate((l) => l._mpAddBot());
  await A.logic.evaluate((l) => l._mpReadyToggle());
  // race:start → the boss game screen, NOT the shared-text race
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mp && l.state.mp.game)), { timeout: 12000 }).toBe(true);
  const st = await A.logic.evaluate((l) => ({ game: l.state.mp.game, text: l.state.mp.text, screen: l.state.screen }));
  expect(st.game).toBe('boss');
  expect(st.text).toBe('');            // mini-games have no shared text
  expect(st.screen).toBe('game');
  // simulate typing progress; the live board (server ticks) should populate + advance
  await A.logic.evaluate((l) => { l._mpCorrect = 40; });
  await A.page.waitForTimeout(700);
  const board = await A.logic.evaluate((l) => (l.state.mp.board || []).map((p) => ({ name: p.name, progress: p.progress })));
  expect(board.length).toBe(2);        // Gina + bot
  expect(board.some((p) => p.progress > 0)).toBe(true);
  await A.ctx.close();
});

test('quick match pairs two waiting players and starts a race', async ({ browser }) => {
  const A = await newPlayer(browser, 'Quinn');
  const B = await newPlayer(browser, 'Robin');
  await expect.poll(() => A.logic.evaluate((l) => l.state.mpConnected)).toBe(true);
  await expect.poll(() => B.logic.evaluate((l) => l.state.mpConnected)).toBe(true);

  await A.logic.evaluate((l) => l._mpQuick());
  await B.logic.evaluate((l) => l._mpQuick());

  // paired → countdown → both racing the same text
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mp && l.state.mp.text)), { timeout: 12000 }).toBe(true);
  await expect.poll(() => B.logic.evaluate((l) => !!(l.state.mp && l.state.mp.text)), { timeout: 12000 }).toBe(true);
  const ta = await A.logic.evaluate((l) => l.state.mp.text);
  const tb = await B.logic.evaluate((l) => l.state.mp.text);
  expect(ta).toBe(tb);

  await A.ctx.close();
  await B.ctx.close();
});

test('add-bot lets a solo player start, and a bot appears in results', async ({ browser }) => {
  const A = await newPlayer(browser, 'Solo');
  await expect.poll(() => A.logic.evaluate((l) => l.state.mpConnected)).toBe(true);
  await A.logic.evaluate((l) => { l._mpPickLen('short'); l._mpCreate(); });
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mpLobby && l.state.mpLobby.room))).toBe(true);
  await A.logic.evaluate((l) => l._mpAddBot());
  await expect.poll(() => A.logic.evaluate((l) => l.state.mpLobby.room.players.length)).toBe(2);
  await A.logic.evaluate((l) => l._mpReadyToggle());
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mp && l.state.mp.text)), { timeout: 12000 }).toBe(true);
  // solo player types everything; race ends when the human finishes
  await A.logic.evaluate((l) => { const t=l.state.mp.text; for(const ch of t){ l._mpKey({key:ch, preventDefault(){}}); } });
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mp && l.state.mp.over)), { timeout: 15000 }).toBe(true);
  const names = await A.logic.evaluate((l) => l.state.mp.ranking.map(r=>r.name));
  expect(names).toContain('Solo');
  expect(names.length).toBe(2); // Solo + 1 bot
  await A.ctx.close();
});
