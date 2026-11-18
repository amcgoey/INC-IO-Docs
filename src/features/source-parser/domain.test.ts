import { describe, it, expect, vi } from 'vitest';
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
} from './domain';
import type {
  DriveSourceContextPort,
  SourceParserSpaceConfigPort,
  SourceParserSpaceTypeConfig,
  DriveItemHierarchy,
} from './ports';

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
  });
});
