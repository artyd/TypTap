// @ts-check
// Covers the audit-driven additions: force-start, room-size cap, emoji reactions,
// MP-wins recording, reconnect grace, and clean exit / overlay gating.
const { test, expect } = require('@playwright/test');
const http = require('http');
const { attach } = require('../backend/realtime.js');

let wsServer, WS_PORT;
const FIND_LOGIC = `(function(){const all=document.querySelectorAll('*');for(const el of all){for(const k in el){if(k.startsWith('__reactFiber$')||k.startsWith('__reactInternalInstance$')){let f=el[k];while(f){const sn=f.stateNode;if(sn&&sn.logic&&sn.logic.state&&('falling' in sn.logic.state))return sn.logic;f=f.return;}}}}return null;})()`;

async function newPlayer(browser, nick) {
  const ctx = await browser.newContext({ locale: 'en-US' });
  const page = await ctx.newPage();
  await page.addInitScript((port) => { try { localStorage.clear(); } catch (e) {} window.TYPTAP_WS_BASE = 'ws://127.0.0.1:' + port + '/ws'; }, WS_PORT);
  await page.goto('/index.html');
  await expect.poll(() => page.evaluate(FIND_LOGIC + ' !== null')).toBe(true);
  const logic = await page.evaluateHandle(FIND_LOGIC);
  await logic.evaluate((l, n) => { l._login(n); l._openMp(); }, nick);
  await expect.poll(() => logic.evaluate((l) => l.state.mpConnected)).toBe(true);
  return { ctx, page, logic };
}

test.beforeAll(async () => {
  wsServer = http.createServer();
  attach(wsServer, { allowOrigins: ['127.0.0.1:8123', 'localhost:8123'] });
  await new Promise((r) => wsServer.listen(0, '127.0.0.1', r));
  WS_PORT = wsServer.address().port;
});
test.afterAll(async () => { if (wsServer) await new Promise((r) => wsServer.close(r)); });

test('host force-start begins the race without everyone readying', async ({ browser }) => {
  const A = await newPlayer(browser, 'HostA');
  await A.logic.evaluate((l) => { l._mpPickGame('race'); l._mpPickLen('short'); l._mpCreate(); });
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mpLobby && l.state.mpLobby.room))).toBe(true);
  await A.logic.evaluate((l) => l._mpAddBot());           // 2 players (host + bot), host NOT ready
  await A.logic.evaluate((l) => l._mpForceStart());       // host forces start
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mp && l.state.mp.text)), { timeout: 12000 }).toBe(true);
  await A.ctx.close();
});

test('room size cap blocks a join when full', async ({ browser }) => {
  const A = await newPlayer(browser, 'CapHost');
  const B = await newPlayer(browser, 'CapJoin');
  // room for 2, fill with host + bot
  await A.logic.evaluate((l) => { l._mpPickMax(2); l._mpCreate(); });
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mpLobby && l.state.mpLobby.room))).toBe(true);
  const code = await A.logic.evaluate((l) => l.state.mpLobby.room.code);
  await A.logic.evaluate((l) => l._mpAddBot());
  await expect.poll(() => A.logic.evaluate((l) => l.state.mpLobby.room.players.length)).toBe(2);
  // B tries to join the 2/2 room → error room_full
  await B.logic.evaluate((l, c) => l._mpJoinCode(c), code);
  await expect.poll(() => B.logic.evaluate((l) => (l.state.mpStatus || '').length > 0)).toBe(true); // error surfaced
  const joined = await B.logic.evaluate((l) => !!(l.state.mpLobby && l.state.mpLobby.room));
  expect(joined, 'B must not be in the full room').toBe(false);
  await A.ctx.close(); await B.ctx.close();
});

test('emoji reaction is broadcast back to the sender during a race', async ({ browser }) => {
  const A = await newPlayer(browser, 'Reactor');
  await A.logic.evaluate((l) => { l._mpPickGame('race'); l._mpPickLen('short'); l._mpCreate(); });
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mpLobby && l.state.mpLobby.room))).toBe(true);
  await A.logic.evaluate((l) => l._mpAddBot());
  await A.logic.evaluate((l) => l._mpForceStart());
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mp && l.state.mp.text)), { timeout: 12000 }).toBe(true);
  await A.logic.evaluate((l) => l._mpReact('🔥'));
  await expect.poll(() => A.logic.evaluate((l) => (l.state.mpReacts || []).some((r) => r.emoji === '🔥'))).toBe(true);
  await A.ctx.close();
});

test('winning a race increments MP wins on the profile', async ({ browser }) => {
  const A = await newPlayer(browser, 'Winner');
  await A.logic.evaluate((l) => { l._mpPickGame('race'); l._mpPickLen('short'); l._mpCreate(); });
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mpLobby && l.state.mpLobby.room))).toBe(true);
  await A.logic.evaluate((l) => l._mpAddBot());
  await A.logic.evaluate((l) => l._mpForceStart());
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mp && l.state.mp.text)), { timeout: 12000 }).toBe(true);
  await A.logic.evaluate((l) => { const t = l.state.mp.text; for (const ch of t) l._mpKey({ key: ch, preventDefault() {} }); });
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mp && l.state.mp.over)), { timeout: 15000 }).toBe(true);
  const wins = await A.logic.evaluate((l) => l.store.mpWins || 0);
  expect(wins).toBe(1);
  await A.ctx.close();
});

test('reconnect grace: a dropped player rejoins their room', async ({ browser }) => {
  const A = await newPlayer(browser, 'StayA');
  const B = await newPlayer(browser, 'DropB');
  await A.logic.evaluate((l) => l._mpCreate());
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mpLobby && l.state.mpLobby.room))).toBe(true);
  await A.logic.evaluate((l) => l._mpInvite('DropB'));
  await expect.poll(() => B.logic.evaluate((l) => !!l.state.mpInvite)).toBe(true);
  await B.logic.evaluate((l) => l._mpAcceptInvite());
  await expect.poll(() => A.logic.evaluate((l) => l.state.mpLobby.room.players.length)).toBe(2);
  // B drops the socket
  await B.logic.evaluate(() => window.TypTapMP.close());
  await expect.poll(() => A.logic.evaluate((l) => (l.state.mpLobby.room.players.find((p) => p.nickname === 'DropB') || {}).disconnected)).toBe(true);
  // B reconnects → server re-attaches by nick within the grace window
  await B.logic.evaluate((l) => l._mpConnect());
  await expect.poll(() => A.logic.evaluate((l) => (l.state.mpLobby.room.players.find((p) => p.nickname === 'DropB') || {}).disconnected), { timeout: 8000 }).toBe(false);
  await expect.poll(() => B.logic.evaluate((l) => !!(l.state.mpLobby && l.state.mpLobby.room))).toBe(true);
  await A.ctx.close(); await B.ctx.close();
});

test('navigating away from a mini-game match cleanly leaves it', async ({ browser }) => {
  const A = await newPlayer(browser, 'Nav');
  await A.logic.evaluate((l) => { l._mpPickGame('boss'); l._mpCreate(); });
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mpLobby && l.state.mpLobby.room))).toBe(true);
  await A.logic.evaluate((l) => l._mpAddBot());
  await A.logic.evaluate((l) => l._mpForceStart());
  await expect.poll(() => A.logic.evaluate((l) => !!(l.state.mp && l.state.mp.game)), { timeout: 12000 }).toBe(true);
  // navigate home via go() → match aborted, mp cleared
  await A.logic.evaluate((l) => l.go('hub'));
  expect(await A.logic.evaluate((l) => l.state.mp)).toBeNull();
  expect(await A.logic.evaluate((l) => l.state.screen)).toBe('hub');
  await A.ctx.close();
});
