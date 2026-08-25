# Explicit App Manifest for Configuration Discovery

We will use an explicit `manifest.json` file as an infrastructure mechanism to discover and load application configuration and schemas, rather than relying on dynamic file system scanning or hardcoded lists in code.

Currently, the manifest structure is a simple `{ "recordTypes": ["./path1.json", ...] }` providing the relative paths to the `RecordType` schemas. This manifest path is injected into the application via an environment variable (`APP_MANIFEST_PATH`), keeping the file-system adapter ignorant of hardcoded locations. While the manifest currently only serves the `record` module's schemas, this explicit file gives us a central place to add broader application configuration in the future without changing the architecture.
