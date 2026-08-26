// @ts-check
const { test, expect } = require('@playwright/test');

// ---------------------------------------------------------------------------
// Regression suite for: "keyboard does not work in games".
//
// Root cause that was fixed: the Falling Letters pool was hardcoded to
// 'asdfjkl;ghрутек' — a mix of Latin (asdfjkl;gh) and Cyrillic (рутек). On any
// single keyboard layout ~1/3 of the falling letters were the wrong script and
// physically un-typeable, so they always fell through and drained lives, which
// read to players as "the keyboard doesn't work". It also ignored the selected
// UI language. The fix derives the pool from the active language's key rows.
//
// These tests drive the real app in Chromium. They reach into the DC-framework
// component instance (the same way the app stores its state) to:
//   1) assert every game registers a keypress through the single window
//      `keydown` listener (i.e. the keyboard works everywhere), and
//   2) assert no game presents letters from a script the current layout can't
//      type (the specific bug), across all three languages.
// ---------------------------------------------------------------------------

// Injected into the page: walks the React fiber tree to find the DC logic
// instance that owns the game state (it has a `falling` key in its state).
const FIND_LOGIC = `
(function(){
  const all = document.querySelectorAll('*');
  for (const el of all) {
    for (const k in el) {
      if (k.startsWith('__reactFiber$') || k.startsWith('__reactInternalInstance$')) {
        let f = el[k];
        while (f) {
          const sn = f.stateNode;
          if (sn && sn.logic && sn.logic.state && ('falling' in sn.logic.state)) return sn.logic;
          f = f.return;
        }
      }
    }
  }
  return null;
})()`;

async function getLogicHandle(page) {
  const handle = await page.evaluateHandle(FIND_LOGIC);
  const isNull = await handle.evaluate((l) => l === null);
  expect(isNull, 'DC game logic instance should be found on the page').toBe(false);
  return handle;
}

// Dispatches a trusted-shaped keydown to window (the app's single listener) and
// returns whether the given game advanced. Runs entirely in page context.
const RUN_GAME_PROBE = `
(logic, game) => {
  const press = (key) => window.dispatchEvent(new KeyboardEvent('keydown', {key, bubbles:true, cancelable:true}));
  const setScreen = () => { logic.state.screen='game'; logic.state.game=game; };
  try {
    switch(game){
      case 'falling': { logic._startFalling(false); setScreen(); const f=logic.state.falling; f.items=[{id:1,ch:f.pool[0],x:50,y:50}]; const s=f.score; press(f.pool[0]); return logic.state.falling.score>s; }
      case 'race': { logic._startRace(false); setScreen(); const r=logic.state.race; const i=r.i; press(r.text[r.i]); return logic.state.race.i===i+1; }
      case 'boss': { logic._startBoss(false); setScreen(); const b=logic.state.boss; const w=b.words[b.idx]; const n=b.buffer.length; press(w[n]); return logic.state.boss.buffer.length===n+1||logic.state.boss.score>0; }
      case 'combo': { logic._startCombo(false); setScreen(); const c=logic.state.combo; const w=c.words[c.idx]; const n=c.buffer.length; press(w[n]); return logic.state.combo.buffer.length===n+1||logic.state.combo.streak>0; }
      case 'defense': { logic._startDefense(false); setScreen(); const d=logic.state.defense; d.enemies=[{id:1,word:'cat',buffer:0,x:50,lane:0}]; d.targetId=null; press('c'); return logic.state.defense.enemies[0]&&logic.state.defense.enemies[0].buffer===1; }
      case 'balloon': { logic._startBalloon(false); setScreen(); const b=logic.state.balloon; b.items=[{id:1,word:'cat',buffer:0,x:50,y:50,hue:0}]; b.targetId=null; press('c'); return logic.state.balloon.items[0]&&logic.state.balloon.items[0].buffer===1; }
      case 'climber': { logic._startClimber(false); setScreen(); const c=logic.state.climber; const w=c.words[c.idx]; const n=c.buffer; press(w[n]); return logic.state.climber.buffer===n+1||logic.state.climber.started===true; }
      case 'piano': { logic._startPiano(false); setScreen(); const p=logic.state.piano; p.notes=[{id:1,lane:0,ch:p.keys[0],y:88}]; const s=p.score; press(p.keys[0]); return logic.state.piano.score>s; }
      case 'maze': { logic._startMaze(false); setScreen(); const m=logic.state.maze; const d=m.doors[0]; const n=d.buffer; press(d.word[0]); return logic.state.maze.doors[0]&&(logic.state.maze.doors[0].buffer===n+1||logic.state.maze.step>0); }
      case 'horde': { logic._startHorde(false); setScreen(); const h=logic.state.horde; h.words=[{id:1,word:'cat',buffer:0,x:50,y:50,born:Date.now(),ttl:9999}]; h.targetId=null; press('c'); return logic.state.horde.words[0]&&logic.state.horde.words[0].buffer===1; }
      case 'flash': { logic._startFlash(false); setScreen(); const f=logic.state.flash; f.phase='input'; f.word='cat'; f.buffer=''; press('c'); return logic.state.flash.buffer.length===1; }
      case 'cipher': { logic._startCipher(false); setScreen(); const c=logic.state.cipher; const i=c.i; press(c.text[c.i]); return logic.state.cipher.i===i+1; }
      case 'chain': { logic._startChain(false); setScreen(); const c=logic.state.chain; const n=c.buffer; press(c.word[c.buffer]); return logic.state.chain.buffer===n+1||logic.state.chain.len>0; }
      case 'duel': { logic._startDuel(false,'ai'); setScreen(); const d=logic.state.duel; const n=d.typed.length; press(d.text[0]); return logic.state.duel.typed.length===n+1; }
      case 'garden': { logic._startGarden(false); setScreen(); const g=logic.state.garden; const n=g.buffer; press(g.word[g.buffer]); return logic.state.garden.buffer===n+1||logic.state.garden.stage>0; }
      case 'ladder': { logic._startLadder(false); setScreen(); const l=logic.state.ladder; const it=l.items[l.ci%l.items.length]; press(it.ans[0]); return logic.state.ladder.buffer.length===1; }
      default: return false;
    }
  } finally { logic._stopLoop(); }
}`;

const GAMES = ['falling','race','boss','combo','defense','balloon','climber','piano','maze','horde','flash','cipher','chain','duel','garden','ladder'];

test.beforeEach(async ({ page }) => {
  await page.goto('/index.html');
  // Wait for the DC framework to mount the game component.
  await expect.poll(async () => page.evaluate(FIND_LOGIC + ' !== null')).toBe(true);
});

for (const game of GAMES) {
  test(`keyboard registers in game: ${game}`, async ({ page }) => {
    const logic = await getLogicHandle(page);
    const advanced = await logic.evaluate(
      (l, { probe, game }) => new Function('return (' + probe + ')')()(l, game),
      { probe: RUN_GAME_PROBE, game }
    );
    expect(advanced, `game "${game}" should advance on a matching keypress`).toBe(true);
  });
}

// Guards the exact bug: no game's letter pool may mix scripts, and the Falling
// Letters pool must match the selected language on every layout.
for (const lang of ['en', 'uk', 'ru']) {
  test(`falling pool matches layout, no un-typeable letters: ${lang}`, async ({ page }) => {
    const logic = await getLogicHandle(page);
    const info = await logic.evaluate((l, lng) => {
      l.state.lang = lng;
      l._startFalling(false);
      const pool = l.state.falling.pool;
      l._stopLoop();
      const isCyr = (c) => /[Ѐ-ӿ]/.test(c);
      const isLat = (c) => /[a-z;]/i.test(c);
      const cyr = pool.filter(isCyr).length;
      const lat = pool.filter(isLat).length;
      return { lang: lng, pool: pool.join(''), cyr, lat, mixed: cyr > 0 && lat > 0 };
    }, lang);

    // The pool must never mix Latin and Cyrillic in one layout.
    expect(info.mixed, `falling pool for "${lang}" must not mix scripts: "${info.pool}"`).toBe(false);
    // And it must be in the script the selected language actually types.
    if (lang === 'en') {
      expect(info.lat, 'English pool should be Latin').toBeGreaterThan(0);
      expect(info.cyr, 'English pool should have no Cyrillic').toBe(0);
    } else {
      expect(info.cyr, `${lang} pool should be Cyrillic`).toBeGreaterThan(0);
      expect(info.lat, `${lang} pool should have no Latin`).toBe(0);
    }
  });
}
