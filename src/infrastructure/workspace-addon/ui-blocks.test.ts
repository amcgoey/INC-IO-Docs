import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { TypeSystemPolicy } from '@sinclair/typebox/system';
import {
  buildTitleBlock,
  buildStatusMessageBlock,
  buildCard,
  buildNavigationAction,
  buildUpdateCardNavigationAction,
  buildErrorCard,
  GoogleWorkspaceCardSchema,
  GoogleWorkspaceSectionSchema,
  GoogleWorkspaceWidgetSchema,
  GoogleWorkspaceTextParagraphWidgetSchema,
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

    it('includes optional evaluationOrder in card and validates against CardSchema', () => {
      const header = buildTitleBlock({ title: 'Card Title' });
      const section = buildStatusMessageBlock('Status OK');
      const card = buildCard(header, [section], ['fieldA', 'fieldB']);

      expect(card).toEqual({
        header: { title: 'Card Title' },
        sections: [section],
        evaluationOrder: ['fieldA', 'fieldB'],
      });
      expect(Value.Check(GoogleWorkspaceCardSchema, card)).toBe(true);
    });

    it('ensures GoogleWorkspaceCardSchema does not define evaluationOrder property', () => {
      expect('evaluationOrder' in GoogleWorkspaceCardSchema.properties).toBe(false);
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

  describe('buildUpdateCardNavigationAction', () => {
    it('wraps a card in standard updateCard navigation action', () => {
      const card = { header: { title: 'Card' }, sections: [] };
      const action = buildUpdateCardNavigationAction(card);

      expect(action).toEqual({
        action: {
          navigations: [
            {
              updateCard: card,
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
      const pushCard = (
        errorAction.action.navigations as {
          pushCard: { header: { title: string } };
        }[]
      )[0].pushCard;
      expect(pushCard.header.title).toBe('Connection Error');
    });
  });

  describe('GoogleWorkspace schemas', () => {
    it('validates a GoogleWorkspaceCard with collapsible section', () => {
      const sectionWithCollapsible = {
        header: 'Collapsible Section',
        collapsible: true,
        uncollapsibleWidgetsCount: 1,
        widgets: [
          {
            textParagraph: { text: 'Visible widget' },
          },
        ],
      };

      expect(Value.Check(GoogleWorkspaceSectionSchema, sectionWithCollapsible)).toBe(true);

      const card = {
        header: { title: 'Test' },
        sections: [sectionWithCollapsible],
      };

      expect(Value.Check(GoogleWorkspaceCardSchema, card)).toBe(true);
    });

    it('accepts textParagraph.maxLines as a positive integer across TextParagraph, Widget, and Card schemas', () => {
      const widget = {
        textParagraph: { text: 'Summary', maxLines: 3 },
      };
      const card = {
        header: { title: 'Test' },
        sections: [{ widgets: [widget] }],
      };

      expect(Value.Check(GoogleWorkspaceTextParagraphWidgetSchema, widget)).toBe(true);
      expect(Value.Check(GoogleWorkspaceWidgetSchema, widget)).toBe(true);
      expect(Value.Check(GoogleWorkspaceCardSchema, card)).toBe(true);
    });

    it('accepts textParagraph.maxLines: undefined under ExactOptionalPropertyTypes = true', () => {
      const prev = TypeSystemPolicy.ExactOptionalPropertyTypes;
      TypeSystemPolicy.ExactOptionalPropertyTypes = true;
      try {
        expect(
          Value.Check(GoogleWorkspaceWidgetSchema, {
            textParagraph: { text: 'Summary', maxLines: undefined },
          })
        ).toBe(true);
      } finally {
        TypeSystemPolicy.ExactOptionalPropertyTypes = prev;
      }
    });

    it('rejects invalid textParagraph.maxLines values (0, -2, 2.5) on GoogleWorkspaceWidgetSchema', () => {
      expect(
        Value.Check(GoogleWorkspaceWidgetSchema, { textParagraph: { text: 'Summary', maxLines: 0 } })
      ).toBe(false);
      expect(
        Value.Check(GoogleWorkspaceWidgetSchema, { textParagraph: { text: 'Summary', maxLines: -2 } })
      ).toBe(false);
      expect(
        Value.Check(GoogleWorkspaceWidgetSchema, { textParagraph: { text: 'Summary', maxLines: 2.5 } })
      ).toBe(false);
    });

    it('accepts buttonList.buttons[] with color and disabled on GoogleWorkspaceWidgetSchema and GoogleWorkspaceCardSchema', () => {
      const widget = {
        buttonList: {
          buttons: [
            {
              text: 'Submit',
              color: { red: 0.1, green: 0.45, blue: 0.91, alpha: 1 },
              disabled: true,
            },
          ],
        },
      };
      const card = {
        header: { title: 'Test' },
        sections: [{ widgets: [widget] }],
      };

      expect(Value.Check(GoogleWorkspaceWidgetSchema, widget)).toBe(true);
      expect(Value.Check(GoogleWorkspaceCardSchema, card)).toBe(true);
    });

    it('accepts buttonList.buttons[] optional color, alpha, disabled, and onClick as undefined under ExactOptionalPropertyTypes = true', () => {
      const prev = TypeSystemPolicy.ExactOptionalPropertyTypes;
      TypeSystemPolicy.ExactOptionalPropertyTypes = true;
      try {
        expect(
          Value.Check(GoogleWorkspaceWidgetSchema, {
            buttonList: {
              buttons: [
                {
                  text: 'Alpha Undefined',
                  color: { red: 0.2, green: 0.3, blue: 0.4, alpha: undefined },
                  disabled: undefined,
                  onClick: undefined,
                },
                {
                  text: 'Color Undefined',
                  color: undefined,
                  disabled: undefined,
                  onClick: undefined,
                },
              ],
            },
          })
        ).toBe(true);
      } finally {
        TypeSystemPolicy.ExactOptionalPropertyTypes = prev;
      }
    });

    it('rejects out-of-bounds color channels, missing channel, non-boolean disabled, and unknown button properties on GoogleWorkspaceWidgetSchema', () => {
      const makeButtonWidget = (button: Record<string, unknown>) => ({
        buttonList: { buttons: [button] },
      });

      expect(
        Value.Check(
          GoogleWorkspaceWidgetSchema,
          makeButtonWidget({ text: 'Btn', color: { red: -0.1, green: 0.5, blue: 0.5 } })
        )
      ).toBe(false);
      expect(
        Value.Check(
          GoogleWorkspaceWidgetSchema,
          makeButtonWidget({ text: 'Btn', color: { red: 0.5, green: 0.5, blue: 1.01 } })
        )
      ).toBe(false);
      expect(
        Value.Check(
          GoogleWorkspaceWidgetSchema,
          makeButtonWidget({ text: 'Btn', color: { red: 0.5, green: 0.5, blue: 0.5, alpha: 1.5 } })
        )
      ).toBe(false);
      expect(
        Value.Check(
          GoogleWorkspaceWidgetSchema,
          makeButtonWidget({ text: 'Btn', color: { red: 0.5, green: 0.5 } })
        )
      ).toBe(false);
      expect(
        Value.Check(
          GoogleWorkspaceWidgetSchema,
          makeButtonWidget({ text: 'Btn', disabled: 'true' })
        )
      ).toBe(false);
      expect(
        Value.Check(
          GoogleWorkspaceWidgetSchema,
          makeButtonWidget({ text: 'Btn', type: 'FILLED' })
        )
      ).toBe(false);
    });

    it('accepts buttonList.buttons[].onClick as GoogleWorkspaceAction or openLink on Widget and Card schemas', () => {
      const widget = {
        buttonList: {
          buttons: [
            {
              text: 'Server Action',
              onClick: {
                action: {
                  function: '/workspace/action',
                  parameters: [{ key: 'action', value: 'go' }],
                  loadIndicator: 'SPINNER',
                },
              },
            },
            {
              text: 'Open Sheet',
              onClick: {
                openLink: {
                  url: 'https://docs.google.com/spreadsheets/d/123/edit',
                  openAs: 'FULL_SIZE',
                  onClose: 'RELOAD',
                },
              },
            },
          ],
        },
      };
      const card = {
        header: { title: 'Test' },
        sections: [{ widgets: [widget] }],
      };

      expect(Value.Check(GoogleWorkspaceWidgetSchema, widget)).toBe(true);
      expect(Value.Check(GoogleWorkspaceCardSchema, card)).toBe(true);
    });

    it('accepts buttonList.buttons[].onClick openLink with undefined optional properties under ExactOptionalPropertyTypes = true', () => {
      const prev = TypeSystemPolicy.ExactOptionalPropertyTypes;
      TypeSystemPolicy.ExactOptionalPropertyTypes = true;
      try {
        expect(
          Value.Check(GoogleWorkspaceWidgetSchema, {
            buttonList: {
              buttons: [
                {
                  text: 'Open Link',
                  onClick: {
                    openLink: {
                      url: 'https://example.com',
                      openAs: undefined,
                      onClose: undefined,
                    },
                  },
                },
              ],
            },
          })
        ).toBe(true);
      } finally {
        TypeSystemPolicy.ExactOptionalPropertyTypes = prev;
      }
    });

    it('rejects malformed onClick values on GoogleWorkspaceWidgetSchema', () => {
      const makeOnClickWidget = (onClick: unknown) => ({
        buttonList: { buttons: [{ text: 'Btn', onClick }] },
      });

      expect(
        Value.Check(GoogleWorkspaceWidgetSchema, makeOnClickWidget({ action: 'invalid' }))
      ).toBe(false);
      expect(
        Value.Check(GoogleWorkspaceWidgetSchema, makeOnClickWidget({ openLink: { url: '' } }))
      ).toBe(false);
      expect(
        Value.Check(
          GoogleWorkspaceWidgetSchema,
          makeOnClickWidget({ openLink: { url: 'https://example.com', openAs: 'TAB' } })
        )
      ).toBe(false);
      expect(
        Value.Check(
          GoogleWorkspaceWidgetSchema,
          makeOnClickWidget({ openLink: { url: 'https://example.com', onClose: 'REFRESH' } })
        )
      ).toBe(false);
      expect(
        Value.Check(
          GoogleWorkspaceWidgetSchema,
          makeOnClickWidget({
            action: { function: '/a' },
            openLink: { url: 'https://example.com' },
          })
        )
      ).toBe(false);
      expect(
        Value.Check(GoogleWorkspaceWidgetSchema, makeOnClickWidget({ foo: 'bar' }))
      ).toBe(false);
    });

    it('accepts minimal and full decoratedText on GoogleWorkspaceWidgetSchema and GoogleWorkspaceCardSchema', () => {
      const minimalWidget = {
        decoratedText: { text: '071200-001' },
      };
      const fullWidgetWithOpenLinkButton = {
        decoratedText: {
          topLabel: 'Submittal',
          text: '071200-001 Waterproofing',
          wrapText: true,
          bottomLabel: '2026-11-24',
          button: {
            text: 'Open',
            color: { red: 0.1, green: 0.45, blue: 0.91, alpha: 1 },
            disabled: false,
            onClick: {
              openLink: {
                url: 'https://docs.google.com/spreadsheets/d/123/edit',
                openAs: 'FULL_SIZE',
                onClose: 'RELOAD',
              },
            },
          },
          onClick: {
            action: {
              function: '/workspace/action',
              parameters: [{ key: 'action', value: 'selectHistoryRow' }],
              loadIndicator: 'SPINNER',
            },
          },
        },
      };
      const fullWidgetWithActionButtonAndOpenLinkClick = {
        decoratedText: {
          text: 'RFI-042',
          button: {
            text: 'Approve',
            disabled: true,
            onClick: {
              action: {
                function: '/workspace/action',
                parameters: [{ key: 'action', value: 'approveItem' }],
              },
            },
          },
          onClick: {
            openLink: {
              url: 'https://example.com/rfi/42',
            },
          },
        },
      };

      expect(Value.Check(GoogleWorkspaceWidgetSchema, minimalWidget)).toBe(true);
      expect(Value.Check(GoogleWorkspaceWidgetSchema, fullWidgetWithOpenLinkButton)).toBe(true);
      expect(
        Value.Check(GoogleWorkspaceWidgetSchema, fullWidgetWithActionButtonAndOpenLinkClick)
      ).toBe(true);
      expect(
        Value.Check(GoogleWorkspaceCardSchema, {
          header: { title: 'Test' },
          sections: [
            {
              widgets: [
                minimalWidget,
                fullWidgetWithOpenLinkButton,
                fullWidgetWithActionButtonAndOpenLinkClick,
              ],
            },
          ],
        })
      ).toBe(true);
    });

    it('accepts decoratedText with undefined optional properties under ExactOptionalPropertyTypes = true', () => {
      const prev = TypeSystemPolicy.ExactOptionalPropertyTypes;
      TypeSystemPolicy.ExactOptionalPropertyTypes = true;
      try {
        expect(
          Value.Check(GoogleWorkspaceWidgetSchema, {
            decoratedText: undefined,
            textParagraph: { text: 'Fallback' },
          })
        ).toBe(true);
        expect(
          Value.Check(GoogleWorkspaceWidgetSchema, {
            decoratedText: {
              text: 'Entry',
              topLabel: undefined,
              wrapText: undefined,
              bottomLabel: undefined,
              button: undefined,
              onClick: undefined,
            },
          })
        ).toBe(true);
      } finally {
        TypeSystemPolicy.ExactOptionalPropertyTypes = prev;
      }
    });

    it('rejects columns, divider, Chat-only decoratedText/button fields, and malformed onClick on GoogleWorkspaceWidgetSchema', () => {
      expect(Value.Check(GoogleWorkspaceWidgetSchema, { columns: { columnItems: [] } })).toBe(
        false
      );
      expect(Value.Check(GoogleWorkspaceWidgetSchema, { divider: {} })).toBe(false);

      expect(
        Value.Check(GoogleWorkspaceWidgetSchema, {
          decoratedText: { text: 'Entry', startIcon: { knownIcon: 'STAR' } },
        })
      ).toBe(false);
      expect(
        Value.Check(GoogleWorkspaceWidgetSchema, {
          decoratedText: { text: 'Entry', endIcon: { knownIcon: 'STAR' } },
        })
      ).toBe(false);
      expect(
        Value.Check(GoogleWorkspaceWidgetSchema, {
          decoratedText: { text: 'Entry', switchControl: { name: 'sw', value: '1' } },
        })
      ).toBe(false);

      expect(
        Value.Check(GoogleWorkspaceWidgetSchema, {
          decoratedText: { text: 'Entry', button: { text: 'Btn', type: 'FILLED' } },
        })
      ).toBe(false);
      expect(
        Value.Check(GoogleWorkspaceWidgetSchema, {
          decoratedText: { text: 'Entry', button: { text: 'Btn', icon: { knownIcon: 'STAR' } } },
        })
      ).toBe(false);

      expect(
        Value.Check(GoogleWorkspaceWidgetSchema, {
          decoratedText: { text: 'Entry', onClick: { action: 'invalid' } },
        })
      ).toBe(false);
      expect(
        Value.Check(GoogleWorkspaceWidgetSchema, {
          decoratedText: {
            text: 'Entry',
            button: { text: 'Btn', onClick: { action: 'invalid' } },
          },
        })
      ).toBe(false);
    });
  });
});


