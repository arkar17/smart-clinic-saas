import { defineConfig } from 'vitest/config';

// Two projects (SC1-BE-01): unit tests are pure; integration tests need a disposable PostgreSQL (DATABASE_URL).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['{apps,packages}/*/src/**/*.test.ts'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
        },
      },
      {
        test: {
          name: 'integration',
          include: ['apps/api/test/*.int.test.ts'],
          globalSetup: ['apps/api/test/global-setup.ts'],
          fileParallelism: false,
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 30000,
          hookTimeout: 60000,
        },
      },
      {
        // SC4-FE-04: browser journeys with the preinstalled Playwright Chromium; run with `pnpm test:e2e`.
        test: {
          name: 'e2e',
          include: ['apps/api/test/e2e/*.e2e.test.ts'],
          globalSetup: ['apps/api/test/global-setup.ts'],
          pool: 'forks',
          poolOptions: { forks: { singleFork: true } },
          testTimeout: 120000,
          hookTimeout: 120000,
        },
      },
    ],
  },
});
