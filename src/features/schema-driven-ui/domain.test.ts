import { describe, it, expect, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { TypeSystemPolicy } from '@sinclair/typebox/system';
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
  OptionsFetcherPort,
  UiContextQueryPort,
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

    it('validates UiViewWidgetSchema with autocomplete on textInput and rejects root-level autocomplete', () => {
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
      expect(Value.Check(UiViewWidgetSchema, widgetWithTopLevelAutocomplete)).toBe(false);
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

    it('accepts textParagraph.maxLines as a positive integer on UiViewWidgetSchema and UiViewModel', () => {
      const widget = { textParagraph: { text: 'Summary', maxLines: 2 } };
      const view = {
        id: 'view-with-max-lines',
        sections: [
          {
            widgets: [widget],
          },
        ],
      };

      expect(Value.Check(UiViewWidgetSchema, widget)).toBe(true);
      expect(Value.Check(UiViewModel, view)).toBe(true);
    });

    it('accepts undefined or omitted textParagraph.maxLines under ExactOptionalPropertyTypes = true', () => {
      const prev = TypeSystemPolicy.ExactOptionalPropertyTypes;
      TypeSystemPolicy.ExactOptionalPropertyTypes = true;
      try {
        expect(
          Value.Check(UiViewWidgetSchema, {
            textParagraph: { text: 'Summary', maxLines: undefined },
          })
        ).toBe(true);
        expect(
          Value.Check(UiViewWidgetSchema, {
            textParagraph: { text: 'Summary' },
          })
        ).toBe(true);
      } finally {
        TypeSystemPolicy.ExactOptionalPropertyTypes = prev;
      }
    });

    it('rejects invalid textParagraph.maxLines values (0, negative, float, string)', () => {
      expect(Value.Check(UiViewWidgetSchema, { textParagraph: { text: 'Summary', maxLines: 0 } })).toBe(false);
      expect(Value.Check(UiViewWidgetSchema, { textParagraph: { text: 'Summary', maxLines: -1 } })).toBe(false);
      expect(Value.Check(UiViewWidgetSchema, { textParagraph: { text: 'Summary', maxLines: 1.5 } })).toBe(false);
      expect(Value.Check(UiViewWidgetSchema, { textParagraph: { text: 'Summary', maxLines: '2' } })).toBe(false);
    });

    it('accepts buttonList.buttons[] with valid color (with/without alpha) and disabled boolean', () => {
      const widget = {
        buttonList: {
          buttons: [
            {
              text: 'Primary',
              color: { red: 0.1, green: 0.45, blue: 0.91 },
              disabled: false,
            },
            {
              text: 'Translucent Disabled',
              color: { red: 0, green: 1, blue: 0.5, alpha: 0.8 },
              disabled: true,
            },
          ],
        },
      };

      expect(Value.Check(UiViewWidgetSchema, widget)).toBe(true);
      expect(
        Value.Check(UiViewModel, {
          id: 'button-colors-view',
          sections: [{ widgets: [widget] }],
        })
      ).toBe(true);
    });

    it('accepts buttonList.buttons[] optional color, alpha, disabled, and onClick as undefined under ExactOptionalPropertyTypes = true', () => {
      const prev = TypeSystemPolicy.ExactOptionalPropertyTypes;
      TypeSystemPolicy.ExactOptionalPropertyTypes = true;
      try {
        expect(
          Value.Check(UiViewWidgetSchema, {
            buttonList: {
              buttons: [
                {
                  text: 'Alpha Undefined',
                  color: { red: 0.1, green: 0.2, blue: 0.3, alpha: undefined },
                  disabled: undefined,
                  onClick: undefined,
                },
                {
                  text: 'Color Undefined',
                  color: undefined,
                  disabled: undefined,
                  onClick: undefined,
                },
              ],
            },
          })
        ).toBe(true);
      } finally {
        TypeSystemPolicy.ExactOptionalPropertyTypes = prev;
      }
    });

    it('rejects out-of-bounds color channels, missing channel, extra color property, and non-boolean disabled on buttonList.buttons[]', () => {
      const makeButtonWidget = (button: Record<string, unknown>) => ({
        buttonList: { buttons: [button] },
      });

      expect(
        Value.Check(
          UiViewWidgetSchema,
          makeButtonWidget({ text: 'Btn', color: { red: -0.1, green: 0.5, blue: 0.5 } })
        )
      ).toBe(false);
      expect(
        Value.Check(
          UiViewWidgetSchema,
          makeButtonWidget({ text: 'Btn', color: { red: 0.5, green: 1.1, blue: 0.5 } })
        )
      ).toBe(false);
      expect(
        Value.Check(
          UiViewWidgetSchema,
          makeButtonWidget({ text: 'Btn', color: { red: 0.5, green: 0.5, blue: -1 } })
        )
      ).toBe(false);
      expect(
        Value.Check(
          UiViewWidgetSchema,
          makeButtonWidget({ text: 'Btn', color: { red: 0.5, green: 0.5, blue: 0.5, alpha: 1.5 } })
        )
      ).toBe(false);
      expect(
        Value.Check(
          UiViewWidgetSchema,
          makeButtonWidget({ text: 'Btn', color: { red: 0.5, green: 0.5, blue: 0.5, alpha: -0.01 } })
        )
      ).toBe(false);
      expect(
        Value.Check(
          UiViewWidgetSchema,
          makeButtonWidget({ text: 'Btn', color: { red: 0.5, green: 0.5 } })
        )
      ).toBe(false);
      expect(
        Value.Check(
          UiViewWidgetSchema,
          makeButtonWidget({ text: 'Btn', color: { red: 0.5, green: 0.5, blue: 0.5, extra: 1 } })
        )
      ).toBe(false);
      expect(
        Value.Check(UiViewWidgetSchema, makeButtonWidget({ text: 'Btn', disabled: 'true' }))
      ).toBe(false);
    });

    it('accepts buttonList.buttons[].onClick as openLink intent with optional openAs and onClose', () => {
      const widget = {
        buttonList: {
          buttons: [
            {
              text: 'Open Sheet',
              onClick: { openLink: { url: 'https://docs.google.com/spreadsheets/d/123/edit' } },
            },
            {
              text: 'Open Full',
              onClick: {
                openLink: { url: 'https://example.com', openAs: 'FULL_SIZE', onClose: 'NOTHING' },
              },
            },
            {
              text: 'Open Overlay',
              onClick: {
                openLink: { url: 'https://example.com', openAs: 'OVERLAY', onClose: 'RELOAD' },
              },
            },
          ],
        },
      };

      expect(Value.Check(UiViewWidgetSchema, widget)).toBe(true);
      expect(
        Value.Check(UiViewModel, {
          id: 'open-link-view',
          sections: [{ widgets: [widget] }],
        })
      ).toBe(true);
    });

    it('accepts buttonList.buttons[].onClick openLink and action with undefined optional properties under ExactOptionalPropertyTypes = true', () => {
      const prev = TypeSystemPolicy.ExactOptionalPropertyTypes;
      TypeSystemPolicy.ExactOptionalPropertyTypes = true;
      try {
        expect(
          Value.Check(UiViewWidgetSchema, {
            buttonList: {
              buttons: [
                {
                  text: 'Open Link',
                  onClick: {
                    openLink: {
                      url: 'https://example.com',
                      openAs: undefined,
                      onClose: undefined,
                    },
                  },
                },
                {
                  text: 'Submit Action',
                  onClick: {
                    action: 'submit',
                    parameters: undefined,
                  },
                },
              ],
            },
          })
        ).toBe(true);
      } finally {
        TypeSystemPolicy.ExactOptionalPropertyTypes = prev;
      }
    });

    it('rejects malformed openLink and mixed action/openLink values on buttonList.buttons[].onClick', () => {
      const makeOnClickWidget = (onClick: unknown) => ({
        buttonList: { buttons: [{ text: 'Btn', onClick }] },
      });

      expect(
        Value.Check(UiViewWidgetSchema, makeOnClickWidget({ openLink: { url: '' } }))
      ).toBe(false);
      expect(
        Value.Check(
          UiViewWidgetSchema,
          makeOnClickWidget({ openLink: { url: 'https://example.com', openAs: 'POPUP' } })
        )
      ).toBe(false);
      expect(
        Value.Check(
          UiViewWidgetSchema,
          makeOnClickWidget({ openLink: { url: 'https://example.com', onClose: 'CLOSE' } })
        )
      ).toBe(false);
      expect(
        Value.Check(
          UiViewWidgetSchema,
          makeOnClickWidget({ openLink: { url: 'https://example.com', extra: true } })
        )
      ).toBe(false);
      expect(
        Value.Check(
          UiViewWidgetSchema,
          makeOnClickWidget({ openLink: { url: 'https://example.com' }, extra: true })
        )
      ).toBe(false);
      expect(
        Value.Check(
          UiViewWidgetSchema,
          makeOnClickWidget({ action: 'a', openLink: { url: 'https://example.com' } })
        )
      ).toBe(false);
    });

    it('accepts minimal and full decoratedText widgets on UiViewWidgetSchema and UiViewModel', () => {
      const minimalWidget = { decoratedText: { text: '071200-001' } };
      const fullWidgetWithOpenLinkButtonAndActionClick = {
        decoratedText: {
          topLabel: 'Submittal',
          text: '071200-001 Waterproofing',
          wrapText: true,
          bottomLabel: '2026-11-24 • Project Alpha',
          button: {
            text: 'Open',
            color: { red: 0.1, green: 0.45, blue: 0.91, alpha: 1 },
            disabled: false,
            onClick: {
              openLink: {
                url: 'https://docs.google.com/spreadsheets/d/123/edit',
                openAs: 'FULL_SIZE',
                onClose: 'NOTHING',
              },
            },
          },
          onClick: {
            action: 'selectHistoryRow',
            parameters: { rowId: 'row-1' },
          },
        },
      };
      const fullWidgetWithActionButtonAndOpenLinkClick = {
        decoratedText: {
          topLabel: 'RFI',
          text: 'RFI-042',
          wrapText: false,
          bottomLabel: 'Pending review',
          button: {
            text: 'Approve',
            disabled: true,
            onClick: {
              action: 'approveItem',
            },
          },
          onClick: {
            openLink: {
              url: 'https://example.com/rfi/42',
              openAs: 'OVERLAY',
              onClose: 'RELOAD',
            },
          },
        },
      };

      expect(Value.Check(UiViewWidgetSchema, minimalWidget)).toBe(true);
      expect(Value.Check(UiViewWidgetSchema, fullWidgetWithOpenLinkButtonAndActionClick)).toBe(true);
      expect(Value.Check(UiViewWidgetSchema, fullWidgetWithActionButtonAndOpenLinkClick)).toBe(true);
      expect(
        Value.Check(UiViewModel, {
          id: 'decorated-text-view',
          sections: [
            {
              widgets: [
                minimalWidget,
                fullWidgetWithOpenLinkButtonAndActionClick,
                fullWidgetWithActionButtonAndOpenLinkClick,
              ],
            },
          ],
        })
      ).toBe(true);
    });

    it('accepts decoratedText with undefined optional properties under ExactOptionalPropertyTypes = true', () => {
      const prev = TypeSystemPolicy.ExactOptionalPropertyTypes;
      TypeSystemPolicy.ExactOptionalPropertyTypes = true;
      try {
        expect(
          Value.Check(UiViewWidgetSchema, {
            decoratedText: undefined,
            textParagraph: { text: 'Fallback' },
          })
        ).toBe(true);
        expect(
          Value.Check(UiViewWidgetSchema, {
            decoratedText: {
              text: 'Entry',
              topLabel: undefined,
              wrapText: undefined,
              bottomLabel: undefined,
              button: undefined,
              onClick: undefined,
            },
          })
        ).toBe(true);
        expect(
          Value.Check(UiViewWidgetSchema, {
            decoratedText: {
              text: 'Entry With Button',
              button: {
                text: 'Open',
                color: { red: 0.1, green: 0.2, blue: 0.3, alpha: undefined },
                disabled: undefined,
                onClick: {
                  openLink: {
                    url: 'https://example.com',
                    openAs: undefined,
                    onClose: undefined,
                  },
                },
              },
            },
          })
        ).toBe(true);
      } finally {
        TypeSystemPolicy.ExactOptionalPropertyTypes = prev;
      }
    });

    it('rejects columns, divider, Chat-only decoratedText/button fields, invalid button color, and malformed onClick on decoratedText', () => {
      expect(Value.Check(UiViewWidgetSchema, { columns: { columnItems: [] } })).toBe(false);
      expect(Value.Check(UiViewWidgetSchema, { divider: {} })).toBe(false);

      expect(
        Value.Check(UiViewWidgetSchema, {
          decoratedText: { text: 'Entry', startIcon: { knownIcon: 'STAR' } },
        })
      ).toBe(false);
      expect(
        Value.Check(UiViewWidgetSchema, {
          decoratedText: { text: 'Entry', endIcon: { knownIcon: 'STAR' } },
        })
      ).toBe(false);
      expect(
        Value.Check(UiViewWidgetSchema, {
          decoratedText: { text: 'Entry', switchControl: { name: 'sw', value: '1' } },
        })
      ).toBe(false);
      expect(
        Value.Check(UiViewWidgetSchema, {
          decoratedText: { text: 'Entry', contentText: 'legacy' },
        })
      ).toBe(false);

      expect(
        Value.Check(UiViewWidgetSchema, {
          decoratedText: { text: 'Entry', button: { text: 'Btn', type: 'FILLED' } },
        })
      ).toBe(false);
      expect(
        Value.Check(UiViewWidgetSchema, {
          decoratedText: { text: 'Entry', button: { text: 'Btn', icon: { knownIcon: 'STAR' } } },
        })
      ).toBe(false);
      expect(
        Value.Check(UiViewWidgetSchema, {
          decoratedText: {
            text: 'Entry',
            button: { text: 'Btn', color: { red: -0.1, green: 0.5, blue: 0.5 } },
          },
        })
      ).toBe(false);

      expect(
        Value.Check(UiViewWidgetSchema, {
          decoratedText: {
            text: 'Entry',
            button: { text: 'Btn', onClick: { openLink: { url: '' } } },
          },
        })
      ).toBe(false);
      expect(
        Value.Check(UiViewWidgetSchema, {
          decoratedText: {
            text: 'Entry',
            button: {
              text: 'Btn',
              onClick: { action: 'a', openLink: { url: 'https://example.com' } },
            },
          },
        })
      ).toBe(false);
      expect(
        Value.Check(UiViewWidgetSchema, {
          decoratedText: { text: 'Entry', onClick: { openLink: { url: '' } } },
        })
      ).toBe(false);
      expect(
        Value.Check(UiViewWidgetSchema, {
          decoratedText: {
            text: 'Entry',
            onClick: { action: 'a', openLink: { url: 'https://example.com' } },
          },
        })
      ).toBe(false);
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

  it('dispatches queries for fields referencing optionSources to OptionsFetcherPort and populates dynamicOptions in adapterContext', async () => {
    const docSchemaWithDynamic = {
      fields: [
        {
          key: 'contact',
          type: 'string',
          options: {
            source: 'contactFolders',
            key: 'name',
            name: 'name',
            allowUserInput: true,
          },
        },
        {
          key: 'staticField',
          type: 'string',
          options: {
            source: 'staticOptions',
            key: 'val',
            name: 'text',
          },
        },
      ],
      options: {
        staticOptions: [{ val: 's1', text: 'Static 1' }],
      },
      optionSources: {
        contactFolders: {
          provider: 'google_drive',
          method: 'list_folders',
          relativePath: '1 Admin/Communication',
        },
      },
    };

    const manifestPort = createMockManifestPort({
      getDocumentSchema: vi.fn().mockResolvedValue(docSchemaWithDynamic),
    });

    const mockFetcher: OptionsFetcherPort = {
      fetchOptions: vi.fn().mockResolvedValue({
        contactFolders: [
          { text: 'Client A', value: 'Client A' },
          { text: 'Client B', value: 'Client B' },
        ],
      }),
    };

    let capturedContext: UiViewAdapterContext | undefined;
    const adapter = createMockAdapter('dynamic-view', undefined, async (ctx) => {
      capturedContext = ctx;
      return {
        id: 'dynamic-view',
        sections: [],
      };
    });

    const service = new SchemaDrivenUiService(manifestPort, [adapter], mockFetcher);

    await service.generateView({
      viewId: 'dynamic-view',
      documentTypeKey: 'communication-project',
      spaceId: 'space-folder-123',
      formData: { existingField: 'someValue' },
    });

    expect(mockFetcher.fetchOptions).toHaveBeenCalledWith(
      [
        {
          sourceKey: 'contactFolders',
          optionSource: {
            provider: 'google_drive',
            method: 'list_folders',
            relativePath: '1 Admin/Communication',
          },
        },
      ],
      {
        spaceId: 'space-folder-123',
        documentTypeKey: 'communication-project',
        formData: { existingField: 'someValue' },
      }
    );

    expect(capturedContext?.dynamicOptions).toEqual({
      contactFolders: [
        { text: 'Client A', value: 'Client A' },
        { text: 'Client B', value: 'Client B' },
      ],
    });

    // Verify resolvedDocSchema was NOT mutated
    expect(capturedContext?.documentSchema).toEqual(docSchemaWithDynamic);
  });

  it('calls optionsFetcher when spaceId is missing and receives placeholder item', async () => {
    const docSchemaWithDynamic = {
      fields: [
        {
          key: 'contact',
          type: 'string',
          options: {
            source: 'contactFolders',
            key: 'name',
            name: 'name',
            allowUserInput: true,
          },
        },
      ],
      optionSources: {
        contactFolders: {
          provider: 'google_drive',
          method: 'list_folders',
          relativePath: '1 Admin/Communication',
        },
      },
    };

    const manifestPort = createMockManifestPort({
      getDocumentSchema: vi.fn().mockResolvedValue(docSchemaWithDynamic),
    });

    const mockFetcher: OptionsFetcherPort = {
      fetchOptions: vi.fn().mockResolvedValue({
        contactFolders: [{ text: 'Select a Space first', value: '' }],
      }),
    };

    let capturedContext: UiViewAdapterContext | undefined;
    const adapter = createMockAdapter('dynamic-view-missing-space', undefined, async (ctx) => {
      capturedContext = ctx;
      return {
        id: 'dynamic-view-missing-space',
        sections: [],
      };
    });

    const service = new SchemaDrivenUiService(manifestPort, [adapter], mockFetcher);

    await service.generateView({
      viewId: 'dynamic-view-missing-space',
      documentTypeKey: 'communication-project',
    });

    expect(mockFetcher.fetchOptions).toHaveBeenCalledWith(
      [
        {
          sourceKey: 'contactFolders',
          optionSource: {
            provider: 'google_drive',
            method: 'list_folders',
            relativePath: '1 Admin/Communication',
          },
        },
      ],
      {
        documentTypeKey: 'communication-project',
      }
    );

    expect(capturedContext?.dynamicOptions).toEqual({
      contactFolders: [{ text: 'Select a Space first', value: '' }],
    });
  });

  describe('generateView dynamic status resolution and top-of-card statusMessages', () => {
    const multiDynamicDocSchema = {
      fields: [
        {
          key: 'contact',
          type: 'string',
          options: {
            source: 'contactFolders',
          },
        },
        {
          key: 'secondaryContact',
          type: 'string',
          options: {
            source: 'secondaryContactFolders',
          },
        },
        {
          key: 'vendor',
          type: 'string',
          options: {
            source: 'vendorFolders',
          },
        },
        {
          key: 'hiddenDynamic',
          type: 'string',
          options: {
            source: 'hiddenFolders',
          },
        },
      ],
      optionSources: {
        contactFolders: {
          provider: 'google_drive',
          method: 'list_folders',
          relativePath: 'Communications',
        },
        secondaryContactFolders: {
          provider: 'google_drive',
          method: 'list_folders',
          relativePath: 'Communications',
        },
        vendorFolders: {
          provider: 'google_drive',
          method: 'list_folders',
          relativePath: 'Vendors',
        },
        hiddenFolders: {
          provider: 'google_drive',
          method: 'list_folders',
          relativePath: 'HiddenPath',
        },
      },
    };

    const multiDynamicUiSchema = {
      layout: ['contact', 'secondaryContact', 'vendor', 'hiddenDynamic'],
      fields: {},
    };

    it('populates deduplicated statusMessages for visible dynamic fields and skips hiddenFields', async () => {
      const manifestPort = createMockManifestPort({
        getUiSchema: vi.fn().mockResolvedValue(multiDynamicUiSchema),
        getDocumentSchema: vi.fn().mockResolvedValue(multiDynamicDocSchema),
      });

      const mockFetcher: OptionsFetcherPort = {
        fetchOptions: vi.fn().mockResolvedValue({
          contactFolders: {
            status: 'path_not_found',
            items: [],
            targetPath: 'Communications',
          },
          secondaryContactFolders: {
            status: 'path_not_found',
            items: [],
            targetPath: 'Communications',
          },
          vendorFolders: {
            status: 'timeout',
            items: [],
            targetPath: 'Vendors',
          },
          hiddenFolders: {
            status: 'error',
            items: [],
            targetPath: 'HiddenPath',
          },
        }),
      };

      let capturedContext: UiViewAdapterContext | undefined;
      const adapter = createMockAdapter('test-status-view', undefined, async (ctx) => {
        capturedContext = ctx;
        return { id: 'test-status-view', sections: [] };
      });

      const service = new SchemaDrivenUiService(manifestPort, [adapter], mockFetcher);

      await service.generateView({
        viewId: 'test-status-view',
        documentTypeKey: 'multi-dynamic',
        hiddenFields: ['hiddenDynamic'],
        statusMessages: ['Initial system alert'],
      });

      expect(capturedContext?.statusMessages).toEqual([
        'Initial system alert',
        'Folder "Communications" was not found in the selected Document Space.',
        'Timed out loading options from "Vendors".',
      ]);
    });

    it('leaves statusMessages undefined when all dynamic statuses are ready, empty, or missing_space', async () => {
      const manifestPort = createMockManifestPort({
        getUiSchema: vi.fn().mockResolvedValue(multiDynamicUiSchema),
        getDocumentSchema: vi.fn().mockResolvedValue(multiDynamicDocSchema),
      });

      const mockFetcher: OptionsFetcherPort = {
        fetchOptions: vi.fn().mockResolvedValue({
          contactFolders: { status: 'ready', items: [{ text: 'Alice', value: 'Alice' }] },
          secondaryContactFolders: { status: 'empty', items: [] },
          vendorFolders: { status: 'missing_space', items: [] },
        }),
      };

      let capturedContext: UiViewAdapterContext | undefined;
      const adapter = createMockAdapter('test-status-view-clean', undefined, async (ctx) => {
        capturedContext = ctx;
        return { id: 'test-status-view-clean', sections: [] };
      });

      const service = new SchemaDrivenUiService(manifestPort, [adapter], mockFetcher);

      await service.generateView({
        viewId: 'test-status-view-clean',
        documentTypeKey: 'multi-dynamic',
      });

      expect(capturedContext?.statusMessages).toBeUndefined();
    });

    it('formats source-specific statusMessages for document_log missing_log, config_error, and timeout without falling back to "root"', async () => {
      const docLogDocSchema = {
        fields: [
          { key: 'status', type: 'string', options: { source: 'statuses', key: 'key' } },
          { key: 'action', type: 'string', options: { source: 'actions', key: 'key', name: 'name' } },
        ],
        optionSources: {
          statuses: { provider: 'document_log', properties: ['key'] },
          actions: { provider: 'document_log', properties: ['key', 'name', 'suffix', 'order'] },
        },
      };
      const docLogUiSchema = {
        layout: ['status', 'action'],
        fields: {
          status: { widget: 'selectionInput', label: 'Status' },
          action: { widget: 'selectionInput', label: 'Action' },
        },
      };

      const manifestPort = createMockManifestPort({
        getUiSchema: vi.fn().mockResolvedValue(docLogUiSchema),
        getDocumentSchema: vi.fn().mockResolvedValue(docLogDocSchema),
      });

      const mockFetcher: OptionsFetcherPort = {
        fetchOptions: vi
          .fn()
          .mockResolvedValueOnce({
            statuses: { status: 'missing_log', items: [], targetPath: '1 Admin' },
            actions: { status: 'missing_log', items: [], targetPath: '1 Admin' },
          })
          .mockResolvedValueOnce({
            statuses: { status: 'ready', items: [{ text: 'Open', value: 'Open' }] },
            actions: {
              status: 'config_error',
              items: [],
              errorMessage: 'Named range "Options_Submittal_Arch_Actions" not found.',
            },
          })
          .mockResolvedValueOnce({
            statuses: { status: 'timeout', items: [] },
            actions: { status: 'timeout', items: [] },
          }),
      };

      let capturedContext: UiViewAdapterContext | undefined;
      const adapter = createMockAdapter('doc-log-hints', undefined, async (ctx) => {
        capturedContext = ctx;
        return { id: 'doc-log-hints', sections: [] };
      });

      const service = new SchemaDrivenUiService(manifestPort, [adapter], mockFetcher);

      await service.generateView({ viewId: 'doc-log-hints', documentTypeKey: 'submittal-arch' });
      expect(capturedContext?.statusMessages).toEqual([
        'Document Log not found in the selected Document Space. Click Copy Log to create one.',
      ]);

      await service.generateView({ viewId: 'doc-log-hints', documentTypeKey: 'submittal-arch' });
      expect(capturedContext?.statusMessages).toEqual([
        'Document Log option table configuration error for "Action" (actions): Named range "Options_Submittal_Arch_Actions" not found.',
      ]);

      await service.generateView({ viewId: 'doc-log-hints', documentTypeKey: 'submittal-arch' });
      expect(capturedContext?.statusMessages).toEqual([
        'Timed out loading Document Log options for "Status" (statuses).',
        'Timed out loading Document Log options for "Action" (actions).',
      ]);
    });
  });

  describe('generateView UiContextQueryPort integration', () => {
    it('calls uiContextQuery when adapter declares non-empty contextKeys and attaches uiContext to adapterContext', async () => {
      const manifestPort = createMockManifestPort({
        getUiSchema: vi.fn().mockResolvedValue({ layout: ['section'], fields: {} }),
        getDocumentSchema: vi.fn().mockResolvedValue({ fields: [{ key: 'section', type: 'string' }] }),
      });

      const uiContextQuery: UiContextQueryPort = {
        queryContext: vi.fn().mockResolvedValue({
          'document-log': {
            status: 'resolved',
            spaceName: 'Harborview Hotel',
            activeCandidate: {
              name: 'Harborview Hotel Document Log',
              url: 'https://docs.google.com/spreadsheets/d/log-1/edit',
            },
          },
        }),
      };

      let capturedContext: UiViewAdapterContext | undefined;
      const adapter: UiViewSchemaAdapterPort = {
        viewId: 'ctx-view',
        contextKeys: ['document-log'],
        composeView: vi.fn(async (ctx) => {
          capturedContext = ctx;
          return { id: 'ctx-view', sections: [] };
        }),
      };

      const service = new SchemaDrivenUiService(manifestPort, [adapter], undefined, uiContextQuery);
      await service.generateView({
        viewId: 'ctx-view',
        documentTypeKey: 'submittal-arch',
        spaceId: 'space-1',
        formData: { section: '071200' },
      });

      expect(uiContextQuery.queryContext).toHaveBeenCalledTimes(1);
      expect(uiContextQuery.queryContext).toHaveBeenCalledWith(['document-log'], {
        spaceId: 'space-1',
        documentTypeKey: 'submittal-arch',
        formData: { section: '071200' },
      });
      expect(capturedContext?.uiContext).toEqual({
        'document-log': {
          status: 'resolved',
          spaceName: 'Harborview Hotel',
          activeCandidate: {
            name: 'Harborview Hotel Document Log',
            url: 'https://docs.google.com/spreadsheets/d/log-1/edit',
          },
        },
      });
    });

    it('falls back to formData.spaceId and runs even when documentTypeKey is omitted', async () => {
      const manifestPort = createMockManifestPort();
      const uiContextQuery: UiContextQueryPort = {
        queryContext: vi.fn().mockResolvedValue({}),
      };
      const adapter: UiViewSchemaAdapterPort = {
        viewId: 'ctx-view',
        contextKeys: ['document-log'],
        composeView: vi.fn(async () => ({ id: 'ctx-view', sections: [] })),
      };

      const service = new SchemaDrivenUiService(manifestPort, [adapter], undefined, uiContextQuery);
      await service.generateView({
        viewId: 'ctx-view',
        formData: { spaceId: 'space-from-form' },
      });

      expect(uiContextQuery.queryContext).toHaveBeenCalledWith(['document-log'], {
        spaceId: 'space-from-form',
        formData: { spaceId: 'space-from-form' },
      });
    });

    it('skips uiContextQuery when adapter.contextKeys is omitted or empty and fails fast on unknown documentTypeKey', async () => {
      const manifestPort = createMockManifestPort({
        getUiSchema: vi.fn().mockResolvedValue(undefined),
      });
      const uiContextQuery: UiContextQueryPort = {
        queryContext: vi.fn().mockResolvedValue({}),
      };

      const adapterWithoutKeys: UiViewSchemaAdapterPort = {
        viewId: 'no-keys',
        composeView: vi.fn(async () => ({ id: 'no-keys', sections: [] })),
      };
      const adapterWithEmptyKeys: UiViewSchemaAdapterPort = {
        viewId: 'empty-keys',
        contextKeys: [],
        composeView: vi.fn(async () => ({ id: 'empty-keys', sections: [] })),
      };
      const adapterWithKeys: UiViewSchemaAdapterPort = {
        viewId: 'with-keys',
        contextKeys: ['document-log'],
        composeView: vi.fn(async () => ({ id: 'with-keys', sections: [] })),
      };

      const service = new SchemaDrivenUiService(
        manifestPort,
        [adapterWithoutKeys, adapterWithEmptyKeys, adapterWithKeys],
        undefined,
        uiContextQuery
      );

      await service.generateView({ viewId: 'no-keys' });
      await service.generateView({ viewId: 'empty-keys' });
      expect(uiContextQuery.queryContext).not.toHaveBeenCalled();

      await expect(
        service.generateView({ viewId: 'with-keys', documentTypeKey: 'nonexistent' })
      ).rejects.toThrow(/UiSchema not found/i);
      expect(uiContextQuery.queryContext).not.toHaveBeenCalled();
    });
  });
});
