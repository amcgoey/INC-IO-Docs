import { describe, it, expect, vi } from 'vitest';
import { DocumentContentActivityHandler } from './document-content-activity-handler';
import {
  UnsupportedDocumentMimeTypeError,
  type DocumentContentEditorPort,
  type DocumentSchemaRegistryPort,
} from '../ports';
import type { ActivityExecutionContext, DocumentType } from '../domain';
import { HandlebarsAdapter } from '../../../infrastructure/template-engine/handlebars-adapter';

describe('DocumentContentActivityHandler (#378)', () => {
  const handlebars = new HandlebarsAdapter();

  const docType: DocumentType = {
    key: 'submittal-test',
    name: 'Submittal Test',
    documentSchema: {
      fields: [
        { key: 'section', name: 'Section', type: 'string', required: false },
        { key: 'number', name: 'Number', type: 'string', required: false },
        {
          key: 'action',
          name: 'Action',
          type: 'string',
          required: false,
          options: { source: 'actions', key: 'key', name: 'name' },
        },
        { key: 'date', name: 'Date', type: 'string', required: false },
      ],
      options: {
        actions: [
          { key: 'RR', name: 'Revise & Resubmit' },
          { key: 'NET', name: 'No Exceptions Taken' },
        ],
      },
    },
    documentFormSchema: {
      fields: {
        'Submittal No': { template: '{{section}}-{{number}}', writable: true },
        'Submittal Response': {
          template: '{{action.name}}',
          valueMap: {
            RR: 'Revise and Resubmit',
            'No Exceptions Taken': 'NET Rendered Override',
          },
          writable: true,
        },
        Date: { template: '{{date}}', format: 'date', writable: true },
        ReadOnlyField: { template: '{{section}}' },
      },
    },
  };

  const registry: DocumentSchemaRegistryPort = {
    loadAll: vi.fn().mockResolvedValue([docType]),
  };

  function makeContext(overrides?: Partial<ActivityExecutionContext>): ActivityExecutionContext {
    return {
      document: {
        type: 'submittal-test',
        data: {
          section: '071200',
          number: '001',
          action: { key: 'RR', name: 'Revise & Resubmit' },
          date: '261104',
        },
      },
      files: [{ id: 'file-1', name: 'Submittal.pdf', mimeType: 'application/pdf', parentId: 'folder-1', parentName: 'Submittals', uri: 'https://drive/file-1' }],
      stepOutputs: {},
      contextVariables: {},
      ...overrides,
    };
  }

  it('canHandle returns true only for INSERT_DATA', () => {
    const handler = new DocumentContentActivityHandler({
      contentEditor: { insertData: vi.fn() },
      documentSchemaRegistry: registry,
      templateEvaluator: handlebars,
    });
    expect(handler.canHandle({ type: 'INSERT_DATA', payload: {} })).toBe(true);
    expect(handler.canHandle({ type: 'MOVE_FILE', payload: {} })).toBe(false);
    expect(handler.canHandle({ type: 'WRITE_LOG', payload: {} })).toBe(false);
  });

  it('uses valueMap rendered-string fallback when canonical key is absent from valueMap, and rejects invalid non-blank date', async () => {
    const insertData = vi.fn().mockResolvedValue({
      file: { id: 'file-1', name: 'Submittal.pdf', mimeType: 'application/pdf' },
    });
    const handler = new DocumentContentActivityHandler({
      contentEditor: { insertData },
      documentSchemaRegistry: registry,
      templateEvaluator: handlebars,
    });

    const okResult = await handler.handle(
      { id: 'stamp', type: 'INSERT_DATA', payload: {} },
      makeContext({
        document: {
          type: 'submittal-test',
          data: {
            section: '071200',
            number: '001',
            action: { key: 'NET', name: 'No Exceptions Taken' },
            date: '261104',
          },
        },
      })
    );

    expect(okResult.success).toBe(true);
    expect(insertData).toHaveBeenCalledWith({
      targetFileId: 'file-1',
      targetMimeType: 'application/pdf',
      targetFileName: 'Submittal.pdf',
      formData: {
        'Submittal No': '071200-001',
        'Submittal Response': 'NET Rendered Override',
        Date: '2026-11-04',
      },
    });
    expect(okResult.files?.[0]).toEqual({
      id: 'file-1',
      name: 'Submittal.pdf',
      parentId: 'folder-1',
      parentName: 'Submittals',
      mimeType: 'application/pdf',
      uri: 'https://drive/file-1',
    });

    const badDateResult = await handler.handle(
      { id: 'stamp', type: 'INSERT_DATA', payload: {} },
      makeContext({
        document: {
          type: 'submittal-test',
          data: {
            section: '071200',
            number: '001',
            date: 'not-a-date',
          },
        },
      })
    );
    expect(badDateResult.success).toBe(false);
    expect(badDateResult.error).toMatch(/Invalid date value/i);
  });

  it('fails fast when fileSourceStepId references an unexecuted step or zero files, or when fields includes a read-only field', async () => {
    const contentEditor: DocumentContentEditorPort = {
      insertData: vi.fn().mockRejectedValue(
        new UnsupportedDocumentMimeTypeError('Unsupported MIME')
      ),
    };
    const handler = new DocumentContentActivityHandler({
      contentEditor,
      documentSchemaRegistry: registry,
      templateEvaluator: handlebars,
    });

    const missingStepRes = await handler.handle(
      { id: 'stamp', type: 'INSERT_DATA', payload: { fileSourceStepId: 'missingStep' } },
      makeContext()
    );
    expect(missingStepRes.success).toBe(false);
    expect(missingStepRes.error).toMatch(/unexecuted step/i);

    const zeroFilesRes = await handler.handle(
      { id: 'stamp', type: 'INSERT_DATA', payload: { fileSourceStepId: 'prevStep' } },
      makeContext({
        stepOutputs: { prevStep: { success: true, files: [] } },
      })
    );
    expect(zeroFilesRes.success).toBe(false);
    expect(zeroFilesRes.error).toMatch(/zero files/i);

    const readOnlyRes = await handler.handle(
      { id: 'stamp', type: 'INSERT_DATA', payload: { fields: ['ReadOnlyField'] } },
      makeContext()
    );
    expect(readOnlyRes.success).toBe(false);
    expect(readOnlyRes.error).toMatch(/read-only/i);
  });
});
