import { describe, it, expect } from 'vitest';
import {
  buildTitleBlock,
  buildStatusMessageBlock,
  buildCard,
  buildNavigationAction,
  buildErrorCard,
} from './ui-blocks';

describe('Workspace Add-on UI Blocks', () => {
  describe('buildTitleBlock', () => {
    it('constructs a card header with title only', () => {
      const header = buildTitleBlock({ title: 'Test Title' });
      expect(header).toEqual({ title: 'Test Title' });
    });

    it('constructs a card header with all optional properties', () => {
      const header = buildTitleBlock({
        title: 'Title',
        subtitle: 'Subtitle',
        imageUrl: 'https://example.com/icon.png',
        imageType: 'CIRCLE',
      });
      expect(header).toEqual({
        title: 'Title',
        subtitle: 'Subtitle',
        imageUrl: 'https://example.com/icon.png',
        imageType: 'CIRCLE',
      });
    });
  });

  describe('buildStatusMessageBlock', () => {
    it('returns a section widget with the given message', () => {
      const section = buildStatusMessageBlock('All systems operational');
      expect(section).toEqual({
        widgets: [
          {
            textParagraph: {
              text: 'All systems operational',
            },
          },
        ],
      });
    });

    it('returns null if message is empty and isOnlySection is false', () => {
      expect(buildStatusMessageBlock(undefined, false)).toBeNull();
      expect(buildStatusMessageBlock('', false)).toBeNull();
      expect(buildStatusMessageBlock('   ', false)).toBeNull();
    });

    it('catches error and returns self-validating error widget if message is empty and isOnlySection is true', () => {
      const sectionUndefined = buildStatusMessageBlock(undefined, true);
      expect(sectionUndefined).toEqual({
        widgets: [
          {
            textParagraph: {
              text: 'Error: Card must contain at least one visible section.',
            },
          },
        ],
      });

      const sectionEmpty = buildStatusMessageBlock('', true);
      expect(sectionEmpty).toEqual({
        widgets: [
          {
            textParagraph: {
              text: 'Error: Card must contain at least one visible section.',
            },
          },
        ],
      });

      const sectionWhitespace = buildStatusMessageBlock('   ', true);
      expect(sectionWhitespace).toEqual({
        widgets: [
          {
            textParagraph: {
              text: 'Error: Card must contain at least one visible section.',
            },
          },
        ],
      });
    });
  });

  describe('buildCard', () => {
    it('builds card with header and valid sections', () => {
      const header = buildTitleBlock({ title: 'Card Title' });
      const section = buildStatusMessageBlock('Status OK');
      const card = buildCard(header, [section]);

      expect(card).toEqual({
        header: { title: 'Card Title' },
        sections: [section],
      });
    });

    it('filters out null sections when at least one valid section exists', () => {
      const header = buildTitleBlock({ title: 'Card Title' });
      const validSection = buildStatusMessageBlock('Valid Section');
      const card = buildCard(header, [null, validSection, null]);

      expect(card.sections).toHaveLength(1);
      expect(card.sections[0]).toEqual(validSection);
    });

    it('throws an error if no valid sections are provided', () => {
      const header = buildTitleBlock({ title: 'Card Title' });
      expect(() => buildCard(header, [])).toThrow(
        'A Google Workspace Add-on card must contain at least one valid section.'
      );
      expect(() => buildCard(header, [null, null])).toThrow(
        'A Google Workspace Add-on card must contain at least one valid section.'
      );
    });
  });

  describe('buildNavigationAction', () => {
    it('wraps a card in standard pushCard navigation action', () => {
      const card = { header: { title: 'Card' }, sections: [] };
      const action = buildNavigationAction(card);

      expect(action).toEqual({
        action: {
          navigations: [
            {
              pushCard: card,
            },
          ],
        },
      });
    });
  });

  describe('buildErrorCard', () => {
    it('returns an error card action with default title and notification', () => {
      const errorAction = buildErrorCard('Something broke');
      expect(errorAction).toEqual({
        action: {
          navigations: [
            {
              pushCard: {
                header: { title: 'Error' },
                sections: [
                  {
                    widgets: [
                      {
                        textParagraph: {
                          text: 'Something broke',
                        },
                      },
                    ],
                  },
                ],
              },
            },
          ],
          notification: {
            text: 'Something broke',
          },
        },
      });
    });

    it('returns an error card action with custom title', () => {
      const errorAction = buildErrorCard('Network timeout', 'Connection Error');
      const pushCard = (errorAction.action.navigations as { pushCard: { header: { title: string } } }[])[0].pushCard;
      expect(pushCard.header.title).toBe('Connection Error');
    });
  });
});
