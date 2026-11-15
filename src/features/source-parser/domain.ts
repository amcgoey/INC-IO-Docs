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
    const items = context.items ?? [];
    if (items.length === 0) {
      return {};
    }

    const firstItem = items[0];
    if (!firstItem || !firstItem.id) {
      return {};
    }

    const rawSpaceTypes = await this.spaceConfigPort.getDocumentSpaceTypes();
    const spaceTypes = rawSpaceTypes ?? [];

    const hierarchy = await this.driveContextPort.getItemHierarchy(firstItem.id);

    return this.inferFromDriveHierarchy(hierarchy, spaceTypes);
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
    const documentTypeKey = this.inferDocumentTypeFromHierarchy(
      hierarchy,
      winningSpaceTypeId
    );

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
