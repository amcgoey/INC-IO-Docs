import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import * as YAML from 'yaml';

const ROOT_DIR = path.resolve(__dirname, '..');
const DOCKERIGNORE_PATH = path.join(ROOT_DIR, '.dockerignore');
const TSCONFIG_BUILD_PATH = path.join(ROOT_DIR, 'tsconfig.build.json');
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');
const DEPLOY_YML_PATH = path.join(ROOT_DIR, '.github', 'workflows', 'deploy.yml');

function findBash(): string | undefined {
  try {
    const res = spawnSync('bash', ['--version'], { encoding: 'utf8' });
    if (res.status === 0) return 'bash';
  } catch {
    // ignore
  }
  if (process.platform === 'win32') {
    const gitBash = 'C:\\Program Files\\Git\\bin\\bash.exe';
    if (fs.existsSync(gitBash)) return gitBash;
    const gitUsrBash = 'C:\\Program Files\\Git\\usr\\bin\\bash.exe';
    if (fs.existsSync(gitUsrBash)) return gitUsrBash;
  }
  return undefined;
}

function toBashPath(p: string): string {
  const normalized = p.replace(/\\/g, '/');
  return normalized.replace(/^([A-Za-z]):/, (_, drive) => `/${drive.toLowerCase()}`);
}

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

  describe('CI/CD deployment workflow step order and bootstrap image handling (#240)', () => {
    interface WorkflowStep {
      name?: string;
      id?: string;
      uses?: string;
      run?: string;
      with?: Record<string, unknown>;
    }

    function getDeployWorkflowSteps(): WorkflowStep[] {
      expect(fs.existsSync(DEPLOY_YML_PATH)).toBe(true);
      const content = fs.readFileSync(DEPLOY_YML_PATH, 'utf8');
      const parsed = YAML.parse(content);
      const steps = parsed?.jobs?.['build-and-deploy']?.steps;
      expect(Array.isArray(steps)).toBe(true);
      return steps;
    }

    it('orders pre-flight Docker build, bootstrap image resolution, and deployment passes correctly', () => {
      const steps = getDeployWorkflowSteps();

      const buildLocalIdx = steps.findIndex(
        (s) => s.name === 'Build Docker Image (Local)'
      );
      const authIdx = steps.findIndex(
        (s) => s.name === 'Authenticate to Google Cloud (WIF)'
      );
      const resolveBootstrapIdx = steps.findIndex(
        (s) => s.name === 'Resolve Bootstrap Image for Base Service'
      );
      const provisionInfraIdx = steps.findIndex(
        (s) => s.name === 'Provision Infrastructure (Artifact Registry & Base Service)'
      );
      const dockerAuthIdx = steps.findIndex(
        (s) => s.name === 'Configure Docker Authentication for Artifact Registry'
      );
      const pushDockerIdx = steps.findIndex(
        (s) => s.name === 'Push Docker Image'
      );
      const deployAppIdx = steps.findIndex(
        (s) => s.name === 'Deploy App to Cloud Run'
      );

      // 1) "Build Docker Image (Local)" occurs before GCP auth and before "Provision Infrastructure"
      expect(buildLocalIdx).toBeGreaterThanOrEqual(0);
      expect(authIdx).toBeGreaterThanOrEqual(0);
      expect(provisionInfraIdx).toBeGreaterThanOrEqual(0);
      expect(buildLocalIdx).toBeLessThan(authIdx);
      expect(buildLocalIdx).toBeLessThan(provisionInfraIdx);

      // Verify "Build Docker Image (Local)" builds with IMAGE_TAG and IMAGE_LATEST and exports them
      const buildStep = steps[buildLocalIdx];
      expect(buildStep.run).toContain('docker build');
      expect(buildStep.run).toContain('IMAGE_TAG=');
      expect(buildStep.run).toContain('IMAGE_LATEST=');
      expect(buildStep.run).toContain('>> $GITHUB_ENV');

      // 2) "Resolve Bootstrap Image for Base Service" occurs before "Provision Infrastructure"
      expect(resolveBootstrapIdx).toBeGreaterThanOrEqual(0);
      expect(resolveBootstrapIdx).toBeLessThan(provisionInfraIdx);

      // 3) "Provision Infrastructure" config-map binds image to ${{ env.BOOTSTRAP_IMAGE }}
      const provisionStep = steps[provisionInfraIdx];
      expect(provisionStep.with).toBeDefined();
      const provisionConfigMap = String(provisionStep.with?.['config-map'] ?? '');
      expect(provisionConfigMap).toContain('image:');
      expect(provisionConfigMap).toContain('${{ env.BOOTSTRAP_IMAGE }}');

      // 4) Docker authentication and push steps occur after "Provision Infrastructure" and before "Deploy App to Cloud Run"
      expect(dockerAuthIdx).toBeGreaterThan(provisionInfraIdx);
      expect(pushDockerIdx).toBeGreaterThan(provisionInfraIdx);
      expect(dockerAuthIdx).toBeLessThan(deployAppIdx);
      expect(pushDockerIdx).toBeLessThan(deployAppIdx);

      // Verify "Push Docker Image" pushes IMAGE_TAG and IMAGE_LATEST
      const pushStep = steps[pushDockerIdx];
      expect(pushStep.run).toContain('docker push "$IMAGE_TAG"');
      expect(pushStep.run).toContain('docker push "$IMAGE_LATEST"');

      // 5) "Deploy App to Cloud Run" config-map binds image to ${{ env.IMAGE_TAG }}
      const deployStep = steps[deployAppIdx];
      expect(deployStep.with).toBeDefined();
      const deployConfigMap = String(deployStep.with?.['config-map'] ?? '');
      expect(deployConfigMap).toContain('image:');
      expect(deployConfigMap).toContain('${{ env.IMAGE_TAG }}');
    });

    describe('BOOTSTRAP_IMAGE resolution script behavior', () => {
      it('contains robust query syntax with fallback to us-docker.pkg.dev/cloudrun/container/hello', () => {
        const steps = getDeployWorkflowSteps();
        const resolveBootstrapStep = steps.find(
          (s) => s.name === 'Resolve Bootstrap Image for Base Service'
        );
        expect(resolveBootstrapStep).toBeDefined();
        const runScript = resolveBootstrapStep?.run ?? '';

        expect(runScript).toContain('gcloud run services describe');
        expect(runScript).toContain('--format="value(spec.template.spec.containers[0].image)"');
        expect(runScript).toContain('2>/dev/null || true');
        expect(runScript).toContain('us-docker.pkg.dev/cloudrun/container/hello');
        expect(runScript).toContain('echo "BOOTSTRAP_IMAGE=$BOOTSTRAP_IMAGE" >> $GITHUB_ENV');
      });

      it('resolves active image when gcloud run services describe returns an image', () => {
        const bashBin = findBash();
        if (!bashBin) {
          return;
        }

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-img-test-'));
        const githubEnvFile = path.join(tempDir, 'github_env');
        fs.writeFileSync(githubEnvFile, '', 'utf8');

        // Create a fake gcloud script that returns an active image
        const fakeGcloud = path.join(tempDir, 'gcloud');
        fs.writeFileSync(
          fakeGcloud,
          '#!/usr/bin/env bash\necho "us-east4-docker.pkg.dev/inc-io-docs-dev/inc-io-docs/inc-io-docs:active-tag-1234"\n',
          { mode: 0o755 }
        );

        try {
          const steps = getDeployWorkflowSteps();
          const resolveBootstrapStep = steps.find(
            (s) => s.name === 'Resolve Bootstrap Image for Base Service'
          );
          expect(resolveBootstrapStep).toBeDefined();

          const interpolatedScript = resolveBootstrapStep!.run!
            .replace(/\$\{\{\s*env\.SERVICE_NAME\s*\}\}/g, 'test-service')
            .replace(/\$\{\{\s*env\.REGION\s*\}\}/g, 'us-east4')
            .replace(/\$\{\{\s*env\.PROJECT_ID\s*\}\}/g, 'test-project');

          const testScript = `
export PATH="${toBashPath(tempDir)}:$PATH"
export GITHUB_ENV="${toBashPath(githubEnvFile)}"

${interpolatedScript}
`;
          execFileSync(bashBin, ['-c', testScript], { encoding: 'utf8' });

          const envContent = fs.readFileSync(githubEnvFile, 'utf8');
          expect(envContent).toContain(
            'BOOTSTRAP_IMAGE=us-east4-docker.pkg.dev/inc-io-docs-dev/inc-io-docs/inc-io-docs:active-tag-1234'
          );
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      });

      it('falls back to hello container when gcloud run services describe errors or returns empty', () => {
        const bashBin = findBash();
        if (!bashBin) {
          return;
        }

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-img-fallback-'));
        const githubEnvFile = path.join(tempDir, 'github_env');
        fs.writeFileSync(githubEnvFile, '', 'utf8');

        // Create a fake gcloud script that fails with exit code 1 and writes to stderr
        const fakeGcloud = path.join(tempDir, 'gcloud');
        fs.writeFileSync(
          fakeGcloud,
          '#!/usr/bin/env bash\necho "ERROR: (gcloud.run.services.describe) Cannot find service" >&2\nexit 1\n',
          { mode: 0o755 }
        );

        try {
          const steps = getDeployWorkflowSteps();
          const resolveBootstrapStep = steps.find(
            (s) => s.name === 'Resolve Bootstrap Image for Base Service'
          );
          expect(resolveBootstrapStep).toBeDefined();

          const interpolatedScript = resolveBootstrapStep!.run!
            .replace(/\$\{\{\s*env\.SERVICE_NAME\s*\}\}/g, 'test-service')
            .replace(/\$\{\{\s*env\.REGION\s*\}\}/g, 'us-east4')
            .replace(/\$\{\{\s*env\.PROJECT_ID\s*\}\}/g, 'test-project');

          const testScript = `
export PATH="${toBashPath(tempDir)}:$PATH"
export GITHUB_ENV="${toBashPath(githubEnvFile)}"

${interpolatedScript}
`;
          execFileSync(bashBin, ['-c', testScript], { encoding: 'utf8' });

          const envContent = fs.readFileSync(githubEnvFile, 'utf8');
          expect(envContent).toContain('BOOTSTRAP_IMAGE=us-docker.pkg.dev/cloudrun/container/hello');
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      });
    });
  });
});
