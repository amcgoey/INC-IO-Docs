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

    const nameToKeyMap: Record<string, string> = {};
    if (manifestPort) {
      try {
        const docTypes = await manifestPort.getAllDocumentTypes();
        const registerMapping = (name: string, key: string) => {
          if (nameToKeyMap[name] && nameToKeyMap[name] !== key) {
            console.warn(
              `Document type display name collision: "${name}" is already mapped to "${nameToKeyMap[name]}". Ignoring mapping to "${key}".`
            );
          } else {
            nameToKeyMap[name] = key;
          }
        };

        for (const doc of docTypes) {
          if (doc.name) {
            registerMapping(doc.name, doc.key);
          }
          if (doc.displayName) {
            registerMapping(doc.displayName, doc.key);
          }
        }
      } catch (e) {
        console.warn('Could not fetch document types from manifest port', e);
      }
    }

    const state = evaluateProcessUiState({
      context,
      config: {
        ...(config?.defaultDocumentType ? { defaultDocumentType: config.defaultDocumentType } : {}),
        ...(config?.defaultDocumentSpaceType
          ? { defaultDocumentSpaceType: config.defaultDocumentSpaceType }
          : {}),
      },
      spaceTypes,
      collectionSpaces,
      nameToKeyMap,
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
