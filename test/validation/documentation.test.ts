import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';

describe('Repository Documentation Validation', () => {
  const repoRoot = path.resolve(__dirname, '../..');

  it('verifies that README.md exists at the repository root', () => {
    const readmePath = path.join(repoRoot, 'README.md');
    expect(fs.existsSync(readmePath)).toBe(true);
  });
});
