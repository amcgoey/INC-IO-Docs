import { describe, it, expect, vi } from 'vitest';
import { DocumentContentActivityHandler } from './document-content-activity-handler';
import {
  UnsupportedDocumentMimeTypeError,
  type DocumentContentEditorPort,
  type DocumentSchemaRegistryPort,
  type TemplateRegistryPort,
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

  it('canHandle returns true for INSERT_DATA and INSERT_PAGES', () => {
    const handler = new DocumentContentActivityHandler({
      contentEditor: { insertData: vi.fn(), insertPages: vi.fn() },
      documentSchemaRegistry: registry,
      templateEvaluator: handlebars,
    });
    expect(handler.canHandle({ type: 'INSERT_DATA', payload: {} })).toBe(true);
    expect(handler.canHandle({ type: 'INSERT_PAGES', payload: {} })).toBe(true);
    expect(handler.canHandle({ type: 'MOVE_FILE', payload: {} })).toBe(false);
    expect(handler.canHandle({ type: 'WRITE_LOG', payload: {} })).toBe(false);
  });

  it('uses valueMap rendered-string fallback when canonical key is absent from valueMap, and rejects invalid non-blank date', async () => {
    const insertData = vi.fn().mockResolvedValue({
      file: { id: 'file-1', name: 'Submittal.pdf', mimeType: 'application/pdf' },
    });
    const handler = new DocumentContentActivityHandler({
      contentEditor: { insertData, insertPages: vi.fn() },
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
      insertPages: vi.fn(),
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

  describe('INSERT_PAGES (#379)', () => {
    const submittalDocType: DocumentType = {
      key: 'submittal-test',
      name: 'Submittal Test',
      documentSchema: docType.documentSchema,
      documentFormSchema: {
        fields: {
          'Submittal No': { template: '{{section}}-{{number}}', writable: true },
          'Submittal Response': { template: '{{action.name}}' },
          Date: { template: '{{date}}', format: 'date' },
        },
      },
    };
    const submittalRegistry: DocumentSchemaRegistryPort = {
      loadAll: vi.fn().mockResolvedValue([submittalDocType]),
    };

    it('resolves templateKey via TemplateRegistryPort, stamps writable fields with fillForm: true, and returns merged FileLocator without leaking secret IDs', async () => {
      const confidentialTemplateId = 'secret-cover-sheet-drive-id-444';
      const insertPages = vi.fn().mockResolvedValue({
        file: {
          id: 'dup-1',
          name: '_071200-001.pdf',
          mimeType: 'application/pdf',
        },
      });
      const templateRegistry: TemplateRegistryPort = {
        resolveTemplate: vi.fn().mockResolvedValue({
          templateKey: 'submittalCoverSheet',
          fileId: confidentialTemplateId,
          envVarName: 'SUBMITTAL_COVER_SHEET_TEMPLATE_ID',
        }),
        redactSecrets: (msg: string) => msg.split(confidentialTemplateId).join('[REDACTED_TEMPLATE_ID]'),
      };

      const handler = new DocumentContentActivityHandler({
        contentEditor: { insertData: vi.fn(), insertPages },
        documentSchemaRegistry: submittalRegistry,
        templateEvaluator: handlebars,
        templateRegistry,
      });

      const res = await handler.handle(
        {
          id: 'insertCoverSheet',
          type: 'INSERT_PAGES',
          payload: {
            fileSourceStepId: 'duplicateForReview',
            templateKey: 'submittalCoverSheet',
            position: 'start',
            sourcePages: [1],
            fillForm: true,
          },
        },
        makeContext({
          stepOutputs: {
            duplicateForReview: {
              success: true,
              files: [
                {
                  id: 'dup-1',
                  name: '_071200-001.pdf',
                  parentId: 'submittals-folder',
                  parentName: 'Submittals',
                  mimeType: 'application/pdf',
                  uri: 'https://drive/dup-1',
                },
              ],
            },
          },
        })
      );

      expect(res.success).toBe(true);
      expect(templateRegistry.resolveTemplate).toHaveBeenCalledWith('submittalCoverSheet');
      expect(insertPages).toHaveBeenCalledWith({
        targetFileId: 'dup-1',
        targetMimeType: 'application/pdf',
        targetFileName: '_071200-001.pdf',
        sourceFileId: confidentialTemplateId,
        sourceIsTemplate: true,
        position: 'start',
        sourcePages: [1],
        formData: { 'Submittal No': '071200-001' },
      });
      expect(res.files).toEqual([
        {
          id: 'dup-1',
          name: '_071200-001.pdf',
          parentId: 'submittals-folder',
          parentName: 'Submittals',
          mimeType: 'application/pdf',
          uri: 'https://drive/dup-1',
        },
      ]);
      expect(JSON.stringify(res)).not.toContain(confidentialTemplateId);
    });

    it('redacts secret template ID when contentEditor.insertPages throws an error mentioning it', async () => {
      const confidentialTemplateId = 'secret-cover-sheet-drive-id-555';
      const templateRegistry: TemplateRegistryPort = {
        resolveTemplate: vi.fn().mockResolvedValue({
          templateKey: 'submittalCoverSheet',
          fileId: confidentialTemplateId,
        }),
        redactSecrets: (msg: string) => msg.split(confidentialTemplateId).join('[REDACTED_TEMPLATE_ID]'),
      };
      const handler = new DocumentContentActivityHandler({
        contentEditor: {
          insertData: vi.fn(),
          insertPages: vi.fn().mockRejectedValue(
            new Error(`Google Drive error reading ${confidentialTemplateId}`)
          ),
        },
        documentSchemaRegistry: submittalRegistry,
        templateEvaluator: handlebars,
        templateRegistry,
      });

      const res = await handler.handle(
        {
          id: 'insertCoverSheet',
          type: 'INSERT_PAGES',
          payload: {
            templateKey: 'submittalCoverSheet',
          },
        },
        makeContext()
      );

      expect(res.success).toBe(false);
      expect(res.error).not.toContain(confidentialTemplateId);
      expect(res.error).toContain('[REDACTED_TEMPLATE_ID]');
    });

    it('supports sourceStepId referencing an earlier step and fails fast when sourceStepId has zero or multiple files', async () => {
      const insertPages = vi.fn().mockResolvedValue({
        file: { id: 'file-1', name: 'Submittal.pdf', mimeType: 'application/pdf' },
      });
      const handler = new DocumentContentActivityHandler({
        contentEditor: { insertData: vi.fn(), insertPages },
        documentSchemaRegistry: submittalRegistry,
        templateEvaluator: handlebars,
      });

      const okRes = await handler.handle(
        {
          id: 'mergeStep',
          type: 'INSERT_PAGES',
          payload: { sourceStepId: 'coverStep', position: 'end' },
        },
        makeContext({
          stepOutputs: {
            coverStep: {
              success: true,
              files: [{ id: 'cover-1', name: 'Cover.pdf', mimeType: 'application/pdf' }],
            },
          },
        })
      );
      expect(okRes.success).toBe(true);
      expect(insertPages).toHaveBeenCalledWith({
        targetFileId: 'file-1',
        targetMimeType: 'application/pdf',
        targetFileName: 'Submittal.pdf',
        sourceFileId: 'cover-1',
        sourceMimeType: 'application/pdf',
        sourceIsTemplate: false,
        position: 'end',
      });

      const zeroRes = await handler.handle(
        {
          id: 'mergeStep',
          type: 'INSERT_PAGES',
          payload: { sourceStepId: 'coverStep' },
        },
        makeContext({
          stepOutputs: { coverStep: { success: true, files: [] } },
        })
      );
      expect(zeroRes.success).toBe(false);
      expect(zeroRes.error).toMatch(/zero files/i);

      const multiRes = await handler.handle(
        {
          id: 'mergeStep',
          type: 'INSERT_PAGES',
          payload: { sourceStepId: 'coverStep' },
        },
        makeContext({
          stepOutputs: {
            coverStep: {
              success: true,
              files: [
                { id: 'c1', name: 'C1.pdf' },
                { id: 'c2', name: 'C2.pdf' },
              ],
            },
          },
        })
      );
      expect(multiRes.success).toBe(false);
      expect(multiRes.error).toMatch(/single source file|multiple/i);
    });
  });
});
