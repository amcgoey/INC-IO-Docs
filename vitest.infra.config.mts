import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    include: ['test/infra/**/*.test.ts'],
    exclude: [...configDefaults.exclude, 'test/live/**'],
    testTimeout: 30_000,
    maxConcurrency: 5,
  },
});
