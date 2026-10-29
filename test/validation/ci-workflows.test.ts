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
});
