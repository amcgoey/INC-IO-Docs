import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import {
  DocumentService,
  type Document,
  type Activity,
  type ActivityExecutionContext,
  type ActivityOutput,
  type DocumentType,
} from '../src/features/document/domain';
import { HandlebarsAdapter } from '../src/infrastructure/template-engine/handlebars-adapter';
import { ActivityEngine } from '../src/features/document/adapters/activity-engine';
import { DocumentSchemaRegistryAdapter } from '../src/features/document/adapters/document-schema-registry';
import { CompiledSchemaRegistry } from '../src/features/document/adapters/compiled-schema-registry';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import { ensureEvaluationOrder } from '../src/infrastructure/validation/json-logic-graph';
import type { ActivityHandler, DocumentSchemaRegistryPort } from '../src/features/document/ports';

describe('Workflow & Activity End-to-End Hexagonal Integration (Production Schemas)', () => {
  let documentService: DocumentService;
  let handlebarsAdapter: HandlebarsAdapter;
  let activityEngine: ActivityEngine;
  let mockMoveHandler: ActivityHandler;
  let moveHandleSpy: Mock<(activity: Activity, context?: ActivityExecutionContext) => Promise<ActivityOutput>>;

  beforeEach(async () => {
    moveHandleSpy = vi
      .fn<(activity: Activity, context?: ActivityExecutionContext) => Promise<ActivityOutput>>()
      .mockResolvedValue({
        success: true,
        files: [{ id: 'moved-file-123', name: 'Original.pdf', parentName: '260826 OT - ASR 06 Design Changes' }],
      });

    mockMoveHandler = {
      canHandle: vi.fn((activity: Activity) => activity.type === 'MOVE_FILE'),
      handle: (activity: Activity, context?: ActivityExecutionContext) => moveHandleSpy(activity, context),
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
      },
      calculated: {
        commFolderName: '260826 OT - ASR 06 Design Changes',
      },
    });

    const expectedPayload = {
      rootStorageId: 'shared-drive-proj-123',
      parentPath: '1 Admin/Communication',
      folderName: '_Client - AAA/260826 OT - ASR 06 Design Changes',
    };

    const expectedActivity: Activity = {
      id: 'moveFiles',
      type: 'MOVE_FILE',
      payload: expectedPayload,
    };

    expect(result.activities).toEqual([expectedActivity]);
    expect(mockMoveHandler.canHandle).toHaveBeenCalledWith(expectedActivity);
    expect(moveHandleSpy).toHaveBeenCalledWith(
      expectedActivity,
      expect.objectContaining({
        document: result.data,
        files: [],
        stepOutputs: {},
        contextVariables: {},
      })
    );
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
      },
      calculated: {
        commFolderName: '260715 IN - CD Comments',
      },
    });

    const expectedPayload = {
      rootStorageId: 'opp-folder-456',
      parentPath: 'Communications',
      folderName: 'Architect - BBB/260715 IN - CD Comments',
    };

    const expectedActivity: Activity = {
      id: 'moveFiles',
      type: 'MOVE_FILE',
      payload: expectedPayload,
    };

    expect(result.activities).toEqual([expectedActivity]);
    expect(mockMoveHandler.canHandle).toHaveBeenCalledWith(expectedActivity);
    expect(moveHandleSpy).toHaveBeenCalledWith(
      expectedActivity,
      expect.objectContaining({
        document: result.data,
        files: [],
        stepOutputs: {},
        contextVariables: {},
      })
    );
  });

  it('preserves raw punctuation in Document.data and identity while sanitizing disallowed file-path characters strictly in MOVE_FILE path assembly', async () => {
    const rawContact = 'Client: /Bad*Name?|With<Disallowed>"Chars\\And\x01Control. .';
    const rawDescription = '  ASR / 06: Design * Changes? ...  ';
    const projectDocument: Document = {
      type: 'communication-project',
      space: {
        id: 'proj-1',
        typeId: 'projects',
        abstractStorageId: 'shared-drive-proj-123',
        name: 'Project Alpha',
      },
      data: {
        contact: `  ${rawContact} `,
        date: '260826',
        direction: 'OT',
        description: rawDescription,
      },
    };

    const result = await documentService.processDocument(projectDocument, 'onSubmit');

    expect(result.success).toBe(true);
    if (!result.success) return;

    const rawCommFolder = `260826 OT - ${rawDescription}`;
    const expectedContactPath = 'Client- -Bad-Name--With-Disallowed--Chars-And-Control';
    const expectedCommFolderPath = '260826 OT - ASR - 06- Design - Changes-';

    expect(result.data).toEqual({
      type: 'communication-project',
      id: `${rawContact}-260826-OT-${rawDescription}`,
      idDocument: `${rawContact}-260826-OT-${rawDescription}`,
      idGroup: rawContact,
      space: {
        id: 'proj-1',
        typeId: 'projects',
        abstractStorageId: 'shared-drive-proj-123',
        name: 'Project Alpha',
      },
      data: {
        contact: {
          key: rawContact,
          name: rawContact,
        },
        date: '260826',
        direction: {
          key: 'OT',
          name: 'Outgoing',
        },
        description: rawDescription,
      },
      calculated: {
        commFolderName: rawCommFolder,
      },
    });

    const expectedPayload = {
      rootStorageId: 'shared-drive-proj-123',
      parentPath: '1 Admin/Communication',
      folderName: `${expectedContactPath}/${expectedCommFolderPath}`,
    };

    const expectedActivity: Activity = {
      id: 'moveFiles',
      type: 'MOVE_FILE',
      payload: expectedPayload,
    };

    expect(result.activities).toEqual([expectedActivity]);
    expect(mockMoveHandler.canHandle).toHaveBeenCalledWith(expectedActivity);
    expect(moveHandleSpy).toHaveBeenCalledWith(
      expectedActivity,
      expect.objectContaining({
        document: result.data,
        files: [],
        stepOutputs: {},
        contextVariables: {},
      })
    );
  });

  it('chains multi-step workflow with Activity.id through ActivityEngine and HandlebarsAdapter, evolving frozen ActivityExecutionContext snapshots immutably', async () => {
    const primaryFile = {
      id: 'drive-file-primary-1',
      name: 'ASR-06.pdf',
      uri: 'https://drive.google.com/file/d/drive-file-primary-1/view',
    };

    const multiStepDocumentType: DocumentType = {
      key: 'multi-step-chain-doc',
      name: 'Multi-Step Chain Doc',
      documentSchema: {
        fields: [{ key: 'title', name: 'Title', type: 'string', required: true }],
      },
      documentUiSchema: {
        events: {
          onSubmit: {
            catchAllWorkflow: 'ChainedExecutionWorkflow',
          },
        },
      },
      documentWorkflowConfig: {
        workflows: [
          {
            name: 'ChainedExecutionWorkflow',
            activitySequence: [
              {
                id: 'movePrimary',
                type: 'MOVE_FILE',
                payload: {
                  title: '{{Document.data.title}}',
                },
              },
              {
                id: 'auditStep',
                type: 'AUDIT_STEP',
                payload: {
                  folder: '{{Context.archiveFolder}}',
                },
              },
              {
                id: 'writeLog',
                type: 'WRITE_LOG',
                payload: {
                  movedUri: '{{Context.movePrimary.files.0.uri}}',
                  archiveFolder: '{{Context.archiveFolder}}',
                  auditStatus: '{{Context.auditStatus}}',
                },
              },
            ],
          },
        ],
      },
    };

    const capturedContexts: Array<{
      activityType: string;
      context: ActivityExecutionContext;
    }> = [];

    const captureContextHandler = (
      type: string,
      output?: ActivityOutput
    ): ActivityHandler => ({
      canHandle: (activity: Activity) => activity.type === type,
      handle: (activity: Activity, context?: ActivityExecutionContext) => {
        expect(context).toBeDefined();
        capturedContexts.push({
          activityType: activity.type,
          context: context!,
        });
        return output;
      },
    });

    const engine = new ActivityEngine([
      captureContextHandler('MOVE_FILE', {
        success: true,
        files: [primaryFile],
        contextVariables: { archiveFolder: 'Archive/2026' },
      }),
      captureContextHandler('AUDIT_STEP', {
        success: true,
        contextVariables: { auditStatus: 'VERIFIED' },
      }),
      captureContextHandler('WRITE_LOG', {
        success: true,
      }),
    ]);

    const realHandlebars = new HandlebarsAdapter();
    const customRegistry: DocumentSchemaRegistryPort = {
      loadAll: vi.fn().mockResolvedValue([multiStepDocumentType]),
    };
    const compiledRegistry = new CompiledSchemaRegistry(customRegistry);
    await compiledRegistry.initialize();

    const service = new DocumentService(
      engine,
      customRegistry,
      realHandlebars,
      compiledRegistry
    );
    await service.initialize();

    const inputDocument: Document = {
      type: 'multi-step-chain-doc',
      data: { title: 'Design Package' },
    };

    const result = await service.processDocument(inputDocument, 'onSubmit');

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Handlebars evaluated downstream WRITE_LOG templates using Context.<id>.files.0.uri and Context.<var>
    expect(result.activities).toEqual([
      {
        id: 'movePrimary',
        type: 'MOVE_FILE',
        payload: { title: 'Design Package' },
      },
      {
        id: 'auditStep',
        type: 'AUDIT_STEP',
        payload: { folder: 'Archive/2026' },
      },
      {
        id: 'writeLog',
        type: 'WRITE_LOG',
        payload: {
          movedUri: 'https://drive.google.com/file/d/drive-file-primary-1/view',
          archiveFolder: 'Archive/2026',
          auditStatus: 'VERIFIED',
        },
      },
    ]);
    expect(result.contextVariables).toEqual({
      archiveFolder: 'Archive/2026',
      auditStatus: 'VERIFIED',
    });

    // Verify ActivityHandler.handle received frozen, evolving ActivityExecutionContext snapshots
    expect(capturedContexts).toHaveLength(3);
    const [step1Snap, step2Snap, step3Snap] = capturedContexts;

    expect(step1Snap.activityType).toBe('MOVE_FILE');
    expect(step1Snap.context).toEqual({
      document: inputDocument,
      files: [],
      stepOutputs: {},
      contextVariables: {},
    });

    expect(step2Snap.activityType).toBe('AUDIT_STEP');
    expect(step2Snap.context).toEqual({
      document: inputDocument,
      files: [primaryFile],
      stepOutputs: {
        movePrimary: {
          success: true,
          files: [primaryFile],
          contextVariables: { archiveFolder: 'Archive/2026' },
        },
      },
      contextVariables: { archiveFolder: 'Archive/2026' },
    });

    // Middle step omitted `files`; `files` from movePrimary is preserved and contextVariables merged
    expect(step3Snap.activityType).toBe('WRITE_LOG');
    expect(step3Snap.context).toEqual({
      document: inputDocument,
      files: [primaryFile],
      stepOutputs: {
        movePrimary: {
          success: true,
          files: [primaryFile],
          contextVariables: { archiveFolder: 'Archive/2026' },
        },
        auditStep: {
          success: true,
          contextVariables: { auditStatus: 'VERIFIED' },
        },
      },
      contextVariables: {
        archiveFolder: 'Archive/2026',
        auditStatus: 'VERIFIED',
      },
    });

    // All captured snapshots and their nested fields remain frozen and earlier snapshots were not mutated
    for (const { context } of capturedContexts) {
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.document)).toBe(true);
      expect(Object.isFrozen(context.files)).toBe(true);
      expect(Object.isFrozen(context.stepOutputs)).toBe(true);
      expect(Object.isFrozen(context.contextVariables)).toBe(true);
    }

    expect(Object.keys(step1Snap.context.stepOutputs)).toEqual([]);
    expect(Object.keys(step1Snap.context.contextVariables)).toEqual([]);
    expect(Object.keys(step2Snap.context.stepOutputs)).toEqual(['movePrimary']);
    expect(step2Snap.context.contextVariables).toEqual({ archiveFolder: 'Archive/2026' });
    expect(Object.isFrozen(step2Snap.context.stepOutputs.movePrimary)).toBe(true);
    expect(Object.isFrozen(step2Snap.context.stepOutputs.movePrimary.files)).toBe(true);
  });
});
