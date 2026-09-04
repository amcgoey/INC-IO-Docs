import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const WorkspaceConfigurationSchema = Type.Object({
  appTitle: Type.Optional(Type.String()),
  actionButtonText: Type.Optional(Type.String()),
  defaultDocumentType: Type.Optional(Type.String()),
  defaultEventName: Type.Optional(Type.String()),
});

export const DriveConfigurationSchema = Type.Object({
  defaultFolderName: Type.Optional(Type.String()),
  maxRetries: Type.Optional(Type.Number()),
  initialDelayMs: Type.Optional(Type.Number()),
  backoffFactor: Type.Optional(Type.Number()),
});

export const SheetsConfigurationSchema = Type.Object({
  spreadsheetId: Type.Optional(Type.String()),
});

export type WorkspaceConfiguration = Static<typeof WorkspaceConfigurationSchema>;
export type DriveConfiguration = Static<typeof DriveConfigurationSchema>;
export type SheetsConfiguration = Static<typeof SheetsConfigurationSchema>;

export const AppConfigurationSchema = Type.Object({
  workspace: Type.Optional(WorkspaceConfigurationSchema),
  drive: Type.Optional(DriveConfigurationSchema),
  sheets: Type.Optional(SheetsConfigurationSchema),
});

export type AppConfiguration = Static<typeof AppConfigurationSchema>;

export const ManifestSchema = Type.Object({
  documentTypes: Type.Array(Type.String()),
  configuration: Type.Optional(AppConfigurationSchema),
});

export type Manifest = Static<typeof ManifestSchema>;

export interface AppManifestProviderOptions {
  manifestPath: string;
}

function parseJson(content: string, contextDescription: string): unknown {
  try {
    return JSON.parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in ${contextDescription}: ${message}`, { cause: err });
  }
}

function formatValidationErrors<T extends TSchema>(schema: T, value: unknown): string[] {
  return [...Value.Errors(schema, value)].map((e) => `${e.path}: ${e.message}`);
}

function validateAndCleanSchema<T extends TSchema>(
  schema: T,
  value: unknown,
  errorMessage: string
): Static<T> {
  const cloned = structuredClone(value);
  const cleaned = Value.Clean(schema, cloned);
  if (!Value.Check(schema, cleaned)) {
    const errors = formatValidationErrors(schema, cleaned).join(', ');
    throw new Error(`${errorMessage}: ${errors}`);
  }
  return cleaned as Static<T>;
}

export class AppManifestProvider {
  private readonly manifestPath: string;
  private cachedConfiguration: AppConfiguration | undefined = undefined;
  private cachedRawManifest: unknown = undefined;
  private isManifestLoaded = false;

  constructor(options?: AppManifestProviderOptions) {
    if (!options?.manifestPath) {
      throw new Error(
        'Manifest path is not defined. Please provide options.manifestPath.'
      );
    }
    this.manifestPath = options.manifestPath;
  }

  private async loadManifest(): Promise<Static<typeof ManifestSchema>> {
    let manifestContent: string;
    try {
      manifestContent = await fs.readFile(this.manifestPath, 'utf-8');
    } catch (err) {
      throw new Error(
        `Failed to read manifest file at "${this.manifestPath}": ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
    const manifestData = parseJson(manifestContent, `manifest file at "${this.manifestPath}"`);

    const validatedManifest = validateAndCleanSchema(
      ManifestSchema,
      manifestData,
      `Invalid manifest file structure at "${this.manifestPath}"`
    );

    this.cachedConfiguration = validatedManifest.configuration;
    this.cachedRawManifest = manifestData;
    this.isManifestLoaded = true;
    return validatedManifest;
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
    return this.cachedConfiguration?.drive;
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
    return this.cachedConfiguration?.workspace;
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
    return this.cachedRawManifest;
  }

  getManifestDir(): string {
    return path.dirname(this.manifestPath);
  }
}
