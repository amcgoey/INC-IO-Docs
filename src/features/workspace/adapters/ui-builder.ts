export type UiCardHeader = unknown;
export type UiCardSection = unknown;
export type UiCard = unknown;
export type UiActionResponse = unknown;

export interface DocumentSelectionItem {
  text: string;
  value: string;
  selected?: boolean;
}

export interface DocumentSelectionState {
  spaceTypes: DocumentSelectionItem[];
  spaces: string[];
  documentTypes: DocumentSelectionItem[];
}

export type DocumentSelectionContext = DocumentSelectionState;

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
    selectionContext: DocumentSelectionState;
    onSpaceTypeChangeAction: string;
  }): UiCardSection;
  buildNavigationAction(card: UiCard): UiActionResponse;
  buildErrorCard(errorMessage: string, title?: string): UiActionResponse;
}
