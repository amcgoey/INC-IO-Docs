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

export interface WorkspaceExecutionResult {
  fileId?: string | undefined;
  fileName: string;
  destinationFolder: string;
}

export interface WorkspaceExecutionContext {
  userOAuthToken?: string | undefined;
  userEmail?: string | undefined;
  hostApp?: string | undefined;
  platform?: string | undefined;
  traceId?: string | undefined;
  selectedItems?: WorkspaceDriveSelectedItem[] | undefined;
  rawEvent?: unknown;
  lastExecutionResult?: WorkspaceExecutionResult | undefined;
}

export function extractWorkspaceExecutionContext(
  payload: unknown,
  traceId?: string
): WorkspaceExecutionContext {
  let event: Partial<WorkspaceEventPayload> = {};
  if (Value.Check(WorkspaceEventPayloadType, payload)) {
    event = payload;
  } else if (payload && typeof payload === 'object') {
    event = payload as Partial<WorkspaceEventPayload>;
  }

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
