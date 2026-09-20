import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import {
  buildCard,
  buildNavigationAction,
  type GoogleWorkspaceCard,
  type GoogleWorkspaceHeader,
  type GoogleWorkspaceSection,
  type GoogleWorkspaceWidget,
  type GoogleWorkspaceActionResponse,
  type GoogleWorkspaceAction,
  type GoogleWorkspaceTextInput,
  type GoogleWorkspaceSelectionInput,
  type GoogleWorkspaceSelectionItem,
} from './ui-blocks';

// --- Local Boundary Contract Schema (Adheres to Rule 2: No imports from features/) ---

export const AbstractUiViewHeaderSchema = Type.Object(
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

export type AbstractUiViewHeader = Static<typeof AbstractUiViewHeaderSchema>;

export const AbstractUiSelectionItemSchema = Type.Object({
  text: Type.String(),
  value: Type.String(),
  selected: Type.Optional(Type.Boolean()),
});

export const AbstractUiSuggestionItemSchema = Type.Object({
  text: Type.String(),
});

export const AbstractUiSuggestionsSchema = Type.Object({
  items: Type.Array(AbstractUiSuggestionItemSchema),
});

export const AbstractUiActionParameterSchema = Type.Object({
  key: Type.String(),
  value: Type.String(),
});

export type AbstractUiActionParameter = Static<typeof AbstractUiActionParameterSchema>;

export const AbstractUiActionSchema = Type.Union([
  Type.String(),
  Type.Object(
    {
      function: Type.String(),
      parameters: Type.Optional(Type.Array(AbstractUiActionParameterSchema)),
      loadIndicator: Type.Optional(
        Type.Union([Type.Literal('SPINNER'), Type.Literal('NONE')])
      ),
    },
    { additionalProperties: false }
  ),
]);

export type AbstractUiAction = Static<typeof AbstractUiActionSchema>;

export const AbstractUiOnClickSchema = Type.Union([
  AbstractUiActionSchema,
  Type.Object(
    {
      action: Type.Optional(AbstractUiActionSchema),
    },
    { additionalProperties: false }
  ),
]);

export type AbstractUiOnClick = Static<typeof AbstractUiOnClickSchema>;

export const AbstractUiViewTextParagraphWidgetSchema = Type.Object(
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

export const AbstractUiViewTextInputWidgetSchema = Type.Object(
  {
    textInput: Type.Object(
      {
        name: Type.String(),
        label: Type.Optional(Type.String()),
        hintText: Type.Optional(Type.String()),
        value: Type.Optional(Type.String()),
        initialSuggestions: Type.Optional(AbstractUiSuggestionsSchema),
        onChangeAction: Type.Optional(AbstractUiActionSchema),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const AbstractUiViewSelectionInputWidgetSchema = Type.Object(
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
        items: Type.Optional(Type.Array(AbstractUiSelectionItemSchema)),
        onChangeAction: Type.Optional(AbstractUiActionSchema),
      },
      { additionalProperties: false }
    ),
  },
  { additionalProperties: false }
);

export const AbstractUiViewButtonListWidgetSchema = Type.Object(
  {
    buttonList: Type.Object(
      {
        buttons: Type.Array(
          Type.Object(
            {
              text: Type.String(),
              onClick: Type.Optional(AbstractUiOnClickSchema),
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

export const AbstractUiViewWidgetSchema = Type.Union([
  AbstractUiViewTextParagraphWidgetSchema,
  AbstractUiViewTextInputWidgetSchema,
  AbstractUiViewSelectionInputWidgetSchema,
  AbstractUiViewButtonListWidgetSchema,
]);

export type AbstractUiViewWidget = Static<typeof AbstractUiViewWidgetSchema>;

export const AbstractUiViewSectionSchema = Type.Object(
  {
    header: Type.Optional(Type.String()),
    widgets: Type.Array(AbstractUiViewWidgetSchema, { minItems: 1 }),
    collapsible: Type.Optional(Type.Boolean()),
    uncollapsibleWidgetsCount: Type.Optional(Type.Number()),
  },
  { additionalProperties: false }
);

export type AbstractUiViewSection = Static<typeof AbstractUiViewSectionSchema>;

export const AbstractUiViewSchema = Type.Object(
  {
    id: Type.Optional(Type.String()),
    header: Type.Optional(AbstractUiViewHeaderSchema),
    sections: Type.Array(AbstractUiViewSectionSchema, { minItems: 1 }),
    evaluationOrder: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false }
);

export type AbstractUiView = Static<typeof AbstractUiViewSchema>;

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

function normalizeAction(
  action: AbstractUiAction | undefined
): GoogleWorkspaceAction | undefined {
  if (!action) {
    return undefined;
  }
  if (typeof action === 'string') {
    return {
      function: action,
      loadIndicator: 'SPINNER',
    };
  }
  const normalized: GoogleWorkspaceAction = {
    function: action.function,
    loadIndicator: action.loadIndicator ?? 'SPINNER',
  };
  if (action.parameters !== undefined) {
    normalized.parameters = action.parameters;
  }
  return normalized;
}

function normalizeButtonOnClick(
  onClick: AbstractUiOnClick | undefined
): { action?: GoogleWorkspaceAction } | undefined {
  if (!onClick) {
    return undefined;
  }
  const rawAction =
    typeof onClick === 'string' || 'function' in onClick
      ? onClick
      : 'action' in onClick
        ? onClick.action
        : undefined;

  const action = normalizeAction(rawAction);
  return action ? { action } : undefined;
}

// --- Deep Module Public Interface ---

/**
 * Translates an abstract UiView model into a concrete GoogleWorkspaceCard structure.
 * Validates the input payload against the boundary contract and maps abstract widgets
 * to Google Workspace Card JSON formats.
 */
export function translateUiViewToWorkspaceCard(payload: unknown): GoogleWorkspaceCard {
  validateOrThrow(AbstractUiViewSchema, payload, 'Invalid UiView');

  const view = payload as AbstractUiView;

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
        if (w.textInput.label !== undefined) {
          textInput.label = w.textInput.label;
        }
        if (w.textInput.hintText !== undefined) {
          textInput.hintText = w.textInput.hintText;
        }
        if (w.textInput.value !== undefined) {
          textInput.value = w.textInput.value;
        }
        if (w.textInput.initialSuggestions !== undefined) {
          textInput.initialSuggestions = w.textInput.initialSuggestions;
        }
        const action = normalizeAction(w.textInput.onChangeAction);
        if (action !== undefined) {
          textInput.onChangeAction = action;
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
        if (w.selectionInput.label !== undefined) {
          selectionInput.label = w.selectionInput.label;
        }
        const action = normalizeAction(w.selectionInput.onChangeAction);
        if (action !== undefined) {
          selectionInput.onChangeAction = action;
        }
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
 * Translates an abstract UiView model into a GoogleWorkspaceActionResponse navigation action.
 */
export function translateUiViewToNavigationAction(payload: unknown): GoogleWorkspaceActionResponse {
  const card = translateUiViewToWorkspaceCard(payload);
  return buildNavigationAction(card);
}
