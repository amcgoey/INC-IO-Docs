import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import { parseJson, validateAndCleanSchema } from '../validation/json-schema';

export const WorkspaceConfigurationSchema = Type.Object({
  defaultDocumentType: Type.Optional(Type.String()),
  defaultDocumentSpaceType: Type.Optional(Type.String()),
  timeZone: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
});

export const DriveConfigurationSchema = Type.Object({
  defaultFolderName: Type.Optional(Type.String()),
  maxRetries: Type.Optional(Type.Number()),
  initialDelayMs: Type.Optional(Type.Number()),
  backoffFactor: Type.Optional(Type.Number()),
});

export const SheetsConfigurationSchema = Type.Object({
  maxRetries: Type.Optional(Type.Number()),
  initialDelayMs: Type.Optional(Type.Number()),
  backoffFactor: Type.Optional(Type.Number()),
});

export type WorkspaceConfiguration = Static<typeof WorkspaceConfigurationSchema>;
export type DriveConfiguration = Static<typeof DriveConfigurationSchema>;
export type SheetsConfiguration = Static<typeof SheetsConfigurationSchema>;

export const DEFAULT_MAX_IN_MEMORY_FILE_BYTES = 200 * 1024 * 1024;
export const MAX_IN_MEMORY_FILE_BYTES_ENV_VAR = 'MAX_IN_MEMORY_FILE_BYTES';

/**
 * Parses the optional MAX_IN_MEMORY_FILE_BYTES environment override, throwing if non-empty and invalid.
 */
export function resolveMaxInMemoryFileBytesFromEnv(): number | undefined {
  const raw = process.env[MAX_IN_MEMORY_FILE_BYTES_ENV_VAR];
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new Error(
      `Invalid ${MAX_IN_MEMORY_FILE_BYTES_ENV_VAR} environment variable "${raw}": must be a positive integer`
    );
  }
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(
      `Invalid ${MAX_IN_MEMORY_FILE_BYTES_ENV_VAR} environment variable "${raw}": must be a positive integer`
    );
  }
  return parsed;
}

/**
 * Builds an async provider resolving the in-memory file byte limit from configProvider,
 * environment override, or the 200 MB default.
 */
export function createMaxInMemoryFileBytesProvider(
  configProvider?: { getMaxInMemoryFileBytes?: () => Promise<number | undefined> }
): () => Promise<number> {
  return async (): Promise<number> => {
    if (configProvider && typeof configProvider.getMaxInMemoryFileBytes === 'function') {
      const configured = await configProvider.getMaxInMemoryFileBytes();
      if (configured !== undefined) {
        return configured;
      }
    }
    return resolveMaxInMemoryFileBytesFromEnv() ?? DEFAULT_MAX_IN_MEMORY_FILE_BYTES;
  };
}

export const AppConfigurationSchema = Type.Object({
  workspace: Type.Optional(WorkspaceConfigurationSchema),
  drive: Type.Optional(DriveConfigurationSchema),
  sheets: Type.Optional(SheetsConfigurationSchema),
  maxInMemoryFileBytes: Type.Optional(
    Type.Union([Type.Integer({ minimum: 1 }), Type.Undefined()])
  ),
  templates: Type.Optional(
    Type.Union([
      Type.Record(Type.String({ minLength: 1 }), Type.String({ minLength: 1 })),
      Type.Undefined(),
    ])
  ),
});

export type AppConfiguration = Static<typeof AppConfigurationSchema>;

export const ManifestSchema = Type.Object({
  documentTypes: Type.Array(Type.String()),
  configuration: Type.Optional(AppConfigurationSchema),
  DocumentSpaceTypes: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()))),
  aliases: Type.Optional(Type.Union([Type.Record(Type.String(), Type.String()), Type.Undefined()])),
});

export type Manifest = Static<typeof ManifestSchema>;

export interface AppManifestProviderOptions {
  manifestPath?: string;
}

export class AppManifestProvider {
  private readonly manifestPath: string;
  private cachedConfiguration: AppConfiguration | undefined = undefined;
  private cachedRawManifest: unknown = undefined;
  private cachedValidatedManifest: Manifest | undefined = undefined;
  private isManifestLoaded = false;
  private manifestLoadPromise: Promise<Manifest> | undefined = undefined;
  private readonly parsedSchemaCache = new Map<string, unknown>();
  private readonly inFlightSchemaReads = new Map<string, Promise<unknown>>();

  constructor(options?: AppManifestProviderOptions) {
    const manifestPath = options?.manifestPath ?? process.env.APP_MANIFEST_PATH;
    if (!manifestPath) {
      throw new Error(
        'Manifest path is not defined. Please provide options.manifestPath or set the APP_MANIFEST_PATH environment variable.'
      );
    }
    this.manifestPath = manifestPath;
  }

  private async loadManifest(): Promise<Static<typeof ManifestSchema>> {
    if (this.isManifestLoaded && this.cachedValidatedManifest) {
      return this.cachedValidatedManifest;
    }
    if (this.manifestLoadPromise) {
      return this.manifestLoadPromise;
    }

    this.manifestLoadPromise = (async () => {
      let manifestContent: string;
      try {
        manifestContent = await fs.readFile(this.manifestPath, 'utf-8');
      } catch (err) {
        throw new Error(
          `Failed to read manifest file at "${this.manifestPath}": ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
      const rawData = parseJson(manifestContent, {
        filePath: this.manifestPath,
        description: 'manifest file',
      }) as Record<string, unknown>;

      const validatedManifest = validateAndCleanSchema(
        ManifestSchema,
        rawData,
        `Invalid manifest file structure at "${this.manifestPath}"`
      );

      const timeZone = validatedManifest.configuration?.workspace?.timeZone;
      if (timeZone !== undefined) {
        if (timeZone.trim().length === 0) {
          throw new Error(
            `Invalid workspace configuration at "${this.manifestPath}": timeZone must be a non-empty valid IANA timezone identifier`
          );
        }
        try {
          new Intl.DateTimeFormat(undefined, { timeZone });
        } catch (err) {
          throw new Error(
            `Invalid workspace configuration at "${this.manifestPath}": invalid IANA timeZone "${timeZone}"`,
            { cause: err }
          );
        }
      }

      this.cachedConfiguration = validatedManifest.configuration;

      const templates = validatedManifest.configuration?.templates;
      if (templates !== undefined) {
        for (const [templateKey, envVarName] of Object.entries(templates)) {
          if (templateKey.trim().length === 0 || envVarName.trim().length === 0) {
            throw new Error(
              `Invalid templates configuration at "${this.manifestPath}": templateKey "${templateKey}" and env var name must be non-empty strings`
            );
          }
        }
      }

      this.cachedRawManifest = rawData;
      this.cachedValidatedManifest = validatedManifest;
      this.isManifestLoaded = true;
      return validatedManifest;
    })();

    try {
      return await this.manifestLoadPromise;
    } finally {
      this.manifestLoadPromise = undefined;
    }
  }

  async getDriveConfig(): Promise<DriveConfiguration | undefined> {
    if (!this.isManifestLoaded) {
      try {
        await this.loadManifest();
      } catch (err) {
        throw new Error(
          `Failed to load drive config from manifest: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
    }
    return this.cachedConfiguration?.drive !== undefined
      ? structuredClone(this.cachedConfiguration.drive)
      : undefined;
  }

  async getWorkspaceConfig(): Promise<WorkspaceConfiguration | undefined> {
    if (!this.isManifestLoaded) {
      try {
        await this.loadManifest();
      } catch (err) {
        throw new Error(
          `Failed to load workspace config from manifest: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
    }
    return this.cachedConfiguration?.workspace !== undefined
      ? structuredClone(this.cachedConfiguration.workspace)
      : undefined;
  }

  async getSheetsConfig(): Promise<SheetsConfiguration | undefined> {
    if (!this.isManifestLoaded) {
      try {
        await this.loadManifest();
      } catch (err) {
        throw new Error(
          `Failed to load sheets config from manifest: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
    }
    return this.cachedConfiguration?.sheets !== undefined
      ? structuredClone(this.cachedConfiguration.sheets)
      : undefined;
  }

  /**
   * Resolves the maximum in-memory file byte limit from the environment override,
   * manifest configuration, or the 200 MB default.
   */
  async getMaxInMemoryFileBytes(): Promise<number> {
    const envOverride = resolveMaxInMemoryFileBytesFromEnv();
    if (envOverride !== undefined) {
      return envOverride;
    }
    if (!this.isManifestLoaded) {
      try {
        await this.loadManifest();
      } catch (err) {
        throw new Error(
          `Failed to load maxInMemoryFileBytes from manifest: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
    }
    return this.cachedConfiguration?.maxInMemoryFileBytes ?? DEFAULT_MAX_IN_MEMORY_FILE_BYTES;
  }

  /**
   * Returns logical DocumentTemplate keys mapped to runtime environment variable names.
   */
  async getTemplatesConfig(): Promise<Record<string, string> | undefined> {
    if (!this.isManifestLoaded) {
      try {
        await this.loadManifest();
      } catch (err) {
        throw new Error(
          `Failed to load templates config from manifest: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
    }
    return this.cachedConfiguration?.templates !== undefined
      ? structuredClone(this.cachedConfiguration.templates)
      : undefined;
  }

  async getRawManifest(): Promise<unknown> {
    if (!this.isManifestLoaded) {
      try {
        await this.loadManifest();
      } catch (err) {
        throw new Error(
          `Failed to load raw manifest: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }
    }
    return structuredClone(this.cachedRawManifest);
  }

  async readParsedSchema(relPath: string): Promise<unknown> {
    const manifestDir = path.dirname(this.manifestPath);
    const resolvedPath = path.resolve(manifestDir, relPath);

    if (this.parsedSchemaCache.has(resolvedPath)) {
      return structuredClone(this.parsedSchemaCache.get(resolvedPath));
    }

    let inFlight = this.inFlightSchemaReads.get(resolvedPath);
    if (!inFlight) {
      inFlight = (async () => {
        let content: string;
        try {
          content = await fs.readFile(resolvedPath, 'utf-8');
        } catch (err) {
          throw new Error(
            `Failed to read DocumentType file "${relPath}" at "${resolvedPath}": ${err instanceof Error ? err.message : String(err)}`,
            { cause: err }
          );
        }
        const parsed = parseJson(content, {
          filePath: resolvedPath,
          description: `DocumentType file "${relPath}"`,
        });
        this.parsedSchemaCache.set(resolvedPath, parsed);
        return parsed;
      })();
      this.inFlightSchemaReads.set(resolvedPath, inFlight);
    }

    try {
      const result = await inFlight;
      return structuredClone(result);
    } finally {
      this.inFlightSchemaReads.delete(resolvedPath);
    }
  }
}



