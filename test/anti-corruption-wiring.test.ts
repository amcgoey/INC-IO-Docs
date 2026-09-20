import { describe, it, expect, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  createSchemaDrivenUiWiring,
  type RawManifestProviderPort,
} from '../src/app/schema-driven-ui.wiring';
import { wireWorkspaceAddonRoutes } from '../src/app/workspace-addon.wiring';
import type { HttpServer, RouteDefinition } from '../src/infrastructure/http';
import type { DocumentService } from '../src/features/document/domain';
import { translateUiViewToNavigationAction } from '../src/infrastructure/workspace-addon/translator';
import { GoogleWorkspaceActionResponseSchema } from '../src/infrastructure/workspace-addon/ui-blocks';

describe('Anti-Corruption Wiring Integration', () => {
  const mockManifestProvider: RawManifestProviderPort = {
    getRawManifest: vi.fn().mockResolvedValue({
      documentTypes: ['./contract-doc.json'],
    }),
    readParsedSchema: vi.fn().mockImplementation(async (relPath: string) => {
      if (relPath === './contract-doc.json') {
        return {
          key: 'contract-doc',
          name: 'Contract Document',
          documentSchema: {
            fields: [
              { key: 'title', type: 'string', required: true },
              { key: 'amount', type: 'number' },
            ],
          },
          documentUiSchema: {
            layout: ['title', 'amount'],
            fields: {
              title: { widget: 'textInput', label: 'Contract Title' },
              amount: { widget: 'textInput', label: 'Total Amount' },
            },
          },
        };
      }
      return undefined;
    }),
  };

  it('wires SchemaDrivenUiService with driven Manifest adapter and workspace addon adapter', async () => {
    const wiring = createSchemaDrivenUiWiring({
      manifestProvider: mockManifestProvider,
    });

    expect(wiring.schemaDrivenUiService).toBeDefined();
  });

  it('resolves schema-driven-ui read ports and translates to GoogleWorkspaceActionResponse without leaking types', async () => {
    const wiring = createSchemaDrivenUiWiring({
      manifestProvider: mockManifestProvider,
    });

    const view = await wiring.schemaDrivenUiService.generateView({
      viewId: 'drive-document-process-card',
      documentTypeKey: 'contract-doc',
      selectionState: {
        spaceTypes: [{ text: 'Legal', value: 'legal', selected: true }],
        spaces: ['Corp Contracts'],
        documentTypes: [{ text: 'Contract Document', value: 'contract-doc', selected: true }],
      },
      validationErrors: ['Title cannot be empty'],
    });
    const actionResponse = translateUiViewToNavigationAction(view);

    // 1. Verify that the output satisfies the infrastructure-defined Google Workspace Action Response schema
    expect(Value.Check(GoogleWorkspaceActionResponseSchema, actionResponse)).toBe(true);
    const typedResponse = actionResponse as import('../src/infrastructure/workspace-addon/ui-blocks').GoogleWorkspaceActionResponse;

    // 2. Verify all 4 blocks are represented in the translated sections
    expect(typedResponse.action?.navigations).toBeDefined();
    const pushCard = typedResponse.action!.navigations![0].pushCard!;
    expect(pushCard).toBeDefined();
    expect(pushCard.header.title).toBe('INC-IO Engine');
    expect(pushCard.header.subtitle).toBe('Process Document');


    // Section 1: Status message (validation errors)
    expect(pushCard.sections[0].widgets[0].textParagraph?.text).toContain('Title cannot be empty');

    // Section 2: Document type selection
    expect(pushCard.sections[1].header).toBe('Document Type');
    expect(pushCard.sections[1].widgets[0].selectionInput?.name).toBe('SelectDocumentSpaceType');


    // Section 3: Document data
    expect(pushCard.sections[2].header).toBe('Document Data');
    expect(pushCard.sections[2].widgets).toHaveLength(2);
    expect(pushCard.sections[2].widgets[0].textInput?.name).toBe('title');
    expect(pushCard.sections[2].widgets[0].textInput?.label).toBe('Contract Title');
    expect(pushCard.sections[2].widgets[1].textInput?.name).toBe('amount');
    expect(pushCard.sections[2].widgets[1].textInput?.label).toBe('Total Amount');

    // Section 4: Document Space Admin
    expect(pushCard.sections[3].header).toBe('Admin');
    expect(pushCard.sections[3].collapsible).toBe(true);
  });

  it('wires processCardOrchestrator in wireWorkspaceAddonRoutes to resolve schema-driven-ui pipeline without leaking types', async () => {
    const routes: RouteDefinition[] = [];
    const mockServer = {
      registerRoute: (route: RouteDefinition) => {
        routes.push(route);
      },
    } as unknown as HttpServer;

    wireWorkspaceAddonRoutes({
      server: mockServer,
      manifestProvider: mockManifestProvider,
      documentService: {} as unknown as DocumentService,
      configProvider: {
        getWorkspaceConfig: vi.fn().mockResolvedValue({
          defaultDocumentType: 'contract-doc',
        }),
      },
      authVerifier: {
        verifyToken: vi.fn().mockResolvedValue({
          isValid: true,
          payload: { email: 'test@example.com' },
        }),
      },
    });

    const route = routes.find((r) => r.url === '/workspace/drive-items-selected');
    expect(route).toBeDefined();

    const response = await route!.handler({
      headers: { authorization: 'Bearer valid-token' },
      body: {
        authorizationEventObject: {
          userOAuthToken: 'ya29.sample-token',
        },
        drive: {
          selectedItems: [{ id: 'drive-123', title: 'Contract Document' }],
        },
      },
    });

    expect(response.status).toBe(200);
    expect(Value.Check(GoogleWorkspaceActionResponseSchema, response.body)).toBe(true);
    const body = response.body as { action: { navigations: Array<{ pushCard: { header: { title: string } } }> } };
    expect(body.action.navigations[0].pushCard.header.title).toBe('INC-IO Engine');
  });
});
