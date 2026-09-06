export type UiCardHeader = unknown;
export type UiCardSection = unknown;
export type UiCard = unknown;
export type UiActionResponse = unknown;

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
    spaceTypes: { text: string; value: string; selected?: boolean }[];
    onSpaceTypeChangeAction: string;
    spaces: string[];
    documentTypes: { text: string; value: string; selected?: boolean }[];
  }): UiCardSection;
  buildNavigationAction(card: UiCard): UiActionResponse;
  buildErrorCard(errorMessage: string, title?: string): UiActionResponse;
}
