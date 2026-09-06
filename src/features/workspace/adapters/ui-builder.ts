export type UiCardHeader = unknown;
export type UiCardSection = unknown;
export type UiCard = unknown;
export type UiActionResponse = unknown;

export interface DocumentSelectionItem {
  text: string;
  value: string;
  selected?: boolean;
}

export interface DocumentSelectionContext {
  spaceTypes: DocumentSelectionItem[];
  spaces: string[];
  documentTypes: DocumentSelectionItem[];
}

export interface WorkspaceUiBuilderPort {
  buildCard(header: UiCardHeader, sections: (UiCardSection | null | undefined)[]): UiCard;
  buildTitleBlock(options: {
    title: string;
    subtitle?: string;
    imageUrl?: string;
    imageType?: 'SQUARE' | 'CIRCLE';
  }): UiCardHeader;
  buildStatusMessageBlock(message?: string, isOnlySection?: boolean): UiCardSection | null;
  buildDocumentTypeSelectionBlock(options: {
    selectionContext: DocumentSelectionContext;
    onSpaceTypeChangeAction: string;
  }): UiCardSection;
  buildNavigationAction(card: UiCard): UiActionResponse;
  buildErrorCard(errorMessage: string, title?: string): UiActionResponse;
}
