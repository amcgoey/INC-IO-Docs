import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  DriveHierarchyNodeSchema,
  DriveItemHierarchySchema,
  SourceItemDescriptorSchema,
  CandidateSpaceDescriptorSchema,
  SourceContextSchema,
  InferredRoutingResultSchema,
  ExtractFieldsRequestSchema,
  ExtractedFieldsResultSchema,
  SourceParserSpaceTypeConfigSchema,
} from './ports';

describe('SourceParser ports and schemas', () => {
  it('validates DriveHierarchyNodeSchema', () => {
    expect(
      Value.Check(DriveHierarchyNodeSchema, {
        id: 'node-1',
        name: 'Folder',
        mimeType: 'application/vnd.google-apps.folder',
      })
    ).toBe(true);

    expect(
      Value.Check(DriveHierarchyNodeSchema, {
        id: 'node-1',
        name: 'File.pdf',
      })
    ).toBe(true);

    expect(
      Value.Check(SourceItemDescriptorSchema, {
        id: 'item-1',
        name: 'Note.docx',
        mimeType: 'application/vnd.google-apps.document',
      })
    ).toBe(true);

    expect(
      Value.Check(CandidateSpaceDescriptorSchema, {
        id: 'space-1',
        name: 'Project Alpha',
        typeId: 'projects',
        abstractStorageId: 'drive-folder-1',
      })
    ).toBe(true);

    expect(Value.Check(DriveHierarchyNodeSchema, { id: '' })).toBe(false);
  });

  it('validates DriveItemHierarchySchema', () => {
    expect(
      Value.Check(DriveItemHierarchySchema, {
        item: { id: 'item-1', name: 'File.pdf' },
        driveId: 'drive-123',
        driveName: 'Project Drive',
        ancestors: [{ id: 'parent-1', name: 'Parent' }],
      })
    ).toBe(true);

    expect(
      Value.Check(DriveItemHierarchySchema, {
        item: { id: 'item-1', name: 'File.pdf' },
        ancestors: [],
      })
    ).toBe(true);
  });

  it('validates SourceContextSchema', () => {
    expect(
      Value.Check(SourceContextSchema, {
        items: [{ id: 'file-1', name: 'Doc.pdf' }],
        candidateSpaces: [{ id: 'sp-1', name: 'Space 1' }],
      })
    ).toBe(true);

    expect(Value.Check(SourceContextSchema, {})).toBe(true);
  });

  it('validates InferredRoutingResultSchema', () => {
    expect(
      Value.Check(InferredRoutingResultSchema, {
        spaceTypeId: 'projects',
        spaceIdOrName: 'drive-123',
        documentTypeKey: 'submittal-ffe',
        statusMessages: ['Notice'],
      })
    ).toBe(true);

    expect(Value.Check(InferredRoutingResultSchema, {})).toBe(true);
  });

  it('validates ExtractFieldsRequestSchema and ExtractedFieldsResultSchema', () => {
    expect(
      Value.Check(ExtractFieldsRequestSchema, {
        documentTypeKey: 'communication-project',
        context: {},
      })
    ).toBe(true);

    expect(
      Value.Check(ExtractedFieldsResultSchema, {
        fields: { contact: 'Acme Corp' },
        statusMessages: ['Loaded'],
      })
    ).toBe(true);
  });

  it('validates SourceParserSpaceTypeConfigSchema', () => {
    expect(
      Value.Check(SourceParserSpaceTypeConfigSchema, {
        id: 'projects',
        displayName: 'Projects',
        spaceSchema: {
          allowedDocumentTypes: ['communication-project'],
          defaultDocumentType: 'communication-project',
        },
        storageConfig: { provider: 'google_drive', fetchMethod: 'shared_drives' },
      })
    ).toBe(true);
  });
});
