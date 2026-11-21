import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  DriveHierarchyNodeSchema,
  DriveItemHierarchySchema,
  DriveSourceShortcutDetailsSchema,
  DriveSourceFileMetadataSchema,
  SourceItemDescriptorSchema,
  CandidateSpaceDescriptorSchema,
  SourceContextSchema,
  InferredRoutingResultSchema,
  ExtractFieldsRequestSchema,
  ExtractedFieldsResultSchema,
  SourceParserSpaceTypeConfigSchema,
  GmailFieldRuleOrListSchema,
  GmailExtractorRuleSchema,
  DriveExtractSourceSchema,
  FieldCandidateNormalizeSchema,
  DriveFieldRuleOrListSchema,
  DriveExtractorRuleSchema,
  StructuralExtractorRuleSchema,
  SourceExtractorRuleSchema,
  ParseTargetDocumentFieldSchema,
  ParseTargetCalculatedFieldSchema,
  ParseTargetDocumentOptionTupleSchema,
  ParseTargetDocumentSchemaSchema,
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
        createdTime: '2026-10-18T12:00:00Z',
        modifiedTime: '2026-10-19T23:30:00Z',
      })
    ).toBe(true);

    expect(
      Value.Check(DriveHierarchyNodeSchema, {
        id: 'node-1',
        name: 'File.pdf',
        createdTime: undefined,
        modifiedTime: undefined,
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

  it('validates DriveSourceShortcutDetailsSchema and DriveSourceFileMetadataSchema', () => {
    expect(
      Value.Check(DriveSourceShortcutDetailsSchema, {
        targetId: 'target-1',
        targetMimeType: 'application/pdf',
      })
    ).toBe(true);

    expect(
      Value.Check(DriveSourceShortcutDetailsSchema, {
        targetId: undefined,
        targetMimeType: undefined,
      })
    ).toBe(true);

    expect(
      Value.Check(DriveSourceFileMetadataSchema, {
        id: 'file-1',
        name: 'Submittal.pdf',
        parents: ['folder-1'],
        mimeType: 'application/pdf',
        webViewLink: 'https://drive.google.com/file/d/file-1/view',
        driveId: 'drive-1',
        createdTime: '2026-11-01T10:00:00Z',
        modifiedTime: '2026-11-02T10:00:00Z',
        shortcutDetails: { targetId: 'target-1' },
      })
    ).toBe(true);

    expect(
      Value.Check(DriveSourceFileMetadataSchema, {
        id: 'file-2',
        name: 'Minimal.pdf',
        parents: undefined,
        mimeType: undefined,
        shortcutDetails: undefined,
      })
    ).toBe(true);

    expect(Value.Check(DriveSourceFileMetadataSchema, { id: '', name: 'Bad' })).toBe(false);
    expect(Value.Check(DriveSourceFileMetadataSchema, { id: 'file-3', name: '' })).toBe(false);
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

  it('validates GmailFieldRuleOrListSchema rejecting empty rule arrays', () => {
    expect(Value.Check(GmailFieldRuleOrListSchema, { from: 'email.date' })).toBe(true);
    expect(Value.Check(GmailFieldRuleOrListSchema, [{ from: 'email.date' }])).toBe(true);
    expect(Value.Check(GmailFieldRuleOrListSchema, [])).toBe(false);
    expect(
      Value.Check(GmailExtractorRuleSchema, {
        source: 'gmail',
        fields: { date: [] },
      })
    ).toBe(false);
  });

  it('validates DriveExtractSourceSchema, DriveExtractorRuleSchema, and StructuralExtractorRuleSchema (#307)', () => {
    for (const validSource of [
      'drive.fileName',
      'drive.fileNameStem',
      'drive.modifiedTime',
      'drive.createdTime',
    ]) {
      expect(Value.Check(DriveExtractSourceSchema, validSource)).toBe(true);
    }
    expect(Value.Check(DriveExtractSourceSchema, 'email.date')).toBe(false);
    expect(Value.Check(DriveExtractSourceSchema, 'drive.unknown')).toBe(false);

    expect(
      Value.Check(DriveFieldRuleOrListSchema, [
        { from: 'drive.modifiedTime', when: undefined, pattern: undefined, flags: undefined, group: undefined, normalize: undefined },
        { from: 'drive.fileNameStem', normalize: 'yymmdd' },
        { from: 'drive.createdTime' },
      ])
    ).toBe(true);
    expect(Value.Check(FieldCandidateNormalizeSchema, 'yymmdd')).toBe(true);
    expect(Value.Check(FieldCandidateNormalizeSchema, 'digits6')).toBe(true);
    expect(Value.Check(FieldCandidateNormalizeSchema, 'pad3')).toBe(true);
    expect(Value.Check(FieldCandidateNormalizeSchema, 'compactAlnum')).toBe(true);
    expect(Value.Check(FieldCandidateNormalizeSchema, 'revision')).toBe(true);
    expect(Value.Check(FieldCandidateNormalizeSchema, 'cleanFilenameText')).toBe(true);
    expect(Value.Check(FieldCandidateNormalizeSchema, 'unknown')).toBe(false);
    expect(Value.Check(GmailFieldRuleOrListSchema, { from: 'email.subjectClean', normalize: 'yymmdd' })).toBe(true);
    expect(Value.Check(GmailFieldRuleOrListSchema, { from: 'email.subjectClean', normalize: 'yymmdd', lookup: true })).toBe(true);
    expect(Value.Check(DriveFieldRuleOrListSchema, { set: 'IN', normalize: 'yymmdd' })).toBe(false);
    expect(Value.Check(DriveFieldRuleOrListSchema, [])).toBe(false);
    expect(Value.Check(DriveFieldRuleOrListSchema, { from: 'drive.fileName', extraProp: true })).toBe(false);

    expect(
      Value.Check(DriveExtractorRuleSchema, {
        source: 'drive',
        name: undefined,
        match: { '==': [{ var: 'drive.isFolder' }, false] },
        fields: {
          date: [{ from: 'drive.modifiedTime' }, { from: 'drive.createdTime' }],
          contact: { from: 'drive.fileNameStem', lookup: true },
          direction: { set: 'IN' },
        },
      })
    ).toBe(true);

    expect(
      Value.Check(StructuralExtractorRuleSchema, {
        source: 'pdfForm',
        fields: { date: { custom: 'placeholder' } },
      })
    ).toBe(true);
    expect(
      Value.Check(StructuralExtractorRuleSchema, {
        source: 'googleDoc',
        fields: { date: { custom: 'placeholder' } },
      })
    ).toBe(true);
    expect(
      Value.Check(StructuralExtractorRuleSchema, {
        source: 'drive',
        fields: { date: { custom: 'placeholder' } },
      })
    ).toBe(false);
    expect(
      Value.Check(SourceExtractorRuleSchema, {
        source: 'drive',
        fields: { date: { custom: 'placeholder' } },
      })
    ).toBe(false);
  });

  it('validates ParseTargetDocumentSchema TypeBox DTOs', () => {
    expect(
      Value.Check(ParseTargetDocumentFieldSchema, {
        key: 'contact',
        name: 'Contact',
        type: 'string',
        minLength: 1,
        pattern: '^.*$',
        options: {
          source: 'contacts',
          key: 'code',
          name: 'title',
          allowUserInput: true,
          dynamicConfig: { provider: 'google_drive' },
        },
      })
    ).toBe(true);

    expect(
      Value.Check(ParseTargetDocumentFieldSchema, {
        key: 'contact',
        unknownProp: 'rejected',
      })
    ).toBe(false);

    expect(
      Value.Check(ParseTargetCalculatedFieldSchema, {
        key: 'fileName',
        name: 'File Name',
      })
    ).toBe(true);

    expect(
      Value.Check(ParseTargetDocumentOptionTupleSchema, {
        code: '071200',
        title: 'Waterproofing',
        aliases: ['wp'],
      })
    ).toBe(true);

    expect(
      Value.Check(ParseTargetDocumentSchemaSchema, {
        fields: [{ key: 'date' }],
        calculatedFields: [{ key: 'fileName' }],
        options: {
          contacts: [{ key: 'PMG', name: 'Pavarini', aliases: ['@pavarini.com'] }],
        },
      })
    ).toBe(true);
  });
});
