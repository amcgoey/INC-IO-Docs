export interface CardHeaderOptions {
  title: string;
  subtitle?: string | undefined;
  imageUrl?: string | undefined;
  imageType?: 'SQUARE' | 'CIRCLE' | undefined;
}

export function buildTitleBlock(options: CardHeaderOptions) {
  return {
    title: options.title,
    ...(options.subtitle ? { subtitle: options.subtitle } : {}),
    ...(options.imageUrl ? { imageUrl: options.imageUrl } : {}),
    ...(options.imageType ? { imageType: options.imageType } : {}),
  };
}

export function buildStatusMessageBlock(message?: string | undefined, isOnlySection = false) {
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
                text: error instanceof Error ? `Error: ${error.message}` : 'Error: Card must contain at least one visible section.',
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

export function buildCard(header: Record<string, unknown>, sections: (Record<string, unknown> | null)[]) {
  const validSections = sections.filter((s): s is Record<string, unknown> => s !== null && s !== undefined);
  
  if (validSections.length === 0) {
    throw new Error('A Google Workspace Add-on card must contain at least one valid section.');
  }

  return {
    header,
    sections: validSections,
  };
}

export function buildNavigationAction(card: Record<string, unknown>) {
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

export function buildErrorCard(errorMessage: string, title = 'Error') {
  const header = buildTitleBlock({ title });
  const messageBlock = buildStatusMessageBlock(errorMessage, true);
  const card = buildCard(header, [messageBlock]);
  const action = buildNavigationAction(card);
  return {
    ...action,
    action: {
      ...action.action,
      notification: {
        text: errorMessage,
      },
    },
  };
}

export function buildAuthorizationAction(authorizationUrl = 'https://accounts.google.com/o/oauth2/v2/auth') {
  return {
    action: {
      authorizationAction: {
        authorizationUrl,
      },
    },
  };
}
