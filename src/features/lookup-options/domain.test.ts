import { describe, it, expect, vi } from 'vitest';
import { LookupOptionsService } from './domain';
import type {
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
});
