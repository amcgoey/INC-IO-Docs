import type {
  CardHeaderOptions,
  CardHeader,
  CardSection,
  Card,
  CardActionResponse,
} from '../../../infrastructure/workspace-addon/ui-blocks';

export interface WorkspaceUiBuilderPort {
  buildCard(header: CardHeader, sections: (CardSection | null | undefined)[]): Card;
  buildTitleBlock(options: CardHeaderOptions): CardHeader;
  buildStatusMessageBlock(message?: string, isOnlySection?: boolean): CardSection | null;
  buildNavigationAction(card: Card): CardActionResponse;
  buildErrorCard(errorMessage: string, title?: string): CardActionResponse;
}
