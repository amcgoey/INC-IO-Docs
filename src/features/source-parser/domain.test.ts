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
});
