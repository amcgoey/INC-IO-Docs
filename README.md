# INC-IO-Docs

Schema Driven, Hexagonal Architecture Document Management App.

## Core Domain

- **`DocumentType`**: The JSON schema definition loaded from the app's runtime directory.
- **`Document`**: The structured metadata instantiating a `DocumentType`. Contains references to file locations but does NOT embed binary files.

## Architecture (Hexagonal)

- **Driving Port**: Google Workspace Addon (primary target) & Fastify REST API.
- **Driven Port (Types)**: App Runtime Directory (Reads JSON schemas).
- **Driven Port (Documents)**: Google Drive (Serializes Document metadata to JSON).

## Tech Stack

- TypeScript
- Fastify
- Typebox
- Google Cloud Run
- Vitest