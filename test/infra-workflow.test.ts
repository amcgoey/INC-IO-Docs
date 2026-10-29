import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';

const ROOT_DIR = path.resolve(__dirname, '..');
const DOCKERIGNORE_PATH = path.join(ROOT_DIR, '.dockerignore');
const TSCONFIG_BUILD_PATH = path.join(ROOT_DIR, 'tsconfig.build.json');
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');

function findFilesRecursively(dir: string, pattern: RegExp): string[] {
  if (!fs.existsSync(dir)) return [];
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...findFilesRecursively(fullPath, pattern));
    } else if (pattern.test(entry.name)) {
      results.push(fullPath);
    }
  }
  return results;
}

describe('Infrastructure and Build Isolation Workflow (#239)', () => {
  describe('.dockerignore configuration', () => {
    it('excludes required non-runtime and sensitive directories from Docker build context', () => {
      expect(fs.existsSync(DOCKERIGNORE_PATH)).toBe(true);
      const dockerignoreContent = fs.readFileSync(DOCKERIGNORE_PATH, 'utf8');
      const lines = dockerignoreContent
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'));

      const requiredExclusions = [
        'node_modules',
        '.git',
        'infra',
        'dist',
        '.env',
        'test',
        'scratch',
        'docs',
        'lessons',
        '.agents',
        '.github',
      ];

      for (const exclusion of requiredExclusions) {
        expect(lines).toContain(exclusion);
      }
    });
  });

  describe('production TypeScript build configuration (tsconfig.build.json)', () => {
    it('exists, extends root configuration, and isolates runtime compilation scope', () => {
      expect(fs.existsSync(TSCONFIG_BUILD_PATH)).toBe(true);
      const content = fs.readFileSync(TSCONFIG_BUILD_PATH, 'utf8');
      const tsconfigBuild = JSON.parse(content);

      expect(tsconfigBuild.extends).toBe('./tsconfig.json');
      expect(tsconfigBuild.compilerOptions?.rootDir).toBe('.');
      expect(tsconfigBuild.include).toEqual(['src/**/*.ts']);
      expect(tsconfigBuild.exclude).toContain('node_modules');
      expect(tsconfigBuild.exclude).toContain('dist');
      expect(tsconfigBuild.exclude).toContain('src/**/*.test.ts');
    });
  });

  describe('package.json build and typecheck scripts', () => {
    it('configures build to use tsconfig.build.json and typecheck to validate full repository', () => {
      expect(fs.existsSync(PACKAGE_JSON_PATH)).toBe(true);
      const content = fs.readFileSync(PACKAGE_JSON_PATH, 'utf8');
      const pkg = JSON.parse(content);

      expect(pkg.scripts?.build).toBe('tsc -p tsconfig.build.json');
      expect(pkg.scripts?.typecheck).toBe('tsc --noEmit && npm --prefix infra/pulumi run typecheck');
    });
  });

  describe('production build execution and artifact isolation', () => {
    it(
      'compiles runtime code and emits server entrypoint without emitting test or infra artifacts',
      () => {
        const tscBin = require.resolve('typescript/bin/tsc');
        const distDir = path.join(ROOT_DIR, 'dist');
        if (fs.existsSync(distDir)) {
          fs.rmSync(distDir, { recursive: true, force: true });
        }

        try {
          // Compile using the production configuration
          execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.build.json'], {
            cwd: ROOT_DIR,
            encoding: 'utf8',
          });

          const serverJsPath = path.join(ROOT_DIR, 'dist', 'src', 'app', 'server.js');
          expect(fs.existsSync(serverJsPath)).toBe(true);

          // Verify no test files are emitted in dist/
          const emittedTestFiles = findFilesRecursively(path.join(ROOT_DIR, 'dist'), /\.test\.(js|d\.ts|js\.map)$/);
          expect(emittedTestFiles).toEqual([]);

          // Verify neither test/ nor infra/ are emitted under dist/
          expect(fs.existsSync(path.join(ROOT_DIR, 'dist', 'test'))).toBe(false);
          expect(fs.existsSync(path.join(ROOT_DIR, 'dist', 'infra'))).toBe(false);
        } finally {
          if (fs.existsSync(distDir)) {
            fs.rmSync(distDir, { recursive: true, force: true });
          }
        }
      },
      30000
    );

    it(
      'successfully compiles in an isolated Docker-like context where infra/ and test/ are absent',
      () => {
        const tscBin = require.resolve('typescript/bin/tsc');
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'inc-io-build-isolated-'));

        try {
          // Copy production config files
          fs.copyFileSync(
            path.join(ROOT_DIR, 'package.json'),
            path.join(tempDir, 'package.json')
          );
          fs.copyFileSync(
            path.join(ROOT_DIR, 'tsconfig.json'),
            path.join(tempDir, 'tsconfig.json')
          );
          fs.copyFileSync(
            TSCONFIG_BUILD_PATH,
            path.join(tempDir, 'tsconfig.build.json')
          );

          // Copy src directory recursively (including runtime and co-located tests)
          fs.cpSync(path.join(ROOT_DIR, 'src'), path.join(tempDir, 'src'), { recursive: true });

          // Symlink node_modules so TypeScript can resolve types
          fs.symlinkSync(
            path.join(ROOT_DIR, 'node_modules'),
            path.join(tempDir, 'node_modules'),
            'junction'
          );

          // Verify test/ and infra/ are NOT present in tempDir
          expect(fs.existsSync(path.join(tempDir, 'test'))).toBe(false);
          expect(fs.existsSync(path.join(tempDir, 'infra'))).toBe(false);

          // Run tsc in isolated directory
          execFileSync(process.execPath, [tscBin, '-p', 'tsconfig.build.json'], {
            cwd: tempDir,
            encoding: 'utf8',
          });

          // Verify dist output
          const isolatedServerJs = path.join(tempDir, 'dist', 'src', 'app', 'server.js');
          expect(fs.existsSync(isolatedServerJs)).toBe(true);

          const isolatedTestFiles = findFilesRecursively(path.join(tempDir, 'dist'), /\.test\.(js|d\.ts|js\.map)$/);
          expect(isolatedTestFiles).toEqual([]);
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      },
      30000
    );
  });
});
