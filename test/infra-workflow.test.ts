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

function toBashPath(targetPath: string): string {
  const normalized = targetPath.replace(/\\/g, '/');
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

  describe('CI/CD deployment workflow step order, conditional bootstrap, and create-or-replace manifest rollout (#242)', () => {
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
      const steps = parsed?.jobs?.deploy?.steps;
      expect(Array.isArray(steps)).toBe(true);
      return steps;
    }

    it('orders GCP auth, conditional bootstrap, Docker build & push, and Cloud Run & Addon rollout passes correctly', () => {
      const steps = getDeployWorkflowSteps();

      const authIdx = steps.findIndex(
        (s) => s.name === 'Authenticate to Google Cloud (WIF)'
      );
      const bootstrapIdx = steps.findIndex(
        (s) => s.name === 'Conditional First-Run Infrastructure Bootstrap'
      );
      const dockerAuthIdx = steps.findIndex(
        (s) => s.name === 'Configure Docker Authentication for Artifact Registry'
      );
      const buildDockerIdx = steps.findIndex(
        (s) => s.name === 'Build Docker Image with Version Tags'
      );
      const pushDockerIdx = steps.findIndex(
        (s) => s.name === 'Push Docker Image'
      );
      const deployAppIdx = steps.findIndex(
        (s) => s.name === 'Deploy App to Cloud Run'
      );
      const pulumiOutputIdx = steps.findIndex(
        (s) => s.name === 'Get Cloud Run URL from Pulumi'
      );
      const generateManifestIdx = steps.findIndex(
        (s) => s.name === 'Generate Google Workspace Add-on Manifest'
      );
      const deployManifestIdx = steps.findIndex(
        (s) => s.name === 'Deploy Google Workspace Add-on Manifest'
      );

      // 1) Auth occurs before conditional bootstrap
      expect(authIdx).toBeGreaterThanOrEqual(0);
      expect(bootstrapIdx).toBeGreaterThan(authIdx);

      // 2) Conditional bootstrap occurs before Docker auth and build
      expect(dockerAuthIdx).toBeGreaterThan(bootstrapIdx);
      expect(buildDockerIdx).toBeGreaterThan(bootstrapIdx);

      // 3) Docker build and auth occur before Docker push
      expect(pushDockerIdx).toBeGreaterThan(buildDockerIdx);
      expect(pushDockerIdx).toBeGreaterThan(dockerAuthIdx);

      // 4) Docker push occurs before Deploy App to Cloud Run
      expect(deployAppIdx).toBeGreaterThan(pushDockerIdx);

      // Verify Cloud Run deployment binds image to ${{ env.IMAGE_SHA_TAG }}
      const deployStep = steps[deployAppIdx];
      expect(deployStep.with).toBeDefined();
      const deployConfigMap = String(deployStep.with?.['config-map'] ?? '');
      expect(deployConfigMap).toContain('image:');
      expect(deployConfigMap).toContain('${{ env.IMAGE_SHA_TAG }}');

      // 5) Pulumi output, manifest generation, and manifest deployment sequence
      expect(pulumiOutputIdx).toBeGreaterThan(deployAppIdx);
      expect(generateManifestIdx).toBeGreaterThan(pulumiOutputIdx);
      expect(deployManifestIdx).toBeGreaterThan(generateManifestIdx);

      // Verify manifest generation uses dynamic env
      const manifestStep = steps[generateManifestIdx];
      expect(manifestStep.run).toContain('--environment "$DEPLOY_ENV"');
      expect(manifestStep.run).toContain('--service-url "$SERVICE_URL"');
    });

    describe('Conditional bootstrap script execution behavior', () => {
      function runBootstrapScript(repoExists: boolean): { calls: string[]; scriptOutput: string } {
        const bashBin = findBash();
        if (!bashBin) {
          throw new Error('Bash is not available in the current environment');
        }

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-cond-test-'));
        const callsLogFile = path.join(tempDir, 'calls.log');
        fs.writeFileSync(callsLogFile, '', 'utf8');

        // Fake gcloud binary
        const fakeGcloud = path.join(tempDir, 'gcloud');
        const gcloudScript = `#!/usr/bin/env bash
echo "gcloud $*" >> "${toBashPath(callsLogFile)}"
if [ "$1" = "artifacts" ] && [ "$2" = "repositories" ] && [ "$3" = "describe" ]; then
  ${repoExists ? 'exit 0' : 'exit 1'}
fi
exit 0
`;
        fs.writeFileSync(fakeGcloud, gcloudScript, { mode: 0o755 });

        // Fake pulumi binary
        const fakePulumi = path.join(tempDir, 'pulumi');
        const pulumiScript = `#!/usr/bin/env bash
echo "pulumi $*" >> "${toBashPath(callsLogFile)}"
exit 0
`;
        fs.writeFileSync(fakePulumi, pulumiScript, { mode: 0o755 });

        try {
          const steps = getDeployWorkflowSteps();
          const bootstrapStep = steps.find(
            (s) => s.name === 'Conditional First-Run Infrastructure Bootstrap'
          );
          expect(bootstrapStep).toBeDefined();

          const testScript = `
export PATH="${toBashPath(tempDir)}:$PATH"
export REPO_NAME="inc-io-docs"
export REGION="us-east4"
export PROJECT_ID="inc-io-docs-dev"
export PULUMI_STATE_BUCKET="gs://inc-io-docs-dev-pulumi-state"
export PULUMI_STACK="dev"

${bootstrapStep!.run!}
`;
          const output = execFileSync(bashBin, ['-c', testScript], { encoding: 'utf8' });
          const calls = fs
            .readFileSync(callsLogFile, 'utf8')
            .split(/\r?\n/)
            .filter((l) => l.trim().length > 0);

          return { calls, scriptOutput: output };
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }

      it('skips pulumi up when Artifact Registry repository already exists', () => {
        if (!findBash()) return;

        const { calls, scriptOutput } = runBootstrapScript(true);
        expect(scriptOutput).toContain('Skipping');
        const pulumiCalls = calls.filter((c) => c.startsWith('pulumi'));
        expect(pulumiCalls).toHaveLength(0);
      });

      it('executes pulumi login, stack select, and pulumi up when Artifact Registry repository does not exist', () => {
        if (!findBash()) return;

        const { calls, scriptOutput } = runBootstrapScript(false);
        expect(scriptOutput).toContain('Executing initial bootstrap pulumi up');
        const pulumiCalls = calls.filter((c) => c.startsWith('pulumi'));
        expect(pulumiCalls.some((c) => c.includes('login'))).toBe(true);
        expect(pulumiCalls.some((c) => c.includes('stack select'))).toBe(true);
        expect(pulumiCalls.some((c) => c.includes('up'))).toBe(true);
      });
    });

    describe('Workspace Add-on create-or-replace deployment script behavior', () => {
      function runAddonDeployScript(deploymentExists: boolean): { calls: string[]; scriptOutput: string } {
        const bashBin = findBash();
        if (!bashBin) {
          throw new Error('Bash is not available in the current environment');
        }

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'addon-deploy-test-'));
        const callsLogFile = path.join(tempDir, 'calls.log');
        fs.writeFileSync(callsLogFile, '', 'utf8');

        // Fake gcloud binary
        const fakeGcloud = path.join(tempDir, 'gcloud');
        const gcloudScript = `#!/usr/bin/env bash
echo "gcloud $*" >> "${toBashPath(callsLogFile)}"
if [ "$1" = "workspace-add-ons" ] && [ "$2" = "deployments" ] && [ "$3" = "describe" ]; then
  ${deploymentExists ? 'exit 0' : 'exit 1'}
fi
exit 0
`;
        fs.writeFileSync(fakeGcloud, gcloudScript, { mode: 0o755 });

        try {
          const steps = getDeployWorkflowSteps();
          const addonDeployStep = steps.find(
            (s) => s.name === 'Deploy Google Workspace Add-on Manifest'
          );
          expect(addonDeployStep).toBeDefined();

          const testScript = `
export PATH="${toBashPath(tempDir)}:$PATH"
export REPO_NAME="inc-io-docs"
export PROJECT_ID="inc-io-docs-dev"

${addonDeployStep!.run!}
`;
          const output = execFileSync(bashBin, ['-c', testScript], { encoding: 'utf8' });
          const calls = fs
            .readFileSync(callsLogFile, 'utf8')
            .split(/\r?\n/)
            .filter((l) => l.trim().length > 0);

          return { calls, scriptOutput: output };
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }

      it('executes deployments replace when deployment already exists', () => {
        if (!findBash()) return;

        const { calls, scriptOutput } = runAddonDeployScript(true);
        expect(scriptOutput).toContain('Running deployments replace');
        const replaceCall = calls.find((c) => c.includes('deployments replace'));
        expect(replaceCall).toBeDefined();
        const createCall = calls.find((c) => c.includes('deployments create'));
        expect(createCall).toBeUndefined();
      });

      it('executes deployments create when deployment does not exist', () => {
        if (!findBash()) return;

        const { calls, scriptOutput } = runAddonDeployScript(false);
        expect(scriptOutput).toContain('Running deployments create');
        const createCall = calls.find((c) => c.includes('deployments create'));
        expect(createCall).toBeDefined();
        const replaceCall = calls.find((c) => c.includes('deployments replace'));
        expect(replaceCall).toBeUndefined();
      });
    });

    describe('Docker version tagging script behavior', () => {
      it('exports SHA and latest on develop, and adds v${PACKAGE_VERSION} on prod', () => {
        const bashBin = findBash();
        if (!bashBin) return;

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-tag-test-'));
        const githubEnvDev = path.join(tempDir, 'github_env_dev');
        const githubEnvProd = path.join(tempDir, 'github_env_prod');
        fs.writeFileSync(githubEnvDev, '', 'utf8');
        fs.writeFileSync(githubEnvProd, '', 'utf8');

        // Fake docker binary
        const fakeDocker = path.join(tempDir, 'docker');
        const dockerScript = `#!/usr/bin/env bash
exit 0
`;
        fs.writeFileSync(fakeDocker, dockerScript, { mode: 0o755 });

        try {
          const steps = getDeployWorkflowSteps();
          const buildStep = steps.find(
            (s) => s.name === 'Build Docker Image with Version Tags'
          );
          expect(buildStep).toBeDefined();

          // Dev execution
          const devScript = `
export PATH="${toBashPath(tempDir)}:$PATH"
export GITHUB_ENV="${toBashPath(githubEnvDev)}"
export GITHUB_SHA="mocksha123456"
export DEPLOY_ENV="dev"
export REGION="us-east4"
export PROJECT_ID="inc-io-docs-dev"
export REPO_NAME="inc-io-docs"

${buildStep!.run!}
`;
          execFileSync(bashBin, ['-c', devScript], { cwd: ROOT_DIR, encoding: 'utf8' });
          const devEnv = fs.readFileSync(githubEnvDev, 'utf8');
          expect(devEnv).toContain('IMAGE_SHA_TAG=us-east4-docker.pkg.dev/inc-io-docs-dev/inc-io-docs/inc-io-docs:mocksha123456');
          expect(devEnv).toContain('IMAGE_LATEST=us-east4-docker.pkg.dev/inc-io-docs-dev/inc-io-docs/inc-io-docs:latest');
          expect(devEnv).not.toContain('IMAGE_VERSION_TAG=');

          // Prod execution
          const prodScript = `
export PATH="${toBashPath(tempDir)}:$PATH"
export GITHUB_ENV="${toBashPath(githubEnvProd)}"
export GITHUB_SHA="mocksha123456"
export DEPLOY_ENV="prod"
export REGION="us-east4"
export PROJECT_ID="inc-io-docs-prod"
export REPO_NAME="inc-io-docs"

${buildStep!.run!}
`;
          execFileSync(bashBin, ['-c', prodScript], { cwd: ROOT_DIR, encoding: 'utf8' });
          const prodEnv = fs.readFileSync(githubEnvProd, 'utf8');
          expect(prodEnv).toContain('IMAGE_SHA_TAG=us-east4-docker.pkg.dev/inc-io-docs-prod/inc-io-docs/inc-io-docs:mocksha123456');
          expect(prodEnv).toContain('IMAGE_LATEST=us-east4-docker.pkg.dev/inc-io-docs-prod/inc-io-docs/inc-io-docs:latest');
          expect(prodEnv).toContain('IMAGE_VERSION_TAG=us-east4-docker.pkg.dev/inc-io-docs-prod/inc-io-docs/inc-io-docs:v0.5.0');
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      });
    });
  });
});
