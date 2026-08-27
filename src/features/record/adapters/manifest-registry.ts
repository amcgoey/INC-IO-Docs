import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import { RecordTypeSchema, SystemContextSchema, formatValidationErrors, type RecordType } from '../domain';
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
  defaultRecordType: Type.Optional(Type.String()),
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
  recordTypes: Type.Array(Type.String()),
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
    const manifestContent = await fs.readFile(this.manifestPath, 'utf-8');
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
      await this.loadManifest();
    }
    return this.cachedConfiguration?.drive;
  }

  async getWorkspaceConfig(): Promise<WorkspaceConfiguration | undefined> {
    if (!this.isManifestLoaded) {
      await this.loadManifest();
    }
    return this.cachedConfiguration?.workspace;
  }

  private validateTemplate(
    template: string,
    allowedVariables: string[],
    recordTypeRelPath: string,
    errorPrefix: string,
    targetDescription: string
  ): void {
    const isValid = this.templateEvaluator.validate(template, allowedVariables);
    if (!isValid) {
      throw new Error(
        `Invalid ${errorPrefix} in "${recordTypeRelPath}" for ${targetDescription}: template "${template}" references unknown fields or is malformed.`
      );
    }
  }

  async loadAll(): Promise<RecordType[]> {
    const validatedManifest = await this.loadManifest();
    const manifestDir = path.dirname(this.manifestPath);
    const recordTypes: RecordType[] = [];


    for (const recordTypeRelPath of validatedManifest.recordTypes) {
      const resolvedPath = path.resolve(manifestDir, recordTypeRelPath);
      const fileContent = await fs.readFile(resolvedPath, 'utf-8');

      const rawRecordType = parseJson(
        fileContent,
        `RecordType file "${recordTypeRelPath}" at "${resolvedPath}"`
      );

      const validatedRecordType = validateAndCleanSchema(
        RecordTypeSchema,
        rawRecordType,
        `Invalid RecordType schema in "${recordTypeRelPath}" at "${resolvedPath}"`
      );

      const allowedVariables: string[] = [
        ...Object.keys(SystemContextSchema.properties),
      ];

      for (const field of validatedRecordType.recordSchema.fields) {
        allowedVariables.push(field.key);
        if (field.options) {
          allowedVariables.push(`${field.key}.${field.options.key}`);
          allowedVariables.push(`${field.key}.${field.options.name}`);
          const optionTuples = validatedRecordType.recordSchema.options?.[field.options.source] ?? [];
          for (const tuple of optionTuples) {
            for (const tupleKey of Object.keys(tuple)) {
              allowedVariables.push(`${field.key}.${tupleKey}`);
            }
          }
        }
      }

      if (validatedRecordType.recordSchema.calculatedFields) {
        for (const calculatedField of validatedRecordType.recordSchema.calculatedFields) {
          this.validateTemplate(
            calculatedField.template,
            allowedVariables,
            recordTypeRelPath,
            'calculated field template',
            `field "${calculatedField.key}"`
          );
        }
      }

      if (validatedRecordType.recordSchema.identity) {
        for (const [propKey, template] of Object.entries(validatedRecordType.recordSchema.identity)) {
          if (typeof template === 'string') {
            this.validateTemplate(
              template,
              allowedVariables,
              recordTypeRelPath,
              'identity template',
              `property "${propKey}"`
            );
          }
        }
      }

      recordTypes.push(validatedRecordType);
    }

    return recordTypes;
  }
}

