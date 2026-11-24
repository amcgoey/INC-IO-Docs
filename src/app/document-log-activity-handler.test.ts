import { describe, it, expect, vi } from 'vitest';
import { DocumentLogActivityHandler } from './document-log-activity-handler';
import {
  DocumentLogMissingError,
  type DocumentLogPort,
} from '../features/document-log';
import type { Activity } from '../features/document/domain';
import type { ActivityExecutionContext } from '../features/document/ports';

describe('DocumentLogActivityHandler', () => {
  const baseContext: ActivityExecutionContext = {
    document: {
      id: '071200-001-0-260204-1',
      idDocument: '071200-001-0',
      idGroup: '071200-001',
      type: 'submittal-arch',
      data: {
        status: { key: 'Open' },
        section: '071200',
        number: '001',
        revision: '0',
        title: 'Waterproofing',
        date: '260204',
        contact: { key: 'MB', name: 'Meridian Builders' },
        action: { key: 'REC', name: 'Received', order: '1' },
      },
      space: {
        id: 'space-1',
        typeId: 'projects',
        name: 'Harborview Hotel',
        abstractStorageId: 'drive-1',
      },
    },
    files: [
      {
        id: 'moved-file-1',
        name: 'Submittal.pdf',
        uri: 'https://drive.google.com/file/d/moved-file-1/view',
      },
    ],
    stepOutputs: {},
    contextVariables: {},
  };

  it('canHandle returns true only for WRITE_LOG and READ_LOG', () => {
    const mockService: DocumentLogPort = {
      requiresDocumentLog: vi.fn().mockReturnValue(true),
      resolveLog: vi.fn(),
      copyLog: vi.fn(),
      queryUiContext: vi.fn().mockResolvedValue(undefined),
      readLog: vi.fn(),
      writeLog: vi.fn(),
    };
    const handler = new DocumentLogActivityHandler(mockService);

    expect(handler.canHandle({ type: 'WRITE_LOG', payload: {} })).toBe(true);
    expect(handler.canHandle({ type: 'READ_LOG', payload: {} })).toBe(true);
    expect(handler.canHandle({ type: 'MOVE_FILE', payload: {} })).toBe(false);
  });

  it('uses context.files[0].uri, forwards selectedLogId, and returns documentLogWrite contextVariables', async () => {
    const writeLog = vi.fn().mockResolvedValue({
      spreadsheetId: 'sheet-log-1',
      sheetName: 'Submittal Arch',
      rowNumber: 6,
      action: 'inserted',
    });
    const handler = new DocumentLogActivityHandler(
      {
        requiresDocumentLog: vi.fn().mockReturnValue(true),
        resolveLog: vi.fn(),
        copyLog: vi.fn(),
        queryUiContext: vi.fn().mockResolvedValue(undefined),
        readLog: vi.fn(),
        writeLog,
      },
      { selectedLogId: 'sheet-log-1' }
    );

    const output = await handler.handle(
      { type: 'WRITE_LOG', payload: {} },
      baseContext
    );

    expect(output).toEqual({
      success: true,
      contextVariables: {
        documentLogWrite: {
          spreadsheetId: 'sheet-log-1',
          sheetName: 'Submittal Arch',
          rowNumber: 6,
          action: 'inserted',
        },
      },
    });
    expect(writeLog).toHaveBeenCalledWith({
      document: baseContext.document,
      fileUri: 'https://drive.google.com/file/d/moved-file-1/view',
      selectedLogId: 'sheet-log-1',
    });
  });

  it('selects context.stepOutputs[fileSourceStepId].files[0].uri when fileSourceStepId is specified', async () => {
    const writeLog = vi.fn().mockResolvedValue({
      spreadsheetId: 'sheet-log-2',
      sheetName: 'Submittal Arch',
      rowNumber: 8,
      action: 'inserted',
    });
    const handler = new DocumentLogActivityHandler({
      requiresDocumentLog: vi.fn().mockReturnValue(true),
      resolveLog: vi.fn(),
      copyLog: vi.fn(),
      queryUiContext: vi.fn().mockResolvedValue(undefined),
      readLog: vi.fn(),
      writeLog,
    });

    const contextWithSteps: ActivityExecutionContext = {
      ...baseContext,
      files: [
        { id: 'later-file', name: 'Later.pdf', uri: 'https://drive.google.com/file/d/later/view' },
      ],
      stepOutputs: {
        createPackage: {
          success: true,
          files: [
            {
              id: 'pkg-file',
              name: 'Package.pdf',
              uri: 'https://drive.google.com/file/d/pkg-file/view',
            },
          ],
        },
      },
    };

    const output = await handler.handle(
      { type: 'WRITE_LOG', payload: { fileSourceStepId: 'createPackage' } },
      contextWithSteps
    );

    expect(output.success).toBe(true);
    expect(writeLog).toHaveBeenCalledWith({
      document: baseContext.document,
      fileUri: 'https://drive.google.com/file/d/pkg-file/view',
    });
  });

  it('fails fast when fileSourceStepId references an unexecuted step', async () => {
    const writeLog = vi.fn();
    const handler = new DocumentLogActivityHandler({
      requiresDocumentLog: vi.fn().mockReturnValue(true),
      resolveLog: vi.fn(),
      copyLog: vi.fn(),
      queryUiContext: vi.fn().mockResolvedValue(undefined),
      readLog: vi.fn(),
      writeLog,
    });

    const output = await handler.handle(
      { type: 'WRITE_LOG', payload: { fileSourceStepId: 'missingStep' } },
      baseContext
    );

    expect(output).toEqual({
      success: false,
      error: expect.stringContaining('missingStep'),
    });
    expect(writeLog).not.toHaveBeenCalled();
  });

  it('validates WRITE_LOG payload and rejects unknown keys or invalid fileSourceStepId', async () => {
    const writeLog = vi.fn();
    const handler = new DocumentLogActivityHandler({
      requiresDocumentLog: vi.fn().mockReturnValue(true),
      resolveLog: vi.fn(),
      copyLog: vi.fn(),
      queryUiContext: vi.fn().mockResolvedValue(undefined),
      readLog: vi.fn(),
      writeLog,
    });

    const badPayloads: Activity[] = [
      { type: 'WRITE_LOG', payload: { unexpected: true } },
      { type: 'WRITE_LOG', payload: { fileSourceStepId: '   ' } },
      { type: 'WRITE_LOG', payload: { fileSourceStepId: 42 } },
    ];

    for (const activity of badPayloads) {
      const output = await handler.handle(activity, baseContext);
      expect(output.success).toBe(false);
      expect(output.error).toBeDefined();
    }
    expect(writeLog).not.toHaveBeenCalled();
  });

  it('maps domain/Sheets/Drive errors from writeLog into { success: false, error }', async () => {
    const handler = new DocumentLogActivityHandler({
      requiresDocumentLog: vi.fn().mockReturnValue(true),
      resolveLog: vi.fn(),
      copyLog: vi.fn(),
      queryUiContext: vi.fn().mockResolvedValue(undefined),
      readLog: vi.fn(),
      writeLog: vi.fn().mockRejectedValue(
        new DocumentLogMissingError('Harborview Hotel', '1 Admin')
      ),
    });

    const output = await handler.handle({ type: 'WRITE_LOG', payload: {} }, baseContext);
    expect(output.success).toBe(false);
    expect(output.error).toContain('Harborview Hotel');
    expect(output.error).toContain('1 Admin');
  });

  describe('READ_LOG', () => {
    it('executes full-log READ_LOG with default outputVariable "logEntries", forwards selectedLogId and space, and populates entries, warnings, and documentLogRead metadata', async () => {
      const sampleEntries = [
        {
          rowNumber: 6,
          valid: true,
          fileUri: 'https://drive.google.com/file/d/prior-1/view',
          document: {
            id: '071200-001-0-260204-1',
            idDocument: '071200-001-0',
            idGroup: '071200-001',
            type: 'submittal-arch',
            data: { title: 'Waterproofing' },
          },
        },
      ];
      const sampleWarnings = [
        { rowNumber: 7, field: 'date', message: 'Field "date" is required.' },
      ];
      const readLog = vi.fn().mockResolvedValue({
        spreadsheetId: 'log-sheet-1',
        sheetName: 'Submittal Arch',
        entries: sampleEntries,
        warnings: sampleWarnings,
      });

      const handler = new DocumentLogActivityHandler(
        {
          requiresDocumentLog: vi.fn().mockReturnValue(true),
          resolveLog: vi.fn(),
          copyLog: vi.fn(),
          queryUiContext: vi.fn().mockResolvedValue(undefined),
          readLog,
          writeLog: vi.fn(),
        },
        { selectedLogId: 'log-sheet-1' }
      );

      const output = await handler.handle({ type: 'READ_LOG', payload: {} }, baseContext);

      expect(readLog).toHaveBeenCalledWith({
        documentTypeKey: 'submittal-arch',
        space: baseContext.document.space,
        selectedLogId: 'log-sheet-1',
      });
      expect(output).toEqual({
        success: true,
        contextVariables: {
          logEntries: sampleEntries,
          logEntriesWarnings: sampleWarnings,
          documentLogRead: {
            spreadsheetId: 'log-sheet-1',
            sheetName: 'Submittal Arch',
            entryCount: 1,
            warningCount: 1,
          },
        },
      });
    });

    it('supports filtered READ_LOG and custom outputVariable', async () => {
      const readLog = vi.fn().mockResolvedValue({
        spreadsheetId: 'log-sheet-2',
        sheetName: 'Submittal Arch',
        entries: [],
        warnings: [],
      });

      const handler = new DocumentLogActivityHandler({
        requiresDocumentLog: vi.fn().mockReturnValue(true),
        resolveLog: vi.fn(),
        copyLog: vi.fn(),
        queryUiContext: vi.fn().mockResolvedValue(undefined),
        readLog,
        writeLog: vi.fn(),
      });

      const output = await handler.handle(
        {
          type: 'READ_LOG',
          payload: {
            filterBy: 'idGroup',
            values: ['071200-001'],
            outputVariable: 'priorSubmittals',
          },
        },
        baseContext
      );

      expect(readLog).toHaveBeenCalledWith({
        documentTypeKey: 'submittal-arch',
        space: baseContext.document.space,
        filterBy: 'idGroup',
        values: ['071200-001'],
      });
      expect(output).toEqual({
        success: true,
        contextVariables: {
          priorSubmittals: [],
          priorSubmittalsWarnings: [],
          documentLogRead: {
            spreadsheetId: 'log-sheet-2',
            sheetName: 'Submittal Arch',
            entryCount: 0,
            warningCount: 0,
          },
        },
      });
    });

    it('validates READ_LOG payload (additionalProperties, paired filterBy/values, non-blank outputVariable, reserved names, missing context)', async () => {
      const readLog = vi.fn();
      const handler = new DocumentLogActivityHandler({
        requiresDocumentLog: vi.fn().mockReturnValue(true),
        resolveLog: vi.fn(),
        copyLog: vi.fn(),
        queryUiContext: vi.fn().mockResolvedValue(undefined),
        readLog,
        writeLog: vi.fn(),
      });

      const badActivities: Activity[] = [
        { type: 'READ_LOG', payload: { extraKey: true } },
        { type: 'READ_LOG', payload: { filterBy: 'invalidKey', values: ['x'] } },
        { type: 'READ_LOG', payload: { filterBy: 'idGroup' } },
        { type: 'READ_LOG', payload: { values: ['071200-001'] } },
        { type: 'READ_LOG', payload: { outputVariable: '' } },
        { type: 'READ_LOG', payload: { outputVariable: '   ' } },
        { type: 'READ_LOG', payload: { outputVariable: 'documentLogRead' } },
        { type: 'READ_LOG', payload: { outputVariable: 'documentLogWrite' } },
        { type: 'READ_LOG', payload: { outputVariable: ' documentLogRead ' } },
      ];

      for (const activity of badActivities) {
        const output = await handler.handle(activity, baseContext);
        expect(output.success).toBe(false);
        expect(output.error).toBeDefined();
      }

      const missingContextOutput = await handler.handle({ type: 'READ_LOG', payload: {} });
      expect(missingContextOutput).toEqual({
        success: false,
        error: expect.stringContaining('ActivityExecutionContext'),
      });
      expect(readLog).not.toHaveBeenCalled();
    });

    it('maps errors thrown by readLog into { success: false, error }', async () => {
      const handler = new DocumentLogActivityHandler({
        requiresDocumentLog: vi.fn().mockReturnValue(true),
        resolveLog: vi.fn(),
        copyLog: vi.fn(),
        queryUiContext: vi.fn().mockResolvedValue(undefined),
        readLog: vi.fn().mockRejectedValue(
          new DocumentLogMissingError('Harborview Hotel', '1 Admin')
        ),
        writeLog: vi.fn(),
      });

      const output = await handler.handle({ type: 'READ_LOG', payload: {} }, baseContext);
      expect(output.success).toBe(false);
      expect(output.error).toContain('Harborview Hotel');
    });
  });
});
