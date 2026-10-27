import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT_DIR = path.resolve(__dirname, '../..');
const BOOTSTRAP_PATH = path.join(ROOT_DIR, 'infra', 'bootstrap.ps1');
const DEPLOY_YML_PATH = path.join(ROOT_DIR, '.github', 'workflows', 'deploy.yml');

function getPowerShellCommand(): string {
  try {
    const res = spawnSync('pwsh', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
    if (res.status === 0) return 'pwsh';
  } catch {
    // ignore
  }
  try {
    const res = spawnSync('powershell', ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
    if (res.status === 0) return 'powershell';
  } catch {
    // ignore
  }
  throw new Error('Neither pwsh nor powershell is available on this system.');
}

interface ShimCall {
  args: string[];
}

interface MockConfig {
  projectNumber?: string;
  bucketExists?: boolean;
  serviceAccountExists?: boolean;
  wifPoolExists?: boolean;
  wifProviderExists?: boolean;
  hasEditorRole?: boolean;
}

function setupShim(mockConfig: MockConfig = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcloud-shim-'));
  const callsFile = path.join(tmpDir, 'calls.json');
  const configFile = path.join(tmpDir, 'config.json');

  fs.writeFileSync(configFile, JSON.stringify(mockConfig, null, 2), 'utf8');
  fs.writeFileSync(callsFile, '[]', 'utf8');

  // gcloud-shim.js
  const shimJs = `
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const callsFile = path.join(dir, 'calls.json');
const configFile = path.join(dir, 'config.json');

const args = process.argv.slice(2);

let calls = [];
try {
  calls = JSON.parse(fs.readFileSync(callsFile, 'utf8'));
} catch (e) {}
calls.push({ args });
fs.writeFileSync(callsFile, JSON.stringify(calls, null, 2), 'utf8');

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
} catch (e) {}

const joined = args.join(' ');

if (joined.startsWith('auth print-access-token')) {
  process.stdout.write('mock-access-token\\n');
  process.exit(0);
}

if (joined.startsWith('storage ls')) {
  const exists = config.bucketExists ?? true;
  process.exit(exists ? 0 : 1);
}

if (joined.startsWith('iam service-accounts describe')) {
  const exists = config.serviceAccountExists ?? true;
  process.exit(exists ? 0 : 1);
}

if (joined.startsWith('iam workload-identity-pools describe')) {
  const exists = config.wifPoolExists ?? true;
  process.exit(exists ? 0 : 1);
}

if (joined.startsWith('iam workload-identity-pools providers describe')) {
  const exists = config.wifProviderExists ?? false;
  process.exit(exists ? 0 : 1);
}

if (joined.startsWith('projects get-iam-policy')) {
  const hasEditor = config.hasEditorRole ?? false;
  const proj = args[2] || 'inc-io-docs-dev';
  const bindings = [];
  if (hasEditor) {
    bindings.push({
      role: 'roles/editor',
      members: ['serviceAccount:ci-deployer@' + proj + '.iam.gserviceaccount.com']
    });
  }
  process.stdout.write(JSON.stringify({ bindings }) + '\\n');
  process.exit(0);
}

if (joined.startsWith('projects describe')) {
  process.stdout.write((config.projectNumber || '123456789012') + '\\n');
  process.exit(0);
}

// All other mutating commands (services enable, storage buckets create, update, etc.) succeed
process.exit(0);
`;

  fs.writeFileSync(path.join(tmpDir, 'gcloud-shim.js'), shimJs, 'utf8');

  // Windows cmd shim
  fs.writeFileSync(path.join(tmpDir, 'gcloud.cmd'), '@node "%~dp0gcloud-shim.js" %*\n', 'utf8');

  // Unix / bash shim
  const unixShim = '#!/bin/sh\nexec node "$(dirname "$0")/gcloud-shim.js" "$@"\n';
  fs.writeFileSync(path.join(tmpDir, 'gcloud'), unixShim, { encoding: 'utf8', mode: 0o755 });

  return {
    tmpDir,
    getCalls: (): ShimCall[] => {
      try {
        return JSON.parse(fs.readFileSync(callsFile, 'utf8'));
      } catch {
        return [];
      }
    },
    cleanup: () => {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch {
        // ignore
      }
    },
  };
}

function runBootstrap(args: string[], env: Record<string, string | undefined> = {}, shimDir?: string) {
  const ps = getPowerShellCommand();
  const sep = path.delimiter;
  const mergedPath = shimDir ? `${shimDir}${sep}${process.env.PATH || ''}` : process.env.PATH;

  const result = spawnSync(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', BOOTSTRAP_PATH, ...args], {
    env: {
      ...process.env,
      ...env,
      PATH: mergedPath,
    },
    encoding: 'utf8',
  });

  return result;
}

describe('GCP Bootstrap Script (infra/bootstrap.ps1)', () => {
  it('parses cleanly with zero PowerShell AST syntax errors and defines expected parameters', () => {
    const ps = getPowerShellCommand();
    const normalizedPath = BOOTSTRAP_PATH.replace(/\\/g, '/');

    // Run AST parser in PowerShell directly from file
    const checkScript = `
      $tokens = $null
      $errors = $null
      $ast = [System.Management.Automation.Language.Parser]::ParseFile('${normalizedPath}', [ref]$tokens, [ref]$errors)

      $paramAst = $ast.ParamBlock
      $params = @{}
      if ($paramAst) {
        foreach ($p in $paramAst.Parameters) {
          $name = $p.Name.VariablePath.UserPath
          $type = if ($p.StaticType) { $p.StaticType.Name } else { "" }
          $validSet = @()
          foreach ($attr in $p.Attributes) {
            if ($attr.TypeName.Name -eq "ValidateSet") {
              foreach ($arg in $attr.PositionalArguments) {
                $validSet += $arg.Value
              }
            }
          }
          $params[$name] = @{
            Type = $type
            ValidateSet = $validSet
            Default = if ($p.DefaultValue) { $p.DefaultValue.Extent.Text } else { $null }
          }
        }
      }

      [PSCustomObject]@{
        ErrorCount = $errors.Count
        Errors = @($errors | ForEach-Object { $_.Message })
        Parameters = $params
      } | ConvertTo-Json -Depth 5
    `;

    const res = spawnSync(ps, ['-NoProfile', '-Command', checkScript], { encoding: 'utf8' });
    expect(res.status).toBe(0);
    const parsed = JSON.parse(res.stdout);
    expect(parsed.ErrorCount).toBe(0);
    expect(parsed.Errors).toEqual([]);

    const params = parsed.Parameters;
    expect(params).toHaveProperty('Environment');
    expect(params.Environment.ValidateSet).toEqual(['dev', 'prod']);
    expect(params).toHaveProperty('ProjectId');
    expect(params).toHaveProperty('Region');
    expect(params).toHaveProperty('Repo');
    expect(params).toHaveProperty('Branch');
    expect(params).toHaveProperty('PulumiPassphrase');
    expect(params).toHaveProperty('Force');
    expect(params.Force.Type).toBe('SwitchParameter');
  });

  describe('Parameter precedence and environment resolution', () => {
    let shim: ReturnType<typeof setupShim>;

    beforeEach(() => {
      shim = setupShim({ wifProviderExists: false, hasEditorRole: true });
    });

    afterEach(() => {
      shim.cleanup();
    });

    it('defaults to dev environment, resolving inc-io-docs-dev, develop branch, us-east4, and inc-io-docs-dev-pulumi-state', () => {
      const res = runBootstrap(['-Force'], { PROJECT_ID: undefined, REGION: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const calls = shim.getCalls();
      // Foundational APIs enabled for inc-io-docs-dev
      const servicesEnable = calls.find((c) => c.args.includes('services') && c.args.includes('enable'));
      expect(servicesEnable).toBeDefined();
      expect(servicesEnable?.args).toContain('--project');
      expect(servicesEnable?.args).toContain('inc-io-docs-dev');

      // State bucket created / checked with inc-io-docs-dev-pulumi-state
      const bucketUpdate = calls.find((c) => c.args.includes('storage') && c.args.includes('update'));
      expect(bucketUpdate?.args).toContain('gs://inc-io-docs-dev-pulumi-state');

      // WIF condition references dev and develop
      const createOidc = calls.find((c) => c.args.includes('create-oidc'));
      expect(createOidc).toBeDefined();
      const condArg = createOidc?.args.find((a) => a.startsWith('--attribute-condition='));
      expect(condArg).toContain("assertion.environment == 'dev'");
      expect(condArg).toContain("assertion.ref == 'refs/heads/develop'");
    });

    it('resolves prod environment, mapping inc-io-docs-prod, main branch, and inc-io-docs-prod-pulumi-state', () => {
      const res = runBootstrap(['-Environment', 'prod', '-Force'], { PROJECT_ID: undefined, REGION: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const calls = shim.getCalls();
      const servicesEnable = calls.find((c) => c.args.includes('services') && c.args.includes('enable'));
      expect(servicesEnable?.args).toContain('inc-io-docs-prod');

      const bucketUpdate = calls.find((c) => c.args.includes('storage') && c.args.includes('update'));
      expect(bucketUpdate?.args).toContain('gs://inc-io-docs-prod-pulumi-state');

      const createOidc = calls.find((c) => c.args.includes('create-oidc'));
      const condArg = createOidc?.args.find((a) => a.startsWith('--attribute-condition='));
      expect(condArg).toContain("assertion.environment == 'prod'");
      expect(condArg).toContain("assertion.ref == 'refs/heads/main'");
    });

    it('enforces precedence: explicit -Environment prod wins over ambient $env:PROJECT_ID', () => {
      const res = runBootstrap(
        ['-Environment', 'prod', '-Force'],
        { PROJECT_ID: 'inc-io-docs-dev' },
        shim.tmpDir
      );
      expect(res.status).toBe(0);

      const calls = shim.getCalls();
      const servicesEnable = calls.find((c) => c.args.includes('services') && c.args.includes('enable'));
      expect(servicesEnable?.args).toContain('inc-io-docs-prod');
    });

    it('enforces precedence: explicit CLI -ProjectId wins over both -Environment preset and $env:PROJECT_ID', () => {
      const res = runBootstrap(
        ['-Environment', 'dev', '-ProjectId', 'custom-project-id', '-Force'],
        { PROJECT_ID: 'ambient-project-id' },
        shim.tmpDir
      );
      expect(res.status).toBe(0);

      const calls = shim.getCalls();
      const servicesEnable = calls.find((c) => c.args.includes('services') && c.args.includes('enable'));
      expect(servicesEnable?.args).toContain('custom-project-id');

      const bucketUpdate = calls.find((c) => c.args.includes('storage') && c.args.includes('update'));
      expect(bucketUpdate?.args).toContain('gs://custom-project-id-pulumi-state');
    });

    it('falls back to ambient $env:PROJECT_ID when neither -ProjectId nor -Environment is passed', () => {
      const resWithForce = runBootstrap(['-Force'], { PROJECT_ID: 'ambient-project-id' }, shim.tmpDir);
      expect(resWithForce.status).toBe(0);

      const calls = shim.getCalls();
      const servicesEnable = calls.find((c) => c.args.includes('services') && c.args.includes('enable'));
      expect(servicesEnable?.args).toContain('ambient-project-id');
    });

    it('enforces Region precedence: explicit -Region > ambient $env:REGION > default us-east4', () => {
      // 1. Explicit -Region wins
      let res = runBootstrap(['-Region', 'europe-west1', '-Force'], { REGION: 'us-central1' }, shim.tmpDir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('europe-west1');

      // 2. Ambient $env:REGION wins over default
      shim.cleanup();
      shim = setupShim({ wifProviderExists: false, hasEditorRole: false });
      res = runBootstrap(['-Force'], { REGION: 'us-central1' }, shim.tmpDir);
      expect(res.status).toBe(0);
      expect(res.stdout).toContain('us-central1');
    });

    it('strips leading refs/heads/ from explicit -Branch', () => {
      const res = runBootstrap(
        ['-Branch', 'refs/heads/feature-custom', '-Force'],
        { PROJECT_ID: undefined },
        shim.tmpDir
      );
      expect(res.status).toBe(0);

      const calls = shim.getCalls();
      const createOidc = calls.find((c) => c.args.includes('create-oidc'));
      const condArg = createOidc?.args.find((a) => a.startsWith('--attribute-condition='));
      expect(condArg).toContain("assertion.ref == 'refs/heads/feature-custom'");
    });
  });

  describe('GCS State Bucket & Least-Privilege IAM', () => {
    let shim: ReturnType<typeof setupShim>;

    afterEach(() => {
      if (shim) shim.cleanup();
    });

    it('enables the 5 foundational APIs', () => {
      shim = setupShim({ wifProviderExists: false, hasEditorRole: false });
      const res = runBootstrap(['-Force'], { PROJECT_ID: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const calls = shim.getCalls();
      const servicesEnable = calls.find((c) => c.args.includes('services') && c.args.includes('enable'));
      expect(servicesEnable).toBeDefined();
      expect(servicesEnable?.args).toContain('iamcredentials.googleapis.com');
      expect(servicesEnable?.args).toContain('cloudresourcemanager.googleapis.com');
      expect(servicesEnable?.args).toContain('iam.googleapis.com');
      expect(servicesEnable?.args).toContain('serviceusage.googleapis.com');
      expect(servicesEnable?.args).toContain('storage.googleapis.com');
    });

    it('enables Object Versioning and grants bucket-scoped roles/storage.admin on the state bucket', () => {
      shim = setupShim({ wifProviderExists: false, hasEditorRole: false });
      const res = runBootstrap(['-Force'], { PROJECT_ID: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const calls = shim.getCalls();

      // Object Versioning
      const versioningCall = calls.find((c) =>
        c.args.includes('storage') && c.args.includes('buckets') && c.args.includes('update') && c.args.includes('--versioning')
      );
      expect(versioningCall).toBeDefined();
      expect(versioningCall?.args).toContain('gs://inc-io-docs-dev-pulumi-state');

      // Bucket-scoped roles/storage.admin
      const bucketIamCall = calls.find((c) =>
        c.args.includes('storage') &&
        c.args.includes('buckets') &&
        c.args.includes('add-iam-policy-binding') &&
        c.args.includes('gs://inc-io-docs-dev-pulumi-state')
      );
      expect(bucketIamCall).toBeDefined();
      expect(bucketIamCall?.args).toContain('--role=roles/storage.admin');
      expect(bucketIamCall?.args).toContain('--member=serviceAccount:ci-deployer@inc-io-docs-dev.iam.gserviceaccount.com');
    });

    it('binds the 7 least-privilege project roles to ci-deployer', () => {
      shim = setupShim({ wifProviderExists: false, hasEditorRole: false });
      const res = runBootstrap(['-Force'], { PROJECT_ID: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const calls = shim.getCalls();
      const projectBindings = calls.filter((c) =>
        c.args.includes('projects') && c.args.includes('add-iam-policy-binding')
      );

      const boundRoles = projectBindings.map((c) => {
        const roleArg = c.args.find((a) => a.startsWith('--role='));
        return roleArg ? roleArg.split('=')[1] : undefined;
      }).filter(Boolean);

      const expectedRoles = [
        'roles/serviceusage.serviceUsageAdmin',
        'roles/browser',
        'roles/iam.serviceAccountAdmin',
        'roles/iam.serviceAccountUser',
        'roles/run.admin',
        'roles/artifactregistry.admin',
        'roles/gsuiteaddons.developer',
      ];

      for (const role of expectedRoles) {
        expect(boundRoles).toContain(role);
      }
      expect(boundRoles).not.toContain('roles/editor');
    });

    it('inspects project IAM policy and removes roles/editor from ci-deployer when present', () => {
      shim = setupShim({ wifProviderExists: false, hasEditorRole: true });
      const res = runBootstrap(['-Force'], { PROJECT_ID: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const calls = shim.getCalls();
      const removeEditorCall = calls.find((c) =>
        c.args.includes('projects') &&
        c.args.includes('remove-iam-policy-binding') &&
        c.args.some((a) => a.includes('roles/editor'))
      );
      expect(removeEditorCall).toBeDefined();
      expect(removeEditorCall?.args).toContain('--member=serviceAccount:ci-deployer@inc-io-docs-dev.iam.gserviceaccount.com');
      expect(removeEditorCall?.args).toContain('--role=roles/editor');
    });

    it('does not invoke remove-iam-policy-binding when roles/editor is absent', () => {
      shim = setupShim({ wifProviderExists: false, hasEditorRole: false });
      const res = runBootstrap(['-Force'], { PROJECT_ID: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const calls = shim.getCalls();
      const removeEditorCall = calls.find((c) =>
        c.args.includes('projects') &&
        c.args.includes('remove-iam-policy-binding')
      );
      expect(removeEditorCall).toBeUndefined();
    });
  });

  describe('Hardened 3-Way WIF OIDC Provider', () => {
    let shim: ReturnType<typeof setupShim>;

    afterEach(() => {
      if (shim) shim.cleanup();
    });

    it('creates OIDC provider with 3-way condition and attribute mapping when provider does not exist', () => {
      shim = setupShim({ wifProviderExists: false, hasEditorRole: false });
      const res = runBootstrap(['-Force'], { PROJECT_ID: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const calls = shim.getCalls();
      const createOidc = calls.find((c) => c.args.includes('create-oidc'));
      expect(createOidc).toBeDefined();

      const mappingArg = createOidc?.args.find((a) => a.startsWith('--attribute-mapping='));
      expect(mappingArg).toBe(
        '--attribute-mapping=google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.environment=assertion.environment'
      );

      const conditionArg = createOidc?.args.find((a) => a.startsWith('--attribute-condition='));
      expect(conditionArg).toBe(
        "--attribute-condition=has(assertion.environment) && assertion.environment == 'dev' && assertion.repository == 'amcgoey/INC-IO-Docs' && assertion.ref == 'refs/heads/develop'"
      );
    });

    it('updates OIDC provider with update-oidc when provider already exists', () => {
      shim = setupShim({ wifProviderExists: true, hasEditorRole: false });
      const res = runBootstrap(['-Force'], { PROJECT_ID: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const calls = shim.getCalls();
      const createOidc = calls.find((c) => c.args.includes('create-oidc'));
      expect(createOidc).toBeUndefined();

      const updateOidc = calls.find((c) => c.args.includes('update-oidc'));
      expect(updateOidc).toBeDefined();

      const mappingArg = updateOidc?.args.find((a) => a.startsWith('--attribute-mapping='));
      expect(mappingArg).toBe(
        '--attribute-mapping=google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.environment=assertion.environment'
      );

      const conditionArg = updateOidc?.args.find((a) => a.startsWith('--attribute-condition='));
      expect(conditionArg).toBe(
        "--attribute-condition=has(assertion.environment) && assertion.environment == 'dev' && assertion.repository == 'amcgoey/INC-IO-Docs' && assertion.ref == 'refs/heads/develop'"
      );
    });
  });

  describe('Workflow alignment in .github/workflows/deploy.yml', () => {
    it('declares environment: dev on the build-and-deploy job', () => {
      const content = fs.readFileSync(DEPLOY_YML_PATH, 'utf8');
      // Verify job definition includes environment: dev
      expect(content).toMatch(/jobs:\s+build-and-deploy:[\s\S]*?environment:\s*dev/);
    });
  });
});
