import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RecordService, type RecordType, type Record, type Activity } from '../src/features/record/domain';
import { HandlebarsAdapter } from '../src/infrastructure/template-engine/handlebars-adapter';
import { StructuredLogActivity } from '../src/features/record/adapters/structured-log-activity';
import type { ManifestRegistryPort } from '../src/features/record/ports';

describe('Workflow & Activity End-to-End Hexagonal Integration', () => {
  let recordService: RecordService;
  let handlebarsAdapter: HandlebarsAdapter;
  let structuredLogActivity: StructuredLogActivity;
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  const communicationProjectRecordType: RecordType = {
    key: 'communication-project',
    name: 'Communication Project',
    recordSchema: {
      fields: [
        { key: 'contact', name: 'Contact Person', type: 'string', required: true },
        { key: 'date', name: 'Date', type: 'string', required: true },
        { key: 'direction', name: 'Direction', type: 'string', required: true },
        { key: 'description', name: 'Description', type: 'string', required: true },
      ],
      calculatedFields: [
        { key: 'summary', template: '{{date}} {{direction}} - {{description}}' },
      ],
    },
    recordUiConfig: {
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
      folder: '1Admin\\Communication\\\\{{Record.data.contact}}',
      subfolder: 'Archive\\\\{{Record.data.direction}}',
    },
    recordWorkflowConfig: {
      workflows: [
        {
          name: 'OutgoingCommWorkflow',
          activitySequence: [
            {
              type: 'CREATE_COMMUNICATION',
              payload: {
                targetPath: '{{StorageContext.folder}}\\\\{{Record.data.summary}}',
                archivePath: '{{StorageContext.subfolder}}\\\\{{Record.data.date}}',
              },
            },
          ],
        },
        {
          name: 'IncomingCommWorkflow',
          activitySequence: [
            {
              type: 'CREATE_COMMUNICATION',
              payload: {
                targetPath: '{{StorageContext.folder}}\\\\{{Record.data.summary}}',
                archivePath: '{{StorageContext.subfolder}}\\\\{{Record.data.date}}',
              },
            },
          ],
        },
        {
          name: 'DefaultCommWorkflow',
          activitySequence: [
            {
              type: 'CREATE_COMMUNICATION',
              payload: {
                targetPath: '{{StorageContext.folder}}\\\\{{Record.data.summary}}',
              },
            },
          ],
        },
      ],
    },
  };

  beforeEach(async () => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const mockRegistry: ManifestRegistryPort = {
      loadAll: vi.fn().mockResolvedValue([communicationProjectRecordType]),
    };

    handlebarsAdapter = new HandlebarsAdapter();
    structuredLogActivity = new StructuredLogActivity();
    recordService = new RecordService(structuredLogActivity, mockRegistry, handlebarsAdapter);

    await recordService.initialize();
  });

  afterEach(() => {
    consoleSpy.mockRestore();
  });

  it('routes and executes Record 1 (Client - AAA) with precise nested string path evaluation and structured stdout output', async () => {
    const record1: Record = {
      type: 'communication-project',
      data: {
        contact: '_Client - AAA',
        date: '260826',
        direction: 'OT',
        description: 'ASR 06 Design Changes',
      },
    };

    const result = await recordService.processRecord(record1, 'onSubmit');

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data).toEqual({
      type: 'communication-project',
      data: {
        contact: '_Client - AAA',
        date: '260826',
        direction: 'OT',
        description: 'ASR 06 Design Changes',
        summary: '260826 OT - ASR 06 Design Changes',
      },
    });

    const expectedPayload = {
      targetPath: '1Admin\\Communication\\_Client - AAA\\260826 OT - ASR 06 Design Changes',
      archivePath: 'Archive\\OT\\260826',
    };

    const expectedActivity: Activity = {
      type: 'CREATE_COMMUNICATION',
      payload: expectedPayload,
    };

    expect(result.activities).toEqual([expectedActivity]);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(expectedPayload));
  });

  it('routes and executes Record 2 (Architect - BBB) with precise nested string path evaluation and structured stdout output', async () => {
    const record2: Record = {
      type: 'communication-project',
      data: {
        contact: 'Architect - BBB',
        date: '260715',
        direction: 'IN',
        description: 'CD Comments',
      },
    };

    const result = await recordService.processRecord(record2, 'onSubmit');

    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.data).toEqual({
      type: 'communication-project',
      data: {
        contact: 'Architect - BBB',
        date: '260715',
        direction: 'IN',
        description: 'CD Comments',
        summary: '260715 IN - CD Comments',
      },
    });

    const expectedPayload = {
      targetPath: '1Admin\\Communication\\Architect - BBB\\260715 IN - CD Comments',
      archivePath: 'Archive\\IN\\260715',
    };

    const expectedActivity: Activity = {
      type: 'CREATE_COMMUNICATION',
      payload: expectedPayload,
    };

    expect(result.activities).toEqual([expectedActivity]);
    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(expectedPayload));
  });
});
