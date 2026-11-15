import { describe, it, expect, vi } from 'vitest';
import {
  SourceParserService,
  type DriveSourceContextPort,
  type SourceParserSpaceConfigPort,
  type SourceParserSpaceTypeConfig,
  type DriveItemHierarchy,
} from './domain';

describe('SourceParserService Pass 1 (inferRouting)', () => {
  const standardSpaceTypes: SourceParserSpaceTypeConfig[] = [
    {
      id: 'proposals',
      displayName: 'Proposals',
      spaceSchema: {
        allowedDocumentTypes: ['communication-proposal'],
        defaultDocumentType: 'communication-proposal',
      },
      storageConfig: {
        provider: 'google_drive',
        fetchMethod: 'folders',
        sharedDriveName: 'INC Marketing',
        parentFolderName: 'Opportunities',
      },
    },
    {
      id: 'projects',
      displayName: 'Projects',
      spaceSchema: {
        allowedDocumentTypes: [
          'communication-project',
          'submittal-ffe',
          'submittal-arch',
        ],
        defaultDocumentType: 'communication-project',
      },
      storageConfig: {
        provider: 'google_drive',
        fetchMethod: 'shared_drives',
      },
    },
  ];

  const mockSpaceConfigPort: SourceParserSpaceConfigPort = {
    getDocumentSpaceTypes: vi.fn().mockResolvedValue(standardSpaceTypes),
  };

  it('returns empty result when context items is empty or undefined', async () => {
    const mockDrivePort: DriveSourceContextPort = {
      getItemHierarchy: vi.fn(),
    };
    const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

    expect(await service.inferRouting({})).toEqual({});
    expect(await service.inferRouting({ items: [] })).toEqual({});
    expect(mockDrivePort.getItemHierarchy).not.toHaveBeenCalled();
  });

  it('stubs extractFields with empty fields', async () => {
    const mockDrivePort: DriveSourceContextPort = {
      getItemHierarchy: vi.fn(),
    };
    const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

    const result = await service.extractFields({
      documentTypeKey: 'communication-project',
      context: {},
    });
    expect(result).toEqual({ fields: {} });
  });

  describe('Folder-backed space routing (Proposals under Opportunities)', () => {
    it('infers proposals spaceType, proposal folder id, and communication-proposal for file inside proposal folder', async () => {
      const hierarchy: DriveItemHierarchy = {
        item: { id: 'file-1', name: 'Proposal_Draft.docx', mimeType: 'application/vnd.google-apps.document' },
        driveId: 'marketing-drive-id',
        driveName: 'INC Marketing',
        ancestors: [
          { id: 'opp-folder-id', name: 'Opportunities' },
          { id: 'proposal-acme-id', name: 'Acme Headquarters' },
          { id: 'comm-folder-id', name: 'Communications' },
        ],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue(hierarchy),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({ items: [{ id: 'file-1' }] });

      expect(result).toEqual({
        spaceTypeId: 'proposals',
        spaceIdOrName: 'proposal-acme-id',
        documentTypeKey: 'communication-proposal',
      });
    });

    it('infers proposals spaceType and proposal folder id when the proposal folder itself is selected', async () => {
      const hierarchy: DriveItemHierarchy = {
        item: { id: 'proposal-acme-id', name: 'Acme Headquarters', mimeType: 'application/vnd.google-apps.folder' },
        driveId: 'marketing-drive-id',
        driveName: 'INC Marketing',
        ancestors: [
          { id: 'opp-folder-id', name: 'Opportunities' },
        ],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue(hierarchy),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({ items: [{ id: 'proposal-acme-id' }] });

      expect(result).toEqual({
        spaceTypeId: 'proposals',
        spaceIdOrName: 'proposal-acme-id',
        documentTypeKey: 'communication-proposal',
      });
    });

    it('leaves spaceTypeId and spaceIdOrName undefined when file is in INC Marketing outside Opportunities', async () => {
      const hierarchy: DriveItemHierarchy = {
        item: { id: 'file-marketing-logo', name: 'Logo.png', mimeType: 'image/png' },
        driveId: 'marketing-drive-id',
        driveName: 'INC Marketing',
        ancestors: [
          { id: 'brand-assets-folder-id', name: 'Brand Assets' },
        ],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue(hierarchy),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({ items: [{ id: 'file-marketing-logo' }] });

      expect(result.spaceTypeId).toBeUndefined();
      expect(result.spaceIdOrName).toBeUndefined();
      expect(result.documentTypeKey).toBeUndefined();
    });
  });

  describe('Shared-Drive-backed space routing (Projects)', () => {
    it('infers projects spaceType and driveId for file in Project Shared Drive root', async () => {
      const hierarchy: DriveItemHierarchy = {
        item: { id: 'file-proj-root', name: 'Overview.pdf', mimeType: 'application/pdf' },
        driveId: 'project-drive-001',
        driveName: 'Project 1001 Alpha',
        ancestors: [],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue(hierarchy),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({ items: [{ id: 'file-proj-root' }] });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        spaceIdOrName: 'project-drive-001',
        documentTypeKey: undefined,
      });
    });

    it('infers communication-project for file inside 1 Admin/Communication in Project Shared Drive', async () => {
      const hierarchy: DriveItemHierarchy = {
        item: { id: 'file-comm', name: 'Letter.pdf', mimeType: 'application/pdf' },
        driveId: 'project-drive-001',
        driveName: 'Project 1001 Alpha',
        ancestors: [
          { id: 'admin-comm-id', name: '1 Admin/Communication' },
          { id: 'contact-folder-id', name: 'Acme Corp' },
        ],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue(hierarchy),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({ items: [{ id: 'file-comm' }] });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        spaceIdOrName: 'project-drive-001',
        documentTypeKey: 'communication-project',
      });
    });

    it('infers submittal-ffe for file inside 3 FFE in Project Shared Drive', async () => {
      const hierarchy: DriveItemHierarchy = {
        item: { id: 'file-chair', name: 'Specs.pdf', mimeType: 'application/pdf' },
        driveId: 'project-drive-001',
        driveName: 'Project 1001 Alpha',
        ancestors: [
          { id: 'ffe-id', name: '3 FFE' },
          { id: 'sub-folder-id', name: '05 Submittals' },
        ],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue(hierarchy),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({ items: [{ id: 'file-chair' }] });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        spaceIdOrName: 'project-drive-001',
        documentTypeKey: 'submittal-ffe',
      });
    });

    it('infers submittal-arch for file inside 6 Construction/Submittals in Project Shared Drive', async () => {
      const hierarchy: DriveItemHierarchy = {
        item: { id: 'file-steel', name: 'Steel_Submittal.pdf', mimeType: 'application/pdf' },
        driveId: 'project-drive-001',
        driveName: 'Project 1001 Alpha',
        ancestors: [
          { id: 'const-sub-id', name: '6 Construction/Submittals' },
        ],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue(hierarchy),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({ items: [{ id: 'file-steel' }] });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        spaceIdOrName: 'project-drive-001',
        documentTypeKey: 'submittal-arch',
      });
    });

    it('infers submittal-arch for file inside 6 Construction in Project Shared Drive', async () => {
      const hierarchy: DriveItemHierarchy = {
        item: { id: 'file-concrete', name: 'Concrete.pdf', mimeType: 'application/pdf' },
        driveId: 'project-drive-001',
        driveName: 'Project 1001 Alpha',
        ancestors: [
          { id: 'const-id', name: '6 Construction' },
          { id: 'submittals-id', name: 'Submittals' },
        ],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue(hierarchy),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({ items: [{ id: 'file-concrete' }] });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        spaceIdOrName: 'project-drive-001',
        documentTypeKey: 'submittal-arch',
      });
    });
  });

  describe('My Drive items', () => {
    it('leaves spaceIdOrName undefined for items in My Drive (no driveId)', async () => {
      const hierarchy: DriveItemHierarchy = {
        item: { id: 'file-my-drive', name: 'Notes.pdf', mimeType: 'application/pdf' },
        ancestors: [
          { id: 'folder-personal', name: 'Personal' },
        ],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue(hierarchy),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({ items: [{ id: 'file-my-drive' }] });

      expect(result.spaceTypeId).toBeUndefined();
      expect(result.spaceIdOrName).toBeUndefined();
      expect(result.documentTypeKey).toBeUndefined();
    });
  });

  describe('Submittal filename fallback (Ticket #291)', () => {
    it('infers submittal-arch and preserves project spaceId for CSI filename in unmatched folder', async () => {
      const hierarchy: DriveItemHierarchy = {
        item: {
          id: 'file-csi-1',
          name: '071200-001_Waterproofing.pdf',
          mimeType: 'application/pdf',
        },
        driveId: 'project-drive-001',
        driveName: 'Project 1001 Alpha',
        ancestors: [{ id: 'folder-unfiled', name: 'Unfiled' }],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue(hierarchy),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({ items: [{ id: 'file-csi-1' }] });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        spaceIdOrName: 'project-drive-001',
        documentTypeKey: 'submittal-arch',
      });
    });

    it('infers submittal-arch and dynamically resolves spaceTypeId in My Drive for CSI section filename with revision', async () => {
      const hierarchy: DriveItemHierarchy = {
        item: {
          id: 'file-csi-rev',
          name: '071200-001-A Waterproofing - 260315 PMG.pdf',
          mimeType: 'application/pdf',
        },
        ancestors: [],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue(hierarchy),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({ items: [{ id: 'file-csi-rev' }] });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        spaceIdOrName: undefined,
        documentTypeKey: 'submittal-arch',
      });
    });

    it('infers submittal-ffe and dynamically resolves spaceTypeId in My Drive for FF&E spec tag filename', async () => {
      const hierarchy: DriveItemHierarchy = {
        item: {
          id: 'file-ffe-tag',
          name: 'CG104-A_Chair.pdf',
          mimeType: 'application/pdf',
        },
        ancestors: [],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue(hierarchy),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({ items: [{ id: 'file-ffe-tag' }] });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        spaceIdOrName: undefined,
        documentTypeKey: 'submittal-ffe',
      });
    });

    it('infers submittal-ffe for bounded proximity keywords (FF&E ... Submittal)', async () => {
      const hierarchy: DriveItemHierarchy = {
        item: {
          id: 'file-ffe-prox',
          name: 'Project 100 - FF&E Package Seating Submittal.pdf',
          mimeType: 'application/pdf',
        },
        driveId: 'project-drive-001',
        driveName: 'Project 1001 Alpha',
        ancestors: [],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue(hierarchy),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({ items: [{ id: 'file-ffe-prox' }] });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        spaceIdOrName: 'project-drive-001',
        documentTypeKey: 'submittal-ffe',
      });
    });

    it('infers submittal-ffe for reverse proximity keywords (Submittal ... FFE)', async () => {
      const hierarchy: DriveItemHierarchy = {
        item: {
          id: 'file-ffe-rev-prox',
          name: 'Submittal_04_FFE_Tables.pdf',
          mimeType: 'application/pdf',
        },
        ancestors: [],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue(hierarchy),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({ items: [{ id: 'file-ffe-rev-prox' }] });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        spaceIdOrName: undefined,
        documentTypeKey: 'submittal-ffe',
      });
    });

    it('leaves documentTypeKey and spaceTypeId undefined when filename does not match submittal patterns in My Drive', async () => {
      const hierarchy: DriveItemHierarchy = {
        item: {
          id: 'file-unmatched',
          name: 'Meeting_Notes_2026.pdf',
          mimeType: 'application/pdf',
        },
        ancestors: [],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue(hierarchy),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({ items: [{ id: 'file-unmatched' }] });

      expect(result.spaceTypeId).toBeUndefined();
      expect(result.spaceIdOrName).toBeUndefined();
      expect(result.documentTypeKey).toBeUndefined();
    });
  });

  describe('Multi-item Drive selection precedence (Ticket #291)', () => {
    it('locks winning spaceTypeId from first item and accepts missing spaceId from subsequent compatible item', async () => {
      const hierarchyItem0: DriveItemHierarchy = {
        item: { id: 'file-0', name: '071200-001_Waterproofing.pdf', mimeType: 'application/pdf' },
        ancestors: [], // My Drive
      };
      const hierarchyItem1: DriveItemHierarchy = {
        item: { id: 'file-1', name: 'Notes.pdf', mimeType: 'application/pdf' },
        driveId: 'project-drive-001',
        driveName: 'Project 1001 Alpha',
        ancestors: [],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockImplementation(async (id: string) => {
          if (id === 'file-0') return hierarchyItem0;
          if (id === 'file-1') return hierarchyItem1;
          throw new Error('Not found');
        }),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({
        items: [{ id: 'file-0' }, { id: 'file-1' }],
      });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        spaceIdOrName: 'project-drive-001',
        documentTypeKey: 'submittal-arch',
      });
    });

    it('ignores incompatible spaceType items after winning spaceTypeId is locked', async () => {
      const hierarchyProject: DriveItemHierarchy = {
        item: { id: 'file-proj', name: 'Notes.pdf', mimeType: 'application/pdf' },
        driveId: 'project-drive-001',
        driveName: 'Project 1001 Alpha',
        ancestors: [],
      };
      const hierarchyProposal: DriveItemHierarchy = {
        item: { id: 'file-prop', name: 'Proposal.pdf', mimeType: 'application/pdf' },
        driveId: 'marketing-drive-id',
        driveName: 'INC Marketing',
        ancestors: [
          { id: 'opp-folder-id', name: 'Opportunities' },
          { id: 'proposal-acme-id', name: 'Acme Headquarters' },
        ],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockImplementation(async (id: string) => {
          if (id === 'file-proj') return hierarchyProject;
          if (id === 'file-prop') return hierarchyProposal;
          throw new Error('Not found');
        }),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({
        items: [{ id: 'file-proj' }, { id: 'file-prop' }],
      });

      // Item 0 locks 'projects' and 'project-drive-001'.
      // Item 1 is 'proposals', so its spaceId and docType must be ignored.
      expect(result).toEqual({
        spaceTypeId: 'projects',
        spaceIdOrName: 'project-drive-001',
        documentTypeKey: undefined,
      });
    });

    it('preserves first resolved spaceId and documentTypeKey over subsequent compatible items', async () => {
      const hierarchyFirst: DriveItemHierarchy = {
        item: { id: 'file-ffe', name: 'Chairs.pdf', mimeType: 'application/pdf' },
        driveId: 'project-drive-001',
        driveName: 'Project 1001 Alpha',
        ancestors: [{ id: 'ffe-folder', name: '3 FFE' }],
      };
      const hierarchySecond: DriveItemHierarchy = {
        item: { id: 'file-arch', name: 'Steel.pdf', mimeType: 'application/pdf' },
        driveId: 'project-drive-002',
        driveName: 'Project 1002 Beta',
        ancestors: [{ id: 'const-folder', name: '6 Construction' }],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockImplementation(async (id: string) => {
          if (id === 'file-ffe') return hierarchyFirst;
          if (id === 'file-arch') return hierarchySecond;
          throw new Error('Not found');
        }),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({
        items: [{ id: 'file-ffe' }, { id: 'file-arch' }],
      });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        spaceIdOrName: 'project-drive-001',
        documentTypeKey: 'submittal-ffe',
      });
    });

    it('skips neutral items without spaceTypeId until an item establishes positive spaceTypeId', async () => {
      const hierarchyNeutral: DriveItemHierarchy = {
        item: { id: 'file-neutral', name: 'General_Doc.pdf', mimeType: 'application/pdf' },
        ancestors: [], // My Drive
      };
      const hierarchyProposal: DriveItemHierarchy = {
        item: { id: 'file-prop', name: 'Proposal_Doc.pdf', mimeType: 'application/pdf' },
        driveId: 'marketing-drive-id',
        driveName: 'INC Marketing',
        ancestors: [
          { id: 'opp-folder-id', name: 'Opportunities' },
          { id: 'proposal-acme-id', name: 'Acme Headquarters' },
        ],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockImplementation(async (id: string) => {
          if (id === 'file-neutral') return hierarchyNeutral;
          if (id === 'file-prop') return hierarchyProposal;
          throw new Error('Not found');
        }),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({
        items: [{ id: 'file-neutral' }, { id: 'file-prop' }],
      });

      expect(result).toEqual({
        spaceTypeId: 'proposals',
        spaceIdOrName: 'proposal-acme-id',
        documentTypeKey: 'communication-proposal',
      });
    });
  });

  describe('Drive API error degradation and status messages (Ticket #291)', () => {
    it('catches systemic error or failure to load selected item and returns Manifest defaults with statusMessages', async () => {
      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockRejectedValue(new Error('Drive API 429: Rate limit exceeded')),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({
        items: [{ id: 'file-throttled' }],
      });

      expect(result).toEqual({
        statusMessages: [
          'Could not inspect Google Drive folder hierarchy; please verify Document Space and Document Type.',
        ],
      });
      expect(result.spaceTypeId).toBeUndefined();
      expect(result.spaceIdOrName).toBeUndefined();
      expect(result.documentTypeKey).toBeUndefined();
    });

    it('does not emit statusMessages when parent folder 403/404 boundary results in partial hierarchy', async () => {
      // Partial hierarchy: empty ancestors because parent was 403, but file has CSI filename
      const partialHierarchy: DriveItemHierarchy = {
        item: {
          id: 'file-boundary',
          name: '071200-001_Waterproofing.pdf',
          mimeType: 'application/pdf',
        },
        driveId: 'project-drive-001',
        driveName: 'Project 1001 Alpha',
        ancestors: [],
      };

      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue(partialHierarchy),
      };
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      const result = await service.inferRouting({
        items: [{ id: 'file-boundary' }],
      });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        spaceIdOrName: 'project-drive-001',
        documentTypeKey: 'submittal-arch',
      });
      expect(result.statusMessages).toBeUndefined();
    });
  });
});
