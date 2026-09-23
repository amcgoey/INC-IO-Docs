import { describe, it, expect, vi } from 'vitest';
import { createHttpServer } from '../src/infrastructure/http';
import {
  registerWorkspaceAddonRoutes,
  type WorkspaceAuthVerifierPort,
} from '../src/infrastructure/workspace-addon/api';
import { evaluateFormChange } from '../src/infrastructure/workspace-addon/json-logic-evaluator';
import {
  WorkspaceAddonAdapter,
  type UiProcessRenderResult,
} from '../src/features/ui-process-manager';
import type { WorkspaceExecutionContext } from '../src/infrastructure/workspace-addon/context';

describe('Integration: JSON Logic Evaluation (onFormChange)', () => {
  it('tests onFormChange handler in isolation to ensure it correctly executes computeEvaluationOrder for partial roundtrips', async () => {
    const server = createHttpServer();

    const mockAuthVerifier: WorkspaceAuthVerifierPort = {
      verifyToken: vi.fn().mockResolvedValue({ isValid: true, payload: { email: 'user@example.com' } }),
    };

    let capturedResult: UiProcessRenderResult | undefined;


    // Provide a manifest with a dependency DAG:
    // grandTotal depends on tax and subtotal; tax depends on subtotal.
    // Kahn's algorithm in computeEvaluationOrder must evaluate subtotal -> tax -> grandTotal
    const mockManifestProvider = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: {
          'invoice-doc': {
            documentSchema: {
              fields: [
                { key: 'quantity', type: 'number' },
                { key: 'unitPrice', type: 'number' },
                { key: 'subtotal', type: 'number' },
                { key: 'tax', type: 'number' },
                { key: 'grandTotal', type: 'number' },
                { key: 'taxExemptNotes', type: 'string' },
              ],
            },
            documentUiSchema: {
              layout: ['quantity', 'unitPrice', 'subtotal', 'tax', 'grandTotal', 'taxExemptNotes'],
              fields: {
                subtotal: {
                  computeValue: {
                    '*': [{ var: 'data.quantity' }, { var: 'data.unitPrice' }],
                  },
                },
                tax: {
                  computeValue: {
                    '*': [{ var: 'data.subtotal' }, 0.1],
                  },
                },
                grandTotal: {
                  computeValue: {
                    '+': [{ var: 'data.subtotal' }, { var: 'data.tax' }],
                  },
                },
                taxExemptNotes: {
                  showIf: { '==': [{ var: 'data.tax' }, 0] },
                },
              },
            },
          },
        },
      }),
    };

    const adapter = new WorkspaceAddonAdapter({
      spaceProvider: { getAllTypes: () => [], getCollection: async () => ({ spaces: [] }) },
      formEvaluator: {
        evaluate: async (formData) => {
          const raw = await mockManifestProvider.getRawManifest();
          const docDef = raw.documentTypes['invoice-doc'];
          return evaluateFormChange(formData, docDef.documentSchema, docDef.documentUiSchema);
        },
      },
    });

    const uiOrchestrator = {
      async processUiEvent(context: WorkspaceExecutionContext) {
        const result = await adapter.processUiEvent(context);
        if (result.type === 'render') {
          capturedResult = result;
        }
        return {
          action: {
            navigations: [
              {
                updateCard: {
                  header: { title: 'INC-IO Engine', subtitle: 'Process Document' },
                  sections: [],
                },
              },
            ],
          },
        };
      },
    };

    registerWorkspaceAddonRoutes(server, {
      authVerifier: mockAuthVerifier,
      uiOrchestrator,
    });

    const response = await server.inject({
      method: 'POST',
      url: '/workspace/on-form-change',
      headers: {
        authorization: 'Bearer valid-token',
      },
      payload: {
        commonEventObject: {
          formInputs: {
            SelectDocumentType: { stringInputs: { value: ['invoice-doc'] } },
            quantity: { stringInputs: { value: ['5'] } },
            unitPrice: { stringInputs: { value: ['20'] } },
          },
          parameters: {
            action: 'onFormChange',
          },
        },
      },
    });

    expect(response.statusCode).toBe(200);

    expect(capturedResult).toBeDefined();
    expect(capturedResult?.isUpdateCard).toBe(true);
    expect(capturedResult?.documentTypeKey).toBe('invoice-doc');

    // Assert computed values:
    // quantity=5, unitPrice=20 -> subtotal=100 -> tax=10 -> grandTotal=110
    expect(capturedResult?.formData).toEqual({
      SelectDocumentType: 'invoice-doc',
      quantity: '5',
      unitPrice: '20',
      subtotal: 100,
      tax: 10,
      grandTotal: 110,
    });

    // Assert JSON Logic showIf evaluation:
    // tax is 10 (!= 0), so taxExemptNotes should be hidden
    expect(capturedResult?.hiddenFields).toContain('taxExemptNotes');
  });
});
