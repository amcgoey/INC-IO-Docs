import { describe, it, expect, vi } from 'vitest';
import { createHttpServer } from '../src/infrastructure/http';
import {
  registerWorkspaceAddonRoutes,
  type WorkspaceAuthVerifierPort,
  type WorkspaceProcessCardOrchestratorPort,
  type WorkspaceProcessCardRequest,
} from '../src/infrastructure/workspace-addon/api';
import { evaluateFormChange } from '../src/infrastructure/workspace-addon/json-logic-evaluator';

describe('Integration: JSON Logic Evaluation (onFormChange)', () => {
  it('tests onFormChange handler in isolation to ensure it correctly executes computeEvaluationOrder for partial roundtrips', async () => {
    const server = createHttpServer();

    const mockAuthVerifier: WorkspaceAuthVerifierPort = {
      verifyToken: vi.fn().mockResolvedValue({ isValid: true, payload: { email: 'user@example.com' } }),
    };

    let capturedRequest: WorkspaceProcessCardRequest | undefined;
    const mockOrchestrator: WorkspaceProcessCardOrchestratorPort = {
      generateCard: vi.fn().mockImplementation(async (request) => {
        capturedRequest = request;
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
      }),
    };

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

    registerWorkspaceAddonRoutes(server, {
      authVerifier: mockAuthVerifier,
      processCardOrchestrator: mockOrchestrator,
      manifestProvider: mockManifestProvider,
      evaluateFormChange,
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
    expect(mockOrchestrator.generateCard).toHaveBeenCalledTimes(1);
    expect(capturedRequest).toBeDefined();
    expect(capturedRequest?.isUpdateCard).toBe(true);
    expect(capturedRequest?.documentTypeKey).toBe('invoice-doc');

    // Assert computed values:
    // quantity=5, unitPrice=20 -> subtotal=100 -> tax=10 -> grandTotal=110
    expect(capturedRequest?.formData).toEqual({
      SelectDocumentType: 'invoice-doc',
      quantity: '5',
      unitPrice: '20',
      subtotal: 100,
      tax: 10,
      grandTotal: 110,
    });

    // Assert JSON Logic showIf evaluation:
    // tax is 10 (!= 0), so taxExemptNotes should be hidden
    expect(capturedRequest?.hiddenFields).toContain('taxExemptNotes');
  });
});
