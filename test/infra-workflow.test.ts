import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import * as YAML from 'yaml';
import {
  verifyDeploymentReadiness,
  type DeploymentReadinessPort,
} from '../infra/deployment-readiness';

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
      const gcloudSetupIdx = steps.findIndex(
        (s) => s.name === 'Set up Google Cloud SDK'
      );
      const pulumiSetupIdx = steps.findIndex(
        (s) => s.name === 'Set up Pulumi CLI'
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
      const smokeTestIdx = steps.findIndex(
        (s) => s.name === 'Verify Deployment Readiness (Smoke Test)'
      );

      // 1) Auth and tooling setup occur before conditional bootstrap
      expect(authIdx).toBeGreaterThanOrEqual(0);
      expect(gcloudSetupIdx).toBeGreaterThan(authIdx);
      expect(pulumiSetupIdx).toBeGreaterThan(gcloudSetupIdx);
      expect(bootstrapIdx).toBeGreaterThan(pulumiSetupIdx);
      expect(steps[pulumiSetupIdx].uses).toBe('pulumi/actions@v6');

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

      // 5) Pulumi output, manifest generation, manifest deployment, and smoke verification sequence
      expect(pulumiOutputIdx).toBeGreaterThan(deployAppIdx);
      expect(generateManifestIdx).toBeGreaterThan(pulumiOutputIdx);
      expect(deployManifestIdx).toBeGreaterThan(generateManifestIdx);
      expect(smokeTestIdx).toBeGreaterThan(deployManifestIdx);

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

    describe('Post-deployment smoke verification module and workflow behavior (#243)', () => {
      interface SmokeMockConfig {
        cloudRunJson?: Record<string, unknown>;
        cloudRunThrows?: boolean;
        addonJson?: Record<string, unknown>;
        addonThrows?: boolean;
        oidcCredential?: string;
        unauthHttpStatus?: number;
        authHttpStatus?: number;
        authResponseBody?: Record<string, unknown> | string;
      }

      async function runSmokeVerification(config: SmokeMockConfig = {}): Promise<{
        status: number;
        stdout: string;
        stderr: string;
        calls: string[];
      }> {
        const calls: string[] = [];
        const logs: string[] = [];

        const defaultCloudRun = {
          uri: 'https://inc-io-docs-dev-example.a.run.app',
          latestReadyRevisionName: 'inc-io-docs-00001-abc',
          latestCreatedRevisionName: 'inc-io-docs-00001-abc',
          status: {
            url: 'https://inc-io-docs-dev-example.a.run.app',
            latestReadyRevisionName: 'inc-io-docs-00001-abc',
            latestCreatedRevisionName: 'inc-io-docs-00001-abc',
            conditions: [{ type: 'Ready', status: 'True' }],
          },
        };
        const cloudRunData =
          config.cloudRunJson !== undefined ? config.cloudRunJson : defaultCloudRun;

        const defaultAddon = {
          name: 'projects/inc-io-docs-dev/deployments/inc-io-docs',
          addOns: {
            common: {
              homepageTrigger: {
                runFunction: 'https://inc-io-docs-dev-example.a.run.app/workspace/homepage',
              },
            },
          },
        };
        const addonData = config.addonJson !== undefined ? config.addonJson : defaultAddon;

        const defaultAuthBody = {
          action: {
            navigations: [
              {
                pushCard: {
                  header: { title: 'INC-IO Engine' },
                  sections: [],
                },
              },
            ],
          },
        };
        const authBody =
          config.authResponseBody !== undefined
            ? typeof config.authResponseBody === 'string'
              ? config.authResponseBody
              : JSON.stringify(config.authResponseBody)
            : JSON.stringify(defaultAuthBody);

        const adapter: DeploymentReadinessPort = {
          log: (msg) => logs.push(msg),
          async describeCloudRunService({ serviceName, region, projectId }) {
            calls.push(`describeCloudRunService:${serviceName}:${region}:${projectId}`);
            if (config.cloudRunThrows) {
              throw new Error('gcloud run services describe failed');
            }
            return cloudRunData;
          },
          async describeWorkspaceAddonDeployment({ repoName, projectId }) {
            calls.push(`describeWorkspaceAddonDeployment:${repoName}:${projectId}`);
            if (config.addonThrows) {
              throw new Error('gcloud workspace-add-ons deployments describe failed');
            }
            return addonData;
          },
          async postWorkspaceHomepage({ url, authorizationBearer }) {
            if (authorizationBearer) {
              calls.push(`postWorkspaceHomepage:auth:${url}`);
              return {
                status: config.authHttpStatus ?? 200,
                body: authBody,
              };
            }
            calls.push(`postWorkspaceHomepage:unauth:${url}`);
            return {
              status: config.unauthHttpStatus ?? 401,
              body: '',
            };
          },
        };

        try {
          await verifyDeploymentReadiness(
            {
              serviceUrl: 'https://inc-io-docs-dev-example.a.run.app',
              serviceName: 'inc-io-docs-service',
              region: 'us-east4',
              projectId: 'inc-io-docs-dev',
              repoName: 'inc-io-docs',
              oidcBearerCredential:
                config.oidcCredential !== undefined ? config.oidcCredential : 'mock-oidc-jwt',
            },
            adapter
          );
          return {
            status: 0,
            stdout: logs.join('\n'),
            stderr: '',
            calls,
          };
        } catch (error) {
          return {
            status: 1,
            stdout: logs.join('\n'),
            stderr: error instanceof Error ? error.message : String(error),
            calls,
          };
        }
      }

      it('passes all 4 checks in order with happy-path inputs', async () => {
        const res = await runSmokeVerification();
        expect(res.status).toBe(0);
        expect(res.stdout).toContain('Cloud Run revision readiness verified');
        expect(res.stdout).toContain('Workspace Add-on homepageTrigger verified');
        expect(res.stdout).toContain('IAM privacy verified');
        expect(res.stdout).toContain('Authenticated Workspace Add-on execution verified');

        expect(res.calls).toEqual([
          'describeCloudRunService:inc-io-docs-service:us-east4:inc-io-docs-dev',
          'describeWorkspaceAddonDeployment:inc-io-docs:inc-io-docs-dev',
          'postWorkspaceHomepage:unauth:https://inc-io-docs-dev-example.a.run.app/workspace/homepage',
          'postWorkspaceHomepage:auth:https://inc-io-docs-dev-example.a.run.app/workspace/homepage',
        ]);
      });

      it('fails Check 1 when Cloud Run service URI does not match $SERVICE_URL', async () => {
        const res = await runSmokeVerification({
          cloudRunJson: {
            uri: 'https://wrong-uri.run.app',
            latestReadyRevisionName: 'rev-1',
            latestCreatedRevisionName: 'rev-1',
            conditions: [{ type: 'Ready', status: 'True' }],
          },
        });
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('URI mismatch');
      });

      it('fails Check 1 when latestReadyRevisionName != latestCreatedRevisionName', async () => {
        const res = await runSmokeVerification({
          cloudRunJson: {
            uri: 'https://inc-io-docs-dev-example.a.run.app',
            latestReadyRevisionName: 'rev-old',
            latestCreatedRevisionName: 'rev-new',
            conditions: [{ type: 'Ready', status: 'True' }],
          },
        });
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('revision mismatch');
      });

      it('fails Check 1 when Ready condition status is not True', async () => {
        const res = await runSmokeVerification({
          cloudRunJson: {
            uri: 'https://inc-io-docs-dev-example.a.run.app',
            latestReadyRevisionName: 'rev-1',
            latestCreatedRevisionName: 'rev-1',
            conditions: [{ type: 'Ready', status: 'False' }],
          },
        });
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('Ready');
      });

      it('fails Check 1 when describeCloudRunService fails', async () => {
        const res = await runSmokeVerification({
          cloudRunThrows: true,
        });
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('Failed to query Cloud Run service');
      });

      it('fails Check 2 when Workspace Add-on trigger URL does not match ${SERVICE_URL}/workspace/homepage', async () => {
        const res = await runSmokeVerification({
          addonJson: {
            addOns: {
              common: {
                homepageTrigger: {
                  runFunction: 'https://inc-io-docs-dev-example.a.run.app/wrong-path',
                },
              },
            },
          },
        });
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('trigger mismatch');
      });

      it('fails Check 2 when describeWorkspaceAddonDeployment fails', async () => {
        const res = await runSmokeVerification({
          addonThrows: true,
        });
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('Failed to query Workspace Add-on deployment');
      });

      it('fails Check 3 when unauthenticated probe returns HTTP 200 instead of 401 or 403', async () => {
        const res = await runSmokeVerification({
          unauthHttpStatus: 200,
        });
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('IAM privacy check failed');
      });

      it('passes Check 3 when unauthenticated probe returns HTTP 403', async () => {
        const res = await runSmokeVerification({
          unauthHttpStatus: 403,
        });
        expect(res.status).toBe(0);
        expect(res.stdout).toContain(
          'IAM privacy verified: unauthenticated request rejected with HTTP 403'
        );
      });

      it('fails Check 4 when OIDC token is empty', async () => {
        const res = await runSmokeVerification({
          oidcCredential: '',
        });
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('identity token');
      });

      it('fails Check 4 when authenticated probe returns HTTP 500', async () => {
        const res = await runSmokeVerification({
          authHttpStatus: 500,
        });
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('500');
      });

      it('fails Check 4 when authenticated response body is invalid or not a Workspace Card response', async () => {
        const res = await runSmokeVerification({
          authResponseBody: { invalid: 'response' },
        });
        expect(res.status).not.toBe(0);
        expect(res.stderr).toContain('not a valid Google Workspace Card response');
      });
    });

    describe('Publish GitHub Release step execution behavior (#244)', () => {
      interface ReleaseMockConfig {
        releaseViewExitCode?: number;
        gitLsRemoteExitCode?: number;
        githubSha?: string;
        packageVersion?: string;
      }

      function runPublishReleaseScript(config: ReleaseMockConfig = {}): {
        status: number;
        stdout: string;
        stderr: string;
        calls: string[];
      } {
        const bashBin = findBash();
        if (!bashBin) {
          throw new Error('Bash is not available in the current environment');
        }

        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'release-publish-test-'));
        const callsLogFile = path.join(tempDir, 'calls.log');
        fs.writeFileSync(callsLogFile, '', 'utf8');

        const releaseViewExit = config.releaseViewExitCode ?? 1;
        const gitLsRemoteExit = config.gitLsRemoteExitCode ?? 1;

        // Fake gh script
        const fakeGh = path.join(tempDir, 'gh');
        const ghScript = `#!/usr/bin/env bash
echo "gh $*" >> "${toBashPath(callsLogFile)}"
if [ "$1" = "release" ] && [ "$2" = "view" ]; then
  exit ${releaseViewExit}
fi
if [ "$1" = "release" ] && [ "$2" = "create" ]; then
  exit 0
fi
exit 0
`;
        fs.writeFileSync(fakeGh, ghScript, { mode: 0o755 });

        // Fake git script
        const fakeGit = path.join(tempDir, 'git');
        const gitScript = `#!/usr/bin/env bash
echo "git $*" >> "${toBashPath(callsLogFile)}"
if [ "$1" = "ls-remote" ]; then
  exit ${gitLsRemoteExit}
fi
exit 0
`;
        fs.writeFileSync(fakeGit, gitScript, { mode: 0o755 });

        try {
          const steps = getDeployWorkflowSteps();
          const releaseStep = steps.find(
            (s) => s.name === 'Publish GitHub Release on Main'
          );
          expect(releaseStep).toBeDefined();

          const testScript = `
export PATH="${toBashPath(tempDir)}:$PATH"
export GITHUB_SHA="${config.githubSha ?? 'testsha987654321'}"
export GH_TOKEN="mock-github-token"
${config.packageVersion ? `export PACKAGE_VERSION="${config.packageVersion}"` : ''}

${releaseStep!.run!}
`;
          const res = spawnSync(bashBin, ['-c', testScript], {
            cwd: ROOT_DIR,
            encoding: 'utf8',
          });

          const calls = fs
            .readFileSync(callsLogFile, 'utf8')
            .split(/\r?\n/)
            .filter((l) => l.trim().length > 0);

          return {
            status: res.status ?? 0,
            stdout: res.stdout || '',
            stderr: res.stderr || '',
            calls,
          };
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }

      it('creates GitHub Release when neither release nor git tag exists', () => {
        if (!findBash()) return;

        const res = runPublishReleaseScript({
          releaseViewExitCode: 1,
          gitLsRemoteExitCode: 1,
          githubSha: 'commit123456789',
        });

        expect(res.status).toBe(0);
        expect(res.calls.some((c) => c.startsWith('gh release view'))).toBe(true);
        expect(res.calls.some((c) => c.startsWith('git ls-remote'))).toBe(true);

        const createCall = res.calls.find((c) => c.startsWith('gh release create'));
        expect(createCall).toBeDefined();
        expect(createCall).toContain('v0.5.0');
        expect(createCall).toContain('--target commit123456789');
        expect(createCall).toContain('--title v0.5.0');
        expect(createCall).toContain('--generate-notes');
        expect(createCall).not.toContain('.tar.gz');
        expect(createCall).not.toContain('.zip');
      });

      it('skips release creation when release already exists in gh release view', () => {
        if (!findBash()) return;

        const res = runPublishReleaseScript({
          releaseViewExitCode: 0,
          gitLsRemoteExitCode: 1,
        });

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('Release v0.5.0 already exists; skipping release creation.');
        expect(res.calls.some((c) => c.startsWith('gh release view'))).toBe(true);
        expect(res.calls.some((c) => c.startsWith('git ls-remote'))).toBe(false);
        expect(res.calls.some((c) => c.startsWith('gh release create'))).toBe(false);
      });

      it('skips release creation when tag already exists in git ls-remote', () => {
        if (!findBash()) return;

        const res = runPublishReleaseScript({
          releaseViewExitCode: 1,
          gitLsRemoteExitCode: 0,
        });

        expect(res.status).toBe(0);
        expect(res.stdout).toContain('Release v0.5.0 already exists; skipping release creation.');
        expect(res.calls.some((c) => c.startsWith('gh release view'))).toBe(true);
        expect(res.calls.some((c) => c.startsWith('git ls-remote'))).toBe(true);
        expect(res.calls.some((c) => c.startsWith('gh release create'))).toBe(false);
      });

      it('creates GitHub Release utilizing PACKAGE_VERSION from environment when provided', () => {
        if (!findBash()) return;

        const res = runPublishReleaseScript({
          releaseViewExitCode: 1,
          gitLsRemoteExitCode: 1,
          githubSha: 'commit123456789',
          packageVersion: '0.5.0-rc1',
        });

        expect(res.status).toBe(0);
        const createCall = res.calls.find((c) => c.startsWith('gh release create'));
        expect(createCall).toBeDefined();
        expect(createCall).toContain('v0.5.0-rc1');
      });
    });
  });
});
