import { describe, it, expect } from 'vitest';
import { buildHomepageCard, buildToastNotification } from './cards';

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
});
