import { describe, it, expect, vi } from 'vitest';
import jsonLogic from 'json-logic-js';
import {
  SourceParserService,
  extractTextFromHtml,
  matchCandidateSpaces,
  cleanSubject,
  parseDateToYymmdd,
  normalizeHtmlBodyForPass2,
  splitRfc5322Recipients,
  parseRecipient,
  getCandidateAttachmentNames,
  matchesCorrelatedCode,
  FFE_PROXIMITY_REGEX_1,
  FFE_PROXIMITY_REGEX_2,
  PDF_FORM_ENCRYPTED_ERROR_MESSAGE,
  DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE,
  DRIVE_METADATA_EXTRACT_ERROR_MESSAGE,
  formatAmbiguousFormFieldMessage,
} from './domain';
import type {
  CanonicalOptionsProviderPort,
  DriveSourceContextPort,
  SourceParserSpaceConfigPort,
  SourceParserSpaceTypeConfig,
  DriveItemHierarchy,
  FormExtractorPort,
  FormTemplateParserPort,
  PredicateEvaluatorPort,
} from './ports';
import { HandlebarsAdapter } from '../../infrastructure/template-engine/handlebars-adapter';

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

    it('infers submittal-arch for varied uniform-delimiter CSI formats while rejecting ISO dates and mixed delimiters (#310)', async () => {
      const positiveCases = [
        '07 12 00 - 1_v1_Waterproofing.pdf',
        '07.12.00_01_Waterproofing.pdf',
        '07.12.00_Submittal_002_Rev1_Waterproofing_2026-11-15.pdf',
        'Section 07-12-00 Submittal #12 - Fluid Applied Waterproofing.pdf',
      ];
      for (const name of positiveCases) {
        const mockDrive: DriveSourceContextPort = {
          getItemHierarchy: vi.fn().mockResolvedValue({
            item: { id: 'f-pos', name, mimeType: 'application/pdf' },
            driveId: 'project-drive-001',
            driveName: 'Project 1001 Alpha',
            ancestors: [{ id: 'folder-unfiled', name: 'Unfiled' }],
          }),
        };
        const service = new SourceParserService(mockDrive, mockSpaceConfigPort);
        const driveRes = await service.inferRouting({ items: [{ id: 'f-pos' }] });
        expect(driveRes.documentTypeKey, `Drive: ${name}`).toBe('submittal-arch');

        const gmailRes = await service.inferRouting({
          email: { id: 'msg-pos', subject: name.replace(/\.pdf$/, '') },
        });
        expect(gmailRes.documentTypeKey, `Gmail: ${name}`).toBe('submittal-arch');
      }

      const negativeCases = [
        '2026-11-15_Meeting_Notes.pdf',
        'Report_2026-11-15_01.pdf',
        '07 12.00 - 1_Mixed.pdf',
      ];
      for (const name of negativeCases) {
        const mockDrive: DriveSourceContextPort = {
          getItemHierarchy: vi.fn().mockResolvedValue({
            item: { id: 'f-neg', name, mimeType: 'application/pdf' },
            driveId: 'project-drive-001',
            driveName: 'Project 1001 Alpha',
            ancestors: [{ id: 'folder-unfiled', name: 'Unfiled' }],
          }),
        };
        const service = new SourceParserService(mockDrive, mockSpaceConfigPort);
        const driveRes = await service.inferRouting({ items: [{ id: 'f-neg' }] });
        expect(driveRes.documentTypeKey, `Drive negative: ${name}`).toBeUndefined();

        const gmailRes = await service.inferRouting({
          email: { id: 'msg-neg', subject: name.replace(/\.pdf$/, '') },
        });
        expect(gmailRes.documentTypeKey, `Gmail negative: ${name}`).toBeUndefined();
      }
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

    it('infers submittal-ffe for spaced/hyphenated FF&E spec tags while rejecting lowercase prose ("in 100 days", "at 120V panel") and partial code prefixes (#311)', async () => {
      const positiveCases = [
        'CG-104 v2',
        'CG-104_v2_Fil_Doux.pdf',
        'LT 159A_R0.pdf',
        'LT 159A_R0',
        'CG104-A_Berman_Falk.pdf',
        'CG-104-A.pdf',
        'CG-104_Fil_Doux.pdf',
        'XCG104-Z - CG104-A',
      ];
      for (const name of positiveCases) {
        const mockDrive: DriveSourceContextPort = {
          getItemHierarchy: vi.fn().mockResolvedValue({
            item: { id: 'f-ffe-pos', name, mimeType: 'application/pdf' },
            driveId: 'project-drive-001',
            driveName: 'Project 1001 Alpha',
            ancestors: [{ id: 'folder-unfiled', name: 'Unfiled' }],
          }),
        };
        const service = new SourceParserService(mockDrive, mockSpaceConfigPort);
        const driveRes = await service.inferRouting({ items: [{ id: 'f-ffe-pos' }] });
        expect(driveRes.documentTypeKey, `Drive: ${name}`).toBe('submittal-ffe');

        const gmailRes = await service.inferRouting({
          email: { id: 'msg-ffe-pos', subject: name.replace(/\.pdf$/, '') },
        });
        expect(gmailRes.documentTypeKey, `Gmail: ${name}`).toBe('submittal-ffe');
      }

      const negativeCases = [
        'in 100 days',
        'at 120V panel',
        'Meeting in 100 days about at 120V panel',
        'XCG104-Z',
        'PO12345',
        '2026-11-15_Notes.pdf',
      ];
      for (const name of negativeCases) {
        const mockDrive: DriveSourceContextPort = {
          getItemHierarchy: vi.fn().mockResolvedValue({
            item: { id: 'f-ffe-neg', name, mimeType: 'application/pdf' },
            driveId: 'project-drive-001',
            driveName: 'Project 1001 Alpha',
            ancestors: [{ id: 'folder-unfiled', name: 'Unfiled' }],
          }),
        };
        const service = new SourceParserService(mockDrive, mockSpaceConfigPort);
        const driveRes = await service.inferRouting({ items: [{ id: 'f-ffe-neg' }] });
        expect(driveRes.documentTypeKey, `Drive negative: ${name}`).toBeUndefined();

        const gmailRes = await service.inferRouting({
          email: { id: 'msg-ffe-neg', subject: name.replace(/\.pdf$/, '') },
        });
        expect(gmailRes.documentTypeKey, `Gmail negative: ${name}`).toBeUndefined();
      }
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

  describe('extractTextFromHtml utility (Ticket #292)', () => {
    it('returns empty string for null, undefined, or empty input', () => {
      expect(extractTextFromHtml(undefined)).toBe('');
      // @ts-expect-error testing invalid runtime null input
      expect(extractTextFromHtml(null)).toBe('');
      expect(extractTextFromHtml('')).toBe('');
    });

    it('strips tags and collapses spaces without concatenating text', () => {
      const html = '<p>First paragraph</p><p>Second paragraph</p>';
      expect(extractTextFromHtml(html)).toBe('First paragraph Second paragraph');
    });

    it('strips <script> and <style> tags and their contents', () => {
      const html = '<div>Header<script>alert("bad")</script><style>.cls{color:red;}</style> Body</div>';
      expect(extractTextFromHtml(html)).toBe('Header Body');
    });

    it('decodes common HTML entities (&amp;, &nbsp;, &lt;, &gt;, &quot;, &#39;, &#x27;)', () => {
      const html =
        '<p>FF&amp;E &lt;Submittal&gt; package &#39;2026&#39; &#x27;A&#x27; &quot;Final&quot;&nbsp;approved &amp;nbsp;</p>';
      expect(extractTextFromHtml(html)).toBe('FF&E <Submittal> package \'2026\' \'A\' "Final" approved &nbsp;');
    });
  });

  describe('Gmail Pass 1 routing heuristics (Ticket #292)', () => {
    const mockDrivePort: DriveSourceContextPort = {
      getItemHierarchy: vi.fn(),
    };

    it('infers submittal-ffe and projects when attachment filename matches FF&E spec tag', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        email: {
          id: 'msg-1',
          attachments: [{ id: 'att-1', name: 'CG104-A_Chair.pdf' }],
        },
      });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        documentTypeKey: 'submittal-ffe',
      });
      expect(mockDrivePort.getItemHierarchy).not.toHaveBeenCalled();
    });

    it('infers submittal-ffe and projects when attachment filename matches bounded FF&E keyword', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        email: {
          id: 'msg-1',
          attachments: [{ id: 'att-1', name: 'FFE Submittal Package.pdf' }],
        },
      });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        documentTypeKey: 'submittal-ffe',
      });
    });

    it('infers submittal-arch and projects when attachment filename matches CSI section number', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        email: {
          id: 'msg-1',
          attachments: [{ id: 'att-1', name: '071200-001_Waterproofing.pdf' }],
        },
      });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        documentTypeKey: 'submittal-arch',
      });
    });

    it('evaluates attachments in order and lets the first matching attachment determine document type', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        email: {
          id: 'msg-1',
          attachments: [
            { id: 'att-1', name: 'CG104-A_Chair.pdf' },
            { id: 'att-2', name: '071200-001_Waterproofing.pdf' },
          ],
        },
      });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        documentTypeKey: 'submittal-ffe',
      });
    });

    it('inspects context.items attachment filenames in order when email.attachments is omitted', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        items: [{ id: 'att-1', name: '071200-001-A Waterproofing - 260315 PMG.pdf' }],
        email: {
          id: 'msg-1',
          subject: 'General Update',
        },
      });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        documentTypeKey: 'submittal-arch',
      });
    });

    it('inspects email subject when attachment filenames do not match', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const resultFfe = await service.inferRouting({
        email: {
          id: 'msg-1',
          subject: 'Review needed: FF&E Submittal for Ballroom',
          attachments: [{ id: 'att-1', name: 'Notes.pdf' }],
        },
      });

      expect(resultFfe).toEqual({
        spaceTypeId: 'projects',
        documentTypeKey: 'submittal-ffe',
      });

      const resultArchCsi = await service.inferRouting({
        email: {
          id: 'msg-2',
          subject: '071200-001 Waterproofing Specs',
          attachments: [{ id: 'att-1', name: 'Notes.pdf' }],
        },
      });

      expect(resultArchCsi).toEqual({
        spaceTypeId: 'projects',
        documentTypeKey: 'submittal-arch',
      });
    });

    it('infers submittal-arch from architectural submittal notification marker in subject (Submittal #12)', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        email: {
          id: 'msg-1',
          subject: 'Submittal #12: Structural Steel Shop Drawings',
        },
      });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        documentTypeKey: 'submittal-arch',
      });
    });

    it('infers submittal-arch from Procore submittal email header in subject or body', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const resultSubject = await service.inferRouting({
        email: {
          id: 'msg-1',
          subject: 'Procore: Submittal Sent for Review',
        },
      });

      expect(resultSubject).toEqual({
        spaceTypeId: 'projects',
        documentTypeKey: 'submittal-arch',
      });

      const resultBody = await service.inferRouting({
        email: {
          id: 'msg-2',
          subject: 'Notification from General Contractor',
          plainTextBody: 'Procore - Submittal #105 has been assigned to you for review.',
        },
      });

      expect(resultBody).toEqual({
        spaceTypeId: 'projects',
        documentTypeKey: 'submittal-arch',
      });
    });

    it('infers submittal-arch from Autodesk Build submittal email header in subject or body', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const resultSubject = await service.inferRouting({
        email: {
          id: 'msg-1',
          subject: 'Autodesk Build - Submittal Package for Review',
        },
      });

      expect(resultSubject).toEqual({
        spaceTypeId: 'projects',
        documentTypeKey: 'submittal-arch',
      });
    });

    it('inspects plainTextBody when attachments and subject do not match', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        email: {
          id: 'msg-1',
          subject: 'Quick question about schedule',
          plainTextBody: 'Please find attached the FF&E Submittal for the restaurant booths.',
          attachments: [{ id: 'att-1', name: 'Document.pdf' }],
        },
      });

      expect(result).toEqual({
        spaceTypeId: 'projects',
        documentTypeKey: 'submittal-ffe',
      });
    });

    it('derives searchable text from htmlBody when plainTextBody is empty or absent, stripping tags and decoding entities', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const resultFfe = await service.inferRouting({
        email: {
          id: 'msg-1',
          subject: 'Project Inquiry',
          plainTextBody: '',
          htmlBody: '<p>Attached is the <strong>FF&amp;E &nbsp; Submittal</strong> for guestrooms.</p>',
        },
      });

      expect(resultFfe).toEqual({
        spaceTypeId: 'projects',
        documentTypeKey: 'submittal-ffe',
      });

      const resultArch = await service.inferRouting({
        email: {
          id: 'msg-2',
          subject: 'Project Inquiry',
          htmlBody: '<div>Please see <span class="badge">Submittal #45</span> details below.</div>',
        },
      });

      expect(resultArch).toEqual({
        spaceTypeId: 'projects',
        documentTypeKey: 'submittal-arch',
      });
    });

    it('returns empty result (undefined spaceTypeId and documentTypeKey) when email has no submittal signals', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        email: {
          id: 'msg-1',
          subject: 'Meeting Minutes Oct 19',
          plainTextBody: 'Here are the minutes from today\'s kickoff meeting.',
          attachments: [{ id: 'att-1', name: 'MeetingMinutes.pdf' }],
        },
      });

      expect(result).toEqual({});
      expect(result.spaceTypeId).toBeUndefined();
      expect(result.documentTypeKey).toBeUndefined();
    });
  });

  describe('Gmail candidateSpaces DocumentSpace inference (Ticket #293)', () => {
    const mockDrivePort: DriveSourceContextPort = {
      getItemHierarchy: vi.fn(),
    };

    const candidateSpaces = [
      { id: 'proj-skyline', name: 'Skyline Tower', typeId: 'projects' },
      { id: 'proj-phase1', name: 'Phase 1 (Shell)', typeId: 'projects' },
      { id: 'proj-hq', name: 'HQ', typeId: 'projects' },
      { id: 'proj-single', name: 'A', typeId: 'projects' },
      { id: 'prop-grand-hotel', name: 'Grand Hotel', typeId: 'proposals' },
      { id: 'prop-grand-renov', name: 'Grand Hotel Renovation', typeId: 'proposals' },
      { id: 'proj-ocean', name: 'Ocean Breeze', typeId: 'projects' },
    ];

    it('matches candidate space in subject on token boundaries and adopts spaceIdOrName and typeId', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        candidateSpaces,
        email: {
          id: 'msg-1',
          subject: 'Re: Skyline Tower - Weekly Progress Update',
          plainTextBody: 'All trades on schedule.',
        },
      });

      expect(result.spaceTypeId).toBe('projects');
      expect(result.spaceIdOrName).toBe('proj-skyline');
      expect(result.documentTypeKey).toBeUndefined();
    });

    it('matches candidate space with punctuation and parentheses in name', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        candidateSpaces,
        email: {
          id: 'msg-1',
          subject: '[Phase 1 (Shell)] Inspection Checklist',
          plainTextBody: 'Please review.',
        },
      });

      expect(result.spaceTypeId).toBe('projects');
      expect(result.spaceIdOrName).toBe('proj-phase1');
    });

    it('does not false-positive match when space name is a prefix/suffix of a longer token', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        candidateSpaces,
        email: {
          id: 'msg-1',
          subject: 'Update on Skyline Towers and TheSkyline Tower',
          plainTextBody: 'Nothing to report.',
        },
      });

      expect(result.spaceIdOrName).toBeUndefined();
      expect(result.spaceTypeId).toBeUndefined();
    });

    it('enforces length guards: ignores 1-character space names', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        candidateSpaces,
        email: {
          id: 'msg-1',
          subject: 'A great update for building A',
        },
      });

      expect(result.spaceIdOrName).toBeUndefined();
    });

    it('enforces length guards: requires exact case-sensitive match in subject for 2-3 character names', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);

      // Exact case in subject -> matches
      const matchExact = await service.inferRouting({
        candidateSpaces,
        email: {
          id: 'msg-1',
          subject: 'Meeting at HQ today',
        },
      });
      expect(matchExact.spaceIdOrName).toBe('proj-hq');

      // Lowercase in subject -> ignored
      const matchLower = await service.inferRouting({
        candidateSpaces,
        email: {
          id: 'msg-2',
          subject: 'Meeting at hq today',
        },
      });
      expect(matchLower.spaceIdOrName).toBeUndefined();
    });

    it('enforces length guards: ignores 2-3 character space names in body text', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        candidateSpaces,
        email: {
          id: 'msg-1',
          subject: 'Meeting notes',
          plainTextBody: 'We will meet at HQ next Tuesday.',
        },
      });

      expect(result.spaceIdOrName).toBeUndefined();
    });

    it('evaluates subject first; does not evaluate body when subject matches', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        candidateSpaces,
        email: {
          id: 'msg-1',
          subject: 'Re: Skyline Tower status',
          plainTextBody: 'Also mentions Ocean Breeze in body.',
        },
      });

      expect(result.spaceIdOrName).toBe('proj-skyline');
      expect(result.spaceTypeId).toBe('projects');
    });

    it('evaluates body text when subject yields zero matches', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        candidateSpaces,
        email: {
          id: 'msg-1',
          subject: 'General status report',
          plainTextBody: 'Please review progress on Skyline Tower.',
        },
      });

      expect(result.spaceIdOrName).toBe('proj-skyline');
      expect(result.spaceTypeId).toBe('projects');
    });

    it('evaluates body text from stripped htmlBody when plainTextBody is empty and subject yields zero matches', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        candidateSpaces,
        email: {
          id: 'msg-1',
          subject: 'General status report',
          htmlBody: '<div>Please see update on <b>Skyline Tower</b>.</div>',
        },
      });

      expect(result.spaceIdOrName).toBe('proj-skyline');
      expect(result.spaceTypeId).toBe('projects');
    });

    it('tie-breaking: longest match wins when every other matched space name is a strict substring', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        candidateSpaces,
        email: {
          id: 'msg-1',
          subject: 'Grand Hotel Renovation Proposal Update',
        },
      });

      // Both "Grand Hotel" and "Grand Hotel Renovation" match, but "Grand Hotel" is a strict substring
      expect(result.spaceIdOrName).toBe('prop-grand-renov');
      expect(result.spaceTypeId).toBe('proposals');
    });

    it('tie-breaking: collision returns undefined spaceIdOrName when distinct non-overlapping spaces match in subject', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        candidateSpaces,
        email: {
          id: 'msg-1',
          subject: 'Joint review: Skyline Tower and Ocean Breeze',
          plainTextBody: 'Only Skyline Tower mentioned here.',
        },
      });

      // Collision in subject leaves spaceIdOrName undefined and does not fall back to body
      expect(result.spaceIdOrName).toBeUndefined();
    });

    it('tie-breaking: collision returns undefined spaceIdOrName when distinct non-overlapping spaces match in body', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        candidateSpaces,
        email: {
          id: 'msg-1',
          subject: 'Weekly coordination call',
          plainTextBody: 'We will coordinate work between Skyline Tower and Ocean Breeze.',
        },
      });

      expect(result.spaceIdOrName).toBeUndefined();
    });

    it('combines submittal documentTypeKey and candidate spaceIdOrName when spaceTypeId is compatible', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        candidateSpaces,
        email: {
          id: 'msg-1',
          subject: 'Submittal 071200-001 Waterproofing for Skyline Tower',
          attachments: [{ id: 'att-1', name: '071200-001_Waterproofing.pdf' }],
        },
      });

      expect(result.documentTypeKey).toBe('submittal-arch');
      expect(result.spaceTypeId).toBe('projects');
      expect(result.spaceIdOrName).toBe('proj-skyline');
    });

    it('does not attach spaceIdOrName when winning candidate space is incompatible with submittal spaceTypeId', async () => {
      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        candidateSpaces,
        email: {
          id: 'msg-1',
          subject: 'Submittal 071200-001 Waterproofing for Grand Hotel',
          attachments: [{ id: 'att-1', name: '071200-001_Waterproofing.pdf' }],
        },
      });

      // submittal-arch requires 'projects', but Grand Hotel is 'proposals'
      expect(result.documentTypeKey).toBe('submittal-arch');
      expect(result.spaceTypeId).toBe('projects');
      expect(result.spaceIdOrName).toBeUndefined();
    });
  });

  describe('Google Drive URL delegation and email fallback (Ticket #294)', () => {
    const candidateSpaces = [
      { id: 'proj-skyline', name: 'Skyline Tower', typeId: 'projects' },
      { id: 'prop-grand-hotel', name: 'Grand Hotel', typeId: 'proposals' },
    ];

    it('delegates to Google Drive hierarchy first when items are present and resolves all fields from Drive', async () => {
      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue({
          item: { id: 'file-prop-comm', name: 'Proposal_Cover.pdf' },
          driveName: 'INC Marketing',
          ancestors: [
            { id: 'inc-mkt', name: 'INC Marketing' },
            { id: 'opp', name: 'Opportunities' },
            { id: 'prop-acme', name: 'Acme Proposal' },
            { id: 'comm', name: 'Communications' },
          ],
        }),
      };

      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        items: [{ id: 'file-prop-comm' }],
        isDriveUrl: true,
        candidateSpaces,
        email: {
          id: 'msg-1',
          subject: 'Weekly update for Skyline Tower',
        },
      });

      expect(mockDrivePort.getItemHierarchy).toHaveBeenCalledWith('file-prop-comm');
      expect(result).toEqual({
        spaceTypeId: 'proposals',
        spaceIdOrName: 'prop-acme',
        documentTypeKey: 'communication-proposal',
      });
    });

    it('falls back to email candidateSpaces when Drive item leaves spaceIdOrName undefined (e.g. in My Drive)', async () => {
      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue({
          item: { id: 'file-csi-my-drive', name: '071200-001_Waterproofing.pdf' },
          ancestors: [],
          driveId: undefined,
        }),
      };

      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        items: [{ id: 'file-csi-my-drive' }],
        isDriveUrl: true,
        candidateSpaces,
        email: {
          id: 'msg-1',
          subject: 'Review attached submittal for Skyline Tower',
        },
      });

      expect(mockDrivePort.getItemHierarchy).toHaveBeenCalledWith('file-csi-my-drive');
      expect(result).toEqual({
        spaceTypeId: 'projects',
        spaceIdOrName: 'proj-skyline',
        documentTypeKey: 'submittal-arch',
      });
    });

    it('falls back to email heuristics for documentTypeKey when Drive hierarchy/filename leaves documentTypeKey undefined', async () => {
      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue({
          item: { id: 'file-generic', name: 'General_Report.pdf' },
          ancestors: [],
          driveId: 'proj-skyline',
          driveName: 'Skyline Project Drive',
        }),
      };

      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        items: [{ id: 'file-generic' }],
        isDriveUrl: true,
        candidateSpaces,
        email: {
          id: 'msg-1',
          subject: 'FF&E Submittal Package for Review',
        },
      });

      expect(mockDrivePort.getItemHierarchy).toHaveBeenCalledWith('file-generic');
      expect(result).toEqual({
        spaceTypeId: 'projects',
        spaceIdOrName: 'proj-skyline',
        documentTypeKey: 'submittal-ffe',
      });
    });

    it('surfaces DRIVE_HIERARCHY_ERROR_MESSAGE and falls back to email heuristics on systemic Drive error', async () => {
      const mockDrivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockRejectedValue(new Error('500 Internal Server Error')),
      };

      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
      const result = await service.inferRouting({
        items: [{ id: 'file-throttled' }],
        isDriveUrl: true,
        candidateSpaces,
        email: {
          id: 'msg-1',
          subject: 'Submittal 071200-001 Waterproofing for Skyline Tower',
        },
      });

      expect(mockDrivePort.getItemHierarchy).toHaveBeenCalledWith('file-throttled');
      expect(result).toEqual({
        spaceTypeId: 'projects',
        spaceIdOrName: 'proj-skyline',
        documentTypeKey: 'submittal-arch',
        statusMessages: [
          'Could not inspect Google Drive folder hierarchy; please verify Document Space and Document Type.',
        ],
      });
    });
  });

  describe('Gmail labels hydration & label-aware Pass 1 routing (Ticket #302)', () => {
    const mockDrivePort: DriveSourceContextPort = {
      getItemHierarchy: vi.fn(),
    };

    const candidateSpaces = [
      { id: 'proj-123', name: '123 Main St', typeId: 'projects' },
      { id: 'proj-skyline', name: 'Skyline Tower', typeId: 'projects' },
    ];

    describe('FFE Proximity Regular Expressions with hierarchical delimiters and plural forms', () => {
      it('matches hierarchical label with slash delimiter and plural Submittals', () => {
        expect(FFE_PROXIMITY_REGEX_1.test('Projects/FF&E/Submittals')).toBe(true);
        expect(FFE_PROXIMITY_REGEX_1.test('FF&E Submittals')).toBe(true);
        expect(FFE_PROXIMITY_REGEX_1.test('FFE Submittal')).toBe(true);
        expect(FFE_PROXIMITY_REGEX_2.test('Submittals/FF&E')).toBe(true);
        expect(FFE_PROXIMITY_REGEX_2.test('Submittals / FF&E')).toBe(true);
        expect(FFE_PROXIMITY_REGEX_2.test('Submittal - FF&E')).toBe(true);
      });
    });

    describe('matchCandidateSpaces with labels', () => {
      it('matches candidate space from non-system label across full string and hierarchical segments', () => {
        const matchFull = matchCandidateSpaces(
          candidateSpaces,
          undefined,
          undefined,
          ['Projects/123 Main St/Submittals']
        );
        expect(matchFull?.id).toBe('proj-123');

        const matchSegment = matchCandidateSpaces(
          candidateSpaces,
          undefined,
          undefined,
          ['123 Main St']
        );
        expect(matchSegment?.id).toBe('proj-123');
      });

      it('inspects non-system labels ahead of subject and body text', () => {
        const match = matchCandidateSpaces(
          candidateSpaces,
          'Update regarding Skyline Tower',
          'We are discussing Skyline Tower project',
          ['Projects/123 Main St/Submittals']
        );
        expect(match?.id).toBe('proj-123');
      });

      it('ignores system labels and falls back to subject/body', () => {
        const match = matchCandidateSpaces(
          candidateSpaces,
          'Skyline Tower Kickoff',
          undefined,
          ['INBOX', 'SENT', 'UNREAD', 'STARRED', 'IMPORTANT', 'CATEGORY_PROMOTIONS']
        );
        expect(match?.id).toBe('proj-skyline');
      });
    });

    describe('SourceParserService Pass 1 inferRouting with Gmail labels', () => {
      it('lets explicit FF&E code-bearing attachment win over generic Submittals Gmail label', async () => {
        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
        const result = await service.inferRouting({
          candidateSpaces,
          email: {
            id: 'msg-1',
            attachments: [{ id: 'att-1', name: 'CG104-A_Chair.pdf' }],
            labels: ['Projects/123 Main St/Submittals'],
          },
        });

        expect(result).toEqual({
          spaceTypeId: 'projects',
          spaceIdOrName: 'proj-123',
          documentTypeKey: 'submittal-ffe',
        });
      });

      it('lets explicit CSI code-bearing attachment win over specific FF&E Gmail label', async () => {
        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
        const result = await service.inferRouting({
          candidateSpaces,
          email: {
            id: 'msg-1',
            attachments: [{ id: 'att-1', name: '071200-001_Waterproofing.pdf' }],
            labels: ['Projects/FF&E/Submittals'],
          },
        });

        expect(result).toEqual({
          spaceTypeId: 'projects',
          documentTypeKey: 'submittal-arch',
        });
      });

      it('infers submittal-ffe when label contains FF&E + Submittals proximity and attachments have no code', async () => {
        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
        const result = await service.inferRouting({
          candidateSpaces,
          email: {
            id: 'msg-1',
            attachments: [{ id: 'att-1', name: 'cutsheet.pdf' }],
            labels: ['Projects/FF&E/Submittals', '123 Main St'],
          },
        });

        expect(result).toEqual({
          spaceTypeId: 'projects',
          spaceIdOrName: 'proj-123',
          documentTypeKey: 'submittal-ffe',
        });
      });

      it('infers submittal-arch and candidate space from generic Submittals Gmail label when no specific codes match', async () => {
        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
        const result = await service.inferRouting({
          candidateSpaces,
          email: {
            id: 'msg-1',
            attachments: [{ id: 'att-1', name: 'general-cutsheet.pdf' }],
            labels: ['Projects/123 Main St/Submittals'],
          },
        });

        expect(result).toEqual({
          spaceTypeId: 'projects',
          spaceIdOrName: 'proj-123',
          documentTypeKey: 'submittal-arch',
        });
      });

      it('infers submittal-arch from standalone Submittal / Submittals label', async () => {
        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
        const result = await service.inferRouting({
          candidateSpaces,
          email: {
            id: 'msg-1',
            labels: ['Submittals'],
          },
        });

        expect(result).toEqual({
          spaceTypeId: 'projects',
          documentTypeKey: 'submittal-arch',
        });
      });

      it('lets specific FF&E proximity in subject win over generic Submittals label', async () => {
        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
        const result = await service.inferRouting({
          candidateSpaces,
          email: {
            id: 'msg-1',
            subject: 'FF&E Submittals for 123 Main St',
            labels: ['Submittals'],
          },
        });

        expect(result).toEqual({
          spaceTypeId: 'projects',
          spaceIdOrName: 'proj-123',
          documentTypeKey: 'submittal-ffe',
        });
      });

      it('does NOT infer submittal-arch when labels contain only system labels', async () => {
        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort);
        const result = await service.inferRouting({
          candidateSpaces,
          email: {
            id: 'msg-1',
            subject: 'General check-in',
            labels: ['INBOX', 'SENT', 'UNREAD', 'STARRED', 'IMPORTANT'],
          },
        });

        expect(result.documentTypeKey).toBeUndefined();
      });
    });
  });

  describe('SourceParser Pass 2 helper functions', () => {
    describe('cleanSubject', () => {
      it('strips leading Re:, Fwd:, FW:, and aw: prefixes case-insensitively', () => {
        expect(cleanSubject('Re: Project Update')).toBe('Project Update');
        expect(cleanSubject('FWD: Re: aw: Hello World')).toBe('Hello World');
        expect(cleanSubject('fw: meeting notes')).toBe('meeting notes');
        expect(cleanSubject('Clean Subject')).toBe('Clean Subject');
        expect(cleanSubject('')).toBe('');
      });
    });

    describe('parseDateToYymmdd', () => {
      it('parses RFC 2822 dates with named timezone offsets', () => {
        expect(parseDateToYymmdd('Mon, 18 Oct 2026 12:00:00 GMT')).toBe('261018');
        expect(parseDateToYymmdd('Sun, 20 Sep 2026 10:00:00 EDT')).toBe('260920');
      });

      it('parses ISO dates with numeric timezone offsets', () => {
        expect(parseDateToYymmdd('2026-09-20T10:00:00-04:00')).toBe('260920');
        expect(parseDateToYymmdd('2026-10-18T12:00:00Z')).toBe('261018');
      });

      it('returns undefined for unparseable dates', () => {
        expect(parseDateToYymmdd('invalid-date')).toBeUndefined();
        expect(parseDateToYymmdd('')).toBeUndefined();
        expect(parseDateToYymmdd(undefined)).toBeUndefined();
      });

      it('formats UTC ISO and timezone-less date-time strings in workspace timeZone without shifting date-only strings or explicit offsets (#307)', () => {
        // Evening UTC Z rolls back to prior calendar day in America/New_York
        expect(parseDateToYymmdd('2026-03-16T02:30:00Z', 'America/New_York')).toBe('260315');
        expect(parseDateToYymmdd('2026-03-16T02:30:00Z')).toBe('260316');

        // DST spring-forward (2026-03-08 02:00 EST -> 03:00 EDT = 07:00Z)
        expect(parseDateToYymmdd('2026-03-08T04:30:00Z', 'America/New_York')).toBe('260307'); // 23:30 EST Mar 7
        expect(parseDateToYymmdd('2026-03-08T07:30:00Z', 'America/New_York')).toBe('260308'); // 03:30 EDT Mar 8

        // DST fall-back (2026-11-01 02:00 EDT -> 01:00 EST = 06:00Z)
        expect(parseDateToYymmdd('2026-11-02T04:30:00Z', 'America/New_York')).toBe('261101'); // 23:30 EST Nov 1

        // Timezone-less ISO date-time treated as UTC and formatted in workspace timeZone
        expect(parseDateToYymmdd('2026-03-16T02:30:00', 'America/New_York')).toBe('260315');

        // Date-only strings remain unshifted in America/New_York
        expect(parseDateToYymmdd('2026-03-15', 'America/New_York')).toBe('260315');
        expect(parseDateToYymmdd('Mar 15, 2026', 'America/New_York')).toBe('260315');

        // Explicit RFC 2822 numeric and named offsets are preserved even when timeZone is provided
        expect(parseDateToYymmdd('Mon, 16 Mar 2026 02:30:00 +0000', 'America/New_York')).toBe('260316');
        expect(parseDateToYymmdd('Sun, 20 Sep 2026 23:30:00 EDT', 'America/New_York')).toBe('260920');
        expect(parseDateToYymmdd('Mon, 16 Mar 2026 02:30:00 GMT', 'America/New_York')).toBe('260316');
      });
    });

    describe('normalizeHtmlBodyForPass2', () => {
      it('converts line-breaking tags to newlines and table cells to spaces', () => {
        const html = '<p>Paragraph 1</p><p>Paragraph 2</p><table><tr><td>Cell 1</td><td>Cell 2</td></tr></table>';
        const text = normalizeHtmlBodyForPass2(html);
        expect(text).toContain('Paragraph 1\nParagraph 2');
        expect(text).toContain('Cell 1 Cell 2');
      });

      it('decodes HTML entities including en-dash and em-dash', () => {
        const html = '<div>A &ndash; B &#8211; C &mdash; D &#8212; E &amp; F &quot;G&quot; &#39;H&#39;</div>';
        const text = normalizeHtmlBodyForPass2(html);
        expect(text).toBe('A \u2013 B \u2013 C \u2014 D \u2014 E & F "G" \'H\'');
      });

      it('preserves newline line boundaries while collapsing horizontal whitespace', () => {
        const html = 'Line 1    extra spaces<br>Line 2   more spaces';
        const text = normalizeHtmlBodyForPass2(html);
        expect(text).toBe('Line 1 extra spaces\nLine 2 more spaces');
      });
    });
  });

  describe('SourceParserService Pass 2 (extractFields)', () => {
    const mockDrivePort: DriveSourceContextPort = {
      getItemHierarchy: vi.fn(),
    };

    it('seeds populatedFields from non-empty existingData without overwriting it', async () => {
      const mockParseRegistry = {
        initialize: vi.fn(),
        getParseSchema: vi.fn().mockResolvedValue({
          extractors: [
            {
              source: 'gmail',
              fields: {
                description: { from: 'email.subjectClean' },
                date: { from: 'email.date' },
              },
            },
          ],
        }),
        getTargetSchema: vi.fn().mockResolvedValue({
          fields: [
            { key: 'description', type: 'string' },
            { key: 'date', type: 'string' },
          ],
        }),
      };

      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: mockParseRegistry,
      });

      const result = await service.extractFields({
        documentTypeKey: 'communication-project',
        existingData: {
          description: 'User Existing Description',
        },
        context: {
          email: {
            id: 'msg-1',
            subject: 'New Subject in Email',
            date: 'Sun, 20 Sep 2026 10:00:00 EDT',
          },
        },
      });

      expect(result.fields.description).toBe('User Existing Description');
      expect(result.fields.date).toBe('260920');
    });

    it('evaluates extractor.match and FieldRule.when using predicateEvaluator', async () => {
      const mockParseRegistry = {
        initialize: vi.fn(),
        getParseSchema: vi.fn().mockResolvedValue({
          extractors: [
            {
              source: 'gmail',
              match: { '==': [{ var: 'email.fromDomain' }, 'inc.nyc'] },
              fields: {
                direction: [
                  {
                    when: { in: ['SENT', { var: 'email.labels' }] },
                    set: 'OT',
                  },
                  { set: 'IN' },
                ],
              },
            },
          ],
        }),
        getTargetSchema: vi.fn().mockResolvedValue({
          fields: [
            {
              key: 'direction',
              type: 'string',
              options: { source: 'direction', key: 'key', name: 'name' },
            },
          ],
          options: {
            direction: [
              { key: 'IN', name: 'Incoming' },
              { key: 'OT', name: 'Outgoing' },
            ],
          },
        }),
      };

      const mockPredicateEvaluator = {
        evaluate: vi.fn((rule: unknown, data: Record<string, unknown>) => {
          const typedRule = rule as Record<string, unknown> | undefined;
          const typedData = data as { email?: { fromDomain?: string; labels?: string[] } };
          if (typedRule && typedRule['==']) {
            return typedData.email?.fromDomain === 'inc.nyc';
          }
          if (typedRule && typedRule.in) {
            return (typedData.email?.labels ?? []).includes('SENT');
          }
          return false;
        }),
      };

      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: mockParseRegistry,
        predicateEvaluator: mockPredicateEvaluator,
      });

      const resultSent = await service.extractFields({
        documentTypeKey: 'communication-project',
        context: {
          email: {
            id: 'msg-1',
            from: 'Alice <alice@inc.nyc>',
            labels: ['SENT', 'INBOX'],
          },
        },
      });
      expect(resultSent.fields.direction).toBe('OT');

      const resultNotSent = await service.extractFields({
        documentTypeKey: 'communication-project',
        context: {
          email: {
            id: 'msg-2',
            from: 'Alice <alice@inc.nyc>',
            labels: ['INBOX'],
          },
        },
      });
      expect(resultNotSent.fields.direction).toBe('IN');

      const resultMismatchedDomain = await service.extractFields({
        documentTypeKey: 'communication-project',
        context: {
          email: {
            id: 'msg-3',
            from: 'Bob <bob@other.com>',
            labels: ['SENT'],
          },
        },
      });
      expect(resultMismatchedDomain.fields.direction).toBeUndefined();
    });

    it('extracts date, clean subject, body, and labels with regex patterns', async () => {
      const mockParseRegistry = {
        initialize: vi.fn(),
        getParseSchema: vi.fn().mockResolvedValue({
          extractors: [
            {
              source: 'gmail',
              fields: {
                date: { from: 'email.date' },
                description: { from: 'email.subjectClean' },
                sectionCode: {
                  from: 'email.labels',
                  pattern: '^(\\d{6})$',
                  group: 1,
                },
                bodySnippet: {
                  from: 'email.body',
                  pattern: '^Submittal\\s*#?\\s*(\\d+)',
                  flags: 'im',
                  group: 1,
                },
              },
            },
          ],
        }),
        getTargetSchema: vi.fn().mockResolvedValue({
          fields: [
            { key: 'date', type: 'string' },
            { key: 'description', type: 'string' },
            { key: 'sectionCode', type: 'string' },
            { key: 'bodySnippet', type: 'string' },
          ],
        }),
      };

      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: mockParseRegistry,
      });

      const result = await service.extractFields({
        documentTypeKey: 'communication-project',
        context: {
          email: {
            id: 'msg-1',
            subject: 'Re: Fwd: Important Update',
            date: 'Mon, 18 Oct 2026 12:00:00 GMT',
            labels: ['Projects/123 Main St', '071200'],
            htmlBody: '<p>Line 1</p><p>Submittal #1234 details</p>',
          },
        },
      });

      expect(result.fields.date).toBe('261018');
      expect(result.fields.description).toBe('Important Update');
      expect(result.fields.sectionCode).toBe('071200');
      expect(result.fields.bodySnippet).toBe('1234');
    });

    it('validates candidate against minLength, pattern, and canonical LookupField options', async () => {
      const mockParseRegistry = {
        initialize: vi.fn(),
        getParseSchema: vi.fn().mockResolvedValue({
          extractors: [
            {
              source: 'gmail',
              fields: {
                shortField: [
                  { from: 'email.subject', pattern: '^(a)$' }, // minLength 3 -> rejected
                  { set: 'Valid Long' }, // passes
                ],
                patternField: [
                  { set: 'not-matching' }, // fails pattern ^\\d+$
                  { set: '12345' }, // passes
                ],
                direction: [
                  { set: 'INVALID_DIR' }, // not in options -> rejected
                  { set: 'Incoming' }, // matches name -> normalizes to key 'IN'
                ],
              },
            },
          ],
        }),
        getTargetSchema: vi.fn().mockResolvedValue({
          fields: [
            { key: 'shortField', type: 'string', minLength: 3 },
            { key: 'patternField', type: 'string', pattern: '^\\d+$' },
            {
              key: 'direction',
              type: 'string',
              options: { source: 'direction', key: 'key', name: 'name' },
            },
          ],
          options: {
            direction: [
              { key: 'IN', name: 'Incoming' },
              { key: 'OT', name: 'Outgoing' },
            ],
          },
        }),
      };

      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: mockParseRegistry,
      });

      const result = await service.extractFields({
        documentTypeKey: 'test-doc',
        context: {
          email: {
            id: 'msg-1',
            subject: 'a',
          },
        },
      });

      expect(result.fields.shortField).toBe('Valid Long');
      expect(result.fields.patternField).toBe('12345');
      expect(result.fields.direction).toBe('IN');
    });

    it('catches extractor errors non-blockingly and appends statusMessages', async () => {
      const mockParseRegistry = {
        initialize: vi.fn(),
        getParseSchema: vi.fn().mockResolvedValue({
          extractors: [
            {
              source: 'gmail',
              name: 'Broken Extractor',
              fields: {
                date: { from: 'email.date' },
              },
            },
            {
              source: 'gmail',
              name: 'Healthy Extractor',
              fields: {
                description: { from: 'email.subjectClean' },
              },
            },
          ],
        }),
        getTargetSchema: vi.fn().mockResolvedValue({
          fields: [
            Object.defineProperty({ key: 'date', type: 'string' }, 'minLength', {
              get() {
                throw new Error('Broken field getter');
              },
            }),
            { key: 'description', type: 'string' },
          ],
        }),
      };

      const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: mockParseRegistry,
      });

      const result = await service.extractFields({
        documentTypeKey: 'test-doc',
        context: {
          email: {
            id: 'msg-1',
            date: 'Mon, 18 Oct 2026 12:00:00 GMT',
            subject: 'Clean Subject',
          },
        },
      });

      expect(result.statusMessages).toBeDefined();
      expect(result.statusMessages?.[0]).toContain('Could not extract fields from Broken Extractor');
      expect(result.fields.description).toBe('Clean Subject');
    });

    describe('RFC 5322 Recipient Splitting and Parsing', () => {
      it('splits recipients preserving commas inside quoted display names', () => {
        const input = '"McGovern, James" <jmcgovern@pavarini.com>, "Smith, Bob" <bsmith@inc.nyc>, Jane Doe <jane@example.com>';
        const split = splitRfc5322Recipients(input);
        expect(split).toEqual([
          '"McGovern, James" <jmcgovern@pavarini.com>',
          '"Smith, Bob" <bsmith@inc.nyc>',
          'Jane Doe <jane@example.com>',
        ]);
      });

      it('handles escaped quotes and returns empty array on empty input', () => {
        expect(splitRfc5322Recipients('')).toEqual([]);
        expect(splitRfc5322Recipients('   ')).toEqual([]);
        const input = '"Escaped \\"Quote\\", Test" <test@example.com>';
        expect(splitRfc5322Recipients(input)).toEqual(['"Escaped \\"Quote\\", Test" <test@example.com>']);
      });

      it('parses recipient into displayName, email, and domain', () => {
        expect(parseRecipient('"McGovern, James" <jmcgovern@pavarini.com>')).toEqual({
          raw: '"McGovern, James" <jmcgovern@pavarini.com>',
          displayName: 'McGovern, James',
          email: 'jmcgovern@pavarini.com',
          domain: 'pavarini.com',
        });
        expect(parseRecipient('<contact@domain.org>')).toEqual({
          raw: '<contact@domain.org>',
          email: 'contact@domain.org',
          domain: 'domain.org',
        });
        expect(parseRecipient('user@inc.nyc')).toEqual({
          raw: 'user@inc.nyc',
          email: 'user@inc.nyc',
          domain: 'inc.nyc',
        });
        expect(parseRecipient('Bare Name')).toEqual({
          raw: 'Bare Name',
          displayName: 'Bare Name',
        });
      });
    });

    describe('LookupField 3-Tier Entity Resolution & LinkedField Derivation', () => {
      const targetDocSchema = {
        fields: [
          {
            key: 'contact',
            name: 'Contact',
            type: 'string',
            options: {
              source: 'contactFolders',
              key: 'key',
              name: 'name',
              allowUserInput: true,
              dynamicConfig: { provider: 'google_drive', relativePath: 'Contacts' },
            },
          },
          {
            key: 'specTag',
            name: 'Spec Tag',
            type: 'string',
            options: {
              source: 'specItems',
              key: 'code',
              name: 'title',
            },
          },
          {
            key: 'specTitle',
            name: 'Spec Title',
            type: 'string',
            linkedField: {
              sourceField: 'specTag',
              sourceProperty: 'title',
            },
          },
        ],
        options: {
          specItems: [
            { code: '071200', title: 'Waterproofing', aliases: ['WP', 'dampproofing'] },
            { code: '092200', title: 'Drywall', aliases: ['gypsum', 'GWB'] },
          ],
        },
      };

      it('resolves Tier 1 local option aliases first and derives sibling LinkedField', async () => {
        const mockParseRegistry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockReturnValue({
            extractors: [
              {
                source: 'gmail',
                fields: {
                  specTag: { from: 'email.subjectClean', lookup: true },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockReturnValue(targetDocSchema),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: mockParseRegistry,
        });

        const result = await service.extractFields({
          documentTypeKey: 'test-doc',
          context: {
            email: {
              id: 'msg-1',
              subject: 'Re: Dampproofing Submittal for review',
            },
          },
        });

        expect(result.fields.specTag).toBe('071200');
        expect(result.fields.specTitle).toBe('Waterproofing');
      });

      it('filters out entries matching excludePattern on email.to and matches external counterparty', async () => {
        const mockCanonicalProvider = {
          getCanonicalOptions: vi.fn().mockResolvedValue([
            { key: 'Pavarini Construction', name: 'Pavarini Construction' },
            { key: 'Structure Tone', name: 'Structure Tone' },
          ]),
        };

        const mockParseRegistry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockReturnValue({
            extractors: [
              {
                source: 'gmail',
                fields: {
                  contact: {
                    from: 'email.to',
                    excludePattern: '@inc\\.nyc\\b',
                    lookup: true,
                  },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockReturnValue(targetDocSchema),
          getAliasDictionary: vi.fn().mockReturnValue({
            source: 'contactFolders',
            mappings: {
              'Pavarini Construction': ['@pavarini.com', 'PCNE'],
            },
          }),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: mockParseRegistry,
          canonicalOptionsProvider: mockCanonicalProvider,
        });

        const result = await service.extractFields({
          documentTypeKey: 'test-doc',
          spaceId: 'space-999',
          context: {
            email: {
              id: 'msg-1',
              to: 'colleague@inc.nyc, "McGovern, James" <jmcgovern@pavarini.com>',
            },
          },
        });

        expect(result.fields.contact).toBe('Pavarini Construction');
        expect(mockCanonicalProvider.getCanonicalOptions).toHaveBeenCalledWith(
          'space-999',
          expect.objectContaining({ key: 'contact' })
        );
      });

      it('shadowing: higher tiers shadow lower tiers and collision in winning tier returns undefined', async () => {
        // Tier 1 has static options with local alias 'shared-alias' mapping to key '071200'
        // Tier 3 shared dictionary attempts to map 'shared-alias' to key '092200' -> shadowed by Tier 1!
        const schemaWithLocalAlias = {
          ...targetDocSchema,
          options: {
            specItems: [
              { code: '071200', title: 'Waterproofing', aliases: ['wp-tier1'] },
              { code: '092200', title: 'Drywall', aliases: ['dw-tier1'] },
            ],
          },
        };

        const mockParseRegistry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockReturnValue({
            extractors: [
              {
                source: 'gmail',
                fields: {
                  specTag: { from: 'email.subjectClean', lookup: true },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockReturnValue(schemaWithLocalAlias),
          getAliasDictionary: vi.fn().mockReturnValue({
            source: 'specItems',
            mappings: {
              '092200': ['wp-tier1'], // attempted conflict in Tier 3
            },
          }),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: mockParseRegistry,
        });

        // 'wp-tier1' is in Tier 1 for 071200, so it matches 071200 and ignores Tier 3 mapping to 092200
        const result = await service.extractFields({
          documentTypeKey: 'test-doc',
          context: {
            email: {
              id: 'msg-1',
              subject: 'Checking wp-tier1 notes',
            },
          },
        });

        expect(result.fields.specTag).toBe('071200');
      });

      it('longest strict-substring tie-breaking picks the longer entity, but multi-entity collision returns undefined', async () => {
        const schemaWithSubstrings = {
          ...targetDocSchema,
          options: {
            specItems: [
              { code: '071200', title: 'Pavarini Construction', aliases: ['Pavarini Construction'] },
              { code: '092200', title: 'Pavarini', aliases: ['Pavarini'] },
            ],
          },
        };

        const mockParseRegistry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockReturnValue({
            extractors: [
              {
                source: 'gmail',
                fields: {
                  specTag: { from: 'email.subjectClean', lookup: true },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockReturnValue(schemaWithSubstrings),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: mockParseRegistry,
        });

        // 1. Text has "Pavarini Construction" - "Pavarini" is a strict substring, so "Pavarini Construction" (071200) wins
        const result1 = await service.extractFields({
          documentTypeKey: 'test-doc',
          context: {
            email: {
              id: 'msg-1',
              subject: 'Meeting with Pavarini Construction team',
            },
          },
        });
        expect(result1.fields.specTag).toBe('071200');

        // 2. Text has two non-substring entities: "Pavarini" and "Drywall" -> collision returns undefined
        const schemaWithIndependent = {
          ...targetDocSchema,
          options: {
            specItems: [
              { code: '071200', title: 'Pavarini', aliases: ['Pavarini'] },
              { code: '092200', title: 'Drywall', aliases: ['Drywall'] },
            ],
          },
        };
        mockParseRegistry.getTargetSchema.mockReturnValue(schemaWithIndependent);

        const result2 = await service.extractFields({
          documentTypeKey: 'test-doc',
          context: {
            email: {
              id: 'msg-2',
              subject: 'Pavarini and Drywall meeting',
            },
          },
        });
        expect(result2.fields.specTag).toBeUndefined();
      });

      it('canonical-only guard: never pre-populates unverified strings even when allowUserInput is true', async () => {
        const mockCanonicalProvider = {
          getCanonicalOptions: vi.fn().mockResolvedValue([
            { key: 'Known Contact', name: 'Known Contact' },
          ]),
        };

        const mockParseRegistry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockReturnValue({
            extractors: [
              {
                source: 'gmail',
                fields: {
                  contact: { from: 'email.from', lookup: true },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockReturnValue(targetDocSchema),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: mockParseRegistry,
          canonicalOptionsProvider: mockCanonicalProvider,
        });

        // Unknown email from an unregistered sender
        const result = await service.extractFields({
          documentTypeKey: 'test-doc',
          spaceId: 'space-123',
          context: {
            email: {
              id: 'msg-1',
              from: 'stranger@unknown-vendor.com',
            },
          },
        });

        // Contact must remain blank (not populated with 'stranger@unknown-vendor.com')
        expect(result.fields.contact).toBeUndefined();
      });

      it('discards candidate when spaceId is missing for dynamic options', async () => {
        const mockCanonicalProvider = {
          getCanonicalOptions: vi.fn().mockResolvedValue([
            { key: 'Known Contact', name: 'Known Contact' },
          ]),
        };

        const mockParseRegistry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockReturnValue({
            extractors: [
              {
                source: 'gmail',
                fields: {
                  contact: { from: 'email.from', lookup: true },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockReturnValue(targetDocSchema),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: mockParseRegistry,
          canonicalOptionsProvider: mockCanonicalProvider,
        });

        const result = await service.extractFields({
          documentTypeKey: 'test-doc',
          // spaceId omitted
          context: {
            email: {
              id: 'msg-1',
              from: 'Known Contact <contact@example.com>',
            },
          },
        });

        expect(result.fields.contact).toBeUndefined();
        expect(mockCanonicalProvider.getCanonicalOptions).not.toHaveBeenCalled();
      });
    });

    describe('Ticket #305: Correlated single-attachment extraction and production Submittal Arch & FF&E extraction', () => {
      it('getCandidateAttachmentNames handles isDriveUrl, items in order, and fallback to email.attachments', () => {
        expect(
          getCandidateAttachmentNames({
            isDriveUrl: true,
            items: [{ id: '1', name: 'File1.pdf' }],
            email: { id: 'm1', attachments: [{ id: 'a1', name: 'Att1.pdf' }] },
          })
        ).toEqual([]);

        expect(
          getCandidateAttachmentNames({
            items: [
              { id: '1', name: 'File1.pdf' },
              { id: '2', name: 'File2.pdf' },
            ],
            email: { id: 'm1', attachments: [{ id: 'a1', name: 'Att1.pdf' }] },
          })
        ).toEqual(['File1.pdf', 'File2.pdf']);

        expect(
          getCandidateAttachmentNames({
            items: [],
            email: {
              id: 'm1',
              attachments: [
                { id: 'a1', name: 'Att1.pdf' },
                { id: 'a2', name: 'Att2.pdf' },
              ],
            },
          })
        ).toEqual(['Att1.pdf', 'Att2.pdf']);

        expect(
          getCandidateAttachmentNames({
            items: [{ id: '1', name: '   ' }],
            email: {
              id: 'm1',
              attachments: [{ id: 'a1', name: 'FallbackAtt.pdf' }],
            },
          })
        ).toEqual(['FallbackAtt.pdf']);
      });

      it('matchesCorrelatedCode validates CSI section and number correlation against populated fields', () => {
        const csiMatch = '071200-001-B Specs'.match(/(\d{6})-(\d{3})-([A-Za-z0-9]+)/);
        expect(csiMatch).not.toBeNull();
        expect(
          matchesCorrelatedCode(csiMatch!, 3, { section: '071200', number: '001' })
        ).toBe(true);
        expect(
          matchesCorrelatedCode(csiMatch!, 3, { section: '081100', number: '001' })
        ).toBe(false);
        expect(
          matchesCorrelatedCode(csiMatch!, 3, { section: '071200', number: '002' })
        ).toBe(false);

        const mismatchedCsiMatch = '081100-002-C Doors'.match(/(\d{6})-(\d{3})-([A-Za-z0-9]+)/);
        expect(
          matchesCorrelatedCode(mismatchedCsiMatch!, 3, { section: '071200', number: '001' })
        ).toBe(false);
      });

      it('matchesCorrelatedCode validates FF&E specTag correlation against populated fields', () => {
        const specMatch = 'CG104-B Cut Sheet'.match(/([A-Za-z]{2}\d{3}[A-Za-z]?)-([A-Za-z0-9]+)/);
        expect(specMatch).not.toBeNull();
        expect(matchesCorrelatedCode(specMatch!, 2, { specTag: 'CG104' })).toBe(true);
        expect(matchesCorrelatedCode(specMatch!, 2, { specTag: 'cg104' })).toBe(true);
        expect(matchesCorrelatedCode(specMatch!, 2, { specTag: 'LT108' })).toBe(false);
      });

      it('binds compound attachment extraction to first matching attachment and prevents cross-attachment field splicing in Submittal Arch', async () => {
        const mockParseRegistry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'gmail',
                fields: {
                  section: [
                    {
                      from: 'attachmentName',
                      pattern: '(\\d{6})-(\\d{3})(?:-([A-Za-z0-9]+))?',
                      group: 1,
                    },
                  ],
                  number: [
                    {
                      from: 'attachmentName',
                      pattern: '(\\d{6})-(\\d{3})(?:-([A-Za-z0-9]+))?',
                      group: 2,
                    },
                  ],
                  revision: [
                    {
                      from: 'attachmentName',
                      pattern: '(\\d{6})-(\\d{3})-([A-Za-z0-9]+)(?:[\\s_]|\\.[A-Za-z]{2,5}$|$)',
                      group: 3,
                    },
                    {
                      from: 'email.labels',
                      pattern: '(\\d{6})-(\\d{3})-([A-Za-z0-9]+)(?:[\\s_]|\\.[A-Za-z]{2,5}$|$)',
                      group: 3,
                    },
                    {
                      from: 'email.subjectClean',
                      pattern: '(\\d{6})-(\\d{3})-([A-Za-z0-9]+)(?:[\\s_]|\\.[A-Za-z]{2,5}$|$)',
                      group: 3,
                    },
                  ],
                  title: [
                    {
                      from: 'attachmentName',
                      pattern: '(\\d{6})-(\\d{3})(?:-([A-Za-z0-9]+))?[\\s_]+(?:[-–—]\\s*)?(.+?)(?:\\.[A-Za-z]{2,5})?$',
                      group: 4,
                    },
                    {
                      from: 'email.labels',
                      pattern: '(\\d{6})-(\\d{3})(?:-([A-Za-z0-9]+))?[\\s_]+(?:[-–—]\\s*)?(.+?)(?:\\.[A-Za-z]{2,5})?$',
                      group: 4,
                    },
                    {
                      from: 'email.subjectClean',
                      pattern: '(\\d{6})-(\\d{3})(?:-([A-Za-z0-9]+))?[\\s_]+(?:[-–—]\\s*)?(.+?)(?:\\.[A-Za-z]{2,5})?$',
                      group: 4,
                    },
                  ],
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [
              { key: 'section', type: 'string', pattern: '^\\d{6}$' },
              { key: 'number', type: 'string', pattern: '^\\d{3}$' },
              { key: 'revision', type: 'string', minLength: 1 },
              { key: 'title', type: 'string', minLength: 1 },
            ],
          }),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: mockParseRegistry,
        });

        const result = await service.extractFields({
          documentTypeKey: 'submittal-arch',
          context: {
            email: {
              id: 'msg-submittal-arch-1',
              subject: 'Re: Submittal 071200-001-B Waterproofing Specs',
              attachments: [
                { id: 'att-0', name: 'Invoice_12345.pdf' },
                { id: 'att-1', name: '071200-001 Waterproofing Specs.pdf' },
                { id: 'att-2', name: '081100-002-C Hollow Metal Doors.pdf' },
              ],
            },
          },
        });

        expect(result.fields.section).toBe('071200');
        expect(result.fields.number).toBe('001');
        expect(result.fields.title).toBe('Waterproofing Specs');
        expect(result.fields.revision).toBe('B');
      });

      it('rejects fallback revision and title when leading code does not match already-populated section and number', async () => {
        const mockParseRegistry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'gmail',
                fields: {
                  section: [
                    {
                      from: 'attachmentName',
                      pattern: '(\\d{6})-(\\d{3})(?:-([A-Za-z0-9]+))?',
                      group: 1,
                    },
                  ],
                  number: [
                    {
                      from: 'attachmentName',
                      pattern: '(\\d{6})-(\\d{3})(?:-([A-Za-z0-9]+))?',
                      group: 2,
                    },
                  ],
                  revision: [
                    {
                      from: 'attachmentName',
                      pattern: '(\\d{6})-(\\d{3})-([A-Za-z0-9]+)(?:[\\s_]|\\.[A-Za-z]{2,5}$|$)',
                      group: 3,
                    },
                    {
                      from: 'email.subjectClean',
                      pattern: '(\\d{6})-(\\d{3})-([A-Za-z0-9]+)(?:[\\s_]|\\.[A-Za-z]{2,5}$|$)',
                      group: 3,
                    },
                  ],
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [
              { key: 'section', type: 'string', pattern: '^\\d{6}$' },
              { key: 'number', type: 'string', pattern: '^\\d{3}$' },
              { key: 'revision', type: 'string', minLength: 1 },
            ],
          }),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: mockParseRegistry,
        });

        const result = await service.extractFields({
          documentTypeKey: 'submittal-arch',
          context: {
            email: {
              id: 'msg-submittal-arch-2',
              subject: 'Re: 081100-002-D Doors for another project',
              attachments: [
                { id: 'att-1', name: '071200-001 Waterproofing Specs.pdf' },
              ],
            },
          },
        });

        expect(result.fields.section).toBe('071200');
        expect(result.fields.number).toBe('001');
        expect(result.fields.revision).toBeUndefined();
      });

      it('resolves specTag with lookup: true, auto-derives LinkedField specTitle, binds revision, and resolves vendor across 3 tiers for Submittal FF&E', async () => {
        const mockCanonicalProvider = {
          getCanonicalOptions: vi.fn().mockImplementation(async (_spaceId, field) => {
            if (field.options?.source === 'vendors') {
              return [
                { key: 'BM', name: 'Berman Falk' },
                { key: 'Carn', name: 'Carnegie' },
              ];
            }
            return [];
          }),
        };

        const mockParseRegistry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'gmail',
                fields: {
                  action: [
                    {
                      when: { '!=': [{ var: 'email.fromDomain' }, 'inc.nyc'] },
                      set: 'REC',
                    },
                  ],
                  date: { from: 'email.date' },
                  contact: [
                    {
                      when: {
                        or: [
                          { in: ['SENT', { var: 'email.labels' }] },
                          { '==': [{ var: 'email.fromDomain' }, 'inc.nyc'] },
                        ],
                      },
                      from: 'email.to',
                      excludePattern: '@inc\\.nyc\\b',
                      lookup: true,
                    },
                    { from: 'email.from', lookup: true },
                  ],
                  vendor: [
                    { from: 'attachmentName', lookup: true },
                    { from: 'email.labels', lookup: true },
                    { from: 'email.subjectClean', lookup: true },
                    {
                      when: { '!=': [{ var: 'email.fromDomain' }, 'inc.nyc'] },
                      from: 'email.from',
                      lookup: true,
                    },
                  ],
                  specTag: [
                    {
                      from: 'attachmentName',
                      pattern: '([A-Za-z]{2}\\d{3}[A-Za-z]?)(?:-([A-Za-z0-9]+))?',
                      group: 1,
                      lookup: true,
                    },
                  ],
                  revision: [
                    {
                      from: 'attachmentName',
                      pattern: '([A-Za-z]{2}\\d{3}[A-Za-z]?)-([A-Za-z0-9]+)(?:[\\s_]|\\.[A-Za-z]{2,5}$|$)',
                      group: 2,
                    },
                    {
                      from: 'email.subjectClean',
                      pattern: '([A-Za-z]{2}\\d{3}[A-Za-z]?)-([A-Za-z0-9]+)(?:[\\s_]|\\.[A-Za-z]{2,5}$|$)',
                      group: 2,
                    },
                  ],
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [
              {
                key: 'action',
                type: 'string',
                options: { source: 'actions', key: 'key', name: 'name' },
              },
              { key: 'date', type: 'string' },
              {
                key: 'contact',
                type: 'string',
                options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true },
              },
              {
                key: 'vendor',
                type: 'string',
                options: { source: 'vendors', key: 'key', name: 'name', allowUserInput: true, dynamicConfig: { provider: 'google_drive' } },
              },
              {
                key: 'specTag',
                type: 'string',
                options: { source: 'specs', key: 'key', allowUserInput: true },
              },
              {
                key: 'specTitle',
                type: 'string',
                linkedField: { sourceField: 'specTag', sourceProperty: 'name' },
              },
              { key: 'revision', type: 'string', minLength: 1 },
            ],
            options: {
              actions: [{ key: 'REC', name: 'Received' }],
              contacts: [
                { key: 'BW', name: 'Benjamin West' },
                { key: 'INC', name: 'INC Architecture & Design' },
              ],
              specs: [
                { key: 'CG104', name: 'BED - KING' },
                { key: 'LT108', name: 'SCONCE' },
              ],
            },
          }),
          getAliasDictionary: vi.fn().mockImplementation((source: string) => {
            if (source === 'vendors') {
              return {
                source: 'vendors',
                mappings: {
                  BM: ['@bermanfalk.com', 'Berman Falk', 'BermanFalk'],
                },
              };
            }
            if (source === 'contacts') {
              return {
                source: 'contacts',
                mappings: {
                  BW: ['@benjaminwest.com', 'Benjamin West'],
                },
              };
            }
            return undefined;
          }),
        };

        const mockPredicateEvaluator = {
          evaluate: vi.fn((rule: unknown, data: Record<string, unknown>) => {
            const typedRule = rule as Record<string, unknown> | undefined;
            const typedData = data as { email?: { fromDomain?: string; labels?: string[] } };
            if (typedRule && typedRule['!=']) {
              return typedData.email?.fromDomain !== 'inc.nyc';
            }
            if (typedRule && typedRule.or) {
              return (
                (typedData.email?.labels ?? []).includes('SENT') ||
                typedData.email?.fromDomain === 'inc.nyc'
              );
            }
            return false;
          }),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: mockParseRegistry,
          predicateEvaluator: mockPredicateEvaluator,
          canonicalOptionsProvider: mockCanonicalProvider,
        });

        const result = await service.extractFields({
          documentTypeKey: 'submittal-ffe',
          spaceId: 'space-projects-1',
          context: {
            email: {
              id: 'msg-ffe-1',
              subject: 'CG104-A Berman Falk King Bed Submittal',
              date: 'Wed, 21 Oct 2026 10:00:00 GMT',
              from: 'Berman Rep <rep@bermanfalk.com>',
              to: 'Designer <designer@inc.nyc>',
              labels: ['INBOX', 'Submittals'],
              attachments: [
                { id: 'att-1', name: 'CG104-A Berman Falk Cut Sheet.pdf' },
              ],
            },
          },
        });

        expect(result.fields.action).toBe('REC');
        expect(result.fields.date).toBe('261021');
        expect(result.fields.specTag).toBe('CG104');
        expect(result.fields.specTitle).toBe('BED - KING');
        expect(result.fields.revision).toBe('A');
        expect(result.fields.vendor).toBe('BM');
      });

      it('rejects fallback revision in Submittal FF&E when subject specTag does not match populated specTag', async () => {
        const mockParseRegistry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'gmail',
                fields: {
                  specTag: [
                    {
                      from: 'attachmentName',
                      pattern: '([A-Za-z]{2}\\d{3}[A-Za-z]?)(?:-([A-Za-z0-9]+))?',
                      group: 1,
                      lookup: true,
                    },
                  ],
                  revision: [
                    {
                      from: 'attachmentName',
                      pattern: '([A-Za-z]{2}\\d{3}[A-Za-z]?)-([A-Za-z0-9]+)(?:[\\s_]|\\.[A-Za-z]{2,5}$|$)',
                      group: 2,
                    },
                    {
                      from: 'email.subjectClean',
                      pattern: '([A-Za-z]{2}\\d{3}[A-Za-z]?)-([A-Za-z0-9]+)(?:[\\s_]|\\.[A-Za-z]{2,5}$|$)',
                      group: 2,
                    },
                  ],
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [
              {
                key: 'specTag',
                type: 'string',
                options: { source: 'specs', key: 'key', allowUserInput: true },
              },
              { key: 'revision', type: 'string', minLength: 1 },
            ],
            options: {
              specs: [
                { key: 'CG104', name: 'BED - KING' },
                { key: 'LT108', name: 'SCONCE' },
              ],
            },
          }),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: mockParseRegistry,
        });

        // Attachment binds CG104 (no revision in filename)
        // Subject mentions a different spec tag: LT108-B
        const result = await service.extractFields({
          documentTypeKey: 'submittal-ffe',
          context: {
            email: {
              id: 'msg-ffe-2',
              subject: 'Re: LT108-B Sconces inquiry',
              attachments: [
                { id: 'att-1', name: 'CG104 Cut Sheet.pdf' },
              ],
            },
          },
        });

        expect(result.fields.specTag).toBe('CG104');
        expect(result.fields.revision).toBeUndefined();
      });
    });

    describe('Iteration 1 Review Fixes (S2, Spec #1, Spec #5, S10)', () => {
      it('honors configured options.key and options.name for non-lookup and lookup options and derives LinkedFields', async () => {
        const mockParseRegistry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'gmail',
                fields: {
                  action: { set: 'Received' },
                  specTag: { from: 'email.subjectClean', lookup: true },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [
              {
                key: 'action',
                type: 'string',
                options: { source: 'actions', key: 'code', name: 'label' },
              },
              {
                key: 'specTag',
                type: 'string',
                options: { source: 'specs', key: 'code', name: 'label', allowUserInput: true },
              },
              {
                key: 'specTitle',
                type: 'string',
                linkedField: { sourceField: 'specTag', sourceProperty: 'label' },
              },
            ],
            options: {
              actions: [{ code: 'REC', label: 'Received' }],
              specs: [{ code: '071200', label: 'Waterproofing' }],
            },
          }),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: mockParseRegistry,
        });

        const result = await service.extractFields({
          documentTypeKey: 'test-doc',
          context: {
            email: {
              id: 'msg-1',
              subject: 'Submittal: Waterproofing Review',
            },
          },
        });

        expect(result.fields.action).toBe('REC');
        expect(result.fields.specTag).toBe('071200');
        expect(result.fields.specTitle).toBe('Waterproofing');
      });

      it('evaluates Step 1 (@domain) across Tiers 1 -> 2 -> 3 before Step 2 (exact displayName), supports subdomain boundaries and embedded emails, and halts on ambiguity', async () => {
        const targetSchemaWithOptions = {
          fields: [
            {
              key: 'contact',
              type: 'string',
              options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true },
            },
          ],
          options: {
            contacts: [
              { key: 'PMG', name: 'Pavarini McGovern' },
              { key: 'OTHER', name: 'Other Company' },
            ],
          },
        };

        const mockParseRegistry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'gmail',
                fields: {
                  contact: { from: 'email.from', lookup: true },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue(targetSchemaWithOptions),
          getAliasDictionary: vi.fn().mockReturnValue({
            source: 'contacts',
            mappings: {
              PMG: ['@pavarini.com'],
            },
          }),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: mockParseRegistry,
        });

        // 1. Step 1 (Tier 3 @pavarini.com) beats Step 2 (Tier 1 canonical name "Other Company" in displayName)
        const step1PriorityRes = await service.extractFields({
          documentTypeKey: 'test-doc',
          context: {
            email: {
              id: 'msg-1',
              from: 'Other Company <jmcgovern@pavarini.com>',
            },
          },
        });
        expect(step1PriorityRes.fields.contact).toBe('PMG');

        // 2. Subdomain boundary: @pavarini.com matches mail.pavarini.com, not notpavarini.com
        const subdomainRes = await service.extractFields({
          documentTypeKey: 'test-doc',
          context: {
            email: {
              id: 'msg-2',
              from: 'Forwarded from user@mail.pavarini.com',
            },
          },
        });
        expect(subdomainRes.fields.contact).toBe('PMG');

        const lookalikeRes = await service.extractFields({
          documentTypeKey: 'test-doc',
          context: {
            email: {
              id: 'msg-3',
              from: 'User <user@notpavarini.com>',
            },
          },
        });
        expect(lookalikeRes.fields.contact).toBeUndefined();

        // 3. Ambiguity collision in Tier 1 Step 3 halts immediately without falling through to Tier 3
        mockParseRegistry.getTargetSchema.mockResolvedValue({
          fields: [
            {
              key: 'contact',
              type: 'string',
              options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true },
            },
          ],
          options: {
            contacts: [
              { key: 'PMG', name: 'Pavarini McGovern', aliases: ['Alpha'] },
              { key: 'OTHER', name: 'Other Company', aliases: ['Beta'] },
            ],
          },
        });
        mockParseRegistry.getAliasDictionary.mockReturnValue({
          source: 'contacts',
          mappings: {
            PMG: ['Gamma'],
          },
        });

        const ambiguousRes = await service.extractFields({
          documentTypeKey: 'test-doc',
          context: {
            email: {
              id: 'msg-4',
              from: 'Alpha and Beta with Gamma',
            },
          },
        });
        expect(ambiguousRes.fields.contact).toBeUndefined();
      });

      it('gates FallbackFieldExtractorPort, validates fallback candidates, rejects unverified lookup strings, and derives LinkedFields', async () => {
        const targetSchema = {
          fields: [
            { key: 'date', type: 'string', pattern: '^\\d{6}$' },
            { key: 'description', type: 'string', minLength: 3 },
            {
              key: 'specTag',
              type: 'string',
              options: { source: 'specs', key: 'key', name: 'name', allowUserInput: true },
            },
            {
              key: 'specTitle',
              type: 'string',
              linkedField: { sourceField: 'specTag', sourceProperty: 'name' },
            },
            {
              key: 'action',
              type: 'string',
              options: { source: 'actions', key: 'key', name: 'name' },
            },
          ],
          options: {
            specs: [{ key: 'CG104', name: 'BED - KING' }],
            actions: [{ key: 'REC', name: 'Received' }],
          },
        };

        const fallbackExtractor = {
          extractFields: vi.fn().mockResolvedValue({
            date: 'bad-date', // fails pattern ^\\d{6}$ -> rejected
            description: 'Valid AI Description',
            specTag: 'CG104', // valid canonical option -> populates specTag & derives specTitle
            specTitle: 'SHOULD NOT BE ACCEPTED DIRECTLY',
            action: 'Received', // normalizes name -> key 'REC'
            unknownField: 'ignored',
          }),
        };

        const mockParseRegistry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [], // empty extractors, fallback still runs!
            fallback: {
              strategy: 'ai',
              fields: ['date', 'description', 'specTag', 'action'],
            },
          }),
          getTargetSchema: vi.fn().mockResolvedValue(targetSchema),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: mockParseRegistry,
          fallbackExtractor,
        });

        const res1 = await service.extractFields({
          documentTypeKey: 'test-doc',
          context: { email: { id: 'msg-1', subject: 'Hello' } },
        });

        expect(fallbackExtractor.extractFields).toHaveBeenCalledTimes(1);
        expect(res1.fields).toEqual({
          description: 'Valid AI Description',
          specTag: 'CG104',
          specTitle: 'BED - KING',
          action: 'REC',
        });

        // Rejects unverified allowUserInput lookup candidate from fallback
        fallbackExtractor.extractFields.mockResolvedValueOnce({
          specTag: 'UNVERIFIED-TAG',
        });
        const resUnverified = await service.extractFields({
          documentTypeKey: 'test-doc',
          context: { email: { id: 'msg-2', subject: 'Hello' } },
        });
        expect(resUnverified.fields.specTag).toBeUndefined();

        // Skips fallbackExtractor entirely when all targetable fields are already populated
        fallbackExtractor.extractFields.mockClear();
        const resAllPopulated = await service.extractFields({
          documentTypeKey: 'test-doc',
          context: { email: { id: 'msg-3', subject: 'Hello' } },
          existingData: {
            date: '261020',
            description: 'Already Set',
            specTag: 'CG104',
            action: 'REC',
          },
        });
        expect(fallbackExtractor.extractFields).not.toHaveBeenCalled();
        expect(resAllPopulated.fields.description).toBe('Already Set');
      });
    });

    describe('Iteration 2 Review Fixes', () => {
      it('fails closed when extractor.match or rule.when is present without predicateEvaluator, while still executing unconditional rules', async () => {
        const mockParseRegistry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'gmail',
                match: { '==': [{ var: 'email.fromDomain' }, 'inc.nyc'] },
                fields: {
                  description: { from: 'email.subjectClean' },
                },
              },
              {
                source: 'gmail',
                fields: {
                  action: [
                    {
                      when: { '!=': [{ var: 'email.fromDomain' }, 'inc.nyc'] },
                      set: 'REC',
                    },
                  ],
                  date: { from: 'email.date' },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [
              { key: 'description', type: 'string' },
              {
                key: 'action',
                type: 'string',
                options: { source: 'actions', key: 'key', name: 'name' },
              },
              { key: 'date', type: 'string' },
            ],
            options: {
              actions: [{ key: 'REC', name: 'Received' }],
            },
          }),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: mockParseRegistry,
          // predicateEvaluator intentionally omitted
        });

        const result = await service.extractFields({
          documentTypeKey: 'test-doc',
          context: {
            email: {
              id: 'msg-fail-closed',
              from: 'Someone <someone@inc.nyc>',
              subject: 'Should not populate gated description',
              date: 'Wed, 21 Oct 2026 10:00:00 GMT',
            },
          },
        });

        expect(result.fields.description).toBeUndefined();
        expect(result.fields.action).toBeUndefined();
        expect(result.fields.date).toBe('261021');
      });

      it('iterates multiple regex matches for lookup and correlated fields ("PO123-45 - CG104-A", "PO12345 - CG104-A", and "081100-002-C and 071200-001-B")', async () => {
        const ffeSpecPattern =
          '(?<=^|[\\s_./-])([A-Za-z]{2}\\d{3}[A-Za-z]?)-([A-Za-z0-9]+)(?=[\\s_./-]|$)';
        const mockParseRegistry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockImplementation(async (docTypeKey: string) => {
            if (docTypeKey === 'submittal-ffe') {
              return {
                extractors: [
                  {
                    source: 'gmail',
                    fields: {
                      specTag: {
                        from: 'email.subjectClean',
                        pattern: ffeSpecPattern,
                        group: 1,
                        lookup: true,
                      },
                      revision: {
                        from: 'email.subjectClean',
                        pattern: ffeSpecPattern,
                        group: 2,
                      },
                    },
                  },
                ],
              };
            }
            return {
              extractors: [
                {
                  source: 'gmail',
                  fields: {
                    section: {
                      from: 'email.subjectClean',
                      pattern: '(\\d{6})-(\\d{3})(?:-([A-Za-z0-9]+))?',
                      group: 1,
                    },
                    number: {
                      from: 'email.subjectClean',
                      pattern: '(\\d{6})-(\\d{3})(?:-([A-Za-z0-9]+))?',
                      group: 2,
                    },
                    revision: {
                      from: 'email.subjectClean',
                      pattern: '(\\d{6})-(\\d{3})-([A-Za-z0-9]+)',
                      group: 3,
                    },
                  },
                },
              ],
            };
          }),
          getTargetSchema: vi.fn().mockImplementation(async (docTypeKey: string) => {
            if (docTypeKey === 'submittal-ffe') {
              return {
                fields: [
                  {
                    key: 'specTag',
                    type: 'string',
                    options: { source: 'specs', key: 'key', name: 'name', allowUserInput: true },
                  },
                  {
                    key: 'specTitle',
                    type: 'string',
                    linkedField: { sourceField: 'specTag', sourceProperty: 'name' },
                  },
                  { key: 'revision', type: 'string', minLength: 1 },
                ],
                options: {
                  specs: [{ key: 'CG104', name: 'BED - KING' }],
                },
              };
            }
            return {
              fields: [
                { key: 'section', type: 'string' },
                { key: 'number', type: 'string' },
                { key: 'revision', type: 'string' },
              ],
            };
          }),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: mockParseRegistry,
        });

        // "PO123-45 - CG104-A": PO123 fails lookup, multi-match moves to CG104-A
        const res1 = await service.extractFields({
          documentTypeKey: 'submittal-ffe',
          context: {
            email: {
              id: 'msg-multi-ffe-1',
              subject: 'PO123-45 - CG104-A',
            },
          },
        });
        expect(res1.fields.specTag).toBe('CG104');
        expect(res1.fields.specTitle).toBe('BED - KING');
        expect(res1.fields.revision).toBe('A');

        // "PO12345 - CG104-A": PO12345 does not match bounded specTag pattern, resolves CG104-A
        const res2 = await service.extractFields({
          documentTypeKey: 'submittal-ffe',
          context: {
            email: {
              id: 'msg-multi-ffe-2',
              subject: 'PO12345 - CG104-A',
            },
          },
        });
        expect(res2.fields.specTag).toBe('CG104');
        expect(res2.fields.specTitle).toBe('BED - KING');
        expect(res2.fields.revision).toBe('A');

        // "081100-002-C and 071200-001-B": existingData has section 071200 & number 001 -> correlated revision B
        const resCsi = await service.extractFields({
          documentTypeKey: 'submittal-arch',
          existingData: {
            section: '071200',
            number: '001',
          },
          context: {
            email: {
              id: 'msg-multi-csi',
              subject: '081100-002-C and 071200-001-B',
            },
          },
        });
        expect(resCsi.fields.revision).toBe('B');
      });

      it('supports pattern, flags, group, and excludePattern on email.to and email.cc lookups', async () => {
        const mockParseRegistry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'gmail',
                fields: {
                  contact: [
                    {
                      from: 'email.to',
                      pattern: '\\[code:([A-Za-z0-9]+)\\]',
                      flags: 'i',
                      group: 1,
                      excludePattern: '@inc\\.nyc\\b',
                      lookup: true,
                    },
                    {
                      from: 'email.cc',
                      pattern: '<([^>]+)>',
                      flags: 'i',
                      group: 1,
                      excludePattern: '@inc\\.nyc\\b',
                      lookup: true,
                    },
                  ],
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [
              {
                key: 'contact',
                type: 'string',
                options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true },
              },
            ],
            options: {
              contacts: [
                { key: 'PMG', name: 'Pavarini McGovern', aliases: ['pavarini.com'] },
                { key: 'STO', name: 'Structure Tone', aliases: ['@structuretone.com'] },
              ],
            },
          }),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: mockParseRegistry,
        });

        const toRes = await service.extractFields({
          documentTypeKey: 'test-doc',
          context: {
            email: {
              id: 'msg-to-pattern',
              to: '"Internal, Team [code:PMG]" <team@inc.nyc>, "External [code:STO]" <ext@example.com>',
            },
          },
        });
        expect(toRes.fields.contact).toBe('STO');

        const ccRes = await service.extractFields({
          documentTypeKey: 'test-doc',
          context: {
            email: {
              id: 'msg-cc-pattern',
              to: 'colleague@inc.nyc',
              cc: 'PM <pm@inc.nyc>, "McGovern, James" <jmcgovern@structuretone.com>',
            },
          },
        });
        expect(ccRes.fields.contact).toBe('STO');
      });

      it('binds specTag to CG104-A_CutSheet.pdf before vendor lookup in multi-attachment FF&E emails', async () => {
        const ffeSpecPattern =
          '(?<=^|[\\s_./-])([A-Za-z]{2}\\d{3}[A-Za-z]?)-([A-Za-z0-9]+)(?=[\\s_./-]|$)';
        const mockParseRegistry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'gmail',
                fields: {
                  specTag: [
                    {
                      from: 'attachmentName',
                      pattern: ffeSpecPattern,
                      group: 1,
                      lookup: true,
                    },
                  ],
                  revision: [
                    {
                      from: 'attachmentName',
                      pattern: ffeSpecPattern,
                      group: 2,
                    },
                  ],
                  vendor: [
                    {
                      from: 'attachmentName',
                      lookup: true,
                    },
                    {
                      from: 'email.from',
                      lookup: true,
                    },
                  ],
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [
              {
                key: 'specTag',
                type: 'string',
                options: { source: 'specs', key: 'key', name: 'name', allowUserInput: true },
              },
              {
                key: 'specTitle',
                type: 'string',
                linkedField: { sourceField: 'specTag', sourceProperty: 'name' },
              },
              { key: 'revision', type: 'string', minLength: 1 },
              {
                key: 'vendor',
                type: 'string',
                options: { source: 'vendors', key: 'key', name: 'name', allowUserInput: true },
              },
            ],
            options: {
              specs: [{ key: 'CG104', name: 'BED - KING' }],
              vendors: [{ key: 'BM', name: 'Berman Falk', aliases: ['Berman', '@bermanfalk.com'] }],
            },
          }),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: mockParseRegistry,
        });

        const result = await service.extractFields({
          documentTypeKey: 'submittal-ffe',
          context: {
            email: {
              id: 'msg-multi-att-ffe',
              from: 'Rep <rep@bermanfalk.com>',
              attachments: [
                { id: 'att-1', name: 'Berman_Cover.pdf' },
                { id: 'att-2', name: 'CG104-A_CutSheet.pdf' },
              ],
            },
          },
        });

        expect(result.fields.specTag).toBe('CG104');
        expect(result.fields.specTitle).toBe('BED - KING');
        expect(result.fields.revision).toBe('A');
        expect(result.fields.vendor).toBe('BM');
      });
    });

    describe('Iteration 3 Review Fixes', () => {
      it('parses apostrophes inside double-quoted and unquoted display names in parseRecipient and extractFields lookup', async () => {
        expect(parseRecipient('"O\'Brien, James" <jobrien@example.com>')).toEqual({
          raw: '"O\'Brien, James" <jobrien@example.com>',
          displayName: "O'Brien, James",
          email: 'jobrien@example.com',
          domain: 'example.com',
        });

        expect(parseRecipient("O'Brien <jobrien@example.com>")).toEqual({
          raw: "O'Brien <jobrien@example.com>",
          displayName: "O'Brien",
          email: 'jobrien@example.com',
          domain: 'example.com',
        });

        const mockParseRegistry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'gmail',
                fields: {
                  contact: [
                    {
                      from: 'email.from',
                      lookup: true,
                    },
                  ],
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [
              {
                key: 'contact',
                type: 'string',
                options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true },
              },
            ],
            options: {
              contacts: [
                { key: 'OBR', name: "O'Brien, James", aliases: ["O'Brien"] },
              ],
            },
          }),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: mockParseRegistry,
        });

        const quotedRes = await service.extractFields({
          documentTypeKey: 'test-doc',
          context: {
            email: {
              id: 'msg-obrien-quoted',
              from: '"O\'Brien, James" <jobrien@example.com>',
            },
          },
        });
        expect(quotedRes.fields.contact).toBe('OBR');

        const unquotedRes = await service.extractFields({
          documentTypeKey: 'test-doc',
          context: {
            email: {
              id: 'msg-obrien-unquoted',
              from: "O'Brien <jobrien@example.com>",
            },
          },
        });
        expect(unquotedRes.fields.contact).toBe('OBR');
      });
    });

    describe('Ticket #307: Pass 2 source: "drive" extractor, workspace timeZone, and Gmail-first precedence', () => {
      const commParseSchema = {
        extractors: [
          {
            source: 'gmail' as const,
            fields: {
              date: { from: 'email.date' as const },
              description: { from: 'email.subjectClean' as const },
            },
          },
          {
            source: 'drive' as const,
            fields: {
              date: [
                { from: 'drive.modifiedTime' as const },
                { from: 'drive.createdTime' as const },
              ],
            },
          },
        ],
      };

      const commTargetSchema = {
        fields: [
          { key: 'contact', type: 'string', options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true } },
          { key: 'date', type: 'string' },
          { key: 'direction', type: 'string' },
          { key: 'description', type: 'string' },
        ],
      };

      it('populates date in yyMMdd from drive.modifiedTime in workspace timeZone and falls back to drive.createdTime', async () => {
        const drivePort: DriveSourceContextPort = {
          getItemHierarchy: vi
            .fn()
            .mockResolvedValueOnce({
              item: {
                id: 'file-evening',
                name: 'Project_Notes.pdf',
                mimeType: 'application/pdf',
                // 2026-03-16 02:30 UTC is 2026-03-15 22:30 EDT in America/New_York
                modifiedTime: '2026-03-16T02:30:00Z',
                createdTime: '2026-03-10T12:00:00Z',
              },
              ancestors: [],
            })
            .mockResolvedValueOnce({
              item: {
                id: 'file-created-only',
                name: 'Created_Only.pdf',
                mimeType: 'application/pdf',
                createdTime: '2026-11-02T04:30:00Z', // 2026-11-01 23:30 EST (post DST fall-back)
              },
              ancestors: [],
            }),
        };

        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue(commParseSchema),
          getTargetSchema: vi.fn().mockResolvedValue(commTargetSchema),
        };

        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: registry,
          configPort: { getWorkspaceTimeZone: async () => 'America/New_York' },
        });

        const res1 = await service.extractFields({
          documentTypeKey: 'communication-project',
          context: { items: [{ id: 'file-evening' }] },
        });
        expect(res1.fields).toEqual({ date: '260315' });

        const res2 = await service.extractFields({
          documentTypeKey: 'communication-project',
          context: { items: [{ id: 'file-created-only' }] },
        });
        expect(res2.fields).toEqual({ date: '261101' });
      });

      it('exposes full drive metadata in JsonLogic without mutating cached ancestors and handles Google Workspace MIME stems', async () => {
        const cachedAncestors = [
          { id: 'f-1', name: '1 Admin/Communication' },
          { id: 'f-2', name: 'Acme' },
        ];
        const drivePort: DriveSourceContextPort = {
          getItemHierarchy: vi.fn().mockResolvedValue({
            item: {
              id: 'gdoc-1',
              name: 'Spec_v1.2',
              mimeType: 'application/vnd.google-apps.document',
              modifiedTime: '2026-10-19T15:00:00Z',
              createdTime: '2026-10-18T12:00:00Z',
            },
            driveId: 'drive-1',
            driveName: 'Project Alpha',
            ancestors: cachedAncestors,
          }),
        };

        const capturedData: Array<Record<string, unknown>> = [];
        const spyEvaluator = {
          evaluate: vi.fn((_rule: unknown, data: Record<string, unknown>) => {
            capturedData.push(data);
            return true;
          }),
        };

        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'drive' as const,
                match: { '==': [{ var: 'drive.isFolder' }, false] },
                fields: {
                  description: {
                    when: { '==': [{ var: 'drive.parentName' }, 'Acme'] },
                    from: 'drive.fileNameStem' as const,
                  },
                  date: { from: 'drive.modifiedTime' as const },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue(commTargetSchema),
        };

        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: registry,
          predicateEvaluator: spyEvaluator,
          configPort: { getWorkspaceTimeZone: () => 'America/New_York' },
        });

        const res = await service.extractFields({
          documentTypeKey: 'communication-project',
          context: { items: [{ id: 'gdoc-1' }] },
        });

        expect(res.fields).toEqual({
          description: 'Spec_v1.2',
          date: '261019',
        });
        expect(cachedAncestors).toEqual([
          { id: 'f-1', name: '1 Admin/Communication' },
          { id: 'f-2', name: 'Acme' },
        ]);
        expect(capturedData[0]?.drive).toEqual({
          id: 'gdoc-1',
          fileName: 'Spec_v1.2',
          fileNameStem: 'Spec_v1.2',
          mimeType: 'application/vnd.google-apps.document',
          isFolder: false,
          createdTime: '2026-10-18T12:00:00Z',
          modifiedTime: '2026-10-19T15:00:00Z',
          parentName: 'Acme',
          folderPath: '1 Admin/Communication/Acme',
          ancestors: ['1 Admin/Communication', 'Acme'],
          driveId: 'drive-1',
          driveName: 'Project Alpha',
        });
      });

      it('runs gmail before drive in Google Drive URL mode: skips getItemHierarchy when gmail populates date, and falls back to drive when email.date is absent', async () => {
        const drivePort: DriveSourceContextPort = {
          getItemHierarchy: vi.fn().mockResolvedValue({
            item: {
              id: 'drive-url-file',
              name: 'URL_File.pdf',
              modifiedTime: '2026-10-20T14:00:00Z',
            },
            ancestors: [],
          }),
        };

        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue(commParseSchema),
          getTargetSchema: vi.fn().mockResolvedValue(commTargetSchema),
        };

        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: registry,
          configPort: { getWorkspaceTimeZone: () => 'America/New_York' },
        });

        // Case 1: email.date present -> gmail wins, getItemHierarchy not called
        const resWithEmailDate = await service.extractFields({
          documentTypeKey: 'communication-project',
          context: {
            isDriveUrl: true,
            items: [{ id: 'drive-url-file' }],
            email: {
              id: 'msg-1',
              subject: 'Re: Progress Update',
              date: 'Mon, 19 Oct 2026 10:00:00 -0400',
            },
          },
        });
        expect(resWithEmailDate.fields).toEqual({
          date: '261019',
          description: 'Progress Update',
        });
        expect(drivePort.getItemHierarchy).not.toHaveBeenCalled();

        // Case 2: email.date absent -> gmail populates description, drive fills blank date
        const resWithoutEmailDate = await service.extractFields({
          documentTypeKey: 'communication-project',
          context: {
            isDriveUrl: true,
            items: [{ id: 'drive-url-file' }],
            email: {
              id: 'msg-2',
              subject: 'Re: Progress Update',
            },
          },
        });
        expect(resWithoutEmailDate.fields).toEqual({
          description: 'Progress Update',
          date: '261020',
        });
        expect(drivePort.getItemHierarchy).toHaveBeenCalledTimes(1);
      });

      it('skips source: "drive" extractors completely in Gmail Email Attachments mode', async () => {
        const drivePort: DriveSourceContextPort = {
          getItemHierarchy: vi.fn(),
        };

        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue(commParseSchema),
          getTargetSchema: vi.fn().mockResolvedValue(commTargetSchema),
        };

        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: registry,
        });

        const res = await service.extractFields({
          documentTypeKey: 'communication-project',
          context: {
            items: [{ id: 'gmail-att-part-1', name: 'Notes.pdf' }],
            email: {
              id: 'msg-att-1',
              subject: 'Email With Attachment',
              attachments: [{ id: 'gmail-att-part-1', name: 'Notes.pdf' }],
            },
          },
        });

        expect(res.fields).toEqual({ description: 'Email With Attachment' });
        expect(drivePort.getItemHierarchy).not.toHaveBeenCalled();
      });

      it('emits deduplicated Pass 2 Drive metadata error notice when getItemHierarchy throws and includes drive lookup fields in fallback validation', async () => {
        const drivePort: DriveSourceContextPort = {
          getItemHierarchy: vi.fn().mockRejectedValue(new Error('Drive API 503')),
        };
        const fallbackExtractor = {
          extractFields: vi.fn().mockResolvedValue({ contact: 'Acme Corp' }),
        };

        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'drive' as const,
                fields: {
                  date: { from: 'drive.modifiedTime' as const },
                  contact: { from: 'drive.fileNameStem' as const, lookup: true as const },
                },
              },
            ],
            fallback: { strategy: 'ai' as const, fields: ['contact'] },
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [
              { key: 'date', type: 'string' },
              { key: 'contact', type: 'string', options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true } },
            ],
            options: {
              contacts: [{ key: 'ACM', name: 'Acme Corp' }],
            },
          }),
        };

        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: registry,
          fallbackExtractor,
        });

        const res = await service.extractFields({
          documentTypeKey: 'communication-project',
          context: { items: [{ id: 'file-err' }] },
        });

        expect(res.statusMessages).toEqual([
          'Could not read Google Drive file metadata or document form fields to pre-populate fields; you can enter them manually.',
        ]);
        expect(res.fields.contact).toBe('ACM');
      });

      it('handles DriveSourceContextPort errors across Pass 1 + Pass 2, preserves gmail fields, and deduplicates Pass 2 notice across multiple drive extractors', async () => {
        const err = new Error('Not found') as Error & { statusCode: number };
        err.statusCode = 404;
        const mockedDrivePort: DriveSourceContextPort = {
          getItemHierarchy: vi.fn().mockRejectedValue(err),
        };
        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'gmail' as const,
                fields: {
                  description: { from: 'email.subjectClean' as const },
                },
              },
              {
                source: 'drive' as const,
                fields: {
                  date: { from: 'drive.modifiedTime' as const },
                },
              },
              {
                source: 'drive' as const,
                fields: {
                  contact: { from: 'drive.fileNameStem' as const },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [
              { key: 'description', type: 'string' },
              { key: 'date', type: 'string' },
              { key: 'contact', type: 'string' },
            ],
          }),
        };

        const spaceConfigPort: SourceParserSpaceConfigPort = {
          getDocumentSpaceTypes: vi.fn().mockResolvedValue([
            {
              id: 'projects',
              displayName: 'Projects',
              spaceSchema: {
                allowedDocumentTypes: ['communication-project'],
                defaultDocumentType: 'communication-project',
              },
              storageConfig: { provider: 'google_drive', fetchMethod: 'shared_drives' },
            },
          ]),
        };

        const service = new SourceParserService(mockedDrivePort, spaceConfigPort, {
          parseSchemaRegistry: registry,
        });

        const routing = await service.inferRouting({
          items: [{ id: 'shortcut-broken' }],
        });
        expect(routing.statusMessages).toEqual([
          'Could not inspect Google Drive folder hierarchy; please verify Document Space and Document Type.',
        ]);

        const extracted = await service.extractFields({
          documentTypeKey: 'communication-project',
          context: {
            isDriveUrl: true,
            items: [{ id: 'shortcut-broken' }],
            email: {
              id: 'msg-1',
              subject: 'Weekly Update',
            },
          },
        });

        expect(extracted.fields.description).toBe('Weekly Update');
        expect(extracted.statusMessages).toEqual([
          'Could not read Google Drive file metadata or document form fields to pre-populate fields; you can enter them manually.',
        ]);
      });

      it('remains stateless across separate extractFields calls on distinct contexts for the same itemId', async () => {
        let callCount = 0;
        const drivePort: DriveSourceContextPort = {
          getItemHierarchy: vi.fn().mockImplementation(async (itemId: string) => {
            callCount++;
            return {
              item: {
                id: itemId,
                name: 'File.pdf',
                mimeType: 'application/pdf',
                modifiedTime: callCount === 1 ? '2026-10-15T12:00:00Z' : '2026-10-20T12:00:00Z',
              },
              ancestors: [],
            };
          }),
        };

        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'drive' as const,
                fields: {
                  date: { from: 'drive.modifiedTime' as const },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [{ key: 'date', type: 'string' }],
          }),
        };

        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: registry,
        });

        const first = await service.extractFields({
          documentTypeKey: 'communication-project',
          context: { items: [{ id: 'shared-id' }] },
        });
        const second = await service.extractFields({
          documentTypeKey: 'communication-project',
          context: { items: [{ id: 'shared-id' }] },
        });

        expect(first.fields.date).toBe('261015');
        expect(second.fields.date).toBe('261020');
        expect(drivePort.getItemHierarchy).toHaveBeenCalledTimes(2);
      });
    });

    describe('Ticket #308: normalize: "yymmdd" ([today - 12 months, today]) and Google Workspace MIME-aware fileNameStem', () => {
      const commParseSchemaWithFilenameDate = {
        extractors: [
          {
            source: 'drive' as const,
            fields: {
              date: [
                { from: 'drive.fileNameStem' as const, normalize: 'yymmdd' as const },
                { from: 'drive.modifiedTime' as const },
                { from: 'drive.createdTime' as const },
              ],
            },
          },
        ],
      };

      const commTargetSchema = {
        fields: [
          { key: 'date', type: 'string' },
          { key: 'description', type: 'string' },
          {
            key: 'contact',
            type: 'string',
            options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true },
          },
        ],
        options: {
          contacts: [{ key: 'ACM', name: 'Acme' }],
        },
      };

      it('extracts INC yyMMdd date from drive.fileNameStem within [today - 12 months, today] ahead of modifiedTime using injected now clock', async () => {
        const drivePort: DriveSourceContextPort = {
          getItemHierarchy: vi
            .fn()
            .mockResolvedValueOnce({
              item: {
                id: 'file-yymmdd',
                name: '261115_Client_Meeting_Notes.pdf',
                mimeType: 'application/pdf',
                modifiedTime: '2026-11-18T14:00:00Z',
                createdTime: '2026-11-18T12:00:00Z',
              },
              ancestors: [],
            })
            .mockResolvedValueOnce({
              item: {
                id: 'file-jan-dec',
                name: '251228_Year_End_Minutes.pdf',
                mimeType: 'application/pdf',
                modifiedTime: '2026-01-05T14:00:00Z',
              },
              ancestors: [],
            }),
        };

        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue(commParseSchemaWithFilenameDate),
          getTargetSchema: vi.fn().mockResolvedValue(commTargetSchema),
        };

        const novService = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: registry,
          configPort: { getWorkspaceTimeZone: () => 'America/New_York' },
          now: () => new Date('2026-11-20T15:00:00Z'),
        });

        const novRes = await novService.extractFields({
          documentTypeKey: 'communication-project',
          context: { items: [{ id: 'file-yymmdd' }] },
        });
        expect(novRes.fields).toEqual({ date: '261115' });

        // Late-December date in early January is within [today - 12 months, today]
        const janService = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: registry,
          configPort: { getWorkspaceTimeZone: () => 'America/New_York' },
          now: () => new Date('2026-01-05T15:00:00Z'),
        });

        const janRes = await janService.extractFields({
          documentTypeKey: 'communication-project',
          context: { items: [{ id: 'file-jan-dec' }] },
        });
        expect(janRes.fields).toEqual({ date: '251228' });
      });

      it('extracts delimited 4-digit and 2-digit year dates, prioritizing 4-digit-year patterns before 2-digit-year and yyMMdd', async () => {
        const drivePort: DriveSourceContextPort = {
          getItemHierarchy: vi
            .fn()
            .mockResolvedValueOnce({
              item: {
                id: 'f-ymd-dash',
                name: '07.12.00_Submittal_002_Rev1_Waterproofing_2026-11-15.pdf',
                mimeType: 'application/pdf',
                modifiedTime: '2026-11-19T12:00:00Z',
              },
              ancestors: [],
            })
            .mockResolvedValueOnce({
              item: {
                id: 'f-mdy-4',
                name: 'Notes_11_15_2026.pdf',
                mimeType: 'application/pdf',
                modifiedTime: '2026-11-19T12:00:00Z',
              },
              ancestors: [],
            })
            .mockResolvedValueOnce({
              item: {
                id: 'f-mdy-2',
                name: 'Notes_11.14.26.pdf',
                mimeType: 'application/pdf',
                modifiedTime: '2026-11-19T12:00:00Z',
              },
              ancestors: [],
            })
            .mockResolvedValueOnce({
              item: {
                id: 'f-priority',
                name: '260101_Notes_2026-11-15.pdf',
                mimeType: 'application/pdf',
                modifiedTime: '2026-11-19T12:00:00Z',
              },
              ancestors: [],
            }),
        };

        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue(commParseSchemaWithFilenameDate),
          getTargetSchema: vi.fn().mockResolvedValue(commTargetSchema),
        };

        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: registry,
          configPort: { getWorkspaceTimeZone: () => 'America/New_York' },
          now: () => new Date('2026-11-20T15:00:00Z'),
        });

        expect(
          (await service.extractFields({ documentTypeKey: 'communication-project', context: { items: [{ id: 'f-ymd-dash' }] } })).fields
        ).toEqual({ date: '261115' });
        expect(
          (await service.extractFields({ documentTypeKey: 'communication-project', context: { items: [{ id: 'f-mdy-4' }] } })).fields
        ).toEqual({ date: '261115' });
        expect(
          (await service.extractFields({ documentTypeKey: 'communication-project', context: { items: [{ id: 'f-mdy-2' }] } })).fields
        ).toEqual({ date: '261114' });
        expect(
          (await service.extractFields({ documentTypeKey: 'communication-project', context: { items: [{ id: 'f-priority' }] } })).fields
        ).toEqual({ date: '261115' });
      });

      it('enforces [today - 12 months, today] in workspace timeZone, rejects calendar-invalid dates and CSI prefixes (260519-001, 07.12.00, 081113), and falls back to modifiedTime', async () => {
        const cases: Array<{ id: string; name: string; expectedDate: string }> = [
          // Inclusive lower and upper bounds on 2026-11-20 EST (2026-11-21T02:00:00Z is still Nov 20 in NY!)
          { id: 'c-today', name: '261120_Today_Notes.pdf', expectedDate: '261120' },
          { id: 'c-12mo', name: '251120_Year_Ago_Notes.pdf', expectedDate: '251120' },
          // Rejected future date (> today in America/New_York) -> falls back to modifiedTime
          { id: 'c-future', name: '261121_Tomorrow_Notes.pdf', expectedDate: '261118' },
          // Rejected stale date (< today - 12 months) -> falls back to modifiedTime
          { id: 'c-stale', name: '251119_Too_Old_Notes.pdf', expectedDate: '261118' },
          // Rejected calendar-invalid dates -> falls back to modifiedTime
          { id: 'c-feb30', name: '260230_Invalid_Date.pdf', expectedDate: '261118' },
          { id: 'c-apr31', name: '260431_Invalid_Date.pdf', expectedDate: '261118' },
          { id: 'c-feb29-nonleap', name: '260229_Non_Leap.pdf', expectedDate: '261118' },
          { id: 'c-071200', name: '071200_Invalid_CSI.pdf', expectedDate: '261118' },
          // Rejected out-of-window CSI codes -> falls back to modifiedTime
          { id: 'c-csi-dot', name: '07.12.00_Waterproofing.pdf', expectedDate: '261118' },
          { id: 'c-csi-08', name: '081113_Hollow_Metal_Doors.pdf', expectedDate: '261118' },
          // Protected Division 26 CSI prefix (260519-001) -> falls back to modifiedTime
          { id: 'c-div26', name: '260519-001_Lighting_Controls.pdf', expectedDate: '261118' },
          // Protected Division 26 prefix followed by actual date -> extracts trailing date
          { id: 'c-div26-plus-date', name: '260519-001_Minutes_261115.pdf', expectedDate: '261115' },
        ];

        const drivePort: DriveSourceContextPort = {
          getItemHierarchy: vi.fn(async (id: string) => {
            const match = cases.find((c) => c.id === id);
            return {
              item: {
                id,
                name: match?.name ?? 'Unknown.pdf',
                mimeType: 'application/pdf',
                modifiedTime: '2026-11-18T14:00:00Z',
              },
              ancestors: [],
            };
          }),
        };

        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue(commParseSchemaWithFilenameDate),
          getTargetSchema: vi.fn().mockResolvedValue(commTargetSchema),
        };

        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: registry,
          configPort: { getWorkspaceTimeZone: () => 'America/New_York' },
          // 2026-11-21 02:00 UTC = 2026-11-20 21:00 EST in America/New_York
          now: () => new Date('2026-11-21T02:00:00Z'),
        });

        for (const testCase of cases) {
          const res = await service.extractFields({
            documentTypeKey: 'communication-project',
            context: { items: [{ id: testCase.id }] },
          });
          expect(res.fields.date, testCase.id).toBe(testCase.expectedDate);
        }

        // Leap day 240229 is accepted when within [today - 12 months, today]
        const leapDrivePort: DriveSourceContextPort = {
          getItemHierarchy: vi.fn().mockResolvedValue({
            item: {
              id: 'leap-day',
              name: '240229_Leap_Day_Notes.pdf',
              mimeType: 'application/pdf',
              modifiedTime: '2024-03-01T12:00:00Z',
            },
            ancestors: [],
          }),
        };
        const leapService = new SourceParserService(leapDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: registry,
          configPort: { getWorkspaceTimeZone: () => 'America/New_York' },
          now: () => new Date('2024-06-01T12:00:00Z'),
        });
        const leapRes = await leapService.extractFields({
          documentTypeKey: 'communication-project',
          context: { items: [{ id: 'leap-day' }] },
        });
        expect(leapRes.fields.date).toBe('240229');
      });

      it('preserves extensionless Google Workspace titles (Spec_v1.2, 07.12.00) in drive.fileNameStem and falls back to modifiedTime for date', async () => {
        const drivePort: DriveSourceContextPort = {
          getItemHierarchy: vi
            .fn()
            .mockResolvedValueOnce({
              item: {
                id: 'gdoc-spec',
                name: 'Spec_v1.2',
                mimeType: 'application/vnd.google-apps.document',
                modifiedTime: '2026-11-18T14:00:00Z',
              },
              ancestors: [],
            })
            .mockResolvedValueOnce({
              item: {
                id: 'gsheet-csi',
                name: '07.12.00',
                mimeType: 'application/vnd.google-apps.spreadsheet',
                modifiedTime: '2026-11-17T14:00:00Z',
              },
              ancestors: [],
            })
            .mockResolvedValueOnce({
              item: {
                id: 'gfolder',
                name: '261115_Client.Review',
                mimeType: 'application/vnd.google-apps.folder',
                modifiedTime: '2026-11-16T14:00:00Z',
              },
              ancestors: [],
            }),
        };

        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'drive' as const,
                fields: {
                  description: { from: 'drive.fileNameStem' as const },
                  date: [
                    { from: 'drive.fileNameStem' as const, normalize: 'yymmdd' as const },
                    { from: 'drive.modifiedTime' as const },
                  ],
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue(commTargetSchema),
        };

        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: registry,
          configPort: { getWorkspaceTimeZone: () => 'America/New_York' },
          now: () => new Date('2026-11-20T15:00:00Z'),
        });

        expect(
          (await service.extractFields({ documentTypeKey: 'communication-project', context: { items: [{ id: 'gdoc-spec' }] } })).fields
        ).toEqual({ description: 'Spec_v1.2', date: '261118' });

        expect(
          (await service.extractFields({ documentTypeKey: 'communication-project', context: { items: [{ id: 'gsheet-csi' }] } })).fields
        ).toEqual({ description: '07.12.00', date: '261117' });

        expect(
          (await service.extractFields({ documentTypeKey: 'communication-project', context: { items: [{ id: 'gfolder' }] } })).fields
        ).toEqual({ description: '261115_Client.Review', date: '261115' });
      });

      it('applies normalize: "yymmdd" before DocumentField pattern constraints and LookupField resolution on both gmail and drive', async () => {
        const drivePort: DriveSourceContextPort = {
          getItemHierarchy: vi.fn().mockResolvedValue({
            item: {
              id: 'file-lookup-norm',
              name: 'Meeting_2026-11-15.pdf',
              mimeType: 'application/pdf',
              modifiedTime: '2026-11-18T14:00:00Z',
            },
            ancestors: [],
          }),
        };

        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'gmail' as const,
                fields: {
                  date: { from: 'email.subjectClean' as const, normalize: 'yymmdd' as const },
                },
              },
              {
                source: 'drive' as const,
                fields: {
                  contact: { from: 'drive.fileNameStem' as const, normalize: 'yymmdd' as const, lookup: true as const },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [
              { key: 'date', type: 'string', pattern: '^\\d{6}$' },
              {
                key: 'contact',
                type: 'string',
                options: { source: 'contacts', key: 'key', name: 'name' },
              },
            ],
            options: {
              contacts: [{ key: '261115', name: 'Nov 15 Batch' }],
            },
          }),
        };

        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: registry,
          configPort: { getWorkspaceTimeZone: () => 'America/New_York' },
          now: () => new Date('2026-11-20T15:00:00Z'),
        });

        const res = await service.extractFields({
          documentTypeKey: 'communication-project',
          context: {
            isDriveUrl: true,
            items: [{ id: 'file-lookup-norm' }],
            email: {
              id: 'msg-norm',
              subject: 'Re: Minutes 11-14-2026',
            },
          },
        });

        expect(res.fields).toEqual({
          date: '261114',
          contact: '261115',
        });
      });

      it('applies normalize: "formDate" on extractor rules across all 5 date groups without rolling 12-month cap', async () => {
        const drivePort: DriveSourceContextPort = {
          getItemHierarchy: vi.fn().mockResolvedValue({
            item: {
              id: 'file-formdate-rule',
              name: 'Doc.pdf',
              mimeType: 'application/pdf',
            },
            ancestors: [],
          }),
        };

        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'gmail' as const,
                fields: {
                  date: { from: 'email.subjectClean' as const, normalize: 'formDate' as const },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [{ key: 'date', type: 'string', pattern: '^\\d{6}$' }],
          }),
        };

        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: registry,
          now: () => new Date('2026-11-22T12:00:00Z'),
        });

        const accepted = [
          ['2023-09-13', '230913'],
          ['2026-11-21T14:30:00Z', '261121'],
          ['5/8/26', '260508'],
          ['Sept 8, 2026', '260908'],
          ['May 8th, 2026', '260508'],
          ['8 May 2026', '260508'],
          ['261121', '261121'],
        ] as const;

        for (const [input, expected] of accepted) {
          const res = await service.extractFields({
            documentTypeKey: 'submittal-arch',
            context: { email: { id: 'm1', subject: input } },
          });
          expect(res.fields.date, input).toBe(expected);
        }

        for (const rejected of ['DATE', '1999-12-31', '2100-01-01', '2026-11/21', '02/29/2025', '2026-04-31']) {
          const res = await service.extractFields({
            documentTypeKey: 'submittal-arch',
            context: { email: { id: 'm1', subject: rejected } },
          });
          expect(res.fields.date, rejected).toBeUndefined();
        }
      });
    });

    describe('Ticket #310: Flexible Submittal Arch normalizers, correlated codes, and multi-file Drive binding', () => {
      it('applies normalize: "digits6" and "pad3" before field pattern validation and skips non-conforming values', async () => {
        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'drive' as const,
                fields: {
                  section: [
                    { from: 'drive.fileNameStem' as const, pattern: '(\\d{2}[\\s._-]\\d{2}[\\s._-]\\d{2}|\\d{5,7})', group: 1, normalize: 'digits6' as const },
                  ],
                  number: [
                    { from: 'drive.fileNameStem' as const, pattern: '#(\\d{1,4})', group: 1, normalize: 'pad3' as const },
                  ],
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [
              { key: 'section', type: 'string', pattern: '^\\d{6}$' },
              { key: 'number', type: 'string', pattern: '^\\d{3}$' },
            ],
          }),
        };

        const drivePort: DriveSourceContextPort = {
          getItemHierarchy: vi
            .fn()
            .mockResolvedValueOnce({
              item: { id: 'f1', name: 'Section 07 12 00 #1.pdf', mimeType: 'application/pdf' },
              ancestors: [],
            })
            .mockResolvedValueOnce({
              item: { id: 'f2', name: '07.12.00 #12.pdf', mimeType: 'application/pdf' },
              ancestors: [],
            })
            .mockResolvedValueOnce({
              item: { id: 'f3', name: '07120 #1234.pdf', mimeType: 'application/pdf' },
              ancestors: [],
            }),
        };

        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: registry,
        });

        expect((await service.extractFields({ documentTypeKey: 'submittal-arch', context: { items: [{ id: 'f1' }] } })).fields).toEqual({
          section: '071200',
          number: '001',
        });
        expect((await service.extractFields({ documentTypeKey: 'submittal-arch', context: { items: [{ id: 'f2' }] } })).fields).toEqual({
          section: '071200',
          number: '012',
        });
        expect((await service.extractFields({ documentTypeKey: 'submittal-arch', context: { items: [{ id: 'f3' }] } })).fields).toEqual({});
      });

      it('normalizes revision and 1-based version tokens while rejecting Review, Revised, R-19, 120V, 277V, v1.2, v1.0.2, Rev 1.0, -Waterproofing, and -2026', async () => {
        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'drive' as const,
                fields: {
                  revision: { from: 'drive.fileNameStem' as const, normalize: 'revision' as const },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [{ key: 'revision', type: 'string', minLength: 1 }],
          }),
        };

        const cases: Array<{ name: string; expected: string | undefined }> = [
          { name: '07 12 00 - 1_v1_Waterproofing.pdf', expected: '0' },
          { name: '07 12 00 - 1_v2_Waterproofing.pdf', expected: '1' },
          { name: '07 12 00 - 1_v0_Waterproofing.pdf', expected: '0' },
          { name: '07 12 00 - 1_v1.0_Waterproofing.pdf', expected: '0' },
          { name: '07 12 00 - 1_Ver. 1_Waterproofing.pdf', expected: '0' },
          { name: '07 12 00 - 1_Version 03_Waterproofing.pdf', expected: '2' },
          { name: '07.12.00_Submittal_002_Rev 0_Waterproofing.pdf', expected: '0' },
          { name: '07.12.00_Submittal_002_Rev. A_Waterproofing.pdf', expected: 'A' },
          { name: '07.12.00_Submittal_002_R1_Waterproofing.pdf', expected: '1' },
          { name: '07.12.00_Submittal_002_Revision B_Waterproofing.pdf', expected: 'B' },
          { name: '071200-001_v1.2_Waterproofing.pdf', expected: undefined },
          { name: '071200-001_v1.0.2_Waterproofing.pdf', expected: undefined },
          { name: '071200-001_Rev 1.0_Waterproofing.pdf', expected: undefined },
          { name: '071200-001_Review_Waterproofing.pdf', expected: undefined },
          { name: '071200-001_Revised_Waterproofing.pdf', expected: undefined },
          { name: '071200-001_R-19_Insulation.pdf', expected: undefined },
          { name: '071200-001_120V_Panel.pdf', expected: undefined },
          { name: '071200-001_277V_Lighting.pdf', expected: undefined },
          { name: '071200-001-Waterproofing.pdf', expected: undefined },
          { name: '071200-001-Berman_Falk.pdf', expected: undefined },
          { name: '071200-001-2026.pdf', expected: undefined },
        ];

        for (const c of cases) {
          const drivePort: DriveSourceContextPort = {
            getItemHierarchy: vi.fn().mockResolvedValue({
              item: { id: 'f-rev', name: c.name, mimeType: 'application/pdf' },
              ancestors: [],
            }),
          };
          const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
            parseSchemaRegistry: registry,
          });
          const res = await service.extractFields({
            documentTypeKey: 'submittal-arch',
            context: { items: [{ id: 'f-rev' }] },
          });
          expect(res.fields.revision, c.name).toBe(c.expected);
        }

        // Tight single-token suffix values (-A, -0, -R, -12) when extracted by regex group
        const suffixRegistry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'drive' as const,
                fields: {
                  revision: {
                    from: 'drive.fileNameStem' as const,
                    pattern: '\\d{6}-\\d{3}(-\\d{1,2}|-[A-Za-z])(?![A-Za-z0-9])',
                    group: 1,
                    normalize: 'revision' as const,
                  },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [{ key: 'revision', type: 'string', minLength: 1 }],
          }),
        };

        for (const [name, expected] of [
          ['071200-001-R Waterproofing.pdf', 'R'],
          ['071200-001-0 Waterproofing.pdf', '0'],
          ['071200-001-A Waterproofing.pdf', 'A'],
          ['071200-001-12 Waterproofing.pdf', '12'],
        ] as const) {
          const drivePort: DriveSourceContextPort = {
            getItemHierarchy: vi.fn().mockResolvedValue({
              item: { id: 'f-suf', name, mimeType: 'application/pdf' },
              ancestors: [],
            }),
          };
          const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
            parseSchemaRegistry: suffixRegistry,
          });
          const res = await service.extractFields({
            documentTypeKey: 'submittal-arch',
            context: { items: [{ id: 'f-suf' }] },
          });
          expect(res.fields.revision, name).toBe(expected);
        }
      });

      it('applies cleanFilenameText stripping extensions only on drive.fileName and attachmentName without truncating .Inc/.Ltd in email.subjectClean', async () => {
        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'gmail' as const,
                fields: {
                  title: [
                    { from: 'attachmentName' as const, normalize: 'cleanFilenameText' as const },
                    { from: 'email.subjectClean' as const, normalize: 'cleanFilenameText' as const },
                  ],
                },
              },
              {
                source: 'drive' as const,
                fields: {
                  title: { from: 'drive.fileName' as const, normalize: 'cleanFilenameText' as const },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [{ key: 'title', type: 'string', minLength: 1 }],
          }),
        };

        const drivePort: DriveSourceContextPort = {
          getItemHierarchy: vi.fn().mockResolvedValue({
            item: { id: 'f-clean', name: ' - __Fluid__Applied_Waterproofing_-_.pdf', mimeType: 'application/pdf' },
            ancestors: [],
          }),
        };

        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: registry,
        });

        // Subject with .Inc / .Ltd is NOT truncated
        const subjRes = await service.extractFields({
          documentTypeKey: 'submittal-arch',
          context: {
            email: {
              id: 'msg-inc',
              subject: 'Re: -- _Waterproofing_by_Acme.Inc_ --',
            },
          },
        });
        expect(subjRes.fields.title).toBe('Waterproofing by Acme.Inc');

        const ltdRes = await service.extractFields({
          documentTypeKey: 'submittal-arch',
          context: {
            email: {
              id: 'msg-ltd',
              subject: 'Waterproofing_Supply.Ltd',
            },
          },
        });
        expect(ltdRes.fields.title).toBe('Waterproofing Supply.Ltd');

        // attachmentName strips extension
        const attRes = await service.extractFields({
          documentTypeKey: 'submittal-arch',
          context: {
            email: {
              id: 'msg-att',
              attachments: [{ id: 'a1', name: ' - Fluid_Applied_Waterproofing_Spec.pdf' }],
            },
          },
        });
        expect(attRes.fields.title).toBe('Fluid Applied Waterproofing Spec');

        // drive.fileName strips extension and trims separators
        const driveRes = await service.extractFields({
          documentTypeKey: 'submittal-arch',
          context: { items: [{ id: 'f-clean' }] },
        });
        expect(driveRes.fields.title).toBe('Fluid Applied Waterproofing');
      });

      it('does not double-strip .Inc/.Ltd/.2 when attachmentName or drive.fileName pattern already stripped .pdf', async () => {
        const attachmentTitlePattern =
          '(?:^|[\\s_./-])(\\d{6}|\\d{2} \\d{2} \\d{2}|\\d{2}\\.\\d{2}\\.\\d{2}|\\d{2}-\\d{2}-\\d{2}|\\d{2}_\\d{2}_\\d{2})(?:[\\s_.-]*(?:submittal|sub\\.?|no\\.?)[\\s_.-]*#?[\\s_.-]*|[\\s_.-]*#[\\s_.-]*|[\\s_.-]+)(\\d{1,3})(?![A-Za-z0-9])(?!-\\d{2}[-_.]\\d{2,4})(?:-(?:\\d{1,2}|[A-Za-z])(?![A-Za-z0-9]|-\\d)|[\\s_.-]+(?:(?:v|ver\\.?|version)[\\s_.-]*\\d+(?:\\.0+)?|(?:rev(?:ision)?\\.?|r(?=[\\s_.]*(?:\\d|[A-Za-z]\\b)))[\\s_.-]*(?:\\d{1,2}[A-Za-z]?|[A-Za-z]\\d{0,2}))(?![A-Za-z0-9]|\\.\\d))?(?:[\\s_.-]+(?:\\d{4}[-_.]\\d{2}[-_.]\\d{2}|\\d{2}[-_.]\\d{2}[-_.]\\d{4}|\\d{2}[-_.]\\d{2}[-_.]\\d{2}))?[\\s_.-]+(?:[-–—][\\s_]*)?(.+?)(?:[\\s_.-]+[-–—]?[\\s_]*\\d{6}[\\s_]+[A-Za-z0-9]{1,10}(?:_[A-Za-z0-9]{1,6})?|[\\s_.-]+(?:\\d{4}[-_.]\\d{2}[-_.]\\d{2}|\\d{2}[-_.]\\d{2}[-_.]\\d{4}|\\d{2}[-_.]\\d{2}[-_.]\\d{2}|\\d{6})|[\\s_.-]+(?:(?:v|ver\\.?|version)[\\s_.-]*\\d+(?:\\.0+)?|(?:rev(?:ision)?\\.?|r(?=[\\s_.]*(?:\\d|[A-Za-z]\\b)))[\\s_.-]*(?:\\d{1,2}[A-Za-z]?|[A-Za-z]\\d{0,2}))(?![A-Za-z0-9]|\\.\\d))*(?:\\.(?!inc$|ltd$)[A-Za-z0-9]{1,5})?$';

        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'gmail' as const,
                fields: {
                  title: {
                    from: 'attachmentName' as const,
                    pattern: attachmentTitlePattern,
                    group: 3,
                    normalize: 'cleanFilenameText' as const,
                  },
                },
              },
              {
                source: 'drive' as const,
                fields: {
                  title: {
                    from: 'drive.fileName' as const,
                    pattern: attachmentTitlePattern,
                    group: 3,
                    normalize: 'cleanFilenameText' as const,
                  },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [{ key: 'title', type: 'string', minLength: 1 }],
          }),
        };

        const cases = [
          ['071200-001_Waterproofing_2026-11-15.pdf', 'Waterproofing'],
          ['071200-001_Waterproofing_by_Acme.Inc.pdf', 'Waterproofing by Acme.Inc'],
          ['071200-001_Waterproofing_Supply.Ltd.pdf', 'Waterproofing Supply.Ltd'],
          ['071200-001_Spec_v1.2.pdf', 'Spec v1.2'],
        ] as const;

        for (const [filename, expectedTitle] of cases) {
          const drivePort: DriveSourceContextPort = {
            getItemHierarchy: vi.fn().mockResolvedValue({
              item: { id: 'f-title', name: filename, mimeType: 'application/pdf' },
              ancestors: [],
            }),
          };
          const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
            parseSchemaRegistry: registry,
          });

          const attRes = await service.extractFields({
            documentTypeKey: 'submittal-arch',
            context: {
              email: {
                id: 'msg-1',
                attachments: [{ id: 'att-1', name: filename }],
              },
            },
          });
          expect(attRes.fields.title, `attachmentName: ${filename}`).toBe(expectedTitle);

          const driveRes = await service.extractFields({
            documentTypeKey: 'submittal-arch',
            context: { items: [{ id: 'f-title' }] },
          });
          expect(driveRes.fields.title, `drive.fileName: ${filename}`).toBe(expectedTitle);
        }
      });

      it('normalizes CSI section/number in matchesCorrelatedCode including groupIndex === 2', async () => {
        const csiPattern =
          '(\\d{6}|\\d{2} \\d{2} \\d{2}|\\d{2}\\.\\d{2}\\.\\d{2})[\\s_-]+(\\d{1,3})(?:[\\s_-]+(v\\d+|Rev\\d+))?';
        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'gmail' as const,
                fields: {
                  number: {
                    from: 'email.subjectClean' as const,
                    pattern: csiPattern,
                    group: 2,
                    normalize: 'pad3' as const,
                  },
                  revision: {
                    from: 'email.subjectClean' as const,
                    pattern: csiPattern,
                    group: 3,
                    normalize: 'revision' as const,
                  },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [
              { key: 'section', type: 'string', pattern: '^\\d{6}$' },
              { key: 'number', type: 'string', pattern: '^\\d{3}$' },
              { key: 'revision', type: 'string', minLength: 1 },
            ],
          }),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: registry,
        });

        const res = await service.extractFields({
          documentTypeKey: 'submittal-arch',
          existingData: { section: '071200' },
          context: {
            email: {
              id: 'msg-corr',
              subject: '08 11 00 - 2_v9 and 07.12.00_1_v2',
            },
          },
        });
        expect(res.fields.number).toBe('001');
        expect(res.fields.revision).toBe('1');
      });

      it('binds boundDriveItemId in declared field order so [Cover_Notes.pdf, 07 12 00 - 1_v1_Waterproofing.pdf] binds to item 2 including date', async () => {
        const drivePort: DriveSourceContextPort = {
          getItemHierarchy: vi
            .fn()
            .mockImplementation(async (itemId: string) => {
              if (itemId === 'item-cover') {
                return {
                  item: {
                    id: 'item-cover',
                    name: 'Cover_Notes.pdf',
                    mimeType: 'application/pdf',
                    modifiedTime: '2026-11-01T15:00:00Z',
                  },
                  ancestors: [],
                };
              }
              return {
                item: {
                  id: 'item-submittal',
                  name: '07 12 00 - 1_v1_Waterproofing.pdf',
                  mimeType: 'application/pdf',
                  modifiedTime: '2026-11-18T15:00:00Z',
                },
                ancestors: [],
              };
            }),
        };

        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'drive' as const,
                fields: {
                  section: {
                    from: 'drive.fileNameStem' as const,
                    pattern: '(\\d{6}|\\d{2} \\d{2} \\d{2})[\\s_-]+(\\d{1,3})',
                    group: 1,
                    normalize: 'digits6' as const,
                  },
                  number: {
                    from: 'drive.fileNameStem' as const,
                    pattern: '(\\d{6}|\\d{2} \\d{2} \\d{2})[\\s_-]+(\\d{1,3})',
                    group: 2,
                    normalize: 'pad3' as const,
                  },
                  revision: {
                    from: 'drive.fileNameStem' as const,
                    normalize: 'revision' as const,
                  },
                  date: [
                    { from: 'drive.fileNameStem' as const, normalize: 'yymmdd' as const },
                    { from: 'drive.modifiedTime' as const },
                  ],
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [
              { key: 'section', type: 'string', pattern: '^\\d{6}$' },
              { key: 'number', type: 'string', pattern: '^\\d{3}$' },
              { key: 'revision', type: 'string', minLength: 1 },
              { key: 'date', type: 'string' },
            ],
          }),
        };

        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: registry,
          configPort: { getWorkspaceTimeZone: () => 'America/New_York' },
          now: () => new Date('2026-11-20T15:00:00Z'),
        });

        const res = await service.extractFields({
          documentTypeKey: 'submittal-arch',
          context: {
            items: [{ id: 'item-cover' }, { id: 'item-submittal' }],
          },
        });

        expect(res.fields).toEqual({
          section: '071200',
          number: '001',
          revision: '0',
          date: '261118',
        });
      });
    });

    describe('Ticket #311: compactAlnum normalizer, correlated specTag revision, and FF&E lookup/LinkedField derivation', () => {
      it('applies normalize: "compactAlnum" before LookupField resolution and derives LinkedField specTitle', async () => {
        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'drive' as const,
                fields: {
                  specTag: {
                    from: 'drive.fileNameStem' as const,
                    pattern: '(?<=^|[\\s_./-])([A-Za-z]{2}[\\s._-]?\\d{3}[A-Za-z]?)(?=[\\s_./-]|$)',
                    group: 1,
                    normalize: 'compactAlnum' as const,
                    lookup: true as const,
                  },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [
              {
                key: 'specTag',
                type: 'string',
                minLength: 1,
                options: { source: 'specs', key: 'key', allowUserInput: true },
              },
              {
                key: 'specTitle',
                type: 'string',
                linkedField: { sourceField: 'specTag', sourceProperty: 'name' },
              },
            ],
            options: {
              specs: [
                { key: 'CG104', name: 'BED - KING' },
                { key: 'LT159A', name: 'SCONCE - CORRIDOR' },
              ],
            },
          }),
        };

        const cases: Array<{ name: string; expectedTag: string; expectedTitle: string }> = [
          { name: 'CG-104_v2_Fil_Doux.pdf', expectedTag: 'CG104', expectedTitle: 'BED - KING' },
          { name: 'LT 159A_R0.pdf', expectedTag: 'LT159A', expectedTitle: 'SCONCE - CORRIDOR' },
          { name: 'CG.104_CutSheet.pdf', expectedTag: 'CG104', expectedTitle: 'BED - KING' },
          { name: 'CG_104_CutSheet.pdf', expectedTag: 'CG104', expectedTitle: 'BED - KING' },
        ];

        for (const c of cases) {
          const drivePort: DriveSourceContextPort = {
            getItemHierarchy: vi.fn().mockResolvedValue({
              item: { id: 'f-ffe', name: c.name, mimeType: 'application/pdf' },
              ancestors: [],
            }),
          };
          const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
            parseSchemaRegistry: registry,
          });
          const res = await service.extractFields({
            documentTypeKey: 'submittal-ffe',
            context: { items: [{ id: 'f-ffe' }] },
          });
          expect(res.fields.specTag, c.name).toBe(c.expectedTag);
          expect(res.fields.specTitle, c.name).toBe(c.expectedTitle);
        }
      });

      it('normalizes spaced/hyphenated specTag in matchesCorrelatedCode when extracting correlated revision', async () => {
        const registry = {
          initialize: vi.fn(),
          getParseSchema: vi.fn().mockResolvedValue({
            extractors: [
              {
                source: 'gmail' as const,
                fields: {
                  revision: {
                    from: 'email.subjectClean' as const,
                    pattern:
                      '(?<=^|[\\s_./-])([A-Za-z]{2}[\\s._-]?\\d{3}[A-Za-z]?)[\\s_.-]+((?:v|ver\\.?|version)[\\s_.-]*\\d+(?:\\.\\d+)?|(?:rev(?:ision)?\\.?|r(?=[\\s_.]*(?:\\d|[A-Za-z]\\b)))[\\s_.-]*(?:\\d{1,2}[A-Za-z]?|[A-Za-z]\\d{0,2}))(?![A-Za-z0-9]|\\.\\d)',
                    group: 2,
                    normalize: 'revision' as const,
                  },
                },
              },
            ],
          }),
          getTargetSchema: vi.fn().mockResolvedValue({
            fields: [
              { key: 'specTag', type: 'string' },
              { key: 'revision', type: 'string', minLength: 1 },
            ],
          }),
        };

        const service = new SourceParserService(mockDrivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: registry,
        });

        const res = await service.extractFields({
          documentTypeKey: 'submittal-ffe',
          existingData: { specTag: 'LT159A' },
          context: {
            email: {
              id: 'msg-ffe-corr',
              subject: 'CG-104 v2 and LT 159A_R0',
            },
          },
        });

        expect(res.fields.revision).toBe('0');
      });
    });
  });

  describe('Ticket #315: Pass 2 source: "form" single-token DocumentFormSchema evaluation', () => {
    const formTemplateParser: FormTemplateParserPort = new HandlebarsAdapter();

    const submittalActions = [
      { key: 'REC', name: 'Received', suffix: '', order: '1' },
      { key: 'REF', name: 'Referred', suffix: '_REF', order: '2' },
      { key: 'NR', name: 'Not Reviewed', suffix: '_NR', order: '3' },
      { key: 'REJ', name: 'Rejected', suffix: '_REJ', order: '4' },
      { key: 'RR', name: 'Revise & Resubmit', suffix: '_RR', order: '5' },
      { key: 'NOC', name: 'No Objections As Corrected', suffix: '_NOC', order: '6' },
      { key: 'NET', name: 'No Exceptions Taken', suffix: '_NET', order: '7' },
    ];

    function makeArchRegistry(overrides?: {
      extractors?: unknown[];
      formFields?: Record<string, { template: string; format?: 'date'; valueMap?: Record<string, string> }>;
      targetFields?: unknown[];
      options?: Record<string, unknown[]>;
    }) {
      return {
        initialize: vi.fn(),
        getParseSchema: vi.fn().mockResolvedValue({
          extractors: overrides?.extractors ?? [
            { source: 'form' as const },
            {
              source: 'drive' as const,
              fields: {
                section: {
                  from: 'drive.fileNameStem' as const,
                  pattern: '(\\d{6})-(\\d{3})',
                  group: 1,
                  normalize: 'digits6' as const,
                },
                number: {
                  from: 'drive.fileNameStem' as const,
                  pattern: '(\\d{6})-(\\d{3})',
                  group: 2,
                  normalize: 'pad3' as const,
                },
                date: { from: 'drive.modifiedTime' as const },
              },
            },
          ],
        }),
        getDocumentFormSchema: vi.fn().mockResolvedValue({
          fields: overrides?.formFields ?? {
            'Submittal Response': {
              template: '{{action.name}}',
              valueMap: { RR: 'Revise and Resubmit' },
            },
          },
        }),
        getTargetSchema: vi.fn().mockResolvedValue({
          fields: overrides?.targetFields ?? [
            { key: 'section', type: 'string', pattern: '^\\d{6}$' },
            { key: 'number', type: 'string', pattern: '^\\d{3}$' },
            { key: 'revision', type: 'string', minLength: 1 },
            { key: 'date', type: 'string' },
            {
              key: 'action',
              type: 'string',
              options: { source: 'actions', key: 'key', name: 'name' },
            },
          ],
          options: overrides?.options ?? { actions: submittalActions },
        }),
      };
    }

    it('extracts NET, NOC, RR (via valueMap), REJ, and NR from Submittal Response and leaves action unpopulated when unchecked', async () => {
      const cases = [
        { raw: 'No Exceptions Taken', expected: 'NET' },
        { raw: 'No Objections As Corrected', expected: 'NOC' },
        { raw: 'Revise and Resubmit', expected: 'RR' },
        { raw: 'revise and resubmit', expected: 'RR' },
        { raw: 'Rejected', expected: 'REJ' },
        { raw: 'Not Reviewed', expected: 'NR' },
        { raw: undefined, expected: undefined },
      ];

      for (const tc of cases) {
        const drivePort: DriveSourceContextPort = {
          getItemHierarchy: vi.fn().mockResolvedValue({
            item: {
              id: 'pdf-stamped',
              name: '071200-001_Waterproofing.pdf',
              mimeType: 'application/pdf',
              modifiedTime: '2026-11-18T15:00:00Z',
            },
            ancestors: [],
          }),
        };
        const formExtractor: FormExtractorPort = {
          extractFormFields: vi.fn().mockResolvedValue({
            status: 'ok',
            widgetCount: 2,
            fields: tc.raw !== undefined ? { 'Submittal Response': tc.raw } : {},
          }),
        };
        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: makeArchRegistry(),
          formExtractor,
          formTemplateParser,
        });

        const res = await service.extractFields({
          documentTypeKey: 'submittal-arch',
          context: { items: [{ id: 'pdf-stamped' }] },
        });

        expect(res.fields.action, String(tc.raw)).toBe(tc.expected);
        expect(res.fields.section).toBe('071200');
        expect(res.fields.number).toBe('001');
      }
    });

    it('skips Email Attachments mode and skips formExtractor when all bound fields are already populated by gmail or existingData', async () => {
      const drivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn(),
      };
      const formExtractor: FormExtractorPort = {
        extractFormFields: vi.fn(),
      };

      const registry = makeArchRegistry({
        extractors: [
          {
            source: 'gmail' as const,
            fields: { action: { set: 'REC' } },
          },
          { source: 'form' as const },
        ],
      });

      const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: registry,
        formExtractor,
        formTemplateParser,
      });

      // Email Attachments mode: isDriveUrl omitted
      const attRes = await service.extractFields({
        documentTypeKey: 'submittal-arch',
        context: {
          items: [{ id: 'att-1', mimeType: 'application/pdf' }],
          email: { id: 'msg-1', subject: 'Submittal' },
        },
      });
      expect(attRes.fields.action).toBe('REC');
      expect(drivePort.getItemHierarchy).not.toHaveBeenCalled();
      expect(formExtractor.extractFormFields).not.toHaveBeenCalled();

      // Google Drive URL mode where gmail already populated action
      const urlRes = await service.extractFields({
        documentTypeKey: 'submittal-arch',
        context: {
          isDriveUrl: true,
          items: [{ id: 'drive-pdf-1' }],
          email: { id: 'msg-1', subject: 'Submittal' },
        },
      });
      expect(urlRes.fields.action).toBe('REC');
      expect(drivePort.getItemHierarchy).not.toHaveBeenCalled();
      expect(formExtractor.extractFormFields).not.toHaveBeenCalled();

      // existingData already has action
      const existingRes = await service.extractFields({
        documentTypeKey: 'submittal-arch',
        existingData: { action: 'NET' },
        context: { items: [{ id: 'drive-pdf-1' }] },
      });
      expect(existingRes.fields.action).toBe('NET');
      expect(formExtractor.extractFormFields).not.toHaveBeenCalled();
    });

    it('resolves Drive shortcuts, skips unsupported MIME types, silently skips 0-widget PDFs, and stops after first matching stamped form', async () => {
      const drivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockImplementation(async (id: string) => {
          if (id === 'img-1') {
            return { item: { id: 'img-1', name: 'Photo.png', mimeType: 'image/png' }, ancestors: [] };
          }
          if (id === 'flat-1') {
            return { item: { id: 'flat-1', name: 'Flat_Drawing.pdf', mimeType: 'application/pdf' }, ancestors: [] };
          }
          if (id === 'shortcut-cover') {
            return {
              item: { id: 'target-cover', name: 'Stamped_Cover.pdf', mimeType: 'application/pdf' },
              ancestors: [],
            };
          }
          return {
            item: { id: 'extra-cover', name: 'Extra_Cover.pdf', mimeType: 'application/pdf' },
            ancestors: [],
          };
        }),
      };

      const formExtractor: FormExtractorPort = {
        extractFormFields: vi.fn().mockImplementation(async ({ id }: { id: string }) => {
          if (id === 'flat-1') {
            return { status: 'ok', widgetCount: 0, fields: {} };
          }
          if (id === 'target-cover') {
            return {
              status: 'ok',
              widgetCount: 2,
              fields: { 'Submittal Response': 'No Exceptions Taken' },
            };
          }
          return {
            status: 'ok',
            widgetCount: 1,
            fields: { 'Submittal Response': 'Rejected' },
          };
        }),
      };

      const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: makeArchRegistry(),
        formExtractor,
        formTemplateParser,
      });

      const res = await service.extractFields({
        documentTypeKey: 'submittal-arch',
        context: {
          items: [
            { id: 'img-1' },
            { id: 'flat-1' },
            { id: 'shortcut-cover' },
            { id: 'extra-cover' },
          ],
        },
      });

      expect(res.fields.action).toBe('NET');
      expect(res.statusMessages).toBeUndefined();
      expect(formExtractor.extractFormFields).toHaveBeenCalledTimes(2);
      expect(formExtractor.extractFormFields).toHaveBeenNthCalledWith(1, {
        id: 'flat-1',
        mimeType: 'application/pdf',
      });
      expect(formExtractor.extractFormFields).toHaveBeenNthCalledWith(2, {
        id: 'target-cover',
        mimeType: 'application/pdf',
      });
    });

    it('coerces boolean/string/string[] values, preserves "0", normalizes plain fields, resolves dynamic LookupFields, and populates LinkedFields', async () => {
      const drivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue({
          item: { id: 'pdf-1', name: 'Form.pdf', mimeType: 'application/pdf' },
          ancestors: [],
        }),
      };

      const formExtractor: FormExtractorPort = {
        extractFormFields: vi.fn().mockResolvedValue({
          status: 'ok',
          widgetCount: 6,
          fields: {
            SectionWidget: ' 07 12 00 ',
            NumberWidget: ' 5 ',
            RevisionWidget: '0',
            SpecWidget: ['   ', 'CG104'],
            FlagTrue: true,
            FlagFalse: false,
          },
        }),
      };

      const registry = makeArchRegistry({
        extractors: [{ source: 'form' as const }],
        formFields: {
          SectionWidget: { template: '{{section}}' },
          NumberWidget: { template: '{{number}}' },
          RevisionWidget: { template: '{{revision}}' },
          SpecWidget: { template: '{{specTag.key}}' },
          FlagTrue: { template: '{{flagTrue}}' },
          FlagFalse: { template: '{{flagFalse}}' },
        },
        targetFields: [
          { key: 'section', type: 'string', pattern: '^\\d{6}$' },
          { key: 'number', type: 'string', pattern: '^\\d{3}$' },
          { key: 'revision', type: 'string', minLength: 1 },
          {
            key: 'specTag',
            type: 'string',
            options: {
              source: 'specs',
              key: 'key',
              name: 'name',
              dynamicConfig: { provider: 'google_drive' },
            },
          },
          {
            key: 'specTitle',
            type: 'string',
            linkedField: { sourceField: 'specTag', sourceProperty: 'name' },
          },
          { key: 'flagTrue', type: 'string' },
          { key: 'flagFalse', type: 'string' },
        ],
        options: {},
      });

      const canonicalOptionsProvider = {
        getCanonicalOptions: vi.fn().mockResolvedValue([
          { key: 'CG104', name: 'BED - KING' },
        ]),
      };

      const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: registry,
        formExtractor,
        formTemplateParser,
        canonicalOptionsProvider,
      });

      const res = await service.extractFields({
        documentTypeKey: 'submittal-ffe',
        spaceId: 'space-1',
        context: { items: [{ id: 'pdf-1' }] },
      });

      expect(res.fields).toEqual({
        section: '071200',
        number: '005',
        revision: '0',
        specTag: 'CG104',
        specTitle: 'BED - KING',
        flagTrue: 'true',
      });
      expect(res.fields.flagFalse).toBeUndefined();
    });

    it('emits non-blocking statusMessages on encrypted, corrupted, and source_error outcomes without blocking drive extractor', async () => {
      const drivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue({
          item: {
            id: 'pdf-bad',
            name: '071200-001_Waterproofing.pdf',
            mimeType: 'application/pdf',
            modifiedTime: '2026-11-18T15:00:00Z',
          },
          ancestors: [],
        }),
      };

      const expectedMessages = {
        encrypted: PDF_FORM_ENCRYPTED_ERROR_MESSAGE,
        corrupted: DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE,
        source_error: DRIVE_METADATA_EXTRACT_ERROR_MESSAGE,
      } as const;

      for (const status of ['encrypted', 'corrupted', 'source_error'] as const) {
        const formExtractor: FormExtractorPort = {
          extractFormFields: vi.fn().mockResolvedValue({ status }),
        };
        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: makeArchRegistry(),
          formExtractor,
          formTemplateParser,
        });

        const res = await service.extractFields({
          documentTypeKey: 'submittal-arch',
          context: { items: [{ id: 'pdf-bad' }] },
        });

        expect(res.fields.section).toBe('071200');
        expect(res.fields.number).toBe('001');
        expect(res.fields.action).toBeUndefined();
        expect(res.statusMessages).toEqual([expectedMessages[status]]);
      }
    });
  });

  describe('Ticket #316: formDate (format: "date") normalization and fallthrough', () => {
    const formTemplateParser = new HandlebarsAdapter();

    function makeDateRegistry(overrides?: {
      extractors?: Array<Record<string, unknown>>;
      datePattern?: string;
    }) {
      return {
        initialize: vi.fn(),
        getParseSchema: vi.fn().mockResolvedValue({
          extractors: overrides?.extractors ?? [
            {
              source: 'gmail' as const,
              fields: {
                date: { from: 'email.date' as const },
              },
            },
            { source: 'form' as const },
            {
              source: 'drive' as const,
              fields: {
                date: { from: 'drive.modifiedTime' as const },
              },
            },
          ],
        }),
        getDocumentFormSchema: vi.fn().mockResolvedValue({
          fields: {
            'Submittal Response': {
              template: '{{action.name}}',
              valueMap: { RR: 'Revise and Resubmit' },
            },
            Date: {
              template: '{{date}}',
              format: 'date' as const,
            },
          },
        }),
        getTargetSchema: vi.fn().mockResolvedValue({
          fields: [
            {
              key: 'date',
              type: 'string',
              ...(overrides?.datePattern ? { pattern: overrides.datePattern } : {}),
            },
            {
              key: 'action',
              type: 'string',
              options: { source: 'actions', key: 'key', name: 'name' },
            },
          ],
          options: {
            actions: [
              { key: 'REC', name: 'Received' },
              { key: 'NOC', name: 'No Objections As Corrected' },
              { key: 'NET', name: 'No Exceptions Taken' },
            ],
          },
        }),
      };
    }

    it('parses all 5 formDate format groups into INC yyMMdd without a rolling 12-month cap (even when target field has ^\\d{6}$ pattern)', async () => {
      const acceptedCases: Array<[string, string]> = [
        ['2026-11-21', '261121'],
        ['2026-11-21T14:30:00Z', '261121'],
        ['2026-11-21T00:00:00-05:00', '261121'],
        ['2026/5/8', '260508'],
        ['2026.05.08', '260508'],
        ['2023-09-13', '230913'],
        ['2000-01-01', '000101'],
        ['2099-12-31', '991231'],
        ['2024-02-29', '240229'],
        ['  2026-11-21  ', '261121'],
        ['05/08/2026', '260508'],
        ['5/8/2026', '260508'],
        ['05-08-2026', '260508'],
        ['05.08.2026', '260508'],
        ['5/8/26', '260508'],
        ['05.08.26', '260508'],
        ['11-21-26', '261121'],
        ['Sept 8, 2026', '260908'],
        ['Sep 8, 2026', '260908'],
        ['September 8, 2026', '260908'],
        ['May 8th, 2026', '260508'],
        ['May 8 2026', '260508'],
        ['8 May 2026', '260508'],
        ['8th May, 2026', '260508'],
        ['1st Jan, 26', '260101'],
        ['2nd Feb 2024', '240202'],
        ['3rd March 2026', '260303'],
        ['21st Nov. 26', '261121'],
        ['  DEC 25 2026  ', '261225'],
        ['261121', '261121'],
        ['240229', '240229'],
      ];

      for (const [rawDate, expected] of acceptedCases) {
        const drivePort: DriveSourceContextPort = {
          getItemHierarchy: vi.fn().mockResolvedValue({
            item: {
              id: 'pdf-date',
              name: 'Stamped_Cover.pdf',
              mimeType: 'application/pdf',
              modifiedTime: '2026-11-18T15:00:00Z',
            },
            ancestors: [],
          }),
        };
        const formExtractor: FormExtractorPort = {
          extractFormFields: vi.fn().mockResolvedValue({
            status: 'ok',
            widgetCount: 1,
            fields: { Date: rawDate },
          }),
        };
        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: makeDateRegistry({ datePattern: '^\\d{6}$' }),
          formExtractor,
          formTemplateParser,
          now: () => new Date('2026-11-22T12:00:00Z'),
        });

        const res = await service.extractFields({
          documentTypeKey: 'submittal-arch',
          context: { items: [{ id: 'pdf-date' }] },
        });
        expect(res.fields.date, rawDate).toBe(expected);
      }
    });

    it('rejects placeholder, out-of-bounds years, mixed delimiters, and invalid calendar dates so date falls through to drive.modifiedTime', async () => {
      const rejectedInputs = [
        'DATE',
        '',
        '   ',
        '1999-12-31',
        '12/31/1999',
        '2100-01-01',
        '01/01/2100',
        'Dec 31, 1999',
        'Jan 1, 2100',
        '2026-11/21',
        '05/08-2026',
        '5/8.26',
        '02/29/2025',
        '2026-04-31',
        '2026-02-30',
        '2026-13-01',
        '2026-00-01',
        'Feb 29, 2025',
        'April 31, 2026',
        '250229',
        '260431',
        '2025-02-29T10:00:00Z',
      ];

      for (const badDate of rejectedInputs) {
        const drivePort: DriveSourceContextPort = {
          getItemHierarchy: vi.fn().mockResolvedValue({
            item: {
              id: 'pdf-bad-date',
              name: 'Unfillable_DATE.pdf',
              mimeType: 'application/pdf',
              modifiedTime: '2026-11-18T15:00:00Z',
            },
            ancestors: [],
          }),
        };
        const formExtractor: FormExtractorPort = {
          extractFormFields: vi.fn().mockResolvedValue({
            status: 'ok',
            widgetCount: 1,
            fields: { Date: badDate },
          }),
        };
        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: makeDateRegistry(),
          formExtractor,
          formTemplateParser,
        });

        const res = await service.extractFields({
          documentTypeKey: 'submittal-arch',
          context: { items: [{ id: 'pdf-bad-date' }] },
        });
        expect(res.fields.date, badDate).toBe('261118');
      }
    });

    it('falls through [Unfillable_DATE.pdf, Stamped_Cover.pdf] and lets email.date win ahead of form in Gmail Google Drive URL mode', async () => {
      const drivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockImplementation(async (id: string) => ({
          item: {
            id,
            name: id === 'unfillable' ? 'Unfillable_DATE.pdf' : 'Stamped_Cover.pdf',
            mimeType: 'application/pdf',
            modifiedTime: '2026-11-18T15:00:00Z',
          },
          ancestors: [],
        })),
      };

      const formExtractor: FormExtractorPort = {
        extractFormFields: vi.fn().mockImplementation(async ({ id }: { id: string }) => {
          if (id === 'unfillable') {
            return {
              status: 'ok',
              widgetCount: 2,
              fields: { Date: 'DATE' },
            };
          }
          return {
            status: 'ok',
            widgetCount: 2,
            fields: { Date: 'Sept 8, 2026', 'Submittal Response': 'No Exceptions Taken' },
          };
        }),
      };

      const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: makeDateRegistry(),
        formExtractor,
        formTemplateParser,
      });

      const multiRes = await service.extractFields({
        documentTypeKey: 'submittal-arch',
        context: { items: [{ id: 'unfillable' }, { id: 'stamped' }] },
      });
      expect(multiRes.fields).toEqual({
        date: '260908',
        action: 'NET',
      });
      expect(formExtractor.extractFormFields).toHaveBeenCalledTimes(2);

      // Gmail Google Drive URL mode: email.date wins ahead of form Date, while form still populates action
      const urlRes = await service.extractFields({
        documentTypeKey: 'submittal-arch',
        context: {
          isDriveUrl: true,
          items: [{ id: 'stamped' }],
          email: {
            id: 'msg-1',
            date: 'Wed, 18 Nov 2026 10:00:00 -0500',
          },
        },
      });
      expect(urlRes.fields).toEqual({
        date: '261118',
        action: 'NET',
      });
    });
  });

  describe('Ticket #317: Multi-token Submittal No cursor decomposition, partial-input disambiguation, and pad3 widening', () => {
    const formTemplateParser = new HandlebarsAdapter();

    function makeArchMultiTokenRegistry(overrides?: { numberPattern?: string }) {
      return {
        initialize: vi.fn(),
        getParseSchema: vi.fn().mockResolvedValue({
          extractors: [
            {
              source: 'gmail' as const,
              fields: {
                section: {
                  from: 'email.subjectClean' as const,
                  pattern: '(\\d{6})-(\\d{1,4})',
                  group: 1,
                  normalize: 'digits6' as const,
                },
                number: {
                  from: 'email.subjectClean' as const,
                  pattern: '(\\d{6})-(\\d{1,4})',
                  group: 2,
                  normalize: 'pad3' as const,
                },
              },
            },
            { source: 'form' as const },
            {
              source: 'drive' as const,
              fields: {
                title: {
                  from: 'drive.fileNameStem' as const,
                  pattern: '^\\d{6}-\\d{3,}(?:-[A-Za-z0-9]+)?[\\s_-]+(.+)$',
                  group: 1,
                  normalize: 'cleanFilenameText' as const,
                },
              },
            },
          ],
        }),
        getDocumentFormSchema: vi.fn().mockResolvedValue({
          fields: {
            'Submittal No': {
              template: '{{section}}-{{number}}-{{revision}}',
            },
            'Submittal Response': {
              template: '{{action.name}}',
              valueMap: { RR: 'Revise and Resubmit' },
            },
            Date: {
              template: '{{date}}',
              format: 'date' as const,
            },
          },
        }),
        getTargetSchema: vi.fn().mockResolvedValue({
          fields: [
            { key: 'section', type: 'string', pattern: '^\\d{6}$' },
            { key: 'number', type: 'string', pattern: overrides?.numberPattern ?? '^\\d{3,}$' },
            { key: 'revision', type: 'string', minLength: 1, pattern: '^.*\\S+.*$' },
            { key: 'title', type: 'string' },
            { key: 'date', type: 'string' },
            {
              key: 'action',
              type: 'string',
              options: { source: 'actions', key: 'key', name: 'name' },
            },
          ],
          options: {
            actions: [
              { key: 'REC', name: 'Received' },
              { key: 'NOC', name: 'No Objections As Corrected' },
              { key: 'NET', name: 'No Exceptions Taken' },
            ],
          },
        }),
      };
    }

    it('widens normalize: "pad3" to /^\\d+$/ while deferring max-digit validation to DocumentField.pattern', async () => {
      const drivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue({
          item: { id: 'f-pad3', name: '071200-1042 Waterproofing.pdf', mimeType: 'application/pdf' },
          ancestors: [],
        }),
      };
      const formExtractor: FormExtractorPort = {
        extractFormFields: vi.fn().mockResolvedValue({
          status: 'ok',
          widgetCount: 1,
          fields: { 'Submittal No': '071200-1042-B' },
        }),
      };

      const widenedService = new SourceParserService(drivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: makeArchMultiTokenRegistry({ numberPattern: '^\\d{3,}$' }),
        formExtractor,
        formTemplateParser,
      });
      const widenedRes = await widenedService.extractFields({
        documentTypeKey: 'submittal-arch',
        context: { items: [{ id: 'f-pad3' }] },
      });
      expect(widenedRes.fields).toEqual({
        section: '071200',
        number: '1042',
        revision: 'B',
        title: 'Waterproofing',
      });

      const strict3Service = new SourceParserService(drivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: makeArchMultiTokenRegistry({ numberPattern: '^\\d{3}$' }),
        formExtractor,
        formTemplateParser,
      });
      const strictRes = await strict3Service.extractFields({
        documentTypeKey: 'submittal-arch',
        context: { items: [{ id: 'f-pad3' }] },
      });
      expect(strictRes.fields).toEqual({
        section: '071200',
        title: 'Waterproofing',
      });
    });

    it.each<[string, Record<string, unknown>]>([
      // Full Submittal No with varied delimiters & formats
      ['071200-001-A', { section: '071200', number: '001', revision: 'A' }],
      ['07 12 00 - 001 - Rev. A', { section: '071200', number: '001', revision: 'A' }],
      ['07.12.00_005_R1', { section: '071200', number: '005', revision: '1' }],
      ['07-12-00 / 12 / v1', { section: '071200', number: '012', revision: '0' }],
      ['071200-1042-B', { section: '071200', number: '1042', revision: 'B' }],
      ['071200-01-01', { section: '071200', number: '001', revision: '01' }],
      ['071200 - Submittal No. 5 - R12', { section: '071200', number: '005', revision: '12' }],
      ['071200-001-0', { section: '071200', number: '001', revision: '0' }],
      ['071200-001-1', { section: '071200', number: '001', revision: '1' }],
      // Partial with CSI
      ['071200-001', { section: '071200', number: '001' }],
      ['071200-1042', { section: '071200', number: '1042' }],
      ['071200-A', { section: '071200', revision: 'A' }],
      ['071200 Rev B', { section: '071200', revision: 'B' }],
      ['071200 - v1.0', { section: '071200', revision: '0' }],
      ['071200 - R1', { section: '071200', revision: '1' }],
      ['071200', { section: '071200' }],
      // Standalone numeric sequences
      ['5', { number: '005' }],
      ['SUB-001', { number: '001' }],
      ['Submittal No. 42 Rev B', { number: '042', revision: 'B' }],
      ['#7', { number: '007' }],
      ['005-A', { number: '005', revision: 'A' }],
      ['1042', { number: '1042' }],
      ['1042 Rev. A', { number: '1042', revision: 'A' }],
      ['1042 R12', { number: '1042', revision: '12' }],
      ['1042 v1.0', { number: '1042', revision: '0' }],
      ['06102-05', { number: '06102', revision: '05' }],
      // Standalone revision markers & tight single tokens
      ['R1', { revision: '1' }],
      ['Rev A', { revision: 'A' }],
      ['Rev. A', { revision: 'A' }],
      ['R12', { revision: '12' }],
      ['v1', { revision: '0' }],
      ['A', { revision: 'A' }],
      ['R', { revision: 'R' }],
      // Rejected / guarded inputs
      ['1042-AB', {}],
      ['06102-001-1', {}],
      ['2026-11-15', {}],
      ['12/31/26', {}],
      ['R-19', {}],
      ['N/A', {}],
      ['071200-001-R-19', { section: '071200', number: '001' }],
    ])('decomposes Submittal No "%s" -> %j', async (submittalNo, expected) => {
      const drivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue({
          item: { id: 'f-sub', name: 'Stamped_Cover.pdf', mimeType: 'application/pdf' },
          ancestors: [],
        }),
      };
      const formExtractor: FormExtractorPort = {
        extractFormFields: vi.fn().mockResolvedValue({
          status: 'ok',
          widgetCount: 1,
          fields: { 'Submittal No': submittalNo },
        }),
      };

      const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: makeArchMultiTokenRegistry(),
        formExtractor,
        formTemplateParser,
      });

      const res = await service.extractFields({
        documentTypeKey: 'submittal-arch',
        context: { items: [{ id: 'f-sub' }] },
      });

      expect(res.fields).toEqual(expected);
    });

    it('advances left-to-right cursor over already-populated tokens without overwriting existingData or gmail fields', async () => {
      const drivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue({
          item: { id: 'f-cursor', name: '071200-001 Waterproofing.pdf', mimeType: 'application/pdf' },
          ancestors: [],
        }),
      };
      const formExtractor: FormExtractorPort = {
        extractFormFields: vi.fn().mockResolvedValue({
          status: 'ok',
          widgetCount: 2,
          fields: {
            'Submittal No': '081100-002-C',
            'Submittal Response': 'No Objections As Corrected',
          },
        }),
      };

      const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: makeArchMultiTokenRegistry(),
        formExtractor,
        formTemplateParser,
      });

      // 1. existingData preserves section + number while cursor still consumes 081100-002- to extract revision: C
      const editedRes = await service.extractFields({
        documentTypeKey: 'submittal-arch',
        existingData: { section: '071200', number: '001' },
        context: { items: [{ id: 'f-cursor' }] },
      });
      expect(editedRes.fields).toEqual({
        section: '071200',
        number: '001',
        revision: 'C',
        action: 'NOC',
        title: 'Waterproofing',
      });

      // 2. Gmail Google Drive URL mode: gmail populates section/number, form advances cursor to revision + action, drive fills title
      const gmailUrlRes = await service.extractFields({
        documentTypeKey: 'submittal-arch',
        context: {
          isDriveUrl: true,
          items: [{ id: 'f-cursor' }],
          email: {
            id: 'msg-1',
            subject: '071200-001 Review',
          },
        },
      });
      expect(gmailUrlRes.fields).toEqual({
        section: '071200',
        number: '001',
        revision: 'C',
        action: 'NOC',
        title: 'Waterproofing',
      });
    });

    it('falls through to second PDF when first PDF has unparseable Submittal No', async () => {
      const drivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockImplementation(async (id: string) => ({
          item: { id, name: `${id}.pdf`, mimeType: 'application/pdf' },
          ancestors: [],
        })),
      };
      const formExtractor: FormExtractorPort = {
        extractFormFields: vi.fn().mockImplementation(async ({ id }: { id: string }) => {
          if (id === 'first') {
            return { status: 'ok', widgetCount: 1, fields: { 'Submittal No': '1042-AB' } };
          }
          return { status: 'ok', widgetCount: 1, fields: { 'Submittal No': '071200-042-B' } };
        }),
      };

      const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: makeArchMultiTokenRegistry(),
        formExtractor,
        formTemplateParser,
      });

      const res = await service.extractFields({
        documentTypeKey: 'submittal-arch',
        context: { items: [{ id: 'first' }, { id: 'second' }] },
      });

      expect(res.fields).toEqual({
        section: '071200',
        number: '042',
        revision: 'B',
      });
      expect(formExtractor.extractFormFields).toHaveBeenCalledTimes(2);
    });
  });

  describe('Ticket #319: Recursive JsonLogic form matching, ambiguous widgets, and per-item resilience', () => {
    const formTemplateParser: FormTemplateParserPort = new HandlebarsAdapter();
    const realPredicateEvaluator: PredicateEvaluatorPort = {
      evaluate: (rule, data) => {
        if (rule === undefined || rule === null) {
          return true;
        }
        return Boolean(jsonLogic.apply(rule as jsonLogic.RulesLogic, data));
      },
    };

    const submittalActions = [
      { key: 'REC', name: 'Received', suffix: '', order: '1' },
      { key: 'NR', name: 'Not Reviewed', suffix: '_NR', order: '3' },
      { key: 'REJ', name: 'Rejected', suffix: '_REJ', order: '4' },
      { key: 'RR', name: 'Revise & Resubmit', suffix: '_RR', order: '5' },
      { key: 'NOC', name: 'No Objections As Corrected', suffix: '_NOC', order: '6' },
      { key: 'NET', name: 'No Exceptions Taken', suffix: '_NET', order: '7' },
    ];

    function makeFormMatchRegistry(matchRule: unknown, extraFields?: Record<string, { template: string }>) {
      return {
        initialize: vi.fn(),
        getParseSchema: vi.fn().mockResolvedValue({
          extractors: [{ source: 'form' as const, match: matchRule }],
        }),
        getDocumentFormSchema: vi.fn().mockResolvedValue({
          fields: {
            'Submittal Response': {
              template: '{{action.name}}',
              valueMap: { RR: 'Revise and Resubmit' },
            },
            ...(extraFields ?? {}),
          },
        }),
        getTargetSchema: vi.fn().mockResolvedValue({
          fields: [
            {
              key: 'action',
              type: 'string',
              options: { source: 'actions', key: 'key', name: 'name' },
            },
            { key: 'notes', type: 'string' },
          ],
          options: { actions: submittalActions },
        }),
      };
    }

    it('evaluates non-form extractor.match against { ...jsonLogicContext, drive } BEFORE calling formExtractor and skips form I/O when false', async () => {
      const drivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockImplementation(async (id: string) => ({
          item: { id, name: `${id}.pdf`, mimeType: 'application/pdf' },
          ancestors: [{ id: 'folder-1', name: id === 'skip-me' ? 'Drafts' : 'Submittals' }],
        })),
      };

      const nonFormMatches = [
        { '==': [{ var: 'drive.parentName' }, 'Submittals'] },
        { '!!': { missing: ['drive.fileName'] } },
        { '!!': { missing_some: [1, ['drive.fileName', 'email.subject']] } },
        { '==': [{ var: 'formData' }, 'Submittals'] },
      ];

      for (const matchRule of nonFormMatches) {
        const formExtractor: FormExtractorPort = {
          extractFormFields: vi.fn().mockResolvedValue({
            status: 'ok',
            widgetCount: 1,
            fields: { 'Submittal Response': 'No Exceptions Taken' },
          }),
        };
        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: makeFormMatchRegistry(matchRule),
          predicateEvaluator: realPredicateEvaluator,
          formExtractor,
          formTemplateParser,
        });

        const skipRes = await service.extractFields({
          documentTypeKey: 'submittal-arch',
          context: { items: [{ id: 'skip-me' }] },
        });
        expect(skipRes.fields.action).toBeUndefined();
        expect(formExtractor.extractFormFields).not.toHaveBeenCalled();
      }

      // When non-form predicate evaluates true, formExtractor IS invoked
      const formExtractorTrue: FormExtractorPort = {
        extractFormFields: vi.fn().mockResolvedValue({
          status: 'ok',
          widgetCount: 1,
          fields: { 'Submittal Response': 'No Exceptions Taken' },
        }),
      };
      const serviceTrue = new SourceParserService(drivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: makeFormMatchRegistry({ '==': [{ var: 'drive.parentName' }, 'Submittals'] }),
        predicateEvaluator: realPredicateEvaluator,
        formExtractor: formExtractorTrue,
        formTemplateParser,
      });
      const hitRes = await serviceTrue.extractFields({
        documentTypeKey: 'submittal-arch',
        context: { items: [{ id: 'submittal-pdf' }] },
      });
      expect(hitRes.fields.action).toBe('NET');
      expect(formExtractorTrue.extractFormFields).toHaveBeenCalledTimes(1);
    });

    it('detects form references across recursive JsonLogic AST (string var, array var, root var, computed var, missing, missing_some), skips widgetCount === 0 silently, and evaluates blank forms & raw booleans post-read', async () => {
      const drivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockImplementation(async (id: string) => ({
          item: { id, name: `${id}.pdf`, mimeType: 'application/pdf' },
          ancestors: [{ id: 'f-1', name: 'Submittals' }],
        })),
      };

      const formReferencingRules: Array<{ label: string; rule: unknown; formFields: Record<string, string | boolean>; shouldMatch: boolean }> = [
        {
          label: 'string var form.IsCover',
          rule: { '===': [{ var: 'form.IsCover' }, true] },
          formFields: { IsCover: true, 'Submittal Response': 'Rejected' },
          shouldMatch: true,
        },
        {
          label: 'raw boolean false in form does not coerce to truthy',
          rule: { '===': [{ var: 'form.IsCover' }, true] },
          formFields: { IsCover: false, 'Submittal Response': 'Rejected' },
          shouldMatch: false,
        },
        {
          label: 'string var bare form',
          rule: { '!!': { var: 'form' } },
          formFields: { 'Submittal Response': 'Rejected' },
          shouldMatch: true,
        },
        {
          label: 'array var ["form.Kind", default]',
          rule: { '==': [{ var: ['form.Kind', 'other'] }, 'cover'] },
          formFields: { Kind: 'cover', 'Submittal Response': 'Rejected' },
          shouldMatch: true,
        },
        {
          label: 'array var with form in default expr',
          rule: { '==': [{ var: ['drive.missingProp', { var: 'form.Kind' }] }, 'cover'] },
          formFields: { Kind: 'cover', 'Submittal Response': 'Rejected' },
          shouldMatch: true,
        },
        {
          label: 'root var ""',
          rule: { '==': [{ var: ['', 'none'] }, 'none'] },
          formFields: { 'Submittal Response': 'Rejected' },
          shouldMatch: false,
        },
        {
          label: 'root var null',
          rule: { '!=': [{ var: null }, null] },
          formFields: { 'Submittal Response': 'Rejected' },
          shouldMatch: true,
        },
        {
          label: 'root var []',
          rule: { '!=': [{ var: [] }, null] },
          formFields: { 'Submittal Response': 'Rejected' },
          shouldMatch: true,
        },
        {
          label: 'computed non-literal var',
          rule: { '==': [{ var: { cat: ['form.', 'Kind'] } }, 'cover'] },
          formFields: { Kind: 'cover', 'Submittal Response': 'Rejected' },
          shouldMatch: true,
        },
        {
          label: 'missing form.RequiredField on blank form (widgetCount > 0, fields: {})',
          rule: { 'in': ['form.RequiredField', { missing: ['drive.fileName', 'form.RequiredField'] }] },
          formFields: {},
          shouldMatch: false,
        },
        {
          label: 'missing_some referencing form.Marker combined with drive.parentName',
          rule: {
            and: [
              { '==': [{ var: 'drive.parentName' }, 'Submittals'] },
              { '!': { in: ['form.Marker', { missing_some: [2, ['drive.fileName', 'form.Marker']] }] } },
            ],
          },
          formFields: { Marker: 'ok', 'Submittal Response': 'Rejected' },
          shouldMatch: true,
        },
      ];

      for (const tc of formReferencingRules) {
        const formExtractor: FormExtractorPort = {
          extractFormFields: vi.fn().mockImplementation(async ({ id }: { id: string }) => {
            if (id === 'flat-doc') {
              return { status: 'ok', widgetCount: 0, fields: {} };
            }
            return {
              status: 'ok',
              widgetCount: 2,
              fields: tc.formFields,
            };
          }),
        };

        const evalSpy = vi.fn((rule: unknown, data: Record<string, unknown>) =>
          realPredicateEvaluator.evaluate(rule, data)
        );
        const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
          parseSchemaRegistry: makeFormMatchRegistry(tc.rule),
          predicateEvaluator: { evaluate: evalSpy },
          formExtractor,
          formTemplateParser,
        });

        // 1. Flat 0-widget doc must be skipped silently WITHOUT evaluating match
        const flatRes = await service.extractFields({
          documentTypeKey: 'submittal-arch',
          context: { items: [{ id: 'flat-doc' }] },
        });
        expect(flatRes.fields.action, tc.label).toBeUndefined();
        expect(evalSpy, tc.label).not.toHaveBeenCalled();

        // 2. Non-zero widget doc evaluates match post-read with { ..., drive, form }
        evalSpy.mockClear();
        const formRes = await service.extractFields({
          documentTypeKey: 'submittal-arch',
          context: { items: [{ id: 'widget-doc' }] },
        });
        expect(evalSpy, tc.label).toHaveBeenCalledTimes(1);
        const passedContext = evalSpy.mock.calls[0][1];
        expect(passedContext.form, tc.label).toEqual(tc.formFields);
        expect((passedContext.drive as Record<string, unknown>).parentName, tc.label).toBe('Submittals');
        if (tc.shouldMatch && tc.formFields['Submittal Response']) {
          expect(formRes.fields.action, tc.label).toBe('REJ');
        } else {
          expect(formRes.fields.action, tc.label).toBeUndefined();
        }
      }

      // Blank form (widgetCount > 0, fields: {}) triggers { "!!": { "missing": ["form.Date"] } } while flat 0-widget skips it
      const blankEvalSpy = vi.fn((rule: unknown, data: Record<string, unknown>) =>
        realPredicateEvaluator.evaluate(rule, data)
      );
      const blankFormExtractor: FormExtractorPort = {
        extractFormFields: vi.fn().mockImplementation(async ({ id }: { id: string }) =>
          id === 'flat-doc'
            ? { status: 'ok', widgetCount: 0, fields: {} }
            : { status: 'ok', widgetCount: 3, fields: {} }
        ),
      };
      const blankService = new SourceParserService(drivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: makeFormMatchRegistry({ '!!': { missing: ['form.Date'] } }),
        predicateEvaluator: { evaluate: blankEvalSpy },
        formExtractor: blankFormExtractor,
        formTemplateParser,
      });

      await blankService.extractFields({
        documentTypeKey: 'submittal-arch',
        context: { items: [{ id: 'flat-doc' }] },
      });
      expect(blankEvalSpy).not.toHaveBeenCalled();

      await blankService.extractFields({
        documentTypeKey: 'submittal-arch',
        context: { items: [{ id: 'blank-form' }] },
      });
      expect(blankEvalSpy).toHaveBeenCalledTimes(1);
      expect(blankEvalSpy.mock.calls[0][1].form).toEqual({});
    });

    it('emits formatAmbiguousFormFieldMessage for ambiguous bound widgets, skips populating them, still populates non-ambiguous widgets on the same form, and breaks out of validItemIds', async () => {
      const drivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockImplementation(async (id: string) => ({
          item: { id, name: `${id}.pdf`, mimeType: 'application/vnd.google-apps.document' },
          ancestors: [],
        })),
      };

      const formExtractor: FormExtractorPort = {
        extractFormFields: vi.fn().mockImplementation(async ({ id }: { id: string }) => {
          if (id === 'doc-1') {
            return {
              status: 'ok',
              widgetCount: 3,
              fields: {
                'Submittal Response': 'No Exceptions Taken',
                Notes: 'Verify sealant color',
                'Unmapped Checkboxes': 'Option A',
              },
              ambiguousFields: ['Submittal Response', 'Unmapped Checkboxes'],
            };
          }
          return {
            status: 'ok',
            widgetCount: 1,
            fields: { 'Submittal Response': 'Rejected' },
          };
        }),
      };

      const registry = makeFormMatchRegistry(undefined, {
        Notes: { template: '{{notes}}' },
      });
      registry.getParseSchema = vi.fn().mockResolvedValue({
        extractors: [{ source: 'form' as const }],
      });

      const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: registry,
        formExtractor,
        formTemplateParser,
      });

      const res = await service.extractFields({
        documentTypeKey: 'submittal-arch',
        context: { items: [{ id: 'doc-1' }, { id: 'doc-2' }] },
      });

      expect(res.fields.action).toBeUndefined();
      expect(res.fields.notes).toBe('Verify sealant color');
      expect(res.statusMessages).toEqual([
        formatAmbiguousFormFieldMessage('Submittal Response'),
      ]);
      expect(res.statusMessages?.[0]).toBe(
        'Could not pre-populate from "Submittal Response" because multiple options are selected; please verify manually.'
      );
      expect(formExtractor.extractFormFields).toHaveBeenCalledTimes(1);
    });

    it('breaks out of validItemIds on ambiguous bound widget even when no other fields are populated, and suppresses notice when target fields are already in populatedFields', async () => {
      const drivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockImplementation(async (id: string) => ({
          item: { id, name: `${id}.pdf`, mimeType: 'application/vnd.google-apps.document' },
          ancestors: [],
        })),
      };

      const formExtractor: FormExtractorPort = {
        extractFormFields: vi.fn().mockImplementation(async ({ id }: { id: string }) => {
          if (id === 'doc-1') {
            return {
              status: 'ok',
              widgetCount: 2,
              fields: {},
              ambiguousFields: ['Submittal Response'],
            };
          }
          return {
            status: 'ok',
            widgetCount: 2,
            fields: {
              'Submittal Response': 'No Exceptions Taken',
              Notes: 'From second doc',
            },
          };
        }),
      };

      const registry = makeFormMatchRegistry(undefined, {
        Notes: { template: '{{notes}}' },
      });
      registry.getParseSchema = vi.fn().mockResolvedValue({
        extractors: [
          { source: 'form' as const },
        ],
      });

      const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: registry,
        formExtractor,
        formTemplateParser,
      });

      // 1. Ambiguous bound widget with no other fields populated on doc-1 still breaks out of validItemIds
      const res1 = await service.extractFields({
        documentTypeKey: 'submittal-arch',
        context: { items: [{ id: 'doc-1' }, { id: 'doc-2' }] },
      });
      expect(res1.fields.action).toBeUndefined();
      expect(res1.fields.notes).toBeUndefined();
      expect(res1.statusMessages).toEqual([
        formatAmbiguousFormFieldMessage('Submittal Response'),
      ]);
      expect(formExtractor.extractFormFields).toHaveBeenCalledTimes(1);

      // 2. When action is already in existingData (user edit), ambiguous notice for Submittal Response is skipped and continues to doc-2 for unpopulated Notes
      (formExtractor.extractFormFields as ReturnType<typeof vi.fn>).mockClear();
      const res2 = await service.extractFields({
        documentTypeKey: 'submittal-arch',
        existingData: { action: 'REC' },
        context: { items: [{ id: 'doc-1' }, { id: 'doc-2' }] },
      });
      expect(res2.fields.action).toBe('REC');
      expect(res2.fields.notes).toBe('From second doc');
      expect(res2.statusMessages).toBeUndefined();
      expect(formExtractor.extractFormFields).toHaveBeenCalledTimes(2);

      // 3. When action is already populated by earlier gmail extractor, ambiguous notice is also skipped
      (formExtractor.extractFormFields as ReturnType<typeof vi.fn>).mockClear();
      registry.getParseSchema = vi.fn().mockResolvedValue({
        extractors: [
          { source: 'gmail' as const, fields: { action: { set: 'REC' } } },
          { source: 'form' as const },
        ],
      });
      const res3 = await service.extractFields({
        documentTypeKey: 'submittal-arch',
        context: {
          isDriveUrl: true,
          email: { id: 'msg-1', subject: 'Submittal' },
          items: [{ id: 'doc-1' }, { id: 'doc-2' }],
        },
      });
      expect(res3.fields.action).toBe('REC');
      expect(res3.fields.notes).toBe('From second doc');
      expect(res3.statusMessages).toBeUndefined();
      expect(formExtractor.extractFormFields).toHaveBeenCalledTimes(2);
    });

    it('continues past per-item getHydratedDriveItem failures in [Forbidden.pdf, Stamped_Cover.pdf], populates from Stamped_Cover.pdf, and emits generalized Drive fallback notice', async () => {
      const drivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockImplementation(async (id: string) => {
          if (id === 'forbidden-pdf') {
            throw Object.assign(new Error('Forbidden'), { statusCode: 403 });
          }
          return {
            item: {
              id: 'stamped-cover',
              name: '071200-001_Stamped_Cover.pdf',
              mimeType: 'application/pdf',
              modifiedTime: '2026-11-18T15:00:00Z',
            },
            ancestors: [],
          };
        }),
      };

      const formExtractor: FormExtractorPort = {
        extractFormFields: vi.fn().mockResolvedValue({
          status: 'ok',
          widgetCount: 2,
          fields: { 'Submittal Response': 'Revise and Resubmit' },
        }),
      };

      const registry = makeFormMatchRegistry(undefined);
      registry.getParseSchema = vi.fn().mockResolvedValue({
        extractors: [{ source: 'form' as const }],
      });

      const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: registry,
        formExtractor,
        formTemplateParser,
      });

      const res = await service.extractFields({
        documentTypeKey: 'submittal-arch',
        context: {
          items: [{ id: 'forbidden-pdf' }, { id: 'stamped-cover' }],
        },
      });

      expect(res.fields.action).toBe('RR');
      expect(res.statusMessages).toEqual([
        DRIVE_METADATA_EXTRACT_ERROR_MESSAGE,
      ]);
      expect(DRIVE_METADATA_EXTRACT_ERROR_MESSAGE).toBe(
        'Could not read Google Drive file metadata or document form fields to pre-populate fields; you can enter them manually.'
      );
      expect(formExtractor.extractFormFields).toHaveBeenCalledTimes(1);
      expect(formExtractor.extractFormFields).toHaveBeenCalledWith({
        id: 'stamped-cover',
        mimeType: 'application/pdf',
      });
    });

    it('does not emit ambiguousFields notice when post-read form extractor.match evaluates to false', async () => {
      const drivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue({
          item: { id: 'doc-1', name: 'Draft.pdf', mimeType: 'application/pdf' },
          ancestors: [],
        }),
      };
      const formExtractor: FormExtractorPort = {
        extractFormFields: vi.fn().mockResolvedValue({
          status: 'ok',
          widgetCount: 2,
          fields: { IsCover: false },
          ambiguousFields: ['Submittal Response'],
        }),
      };
      const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: makeFormMatchRegistry({ '===': [{ var: 'form.IsCover' }, true] }),
        predicateEvaluator: realPredicateEvaluator,
        formExtractor,
        formTemplateParser,
      });

      const res = await service.extractFields({
        documentTypeKey: 'submittal-arch',
        context: { items: [{ id: 'doc-1' }] },
      });

      expect(res.fields.action).toBeUndefined();
      expect(res.statusMessages).toBeUndefined();
    });
  });

  describe('Ticket #318: Composite LookupField cursor matcher, LinkedField derivation, and Submittal FF&E', () => {
    const formTemplateParser = new HandlebarsAdapter();

    function makeFfeRegistry(options?: { dynamicSpecTag?: boolean; customFormTemplate?: string }) {
      const specOptions = options?.dynamicSpecTag
        ? { source: 'specs', key: 'key', dynamicConfig: { provider: 'google_sheets' }, allowUserInput: true }
        : { source: 'specs', key: 'key', allowUserInput: true };

      return {
        initialize: vi.fn(),
        getParseSchema: vi.fn().mockResolvedValue({
          extractors: [
            {
              source: 'gmail' as const,
              fields: {
                specTag: {
                  from: 'email.subjectClean' as const,
                  pattern: '(?<=^|[\\s_./-])([A-Za-z]{2}[\\s._-]?\\d{3}[A-Za-z]?)(?=[\\s_./-]|$)',
                  group: 1,
                  normalize: 'compactAlnum' as const,
                  lookup: true,
                },
              },
            },
            { source: 'form' as const },
            {
              source: 'drive' as const,
              fields: {
                vendor: {
                  from: 'drive.fileNameStem' as const,
                  normalize: 'cleanFilenameText' as const,
                  lookup: true,
                },
              },
            },
          ],
        }),
        getDocumentFormSchema: vi.fn().mockResolvedValue({
          fields: {
            'Submittal No': {
              template: options?.customFormTemplate ?? '{{specTag.key}}-{{revision}}',
            },
            'Submittal Response': {
              template: '{{action.name}}',
              valueMap: { RR: 'Revise and Resubmit' },
            },
            Date: {
              template: '{{date}}',
              format: 'date' as const,
            },
          },
        }),
        getTargetSchema: vi.fn().mockResolvedValue({
          fields: [
            { key: 'specTag', type: 'string', minLength: 1, pattern: '^.*\\S+.*$', options: specOptions },
            { key: 'revision', type: 'string', minLength: 1, pattern: '^.*\\S+.*$' },
            {
              key: 'specTitle',
              type: 'string',
              minLength: 1,
              pattern: '^.*\\S+.*$',
              linkedField: { sourceField: 'specTag', sourceProperty: 'name' },
            },
            {
              key: 'vendor',
              type: 'string',
              options: { source: 'vendors', key: 'key', name: 'name' },
            },
            { key: 'date', type: 'string' },
            {
              key: 'action',
              type: 'string',
              options: { source: 'actions', key: 'key', name: 'name' },
            },
          ],
          options: {
            specs: [
              { key: 'CG104', name: 'BED - KING' },
              { key: 'CG138M', name: 'CREDENZA - MIRRORED' },
              { key: 'LT159A', name: 'SCONCE - CORRIDOR' },
            ],
            vendors: [
              { key: 'BM', name: 'Berman Falk' },
              { key: 'FDT', name: 'Fil Doux Textiles' },
            ],
            actions: [
              { key: 'REC', name: 'Received' },
              { key: 'RR', name: 'Revise & Resubmit' },
              { key: 'NOC', name: 'No Objections As Corrected' },
              { key: 'NET', name: 'No Exceptions Taken' },
            ],
          },
        }),
      };
    }

    it.each<[string, Record<string, unknown>]>([
      ['CG104', { specTag: 'CG104', specTitle: 'BED - KING' }],
      ['CG104 - A', { specTag: 'CG104', specTitle: 'BED - KING', revision: 'A' }],
      ['CG-104 - A', { specTag: 'CG104', specTitle: 'BED - KING', revision: 'A' }],
      ['CG104_A', { specTag: 'CG104', specTitle: 'BED - KING', revision: 'A' }],
      ['CG 104 - A', { specTag: 'CG104', specTitle: 'BED - KING', revision: 'A' }],
      ['LT 159A - R0', { specTag: 'LT159A', specTitle: 'SCONCE - CORRIDOR', revision: '0' }],
      ['CG138M-2', { specTag: 'CG138M', specTitle: 'CREDENZA - MIRRORED', revision: '2' }],
      ['Rev. B', { revision: 'B' }],
      ['R1', { revision: '1' }],
      ['A', { revision: 'A' }],
      // Custom/unlisted specTag must not pre-populate unverified specTag or specTitle
      ['XX999 - A', {}],
      ['ZZ999', {}],
    ])('decomposes FF&E Submittal No "%s" -> %j', async (submittalNo, expected) => {
      const drivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue({
          item: { id: 'f-ffe', name: 'Stamped_Cover.pdf', mimeType: 'application/pdf' },
          ancestors: [],
        }),
      };
      const formExtractor: FormExtractorPort = {
        extractFormFields: vi.fn().mockResolvedValue({
          status: 'ok',
          widgetCount: 1,
          fields: { 'Submittal No': submittalNo },
        }),
      };

      const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: makeFfeRegistry(),
        formExtractor,
        formTemplateParser,
      });

      const res = await service.extractFields({
        documentTypeKey: 'submittal-ffe',
        context: { items: [{ id: 'f-ffe' }] },
      });

      expect(res.fields).toEqual(expected);
    });

    it('resolves dynamic CanonicalOptionsProviderPort options for LookupField tokens and derives LinkedField specTitle', async () => {
      const drivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue({
          item: { id: 'f-dyn', name: 'Stamped_Cover.pdf', mimeType: 'application/pdf' },
          ancestors: [],
        }),
      };
      const formExtractor: FormExtractorPort = {
        extractFormFields: vi.fn().mockResolvedValue({
          status: 'ok',
          widgetCount: 3,
          fields: {
            'Submittal No': 'TA 210 - B',
            'Submittal Response': 'Revise and Resubmit',
            Date: '5/8/26',
          },
        }),
      };
      const canonicalOptionsProvider: CanonicalOptionsProviderPort = {
        getCanonicalOptions: vi.fn().mockResolvedValue([
          { key: 'TA210', name: 'DYNAMIC SIDE TABLE' },
        ]),
      };

      const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: makeFfeRegistry({ dynamicSpecTag: true }),
        canonicalOptionsProvider,
        formExtractor,
        formTemplateParser,
      });

      const res = await service.extractFields({
        documentTypeKey: 'submittal-ffe',
        spaceId: 'proj-dyn-1',
        context: { items: [{ id: 'f-dyn' }] },
      });

      expect(canonicalOptionsProvider.getCanonicalOptions).toHaveBeenCalledWith(
        'proj-dyn-1',
        expect.objectContaining({ key: 'specTag' })
      );
      expect(res.fields).toEqual({
        specTag: 'TA210',
        specTitle: 'DYNAMIC SIDE TABLE',
        revision: 'B',
        action: 'RR',
        date: '260508',
      });
    });

    it('matches fallback delimiter-bounded segment for non-spec-tag LookupField without allowUserInput', async () => {
      const drivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue({
          item: { id: 'f-vendor', name: 'Stamped_Cover.pdf', mimeType: 'application/pdf' },
          ancestors: [],
        }),
      };
      const formExtractor: FormExtractorPort = {
        extractFormFields: vi.fn().mockResolvedValue({
          status: 'ok',
          widgetCount: 1,
          fields: { 'Submittal No': 'BM - 3' },
        }),
      };

      const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: makeFfeRegistry({ customFormTemplate: '{{vendor.key}}-{{revision}}' }),
        formExtractor,
        formTemplateParser,
      });

      const res = await service.extractFields({
        documentTypeKey: 'submittal-ffe',
        context: { items: [{ id: 'f-vendor' }] },
      });

      expect(res.fields).toEqual({
        vendor: 'BM',
        revision: '3',
      });
    });

    it('advances cursor past already-populated specTag (from existingData or gmail) to extract trailing revision without overwriting specTag or specTitle', async () => {
      const drivePort: DriveSourceContextPort = {
        getItemHierarchy: vi.fn().mockResolvedValue({
          item: { id: 'f-ffe-cursor', name: 'Berman_Falk.pdf', mimeType: 'application/pdf' },
          ancestors: [],
        }),
      };
      const formExtractor: FormExtractorPort = {
        extractFormFields: vi.fn().mockResolvedValue({
          status: 'ok',
          widgetCount: 2,
          fields: {
            'Submittal No': 'LT159A - C',
            'Submittal Response': 'No Objections As Corrected',
          },
        }),
      };

      const service = new SourceParserService(drivePort, mockSpaceConfigPort, {
        parseSchemaRegistry: makeFfeRegistry(),
        formExtractor,
        formTemplateParser,
      });

      // 1. existingData preserves custom user-edited specTag + specTitle while cursor consumes LT159A - to extract revision: C
      const editedRes = await service.extractFields({
        documentTypeKey: 'submittal-ffe',
        existingData: { specTag: 'ZZ999', specTitle: 'CUSTOM BENCH' },
        context: { items: [{ id: 'f-ffe-cursor' }] },
      });
      expect(editedRes.fields).toEqual({
        specTag: 'ZZ999',
        specTitle: 'CUSTOM BENCH',
        revision: 'C',
        action: 'NOC',
        vendor: 'BM',
      });

      // 2. Gmail populates specTag/specTitle first, form advances cursor to revision + action, drive fills vendor
      const gmailUrlRes = await service.extractFields({
        documentTypeKey: 'submittal-ffe',
        context: {
          isDriveUrl: true,
          items: [{ id: 'f-ffe-cursor' }],
          email: {
            id: 'msg-ffe-1',
            subject: 'CG104 Submittal',
          },
        },
      });
      expect(gmailUrlRes.fields).toEqual({
        specTag: 'CG104',
        specTitle: 'BED - KING',
        revision: 'C',
        action: 'NOC',
        vendor: 'BM',
      });
    });
  });
});
