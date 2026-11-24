import {
  DOCUMENT_LOG_CONTEXT_KEY,
  type UiContextQueryPort,
  type UiContextQueryRequest,
} from '../features/schema-driven-ui/ports';
import type { DocumentLogPort, DocumentLogSpace } from '../features/document-log';
import type { DocumentSpaceService } from '../features/document-space/domain';

export interface UiContextQueryAdapterOptions {
  documentLogService: DocumentLogPort;
  getDocumentSpaceService: () => Promise<DocumentSpaceService> | DocumentSpaceService;
  ensureInitialized?: (() => Promise<void>) | undefined;
}

/**
 * Thin composition-root adapter bridging `UiContextQueryPort` (`SchemaDrivenUi`)
 * to `DocumentLogPort.queryUiContext` using the request's memoized `DocumentSpaceService`.
 */
export class UiContextQueryAdapter implements UiContextQueryPort {
  constructor(private readonly options: UiContextQueryAdapterOptions) {}

  async queryContext(
    keys: readonly string[],
    context: UiContextQueryRequest
  ): Promise<Record<string, unknown>> {
    if (!keys.includes(DOCUMENT_LOG_CONTEXT_KEY)) {
      return {};
    }

    if (this.options.ensureInitialized) {
      await this.options.ensureInitialized();
    }

    const documentTypeKey = context.documentTypeKey?.trim();
    if (
      !documentTypeKey ||
      !this.options.documentLogService.requiresDocumentLog(documentTypeKey)
    ) {
      return {};
    }

    const space = await this.resolveDocumentLogSpace(context);
    const rawSelectedLogId = context.formData?.SelectDocumentLog;
    const selectedLogId =
      typeof rawSelectedLogId === 'string' && rawSelectedLogId.trim().length > 0
        ? rawSelectedLogId.trim()
        : undefined;

    const panelContext = await this.options.documentLogService.queryUiContext({
      documentTypeKey,
      ...(space !== undefined ? { space } : {}),
      ...(selectedLogId !== undefined ? { selectedLogId } : {}),
      ...(context.formData !== undefined ? { formData: context.formData } : {}),
    });

    return panelContext !== undefined ? { [DOCUMENT_LOG_CONTEXT_KEY]: panelContext } : {};
  }

  private async resolveDocumentLogSpace(
    context: UiContextQueryRequest
  ): Promise<DocumentLogSpace | undefined> {
    const spaceId = context.spaceId?.trim();
    if (!spaceId) {
      return undefined;
    }

    const spaceService = await this.options.getDocumentSpaceService();
    const allTypes = spaceService.getAllTypes();
    const rawPreferredType = context.formData?.SelectDocumentSpaceType;
    const preferredTypeId =
      typeof rawPreferredType === 'string' && rawPreferredType.trim().length > 0
        ? rawPreferredType.trim()
        : undefined;

    const orderedTypeIds: string[] = [];
    if (preferredTypeId && allTypes.some((t) => t.id === preferredTypeId)) {
      orderedTypeIds.push(preferredTypeId);
    }
    for (const spaceType of allTypes) {
      if (spaceType.id !== preferredTypeId) {
        orderedTypeIds.push(spaceType.id);
      }
    }

    for (const typeId of orderedTypeIds) {
      try {
        const collection = await spaceService.getCollection(typeId);
        const found = collection.spaces.find((s) => s.id === spaceId);
        if (found) {
          return {
            id: found.id,
            typeId: found.typeId,
            name: found.name,
            abstractStorageId: found.abstractStorageId,
          };
        }
      } catch {
        // Ignore non-matching collection lookup failures
      }
    }

    return undefined;
  }
}
