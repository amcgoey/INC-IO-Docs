import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  translateUiViewToWorkspaceCard,
  translateUiViewToNavigationAction,
  translateUiViewToUpdateCardAction,
  UiViewSchema,
  UiActionSchema,
  UiOnClickSchema,
} from './translator';
import { GoogleWorkspaceCardSchema, type GoogleWorkspaceAction } from './ui-blocks';

describe('UiView to GoogleWorkspaceCard Translator (Boundary Seams)', () => {
  it('translates a full complex UiView configuration into a valid GoogleWorkspaceCard', () => {
    const complexUiView = {
      id: 'test-complex-view',
      header: {
        title: 'Project Invoice',
        subtitle: 'Process Workspace Item',
        imageUrl: 'https://example.com/logo.png',
        imageType: 'SQUARE',
      },
      sections: [
        {
          header: 'Document Information',
          collapsible: true,
          uncollapsibleWidgetsCount: 1,
          widgets: [
            {
              textParagraph: {
                text: 'Please review the extracted invoice metadata below.',
              },
            },
            {
              textInput: {
                name: 'invoiceNumber',
                label: 'Invoice #',
                hintText: 'e.g. INV-10023',
                value: 'INV-10023',
                onChangeAction: { action: 'onInvoiceNumberChange', route: '/workspace/action' },
              },
            },
            {
              selectionInput: {
                name: 'vendorCategory',
                label: 'Vendor Category',
                type: 'DROPDOWN',
                items: [
                  { text: 'Consulting', value: 'consulting', selected: true },
                  { text: 'Hardware', value: 'hardware' },
                ],
                onChangeAction: {
                  action: 'onVendorCategoryChange',
                  route: '/workspace/action',
                },
              },
            },
            {
              buttonList: {
                buttons: [
                  {
                    text: 'Process Invoice',
                    onClick: {
                      action: 'onProcessInvoice',
                      route: '/workspace/action',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
      evaluationOrder: ['invoiceNumber', 'vendorCategory'],
    };

    const card = translateUiViewToWorkspaceCard(complexUiView);

    expect(Value.Check(GoogleWorkspaceCardSchema, card)).toBe(true);

    expect(card.header).toEqual({
      title: 'Project Invoice',
      subtitle: 'Process Workspace Item',
      imageUrl: 'https://example.com/logo.png',
      imageType: 'SQUARE',
    });

    expect('evaluationOrder' in card).toBe(false);

    expect(card.sections).toHaveLength(1);
    const section = card.sections[0];
    expect(section.header).toBe('Document Information');
    expect(section.collapsible).toBe(true);
    expect(section.uncollapsibleWidgetsCount).toBe(1);

    expect(section.widgets).toHaveLength(4);

    // Widget 1: textParagraph
    expect(section.widgets[0]).toEqual({
      textParagraph: {
        text: 'Please review the extracted invoice metadata below.',
      },
    });

    // Widget 2: textInput with action converted to object
    expect(section.widgets[1]).toEqual({
      textInput: {
        name: 'invoiceNumber',
        label: 'Invoice #',
        hintText: 'e.g. INV-10023',
        value: 'INV-10023',
        onChangeAction: {
          function: '/workspace/action',
          parameters: [{ key: 'action', value: 'onInvoiceNumberChange' }],
          loadIndicator: 'SPINNER',
        },
      },
    });

    // Widget 3: selectionInput with structured action object
    expect(section.widgets[2]).toEqual({
      selectionInput: {
        name: 'vendorCategory',
        label: 'Vendor Category',
        type: 'DROPDOWN',
        items: [
          { text: 'Consulting', value: 'consulting', selected: true },
          { text: 'Hardware', value: 'hardware' },
        ],
        onChangeAction: {
          function: '/workspace/action',
          parameters: [{ key: 'action', value: 'onVendorCategoryChange' }],
          loadIndicator: 'SPINNER',
        },
      },
    });

    // Widget 4: buttonList with normalized onClick action
    expect(section.widgets[3]).toEqual({
      buttonList: {
        buttons: [
          {
            text: 'Process Invoice',
            onClick: {
              action: {
                function: '/workspace/action',
                parameters: [{ key: 'action', value: 'onProcessInvoice' }],
                loadIndicator: 'SPINNER',
              },
            },
          },
        ],
      },
    });
  });

  it('normalizes button onClick to GoogleWorkspaceAction', () => {
    const view = {
      sections: [
        {
          widgets: [
            {
              buttonList: {
                buttons: [
                  {
                    text: 'Submit',
                    onClick: { action: 'handleSubmit', route: '/workspace/action' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    const card = translateUiViewToWorkspaceCard(view);
    expect(card.sections[0].widgets[0].buttonList?.buttons[0].onClick).toEqual({
      action: {
        function: '/workspace/action',
        parameters: [{ key: 'action', value: 'handleSubmit' }],
        loadIndicator: 'SPINNER',
      },
    });
  });

  it('translates action with route property to the specified function', () => {
    const view = {
      sections: [
        {
          widgets: [
            {
              textInput: {
                name: 'amount',
                onChangeAction: { action: 'onFormChange', route: '/workspace/on-form-change' },
              },
            },
          ],
        },
      ],
    };

    const card = translateUiViewToWorkspaceCard(view);
    expect(card.sections[0].widgets[0].textInput?.onChangeAction).toEqual({
      function: '/workspace/on-form-change',
      parameters: [{ key: 'action', value: 'onFormChange' }],
      loadIndicator: 'SPINNER',
    });
  });

  it('rejects action when route is omitted', () => {
    const view = {
      sections: [
        {
          widgets: [
            {
              textInput: {
                name: 'amount',
                onChangeAction: { action: 'customAction' },
              },
            },
          ],
        },
      ],
    };

    expect(() => translateUiViewToWorkspaceCard(view)).toThrow('Invalid UiView');
  });

  it('translates textInput with initialSuggestions', () => {
    const view = {
      sections: [
        {
          widgets: [
            {
              textInput: {
                name: 'spaceSearch',
                label: 'Space',
                initialSuggestions: {
                  items: [{ text: 'DefaultSpace' }, { text: 'OtherSpace' }],
                },
              },
            },
          ],
        },
      ],
    };

    const card = translateUiViewToWorkspaceCard(view);
    expect(card.sections[0].widgets[0].textInput?.initialSuggestions).toEqual({
      items: [{ text: 'DefaultSpace' }, { text: 'OtherSpace' }],
    });
  });

  it('translates textInput with autocomplete to Google initialSuggestions format', () => {
    const view = {
      sections: [
        {
          widgets: [
            {
              textInput: {
                name: 'SelectDocumentSpace',
                label: 'Document Space',
                autocomplete: [
                  { text: 'Project Alpha', value: 'proj-alpha' },
                  { text: 'Project Beta', value: 'proj-beta' },
                ],
              },
            },
          ],
        },
      ],
    };

    const card = translateUiViewToWorkspaceCard(view);
    expect(card.sections[0].widgets[0].textInput?.initialSuggestions).toEqual({
      items: [{ text: 'Project Alpha' }, { text: 'Project Beta' }],
    });
  });

  it('provides default header when UiView has no header', () => {
    const viewWithoutHeader = {
      sections: [
        {
          widgets: [
            {
              textParagraph: { text: 'Section content' },
            },
          ],
        },
      ],
    };

    const card = translateUiViewToWorkspaceCard(viewWithoutHeader);
    expect(Value.Check(GoogleWorkspaceCardSchema, card)).toBe(true);
    expect(card.header).toEqual({
      title: 'INC-IO Engine',
    });
  });

  it('translates minimal widgets with sensible defaults', () => {
    const minimalView = {
      sections: [
        {
          widgets: [
            {
              textInput: {
                name: 'simpleInput',
              },
            },
            {
              selectionInput: {
                name: 'simpleSelection',
              },
            },
            {
              buttonList: {
                buttons: [{ text: 'Cancel' }],
              },
            },
          ],
        },
      ],
    };

    const card = translateUiViewToWorkspaceCard(minimalView);
    expect(Value.Check(GoogleWorkspaceCardSchema, card)).toBe(true);

    const section = card.sections[0];
    expect(section.widgets[0].textInput).toEqual({
      name: 'simpleInput',
    });
    expect(section.widgets[1].selectionInput).toEqual({
      name: 'simpleSelection',
      type: 'DROPDOWN',
      items: [],
    });
    expect(section.widgets[2].buttonList).toEqual({
      buttons: [{ text: 'Cancel' }],
    });
  });

  it('translates UiView directly into a GoogleWorkspaceActionResponse navigation action', () => {
    const view = {
      header: { title: 'Nav Card' },
      sections: [
        {
          widgets: [{ textParagraph: { text: 'Hello' } }],
        },
      ],
    };

    const navAction = translateUiViewToNavigationAction(view);
    expect(navAction.action?.navigations).toBeDefined();
    expect(navAction.action.navigations?.[0]?.pushCard?.header?.title).toBe('Nav Card');
  });

  it('translates abstract UiView to Google Workspace updateCard navigation action', () => {
    const view = {
      header: { title: 'Update Card' },
      sections: [
        {
          widgets: [{ textParagraph: { text: 'Updated content' } }],
        },
      ],
    };

    const updateAction = translateUiViewToUpdateCardAction(view);
    expect(updateAction.action?.navigations).toBeDefined();
    expect(updateAction.action.navigations?.[0]?.updateCard?.header?.title).toBe('Update Card');
  });

  it('throws descriptive error if input is invalid according to AdapterUiViewSchema', () => {
    expect(() => translateUiViewToWorkspaceCard(null)).toThrow('Invalid UiView');
    expect(() => translateUiViewToWorkspaceCard({})).toThrow('Invalid UiView');
    expect(() => translateUiViewToWorkspaceCard({ sections: 'invalid' })).toThrow('Invalid UiView');
    expect(() =>
      translateUiViewToWorkspaceCard({
        sections: [
          {
            widgets: [{ invalidWidgetType: {} }],
          },
        ],
      })
    ).toThrow('Invalid UiView');
  });

  it('throws error when sections array is empty (violating Card requirements at boundary)', () => {
    expect(() =>
      translateUiViewToWorkspaceCard({
        sections: [],
      })
    ).toThrow('Invalid UiView');
  });

  it('rejects section with empty widgets array at boundary', () => {
    expect(() =>
      translateUiViewToWorkspaceCard({
        sections: [
          {
            widgets: [],
          },
        ],
      })
    ).toThrow('Invalid UiView');
  });

  it('rejects empty widget object {} at boundary', () => {
    expect(() =>
      translateUiViewToWorkspaceCard({
        sections: [
          {
            widgets: [{}],
          },
        ],
      })
    ).toThrow('Invalid UiView');
  });

  it('rejects overloaded multi-key widget object at boundary', () => {
    expect(() =>
      translateUiViewToWorkspaceCard({
        sections: [
          {
            widgets: [
              {
                textParagraph: { text: 'Title' },
                textInput: { name: 'email' },
              },
            ],
          },
        ],
      })
    ).toThrow('Invalid UiView');
  });

  it('matches the AdapterUiViewSchema with valid UiView structures', () => {
    const validSample = {
      header: {
        title: 'Title',
        subtitle: 'Sub',
        imageUrl: 'https://example.com/img.png',
        imageType: 'CIRCLE',
      },
      sections: [
        {
          header: 'Sec Header',
          collapsible: false,
          widgets: [
            {
              textParagraph: { text: 'Paragraph' },
            },
          ],
        },
      ],
      evaluationOrder: ['a'],
    };

    expect(Value.Check(UiViewSchema, validSample)).toBe(true);
  });

  it('validates strictly typed action formats and rejects invalid action types', () => {
    const viewWithStructuredAction = {
      sections: [
        {
          widgets: [
            {
              buttonList: {
                buttons: [
                  {
                    text: 'Execute Task',
                    onClick: {
                      action: 'onExecuteTask',
                      route: '/workspace/action',
                      parameters: { taskId: '123' },
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };

    expect(Value.Check(UiViewSchema, viewWithStructuredAction)).toBe(true);
    const card = translateUiViewToWorkspaceCard(viewWithStructuredAction);
    expect(card.sections[0].widgets[0].buttonList?.buttons[0].onClick).toEqual({
      action: {
        function: '/workspace/action',
        parameters: [
          { key: 'action', value: 'onExecuteTask' },
          { key: 'taskId', value: '123' },
        ],
        loadIndicator: 'SPINNER',
      },
    });

    const invalidParametersView = {
      sections: [
        {
          widgets: [
            {
              buttonList: {
                buttons: [
                  {
                    text: 'Execute Task',
                    onClick: {
                      action: 'onExecuteTask',
                      route: '/workspace/action',
                      parameters: { taskId: 123 }, // non-string value violates Defect 1 fix
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    expect(Value.Check(UiViewSchema, invalidParametersView)).toBe(false);
    expect(() => translateUiViewToWorkspaceCard(invalidParametersView)).toThrow('Invalid UiView');

    const invalidActionView = {
      sections: [
        {
          widgets: [
            {
              textInput: {
                name: 'invalidInput',
                onChangeAction: 12345, // invalid type: number
              },
            },
          ],
        },
      ],
    };
    expect(Value.Check(UiViewSchema, invalidActionView)).toBe(false);
    expect(() => translateUiViewToWorkspaceCard(invalidActionView)).toThrow('Invalid UiView');

    const invalidSelectionTypeView = {
      sections: [
        {
          widgets: [
            {
              selectionInput: {
                name: 'invalidSelection',
                type: 'INVALID_TYPE', // must be DROPDOWN, CHECK_BOX, or RADIO_BUTTON
              },
            },
          ],
        },
      ],
    };
    expect(Value.Check(UiViewSchema, invalidSelectionTypeView)).toBe(false);
    expect(() => translateUiViewToWorkspaceCard(invalidSelectionTypeView)).toThrow('Invalid UiView');
  });

  describe('UI Action Translations & Boundary Error Handling (Issue #137)', () => {
    describe('UiActionSchema and UiOnClickSchema Typebox Contracts', () => {
      it('validates and accepts compliant action definitions', () => {
        expect(Value.Check(UiActionSchema, { action: 'submit', route: '/workspace/action' })).toBe(true);
        expect(
          Value.Check(UiActionSchema, {
            action: 'submit',
            route: '/workspace/action',
            parameters: {},
          })
        ).toBe(true);
        expect(
          Value.Check(UiActionSchema, {
            action: 'submit',
            route: '/workspace/action',
            parameters: { id: 'doc-123', mode: 'edit' },
          })
        ).toBe(true);
        // UiOnClickSchema is structurally identical to UiActionSchema
        expect(Value.Check(UiOnClickSchema, { action: 'click', route: '/workspace/action' })).toBe(true);
      });

      it('rejects action missing required action property', () => {
        const missingAction = { route: '/workspace/action' };
        expect(Value.Check(UiActionSchema, missingAction)).toBe(false);
        const errors = [...Value.Errors(UiActionSchema, missingAction)];
        expect(errors.some((e) => e.path === '/action')).toBe(true);
      });

      it('rejects action missing required route property', () => {
        const missingRoute = { action: 'onClick' };
        expect(Value.Check(UiActionSchema, missingRoute)).toBe(false);
        const errors = [...Value.Errors(UiActionSchema, missingRoute)];
        expect(errors.some((e) => e.path === '/route')).toBe(true);
      });

      it('rejects non-string action values', () => {
        expect(Value.Check(UiActionSchema, { action: 123, route: '/workspace/action' })).toBe(false);
        expect(Value.Check(UiActionSchema, { action: true, route: '/workspace/action' })).toBe(false);
        expect(Value.Check(UiActionSchema, { action: null, route: '/workspace/action' })).toBe(false);
        expect(Value.Check(UiActionSchema, { action: {}, route: '/workspace/action' })).toBe(false);
        expect(Value.Check(UiActionSchema, { action: ['click'], route: '/workspace/action' })).toBe(false);
      });

      it('rejects non-string route values', () => {
        expect(Value.Check(UiActionSchema, { action: 'click', route: 404 })).toBe(false);
        expect(Value.Check(UiActionSchema, { action: 'click', route: false })).toBe(false);
        expect(Value.Check(UiActionSchema, { action: 'click', route: null })).toBe(false);
        expect(Value.Check(UiActionSchema, { action: 'click', route: { path: '/test' } })).toBe(false);
      });

      it('rejects extraneous properties due to additionalProperties: false', () => {
        const extraPropAction = {
          action: 'submit',
          route: '/workspace/action',
          unknownField: 'unexpected',
        };
        expect(Value.Check(UiActionSchema, extraPropAction)).toBe(false);
        const errors = [...Value.Errors(UiActionSchema, extraPropAction)];
        expect(errors.some((e) => e.path === '/unknownField' && e.message.includes('Unexpected property'))).toBe(true);
      });

      it('rejects non-object parameters', () => {
        expect(
          Value.Check(UiActionSchema, { action: 'a', route: 'r', parameters: 'invalid-string' })
        ).toBe(false);
        expect(
          Value.Check(UiActionSchema, { action: 'a', route: 'r', parameters: 42 })
        ).toBe(false);
        expect(
          Value.Check(UiActionSchema, { action: 'a', route: 'r', parameters: true })
        ).toBe(false);
        expect(
          Value.Check(UiActionSchema, { action: 'a', route: 'r', parameters: null })
        ).toBe(false);
        expect(
          Value.Check(UiActionSchema, { action: 'a', route: 'r', parameters: ['array'] })
        ).toBe(false);
      });

      it('rejects non-string values within parameters record', () => {
        expect(
          Value.Check(UiActionSchema, {
            action: 'a',
            route: 'r',
            parameters: { num: 123 },
          })
        ).toBe(false);
        expect(
          Value.Check(UiActionSchema, {
            action: 'a',
            route: 'r',
            parameters: { bool: true },
          })
        ).toBe(false);
        expect(
          Value.Check(UiActionSchema, {
            action: 'a',
            route: 'r',
            parameters: { nil: null },
          })
        ).toBe(false);
        expect(
          Value.Check(UiActionSchema, {
            action: 'a',
            route: 'r',
            parameters: { nested: { key: 'val' } },
          })
        ).toBe(false);
        expect(
          Value.Check(UiActionSchema, {
            action: 'a',
            route: 'r',
            parameters: { list: ['a', 'b'] },
          })
        ).toBe(false);
      });
    });

    describe('Malformed UI Actions in TextInput Widgets', () => {
      const createTextInputView = (onChangeAction: unknown) => ({
        sections: [
          {
            widgets: [
              {
                textInput: {
                  name: 'testInput',
                  onChangeAction,
                },
              },
            ],
          },
        ],
      });

      it('rejects primitive values for textInput onChangeAction', () => {
        expect(() => translateUiViewToWorkspaceCard(createTextInputView('onTextChange'))).toThrow(
          'Invalid UiView'
        );
        expect(() => translateUiViewToWorkspaceCard(createTextInputView(12345))).toThrow(
          'Invalid UiView'
        );
        expect(() => translateUiViewToWorkspaceCard(createTextInputView(true))).toThrow(
          'Invalid UiView'
        );
      });

      it('rejects null or array for textInput onChangeAction', () => {
        expect(() => translateUiViewToWorkspaceCard(createTextInputView(null))).toThrow(
          'Invalid UiView'
        );
        expect(() => translateUiViewToWorkspaceCard(createTextInputView([]))).toThrow(
          'Invalid UiView'
        );
      });

      it('rejects textInput onChangeAction missing required action or route', () => {
        expect(() =>
          translateUiViewToWorkspaceCard(createTextInputView({ route: '/workspace/action' }))
        ).toThrow('Invalid UiView');
        expect(() =>
          translateUiViewToWorkspaceCard(createTextInputView({ action: 'onTextChange' }))
        ).toThrow('Invalid UiView');
      });

      it('rejects textInput onChangeAction with extraneous properties', () => {
        expect(() =>
          translateUiViewToWorkspaceCard(
            createTextInputView({
              action: 'onTextChange',
              route: '/workspace/action',
              extraProperty: 'disallowed',
            })
          )
        ).toThrow('Invalid UiView');
      });

      it('rejects textInput onChangeAction with non-string parameter values', () => {
        expect(() =>
          translateUiViewToWorkspaceCard(
            createTextInputView({
              action: 'onTextChange',
              route: '/workspace/action',
              parameters: { count: 10, isValid: false },
            })
          )
        ).toThrow('Invalid UiView');
      });

      it('rejects textInput onChangeAction with non-object parameters', () => {
        expect(() =>
          translateUiViewToWorkspaceCard(
            createTextInputView({
              action: 'onTextChange',
              route: '/workspace/action',
              parameters: 'invalid-parameters-string',
            })
          )
        ).toThrow('Invalid UiView');
      });
    });

    describe('Malformed UI Actions in SelectionInput Widgets', () => {
      const createSelectionInputView = (onChangeAction: unknown) => ({
        sections: [
          {
            widgets: [
              {
                selectionInput: {
                  name: 'testSelection',
                  type: 'DROPDOWN',
                  items: [{ text: 'Item 1', value: 'item-1' }],
                  onChangeAction,
                },
              },
            ],
          },
        ],
      });

      it('rejects primitive values for selectionInput onChangeAction', () => {
        expect(() => translateUiViewToWorkspaceCard(createSelectionInputView('onSelectChange'))).toThrow(
          'Invalid UiView'
        );
        expect(() => translateUiViewToWorkspaceCard(createSelectionInputView(999))).toThrow(
          'Invalid UiView'
        );
        expect(() => translateUiViewToWorkspaceCard(createSelectionInputView(false))).toThrow(
          'Invalid UiView'
        );
      });

      it('rejects null or array for selectionInput onChangeAction', () => {
        expect(() => translateUiViewToWorkspaceCard(createSelectionInputView(null))).toThrow(
          'Invalid UiView'
        );
        expect(() => translateUiViewToWorkspaceCard(createSelectionInputView([]))).toThrow(
          'Invalid UiView'
        );
      });

      it('rejects selectionInput onChangeAction missing required action or route', () => {
        expect(() =>
          translateUiViewToWorkspaceCard(createSelectionInputView({ route: '/workspace/action' }))
        ).toThrow('Invalid UiView');
        expect(() =>
          translateUiViewToWorkspaceCard(createSelectionInputView({ action: 'onSelectChange' }))
        ).toThrow('Invalid UiView');
      });

      it('rejects selectionInput onChangeAction with extraneous properties', () => {
        expect(() =>
          translateUiViewToWorkspaceCard(
            createSelectionInputView({
              action: 'onSelectChange',
              route: '/workspace/action',
              unknownFlag: 1,
            })
          )
        ).toThrow('Invalid UiView');
      });

      it('rejects selectionInput onChangeAction with non-string parameter values', () => {
        expect(() =>
          translateUiViewToWorkspaceCard(
            createSelectionInputView({
              action: 'onSelectChange',
              route: '/workspace/action',
              parameters: { complex: { a: 1 } },
            })
          )
        ).toThrow('Invalid UiView');
      });
    });

    describe('Malformed UI Actions in ButtonList Widgets', () => {
      const createButtonListView = (onClick: unknown) => ({
        sections: [
          {
            widgets: [
              {
                buttonList: {
                  buttons: [
                    {
                      text: 'Click Me',
                      onClick,
                    },
                  ],
                },
              },
            ],
          },
        ],
      });

      it('rejects primitive string action name for button onClick', () => {
        expect(() => translateUiViewToWorkspaceCard(createButtonListView('handleClick'))).toThrow(
          'Invalid UiView'
        );
      });

      it('rejects primitive number or boolean for button onClick', () => {
        expect(() => translateUiViewToWorkspaceCard(createButtonListView(1))).toThrow(
          'Invalid UiView'
        );
        expect(() => translateUiViewToWorkspaceCard(createButtonListView(true))).toThrow(
          'Invalid UiView'
        );
      });

      it('rejects null or array for button onClick', () => {
        expect(() => translateUiViewToWorkspaceCard(createButtonListView(null))).toThrow(
          'Invalid UiView'
        );
        expect(() => translateUiViewToWorkspaceCard(createButtonListView([]))).toThrow(
          'Invalid UiView'
        );
      });

      it('rejects button onClick missing action or route', () => {
        expect(() =>
          translateUiViewToWorkspaceCard(createButtonListView({ route: '/workspace/action' }))
        ).toThrow('Invalid UiView');
        expect(() =>
          translateUiViewToWorkspaceCard(createButtonListView({ action: 'onButtonClick' }))
        ).toThrow('Invalid UiView');
      });

      it('rejects button onClick with extraneous properties', () => {
        expect(() =>
          translateUiViewToWorkspaceCard(
            createButtonListView({
              action: 'onButtonClick',
              route: '/workspace/action',
              debounceMs: 300,
            })
          )
        ).toThrow('Invalid UiView');
      });

      it('rejects button onClick with non-string parameter values', () => {
        expect(() =>
          translateUiViewToWorkspaceCard(
            createButtonListView({
              action: 'onButtonClick',
              route: '/workspace/action',
              parameters: { ids: [1, 2, 3] },
            })
          )
        ).toThrow('Invalid UiView');
      });
    });

    describe('Graceful Handling and Normalization of Action Edge Cases', () => {
      it('safely ignores duplicate parameter key named "action" and preserves primary action value', () => {
        const viewWithDuplicateActionParam = {
          sections: [
            {
              widgets: [
                {
                  buttonList: {
                    buttons: [
                      {
                        text: 'Test Duplicate Action Key',
                        onClick: {
                          action: 'primaryActionName',
                          route: '/workspace/action',
                          parameters: {
                            action: 'attemptedOverrideValue',
                            docId: 'doc-789',
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        };

        const card = translateUiViewToWorkspaceCard(viewWithDuplicateActionParam);
        const button = card.sections[0].widgets[0].buttonList?.buttons[0];
        const onClick = button?.onClick as { action?: GoogleWorkspaceAction } | undefined;
        const actionObj = onClick?.action;

        expect(actionObj?.function).toBe('/workspace/action');
        // Must contain primaryActionName and not be overwritten or duplicated
        expect(actionObj?.parameters).toEqual([
          { key: 'action', value: 'primaryActionName' },
          { key: 'docId', value: 'doc-789' },
        ]);
        const actionParams = actionObj?.parameters?.filter(
          (p: { key: string; value: string }) => p.key === 'action'
        );
        expect(actionParams).toHaveLength(1);
        expect(actionParams?.[0].value).toBe('primaryActionName');
      });

      it('gracefully normalizes action with empty parameters object', () => {
        const view = {
          sections: [
            {
              widgets: [
                {
                  textInput: {
                    name: 'username',
                    onChangeAction: {
                      action: 'validateUser',
                      route: '/workspace/action',
                      parameters: {},
                    },
                  },
                },
              ],
            },
          ],
        };

        const card = translateUiViewToWorkspaceCard(view);
        expect(card.sections[0].widgets[0].textInput?.onChangeAction).toEqual({
          function: '/workspace/action',
          parameters: [{ key: 'action', value: 'validateUser' }],
          loadIndicator: 'SPINNER',
        });
      });

      it('gracefully handles parameter with empty string value without omitting or throwing', () => {
        const view = {
          sections: [
            {
              widgets: [
                {
                  textInput: {
                    name: 'filter',
                    onChangeAction: {
                      action: 'applyFilter',
                      route: '/workspace/action',
                      parameters: { query: '' },
                    },
                  },
                },
              ],
            },
          ],
        };

        const card = translateUiViewToWorkspaceCard(view);
        expect(card.sections[0].widgets[0].textInput?.onChangeAction?.parameters).toEqual([
          { key: 'action', value: 'applyFilter' },
          { key: 'query', value: '' },
        ]);
      });

      it('gracefully handles parameters containing spaces, colons, unicode, and serialized JSON strings', () => {
        const view = {
          sections: [
            {
              widgets: [
                {
                  buttonList: {
                    buttons: [
                      {
                        text: 'Submit Complex',
                        onClick: {
                          action: 'processComplex',
                          route: '/workspace/complex',
                          parameters: {
                            'colon:key': 'value with spaces & symbols (#@!)',
                            unicode: 'こんにちは世界 🚀',
                            serializedJson: JSON.stringify({ nested: true, count: 42 }),
                          },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        };

        const card = translateUiViewToWorkspaceCard(view);
        const buttonOnClick = card.sections[0].widgets[0].buttonList?.buttons[0].onClick as
          | { action?: GoogleWorkspaceAction }
          | undefined;
        const params = buttonOnClick?.action?.parameters;
        expect(params).toEqual(
          expect.arrayContaining([
            { key: 'action', value: 'processComplex' },
            { key: 'colon:key', value: 'value with spaces & symbols (#@!)' },
            { key: 'unicode', value: 'こんにちは世界 🚀' },
            { key: 'serializedJson', value: '{"nested":true,"count":42}' },
          ])
        );
      });

      it('gracefully translates widgets when actions are omitted', () => {
        const viewWithoutActions = {
          sections: [
            {
              widgets: [
                {
                  textInput: {
                    name: 'nameOnly',
                  },
                },
                {
                  selectionInput: {
                    name: 'selectionOnly',
                    items: [{ text: 'Opt', value: 'opt' }],
                  },
                },
                {
                  buttonList: {
                    buttons: [{ text: 'Button Without OnClick' }],
                  },
                },
              ],
            },
          ],
        };

        const card = translateUiViewToWorkspaceCard(viewWithoutActions);
        const widgets = card.sections[0].widgets;

        expect(widgets[0].textInput?.onChangeAction).toBeUndefined();
        expect(widgets[1].selectionInput?.onChangeAction).toBeUndefined();
        expect(widgets[2].buttonList?.buttons[0].onClick).toBeUndefined();
      });

      it('translates multiple distinct actions across different widgets and sections cleanly', () => {
        const multiActionView = {
          sections: [
            {
              header: 'Section 1',
              widgets: [
                {
                  textInput: {
                    name: 'input1',
                    onChangeAction: { action: 'act1', route: '/workspace/route1' },
                  },
                },
              ],
            },
            {
              header: 'Section 2',
              widgets: [
                {
                  selectionInput: {
                    name: 'select2',
                    onChangeAction: {
                      action: 'act2',
                      route: '/workspace/route2',
                      parameters: { p: 'v' },
                    },
                  },
                },
                {
                  buttonList: {
                    buttons: [
                      {
                        text: 'Btn3',
                        onClick: { action: 'act3', route: '/workspace/route3' },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        };

        const card = translateUiViewToWorkspaceCard(multiActionView);
        expect(card.sections[0].widgets[0].textInput?.onChangeAction?.function).toBe(
          '/workspace/route1'
        );
        expect(card.sections[1].widgets[0].selectionInput?.onChangeAction?.function).toBe(
          '/workspace/route2'
        );
        const buttonOnClick = card.sections[1].widgets[1].buttonList?.buttons[0].onClick as
          | { action?: GoogleWorkspaceAction }
          | undefined;
        expect(buttonOnClick?.action?.function).toBe('/workspace/route3');
      });
    });

    describe('Navigation Action & UpdateCard Action Graceful Degradation', () => {
      const malformedActionView = {
        sections: [
          {
            widgets: [
              {
                textInput: {
                  name: 'brokenInput',
                  onChangeAction: { invalidActionSchema: true },
                },
              },
            ],
          },
        ],
      };

      it('translateUiViewToNavigationAction fails gracefully with descriptive error on malformed UI actions', () => {
        expect(() => translateUiViewToNavigationAction(malformedActionView)).toThrow(
          'Invalid UiView'
        );
      });

      it('translateUiViewToUpdateCardAction fails gracefully with descriptive error on malformed UI actions', () => {
        expect(() => translateUiViewToUpdateCardAction(malformedActionView)).toThrow(
          'Invalid UiView'
        );
      });

      it('translateUiViewToNavigationAction fails gracefully with descriptive error on unexpected top-level inputs', () => {
        expect(() => translateUiViewToNavigationAction(null)).toThrow('Invalid UiView');
        expect(() => translateUiViewToNavigationAction(undefined)).toThrow('Invalid UiView');
        expect(() => translateUiViewToNavigationAction(12345)).toThrow('Invalid UiView');
        expect(() => translateUiViewToNavigationAction('plain-string')).toThrow('Invalid UiView');
        expect(() => translateUiViewToNavigationAction([])).toThrow('Invalid UiView');
        expect(() => translateUiViewToNavigationAction({})).toThrow('Invalid UiView');
        expect(() => translateUiViewToNavigationAction({ sections: [] })).toThrow('Invalid UiView');
      });

      it('translateUiViewToUpdateCardAction fails gracefully with descriptive error on unexpected top-level inputs', () => {
        expect(() => translateUiViewToUpdateCardAction(null)).toThrow('Invalid UiView');
        expect(() => translateUiViewToUpdateCardAction(undefined)).toThrow('Invalid UiView');
        expect(() => translateUiViewToUpdateCardAction(12345)).toThrow('Invalid UiView');
        expect(() => translateUiViewToUpdateCardAction('plain-string')).toThrow('Invalid UiView');
        expect(() => translateUiViewToUpdateCardAction([])).toThrow('Invalid UiView');
        expect(() => translateUiViewToUpdateCardAction({})).toThrow('Invalid UiView');
        expect(() => translateUiViewToUpdateCardAction({ sections: [] })).toThrow('Invalid UiView');
      });

      it('translateUiViewToNavigationAction translates valid actions into pushCard response', () => {
        const validView = {
          header: { title: 'Test Navigation' },
          sections: [
            {
              widgets: [
                {
                  buttonList: {
                    buttons: [
                      {
                        text: 'Go',
                        onClick: {
                          action: 'navigateAction',
                          route: '/workspace/action',
                          parameters: { step: '2' },
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        };

        const navResponse = translateUiViewToNavigationAction(validView);
        expect(navResponse.action?.navigations).toHaveLength(1);
        const pushCard = navResponse.action?.navigations?.[0]?.pushCard;
        expect(pushCard).toBeDefined();
        expect(pushCard?.header?.title).toBe('Test Navigation');
        const button = pushCard?.sections[0].widgets[0].buttonList?.buttons[0];
        const buttonOnClick = button?.onClick as { action?: GoogleWorkspaceAction } | undefined;
        expect(buttonOnClick?.action?.function).toBe('/workspace/action');
        expect(buttonOnClick?.action?.parameters).toEqual([
          { key: 'action', value: 'navigateAction' },
          { key: 'step', value: '2' },
        ]);
      });

      it('translateUiViewToUpdateCardAction translates valid actions into updateCard response', () => {
        const validView = {
          header: { title: 'Test Update' },
          sections: [
            {
              widgets: [
                {
                  textInput: {
                    name: 'field',
                    onChangeAction: {
                      action: 'updateField',
                      route: '/workspace/on-form-change',
                    },
                  },
                },
              ],
            },
          ],
        };

        const updateResponse = translateUiViewToUpdateCardAction(validView);
        expect(updateResponse.action?.navigations).toHaveLength(1);
        const updateCard = updateResponse.action?.navigations?.[0]?.updateCard;
        expect(updateCard).toBeDefined();
        expect(updateCard?.header?.title).toBe('Test Update');
        expect(updateCard?.sections[0].widgets[0].textInput?.onChangeAction).toEqual({
          function: '/workspace/on-form-change',
          parameters: [{ key: 'action', value: 'updateField' }],
          loadIndicator: 'SPINNER',
        });
      });

      it('translates CHECK_BOX and RADIO_BUTTON selection inputs with onChangeAction and rejects malformed actions', () => {
        const checkboxView = {
          sections: [
            {
              widgets: [
                {
                  selectionInput: {
                    name: 'optIn',
                    type: 'CHECK_BOX',
                    items: [{ text: 'Yes', value: 'yes', selected: false }],
                    onChangeAction: {
                      action: 'onCheckboxToggle',
                      route: '/workspace/on-form-change',
                      parameters: { target: 'notifications' },
                    },
                  },
                },
                {
                  selectionInput: {
                    name: 'priority',
                    type: 'RADIO_BUTTON',
                    items: [{ text: 'High', value: 'high' }, { text: 'Low', value: 'low' }],
                    onChangeAction: {
                      action: 'onPriorityChange',
                      route: '/workspace/on-form-change',
                    },
                  },
                },
              ],
            },
          ],
        };

        const card = translateUiViewToWorkspaceCard(checkboxView);
        const widgets = card.sections[0].widgets;

        expect(widgets[0].selectionInput?.type).toBe('CHECK_BOX');
        expect(widgets[0].selectionInput?.onChangeAction).toEqual({
          function: '/workspace/on-form-change',
          parameters: [
            { key: 'action', value: 'onCheckboxToggle' },
            { key: 'target', value: 'notifications' },
          ],
          loadIndicator: 'SPINNER',
        });

        expect(widgets[1].selectionInput?.type).toBe('RADIO_BUTTON');
        expect(widgets[1].selectionInput?.onChangeAction).toEqual({
          function: '/workspace/on-form-change',
          parameters: [{ key: 'action', value: 'onPriorityChange' }],
          loadIndicator: 'SPINNER',
        });

        // Malformed checkbox action rejected
        const brokenCheckboxView = {
          sections: [
            {
              widgets: [
                {
                  selectionInput: {
                    name: 'optIn',
                    type: 'CHECK_BOX',
                    items: [{ text: 'Yes', value: 'yes' }],
                    onChangeAction: { action: 'onToggle' }, // missing route
                  },
                },
              ],
            },
          ],
        };
        expect(() => translateUiViewToWorkspaceCard(brokenCheckboxView)).toThrow('Invalid UiView');
      });

      it('rejects buttonList when any button has a malformed onClick action', () => {
        const mixedButtonsView = {
          sections: [
            {
              widgets: [
                {
                  buttonList: {
                    buttons: [
                      {
                        text: 'Valid Button',
                        onClick: { action: 'valid', route: '/workspace/action' },
                      },
                      {
                        text: 'Malformed Button',
                        onClick: { action: 'invalid' }, // missing route
                      },
                    ],
                  },
                },
              ],
            },
          ],
        };

        expect(() => translateUiViewToWorkspaceCard(mixedButtonsView)).toThrow('Invalid UiView');
      });
    });

    describe('Action Route Rendering (Pure Dumb Renderer Contract)', () => {
      it('uses action.route directly as function name when relative path is provided', () => {
        const view = {
          sections: [
            {
              widgets: [
                {
                  textInput: {
                    name: 'testInput',
                    onChangeAction: { action: 'onTextChange', route: '/workspace/on-form-change' },
                  },
                },
              ],
            },
          ],
        };

        const card = translateUiViewToWorkspaceCard(view);
        expect(card.sections[0].widgets[0].textInput?.onChangeAction?.function).toBe(
          '/workspace/on-form-change'
        );
      });

      it('uses action.route directly as function name when pre-resolved fully-qualified HTTPS URL is provided', () => {
        const view = {
          sections: [
            {
              widgets: [
                {
                  textInput: {
                    name: 'testInput',
                    onChangeAction: {
                      action: 'onTextChange',
                      route: 'https://addon.google.internal/workspace/on-form-change',
                    },
                  },
                },
                {
                  selectionInput: {
                    name: 'testSelection',
                    type: 'DROPDOWN',
                    items: [{ text: 'Item 1', value: 'item1' }],
                    onChangeAction: {
                      action: 'onSelectChange',
                      route: 'https://addon.google.internal/workspace/action',
                    },
                  },
                },
                {
                  buttonList: {
                    buttons: [
                      {
                        text: 'Submit',
                        onClick: {
                          action: 'onSubmit',
                          route: 'https://addon.google.internal/workspace/action',
                        },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        };

        const card = translateUiViewToWorkspaceCard(view);

        expect(card.sections[0].widgets[0].textInput?.onChangeAction?.function).toBe(
          'https://addon.google.internal/workspace/on-form-change'
        );
        expect(card.sections[0].widgets[1].selectionInput?.onChangeAction?.function).toBe(
          'https://addon.google.internal/workspace/action'
        );
        const btn = card.sections[0].widgets[2].buttonList?.buttons[0];
        expect((btn?.onClick as { action?: GoogleWorkspaceAction })?.action?.function).toBe(
          'https://addon.google.internal/workspace/action'
        );
      });

      it('preserves pre-resolved action routes directly in translateUiViewToNavigationAction and translateUiViewToUpdateCardAction', () => {
        const view = {
          sections: [
            {
              widgets: [
                {
                  buttonList: {
                    buttons: [
                      {
                        text: 'Action',
                        onClick: { action: 'onAction', route: 'https://addon.nav.com/workspace/action' },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        };

        const navAction = translateUiViewToNavigationAction(view);
        const updateAction = translateUiViewToUpdateCardAction(view);

        const navBtn = navAction.action?.navigations?.[0]?.pushCard?.sections[0].widgets[0].buttonList?.buttons[0];
        expect((navBtn?.onClick as { action?: GoogleWorkspaceAction })?.action?.function).toBe(
          'https://addon.nav.com/workspace/action'
        );

        const updateBtn = updateAction.action?.navigations?.[0]?.updateCard?.sections[0].widgets[0].buttonList?.buttons[0];
        expect((updateBtn?.onClick as { action?: GoogleWorkspaceAction })?.action?.function).toBe(
          'https://addon.nav.com/workspace/action'
        );
      });
    });
  });
});
