import { Type, type Static } from '@sinclair/typebox';

export const CardHeaderOptionsSchema = Type.Object({
  title: Type.String(),
  subtitle: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  imageUrl: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  imageType: Type.Optional(
    Type.Union([Type.Literal('SQUARE'), Type.Literal('CIRCLE'), Type.Undefined()])
  ),
});

export type CardHeaderOptions = Static<typeof CardHeaderOptionsSchema>;

export const CardHeaderSchema = Type.Object({
  title: Type.String(),
  subtitle: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  imageUrl: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  imageType: Type.Optional(
    Type.Union([Type.Literal('SQUARE'), Type.Literal('CIRCLE'), Type.Undefined()])
  ),
});

export type CardHeader = Static<typeof CardHeaderSchema>;

export const TextParagraphWidgetSchema = Type.Object({
  textParagraph: Type.Object({
    text: Type.String(),
  }),
});

export type TextParagraphWidget = Static<typeof TextParagraphWidgetSchema>;

export const ActionParameterSchema = Type.Object({
  key: Type.String(),
  value: Type.String(),
});

export const ActionSchema = Type.Object({
  function: Type.String(),
  parameters: Type.Optional(Type.Array(ActionParameterSchema)),
  loadIndicator: Type.Optional(Type.Union([Type.Literal('SPINNER'), Type.Literal('NONE')])),
});

export type Action = Static<typeof ActionSchema>;

export const SelectionItemSchema = Type.Object({
  text: Type.String(),
  value: Type.String(),
  selected: Type.Optional(Type.Boolean()),
});

export type SelectionItem = Static<typeof SelectionItemSchema>;

export const SelectionInputSchema = Type.Object({
  name: Type.String(),
  label: Type.Optional(Type.String()),
  type: Type.Union([Type.Literal('DROPDOWN'), Type.Literal('CHECK_BOX'), Type.Literal('RADIO_BUTTON')]),
  items: Type.Array(SelectionItemSchema),
  onChangeAction: Type.Optional(ActionSchema),
});

export type SelectionInput = Static<typeof SelectionInputSchema>;

export const SuggestionItemSchema = Type.Object({
  text: Type.String()
});

export type SuggestionItem = Static<typeof SuggestionItemSchema>;

export const SuggestionsSchema = Type.Object({
  items: Type.Array(SuggestionItemSchema)
});

export type Suggestions = Static<typeof SuggestionsSchema>;

export const TextInputSchema = Type.Object({
  name: Type.String(),
  label: Type.Optional(Type.String()),
  hintText: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
  initialSuggestions: Type.Optional(SuggestionsSchema),
  onChangeAction: Type.Optional(ActionSchema),
});

export type TextInput = Static<typeof TextInputSchema>;

export const CardWidgetSchema = Type.Object({
  textParagraph: Type.Optional(
    Type.Union([
      Type.Object({
        text: Type.String(),
      }),
      Type.Undefined(),
    ])
  ),
  buttonList: Type.Optional(
    Type.Union([
      Type.Object({
        buttons: Type.Array(
          Type.Object({
            text: Type.String(),
            onClick: Type.Optional(Type.Union([Type.Unknown(), Type.Undefined()])),
          })
        ),
      }),
      Type.Undefined(),
    ])
  ),
  selectionInput: Type.Optional(SelectionInputSchema),
  textInput: Type.Optional(TextInputSchema),
});

export type CardWidget = Static<typeof CardWidgetSchema>;

export const CardSectionSchema = Type.Object({
  header: Type.Optional(Type.String()),
  widgets: Type.Array(CardWidgetSchema),
});

export type CardSection = Static<typeof CardSectionSchema>;

export const CardSchema = Type.Object({
  header: CardHeaderSchema,
  sections: Type.Array(CardSectionSchema),
});

export type Card = Static<typeof CardSchema>;

export const CardNavigationSchema = Type.Object({
  pushCard: CardSchema,
});

export type CardNavigation = Static<typeof CardNavigationSchema>;

export const CardNotificationSchema = Type.Object({
  text: Type.String(),
});

export type CardNotification = Static<typeof CardNotificationSchema>;

export const CardActionSchema = Type.Object({
  navigations: Type.Optional(Type.Union([Type.Array(CardNavigationSchema), Type.Undefined()])),
  notification: Type.Optional(Type.Union([CardNotificationSchema, Type.Undefined()])),
});

export type CardAction = Static<typeof CardActionSchema>;

export const CardActionResponseSchema = Type.Object({
  renderActions: Type.Object({
    action: CardActionSchema,
  }),
});

export type CardActionResponse = Static<typeof CardActionResponseSchema>;

export function buildTitleBlock(options: CardHeaderOptions): CardHeader {
  return {
    title: options.title,
    ...(options.subtitle ? { subtitle: options.subtitle } : {}),
    ...(options.imageUrl ? { imageUrl: options.imageUrl } : {}),
    ...(options.imageType ? { imageType: options.imageType } : {}),
  };
}

export function buildStatusMessageBlock(
  message?: string | undefined,
  isOnlySection = false
): CardSection | null {
  if (!message || message.trim() === '') {
    if (isOnlySection) {
      // If it's the only section and there's no message, we must return a visible section
      // to prevent schema violations. We display a default error message.
      return {
        widgets: [
          {
            textParagraph: {
              text: 'Error: Card must contain at least one visible section.',
            },
          },
        ],
      };
    }
    return null; // Return null if no message, letting the caller omit this section
  }

  return {
    widgets: [
      {
        textParagraph: {
          text: message,
        },
      },
    ],
  };
}

export function buildCard(
  header: CardHeader,
  sections: (CardSection | null | undefined)[]
): Card {
  const validSections = sections.filter(
    (s): s is CardSection => s !== null && s !== undefined
  );

  if (validSections.length === 0) {
    throw new Error('A Google Workspace Add-on card must contain at least one valid section.');
  }

  return {
    header,
    sections: validSections,
  };
}

export interface DocumentSelectionItem {
  text: string;
  value: string;
  selected?: boolean;
}

export interface DocumentSelectionState {
  spaceTypes: DocumentSelectionItem[];
  spaces: string[];
  documentTypes: DocumentSelectionItem[];
}

export type DocumentSelectionContext = DocumentSelectionState;

export function buildDocumentTypeSelectionBlock(options: {
  selectionContext: DocumentSelectionState;
  onSpaceTypeChangeAction: string;
}): CardSection {
  const widgets: CardWidget[] = [];

  widgets.push({
    selectionInput: {
      name: 'SelectDocumentSpaceType',
      label: 'Document Space Type',
      type: 'DROPDOWN',
      items: options.selectionContext.spaceTypes,
      onChangeAction: {
        function: options.onSpaceTypeChangeAction,
        loadIndicator: 'SPINNER',
      },
    },
  });

  widgets.push({
    textInput: {
      name: 'SelectDocumentSpace',
      label: 'Document Space',
      initialSuggestions: {
        items: options.selectionContext.spaces.map((space) => ({ text: space })),
      },
    },
  });

  widgets.push({
    selectionInput: {
      name: 'SelectDocumentType',
      label: 'Document Type',
      type: 'DROPDOWN',
      items: options.selectionContext.documentTypes,
    },
  });

  return {
    header: 'Document Type',
    widgets,
  };
}

export function buildNavigationAction(card: Card): CardActionResponse {
  return {
    renderActions: {
      action: {
        navigations: [
          {
            pushCard: card,
          },
        ],
      },
    },
  };
}

export function buildErrorCard(errorMessage: string, title = 'Error'): CardActionResponse {
  const header = buildTitleBlock({ title });
  const messageBlock = buildStatusMessageBlock(errorMessage, true);
  // messageBlock is guaranteed non-null when isOnlySection is true
  const card = buildCard(header, [messageBlock]);
  return {
    renderActions: {
      action: {
        navigations: [
          {
            pushCard: card,
          },
        ],
        notification: {
          text: errorMessage,
        },
      },
    },
  };
}
