import { describe, it, expect } from 'vitest';
import {
  buildHomepageCard,
  buildToastNotification,
  buildErrorCard,
  buildAuthorizationAction,
} from './cards';

describe('Workspace Cards Adapter', () => {
  describe('buildHomepageCard', () => {
    it('returns a card with a Move Selected File button', () => {
      const card = buildHomepageCard();

      expect(card.action.navigations[0].pushCard.header.title).toBe('INC-IO Docs');
      const button =
        card.action.navigations[0].pushCard.sections[0].widgets[0].buttonList.buttons[0];
      expect(button.text).toBe('Move Selected File');
      expect(button.onClick.action.actionMethodName).toBe('moveSelectedFile');
    });
  });

  describe('buildToastNotification', () => {
    it('returns a notification toast with fileName and destinationFolder', () => {
      const toast = buildToastNotification('Report.pdf', '!TestMove');
      expect(toast).toEqual({
        renderActions: {
          action: {
            notification: {
              text: "Moved 'Report.pdf' to '!TestMove'",
            },
          },
        },
      });
    });
  });

  describe('buildErrorCard', () => {
    it('returns an error card with error title and description', () => {
      const errorCard = buildErrorCard('File not found in Google Drive', 'Drive Error');
      expect(errorCard).toEqual({
        renderActions: {
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
        },
      });
    });

    it('defaults error card title to Error', () => {
      const errorCard = buildErrorCard('Something went wrong');
      expect(errorCard.renderActions.action.navigations[0].pushCard.header.title).toBe('Error');
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

