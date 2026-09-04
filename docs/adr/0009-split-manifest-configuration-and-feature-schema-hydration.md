# Split Manifest Configuration and Feature Schema Hydration

We will split `manifest.json` parsing into an infrastructure `AppManifestProvider` (for domain-agnostic global configuration) and a feature-specific `DocumentSchemaRegistryAdapter` (for hydrating `DocumentType` domain schemas).

Parsing global configuration alongside feature-specific domain models inside a single adapter violates our strict separation of concerns (infrastructure vs. features) and our deletion test. By creating a seam (`DocumentTypePathsProviderPort`), the infrastructure layer simply reads the raw file paths and configuration blocks without importing feature domain models. The feature layer then receives those paths and only hydrates the `DocumentType` JSON files it is handed. This guarantees deep modules with small interfaces and preserves feature isolation.
