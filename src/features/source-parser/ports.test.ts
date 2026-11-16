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

  it('validates SourceContextSchema including email metadata (Ticket #292)', () => {
    expect(
      Value.Check(SourceContextSchema, {
        items: [{ id: 'file-1', name: 'Doc.pdf' }],
        candidateSpaces: [{ id: 'sp-1', name: 'Space 1' }],
        email: {
          id: 'msg-1',
          threadId: 'th-1',
          subject: 'Submittal Review',
          from: 'Sender <sender@example.com>',
          to: 'Recipient <recipient@example.com>',
          cc: 'CC <cc@example.com>',
          date: 'Mon, 19 Oct 2026 14:00:00 -0400',
          plainTextBody: 'Body text',
          htmlBody: '<p>Body text</p>',
          labels: ['Projects/123 Main St', 'INBOX'],
          attachments: [{ id: 'att-1', name: 'Plan.pdf', mimeType: 'application/pdf' }],
        },
      })
    ).toBe(true);

    expect(
      Value.Check(SourceContextSchema, {
        email: {
          id: 'msg-2',
          threadId: undefined,
          subject: undefined,
          from: undefined,
          to: undefined,
          cc: undefined,
          date: undefined,
          plainTextBody: undefined,
          htmlBody: undefined,
          labels: undefined,
          attachments: undefined,
        },
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
