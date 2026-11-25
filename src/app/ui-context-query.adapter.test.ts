import { describe, it, expect, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  UiContextQueryAdapter,
  mapDocumentLogUiContextToPanelContext,
} from './ui-context-query.adapter';
import {
  DOCUMENT_LOG_CONTEXT_KEY,
  DocumentLogPanelContextSchema,
} from '../features/schema-driven-ui/ports';
import type { DocumentLogPort, DocumentLogUiContextResult } from '../features/document-log';
import {
  SELECT_DOCUMENT_LOG_KEY,
  SELECT_DOCUMENT_SPACE_TYPE_KEY,
} from '../features/ui-process-manager';
import type { DocumentSpaceService } from '../features/document-space/domain';

function createMockDocumentLogService(
  overrides: Partial<DocumentLogPort> = {}
): DocumentLogPort {
  return {
    requiresDocumentLog: vi.fn().mockReturnValue(true),
    resolveLog: vi.fn(),
    copyLog: vi.fn(),
    queryUiContext: vi.fn().mockResolvedValue({ status: 'missing_space' }),
    readLog: vi.fn(),
    writeLog: vi.fn(),
    ...overrides,
  };
}

function createMockSpaceService(options?: {
  types?: Array<{ id: string }>;
  collections?: Record<
    string,
    Array<{ id: string; typeId: string; name: string; abstractStorageId: string }>
  >;
  rejectTypes?: Record<string, Error>;
}): DocumentSpaceService {
  const types = (options?.types ?? [{ id: 'projects' }, { id: 'proposals' }]).map((t) => ({
    id: t.id,
    displayName: t.id,
    spaceSchema: { allowedDocumentTypes: ['submittal-arch'] },
    storageConfig: { provider: 'google_drive' },
  }));

  return {
    getAllTypes: vi.fn().mockReturnValue(types),
    getCollection: vi.fn().mockImplementation(async (typeId: string) => {
      const err = options?.rejectTypes?.[typeId];
      if (err) {
        throw err;
      }
      const matchedType = types.find((t) => t.id === typeId) ?? types[0];
      return {
        type: matchedType,
        spaces: options?.collections?.[typeId] ?? [],
      };
    }),
  } as unknown as DocumentSpaceService;
}

describe('UiContextQueryAdapter', () => {
  it('returns {} without invoking ensureInitialized, documentLogService, or getDocumentSpaceService when keys do not include document-log', async () => {
    const ensureInitialized = vi.fn().mockResolvedValue(undefined);
    const documentLogService = createMockDocumentLogService();
    const getDocumentSpaceService = vi.fn();

    const adapter = new UiContextQueryAdapter({
      documentLogService,
      getDocumentSpaceService,
      ensureInitialized,
    });

    const result = await adapter.queryContext(['other-context'], {
      documentTypeKey: 'submittal-arch',
      spaceId: 'space-1',
    });

    expect(result).toEqual({});
    expect(ensureInitialized).not.toHaveBeenCalled();
    expect(documentLogService.requiresDocumentLog).not.toHaveBeenCalled();
    expect(documentLogService.queryUiContext).not.toHaveBeenCalled();
    expect(getDocumentSpaceService).not.toHaveBeenCalled();
  });

  it('awaits ensureInitialized before calling requiresDocumentLog and queryUiContext, and propagates initialization errors', async () => {
    const callOrder: string[] = [];
    const ensureInitialized = vi.fn().mockImplementation(async () => {
      await Promise.resolve();
      callOrder.push('ensureInitialized');
    });
    const documentLogService = createMockDocumentLogService({
      requiresDocumentLog: vi.fn().mockImplementation(() => {
        callOrder.push('requiresDocumentLog');
        return true;
      }),
      queryUiContext: vi.fn().mockImplementation(async () => {
        callOrder.push('queryUiContext');
        return { status: 'missing_space' };
      }),
    });
    const getDocumentSpaceService = vi.fn().mockReturnValue(createMockSpaceService());

    const adapter = new UiContextQueryAdapter({
      documentLogService,
      getDocumentSpaceService,
      ensureInitialized,
    });

    await adapter.queryContext([DOCUMENT_LOG_CONTEXT_KEY], {
      documentTypeKey: 'submittal-arch',
    });

    expect(callOrder).toEqual(['ensureInitialized', 'requiresDocumentLog', 'queryUiContext']);

    const failingDocLogService = createMockDocumentLogService();
    const failingAdapter = new UiContextQueryAdapter({
      documentLogService: failingDocLogService,
      getDocumentSpaceService: vi.fn(),
      ensureInitialized: vi.fn().mockRejectedValue(new Error('Manifest init failed')),
    });

    await expect(
      failingAdapter.queryContext([DOCUMENT_LOG_CONTEXT_KEY], {
        documentTypeKey: 'submittal-arch',
      })
    ).rejects.toThrow('Manifest init failed');
    expect(failingDocLogService.requiresDocumentLog).not.toHaveBeenCalled();
    expect(failingDocLogService.queryUiContext).not.toHaveBeenCalled();
  });

  it('returns {} without calling getDocumentSpaceService or queryUiContext when documentTypeKey is missing/blank or requiresDocumentLog returns false', async () => {
    const documentLogService = createMockDocumentLogService({
      requiresDocumentLog: vi.fn().mockReturnValue(false),
    });
    const getDocumentSpaceService = vi.fn();

    const adapter = new UiContextQueryAdapter({
      documentLogService,
      getDocumentSpaceService,
    });

    expect(
      await adapter.queryContext([DOCUMENT_LOG_CONTEXT_KEY], {})
    ).toEqual({});
    expect(
      await adapter.queryContext([DOCUMENT_LOG_CONTEXT_KEY], { documentTypeKey: '   ' })
    ).toEqual({});
    expect(
      await adapter.queryContext([DOCUMENT_LOG_CONTEXT_KEY], {
        documentTypeKey: 'non-logging-type',
        spaceId: 'space-1',
      })
    ).toEqual({});

    expect(documentLogService.requiresDocumentLog).toHaveBeenCalledTimes(1);
    expect(documentLogService.requiresDocumentLog).toHaveBeenCalledWith('non-logging-type');
    expect(getDocumentSpaceService).not.toHaveBeenCalled();
    expect(documentLogService.queryUiContext).not.toHaveBeenCalled();
  });

  it('short-circuits getCollection on preferred SELECT_DOCUMENT_SPACE_TYPE_KEY when matched and passes resolved DocumentLogSpace', async () => {
    const spaceService = createMockSpaceService({
      types: [{ id: 'projects' }, { id: 'proposals' }],
      collections: {
        projects: [],
        proposals: [
          {
            id: 'prop-1',
            typeId: 'proposals',
            name: 'Pier 4 Proposal',
            abstractStorageId: 'folder-prop-1',
          },
        ],
      },
    });
    const documentLogService = createMockDocumentLogService();
    const adapter = new UiContextQueryAdapter({
      documentLogService,
      getDocumentSpaceService: () => spaceService,
    });

    await adapter.queryContext([DOCUMENT_LOG_CONTEXT_KEY], {
      documentTypeKey: 'submittal-arch',
      spaceId: 'prop-1',
      formData: {
        [SELECT_DOCUMENT_SPACE_TYPE_KEY]: 'proposals',
      },
    });

    expect(spaceService.getCollection).toHaveBeenCalledTimes(1);
    expect(spaceService.getCollection).toHaveBeenCalledWith('proposals');
    expect(spaceService.getCollection).not.toHaveBeenCalledWith('projects');
    expect(documentLogService.queryUiContext).toHaveBeenCalledWith({
      documentTypeKey: 'submittal-arch',
      space: {
        id: 'prop-1',
        typeId: 'proposals',
        name: 'Pier 4 Proposal',
        abstractStorageId: 'folder-prop-1',
      },
      formData: {
        [SELECT_DOCUMENT_SPACE_TYPE_KEY]: 'proposals',
      },
    });
  });

  it('falls back across remaining space types, tolerates rejecting getCollection calls, and omits space when unmatched or blank spaceId', async () => {
    // 1. Preferred type rejects -> falls back to remaining types and finds space
    const fallbackService = createMockSpaceService({
      types: [{ id: 'projects' }, { id: 'proposals' }, { id: 'archive' }],
      rejectTypes: {
        proposals: new Error('Proposals storage unavailable'),
        projects: new Error('Projects timeout'),
      },
      collections: {
        archive: [
          {
            id: 'arch-1',
            typeId: 'archive',
            name: 'Archived Tower',
            abstractStorageId: 'drive-arch-1',
          },
        ],
      },
    });
    const docLog1 = createMockDocumentLogService();
    const adapter1 = new UiContextQueryAdapter({
      documentLogService: docLog1,
      getDocumentSpaceService: async () => fallbackService,
    });

    await adapter1.queryContext([DOCUMENT_LOG_CONTEXT_KEY], {
      documentTypeKey: 'submittal-arch',
      spaceId: ' arch-1 ',
      formData: {
        [SELECT_DOCUMENT_SPACE_TYPE_KEY]: 'proposals',
      },
    });

    expect(fallbackService.getCollection).toHaveBeenNthCalledWith(1, 'proposals');
    expect(fallbackService.getCollection).toHaveBeenNthCalledWith(2, 'projects');
    expect(fallbackService.getCollection).toHaveBeenNthCalledWith(3, 'archive');
    expect(docLog1.queryUiContext).toHaveBeenCalledWith(
      expect.objectContaining({
        space: {
          id: 'arch-1',
          typeId: 'archive',
          name: 'Archived Tower',
          abstractStorageId: 'drive-arch-1',
        },
      })
    );

    // 2. All collections miss or reject -> omits space
    const missService = createMockSpaceService({
      types: [{ id: 'projects' }, { id: 'proposals' }],
      rejectTypes: { projects: new Error('503') },
      collections: { proposals: [] },
    });
    const docLog2 = createMockDocumentLogService();
    const adapter2 = new UiContextQueryAdapter({
      documentLogService: docLog2,
      getDocumentSpaceService: () => missService,
    });

    await adapter2.queryContext([DOCUMENT_LOG_CONTEXT_KEY], {
      documentTypeKey: 'submittal-arch',
      spaceId: 'nonexistent',
    });

    const missCall = vi.mocked(docLog2.queryUiContext).mock.calls[0]?.[0];
    expect(missCall).toBeDefined();
    expect('space' in missCall!).toBe(false);

    // 3. Blank spaceId -> skips getDocumentSpaceService completely and omits space
    const getSpaceService3 = vi.fn();
    const docLog3 = createMockDocumentLogService();
    const adapter3 = new UiContextQueryAdapter({
      documentLogService: docLog3,
      getDocumentSpaceService: getSpaceService3,
    });

    await adapter3.queryContext([DOCUMENT_LOG_CONTEXT_KEY], {
      documentTypeKey: 'submittal-arch',
      spaceId: '   ',
    });

    expect(getSpaceService3).not.toHaveBeenCalled();
    const blankCall = vi.mocked(docLog3.queryUiContext).mock.calls[0]?.[0];
    expect('space' in blankCall!).toBe(false);
  });

  it('trims non-empty SELECT_DOCUMENT_LOG_KEY and omits selectedLogId when blank, missing, or non-string', async () => {
    const documentLogService = createMockDocumentLogService();
    const adapter = new UiContextQueryAdapter({
      documentLogService,
      getDocumentSpaceService: () => createMockSpaceService(),
    });

    await adapter.queryContext([DOCUMENT_LOG_CONTEXT_KEY], {
      documentTypeKey: 'submittal-arch',
      formData: { [SELECT_DOCUMENT_LOG_KEY]: '  log-2  ' },
    });
    expect(vi.mocked(documentLogService.queryUiContext).mock.calls[0]?.[0]).toEqual({
      documentTypeKey: 'submittal-arch',
      selectedLogId: 'log-2',
      formData: { [SELECT_DOCUMENT_LOG_KEY]: '  log-2  ' },
    });

    for (const formData of [
      { [SELECT_DOCUMENT_LOG_KEY]: '   ' },
      {},
      { [SELECT_DOCUMENT_LOG_KEY]: 123 },
    ]) {
      vi.mocked(documentLogService.queryUiContext).mockClear();
      await adapter.queryContext([DOCUMENT_LOG_CONTEXT_KEY], {
        documentTypeKey: 'submittal-arch',
        formData,
      });
      const req = vi.mocked(documentLogService.queryUiContext).mock.calls[0]?.[0];
      expect(req).toBeDefined();
      expect('selectedLogId' in req!).toBe(false);
    }
  });

  it('explicitly maps DocumentLogUiContextResult to DocumentLogPanelContext across all 5 statuses, stripping extra fields and omitting undefined keys', async () => {
    const rawPayloads: DocumentLogUiContextResult[] = [
      {
        status: 'missing_space',
        spaceName: undefined,
        extraSecret: 'leak',
      } as unknown as DocumentLogUiContextResult,
      {
        status: 'missing',
        spaceName: 'Harborview Hotel',
        targetFolderPath: '1 Admin',
        targetFileName: 'Harborview Hotel Document Log',
        extraProp: 'should-be-stripped',
      } as unknown as DocumentLogUiContextResult,
      {
        status: 'resolved',
        spaceName: 'Harborview Hotel',
        activeCandidate: {
          name: 'Harborview Hotel Document Log',
          url: 'https://docs.google.com/spreadsheets/d/log-1/edit',
          rawId: 'internal-id',
        } as unknown as DocumentLogUiContextResult['activeCandidate'],
        readStatus: 'ready',
        idGroup: '071200-001',
        entries: [
          {
            topLabel: undefined,
            text: '<b>Received</b> 260204',
            bottomLabel: undefined,
            fileUri: undefined,
            valid: true,
            extraEntryField: 'strip-me',
          } as unknown as NonNullable<DocumentLogUiContextResult['entries']>[number],
          {
            topLabel: 'Rev 1 • Open',
            text: '<b>Approved</b> 260210',
            bottomLabel: 'Submittal 001',
            fileUri: 'https://drive.google.com/file/d/f1/view',
            valid: false,
          },
        ],
        warningMessages: undefined,
      },
      {
        status: 'ambiguous',
        spaceName: 'Harborview Hotel',
        candidateOptions: [
          {
            text: 'Log A (1 Admin)',
            value: 'log-a',
            selected: true,
            extraOptProp: 'strip-opt',
          } as unknown as NonNullable<DocumentLogUiContextResult['candidateOptions']>[number],
          {
            text: 'Log B',
            value: 'log-b',
            selected: undefined,
          },
        ],
        activeCandidate: {
          name: 'Log A',
          url: 'https://docs.google.com/spreadsheets/d/log-a/edit',
        },
        readStatus: 'partial_hydration',
        idGroup: 'LT108',
        warningMessages: ['Row 8 invalid date'],
        entries: [],
      },
      {
        status: 'discovery_error',
        spaceName: 'Harborview Hotel',
        discoveryErrorMessage: 'Drive API 503',
        unexpectedField: true,
      } as unknown as DocumentLogUiContextResult,
    ];

    for (const raw of rawPayloads) {
      const documentLogService = createMockDocumentLogService({
        queryUiContext: vi.fn().mockResolvedValue(raw),
      });
      const adapter = new UiContextQueryAdapter({
        documentLogService,
        getDocumentSpaceService: () => createMockSpaceService(),
      });

      const result = await adapter.queryContext([DOCUMENT_LOG_CONTEXT_KEY], {
        documentTypeKey: 'submittal-arch',
      });
      const mapped = result[DOCUMENT_LOG_CONTEXT_KEY] as Record<string, unknown>;

      expect(mapped).toBeDefined();
      expect(mapped).not.toBe(raw);
      expect(Value.Check(DocumentLogPanelContextSchema, mapped)).toBe(true);
      const directMapped = mapDocumentLogUiContextToPanelContext(raw);
      expect(directMapped).not.toBe(raw);
      expect(directMapped).toEqual(mapped);
      expect(Value.Check(DocumentLogPanelContextSchema, directMapped)).toBe(true);

      for (const value of Object.values(mapped)) {
        expect(value).not.toBeUndefined();
      }

      if (raw.status === 'missing_space') {
        expect('spaceName' in mapped).toBe(false);
        expect('extraSecret' in mapped).toBe(false);
      }

      if (raw.status === 'missing') {
        expect('extraProp' in mapped).toBe(false);
        expect(mapped).toEqual({
          status: 'missing',
          spaceName: 'Harborview Hotel',
          targetFolderPath: '1 Admin',
          targetFileName: 'Harborview Hotel Document Log',
        });
      }

      if (raw.status === 'resolved') {
        const mappedCandidate = mapped.activeCandidate as Record<string, unknown>;
        expect(mappedCandidate).not.toBe(raw.activeCandidate);
        expect('rawId' in mappedCandidate).toBe(false);
        expect('warningMessages' in mapped).toBe(false);

        const mappedEntries = mapped.entries as Array<Record<string, unknown>>;
        expect(mappedEntries[0]).not.toBe(raw.entries![0]);
        expect('topLabel' in mappedEntries[0]).toBe(false);
        expect('bottomLabel' in mappedEntries[0]).toBe(false);
        expect('fileUri' in mappedEntries[0]).toBe(false);
        expect('extraEntryField' in mappedEntries[0]).toBe(false);
        expect(mappedEntries[1]).toEqual({
          topLabel: 'Rev 1 • Open',
          text: '<b>Approved</b> 260210',
          bottomLabel: 'Submittal 001',
          fileUri: 'https://drive.google.com/file/d/f1/view',
          valid: false,
        });
      }

      if (raw.status === 'ambiguous') {
        const mappedOpts = mapped.candidateOptions as Array<Record<string, unknown>>;
        expect(mappedOpts[0]).not.toBe(raw.candidateOptions![0]);
        expect('extraOptProp' in mappedOpts[0]).toBe(false);
        expect(mappedOpts[0]).toEqual({ text: 'Log A (1 Admin)', value: 'log-a', selected: true });
        expect('selected' in mappedOpts[1]).toBe(false);
      }

      if (raw.status === 'discovery_error') {
        expect('unexpectedField' in mapped).toBe(false);
        expect(mapped).toEqual({
          status: 'discovery_error',
          spaceName: 'Harborview Hotel',
          discoveryErrorMessage: 'Drive API 503',
        });
      }
    }
  });

  it('returns {} when documentLogService.queryUiContext returns undefined', async () => {
    const documentLogService = createMockDocumentLogService({
      queryUiContext: vi.fn().mockResolvedValue(undefined),
    });
    const adapter = new UiContextQueryAdapter({
      documentLogService,
      getDocumentSpaceService: () => createMockSpaceService(),
    });

    const result = await adapter.queryContext([DOCUMENT_LOG_CONTEXT_KEY], {
      documentTypeKey: 'submittal-arch',
    });

    expect(result).toEqual({});
  });
});
