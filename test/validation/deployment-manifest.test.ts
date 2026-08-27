import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect, beforeAll } from 'vitest';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const WorkspaceTriggerSchema = Type.Object({
  runFunction: Type.String({ minLength: 1 }),
});

export const DeploymentManifestSchema = Type.Object({
  oauthScopes: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  addOns: Type.Object({
    common: Type.Object({
      name: Type.String({ minLength: 1 }),
      logoUrl: Type.String({ minLength: 1 }),
      homepageTrigger: Type.Optional(WorkspaceTriggerSchema),
    }),
    drive: Type.Optional(
      Type.Object({
        homepageTrigger: Type.Optional(WorkspaceTriggerSchema),
        onItemsSelectedTrigger: Type.Optional(WorkspaceTriggerSchema),
      })
    ),
  }),
});

export type DeploymentManifest = Static<typeof DeploymentManifestSchema>;

describe('Google Workspace Add-on Deployment Manifest', () => {
  const manifestPath = path.resolve(__dirname, '../../infra/deployment.json');
  let manifest: unknown;

  beforeAll(() => {
    expect(fs.existsSync(manifestPath)).toBe(true);
    const content = fs.readFileSync(manifestPath, 'utf8');
    manifest = JSON.parse(content);
  });

  it('should validate against TypeBox DeploymentManifestSchema', () => {
    const isValid = Value.Check(DeploymentManifestSchema, manifest);
    const errors = [...Value.Errors(DeploymentManifestSchema, manifest)];
    expect(errors).toEqual([]);
    expect(isValid).toBe(true);
  });

  it('should contain expected OAuth scopes', () => {
    const typed = manifest as DeploymentManifest;
    expect(typed.oauthScopes).toContain('https://www.googleapis.com/auth/drive');
    expect(typed.oauthScopes).toContain('https://www.googleapis.com/auth/drive.addons.metadata.readonly');
    expect(typed.oauthScopes).toContain('https://www.googleapis.com/auth/userinfo.email');
  });

  it('should configure valid HTTPS triggers for common and drive integration', () => {
    const typed = manifest as DeploymentManifest;
    expect(typed.addOns.common.name).toBe('INC-IO Docs');
    expect(typed.addOns.common.logoUrl).toMatch(/^https:\/\//);
    expect(typed.addOns.common.homepageTrigger?.runFunction).toMatch(/^https:\/\//);

    expect(typed.addOns.drive?.homepageTrigger?.runFunction).toMatch(/^https:\/\//);
    expect(typed.addOns.drive?.onItemsSelectedTrigger?.runFunction).toMatch(/^https:\/\//);
  });
});
