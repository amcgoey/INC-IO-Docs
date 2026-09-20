import { describe, it, expect, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  SchemaDrivenUiService,
  UiFieldSchema,
  UiSchema,
  JSONLogicRuleType,
  UiViewHeaderSchema,
  UiViewSectionSchema,
  UiViewWidgetSchema,
  UiViewModel,
  type UiView,
} from './domain';
import type {
  UiManifestPort,
  UiViewAdapterContext,
  UiViewSchemaAdapterPort,
  SelectionState,
} from './ports';

describe('schema-driven-ui domain schemas', () => {
  describe('UiFieldSchema', () => {
    it('validates a standard field schema', () => {
      const field = {
        widget: 'textInput',
        label: 'Subject',
        props: { placeholder: 'Enter subject' },
      };
      expect(Value.Check(UiFieldSchema, field)).toBe(true);
    });

    it('accepts boolean onChange property', () => {
      const field = {
        widget: 'selectionInput',
        label: 'Category',
        onChange: true,
      };
      expect(Value.Check(UiFieldSchema, field)).toBe(true);
    });

    it('accepts string onChange property', () => {
      const field = {
        widget: 'textInput',
        label: 'Dynamic Field',
        onChange: 'onFieldChangedAction',
      };
      expect(Value.Check(UiFieldSchema, field)).toBe(true);
    });

    it('rejects invalid onChange property type', () => {
      const field = {
        widget: 'textInput',
        label: 'Invalid Field',
        onChange: 123,
      };
      expect(Value.Check(UiFieldSchema, field)).toBe(false);
    });

    it('validates JSON Logic rules on showIf, disableIf, and computeValue', () => {
      const rule = { '==': [{ var: 'data.isActive' }, true] };
      expect(Value.Check(JSONLogicRuleType, rule)).toBe(true);

      const field = {
        widget: 'textInput',
        label: 'Calculated Total',
        showIf: rule,
        disableIf: { '!': [{ var: 'data.canEdit' }] },
        computeValue: { '*': [{ var: 'data.qty' }, { var: 'data.rate' }] },
      };
      expect(Value.Check(UiFieldSchema, field)).toBe(true);
    });
  });

  describe('UiSchema', () => {
    it('validates a full UiSchema with layout, fields, events, and evaluationOrder', () => {
      const schema = {
        layout: ['name', 'category'],
        fields: {
          name: { widget: 'textInput', label: 'Full Name' },
          category: { widget: 'selectionInput', label: 'Category', onChange: true },
        },
        events: {
          onSubmit: { catchAllWorkflow: 'SubmitForm' },
        },
        evaluationOrder: ['category', 'name'],
      };
      expect(Value.Check(UiSchema, schema)).toBe(true);
    });

    it('validates minimal empty UiSchema', () => {
      expect(Value.Check(UiSchema, {})).toBe(true);
    });
  });

  describe('UiView abstract models', () => {
    it('validates UiViewHeaderSchema', () => {
      const header = {
        title: 'Test Header',
        subtitle: 'Sub-info',
        imageType: 'SQUARE' as const,
      };
      expect(Value.Check(UiViewHeaderSchema, header)).toBe(true);
    });

    it('validates UiViewSectionSchema and UiViewWidgetSchema', () => {
      const section = {
        header: 'General Details',
        widgets: [
          {
            textParagraph: { text: 'Hello World' },
          },
          {
            textInput: { name: 'title', label: 'Title', value: 'Default' },
          },
          {
            selectionInput: {
              name: 'type',
              label: 'Type',
              items: [{ text: 'Option A', value: 'a' }],
            },
          },
        ],
      };
      expect(Value.Check(UiViewWidgetSchema, section.widgets[0])).toBe(true);
      expect(Value.Check(UiViewSectionSchema, section)).toBe(true);
    });

    it('validates UiViewWidgetSchema with autocomplete on textInput and widget', () => {
      const widgetWithTextInputAutocomplete = {
        textInput: {
          name: 'space',
          label: 'Document Space',
          autocomplete: [{ text: 'Project A', value: 'proj-a' }],
        },
      };
      const widgetWithTopLevelAutocomplete = {
        autocomplete: [{ text: 'Project B', value: 'proj-b' }],
        textInput: {
          name: 'space2',
        },
      };
      expect(Value.Check(UiViewWidgetSchema, widgetWithTextInputAutocomplete)).toBe(true);
      expect(Value.Check(UiViewWidgetSchema, widgetWithTopLevelAutocomplete)).toBe(true);
    });

    it('validates a complete UiViewModel', () => {
      const view = {
        id: 'main-view',
        header: { title: 'Main View' },
        sections: [
          {
            header: 'Section 1',
            widgets: [{ textParagraph: { text: 'Description' } }],
          },
        ],
        evaluationOrder: ['fieldA'],
      };
      expect(Value.Check(UiViewModel, view)).toBe(true);
    });
  });
});

describe('SchemaDrivenUiService (Guarded Read Domain)', () => {
  const mockValidUiSchema: UiSchema = {
    layout: ['fieldName'],
    fields: {
      fieldName: {
        widget: 'textInput',
        label: 'Field Name',
        onChange: true,
      },
    },
    evaluationOrder: ['fieldName'],
  };

  const createMockManifestPort = (overrides?: Partial<UiManifestPort>): UiManifestPort => ({
    getUiSchema: vi.fn().mockResolvedValue(mockValidUiSchema),
    getDocumentSchema: vi.fn().mockResolvedValue({ fields: [{ key: 'fieldName', type: 'string' }] }),
    ...overrides,
  });

  const createMockAdapter = (
    viewId: string,
    outputView?: Partial<UiView>,
    composeFn?: (ctx: UiViewAdapterContext) => Promise<UiView> | UiView
  ): UiViewSchemaAdapterPort => ({
    viewId,
    composeView: composeFn
      ? vi.fn().mockImplementation(composeFn)
      : vi.fn().mockResolvedValue({
          id: viewId,
          header: { title: 'Generated View' },
          sections: [
            {
              widgets: [{ textParagraph: { text: 'Hello' } }],
            },
          ],
          ...outputView,
        }),
  });

  it('rejects initialization with an adapter lacking a viewId', () => {
    const manifestPort = createMockManifestPort();

    expect(
      () => new SchemaDrivenUiService(manifestPort, [{} as unknown as UiViewSchemaAdapterPort])
    ).toThrow(/Cannot register UiViewSchema adapter without a viewId/i);
  });

  it('rejects invalid generateView request with invalid structure', async () => {
    const manifestPort = createMockManifestPort();
    const service = new SchemaDrivenUiService(manifestPort);

    await expect(service.generateView({ viewId: '' })).rejects.toThrow(
      /Invalid GenerateViewRequest/i
    );
  });

  it('rejects generateView if no adapter is registered for viewId', async () => {
    const manifestPort = createMockManifestPort();
    const service = new SchemaDrivenUiService(manifestPort);

    await expect(service.generateView({ viewId: 'unregistered-view' })).rejects.toThrow(
      /UiViewSchema adapter not registered for viewId "unregistered-view"/i
    );
  });

  it('fetches required schemas from manifestPort and orchestrates adapter', async () => {
    const manifestPort = createMockManifestPort();
    const adapter = createMockAdapter('drive-document-process-card');
    const service = new SchemaDrivenUiService(manifestPort, [adapter]);

    const selectionState: SelectionState = {
      spaceTypes: [{ text: 'Projects', value: 'projects' }],
      spaces: ['proj-1'],
      documentTypes: [{ text: 'Proposal', value: 'proposal' }],
    };

    const view = await service.generateView({
      viewId: 'drive-document-process-card',
      documentTypeKey: 'communication-proposal',
      selectionState,
    });

    expect(manifestPort.getUiSchema).toHaveBeenCalledWith('communication-proposal');
    expect(manifestPort.getDocumentSchema).toHaveBeenCalledWith('communication-proposal');

    expect(adapter.composeView).toHaveBeenCalledWith({
      viewId: 'drive-document-process-card',
      documentTypeKey: 'communication-proposal',
      uiSchema: mockValidUiSchema,
      documentSchema: { fields: [{ key: 'fieldName', type: 'string' }] },
      selectionState,
    });

    expect(view.header?.title).toBe('Generated View');
    expect(view.sections).toHaveLength(1);
    expect(Value.Check(UiViewModel, view)).toBe(true);
  });

  it('forwards validationErrors context to adapter for inline error rendering', async () => {
    const manifestPort = createMockManifestPort();
    let receivedContext: UiViewAdapterContext | undefined;
    const adapter = createMockAdapter('error-view', undefined, async (ctx) => {
      receivedContext = ctx;
      return {
        id: ctx.viewId,
        header: { title: 'Error View' },
        sections: [
          {
            widgets: [
              {
                textParagraph: {
                  text: (ctx.validationErrors ?? []).join(', '),
                },
              },
            ],
          },
        ],
      };
    });

    const service = new SchemaDrivenUiService(manifestPort, [adapter]);

    const view = await service.generateView({
      viewId: 'error-view',
      validationErrors: ['Field "amount" is required', 'Invalid date format'],
    });

    expect(receivedContext?.validationErrors).toEqual([
      'Field "amount" is required',
      'Invalid date format',
    ]);
    expect(view.sections[0].widgets[0].textParagraph?.text).toBe(
      'Field "amount" is required, Invalid date format'
    );
  });

  it('fails loudly if UiSchema is not found for requested documentTypeKey', async () => {
    const manifestPort = createMockManifestPort({
      getUiSchema: vi.fn().mockResolvedValue(undefined),
    });
    const adapter = createMockAdapter('test-view');
    const service = new SchemaDrivenUiService(manifestPort, [adapter]);

    await expect(
      service.generateView({
        viewId: 'test-view',
        documentTypeKey: 'missing-doc',
      })
    ).rejects.toThrow(/UiSchema not found for documentTypeKey "missing-doc"/i);

    expect(adapter.composeView).not.toHaveBeenCalled();
  });

  it('fails loudly if fetched UiSchema violates schema invariants', async () => {
    const invalidUiSchema = {
      fields: {
        badField: {
          onChange: 12345, // invalid onChange type
        },
      },
    };

    const manifestPort = createMockManifestPort({
      getUiSchema: vi.fn().mockResolvedValue(invalidUiSchema),
    });

    const adapter = createMockAdapter('bad-schema-view');
    const service = new SchemaDrivenUiService(manifestPort, [adapter]);

    await expect(
      service.generateView({
        viewId: 'bad-schema-view',
        documentTypeKey: 'invalid-doc',
      })
    ).rejects.toThrow(/Invalid UiSchema for documentTypeKey "invalid-doc"/i);

    expect(adapter.composeView).not.toHaveBeenCalled();
  });

  it('guards and rejects when adapter emits invalid UiView structure', async () => {
    const manifestPort = createMockManifestPort();
    const adapter = createMockAdapter('corrupted-view', undefined, async () => {
      return {
        id: 'corrupted',
        sections: 'not-an-array' as unknown as [],
      };
    });

    const service = new SchemaDrivenUiService(manifestPort, [adapter]);

    await expect(
      service.generateView({
        viewId: 'corrupted-view',
      })
    ).rejects.toThrow(/Generated UiView failed validation/i);
  });

  it('allows valid UiView without header and empty sections', async () => {
    const manifestPort = createMockManifestPort();
    const adapter = createMockAdapter('empty-view', undefined, async () => {
      return {
        id: 'empty-view',
        sections: [],
      };
    });

    const service = new SchemaDrivenUiService(manifestPort, [adapter]);
    const view = await service.generateView({
      viewId: 'empty-view',
    });

    expect(view.sections).toEqual([]);
    expect(view.header).toBeUndefined();
  });
});
