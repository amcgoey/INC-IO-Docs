import { describe, it, expect, vi } from 'vitest';
import { LookupOptionsService } from './domain';
import type {
  DocumentLogOptionSourcePort,
  DriveOptionSourcePort,
  LookupDocumentSchema,
  LookupManifestPort,
  LookupOptionsPort,
} from './ports';

function createManifestPort(
  schemas: Record<string, LookupDocumentSchema>
): LookupManifestPort {
  return {
    getDocumentSchema: vi.fn((documentTypeKey: string) => schemas[documentTypeKey]),
  };
}

describe('LookupOptionsService (LookupOptionsPort seam)', () => {
  const commSchema: LookupDocumentSchema = {
    fields: [
      {
        key: 'contact',
        options: {
          source: 'contactFolders',
          key: 'key',
          name: 'name',
          allowUserInput: true,
        },
      },
      {
        key: 'direction',
        options: {
          source: 'direction',
          key: 'key',
          name: 'name',
        },
      },
    ],
    options: {
      direction: [
        { key: 'IN', name: 'Incoming' },
        { key: 'OT', name: 'Outgoing' },
      ],
    },
    optionSources: {
      contactFolders: {
        provider: 'google_drive',
        method: 'list_folders',
        relativePath: '1 Admin/Communication',
        properties: ['key', 'name'],
      },
    },
  };

  it('resolves static DocumentSchema.options and google_drive OptionSource entries with explicit per-call context', async () => {
    const driveSource: DriveOptionSourcePort = {
      listFoldersAtPath: vi.fn().mockResolvedValue({
        status: 'ready',
        targetPath: '1 Admin/Communication',
        items: [
          { key: 'Acme Corp', name: 'Acme Corp' },
          { key: 'Pavarini', name: 'Pavarini' },
        ],
      }),
    };

    const service: LookupOptionsPort = new LookupOptionsService(
      createManifestPort({ 'communication-project': commSchema }),
      { driveOptionSource: driveSource }
    );

    const resolved = await service.resolveOptions({
      space: { id: 'space-1', abstractStorageId: 'storage-1' },
      documentTypeKey: 'communication-project',
    });

    expect(driveSource.listFoldersAtPath).toHaveBeenCalledWith({
      spaceStorageId: 'storage-1',
      relativePath: '1 Admin/Communication',
      maxItems: 150,
      signal: expect.any(AbortSignal),
    });
    expect(resolved.direction).toEqual({
      status: 'ready',
      tuples: [
        { key: 'IN', name: 'Incoming' },
        { key: 'OT', name: 'Outgoing' },
      ],
      items: [
        { text: 'Incoming', value: 'IN' },
        { text: 'Outgoing', value: 'OT' },
      ],
    });
    expect(resolved.contactFolders).toEqual({
      status: 'ready',
      targetPath: '1 Admin/Communication',
      tuples: [
        { key: 'Acme Corp', name: 'Acme Corp' },
        { key: 'Pavarini', name: 'Pavarini' },
      ],
      items: [
        { text: 'Acme Corp', value: 'Acme Corp' },
        { text: 'Pavarini', value: 'Pavarini' },
      ],
    });
  });

  it('formats autocomplete items using name when configured else key, and appends " (KEY)" only on duplicate display names', async () => {
    const disambigSchema: LookupDocumentSchema = {
      fields: [
        {
          key: 'vendor',
          options: { source: 'vendors', key: 'key', name: 'name', allowUserInput: true },
        },
        {
          key: 'specTag',
          options: { source: 'specs', key: 'key', allowUserInput: true },
        },
      ],
      options: {
        vendors: [
          { key: 'ACME1', name: 'Acme Corp' },
          { key: 'ACME2', name: 'Acme Corp' },
          { key: 'BF01', name: 'Berman Falk' },
        ],
        specs: [
          { key: 'LT108', name: 'SCONCE' },
          { key: 'LT134', name: 'SCONCE' },
        ],
      },
    };

    const service: LookupOptionsPort = new LookupOptionsService(
      createManifestPort({ 'test-doc': disambigSchema })
    );

    const resolved = await service.resolveOptions({
      documentTypeKey: 'test-doc',
    });

    expect(resolved.vendors.items).toEqual([
      { text: 'Acme Corp (ACME1)', value: 'ACME1' },
      { text: 'Acme Corp (ACME2)', value: 'ACME2' },
      { text: 'Berman Falk', value: 'BF01' },
    ]);

    // specTag has no options.name configured, so it displays key directly without disambiguating on name
    expect(resolved.specs.items).toEqual([
      { text: 'LT108', value: 'LT108' },
      { text: 'LT134', value: 'LT134' },
    ]);
  });

  it('matches trimmed case-insensitive key first and falls back to name only when options.name is configured', async () => {
    const matchSchema: LookupDocumentSchema = {
      fields: [
        {
          key: 'withName',
          options: { source: 'items', key: 'key', name: 'name' },
        },
        {
          key: 'withoutName',
          options: { source: 'specs', key: 'key' },
        },
      ],
      options: {
        items: [
          { key: 'A', name: 'B' },
          { key: 'B', name: 'A' },
        ],
        specs: [{ key: 'LT108', name: 'SCONCE' }],
      },
    };

    const service = new LookupOptionsService(createManifestPort({ 'match-doc': matchSchema }));

    // Key wins over name when both exist
    const keyWins = await service.matchOption({ documentTypeKey: 'match-doc' }, 'withName', '  b  ');
    expect(keyWins).toEqual({
      matched: true,
      key: 'B',
      tuple: { key: 'B', name: 'A' },
    });

    // Falls back to name when options.name is configured
    const disambigSchema: LookupDocumentSchema = {
      fields: [
        {
          key: 'vendor',
          options: { source: 'vendors', key: 'key', name: 'name' },
        },
      ],
      options: {
        vendors: [
          { key: 'ACME1', name: 'Acme Corp' },
          { key: 'ACME2', name: 'Acme Corp' },
          { key: 'BF01', name: 'Berman Falk' },
        ],
      },
    };
    const service2 = new LookupOptionsService(createManifestPort({ d: disambigSchema }));

    expect(await service2.matchOption({ documentTypeKey: 'd' }, 'vendor', '  berman falk ')).toEqual({
      matched: true,
      key: 'BF01',
      tuple: { key: 'BF01', name: 'Berman Falk' },
    });

    // Selecting disambiguated autocomplete text "Acme Corp (ACME2)" resolves to ACME2
    expect(
      await service2.matchOption({ documentTypeKey: 'd' }, 'vendor', 'Acme Corp (ACME2)')
    ).toEqual({
      matched: true,
      key: 'ACME2',
      tuple: { key: 'ACME2', name: 'Acme Corp' },
    });

    // Does NOT fall back to name when options.name is omitted
    expect(await service.matchOption({ documentTypeKey: 'match-doc' }, 'withoutName', 'SCONCE')).toEqual({
      matched: false,
    });
    expect(await service.matchOption({ documentTypeKey: 'match-doc' }, 'withoutName', ' lt108 ')).toEqual({
      matched: true,
      key: 'LT108',
      tuple: { key: 'LT108', name: 'SCONCE' },
    });
  });

  it('deduplicates concurrent and repeated lookups via in-flight Promise memoization and clears on invalidate()', async () => {
    let resolveFolders!: (value: {
      status: 'ready';
      targetPath: string;
      items: Array<{ key: string; name: string }>;
    }) => void;
    const listFoldersAtPath = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<{
            status: 'ready';
            targetPath: string;
            items: Array<{ key: string; name: string }>;
          }>((resolve) => {
            resolveFolders = resolve;
          })
      )
      .mockResolvedValue({
        status: 'ready',
        targetPath: '1 Admin/Communication',
        items: [{ key: 'Acme Corp', name: 'Acme Corp' }],
      });

    const service = new LookupOptionsService(
      createManifestPort({ 'communication-project': commSchema }),
      { driveOptionSource: { listFoldersAtPath } }
    );

    const ctx = {
      space: { id: 'space-1', abstractStorageId: 'storage-1' },
      documentTypeKey: 'communication-project',
    };

    const p1 = service.resolveOptions(ctx, ['contactFolders']);
    const p2 = service.getCanonicalOptions(ctx, 'contact');
    const p3 = service.validateFields(ctx, [
      { queryId: 'contact', fieldKey: 'contact', sourceKey: 'contactFolders', value: 'Acme Corp', allowUserInput: true },
    ]);

    await Promise.resolve();
    await Promise.resolve();
    expect(listFoldersAtPath).toHaveBeenCalledTimes(1);

    resolveFolders({
      status: 'ready',
      targetPath: '1 Admin/Communication',
      items: [{ key: 'Acme Corp', name: 'Acme Corp' }],
    });

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1.contactFolders.status).toBe('ready');
    expect(r2).toEqual([{ key: 'Acme Corp', name: 'Acme Corp' }]);
    expect(r3.contact.isValid).toBe(true);

    // Subsequent call with same context reuses memoized resolution
    await service.resolveOptions(ctx, ['contactFolders']);
    await Promise.resolve();
    await Promise.resolve();
    expect(listFoldersAtPath).toHaveBeenCalledTimes(1);

    // Different selectedLogId is keyed separately
    await service.resolveOptions({ ...ctx, selectedLogId: 'log-2' }, ['contactFolders']);
    expect(listFoldersAtPath).toHaveBeenCalledTimes(2);

    // Invalidate scoped to spaceId clears memoization for that space
    service.invalidate({ spaceId: 'storage-1' });
    await service.resolveOptions(ctx, ['contactFolders']);
    expect(listFoldersAtPath).toHaveBeenCalledTimes(3);
  });

  it('surfaces missing_space, timeout, error, and ambiguous_option statuses cleanly', async () => {
    const driveSource: DriveOptionSourcePort = {
      listFoldersAtPath: vi.fn().mockImplementation(async ({ spaceStorageId }) => {
        if (spaceStorageId === 'dup-space') {
          return {
            status: 'ready',
            targetPath: '1 Admin/Communication',
            items: [
              { key: 'Dup', name: 'Dup' },
              { key: 'Dup', name: 'Dup' },
            ],
          };
        }
        if (spaceStorageId === 'slow-space') {
          await new Promise((resolve) => setTimeout(resolve, 50));
          return { status: 'empty', targetPath: '1 Admin/Communication', items: [] };
        }
        throw new Error('Drive API failed');
      }),
    };

    const service = new LookupOptionsService(
      createManifestPort({ 'communication-project': commSchema }),
      { driveOptionSource: driveSource, timeoutMs: 15 }
    );

    const missing = await service.resolveOptions(
      { documentTypeKey: 'communication-project' },
      ['contactFolders']
    );
    expect(missing.contactFolders).toEqual({
      status: 'missing_space',
      tuples: [],
      items: [],
      targetPath: '1 Admin/Communication',
    });

    const timedOut = await service.resolveOptions(
      { space: { id: 'slow-space' }, documentTypeKey: 'communication-project' },
      ['contactFolders']
    );
    expect(timedOut.contactFolders.status).toBe('timeout');

    const errored = await service.resolveOptions(
      { space: { id: 'err-space' }, documentTypeKey: 'communication-project' },
      ['contactFolders']
    );
    expect(errored.contactFolders.status).toBe('error');

    const dupValidation = await service.validateFields(
      { space: { id: 'dup-space' }, documentTypeKey: 'communication-project' },
      [{ queryId: 'contact', fieldKey: 'contact', sourceKey: 'contactFolders', value: 'Dup', allowUserInput: true }]
    );
    expect(dupValidation.contact).toEqual({
      isValid: false,
      status: 'ambiguous_option',
      targetPath: '1 Admin/Communication',
    });

    const emptyVal = await service.validateFields(
      { space: { id: 'dup-space' }, documentTypeKey: 'communication-project' },
      [{ queryId: 'contact', fieldKey: 'contact', sourceKey: 'contactFolders', value: '   ', allowUserInput: true }]
    );
    expect(emptyVal.contact).toEqual({
      isValid: false,
      status: 'option_not_found',
      targetPath: '1 Admin/Communication',
    });
  });

  describe('document_log OptionSource integration (Ticket #358)', () => {
    const submittalArchSchema: LookupDocumentSchema = {
      fields: [
        {
          key: 'status',
          options: { source: 'statuses', key: 'key' },
        },
        {
          key: 'action',
          options: { source: 'actions', key: 'key', name: 'name' },
        },
      ],
      optionSources: {
        statuses: { provider: 'document_log', properties: ['key'] },
        actions: { provider: 'document_log', properties: ['key', 'name', 'suffix', 'order'] },
      },
    };

    it('batches all document_log sources for a request in one readOptionTables call, memoizes across resolveOptions and validateFields, and clears on invalidate()', async () => {
      const readOptionTables = vi.fn().mockResolvedValue({
        status: 'ready',
        spreadsheetId: 'log-arch-1',
        tables: {
          statuses: {
            status: 'ready',
            tuples: [{ key: 'Open' }, { key: 'Closed' }],
          },
          actions: {
            status: 'ready',
            tuples: [
              { key: 'REC', name: 'Received', suffix: '', order: '1' },
              { key: 'REF', name: 'Referred', suffix: '_REF', order: '2' },
            ],
          },
        },
      });

      const docLogSource: DocumentLogOptionSourcePort = { readOptionTables };
      const service = new LookupOptionsService(
        createManifestPort({ 'submittal-arch': submittalArchSchema }),
        { documentLogOptionSource: docLogSource }
      );

      const ctx = {
        space: { id: 'sp-1', typeId: 'projects', name: 'Proj 1', abstractStorageId: 'drive-1' },
        documentTypeKey: 'submittal-arch',
      };

      const resolved = await service.resolveOptions(ctx, ['statuses', 'actions']);
      expect(readOptionTables).toHaveBeenCalledTimes(1);
      expect(readOptionTables).toHaveBeenCalledWith({
        documentTypeKey: 'submittal-arch',
        space: ctx.space,
        sourceKeys: ['statuses', 'actions'],
        signal: expect.any(AbortSignal),
      });
      expect(resolved.statuses).toEqual({
        status: 'ready',
        tuples: [{ key: 'Open' }, { key: 'Closed' }],
        items: [
          { text: 'Open', value: 'Open' },
          { text: 'Closed', value: 'Closed' },
        ],
      });
      expect(resolved.actions).toEqual({
        status: 'ready',
        tuples: [
          { key: 'REC', name: 'Received', suffix: '', order: '1' },
          { key: 'REF', name: 'Referred', suffix: '_REF', order: '2' },
        ],
        items: [
          { text: 'Received', value: 'REC' },
          { text: 'Referred', value: 'REF' },
        ],
      });

      // Subsequent validation reuses memoized batch result with zero extra DocumentLog calls
      const validation = await service.validateFields(ctx, [
        { queryId: 'status', fieldKey: 'status', sourceKey: 'statuses', value: 'open', allowUserInput: false },
        { queryId: 'action', fieldKey: 'action', sourceKey: 'actions', value: 'Referred', allowUserInput: false },
      ]);
      expect(readOptionTables).toHaveBeenCalledTimes(1);
      expect(validation.status).toEqual({
        isValid: true,
        status: 'valid',
        canonicalValue: 'Open',
        matchedTuple: { key: 'Open' },
      });
      expect(validation.action).toEqual({
        isValid: true,
        status: 'valid',
        canonicalValue: 'REF',
        matchedTuple: { key: 'REF', name: 'Referred', suffix: '_REF', order: '2' },
      });

      // Invalid restricted dynamic LookupField fails with option_not_found
      const invalidVal = await service.validateFields(ctx, [
        { queryId: 'action', fieldKey: 'action', sourceKey: 'actions', value: 'BAD', allowUserInput: false },
      ]);
      expect(invalidVal.action).toEqual({
        isValid: false,
        status: 'option_not_found',
      });

      // Invalidation forces fresh read on next call
      service.invalidate({ spaceId: 'drive-1' });
      await service.resolveOptions(ctx, ['statuses']);
      expect(readOptionTables).toHaveBeenCalledTimes(2);
    });

    it('surfaces missing_log, per-source config_error, and timeout cleanly for document_log sources', async () => {
      const readOptionTables = vi
        .fn()
        .mockResolvedValueOnce({
          status: 'missing_log',
          expectedFolderPath: '1 Admin',
          tables: {},
        })
        .mockResolvedValueOnce({
          status: 'ready',
          spreadsheetId: 'log-1',
          tables: {
            statuses: {
              status: 'ready',
              tuples: [{ key: 'Open' }],
            },
            actions: {
              status: 'config_error',
              tuples: [],
              errorMessage: 'Missing endMarker "---" in Options_Submittal_Arch_Actions',
            },
          },
        })
        .mockImplementationOnce(async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return { status: 'missing_space', tables: {} };
        });

      const service = new LookupOptionsService(
        createManifestPort({ 'submittal-arch': submittalArchSchema }),
        { documentLogOptionSource: { readOptionTables }, timeoutMs: 15 }
      );

      const missingRes = await service.resolveOptions(
        { space: { id: 'sp-missing' }, documentTypeKey: 'submittal-arch' },
        ['statuses', 'actions']
      );
      expect(missingRes.statuses.status).toBe('missing_log');
      expect(missingRes.statuses.targetPath).toBe('1 Admin');

      const configErrRes = await service.resolveOptions(
        { space: { id: 'sp-cfg' }, documentTypeKey: 'submittal-arch' },
        ['statuses', 'actions']
      );
      expect(configErrRes.statuses.status).toBe('ready');
      expect(configErrRes.actions).toEqual({
        status: 'config_error',
        tuples: [],
        items: [],
        errorMessage: 'Missing endMarker "---" in Options_Submittal_Arch_Actions',
      });

      const timeoutRes = await service.resolveOptions(
        { space: { id: 'sp-slow' }, documentTypeKey: 'submittal-arch' },
        ['statuses', 'actions']
      );
      expect(timeoutRes.statuses.status).toBe('timeout');
      expect(timeoutRes.actions.status).toBe('timeout');
      expect(timeoutRes.statuses.targetPath).toBeUndefined();
    });

    it('maps ambiguous_log from DocumentLogOptionSourcePort.readOptionTables through resolveOptions and validateFields', async () => {
      const readOptionTables = vi.fn().mockResolvedValue({
        status: 'ambiguous_log',
        errorMessage: 'Multiple DocumentLog spreadsheets found.',
        tables: {},
      });

      const service = new LookupOptionsService(
        createManifestPort({ 'submittal-arch': submittalArchSchema }),
        { documentLogOptionSource: { readOptionTables } }
      );
      const ctx = { space: { id: 'sp-ambiguous' }, documentTypeKey: 'submittal-arch' };

      const resolved = await service.resolveOptions(ctx, ['statuses']);
      expect(resolved.statuses).toEqual({
        status: 'ambiguous_log',
        tuples: [],
        items: [],
        errorMessage: 'Multiple DocumentLog spreadsheets found.',
      });

      const validated = await service.validateFields(ctx, [
        { queryId: 'q-status', fieldKey: 'status', sourceKey: 'statuses', value: 'Open' },
      ]);
      expect(validated['q-status']).toEqual({
        isValid: false,
        status: 'ambiguous_log',
        errorMessage: 'Multiple DocumentLog spreadsheets found.',
      });
    });

    it('forwards selectedLogId to readOptionTables and surfaces missing_log when space is omitted', async () => {
      const readOptionTables = vi.fn().mockResolvedValue({
        status: 'missing_log',
        expectedFolderPath: '1 Admin',
        tables: {},
      });

      const service = new LookupOptionsService(
        createManifestPort({ 'submittal-arch': submittalArchSchema }),
        { documentLogOptionSource: { readOptionTables } }
      );
      const ctx = {
        documentTypeKey: 'submittal-arch',
        selectedLogId: 'log-stale-omitted',
      };

      const resolved = await service.resolveOptions(ctx, ['statuses']);
      expect(readOptionTables).toHaveBeenCalledTimes(1);
      expect(readOptionTables).toHaveBeenCalledWith({
        documentTypeKey: 'submittal-arch',
        selectedLogId: 'log-stale-omitted',
        sourceKeys: ['statuses', 'actions'],
        signal: expect.any(AbortSignal),
      });
      expect(resolved.statuses).toEqual({
        status: 'missing_log',
        tuples: [],
        items: [],
        targetPath: '1 Admin',
      });

      const validated = await service.validateFields(ctx, [
        { queryId: 'q-status', fieldKey: 'status', sourceKey: 'statuses', value: 'Open' },
      ]);
      expect(readOptionTables).toHaveBeenCalledTimes(1);
      expect(validated['q-status']).toEqual({
        isValid: false,
        status: 'missing_log',
        targetPath: '1 Admin',
      });
    });

    it('surfaces status error on resolveOptions and validateFields and keeps LinkedFields unlocked when readOptionTables rejects', async () => {
      const linkedSchema: LookupDocumentSchema = {
        fields: [
          {
            key: 'status',
            options: { source: 'statuses', key: 'key', name: 'name' },
          },
          {
            key: 'statusLabel',
            linkedField: { sourceField: 'status', sourceProperty: 'name' },
          },
        ],
        optionSources: {
          statuses: { provider: 'document_log', properties: ['key', 'name'] },
        },
      };

      const readOptionTables = vi.fn().mockRejectedValue(new Error('Not found'));
      const service = new LookupOptionsService(
        createManifestPort({ 'submittal-linked': linkedSchema }),
        { documentLogOptionSource: { readOptionTables } }
      );
      const ctx = {
        space: { id: 'sp-1', abstractStorageId: 'drive-1' },
        documentTypeKey: 'submittal-linked',
        selectedLogId: 'log-inaccessible',
      };

      const resolved = await service.resolveOptions(ctx, ['statuses']);
      expect(resolved.statuses).toEqual({
        status: 'error',
        tuples: [],
        items: [],
      });

      const validated = await service.validateFields(ctx, [
        { queryId: 'q-status', fieldKey: 'status', sourceKey: 'statuses', value: 'Open' },
      ]);
      expect(validated['q-status']).toEqual({
        isValid: false,
        status: 'error',
      });

      await expect(service.deriveLockedFields(ctx, { status: 'Open' })).resolves.toEqual({});
      expect(readOptionTables).toHaveBeenCalledTimes(1);
    });
  });

  describe('deriveLockedFields (non-blank-only LinkedField locking)', () => {
    const ffeSchema: LookupDocumentSchema = {
      fields: [
        {
          key: 'specTag',
          options: { source: 'specs', key: 'key', allowUserInput: true },
        },
        {
          key: 'relatedTag',
          options: { source: 'specs', key: 'key', allowUserInput: true },
        },
        {
          key: 'specTitle',
          linkedField: { sourceField: 'specTag', sourceProperty: 'name' },
        },
      ],
      optionSources: {
        specs: { provider: 'document_log', properties: ['key', 'name'] },
      },
    };

    it('locks LinkedField only when sibling LookupField matches strictly on key AND derived sourceProperty is non-blank', async () => {
      const readOptionTables = vi.fn().mockResolvedValue({
        status: 'ready',
        spreadsheetId: 'log-ffe',
        tables: {
          specs: {
            status: 'ready',
            tuples: [
              { key: 'AC102', name: 'HOOK' },
              { key: 'BLANK1', name: '   ' },
              { key: 'EMPTY1', name: '' },
              { key: 'NO_TITLE' },
            ],
          },
        },
      });

      const service: LookupOptionsPort = new LookupOptionsService(
        createManifestPort({ 'submittal-ffe': ffeSchema }),
        { documentLogOptionSource: { readOptionTables } }
      );
      const ctx = { space: { id: 'sp-1', abstractStorageId: 'drive-1' }, documentTypeKey: 'submittal-ffe' };

      // Trimmed case-insensitive key match with non-blank name -> locked
      await expect(service.deriveLockedFields(ctx, { specTag: ' ac102 ' })).resolves.toEqual({
        specTitle: 'HOOK',
      });

      // Strict key-only matching when options.name is absent: passing "HOOK" must NOT match AC102
      await expect(service.deriveLockedFields(ctx, { specTag: 'HOOK' })).resolves.toEqual({});

      // Custom / unknown key -> unlocked
      await expect(service.deriveLockedFields(ctx, { specTag: 'XX999' })).resolves.toEqual({});

      // Blank lookup value -> unlocked
      await expect(service.deriveLockedFields(ctx, { specTag: '   ' })).resolves.toEqual({});
      await expect(service.deriveLockedFields(ctx, {})).resolves.toEqual({});

      // Matched tuple with blank / whitespace / missing sourceProperty -> unlocked
      await expect(service.deriveLockedFields(ctx, { specTag: 'BLANK1' })).resolves.toEqual({});
      await expect(service.deriveLockedFields(ctx, { specTag: 'EMPTY1' })).resolves.toEqual({});
      await expect(service.deriveLockedFields(ctx, { specTag: 'NO_TITLE' })).resolves.toEqual({});

      // Memoized across calls for same context
      expect(readOptionTables).toHaveBeenCalledTimes(1);
    });

    it('keeps LinkedField unlocked on missing_log, config_error, timeout, and error, and refreshes on selectedLogId change', async () => {
      const readOptionTables = vi
        .fn()
        .mockResolvedValueOnce({ status: 'missing_log', expectedFolderPath: '1 Admin', tables: {} })
        .mockResolvedValueOnce({
          status: 'ready',
          spreadsheetId: 'log-a',
          tables: {
            specs: { status: 'config_error', tuples: [], errorMessage: 'Missing ---' },
          },
        })
        .mockImplementationOnce(async () => {
          await new Promise((resolve) => setTimeout(resolve, 40));
          return { status: 'missing_space', tables: {} };
        })
        .mockRejectedValueOnce(new Error('Sheets unavailable'))
        .mockResolvedValueOnce({
          status: 'ready',
          spreadsheetId: 'log-b',
          tables: {
            specs: { status: 'ready', tuples: [{ key: 'AC102', name: 'HOOK LOG B' }] },
          },
        });

      const service: LookupOptionsPort = new LookupOptionsService(
        createManifestPort({ 'submittal-ffe': ffeSchema }),
        { documentLogOptionSource: { readOptionTables }, timeoutMs: 15 }
      );

      await expect(
        service.deriveLockedFields(
          { space: { id: 'sp-missing' }, documentTypeKey: 'submittal-ffe' },
          { specTag: 'AC102' }
        )
      ).resolves.toEqual({});

      await expect(
        service.deriveLockedFields(
          { space: { id: 'sp-cfg' }, documentTypeKey: 'submittal-ffe', selectedLogId: 'log-a' },
          { specTag: 'AC102' }
        )
      ).resolves.toEqual({});

      await expect(
        service.deriveLockedFields(
          { space: { id: 'sp-timeout' }, documentTypeKey: 'submittal-ffe' },
          { specTag: 'AC102' }
        )
      ).resolves.toEqual({});

      await expect(
        service.deriveLockedFields(
          { space: { id: 'sp-err' }, documentTypeKey: 'submittal-ffe' },
          { specTag: 'AC102' }
        )
      ).resolves.toEqual({});

      // Switching selectedLogId loads fresh options and locks specTitle from log-b
      await expect(
        service.deriveLockedFields(
          { space: { id: 'sp-cfg' }, documentTypeKey: 'submittal-ffe', selectedLogId: 'log-b' },
          { specTag: 'AC102' }
        )
      ).resolves.toEqual({ specTitle: 'HOOK LOG B' });
    });
  });

  describe('AbortSignal timeout cancellation and timeout cache non-poisoning (Ticket #414)', () => {
    const submittalArchSchema: LookupDocumentSchema = {
      fields: [
        { key: 'status', options: { source: 'statuses', key: 'key' } },
        { key: 'action', options: { source: 'actions', key: 'key', name: 'name' } },
      ],
      optionSources: {
        statuses: { provider: 'document_log', properties: ['key'] },
        actions: { provider: 'document_log', properties: ['key', 'name'] },
      },
    };

    it('propagates an AbortSignal to DocumentLogOptionSourcePort and aborts active backoff loops immediately on timeout', async () => {
      let capturedSignal: AbortSignal | undefined;
      let backoffAborted = false;

      const readOptionTables = vi.fn().mockImplementation(async (params: { signal?: AbortSignal }) => {
        capturedSignal = params.signal;
        return new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => {
            reject(new Error('Backoff should have been aborted before 60s'));
          }, 60_000);
          params.signal?.addEventListener(
            'abort',
            () => {
              clearTimeout(timer);
              backoffAborted = true;
              reject(new Error('Aborted'));
            },
            { once: true }
          );
        });
      });

      const service = new LookupOptionsService(
        createManifestPort({ 'submittal-arch': submittalArchSchema }),
        { documentLogOptionSource: { readOptionTables }, lookupTimeoutMs: 20 }
      );

      const startedAt = Date.now();
      const resolved = await service.resolveOptions(
        { space: { id: 'sp-1', abstractStorageId: 'drive-1' }, documentTypeKey: 'submittal-arch' },
        ['statuses', 'actions']
      );
      const elapsedMs = Date.now() - startedAt;

      expect(resolved.statuses.status).toBe('timeout');
      expect(resolved.actions.status).toBe('timeout');
      expect(capturedSignal).toBeDefined();
      expect(capturedSignal?.aborted).toBe(true);
      expect(backoffAborted).toBe(true);
      expect(elapsedMs).toBeLessThan(1000);
      expect(readOptionTables).toHaveBeenCalledTimes(1);
    });

    it('propagates an AbortSignal to DriveOptionSourcePort listFoldersAtPath and validateFolderExistence and aborts on timeout', async () => {
      let listSignal: AbortSignal | undefined;
      let validateSignal: AbortSignal | undefined;

      const driveSource: DriveOptionSourcePort = {
        listFoldersAtPath: vi.fn().mockImplementation(async (params: { signal?: AbortSignal }) => {
          listSignal = params.signal;
          return new Promise<never>((_resolve, reject) => {
            params.signal?.addEventListener('abort', () => reject(new Error('Aborted')), {
              once: true,
            });
          });
        }),
        validateFolderExistence: vi
          .fn()
          .mockImplementation(async (params: { signal?: AbortSignal }) => {
            validateSignal = params.signal;
            return new Promise<never>((_resolve, reject) => {
              params.signal?.addEventListener('abort', () => reject(new Error('Aborted')), {
                once: true,
              });
            });
          }),
      };

      const service = new LookupOptionsService(
        createManifestPort({ 'communication-project': commSchema }),
        { driveOptionSource: driveSource, lookupTimeoutMs: 20 }
      );

      const valRes = await service.validateFields(
        { space: { id: 'sp-val', abstractStorageId: 'drive-val' }, documentTypeKey: 'communication-project' },
        [{ queryId: 'contact', fieldKey: 'contact', sourceKey: 'contactFolders', value: 'Acme', allowUserInput: true }]
      );
      expect(valRes.contact.status).toBe('timeout');
      expect(validateSignal?.aborted).toBe(true);

      const optRes = await service.resolveOptions(
        { space: { id: 'sp-opt', abstractStorageId: 'drive-opt' }, documentTypeKey: 'communication-project' },
        ['contactFolders']
      );
      expect(optRes.contactFolders.status).toBe('timeout');
      expect(listSignal?.aborted).toBe(true);
    });

    it('does not cache transient timeout outcomes in documentLogBatchCache across calls within a request, while caching subsequent settled results', async () => {
      const readOptionTables = vi
        .fn()
        .mockImplementationOnce(async (params: { signal?: AbortSignal }) => {
          return new Promise<never>((_resolve, reject) => {
            params.signal?.addEventListener('abort', () => reject(new Error('Aborted')), {
              once: true,
            });
          });
        })
        .mockResolvedValueOnce({
          status: 'ready',
          spreadsheetId: 'log-1',
          tables: {
            statuses: { status: 'ready', tuples: [{ key: 'Open' }] },
            actions: { status: 'ready', tuples: [{ key: 'REC', name: 'Received' }] },
          },
        });

      const service = new LookupOptionsService(
        createManifestPort({ 'submittal-arch': submittalArchSchema }),
        { documentLogOptionSource: { readOptionTables }, lookupTimeoutMs: 20 }
      );

      const ctx = {
        space: { id: 'sp-1', abstractStorageId: 'drive-1' },
        documentTypeKey: 'submittal-arch',
      };

      // Concurrent calls in the first batch share the single in-flight timeout
      const firstBatch = await service.resolveOptions(ctx, ['statuses', 'actions']);
      expect(firstBatch.statuses.status).toBe('timeout');
      expect(firstBatch.actions.status).toBe('timeout');
      expect(readOptionTables).toHaveBeenCalledTimes(1);

      // Subsequent call in the same request is NOT poisoned by the transient timeout
      const secondValidation = await service.validateFields(ctx, [
        { queryId: 'status', fieldKey: 'status', sourceKey: 'statuses', value: 'Open' },
      ]);
      expect(secondValidation.status).toEqual({
        isValid: true,
        status: 'valid',
        canonicalValue: 'Open',
        matchedTuple: { key: 'Open' },
      });
      expect(readOptionTables).toHaveBeenCalledTimes(2);

      // Once settled with a non-timeout result, subsequent calls reuse the cached result
      const thirdResolve = await service.resolveOptions(ctx, ['actions']);
      expect(thirdResolve.actions.status).toBe('ready');
      expect(readOptionTables).toHaveBeenCalledTimes(2);
    });

    it('keeps production DEFAULT_TIMEOUT_MS at 5,000 ms when lookupTimeoutMs is omitted', async () => {
      vi.useFakeTimers();
      try {
        let capturedSignal: AbortSignal | undefined;
        const readOptionTables = vi.fn().mockImplementation(async (params: { signal?: AbortSignal }) => {
          capturedSignal = params.signal;
          return new Promise<never>(() => {});
        });

        const service = new LookupOptionsService(
          createManifestPort({ 'submittal-arch': submittalArchSchema }),
          { documentLogOptionSource: { readOptionTables } }
        );

        const pending = service.resolveOptions(
          { space: { id: 'sp-default', abstractStorageId: 'drive-default' }, documentTypeKey: 'submittal-arch' },
          ['statuses']
        );

        await vi.advanceTimersByTimeAsync(4999);
        expect(capturedSignal?.aborted).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        const res = await pending;
        expect(capturedSignal?.aborted).toBe(true);
        expect(res.statuses.status).toBe('timeout');
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
