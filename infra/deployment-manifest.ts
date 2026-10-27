import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const WorkspaceTriggerSchema = Type.Object({
  runFunction: Type.String({ minLength: 1, pattern: '^https://' }),
});

export const GmailTriggerSchema = Type.Object({
  unconditional: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  onTriggerFunction: Type.String({ minLength: 1, pattern: '^https://' }),
});

export const DeploymentManifestSchema = Type.Object({
  oauthScopes: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
  addOns: Type.Object({
    common: Type.Object({
      name: Type.String({ minLength: 1 }),
      logoUrl: Type.String({ minLength: 1, pattern: '^https://' }),
      homepageTrigger: Type.Optional(WorkspaceTriggerSchema),
    }),
    drive: Type.Optional(
      Type.Object({
        homepageTrigger: Type.Optional(WorkspaceTriggerSchema),
        onItemsSelectedTrigger: Type.Optional(WorkspaceTriggerSchema),
      })
    ),
    gmail: Type.Optional(
      Type.Object({
        contextualTriggers: Type.Optional(Type.Array(GmailTriggerSchema)),
      })
    ),
  }),
});

export type DeploymentManifest = Static<typeof DeploymentManifestSchema>;

export interface GenerateDeploymentManifestOptions {
  templateContent: string;
  serviceUrl: string;
  environment: 'dev' | 'prod';
  addOnName?: string | undefined;
}

export interface GenerateDeploymentManifestResult {
  manifest: DeploymentManifest;
  json: string;
}

/**
 * Generates and validates a Google Workspace Add-on deployment manifest from a template string.
 *
 * Normalizes serviceUrl (strips trailing slashes, enforces HTTPS), resolves addOnName based on
 * environment (unless overridden), substitutes {{ADDON_NAME}} and {{BASE_URL}}, fails fast on
 * any unresolved tokens or invalid JSON, and strictly validates against DeploymentManifestSchema.
 */
export function generateDeploymentManifest(
  options: GenerateDeploymentManifestOptions
): GenerateDeploymentManifestResult {
  const trimmedServiceUrl = options.serviceUrl?.trim() ?? '';
  if (!trimmedServiceUrl.startsWith('https://')) {
    throw new Error(
      `serviceUrl must be a valid HTTPS URL starting with "https://", received: "${options.serviceUrl}"`
    );
  }
  const normalizedServiceUrl = trimmedServiceUrl.replace(/\/+$/, '');

  let effectiveAddOnName = options.addOnName?.trim();
  if (!effectiveAddOnName) {
    if (options.environment === 'dev') {
      effectiveAddOnName = 'INC-IO Docs (Dev)';
    } else if (options.environment === 'prod') {
      effectiveAddOnName = 'INC-IO Docs';
    } else {
      throw new Error(`Invalid environment: "${options.environment}". Must be "dev" or "prod".`);
    }
  }

  const rendered = options.templateContent
    .replaceAll('{{ADDON_NAME}}', effectiveAddOnName)
    .replaceAll('{{BASE_URL}}', normalizedServiceUrl);

  const unresolvedTokens = rendered.match(/\{\{[^}]+\}\}/g);
  if (unresolvedTokens && unresolvedTokens.length > 0) {
    const uniqueTokens = [...new Set(unresolvedTokens)];
    throw new Error(
      `Unresolved template placeholder tokens remaining in manifest: ${uniqueTokens.join(', ')}`
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rendered);
  } catch (error) {
    throw new Error(
      `Failed to parse rendered deployment manifest as JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }

  if (!Value.Check(DeploymentManifestSchema, parsed)) {
    const errors = [...Value.Errors(DeploymentManifestSchema, parsed)];
    const formattedErrors = errors
      .map((err) => `${err.path || '/'}: ${err.message}`)
      .join('; ');
    throw new Error(`Deployment manifest validation failed: ${formattedErrors}`);
  }

  const manifest = parsed as DeploymentManifest;
  const json = JSON.stringify(manifest, null, 2) + '\n';

  return { manifest, json };
}
