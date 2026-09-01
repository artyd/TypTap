// TypTap backend API — Node/Express + Postgres (self-hosted).
//
// Роуты (за nginx они висят под /api, см. nginx/typtap.conf; сюда приходят
// уже без префикса /api):
//   POST /login        { nickname }                       -> { nickname, exists, data }
//   PUT  /profile      { nickname, data }                 -> { ok, updated_at }
//   GET  /leaderboard  ?metric=wpm|acc|streak&nickname&limit -> { metric, top, you }
//   GET  /health                                          -> { ok: true }
//
// Авторизация профиля НАМЕРЕННО простая: только никнейм, без пароля — так и
// просили. Любой, кто наберёт тот же ник, увидит и сможет перезаписать тот же
// профиль. Это осознанный компромисс ради простоты (раньше профиль был привязан
// к одному браузеру, теперь общий для всех устройств). Если позже понадобится
// защита — добавить необязательный PIN: одна колонка в таблице + одна проверка
// здесь, без изменений в остальной логике.

const express = require('express');
const { pool, migrate, waitForDb } = require('./db');

const PORT = Number(process.env.PORT) || 8787;
const MAX_SESSIONS = 200;          // столько последних сессий храним на игрока
const MAX_BODY = '200kb';          // 200 сессий + прочая статистика влезают с запасом

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: MAX_BODY }));

// ---------- helpers (порт из supabase/functions/api/index.ts) ----------

function clamp(v, min, max, fallback = 0) {
  const n = typeof v === 'number' && Number.isFinite(v) ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeNickname(raw) {
  if (typeof raw !== 'string') return null;
  const nick = raw.trim().slice(0, 20);
  return nick.length ? nick : null;
}

// Витринные метрики из произвольного jsonb-снимка store — для быстрой сортировки
// индексами в таблице.
function deriveMetrics(data) {
  const sessions = Array.isArray(data && data.sessions) ? data.sessions : [];
  let bestWpm = 0;
  let bestAcc = 0;
  for (const s of sessions) {
    const wpm = Number(s && s.wpm) || 0;
    const acc = Number(s && s.acc) || 0;
    if (wpm > bestWpm) bestWpm = wpm;
    if (acc > bestAcc) bestAcc = acc;
  }
  // bestRace (мини-игра race) тоже в WPM и может быть выше лучшего урока.
  const bestRace = Number(data && data.bestRace) || 0;
  if (bestRace > bestWpm) bestWpm = bestRace;

  const streakCount = Number(data && data.streak && data.streak.count) || 0;
  const xp = Number(data && data.xp) || 0;

  return {
    best_wpm: clamp(bestWpm, 0, 400),
    best_acc: clamp(bestAcc, 0, 100),
    streak_count: clamp(streakCount, 0, 20000),
    xp: clamp(xp, 0, 100_000_000),
  };
}

// Отсекаем неправдоподобные значения и режем историю сессий — бэкенд не должен
// доверять клиенту вслепую (клиент и так режет до 200).
function sanitizeData(raw) {
  const data = raw && typeof raw === 'object' ? { ...raw } : {};
  if (Array.isArray(data.sessions)) {
    data.sessions = data.sessions.slice(-MAX_SESSIONS).map((s) => ({
      date: s && typeof s.date === 'string' ? s.date : new Date().toISOString(),
      wpm: clamp(s && s.wpm, 0, 400),
      acc: clamp(s && s.acc, 0, 100),
      mode: s && typeof s.mode === 'string' ? s.mode.slice(0, 30) : 'unknown',
      lang: s && typeof s.lang === 'string' ? s.lang.slice(0, 10) : 'en',
      keyErr: s && s.keyErr && typeof s.keyErr === 'object' ? s.keyErr : {},
    }));
  }
  return data;
}

const METRIC_COLUMN = { wpm: 'best_wpm', acc: 'best_acc', streak: 'streak_count' };

function asyncHandler(fn) {
  return (req, res) => fn(req, res).catch((e) => {
    console.error('[api] error:', e);
    res.status(500).json({ error: 'internal error' });
  });
}

// ---------- routes ----------

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/login', asyncHandler(async (req, res) => {
  const nickname = normalizeNickname(req.body && req.body.nickname);
  if (!nickname) return res.status(400).json({ error: 'nickname required' });

  const { rows } = await pool.query(
    'select data, updated_at from public.profiles where nickname = $1',
    [nickname],
  );
  if (!rows.length) return res.json({ nickname, exists: false, data: null });
  return res.json({ nickname, exists: true, data: rows[0].data, updated_at: rows[0].updated_at });
}));

app.put('/profile', asyncHandler(async (req, res) => {
  const nickname = normalizeNickname(req.body && req.body.nickname);
  if (!nickname) return res.status(400).json({ error: 'nickname required' });

  const data = sanitizeData(req.body && req.body.data);
  const m = deriveMetrics(data);

  const { rows } = await pool.query(
    `insert into public.profiles (nickname, data, best_wpm, best_acc, streak_count, xp)
       values ($1, $2, $3, $4, $5, $6)
     on conflict (nickname) do update set
       data = excluded.data,
       best_wpm = excluded.best_wpm,
       best_acc = excluded.best_acc,
       streak_count = excluded.streak_count,
       xp = excluded.xp
     returning updated_at`,
    [nickname, data, m.best_wpm, m.best_acc, m.streak_count, m.xp],
  );
  return res.json({ ok: true, updated_at: rows[0].updated_at });
}));

app.get('/leaderboard', asyncHandler(async (req, res) => {
  const metric = String(req.query.metric || 'wpm').toLowerCase();
  const column = METRIC_COLUMN[metric];
  if (!column) return res.status(400).json({ error: 'metric must be wpm | acc | streak' });

  const nickname = normalizeNickname(req.query.nickname);
  const limit = clamp(req.query.limit, 1, 100, 50);

  // Топ: колонка денормализована и проиндексирована — обычный order by.
  const { rows } = await pool.query(
    `select nickname, ${column} as value
       from public.profiles
      where ${column} > 0
      order by ${column} desc
      limit $1`,
    [limit],
  );
  const top = rows.map((r, i) => ({
    nickname: r.nickname,
    value: Number(r.value),
    rank: i + 1,
  }));

  // Точный ранг игрока — отдельным count (сколько профилей строго выше),
  // чтобы не тянуть всю таблицу.
  let you = null;
  if (nickname) {
    const mine = await pool.query(
      `select ${column} as value from public.profiles where nickname = $1`,
      [nickname],
    );
    const myValue = mine.rows.length ? Number(mine.rows[0].value) : 0;
    if (myValue > 0) {
      const cnt = await pool.query(
        `select count(*)::int as c from public.profiles where ${column} > $1`,
        [myValue],
      );
      you = { nickname, value: myValue, rank: cnt.rows[0].c + 1 };
    }
  }

  // column выше берётся ТОЛЬКО из белого списка METRIC_COLUMN, а не из
  // пользовательского ввода напрямую — поэтому интерполяция в SQL безопасна.
  return res.json({ metric, top, you });
}));

app.use((_req, res) => res.status(404).json({ error: 'not found' }));

// ---------- bootstrap ----------

(async () => {
  try {
    await waitForDb();
    await migrate();
    app.listen(PORT, () => console.log(`[api] listening on :${PORT}`));
  } catch (e) {
    console.error('[api] failed to start:', e);
    process.exit(1);
  }
})();
