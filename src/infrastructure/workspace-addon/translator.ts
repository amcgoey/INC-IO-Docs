import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  buildCard,
  buildNavigationAction,
  buildUpdateCardNavigationAction,
  type GoogleWorkspaceCard,
  type GoogleWorkspaceHeader,
  type GoogleWorkspaceSection,
  type GoogleWorkspaceWidget,
  type GoogleWorkspaceActionResponse,
  type GoogleWorkspaceAction,
  type GoogleWorkspaceActionParameter,
  type GoogleWorkspaceTextInput,
  type GoogleWorkspaceSelectionInput,
  type GoogleWorkspaceSelectionItem,
} from './ui-blocks';

// --- Local Boundary Contract Schema (Adheres to Rule 2: No imports from features/) ---

export const UiViewHeaderSchema = Type.Object(
  {
    title: Type.String({ minLength: 1 }),
    subtitle: Type.Optional(Type.String()),
    imageUrl: Type.Optional(Type.String()),
    imageType: Type.Optional(
      Type.Union([Type.Literal('SQUARE'), Type.Literal('CIRCLE')])
    ),
  },
  { additionalProperties: false }
);

export type UiViewHeader = Static<typeof UiViewHeaderSchema>;

export const UiSelectionItemSchema = Type.Object({
  text: Type.String(),
  value: Type.String(),
  selected: Type.Optional(Type.Boolean()),
});

export const UiSuggestionItemSchema = Type.Object({
  text: Type.String(),
});

export const UiSuggestionsSchema = Type.Object({
  items: Type.Array(UiSuggestionItemSchema),
});

export const UiActionSchema = Type.Object(
  {
    action: Type.String(),
    route: Type.String(),
    parameters: Type.Optional(Type.Record(Type.String(), Type.String())),
  },
  { additionalProperties: false }
);

export type UiAction = Static<typeof UiActionSchema>;

export const UiOnClickSchema = UiActionSchema;

export type UiOnClick = Static<typeof UiOnClickSchema>;

export const UiViewTextParagraphWidgetSchema = Type.Object(
  {
    textParagraph: Type.Object(
      {
        text: Type.String(),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const UiViewTextInputWidgetSchema = Type.Object(
  {
    textInput: Type.Object(
      {
        name: Type.String(),
        label: Type.Optional(Type.String()),
        hintText: Type.Optional(Type.String()),
        value: Type.Optional(Type.String()),
        initialSuggestions: Type.Optional(UiSuggestionsSchema),
        autocomplete: Type.Optional(Type.Array(UiSelectionItemSchema)),
        onChangeAction: Type.Optional(UiActionSchema),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const UiViewSelectionInputWidgetSchema = Type.Object(
  {
    selectionInput: Type.Object(
      {
        name: Type.String(),
        label: Type.Optional(Type.String()),
        type: Type.Optional(
          Type.Union([
            Type.Literal('DROPDOWN'),
            Type.Literal('CHECK_BOX'),
            Type.Literal('RADIO_BUTTON'),
          ])
        ),
        items: Type.Optional(Type.Array(UiSelectionItemSchema)),
        onChangeAction: Type.Optional(UiActionSchema),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const UiViewButtonListWidgetSchema = Type.Object(
  {
    buttonList: Type.Object(
      {
        buttons: Type.Array(
          Type.Object(
            {
              text: Type.String(),
              onClick: Type.Optional(UiOnClickSchema),
            },
            { additionalProperties: false }
          )
        ),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const UiViewWidgetSchema = Type.Union([
  UiViewTextParagraphWidgetSchema,
  UiViewTextInputWidgetSchema,
  UiViewSelectionInputWidgetSchema,
  UiViewButtonListWidgetSchema,
]);

export type UiViewWidget = Static<typeof UiViewWidgetSchema>;

export const UiViewSectionSchema = Type.Object(
  {
    header: Type.Optional(Type.String()),
    widgets: Type.Array(UiViewWidgetSchema, { minItems: 1 }),
    collapsible: Type.Optional(Type.Boolean()),
    uncollapsibleWidgetsCount: Type.Optional(Type.Number()),
  },
  { additionalProperties: false }
);

export type UiViewSection = Static<typeof UiViewSectionSchema>;

export const UiViewSchema = Type.Object(
  {
    id: Type.Optional(Type.String()),
    header: Type.Optional(UiViewHeaderSchema),
    sections: Type.Array(UiViewSectionSchema, { minItems: 1 }),
    evaluationOrder: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false }
);

export type UiView = Static<typeof UiViewSchema>;

// --- Validation Helpers ---

function formatValidationErrors<T extends TSchema>(schema: T, value: unknown): string[] {
  return [...Value.Errors(schema, value)].map((e) => `${e.path}: ${e.message}`);
}

function validateOrThrow<T extends TSchema>(
  schema: T,
  value: unknown,
  errorMessagePrefix: string
): void {
  if (!Value.Check(schema, value)) {
    const errors = formatValidationErrors(schema, value);
    throw new Error(`${errorMessagePrefix}: ${errors.join(', ')}`);
  }
}

export type TranslatorOptions = Record<string, never>;

function normalizeAction(
  action: UiAction | undefined
): GoogleWorkspaceAction | undefined {
  if (!action) {
    return undefined;
  }

  const funcName = action.route;

  const parameters: GoogleWorkspaceActionParameter[] = [
    { key: 'action', value: action.action },
  ];

  if (action.parameters) {
    for (const [key, value] of Object.entries(action.parameters)) {
      if (key !== 'action' && value !== undefined && value !== null) {
        parameters.push({ key, value: String(value) });
      }
    }
  }

  return {
    function: funcName,
    parameters,
    loadIndicator: 'SPINNER',
  };
}

function normalizeButtonOnClick(
  onClick: UiOnClick | undefined
): { action?: GoogleWorkspaceAction } | undefined {
  if (!onClick) {
    return undefined;
  }
  const action = normalizeAction(onClick);
  return action ? { action } : undefined;
}

function applyCommonInputProps<T extends { label?: string; onChangeAction?: GoogleWorkspaceAction }>(
  target: T,
  source: { label?: string; onChangeAction?: UiAction }
): void {
  if (source.label !== undefined) {
    target.label = source.label;
  }
  const action = normalizeAction(source.onChangeAction);
  if (action !== undefined) {
    target.onChangeAction = action;
  }
}

// --- Deep Module Public Interface ---

/**
 * Translates an adapter UiView model into a concrete GoogleWorkspaceCard structure.
 * Validates the input payload against the boundary contract and maps adapter widgets
 * to Google Workspace Card JSON formats.
 */
export function translateUiViewToWorkspaceCard(
  payload: unknown
): GoogleWorkspaceCard {
  validateOrThrow(UiViewSchema, payload, 'Invalid UiView');

  const view = payload as UiView;

  // Map header (or fallback to default header)
  const header: GoogleWorkspaceHeader = {
    title: view.header?.title ?? 'INC-IO Engine',
  };
  if (view.header?.subtitle !== undefined) {
    header.subtitle = view.header.subtitle;
  }
  if (view.header?.imageUrl !== undefined) {
    header.imageUrl = view.header.imageUrl;
  }
  if (view.header?.imageType !== undefined) {
    header.imageType = view.header.imageType;
  }

  // Map sections and widgets
  const sections: GoogleWorkspaceSection[] = view.sections.map((sec) => {
    const widgets: GoogleWorkspaceWidget[] = sec.widgets.map((w) => {
      const widget: GoogleWorkspaceWidget = {};

      if ('textParagraph' in w) {
        widget.textParagraph = {
          text: w.textParagraph.text,
        };
      }

      if ('textInput' in w) {
        const textInput: GoogleWorkspaceTextInput = {
          name: w.textInput.name,
        };
        applyCommonInputProps(textInput, w.textInput);
        if (w.textInput.hintText !== undefined) {
          textInput.hintText = w.textInput.hintText;
        }
        if (w.textInput.value !== undefined) {
          textInput.value = w.textInput.value;
        }
        if (w.textInput.initialSuggestions !== undefined) {
          textInput.initialSuggestions = w.textInput.initialSuggestions;
        } else if (w.textInput.autocomplete !== undefined && w.textInput.autocomplete.length > 0) {
          textInput.initialSuggestions = {
            items: w.textInput.autocomplete.map((item) => ({ text: item.text })),
          };
        }
        widget.textInput = textInput;
      }

      if ('selectionInput' in w) {
        const selectionType = w.selectionInput.type ?? 'DROPDOWN';

        const selectionInput: GoogleWorkspaceSelectionInput = {
          name: w.selectionInput.name,
          type: selectionType,
          items:
            w.selectionInput.items?.map((item) => {
              const itemObj: GoogleWorkspaceSelectionItem = {
                text: item.text,
                value: item.value,
              };
              if (item.selected !== undefined) {
                itemObj.selected = item.selected;
              }
              return itemObj;
            }) ?? [],
        };
        applyCommonInputProps(selectionInput, w.selectionInput);
        widget.selectionInput = selectionInput;
      }

      if ('buttonList' in w) {
        widget.buttonList = {
          buttons: w.buttonList.buttons.map((btn) => {
            const buttonObj: { text: string; onClick?: { action?: GoogleWorkspaceAction } } = {
              text: btn.text,
            };
            if (btn.onClick !== undefined) {
              const normalizedOnClick = normalizeButtonOnClick(btn.onClick);
              if (normalizedOnClick !== undefined) {
                buttonObj.onClick = normalizedOnClick;
              }
            }
            return buttonObj;
          }),
        };
      }

      return widget;
    });

    const section: GoogleWorkspaceSection = {
      widgets,
    };
    if (sec.header !== undefined) {
      section.header = sec.header;
    }
    if (sec.collapsible !== undefined) {
      section.collapsible = sec.collapsible;
    }
    if (sec.uncollapsibleWidgetsCount !== undefined) {
      section.uncollapsibleWidgetsCount = sec.uncollapsibleWidgetsCount;
    }

    return section;
  });

  return buildCard(header, sections);
}

/**
 * Translates an adapter UiView model into a GoogleWorkspaceActionResponse navigation action.
 */
export function translateUiViewToNavigationAction(
  payload: unknown
): GoogleWorkspaceActionResponse {
  const card = translateUiViewToWorkspaceCard(payload);
  return buildNavigationAction(card);
}

/**
 * Translates an adapter UiView model into a GoogleWorkspaceActionResponse updateCard navigation action.
 */
export function translateUiViewToUpdateCardAction(
  payload: unknown
): GoogleWorkspaceActionResponse {
  const card = translateUiViewToWorkspaceCard(payload);
  return buildUpdateCardNavigationAction(card);
}
