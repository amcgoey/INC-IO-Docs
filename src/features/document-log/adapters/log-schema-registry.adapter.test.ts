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

  it('rejects unknown extra properties on documentLogSchema and historyDisplay (additionalProperties: false)', async () => {
    const docWithExtraRoot = createValidArchDocDef();
    (docWithExtraRoot.documentLogSchema as Record<string, unknown>).unexpectedProp = true;

    const adapterRoot = new LogSchemaRegistryAdapter(
      {
        getRawManifest: vi.fn().mockResolvedValue({
          documentTypes: ['./document-types/submittal-arch.json'],
          configuration: { documentLog: createValidDiscoveryConfig() },
        }),
        readParsedSchema: vi.fn().mockResolvedValue(docWithExtraRoot),
      },
      parser
    );
    await expect(adapterRoot.initialize()).rejects.toThrow(DocumentLogConfigurationError);

    const docWithExtraHistoryProp = createValidArchDocDef();
    (docWithExtraHistoryProp.documentLogSchema as Record<string, unknown>).historyDisplay = {
      text: '<b>{{action.name}}</b>',
      extraProp: 'nope',
    };

    const adapterHistory = new LogSchemaRegistryAdapter(
      {
        getRawManifest: vi.fn().mockResolvedValue({
          documentTypes: ['./document-types/submittal-arch.json'],
          configuration: { documentLog: createValidDiscoveryConfig() },
        }),
        readParsedSchema: vi.fn().mockResolvedValue(docWithExtraHistoryProp),
      },
      parser
    );
    await expect(adapterHistory.initialize()).rejects.toThrow(DocumentLogConfigurationError);
  });

  it('hydrates valid optional historyDisplay with safe Google Card HTML tags in text and static or tokenized plain text in topLabel/bottomLabel', async () => {
    const validCases: Array<{ label: string; historyDisplay: Record<string, unknown> }> = [
      {
        label: 'full submittal-arch style with HTML formatting',
        historyDisplay: {
          topLabel: 'Rev {{revision}} • {{section}}-{{number}} • {{status.key}}',
          text: '<b>{{action.name}}</b> {{date}} ({{contact.key}})',
          bottomLabel: '{{title}}',
        },
      },
      {
        label: 'minimal text only with all allowlisted Google Card HTML tags',
        historyDisplay: {
          text: '<b>{{action.name}}</b> <i>{{date}}</i> <u>{{section}}</u> <s>{{number}}</s><br><font color="#b06000">{{status.key}}</font> <a href="https://example.com/docs">View</a> <time>{{date}}</time>',
        },
      },
      {
        label: 'static non-blank plain text (zero tokens) in topLabel and bottomLabel including raw < and &',
        historyDisplay: {
          topLabel: 'Submittal History & Notes <Arch>',
          text: '<b>{{action.name}}</b><br/>{{title}}',
          bottomLabel: 'Static plain label = OK',
        },
      },
    ];

    for (const testCase of validCases) {
      const docDef = createValidArchDocDef();
      (docDef.documentLogSchema as Record<string, unknown>).historyDisplay = testCase.historyDisplay;

      const adapter = new LogSchemaRegistryAdapter(
        {
          getRawManifest: vi.fn().mockResolvedValue({
            documentTypes: ['./document-types/submittal-arch.json'],
            configuration: { documentLog: createValidDiscoveryConfig() },
          }),
          readParsedSchema: vi.fn().mockResolvedValue(docDef),
        },
        parser
      );

      await expect(adapter.initialize(), testCase.label).resolves.toBeUndefined();
      expect(adapter.getDocumentLogSchema('submittal-arch')?.historyDisplay).toEqual(
        testCase.historyDisplay
      );
    }
  });

  it('rejects invalid historyDisplay (blank strings, 0-token text, disallowed/unbalanced HTML, and invalid tokens across text/topLabel/bottomLabel)', async () => {
    const invalidCases: Array<{ label: string; historyDisplay: unknown }> = [
      { label: 'missing text', historyDisplay: { topLabel: '{{section}}' } },
      { label: 'blank text', historyDisplay: { text: '   ' } },
      { label: 'blank topLabel', historyDisplay: { topLabel: '   ', text: '{{title}}' } },
      { label: 'blank bottomLabel', historyDisplay: { text: '{{title}}', bottomLabel: '   ' } },
      { label: 'zero tokens in text', historyDisplay: { text: '<b>Static Only</b>' } },
      { label: 'disallowed <script> tag', historyDisplay: { text: '<script>{{title}}</script>' } },
      { label: 'disallowed <img> tag', historyDisplay: { text: '<img src="x">{{title}}' } },
      { label: 'disallowed <div> tag', historyDisplay: { text: '<div>{{title}}</div>' } },
      { label: 'HTML comment in text', historyDisplay: { text: '<!-- hi -->{{title}}' } },
      { label: 'unclosed <b> tag', historyDisplay: { text: '<b>{{action.name}}' } },
      { label: 'stray closing </b> tag', historyDisplay: { text: '{{action.name}}</b>' } },
      { label: 'mismatched nested tags', historyDisplay: { text: '<b><i>{{action.name}}</b></i>' } },
      { label: 'closing </br> tag', historyDisplay: { text: '{{action.name}}</br>' } },
      { label: 'attribute on <b>', historyDisplay: { text: '<b onclick="x">{{action.name}}</b>' } },
      { label: 'javascript href in <a>', historyDisplay: { text: '<a href="javascript:alert(1)">{{title}}</a>' } },
      { label: '<a> missing href', historyDisplay: { text: '<a>{{title}}</a>' } },
      { label: '<a> extra onclick attr', historyDisplay: { text: '<a href="https://example.com" onclick="x">{{title}}</a>' } },
      { label: '<font> missing color', historyDisplay: { text: '<font>{{title}}</font>' } },
      { label: '<font> disallowed attr', historyDisplay: { text: '<font style="color:red">{{title}}</font>' } },
      { label: 'token inside HTML tag attribute', historyDisplay: { text: '<a href="{{title}}">Open</a>' } },
      { label: 'raw < in HTML literal', historyDisplay: { text: '{{section}} < {{number}}' } },
      { label: 'raw > in HTML literal', historyDisplay: { text: '{{section}} > {{number}}' } },
      { label: 'CalculatedField in text', historyDisplay: { text: '{{fileName}}' } },
      { label: 'CalculatedField in topLabel', historyDisplay: { topLabel: '{{fileName}}', text: '{{title}}' } },
      { label: 'disallowed namespace in bottomLabel', historyDisplay: { text: '{{title}}', bottomLabel: '{{Document.id}}' } },
      { label: 'logic block in text', historyDisplay: { text: '{{#if title}}{{title}}{{/if}}' } },
      { label: 'helper in topLabel', historyDisplay: { topLabel: '{{upper section}}', text: '{{title}}' } },
      { label: 'comment in bottomLabel', historyDisplay: { text: '{{title}}', bottomLabel: '{{! comment }}{{date}}' } },
      { label: 'triple-stache in text', historyDisplay: { text: '{{{title}}}' } },
      { label: 'invalid .prop on non-lookup in text', historyDisplay: { text: '{{title.key}}' } },
      { label: 'unknown .prop on lookup in topLabel', historyDisplay: { topLabel: '{{action.badProp}}', text: '{{title}}' } },
      { label: 'unknown field in bottomLabel', historyDisplay: { text: '{{title}}', bottomLabel: '{{nonExistent}}' } },
    ];

    for (const testCase of invalidCases) {
      const docDef = createValidArchDocDef();
      (docDef.documentLogSchema as Record<string, unknown>).historyDisplay = testCase.historyDisplay;

      const adapter = new LogSchemaRegistryAdapter(
        {
          getRawManifest: vi.fn().mockResolvedValue({
            documentTypes: ['./document-types/submittal-arch.json'],
            configuration: { documentLog: createValidDiscoveryConfig() },
          }),
          readParsedSchema: vi.fn().mockResolvedValue(docDef),
        },
        parser
      );

      await expect(adapter.initialize(), `Expected failure for: ${testCase.label}`).rejects.toThrow(
        DocumentLogConfigurationError
      );
    }
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

  it('allows dynamic LookupField declared .prop references in column templates', async () => {
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
      },
    });
    (docDef.documentSchema as Record<string, unknown>).optionSources = {
      dynContacts: {
        provider: 'google_drive',
        method: 'list_folders',
        properties: ['key', 'customAttr'],
      },
    };
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

  it('fails fast when a DocumentType with WRITE_LOG or READ_LOG step omits documentLogSchema', async () => {
    const writeDocDef = createValidArchDocDef();
    delete (writeDocDef as { documentLogSchema?: unknown }).documentLogSchema;

    const writeProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./document-types/submittal-arch.json'],
        configuration: { documentLog: createValidDiscoveryConfig() },
      }),
      readParsedSchema: vi.fn().mockResolvedValue(writeDocDef),
    };

    const writeAdapter = new LogSchemaRegistryAdapter(writeProvider, parser);
    await expect(writeAdapter.initialize()).rejects.toThrow(/documentLogSchema/i);

    const readDocDef = createValidArchDocDef({
      documentWorkflowConfig: {
        workflows: [
          {
            name: 'LookupPriorLogs',
            activitySequence: [{ type: 'READ_LOG', payload: {} }],
          },
        ],
      },
    });
    delete (readDocDef as { documentLogSchema?: unknown }).documentLogSchema;

    const readProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./document-types/submittal-arch.json'],
        configuration: { documentLog: createValidDiscoveryConfig() },
      }),
      readParsedSchema: vi.fn().mockResolvedValue(readDocDef),
    };

    const readAdapter = new LogSchemaRegistryAdapter(readProvider, parser);
    await expect(readAdapter.initialize()).rejects.toThrow(DocumentLogConfigurationError);
    await expect(readAdapter.initialize()).rejects.toThrow(/READ_LOG.*documentLogSchema/i);
  });

  it('retains minLength and pattern on LogTargetDocumentFieldSchema and allows READ_LOG when documentLogSchema is present', async () => {
    const docDef = createValidArchDocDef({
      documentWorkflowConfig: {
        workflows: [
          {
            name: 'LookupAndWrite',
            activitySequence: [
              { id: 'readPrior', type: 'READ_LOG', payload: { filterBy: 'idGroup', values: ['{{Document.idGroup}}'] } },
              { type: 'WRITE_LOG', payload: {} },
            ],
          },
        ],
      },
    });
    (docDef.documentSchema.fields[1] as Record<string, unknown>).pattern = '^\\d{6}$';
    (docDef.documentSchema.fields[3] as Record<string, unknown>).minLength = 1;
    (docDef.documentSchema.fields[3] as Record<string, unknown>).pattern = '^.*\\S+.*$';

    const provider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: ['./document-types/submittal-arch.json'],
        configuration: { documentLog: createValidDiscoveryConfig() },
      }),
      readParsedSchema: vi.fn().mockResolvedValue(docDef),
    };

    const adapter = new LogSchemaRegistryAdapter(provider, parser);
    await expect(adapter.initialize()).resolves.toBeUndefined();

    const target = adapter.getTargetSchema('submittal-arch');
    const sectionField = target?.fields.find((f) => f.key === 'section');
    const revisionField = target?.fields.find((f) => f.key === 'revision');
    expect(sectionField?.pattern).toBe('^\\d{6}$');
    expect(revisionField?.minLength).toBe(1);
    expect(revisionField?.pattern).toBe('^.*\\S+.*$');
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

  it('records storageConfig.fetchMethod per DocumentSpaceType.id and returns undefined for unregistered spaceTypeIds', async () => {
    const manifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: [],
        configuration: { documentLog: createValidDiscoveryConfig() },
        DocumentSpaceTypes: [
          {
            id: 'projects',
            displayName: 'Projects',
            storageConfig: { provider: 'google_drive', fetchMethod: 'shared_drives' },
          },
          {
            id: 'proposals',
            displayName: 'Proposals',
            storageConfig: { provider: 'google_drive', fetchMethod: 'folders' },
          },
        ],
      }),
      readParsedSchema: vi.fn(),
    };

    const adapter = new LogSchemaRegistryAdapter(manifestProvider, parser);
    await adapter.initialize();

    expect(adapter.getSpaceFetchMethod('projects')).toBe('shared_drives');
    expect(adapter.getSpaceFetchMethod('proposals')).toBe('folders');
    expect(adapter.getSpaceFetchMethod('unregistered')).toBeUndefined();
  });

  it('deep-merges partial DocumentSpaceTypes[].documentLog overrides over configuration.documentLog per spaceTypeId', async () => {
    const baseDiscovery = createValidDiscoveryConfig();
    const manifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: [],
        configuration: { documentLog: baseDiscovery },
        DocumentSpaceTypes: [
          {
            id: 'projects',
            displayName: 'Projects',
            storageConfig: { provider: 'google_drive', fetchMethod: 'shared_drives' },
          },
          {
            id: 'proposals',
            displayName: 'Proposals',
            storageConfig: { provider: 'google_drive', fetchMethod: 'folders' },
            documentLog: {
              preferredFolderPath: '01 Admin/Logs',
              excludePrefixes: ['OLD_', 'Copy of '],
              copyNameTemplate: '{{DocumentSpace.id}} - {{DocumentSpace.name}} Log',
            },
          },
        ],
      }),
      readParsedSchema: vi.fn(),
    };

    const adapter = new LogSchemaRegistryAdapter(manifestProvider, parser);
    await adapter.initialize();

    expect(adapter.getDiscoveryConfig('proposals')).toEqual({
      preferredFolderPath: '01 Admin/Logs',
      fileNameContains: baseDiscovery.fileNameContains,
      excludePrefixes: ['OLD_', 'Copy of '],
      excludeSubstrings: baseDiscovery.excludeSubstrings,
      templateSpreadsheetId: baseDiscovery.templateSpreadsheetId,
      copyNameTemplate: '{{DocumentSpace.id}} - {{DocumentSpace.name}} Log',
    });
    expect(adapter.getDiscoveryConfig('projects')).toEqual(baseDiscovery);
    expect(adapter.getDiscoveryConfig()).toEqual(baseDiscovery);
  });

  it('validates overridden copyNameTemplate on DocumentSpaceTypes[].documentLog strictly against DocumentSpace.* variables', async () => {
    for (const badTemplate of [
      '{{DocumentSpace.unknown}} Log',
      '{{Document.name}} Log',
      '{{#if DocumentSpace.name}}Log{{/if}}',
      '{{{DocumentSpace.name}}} Log',
    ]) {
      const manifestProvider: RawManifestProviderPort = {
        getRawManifest: vi.fn().mockResolvedValue({
          documentTypes: [],
          configuration: { documentLog: createValidDiscoveryConfig() },
          DocumentSpaceTypes: [
            {
              id: 'proposals',
              displayName: 'Proposals',
              documentLog: {
                copyNameTemplate: badTemplate,
              },
            },
          ],
        }),
        readParsedSchema: vi.fn(),
      };

      const adapter = new LogSchemaRegistryAdapter(manifestProvider, parser);
      await expect(adapter.initialize(), badTemplate).rejects.toThrow(DocumentLogConfigurationError);
    }
  });

  it('fails fast on invalid DocumentSpaceTypes[].documentLog overrides without leaving stale state', async () => {
    const invalidCases: Array<{ label: string; rawManifest: Record<string, unknown> }> = [
      {
        label: 'unknown property on override (additionalProperties: false)',
        rawManifest: {
          documentTypes: [],
          configuration: { documentLog: createValidDiscoveryConfig() },
          DocumentSpaceTypes: [
            {
              id: 'projects',
              storageConfig: { fetchMethod: 'shared_drives' },
            },
            {
              id: 'proposals',
              storageConfig: { fetchMethod: 'folders' },
              documentLog: {
                preferredFolderPath: '01 Admin',
                extraUnknownField: 'bad',
              },
            },
          ],
        },
      },
      {
        label: 'blank string in override field',
        rawManifest: {
          documentTypes: [],
          configuration: { documentLog: createValidDiscoveryConfig() },
          DocumentSpaceTypes: [
            {
              id: 'projects',
              storageConfig: { fetchMethod: 'shared_drives' },
            },
            {
              id: 'proposals',
              documentLog: {
                preferredFolderPath: '   ',
              },
            },
          ],
        },
      },
      {
        label: 'blank string element in override array',
        rawManifest: {
          documentTypes: [],
          configuration: { documentLog: createValidDiscoveryConfig() },
          DocumentSpaceTypes: [
            {
              id: 'proposals',
              documentLog: {
                excludePrefixes: ['Valid', '   '],
              },
            },
          ],
        },
      },
      {
        label: 'partial override while configuration.documentLog is omitted',
        rawManifest: {
          documentTypes: [],
          DocumentSpaceTypes: [
            {
              id: 'projects',
              storageConfig: { fetchMethod: 'shared_drives' },
            },
            {
              id: 'proposals',
              documentLog: {
                preferredFolderPath: '01 Admin',
              },
            },
          ],
        },
      },
      {
        label: 'documentLog override declared on entry with missing id',
        rawManifest: {
          documentTypes: [],
          configuration: { documentLog: createValidDiscoveryConfig() },
          DocumentSpaceTypes: [
            {
              id: 'projects',
              storageConfig: { fetchMethod: 'shared_drives' },
            },
            {
              displayName: 'Missing ID',
              documentLog: {
                preferredFolderPath: '01 Admin',
              },
            },
          ],
        },
      },
      {
        label: 'documentLog override declared on entry with blank id',
        rawManifest: {
          documentTypes: [],
          configuration: { documentLog: createValidDiscoveryConfig() },
          DocumentSpaceTypes: [
            {
              id: '   ',
              displayName: 'Blank ID',
              documentLog: {
                preferredFolderPath: '01 Admin',
              },
            },
          ],
        },
      },
    ];

    for (const testCase of invalidCases) {
      const manifestProvider: RawManifestProviderPort = {
        getRawManifest: vi.fn().mockResolvedValue(testCase.rawManifest),
        readParsedSchema: vi.fn(),
      };
      const adapter = new LogSchemaRegistryAdapter(manifestProvider, parser);
      await expect(adapter.initialize(), testCase.label).rejects.toThrow(DocumentLogConfigurationError);
      expect(adapter.getDiscoveryConfig(), `${testCase.label}: no stale base discoveryConfig`).toBeUndefined();
      expect(adapter.getDiscoveryConfig('projects'), `${testCase.label}: no stale projects discoveryConfig`).toBeUndefined();
      expect(adapter.getDiscoveryConfig('proposals'), `${testCase.label}: no stale proposals discoveryConfig`).toBeUndefined();
      expect(adapter.getSpaceFetchMethod('projects'), `${testCase.label}: no stale fetchMethod`).toBeUndefined();
    }
  });

  it('allows a complete DocumentSpaceTypes[].documentLog without configuration.documentLog when no DocumentType requires configuration.documentLog', async () => {
    const completeOverride = createValidDiscoveryConfig({
      preferredFolderPath: 'Proposals Admin',
    });
    const manifestProvider: RawManifestProviderPort = {
      getRawManifest: vi.fn().mockResolvedValue({
        documentTypes: [],
        DocumentSpaceTypes: [
          {
            id: 'proposals',
            displayName: 'Proposals',
            storageConfig: { fetchMethod: 'folders' },
            documentLog: completeOverride,
          },
        ],
      }),
      readParsedSchema: vi.fn(),
    };

    const adapter = new LogSchemaRegistryAdapter(manifestProvider, parser);
    await expect(adapter.initialize()).resolves.toBeUndefined();
    expect(adapter.getDiscoveryConfig()).toBeUndefined();
    expect(adapter.getDiscoveryConfig('proposals')).toEqual(completeOverride);
    expect(adapter.getSpaceFetchMethod('proposals')).toBe('folders');
  });

  describe('OptionSources & OptionBindings cross-schema validation (Spec #355 / Ticket #356)', () => {
    function createOptionSourcesDocDef() {
      const base = createValidArchDocDef();
      delete (base.documentSchema as Record<string, unknown>).options;
      (base.documentSchema as Record<string, unknown>).optionSources = {
        statuses: { provider: 'document_log', properties: ['key'] },
        actions: { provider: 'document_log', properties: ['key', 'name', 'order'] },
        contacts: { provider: 'document_log', properties: ['key', 'name'] },
      };
      (base.documentLogSchema as Record<string, unknown>).optionBindings = {
        statuses: {
          sheetName: '_Config',
          rangeName: 'Options_Submittal_Arch_Statuses',
          validationRangeName: 'Validation_Submittal_Arch_Statuses',
          endMarker: '---',
          columns: { Status: 'key' },
        },
        actions: {
          sheetName: '_Config',
          rangeName: 'Options_Submittal_Arch_Actions',
          endMarker: '---',
          columns: { Action: 'key', Description: 'name', Order: 'order' },
        },
        contacts: {
          sheetName: '_Config',
          rangeName: 'Options_Contacts',
          endMarker: '---',
          columns: { Key: 'key', Company: 'name' },
          aliasesColumn: 'Aliases',
        },
      };
      return base;
    }

    it('hydrates optionSources on targetSchema and optionBindings on documentLogSchema when all declared properties are covered', async () => {
      const docDef = createOptionSourcesDocDef();
      const adapter = new LogSchemaRegistryAdapter(
        {
          getRawManifest: vi.fn().mockResolvedValue({
            documentTypes: ['./document-types/submittal-arch.json'],
            configuration: { documentLog: createValidDiscoveryConfig() },
          }),
          readParsedSchema: vi.fn().mockResolvedValue(docDef),
        },
        parser
      );

      await expect(adapter.initialize()).resolves.toBeUndefined();
      const logSchema = adapter.getDocumentLogSchema('submittal-arch') as Record<string, unknown>;
      expect(logSchema.optionBindings).toEqual(
        (docDef.documentLogSchema as Record<string, unknown>).optionBindings
      );
      const targetSchema = adapter.getTargetSchema('submittal-arch') as Record<string, unknown>;
      expect(targetSchema.optionSources).toEqual(
        (docDef.documentSchema as Record<string, unknown>).optionSources
      );
    });

    it('fails fast when a document_log OptionSource lacks a matching OptionBinding or omits documentLogSchema', async () => {
      const missingBindingDoc = createOptionSourcesDocDef();
      delete ((missingBindingDoc.documentLogSchema as Record<string, unknown>).optionBindings as Record<string, unknown>).contacts;

      const missingBindingAdapter = new LogSchemaRegistryAdapter(
        {
          getRawManifest: vi.fn().mockResolvedValue({
            documentTypes: ['./document-types/submittal-arch.json'],
            configuration: { documentLog: createValidDiscoveryConfig() },
          }),
          readParsedSchema: vi.fn().mockResolvedValue(missingBindingDoc),
        },
        parser
      );
      await expect(missingBindingAdapter.initialize()).rejects.toThrow(
        /missing binding for document_log OptionSource "contacts"/i
      );

      const noLogSchemaDoc = createOptionSourcesDocDef();
      delete (noLogSchemaDoc as Record<string, unknown>).documentLogSchema;
      (noLogSchemaDoc as Record<string, unknown>).documentWorkflowConfig = { workflows: [] };

      const noLogSchemaAdapter = new LogSchemaRegistryAdapter(
        {
          getRawManifest: vi.fn().mockResolvedValue({
            documentTypes: ['./document-types/submittal-arch.json'],
            configuration: { documentLog: createValidDiscoveryConfig() },
          }),
          readParsedSchema: vi.fn().mockResolvedValue(noLogSchemaDoc),
        },
        parser
      );
      await expect(noLogSchemaAdapter.initialize()).rejects.toThrow(
        /without declaring documentLogSchema/i
      );
    });

    it('fails fast when an OptionBinding does not cover all declared OptionSource.properties or references a non-document_log source', async () => {
      const incompleteColumnsDoc = createOptionSourcesDocDef();
      ((incompleteColumnsDoc.documentLogSchema as Record<string, unknown>).optionBindings as Record<string, Record<string, unknown>>).actions.columns = {
        Action: 'key',
        Description: 'name',
      };

      const incompleteAdapter = new LogSchemaRegistryAdapter(
        {
          getRawManifest: vi.fn().mockResolvedValue({
            documentTypes: ['./document-types/submittal-arch.json'],
            configuration: { documentLog: createValidDiscoveryConfig() },
          }),
          readParsedSchema: vi.fn().mockResolvedValue(incompleteColumnsDoc),
        },
        parser
      );
      await expect(incompleteAdapter.initialize()).rejects.toThrow(
        /missing column mappings for declared properties: order/i
      );

      const extraBindingDoc = createOptionSourcesDocDef();
      ((extraBindingDoc.documentLogSchema as Record<string, unknown>).optionBindings as Record<string, unknown>).nonExistent = {
        sheetName: '_Config',
        rangeName: 'Options_NonExistent',
        endMarker: '---',
        columns: { Key: 'key' },
      };

      const extraBindingAdapter = new LogSchemaRegistryAdapter(
        {
          getRawManifest: vi.fn().mockResolvedValue({
            documentTypes: ['./document-types/submittal-arch.json'],
            configuration: { documentLog: createValidDiscoveryConfig() },
          }),
          readParsedSchema: vi.fn().mockResolvedValue(extraBindingDoc),
        },
        parser
      );
      await expect(extraBindingAdapter.initialize()).rejects.toThrow(
        /does not match a document_log OptionSource/i
      );
    });

    it('fails fast when documentLogSchema column or historyDisplay templates reference undeclared OptionSource properties', async () => {
      const badColDoc = createOptionSourcesDocDef();
      badColDoc.documentLogSchema.columns = {
        ...badColDoc.documentLogSchema.columns,
        BadProp: { template: '{{action.undeclaredProp}}' },
      } as typeof badColDoc.documentLogSchema.columns;

      const badColAdapter = new LogSchemaRegistryAdapter(
        {
          getRawManifest: vi.fn().mockResolvedValue({
            documentTypes: ['./document-types/submittal-arch.json'],
            configuration: { documentLog: createValidDiscoveryConfig() },
          }),
          readParsedSchema: vi.fn().mockResolvedValue(badColDoc),
        },
        parser
      );
      await expect(badColAdapter.initialize()).rejects.toThrow(
        /accesses unknown property "\.undeclaredProp"/i
      );
    });
  });
});
