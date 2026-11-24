import * as path from 'node:path';
import { describe, it, expect } from 'vitest';
import { DocumentSchemaRegistryAdapter } from '../../src/features/document/adapters/document-schema-registry';
import { AppManifestProvider } from '../../src/infrastructure/manifest/app-manifest-provider';
import { HandlebarsAdapter } from '../../src/infrastructure/template-engine/handlebars-adapter';
import {
  DocumentTypeSchema,
  formatValidationErrors,
} from '../../src/features/document/domain';
import { FormSchemaType } from '../../src/features/document/ports';
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

  it('should configure contact field in communication-project with dynamicConfig, key/name, allowUserInput: true, and aligned identity templates', async () => {
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
    expect(contactField?.options).toBeDefined();
    expect(contactField?.options?.allowUserInput).toBe(true);
    expect(contactField?.options?.source).toBe('contactFolders');
    expect(contactField?.options?.key).toBe('key');
    expect(contactField?.options?.name).toBe('name');
    expect(contactField?.options?.dynamicConfig).toEqual({
      provider: 'google_drive',
      method: 'list_folders',
      relativePath: '1 Admin/Communication',
    });

    expect(commProject!.documentSchema.identity).toEqual({
      id: '{{contact.key}}-{{date}}-{{direction.key}}-{{description}}',
      idDocument: '{{contact.key}}-{{date}}-{{direction.key}}-{{description}}',
      idGroup: '{{contact.name}}',
    });
  });

  it('should configure contact field in communication-proposal with dynamicConfig, allowUserInput: true, and aligned identity templates', async () => {
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
    expect(contactField?.options).toBeDefined();
    expect(contactField?.options?.allowUserInput).toBe(true);
    expect(contactField?.options?.source).toBe('contactFolders');
    expect(contactField?.options?.key).toBe('key');
    expect(contactField?.options?.name).toBe('name');
    expect(contactField?.options?.dynamicConfig).toEqual({
      provider: 'google_drive',
      method: 'list_folders',
      relativePath: 'Communications',
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
      });

      expect(logRegistry.getDocumentLogSchema('communication-project')).toBeUndefined();
      expect(logRegistry.getDocumentLogSchema('communication-proposal')).toBeUndefined();
    });
  });
});





