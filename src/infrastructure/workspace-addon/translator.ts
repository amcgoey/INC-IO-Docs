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
  type Action,
  type TextInput,
  type SelectionInput,
  type SelectionItem,
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

export const AbstractUiViewWidgetSchema = Type.Object(
  {
    type: Type.Optional(Type.String()),
    textParagraph: Type.Optional(
      Type.Object(
        {
          text: Type.String(),
        },
        { additionalProperties: false }
      )
    ),
    textInput: Type.Optional(
      Type.Object(
        {
          name: Type.String(),
          label: Type.Optional(Type.String()),
          hintText: Type.Optional(Type.String()),
          value: Type.Optional(Type.String()),
          initialSuggestions: Type.Optional(AbstractUiSuggestionsSchema),
          onChangeAction: Type.Optional(Type.Unknown()),
        },
        { additionalProperties: false }
      )
    ),
    selectionInput: Type.Optional(
      Type.Object(
        {
          name: Type.String(),
          label: Type.Optional(Type.String()),
          type: Type.Optional(Type.String()),
          items: Type.Optional(Type.Array(AbstractUiSelectionItemSchema)),
          onChangeAction: Type.Optional(Type.Unknown()),
        },
        { additionalProperties: false }
      )
    ),
    buttonList: Type.Optional(
      Type.Object(
        {
          buttons: Type.Array(
            Type.Object(
              {
                text: Type.String(),
                onClick: Type.Optional(Type.Unknown()),
              },
              { additionalProperties: false }
            )
          ),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);

export type AbstractUiViewWidget = Static<typeof AbstractUiViewWidgetSchema>;

export const AbstractUiViewSectionSchema = Type.Object(
  {
    header: Type.Optional(Type.String()),
    widgets: Type.Array(AbstractUiViewWidgetSchema),
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
    sections: Type.Array(AbstractUiViewSectionSchema),
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

function normalizeAction(action: unknown): Action | undefined {
  if (!action) {
    return undefined;
  }
  if (typeof action === 'string') {
    return {
      function: action,
      loadIndicator: 'SPINNER',
    };
  }
  if (typeof action === 'object' && action !== null && 'function' in action) {
    const act = action as Record<string, unknown>;
    const normalized: Action = {
      function: String(act.function),
      loadIndicator:
        act.loadIndicator === 'NONE' || act.loadIndicator === 'SPINNER'
          ? act.loadIndicator
          : 'SPINNER',
    };
    if (Array.isArray(act.parameters)) {
      normalized.parameters = act.parameters as { key: string; value: string }[];
    }
    return normalized;
  }
  return undefined;
}

function normalizeButtonOnClick(onClick: unknown): unknown {
  if (!onClick) {
    return undefined;
  }
  if (
    typeof onClick === 'object' &&
    onClick !== null &&
    ('action' in onClick || 'openLink' in onClick)
  ) {
    return onClick;
  }
  const action = normalizeAction(onClick);
  if (action) {
    return { action };
  }
  return onClick;
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

      if (w.textParagraph) {
        widget.textParagraph = {
          text: w.textParagraph.text,
        };
      }

      if (w.textInput) {
        const textInput: TextInput = {
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

      if (w.selectionInput) {
        const selectionType =
          w.selectionInput.type === 'CHECK_BOX' || w.selectionInput.type === 'RADIO_BUTTON'
            ? w.selectionInput.type
            : 'DROPDOWN';

        const selectionInput: SelectionInput = {
          name: w.selectionInput.name,
          type: selectionType,
          items:
            w.selectionInput.items?.map((item) => {
              const itemObj: SelectionItem = {
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

      if (w.buttonList) {
        widget.buttonList = {
          buttons: w.buttonList.buttons.map((btn) => {
            const buttonObj: { text: string; onClick?: unknown } = {
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

  return buildCard(header, sections, view.evaluationOrder);
}

/**
 * Translates an abstract UiView model into a GoogleWorkspaceActionResponse navigation action.
 */
export function translateUiViewToNavigationAction(payload: unknown): GoogleWorkspaceActionResponse {
  const card = translateUiViewToWorkspaceCard(payload);
  return buildNavigationAction(card);
}
