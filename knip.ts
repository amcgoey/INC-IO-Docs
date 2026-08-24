import type { KnipConfig } from 'knip' assert { 'resolution-mode': 'import' };

const config: KnipConfig = {
  entry: ['src/app/server.ts'],
  project: ['src/**/*.ts', 'test/**/*.ts'],
  vitest: {
    entry: ['test/**/*.test.ts'],
  },
};

export default config;
