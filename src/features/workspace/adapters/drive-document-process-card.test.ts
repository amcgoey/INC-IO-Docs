import { describe, it, expect, vi } from 'vitest';
import { buildDriveDocumentProcessCard } from './drive-document-process-card';
import type { WorkspaceUiBuilderPort } from './ui-builder';

describe('buildDriveDocumentProcessCard', () => {
  it('builds card using injected uiBuilder with fallback title and default message when config is undefined', () => {
    const mockCard = {
      header: { title: 'INC-IO Engine', subtitle: 'Process Document' },
      sections: [{ widgets: [{ textParagraph: { text: 'Processing selected items...' } }] }],
    };
    const mockUiBuilder: WorkspaceUiBuilderPort = {
      buildTitleBlock: vi.fn().mockReturnValue({ title: 'INC-IO Engine', subtitle: 'Process Document' }),
      buildStatusMessageBlock: vi.fn().mockReturnValue({ widgets: [{ textParagraph: { text: 'Processing selected items...' } }] }),
      buildCard: vi.fn().mockReturnValue(mockCard),
      buildNavigationAction: vi.fn().mockReturnValue({ action: { navigations: [{ pushCard: mockCard }] } }),
      buildErrorCard: vi.fn(),
    };

    const result = buildDriveDocumentProcessCard(undefined, undefined, mockUiBuilder);

    expect(mockUiBuilder.buildTitleBlock).toHaveBeenCalledWith({
      title: 'INC-IO Engine',
      subtitle: 'Process Document',
    });
    expect(mockUiBuilder.buildStatusMessageBlock).toHaveBeenCalledWith('Processing selected items...', true);
    expect(mockUiBuilder.buildCard).toHaveBeenCalledWith(
      { title: 'INC-IO Engine', subtitle: 'Process Document' },
      [{ widgets: [{ textParagraph: { text: 'Processing selected items...' } }] }]
    );
    expect(mockUiBuilder.buildNavigationAction).toHaveBeenCalledWith(mockCard);
    expect(result).toEqual({ action: { navigations: [{ pushCard: mockCard }] } });
  });

  it('builds card using custom appTitle and defaultDocumentType from configuration', () => {
    const mockCard = {
      header: { title: 'Enterprise Portal', subtitle: 'Process Document' },
      sections: [{ widgets: [{ textParagraph: { text: 'Current DocumentType: invoice-spec' } }] }],
    };
    const mockUiBuilder: WorkspaceUiBuilderPort = {
      buildTitleBlock: vi.fn().mockReturnValue({ title: 'Enterprise Portal', subtitle: 'Process Document' }),
      buildStatusMessageBlock: vi.fn().mockReturnValue({ widgets: [{ textParagraph: { text: 'Current DocumentType: invoice-spec' } }] }),
      buildCard: vi.fn().mockReturnValue(mockCard),
      buildNavigationAction: vi.fn().mockReturnValue({ action: { navigations: [{ pushCard: mockCard }] } }),
      buildErrorCard: vi.fn(),
    };

    const config = {
      appTitle: 'Enterprise Portal',
      defaultDocumentType: 'invoice-spec',
    };

    const selectedItems = [{ id: 'drive-file-1', title: 'Invoice.pdf' }];

    const result = buildDriveDocumentProcessCard(selectedItems, config, mockUiBuilder);

    expect(mockUiBuilder.buildTitleBlock).toHaveBeenCalledWith({
      title: 'Enterprise Portal',
      subtitle: 'Process Document',
    });
    expect(mockUiBuilder.buildStatusMessageBlock).toHaveBeenCalledWith(
      'Current DocumentType: invoice-spec',
      true
    );
    expect(result).toEqual({ action: { navigations: [{ pushCard: mockCard }] } });
  });
});
