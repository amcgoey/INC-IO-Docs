import { Type, type Static } from '@sinclair/typebox';

export const GoogleWorkspaceHeaderOptionsSchema = Type.Object({
  title: Type.String(),
  subtitle: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  imageUrl: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  imageType: Type.Optional(
    Type.Union([Type.Literal('SQUARE'), Type.Literal('CIRCLE'), Type.Undefined()])
  ),
});

export type GoogleWorkspaceHeaderOptions = Static<typeof GoogleWorkspaceHeaderOptionsSchema>;

export const GoogleWorkspaceHeaderSchema = Type.Object({
  title: Type.String(),
  subtitle: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  imageUrl: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  imageType: Type.Optional(
    Type.Union([Type.Literal('SQUARE'), Type.Literal('CIRCLE'), Type.Undefined()])
  ),
});

export type GoogleWorkspaceHeader = Static<typeof GoogleWorkspaceHeaderSchema>;

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

export const GoogleWorkspaceWidgetSchema = Type.Object({
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

export type GoogleWorkspaceWidget = Static<typeof GoogleWorkspaceWidgetSchema>;

export const GoogleWorkspaceSectionSchema = Type.Object({
  header: Type.Optional(Type.String()),
  widgets: Type.Array(GoogleWorkspaceWidgetSchema),
  collapsible: Type.Optional(Type.Boolean()),
  uncollapsibleWidgetsCount: Type.Optional(Type.Number()),
});

export type GoogleWorkspaceSection = Static<typeof GoogleWorkspaceSectionSchema>;

export const GoogleWorkspaceCardSchema = Type.Object({
  header: GoogleWorkspaceHeaderSchema,
  sections: Type.Array(GoogleWorkspaceSectionSchema),
  evaluationOrder: Type.Optional(Type.Array(Type.String())),
});

export type GoogleWorkspaceCard = Static<typeof GoogleWorkspaceCardSchema>;

export const GoogleWorkspaceNavigationSchema = Type.Object({
  pushCard: GoogleWorkspaceCardSchema,
});

export type GoogleWorkspaceNavigation = Static<typeof GoogleWorkspaceNavigationSchema>;

export const GoogleWorkspaceNotificationSchema = Type.Object({
  text: Type.String(),
});

export type GoogleWorkspaceNotification = Static<typeof GoogleWorkspaceNotificationSchema>;

export const GoogleWorkspaceActionSchema = Type.Object({
  navigations: Type.Optional(Type.Union([Type.Array(GoogleWorkspaceNavigationSchema), Type.Undefined()])),
  notification: Type.Optional(Type.Union([GoogleWorkspaceNotificationSchema, Type.Undefined()])),
});

export type GoogleWorkspaceAction = Static<typeof GoogleWorkspaceActionSchema>;

export const GoogleWorkspaceActionResponseSchema = Type.Object({
  action: GoogleWorkspaceActionSchema,
});

export type GoogleWorkspaceActionResponse = Static<typeof GoogleWorkspaceActionResponseSchema>;

export function buildTitleBlock(options: GoogleWorkspaceHeaderOptions): GoogleWorkspaceHeader {
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
): GoogleWorkspaceSection | null {
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
  header: GoogleWorkspaceHeader,
  sections: (GoogleWorkspaceSection | null | undefined)[],
  evaluationOrder?: string[]
): GoogleWorkspaceCard {
  const validSections = sections.filter(
    (s): s is GoogleWorkspaceSection => s !== null && s !== undefined
  );

  if (validSections.length === 0) {
    throw new Error('A Google Workspace Add-on card must contain at least one valid section.');
  }

  const card: GoogleWorkspaceCard = {
    header,
    sections: validSections,
  };

  if (evaluationOrder !== undefined) {
    card.evaluationOrder = evaluationOrder;
  }

  return card;
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
}): GoogleWorkspaceSection {
  const widgets: GoogleWorkspaceWidget[] = [];

  const spaceTypes =
    options.selectionContext.spaceTypes.length > 0
      ? options.selectionContext.spaceTypes
      : [{ text: 'No space types available', value: '' }];

  widgets.push({
    selectionInput: {
      name: 'SelectDocumentSpaceType',
      label: 'Document Space Type',
      type: 'DROPDOWN',
      items: spaceTypes,
      onChangeAction: {
        function: options.onSpaceTypeChangeAction,
        loadIndicator: 'SPINNER',
      },
    },
  });

  const spaceTextInput: TextInput = {
    name: 'SelectDocumentSpace',
    label: 'Document Space',
  };

  if (options.selectionContext.spaces.length > 0) {
    spaceTextInput.initialSuggestions = {
      items: options.selectionContext.spaces.map((space) => ({ text: space })),
    };
  }

  widgets.push({
    textInput: spaceTextInput,
  });

  const documentTypes =
    options.selectionContext.documentTypes.length > 0
      ? options.selectionContext.documentTypes
      : [{ text: 'No document types available', value: '' }];

  widgets.push({
    selectionInput: {
      name: 'SelectDocumentType',
      label: 'Document Type',
      type: 'DROPDOWN',
      items: documentTypes,
    },
  });

  return {
    header: 'Document Type',
    widgets,
  };
}

export function buildNavigationAction(card: GoogleWorkspaceCard): GoogleWorkspaceActionResponse {
  return {
    action: {
      navigations: [
        {
          pushCard: card,
        },
      ],
    },
  };
}

export function buildErrorCard(
  errorMessage: string,
  title = 'Error'
): GoogleWorkspaceActionResponse {
  const header = buildTitleBlock({ title });
  const messageBlock = buildStatusMessageBlock(errorMessage, true);
  // messageBlock is guaranteed non-null when isOnlySection is true
  const card = buildCard(header, [messageBlock]);
  return {
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
  };
}

// --- Backward Compatibility Aliases ---
export const CardHeaderOptionsSchema = GoogleWorkspaceHeaderOptionsSchema;
export type CardHeaderOptions = GoogleWorkspaceHeaderOptions;

export const CardHeaderSchema = GoogleWorkspaceHeaderSchema;
export type CardHeader = GoogleWorkspaceHeader;

export const CardWidgetSchema = GoogleWorkspaceWidgetSchema;
export type CardWidget = GoogleWorkspaceWidget;

export const CardSectionSchema = GoogleWorkspaceSectionSchema;
export type CardSection = GoogleWorkspaceSection;

export const CardSchema = GoogleWorkspaceCardSchema;
export type Card = GoogleWorkspaceCard;

export const UiCardSchema = GoogleWorkspaceCardSchema;
export type UiCard = GoogleWorkspaceCard;

export const CardNavigationSchema = GoogleWorkspaceNavigationSchema;
export type CardNavigation = GoogleWorkspaceNavigation;

export const CardNotificationSchema = GoogleWorkspaceNotificationSchema;
export type CardNotification = GoogleWorkspaceNotification;

export const CardActionSchema = GoogleWorkspaceActionSchema;
export type CardAction = GoogleWorkspaceAction;

export const CardActionResponseSchema = GoogleWorkspaceActionResponseSchema;
export type CardActionResponse = GoogleWorkspaceActionResponse;

