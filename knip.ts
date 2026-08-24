import type { KnipConfig } from 'knip' with { 'resolution-mode': 'import' };

const config: KnipConfig = {
  project: ['src/**/*.ts', 'test/**/*.ts'],
  vitest: {
    entry: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
  ignoreBinaries: ['semgrep'],
};

export default config;
