import { configDefaults, defineConfig } from 'vitest/config';

export const offlineAppProjectConfig = {
  include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  exclude: [...configDefaults.exclude, 'test/live/**', 'test/infra/**', 'test/infra-workflow.test.ts'],
};

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    ...offlineAppProjectConfig,
  },
});
