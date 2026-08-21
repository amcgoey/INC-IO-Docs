// PROTOTYPE: Issue #6 Hexagonal Architecture Ports
// This file is a throwaway prototype to validate the seams (interfaces) for the Document feature.
// It will be replaced by actual implementations in the respective domain/ports files.

import { Static, Type } from '@sinclair/typebox';

// ==========================================
// 1. Domain Models (Minimal for prototype)
// ==========================================

export const DocumentTypeSchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  schemaDefinition: Type.Any(), // e.g. JSON schema structure
});
export type DocumentType = Static<typeof DocumentTypeSchema>;

export const DocumentSchema = Type.Object({
  id: Type.String(),
  typeId: Type.String(),
  metadata: Type.Record(Type.String(), Type.Any()),
  fileUris: Type.Array(Type.String()), // Refers to file locations, does not embed binary
});
export type Document = Static<typeof DocumentSchema>;

// ==========================================
// 2. Driven Ports (Outbound Seams)
// ==========================================
// Deep modules: large amounts of implementation (Google Drive API, File system parsing) 
// hidden behind simple, testable interfaces.

/**
 * Driven Port: App Runtime Directory
 * Reads JSON schemas from the filesystem.
 */
export interface DocumentTypeRegistry {
  listAvailableTypes(): Promise<DocumentType[]>;
  getType(id: string): Promise<DocumentType | null>;
}

/**
 * Driven Port: Google Drive
 * Serializes/Deserializes Document metadata to/from JSON in Google Drive.
 */
export interface DocumentStore {
  save(document: Document): Promise<void>;
  get(id: string): Promise<Document | null>;
  // Optionally, a search/list capability if Google Drive permits easy querying
  list(typeId?: string): Promise<Document[]>;
}

// ==========================================
// 3. Driving Port (Inbound Seam)
// ==========================================
// The Application Service interface that the Fastify REST API 
// and Google Workspace Addon will depend on.

export interface DocumentManager {
  // Queries
  getAvailableTypes(): Promise<DocumentType[]>;
  getDocument(id: string): Promise<Document | null>;
  
  // Commands
  /**
   * Creates a new document. 
   * The implementation will fetch the DocumentType, validate the metadata, and save via DocumentStore.
   */
  createDocument(typeId: string, metadata: Record<string, any>): Promise<Document>;
  
  /**
   * Updates document metadata.
   * The implementation will validate the new metadata against the DocumentType before saving.
   */
  updateMetadata(documentId: string, metadata: Record<string, any>): Promise<Document>;
  
  /**
   * Links an external file to the document.
   */
  attachFile(documentId: string, fileUri: string): Promise<Document>;
}
