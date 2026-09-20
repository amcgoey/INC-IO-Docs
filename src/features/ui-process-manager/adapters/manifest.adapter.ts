import type { UiProcessManifestPort, RawManifestProviderPort } from '../ports';

export type { RawManifestProviderPort };

interface RawDocDef {
  key: string;
  name?: string | undefined;
  displayName?: string | undefined;
  documentSchema?: unknown;
  documentUiSchema?: unknown;
}

export class ManifestAdapter implements UiProcessManifestPort {
  private cachedDocTypes?: Array<{ key: string; name?: string | undefined; displayName?: string | undefined }>;

  constructor(private readonly manifestProvider: RawManifestProviderPort) {}

  private async loadAllRawDocDefs(): Promise<RawDocDef[]> {
    const raw = (await this.manifestProvider.getRawManifest()) as
      | {
          documentTypes?:
            | string[]
            | Record<
                string,
                {
                  name?: string;
                  displayName?: string;
                  documentSchema?: unknown;
                  documentUiSchema?: unknown;
                }
              >;
        }
      | undefined;

    if (!raw?.documentTypes) {
      return [];
    }

    const result: RawDocDef[] = [];

    if (Array.isArray(raw.documentTypes)) {
      for (const relPath of raw.documentTypes) {
        try {
          if (this.manifestProvider.readParsedSchema) {
            const parsed = (await this.manifestProvider.readParsedSchema(relPath)) as
              | {
                  key?: string;
                  name?: string;
                  displayName?: string;
                  documentSchema?: unknown;
                  documentUiSchema?: unknown;
                }
              | undefined;
            if (parsed?.key) {
              result.push({
                key: parsed.key,
                name: parsed.name,
                displayName: parsed.displayName,
                documentSchema: parsed.documentSchema,
                documentUiSchema: parsed.documentUiSchema,
              });
            }
          }
        } catch {
          // ignore unreadable/invalid schemas
        }
      }
    } else if (typeof raw.documentTypes === 'object') {
      for (const [key, def] of Object.entries(raw.documentTypes)) {
        result.push({
          key,
          name: def?.name,
          displayName: def?.displayName,
          documentSchema: def?.documentSchema,
          documentUiSchema: def?.documentUiSchema,
        });
      }
    }

    return result;
  }

  async resolveDocumentTypeKey(nameOrKey: string): Promise<string | undefined> {
    const all = await this.getAllDocumentTypes();
    const found = all.find(
      (d) => d.key === nameOrKey || d.name === nameOrKey || d.displayName === nameOrKey
    );
    return found?.key ?? nameOrKey;
  }

  async getAllDocumentTypes(): Promise<
    Array<{ key: string; name?: string | undefined; displayName?: string | undefined }>
  > {
    if (this.cachedDocTypes) {
      return this.cachedDocTypes;
    }

    const defs = await this.loadAllRawDocDefs();
    const result = defs.map(({ key, name, displayName }) => ({
      key,
      ...(name ? { name } : {}),
      ...(displayName ? { displayName } : {}),
    }));

    this.cachedDocTypes = result;
    return result;
  }

  async getDocumentTypeSchemas(
    documentTypeKey: string
  ): Promise<{ docSchema?: unknown; uiSchema?: unknown }> {
    if (!documentTypeKey) {
      return {};
    }

    const defs = await this.loadAllRawDocDefs();
    const found = defs.find((d) => d.key === documentTypeKey);
    if (!found) {
      return {};
    }

    return {
      docSchema: found.documentSchema,
      uiSchema: found.documentUiSchema,
    };
  }
}
