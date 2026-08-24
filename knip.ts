import type { KnipConfig } from 'knip' assert { 'resolution-mode': 'import' };

const config: KnipConfig = {
  project: ['src/**/*.ts', 'test/**/*.ts'],
  vitest: {
    entry: ['test/**/*.test.ts', 'src/**/*.test.ts'],
  },
};

export default config;
