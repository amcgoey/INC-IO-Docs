import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { DocumentSchemaRegistryAdapter } from '../../src/features/document/adapters/document-schema-registry';
import { CompiledSchemaRegistry } from '../../src/features/document/adapters/compiled-schema-registry';
import { AppManifestProvider } from '../../src/infrastructure/manifest/app-manifest-provider';
import { HandlebarsAdapter } from '../../src/infrastructure/template-engine/handlebars-adapter';
import { ensureEvaluationOrder } from '../../src/infrastructure/validation/json-logic-graph';
import {
  DocumentTypeSchema,
  formatValidationErrors,
} from '../../src/features/document/domain';
import { FormSchemaType, type RawManifestProviderPort } from '../../src/features/document/ports';
import { UiSchema, type UiSchema as UiSchemaType } from '../../src/features/schema-driven-ui/domain';
import { Value } from '@sinclair/typebox/value';
import {
  DocumentSpaceService,
  DocumentSpaceTypeSchema,
} from '../../src/features/document-space/domain';
import { DocumentSpaceManifestRegistryAdapter } from '../../src/features/document-space/adapters/document-space-manifest-registry';
import { ParseSchemaRegistryAdapter } from '../../src/features/source-parser/adapters/parse-schema-registry.adapter';
import { LogSchemaRegistryAdapter } from '../../src/features/document-log';
import type {
  DocumentSpaceManifestRegistryPort,
  DocumentSpaceStoragePort,
} from '../../src/features/document-space/ports';

describe('DocumentType JSON files schema validation', () => {
  it('should validate all DocumentType JSON files referenced by manifest.json against Typebox schemas', async () => {
    const manifestPath = path.resolve(__dirname, '../../assets/manifest.json');
    const manifestProvider = new AppManifestProvider({ manifestPath });
    const adapter = new DocumentSchemaRegistryAdapter(
      manifestProvider,
      new HandlebarsAdapter()
    );
    const documentTypes = await adapter.loadAll();

    expect(documentTypes.length).toBeGreaterThan(0);
    for (const documentType of documentTypes) {
      const errors = formatValidationErrors(DocumentTypeSchema, documentType);
      expect(errors).toEqual([]);
      expect(Value.Check(DocumentTypeSchema, documentType)).toBe(true);

      // Verify essential properties
      expect(typeof documentType.key).toBe('string');
      expect(documentType.key.length).toBeGreaterThan(0);
      expect(typeof documentType.name).toBe('string');
      expect(documentType.name.length).toBeGreaterThan(0);

      // Verify fields
      expect(Array.isArray(documentType.documentSchema.fields)).toBe(true);
      expect(documentType.documentSchema.fields.length).toBeGreaterThan(0);
      for (const field of documentType.documentSchema.fields) {
        expect(typeof field.key).toBe('string');
        expect(typeof field.name).toBe('string');
        expect(typeof field.type).toBe('string');
        expect(typeof field.required).toBe('boolean');
      }

      // Verify calculatedFields if present
      if (documentType.documentSchema.calculatedFields) {
        expect(Array.isArray(documentType.documentSchema.calculatedFields)).toBe(true);
        for (const calcField of documentType.documentSchema.calculatedFields) {
          expect(typeof calcField.key).toBe('string');
          expect(calcField.key.length).toBeGreaterThan(0);
          expect(typeof calcField.template).toBe('string');
          expect(calcField.template.length).toBeGreaterThan(0);
        }
      }

      // Verify identity if present
      if (documentType.documentSchema.identity) {
        expect(typeof documentType.documentSchema.identity).toBe('object');
        if (documentType.documentSchema.identity.id) {
          expect(typeof documentType.documentSchema.identity.id).toBe('string');
          expect(documentType.documentSchema.identity.id.length).toBeGreaterThan(0);
        }
        if (documentType.documentSchema.identity.idDocument) {
          expect(typeof documentType.documentSchema.identity.idDocument).toBe('string');
          expect(documentType.documentSchema.identity.idDocument.length).toBeGreaterThan(0);
        }
        if (documentType.documentSchema.identity.idGroup) {
          expect(typeof documentType.documentSchema.identity.idGroup).toBe('string');
          expect(documentType.documentSchema.identity.idGroup.length).toBeGreaterThan(0);
        }
      }

      // Verify documentUiSchema hydration conforms to schema-driven-ui UiSchema
      expect(documentType.documentUiSchema).toBeDefined();
      const uiErrors = formatValidationErrors(UiSchema, documentType.documentUiSchema);
      expect(uiErrors).toEqual([]);
      expect(Value.Check(UiSchema, documentType.documentUiSchema)).toBe(true);

      const uiSchema = documentType.documentUiSchema as UiSchemaType;
      expect(Array.isArray(uiSchema.layout)).toBe(true);
      expect(uiSchema.layout?.length).toBeGreaterThan(0);
      expect(typeof uiSchema.fields).toBe('object');

      for (const [, uiField] of Object.entries(uiSchema.fields ?? {})) {
        if (uiField.widget) expect(typeof uiField.widget).toBe('string');
        if (uiField.label) expect(typeof uiField.label).toBe('string');
        if (uiField.onChange !== undefined) {
          expect(['boolean', 'string'].includes(typeof uiField.onChange)).toBe(true);
        }
      }

      // Verify FormSchema projection matches tightened FormSchemaType
      const formSchema = {
        key: documentType.key,
        name: documentType.name,
        documentSchema: documentType.documentSchema,
        ...(documentType.documentUiSchema !== undefined && {
          documentUiSchema: documentType.documentUiSchema,
        }),
      };
      expect(Value.Check(FormSchemaType, formSchema)).toBe(true);
      expect(formSchema).not.toHaveProperty('documentWorkflowConfig');
      expect(formSchema).not.toHaveProperty('storageContextConfig');
    }
  });

  it('should validate and load DocumentSpaceTypes defined in manifest.json via DocumentSpaceManifestRegistryAdapter', async () => {
    const manifestPath = path.resolve(__dirname, '../../assets/manifest.json');
    const manifestProvider = new AppManifestProvider({ manifestPath });
    const adapter: DocumentSpaceManifestRegistryPort =
      new DocumentSpaceManifestRegistryAdapter(manifestProvider);
    const dummyStoragePort: DocumentSpaceStoragePort = {
      fetchSpaces: async () => [],
      resolveStorageLocation: async (abstractStorageId) => ({
        provider: 'google_drive',
        abstractStorageId,
      }),
    };
    const service = new DocumentSpaceService(adapter, dummyStoragePort);
    await service.initialize();

    const spaceTypes = await adapter.getDocumentSpaceTypes();
    expect(spaceTypes.length).toBeGreaterThan(0);

    for (const spaceType of spaceTypes) {
      expect(Value.Check(DocumentSpaceTypeSchema, spaceType)).toBe(true);
      expect(service.hasType(spaceType.id)).toBe(true);
      const retrieved = service.getType(spaceType.id);
      expect(retrieved).toEqual(spaceType);
      expect(['shared_drives', 'folders']).toContain(retrieved.storageConfig.fetchMethod);
    }

    const docAdapter = new DocumentSchemaRegistryAdapter(
      manifestProvider,
      new HandlebarsAdapter()
    );
    const documentTypes = await docAdapter.loadAll();
    const allDocTypeKeys = new Set(documentTypes.map((d) => d.key));

    for (const spaceType of spaceTypes) {
      expect(Array.isArray(spaceType.spaceSchema.allowedDocumentTypes)).toBe(true);
      expect(spaceType.spaceSchema.allowedDocumentTypes.length).toBeGreaterThan(0);
      for (const allowedDocType of spaceType.spaceSchema.allowedDocumentTypes) {
        expect(allDocTypeKeys.has(allowedDocType)).toBe(true);
      }
    }

    const projectsSpace = spaceTypes.find((s) => s.id === 'projects');
    expect(projectsSpace?.spaceSchema.defaultDocumentType).toBe('communication-project');

    const proposalsSpace = spaceTypes.find((s) => s.id === 'proposals');
    expect(proposalsSpace?.spaceSchema.defaultDocumentType).toBe('communication-proposal');
  });

  it('should have defaultValue: IN on direction field for communication schemas', async () => {
    const manifestPath = path.resolve(__dirname, '../../assets/manifest.json');
    const manifestProvider = new AppManifestProvider({ manifestPath });
    const adapter = new DocumentSchemaRegistryAdapter(
      manifestProvider,
      new HandlebarsAdapter()
    );
    const documentTypes = await adapter.loadAll();

    for (const key of ['communication-project', 'communication-proposal']) {
      const docType = documentTypes.find((d) => d.key === key);
      expect(docType).toBeDefined();
      const directionField = docType!.documentSchema.fields.find((f) => f.key === 'direction');
      expect(directionField).toBeDefined();
      expect(directionField?.defaultValue).toBe('IN');
    }
  });

  it('should configure contact field in communication-project with optionSources (google_drive), key/name, allowUserInput: true, and aligned identity templates', async () => {
    const manifestPath = path.resolve(__dirname, '../../assets/manifest.json');
    const manifestProvider = new AppManifestProvider({ manifestPath });
    const adapter = new DocumentSchemaRegistryAdapter(
      manifestProvider,
      new HandlebarsAdapter()
    );
    const documentTypes = await adapter.loadAll();

    const commProject = documentTypes.find((d) => d.key === 'communication-project');
    expect(commProject).toBeDefined();

    const contactField = commProject!.documentSchema.fields.find((f) => f.key === 'contact');
    expect(contactField).toBeDefined();
    expect(contactField?.options).toEqual({
      source: 'contactFolders',
      key: 'key',
      name: 'name',
      allowUserInput: true,
    });
    expect(commProject!.documentSchema.optionSources?.contactFolders).toEqual({
      provider: 'google_drive',
      method: 'list_folders',
      relativePath: '1 Admin/Communication',
      properties: ['key', 'name'],
    });

    expect(commProject!.documentSchema.identity).toEqual({
      id: '{{contact.key}}-{{date}}-{{direction.key}}-{{description}}',
      idDocument: '{{contact.key}}-{{date}}-{{direction.key}}-{{description}}',
      idGroup: '{{contact.name}}',
    });
  });

  it('should configure contact field in communication-proposal with optionSources (google_drive), allowUserInput: true, and aligned identity templates', async () => {
    const manifestPath = path.resolve(__dirname, '../../assets/manifest.json');
    const manifestProvider = new AppManifestProvider({ manifestPath });
    const adapter = new DocumentSchemaRegistryAdapter(
      manifestProvider,
      new HandlebarsAdapter()
    );
    const documentTypes = await adapter.loadAll();

    const commProposal = documentTypes.find((d) => d.key === 'communication-proposal');
    expect(commProposal).toBeDefined();

    const contactField = commProposal!.documentSchema.fields.find((f) => f.key === 'contact');
    expect(contactField).toBeDefined();
    expect(contactField?.options).toEqual({
      source: 'contactFolders',
      key: 'key',
      name: 'name',
      allowUserInput: true,
    });
    expect(commProposal!.documentSchema.optionSources?.contactFolders).toEqual({
      provider: 'google_drive',
      method: 'list_folders',
      relativePath: 'Communications',
      properties: ['key', 'name'],
    });

    expect(commProposal!.documentSchema.identity).toEqual({
      id: '{{contact.key}}-{{date}}-{{direction.key}}-{{description}}',
      idDocument: '{{contact.key}}-{{date}}-{{direction.key}}-{{description}}',
      idGroup: '{{contact.name}}',
    });
  });

  describe('Production Manifest AppConfiguration defaults', () => {
    it('should configure workspace defaults and unfiled drive folder in production manifest.json', async () => {
      const manifestPath = path.resolve(__dirname, '../../assets/manifest.json');
      const manifestProvider = new AppManifestProvider({ manifestPath });

      const rawManifest = (await manifestProvider.getRawManifest()) as {
        configuration?: {
          workspace?: Record<string, unknown>;
          drive?: { defaultFolderName?: string; [key: string]: unknown };
        };
      };

      expect(rawManifest.configuration?.workspace).toEqual({
        defaultDocumentSpaceType: 'projects',
        defaultDocumentType: 'communication-project',
        timeZone: 'America/New_York',
      });
      expect(rawManifest.configuration?.workspace).not.toHaveProperty('appTitle');
      expect(rawManifest.configuration?.workspace).not.toHaveProperty('actionButtonText');
      expect(rawManifest.configuration?.workspace).not.toHaveProperty('defaultEventName');

      expect(rawManifest.configuration?.drive?.defaultFolderName).toBe('Unfiled');

      const workspaceConfig = await manifestProvider.getWorkspaceConfig();
      expect(workspaceConfig).toEqual({
        defaultDocumentSpaceType: 'projects',
        defaultDocumentType: 'communication-project',
        timeZone: 'America/New_York',
      });

      const driveConfig = await manifestProvider.getDriveConfig();
      expect(driveConfig?.defaultFolderName).toBe('Unfiled');
    });

    it('should validate shared contacts and vendors AliasDictionaries and DocumentParseSchemas across all four DocumentTypes', async () => {
      const manifestPath = path.resolve(__dirname, '../../assets/manifest.json');
      const manifestProvider = new AppManifestProvider({ manifestPath });
      const rawManifest = (await manifestProvider.getRawManifest()) as {
        aliases?: Record<string, string>;
      };

      expect(rawManifest.aliases).toBeDefined();
      expect(rawManifest.aliases?.contacts).toBe('./aliases/contacts.json');
      expect(rawManifest.aliases?.vendors).toBe('./aliases/vendors.json');

      const registry = new ParseSchemaRegistryAdapter(manifestProvider, new HandlebarsAdapter());
      await registry.initialize();

      const contactsDict = registry.getAliasDictionary('contacts');
      expect(contactsDict).toBeDefined();
      expect(contactsDict?.source).toBe('contacts');
      expect(Object.keys(contactsDict?.mappings ?? {}).length).toBeGreaterThan(0);

      const vendorsDict = registry.getAliasDictionary('vendors');
      expect(vendorsDict).toBeDefined();
      expect(vendorsDict?.source).toBe('vendors');
      expect(Object.keys(vendorsDict?.mappings ?? {}).length).toBeGreaterThan(0);

      for (const docKey of [
        'communication-project',
        'communication-proposal',
        'submittal-arch',
        'submittal-ffe',
      ]) {
        const parseSchema = registry.getParseSchema(docKey);
        expect(parseSchema).toBeDefined();
        expect(parseSchema?.extractors.length).toBeGreaterThan(0);
      }

      for (const commKey of ['communication-project', 'communication-proposal']) {
        const commParse = registry.getParseSchema(commKey);
        expect(commParse?.extractors.map((e) => e.source)).toEqual(['gmail', 'drive']);
        expect(registry.getDocumentFormSchema(commKey)).toBeUndefined();
        const commDrive = commParse?.extractors[1];
        expect(commDrive?.source).toBe('drive');
        if (commDrive?.source === 'drive') {
          expect(commDrive.fields).toEqual({
            date: [
              { from: 'drive.fileNameStem', normalize: 'yymmdd' },
              { from: 'drive.modifiedTime' },
              { from: 'drive.createdTime' },
            ],
          });
        }
      }

      const archParse = registry.getParseSchema('submittal-arch');
      const archExtractor = archParse?.extractors[0];
      expect(archExtractor?.source).toBe('gmail');
      if (archExtractor?.source === 'gmail') {
        expect(archExtractor.fields).toHaveProperty('action');
        expect(archExtractor.fields).toHaveProperty('date');
        expect(archExtractor.fields).toHaveProperty('contact');
        expect(archExtractor.fields).toHaveProperty('section');
        expect(archExtractor.fields).toHaveProperty('number');
        expect(archExtractor.fields).toHaveProperty('revision');
        expect(archExtractor.fields).toHaveProperty('title');
      }

      const archFormExtractor = archParse?.extractors[1];
      expect(archFormExtractor?.source).toBe('form');

      const archDriveExtractor = archParse?.extractors[2];
      expect(archDriveExtractor?.source).toBe('drive');
      if (archDriveExtractor?.source === 'drive') {
        expect(Object.keys(archDriveExtractor.fields)).toEqual([
          'section',
          'number',
          'revision',
          'title',
          'date',
        ]);
      }

      expect(registry.getDocumentFormSchema('submittal-arch')).toEqual({
        fields: {
          'Submittal No': {
            template: '{{section}}-{{number}}-{{revision}}',
          },
          'Submittal Response': {
            template: '{{action.name}}',
            valueMap: { RR: 'Revise and Resubmit' },
          },
          Date: {
            template: '{{date}}',
            format: 'date',
          },
        },
      });

      const ffeParse = registry.getParseSchema('submittal-ffe');
      expect(ffeParse?.extractors.map((e) => e.source)).toEqual(['gmail', 'form', 'drive']);
      const ffeExtractor = ffeParse?.extractors[0];
      expect(ffeExtractor?.source).toBe('gmail');
      if (ffeExtractor?.source === 'gmail') {
        expect(ffeExtractor.fields).toHaveProperty('action');
        expect(ffeExtractor.fields).toHaveProperty('date');
        expect(ffeExtractor.fields).toHaveProperty('contact');
        expect(ffeExtractor.fields).toHaveProperty('vendor');
        expect(ffeExtractor.fields).toHaveProperty('specTag');
        expect(ffeExtractor.fields).toHaveProperty('revision');
      }

      const ffeFormExtractor = ffeParse?.extractors[1];
      expect(ffeFormExtractor?.source).toBe('form');

      const ffeDriveExtractor = ffeParse?.extractors[2];
      expect(ffeDriveExtractor?.source).toBe('drive');
      if (ffeDriveExtractor?.source === 'drive') {
        expect(Object.keys(ffeDriveExtractor.fields)).toEqual([
          'specTag',
          'revision',
          'vendor',
          'date',
        ]);
      }

      expect(registry.getDocumentFormSchema('submittal-ffe')).toEqual({
        fields: {
          'Submittal No': {
            template: '{{specTag.key}}-{{revision}}',
          },
          'Submittal Response': {
            template: '{{action.name}}',
            valueMap: { RR: 'Revise and Resubmit' },
          },
          Date: {
            template: '{{date}}',
            format: 'date',
          },
        },
      });

      const ffeTargetSchema = registry.getTargetSchema('submittal-ffe');
      const nocOption = ffeTargetSchema?.options?.actions?.find((a) => a.key === 'NOC');
      expect(nocOption?.name).toBe('No Objections As Corrected');
    });

    it('should validate production configuration.documentLog and Submittal Arch / Submittal FF&E documentLogSchemas via LogSchemaRegistryAdapter', async () => {
      const manifestPath = path.resolve(__dirname, '../../assets/manifest.json');
      const manifestProvider = new AppManifestProvider({ manifestPath });
      const handlebars = new HandlebarsAdapter();

      const logRegistry = new LogSchemaRegistryAdapter(manifestProvider, handlebars);
      await logRegistry.initialize();

      expect(logRegistry.getDiscoveryConfig()).toEqual({
        preferredFolderPath: '1 Admin',
        fileNameContains: 'Document Log',
        excludePrefixes: ['Copy of '],
        excludeSubstrings: ['Template'],
        templateSpreadsheetId: '1Ops-suWgiqs-_PbaEvdx1WIdUWdVCctJkjS2rPjB42I',
        copyNameTemplate: '{{DocumentSpace.name}} Document Log',
      });

      expect(logRegistry.getSpaceFetchMethod('projects')).toBe('shared_drives');
      expect(logRegistry.getSpaceFetchMethod('proposals')).toBe('folders');

      const archLogSchema = logRegistry.getDocumentLogSchema('submittal-arch');
      expect(archLogSchema).toEqual({
        provider: 'google_sheets',
        target: {
          sheetName: 'Submittal Arch',
          rangeName: 'Log_Submittal_Arch',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
        grouping: {
          groupBy: 'idGroup',
          sortBy: 'id',
          groupSortOrder: 'asc',
          rowSortOrder: 'asc',
          duplicatePolicy: 'insert',
        },
        columns: {
          Status: { template: '{{status.key}}' },
          Section: { template: '{{section}}' },
          Number: { template: '{{number}}' },
          Revision: { template: '{{revision}}' },
          Title: { template: '{{title}}' },
          Date: { template: '{{date}}' },
          Contact: { template: '{{contact.key}}' },
          Action: { template: '{{action.name}}' },
          Notes: { template: '{{notes}}' },
          'Calc Link': { source: 'fileLink', label: 'Link' },
        },
        historyDisplay: {
          topLabel: 'Rev {{revision}} • {{section}}-{{number}} • {{status.key}}',
          text: '<b>{{action.name}}</b> {{date}} ({{contact.key}})',
          bottomLabel: '{{title}}',
        },
      });

      const ffeLogSchema = logRegistry.getDocumentLogSchema('submittal-ffe');
      expect(ffeLogSchema).toEqual({
        provider: 'google_sheets',
        target: {
          sheetName: 'Submittal FF&E',
          rangeName: 'Log_Submittal_FFE',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
        grouping: {
          groupBy: 'idGroup',
          sortBy: 'id',
          groupSortOrder: 'asc',
          rowSortOrder: 'asc',
          duplicatePolicy: 'insert',
        },
        columns: {
          Status: { template: '{{status.key}}' },
          'Spec Tag': { template: '{{specTag.key}}' },
          'Related Tag': { template: '{{relatedTag.key}}' },
          Revision: { template: '{{revision}}' },
          'Spec Title': { template: '{{specTitle}}', readOnly: true },
          Vendor: { template: '{{vendor.name}}' },
          Date: { template: '{{date}}' },
          Contact: { template: '{{contact.key}}' },
          Action: { template: '{{action.name}}' },
          Notes: { template: '{{notes}}' },
          'Calc Link': { source: 'fileLink', label: 'Link' },
        },
        historyDisplay: {
          topLabel: 'Rev {{revision}} • {{specTag.key}} • {{status.key}}',
          text: '<b>{{action.name}}</b> {{date}} ({{contact.key}})',
          bottomLabel: '{{specTitle}} — {{vendor.name}}',
        },
      });

      expect(logRegistry.getDocumentLogSchema('communication-project')).toBeUndefined();
      expect(logRegistry.getDocumentLogSchema('communication-proposal')).toBeUndefined();

      // Verify reactive onChange: true rollout on submittal idGroup fields
      const docAdapter = new DocumentSchemaRegistryAdapter(manifestProvider, handlebars);
      const allDocTypes = await docAdapter.loadAll();
      const archDocType = allDocTypes.find((d) => d.key === 'submittal-arch');
      const ffeDocType = allDocTypes.find((d) => d.key === 'submittal-ffe');

      const archUiFields = (archDocType?.documentUiSchema as UiSchemaType | undefined)?.fields;
      expect(archUiFields?.section?.onChange).toBe(true);
      expect(archUiFields?.number?.onChange).toBe(true);

      const ffeUiFields = (ffeDocType?.documentUiSchema as UiSchemaType | undefined)?.fields;
      expect(ffeUiFields?.specTag?.onChange).toBe(true);
    });
  });
});

describe('Split Option Schemas (optionSources & optionBindings) & Manifest Immutability (Ticket #356)', () => {
  const DOC_REL_PATH = './document-types/split-submittal.json';
  const DOC_KEY = 'split-submittal';

  function createSplitOptionFixture() {
    const manifest = {
      documentTypes: [DOC_REL_PATH],
      configuration: {
        documentLog: {
          preferredFolderPath: '1 Admin',
          fileNameContains: 'Document Log',
          excludePrefixes: ['Copy of '],
          excludeSubstrings: ['Template'],
          templateSpreadsheetId: 'template-spreadsheet-id',
          copyNameTemplate: '{{DocumentSpace.name}} Document Log',
        },
      },
    };

    const docType = {
      key: DOC_KEY,
      name: 'Split Submittal',
      documentSchema: {
        fields: [
          {
            key: 'status',
            name: 'Status',
            type: 'string',
            required: true,
            options: {
              source: 'statuses',
              key: 'key',
              allowUserInput: false,
            },
          },
          {
            key: 'action',
            name: 'Action',
            type: 'string',
            required: true,
            options: {
              source: 'actions',
              key: 'key',
              name: 'name',
              allowUserInput: false,
            },
          },
          {
            key: 'specTag',
            name: 'Spec Tag',
            type: 'string',
            required: true,
            options: {
              source: 'specs',
              key: 'key',
              name: 'name',
              allowUserInput: true,
            },
          },
          {
            key: 'specTitle',
            name: 'Spec Title',
            type: 'string',
            required: true,
            linkedField: {
              sourceField: 'specTag',
              sourceProperty: 'name',
            },
          },
          {
            key: 'contact',
            name: 'Contact',
            type: 'string',
            required: true,
            options: {
              source: 'contacts',
              key: 'key',
              name: 'name',
              allowUserInput: true,
            },
          },
          {
            key: 'folder',
            name: 'Folder',
            type: 'string',
            required: false,
            options: {
              source: 'contactFolders',
              key: 'key',
              name: 'name',
              allowUserInput: true,
            },
          },
        ],
        optionSources: {
          statuses: {
            provider: 'document_log',
            properties: ['key'],
          },
          actions: {
            provider: 'document_log',
            properties: ['key', 'name'],
          },
          specs: {
            provider: 'document_log',
            properties: ['key', 'name'],
          },
          contacts: {
            provider: 'document_log',
            properties: ['key', 'name'],
          },
          contactFolders: {
            provider: 'google_drive',
            method: 'list_folders',
            relativePath: '1 Admin/Communication',
            properties: ['key', 'name'],
          },
        },
        calculatedFields: [
          {
            key: 'summary',
            name: 'Summary',
            template: '{{specTag.key}} - {{specTitle}} ({{action.name}})',
          },
        ],
        identity: {
          id: '{{specTag.key}}-{{status.key}}',
          idDocument: '{{specTag.key}}',
          idGroup: '{{specTag.key}}',
        },
      },
      documentUiSchema: {
        layout: ['status', 'specTag', 'specTitle', 'contact', 'action', 'folder'],
        fields: {
          status: { widget: 'select' },
          specTag: { widget: 'select', onChange: true },
          specTitle: { widget: 'text' },
          contact: { widget: 'select' },
          action: { widget: 'select' },
          folder: { widget: 'select' },
        },
      },
      documentLogSchema: {
        provider: 'google_sheets',
        target: {
          sheetName: 'Submittal',
          rangeName: 'Log_Submittal',
          extentMarker: '<--->',
          groupDividerMarker: '---',
        },
        grouping: {
          groupBy: 'idGroup',
          sortBy: 'id',
          groupSortOrder: 'asc',
          rowSortOrder: 'asc',
          duplicatePolicy: 'insert',
        },
        columns: {
          Status: { template: '{{status.key}}' },
          'Spec Tag': { template: '{{specTag.key}}' },
          'Spec Title': { template: '{{specTitle}}', readOnly: true },
          Contact: { template: '{{contact.key}}' },
          Action: { template: '{{action.name}}' },
          'Calc Link': { source: 'fileLink', label: 'Link' },
        },
        historyDisplay: {
          topLabel: '{{specTag.key}} • {{status.key}}',
          text: '<b>{{action.name}}</b> ({{contact.key}})',
          bottomLabel: '{{specTitle}}',
        },
        optionBindings: {
          statuses: {
            sheetName: 'Lookups',
            rangeName: 'Tbl_Statuses',
            validationRangeName: 'Val_Statuses',
            endMarker: '<--->',
            columns: { Key: 'key' },
          },
          actions: {
            sheetName: 'Lookups',
            rangeName: 'Tbl_Actions',
            validationRangeName: 'Val_Actions',
            endMarker: '<--->',
            columns: { Key: 'key', Name: 'name' },
            aliasesColumn: 'Aliases',
          },
          specs: {
            sheetName: 'Lookups',
            rangeName: 'Tbl_Specs',
            validationRangeName: 'Val_Specs',
            endMarker: '<--->',
            columns: { Key: 'key', Name: 'name' },
            aliasesColumn: 'Aliases',
          },
          contacts: {
            sheetName: 'Lookups',
            rangeName: 'Tbl_Contacts',
            validationRangeName: 'Val_Contacts',
            endMarker: '<--->',
            columns: { Key: 'key', Name: 'name' },
            aliasesColumn: 'Aliases',
          },
        },
      },
      documentFormSchema: {
        fields: {
          'Submittal No': {
            template: '{{specTag.key}}',
          },
          'Submittal Response': {
            template: '{{action.name}}',
            valueMap: { RR: 'Revise and Resubmit' },
          },
        },
      },
    };

    return { manifest, docType };
  }

  function createMockManifestProvider(
    manifest: unknown,
    schemas: Record<string, unknown>
  ): RawManifestProviderPort {
    return {
      async getRawManifest(): Promise<unknown> {
        return structuredClone(manifest);
      },
      async readParsedSchema(relPath: string): Promise<unknown> {
        if (!(relPath in schemas)) {
          throw new Error(`Unknown schema path "${relPath}"`);
        }
        return structuredClone(schemas[relPath]);
      },
    };
  }

  it('loads split optionSources, optionBindings, LinkedField, documentLogSchema, and documentFormSchema across all registries and compiles dynamic allowUserInput: false fields as strings', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'inc-io-docs-ticket-356-'));
    try {
      const { manifest, docType } = createSplitOptionFixture();
      const manifestPath = path.join(tmpDir, 'manifest.json');
      const docDir = path.join(tmpDir, 'document-types');
      await fs.mkdir(docDir, { recursive: true });
      await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8');
      await fs.writeFile(
        path.join(tmpDir, DOC_REL_PATH),
        JSON.stringify(docType, null, 2),
        'utf-8'
      );

      const manifestProvider = new AppManifestProvider({ manifestPath });
      const handlebars = new HandlebarsAdapter();

      const docRegistry = new DocumentSchemaRegistryAdapter(
        manifestProvider,
        handlebars,
        ensureEvaluationOrder
      );
      const loadedDocTypes = await docRegistry.loadAll();
      expect(loadedDocTypes).toHaveLength(1);
      const loadedDoc = loadedDocTypes[0];
      expect(loadedDoc.key).toBe(DOC_KEY);
      expect(loadedDoc.documentSchema.optionSources).toEqual(docType.documentSchema.optionSources);
      expect(
        loadedDoc.documentSchema.fields.find((f) => f.key === 'specTitle')?.linkedField
      ).toEqual({
        sourceField: 'specTag',
        sourceProperty: 'name',
      });

      const compiledRegistry = new CompiledSchemaRegistry(docRegistry);
      await compiledRegistry.initialize();
      const compiledSchema = compiledRegistry.get(DOC_KEY);
      expect(compiledSchema).toBeDefined();

      // Dynamic allowUserInput: false fields (status, action) must validate as strings rather than Type.Never()
      expect(
        compiledSchema!.Check({
          status: 'Open',
          action: 'REC',
          specTag: '09-65-00',
          specTitle: 'Resilient Flooring',
          contact: 'JDOE',
        })
      ).toBe(true);
      expect(
        compiledSchema!.Check({
          status: 'Open',
          action: 'REC',
          specTag: '09-65-00',
          specTitle: 'Resilient Flooring',
          contact: 'JDOE',
          folder: 'Acme Corp',
        })
      ).toBe(true);
      expect(
        compiledSchema!.Check({
          status: 123,
          action: 'REC',
          specTag: '09-65-00',
          specTitle: 'Resilient Flooring',
          contact: 'JDOE',
        })
      ).toBe(false);

      const logRegistry = new LogSchemaRegistryAdapter(manifestProvider, handlebars);
      await logRegistry.initialize();
      expect(logRegistry.getTargetSchema(DOC_KEY)?.optionSources).toEqual(
        docType.documentSchema.optionSources
      );
      expect(logRegistry.getDocumentLogSchema(DOC_KEY)?.optionBindings).toEqual(
        docType.documentLogSchema.optionBindings
      );

      const parseRegistry = new ParseSchemaRegistryAdapter(manifestProvider, handlebars);
      await parseRegistry.initialize();
      expect(parseRegistry.getTargetSchema(DOC_KEY)?.optionSources).toEqual(
        docType.documentSchema.optionSources
      );
      expect(parseRegistry.getDocumentFormSchema(DOC_KEY)).toEqual(docType.documentFormSchema);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  describe('negative startup validation fixtures', () => {
    it('rejects LookupField referencing an unknown OptionSource in DocumentSchemaRegistryAdapter.loadAll()', async () => {
      const { manifest, docType } = structuredClone(createSplitOptionFixture());
      const statusField = docType.documentSchema.fields.find((f) => f.key === 'status')!;
      statusField.options!.source = 'unknown_source';

      const provider = createMockManifestProvider(manifest, { [DOC_REL_PATH]: docType });
      const registry = new DocumentSchemaRegistryAdapter(
        provider,
        new HandlebarsAdapter(),
        ensureEvaluationOrder
      );

      await expect(registry.loadAll()).rejects.toThrow(
        /Field "status" references unknown OptionSource "unknown_source"/
      );
    });

    it('rejects undeclared property in calculatedFields template in DocumentSchemaRegistryAdapter.loadAll()', async () => {
      const { manifest, docType } = structuredClone(createSplitOptionFixture());
      docType.documentSchema.calculatedFields[0].template = '{{action.undeclaredProp}}';

      const provider = createMockManifestProvider(manifest, { [DOC_REL_PATH]: docType });
      const registry = new DocumentSchemaRegistryAdapter(
        provider,
        new HandlebarsAdapter(),
        ensureEvaluationOrder
      );

      await expect(registry.loadAll()).rejects.toThrow(
        /documentSchema\.calculatedFields\[0\]\.template/
      );
    });

    it('rejects undeclared property in documentLogSchema.columns in LogSchemaRegistryAdapter.initialize()', async () => {
      const { manifest, docType } = structuredClone(createSplitOptionFixture());
      docType.documentLogSchema.columns.Action = { template: '{{action.undeclaredProp}}' };

      const provider = createMockManifestProvider(manifest, { [DOC_REL_PATH]: docType });
      const registry = new LogSchemaRegistryAdapter(provider, new HandlebarsAdapter());

      await expect(registry.initialize()).rejects.toThrow(
        /accesses unknown property "\.undeclaredProp" on LookupField "action"/
      );
    });

    it('rejects undeclared property in documentFormSchema in ParseSchemaRegistryAdapter.initialize()', async () => {
      const { manifest, docType } = structuredClone(createSplitOptionFixture());
      docType.documentFormSchema.fields['Submittal Response'].template =
        '{{action.undeclaredProp}}';

      const provider = createMockManifestProvider(manifest, { [DOC_REL_PATH]: docType });
      const registry = new ParseSchemaRegistryAdapter(provider, new HandlebarsAdapter());

      await expect(registry.initialize()).rejects.toThrow(
        /accesses unknown property "\.undeclaredProp" on LookupField "action"/
      );
    });

    it('rejects LinkedField.sourceProperty referencing an undeclared property in DocumentSchemaRegistryAdapter.loadAll()', async () => {
      const { manifest, docType } = structuredClone(createSplitOptionFixture());
      const specTitleField = docType.documentSchema.fields.find((f) => f.key === 'specTitle')!;
      specTitleField.linkedField!.sourceProperty = 'undeclaredProp';

      const provider = createMockManifestProvider(manifest, { [DOC_REL_PATH]: docType });
      const registry = new DocumentSchemaRegistryAdapter(
        provider,
        new HandlebarsAdapter(),
        ensureEvaluationOrder
      );

      await expect(registry.loadAll()).rejects.toThrow(
        /Field "specTitle" has invalid linkedField: sourceProperty "undeclaredProp" does not exist on sourceField "specTag" options/
      );
    });

    it('rejects document_log OptionSource lacking a matching OptionBinding in LogSchemaRegistryAdapter.initialize()', async () => {
      const { manifest, docType } = structuredClone(createSplitOptionFixture());
      const optionBindings = docType.documentLogSchema.optionBindings as Record<string, unknown>;
      delete optionBindings.statuses;

      const provider = createMockManifestProvider(manifest, { [DOC_REL_PATH]: docType });
      const registry = new LogSchemaRegistryAdapter(provider, new HandlebarsAdapter());

      await expect(registry.initialize()).rejects.toThrow(
        /missing binding for document_log OptionSource "statuses"/
      );
    });

    it('rejects OptionBinding.columns missing one or more declared OptionSource.properties in LogSchemaRegistryAdapter.initialize()', async () => {
      const { manifest, docType } = structuredClone(createSplitOptionFixture());
      docType.documentLogSchema.optionBindings.actions.columns = { Key: 'key' } as {
        Key: string;
        Name: string;
      };

      const provider = createMockManifestProvider(manifest, { [DOC_REL_PATH]: docType });
      const registry = new LogSchemaRegistryAdapter(provider, new HandlebarsAdapter());

      await expect(registry.initialize()).rejects.toThrow(
        /missing column mappings for declared properties: name/
      );
    });

    it('rejects legacy options.dynamicConfig across DocumentSchemaRegistryAdapter, LogSchemaRegistryAdapter, and ParseSchemaRegistryAdapter', async () => {
      const { manifest, docType } = structuredClone(createSplitOptionFixture());
      const folderField = docType.documentSchema.fields.find((f) => f.key === 'folder')!;
      (folderField.options as Record<string, unknown>).dynamicConfig = {
        provider: 'google_drive',
        method: 'list_folders',
        relativePath: '1 Admin/Communication',
      };

      const provider = createMockManifestProvider(manifest, { [DOC_REL_PATH]: docType });
      const handlebars = new HandlebarsAdapter();

      const docRegistry = new DocumentSchemaRegistryAdapter(
        provider,
        handlebars,
        ensureEvaluationOrder
      );
      await expect(docRegistry.loadAll()).rejects.toThrow(/dynamicConfig/i);

      const logRegistry = new LogSchemaRegistryAdapter(provider, handlebars);
      await expect(logRegistry.initialize()).rejects.toThrow(/dynamicConfig/i);

      const parseRegistry = new ParseSchemaRegistryAdapter(provider, handlebars);
      await expect(parseRegistry.initialize()).rejects.toThrow(/dynamicConfig/i);
    });
  });

  it('protects AppManifestProvider boot memoization via structuredClone immutability against caller mutations', async () => {
    const manifestPath = path.resolve(__dirname, '../../assets/manifest.json');
    const manifestProvider = new AppManifestProvider({ manifestPath });

    const rawManifest = (await manifestProvider.getRawManifest()) as {
      documentTypes: string[];
      configuration: { documentLog: { preferredFolderPath: string } };
      DocumentSpaceTypes: unknown[];
    };
    rawManifest.documentTypes.push('./document-types/does-not-exist.json');
    rawManifest.configuration.documentLog.preferredFolderPath = '';
    rawManifest.DocumentSpaceTypes = [];

    const rawArch = (await manifestProvider.readParsedSchema(
      './document-types/submittal-arch.json'
    )) as {
      key: string;
      documentSchema: { fields: unknown[] };
      documentLogSchema?: unknown;
    };
    rawArch.key = 'mutated-key';
    rawArch.documentSchema.fields.length = 0;
    delete rawArch.documentLogSchema;

    const freshManifest = (await manifestProvider.getRawManifest()) as {
      documentTypes: string[];
      configuration: { documentLog: { preferredFolderPath: string } };
    };
    expect(freshManifest.documentTypes).toHaveLength(4);
    expect(freshManifest.configuration.documentLog.preferredFolderPath).toBe('1 Admin');

    const freshArch = (await manifestProvider.readParsedSchema(
      './document-types/submittal-arch.json'
    )) as {
      key: string;
      documentSchema: { fields: unknown[] };
    };
    expect(freshArch.key).toBe('submittal-arch');
    expect(freshArch.documentSchema.fields.length).toBeGreaterThan(0);

    const handlebars = new HandlebarsAdapter();
    const docRegistry = new DocumentSchemaRegistryAdapter(
      manifestProvider,
      handlebars,
      ensureEvaluationOrder
    );
    const loadedDocs = await docRegistry.loadAll();
    expect(loadedDocs).toHaveLength(4);
    const archDoc = loadedDocs.find((d) => d.key === 'submittal-arch');
    expect(archDoc).toBeDefined();
    expect(archDoc!.documentSchema.fields.length).toBeGreaterThan(0);

    const logRegistry = new LogSchemaRegistryAdapter(manifestProvider, handlebars);
    await expect(logRegistry.initialize()).resolves.toBeUndefined();
    expect(logRegistry.getDiscoveryConfig()?.preferredFolderPath).toBe('1 Admin');
    expect(logRegistry.getDocumentLogSchema('submittal-arch')?.target.sheetName).toBe(
      'Submittal Arch'
    );
  });
});

