// @ts-check
const { defineConfig, devices } = require('@playwright/test');

// Serves the static site (index.html + support.js) and runs the game tests
// against a real Chromium instance. No build step — the app is a single
// static HTML file rendered by the bundled DC framework in support.js.
module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8123',
    // Force a Latin (US) keyboard so injected key events read as Latin `e.key`,
    // matching a real English-layout player — this is exactly the situation the
    // falling-letters bug broke.
    locale: 'en-US',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
  ],
  webServer: {
    command: 'python -m http.server 8123',
    url: 'http://127.0.0.1:8123/index.html',
    reuseExistingServer: true,
    timeout: 30000,
  },
});
