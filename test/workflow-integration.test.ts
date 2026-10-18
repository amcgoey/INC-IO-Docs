import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { DocumentService, type Document, type Activity, type ActivityOutput } from '../src/features/document/domain';
import { HandlebarsAdapter } from '../src/infrastructure/template-engine/handlebars-adapter';
import { ActivityEngine } from '../src/features/document/adapters/activity-engine';
import { DocumentSchemaRegistryAdapter } from '../src/features/document/adapters/document-schema-registry';
import { CompiledSchemaRegistry } from '../src/features/document/adapters/compiled-schema-registry';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import { ensureEvaluationOrder } from '../src/infrastructure/validation/json-logic-graph';
import type { ActivityHandler } from '../src/features/document/ports';

describe('Workflow & Activity End-to-End Hexagonal Integration (Production Schemas)', () => {
  let documentService: DocumentService;
  let handlebarsAdapter: HandlebarsAdapter;
  let activityEngine: ActivityEngine;
  let mockMoveHandler: ActivityHandler;
  let moveHandleSpy: Mock<(activity: Activity) => Promise<ActivityOutput>>;

  beforeEach(async () => {
    moveHandleSpy = vi.fn<(activity: Activity) => Promise<ActivityOutput>>().mockResolvedValue({
      success: true,
      files: [{ id: 'moved-file-123', name: 'Original.pdf', parentName: '260826 OT - ASR 06 Design Changes' }],
    });

    mockMoveHandler = {
      canHandle: vi.fn((activity: Activity) => activity.type === 'MOVE_FILE'),
      handle: (activity: Activity) => moveHandleSpy(activity),
    };

    handlebarsAdapter = new HandlebarsAdapter();
    activityEngine = new ActivityEngine([mockMoveHandler]);

    const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
    const manifestProvider = new AppManifestProvider({ manifestPath });
    const registryAdapter = new DocumentSchemaRegistryAdapter(
      manifestProvider,
      handlebarsAdapter,
      ensureEvaluationOrder
    );

    const compiledRegistry = new CompiledSchemaRegistry(registryAdapter);
    await compiledRegistry.initialize();

    documentService = new DocumentService(
      activityEngine,
      registryAdapter,
      handlebarsAdapter,
      compiledRegistry
    );

    await documentService.initialize();
  });

  it('routes and executes communication-project: enriches options, evaluates commFolderName, synthesizes identity, resolves basePath, and dispatches MOVE_FILE', async () => {
    const projectDocument: Document = {
      type: 'communication-project',
      space: {
        id: 'proj-1',
        typeId: 'projects',
        abstractStorageId: 'shared-drive-proj-123',
        name: 'Project Alpha',
      },
      data: {
        contact: '_Client - AAA',
        date: '260826',
        direction: 'OT',
        description: 'ASR 06 Design Changes',
      },
    };

    const result = await documentService.processDocument(projectDocument, 'onSubmit');

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Asserts identity synthesis, option enrichment, and calculated field from communication-project schema
    expect(result.data).toEqual({
      type: 'communication-project',
      id: '_Client - AAA-260826-OT-ASR 06 Design Changes',
      idDocument: '_Client - AAA-260826-OT-ASR 06 Design Changes',
      idGroup: '_Client - AAA',
      space: {
        id: 'proj-1',
        typeId: 'projects',
        abstractStorageId: 'shared-drive-proj-123',
        name: 'Project Alpha',
      },
      data: {
        contact: {
          key: '_Client - AAA',
          name: '_Client - AAA',
        },
        date: '260826',
        direction: {
          key: 'OT',
          name: 'Outgoing',
        },
        description: 'ASR 06 Design Changes',
        commFolderName: '260826 OT - ASR 06 Design Changes',
      },
    });

    const expectedPayload = {
      rootStorageId: 'shared-drive-proj-123',
      parentPath: '1 Admin/Communication',
      folderName: '_Client - AAA/260826 OT - ASR 06 Design Changes',
    };

    const expectedActivity: Activity = {
      type: 'MOVE_FILE',
      payload: expectedPayload,
    };

    expect(result.activities).toEqual([expectedActivity]);
    expect(mockMoveHandler.canHandle).toHaveBeenCalledWith(expectedActivity);
    expect(moveHandleSpy).toHaveBeenCalledWith(expectedActivity);
  });

  it('routes and executes communication-proposal: enriches options, evaluates commFolderName, synthesizes identity, resolves basePath, and dispatches MOVE_FILE', async () => {
    const proposalDocument: Document = {
      type: 'communication-proposal',
      space: {
        id: 'prop-1',
        typeId: 'proposals',
        abstractStorageId: 'opp-folder-456',
        name: 'Proposal Beta',
      },
      data: {
        contact: 'Architect - BBB',
        date: '260715',
        direction: 'IN',
        description: 'CD Comments',
      },
    };

    const result = await documentService.processDocument(proposalDocument, 'onSubmit');

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Asserts identity synthesis, option enrichment, and calculated field from communication-proposal schema
    expect(result.data).toEqual({
      type: 'communication-proposal',
      id: 'Architect - BBB-260715-IN-CD Comments',
      idDocument: 'Architect - BBB-260715-IN-CD Comments',
      idGroup: 'Architect - BBB',
      space: {
        id: 'prop-1',
        typeId: 'proposals',
        abstractStorageId: 'opp-folder-456',
        name: 'Proposal Beta',
      },
      data: {
        contact: {
          key: 'Architect - BBB',
          name: 'Architect - BBB',
        },
        date: '260715',
        direction: {
          key: 'IN',
          name: 'Incoming',
        },
        description: 'CD Comments',
        commFolderName: '260715 IN - CD Comments',
      },
    });

    const expectedPayload = {
      rootStorageId: 'opp-folder-456',
      parentPath: 'Communications',
      folderName: 'Architect - BBB/260715 IN - CD Comments',
    };

    const expectedActivity: Activity = {
      type: 'MOVE_FILE',
      payload: expectedPayload,
    };

    expect(result.activities).toEqual([expectedActivity]);
    expect(mockMoveHandler.canHandle).toHaveBeenCalledWith(expectedActivity);
    expect(moveHandleSpy).toHaveBeenCalledWith(expectedActivity);
  });

  it('sanitizes disallowed file-path characters in contact and description, evaluates commFolderName, synthesizes identity, and dispatches sanitized MOVE_FILE activity', async () => {
    const projectDocument: Document = {
      type: 'communication-project',
      space: {
        id: 'proj-1',
        typeId: 'projects',
        abstractStorageId: 'shared-drive-proj-123',
        name: 'Project Alpha',
      },
      data: {
        contact: '  Client: /Bad*Name?|With<Disallowed>"Chars\\And\x01Control. . ',
        date: '260826',
        direction: 'OT',
        description: '  ASR / 06: Design * Changes? ...  ',
      },
    };

    const result = await documentService.processDocument(projectDocument, 'onSubmit');

    expect(result.success).toBe(true);
    if (!result.success) return;

    const expectedContact = 'Client- -Bad-Name--With-Disallowed--Chars-And-Control';
    const expectedDescription = 'ASR - 06- Design - Changes-';
    const expectedCommFolder = '260826 OT - ASR - 06- Design - Changes-';

    expect(result.data).toEqual({
      type: 'communication-project',
      id: `${expectedContact}-260826-OT-${expectedDescription}`,
      idDocument: `${expectedContact}-260826-OT-${expectedDescription}`,
      idGroup: expectedContact,
      space: {
        id: 'proj-1',
        typeId: 'projects',
        abstractStorageId: 'shared-drive-proj-123',
        name: 'Project Alpha',
      },
      data: {
        contact: {
          key: expectedContact,
          name: expectedContact,
        },
        date: '260826',
        direction: {
          key: 'OT',
          name: 'Outgoing',
        },
        description: expectedDescription,
        commFolderName: expectedCommFolder,
      },
    });

    const expectedPayload = {
      rootStorageId: 'shared-drive-proj-123',
      parentPath: '1 Admin/Communication',
      folderName: `${expectedContact}/${expectedCommFolder}`,
    };

    const expectedActivity: Activity = {
      type: 'MOVE_FILE',
      payload: expectedPayload,
    };

    expect(result.activities).toEqual([expectedActivity]);
    expect(mockMoveHandler.canHandle).toHaveBeenCalledWith(expectedActivity);
    expect(moveHandleSpy).toHaveBeenCalledWith(expectedActivity);
  });
});
