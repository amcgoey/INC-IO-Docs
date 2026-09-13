import { describe, it, expect, vi } from 'vitest';
import { buildDriveDocumentProcessCard } from './drive-document-process-card';
import type { WorkspaceUiBuilderPort } from '../ports';

describe('buildDriveDocumentProcessCard', () => {
  it('builds card using injected uiBuilder with fallback title and no status message when options omitted', () => {
    const mockCard = {
      header: { title: 'INC-IO Engine', subtitle: 'Process Document' },
      sections: [{ header: 'Document Type', widgets: [] }],
    };
    const mockUiBuilder: WorkspaceUiBuilderPort = {
      buildTitleBlock: vi.fn().mockReturnValue({ title: 'INC-IO Engine', subtitle: 'Process Document' }),
      buildStatusMessageBlock: vi.fn().mockReturnValue(null),
      buildDocumentTypeSelectionBlock: vi.fn().mockReturnValue({ header: 'Document Type', widgets: [] }),
      buildCard: vi.fn().mockReturnValue(mockCard),
      buildNavigationAction: vi.fn().mockReturnValue({ action: { navigations: [{ pushCard: mockCard }] } }),
      buildErrorCard: vi.fn(),
    };

    const result = buildDriveDocumentProcessCard(undefined, undefined, mockUiBuilder);

    expect(mockUiBuilder.buildTitleBlock).toHaveBeenCalledWith({
      title: 'INC-IO Engine',
      subtitle: 'Process Document',
    });
    expect(mockUiBuilder.buildStatusMessageBlock).toHaveBeenCalledWith(undefined, false);
    expect(mockUiBuilder.buildDocumentTypeSelectionBlock).toHaveBeenCalledWith({
      selectionContext: {
        spaceTypes: [],
        spaces: [],
        documentTypes: [],
      },
      onSpaceTypeChangeAction: 'https://example.com/onSpaceTypeChange',
    });
    expect(mockUiBuilder.buildCard).toHaveBeenCalledWith(
      { title: 'INC-IO Engine', subtitle: 'Process Document' },
      [{ header: 'Document Type', widgets: [] }]
    );
    expect(mockUiBuilder.buildNavigationAction).toHaveBeenCalledWith(mockCard);
    expect(result).toEqual({ action: { navigations: [{ pushCard: mockCard }] } });
  });

  it('builds card with status message when provided in options', () => {
    const mockCard = {
      header: { title: 'Enterprise Portal', subtitle: 'Process Document' },
      sections: [
        { widgets: [{ textParagraph: { text: 'Processing selected items...' } }] },
        { header: 'Document Type', widgets: [] }
      ],
    };
    const mockUiBuilder: WorkspaceUiBuilderPort = {
      buildTitleBlock: vi.fn().mockReturnValue({ title: 'Enterprise Portal', subtitle: 'Process Document' }),
      buildStatusMessageBlock: vi.fn().mockReturnValue({ widgets: [{ textParagraph: { text: 'Processing selected items...' } }] }),
      buildDocumentTypeSelectionBlock: vi.fn().mockReturnValue({ header: 'Document Type', widgets: [] }),
      buildCard: vi.fn().mockReturnValue(mockCard),
      buildNavigationAction: vi.fn().mockReturnValue({ action: { navigations: [{ pushCard: mockCard }] } }),
      buildErrorCard: vi.fn(),
    };

    const config = {
      appTitle: 'Enterprise Portal',
    };

    const selectedItems = [{ id: 'drive-file-1', title: 'Invoice.pdf' }];
    const options = { statusMessage: 'Processing selected items...' };

    const result = buildDriveDocumentProcessCard(selectedItems, config, mockUiBuilder, options);

    expect(mockUiBuilder.buildTitleBlock).toHaveBeenCalledWith({
      title: 'Enterprise Portal',
      subtitle: 'Process Document',
    });
    expect(mockUiBuilder.buildStatusMessageBlock).toHaveBeenCalledWith(
      'Processing selected items...',
      false
    );
    expect(mockUiBuilder.buildCard).toHaveBeenCalledWith(
      { title: 'Enterprise Portal', subtitle: 'Process Document' },
      [
        { widgets: [{ textParagraph: { text: 'Processing selected items...' } }] },
        { header: 'Document Type', widgets: [] }
      ]
    );
    expect(result).toEqual({ action: { navigations: [{ pushCard: mockCard }] } });
  });
});
