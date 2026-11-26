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
  DocumentContentInsertPosition,
  DocumentContentUnmodifiableTargetReason,
  DocumentContentUnmodifiableTargetStrategy,
  DocumentSchemaRegistryPort,
  TemplateEvaluatorPort,
  TemplateRegistryPort,
} from '../ports';
import { REDACTED_TEMPLATE_ID_PLACEHOLDER } from './env-template-registry.adapter';

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

const InsertPagesOnUnmodifiableTargetSchema = Type.Union([
  Type.Object({ strategy: Type.Literal('error') }, { additionalProperties: false }),
  Type.Object(
    {
      strategy: Type.Literal('createSiblingPdf'),
      fileName: Type.String({ minLength: 1 }),
    },
    { additionalProperties: false }
  ),
]);

const InsertPagesPayloadSchema = Type.Object(
  {
    fileSourceStepId: Type.Optional(
      Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])
    ),
    templateKey: Type.Optional(
      Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])
    ),
    sourceStepId: Type.Optional(
      Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])
    ),
    position: Type.Optional(
      Type.Union([
        Type.Literal('start'),
        Type.Literal('end'),
        Type.Integer({ minimum: 0 }),
        Type.Undefined(),
      ])
    ),
    sourcePages: Type.Optional(
      Type.Union([
        Type.Array(Type.Integer({ minimum: 1 }), { minItems: 1 }),
        Type.Undefined(),
      ])
    ),
    fillForm: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
    onUnmodifiableTarget: Type.Optional(
      Type.Union([InsertPagesOnUnmodifiableTargetSchema, Type.Undefined()])
    ),
  },
  { additionalProperties: true }
);
type InsertPagesPayload = Static<typeof InsertPagesPayloadSchema>;

export interface DocumentContentActivityHandlerDeps {
  contentEditor: DocumentContentEditorPort;
  documentSchemaRegistry: DocumentSchemaRegistryPort;
  templateEvaluator: TemplateEvaluatorPort;
  templateRegistry?: TemplateRegistryPort | undefined;
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

function toSiblingFileLocator(
  sibling: FileLocator,
  originalTarget: FileLocator
): FileLocator {
  const parentId = sibling.parentId ?? originalTarget.parentId;
  const parentName = sibling.parentName ?? originalTarget.parentName;
  const mimeType = sibling.mimeType ?? 'application/pdf';
  return {
    id: sibling.id,
    name: sibling.name,
    ...(parentId !== undefined ? { parentId } : {}),
    ...(parentName !== undefined ? { parentName } : {}),
    mimeType,
    ...(sibling.uri !== undefined ? { uri: sibling.uri } : {}),
  };
}

const UNMODIFIABLE_REASON_PHRASES: Readonly<Record<DocumentContentUnmodifiableTargetReason, string>> = {
  non_pdf: 'it is not a PDF',
  encrypted: 'it is password-protected/encrypted',
  pure_xfa: 'it uses pure XFA form data',
  signed: 'it is cryptographically signed',
  oversized: 'it exceeds the in-memory file size limit',
};

function formatSiblingFallbackNotice(
  targetFile: FileLocator,
  siblingFile: FileLocator,
  reason?: DocumentContentUnmodifiableTargetReason
): string {
  const targetLabel = targetFile.name || targetFile.id;
  const reasonPhrase = reason
    ? UNMODIFIABLE_REASON_PHRASES[reason]
    : 'the target file could not be modified';
  return `Cover sheet could not be inserted into "${targetLabel}" because ${reasonPhrase}. Created sibling Transmittal PDF "${siblingFile.name}".`;
}

/**
 * ActivityHandler orchestrating content-editing activities (`INSERT_DATA`, `INSERT_PAGES`)
 * by resolving templates, evaluating writable `DocumentFormSchema` fields, and delegating
 * to `DocumentContentEditorPort`.
 */
export class DocumentContentActivityHandler implements ActivityHandler {
  private cachedDocumentTypesPromise: Promise<DocumentType[]> | undefined;

  constructor(private readonly deps: DocumentContentActivityHandlerDeps) {}

  canHandle(activity: Activity): boolean {
    return activity.type === 'INSERT_DATA' || activity.type === 'INSERT_PAGES';
  }

  private redactErrorMessage(message: string, secretId?: string): string {
    let redacted = message;
    if (secretId && redacted.includes(secretId)) {
      redacted = redacted.split(secretId).join(REDACTED_TEMPLATE_ID_PLACEHOLDER);
    }
    if (this.deps.templateRegistry?.redactSecrets) {
      redacted = this.deps.templateRegistry.redactSecrets(redacted);
    }
    return redacted;
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
    activityType: 'INSERT_DATA' | 'INSERT_PAGES',
    fileSourceStepId: string | undefined,
    context: ActivityExecutionContext
  ): FileLocator[] {
    if (fileSourceStepId !== undefined) {
      const stepId = fileSourceStepId.trim();
      if (stepId.length === 0) {
        throw new Error(`${activityType} payload.fileSourceStepId must be a non-empty string.`);
      }
      const stepOutput = context.stepOutputs[stepId];
      if (stepOutput === undefined) {
        throw new Error(
          `${activityType} fileSourceStepId "${stepId}" references an unexecuted step.`
        );
      }
      const stepFiles = stepOutput.files ?? [];
      if (stepFiles.length === 0) {
        throw new Error(
          `${activityType} fileSourceStepId "${stepId}" resolved zero files.`
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
      `${activityType} requires at least one target file from fileSourceStepId or execution context.`
    );
  }

  async handle(
    activity: Activity,
    context?: ActivityExecutionContext
  ): Promise<ActivityOutput> {
    if (activity.type === 'INSERT_DATA') {
      return this.handleInsertData(activity, context);
    }
    if (activity.type === 'INSERT_PAGES') {
      return this.handleInsertPages(activity, context);
    }
    return {
      success: false,
      error: `DocumentContentActivityHandler cannot handle activity type "${activity.type}".`,
    };
  }

  private async handleInsertData(
    activity: Activity,
    context?: ActivityExecutionContext
  ): Promise<ActivityOutput> {
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

      targetFiles = this.resolveTargetFiles('INSERT_DATA', payload.fileSourceStepId, context);

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

  private async handleInsertPages(
    activity: Activity,
    context?: ActivityExecutionContext
  ): Promise<ActivityOutput> {
    if (!context || !context.document) {
      return {
        success: false,
        error: 'INSERT_PAGES requires an ActivityExecutionContext with document.',
      };
    }

    const rawPayload = activity.payload ?? {};
    if (!Value.Check(InsertPagesPayloadSchema, rawPayload)) {
      const details = [...Value.Errors(InsertPagesPayloadSchema, rawPayload)]
        .map((e) => `${e.path}: ${e.message}`)
        .join(', ');
      return {
        success: false,
        error: `Invalid INSERT_PAGES payload: ${details}`,
      };
    }
    const payload = rawPayload as InsertPagesPayload;

    if (payload.templateKey !== undefined && payload.sourceStepId !== undefined) {
      return {
        success: false,
        error: 'INSERT_PAGES payload cannot specify both templateKey and sourceStepId.',
      };
    }
    if (payload.templateKey === undefined && payload.sourceStepId === undefined) {
      return {
        success: false,
        error: 'INSERT_PAGES payload must specify either templateKey or sourceStepId.',
      };
    }
    if (payload.sourcePages !== undefined) {
      const seenPages = new Set<number>();
      for (const page of payload.sourcePages) {
        if (seenPages.has(page)) {
          return {
            success: false,
            error: `Invalid INSERT_PAGES payload: duplicate page number ${page} in sourcePages.`,
          };
        }
        seenPages.add(page);
      }
    }
    if (
      payload.onUnmodifiableTarget?.strategy === 'createSiblingPdf' &&
      payload.onUnmodifiableTarget.fileName.trim().length === 0
    ) {
      return {
        success: false,
        error: 'Invalid INSERT_PAGES payload: onUnmodifiableTarget.fileName must be a non-empty string.',
      };
    }

    let targetFiles: FileLocator[];
    let sourceFileId: string;
    let sourceMimeType: string | undefined;
    let sourceIsTemplate: boolean;
    let formDataToWrite: Record<string, string> | undefined;

    try {
      const documentType = await this.getDocumentType(context.document.type);
      if (!documentType) {
        return {
          success: false,
          error: `Unknown DocumentType "${context.document.type}" for INSERT_PAGES.`,
        };
      }

      targetFiles = this.resolveTargetFiles('INSERT_PAGES', payload.fileSourceStepId, context);

      if (payload.templateKey !== undefined) {
        if (!this.deps.templateRegistry) {
          throw new Error(
            `INSERT_PAGES templateKey "${payload.templateKey}" requires TemplateRegistryPort to be configured.`
          );
        }
        const resolvedTemplate = await this.deps.templateRegistry.resolveTemplate(
          payload.templateKey
        );
        sourceFileId = resolvedTemplate.fileId;
        sourceIsTemplate = true;
      } else {
        const srcStepId = payload.sourceStepId!.trim();
        if (srcStepId.length === 0) {
          throw new Error('INSERT_PAGES payload.sourceStepId must be a non-empty string.');
        }
        const srcStepOutput = context.stepOutputs[srcStepId];
        if (srcStepOutput === undefined) {
          throw new Error(
            `INSERT_PAGES sourceStepId "${srcStepId}" references an unexecuted step.`
          );
        }
        const srcFiles = srcStepOutput.files ?? [];
        if (srcFiles.length === 0) {
          throw new Error(
            `INSERT_PAGES sourceStepId "${srcStepId}" resolved zero files.`
          );
        }
        if (srcFiles.length > 1) {
          throw new Error(
            `INSERT_PAGES sourceStepId "${srcStepId}" resolved ${srcFiles.length} files; expected a single source file.`
          );
        }
        sourceFileId = srcFiles[0]!.id;
        sourceMimeType = srcFiles[0]!.mimeType;
        sourceIsTemplate = false;
      }

      if (payload.fillForm === true) {
        const evaluated = evaluateWritableDocumentFormFields({
          documentFormSchema: documentType.documentFormSchema,
          documentSchema: documentType.documentSchema,
          data: context.document.data,
          templateEvaluator: this.deps.templateEvaluator,
        });
        if (hasNonEmptyWritableFormData(evaluated)) {
          formDataToWrite = evaluated;
        }
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return {
        success: false,
        error: this.redactErrorMessage(msg),
      };
    }

    const updatedFiles: FileLocator[] = [];
    const notices: string[] = [];
    for (const targetFile of targetFiles) {
      try {
        const onUnmodifiableTarget: DocumentContentUnmodifiableTargetStrategy | undefined =
          payload.onUnmodifiableTarget?.strategy === 'createSiblingPdf'
            ? {
                strategy: 'createSiblingPdf',
                fileName: payload.onUnmodifiableTarget.fileName.trim(),
                ...(targetFile.parentId !== undefined
                  ? { targetFolderId: targetFile.parentId }
                  : {}),
              }
            : payload.onUnmodifiableTarget;

        const result = await this.deps.contentEditor.insertPages({
          targetFileId: targetFile.id,
          ...(targetFile.mimeType !== undefined ? { targetMimeType: targetFile.mimeType } : {}),
          ...(targetFile.name ? { targetFileName: targetFile.name } : {}),
          ...(onUnmodifiableTarget !== undefined && targetFile.parentId !== undefined
            ? { targetFolderId: targetFile.parentId }
            : {}),
          sourceFileId,
          ...(sourceMimeType !== undefined ? { sourceMimeType } : {}),
          sourceIsTemplate,
          ...(payload.position !== undefined
            ? { position: payload.position as DocumentContentInsertPosition }
            : {}),
          ...(payload.sourcePages !== undefined ? { sourcePages: payload.sourcePages } : {}),
          ...(formDataToWrite !== undefined ? { formData: formDataToWrite } : {}),
          ...(onUnmodifiableTarget !== undefined ? { onUnmodifiableTarget } : {}),
        });
        if (result.fallbackUsed) {
          const siblingLocator = toSiblingFileLocator(result.file, targetFile);
          updatedFiles.push(siblingLocator);
          const rawNotice = formatSiblingFallbackNotice(
            targetFile,
            siblingLocator,
            result.unmodifiableReason
          );
          notices.push(
            this.redactErrorMessage(rawNotice, sourceIsTemplate ? sourceFileId : undefined)
          );
        } else {
          updatedFiles.push(mergeFileLocatorMetadata(result.file, targetFile));
        }
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        return {
          success: false,
          error: this.redactErrorMessage(msg, sourceIsTemplate ? sourceFileId : undefined),
          ...(updatedFiles.length > 0 ? { files: updatedFiles } : {}),
          ...(notices.length > 0 ? { contextVariables: { notices } } : {}),
        };
      }
    }

    return {
      success: true,
      files: updatedFiles,
      ...(notices.length > 0 ? { contextVariables: { notices } } : {}),
    };
  }
}
