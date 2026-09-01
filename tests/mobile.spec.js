// @ts-check
const { test, expect } = require('@playwright/test');

// ---------------------------------------------------------------------------
// Mobile layout regression: the app must be usable on a phone-sized viewport
// (bottom tab bar, scaled keyboard, no horizontal overflow) across the main
// screens. Drives the real DC component the same way the other specs do.
// ---------------------------------------------------------------------------

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

// iPhone-ish portrait viewport (<640px -> mobile breakpoint kicks in).
test.use({ viewport: { width: 390, height: 844 } });

async function logic(page) {
  const h = await page.evaluateHandle(FIND_LOGIC);
  expect(await h.evaluate((l) => l === null), 'DC logic instance found').toBe(false);
  return h;
}

// Returns how many CSS px the document overflows the viewport horizontally.
async function hOverflow(page) {
  return page.evaluate(() =>
    Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
}

test.describe('mobile layout', () => {
  test('main screens fit the viewport with no horizontal overflow', async ({ page }, testInfo) => {
    await page.goto('/index.html');
    const lg = await logic(page);

    // Sign in and land on the hub (dismiss the welcome modal).
    await lg.evaluate((l) => { l._login('MobileTest'); l.setState({ lbModal: false, screen: 'hub' }); });
    await page.waitForTimeout(250);
    expect(await hOverflow(page), 'hub has no horizontal overflow').toBeLessThanOrEqual(4);
    await page.screenshot({ path: testInfo.outputPath('mobile-hub.png'), fullPage: false });

    // Lessons ladder.
    await lg.evaluate((l) => l.go('lessons'));
    await page.waitForTimeout(250);
    expect(await hOverflow(page), 'lessons has no horizontal overflow').toBeLessThanOrEqual(4);
    await page.screenshot({ path: testInfo.outputPath('mobile-lessons.png'), fullPage: false });

    // Typing surface (drill) — includes the on-screen keyboard.
    await lg.evaluate((l) => l._startDrill());
    await page.waitForTimeout(250);
    expect(await hOverflow(page), 'drill/keyboard has no horizontal overflow').toBeLessThanOrEqual(4);
    await page.screenshot({ path: testInfo.outputPath('mobile-drill.png'), fullPage: false });

    // Leaderboard (podium + list).
    await lg.evaluate((l) => l.go('leaderboard'));
    await page.waitForTimeout(400);
    expect(await hOverflow(page), 'leaderboard has no horizontal overflow').toBeLessThanOrEqual(4);
    await page.screenshot({ path: testInfo.outputPath('mobile-leaderboard.png'), fullPage: false });
  });

  test('sidebar becomes a bottom tab bar on mobile', async ({ page }) => {
    await page.goto('/index.html');
    const lg = await logic(page);
    await lg.evaluate((l) => { l._login('MobileTest2'); l.setState({ lbModal: false, screen: 'hub' }); });
    await page.waitForTimeout(250);
    // The .tt-side aside is fixed to the bottom by the <=640px media query.
    const pos = await page.evaluate(() => {
      const el = document.querySelector('.tt-side');
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return { position: cs.position, flexDirection: cs.flexDirection, bottomAligned: r.bottom >= window.innerHeight - 2 };
    });
    expect(pos, 'sidebar element exists').not.toBeNull();
    expect(pos.position, 'sidebar is fixed on mobile').toBe('fixed');
    expect(pos.flexDirection, 'sidebar lays out as a row on mobile').toBe('row');
    expect(pos.bottomAligned, 'sidebar sits at the bottom').toBe(true);
  });
});
