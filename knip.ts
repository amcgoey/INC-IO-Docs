import type { KnipConfig } from 'knip' with { 'resolution-mode': 'import' };

const config: KnipConfig = {
  project: ['src/**/*.ts', 'test/**/*.ts'],
  vitest: {
    entry: ['test/**/*.test.ts', 'src/**/*.test.ts', 'test/e2e/**/*-e2e.ts'],
  },
  ignoreBinaries: ['semgrep'],
};

export default config;
