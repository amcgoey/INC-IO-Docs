import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  EnvTemplateRegistryAdapter,
  REDACTED_TEMPLATE_ID_PLACEHOLDER,
  redactTemplateId,
} from './env-template-registry.adapter';
import { DocumentTemplateError } from '../ports';

describe('EnvTemplateRegistryAdapter (#379)', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('resolves templateKey via configuration.templates to the runtime env var value without exposing the secret in errors', async () => {
    const confidentialTemplateId = 'synthetic-secret-template-id-987654';
    vi.stubEnv('SUBMITTAL_COVER_SHEET_TEMPLATE_ID', `  ${confidentialTemplateId}  `);

    const adapter = new EnvTemplateRegistryAdapter({
      getTemplatesConfig: async () => ({
        submittalCoverSheet: 'SUBMITTAL_COVER_SHEET_TEMPLATE_ID',
      }),
    });

    const resolved = await adapter.resolveTemplate('submittalCoverSheet');
    expect(resolved).toEqual({
      templateKey: 'submittalCoverSheet',
      fileId: confidentialTemplateId,
      envVarName: 'SUBMITTAL_COVER_SHEET_TEMPLATE_ID',
    });

    const rawMessage = `Drive error fetching https://drive.google.com/file/d/${confidentialTemplateId}/view (${confidentialTemplateId})`;
    const redacted = adapter.redactSecrets(rawMessage);
    expect(redacted).not.toContain(confidentialTemplateId);
    expect(redacted).toContain('[REDACTED_TEMPLATE_ID]');
  });

  it('throws DocumentTemplateError when templateKey is undeclared or env var is missing/blank', async () => {
    const adapter = new EnvTemplateRegistryAdapter({
      getTemplatesConfig: async () => ({
        submittalCoverSheet: 'SUBMITTAL_COVER_SHEET_TEMPLATE_ID',
      }),
    });

    await expect(adapter.resolveTemplate('unknownKey')).rejects.toThrow(DocumentTemplateError);
    await expect(adapter.resolveTemplate('unknownKey')).rejects.toThrow(/unknownKey/);

    vi.stubEnv('SUBMITTAL_COVER_SHEET_TEMPLATE_ID', '   ');
    await expect(adapter.resolveTemplate('submittalCoverSheet')).rejects.toThrow(
      DocumentTemplateError
    );
    await expect(adapter.resolveTemplate('submittalCoverSheet')).rejects.toThrow(
      /SUBMITTAL_COVER_SHEET_TEMPLATE_ID/
    );
  });

  it('redactTemplateId replaces all occurrences of a secretId and leaves messages unchanged when secretId is absent or empty', () => {
    const confidentialTemplateId = 'synthetic-template-id-abc';
    expect(
      redactTemplateId(
        `Error for ${confidentialTemplateId} and ${confidentialTemplateId}`,
        confidentialTemplateId
      )
    ).toBe(
      `Error for ${REDACTED_TEMPLATE_ID_PLACEHOLDER} and ${REDACTED_TEMPLATE_ID_PLACEHOLDER}`
    );
    expect(redactTemplateId('Unchanged message', confidentialTemplateId)).toBe('Unchanged message');
    expect(redactTemplateId('Unchanged message', undefined)).toBe('Unchanged message');
    expect(redactTemplateId('Unchanged message', '')).toBe('Unchanged message');
  });
});
