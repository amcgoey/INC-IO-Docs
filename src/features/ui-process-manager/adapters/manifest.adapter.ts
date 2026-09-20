import type { UiProcessManifestPort } from '../ports';

export interface RawManifestProviderPort {
  getRawManifest(): Promise<unknown>;
  readParsedSchema?(relPath: string): Promise<unknown>;
}

export class ManifestAdapter implements UiProcessManifestPort {
  private cachedDocTypes?: Array<{ key: string; name?: string | undefined; displayName?: string | undefined }>;

  constructor(private readonly manifestProvider: RawManifestProviderPort) {}

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

    const raw = (await this.manifestProvider.getRawManifest()) as
      | { documentTypes?: string[] | Record<string, { name?: string; displayName?: string }> }
      | undefined;
    const result: Array<{ key: string; name?: string | undefined; displayName?: string | undefined }> = [];

    if (Array.isArray(raw?.documentTypes)) {
      for (const relPath of raw.documentTypes) {
        try {
          if (this.manifestProvider.readParsedSchema) {
            const parsed = (await this.manifestProvider.readParsedSchema(relPath)) as
              | { key?: string; name?: string; displayName?: string }
              | undefined;
            if (parsed?.key) {
              result.push({
                key: parsed.key,
                name: parsed.name,
                displayName: parsed.displayName,
              });
            }
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

    this.cachedDocTypes = result;
    return result;
  }
}
