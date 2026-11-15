import type {
  DriveItemHierarchy,
  SourceContext,
  InferredRoutingResult,
  ExtractFieldsRequest,
  ExtractedFieldsResult,
  SourceParserSpaceTypeConfig,
  DriveSourceContextPort,
  SourceParserSpaceConfigPort,
  SourceParserPort,
} from './ports';

export * from './ports';

export const CSI_SECTION_REGEX = /(?<=^|[\s_.-])\d{6}-\d{3}(?:-[A-Za-z0-9]+)?(?=[\s_.-]|$)/;
export const FFE_SPEC_TAG_REGEX = /(?<=^|[\s_.-])[A-Za-z]{2}\d{3}[A-Za-z]?-[A-Za-z0-9]+(?=[\s_.-]|$)/i;
export const FFE_PROXIMITY_REGEX_1 = /(?<=^|[\s_.-])FF&?E(?=[\s_.-]|$).{0,100}(?<=^|[\s_.-])Submittal(?=[\s_.-]|$)/is;
export const FFE_PROXIMITY_REGEX_2 = /(?<=^|[\s_.-])Submittal(?=[\s_.-]|$).{0,100}(?<=^|[\s_.-])FF&?E(?=[\s_.-]|$)/is;

export const DRIVE_HIERARCHY_ERROR_MESSAGE =
  'Could not inspect Google Drive folder hierarchy; please verify Document Space and Document Type.';

export function inferDocumentTypeFromFilename(
  filename?: string
): 'submittal-arch' | 'submittal-ffe' | undefined {
  if (!filename || typeof filename !== 'string') {
    return undefined;
  }
  const clean = filename.trim();
  if (CSI_SECTION_REGEX.test(clean)) {
    return 'submittal-arch';
  }
  if (
    FFE_SPEC_TAG_REGEX.test(clean) ||
    FFE_PROXIMITY_REGEX_1.test(clean) ||
    FFE_PROXIMITY_REGEX_2.test(clean)
  ) {
    return 'submittal-ffe';
  }
  return undefined;
}

export function findSpaceTypeForDocumentType(
  spaceTypes: SourceParserSpaceTypeConfig[],
  documentTypeKey: string
): string | undefined {
  return spaceTypes.find((st) => st.spaceSchema?.allowedDocumentTypes?.includes(documentTypeKey))?.id;
}

export class SourceParserService implements SourceParserPort {
  constructor(
    private readonly driveContextPort: DriveSourceContextPort,
    private readonly spaceConfigPort: SourceParserSpaceConfigPort
  ) {}

  async extractFields(request: ExtractFieldsRequest): Promise<ExtractedFieldsResult> {
    void request;
    return { fields: {} };
  }

  async inferRouting(context: SourceContext): Promise<InferredRoutingResult> {
    const rawItems = context.items ?? [];
    const validItems = rawItems.filter(
      (item) => typeof item?.id === 'string' && item.id.trim().length > 0
    );
    if (validItems.length === 0) {
      return {};
    }

    const rawSpaceTypes = await this.spaceConfigPort.getDocumentSpaceTypes();
    const spaceTypes = rawSpaceTypes ?? [];

    let winningSpaceTypeId: string | undefined;
    let winningSpaceIdOrName: string | undefined;
    let winningDocumentTypeKey: string | undefined;

    try {
      for (const item of validItems) {
        const hierarchy = await this.driveContextPort.getItemHierarchy(item.id.trim());
        const itemResult = this.inferFromDriveHierarchy(hierarchy, spaceTypes);

        if (!winningSpaceTypeId) {
          if (itemResult.spaceTypeId) {
            // nosemgrep: domain-pass-through-read
            winningSpaceTypeId = itemResult.spaceTypeId;
            if (winningSpaceIdOrName === undefined && itemResult.spaceIdOrName !== undefined) {
              // nosemgrep: domain-pass-through-read
              winningSpaceIdOrName = itemResult.spaceIdOrName;
            }
            if (winningDocumentTypeKey === undefined && itemResult.documentTypeKey !== undefined) {
              // nosemgrep: domain-pass-through-read
              winningDocumentTypeKey = itemResult.documentTypeKey;
            }
          }
        } else {
          const isCompatible =
            itemResult.spaceTypeId === undefined || itemResult.spaceTypeId === winningSpaceTypeId;

          if (isCompatible) {
            if (winningSpaceIdOrName === undefined && itemResult.spaceIdOrName !== undefined) {
              // nosemgrep: domain-pass-through-read
              winningSpaceIdOrName = itemResult.spaceIdOrName;
            }
            if (winningDocumentTypeKey === undefined && itemResult.documentTypeKey !== undefined) {
              const spaceConfig = spaceTypes.find((st) => st.id === winningSpaceTypeId);
              const allowed = spaceConfig?.spaceSchema?.allowedDocumentTypes ?? [];
              if (allowed.length === 0 || allowed.includes(itemResult.documentTypeKey)) {
                // nosemgrep: domain-pass-through-read
                winningDocumentTypeKey = itemResult.documentTypeKey;
              }
            }
          }
        }

        if (
          winningSpaceTypeId !== undefined &&
          winningSpaceIdOrName !== undefined &&
          winningDocumentTypeKey !== undefined
        ) {
          break;
        }
      }
    } catch {
      return {
        statusMessages: [DRIVE_HIERARCHY_ERROR_MESSAGE],
      };
    }

    return {
      ...(winningSpaceTypeId !== undefined ? { spaceTypeId: winningSpaceTypeId } : {}),
      ...(winningSpaceIdOrName !== undefined ? { spaceIdOrName: winningSpaceIdOrName } : {}),
      ...(winningDocumentTypeKey !== undefined ? { documentTypeKey: winningDocumentTypeKey } : {}),
    };
  }

  private inferFromDriveHierarchy(
    hierarchy: DriveItemHierarchy,
    spaceTypes: SourceParserSpaceTypeConfig[]
  ): InferredRoutingResult {
    let winningSpaceTypeId: string | undefined;
    let winningSpaceIdOrName: string | undefined;

    const folderBackedTypes = spaceTypes.filter(
      (st) => st.storageConfig?.fetchMethod === 'folders'
    );
    const sharedDrivesTypes = spaceTypes.filter(
      (st) => st.storageConfig?.fetchMethod === 'shared_drives'
    );

    const dedicatedSharedDriveNames = new Set(
      folderBackedTypes
        .map((st) =>
          typeof st.storageConfig?.sharedDriveName === 'string'
            ? st.storageConfig.sharedDriveName.trim().toLowerCase()
            : undefined
        )
        .filter((name): name is string => name !== undefined && name.length > 0)
    );

    // 1. Evaluate folder-backed space types first
    for (const spaceType of folderBackedTypes) {
      const cfg = spaceType.storageConfig as SourceParserSpaceTypeConfig['storageConfig'];
      const expectedSharedDriveName =
        typeof cfg?.sharedDriveName === 'string'
          ? cfg.sharedDriveName.trim().toLowerCase()
          : undefined;
      const expectedParentFolderName =
        typeof cfg?.parentFolderName === 'string'
          ? cfg.parentFolderName.trim().toLowerCase()
          : undefined;

      if (expectedSharedDriveName) {
        const actualDriveName = hierarchy.driveName?.trim().toLowerCase();
        if (actualDriveName !== expectedSharedDriveName) {
          continue;
        }
      }

      if (expectedParentFolderName) {
        const parentIndex = hierarchy.ancestors.findIndex(
          (a) => a.name.trim().toLowerCase() === expectedParentFolderName
        );

        if (parentIndex !== -1) {
          winningSpaceTypeId = spaceType.id as string;
          if (parentIndex + 1 < hierarchy.ancestors.length) {
            const childFolder = hierarchy.ancestors[parentIndex + 1];
            winningSpaceIdOrName = childFolder.id as string;
          } else {
            winningSpaceIdOrName = hierarchy.item.id as string;
          }
          break;
        }
      }
    }

    // 2. Evaluate Shared-Drive-backed space types second
    if (!winningSpaceTypeId) {
      const itemDriveId = hierarchy.driveId?.trim();
      const itemDriveName = hierarchy.driveName?.trim().toLowerCase();

      if (itemDriveId && (!itemDriveName || !dedicatedSharedDriveNames.has(itemDriveName))) {
        for (const spaceType of sharedDrivesTypes) {
          winningSpaceTypeId = spaceType.id as string;
          winningSpaceIdOrName = itemDriveId;
          break;
        }
      }
    }

    // 3. DocumentType inference from ancestor folder paths
    let documentTypeKey = this.inferDocumentTypeFromHierarchy(
      hierarchy,
      winningSpaceTypeId
    );

    // 4. Underscore-safe submittal filename fallback when ancestor folder paths do not resolve a DocumentType
    if (!documentTypeKey) {
      const filenameMatch = inferDocumentTypeFromFilename(hierarchy.item.name);
      if (filenameMatch) {
        documentTypeKey = filenameMatch;
        if (!winningSpaceTypeId) {
          winningSpaceTypeId = findSpaceTypeForDocumentType(spaceTypes, documentTypeKey);
        }
      }
    }

    return {
      ...(winningSpaceTypeId !== undefined ? { spaceTypeId: winningSpaceTypeId } : {}),
      ...(winningSpaceIdOrName !== undefined ? { spaceIdOrName: winningSpaceIdOrName } : {}),
      ...(documentTypeKey !== undefined ? { documentTypeKey } : {}),
    };
  }

  private inferDocumentTypeFromHierarchy(
    hierarchy: DriveItemHierarchy,
    spaceTypeId?: string
  ): string | undefined {
    if (spaceTypeId === 'proposals') {
      return 'communication-proposal';
    }

    const ancestorNames = hierarchy.ancestors.map((a) => a.name.trim().toLowerCase());

    if (
      ancestorNames.some(
        (name) =>
          name === 'communications' ||
          (name.includes('communication') && !name.includes('1 admin'))
      )
    ) {
      if (spaceTypeId === 'proposals') {
        return 'communication-proposal';
      }
    }

    const has6Construction = ancestorNames.some(
      (name) =>
        name === '6 construction' ||
        name.startsWith('6 construction/') ||
        name.startsWith('6 construction /')
    );
    if (has6Construction) {
      return 'submittal-arch';
    }

    const has3FFE = ancestorNames.some(
      (name) =>
        name === '3 ffe' ||
        name.startsWith('3 ffe/') ||
        name.startsWith('3 ffe /')
    );
    if (has3FFE) {
      return 'submittal-ffe';
    }

    const has1AdminComm = ancestorNames.some(
      (name) =>
        name === '1 admin/communication' ||
        name === '1 admin / communication'
    );
    if (has1AdminComm) {
      return 'communication-project';
    }

    const adminIndex = ancestorNames.findIndex((name) => name === '1 admin');
    if (
      adminIndex !== -1 &&
      ancestorNames.slice(adminIndex + 1).some((n) => n.includes('communication'))
    ) {
      return 'communication-project';
    }

    return undefined;
  }
}
