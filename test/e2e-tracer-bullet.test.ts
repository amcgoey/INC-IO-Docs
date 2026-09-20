import * as path from 'node:path';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { createApp, type AppInstance } from '../src/app/server';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import type { AuthVerifierPort, AuthVerificationResult } from '../src/features/workspace/ports';
import { GoogleWorkspaceActionResponseSchema } from '../src/infrastructure/workspace-addon/ui-blocks';



describe('E2E Tracer Bullet: DriveDocumentProcessCard', () => {
  let app: AppInstance;
  let mockAuthVerifier: AuthVerifierPort;

  beforeEach(async () => {
    mockAuthVerifier = {
      verifyToken: vi.fn().mockImplementation(async (header?: string): Promise<AuthVerificationResult> => {
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

    const response = await app.server.inject({
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
    expect(docTypeSection.widgets[1].textInput?.name).toBe('SelectDocumentSpace');
    expect(docTypeSection.widgets[2].selectionInput?.name).toBe('SelectDocumentType');

    // Block 2: Document Info Block (rendered from communication-project.json)
    const docInfoSection = sections.find(
      (s: { header?: string }) => s.header === 'Document Data'
    );
    expect(docInfoSection).toBeDefined();
    const fieldNames = docInfoSection.widgets.map(
      (w: { textInput?: { name: string }; selectionInput?: { name: string } }) =>
        w.textInput?.name ?? w.selectionInput?.name
    );
    expect(fieldNames).toContain('contact');
    expect(fieldNames).toContain('date');
    expect(fieldNames).toContain('direction');
    expect(fieldNames).toContain('description');

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

    const response = await app.server.inject({
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

  it('leaves other flows untouched by continuing to use legacy card builder on /workspace/homepage trigger', async () => {
    const response = await app.server.inject({
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
    // Legacy builder retains INC-IO Docs title and only renders Document Type section
    expect(body.action.navigations[0].pushCard.header.title).toBe('INC-IO Docs');
    expect(body.action.navigations[0].pushCard.sections).toHaveLength(1);
    expect(body.action.navigations[0].pushCard.sections[0].header).toBe('Document Type');
  });
});


