import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DocumentService, type DocumentType, type Document, type Activity } from '../src/features/document/domain';
import { HandlebarsAdapter } from '../src/infrastructure/template-engine/handlebars-adapter';
import { StructuredLogActivity } from '../src/features/document/adapters/structured-log-activity';
import { ActivityEngine } from '../src/features/document/adapters/activity-engine';
import type { DocumentSchemaRegistryPort } from '../src/features/document/ports';

describe('Workflow & Activity End-to-End Hexagonal Integration', () => {
  let documentService: DocumentService;
  let handlebarsAdapter: HandlebarsAdapter;
  let activityEngine: ActivityEngine;
  let structuredLogActivity: StructuredLogActivity;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  const communicationProjectDocumentType: DocumentType = {
    key: 'communication-project',
    name: 'Communication Project',
    documentSchema: {
      fields: [
        {
          key: 'contact',
          name: 'Contact',
          type: 'string',
          description: 'Contact folder name',
          required: true,
        },
        {
          key: 'date',
          name: 'Date',
          type: 'string',
          description: 'Date in yyMMdd format',
          required: true,
        },
        {
          key: 'direction',
          name: 'Direction',
          type: 'string',
          description: 'Communication direction',
          required: true,
          options: {
            source: 'direction',
            key: 'key',
            name: 'name',
          },
        },
        {
          key: 'description',
          name: 'Description',
          type: 'string',
          description: 'Description of communication',
          required: true,
        },
      ],
      calculatedFields: [
        {
          key: 'summary',
          template: '{{date}} {{direction.key}} - {{description}}',
        },
        {
          key: 'testCalculatedField',
          template: '{{date}}-{{direction.key}}-{{contact}}-{{description}}',
        },
      ],
      identity: {
        id: '{{contact}}-{{date}}-{{direction.key}}-{{description}}',
        idDocument: '{{contact}}-{{date}}-{{direction.key}}-{{description}}',
        idGroup: '{{contact}}',
      },
      options: {
        direction: [
          {
            key: 'IN',
            name: 'Incoming',
          },
          {
            key: 'OT',
            name: 'Outgoing',
          },
        ],
      },
    },
    documentUiConfig: {
      events: {
        onSubmit: {
          rules: [
            {
              matchFields: { direction: 'OT' },
              workflow: 'OutgoingCommWorkflow',
            },
            {
              matchFields: { direction: 'IN' },
              workflow: 'IncomingCommWorkflow',
            },
          ],
          catchAllWorkflow: 'DefaultCommWorkflow',
        },
      },
    },
    storageContextConfig: {
      folder: '1Admin\\Communication\\\\{{Document.data.contact}}',
      subfolder: 'Archive\\\\{{Document.data.direction.key}}',
    },
    documentWorkflowConfig: {
      workflows: [
        {
          name: 'OutgoingCommWorkflow',
          activitySequence: [
            {
              type: 'LOG_DOCUMENT',
              payload: {
                targetPath: '{{StorageContext.folder}}\\\\{{Document.data.summary}}',
                archivePath: '{{StorageContext.subfolder}}\\\\{{Document.data.testCalculatedField}}',
              },
            },
          ],
        },
        {
          name: 'IncomingCommWorkflow',
          activitySequence: [
            {
              type: 'LOG_DOCUMENT',
              payload: {
                targetPath: '{{StorageContext.folder}}\\\\{{Document.data.summary}}',
                archivePath: '{{StorageContext.subfolder}}\\\\{{Document.data.testCalculatedField}}',
              },
            },
          ],
        },
        {
          name: 'DefaultCommWorkflow',
          activitySequence: [
            {
              type: 'LOG_DOCUMENT',
              payload: {
                targetPath: '{{StorageContext.folder}}\\\\{{Document.data.summary}}',
                archivePath: '{{StorageContext.subfolder}}\\\\{{Document.data.testCalculatedField}}',
              },
            },
          ],
        },
      ],
    },
  };

  beforeEach(async () => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const mockRegistry: DocumentSchemaRegistryPort = {
      loadAll: vi.fn().mockResolvedValue([communicationProjectDocumentType]),
    };

    handlebarsAdapter = new HandlebarsAdapter();
    structuredLogActivity = new StructuredLogActivity();
    activityEngine = new ActivityEngine([structuredLogActivity]);
    documentService = new DocumentService(activityEngine, mockRegistry, handlebarsAdapter);

    await documentService.initialize();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('routes and executes Document 1 (Client - AAA) with option enrichment, identities, calculated fields, and precise path resolution', async () => {
    const document1: Document = {
      type: 'communication-project',
      data: {
        contact: '_Client - AAA',
        date: '260826',
        direction: 'OT',
        description: 'ASR 06 Design Changes',
      },
    };

    const result = await documentService.processDocument(document1, 'onSubmit');

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Asserts identity synthesis and option enrichment from communication-project schema
    expect(result.data).toEqual({
      type: 'communication-project',
      id: '_Client - AAA-260826-OT-ASR 06 Design Changes',
      idDocument: '_Client - AAA-260826-OT-ASR 06 Design Changes',
      idGroup: '_Client - AAA',
      data: {
        contact: '_Client - AAA',
        date: '260826',
        direction: {
          key: 'OT',
          name: 'Outgoing',
        },
        description: 'ASR 06 Design Changes',
        summary: '260826 OT - ASR 06 Design Changes',
        testCalculatedField: '260826-OT-_Client - AAA-ASR 06 Design Changes',
      },
    });

    const expectedPayload = {
      targetPath: '1Admin\\Communication\\_Client - AAA\\260826 OT - ASR 06 Design Changes',
      archivePath: 'Archive\\OT\\260826-OT-_Client - AAA-ASR 06 Design Changes',
    };

    const expectedActivity: Activity = {
      type: 'LOG_DOCUMENT',
      payload: expectedPayload,
    };

    expect(result.activities).toEqual([expectedActivity]);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(expectedPayload));
  });

  it('routes and executes Document 2 (Architect - BBB) with option enrichment, identities, calculated fields, and precise path resolution', async () => {
    const document2: Document = {
      type: 'communication-project',
      data: {
        contact: 'Architect - BBB',
        date: '260715',
        direction: 'IN',
        description: 'CD Comments',
      },
    };

    const result = await documentService.processDocument(document2, 'onSubmit');

    expect(result.success).toBe(true);
    if (!result.success) return;

    // Asserts identity synthesis and option enrichment from communication-project schema
    expect(result.data).toEqual({
      type: 'communication-project',
      id: 'Architect - BBB-260715-IN-CD Comments',
      idDocument: 'Architect - BBB-260715-IN-CD Comments',
      idGroup: 'Architect - BBB',
      data: {
        contact: 'Architect - BBB',
        date: '260715',
        direction: {
          key: 'IN',
          name: 'Incoming',
        },
        description: 'CD Comments',
        summary: '260715 IN - CD Comments',
        testCalculatedField: '260715-IN-Architect - BBB-CD Comments',
      },
    });

    const expectedPayload = {
      targetPath: '1Admin\\Communication\\Architect - BBB\\260715 IN - CD Comments',
      archivePath: 'Archive\\IN\\260715-IN-Architect - BBB-CD Comments',
    };

    const expectedActivity: Activity = {
      type: 'LOG_DOCUMENT',
      payload: expectedPayload,
    };

    expect(result.activities).toEqual([expectedActivity]);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(expectedPayload));
  });
});
