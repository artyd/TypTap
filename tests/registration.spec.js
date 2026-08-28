// @ts-check
const { test, expect } = require('@playwright/test');

// Guards the "no demo account, registration first" behaviour:
// a fresh device (empty localStorage) must open the login/registration screen
// with NO pre-seeded "Maria" profile, and entering a nickname must create a
// new profile and move to onboarding.

// Walks the React fiber tree to find the DC logic instance (it owns the game
// state — its state has a `falling` key).
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
  // Fresh device: no saved profiles.
  await page.addInitScript(() => { try { localStorage.clear(); } catch (e) {} });
  await page.goto('/index.html');
  await expect.poll(async () => page.evaluate(FIND_LOGIC + ' !== null')).toBe(true);
});

test('fresh device opens registration screen with no demo account', async ({ page }) => {
  const logic = await getLogic(page);
  const info = await logic.evaluate((l) => ({
    screen: l.state.screen,
    current: l.pdata.current,
    profileCount: Object.keys(l.pdata.profiles).length,
    hasMaria: 'Maria' in l.pdata.profiles,
  }));
  expect(info.screen, 'should land on the login/registration screen').toBe('login');
  expect(info.current, 'no active profile on a fresh device').toBeNull();
  expect(info.profileCount, 'no pre-seeded profiles').toBe(0);
  expect(info.hasMaria, 'the demo "Maria" account must be gone').toBe(false);

  // The registration form (nickname input) is visible; the app shell/sidebar is not.
  await expect(page.locator('aside.tt-side')).toHaveCount(0);
  await expect(page.locator('input[placeholder]')).toBeVisible();
});

test('entering a nickname registers a new profile and goes to onboarding', async ({ page }) => {
  const logic = await getLogic(page);
  const info = await logic.evaluate((l) => {
    l._login('NewUser');
    return { screen: l.state.screen, current: l.pdata.current, count: Object.keys(l.pdata.profiles).length };
  });
  expect(info.screen, 'a brand-new nickname should open onboarding').toBe('onboarding');
  expect(info.current).toBe('NewUser');
  expect(info.count).toBe(1);
});
