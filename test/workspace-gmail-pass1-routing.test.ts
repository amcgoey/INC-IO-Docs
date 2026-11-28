import { describe, it, expect, vi, beforeEach } from 'vitest';
import nock from 'nock';
import type { GmailThreadDetails } from '../src/infrastructure/gmail/types';
import type { GoogleWorkspaceActionResponse } from '../src/infrastructure/workspace-addon/ui-blocks';
import {
  getDocumentTypeWidgetName,
  getDocumentSpaceWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';
import {
  setupWorkspaceGmailIntegrationSuite,
  mockDocumentLogSearch,
} from './utils/workspace-gmail-test-helper';

describe('Workspace Gmail Pass 1 Routing & Form Cleansing Integration', () => {
  const ctx = setupWorkspaceGmailIntegrationSuite();

  describe('Gmail Pass 1 DocumentType and DocumentSpaceType routing across threads and attachments (Ticket #292)', () => {
    it('infers submittal-arch on Gmail initial card open (/workspace/gmail-contextual) when active email has CSI attachment', async () => {
      vi.spyOn(ctx.mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
        if (threadId === 'th-arch-e2e') {
          return {
            id: 'th-arch-e2e',
            messages: [
              {
                id: 'msg-arch-e2e',
                threadId: 'th-arch-e2e',
                subject: 'Submittal Review',
                from: 'Architect <arch@example.com>',
                date: 'Mon, 19 Oct 2026 10:00:00 +0000',
                inlineImages: [],
                attachments: [
                  {
                    partId: 'part-arch-1',
                    attachmentId: 'att-arch-1',
                    filename: '071200-001_Waterproofing.pdf',
                    mimeType: 'application/pdf',
                    size: 1024,
                  },
                ],
              },
            ],
          };
        }
        return { id: threadId, messages: [] };
      });

      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-arch-e2e',
            threadId: 'th-arch-e2e',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const cardResponse = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const pushCard = cardResponse.action!.navigations![0].pushCard!;
      const cardJson = JSON.stringify(pushCard);

      expect(cardJson).toContain('submittal-arch');
      expect(cardJson).toContain('Active Projects');
    });

    it('infers submittal-ffe on Gmail initial card open when active email has bounded FF&E keyword in subject', async () => {
      vi.spyOn(ctx.mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
        if (threadId === 'th-ffe-e2e') {
          return {
            id: 'th-ffe-e2e',
            messages: [
              {
                id: 'msg-ffe-e2e',
                threadId: 'th-ffe-e2e',
                subject: 'FF&E Submittal - Ballroom Seating',
                from: 'Designer <designer@example.com>',
                date: 'Mon, 19 Oct 2026 10:00:00 +0000',
                plainTextBody: 'Please review attached specs.',
                inlineImages: [],
                attachments: [
                  {
                    partId: 'part-ffe-1',
                    attachmentId: 'att-ffe-1',
                    filename: 'Notes.pdf',
                    mimeType: 'application/pdf',
                    size: 1024,
                  },
                ],
              },
            ],
          };
        }
        return { id: threadId, messages: [] };
      });

      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-ffe-e2e',
            threadId: 'th-ffe-e2e',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const cardResponse = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const pushCard = cardResponse.action!.navigations![0].pushCard!;
      const cardJson = JSON.stringify(pushCard);

      expect(cardJson).toContain('submittal-ffe');
      expect(cardJson).toContain('Active Projects');
    });

    it('re-runs inferRouting on /workspace/action with action: refresh', async () => {
      vi.spyOn(ctx.mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
        if (threadId === 'th-refresh-e2e') {
          return {
            id: 'th-refresh-e2e',
            messages: [
              {
                id: 'msg-refresh-e2e',
                threadId: 'th-refresh-e2e',
                subject: 'Submittal 071200-001 Waterproofing',
                from: 'Contractor <gc@example.com>',
                date: 'Mon, 19 Oct 2026 10:00:00 +0000',
                inlineImages: [],
                attachments: [
                  {
                    partId: 'part-ref-1',
                    attachmentId: 'att-ref-1',
                    filename: 'Drawing.pdf',
                    mimeType: 'application/pdf',
                    size: 1024,
                  },
                ],
              },
            ],
          };
        }
        return { id: threadId, messages: [] };
      });

      const res = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'refresh',
            },
          },
          gmail: {
            messageId: 'msg-refresh-e2e',
            threadId: 'th-refresh-e2e',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(res.statusCode).toBe(200);
      const cardResponse = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
      const cardJson = JSON.stringify(cardResponse);

      expect(cardJson).toContain('submittal-arch');
    });

    it('re-evaluates Pass 1 on /workspace/action with onEmailMessageChange across messages in a thread', async () => {
      vi.spyOn(ctx.mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
        if (threadId === 'th-switch-routing-e2e') {
          return {
            id: 'th-switch-routing-e2e',
            messages: [
              {
                id: 'msg-plain-e2e',
                threadId: 'th-switch-routing-e2e',
                subject: 'Weekly Team Sync Notes',
                from: 'Alice <alice@example.com>',
                date: 'Mon, 19 Oct 2026 10:00:00 +0000',
                plainTextBody: 'Here are the minutes.',
                inlineImages: [],
                attachments: [
                  {
                    partId: 'part-notes-1',
                    attachmentId: 'att-notes-1',
                    filename: 'Minutes.pdf',
                    mimeType: 'application/pdf',
                    size: 1024,
                  },
                ],
              },
              {
                id: 'msg-submittal-e2e',
                threadId: 'th-switch-routing-e2e',
                subject: 'Submittal Package Sent for Review',
                from: 'Bob <bob@example.com>',
                date: 'Mon, 19 Oct 2026 11:00:00 +0000',
                plainTextBody: 'Please review attached FF&E submittal.',
                inlineImages: [],
                attachments: [
                  {
                    partId: 'part-sub-1',
                    attachmentId: 'att-sub-1',
                    filename: 'CG104-A_Chair.pdf',
                    mimeType: 'application/pdf',
                    size: 2048,
                  },
                ],
              },
            ],
          };
        }
        return { id: threadId, messages: [] };
      });

      // 1. Initial load on msg-plain-e2e -> defaults to communication-project
      const resInitial = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/gmail-contextual',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          hostApp: 'GMAIL',
          gmail: {
            messageId: 'msg-plain-e2e',
            threadId: 'th-switch-routing-e2e',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(resInitial.statusCode).toBe(200);
      const cardResponseInitial = JSON.parse(resInitial.payload) as GoogleWorkspaceActionResponse;
      const initialJson = JSON.stringify(cardResponseInitial);
      expect(initialJson).toContain('communication-project');

      // 2. Switch to msg-submittal-e2e via onEmailMessageChange -> infers submittal-ffe
      const resSwitchToSubmittal = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'onEmailMessageChange',
              previousMessageId: 'msg-plain-e2e',
            },
            formInputs: {
              SelectEmailMessage: { stringInputs: { value: ['msg-submittal-e2e'] } },
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
            },
          },
          gmail: {
            messageId: 'msg-plain-e2e',
            threadId: 'th-switch-routing-e2e',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(resSwitchToSubmittal.statusCode).toBe(200);
      const cardResponseSubmittal = JSON.parse(resSwitchToSubmittal.payload) as GoogleWorkspaceActionResponse;
      const submittalJson = JSON.stringify(cardResponseSubmittal);
      expect(submittalJson).toContain('submittal-ffe');

      // 3. Switch back to msg-plain-e2e -> reverts to communication-project
      const resSwitchBack = await ctx.app.server.inject({
        method: 'POST',
        url: '/workspace/action',
        headers: { authorization: 'Bearer valid-jwt-token' },
        payload: {
          commonEventObject: {
            hostApp: 'GMAIL',
            parameters: {
              action: 'onEmailMessageChange',
              previousMessageId: 'msg-submittal-e2e',
            },
            formInputs: {
              SelectEmailMessage: { stringInputs: { value: ['msg-plain-e2e'] } },
              SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
              [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-ffe'] } },
            },
          },
          gmail: {
            messageId: 'msg-plain-e2e',
            threadId: 'th-switch-routing-e2e',
            accessToken: 'ya29.live-token',
          },
        },
      });

      expect(resSwitchBack.statusCode).toBe(200);
      const cardResponseBack = JSON.parse(resSwitchBack.payload) as GoogleWorkspaceActionResponse;
      const backJson = JSON.stringify(cardResponseBack);
      expect(backJson).toContain('communication-project');
    });

    describe('Gmail Pass 1 DocumentSpace candidateSpaces inference (Ticket #293)', () => {
      beforeEach(() => {
        vi.spyOn(ctx.mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
          if (threadId === 'th-spaces-e2e') {
            return {
              id: 'th-spaces-e2e',
              messages: [
                {
                  id: 'msg-proj-space-e2e',
                  threadId: 'th-spaces-e2e',
                  subject: 'Active Projects - Foundation Progress',
                  from: 'Alice <alice@example.com>',
                  date: 'Mon, 19 Oct 2026 10:00:00 +0000',
                  plainTextBody: 'Here is the progress report for Active Projects.',
                  inlineImages: [],
                  attachments: [],
                },
                {
                  id: 'msg-prop-space-e2e',
                  threadId: 'th-spaces-e2e',
                  subject: 'RFP Submission for Client Proposals',
                  from: 'Bob <bob@example.com>',
                  date: 'Mon, 19 Oct 2026 11:00:00 +0000',
                  plainTextBody: 'Attached is our revised cost proposal.',
                  inlineImages: [],
                  attachments: [],
                },
                {
                  id: 'msg-collision-e2e',
                  threadId: 'th-spaces-e2e',
                  subject: 'Coordination between Active Projects and Client Proposals',
                  from: 'Carol <carol@example.com>',
                  date: 'Mon, 19 Oct 2026 12:00:00 +0000',
                  plainTextBody: 'We need to coordinate both accounts.',
                  inlineImages: [],
                  attachments: [],
                },
                {
                  id: 'msg-unmatched-e2e',
                  threadId: 'th-spaces-e2e',
                  subject: 'General Team Discussion',
                  from: 'Dave <dave@example.com>',
                  date: 'Mon, 19 Oct 2026 13:00:00 +0000',
                  plainTextBody: 'No specific project or proposal.',
                  inlineImages: [],
                  attachments: [],
                },
              ],
            };
          }
          return { id: threadId, messages: [] };
        });
      });

      it('infers projects DocumentSpace on initial card open with latency-bounded fetch (no proposals query)', async () => {
        const fetchSpacesSpy = vi.spyOn(ctx.mockStorageAdapter, 'fetchSpaces');
        fetchSpacesSpy.mockClear();

        const res = await ctx.app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-proj-space-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const cardResponse = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const json = JSON.stringify(cardResponse);

        // Pre-populates Active Projects and communication-project
        expect(json).toContain('Active Projects');
        expect(json).toContain('communication-project');

        // Bounded fetch: only projects was queried; proposals was NOT queried
        expect(fetchSpacesSpy).toHaveBeenCalledWith(expect.anything(), 'projects');
        expect(fetchSpacesSpy).not.toHaveBeenCalledWith(expect.anything(), 'proposals');
      });

      it('infers proposals DocumentSpace when proposal/opportunity marker (RFP) appears in email', async () => {
        const fetchSpacesSpy = vi.spyOn(ctx.mockStorageAdapter, 'fetchSpaces');
        fetchSpacesSpy.mockClear();

        const res = await ctx.app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-prop-space-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const cardResponse = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const json = JSON.stringify(cardResponse);

        // Pre-populates Client Proposals, selects proposals spaceType and communication-proposal
        expect(json).toContain('Client Proposals');
        expect(json).toContain('communication-proposal');

        // Both collections fetched
        expect(fetchSpacesSpy).toHaveBeenCalledWith(expect.anything(), 'projects');
        expect(fetchSpacesSpy).toHaveBeenCalledWith(expect.anything(), 'proposals');
      });

      it('leaves DocumentSpace blank without notFoundError when distinct spaces collide', async () => {
        const res = await ctx.app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-collision-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const cardResponse = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const json = JSON.stringify(cardResponse);

        // Collision leaves space blank with no validation errors
        expect(json).not.toContain('was not found');
        expect(json).not.toContain('Multiple spaces match');
      });

      it('clears space input without notFoundError when switching from matched message to unmatched message', async () => {
        // 1. Initial open on msg-proj-space-e2e -> Active Projects
        const resInitial = await ctx.app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-proj-space-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });
        expect(resInitial.statusCode).toBe(200);
        expect(resInitial.payload).toContain('"value":"Active Projects"');

        // 2. Switch to msg-unmatched-e2e via onEmailMessageChange
        const resSwitch = await ctx.app.server.inject({
          method: 'POST',
          url: '/workspace/action',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onEmailMessageChange',
                previousMessageId: 'msg-proj-space-e2e',
              },
              formInputs: {
                SelectEmailMessage: { stringInputs: { value: ['msg-unmatched-e2e'] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
                [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              },
            },
            gmail: {
              messageId: 'msg-proj-space-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(resSwitch.statusCode).toBe(200);
        const switchJson = resSwitch.payload;

        // Space input value is cleared and no notFoundError is emitted
        expect(switchJson).not.toContain('"value":"Active Projects"');
        expect(switchJson).not.toContain('was not found');
      });
    });

    describe('Gmail interactive Google Drive URL routing delegation and file-source switching (Ticket #294)', () => {
      beforeEach(() => {
        vi.spyOn(ctx.mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
          if (threadId === 'th-spaces-e2e') {
            return {
              id: 'th-spaces-e2e',
              messages: [
                {
                  id: 'msg-proj-space-e2e',
                  threadId: 'th-spaces-e2e',
                  subject: 'Active Projects - Foundation Progress',
                  from: 'Alice <alice@example.com>',
                  date: 'Mon, 19 Oct 2026 10:00:00 +0000',
                  plainTextBody: 'Here is the progress report for Active Projects.',
                  inlineImages: [],
                  attachments: [],
                },
                {
                  id: 'msg-prop-space-e2e',
                  threadId: 'th-spaces-e2e',
                  subject: 'RFP Submission for Client Proposals',
                  from: 'Bob <bob@example.com>',
                  date: 'Mon, 19 Oct 2026 11:00:00 +0000',
                  plainTextBody: 'Attached is our revised cost proposal.',
                  inlineImages: [],
                  attachments: [],
                },
              ],
            };
          }
          return { id: threadId, messages: [] };
        });
      });

      it('configures onChangeAction with action onFormChange and previousDriveUrl on InputDriveURL widget', async () => {
        const res = await ctx.app.server.inject({
          method: 'POST',
          url: '/workspace/on-form-change',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onFileSourceChange',
                previousDriveUrl: 'https://drive.google.com/file/d/drive-url-existing/view',
              },
              formInputs: {
                SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
                InputDriveURL: { stringInputs: { value: ['https://drive.google.com/file/d/drive-url-existing/view'] } },
              },
            },
            gmail: {
              messageId: 'msg-proj-space-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const fileSec = body.action?.navigations?.[0]?.updateCard?.sections.find((s) => s.header === 'File Selection');
        const driveUrlWidget = fileSec?.widgets.find((w) => w.textInput?.name === 'InputDriveURL')?.textInput;
        expect(driveUrlWidget).toBeDefined();
        expect(driveUrlWidget?.onChangeAction?.function).toContain('/workspace/on-form-change');
        expect(
          driveUrlWidget?.onChangeAction?.parameters?.find((p: { key: string }) => p.key === 'action')?.value
        ).toBe('onFormChange');
        expect(
          driveUrlWidget?.onChangeAction?.parameters?.find((p: { key: string }) => p.key === 'previousDriveUrl')?.value
        ).toBe('https://drive.google.com/file/d/drive-url-existing/view');
      });

      it('preserves existing space and document type selections when switching SelectFileSource to Google Drive URL with empty InputDriveURL', async () => {
        const res = await ctx.app.server.inject({
          method: 'POST',
          url: '/workspace/on-form-change',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onFileSourceChange',
                previousDriveUrl: '',
              },
              formInputs: {
                SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
                InputDriveURL: { stringInputs: { value: [''] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
                [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
              },
            },
            gmail: {
              messageId: 'msg-proj-space-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const cardJson = JSON.stringify(body);
        // Space and Document Type selections are preserved (Pass 1 skipped)
        expect(cardJson).toContain('Active Projects');
        expect(cardJson).toContain('communication-project');
      });

      it('runs Pass 1 inferRouting when InputDriveURL receives a valid Drive URL on onFormChange, resolving document type from Drive and space from email fallback', async () => {
        mockDocumentLogSearch({ sharedDriveId: 'shared-drive-proj-root' });
        nock('https://www.googleapis.com')
          .get('/drive/v3/files/drive-submittal-url-123')
          .query(true)
          .reply(200, {
            id: 'drive-submittal-url-123',
            name: '071200-001_Waterproofing.pdf',
            parents: [],
          });

        const driveUrl = 'https://drive.google.com/file/d/drive-submittal-url-123/view';
        const res = await ctx.app.server.inject({
          method: 'POST',
          url: '/workspace/on-form-change',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onFormChange',
                previousDriveUrl: '',
              },
              formInputs: {
                SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
                InputDriveURL: { stringInputs: { value: [driveUrl] } },
              },
            },
            gmail: {
              messageId: 'msg-proj-space-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const cardJson = JSON.stringify(body);

        // Document type inferred from Drive filename regex
        expect(cardJson).toContain('submittal-arch');
        // Space inferred from active email subject fallback ("Active Projects - Foundation Progress")
        expect(cardJson).toContain('Active Projects');
      });

      it('re-runs Pass 1 against active email message when switching SelectFileSource back to Email Attachments', async () => {
        const driveUrl = 'https://drive.google.com/file/d/drive-submittal-url-123/view';

        // When switching back to Email Attachments, active email is msg-prop-space-e2e (RFP Submission for Client Proposals)
        const res = await ctx.app.server.inject({
          method: 'POST',
          url: '/workspace/on-form-change',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onFileSourceChange',
                previousDriveUrl: driveUrl,
              },
              formInputs: {
                SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
                InputDriveURL: { stringInputs: { value: [driveUrl] } },
                // Stale selections from Drive mode
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
                [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['submittal-arch'] } },
              },
            },
            gmail: {
              messageId: 'msg-prop-space-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const cardJson = JSON.stringify(body);

        // Pass 1 re-ran against msg-prop-space-e2e -> inferred Client Proposals
        expect(cardJson).toContain('Client Proposals');
      });

      it('skips Pass 1 on regular onFormChange field edits', async () => {
        const driveUrl = 'https://drive.google.com/file/d/drive-submittal-url-123/view';

        const res = await ctx.app.server.inject({
          method: 'POST',
          url: '/workspace/on-form-change',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onFormChange',
                // previousDriveUrl matches current InputDriveURL (no URL transition)
                previousDriveUrl: driveUrl,
              },
              formInputs: {
                SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
                InputDriveURL: { stringInputs: { value: [driveUrl] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
                [getDocumentSpaceWidgetName('proposals')]: { stringInputs: { value: ['Client Proposals'] } },
                notes: { stringInputs: { value: ['User manually edited notes'] } },
              },
            },
            gmail: {
              messageId: 'msg-proj-space-e2e',
              threadId: 'th-spaces-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const cardJson = JSON.stringify(body);

        // Did not re-run Pass 1 against msg-proj-space-e2e (which would have forced Active Projects)
        expect(cardJson).toContain('Client Proposals');
      });
    });

    describe('Gmail Pass 1 label-aware DocumentSpace and DocumentType routing across card-open seams (Ticket #302)', () => {
      beforeEach(() => {
        vi.spyOn(ctx.mockStorageAdapter, 'fetchSpaces').mockImplementation(async (_config, typeId: string) => {
          if (typeId === 'projects') {
            return [
              {
                id: 'space-proj-123',
                typeId: 'projects',
                name: '123 Main St',
                abstractStorageId: 'drive-123',
              },
              {
                id: 'space-projects-1',
                typeId: 'projects',
                name: 'Active Projects',
                abstractStorageId: 'shared-drive-proj-root',
              },
            ];
          }
          if (typeId === 'proposals') {
            return [
              {
                id: 'space-proposals-1',
                typeId: 'proposals',
                name: 'Client Proposals',
                abstractStorageId: 'folder-opp-root',
              },
            ];
          }
          return [];
        });

        vi.spyOn(ctx.mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
          if (threadId === 'th-labels-e2e') {
            return {
              id: 'th-labels-e2e',
              messages: [
                {
                  id: 'msg-labeled-submittal',
                  threadId: 'th-labels-e2e',
                  subject: 'Weekly Review',
                  from: 'Alice <alice@example.com>',
                  date: 'Mon, 19 Oct 2026 10:00:00 +0000',
                  plainTextBody: 'Please find files attached.',
                  inlineImages: [],
                  attachments: [
                    {
                      partId: 'part-1',
                      attachmentId: 'att-1',
                      filename: 'GeneralNotes.pdf',
                      mimeType: 'application/pdf',
                      size: 1024,
                    },
                  ],
                  labels: ['Projects/123 Main St/Submittals', 'INBOX'],
                },
                {
                  id: 'msg-labeled-ffe-attachment',
                  threadId: 'th-labels-e2e',
                  subject: 'General Update',
                  from: 'Bob <bob@example.com>',
                  date: 'Mon, 19 Oct 2026 11:00:00 +0000',
                  plainTextBody: 'Please find chair cutsheet attached.',
                  inlineImages: [],
                  attachments: [
                    {
                      partId: 'part-2',
                      attachmentId: 'att-2',
                      filename: 'CG104-A_Chair.pdf',
                      mimeType: 'application/pdf',
                      size: 2048,
                    },
                  ],
                  labels: ['Projects/123 Main St/Submittals', 'INBOX'],
                },
                {
                  id: 'msg-labeled-proposals',
                  threadId: 'th-labels-e2e',
                  subject: 'Discussion Notes',
                  from: 'Carol <carol@example.com>',
                  date: 'Mon, 19 Oct 2026 12:00:00 +0000',
                  plainTextBody: 'Review our opportunity pipeline.',
                  inlineImages: [],
                  attachments: [],
                  labels: ['Clients/Client Proposals/Opportunities', 'INBOX'],
                },
              ],
            };
          }
          return { id: threadId, messages: [] };
        });
      });

      it('infers projects DocumentSpace 123 Main St and submittal-arch from hierarchical Gmail label on card open', async () => {
        mockDocumentLogSearch({ sharedDriveId: 'drive-123', name: '123 Main St Document Log' });
        const res = await ctx.app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-labeled-submittal',
              threadId: 'th-labels-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const cardResponse = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const json = JSON.stringify(cardResponse);

        // Pre-populates 123 Main St and submittal-arch from label
        expect(json).toContain('123 Main St');
        expect(json).toContain('submittal-arch');
      });

      it('lets explicit FF&E code-bearing attachment win over generic Submittals label, selecting submittal-ffe', async () => {
        mockDocumentLogSearch({ sharedDriveId: 'drive-123', name: '123 Main St Document Log' });
        const res = await ctx.app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-labeled-ffe-attachment',
              threadId: 'th-labels-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const cardResponse = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const json = JSON.stringify(cardResponse);

        // Pre-populates 123 Main St (from label) and submittal-ffe (from attachment)
        expect(json).toContain('123 Main St');
        expect(json).toContain('submittal-ffe');
      });

      it('infers proposals DocumentSpace when proposal marker appears in Gmail label', async () => {
        const fetchSpacesSpy = vi.spyOn(ctx.mockStorageAdapter, 'fetchSpaces');
        fetchSpacesSpy.mockClear();

        const res = await ctx.app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-labeled-proposals',
              threadId: 'th-labels-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const cardResponse = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const json = JSON.stringify(cardResponse);

        // Pre-populates proposals space and communication-proposal
        expect(json).toContain('Client Proposals');
        expect(json).toContain('communication-proposal');
        expect(fetchSpacesSpy).toHaveBeenCalledWith(expect.anything(), 'proposals');
      });
    });

    describe('Gmail card-state cleansing and universal formEvaluator reactive evaluation (Ticket #301)', () => {
      beforeEach(() => {
        vi.spyOn(ctx.mockGmailClient, 'getThread').mockImplementation(async (threadId: string): Promise<GmailThreadDetails> => {
          if (threadId === 'th-cleansing-e2e') {
            return {
              id: 'th-cleansing-e2e',
              messages: [
                {
                  id: 'msg-1-cleansing',
                  threadId: 'th-cleansing-e2e',
                  subject: 'Message 1 Subject',
                  from: 'Alice <alice@example.com>',
                  date: 'Mon, 19 Oct 2026 10:00:00 +0000',
                  plainTextBody: 'Body 1',
                  inlineImages: [],
                  attachments: [],
                },
                {
                  id: 'msg-2-cleansing',
                  threadId: 'th-cleansing-e2e',
                  subject: 'Message 2 Subject',
                  from: 'Bob <bob@example.com>',
                  date: 'Mon, 19 Oct 2026 11:00:00 +0000',
                  plainTextBody: 'Body 2',
                  inlineImages: [],
                  attachments: [],
                },
              ],
            };
          }
          return { id: threadId, messages: [] };
        });
      });

      it('seeds default values (direction: "IN") on initial card render via universal formEvaluator', async () => {
        const res = await ctx.app.server.inject({
          method: 'POST',
          url: '/workspace/gmail-contextual',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            hostApp: 'GMAIL',
            gmail: {
              messageId: 'msg-1-cleansing',
              threadId: 'th-cleansing-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const card = body.action?.navigations?.[0]?.pushCard;
        const docInfoSec = card?.sections.find((s) => s.header === 'Document Data');
        const directionWidget = docInfoSec?.widgets.find(
          (w) => w.selectionInput?.name === getDocumentInfoWidgetName('direction', 'communication-project')
        )?.selectionInput;

        expect(directionWidget).toBeDefined();
        const selectedItem = directionWidget?.items?.find((item) => item.selected);
        expect(selectedItem?.value).toBe('IN');
      });

      it('purges prior document fields on onEmailMessageChange switching messages in a thread', async () => {
        const res = await ctx.app.server.inject({
          method: 'POST',
          url: '/workspace/on-form-change',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onEmailMessageChange',
                previousMessageId: 'msg-1-cleansing',
              },
              formInputs: {
                SelectEmailMessage: { stringInputs: { value: ['msg-2-cleansing'] } },
                SelectFileSource: { stringInputs: { value: ['Email Attachments'] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
                [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
                [getDocumentInfoWidgetName('description', 'communication-project')]: {
                  stringInputs: { value: ['Prior Message Description'] },
                },
                description: { stringInputs: { value: ['Prior Message Description'] } },
              },
            },
            gmail: {
              messageId: 'msg-1-cleansing',
              threadId: 'th-cleansing-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const cardJson = JSON.stringify(body);
        expect(cardJson).not.toContain('Prior Message Description');
      });

      it('preserves user document fields when switching SelectFileSource to Google Drive URL with blank InputDriveURL', async () => {
        const res = await ctx.app.server.inject({
          method: 'POST',
          url: '/workspace/on-form-change',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onFileSourceChange',
                previousDriveUrl: '',
              },
              formInputs: {
                SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
                InputDriveURL: { stringInputs: { value: [''] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
                [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
                [getDocumentInfoWidgetName('description', 'communication-project')]: {
                  stringInputs: { value: ['User In Progress Notes'] },
                },
              },
            },
            gmail: {
              messageId: 'msg-1-cleansing',
              threadId: 'th-cleansing-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const docInfoSec = body.action?.navigations?.[0]?.updateCard?.sections.find((s) => s.header === 'Document Data');
        const descWidget = docInfoSec?.widgets.find(
          (w) => w.textInput?.name === getDocumentInfoWidgetName('description', 'communication-project')
        )?.textInput;
        expect(descWidget?.value).toBe('User In Progress Notes');
      });

      it('purges prior document fields when InputDriveURL transitions to a valid Google Drive URL', async () => {
        const driveUrl = 'https://drive.google.com/file/d/drive-cleansing-file/view';
        const res = await ctx.app.server.inject({
          method: 'POST',
          url: '/workspace/on-form-change',
          headers: { authorization: 'Bearer valid-jwt-token' },
          payload: {
            commonEventObject: {
              hostApp: 'GMAIL',
              parameters: {
                action: 'onFormChange',
                previousDriveUrl: '',
              },
              formInputs: {
                SelectFileSource: { stringInputs: { value: ['Google Drive URL'] } },
                InputDriveURL: { stringInputs: { value: [driveUrl] } },
                SelectDocumentSpaceType: { stringInputs: { value: ['projects'] } },
                [getDocumentSpaceWidgetName('projects')]: { stringInputs: { value: ['Active Projects'] } },
                [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
                [getDocumentInfoWidgetName('description', 'communication-project')]: {
                  stringInputs: { value: ['User In Progress Notes'] },
                },
              },
            },
            gmail: {
              messageId: 'msg-1-cleansing',
              threadId: 'th-cleansing-e2e',
              accessToken: 'ya29.live-token',
            },
          },
        });

        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.payload) as GoogleWorkspaceActionResponse;
        const cardJson = JSON.stringify(body);
        expect(cardJson).not.toContain('User In Progress Notes');
      });
    });
  });
});
