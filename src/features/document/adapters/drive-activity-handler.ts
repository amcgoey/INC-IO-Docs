import type {
  Activity,
  ActivityExecutionContext,
  ActivityOutput,
  FileLocator,
  SourceFile,
} from '../domain';
import {
  AmbiguousFileError,
  AmbiguousPathSpecError,
  DriveServiceError,
  FileNotFoundError,
  validatePrimaryTargetId,
  type ActivityHandler,
  type AppConfigurationProviderPort,
  type DriveFileResult,
  type DriveFile,
  type DriveSearchQuery,
  type DriveServicePort,
  type SourceFileHydratorPort,
} from '../ports';
import { resolveDriveFolderUri } from './drive-folder-uri';

const GOOGLE_FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

export interface DriveActivityHandlerOptions {
  defaultFolderName?: string | undefined;
  configProvider?: AppConfigurationProviderPort | undefined;
  primaryTargetId?: string | undefined;
  sourceFiles?: SourceFile[] | undefined;
  sourceFileHydrator?: SourceFileHydratorPort | undefined;
  isFileSourceEmailAttachments?: boolean | undefined;
}

const MIME_TYPE_EXTENSION_MAP: Readonly<Record<string, string>> = {
  'application/pdf': '.pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': '.docx',
  'application/msword': '.doc',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': '.xlsx',
  'application/vnd.ms-excel': '.xls',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': '.pptx',
  'application/vnd.ms-powerpoint': '.ppt',
  'text/plain': '.txt',
  'text/csv': '.csv',
  'text/html': '.html',
  'application/rtf': '.rtf',
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/tiff': '.tiff',
  'image/webp': '.webp',
  'image/svg+xml': '.svg',
  'application/zip': '.zip',
  'application/x-zip-compressed': '.zip',
  'application/acad': '.dwg',
  'application/dwg': '.dwg',
  'image/vnd.dwg': '.dwg',
  'application/dxf': '.dxf',
  'image/vnd.dxf': '.dxf',
  'message/rfc822': '.eml',
  'application/json': '.json',
  'application/xml': '.xml',
  'text/xml': '.xml',
};

function extractValidFileExtension(fileName: string | undefined): string | undefined {
  if (typeof fileName !== 'string') {
    return undefined;
  }
  const trimmed = fileName.trim();
  const lastDot = trimmed.lastIndexOf('.');
  if (lastDot <= 0 || lastDot === trimmed.length - 1) {
    return undefined;
  }
  const basePart = trimmed.slice(0, lastDot);
  if (basePart.replace(/\./g, '').trim().length === 0) {
    return undefined;
  }
  const extPart = trimmed.slice(lastDot + 1);
  if (/\s/.test(extPart) || !/^[A-Za-z0-9]{1,15}$/.test(extPart) || !/[A-Za-z]/.test(extPart)) {
    return undefined;
  }
  return `.${extPart}`;
}

function getMimeFallbackExtension(mimeType: string | undefined): string | undefined {
  if (typeof mimeType !== 'string') {
    return undefined;
  }
  const normalized = mimeType.split(';')[0].trim().toLowerCase();
  if (normalized.length === 0 || normalized.startsWith('application/vnd.google-apps.')) {
    return undefined;
  }
  return MIME_TYPE_EXTENSION_MAP[normalized];
}

/**
 * Resolves a renamed target filename while preserving a valid source extension
 * (or falling back to a non-Google-native MIME extension) without doubling extensions.
 */
function resolveExtensionPreservingFileName(
  requestedBaseName: string,
  sourceName: string | undefined,
  mimeType: string | undefined
): string {
  const trimmedTarget = requestedBaseName.trim();
  const resolvedExtension =
    extractValidFileExtension(sourceName) ?? getMimeFallbackExtension(mimeType);
  if (!resolvedExtension) {
    return trimmedTarget;
  }
  if (trimmedTarget.toLowerCase().endsWith(resolvedExtension.toLowerCase())) {
    return trimmedTarget;
  }
  const cleanTarget = trimmedTarget.replace(/\.+$/, '');
  return `${cleanTarget}${resolvedExtension}`;
}

function applyNonDoublingPrefix(fileName: string, prefix: string | undefined): string {
  if (prefix === undefined || prefix.length === 0) {
    return fileName;
  }
  return fileName.startsWith(prefix) ? fileName : `${prefix}${fileName}`;
}

export function parsePathSegments(path: string): string[] {
  if (typeof path !== 'string') {
    throw new DriveServiceError('DriveActivityHandler: Resolved folder path segment must be a non-empty string');
  }
  const cleanPath = path.trim().replace(/^[/\\ ]+|[/\\ ]+$/g, '');
  if (cleanPath.length === 0) {
    throw new DriveServiceError('DriveActivityHandler: Resolved folder path segment must be a non-empty string');
  }
  const segments = cleanPath.split(/[/\\]+/).map((s) => s.trim());
  if (segments.length === 0 || segments.some((s) => s.length === 0)) {
    throw new DriveServiceError('DriveActivityHandler: Resolved folder path segment must be a non-empty string');
  }
  return segments;
}

function isAccessDeniedError(error: unknown): boolean {
  if (typeof error === 'object' && error !== null) {
    const err = error as { statusCode?: unknown; status?: unknown; code?: unknown; message?: unknown };
    if (err.statusCode === 403 || err.status === 403 || err.code === 403) {
      return true;
    }
    if (typeof err.message === 'string' && /403|insufficient permissions|access denied/i.test(err.message)) {
      return true;
    }
  }
  if (typeof error === 'string' && /403|insufficient permissions|access denied/i.test(error)) {
    return true;
  }
  return false;
}

function isFileNotFoundError(error: unknown): boolean {
  if (error instanceof FileNotFoundError) {
    return true;
  }
  if (typeof error === 'object' && error !== null) {
    const err = error as { name?: unknown; message?: unknown; statusCode?: unknown; status?: unknown };
    if (err.name === 'FileNotFoundError' || err.statusCode === 404 || err.status === 404) {
      return true;
    }
    if (typeof err.message === 'string' && (err.message.includes('FileNotFoundError') || /404|file not found/i.test(err.message))) {
      return true;
    }
  }
  return false;
}

export class DriveActivityHandler implements ActivityHandler {
  private readonly options: DriveActivityHandlerOptions;
  private readonly sourceFiles?: SourceFile[] | undefined;
  private readonly sourceFileHydrator?: SourceFileHydratorPort | undefined;
  private readonly isFileSourceEmailAttachments?: boolean | undefined;

  constructor(
    private readonly driveService: DriveServicePort,
    options?: DriveActivityHandlerOptions
  ) {
    const validatedTargetId = validatePrimaryTargetId(
      options?.primaryTargetId,
      'DriveActivityHandler'
    );
    this.options = {
      ...(options ?? {}),
      ...(validatedTargetId !== undefined ? { primaryTargetId: validatedTargetId } : {}),
    };
    this.sourceFileHydrator = options?.sourceFileHydrator;
    this.isFileSourceEmailAttachments = options?.isFileSourceEmailAttachments;
    if (options?.sourceFiles !== undefined) {
      this.sourceFiles = options.sourceFiles;
    } else if (validatedTargetId) {
      this.sourceFiles = [{ id: validatedTargetId }];
    } else {
      this.sourceFiles = undefined;
    }
  }

  private isEmailPdf(sourceFile: SourceFile): boolean {
    return (
      sourceFile.id.startsWith('email-pdf-') &&
      !(sourceFile.content instanceof Uint8Array)
    );
  }

  private isUnhydratedEmailAttachment(
    sourceFile: SourceFile,
    payload?: Record<string, unknown>
  ): boolean {
    if (sourceFile.content instanceof Uint8Array) {
      return false;
    }
    if (this.isEmailPdf(sourceFile)) {
      return false;
    }
    let isFileSourceEmailAttachments = this.options.isFileSourceEmailAttachments;
    if (isFileSourceEmailAttachments === undefined && payload) {
      if (payload.SelectFileSource !== undefined) {
        isFileSourceEmailAttachments = payload.SelectFileSource === 'Email Attachments';
      } else if (payload.fileSource !== undefined) {
        isFileSourceEmailAttachments = payload.fileSource === 'Email Attachments';
      } else if (payload.isFileSourceEmailAttachments !== undefined) {
        isFileSourceEmailAttachments = Boolean(payload.isFileSourceEmailAttachments);
      }
    }

    if (isFileSourceEmailAttachments === false) {
      return false;
    }

    const id = sourceFile.id;
    return (
      id.startsWith('inline-') ||
      id.startsWith('part-') ||
      id.startsWith('att-') ||
      isFileSourceEmailAttachments === true
    );
  }

  canHandle(activity: Activity): boolean {
    return (
      activity.type === 'MOVE_FILE' ||
      activity.type === 'DUPLICATE_FILE' ||
      activity.type === 'SEARCH_DRIVE_FILE' ||
      activity.type === 'FIND_DRIVE_FILE' ||
      activity.type === 'RESOLVE_DRIVE_FILE'
    );
  }

  private extractSearchQuery(
    payload: Record<string, unknown>,
    options?: { includeFileName?: boolean }
  ): DriveSearchQuery | undefined {
    const includeFileName = options?.includeFileName ?? true;
    let targetName =
      typeof payload.targetName === 'string'
        ? payload.targetName
        : includeFileName && typeof payload.fileName === 'string'
          ? payload.fileName
          : typeof payload.name === 'string'
            ? payload.name
            : undefined;

    let expectedParentPathNames: string[] | undefined = undefined;

    if (Array.isArray(payload.expectedParentPathNames)) {
      expectedParentPathNames = payload.expectedParentPathNames.filter(
        (seg): seg is string => typeof seg === 'string' && seg.length > 0
      );
    } else if (typeof payload.parentPath === 'string') {
      expectedParentPathNames = payload.parentPath
        .split(/[/\\]+/)
        .filter((seg) => seg.length > 0);
    } else if (typeof payload.folderPath === 'string') {
      expectedParentPathNames = payload.folderPath
        .split(/[/\\]+/)
        .filter((seg) => seg.length > 0);
    }

    const fullPath =
      typeof payload.targetPath === 'string'
        ? payload.targetPath
        : typeof payload.filePath === 'string'
          ? payload.filePath
          : typeof payload.path === 'string'
            ? payload.path
            : undefined;

    if (fullPath && !targetName) {
      const segments = fullPath.split(/[/\\]+/).filter((seg) => seg.length > 0);
      if (segments.length > 0) {
        targetName = segments[segments.length - 1];
        if (!expectedParentPathNames && segments.length > 1) {
          expectedParentPathNames = segments.slice(0, segments.length - 1);
        }
      }
    }

    if (!targetName) {
      return undefined;
    }

    const sharedDriveId =
      typeof payload.sharedDriveId === 'string' ? payload.sharedDriveId : undefined;

    const mimeTypes = Array.isArray(payload.mimeTypes)
      ? payload.mimeTypes.filter((m): m is string => typeof m === 'string')
      : undefined;

    const exactMatch =
      typeof payload.exactMatch === 'boolean'
        ? payload.exactMatch
        : payload.matchType === 'exact'
          ? true
          : undefined;

    return {
      targetName,
      ...(expectedParentPathNames ? { expectedParentPathNames } : {}),
      ...(sharedDriveId ? { sharedDriveId } : {}),
      ...(mimeTypes ? { mimeTypes } : {}),
      ...(exactMatch !== undefined ? { exactMatch } : {}),
    };
  }

  async handle(
    activity: Activity,
    context?: ActivityExecutionContext
  ): Promise<ActivityOutput> {
    const payload = activity.payload ?? {};

    const isSearchActivity =
      activity.type === 'SEARCH_DRIVE_FILE' ||
      activity.type === 'FIND_DRIVE_FILE' ||
      activity.type === 'RESOLVE_DRIVE_FILE';

    if (isSearchActivity) {
      try {
        return await this.handleSearch(payload);
      } catch (error) {
        if (
          error instanceof AmbiguousPathSpecError ||
          error instanceof AmbiguousFileError ||
          error instanceof FileNotFoundError
        ) {
          return {
            success: false,
            error: error.message,
          };
        }

        if (error instanceof DriveServiceError) {
          throw error;
        }

        throw error instanceof Error
          ? error
          : new Error(`DriveActivityHandler failed: ${String(error)}`, { cause: error });
      }
    }

    try {
      if (activity.type === 'DUPLICATE_FILE') {
        return await this.handleDuplicate(payload, context);
      }
      return await this.handleMove(payload, context);
    } catch (error) {
      if (
        error instanceof DriveServiceError ||
        error instanceof AmbiguousPathSpecError ||
        error instanceof AmbiguousFileError ||
        error instanceof FileNotFoundError
      ) {
        return {
          success: false,
          error: error.message,
        };
      }

      const verb = activity.type === 'DUPLICATE_FILE' ? 'duplicate' : 'move';
      throw new Error(
        `DriveActivityHandler failed to ${verb} file: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  private async handleSearch(
    payload: Record<string, unknown>
  ): Promise<ActivityOutput> {
    const query = this.extractSearchQuery(payload);
    if (!query) {
      throw new Error('DriveActivityHandler: No targetName or path found in activity payload for search');
    }

    try {
      const results = await this.driveService.searchFiles(query);

      if (results.length === 0) {
        throw new FileNotFoundError(`FileNotFoundError: File not found for target '${query.targetName}'`);
      }

      if (results.length > 1) {
        throw new AmbiguousFileError(
          `AmbiguousFileError: Query for target '${query.targetName}' returned ${results.length} matches and could not be uniquely resolved.`
        );
      }

      const matchedFile = results[0];
      const parentId = matchedFile.parents?.[0];
      const parentMeta = parentId
        ? await this.resolveParentFolderMetadata(parentId)
        : undefined;
      const parentUri = resolveDriveFolderUri(parentId, parentMeta?.webViewLink);
      const fileLocator: FileLocator = {
        id: matchedFile.id,
        name: matchedFile.name,
        ...(parentId !== undefined ? { parentId } : {}),
        ...(parentMeta?.name !== undefined ? { parentName: parentMeta.name } : {}),
        ...(parentUri !== undefined ? { parentUri } : {}),
        ...(matchedFile.mimeType ? { mimeType: matchedFile.mimeType } : {}),
        ...(matchedFile.webViewLink ? { uri: matchedFile.webViewLink } : {}),
      };

      return {
        success: true,
        files: [fileLocator],
        documentDataPatch: {
          fileId: matchedFile.id,
          ...(matchedFile.webViewLink ? { webViewLink: matchedFile.webViewLink } : {}),
        },
        contextVariables: {
          fileId: matchedFile.id,
          ...(matchedFile.webViewLink ? { webViewLink: matchedFile.webViewLink } : {}),
        },
      };
    } catch (error) {
      if (error instanceof DriveServiceError) {
        throw error;
      }
      throw new Error(
        `DriveActivityHandler failed to search files: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error }
      );
    }
  }

  private resolveStepSourceFiles(
    activityType: string,
    payload: Record<string, unknown>,
    context?: ActivityExecutionContext
  ): SourceFile[] {
    const rawStepId = payload.fileSourceStepId;
    if (typeof rawStepId !== 'string' || rawStepId.trim().length === 0) {
      throw new DriveServiceError(
        `DriveActivityHandler: ${activityType} payload.fileSourceStepId must be a non-empty string`
      );
    }
    const stepId = rawStepId.trim();
    if (!context) {
      throw new DriveServiceError(
        `DriveActivityHandler: ${activityType} fileSourceStepId "${stepId}" requires an ActivityExecutionContext.`
      );
    }
    const stepOutput = context.stepOutputs[stepId];
    if (stepOutput === undefined) {
      throw new DriveServiceError(
        `DriveActivityHandler: ${activityType} fileSourceStepId "${stepId}" references an unexecuted step.`
      );
    }
    const stepFiles = stepOutput.files ?? [];
    if (stepFiles.length === 0) {
      throw new DriveServiceError(
        `DriveActivityHandler: ${activityType} fileSourceStepId "${stepId}" resolved zero files.`
      );
    }
    return stepFiles.map((file) => ({
      id: file.id,
      name: file.name,
      ...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
    }));
  }

  private async resolveDestinationFolder(
    payload: Record<string, unknown>,
    firstSourceFile: SourceFile | undefined,
    fileMetadataCache: Map<string, DriveFileResult>,
    options: { defaultToUnfiled: boolean }
  ): Promise<DriveFileResult | undefined> {
    const rootStorageId =
      typeof payload.rootStorageId === 'string' && payload.rootStorageId.trim().length > 0
        ? payload.rootStorageId.trim()
        : undefined;

    let parentPathSegments: string[] = [];
    if (payload.parentPath !== undefined) {
      parentPathSegments = parsePathSegments(payload.parentPath as string);
    }

    let driveConfig;
    if (options.defaultToUnfiled && this.options.configProvider) {
      try {
        driveConfig = await this.options.configProvider.getDriveConfig();
      } catch (error) {
        throw new Error(
          `DriveActivityHandler failed to get drive config: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error }
        );
      }
    }

    let folderSegments: string[] = [];
    if (payload.folderName !== undefined) {
      folderSegments = parsePathSegments(payload.folderName as string);
    } else if (options.defaultToUnfiled) {
      const defaultTargetName =
        driveConfig?.defaultFolderName ?? this.options.defaultFolderName ?? 'Unfiled';
      folderSegments = [defaultTargetName];
    }

    if (
      !options.defaultToUnfiled &&
      rootStorageId === undefined &&
      parentPathSegments.length === 0 &&
      folderSegments.length === 0
    ) {
      return undefined;
    }

    let startingId: string;
    if (rootStorageId) {
      startingId = rootStorageId;
    } else if (!firstSourceFile) {
      throw new Error(
        'DriveActivityHandler: Cannot create destination folder for zero-file filing because rootStorageId is missing or unresolved in activity payload'
      );
    } else if (firstSourceFile.content instanceof Uint8Array) {
      throw new Error(
        'DriveActivityHandler: Cannot create destination folder for binary file filing because rootStorageId is missing or unresolved in activity payload'
      );
    } else if (
      this.isEmailPdf(firstSourceFile) ||
      this.isUnhydratedEmailAttachment(firstSourceFile, payload)
    ) {
      throw new Error(
        'DriveActivityHandler: Cannot create destination folder for unhydrated email item because rootStorageId is missing or unresolved in activity payload'
      );
    } else {
      const firstFileMeta = await this.getCachedFileMetadata(firstSourceFile.id, fileMetadataCache);
      startingId = firstFileMeta.parents?.[0] ?? 'root';
    }

    let leafFolder: DriveFileResult = { id: startingId, name: '' };
    if (parentPathSegments.length > 0) {
      leafFolder = await this.driveService.resolveFolderPath(startingId, parentPathSegments);
    }

    let currentParentId = leafFolder.id;
    for (const segment of folderSegments) {
      leafFolder = await this.driveService.findOrCreateFolder(currentParentId, segment);
      currentParentId = leafFolder.id;
    }

    return leafFolder;
  }

  private async resolveTargetFileName(
    sourceFile: SourceFile,
    requestedFileName: string | undefined,
    fileNamePrefix: string | undefined,
    fileMetadataCache: Map<string, DriveFileResult>,
    requireBaseName: boolean
  ): Promise<string | undefined> {
    if (requestedFileName === undefined && fileNamePrefix === undefined) {
      return undefined;
    }
    let sourceName = sourceFile.name;
    let sourceMimeType = sourceFile.mimeType;
    if (sourceName === undefined || sourceMimeType === undefined) {
      const cachedMeta = await this.getCachedFileMetadata(sourceFile.id, fileMetadataCache);
      sourceName = sourceName ?? cachedMeta.name;
      sourceMimeType = sourceMimeType ?? cachedMeta.mimeType;
    }
    const baseName =
      requestedFileName !== undefined
        ? resolveExtensionPreservingFileName(requestedFileName, sourceName, sourceMimeType)
        : sourceName;
    if (baseName === undefined || baseName.trim().length === 0) {
      if (requireBaseName) {
        throw new DriveServiceError('DriveActivityHandler: Could not resolve target file name');
      }
      return undefined;
    }
    return applyNonDoublingPrefix(baseName, fileNamePrefix);
  }

  private mapFileLoopError(error: unknown, processedFiles: FileLocator[]): ActivityOutput {
    if (isFileNotFoundError(error)) {
      return {
        success: false,
        error: 'The specified Google Drive file or folder was not found.',
        files: processedFiles,
      };
    }

    if (isAccessDeniedError(error)) {
      return {
        success: false,
        error: 'Access denied. You do not have permission to access this Google Drive file or folder.',
        files: processedFiles,
      };
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      error: errorMessage,
      files: processedFiles,
    };
  }

  private parseOptionalPayloadFileName(
    activityType: 'MOVE_FILE' | 'DUPLICATE_FILE',
    payload: Record<string, unknown>
  ): string | undefined {
    if (payload.fileName === undefined) {
      return undefined;
    }
    if (typeof payload.fileName !== 'string' || payload.fileName.trim().length === 0) {
      throw new DriveServiceError(
        `DriveActivityHandler: ${activityType} payload.fileName must be a non-empty string`
      );
    }
    return payload.fileName.trim();
  }

  private async hydrateContextSourceFilesIfNeeded(
    targetSourceFiles: SourceFile[],
    isFromContextSourceFiles: boolean,
    processedFiles: FileLocator[]
  ): Promise<{ ok: true; files: SourceFile[] } | { ok: false; output: ActivityOutput }> {
    if (
      !isFromContextSourceFiles ||
      !this.sourceFileHydrator ||
      !targetSourceFiles.some((f) => !(f.content instanceof Uint8Array))
    ) {
      return { ok: true, files: targetSourceFiles };
    }
    try {
      return {
        ok: true,
        files: await this.sourceFileHydrator.hydrate(targetSourceFiles),
      };
    } catch (error) {
      if (error instanceof DriveServiceError) {
        return {
          ok: false,
          output: {
            success: false,
            error: error.message,
            files: processedFiles,
          },
        };
      }
      throw error;
    }
  }

  private validateRemoteSourceFileHydration(
    sourceFile: SourceFile,
    isFromContextSourceFiles: boolean,
    payload: Record<string, unknown>,
    processedFiles: FileLocator[]
  ): ActivityOutput | undefined {
    if (!isFromContextSourceFiles) {
      return undefined;
    }
    if (this.isEmailPdf(sourceFile)) {
      return {
        success: false,
        error: 'Could not generate the Email PDF. Please try again.',
        files: processedFiles,
      };
    }
    if (this.isUnhydratedEmailAttachment(sourceFile, payload)) {
      return {
        success: false,
        error:
          'Could not retrieve the selected email attachment(s) from Gmail. Please refresh the add-on and try again.',
        files: processedFiles,
      };
    }
    return undefined;
  }

  private async saveBinarySourceFile(
    sourceFile: SourceFile & { content: Uint8Array },
    leafFolder: DriveFileResult,
    requestedFileName: string | undefined,
    fileNamePrefix: string | undefined
  ): Promise<FileLocator> {
    const baseName =
      requestedFileName !== undefined
        ? resolveExtensionPreservingFileName(
            requestedFileName,
            sourceFile.name,
            sourceFile.mimeType
          )
        : sourceFile.name || sourceFile.id;
    const resolvedName = applyNonDoublingPrefix(baseName, fileNamePrefix);
    const file = await this.driveService.saveBuffer(sourceFile.content, {
      action: 'create',
      targetFolderId: leafFolder.id,
      name: resolvedName,
      ...(sourceFile.mimeType !== undefined ? { mimeType: sourceFile.mimeType } : {}),
    });
    const resolvedParentId = file.parents?.[0] ?? leafFolder.id;
    return this.createFileLocator(file, leafFolder.name, {
      fallbackMimeType: sourceFile.mimeType,
      fallbackParentId: leafFolder.id,
      parentWebViewLink:
        resolvedParentId === leafFolder.id ? leafFolder.webViewLink : undefined,
      defaultEmptyUri: true,
    });
  }

  private async enrichFileMetadataIfIncomplete(
    fileId: string,
    file: {
      name?: string | undefined;
      mimeType?: string | undefined;
      webViewLink?: string | undefined;
    },
    fallbackName: string | undefined
  ): Promise<{
    name: string | undefined;
    mimeType: string | undefined;
    uri: string | undefined;
  }> {
    let uri = file.webViewLink;
    let mimeType = file.mimeType;
    let name = file.name || fallbackName;

    if (!uri || !name) {
      try {
        const fileMeta = await this.driveService.getFile(fileId);
        uri = uri ?? fileMeta.webViewLink;
        mimeType = mimeType ?? fileMeta.mimeType;
        name = name || fileMeta.name;
      } catch {
        // Ignore
      }
    }

    return { name, mimeType, uri };
  }

  private async handleMove(
    payload: Record<string, unknown>,
    context?: ActivityExecutionContext
  ): Promise<ActivityOutput> {
    let targetSourceFiles: SourceFile[] = [];
    let isFromContextSourceFiles = false;

    const payloadFileId =
      typeof payload.fileId === 'string' && payload.fileId.trim().length > 0
        ? payload.fileId.trim()
        : undefined;

    const contextSourceFiles = context?.document?.sourceFiles;

    if (payload.fileSourceStepId !== undefined) {
      targetSourceFiles = this.resolveStepSourceFiles('MOVE_FILE', payload, context);
    } else if (contextSourceFiles !== undefined) {
      targetSourceFiles = [...contextSourceFiles];
      isFromContextSourceFiles = true;
    } else if (this.sourceFiles !== undefined) {
      targetSourceFiles = [...this.sourceFiles];
      isFromContextSourceFiles = true;
    } else if (payloadFileId) {
      targetSourceFiles = [{ id: payloadFileId }];
    } else {
      const searchQuery = this.extractSearchQuery(payload, { includeFileName: false });
      if (searchQuery) {
        const results = await this.driveService.searchFiles(searchQuery);
        if (results.length === 0) {
          throw new FileNotFoundError(`FileNotFoundError: File not found for target '${searchQuery.targetName}'`);
        }
        if (results.length > 1) {
          throw new AmbiguousFileError(
            `AmbiguousFileError: Query for target '${searchQuery.targetName}' returned ${results.length} matches and could not be uniquely resolved.`
          );
        }
        targetSourceFiles = [{ id: results[0].id }];
      }
    }

    if (
      payload.fileSourceStepId === undefined &&
      contextSourceFiles === undefined &&
      this.sourceFiles === undefined &&
      targetSourceFiles.length === 0
    ) {
      throw new Error('DriveActivityHandler: No fileId found in activity payload or execution context');
    }

    const requestedFileName = this.parseOptionalPayloadFileName('MOVE_FILE', payload);

    const fileMetadataCache = new Map<string, DriveFileResult>();
    const leafFolder = await this.resolveDestinationFolder(
      payload,
      targetSourceFiles[0],
      fileMetadataCache,
      { defaultToUnfiled: true }
    );
    if (!leafFolder) {
      throw new DriveServiceError('DriveActivityHandler: Could not resolve destination folder');
    }

    const movedFiles: FileLocator[] = [];

    const hydration = await this.hydrateContextSourceFilesIfNeeded(
      targetSourceFiles,
      isFromContextSourceFiles,
      movedFiles
    );
    if (!hydration.ok) {
      return hydration.output;
    }
    targetSourceFiles = hydration.files;

    if (targetSourceFiles.length === 0) {
      const folderUri = resolveDriveFolderUri(leafFolder.id, leafFolder.webViewLink);
      return {
        success: true,
        files: [
          {
            id: leafFolder.id,
            name: leafFolder.name,
            parentId: leafFolder.id,
            parentName: leafFolder.name,
            ...(folderUri !== undefined ? { parentUri: folderUri, uri: folderUri } : {}),
            mimeType: GOOGLE_FOLDER_MIME_TYPE,
          },
        ],
      };
    }

    for (const sourceFile of targetSourceFiles) {
      try {
        if (sourceFile.content instanceof Uint8Array) {
          const fileLocator = await this.saveBinarySourceFile(
            { ...sourceFile, content: sourceFile.content },
            leafFolder,
            requestedFileName,
            undefined
          );
          movedFiles.push(fileLocator);
        } else {
          const hydrationError = this.validateRemoteSourceFileHydration(
            sourceFile,
            isFromContextSourceFiles,
            payload,
            movedFiles
          );
          if (hydrationError) {
            return hydrationError;
          }

          const newName = await this.resolveTargetFileName(
            sourceFile,
            requestedFileName,
            undefined,
            fileMetadataCache,
            false
          );

          const movedFile =
            newName !== undefined
              ? await this.driveService.move(sourceFile.id, leafFolder.id, { newName })
              : await this.driveService.move(sourceFile.id, leafFolder.id);

          const { name, mimeType, uri } = await this.enrichFileMetadataIfIncomplete(
            sourceFile.id,
            movedFile,
            newName
          );

          const resolvedParentId = movedFile.parents?.[0] ?? leafFolder.id;
          const fileLocator = this.createFileLocator(
            {
              id: movedFile.id,
              name,
              parents: movedFile.parents,
              mimeType,
              webViewLink: uri,
            },
            leafFolder.name,
            {
              fallbackName: newName ?? sourceFile.name,
              fallbackParentId: leafFolder.id,
              parentWebViewLink:
                resolvedParentId === leafFolder.id ? leafFolder.webViewLink : undefined,
            }
          );
          movedFiles.push(fileLocator);
        }
      } catch (error) {
        return this.mapFileLoopError(error, movedFiles);
      }
    }

    return {
      success: true,
      files: movedFiles,
    };
  }

  private async handleDuplicate(
    payload: Record<string, unknown>,
    context?: ActivityExecutionContext
  ): Promise<ActivityOutput> {
    const requestedFileName = this.parseOptionalPayloadFileName('DUPLICATE_FILE', payload);

    let fileNamePrefix: string | undefined;
    if (payload.fileNamePrefix !== undefined) {
      if (typeof payload.fileNamePrefix !== 'string' || payload.fileNamePrefix.trim().length === 0) {
        throw new DriveServiceError(
          'DriveActivityHandler: DUPLICATE_FILE payload.fileNamePrefix must be a non-empty string'
        );
      }
      fileNamePrefix = payload.fileNamePrefix;
    }

    let targetSourceFiles: SourceFile[] = [];
    let isFromContextSourceFiles = false;
    const payloadFileId =
      typeof payload.fileId === 'string' && payload.fileId.trim().length > 0
        ? payload.fileId.trim()
        : undefined;

    if (payload.fileSourceStepId !== undefined) {
      targetSourceFiles = this.resolveStepSourceFiles('DUPLICATE_FILE', payload, context);
    } else if (payloadFileId) {
      targetSourceFiles = [{ id: payloadFileId }];
    } else if (context && context.files.length > 0) {
      targetSourceFiles = context.files.map((file) => ({
        id: file.id,
        name: file.name,
        ...(file.mimeType !== undefined ? { mimeType: file.mimeType } : {}),
      }));
    } else if (context?.document?.sourceFiles !== undefined && context.document.sourceFiles.length > 0) {
      targetSourceFiles = [...context.document.sourceFiles];
      isFromContextSourceFiles = true;
    } else if (this.sourceFiles !== undefined && this.sourceFiles.length > 0) {
      targetSourceFiles = [...this.sourceFiles];
      isFromContextSourceFiles = true;
    } else {
      const searchQuery = this.extractSearchQuery(payload, { includeFileName: false });
      if (searchQuery) {
        const results = await this.driveService.searchFiles(searchQuery);
        if (results.length === 0) {
          throw new FileNotFoundError(`FileNotFoundError: File not found for target '${searchQuery.targetName}'`);
        }
        if (results.length > 1) {
          throw new AmbiguousFileError(
            `AmbiguousFileError: Query for target '${searchQuery.targetName}' returned ${results.length} matches and could not be uniquely resolved.`
          );
        }
        targetSourceFiles = [{ id: results[0].id }];
      }
    }

    if (targetSourceFiles.length === 0) {
      throw new DriveServiceError(
        'DriveActivityHandler: DUPLICATE_FILE requires at least one source file from fileSourceStepId, fileId, or execution context.'
      );
    }

    const fileMetadataCache = new Map<string, DriveFileResult>();
    const leafFolder = await this.resolveDestinationFolder(
      payload,
      targetSourceFiles[0],
      fileMetadataCache,
      { defaultToUnfiled: false }
    );

    const duplicatedFiles: FileLocator[] = [];

    const hydration = await this.hydrateContextSourceFilesIfNeeded(
      targetSourceFiles,
      isFromContextSourceFiles,
      duplicatedFiles
    );
    if (!hydration.ok) {
      return hydration.output;
    }
    targetSourceFiles = hydration.files;

    for (const sourceFile of targetSourceFiles) {
      try {
        if (sourceFile.content instanceof Uint8Array) {
          if (!leafFolder) {
            throw new DriveServiceError(
              'DriveActivityHandler: DUPLICATE_FILE requires a destination folder for binary source files'
            );
          }
          duplicatedFiles.push(
            await this.saveBinarySourceFile(
              { ...sourceFile, content: sourceFile.content },
              leafFolder,
              requestedFileName,
              fileNamePrefix
            )
          );
          continue;
        }

        const hydrationError = this.validateRemoteSourceFileHydration(
          sourceFile,
          isFromContextSourceFiles,
          payload,
          duplicatedFiles
        );
        if (hydrationError) {
          return hydrationError;
        }

        const newName = await this.resolveTargetFileName(
          sourceFile,
          requestedFileName,
          fileNamePrefix,
          fileMetadataCache,
          true
        );

        const duplicateOptions = {
          ...(leafFolder ? { targetFolderId: leafFolder.id } : {}),
          ...(newName !== undefined ? { newName } : {}),
        };

        const duplicatedFile =
          Object.keys(duplicateOptions).length > 0
            ? await this.driveService.duplicate(sourceFile.id, duplicateOptions)
            : await this.driveService.duplicate(sourceFile.id);

        const { name, mimeType, uri } = await this.enrichFileMetadataIfIncomplete(
          duplicatedFile.id,
          duplicatedFile,
          newName
        );

        const resolvedParentId = leafFolder?.id ?? duplicatedFile.parents?.[0];
        let parentName: string | undefined;
        let parentWebViewLink: string | undefined;
        if (leafFolder) {
          parentName = leafFolder.name;
          parentWebViewLink =
            (duplicatedFile.parents?.[0] ?? leafFolder.id) === leafFolder.id
              ? leafFolder.webViewLink
              : undefined;
        } else if (resolvedParentId) {
          const parentMeta = await this.resolveParentFolderMetadata(
            resolvedParentId,
            fileMetadataCache
          );
          parentName = parentMeta.name;
          parentWebViewLink = parentMeta.webViewLink;
        }
        const fileLocator = this.createFileLocator(
          {
            id: duplicatedFile.id,
            name,
            parents: duplicatedFile.parents,
            mimeType,
            webViewLink: uri,
          },
          parentName,
          {
            fallbackName: newName ?? sourceFile.name,
            fallbackMimeType: sourceFile.mimeType,
            fallbackParentId: resolvedParentId,
            parentWebViewLink,
          }
        );
        duplicatedFiles.push(fileLocator);
      } catch (error) {
        return this.mapFileLoopError(error, duplicatedFiles);
      }
    }

    return {
      success: true,
      files: duplicatedFiles,
    };
  }

  private async getCachedFileMetadata(
    fileId: string,
    cache: Map<string, DriveFileResult>
  ): Promise<DriveFileResult> {
    const existing = cache.get(fileId);
    if (existing !== undefined) {
      return existing;
    }
    const fetched = await this.driveService.getFile(fileId);
    cache.set(fileId, fetched);
    return fetched;
  }

  private async resolveParentFolderMetadata(
    parentId: string,
    cache?: Map<string, DriveFileResult>
  ): Promise<{ name?: string | undefined; webViewLink?: string | undefined }> {
    try {
      const meta = cache
        ? await this.getCachedFileMetadata(parentId, cache)
        : await this.driveService.getFile(parentId);
      if (meta && meta.id === parentId) {
        return {
          ...(meta.name ? { name: meta.name } : {}),
          ...(meta.webViewLink ? { webViewLink: meta.webViewLink } : {}),
        };
      }
    } catch {
      // Best-effort parent metadata enrichment; never fall back to raw folder ID
    }
    return {};
  }

  private createFileLocator(
    file:
      | DriveFile
      | {
          id: string;
          name?: string | undefined;
          parents?: string[] | undefined;
          mimeType?: string | undefined;
          webViewLink?: string | undefined;
        },
    parentName: string | undefined,
    options?: {
      fallbackMimeType?: string | undefined;
      fallbackName?: string | undefined;
      fallbackParentId?: string | undefined;
      parentWebViewLink?: string | undefined;
      defaultEmptyUri?: boolean | undefined;
    }
  ): FileLocator {
    const resolvedMimeType = file.mimeType ?? options?.fallbackMimeType;
    const resolvedName = file.name || options?.fallbackName || '';
    const resolvedParentId = file.parents?.[0] ?? options?.fallbackParentId;
    const resolvedParentUri = resolveDriveFolderUri(
      resolvedParentId,
      options?.parentWebViewLink
    );
    const resolvedUri = file.webViewLink ?? (options?.defaultEmptyUri ? '' : undefined);
    return {
      id: file.id,
      name: resolvedName,
      ...(resolvedParentId !== undefined ? { parentId: resolvedParentId } : {}),
      ...(parentName !== undefined ? { parentName } : {}),
      ...(resolvedParentUri !== undefined ? { parentUri: resolvedParentUri } : {}),
      ...(resolvedMimeType !== undefined ? { mimeType: resolvedMimeType } : {}),
      ...(resolvedUri !== undefined ? { uri: resolvedUri } : {}),
    };
  }
}

