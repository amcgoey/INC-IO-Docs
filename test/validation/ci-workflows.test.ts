import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import * as YAML from 'yaml';

const ROOT_DIR = path.resolve(__dirname, '../..');
const PACKAGE_JSON_PATH = path.join(ROOT_DIR, 'package.json');
const PACKAGE_LOCK_JSON_PATH = path.join(ROOT_DIR, 'package-lock.json');
const SEMGREP_WORKFLOW_PATH = path.join(ROOT_DIR, '.github', 'workflows', 'semgrep.yml');
const CI_WORKFLOW_PATH = path.join(ROOT_DIR, '.github', 'workflows', 'ci.yml');
const DEPLOY_WORKFLOW_PATH = path.join(ROOT_DIR, '.github', 'workflows', 'deploy.yml');

describe('CI/CD & Release Workflow Contract Validation', () => {
  describe('Package Version & Legacy Workflow Retirement', () => {
    it('declares version 0.5.0 in package.json', () => {
      const pkg = JSON.parse(fs.readFileSync(PACKAGE_JSON_PATH, 'utf8'));
      expect(pkg.version).toBe('0.5.0');
    });

    it('declares version 0.5.0 in package-lock.json', () => {
      const lock = JSON.parse(fs.readFileSync(PACKAGE_LOCK_JSON_PATH, 'utf8'));
      expect(lock.version).toBe('0.5.0');
      expect(lock.packages?.['']?.version).toBe('0.5.0');
    });

    it('does not have standalone semgrep.yml workflow', () => {
      expect(fs.existsSync(SEMGREP_WORKFLOW_PATH)).toBe(false);
    });

    it('has non-empty ci.yml and deploy.yml workflow files', () => {
      expect(fs.existsSync(CI_WORKFLOW_PATH)).toBe(true);
      const ciStat = fs.statSync(CI_WORKFLOW_PATH);
      expect(ciStat.size).toBeGreaterThan(0);

      expect(fs.existsSync(DEPLOY_WORKFLOW_PATH)).toBe(true);
      const deployStat = fs.statSync(DEPLOY_WORKFLOW_PATH);
      expect(deployStat.size).toBeGreaterThan(0);
    });
  });

  describe('CI Quality Gates Workflow Contract (ci.yml)', () => {
    it('is valid YAML', () => {
      const content = fs.readFileSync(CI_WORKFLOW_PATH, 'utf8');
      expect(() => YAML.parse(content)).not.toThrow();
    });

    it('triggers on pull_request (develop and main), workflow_call, and workflow_dispatch', () => {
      const content = fs.readFileSync(CI_WORKFLOW_PATH, 'utf8');
      const doc = YAML.parse(content);

      expect(doc.on).toBeDefined();

      // pull_request triggers
      expect(doc.on.pull_request).toBeDefined();
      const prBranches = doc.on.pull_request.branches;
      expect(prBranches).toEqual(expect.arrayContaining(['develop', 'main']));

      // workflow_call trigger (reusable)
      expect(Object.prototype.hasOwnProperty.call(doc.on, 'workflow_call')).toBe(true);

      // workflow_dispatch trigger (manual)
      expect(Object.prototype.hasOwnProperty.call(doc.on, 'workflow_dispatch')).toBe(true);
    });

    it('declares permissions: contents: read', () => {
      const content = fs.readFileSync(CI_WORKFLOW_PATH, 'utf8');
      const doc = YAML.parse(content);
      expect(doc.permissions).toEqual({ contents: 'read' });
    });

    it('defines quality-gates job running on ubuntu-latest with checkout and node setup', () => {
      const content = fs.readFileSync(CI_WORKFLOW_PATH, 'utf8');
      const doc = YAML.parse(content);
      const job = doc.jobs?.['quality-gates'];

      expect(job).toBeDefined();
      expect(job['runs-on']).toBe('ubuntu-latest');

      const steps: Array<Record<string, unknown>> = job.steps;
      expect(Array.isArray(steps)).toBe(true);

      // Checkout step
      const checkoutStep = steps.find(
        (s) => typeof s.uses === 'string' && s.uses.startsWith('actions/checkout')
      );
      expect(checkoutStep).toBeDefined();

      // Node.js setup step with node-version 22 and cache npm
      const nodeStep = steps.find(
        (s) => typeof s.uses === 'string' && s.uses.startsWith('actions/setup-node')
      );
      expect(nodeStep).toBeDefined();
      const withConfig = (nodeStep?.with || {}) as Record<string, unknown>;
      expect(String(withConfig['node-version'])).toBe('22');
      expect(withConfig.cache).toBe('npm');
    });

    it('installs Pulumi CLI via pulumi/actions@v6 in quality-gates job', () => {
      const content = fs.readFileSync(CI_WORKFLOW_PATH, 'utf8');
      const doc = YAML.parse(content);
      const steps: Array<Record<string, unknown>> = doc.jobs?.['quality-gates']?.steps || [];

      const pulumiStep = steps.find(
        (s) => typeof s.uses === 'string' && s.uses.startsWith('pulumi/actions')
      );
      expect(pulumiStep).toBeDefined();
      expect(pulumiStep?.uses).toBe('pulumi/actions@v6');
      expect(pulumiStep?.name).toBe('Set up Pulumi CLI');
    });

    it('installs Semgrep CLI, root and Pulumi dependencies, and executes gates in order', () => {
      const content = fs.readFileSync(CI_WORKFLOW_PATH, 'utf8');
      const doc = YAML.parse(content);
      const steps: Array<{ name?: string; run?: string }> = doc.jobs?.['quality-gates']?.steps || [];

      // Find step installing Semgrep CLI
      const semgrepInstallStep = steps.find(
        (s) => s.run && /pip\s+install.*semgrep|pipx\s+install\s+semgrep/i.test(s.run)
      );
      expect(semgrepInstallStep).toBeDefined();

      // Find step installing root and Pulumi dependencies
      const depsInstallStep = steps.find(
        (s) => s.run && s.run.includes('npm ci') && s.run.includes('infra/pulumi')
      );
      expect(depsInstallStep).toBeDefined();

      // Find the quality gate steps
      const lintStepIndex = steps.findIndex((s) => s.run && s.run.trim() === 'npm run lint');
      const typecheckStepIndex = steps.findIndex((s) => s.run && s.run.trim() === 'npm run typecheck');
      const testStepIndex = steps.findIndex((s) => s.run && s.run.trim() === 'npm run test:all');

      expect(lintStepIndex).toBeGreaterThan(-1);
      expect(typecheckStepIndex).toBeGreaterThan(-1);
      expect(testStepIndex).toBeGreaterThan(-1);

      // Verify strict execution order: lint -> typecheck -> test:all
      expect(lintStepIndex).toBeLessThan(typecheckStepIndex);
      expect(typecheckStepIndex).toBeLessThan(testStepIndex);

      // Also ensure dependency installation precedes gates
      const depsIndex = steps.indexOf(depsInstallStep!);
      expect(depsIndex).toBeLessThan(lintStepIndex);
    });
  });

  describe('Exclusion of Knip from Automated CI Quality Gates', () => {
    it('does not invoke knip in ci.yml', () => {
      const content = fs.readFileSync(CI_WORKFLOW_PATH, 'utf8');
      expect(content).not.toMatch(/\bknip\b/i);
    });

    it('does not invoke knip in deploy.yml', () => {
      const content = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
      expect(content).not.toMatch(/\bknip\b/i);
    });
  });

  describe('Deployment Workflow Contract (deploy.yml)', () => {
    it('is valid YAML', () => {
      const content = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
      expect(() => YAML.parse(content)).not.toThrow();
    });

    it('triggers on push to develop and main', () => {
      const content = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
      const doc = YAML.parse(content);

      expect(doc.on).toBeDefined();
      expect(doc.on.push).toBeDefined();
      const branches = doc.on.push.branches;
      expect(branches).toEqual(expect.arrayContaining(['develop', 'main']));
    });

    it('enforces per-branch concurrency with cancel-in-progress: false', () => {
      const content = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
      const doc = YAML.parse(content);

      expect(doc.concurrency).toBeDefined();
      expect(doc.concurrency.group).toBe('deploy-${{ github.ref_name }}');
      expect(doc.concurrency['cancel-in-progress']).toBe(false);
    });

    it('invokes reusable ci.yml as upstream quality-gates job', () => {
      const content = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
      const doc = YAML.parse(content);

      expect(doc.jobs).toBeDefined();
      expect(doc.jobs['quality-gates']).toBeDefined();
      expect(doc.jobs['quality-gates'].uses).toBe('./.github/workflows/ci.yml');
    });

    it('gates deploy job on quality-gates with dynamic environment binding and permissions', () => {
      const content = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
      const doc = YAML.parse(content);

      const deployJob = doc.jobs?.deploy;
      expect(deployJob).toBeDefined();
      expect(deployJob.needs).toEqual(expect.arrayContaining(['quality-gates']));
      expect(deployJob.environment).toBe("${{ github.ref_name == 'main' && 'prod' || 'dev' }}");
      expect(deployJob.permissions).toEqual({
        contents: 'write',
        'id-token': 'write',
      });
    });

    it('consumes required GitHub Environment variables and secrets', () => {
      const content = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
      const doc = YAML.parse(content);
      const deployJob = doc.jobs?.deploy;
      expect(deployJob).toBeDefined();

      const envConfig = deployJob.env || {};
      expect(envConfig.DEPLOY_ENV).toBe("${{ github.ref_name == 'main' && 'prod' || 'dev' }}");
      expect(envConfig.PROJECT_ID).toBe('${{ vars.PROJECT_ID }}');
      expect(envConfig.REGION).toBe('${{ vars.REGION }}');
      expect(envConfig.REPO_NAME).toBe('${{ vars.REPO_NAME }}');
      expect(envConfig.SERVICE_NAME).toBe('${{ vars.SERVICE_NAME }}');
      expect(envConfig.PULUMI_STACK).toBe('${{ vars.PULUMI_STACK }}');
      expect(envConfig.PULUMI_STATE_BUCKET).toBe('${{ vars.PULUMI_STATE_BUCKET }}');

      // Verify WIF and Pulumi secrets authentication
      expect(content).toContain('${{ secrets.WIF_PROVIDER }}');
      expect(content).toContain('${{ secrets.GCP_SERVICE_ACCOUNT }}');
      expect(content).toContain('${{ secrets.PULUMI_CONFIG_PASSPHRASE');
    });

    it('sets up Pulumi CLI in deploy job tooling setup phase before conditional bootstrap', () => {
      const content = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
      const doc = YAML.parse(content);
      const steps: Array<{ name?: string; uses?: string; run?: string }> = doc.jobs?.deploy?.steps || [];

      const gcloudIdx = steps.findIndex(
        (s) => typeof s.uses === 'string' && s.uses.startsWith('google-github-actions/setup-gcloud')
      );
      const pulumiIdx = steps.findIndex(
        (s) => typeof s.uses === 'string' && s.uses === 'pulumi/actions@v6' && s.name === 'Set up Pulumi CLI'
      );
      const bootstrapIdx = steps.findIndex(
        (s) => s.name === 'Conditional First-Run Infrastructure Bootstrap'
      );

      expect(gcloudIdx).toBeGreaterThanOrEqual(0);
      expect(pulumiIdx).toBeGreaterThanOrEqual(0);
      expect(bootstrapIdx).toBeGreaterThanOrEqual(0);

      expect(pulumiIdx).toBe(gcloudIdx + 1);
      expect(bootstrapIdx).toBe(pulumiIdx + 1);
    });

    it('guards pre-Docker bootstrap pulumi up with gcloud artifacts repositories describe existence check', () => {
      const content = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
      const doc = YAML.parse(content);
      const steps: Array<{ name?: string; run?: string }> = doc.jobs?.deploy?.steps || [];

      const bootstrapStep = steps.find(
        (s) => s.run && s.run.includes('artifacts repositories describe')
      );
      expect(bootstrapStep).toBeDefined();
      const runScript = bootstrapStep!.run!;

      // Guarded by describe check
      expect(runScript).toContain('gcloud artifacts repositories describe');
      expect(runScript).toContain('$REPO_NAME');
      expect(runScript).toContain('$REGION');
      expect(runScript).toContain('$PROJECT_ID');

      // Only logs in and runs pulumi up when repo does not exist
      expect(runScript).toContain('pulumi login');
      expect(runScript).toContain('pulumi stack select');
      expect(runScript).toContain('pulumi up');
    });

    it('builds and tags Docker images with SHA and latest on develop, plus v${PACKAGE_VERSION} on main, and pins Pulumi to immutable SHA tag', () => {
      const content = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
      const doc = YAML.parse(content);
      const steps: Array<{ name?: string; uses?: string; run?: string; with?: Record<string, unknown> }> =
        doc.jobs?.deploy?.steps || [];

      // Find Docker build step
      const buildStep = steps.find((s) => s.run && s.run.includes('docker build'));
      expect(buildStep).toBeDefined();
      const buildRun = buildStep!.run!;

      expect(buildRun).toContain('PACKAGE_VERSION=');
      expect(buildRun).toContain('package.json');
      expect(buildRun).toContain('IMAGE_SHA_TAG=');
      expect(buildRun).toContain('IMAGE_LATEST=');
      expect(buildRun).toContain('IMAGE_VERSION_TAG=');
      expect(buildRun).toContain('v${PACKAGE_VERSION}');
      expect(buildRun).toContain('prod');

      // Find Pulumi deploy step
      const deployStep = steps.find(
        (s) => typeof s.uses === 'string' && s.uses.startsWith('pulumi/actions') && s.with?.['config-map']
      );
      expect(deployStep).toBeDefined();
      const configMap = String(deployStep!.with?.['config-map'] ?? '');
      expect(configMap).toContain('IMAGE_SHA_TAG');
    });

    it('generates Workspace Add-on manifest with dynamic --environment flag', () => {
      const content = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
      const doc = YAML.parse(content);
      const steps: Array<{ name?: string; run?: string }> = doc.jobs?.deploy?.steps || [];

      const manifestStep = steps.find(
        (s) => s.run && s.run.includes('generate:manifest')
      );
      expect(manifestStep).toBeDefined();
      const runScript = manifestStep!.run!;
      expect(runScript).toContain('npm run generate:manifest --');
      expect(runScript).toContain('--service-url');
      expect(runScript).toContain('--environment "$DEPLOY_ENV"');
    });

    it('deploys Workspace Add-on via create-or-replace based on deployments describe check', () => {
      const content = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
      const doc = YAML.parse(content);
      const steps: Array<{ name?: string; run?: string }> = doc.jobs?.deploy?.steps || [];

      const addonDeployStep = steps.find(
        (s) => s.run && s.run.includes('workspace-add-ons deployments')
      );
      expect(addonDeployStep).toBeDefined();
      const runScript = addonDeployStep!.run!;

      expect(runScript).toContain('gcloud workspace-add-ons deployments describe');
      expect(runScript).toContain('gcloud workspace-add-ons deployments replace');
      expect(runScript).toContain('gcloud workspace-add-ons deployments create');
      expect(runScript).toContain('--deployment-file=infra/deployment.json');
      expect(runScript).toContain('$REPO_NAME');
      expect(runScript).toContain('$PROJECT_ID');
    });

    it('executes Verify Deployment Readiness (Smoke Test) immediately following the Workspace Add-on deployment step', () => {
      const content = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
      const doc = YAML.parse(content);
      const steps: Array<{ name?: string; run?: string }> = doc.jobs?.deploy?.steps || [];

      const addonDeployIdx = steps.findIndex(
        (s) => s.name === 'Deploy Google Workspace Add-on Manifest'
      );
      expect(addonDeployIdx).toBeGreaterThanOrEqual(0);

      const smokeTestIdx = steps.findIndex(
        (s) => s.name === 'Verify Deployment Readiness (Smoke Test)'
      );
      expect(smokeTestIdx).toBe(addonDeployIdx + 1);
    });

    it('mints an audience-bound OIDC identity token via WIF and invokes npm run verify:deployment in smoke verification step', () => {
      const content = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
      const doc = YAML.parse(content);
      const steps: Array<{
        name?: string;
        id?: string;
        uses?: string;
        with?: Record<string, unknown>;
        env?: Record<string, string>;
        run?: string;
      }> = doc.jobs?.deploy?.steps || [];

      const mintStep = steps.find(
        (s) => s.name === 'Mint OIDC Identity Token for Smoke Test'
      );
      expect(mintStep).toBeDefined();
      expect(mintStep?.id).toBe('smoke-id-token');
      expect(mintStep?.uses).toBe('google-github-actions/auth@v2');
      expect(mintStep?.with?.['token_format']).toBe('id_token');
      expect(mintStep?.with?.['id_token_audience']).toBe('${{ env.SERVICE_URL }}');
      expect(mintStep?.with?.['id_token_include_email']).toBe(true);
      expect(mintStep?.with?.['create_credentials_file']).toBe(false);
      expect(mintStep?.with?.['export_environment_variables']).toBe(false);

      const smokeStep = steps.find(
        (s) => s.name === 'Verify Deployment Readiness (Smoke Test)'
      );
      expect(smokeStep).toBeDefined();
      expect(smokeStep?.env?.['OIDC_ID_TOKEN']).toBe(
        '${{ steps.smoke-id-token.outputs.id_token }}'
      );
      const run = smokeStep!.run!;
      expect(run).toContain('npm run verify:deployment');
      expect(run).toContain('--service-url "$SERVICE_URL"');
      expect(run).toContain('--service-name "$SERVICE_NAME"');
      expect(run).toContain('--region "$REGION"');
      expect(run).toContain('--project-id "$PROJECT_ID"');
      expect(run).toContain('--repo-name "$REPO_NAME"');
    });

    it('implements all 4 control-plane and HTTP smoke checks with Typebox schemas in infra/deployment-readiness.ts', () => {
      const readinessPath = path.join(ROOT_DIR, 'infra', 'deployment-readiness.ts');
      expect(fs.existsSync(readinessPath)).toBe(true);
      const readinessSource = fs.readFileSync(readinessPath, 'utf8');

      // Check 1: Cloud Run readiness
      expect(readinessSource).toContain('CloudRunServiceDescriptorSchema');
      expect(readinessSource).toContain('latestReadyRevisionName');
      expect(readinessSource).toContain('latestCreatedRevisionName');
      expect(readinessSource).toContain('Ready');

      // Check 2: Workspace Add-on deployment alignment
      expect(readinessSource).toContain('WorkspaceAddonDeploymentDescriptorSchema');
      expect(readinessSource).toContain('homepageTrigger');
      expect(readinessSource).toContain('/workspace/homepage');

      // Check 3: Unauthenticated 401/403 check
      expect(readinessSource).toContain('401');
      expect(readinessSource).toContain('403');

      // Check 4: Authenticated 200 + Workspace Card check
      expect(readinessSource).toContain('WorkspaceCardResponseSchema');
      expect(readinessSource).toContain('Bearer');
      expect(readinessSource).toContain('200');
    });

    describe('GitHub Release Publishing Contract on Main (#244)', () => {
      it('executes Publish GitHub Release on Main immediately following Verify Deployment Readiness (Smoke Test)', () => {
        const content = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
        const doc = YAML.parse(content);
        const steps: Array<{ name?: string; run?: string }> = doc.jobs?.deploy?.steps || [];

        const smokeTestIdx = steps.findIndex(
          (s) => s.name === 'Verify Deployment Readiness (Smoke Test)'
        );
        expect(smokeTestIdx).toBeGreaterThanOrEqual(0);

        const releaseIdx = steps.findIndex(
          (s) => s.name === 'Publish GitHub Release on Main'
        );
        expect(releaseIdx).toBe(smokeTestIdx + 1);
      });

      it('conditions Publish GitHub Release on Main on refs/heads/main', () => {
        const content = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
        const doc = YAML.parse(content);
        const steps: Array<{ name?: string; if?: string }> = doc.jobs?.deploy?.steps || [];

        const releaseStep = steps.find(
          (s) => s.name === 'Publish GitHub Release on Main'
        );
        expect(releaseStep).toBeDefined();
        expect(releaseStep!.if).toBe("github.ref == 'refs/heads/main'");
      });

      it('configures GH_TOKEN: secrets.GITHUB_TOKEN in Publish GitHub Release on Main', () => {
        const content = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
        const doc = YAML.parse(content);
        const steps: Array<{ name?: string; env?: Record<string, string> }> =
          doc.jobs?.deploy?.steps || [];

        const releaseStep = steps.find(
          (s) => s.name === 'Publish GitHub Release on Main'
        );
        expect(releaseStep).toBeDefined();
        expect(releaseStep!.env?.GH_TOKEN).toBe('${{ secrets.GITHUB_TOKEN }}');
      });

      it('checks whether the release or tag exists and logs notice before skipping creation', () => {
        const content = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
        const doc = YAML.parse(content);
        const steps: Array<{ name?: string; run?: string }> = doc.jobs?.deploy?.steps || [];

        const releaseStep = steps.find(
          (s) => s.name === 'Publish GitHub Release on Main'
        );
        expect(releaseStep).toBeDefined();
        const run = releaseStep!.run!;

        expect(run).toContain('PACKAGE_VERSION="${PACKAGE_VERSION:-');
        expect(run).toContain('RELEASE_TAG="v${PACKAGE_VERSION}"');
        expect(run).toContain('gh release view');
        expect(run).toContain('git ls-remote');
        expect(run).toContain('Release $RELEASE_TAG already exists; skipping release creation.');
        expect(run).toContain('exit 0');
      });

      it('creates GitHub release with target SHA, title, and generated notes without archive attachments', () => {
        const content = fs.readFileSync(DEPLOY_WORKFLOW_PATH, 'utf8');
        const doc = YAML.parse(content);
        const steps: Array<{ name?: string; run?: string }> = doc.jobs?.deploy?.steps || [];

        const releaseStep = steps.find(
          (s) => s.name === 'Publish GitHub Release on Main'
        );
        expect(releaseStep).toBeDefined();
        const run = releaseStep!.run!;

        expect(run).toContain('gh release create');
        expect(run).toContain('--target "${GITHUB_SHA}"');
        expect(run).toContain('--title "$RELEASE_TAG"');
        expect(run).toContain('--generate-notes');

        // Verify absence of tar.gz or zip archive attachments
        expect(run).not.toContain('.tar.gz');
        expect(run).not.toContain('.zip');
      });
    });
  });
});
