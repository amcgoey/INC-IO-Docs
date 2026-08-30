import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  DocumentTypeSchema,
  formatValidationErrors,
  validateManifestTemplates,
  type DocumentType,
} from '../domain';
import type {
  AppConfigurationProviderPort,
  DriveConfiguration,
  ManifestRegistryPort,
  TemplateEvaluatorPort,
} from '../ports';
import type {
  WorkspaceConfigProviderPort,
  WorkspaceConfiguration,
} from '../../workspace/ports';

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

export const AppConfigurationSchema = Type.Object({
  workspace: Type.Optional(WorkspaceConfigurationSchema),
  drive: Type.Optional(DriveConfigurationSchema),
});

export type AppConfiguration = Static<typeof AppConfigurationSchema>;

const ManifestSchema = Type.Object({
  documentTypes: Type.Array(Type.String()),
  configuration: Type.Optional(AppConfigurationSchema),
});

export interface ManifestRegistryAdapterOptions {
  manifestPath: string;
  templateEvaluator: TemplateEvaluatorPort;
}

function parseJson(content: string, contextDescription: string): unknown {
  try {
    return JSON.parse(content);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid JSON in ${contextDescription}: ${message}`, { cause: err });
  }
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

export class ManifestRegistryAdapter
  implements
    ManifestRegistryPort,
    AppConfigurationProviderPort,
    WorkspaceConfigProviderPort
{
  private readonly manifestPath: string;
  private readonly templateEvaluator: TemplateEvaluatorPort;
  private cachedConfiguration: AppConfiguration | undefined = undefined;
  private isManifestLoaded = false;

  constructor(options?: ManifestRegistryAdapterOptions) {
    if (!options?.manifestPath) {
      throw new Error(
        'Manifest path is not defined. Please provide options.manifestPath.'
      );
    }
    if (!options?.templateEvaluator) {
      throw new Error(
        'Template evaluator is not defined. Please provide options.templateEvaluator.'
      );
    }
    this.manifestPath = options.manifestPath;
    this.templateEvaluator = options.templateEvaluator;
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

  async loadAll(): Promise<DocumentType[]> {
    let validatedManifest: Static<typeof ManifestSchema>;
    try {
      validatedManifest = await this.loadManifest();
    } catch (err) {
      throw new Error(
        `Failed to load manifest in loadAll: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err }
      );
    }
    const manifestDir = path.dirname(this.manifestPath);
    const documentTypes: DocumentType[] = [];

    for (const documentTypeRelPath of validatedManifest.documentTypes) {
      const resolvedPath = path.resolve(manifestDir, documentTypeRelPath);
      let fileContent: string;
      try {
        fileContent = await fs.readFile(resolvedPath, 'utf-8');
      } catch (err) {
        throw new Error(
          `Failed to read DocumentType file "${documentTypeRelPath}" at "${resolvedPath}": ${err instanceof Error ? err.message : String(err)}`,
          { cause: err }
        );
      }

      const rawDocumentType = parseJson(
        fileContent,
        `DocumentType file "${documentTypeRelPath}" at "${resolvedPath}"`
      );

      const validatedDocumentType = validateAndCleanSchema(
        DocumentTypeSchema,
        rawDocumentType,
        `Invalid DocumentType schema in "${documentTypeRelPath}" at "${resolvedPath}"`
      );

      const templateErrors = validateManifestTemplates(
        validatedDocumentType,
        this.templateEvaluator
      );
      if (templateErrors.length > 0) {
        throw new Error(
          `Invalid template in "${documentTypeRelPath}" from manifest "${this.manifestPath}": ${templateErrors.join(', ')}`
        );
      }

      documentTypes.push(validatedDocumentType);
    }

    return documentTypes;
  }
}

