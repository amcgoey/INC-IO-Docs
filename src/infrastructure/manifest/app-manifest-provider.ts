import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Type, type Static } from '@sinclair/typebox';
import { parseJson, validateAndCleanSchema } from '../validation/json-schema';

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
  defaultHeaderRangeName: Type.Optional(Type.String({ default: 'Headers' })),
  defaultDataRangeName: Type.Optional(Type.String({ default: 'Data' })),
  maxRetries: Type.Optional(Type.Number()),
  initialDelayMs: Type.Optional(Type.Number()),
  backoffFactor: Type.Optional(Type.Number()),
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
  manifestPath?: string;
}

export class AppManifestProvider {
  private readonly manifestPath: string;
  private cachedConfiguration: AppConfiguration | undefined = undefined;
  private cachedRawManifest: unknown = undefined;
  private cachedValidatedManifest: Manifest | undefined = undefined;
  private isManifestLoaded = false;

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
    let manifestContent: string;
    try {
      manifestContent = await fs.readFile(this.manifestPath, 'utf-8');
    } catch (err) {
      throw new Error(
        `Failed to read manifest file at "${this.manifestPath}": ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
    const manifestData = parseJson(manifestContent, {
      filePath: this.manifestPath,
      description: 'manifest file',
    });

    const validatedManifest = validateAndCleanSchema(
      ManifestSchema,
      manifestData,
      `Invalid manifest file structure at "${this.manifestPath}"`
    );

    this.cachedConfiguration = validatedManifest.configuration;
    this.cachedRawManifest = manifestData;
    this.cachedValidatedManifest = validatedManifest;
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
    return this.cachedConfiguration?.sheets;
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

  async readParsedSchema(relPath: string): Promise<unknown> {
    const manifestDir = path.dirname(this.manifestPath);
    const resolvedPath = path.resolve(manifestDir, relPath);
    let content: string;
    try {
      content = await fs.readFile(resolvedPath, 'utf-8');
    } catch (err) {
      throw new Error(
        `Failed to read DocumentType file "${relPath}" at "${resolvedPath}": ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
    return parseJson(content, {
      filePath: resolvedPath,
      description: `DocumentType file "${relPath}"`,
    });
  }
}
