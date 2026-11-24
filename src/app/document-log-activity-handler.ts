import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { Activity } from '../features/document/domain';
import type {
  ActivityExecutionContext,
  ActivityHandler,
  ActivityOutput,
} from '../features/document/ports';
import type {
  DocumentLogDocument,
  DocumentLogPort,
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

export interface DocumentLogActivityHandlerOptions {
  selectedLogId?: string | undefined;
}

function toDocumentLogDocument(doc: ActivityExecutionContext['document']): DocumentLogDocument {
  return {
    ...(doc.id !== undefined ? { id: doc.id } : {}),
    ...(doc.idDocument !== undefined ? { idDocument: doc.idDocument } : {}),
    ...(doc.idGroup !== undefined ? { idGroup: doc.idGroup } : {}),
    type: doc.type,
    data: doc.data,
    ...(doc.calculated !== undefined ? { calculated: doc.calculated } : {}),
    ...(doc.space !== undefined
      ? {
          space: {
            id: doc.space.id,
            typeId: doc.space.typeId,
            name: doc.space.name,
            abstractStorageId: doc.space.abstractStorageId,
          },
        }
      : {}),
  };
}

/**
 * ActivityHandler bridging `WRITE_LOG` workflow steps from `ActivityEngine` to `DocumentLogPort`.
 */
export class DocumentLogActivityHandler implements ActivityHandler {
  constructor(
    private readonly documentLogService: DocumentLogPort,
    private readonly options?: DocumentLogActivityHandlerOptions
  ) {}

  canHandle(activity: Activity): boolean {
    return activity.type === 'WRITE_LOG';
  }

  async handle(
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
      fileUri = stepOutput.files?.[0]?.uri;
    } else {
      fileUri = context.files[0]?.uri;
    }

    try {
      const result = await this.documentLogService.writeLog({
        document: toDocumentLogDocument(context.document),
        ...(fileUri !== undefined ? { fileUri } : {}),
        ...(this.options?.selectedLogId !== undefined
          ? { selectedLogId: this.options.selectedLogId }
          : {}),
      });

      return {
        success: true,
        contextVariables: {
          documentLogWrite: {
            spreadsheetId: result.spreadsheetId,
            sheetName: result.sheetName,
            rowNumber: result.rowNumber,
            action: result.action,
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
