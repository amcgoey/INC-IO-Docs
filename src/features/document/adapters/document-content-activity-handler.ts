import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  evaluateWritableDocumentFormFields,
  hasNonEmptyWritableFormData,
  type Activity,
  type ActivityExecutionContext,
  type ActivityOutput,
  type DocumentType,
  type FileLocator,
} from '../domain';
import type {
  ActivityHandler,
  DocumentContentEditorPort,
  DocumentSchemaRegistryPort,
  TemplateEvaluatorPort,
} from '../ports';

const InsertDataPayloadSchema = Type.Object(
  {
    fileSourceStepId: Type.Optional(
      Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])
    ),
    fields: Type.Optional(
      Type.Union([Type.Array(Type.String({ minLength: 1 })), Type.Undefined()])
    ),
  },
  { additionalProperties: true }
);
type InsertDataPayload = Static<typeof InsertDataPayloadSchema>;

export interface DocumentContentActivityHandlerDeps {
  contentEditor: DocumentContentEditorPort;
  documentSchemaRegistry: DocumentSchemaRegistryPort;
  templateEvaluator: TemplateEvaluatorPort;
}

function mergeFileLocatorMetadata(
  updated: FileLocator,
  original: FileLocator
): FileLocator {
  const name = updated.name || original.name;
  const parentId = updated.parentId ?? original.parentId;
  const parentName = updated.parentName ?? original.parentName;
  const mimeType = updated.mimeType ?? original.mimeType;
  const uri = updated.uri ?? original.uri;
  return {
    id: updated.id,
    name,
    ...(parentId !== undefined ? { parentId } : {}),
    ...(parentName !== undefined ? { parentName } : {}),
    ...(mimeType !== undefined ? { mimeType } : {}),
    ...(uri !== undefined ? { uri } : {}),
  };
}

/**
 * ActivityHandler orchestrating content-editing activities (`INSERT_DATA`) by evaluating
 * writable `DocumentFormSchema` fields and delegating to `DocumentContentEditorPort`.
 */
export class DocumentContentActivityHandler implements ActivityHandler {
  private cachedDocumentTypesPromise: Promise<DocumentType[]> | undefined;

  constructor(private readonly deps: DocumentContentActivityHandlerDeps) {}

  canHandle(activity: Activity): boolean {
    return activity.type === 'INSERT_DATA';
  }

  private async getDocumentType(documentTypeKey: string): Promise<DocumentType | undefined> {
    if (!this.cachedDocumentTypesPromise) {
      this.cachedDocumentTypesPromise = this.deps.documentSchemaRegistry
        .loadAll()
        .catch((err) => {
          this.cachedDocumentTypesPromise = undefined;
          throw err;
        });
    }
    const documentTypes = await this.cachedDocumentTypesPromise;
    return documentTypes.find((dt) => dt.key === documentTypeKey);
  }

  private resolveTargetFiles(
    payload: InsertDataPayload,
    context: ActivityExecutionContext
  ): FileLocator[] {
    if (payload.fileSourceStepId !== undefined) {
      const stepId = payload.fileSourceStepId.trim();
      if (stepId.length === 0) {
        throw new Error('INSERT_DATA payload.fileSourceStepId must be a non-empty string.');
      }
      const stepOutput = context.stepOutputs[stepId];
      if (stepOutput === undefined) {
        throw new Error(
          `INSERT_DATA fileSourceStepId "${stepId}" references an unexecuted step.`
        );
      }
      const stepFiles = stepOutput.files ?? [];
      if (stepFiles.length === 0) {
        throw new Error(
          `INSERT_DATA fileSourceStepId "${stepId}" resolved zero files.`
        );
      }
      return [...stepFiles];
    }

    if (context.files.length > 0) {
      return [...context.files];
    }

    if (context.document.sourceFiles !== undefined && context.document.sourceFiles.length > 0) {
      return context.document.sourceFiles.map((file) => ({
        id: file.id,
        name: file.name ?? '',
        ...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
      }));
    }

    throw new Error(
      'INSERT_DATA requires at least one target file from fileSourceStepId or execution context.'
    );
  }

  async handle(
    activity: Activity,
    context?: ActivityExecutionContext
  ): Promise<ActivityOutput> {
    if (activity.type !== 'INSERT_DATA') {
      return {
        success: false,
        error: `DocumentContentActivityHandler cannot handle activity type "${activity.type}".`,
      };
    }

    if (!context || !context.document) {
      return {
        success: false,
        error: 'INSERT_DATA requires an ActivityExecutionContext with document.',
      };
    }

    const rawPayload = activity.payload ?? {};
    if (!Value.Check(InsertDataPayloadSchema, rawPayload)) {
      const details = [...Value.Errors(InsertDataPayloadSchema, rawPayload)]
        .map((e) => `${e.path}: ${e.message}`)
        .join(', ');
      return {
        success: false,
        error: `Invalid INSERT_DATA payload: ${details}`,
      };
    }
    const payload = rawPayload as InsertDataPayload;

    let targetFiles: FileLocator[];
    let evaluatedFormData: Record<string, string>;
    try {
      const documentType = await this.getDocumentType(context.document.type);
      if (!documentType) {
        return {
          success: false,
          error: `Unknown DocumentType "${context.document.type}" for INSERT_DATA.`,
        };
      }

      targetFiles = this.resolveTargetFiles(payload, context);

      evaluatedFormData = evaluateWritableDocumentFormFields({
        documentFormSchema: documentType.documentFormSchema,
        documentSchema: documentType.documentSchema,
        data: context.document.data,
        templateEvaluator: this.deps.templateEvaluator,
        ...(payload.fields !== undefined ? { fieldsAllowlist: payload.fields } : {}),
      });
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }

    if (!hasNonEmptyWritableFormData(evaluatedFormData)) {
      return {
        success: true,
        files: targetFiles,
      };
    }

    const updatedFiles: FileLocator[] = [];
    for (const targetFile of targetFiles) {
      try {
        const result = await this.deps.contentEditor.insertData({
          targetFileId: targetFile.id,
          ...(targetFile.mimeType !== undefined ? { targetMimeType: targetFile.mimeType } : {}),
          ...(targetFile.name ? { targetFileName: targetFile.name } : {}),
          formData: evaluatedFormData,
        });
        updatedFiles.push(mergeFileLocatorMetadata(result.file, targetFile));
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error),
          ...(updatedFiles.length > 0 ? { files: updatedFiles } : {}),
        };
      }
    }

    return {
      success: true,
      files: updatedFiles,
    };
  }
}
