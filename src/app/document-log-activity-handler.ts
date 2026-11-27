import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Activity } from '../features/document/domain';
import {
  findPrimaryFiledFile,
  type ActivityExecutionContext,
  type ActivityHandler,
  type ActivityOutput,
} from '../features/document/ports';
import {
  LogFilterBySchema,
  type DocumentLogDocument,
  type DocumentLogPort,
  type DocumentLogSpace,
} from '../features/document-log';

export const WriteLogPayloadSchema = Type.Object(
  {
    fileSourceStepId: Type.Optional(
      Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])
    ),
  },
  { additionalProperties: false }
);
export type WriteLogPayload = Static<typeof WriteLogPayloadSchema>;

export const ReadLogPayloadSchema = Type.Object(
  {
    filterBy: Type.Optional(Type.Union([LogFilterBySchema, Type.Undefined()])),
    values: Type.Optional(
      Type.Union([Type.String(), Type.Array(Type.String()), Type.Undefined()])
    ),
    outputVariable: Type.Optional(
      Type.Union([Type.String({ minLength: 1 }), Type.Undefined()])
    ),
  },
  { additionalProperties: false }
);
export type ReadLogPayload = Static<typeof ReadLogPayloadSchema>;

const RESERVED_READ_OUTPUT_VARIABLES = new Set(['documentLogRead', 'documentLogWrite']);
const DEFAULT_READ_OUTPUT_VARIABLE = 'logEntries';

export interface DocumentLogActivityHandlerOptions {
  selectedLogId?: string | undefined;
  onWriteLogSuccess?: ((spaceId?: string) => void) | undefined;
}

function toDocumentLogSpace(
  space: ActivityExecutionContext['document']['space']
): DocumentLogSpace | undefined {
  if (!space) {
    return undefined;
  }
  return {
    id: space.id,
    typeId: space.typeId,
    name: space.name,
    abstractStorageId: space.abstractStorageId,
  };
}

function toDocumentLogDocument(doc: ActivityExecutionContext['document']): DocumentLogDocument {
  const space = toDocumentLogSpace(doc.space);
  return {
    ...(doc.id !== undefined ? { id: doc.id } : {}),
    ...(doc.idDocument !== undefined ? { idDocument: doc.idDocument } : {}),
    ...(doc.idGroup !== undefined ? { idGroup: doc.idGroup } : {}),
    type: doc.type,
    data: doc.data,
    ...(doc.calculated !== undefined ? { calculated: doc.calculated } : {}),
    ...(space !== undefined ? { space } : {}),
  };
}

/**
 * ActivityHandler bridging `WRITE_LOG` and `READ_LOG` workflow steps from `ActivityEngine` to `DocumentLogPort`.
 */
export class DocumentLogActivityHandler implements ActivityHandler {
  constructor(
    private readonly documentLogService: DocumentLogPort,
    private readonly options?: DocumentLogActivityHandlerOptions
  ) {}

  canHandle(activity: Activity): boolean {
    return activity.type === 'WRITE_LOG' || activity.type === 'READ_LOG';
  }

  async handle(
    activity: Activity,
    context?: ActivityExecutionContext
  ): Promise<ActivityOutput> {
    if (activity.type === 'READ_LOG') {
      return this.handleReadLog(activity, context);
    }
    if (activity.type === 'WRITE_LOG') {
      return this.handleWriteLog(activity, context);
    }
    return {
      success: false,
      error: `DocumentLogActivityHandler cannot handle activity type "${activity.type}".`,
    };
  }

  private async handleWriteLog(
    activity: Activity,
    context?: ActivityExecutionContext
  ): Promise<ActivityOutput> {
    const rawPayload = activity.payload ?? {};
    if (!Value.Check(WriteLogPayloadSchema, rawPayload)) {
      const details = [...Value.Errors(WriteLogPayloadSchema, rawPayload)]
        .map((e) => `${e.path}: ${e.message}`)
        .join(', ');
      return {
        success: false,
        error: `Invalid WRITE_LOG payload: ${details}`,
      };
    }

    const payload = rawPayload as WriteLogPayload;
    if (
      payload.fileSourceStepId !== undefined &&
      payload.fileSourceStepId.trim().length === 0
    ) {
      return {
        success: false,
        error: 'Invalid WRITE_LOG payload: fileSourceStepId must be a non-empty string.',
      };
    }

    if (!context || !context.document) {
      return {
        success: false,
        error: 'WRITE_LOG requires an ActivityExecutionContext with document.',
      };
    }

    let fileUri: string | undefined;
    if (payload.fileSourceStepId !== undefined) {
      const stepOutput = context.stepOutputs[payload.fileSourceStepId];
      if (stepOutput === undefined) {
        return {
          success: false,
          error: `WRITE_LOG fileSourceStepId "${payload.fileSourceStepId}" references an unexecuted step.`,
        };
      }
      fileUri = findPrimaryFiledFile(stepOutput.files)?.uri;
    } else {
      fileUri = findPrimaryFiledFile(context.files)?.uri;
    }

    try {
      const result = await this.documentLogService.writeLog({
        document: toDocumentLogDocument(context.document),
        ...(fileUri !== undefined ? { fileUri } : {}),
        ...(this.options?.selectedLogId !== undefined
          ? { selectedLogId: this.options.selectedLogId }
          : {}),
      });

      this.options?.onWriteLogSuccess?.(
        context.document.space?.abstractStorageId ?? context.document.space?.id
      );

      return {
        success: true,
        contextVariables: {
          documentLogWrite: {
            spreadsheetId: result.spreadsheetId,
            sheetName: result.sheetName,
            ...(result.sheetId !== undefined ? { sheetId: result.sheetId } : {}),
            rowNumber: result.rowNumber,
            action: result.action,
            ...(result.uri !== undefined ? { uri: result.uri } : {}),
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async handleReadLog(
    activity: Activity,
    context?: ActivityExecutionContext
  ): Promise<ActivityOutput> {
    const rawPayload = activity.payload ?? {};
    if (!Value.Check(ReadLogPayloadSchema, rawPayload)) {
      const details = [...Value.Errors(ReadLogPayloadSchema, rawPayload)]
        .map((e) => `${e.path}: ${e.message}`)
        .join(', ');
      return {
        success: false,
        error: `Invalid READ_LOG payload: ${details}`,
      };
    }

    const payload = rawPayload as ReadLogPayload;
    if ((payload.filterBy !== undefined) !== (payload.values !== undefined)) {
      return {
        success: false,
        error:
          'Invalid READ_LOG payload: filterBy and values must either both be provided or both be omitted.',
      };
    }

    const outputVar =
      payload.outputVariable !== undefined
        ? payload.outputVariable.trim()
        : DEFAULT_READ_OUTPUT_VARIABLE;

    if (outputVar.length === 0) {
      return {
        success: false,
        error: 'Invalid READ_LOG payload: outputVariable must be a non-empty string.',
      };
    }
    if (RESERVED_READ_OUTPUT_VARIABLES.has(outputVar)) {
      return {
        success: false,
        error: `Invalid READ_LOG payload: outputVariable "${outputVar}" is reserved.`,
      };
    }

    if (!context || !context.document) {
      return {
        success: false,
        error: 'READ_LOG requires an ActivityExecutionContext with document.',
      };
    }

    const space = toDocumentLogSpace(context.document.space);

    try {
      const result = await this.documentLogService.readLog({
        documentTypeKey: context.document.type,
        ...(space !== undefined ? { space } : {}),
        ...(this.options?.selectedLogId !== undefined
          ? { selectedLogId: this.options.selectedLogId }
          : {}),
        ...(payload.filterBy !== undefined ? { filterBy: payload.filterBy } : {}),
        ...(payload.values !== undefined ? { values: payload.values } : {}),
      });

      return {
        success: true,
        contextVariables: {
          [outputVar]: result.entries,
          [`${outputVar}Warnings`]: result.warnings,
          documentLogRead: {
            spreadsheetId: result.spreadsheetId,
            sheetName: result.sheetName,
            entryCount: result.entries.length,
            warningCount: result.warnings.length,
          },
        },
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
