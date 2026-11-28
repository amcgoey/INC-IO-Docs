import { defineConfig } from 'vitest/config';
import { BaseSequencer, type TestSpecification } from 'vitest/node';
import { offlineAppProjectConfig } from './vitest.config.mts';
import { infraProjectConfig } from './vitest.infra.config.mts';

/**
 * Schedules long-running infrastructure test files first so `bootstrap.test.ts`
 * and `infra-workflow.test.ts` overlap with the offline app test pool from t=0.
 */
class InfraFirstSequencer extends BaseSequencer {
  override async sort(files: TestSpecification[]): Promise<TestSpecification[]> {
    const sorted = await super.sort(files);
    const infraFiles = sorted.filter((file) => file.project.name === 'infra');
    const appFiles = sorted.filter((file) => file.project.name !== 'infra');
    return [...infraFiles, ...appFiles];
  }
}

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    sequence: {
      sequencer: InfraFirstSequencer,
    },
    projects: [
      {
        extends: true,
        test: {
          name: 'infra',
          ...infraProjectConfig,
        },
      },
      {
        extends: true,
        test: {
          name: 'app',
          ...offlineAppProjectConfig,
        },
      },
    ],
  },
});
