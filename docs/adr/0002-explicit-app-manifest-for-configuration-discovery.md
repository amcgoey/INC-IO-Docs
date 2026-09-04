# Explicit App Manifest for Configuration Discovery

We will use an explicit `manifest.json` file as an infrastructure mechanism to discover and load application configuration and schemas, rather than relying on dynamic file system scanning or hardcoded lists in code.

The manifest structure provides the relative paths to the `DocumentType` schemas (e.g., `{ "documentTypes": ["./path1.json", ...] }`). This manifest path is injected into the application via an environment variable (`APP_MANIFEST_PATH`), keeping the file-system adapter ignorant of hardcoded locations. While the manifest initially only served the `document` module's schemas, this explicit file gives us a central place to add broader application configuration (Drive, Workspace, Sheets).

*Note: The actual loading mechanism is split between infrastructure (for global configuration) and features (for schema hydration). See ADR-0009.*
