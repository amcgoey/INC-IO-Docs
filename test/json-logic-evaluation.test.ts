import { describe, it, expect, vi } from 'vitest';
import { createHttpServer } from '../src/infrastructure/http';
import { registerWorkspaceFeatureRoutes } from '../src/features/workspace/adapters/api';
import type {
  AuthVerifierPort,
  WorkspaceProcessCardOrchestratorPort,
} from '../src/features/workspace/ports';

describe('Integration: JSON Logic Evaluation (onFormChange)', () => {
  it('tests onFormChange handler in isolation to ensure it correctly executes computeEvaluationOrder for partial roundtrips', async () => {
    const server = createHttpServer();

    const mockAuthVerifier: AuthVerifierPort = {
      verifyToken: vi.fn().mockResolvedValue({ isValid: true, payload: { email: 'user@example.com' } }),
    };

    let capturedRequest: import('../src/features/workspace/ports').WorkspaceProcessCardRequest | undefined;
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
                { key: 'quantity', defaultValue: 2 },
                { key: 'unitPrice', defaultValue: 50 },
                { key: 'subtotal' },
                { key: 'tax' },
                { key: 'grandTotal' },
                { key: 'taxExemptNotes' },
              ],
            },
            documentUiSchema: {
              layout: ['quantity', 'unitPrice', 'subtotal', 'tax', 'grandTotal', 'taxExemptNotes'],
              fields: {
                grandTotal: {
                  computeValue: { '+': [{ var: 'data.subtotal' }, { var: 'data.tax' }] },
                },
                tax: {
                  computeValue: { '*': [{ var: 'data.subtotal' }, 0.1] },
                },
                subtotal: {
                  computeValue: { '*': [{ var: 'data.quantity' }, { var: 'data.unitPrice' }] },
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

    registerWorkspaceFeatureRoutes(server, {
      authVerifier: mockAuthVerifier,
      uiBuilder: {} as unknown as import('../src/features/workspace/ports').WorkspaceUiBuilderPort,
      processCardOrchestrator: mockOrchestrator,
      manifestProvider: mockManifestProvider,
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
    const body = JSON.parse(response.payload);
    expect(body.action?.navigations?.[0]?.updateCard).toBeDefined();

    // Verify computeEvaluationOrder executed correctly in topological sequence:
    // subtotal = 5 * 20 = 100
    // tax = 100 * 0.1 = 10
    // grandTotal = 100 + 10 = 110
    // taxExemptNotes should be in hiddenFields because tax !== 0
    expect(capturedRequest.formData.subtotal).toBe(100);
    expect(capturedRequest.formData.tax).toBe(10);
    expect(capturedRequest.formData.grandTotal).toBe(110);
    expect(capturedRequest.hiddenFields).toContain('taxExemptNotes');
    expect(capturedRequest.isUpdateCard).toBe(true);
  });
});
