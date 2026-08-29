import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const WorkspaceDriveSelectedItemType = Type.Object({
  id: Type.String(),
  title: Type.Optional(Type.String()),
  mimeType: Type.Optional(Type.String()),
});

export type WorkspaceDriveSelectedItem = Static<typeof WorkspaceDriveSelectedItemType>;

export const WorkspaceDriveEventType = Type.Object({
  selectedItems: Type.Optional(Type.Array(WorkspaceDriveSelectedItemType)),
  activeCursorItem: Type.Optional(WorkspaceDriveSelectedItemType),
});

export type WorkspaceDriveEvent = Static<typeof WorkspaceDriveEventType>;

export const WorkspaceCommonEventObjectType = Type.Object({
  userLocale: Type.Optional(Type.String()),
  hostApp: Type.Optional(Type.String()),
  platform: Type.Optional(Type.String()),
  parameters: Type.Optional(Type.Record(Type.String(), Type.String())),
  formInputs: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
});

export type WorkspaceCommonEventObject = Static<typeof WorkspaceCommonEventObjectType>;

export const WorkspaceEventPayloadType = Type.Object({
  commonEventObject: Type.Optional(WorkspaceCommonEventObjectType),
  drive: Type.Optional(WorkspaceDriveEventType),
  authorizationEventObject: Type.Optional(
    Type.Object({
      userOAuthToken: Type.Optional(Type.String()),
      systemIdToken: Type.Optional(Type.String()),
      userIdToken: Type.Optional(Type.String()),
    })
  ),
  userOAuthToken: Type.Optional(Type.String()),
  userEmail: Type.Optional(Type.String()),
  userId: Type.Optional(Type.String()),
});

export type WorkspaceEventPayload = Static<typeof WorkspaceEventPayloadType>;

/**
 * WorkspaceRecordExecutionContext represents the execution context contract required when the workspace
 * feature executes records via its driven port (WorkspaceRecordRunnerPort).
 *
 * NOTE ON CODE DUPLICATION:
 * This schema is intentionally defined independently within the `workspace` feature boundary and mirrors
 * `ExecutionContextSchema` in the `record` feature. In accordance with ADR 0001 (Hybrid Hexagonal Architecture)
 * and Hexagonal Architecture boundary rules, feature slices are self-contained and must not import domain
 * models from other feature contexts.
 */
export const WorkspaceRecordExecutionContextSchema = Type.Object({
  credentials: Type.Optional(
    Type.Object({
      oauthToken: Type.Optional(Type.String()),
    })
  ),
  resources: Type.Optional(
    Type.Object({
      primaryTargetId: Type.Optional(Type.String()),
    })
  ),
});

export type WorkspaceRecordExecutionContext = Static<
  typeof WorkspaceRecordExecutionContextSchema
>;

export interface WorkspaceExecutionContext {
  userOAuthToken?: string | undefined;
  userEmail?: string | undefined;
  hostApp?: string | undefined;
  platform?: string | undefined;
  traceId?: string | undefined;
  selectedItems?: WorkspaceDriveSelectedItem[] | undefined;
  rawEvent?: unknown;
}

export function extractWorkspaceExecutionContext(
  payload: unknown,
  traceId?: string
): WorkspaceExecutionContext {
  const event: Partial<WorkspaceEventPayload> =
    Value.Check(WorkspaceEventPayloadType, payload) ? payload : {};

  const userOAuthToken =
    event.authorizationEventObject?.userOAuthToken ?? event.userOAuthToken;

  return {
    userOAuthToken: typeof userOAuthToken === 'string' ? userOAuthToken : undefined,
    userEmail: typeof event.userEmail === 'string' ? event.userEmail : undefined,
    hostApp: event.commonEventObject?.hostApp,
    platform: event.commonEventObject?.platform,
    traceId,
    selectedItems: event.drive?.selectedItems,
    rawEvent: payload,
  };
}

export function createWorkspaceRecordExecutionContext(
  context: WorkspaceExecutionContext
): WorkspaceRecordExecutionContext {
  const selectedItem = context.selectedItems?.[0];
  return {
    ...(context.userOAuthToken ? { credentials: { oauthToken: context.userOAuthToken } } : {}),
    ...(selectedItem?.id ? { resources: { primaryTargetId: selectedItem.id } } : {}),
  };
}

export function findLatestFileLocator<TFile extends { name: string }>(
  outputs?: { files?: TFile[] | undefined }[] | undefined
): TFile | undefined {
  if (!outputs || outputs.length === 0) {
    return undefined;
  }
  for (let i = outputs.length - 1; i >= 0; i--) {
    const output = outputs[i];
    if (output.files && output.files.length > 0) {
      return output.files[output.files.length - 1];
    }
  }
  return undefined;
}
