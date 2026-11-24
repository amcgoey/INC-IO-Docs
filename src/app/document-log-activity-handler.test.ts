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

  it('canHandle returns true only for WRITE_LOG', () => {
    const mockService: DocumentLogPort = {
      resolveLog: vi.fn(),
      writeLog: vi.fn(),
    };
    const handler = new DocumentLogActivityHandler(mockService);

    expect(handler.canHandle({ type: 'WRITE_LOG', payload: {} })).toBe(true);
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
      { resolveLog: vi.fn(), writeLog },
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
    const handler = new DocumentLogActivityHandler({ resolveLog: vi.fn(), writeLog });

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
    const handler = new DocumentLogActivityHandler({ resolveLog: vi.fn(), writeLog });

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
    const handler = new DocumentLogActivityHandler({ resolveLog: vi.fn(), writeLog });

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
      resolveLog: vi.fn(),
      writeLog: vi.fn().mockRejectedValue(
        new DocumentLogMissingError('Harborview Hotel', '1 Admin')
      ),
    });

    const output = await handler.handle({ type: 'WRITE_LOG', payload: {} }, baseContext);
    expect(output.success).toBe(false);
    expect(output.error).toContain('Harborview Hotel');
    expect(output.error).toContain('1 Admin');
  });
});
