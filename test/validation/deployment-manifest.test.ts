import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  generateDeploymentManifest,
  DeploymentManifestSchema,
  DEFAULT_DEV_LOGO_URL,
  DEFAULT_PROD_LOGO_URL,
  type DeploymentManifest,
} from '../../infra/deployment-manifest';

describe('Google Workspace Add-on Deployment Manifest Generator', () => {
  const templatePath = path.resolve(__dirname, '../../infra/deployment.template.json');
  const templateContent = fs.readFileSync(templatePath, 'utf8');

  it('renders committed template for dev environment with correct name and triggers', () => {
    const { manifest, json } = generateDeploymentManifest({
      templateContent,
      serviceUrl: 'https://service-dev.run.app',
      environment: 'dev',
    });

    expect(manifest.addOns.common.name).toBe('INC-IO Docs (Dev)');
    expect(manifest.addOns.common.logoUrl).toBe(DEFAULT_DEV_LOGO_URL);
    expect(manifest.addOns.common.homepageTrigger?.runFunction).toBe(
      'https://service-dev.run.app/workspace/homepage'
    );
    expect(manifest.addOns.drive?.homepageTrigger?.runFunction).toBe(
      'https://service-dev.run.app/workspace/homepage'
    );
    expect(manifest.addOns.drive?.onItemsSelectedTrigger?.runFunction).toBe(
      'https://service-dev.run.app/workspace/drive-items-selected'
    );
    expect(manifest.addOns.gmail?.contextualTriggers?.[0]?.onTriggerFunction).toBe(
      'https://service-dev.run.app/workspace/gmail-contextual'
    );

    // Schema validation
    expect(Value.Check(DeploymentManifestSchema, manifest)).toBe(true);

    // String JSON parsed matches manifest
    expect(JSON.parse(json)).toEqual(manifest);
  });

  it('renders committed template for prod environment with production name', () => {
    const { manifest } = generateDeploymentManifest({
      templateContent,
      serviceUrl: 'https://service-prod.run.app',
      environment: 'prod',
    });

    expect(manifest.addOns.common.name).toBe('INC-IO Docs');
    expect(manifest.addOns.common.logoUrl).toBe(DEFAULT_PROD_LOGO_URL);
    expect(Value.Check(DeploymentManifestSchema, manifest)).toBe(true);
  });

  it('resolves custom logoUrl override regardless of environment', () => {
    const customUrl = 'https://custom.cdn.com/assets/logo.png';
    const { manifest } = generateDeploymentManifest({
      templateContent,
      serviceUrl: 'https://service-dev.run.app',
      environment: 'dev',
      logoUrl: customUrl,
    });

    expect(manifest.addOns.common.logoUrl).toBe(customUrl);
  });

  it('appends logoVersion cache-buster query parameter to logoUrl', () => {
    const { manifest: devManifest } = generateDeploymentManifest({
      templateContent,
      serviceUrl: 'https://service-dev.run.app',
      environment: 'dev',
      logoVersion: 'abc1234',
    });
    expect(devManifest.addOns.common.logoUrl).toBe(`${DEFAULT_DEV_LOGO_URL}?v=abc1234`);

    const { manifest: queryManifest } = generateDeploymentManifest({
      templateContent,
      serviceUrl: 'https://service-dev.run.app',
      environment: 'dev',
      logoUrl: 'https://custom.cdn.com/logo.png?token=secret',
      logoVersion: 'v1.2.3',
    });
    expect(queryManifest.addOns.common.logoUrl).toBe(
      'https://custom.cdn.com/logo.png?token=secret&v=v1.2.3'
    );
  });

  it('contains expected OAuth scopes', () => {
    const { manifest } = generateDeploymentManifest({
      templateContent,
      serviceUrl: 'https://service.run.app',
      environment: 'dev',
    });

    expect(manifest.oauthScopes).toContain('https://www.googleapis.com/auth/drive');
    expect(manifest.oauthScopes).toContain(
      'https://www.googleapis.com/auth/drive.addons.metadata.readonly'
    );
    expect(manifest.oauthScopes).toContain('https://www.googleapis.com/auth/gmail.addons.execute');
    expect(manifest.oauthScopes).toContain('https://www.googleapis.com/auth/gmail.readonly');
    expect(manifest.oauthScopes).toContain('https://www.googleapis.com/auth/userinfo.email');
  });

  it('allows addOnName override regardless of environment', () => {
    const { manifest } = generateDeploymentManifest({
      templateContent,
      serviceUrl: 'https://service-dev.run.app',
      environment: 'dev',
      addOnName: 'Custom Addon Title',
    });

    expect(manifest.addOns.common.name).toBe('Custom Addon Title');
  });

  it('normalizes trailing slashes and whitespace on serviceUrl without double slashes', () => {
    const { manifest } = generateDeploymentManifest({
      templateContent,
      serviceUrl: '   https://service-dev.run.app///   ',
      environment: 'dev',
    });

    expect(manifest.addOns.common.homepageTrigger?.runFunction).toBe(
      'https://service-dev.run.app/workspace/homepage'
    );
    expect(manifest.addOns.drive?.onItemsSelectedTrigger?.runFunction).toBe(
      'https://service-dev.run.app/workspace/drive-items-selected'
    );
    expect(manifest.addOns.gmail?.contextualTriggers?.[0]?.onTriggerFunction).toBe(
      'https://service-dev.run.app/workspace/gmail-contextual'
    );
  });

  it('fails fast if serviceUrl is not HTTPS or empty', () => {
    expect(() =>
      generateDeploymentManifest({
        templateContent,
        serviceUrl: 'http://service-dev.run.app',
        environment: 'dev',
      })
    ).toThrow(/HTTPS/i);

    expect(() =>
      generateDeploymentManifest({
        templateContent,
        serviceUrl: '   ',
        environment: 'dev',
      })
    ).toThrow(/HTTPS/i);

    expect(() =>
      generateDeploymentManifest({
        templateContent,
        serviceUrl: 'ftp://service.com',
        environment: 'dev',
      })
    ).toThrow(/HTTPS/i);
  });

  it('fails fast if unresolved placeholder tokens remain in template', () => {
    const invalidTemplate = templateContent.replace(
      '"name": "{{ADDON_NAME}}"',
      '"name": "{{ADDON_NAME}}", "unknown": "{{UNRESOLVED_TOKEN}}"'
    );

    expect(() =>
      generateDeploymentManifest({
        templateContent: invalidTemplate,
        serviceUrl: 'https://service.run.app',
        environment: 'dev',
      })
    ).toThrow(/UNRESOLVED_TOKEN/i);
  });

  it('fails fast if template contains invalid JSON', () => {
    expect(() =>
      generateDeploymentManifest({
        templateContent: '{ invalid json {{BASE_URL}} }',
        serviceUrl: 'https://service.run.app',
        environment: 'dev',
      })
    ).toThrow(/JSON/i);
  });

  it('fails fast if rendered manifest fails schema validation (non-https logoUrl or triggers)', () => {
    expect(() =>
      generateDeploymentManifest({
        templateContent,
        serviceUrl: 'https://service.run.app',
        environment: 'dev',
        logoUrl: 'http://insecure.com/logo.png',
      })
    ).toThrow(/validation failed/i);
  });

  it('CLI writes validated deployment manifest encoded as UTF-8 without BOM', () => {
    const tmpDir = path.resolve(__dirname, '../../scratch/test-manifest-output');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpOutput = path.resolve(tmpDir, 'deployment.cli.json');

    try {
      const tsxCli = require.resolve('tsx/cli');
      execFileSync(
        process.execPath,
        [
          tsxCli,
          'infra/generate-deployment-manifest.ts',
          '--service-url',
          'https://cli-test.run.app',
          '--environment',
          'dev',
          '--template',
          templatePath,
          '--output',
          tmpOutput,
        ],
        {
          cwd: path.resolve(__dirname, '../..'),
          encoding: 'utf8',
        }
      );

      expect(fs.existsSync(tmpOutput)).toBe(true);

      const buffer = fs.readFileSync(tmpOutput);
      // Verify no UTF-8 BOM (0xEF, 0xBB, 0xBF)
      expect(buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf).toBe(false);

      const parsed = JSON.parse(buffer.toString('utf8')) as DeploymentManifest;
      expect(parsed.addOns.common.name).toBe('INC-IO Docs (Dev)');
      expect(parsed.addOns.common.logoUrl).toBe(DEFAULT_DEV_LOGO_URL);
      expect(parsed.addOns.common.homepageTrigger?.runFunction).toBe(
        'https://cli-test.run.app/workspace/homepage'
      );
      expect(Value.Check(DeploymentManifestSchema, parsed)).toBe(true);
    } finally {
      if (fs.existsSync(tmpOutput)) {
        fs.unlinkSync(tmpOutput);
      }
    }
  });

  it('CLI accepts --logo-url and --logo-version overrides', () => {
    const tmpDir = path.resolve(__dirname, '../../scratch/test-manifest-output');
    fs.mkdirSync(tmpDir, { recursive: true });
    const tmpOutput = path.resolve(tmpDir, 'deployment.custom-logo.json');

    try {
      const tsxCli = require.resolve('tsx/cli');
      execFileSync(
        process.execPath,
        [
          tsxCli,
          'infra/generate-deployment-manifest.ts',
          '--service-url',
          'https://cli-test.run.app',
          '--environment',
          'prod',
          '--template',
          templatePath,
          '--output',
          tmpOutput,
          '--logo-url',
          'https://cdn.example.com/custom.png',
          '--logo-version',
          'sha-1234567',
        ],
        {
          cwd: path.resolve(__dirname, '../..'),
          encoding: 'utf8',
        }
      );

      expect(fs.existsSync(tmpOutput)).toBe(true);

      const buffer = fs.readFileSync(tmpOutput);
      const parsed = JSON.parse(buffer.toString('utf8')) as DeploymentManifest;
      expect(parsed.addOns.common.name).toBe('INC-IO Docs');
      expect(parsed.addOns.common.logoUrl).toBe('https://cdn.example.com/custom.png?v=sha-1234567');
      expect(Value.Check(DeploymentManifestSchema, parsed)).toBe(true);
    } finally {
      if (fs.existsSync(tmpOutput)) {
        fs.unlinkSync(tmpOutput);
      }
    }
  });
});
