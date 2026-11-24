import { describe, it, expect, vi } from 'vitest';
import { LogSchemaRegistryAdapter } from './log-schema-registry.adapter';
import {
  DocumentLogConfigurationError,
  type RawManifestProviderPort,
} from '../ports';
import { HandlebarsAdapter } from '../../../infrastructure/template-engine/handlebars-adapter';

function createValidDiscoveryConfig(overrides?: Record<string, unknown>) {
  return {
    preferredFolderPath: '1 Admin',
    fileNameContains: 'Document Log',
    excludePrefixes: ['Copy of '],
    excludeSubstrings: ['Template'],
    templateSpreadsheetId: 'template-sheet-123',
    copyNameTemplate: '{{DocumentSpace.name}} Document Log',
    ...overrides,
  };
}

function createValidArchDocDef(overrides?: Record<string, unknown>) {
  return {
    key: 'submittal-arch',
    name: 'Submittal Arch',
    documentSchema: {
      fields: [
        {
          key: 'status',
          name: 'Status',
          type: 'string',
          required: true,
          options: { source: 'statuses', key: 'key' },
        },
        { key: 'section', name: 'Section', type: 'string', required: true },
        { key: 'number', name: 'Number', type: 'string', required: true },
        { key: 'revision', name: 'Revision', type: 'string', required: true },
        { key: 'title', name: 'Title', type: 'string', required: true },
        { key: 'date', name: 'Date', type: 'string', required: true },
        {
          key: 'contact',
          name: 'Contact',
          type: 'string',
          required: true,
          options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true },
        },
        {
          key: 'action',
          name: 'Action',
          type: 'string',
          required: true,
          options: { source: 'actions', key: 'key', name: 'name' },
        },
        { key: 'notes', name: 'Notes', type: 'string', required: false },
        {
          key: 'specTitle',
          name: 'Spec Title',
          type: 'string',
          required: false,
          linkedField: { sourceField: 'action', sourceProperty: 'name' },
        },
      ],
      calculatedFields: [{ key: 'fileName', name: 'File Name', template: '{{section}}-{{number}}' }],
      identity: {
        idGroup: '{{section}}-{{number}}',
        idDocument: '{{section}}-{{number}}-{{revision}}',
        id: '{{section}}-{{number}}-{{revision}}-{{date}}-{{action.order}}',
      },
      options: {
        statuses: [{ key: 'Open' }, { key: 'Closed' }],
        actions: [{ key: 'REC', name: 'Received', order: '1' }],
        contacts: [{ key: 'PMG', name: 'Pavarini McGovern' }],
      },
    },
    documentWorkflowConfig: {
      workflows: [
        {
          name: 'FileSubmittalArch',
          activitySequence: [
            { id: 'movePrimary', type: 'MOVE_FILE', payload: {} },
            { type: 'WRITE_LOG', payload: {} },
          ],
        },
      ],
    },
    documentLogSchema: {
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
    },
    ...overrides,
  };
}

describe('LogSchemaRegistryAdapter', () => {
  const parser = new HandlebarsAdapter();

  it('treats omitted manifestProvider as a safe no-op', async () => {
    const adapter = new LogSchemaRegistryAdapter(undefined, parser);
    await expect(adapter.initialize()).resolves.toBeUndefined();
    expect(adapter.getDiscoveryConfig()).toBeUndefined();
    expect(adapter.getDocumentLogSchema('submittal-arch')).toBeUndefined();
    expect(adapter.getTargetSchema('submittal-arch')).toBeUndefined();
  });

  it('hydrates discovery config, documentLogSchema, and minimal target schema, and is idempotent', async () => {
    const docDef = createValidArchDocDef({
      documentLogSchema: {
        ...createValidArchDocDef().documentLogSchema,
        columns: {
          ...createValidArchDocDef().documentLogSchema.columns,
          'Spec Title': { template: '{{specTitle}}', readOnly: true },
        },
      },
    });
    const getRawManifest = vi.fn().mockResolvedValue({
      documentTypes: ['./document-types/submittal-arch.json'],
      configuration: {
        documentLog: createValidDiscoveryConfig(),
      },
    });
    const readParsedSchema = vi.fn().mockResolvedValue(docDef);
    const manifestProvider: RawManifestProviderPort = { getRawManifest, readParsedSchema };

    const adapter = new LogSchemaRegistryAdapter(manifestProvider, parser);
    await adapter.initialize();
    await adapter.initialize();

    expect(getRawManifest).toHaveBeenCalledTimes(1);
    expect(readParsedSchema).toHaveBeenCalledTimes(1);

    expect(adapter.getDiscoveryConfig('projects')).toEqual(createValidDiscoveryConfig());
    const logSchema = adapter.getDocumentLogSchema('submittal-arch');
    expect(logSchema?.provider).toBe('google_sheets');
    expect(logSchema?.target.rangeName).toBe('Log_Submittal_Arch');
    expect(logSchema?.columns['Spec Title']).toEqual({ template: '{{specTitle}}', readOnly: true });

    const targetSchema = adapter.getTargetSchema('submittal-arch');
    expect(targetSchema?.identity).toEqual({
      idGroup: '{{section}}-{{number}}',
      idDocument: '{{section}}-{{number}}-{{revision}}',
      id: '{{section}}-{{number}}-{{revision}}-{{date}}-{{action.order}}',
    });
    expect(targetSchema?.fields.map((f) => f.key)).toContain('specTitle');
    expect(targetSchema?.calculatedFields).toEqual([{ key: 'fileName', name: 'File Name' }]);
    expect(targetSchema?.options?.actions).toEqual([{ key: 'REC', name: 'Received', order: '1' }]);
  });

  it('fails fast when at least one DocumentType declares documentLogSchema without configuration.documentLog', async () => {
    const manifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./document-types/submittal-arch.json'],
      }),
      readParsedSchema: vi.fn().mockResolvedValue(createValidArchDocDef()),
    };

    const adapter = new LogSchemaRegistryAdapter(manifestProvider, parser);
    await expect(adapter.initialize()).rejects.toThrow(DocumentLogConfigurationError);
  });

  it('strictly validates configuration.documentLog whenever present even without any documentLogSchema', async () => {
    const manifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: [],
        configuration: {
          documentLog: createValidDiscoveryConfig({ extraUnknownField: 'bad' }),
        },
      }),
      readParsedSchema: vi.fn(),
    };

    const adapter = new LogSchemaRegistryAdapter(manifestProvider, parser);
    await expect(adapter.initialize()).rejects.toThrow(DocumentLogConfigurationError);
  });

  it('validates copyNameTemplate strictly against DocumentSpace.* variables', async () => {
    for (const badTemplate of [
      '{{DocumentSpace}} Log',
      '{{DocumentSpace.unknown}} Log',
      '{{Document.space.name}} Log',
      '{{#if DocumentSpace.name}}Log{{/if}}',
      '{{{DocumentSpace.name}}} Log',
    ]) {
      const manifestProvider: RawManifestProviderPort = {
        getRawManifest: vi.fn().mockResolvedValue({
          documentTypes: [],
          configuration: {
            documentLog: createValidDiscoveryConfig({ copyNameTemplate: badTemplate }),
          },
        }),
        readParsedSchema: vi.fn(),
      };
      const adapter = new LogSchemaRegistryAdapter(manifestProvider, parser);
      await expect(adapter.initialize(), badTemplate).rejects.toThrow(DocumentLogConfigurationError);
    }
  });

  it('rejects historyDisplay and extra properties on documentLogSchema (additionalProperties: false)', async () => {
    const docWithHistory = createValidArchDocDef();
    (docWithHistory.documentLogSchema as Record<string, unknown>).historyDisplay = {
      topLabel: '{{section}}',
      text: '{{title}}',
      bottomLabel: '{{date}}',
    };

    const manifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./document-types/submittal-arch.json'],
        configuration: { documentLog: createValidDiscoveryConfig() },
      }),
      readParsedSchema: vi.fn().mockResolvedValue(docWithHistory),
    };

    const adapter = new LogSchemaRegistryAdapter(manifestProvider, parser);
    await expect(adapter.initialize()).rejects.toThrow(DocumentLogConfigurationError);
  });

  it('rejects invalid { template } column bindings (0-token, CalculatedField, Document.*, logic, helpers, comments, triple-stache, bad .prop)', async () => {
    const badTemplates = [
      'Static Only',
      '{{fileName}}',
      '{{Document.data.title}}',
      '{{Document.id}}',
      '{{unknownField}}',
      '{{#if notes}}{{notes}}{{/if}}',
      '{{upper title}}',
      '{{! comment }}{{title}}',
      '{{{title}}}',
      '{{title.key}}',
      '{{action.nonExistentProp}}',
      '{{@index}}',
      '{{this.title}}',
      '{{action.key.nested}}',
    ];

    for (const template of badTemplates) {
      const docDef = createValidArchDocDef();
      docDef.documentLogSchema.columns = {
        BadCol: { template },
      } as unknown as typeof docDef.documentLogSchema.columns;

      const manifestProvider: RawManifestProviderPort = {
        getRawManifest: vi.fn().mockResolvedValue({
          documentTypes: ['./document-types/submittal-arch.json'],
          configuration: { documentLog: createValidDiscoveryConfig() },
        }),
        readParsedSchema: vi.fn().mockResolvedValue(docDef),
      };

      const adapter = new LogSchemaRegistryAdapter(manifestProvider, parser);
      await expect(adapter.initialize(), `Expected failure for template: ${template}`).rejects.toThrow(
        DocumentLogConfigurationError
      );
    }
  });

  it('allows dynamic LookupField arbitrary .prop references in column templates', async () => {
    const docDef = createValidArchDocDef();
    (docDef.documentSchema.fields as Array<Record<string, unknown>>).push({
      key: 'dynContact',
      name: 'Dynamic Contact',
      type: 'string',
      required: true,
      options: {
        source: 'dynContacts',
        key: 'key',
        allowUserInput: true,
        dynamicConfig: { provider: 'google_drive', method: 'list_folders' },
      },
    });
    docDef.documentLogSchema.columns = {
      ...docDef.documentLogSchema.columns,
      DynamicCol: { template: '{{dynContact.customAttr}}' },
    } as typeof docDef.documentLogSchema.columns;

    const manifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./document-types/submittal-arch.json'],
        configuration: { documentLog: createValidDiscoveryConfig() },
      }),
      readParsedSchema: vi.fn().mockResolvedValue(docDef),
    };

    const adapter = new LogSchemaRegistryAdapter(manifestProvider, parser);
    await expect(adapter.initialize()).resolves.toBeUndefined();
  });

  it('fails fast when grouping.groupBy or grouping.sortBy is missing from documentSchema.identity', async () => {
    const docDef = createValidArchDocDef();
    docDef.documentLogSchema.grouping.sortBy = 'missingIdentityKey';

    const manifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./document-types/submittal-arch.json'],
        configuration: { documentLog: createValidDiscoveryConfig() },
      }),
      readParsedSchema: vi.fn().mockResolvedValue(docDef),
    };

    const adapter = new LogSchemaRegistryAdapter(manifestProvider, parser);
    await expect(adapter.initialize()).rejects.toThrow(/identity/i);
  });

  it('fails fast when a DocumentType with WRITE_LOG step omits documentLogSchema', async () => {
    const docDef = createValidArchDocDef();
    delete (docDef as { documentLogSchema?: unknown }).documentLogSchema;

    const manifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./document-types/submittal-arch.json'],
        configuration: { documentLog: createValidDiscoveryConfig() },
      }),
      readParsedSchema: vi.fn().mockResolvedValue(docDef),
    };

    const adapter = new LogSchemaRegistryAdapter(manifestProvider, parser);
    await expect(adapter.initialize()).rejects.toThrow(/documentLogSchema/i);
  });

  it('validates WRITE_LOG fileSourceStepId matches an earlier Activity.id in the same workflow', async () => {
    const validDoc = createValidArchDocDef({
      documentWorkflowConfig: {
        workflows: [
          {
            name: 'MultiStep',
            activitySequence: [
              { id: 'movePrimary', type: 'MOVE_FILE', payload: {} },
              { id: 'writeLog', type: 'WRITE_LOG', payload: { fileSourceStepId: 'movePrimary' } },
            ],
          },
        ],
      },
    });

    const validProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./document-types/submittal-arch.json'],
        configuration: { documentLog: createValidDiscoveryConfig() },
      }),
      readParsedSchema: vi.fn().mockResolvedValue(validDoc),
    };
    const validAdapter = new LogSchemaRegistryAdapter(validProvider, parser);
    await expect(validAdapter.initialize()).resolves.toBeUndefined();

    // Forward reference or unknown step id must fail
    for (const badPayload of [
      { fileSourceStepId: 'laterStep' },
      { fileSourceStepId: 'writeLog' },
      { fileSourceStepId: 'nonExistent' },
      { fileSourceStepId: 123 },
    ]) {
      const invalidDoc = createValidArchDocDef({
        documentWorkflowConfig: {
          workflows: [
            {
              name: 'MultiStep',
              activitySequence: [
                { id: 'writeLog', type: 'WRITE_LOG', payload: badPayload },
                { id: 'laterStep', type: 'MOVE_FILE', payload: {} },
              ],
            },
          ],
        },
      });
      const invalidProvider: RawManifestProviderPort = {
        getRawManifest: vi.fn().mockResolvedValue({
          documentTypes: ['./document-types/submittal-arch.json'],
          configuration: { documentLog: createValidDiscoveryConfig() },
        }),
        readParsedSchema: vi.fn().mockResolvedValue(invalidDoc),
      };
      const invalidAdapter = new LogSchemaRegistryAdapter(invalidProvider, parser);
      await expect(invalidAdapter.initialize()).rejects.toThrow(/fileSourceStepId/i);
    }
  });

  it('allows LinkedField targets (readOnly and writable) on Submittal FF&E, rejects .prop on LinkedField, and still rejects readOnly CalculatedFields', async () => {
    const createSubmittalFfeDocDef = (columnOverrides?: Record<string, unknown>) => ({
      key: 'submittal-ffe',
      name: 'Submittal FF&E',
      documentSchema: {
        fields: [
          {
            key: 'status',
            name: 'Status',
            type: 'string',
            required: true,
            options: { source: 'statuses', key: 'key' },
          },
          {
            key: 'specTag',
            name: 'Spec Tag',
            type: 'string',
            required: true,
            options: { source: 'specs', key: 'key', allowUserInput: true },
          },
          {
            key: 'relatedTag',
            name: 'Related Tag',
            type: 'string',
            required: false,
            options: { source: 'specs', key: 'key', allowUserInput: true },
          },
          { key: 'revision', name: 'Revision', type: 'string', required: true },
          {
            key: 'specTitle',
            name: 'Spec Title',
            type: 'string',
            required: true,
            linkedField: { sourceField: 'specTag', sourceProperty: 'name' },
          },
          {
            key: 'vendor',
            name: 'Vendor',
            type: 'string',
            required: true,
            options: { source: 'vendors', key: 'key', name: 'name', allowUserInput: true },
          },
          { key: 'date', name: 'Date', type: 'string', required: true },
          {
            key: 'contact',
            name: 'Contact',
            type: 'string',
            required: true,
            options: { source: 'contacts', key: 'key', name: 'name', allowUserInput: true },
          },
          {
            key: 'action',
            name: 'Action',
            type: 'string',
            required: true,
            options: { source: 'actions', key: 'key', name: 'name' },
          },
          { key: 'notes', name: 'Notes', type: 'string', required: false },
        ],
        calculatedFields: [
          {
            key: 'fileName',
            name: 'File Name',
            template: '{{specTag.key}}-{{revision}} {{vendor.name}}',
          },
        ],
        identity: {
          idGroup: '{{specTag.key}}',
          idDocument: '{{specTag.key}}-{{revision}}',
          id: '{{specTag.key}}-{{revision}}-{{date}}-{{action.order}}',
        },
        options: {
          statuses: [{ key: 'Open' }, { key: 'Closed' }],
          actions: [{ key: 'REC', name: 'Received', order: '1' }],
          contacts: [{ key: 'BW', name: 'Benjamin West' }],
          vendors: [{ key: 'FDT', name: 'Fil Doux Textiles' }],
          specs: [{ key: 'CG104', name: 'BED - KING' }],
        },
      },
      documentWorkflowConfig: {
        workflows: [
          {
            name: 'FileSubmittalFFE',
            activitySequence: [{ type: 'WRITE_LOG', payload: {} }],
          },
        ],
      },
      documentLogSchema: {
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
          ...columnOverrides,
        },
      },
    });

    const createProvider = (docDef: ReturnType<typeof createSubmittalFfeDocDef>): RawManifestProviderPort => ({
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./document-types/submittal-ffe.json'],
        configuration: { documentLog: createValidDiscoveryConfig() },
      }),
      readParsedSchema: vi.fn().mockResolvedValue(docDef),
    });

    // 1a. LinkedField with readOnly: true is allowed
    const readOnlyAdapter = new LogSchemaRegistryAdapter(
      createProvider(createSubmittalFfeDocDef()),
      parser
    );
    await expect(readOnlyAdapter.initialize()).resolves.toBeUndefined();
    expect(readOnlyAdapter.getDocumentLogSchema('submittal-ffe')?.columns['Spec Title']).toEqual({
      template: '{{specTitle}}',
      readOnly: true,
    });

    // 1b. Writable LinkedField (without readOnly) is also allowed
    const writableAdapter = new LogSchemaRegistryAdapter(
      createProvider(createSubmittalFfeDocDef({ 'Spec Title': { template: '{{specTitle}}' } })),
      parser
    );
    await expect(writableAdapter.initialize()).resolves.toBeUndefined();
    expect(writableAdapter.getDocumentLogSchema('submittal-ffe')?.columns['Spec Title']).toEqual({
      template: '{{specTitle}}',
    });

    // 2. Rejects .prop access on LinkedField since it is not a LookupField
    const badPropAdapter = new LogSchemaRegistryAdapter(
      createProvider(
        createSubmittalFfeDocDef({ 'Spec Title': { template: '{{specTitle.name}}', readOnly: true } })
      ),
      parser
    );
    await expect(badPropAdapter.initialize()).rejects.toThrow(DocumentLogConfigurationError);

    // 3. Continues rejecting CalculatedFields even when readOnly: true is set
    const calcAdapter = new LogSchemaRegistryAdapter(
      createProvider(
        createSubmittalFfeDocDef({ 'File Name': { template: '{{fileName}}', readOnly: true } })
      ),
      parser
    );
    await expect(calcAdapter.initialize()).rejects.toThrow(DocumentLogConfigurationError);
  });
});
