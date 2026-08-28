import { describe, it, expect } from 'vitest';
import {
  buildHomepageCard,
  buildToastNotification,
  buildErrorCard,
  buildAuthorizationAction,
} from './cards';

function getCardTitle(
  card: ReturnType<typeof buildHomepageCard> | ReturnType<typeof buildErrorCard>
) {
  return card.action.navigations[0].pushCard.header.title;
}

function getCardButton(card: ReturnType<typeof buildHomepageCard>) {
  return card.action.navigations[0].pushCard.sections[0].widgets[0].buttonList.buttons[0];
}

describe('Workspace Cards Adapter', () => {
  describe('buildHomepageCard', () => {
    it('returns a card with a Move Selected File button', () => {
      const card = buildHomepageCard();

      expect(getCardTitle(card)).toBe('INC-IO Docs');
      const button = getCardButton(card);
      expect(button.text).toBe('Move Selected File');
      expect(button.onClick.action.actionMethodName).toBe('moveSelectedFile');
    });

    it('returns a card with custom appTitle and actionButtonText when options are provided', () => {
      const card = buildHomepageCard({
        appTitle: 'Custom Title',
        actionButtonText: 'Custom Action',
      });

      expect(getCardTitle(card)).toBe('Custom Title');
      const button = getCardButton(card);
      expect(button.text).toBe('Custom Action');
      expect(button.onClick.action.actionMethodName).toBe('moveSelectedFile');
    });
  });


  describe('buildToastNotification', () => {
    it('returns a notification toast with fileName and destinationFolder', () => {
      const toast = buildToastNotification('Report.pdf', '!TestMove');
      expect(toast).toEqual({
        action: {
          notification: {
            text: "Moved 'Report.pdf' to '!TestMove'",
          },
        },
      });
    });
  });

  describe('buildErrorCard', () => {
    it('returns an error card with error title and description', () => {
      const errorCard = buildErrorCard('File not found in Google Drive', 'Drive Error');
      expect(errorCard).toEqual({
        action: {
          navigations: [
            {
              pushCard: {
                header: {
                  title: 'Drive Error',
                },
                sections: [
                  {
                    widgets: [
                      {
                        textParagraph: {
                          text: 'File not found in Google Drive',
                        },
                      },
                    ],
                  },
                ],
              },
            },
          ],
          notification: {
            text: 'File not found in Google Drive',
          },
        },
      });
    });

    it('defaults error card title to Error', () => {
      const errorCard = buildErrorCard('Something went wrong');
      expect(getCardTitle(errorCard)).toBe('Error');
    });
  });

  describe('buildAuthorizationAction', () => {
    it('returns an AuthorizationAction response with default Google OAuth URL', () => {
      const authAction = buildAuthorizationAction();
      expect(authAction).toEqual({
        action: {
          authorizationAction: {
            authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
          },
        },
      });
    });

    it('returns an AuthorizationAction response with custom authorizationUrl', () => {
      const customUrl = 'https://accounts.google.com/o/oauth2/v2/auth?client_id=123';
      const authAction = buildAuthorizationAction(customUrl);
      expect(authAction).toEqual({
        action: {
          authorizationAction: {
            authorizationUrl: customUrl,
          },
        },
      });
    });
  });
});

