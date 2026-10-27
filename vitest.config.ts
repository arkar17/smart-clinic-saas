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
          include: ['apps/api/test/**/*.int.test.ts'],
          globalSetup: ['apps/api/test/global-setup.ts'],
          fileParallelism: false,
          testTimeout: 30000,
          hookTimeout: 60000,
        },
      },
    ],
  },
});
