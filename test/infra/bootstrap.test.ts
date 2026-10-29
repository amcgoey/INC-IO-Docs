import { describe, it, expect, beforeEach, afterEach, beforeAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawnSync } from 'node:child_process';

const ROOT_DIR = path.resolve(__dirname, '../..');
const BOOTSTRAP_PATH = path.join(ROOT_DIR, 'infra', 'bootstrap.ps1');
const DEPLOY_YML_PATH = path.join(ROOT_DIR, '.github', 'workflows', 'deploy.yml');

let cachedPowerShellCommand: string | undefined;

const PS_OPT_OUT_ENV: Record<string, string> = {
  POWERSHELL_TELEMETRY_OPTOUT: '1',
  POWERSHELL_UPDATECHECK: 'Off',
  DOTNET_NOLOGO: '1',
};

function getPowerShellCommand(): string {
  if (cachedPowerShellCommand) {
    return cachedPowerShellCommand;
  }
  const probeArgs = ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'];
  const probeEnv = {
    ...process.env,
    ...PS_OPT_OUT_ENV,
  };
  for (const cmd of ['pwsh', 'powershell']) {
    try {
      const res = spawnSync(cmd, probeArgs, { env: probeEnv, encoding: 'utf8' });
      if (res.status === 0) {
        cachedPowerShellCommand = cmd;
        return cmd;
      }
    } catch {
      // ignore
    }
  }
  throw new Error('Neither pwsh nor powershell is available on this system.');
}

interface ShimCall {
  bin?: string;
  args: string[];
  stdin?: string;
}

interface MockConfig {
  projectNumber?: string;
  bucketExists?: boolean;
  serviceAccountExists?: boolean;
  wifPoolExists?: boolean;
  wifProviderExists?: boolean;
  hasEditorRole?: boolean;
  hasViewerRole?: boolean;
  ghAuthSucceeds?: boolean;
  existingBranchPolicies?: string[];
  existingSecrets?: string[];
  preventDuplicateBranchPolicy?: boolean;
}

function setupShim(mockConfig: MockConfig = {}) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gcloud-shim-'));
  const callsFile = path.join(tmpDir, 'calls.json');
  const configFile = path.join(tmpDir, 'config.json');

  fs.writeFileSync(configFile, JSON.stringify(mockConfig, null, 2), 'utf8');
  fs.writeFileSync(callsFile, '[]', 'utf8');

  // gcloud-shim.js
  const gcloudShimJs = `
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
calls.push({ bin: 'gcloud', args });
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
  const hasViewer = config.hasViewerRole ?? false;
  const proj = args[2] || 'inc-io-docs-dev';
  const bindings = [];
  if (hasEditor) {
    bindings.push({
      role: 'roles/editor',
      members: ['serviceAccount:ci-deployer@' + proj + '.iam.gserviceaccount.com']
    });
  }
  if (hasViewer) {
    bindings.push({
      role: 'roles/viewer',
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

  // gh-shim.js
  const ghShimJs = `
const fs = require('fs');
const path = require('path');

const dir = __dirname;
const callsFile = path.join(dir, 'calls.json');
const configFile = path.join(dir, 'config.json');

const args = process.argv.slice(2);

let stdin = '';
if (args.includes('--input') && args.includes('-')) {
  try {
    stdin = fs.readFileSync(0, 'utf8');
  } catch (e) {}
}

let calls = [];
try {
  calls = JSON.parse(fs.readFileSync(callsFile, 'utf8'));
} catch (e) {}
calls.push({ bin: 'gh', args, stdin });
fs.writeFileSync(callsFile, JSON.stringify(calls, null, 2), 'utf8');

let config = {};
try {
  config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
} catch (e) {}

const joined = args.join(' ');

if (joined.startsWith('auth status')) {
  if (config.ghAuthSucceeds === false) {
    process.stderr.write('You are not logged into any GitHub hosts. Run gh auth login to authenticate.\\n');
    process.exit(1);
  }
  process.stdout.write('Logged in to github.com account testuser (keyring)\\n');
  process.exit(0);
}

if (joined.startsWith('api')) {
  if (joined.includes('deployment-branch-policies')) {
    const isPost = args.includes('POST') || (args.includes('--method') && args[args.indexOf('--method') + 1] === 'POST');
    if (isPost) {
      let branchName = '';
      const fArg = args.find(a => a.startsWith('name='));
      if (fArg) {
        branchName = fArg.split('=')[1];
      } else if (stdin) {
        try {
          const parsed = JSON.parse(stdin);
          branchName = parsed.name;
        } catch (e) {}
      }
      if (config.preventDuplicateBranchPolicy && branchName && config.existingBranchPolicies && config.existingBranchPolicies.includes(branchName)) {
        process.stderr.write(\`HTTP 422: Validation Failed: Branch policy for '\${branchName}' already exists\\n\`);
        process.exit(1);
      }
      process.stdout.write(JSON.stringify({ id: 99, name: branchName }) + '\\n');
      process.exit(0);
    } else {
      const policies = (config.existingBranchPolicies || []).map((name, idx) => ({ id: idx + 1, name }));
      process.stdout.write(JSON.stringify({ total_count: policies.length, branch_policies: policies }) + '\\n');
      process.exit(0);
    }
  }
  // Default API call (e.g. PUT environments)
  process.stdout.write('{}\\n');
  process.exit(0);
}

if (joined.startsWith('variable set')) {
  process.exit(0);
}

if (joined.startsWith('secret list')) {
  const secrets = config.existingSecrets || [];
  const lines = secrets.map(s => \`\${s}\\tUpdated 2026-01-01\`);
  process.stdout.write(lines.join('\\n') + (lines.length > 0 ? '\\n' : ''));
  process.exit(0);
}

if (joined.startsWith('secret set')) {
  process.exit(0);
}

process.exit(0);
`;

  fs.writeFileSync(path.join(tmpDir, 'gcloud-shim.js'), gcloudShimJs, 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'gcloud.cmd'), '@node "%~dp0gcloud-shim.js" %*\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'gcloud'), '#!/bin/sh\nexec node "$(dirname "$0")/gcloud-shim.js" "$@"\n', { encoding: 'utf8', mode: 0o755 });

  fs.writeFileSync(path.join(tmpDir, 'gh-shim.js'), ghShimJs, 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'gh.cmd'), '@node "%~dp0gh-shim.js" %*\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'gh'), '#!/bin/sh\nexec node "$(dirname "$0")/gh-shim.js" "$@"\n', { encoding: 'utf8', mode: 0o755 });

  return {
    tmpDir,
    getCalls: (): ShimCall[] => {
      try {
        return JSON.parse(fs.readFileSync(callsFile, 'utf8'));
      } catch {
        return [];
      }
    },
    getGcloudCalls: (): ShimCall[] => {
      try {
        const calls: ShimCall[] = JSON.parse(fs.readFileSync(callsFile, 'utf8'));
        return calls.filter((c) => c.bin === 'gcloud');
      } catch {
        return [];
      }
    },
    getGhCalls: (): ShimCall[] => {
      try {
        const calls: ShimCall[] = JSON.parse(fs.readFileSync(callsFile, 'utf8'));
        return calls.filter((c) => c.bin === 'gh');
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

  const result = spawnSync(
    ps,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', BOOTSTRAP_PATH, ...args],
    {
      env: {
        ...process.env,
        ...PS_OPT_OUT_ENV,
        ...env,
        PATH: mergedPath,
      },
      encoding: 'utf8',
    }
  );

  return result;
}

describe('GCP Bootstrap Script (infra/bootstrap.ps1)', { timeout: 15000 }, () => {
  beforeAll(() => {
    getPowerShellCommand();
  }, 15000);

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

    const res = spawnSync(
      ps,
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', checkScript],
      {
        env: {
          ...process.env,
          ...PS_OPT_OUT_ENV,
        },
        encoding: 'utf8',
      }
    );
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
    }, 15000);

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
      expect(boundRoles).not.toContain('roles/viewer');
    });

    it('inspects project IAM policy and removes both roles/editor and roles/viewer from ci-deployer when present', () => {
      shim = setupShim({ wifProviderExists: false, hasEditorRole: true, hasViewerRole: true });
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

      const removeViewerCall = calls.find((c) =>
        c.args.includes('projects') &&
        c.args.includes('remove-iam-policy-binding') &&
        c.args.some((a) => a.includes('roles/viewer'))
      );
      expect(removeViewerCall).toBeDefined();
      expect(removeViewerCall?.args).toContain('--member=serviceAccount:ci-deployer@inc-io-docs-dev.iam.gserviceaccount.com');
      expect(removeViewerCall?.args).toContain('--role=roles/viewer');
    });

    it('does not invoke remove-iam-policy-binding when primitive roles (roles/editor, roles/viewer) are absent', () => {
      shim = setupShim({ wifProviderExists: false, hasEditorRole: false, hasViewerRole: false });
      const res = runBootstrap(['-Force'], { PROJECT_ID: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const calls = shim.getCalls();
      const removeCalls = calls.filter((c) =>
        c.args.includes('projects') &&
        c.args.includes('remove-iam-policy-binding')
      );
      expect(removeCalls.length).toBe(0);
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

  describe('Pre-Flight gh Authentication Check', () => {
    let shim: ReturnType<typeof setupShim>;

    afterEach(() => {
      if (shim) shim.cleanup();
    });

    it('verifies gh auth status during pre-flight and aborts with a clear error before mutating GCP or GitHub state', () => {
      shim = setupShim({ ghAuthSucceeds: false });
      const res = runBootstrap(['-Force'], { PROJECT_ID: undefined }, shim.tmpDir);

      expect(res.status).not.toBe(0);
      expect(res.stdout).toContain(
        "FATAL ERROR: You are not authenticated with the GitHub CLI (gh). Please run 'gh auth login' and try again."
      );

      // Verify no mutating GCP commands were invoked
      const mutatingGcloudCalls = shim.getGcloudCalls().filter((c) =>
        c.args.includes('enable') ||
        c.args.includes('create') ||
        c.args.includes('add-iam-policy-binding') ||
        c.args.includes('remove-iam-policy-binding')
      );
      expect(mutatingGcloudCalls).toHaveLength(0);

      // Verify no mutating gh commands were invoked
      const mutatingGhCalls = shim.getGhCalls().filter((c) =>
        c.args.includes('api') ||
        c.args.includes('set')
      );
      expect(mutatingGhCalls).toHaveLength(0);
    });
  });

  describe('Idempotent GitHub Environment & Deployment Branch Policy Provisioning', () => {
    let shim: ReturnType<typeof setupShim>;

    afterEach(() => {
      if (shim) shim.cleanup();
    });

    it('provisions dev GitHub Environment with custom_branch_policies and registers develop branch policy when missing', () => {
      shim = setupShim({ existingBranchPolicies: [], preventDuplicateBranchPolicy: true });
      const res = runBootstrap(['-Force', '-PulumiPassphrase', 'dev-pass'], { PROJECT_ID: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const ghCalls = shim.getGhCalls();

      // PUT repos/amcgoey/INC-IO-Docs/environments/dev
      const envPutCall = ghCalls.find((c) =>
        c.args.includes('api') &&
        c.args.includes('repos/amcgoey/INC-IO-Docs/environments/dev') &&
        c.args.includes('PUT')
      );
      expect(envPutCall).toBeDefined();
      if (envPutCall?.stdin) {
        expect(envPutCall.stdin).toContain('"custom_branch_policies":true');
        expect(envPutCall.stdin).toContain('"protected_branches":false');
      }

      // GET branch policies was performed
      const getPolicyCall = ghCalls.find((c) =>
        c.args.includes('api') &&
        c.args.includes('repos/amcgoey/INC-IO-Docs/environments/dev/deployment-branch-policies') &&
        !c.args.includes('POST')
      );
      expect(getPolicyCall).toBeDefined();

      // POST develop branch policy was performed
      const postPolicyCall = ghCalls.find((c) =>
        c.args.includes('api') &&
        c.args.includes('repos/amcgoey/INC-IO-Docs/environments/dev/deployment-branch-policies') &&
        c.args.includes('POST')
      );
      expect(postPolicyCall).toBeDefined();
      const hasDevelopInArgsOrStdin =
        postPolicyCall?.args.some((a) => a.includes('develop')) ||
        Boolean(postPolicyCall?.stdin && postPolicyCall.stdin.includes('develop'));
      expect(hasDevelopInArgsOrStdin).toBe(true);
    });

    it('provisions prod GitHub Environment with custom_branch_policies and registers main branch policy when missing', () => {
      shim = setupShim({ existingBranchPolicies: [], preventDuplicateBranchPolicy: true });
      const res = runBootstrap(['-Environment', 'prod', '-Force', '-PulumiPassphrase', 'prod-pass'], { PROJECT_ID: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const ghCalls = shim.getGhCalls();

      // PUT repos/amcgoey/INC-IO-Docs/environments/prod
      const envPutCall = ghCalls.find((c) =>
        c.args.includes('api') &&
        c.args.includes('repos/amcgoey/INC-IO-Docs/environments/prod') &&
        c.args.includes('PUT')
      );
      expect(envPutCall).toBeDefined();

      // POST main branch policy was performed
      const postPolicyCall = ghCalls.find((c) =>
        c.args.includes('api') &&
        c.args.includes('repos/amcgoey/INC-IO-Docs/environments/prod/deployment-branch-policies') &&
        c.args.includes('POST')
      );
      expect(postPolicyCall).toBeDefined();
      const hasMainInArgsOrStdin =
        postPolicyCall?.args.some((a) => a.includes('main')) ||
        Boolean(postPolicyCall?.stdin && postPolicyCall.stdin.includes('main'));
      expect(hasMainInArgsOrStdin).toBe(true);
    });

    it('idempotently skips POST when branch policy already exists and avoids duplicate 422 errors on re-runs', () => {
      shim = setupShim({ existingBranchPolicies: ['develop'], preventDuplicateBranchPolicy: true });
      const res = runBootstrap(['-Force', '-PulumiPassphrase', 'dev-pass'], { PROJECT_ID: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const ghCalls = shim.getGhCalls();

      // GET branch policies was performed
      const getPolicyCall = ghCalls.find((c) =>
        c.args.includes('api') &&
        c.args.includes('repos/amcgoey/INC-IO-Docs/environments/dev/deployment-branch-policies') &&
        !c.args.includes('POST')
      );
      expect(getPolicyCall).toBeDefined();

      // POST branch policy was NOT performed
      const postPolicyCall = ghCalls.find((c) =>
        c.args.includes('api') &&
        c.args.includes('repos/amcgoey/INC-IO-Docs/environments/dev/deployment-branch-policies') &&
        c.args.includes('POST')
      );
      expect(postPolicyCall).toBeUndefined();
    });
  });

  describe('Automated GitHub Environment Variables', () => {
    let shim: ReturnType<typeof setupShim>;

    afterEach(() => {
      if (shim) shim.cleanup();
    });

    it('sets the 6 required environment variables for dev environment', () => {
      shim = setupShim({ existingBranchPolicies: ['develop'] });
      const res = runBootstrap(['-Force', '-PulumiPassphrase', 'dev-pass'], { PROJECT_ID: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const ghCalls = shim.getGhCalls();
      const varCalls = ghCalls.filter((c) => c.args.includes('variable') && c.args.includes('set'));

      const getVarValue = (varName: string) => {
        const call = varCalls.find((c) => c.args.includes(varName));
        if (!call) return undefined;
        const bodyIdx = call.args.indexOf('--body');
        return bodyIdx !== -1 ? call.args[bodyIdx + 1] : undefined;
      };

      expect(getVarValue('PROJECT_ID')).toBe('inc-io-docs-dev');
      expect(getVarValue('REGION')).toBe('us-east4');
      expect(getVarValue('REPO_NAME')).toBe('inc-io-docs');
      expect(getVarValue('SERVICE_NAME')).toBe('inc-io-docs-dev');
      expect(getVarValue('PULUMI_STACK')).toBe('dev');
      expect(getVarValue('PULUMI_STATE_BUCKET')).toBe('gs://inc-io-docs-dev-pulumi-state');

      // Verify all variable calls target the dev environment and amcgoey/INC-IO-Docs repo
      for (const call of varCalls) {
        expect(call.args).toContain('--env');
        expect(call.args[call.args.indexOf('--env') + 1]).toBe('dev');
        expect(call.args).toContain('--repo');
        expect(call.args[call.args.indexOf('--repo') + 1]).toBe('amcgoey/INC-IO-Docs');
      }
    });

    it('sets the 6 required environment variables for prod environment', () => {
      shim = setupShim({ existingBranchPolicies: ['main'] });
      const res = runBootstrap(['-Environment', 'prod', '-Force', '-PulumiPassphrase', 'prod-pass'], { PROJECT_ID: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const ghCalls = shim.getGhCalls();
      const varCalls = ghCalls.filter((c) => c.args.includes('variable') && c.args.includes('set'));

      const getVarValue = (varName: string) => {
        const call = varCalls.find((c) => c.args.includes(varName));
        if (!call) return undefined;
        const bodyIdx = call.args.indexOf('--body');
        return bodyIdx !== -1 ? call.args[bodyIdx + 1] : undefined;
      };

      expect(getVarValue('PROJECT_ID')).toBe('inc-io-docs-prod');
      expect(getVarValue('REGION')).toBe('us-east4');
      expect(getVarValue('REPO_NAME')).toBe('inc-io-docs');
      expect(getVarValue('SERVICE_NAME')).toBe('inc-io-docs-prod');
      expect(getVarValue('PULUMI_STACK')).toBe('prod');
      expect(getVarValue('PULUMI_STATE_BUCKET')).toBe('gs://inc-io-docs-prod-pulumi-state');

      for (const call of varCalls) {
        expect(call.args).toContain('--env');
        expect(call.args[call.args.indexOf('--env') + 1]).toBe('prod');
      }
    });
  });

  describe('Automated GitHub Environment Secrets & Passphrase Resolution', () => {
    let shim: ReturnType<typeof setupShim>;

    afterEach(() => {
      if (shim) shim.cleanup();
    });

    it('sets WIF_PROVIDER and GCP_SERVICE_ACCOUNT secrets for dev environment', () => {
      shim = setupShim({ projectNumber: '112233445566', existingSecrets: ['PULUMI_CONFIG_PASSPHRASE'] });
      const res = runBootstrap(['-Force'], { PROJECT_ID: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const ghCalls = shim.getGhCalls();
      const secretCalls = ghCalls.filter((c) => c.args.includes('secret') && c.args.includes('set'));

      const getSecretValue = (secretName: string) => {
        const call = secretCalls.find((c) => c.args.includes(secretName));
        if (!call) return undefined;
        const bodyIdx = call.args.indexOf('--body');
        return bodyIdx !== -1 ? call.args[bodyIdx + 1] : undefined;
      };

      expect(getSecretValue('WIF_PROVIDER')).toBe(
        'projects/112233445566/locations/global/workloadIdentityPools/github-actions-pool/providers/github-provider'
      );
      expect(getSecretValue('GCP_SERVICE_ACCOUNT')).toBe('ci-deployer@inc-io-docs-dev.iam.gserviceaccount.com');
    });

    it('sets PULUMI_CONFIG_PASSPHRASE from explicit -PulumiPassphrase argument', () => {
      shim = setupShim({});
      const res = runBootstrap(['-Force', '-PulumiPassphrase', 'explicit-custom-passphrase'], { PROJECT_ID: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const ghCalls = shim.getGhCalls();
      const passphraseCall = ghCalls.find((c) =>
        c.args.includes('secret') && c.args.includes('set') && c.args.includes('PULUMI_CONFIG_PASSPHRASE')
      );
      expect(passphraseCall).toBeDefined();
      const bodyIdx = passphraseCall?.args.indexOf('--body');
      expect(bodyIdx).toBeDefined();
      expect(passphraseCall?.args[bodyIdx! + 1]).toBe('explicit-custom-passphrase');
    });

    it('sets PULUMI_CONFIG_PASSPHRASE from ambient env var $env:PULUMI_CONFIG_PASSPHRASE when argument omitted', () => {
      shim = setupShim({});
      const res = runBootstrap(['-Force'], { PROJECT_ID: undefined, PULUMI_CONFIG_PASSPHRASE: 'env-custom-passphrase' }, shim.tmpDir);
      expect(res.status).toBe(0);

      const ghCalls = shim.getGhCalls();
      const passphraseCall = ghCalls.find((c) =>
        c.args.includes('secret') && c.args.includes('set') && c.args.includes('PULUMI_CONFIG_PASSPHRASE')
      );
      expect(passphraseCall).toBeDefined();
      const bodyIdx = passphraseCall?.args.indexOf('--body');
      expect(bodyIdx).toBeDefined();
      expect(passphraseCall?.args[bodyIdx! + 1]).toBe('env-custom-passphrase');
    });

    it('preserves existing PULUMI_CONFIG_PASSPHRASE without overwriting when secret already exists and argument omitted', () => {
      shim = setupShim({ existingSecrets: ['PULUMI_CONFIG_PASSPHRASE'] });
      const res = runBootstrap(['-Force'], { PROJECT_ID: undefined, PULUMI_CONFIG_PASSPHRASE: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const ghCalls = shim.getGhCalls();
      // Verifies secret list was queried
      const listCall = ghCalls.find((c) => c.args.includes('secret') && c.args.includes('list'));
      expect(listCall).toBeDefined();

      // Verifies PULUMI_CONFIG_PASSPHRASE was NOT set
      const passphraseSetCall = ghCalls.find((c) =>
        c.args.includes('secret') && c.args.includes('set') && c.args.includes('PULUMI_CONFIG_PASSPHRASE')
      );
      expect(passphraseSetCall).toBeUndefined();
    });

    it('outputs only WIF_PROVIDER and GCP_SERVICE_ACCOUNT in summary Secrets and emits warning when passphrase omitted under -Force', () => {
      shim = setupShim({});
      const res = runBootstrap(['-Force'], { PROJECT_ID: undefined, PULUMI_CONFIG_PASSPHRASE: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const combinedOutput = `${res.stdout}\n${res.stderr}`;
      expect(combinedOutput).toContain('Secrets:   WIF_PROVIDER, GCP_SERVICE_ACCOUNT');
      expect(combinedOutput).not.toContain('Secrets:   WIF_PROVIDER, GCP_SERVICE_ACCOUNT, PULUMI_CONFIG_PASSPHRASE');
      expect(combinedOutput).toMatch(/PULUMI_CONFIG_PASSPHRASE was not configured \(omitted under -Force\)\. Ensure this secret is set in GitHub\s+Environment 'dev' before running CI deployments\./);
    });

    it('outputs WIF_PROVIDER, GCP_SERVICE_ACCOUNT, PULUMI_CONFIG_PASSPHRASE in summary Secrets without warning when passphrase configured', () => {
      shim = setupShim({});
      const res = runBootstrap(['-Force', '-PulumiPassphrase', 'custom-pass'], { PROJECT_ID: undefined }, shim.tmpDir);
      expect(res.status).toBe(0);

      const combinedOutput = `${res.stdout}\n${res.stderr}`;
      expect(combinedOutput).toContain('Secrets:   WIF_PROVIDER, GCP_SERVICE_ACCOUNT, PULUMI_CONFIG_PASSPHRASE');
      expect(combinedOutput).not.toContain('PULUMI_CONFIG_PASSPHRASE was not configured');
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
