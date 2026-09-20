import type {
  UiProcessOrchestratorPort,
  UiProcessEventContext,
  UiProcessSpaceProviderPort,
  UiProcessConfigProviderPort,
  UiProcessManifestPort,
  UiProcessViewGeneratorPort,
} from '../ports';
import { evaluateProcessUiState, resolveSpaceType } from '../domain';

export interface WorkspaceAddonAdapterOptions {
  spaceProvider: UiProcessSpaceProviderPort;
  configProvider?: UiProcessConfigProviderPort;
  manifestPort?: UiProcessManifestPort;
  viewGenerator: UiProcessViewGeneratorPort;
}

export class WorkspaceAddonAdapter implements UiProcessOrchestratorPort {
  constructor(private readonly options: WorkspaceAddonAdapterOptions) {}

  async processUiEvent(context: UiProcessEventContext): Promise<unknown> {
    const { spaceProvider, configProvider, manifestPort, viewGenerator } = this.options;

    const config = configProvider ? await configProvider.getWorkspaceConfig() : undefined;
    const spaceTypes = spaceProvider.getAllTypes();

    const currentSpaceType = resolveSpaceType(context.formData, config);

    let collectionSpaces: string[] = [];
    try {
      const collection = await spaceProvider.getCollection(currentSpaceType);
      collectionSpaces = collection.spaces.map((s) => s.name);
    } catch (e) {
      console.warn(`Could not fetch collection for space type: ${currentSpaceType}`, e);
    }

    const rawSelectedDocType =
      (context.formData?.SelectDocumentType as string | undefined) ??
      context.parameters?.documentTypeKey ??
      config?.defaultDocumentType;

    let resolvedDocumentTypeKey = rawSelectedDocType;
    if (rawSelectedDocType && manifestPort) {
      try {
        const resolved = await manifestPort.resolveDocumentTypeKey(rawSelectedDocType);
        if (resolved) {
          resolvedDocumentTypeKey = resolved;
        }
      } catch (e) {
        console.warn(`Could not resolve document type key for: ${rawSelectedDocType}`, e);
      }
    }

    const state = evaluateProcessUiState({
      context,
      resolvedDocumentTypeKey,
      config: {
        ...(config?.defaultDocumentType ? { defaultDocumentType: config.defaultDocumentType } : {}),
        ...(config?.defaultDocumentSpaceType
          ? { defaultDocumentSpaceType: config.defaultDocumentSpaceType }
          : {}),
      },
      spaceTypes,
      collectionSpaces,
    });

    return await viewGenerator.generateCard({
      viewId: state.viewId,
      documentTypeKey: state.documentTypeKey,
      selectionState: state.selectionState,
      formData: state.formData,
      isUpdateCard: state.isUpdateCard,
      ...(state.validationErrors ? { validationErrors: state.validationErrors } : {}),
    });
  }
}
