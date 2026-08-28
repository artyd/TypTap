// @ts-check
const { test, expect } = require('@playwright/test');

// Regression tests for keyboard-layout auto-detection.
//
// The reported bug: on machines where navigator.keyboard.getLayoutMap() returns a
// stale (page-load) layout, typing Cyrillic switched the lesson correctly for a
// moment and then the background poll immediately reverted it to English.
//
// Contract now:
//  1. A produced character (what the user actually typed) is ground truth and wins.
//  2. getLayoutMap() acts ONLY when its reading changes, and never overrides a layout
//     the user is actively typing — so a stuck "en" map can never revert Cyrillic.

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

async function getLogic(page) {
  const handle = await page.evaluateHandle(FIND_LOGIC);
  const isNull = await handle.evaluate((l) => l === null);
  expect(isNull, 'DC logic instance should be found on the page').toBe(false);
  return handle;
}

test.beforeEach(async ({ page }) => {
  // Install a controllable navigator.keyboard.getLayoutMap mock (default: English)
  // BEFORE the app mounts, and start from an empty profile store.
  await page.addInitScript(() => {
    try {
      if (!('keyboard' in navigator) || !navigator.keyboard) {
        Object.defineProperty(navigator, 'keyboard', { value: {}, configurable: true });
      }
      // @ts-ignore
      window.__setLayout = (obj) => { window.__layoutMap = new Map(Object.entries(obj)); };
      // @ts-ignore
      window.__setLayout({ KeyF: 'f', KeyS: 's', KeyD: 'd', KeyA: 'a', KeyQ: 'q' });
      // @ts-ignore
      navigator.keyboard.getLayoutMap = () => Promise.resolve(window.__layoutMap);
    } catch (e) {}
    try { localStorage.clear(); } catch (e) {}
  });
  await page.goto('/index.html');
  await expect.poll(async () => page.evaluate(FIND_LOGIC + ' !== null')).toBe(true);
});

// The core regression: a stuck English getLayoutMap must not revert typed Cyrillic.
test('typing Cyrillic switches to UK and a stuck English layout-map does not revert it', async ({ page }) => {
  const logic = await getLogic(page);
  const res = await logic.evaluate(async (l) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (l.state.screen === 'login') { l._login('T'); await wait(60); }
    l._lastKeyAt = 0; l._lastMapLayout = undefined;
    l.go('lesson'); await wait(120);
    await l._pollLayout(); await wait(30);
    const start = l.state.lang;
    // OS switched to Ukrainian; the user types a Cyrillic letter.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ф', bubbles: true }));
    await wait(120);
    const afterType = l.state.lang;
    const cyrillicText = /[Ѐ-ӿ]/.test((l.state.session && l.state.session.text) || '');
    // The stale English map keeps being polled (interval/burst) — must NOT revert.
    for (let i = 0; i < 6; i++) { await l._pollLayout(); await wait(20); }
    const afterStalePolls = l.state.lang;
    return { start, afterType, cyrillicText, afterStalePolls };
  });
  expect(res.start).toBe('en');
  expect(res.afterType, 'first Cyrillic keystroke switches the lesson to UK').toBe('uk');
  expect(res.cyrillicText, 'lesson content rebuilt in Cyrillic').toBe(true);
  expect(res.afterStalePolls, 'a stuck English layout-map must NOT kick back to English').toBe('uk');
});

// Typing Latin returns to English.
test('typing Latin from a Cyrillic layout switches back to English', async ({ page }) => {
  const logic = await getLogic(page);
  const res = await logic.evaluate(async (l) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (l.state.screen === 'login') { l._login('T'); await wait(60); }
    l._lastKeyAt = 0; l._lastMapLayout = undefined;
    l.setState({ lang: 'uk' }, () => l._startLesson(0, 0)); await wait(120);
    const start = l.state.lang;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'f', bubbles: true }));
    await wait(120);
    return { start, after: l.state.lang };
  });
  expect(res.start).toBe('uk');
  expect(res.after, 'a Latin keystroke switches back to English').toBe('en');
});

// Shift+Tab cycles the on-screen layout directly, independent of the (unreliable) system API.
test('Shift+Tab cycles the on-screen layout EN -> UK -> RU -> EN without needing the system API', async ({ page }) => {
  const logic = await getLogic(page);
  const res = await logic.evaluate(async (l) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (l.state.screen === 'login') { l._login('T'); await wait(60); }
    l._lastKeyAt = 0; l._lastMapLayout = undefined;
    l.setState({ lang: 'en' }, () => l._startLesson(0, 0)); await wait(120);
    // getLayoutMap stays stuck on English (as on the user's machine) — the cycle must still work.
    navigator.keyboard.getLayoutMap = () => Promise.resolve(new Map([['KeyF', 'f'], ['KeyS', 's']]));
    const seq = [l.state.lang];
    for (let i = 0; i < 3; i++) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true }));
      await wait(150);
      seq.push(l.state.lang);
    }
    return { seq };
  });
  expect(res.seq, 'each Shift+Tab advances the layout, wrapping back to English').toEqual(['en', 'uk', 'ru', 'en']);
});

// A layout switch surfaces a transient toast (replaces the removed top-bar chips).
test('a layout switch shows a keyboard-layout toast', async ({ page }) => {
  const logic = await getLogic(page);
  const res = await logic.evaluate(async (l) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (l.state.screen === 'login') { l._login('T'); await wait(60); }
    l._lastKeyAt = 0; l._lastMapLayout = undefined;
    l.setState({ lang: 'en', layoutToast: null }, () => l._startLesson(0, 0)); await wait(120);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'і', bubbles: true }));
    await wait(120);
    return { toastName: l.state.layoutToast && l.state.layoutToast.name };
  });
  expect(res.toastName, 'switching to a Ukrainian layout shows a toast naming it').toBe('Українська');
  // and the toast text is rendered in the DOM
  await expect(page.getByText('Українська', { exact: true })).toBeVisible();
});

// When getLayoutMap actually updates (reliable machines), a switch with no typing works.
test('a genuine layout-map change (no typing) is followed', async ({ page }) => {
  const logic = await getLogic(page);
  const res = await logic.evaluate(async (l) => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    if (l.state.screen === 'login') { l._login('T'); await wait(60); }
    l._lastKeyAt = 0; l._lastMapLayout = undefined;
    l.setState({ lang: 'en' }, () => l._startLesson(0, 0)); await wait(120);
    const start = l.state.lang;
    // Simulate the OS layout switching to Ukrainian AND getLayoutMap reflecting it.
    // @ts-ignore
    window.__setLayout({ KeyF: 'а', KeyS: 'і', Quote: 'є', BracketR: 'ї' });
    await l._pollLayout(); await wait(120);
    return { start, after: l.state.lang };
  });
  expect(res.start).toBe('en');
  expect(res.after, 'a real layout-map change to UK should be applied without typing').toBe('uk');
});
