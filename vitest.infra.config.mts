import { configDefaults, defineConfig } from 'vitest/config';

export const infraProjectConfig = {
  include: ['test/infra/**/*.test.ts', 'test/infra-workflow.test.ts'],
  exclude: [...configDefaults.exclude, 'test/live/**'],
  testTimeout: 30_000,
  maxConcurrency: 5,
};

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    ...infraProjectConfig,
  },
});
