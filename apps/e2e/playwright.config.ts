import { defineConfig } from '@playwright/test';

// Real stack: API on :4000 against DATABASE_URL (run `pnpm db:reset` first), web on :5173 with mocks off.
export default defineConfig({
  testDir: 'tests',
  timeout: 60_000,
  workers: 1,
  reporter: 'list',
  use: { baseURL: 'http://localhost:5173', locale: 'uk-UA', timezoneId: 'Europe/Kyiv', viewport: { width: 1440, height: 900 } },
  webServer: [
    { command: 'pnpm --filter @clinic/api dev', url: 'http://localhost:4000/api/openapi.json', reuseExistingServer: true, cwd: '../..' },
    { command: 'pnpm --filter @clinic/web dev', url: 'http://localhost:5173', reuseExistingServer: true, cwd: '../..', env: { VITE_USE_MOCKS: '0' } },
  ],
});
