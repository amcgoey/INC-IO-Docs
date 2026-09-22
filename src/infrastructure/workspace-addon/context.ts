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


export interface WorkspaceExecutionContext {
  userOAuthToken?: string | undefined;
  userEmail?: string | undefined;
  hostApp?: string | undefined;
  platform?: string | undefined;
  traceId?: string | undefined;
  baseUrl?: string | undefined;
  selectedItems?: WorkspaceDriveSelectedItem[] | undefined;
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
  const target = name.toLowerCase();
  for (const [key, val] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      if (Array.isArray(val)) {
        return val[0]?.split(',')[0]?.trim();
      }
      if (typeof val === 'string') {
        return val.split(',')[0]?.trim();
      }
    }
  }
  return undefined;
}

export function extractBaseUrl(
  headers?: Record<string, string | string[] | undefined>
): string | undefined {
  if (headers) {
    const proto = getHeader(headers, 'x-forwarded-proto');
    const forwardedHost = getHeader(headers, 'x-forwarded-host');
    const rawHost = forwardedHost ?? getHeader(headers, 'host');
    // Ignore synthetic default host 'localhost:80' injected by test runners (light-my-request) when no proxy proto is set
    const host =
      rawHost === 'localhost:80' && !proto && !forwardedHost ? undefined : rawHost;

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

  if (process.env.APP_BASE_URL && process.env.APP_BASE_URL.trim() !== '') {
    return process.env.APP_BASE_URL.trim().replace(/\/+$/, '');
  }

  return undefined;
}

export function extractWorkspaceExecutionContext(
  payload: unknown,
  traceId?: string,
  headers?: Record<string, string | string[] | undefined>
): WorkspaceExecutionContext {
  const event: Partial<WorkspaceEventPayload> =
    Value.Check(WorkspaceEventPayloadType, payload) ? payload : {};

  const userOAuthToken =
    event.authorizationEventObject?.userOAuthToken ?? event.userOAuthToken;

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
        formData[key] = stringInputs?.value?.[0] ?? '';
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
    hostApp: event.commonEventObject?.hostApp,
    platform: event.commonEventObject?.platform,
    traceId,
    baseUrl: extractBaseUrl(headers),
    selectedItems: event.drive?.selectedItems,
    validationErrors,
    formData,
    actionName,
    parameters: event.commonEventObject?.parameters,
    rawEvent: payload,
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
