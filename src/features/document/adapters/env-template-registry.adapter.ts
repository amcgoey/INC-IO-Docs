import {
  DocumentTemplateError,
  type ResolvedDocumentTemplate,
  type TemplateRegistryPort,
} from '../ports';

export const REDACTED_TEMPLATE_ID_PLACEHOLDER = '[REDACTED_TEMPLATE_ID]';

export interface EnvTemplateRegistryAdapterDeps {
  getTemplatesConfig: () => Promise<Record<string, string> | undefined>;
  readEnvVar?: ((envVarName: string) => string | undefined) | undefined;
}

/**
 * Resolves logical `DocumentTemplate` keys via `Manifest.configuration.templates`
 * to runtime environment variable values, keeping confidential Drive IDs out of
 * source control, execution contexts, errors, and logs.
 */
export class EnvTemplateRegistryAdapter implements TemplateRegistryPort {
  private readonly knownSecrets = new Set<string>();
  private lastTemplatesConfig: Record<string, string> | undefined;

  constructor(private readonly deps: EnvTemplateRegistryAdapterDeps) {}

  private readEnv(envVarName: string): string | undefined {
    if (this.deps.readEnvVar) {
      return this.deps.readEnvVar(envVarName);
    }
    return process.env[envVarName];
  }

  async resolveTemplate(templateKey: string): Promise<ResolvedDocumentTemplate> {
    const normalizedKey = templateKey.trim();
    if (normalizedKey.length === 0) {
      throw new DocumentTemplateError('DocumentTemplate key must be a non-empty string.', {
        templateKey,
      });
    }

    const templatesConfig = await this.deps.getTemplatesConfig();
    this.lastTemplatesConfig = templatesConfig;

    const envVarName = templatesConfig?.[normalizedKey]?.trim();
    if (!envVarName) {
      throw new DocumentTemplateError(
        `Unknown DocumentTemplate key "${normalizedKey}": not declared in Manifest configuration.templates.`,
        { templateKey: normalizedKey }
      );
    }

    const rawValue = this.readEnv(envVarName);
    const fileId = rawValue?.trim();
    if (!fileId) {
      throw new DocumentTemplateError(
        `DocumentTemplate "${normalizedKey}" is not configured: environment variable "${envVarName}" is missing or empty.`,
        { templateKey: normalizedKey }
      );
    }

    this.knownSecrets.add(fileId);
    return {
      templateKey: normalizedKey,
      fileId,
      envVarName,
    };
  }

  redactSecrets(message: string): string {
    if (!message) {
      return message;
    }

    const secretsToRedact = new Set<string>(this.knownSecrets);
    if (this.lastTemplatesConfig) {
      for (const envVarName of Object.values(this.lastTemplatesConfig)) {
        const trimmedName = envVarName.trim();
        if (trimmedName.length === 0) {
          continue;
        }
        const val = this.readEnv(trimmedName)?.trim();
        if (val) {
          secretsToRedact.add(val);
        }
      }
    }

    let redacted = message;
    const sortedSecrets = Array.from(secretsToRedact).sort((a, b) => b.length - a.length);
    for (const secret of sortedSecrets) {
      if (secret.length > 0 && redacted.includes(secret)) {
        redacted = redacted.split(secret).join(REDACTED_TEMPLATE_ID_PLACEHOLDER);
      }
    }
    return redacted;
  }
}
