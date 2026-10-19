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

export const WorkspaceGmailEventType = Type.Object({
  messageId: Type.Optional(Type.String()),
  threadId: Type.Optional(Type.String()),
  accessToken: Type.Optional(Type.String()),
});

export type WorkspaceGmailEvent = Static<typeof WorkspaceGmailEventType>;

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
  gmail: Type.Optional(WorkspaceGmailEventType),
  hostApp: Type.Optional(Type.String()),
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

export const AppBaseUrlEnvSchema = Type.Optional(Type.String({ minLength: 1 }));

export const WorkspaceRequestHeadersSchema = Type.Record(
  Type.String(),
  Type.Union([Type.String(), Type.Array(Type.String()), Type.Undefined()])
);

export type WorkspaceRequestHeaders = Static<typeof WorkspaceRequestHeadersSchema>;

export interface WorkspaceExecutionContext {
  userOAuthToken?: string | undefined;
  userEmail?: string | undefined;
  hostApp?: string | undefined;
  gmail?: {
    messageId?: string | undefined;
    threadId?: string | undefined;
    accessToken?: string | undefined;
  } | undefined;
  platform?: string | undefined;
  traceId?: string | undefined;
  baseUrl?: string | undefined;
  selectedItems?: WorkspaceDriveSelectedItem[] | undefined;
  sourceFiles?: Array<{
    id: string;
    name?: string | undefined;
    mimeType?: string | undefined;
    content?: Uint8Array | undefined;
  }> | undefined;
  validationErrors?: string[] | undefined;
  formData?: Record<string, unknown> | undefined;
  actionName?: string | undefined;
  parameters?: Record<string, string> | undefined;
  rawEvent?: unknown;
}

function getHeader(
  headers: Record<string, string | string[] | undefined>,
  name: string
): string | undefined {
  const val = headers[name.toLowerCase()];
  const normalized = Array.isArray(val) ? val[0] : val;
  return typeof normalized === 'string' ? normalized.split(',')[0]?.trim() : undefined;
}

export function extractBaseUrl(
  headers?: Record<string, string | string[] | undefined>,
  appBaseUrl?: string
): string | undefined {
  if (headers) {
    const proto = getHeader(headers, 'x-forwarded-proto');
    const forwardedHost = getHeader(headers, 'x-forwarded-host');
    const host = forwardedHost ?? getHeader(headers, 'host');

    if (proto && host) {
      return `${proto}://${host}`;
    }
    if (host) {
      const defaultProto =
        host.startsWith('localhost') || host.startsWith('127.0.0.1')
          ? 'http'
          : 'https';
      return `${defaultProto}://${host}`;
    }
  }

  if (
    Value.Check(AppBaseUrlEnvSchema, appBaseUrl) &&
    appBaseUrl !== undefined &&
    appBaseUrl.trim() !== ''
  ) {
    return appBaseUrl.trim().replace(/\/+$/, '');
  }

  return undefined;
}

export function extractWorkspaceExecutionContext(
  payload: unknown,
  traceId?: string,
  rawHeaders?: unknown,
  appBaseUrl?: string
): WorkspaceExecutionContext {
  const event: Partial<WorkspaceEventPayload> =
    Value.Check(WorkspaceEventPayloadType, payload) ? payload : {};

  const headers: Record<string, string | string[] | undefined> =
    Value.Check(WorkspaceRequestHeadersSchema, rawHeaders) ? rawHeaders : {};

  const userOAuthToken =
    event.authorizationEventObject?.userOAuthToken ??
    event.userOAuthToken ??
    event.gmail?.accessToken;

  let validationErrors: string[] | undefined;
  // nosemgrep: domain-pass-through-read
  const rawValidationErrors = event.commonEventObject?.parameters?.validationErrors as string | undefined;
  if (typeof rawValidationErrors === 'string') {
    try {
      const parsed = JSON.parse(rawValidationErrors);
      if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
        validationErrors = parsed;
      }
    } catch {
      validationErrors = [rawValidationErrors];
    }
  }

  let formData: Record<string, unknown> | undefined;
  if (event.commonEventObject?.formInputs) {
    formData = {};
    for (const [key, val] of Object.entries(event.commonEventObject.formInputs)) {
      if (val && typeof val === 'object' && 'stringInputs' in val) {
        const stringInputs = (val as { stringInputs?: { value?: unknown[] } })['stringInputs'];
        const values = stringInputs?.value;
        if (Array.isArray(values) && values.length > 1) {
          formData[key] = values;
        } else {
          formData[key] = values?.[0] ?? '';
        }
      } else {
        formData[key] = val;
      }
    }
  }

  const actionName =
    event.commonEventObject?.parameters?.action ??
    (payload && typeof payload === 'object' && 'commonEventObject' in payload
      ? (payload as { commonEventObject?: { invokedFunction?: string } }).commonEventObject?.invokedFunction
      : undefined);

  return {
    userOAuthToken: typeof userOAuthToken === 'string' ? userOAuthToken : undefined,
    userEmail: typeof event.userEmail === 'string' ? event.userEmail : undefined,
    hostApp: event.commonEventObject?.hostApp ?? event.hostApp,
    gmail: event.gmail
      ? {
          messageId: event.gmail.messageId,
          threadId: event.gmail.threadId,
          accessToken: event.gmail.accessToken,
        }
      : undefined,
    platform: event.commonEventObject?.platform,
    traceId,
    baseUrl: extractBaseUrl(headers, appBaseUrl),
    selectedItems: event.drive?.selectedItems,
    validationErrors,
    formData,
    actionName,
    parameters: event.commonEventObject?.parameters,
    rawEvent: payload,
  };
}

