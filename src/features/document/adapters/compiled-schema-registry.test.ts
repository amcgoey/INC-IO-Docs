import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TypeCompiler } from '@sinclair/typebox/compiler';
import { CompiledSchemaRegistry } from './compiled-schema-registry';
import type { DocumentType } from '../domain';
import type { DocumentSchemaRegistryPort } from '../ports';

describe('CompiledSchemaRegistry', () => {
  const sampleDocumentType: DocumentType = {
    key: 'submittal',
    name: 'Submittal Document',
    documentSchema: {
      fields: [
        {
          key: 'title',
          name: 'Title',
          type: 'string',
          required: true,
        },
        {
          key: 'notes',
          name: 'Notes',
          type: 'string',
          required: false,
        },
        {
          key: 'status',
          name: 'Status',
          type: 'string',
          required: true,
          options: {
            source: 'statuses',
            key: 'code',
            name: 'name',
            allowUserInput: false,
          },
        },
      ],
      options: {
        statuses: [
          { code: 'DRAFT', name: 'Draft' },
          { code: 'APPROVED', name: 'Approved' },
        ],
      },
    },
  };

  const invoiceDocumentType: DocumentType = {
    key: 'invoice',
    name: 'Invoice Document',
    documentSchema: {
      fields: [
        {
          key: 'invoiceNumber',
          name: 'Invoice Number',
          type: 'string',
          required: true,
        },
      ],
    },
  };

  let mockSchemaRegistry: DocumentSchemaRegistryPort;

  beforeEach(() => {
    vi.restoreAllMocks();
    mockSchemaRegistry = {
      loadAll: vi.fn().mockResolvedValue([sampleDocumentType, invoiceDocumentType]),
    };
  });

  describe('initialization and schema retrieval', () => {
    it('compiles and caches schemas upon initialize()', async () => {
      const registry = new CompiledSchemaRegistry(mockSchemaRegistry);
      await registry.initialize();

      expect(mockSchemaRegistry.loadAll).toHaveBeenCalledTimes(1);

      const submittalCheck = registry.get('submittal');
      expect(submittalCheck).toBeDefined();
      expect(submittalCheck?.Schema()).toBeDefined();

      const invoiceCheck = registry.get('invoice');
      expect(invoiceCheck).toBeDefined();

      expect(registry.get('unknown')).toBeUndefined();
    });

    it('validates document data using compiled schemas', async () => {
      const registry = new CompiledSchemaRegistry(mockSchemaRegistry);
      await registry.initialize();

      const submittalCheck = registry.get('submittal')!;

      // Valid submittal
      expect(
        submittalCheck.Check({
          title: 'Spec 01',
          status: 'DRAFT',
        })
      ).toBe(true);

      // Valid submittal with optional field
      expect(
        submittalCheck.Check({
          title: 'Spec 01',
          notes: 'Some notes',
          status: 'APPROVED',
        })
      ).toBe(true);

      // Missing required field
      expect(
        submittalCheck.Check({
          notes: 'Some notes',
          status: 'DRAFT',
        })
      ).toBe(false);

      // Disallowed option value
      expect(
        submittalCheck.Check({
          title: 'Spec 01',
          status: 'INVALID_STATUS',
        })
      ).toBe(false);
    });
  });

  describe('caching behavior', () => {
    it('ensures all TypeBox schema compilations run exactly once upon initialization', async () => {
      const compileSpy = vi.spyOn(TypeCompiler, 'Compile');
      const registry = new CompiledSchemaRegistry(mockSchemaRegistry);

      await registry.initialize();

      // Exactly 2 schemas compiled (one for 'submittal', one for 'invoice')
      expect(compileSpy).toHaveBeenCalledTimes(2);

      // Retrieving schemas repeatedly does NOT invoke TypeCompiler.Compile again
      registry.get('submittal');
      registry.get('submittal');
      registry.get('invoice');
      expect(compileSpy).toHaveBeenCalledTimes(2);

      // Calling initialize() again is a no-op and does NOT recompile or reload
      await registry.initialize();
      expect(compileSpy).toHaveBeenCalledTimes(2);
      expect(mockSchemaRegistry.loadAll).toHaveBeenCalledTimes(1);
    });
  });

  describe('singleton thread-safety (concurrent initialization)', () => {
    it('handles concurrent initialize() calls safely without duplicate compilations', async () => {
      const compileSpy = vi.spyOn(TypeCompiler, 'Compile');

      // Create a delayed mock to simulate async network/IO latency
      let resolveLoadAll: (types: DocumentType[]) => void;
      const delayedLoadAll = new Promise<DocumentType[]>((resolve) => {
        resolveLoadAll = resolve;
      });

      const delayedRegistryPort: DocumentSchemaRegistryPort = {
        loadAll: vi.fn().mockReturnValue(delayedLoadAll),
      };

      const registry = new CompiledSchemaRegistry(delayedRegistryPort);

      // Trigger multiple concurrent initialize() calls simultaneously
      const initPromise1 = registry.initialize();
      const initPromise2 = registry.initialize();
      const initPromise3 = registry.initialize();

      // Resolve the delayed loadAll
      resolveLoadAll!([sampleDocumentType, invoiceDocumentType]);

      await Promise.all([initPromise1, initPromise2, initPromise3]);

      // loadAll and TypeCompiler.Compile should run exactly once despite concurrent triggers
      expect(delayedRegistryPort.loadAll).toHaveBeenCalledTimes(1);
      expect(compileSpy).toHaveBeenCalledTimes(2);

      expect(registry.get('submittal')).toBeDefined();
      expect(registry.get('invoice')).toBeDefined();
    });
  });

  describe('error handling and startup fail-fast', () => {
    it('throws immediately at startup when encountering an unsupported field type', async () => {
      const invalidType: DocumentType = {
        key: 'invalid-type',
        name: 'Invalid Type',
        documentSchema: {
          fields: [
            {
              key: 'badField',
              name: 'Bad Field',
              type: 'unknown',
              required: true,
            },
          ],
        },
      };

      const invalidRegistryPort: DocumentSchemaRegistryPort = {
        loadAll: vi.fn().mockResolvedValue([invalidType]),
      };

      const registry = new CompiledSchemaRegistry(invalidRegistryPort);

      await expect(registry.initialize()).rejects.toThrow(
        /Unsupported field type 'unknown' in DocumentType 'invalid-type'/
      );
    });

    it('rejects all concurrent callers immediately when an invalid schema throws', async () => {
      const errorRegistryPort: DocumentSchemaRegistryPort = {
        loadAll: vi.fn().mockRejectedValue(new Error('Manifest read error')),
      };

      const registry = new CompiledSchemaRegistry(errorRegistryPort);

      const p1 = registry.initialize();
      const p2 = registry.initialize();

      await expect(p1).rejects.toThrow('Manifest read error');
      await expect(p2).rejects.toThrow('Manifest read error');
    });

    it('allows retry after failed initialization if underlying cause is resolved', async () => {
      let fail = true;
      const port: DocumentSchemaRegistryPort = {
        loadAll: vi.fn().mockImplementation(async () => {
          if (fail) {
            throw new Error('Temporary failure');
          }
          return [invoiceDocumentType];
        }),
      };

      const registry = new CompiledSchemaRegistry(port);

      await expect(registry.initialize()).rejects.toThrow('Temporary failure');

      // Now resolve the problem and retry
      fail = false;
      await registry.initialize();

      expect(registry.get('invoice')).toBeDefined();
    });
  });
});
