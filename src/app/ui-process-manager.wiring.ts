import type { WorkspaceConfigProviderPort } from '../infrastructure/workspace-addon/api';
import type { DocumentSpaceService } from '../features/document-space/domain';
import {
  WorkspaceAddonAdapter,
  type UiProcessSpaceProviderPort,
  type UiProcessConfigProviderPort,
  type UiProcessManifestPort,
  type UiProcessViewGeneratorPort,
  type UiProcessCardRequest,
} from '../features/ui-process-manager';
import {
  createSchemaDrivenUiWiring,
  type RawManifestProviderPort,
} from './schema-driven-ui.wiring';
import type { SchemaDrivenUiService } from '../features/schema-driven-ui/domain';
import {
  translateUiViewToNavigationAction,
  translateUiViewToUpdateCardAction,
} from '../infrastructure/workspace-addon/translator';
import { mapUiViewToAbstractUiView } from './workspace-addon.wiring';

export interface UiProcessManagerWiringOptions {
  configProvider?: WorkspaceConfigProviderPort | undefined;
  documentSpaceService: DocumentSpaceService;
  manifestProvider: RawManifestProviderPort;
  schemaDrivenUiService?: SchemaDrivenUiService | undefined;
}

export interface UiProcessManagerWiring {
  orchestrator: WorkspaceAddonAdapter;
}

function mapSelectionItems(items: Array<{ text: string; value: string; selected?: boolean | undefined }>) {
  return items.map((item) => ({
    text: item.text,
    value: item.value,
    ...(item.selected !== undefined ? { selected: item.selected } : {}),
  }));
}

export function createUiProcessManagerWiring(
  options: UiProcessManagerWiringOptions
): UiProcessManagerWiring {
  const schemaDrivenUi =
    options.schemaDrivenUiService !== undefined
      ? { schemaDrivenUiService: options.schemaDrivenUiService }
      : createSchemaDrivenUiWiring({
          manifestProvider: options.manifestProvider,
        });

  const spaceProvider: UiProcessSpaceProviderPort = {
    getAllTypes: () => options.documentSpaceService.getAllTypes(),
    getCollection: (typeId: string) => options.documentSpaceService.getCollection(typeId),
  };

  const configProvider: UiProcessConfigProviderPort = {
    getWorkspaceConfig: async () => {
      if (!options.configProvider) {
        return undefined;
      }
      const cfg = await options.configProvider.getWorkspaceConfig();
      if (!cfg) {
        return undefined;
      }
      return {
        defaultDocumentType: cfg.defaultDocumentType,
        defaultDocumentSpaceType: cfg.defaultDocumentSpaceType,
      };
    },
  };

  let cachedDocTypes: Array<{ key: string; name?: string | undefined; displayName?: string | undefined }> | undefined;

  const manifestPort: UiProcessManifestPort = {
    async resolveDocumentTypeKey(nameOrKey: string): Promise<string | undefined> {
      const all = await this.getAllDocumentTypes();
      const found = all.find(
        (d) => d.key === nameOrKey || d.name === nameOrKey || d.displayName === nameOrKey
      );
      return found?.key ?? nameOrKey;
    },
    async getAllDocumentTypes(): Promise<Array<{ key: string; name?: string | undefined; displayName?: string | undefined }>> {
      if (cachedDocTypes) {
        return cachedDocTypes;
      }

      const raw = (await options.manifestProvider.getRawManifest()) as
        | { documentTypes?: string[] | Record<string, { name?: string; displayName?: string }> }
        | undefined;
      const result: Array<{ key: string; name?: string | undefined; displayName?: string | undefined }> = [];

      if (Array.isArray(raw?.documentTypes)) {
        for (const relPath of raw.documentTypes) {
          try {
            const parsed = (await options.manifestProvider.readParsedSchema(relPath)) as
              | { key?: string; name?: string; displayName?: string }
              | undefined;
            if (parsed?.key) {
              result.push({
                key: parsed.key,
                name: parsed.name,
                displayName: parsed.displayName,
              });
            }
          } catch {
            // ignore unreadable/invalid schemas
          }
        }
      } else if (raw?.documentTypes && typeof raw.documentTypes === 'object') {
        for (const [key, def] of Object.entries(raw.documentTypes)) {
          result.push({
            key,
            name: def?.name,
            displayName: def?.displayName,
          });
        }
      }

      cachedDocTypes = result;
      return result;
    },
  };

  const viewGenerator: UiProcessViewGeneratorPort = {
    async generateCard(request: UiProcessCardRequest) {
      const view = await schemaDrivenUi.schemaDrivenUiService.generateView({
        viewId: request.viewId,
        ...(request.documentTypeKey !== undefined ? { documentTypeKey: request.documentTypeKey } : {}),
        ...(request.validationErrors !== undefined ? { validationErrors: request.validationErrors } : {}),
        ...(request.formData !== undefined ? { formData: request.formData } : {}),
        ...(request.hiddenFields !== undefined ? { hiddenFields: request.hiddenFields } : {}),
        ...(request.selectionState !== undefined
          ? {
              selectionState: {
                spaces: request.selectionState.spaces,
                spaceTypes: mapSelectionItems(request.selectionState.spaceTypes),
                documentTypes: mapSelectionItems(request.selectionState.documentTypes),
              },
            }
          : {}),
      });

      const mappedView = mapUiViewToAbstractUiView(view);
      if (request.isUpdateCard) {
        return translateUiViewToUpdateCardAction(mappedView);
      }
      return translateUiViewToNavigationAction(mappedView);
    },
  };

  const orchestrator = new WorkspaceAddonAdapter({
    spaceProvider,
    configProvider,
    manifestPort,
    viewGenerator,
  });

  return {
    orchestrator,
  };
}
