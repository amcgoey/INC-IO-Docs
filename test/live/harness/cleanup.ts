import type { GoogleDriveClient } from '../../../src/infrastructure/drive/drive-client';
import {
  getDocumentLogTestFolderId,
  getSubmittalCoverSheetTemplateId,
} from '../../e2e/utils/live-google-auth';
import { loadDocumentLogSampleFixture } from '../../e2e/utils/live-sheets-helper';

export type CleanupArtifactKind = 'folder' | 'spreadsheet' | 'file';

export interface TrackCleanupOptions {
  kind?: CleanupArtifactKind | undefined;
  parentFolderId?: string | undefined;
}

export interface CleanupFailure {
  id: string;
  kind: CleanupArtifactKind;
  error: unknown;
}

export type CleanupLogger = (message: string, details?: unknown) => void;

export interface CleanupTrashOptions {
  logger?: CleanupLogger | undefined;
}

export interface CleanupTracker {
  track: (id: string | undefined, options?: TrackCleanupOptions) => void;
  trackFolder: (id: string | undefined, parentFolderId?: string) => void;
  trackSpreadsheet: (id: string | undefined, parentFolderId?: string) => void;
  trashAll: (
    driveClient: Pick<GoogleDriveClient, 'trash'>,
    options?: CleanupTrashOptions
  ) => Promise<CleanupFailure[]>;
}

interface TrackedArtifact {
  id: string;
  kind: CleanupArtifactKind;
  parentFolderId?: string | undefined;
  order: number;
}

const defaultLogger: CleanupLogger = (message, details) => {
  console.warn(message, details);
};

function buildDefaultProtectedIds(): Set<string> {
  const protectedIds = new Set<string>();
  const testFolderId = getDocumentLogTestFolderId();
  if (testFolderId) {
    protectedIds.add(testFolderId);
  }
  const coverSheetTemplateId = getSubmittalCoverSheetTemplateId();
  if (coverSheetTemplateId) {
    protectedIds.add(coverSheetTemplateId);
  }
  const sampleTemplateId = loadDocumentLogSampleFixture().metadata.templateSpreadsheetId?.trim();
  if (sampleTemplateId) {
    protectedIds.add(sampleTemplateId);
  }
  return protectedIds;
}

function isDescendantOfFolder(
  artifact: TrackedArtifact,
  ancestorFolderId: string,
  byId: ReadonlyMap<string, TrackedArtifact>
): boolean {
  const visited = new Set<string>([artifact.id]);
  let currentParentId = artifact.parentFolderId;
  while (currentParentId) {
    if (currentParentId === ancestorFolderId) {
      return true;
    }
    if (visited.has(currentParentId)) {
      return false;
    }
    visited.add(currentParentId);
    currentParentId = byId.get(currentParentId)?.parentFolderId;
  }
  return false;
}

/**
 * Tracks created live Drive artifacts and performs hardened teardown:
 * trashes top-level tracked folders first, logs any cleanup errors instead of swallowing them,
 * and falls back to explicit trashing of tracked spreadsheet/child artifacts if folder trash fails.
 */
export function createCleanupTracker(options?: {
  protectedIds?: readonly string[] | undefined;
}): CleanupTracker {
  const entries = new Map<string, TrackedArtifact>();
  let sequence = 0;

  const isProtected = (id: string): boolean => {
    if (buildDefaultProtectedIds().has(id)) {
      return true;
    }
    return options?.protectedIds?.includes(id) ?? false;
  };

  const track = (id: string | undefined, trackOptions?: TrackCleanupOptions): void => {
    const trimmed = id?.trim();
    if (!trimmed || isProtected(trimmed)) {
      return;
    }
    const existing = entries.get(trimmed);
    if (existing) {
      if (trackOptions?.kind) {
        existing.kind = trackOptions.kind;
      }
      if (trackOptions?.parentFolderId !== undefined) {
        existing.parentFolderId = trackOptions.parentFolderId;
      }
      return;
    }
    entries.set(trimmed, {
      id: trimmed,
      kind: trackOptions?.kind ?? 'file',
      ...(trackOptions?.parentFolderId !== undefined
        ? { parentFolderId: trackOptions.parentFolderId }
        : {}),
      order: sequence++,
    });
  };

  const trackFolder = (id: string | undefined, parentFolderId?: string): void => {
    track(id, { kind: 'folder', ...(parentFolderId !== undefined ? { parentFolderId } : {}) });
  };

  const trackSpreadsheet = (id: string | undefined, parentFolderId?: string): void => {
    track(id, { kind: 'spreadsheet', ...(parentFolderId !== undefined ? { parentFolderId } : {}) });
  };

  const trashAll = async (
    driveClient: Pick<GoogleDriveClient, 'trash'>,
    trashOptions?: CleanupTrashOptions
  ): Promise<CleanupFailure[]> => {
    const logger = trashOptions?.logger ?? defaultLogger;
    const failures: CleanupFailure[] = [];
    const handled = new Set<string>();

    const allEntries = Array.from(entries.values());
    const topLevelFolders = allEntries.filter(
      (entry) =>
        entry.kind === 'folder' &&
        (!entry.parentFolderId || !entries.has(entry.parentFolderId))
    );

    const attemptTrash = async (entry: TrackedArtifact, failureContext?: string): Promise<boolean> => {
      if (handled.has(entry.id)) {
        return true;
      }
      try {
        await driveClient.trash(entry.id);
        handled.add(entry.id);
        return true;
      } catch (error) {
        logger(
          failureContext ??
            `[LiveTestHarness] Failed to trash Drive ${entry.kind} "${entry.id}".`,
          error
        );
        failures.push({ id: entry.id, kind: entry.kind, error });
        handled.add(entry.id);
        return false;
      }
    };

    for (const folder of topLevelFolders) {
      const folderTrashed = await attemptTrash(
        folder,
        `[LiveTestHarness] Failed to trash Drive folder "${folder.id}"; falling back to explicit child cleanup.`
      );
      if (folderTrashed) {
        for (const candidate of allEntries) {
          if (isDescendantOfFolder(candidate, folder.id, entries)) {
            handled.add(candidate.id);
          }
        }
      }
    }

    const remaining = allEntries
      .filter((entry) => !handled.has(entry.id))
      .sort((a, b) => {
        const rank = (kind: CleanupArtifactKind): number =>
          kind === 'spreadsheet' ? 0 : kind === 'file' ? 1 : 2;
        return rank(a.kind) - rank(b.kind) || b.order - a.order;
      });

    for (const entry of remaining) {
      await attemptTrash(entry);
    }

    return failures;
  };

  return { track, trackFolder, trackSpreadsheet, trashAll };
}

/**
 * Discovers an optional `"1 Admin"` subfolder if missing and runs hardened `tracker.trashAll()`.
 */
export async function cleanupScratchSpace(params: {
  driveClient: Pick<GoogleDriveClient, 'trash' | 'resolveFolderPath'> | undefined;
  spaceFolderId: string | undefined;
  adminFolderId: string | undefined;
  tracker: CleanupTracker;
  logger?: CleanupLogger | undefined;
}): Promise<CleanupFailure[]> {
  const { driveClient, spaceFolderId, adminFolderId, tracker, logger = defaultLogger } = params;
  if (!driveClient) {
    return [];
  }
  if (spaceFolderId && !adminFolderId) {
    try {
      const adminFolder = await driveClient.resolveFolderPath(spaceFolderId, ['1 Admin']);
      tracker.trackFolder(adminFolder.id, spaceFolderId);
    } catch (error) {
      logger(
        `[LiveTestHarness] Best-effort "1 Admin" discovery under "${spaceFolderId}" failed during cleanup.`,
        error
      );
    }
  }
  return await tracker.trashAll(driveClient, { logger });
}
