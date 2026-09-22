import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { createApp, type AppInstance } from '../src/app/server';
import { injectWorkspaceRequest } from './e2e/utils/workspace-request';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import type { WorkspaceAuthVerifierPort } from '../src/infrastructure/workspace-addon/api';
import { GoogleWorkspaceActionResponseSchema } from '../src/infrastructure/workspace-addon/ui-blocks';
import {
  getDocumentTypeWidgetName,
  getDocumentSpaceWidgetName,
} from '../src/features/schema-driven-ui/blocks/document-type-selection';
import { getDocumentInfoWidgetName } from '../src/features/schema-driven-ui/blocks/document-info';

describe('E2E Tracer Bullet: DriveDocumentProcessCard', () => {
  let app: AppInstance;
  let mockAuthVerifier: WorkspaceAuthVerifierPort;

  beforeEach(async () => {
    mockAuthVerifier = {
      verifyToken: vi.fn().mockImplementation(async (header?: string) => {
        if (header && header.startsWith('Bearer valid-')) {
          return {
            isValid: true,
            payload: { email: 'test-user@example.com', sub: 'user-123' },
          };
        }
        return {
          isValid: false,
          error: 'Invalid ID token',
        };
      }),
    };

    const manifestPath = path.resolve(__dirname, '../assets/manifest.json');
    const manifestProvider = new AppManifestProvider({ manifestPath });
    app = createApp({
      manifestProvider,
      authVerifier: mockAuthVerifier,
      skipSpaceValidation: true,
    });

    await app.initialize();
  });

  it('completes the full request/response lifecycle from drive trigger to schema-driven process card', async () => {
    const rawTriggerPayload = {
      authorizationEventObject: {
        userOAuthToken: 'ya29.sample-token',
      },
      drive: {
        selectedItems: [
          {
            id: 'drive-file-999',
            title: 'Q3_Financial_Review.pdf',
          },
        ],
      },
    };

    const response = await injectWorkspaceRequest(app.server, {
      method: 'POST',
      url: '/workspace/drive-items-selected',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: rawTriggerPayload,
    });

    expect(response.statusCode).toBe(200);

    const body = JSON.parse(response.payload);

    // 1. Verify response conforms to Google Workspace Action Response contract
    expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
    expect(body.action?.navigations).toBeDefined();

    const pushCard = body.action!.navigations![0].pushCard;
    expect(pushCard).toBeDefined();

    expect(pushCard.header.title).toBe('INC-IO Engine');
    expect(pushCard.header.subtitle).toBe('Process Document');

    const sections = pushCard.sections;

    // Block 1: Document Type Selection Block
    const docTypeSection = sections.find(
      (s: { header?: string }) => s.header === 'Document Type'
    );
    expect(docTypeSection).toBeDefined();
    expect(docTypeSection.widgets).toHaveLength(3);
    expect(docTypeSection.widgets[0].selectionInput?.name).toBe('SelectDocumentSpaceType');
    expect(docTypeSection.widgets[1].textInput?.name).toBe(getDocumentSpaceWidgetName('projects'));
    expect(docTypeSection.widgets[2].selectionInput?.name).toBe(getDocumentTypeWidgetName('projects'));

    // Block 2: Document Info Block (rendered from communication-project.json)
    const docInfoSection = sections.find(
      (s: { header?: string }) => s.header === 'Document Data'
    );
    expect(docInfoSection).toBeDefined();
    const fieldNames = docInfoSection.widgets.map(
      (w: { textInput?: { name: string }; selectionInput?: { name: string } }) =>
        w.textInput?.name ?? w.selectionInput?.name
    );
    expect(fieldNames).toContain(
      getDocumentInfoWidgetName('contact', 'communication-project')
    );
    expect(fieldNames).toContain(
      getDocumentInfoWidgetName('date', 'communication-project')
    );
    expect(fieldNames).toContain(
      getDocumentInfoWidgetName('direction', 'communication-project')
    );
    expect(fieldNames).toContain(
      getDocumentInfoWidgetName('description', 'communication-project')
    );

    // Block 3: Document Admin Block
    const adminSection = sections.find(
      (s: { header?: string }) => s.header === 'Admin'
    );
    expect(adminSection).toBeDefined();
    expect(adminSection.collapsible).toBe(true);
  });



  it('supports the Status Message Block when validation errors are present in trigger parameters', async () => {
    const rawTriggerWithErrors = {
      commonEventObject: {
        parameters: {
          validationErrors: JSON.stringify(['Title cannot be empty', 'Date format must be yyMMdd']),
        },
      },
      drive: {
        selectedItems: [
          {
            id: 'drive-file-999',
            title: 'Q3_Financial_Review.pdf',
          },
        ],
      },
    };

    const response = await injectWorkspaceRequest(app.server, {
      method: 'POST',
      url: '/workspace/drive-items-selected',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: rawTriggerWithErrors,
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(Value.Check(GoogleWorkspaceActionResponseSchema, body)).toBe(true);
    expect(body.action?.navigations).toBeDefined();

    const pushCard = body.action!.navigations![0].pushCard;
    // Section 0: Status Message Block
    expect(pushCard.sections[0].widgets[0].textParagraph?.text).toContain('Title cannot be empty');
    expect(pushCard.sections[0].widgets[0].textParagraph?.text).toContain('Date format must be yyMMdd');

    // All other blocks remain present
    expect(pushCard.sections[1].header).toBe('Document Type');
    expect(pushCard.sections[2].header).toBe('Document Data');
    expect(pushCard.sections[3].header).toBe('Admin');
  });

  it('renders schema-driven process card on /workspace/homepage trigger', async () => {
    const response = await injectWorkspaceRequest(app.server, {
      method: 'POST',
      url: '/workspace/homepage',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.payload);
    expect(body.action?.navigations).toBeDefined();
    expect(body.action.navigations[0].pushCard.header.title).toBe('INC-IO Engine');
    expect(body.action.navigations[0].pushCard.sections.length).toBeGreaterThanOrEqual(1);
  });

  it('interaction loop: programmatically navigates cascading dropdowns and form changes via simulated JSON Logic roundtrips', async () => {
    // 1. Initial trigger
    const initialResponse = await injectWorkspaceRequest(app.server, {
      method: 'POST',
      url: '/workspace/drive-items-selected',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: {
        drive: {
          selectedItems: [{ id: 'drive-file-999', title: 'Q3_Financial_Review.pdf' }],
        },
      },
    });
    expect(initialResponse.statusCode).toBe(200);

    // 2. Simulate onFormChange roundtrip 1: user selects direction 'Outgoing' ('OT')
    // Dynamic rule: incomingNotes showIf: { '==': [{ var: 'data.direction' }, 'IN'] }
    // When direction is 'OT', incomingNotes must be dynamically hidden.
    const changeResponse1 = await injectWorkspaceRequest(app.server, {
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: {
        commonEventObject: {
          parameters: {
            action: 'onFormChange',
          },
          formInputs: {
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
            [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['John Doe'] } },
            [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['OT'] } },
          },
        },
        drive: {
          selectedItems: [{ id: 'drive-file-999', title: 'Q3_Financial_Review.pdf' }],
        },
      },
    });

    expect(changeResponse1.statusCode).toBe(200);
    const changeBody1 = JSON.parse(changeResponse1.payload);
    expect(Value.Check(GoogleWorkspaceActionResponseSchema, changeBody1)).toBe(true);

    const updateCard1 = changeBody1.action.navigations[0].updateCard;
    expect(updateCard1).toBeDefined();

    const dataSection1 = updateCard1.sections.find(
      (s: { header?: string }) => s.header === 'Document Data'
    );
    expect(dataSection1).toBeDefined();

    // Verify incomingNotes is dynamically hidden when direction === 'OT'
    const notesWidget1 = dataSection1.widgets.find(
      (w: { textInput?: { name: string } }) =>
        w.textInput?.name === getDocumentInfoWidgetName('incomingNotes', 'communication-project')
    );
    expect(notesWidget1).toBeUndefined();

    // 3. Simulate onFormChange roundtrip 2: user toggles cascading dropdown direction to 'Incoming' ('IN')
    // Dynamic rule evaluates: incomingNotes showIf evaluates to true, revealing the field!
    const changeResponse2 = await injectWorkspaceRequest(app.server, {
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: {
        commonEventObject: {
          parameters: {
            action: 'onFormChange',
          },
          formInputs: {
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
            [getDocumentInfoWidgetName('contact', 'communication-project')]: { stringInputs: { value: ['John Doe'] } },
            [getDocumentInfoWidgetName('direction', 'communication-project')]: { stringInputs: { value: ['IN'] } },
            [getDocumentInfoWidgetName('incomingNotes', 'communication-project')]: {
              stringInputs: { value: ['Follow up with legal'] },
            },
          },
        },
        drive: {
          selectedItems: [{ id: 'drive-file-999', title: 'Q3_Financial_Review.pdf' }],
        },
      },
    });

    expect(changeResponse2.statusCode).toBe(200);
    const changeBody2 = JSON.parse(changeResponse2.payload);
    const updateCard2 = changeBody2.action.navigations[0].updateCard;
    const dataSection2 = updateCard2.sections.find(
      (s: { header?: string }) => s.header === 'Document Data'
    );

    // Verify incomingNotes is dynamically rendered when direction === 'IN'
    const notesWidget2 = dataSection2.widgets.find(
      (w: { textInput?: { name: string } }) =>
        w.textInput?.name === getDocumentInfoWidgetName('incomingNotes', 'communication-project')
    );
    expect(notesWidget2).toBeDefined();

    // Verify cascading dropdown selected states are maintained correctly
    const directionWidget2 = dataSection2.widgets.find(
      (w: { selectionInput?: { name: string } }) =>
        w.selectionInput?.name === getDocumentInfoWidgetName('direction', 'communication-project')
    );
    expect(directionWidget2?.selectionInput).toBeDefined();
    const incomingItem = directionWidget2?.selectionInput?.items.find(
      (item: { value: string }) => item.value === 'IN'
    );
    expect(incomingItem?.selected).toBe(true);

    // 4. Simulate onFormChange roundtrip 3: user changes the Document Space Type cascading selection dropdown to 'proposals'
    const changeResponse3 = await injectWorkspaceRequest(app.server, {
      method: 'POST',
      url: '/workspace/action',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: {
        commonEventObject: {
          parameters: {
            action: 'onSpaceTypeChange',
          },
          formInputs: {
            SelectDocumentSpaceType: { stringInputs: { value: ['proposals'] } },
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
          },
        },
        drive: {
          selectedItems: [{ id: 'drive-file-999', title: 'Q3_Financial_Review.pdf' }],
        },
      },
    });

    expect(changeResponse3.statusCode).toBe(200);
    const changeBody3 = JSON.parse(changeResponse3.payload);
    const updateCard3 = changeBody3.action.navigations[0].updateCard;
    const docTypeSection3 = updateCard3.sections.find(
      (s: { header?: string }) => s.header === 'Document Type'
    );
    const spaceTypeWidget3 = docTypeSection3.widgets.find(
      (w: { selectionInput?: { name: string } }) => w.selectionInput?.name === 'SelectDocumentSpaceType'
    );
    const selectedSpaceType = spaceTypeWidget3?.selectionInput?.items.find(
      (item: { value: string }) => item.value === 'proposals'
    );
    expect(selectedSpaceType?.selected).toBe(true);

    const docTypeWidget3 = docTypeSection3.widgets.find(
      (w: { selectionInput?: { name: string } }) => w.selectionInput?.name === getDocumentTypeWidgetName('proposals')
    );
    const selectedProposalItem = docTypeWidget3?.selectionInput?.items.find(
      (item: { value: string }) => item.value === 'communication-proposal'
    );
    expect(selectedProposalItem?.selected).toBe(true);
  });

  it('mutation & error rendering: drives flow to final Process submission testing both failure and success paths', async () => {
    // 1. Failure Path: submitting with invalid / incomplete document data renders validation errors inline
    const failureResponse = await injectWorkspaceRequest(app.server, {
      method: 'POST',
      url: '/workspace/action',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: {
        commonEventObject: {
          parameters: {
            action: 'processDocument',
          },
          formInputs: {
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
            // contact, date, direction, description are required but missing
          },
        },
        drive: {
          selectedItems: [{ id: 'drive-file-999', title: 'Q3_Financial_Review.pdf' }],
        },
      },
    });

    expect(failureResponse.statusCode).toBe(200);
    const failureBody = JSON.parse(failureResponse.payload);
    expect(Value.Check(GoogleWorkspaceActionResponseSchema, failureBody)).toBe(true);

    // Assert that validationErrors re-render inline error messages via Status Message Block
    const errorCard = failureBody.action.navigations[0].updateCard ?? failureBody.action.navigations[0].pushCard;
    expect(errorCard).toBeDefined();
    const statusSection = errorCard.sections.find(
      (s: { widgets: Array<{ textParagraph?: { text: string } }> }) =>
        s.widgets?.[0]?.textParagraph?.text?.includes('failed') ||
        s.widgets?.[0]?.textParagraph?.text?.includes('validation') ||
        s.widgets?.[0]?.textParagraph?.text?.includes('required')
    );
    expect(statusSection).toBeDefined();

    // 2. Success Path: submitting with valid document data routes to domain and returns success notification
    const successResponse = await injectWorkspaceRequest(app.server, {
      method: 'POST',
      url: '/workspace/action',
      headers: {
        authorization: 'Bearer valid-jwt-token',
      },
      payload: {
        commonEventObject: {
          parameters: {
            action: 'processDocument',
          },
          formInputs: {
            [getDocumentTypeWidgetName('projects')]: { stringInputs: { value: ['communication-project'] } },
            contact: { stringInputs: { value: ['Acme Corp'] } },
            date: { stringInputs: { value: ['260920'] } },
            direction: { stringInputs: { value: ['IN'] } },
            description: { stringInputs: { value: ['Project Kickoff'] } },
          },
        },
        drive: {
          selectedItems: [{ id: 'drive-file-999', title: 'Q3_Financial_Review.pdf' }],
        },
      },
    });

    expect(successResponse.statusCode).toBe(200);
    const successBody = JSON.parse(successResponse.payload);
    expect(successBody.action?.notification?.text).toBe('Document processed successfully');
  });
});


