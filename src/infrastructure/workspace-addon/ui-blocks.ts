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

export const GoogleWorkspaceTextParagraphSchema = Type.Object(
  {
    text: Type.String(),
    maxLines: Type.Optional(
      Type.Union([Type.Integer({ minimum: 1 }), Type.Undefined()])
    ),
  },
  { additionalProperties: false }
);

export type GoogleWorkspaceTextParagraph = Static<typeof GoogleWorkspaceTextParagraphSchema>;

export const GoogleWorkspaceTextParagraphWidgetSchema = Type.Object({
  textParagraph: GoogleWorkspaceTextParagraphSchema,
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
  type: Type.Optional(
    Type.Union([
      Type.Literal('DROPDOWN'),
      Type.Literal('RADIO_BUTTON'),
      Type.Literal('CHECK_BOX'),
      Type.Literal('SWITCH'),
    ])
  ),
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

export const GoogleWorkspaceColorSchema = Type.Object(
  {
    red: Type.Number({ minimum: 0, maximum: 1 }),
    green: Type.Number({ minimum: 0, maximum: 1 }),
    blue: Type.Number({ minimum: 0, maximum: 1 }),
    alpha: Type.Optional(
      Type.Union([Type.Number({ minimum: 0, maximum: 1 }), Type.Undefined()])
    ),
  },
  { additionalProperties: false }
);

export type GoogleWorkspaceColor = Static<typeof GoogleWorkspaceColorSchema>;

export const GoogleWorkspaceOpenLinkSchema = Type.Object(
  {
    url: Type.String({ minLength: 1 }),
    openAs: Type.Optional(
      Type.Union([Type.Literal('FULL_SIZE'), Type.Literal('OVERLAY'), Type.Undefined()])
    ),
    onClose: Type.Optional(
      Type.Union([Type.Literal('NOTHING'), Type.Literal('RELOAD'), Type.Undefined()])
    ),
  },
  { additionalProperties: false }
);

export type GoogleWorkspaceOpenLink = Static<typeof GoogleWorkspaceOpenLinkSchema>;

export const GoogleWorkspaceOnClickSchema = Type.Union([
  Type.Object(
    {
      action: GoogleWorkspaceActionSchema,
    },
    { additionalProperties: false }
  ),
  Type.Object(
    {
      openLink: GoogleWorkspaceOpenLinkSchema,
    },
    { additionalProperties: false }
  ),
]);

export type GoogleWorkspaceOnClick = Static<typeof GoogleWorkspaceOnClickSchema>;

export const GoogleWorkspaceButtonSchema = Type.Object(
  {
    text: Type.String(),
    onClick: Type.Optional(Type.Union([GoogleWorkspaceOnClickSchema, Type.Undefined()])),
    color: Type.Optional(Type.Union([GoogleWorkspaceColorSchema, Type.Undefined()])),
    disabled: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
  },
  { additionalProperties: false }
);

export type GoogleWorkspaceButton = Static<typeof GoogleWorkspaceButtonSchema>;

export const GoogleWorkspaceDecoratedTextSchema = Type.Object(
  {
    topLabel: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    text: Type.String(),
    wrapText: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
    bottomLabel: Type.Optional(Type.Union([Type.String(), Type.Undefined()])),
    button: Type.Optional(Type.Union([GoogleWorkspaceButtonSchema, Type.Undefined()])),
    onClick: Type.Optional(Type.Union([GoogleWorkspaceOnClickSchema, Type.Undefined()])),
  },
  { additionalProperties: false }
);

export type GoogleWorkspaceDecoratedText = Static<typeof GoogleWorkspaceDecoratedTextSchema>;

export const GoogleWorkspaceWidgetSchema = Type.Object(
  {
    textParagraph: Type.Optional(
      Type.Union([GoogleWorkspaceTextParagraphSchema, Type.Undefined()])
    ),
    buttonList: Type.Optional(
      Type.Union([
        Type.Object(
          {
            buttons: Type.Array(GoogleWorkspaceButtonSchema),
          },
          { additionalProperties: false }
        ),
        Type.Undefined(),
      ])
    ),
    decoratedText: Type.Optional(
      Type.Union([GoogleWorkspaceDecoratedTextSchema, Type.Undefined()])
    ),
    selectionInput: Type.Optional(
      Type.Union([GoogleWorkspaceSelectionInputSchema, Type.Undefined()])
    ),
    textInput: Type.Optional(
      Type.Union([GoogleWorkspaceTextInputSchema, Type.Undefined()])
    ),
  },
  { additionalProperties: false }
);

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
  popToRoot: Type.Optional(Type.Union([Type.Boolean(), Type.Undefined()])),
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

export function buildUpdateCardNavigationAction(
  card: GoogleWorkspaceCard,
  notification?: string | undefined,
  options?: { popToRoot?: boolean | undefined } | undefined
): GoogleWorkspaceActionResponse {
  const navigations: GoogleWorkspaceNavigation[] = [];
  if (options?.popToRoot) {
    navigations.push({ popToRoot: true });
  }
  navigations.push({ updateCard: card });
  return {
    action: {
      navigations,
      ...(notification && notification.trim().length > 0
        ? { notification: { text: notification } }
        : {}),
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
