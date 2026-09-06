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
});

export type CardWidget = Static<typeof CardWidgetSchema>;

export const CardSectionSchema = Type.Object({
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
  action: CardActionSchema,
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
      // If it's the only section and there's no message, we throw an error that is caught
      // and displayed within the Status Message itself to prevent schema violations.
      try {
        throw new Error('Card must contain at least one visible section.');
      } catch (error) {
        return {
          widgets: [
            {
              textParagraph: {
                text:
                  error instanceof Error
                    ? `Error: ${error.message}`
                    : 'Error: Card must contain at least one visible section.',
              },
            },
          ],
        };
      }
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

export function buildNavigationAction(card: Card): CardActionResponse {
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

export function buildErrorCard(errorMessage: string, title = 'Error'): CardActionResponse {
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
