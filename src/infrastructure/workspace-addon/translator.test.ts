import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  translateUiViewToWorkspaceCard,
  translateUiViewToNavigationAction,
  AbstractUiViewSchema,
} from './translator';
import { GoogleWorkspaceCardSchema } from './ui-blocks';

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
                onChangeAction: 'onInvoiceNumberChange',
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
                  function: 'onVendorCategoryChange',
                  loadIndicator: 'SPINNER',
                },
              },
            },
            {
              buttonList: {
                buttons: [
                  {
                    text: 'Process Invoice',
                    onClick: {
                      function: 'onProcessInvoice',
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

    expect(card.evaluationOrder).toEqual(['invoiceNumber', 'vendorCategory']);

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

    // Widget 2: textInput with string action converted to object
    expect(section.widgets[1]).toEqual({
      textInput: {
        name: 'invoiceNumber',
        label: 'Invoice #',
        hintText: 'e.g. INV-10023',
        value: 'INV-10023',
        onChangeAction: {
          function: 'onInvoiceNumberChange',
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
          function: 'onVendorCategoryChange',
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
                function: 'onProcessInvoice',
                loadIndicator: 'SPINNER',
              },
            },
          },
        ],
      },
    });
  });

  it('normalizes string button onClick to GoogleWorkspaceAction', () => {
    const view = {
      sections: [
        {
          widgets: [
            {
              buttonList: {
                buttons: [
                  {
                    text: 'Submit',
                    onClick: 'handleSubmit',
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
        function: 'handleSubmit',
        loadIndicator: 'SPINNER',
      },
    });
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

  it('throws descriptive error if input is invalid according to AbstractUiViewSchema', () => {
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

  it('throws error when sections array is empty (violating Card requirements)', () => {
    expect(() =>
      translateUiViewToWorkspaceCard({
        sections: [],
      })
    ).toThrow('A Google Workspace Add-on card must contain at least one valid section.');
  });

  it('matches the AbstractUiViewSchema with valid UiView structures', () => {
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

    expect(Value.Check(AbstractUiViewSchema, validSample)).toBe(true);
  });
});
