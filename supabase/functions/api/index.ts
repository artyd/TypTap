// TypTap backend API — Supabase Edge Function (Deno).
//
// Роуты (базовый путь /functions/v1/api):
//   POST /login        { nickname }                 -> { nickname, exists, data }
//   PUT  /profile       { nickname, data }           -> { ok, updated_at }
//   GET  /leaderboard  ?metric=wpm|acc|streak&nickname=... -> { metric, top, you }
//
// Авторизация профиля НАМЕРЕННО простая: только никнейм, без пароля —
// так и просили. Это значит, что любой, кто наберёт тот же ник, увидит и
// сможет перезаписать тот же профиль. Это осознанный компромисс ради
// простоты (как и раньше, просто теперь общий для всех устройств, а не
// привязан к одному браузеру). Если позже понадобится защита — легко
// добавить необязательный PIN: одно новое поле в таблице + одна проверка
// здесь, без изменений в остальной логике.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// service_role используется ТОЛЬКО здесь, на сервере. Он никогда не
// отправляется в браузер и обходит RLS — поэтому таблица profiles закрыта
// для anon/authenticated ролей на уровне БД (см. миграцию 0001_init.sql).
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const CORS_HEADERS: Record<string, string> = {
  // При желании сузьте до вашего домена GitHub Pages, например:
  // "Access-Control-Allow-Origin": "https://<username>.github.io",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, PUT, OPTIONS",
};

const MAX_BODY_BYTES = 200_000; // 200 KB с запасом хватает на 200 сессий + прочую статистику
const MAX_SESSIONS = 200;

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

function clamp(v: unknown, min: number, max: number, fallback = 0): number {
  const n = typeof v === "number" && Number.isFinite(v) ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function normalizeNickname(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const nick = raw.trim().slice(0, 20);
  return nick.length ? nick : null;
}

// Извлекает "витринные" метрики из произвольного jsonb-блока store,
// чтобы их можно было быстро сортировать индексами в таблице.
function deriveMetrics(data: Record<string, unknown>) {
  const sessions = Array.isArray(data?.sessions) ? data.sessions : [];
  let bestWpm = 0;
  let bestAcc = 0;
  for (const s of sessions) {
    const wpm = Number((s as any)?.wpm) || 0;
    const acc = Number((s as any)?.acc) || 0;
    if (wpm > bestWpm) bestWpm = wpm;
    if (acc > bestAcc) bestAcc = acc;
  }
  // bestRace (мини-игра race) тоже считается в WPM и может быть выше, чем
  // лучший результат урока/дрели — учитываем и его.
  const bestRace = Number((data as any)?.bestRace) || 0;
  if (bestRace > bestWpm) bestWpm = bestRace;

  const streakCount = Number((data as any)?.streak?.count) || 0;
  const xp = Number((data as any)?.xp) || 0;

  return {
    best_wpm: clamp(bestWpm, 0, 400),
    best_acc: clamp(bestAcc, 0, 100),
    streak_count: clamp(streakCount, 0, 20000),
    xp: clamp(xp, 0, 100_000_000),
  };
}

// Отсекаем совсем неправдоподобные данные и режем историю сессий, чтобы
// таблица не разрасталась бесконтрольно (клиент и так режет до 200, но
// бэкенд не должен доверять клиенту вслепую).
function sanitizeData(raw: unknown): Record<string, unknown> {
  const data = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : {};
  if (Array.isArray(data.sessions)) {
    data.sessions = data.sessions
      .slice(-MAX_SESSIONS)
      .map((s: any) => ({
        date: typeof s?.date === "string" ? s.date : new Date().toISOString(),
        wpm: clamp(s?.wpm, 0, 400),
        acc: clamp(s?.acc, 0, 100),
        mode: typeof s?.mode === "string" ? s.mode.slice(0, 30) : "unknown",
        lang: typeof s?.lang === "string" ? s.lang.slice(0, 10) : "en",
        keyErr: s?.keyErr && typeof s.keyErr === "object" ? s.keyErr : {},
      }));
  }
  return data;
}

async function readJson(req: Request): Promise<any> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new Response(json({ error: "payload too large" }, 413));
  }
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Response(json({ error: "invalid json" }, 400));
  }
}

async function handleLogin(req: Request): Promise<Response> {
  const body = await readJson(req).catch((r) => {
    throw r;
  });
  const nickname = normalizeNickname(body?.nickname);
  if (!nickname) return json({ error: "nickname required" }, 400);

  const { data: row, error } = await supabase
    .from("profiles")
    .select("data, updated_at")
    .eq("nickname", nickname)
    .maybeSingle();

  if (error) return json({ error: error.message }, 500);

  if (!row) return json({ nickname, exists: false, data: null });
  return json({ nickname, exists: true, data: row.data, updated_at: row.updated_at });
}

async function handleSaveProfile(req: Request): Promise<Response> {
  const body = await readJson(req).catch((r) => {
    throw r;
  });
  const nickname = normalizeNickname(body?.nickname);
  if (!nickname) return json({ error: "nickname required" }, 400);

  const data = sanitizeData(body?.data);
  const metrics = deriveMetrics(data);

  const { error } = await supabase.from("profiles").upsert(
    {
      nickname,
      data,
      ...metrics,
    },
    { onConflict: "nickname" },
  );

  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, updated_at: new Date().toISOString() });
}

const METRIC_COLUMN: Record<string, string> = {
  wpm: "best_wpm",
  acc: "best_acc",
  streak: "streak_count",
};

async function handleLeaderboard(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const metric = (url.searchParams.get("metric") || "wpm").toLowerCase();
  const column = METRIC_COLUMN[metric];
  if (!column) return json({ error: "metric must be wpm | acc | streak" }, 400);

  const nickname = normalizeNickname(url.searchParams.get("nickname"));
  const limit = clamp(url.searchParams.get("limit"), 1, 100, 50);

  const { data: rows, error } = await supabase
    .from("profiles")
    .select(`nickname, ${column}`)
    .gt(column, 0)
    .order(column, { ascending: false })
    .limit(limit);

  if (error) return json({ error: error.message }, 500);

  const top = (rows || []).map((r: any, i: number) => ({
    nickname: r.nickname,
    value: r[column],
    rank: i + 1,
  }));

  let you: { nickname: string; value: number; rank: number } | null = null;
  if (nickname) {
    // Точный ранг игрока считаем отдельным запросом (сколько профилей
    // выше него по этой метрике), чтобы не тянуть всю таблицу целиком.
    const { data: mine } = await supabase
      .from("profiles")
      .select(column)
      .eq("nickname", nickname)
      .maybeSingle();

    const myValue = mine ? (mine as any)[column] : 0;
    if (myValue > 0) {
      const { count } = await supabase
        .from("profiles")
        .select("nickname", { count: "exact", head: true })
        .gt(column, myValue);
      you = { nickname, value: myValue, rank: (count || 0) + 1 };
    }
  }

  return json({ metric, top, you });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const url = new URL(req.url);
  // Supabase монтирует функцию на /functions/v1/api — префикс "/api" может
  // присутствовать или нет в зависимости от того, как вызывается функция.
  const path = url.pathname.replace(/^\/functions\/v1/, "").replace(/^\/api/, "") || "/";

  try {
    if (req.method === "POST" && path === "/login") return await handleLogin(req);
    if (req.method === "PUT" && path === "/profile") return await handleSaveProfile(req);
    if (req.method === "GET" && path === "/leaderboard") return await handleLeaderboard(req);
    return json({ error: "not found", path }, 404);
  } catch (e) {
    if (e instanceof Response) return e;
    console.error(e);
    return json({ error: "internal error" }, 500);
  }
});
