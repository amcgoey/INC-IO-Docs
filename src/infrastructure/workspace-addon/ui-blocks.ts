import { Type, type Static } from '@sinclair/typebox';

export const GoogleWorkspaceHeaderSchema = Type.Object({
  title: Type.String(),
  subtitle: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  imageUrl: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
  imageType: Type.Optional(
    Type.Union([Type.Literal('SQUARE'), Type.Literal('CIRCLE'), Type.Undefined()])
  ),
});

export type GoogleWorkspaceHeader = Static<typeof GoogleWorkspaceHeaderSchema>;

export const GoogleWorkspaceHeaderOptionsSchema = GoogleWorkspaceHeaderSchema;
export type GoogleWorkspaceHeaderOptions = GoogleWorkspaceHeader;

export const GoogleWorkspaceTextParagraphWidgetSchema = Type.Object({
  textParagraph: Type.Object({
    text: Type.String(),
  }),
});

export type GoogleWorkspaceTextParagraphWidget = Static<typeof GoogleWorkspaceTextParagraphWidgetSchema>;

export const GoogleWorkspaceActionParameterSchema = Type.Object({
  key: Type.String(),
  value: Type.String(),
});

export type GoogleWorkspaceActionParameter = Static<typeof GoogleWorkspaceActionParameterSchema>;

export const GoogleWorkspaceActionSchema = Type.Object({
  function: Type.String(),
  parameters: Type.Optional(Type.Array(GoogleWorkspaceActionParameterSchema)),
  loadIndicator: Type.Optional(Type.Union([Type.Literal('SPINNER'), Type.Literal('NONE')])),
});

export type GoogleWorkspaceAction = Static<typeof GoogleWorkspaceActionSchema>;

export const GoogleWorkspaceSelectionItemSchema = Type.Object({
  text: Type.String(),
  value: Type.String(),
  selected: Type.Optional(Type.Boolean()),
});

export type GoogleWorkspaceSelectionItem = Static<typeof GoogleWorkspaceSelectionItemSchema>;

export const GoogleWorkspaceSelectionInputSchema = Type.Object({
  name: Type.String(),
  label: Type.Optional(Type.String()),
  type: Type.Union([Type.Literal('DROPDOWN'), Type.Literal('CHECK_BOX'), Type.Literal('RADIO_BUTTON')]),
  items: Type.Array(GoogleWorkspaceSelectionItemSchema),
  onChangeAction: Type.Optional(GoogleWorkspaceActionSchema),
});

export type GoogleWorkspaceSelectionInput = Static<typeof GoogleWorkspaceSelectionInputSchema>;

export const GoogleWorkspaceSuggestionItemSchema = Type.Object({
  text: Type.String()
});

export type GoogleWorkspaceSuggestionItem = Static<typeof GoogleWorkspaceSuggestionItemSchema>;

export const GoogleWorkspaceSuggestionsSchema = Type.Object({
  items: Type.Array(GoogleWorkspaceSuggestionItemSchema)
});

export type GoogleWorkspaceSuggestions = Static<typeof GoogleWorkspaceSuggestionsSchema>;

export const GoogleWorkspaceTextInputSchema = Type.Object({
  name: Type.String(),
  label: Type.Optional(Type.String()),
  hintText: Type.Optional(Type.String()),
  value: Type.Optional(Type.String()),
  initialSuggestions: Type.Optional(GoogleWorkspaceSuggestionsSchema),
  onChangeAction: Type.Optional(GoogleWorkspaceActionSchema),
});

export type GoogleWorkspaceTextInput = Static<typeof GoogleWorkspaceTextInputSchema>;

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
  selectionInput: Type.Optional(GoogleWorkspaceSelectionInputSchema),
  textInput: Type.Optional(GoogleWorkspaceTextInputSchema),
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
});

export type GoogleWorkspaceCard = Static<typeof GoogleWorkspaceCardSchema>;

export const GoogleWorkspaceNavigationSchema = Type.Object({
  pushCard: Type.Optional(GoogleWorkspaceCardSchema),
  updateCard: Type.Optional(GoogleWorkspaceCardSchema),
});

export type GoogleWorkspaceNavigation = Static<typeof GoogleWorkspaceNavigationSchema>;

export const GoogleWorkspaceNotificationSchema = Type.Object({
  text: Type.String(),
});

export type GoogleWorkspaceNotification = Static<typeof GoogleWorkspaceNotificationSchema>;

export const GoogleWorkspaceActionResponseActionSchema = Type.Object({
  navigations: Type.Optional(Type.Union([Type.Array(GoogleWorkspaceNavigationSchema), Type.Undefined()])),
  notification: Type.Optional(Type.Union([GoogleWorkspaceNotificationSchema, Type.Undefined()])),
});

export type GoogleWorkspaceActionResponseAction = Static<typeof GoogleWorkspaceActionResponseActionSchema>;

export const GoogleWorkspaceActionResponseSchema = Type.Object({
  action: GoogleWorkspaceActionResponseActionSchema,
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
): GoogleWorkspaceCard & { evaluationOrder?: string[] } {
  const validSections = sections.filter(
    (s): s is GoogleWorkspaceSection => s !== null && s !== undefined
  );

  if (validSections.length === 0) {
    throw new Error('A Google Workspace Add-on card must contain at least one valid section.');
  }

  const card: GoogleWorkspaceCard & { evaluationOrder?: string[] } = {
    header,
    sections: validSections,
  };

  if (evaluationOrder !== undefined) {
    card.evaluationOrder = evaluationOrder;
  }

  return card;
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

export function buildUpdateCardNavigationAction(card: GoogleWorkspaceCard): GoogleWorkspaceActionResponse {
  return {
    action: {
      navigations: [
        {
          updateCard: card,
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
