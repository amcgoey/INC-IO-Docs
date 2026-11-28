import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

const ROOT_DIR = path.resolve(__dirname, '../..');
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');

function listVitestFiles(configFile?: string, extraArgs: string[] = []): string[] {
  const vitestBin = path.join(ROOT_DIR, 'node_modules/vitest/vitest.mjs');
  const args = [vitestBin, 'list', '--filesOnly'];
  if (configFile) {
    args.push('--config', configFile);
  }
  args.push(...extraArgs);

  const output = execFileSync(process.execPath, args, {
    cwd: ROOT_DIR,
    encoding: 'utf8',
  });

  return output
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^\[[^\]]+\]\s*/, '').replace(/\\/g, '/'))
    .filter((line) => line.length > 0);
}

describe('Four-Tier Test Suite Partitioning & Live Suite Consolidation', () => {
  it('defines all four test tiers and five scoped live scripts in package.json', () => {
    const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const scripts = pkg.scripts ?? {};

    expect(scripts.test).toBeDefined();
    expect(scripts['test:infra']).toBeDefined();
    expect(scripts['test:infra']).toContain('vitest.infra.config.mts');
    expect(scripts['test:infra']).toContain('infra/pulumi');
    expect(scripts['test:all']).toBeDefined();
    expect(scripts['test:all']).toContain('vitest.all.config.mts');
    expect(scripts['test:all']).toContain('infra/pulumi');
    expect(scripts['test:live']).toBeDefined();
    expect(scripts['test:live']).toContain('vitest.live.config.mts');
    expect(scripts['test:live:sheets']).toContain('test/live/sheets.live.test.ts');
    expect(scripts['test:live:arch']).toContain('test/live/document-log-arch.live.test.ts');
    expect(scripts['test:live:ffe']).toContain('test/live/document-log-ffe.live.test.ts');
    expect(scripts['test:live:cover-sheet']).toContain('test/live/submittal-cover-sheet.live.test.ts');
    expect(scripts['test:live:space']).toContain('test/live/document-space.live.test.ts');
  });

  it('excludes live Google suites, bootstrap tests, and infra-workflow tests from the default offline test runner while keeping offline E2E helpers active', () => {
    const offlineFiles = listVitestFiles();

    expect(offlineFiles).toContain('test/e2e/workspace-addon-e2e.test.ts');
    expect(offlineFiles).toContain('test/e2e/live-google-auth.test.ts');
    expect(offlineFiles).toContain('test/e2e/live-sheets-helper.test.ts');

    expect(offlineFiles).not.toContain('test/infra-workflow.test.ts');
    expect(offlineFiles.some((file) => file.startsWith('test/live/'))).toBe(false);
    expect(offlineFiles.some((file) => file.startsWith('test/infra/'))).toBe(false);
  }, 30_000);

  it('resolves bootstrap and infra-workflow tests via vitest.infra.config.mts', () => {
    expect(fs.existsSync(path.join(ROOT_DIR, 'vitest.infra.config.mts'))).toBe(true);
    const infraFiles = listVitestFiles('vitest.infra.config.mts');

    expect(infraFiles.sort()).toEqual([
      'test/infra-workflow.test.ts',
      'test/infra/bootstrap.test.ts',
    ]);
  }, 30_000);

  it('unifies offline app and infrastructure Vitest projects under vitest.all.config.mts without live suites', () => {
    const allConfigPath = path.join(ROOT_DIR, 'vitest.all.config.mts');
    expect(fs.existsSync(allConfigPath)).toBe(true);

    const offlineFiles = listVitestFiles('vitest.config.mts');
    const infraFiles = listVitestFiles('vitest.infra.config.mts');
    const allFiles = listVitestFiles('vitest.all.config.mts');

    expect(allFiles.sort()).toEqual([...offlineFiles, ...infraFiles].sort());
    expect(allFiles.some((file) => file.startsWith('test/live/'))).toBe(false);
  }, 30_000);

  it('consolidates all five live Google suites under test/live/*.live.test.ts with sequential config and 120,000 ms timeouts', async () => {
    const liveConfigPath = path.join(ROOT_DIR, 'vitest.live.config.mts');
    expect(fs.existsSync(liveConfigPath)).toBe(true);

    const liveConfigText = fs.readFileSync(liveConfigPath, 'utf8');
    expect(liveConfigText).toContain('fileParallelism: false');
    expect(liveConfigText).toMatch(/testTimeout:\s*120_?000/);
    expect(liveConfigText).toMatch(/hookTimeout:\s*120_?000/);

    const liveFiles = listVitestFiles('vitest.live.config.mts');
    expect(liveFiles.sort()).toEqual([
      'test/live/document-log-arch.live.test.ts',
      'test/live/document-log-ffe.live.test.ts',
      'test/live/document-space.live.test.ts',
      'test/live/sheets.live.test.ts',
      'test/live/submittal-cover-sheet.live.test.ts',
    ]);

    const scopedTargets = [
      'test/live/sheets.live.test.ts',
      'test/live/document-log-arch.live.test.ts',
      'test/live/document-log-ffe.live.test.ts',
      'test/live/submittal-cover-sheet.live.test.ts',
      'test/live/document-space.live.test.ts',
    ];
    for (const target of scopedTargets) {
      expect(listVitestFiles('vitest.live.config.mts', [target])).toEqual([target]);
    }

    expect(fs.existsSync(path.join(ROOT_DIR, 'test/infrastructure/sheets.test.ts'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT_DIR, 'test/e2e/document-log-live.test.ts'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT_DIR, 'test/e2e/submittal-cover-sheet-live.test.ts'))).toBe(false);
    expect(fs.existsSync(path.join(ROOT_DIR, 'test/validation/document-space-e2e.test.ts'))).toBe(false);
  }, 30_000);
});
