import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import { createDocumentFeatureWiring } from '../src/app/document.wiring';
import { createDocumentSpaceFeatureWiring } from '../src/app/document-space.wiring';
import { createApp } from '../src/app/server';

describe('Schema-Driven UI Integration Test', () => {
  let tempDir: string;
  let manifestPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'schema-ui-e2e-'));
    manifestPath = path.join(tempDir, 'manifest.json');

    const procurementDocPath = path.join(tempDir, 'procurement.json');
    const procurementDocContent = {
      key: 'procurement-request',
      name: 'Procurement Request',
      documentSchema: {
        fields: [
          {
            key: 'requestTitle',
            name: 'requestTitle',
            type: 'string',
            required: true,
          },
          {
            key: 'estimatedCost',
            name: 'estimatedCost',
            type: 'number',
            required: true,
          },
          {
            key: 'vendorCategory',
            name: 'vendorCategory',
            type: 'string',
            required: true,
          },
          {
            key: 'internalNotes',
            name: 'internalNotes',
            type: 'string',
          },
        ],
      },
      documentUiSchema: {
        layout: ['requestTitle', 'estimatedCost', 'vendorCategory'],
        fields: {
          requestTitle: {
            widget: 'textInput',
            label: 'Request Subject',
          },
          vendorCategory: {
            widget: 'selectionInput',
            label: 'Vendor Category Group',
            props: {
              items: [
                { text: 'Hardware', value: 'hw' },
                { text: 'Software', value: 'sw' },
              ],
            },
          },
        },
        events: {
          onSubmit: {
            catchAllWorkflow: 'SubmitProcurement',
          },
        },
      },
    };
    await fs.writeFile(
      procurementDocPath,
      JSON.stringify(procurementDocContent, null, 2),
      'utf-8'
    );

    const manifestContent = {
      documentTypes: ['./procurement.json'],
      DocumentSpaceTypes: [
        {
          id: 'procurement-space',
          displayName: 'Procurement Spaces',
          storageConfig: { provider: 'google-drive' },
          spaceSchema: {
            allowedDocumentTypes: ['procurement-request'],
          },
          spaceUiSchema: {
            layout: ['departmentName'],
            fields: {
              departmentName: {
                label: 'Department Name',
                widget: 'textInput',
              },
            },
          },
        },
      ],
    };
    await fs.writeFile(manifestPath, JSON.stringify(manifestContent, null, 2), 'utf-8');
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it('flows from raw manifest JSON through modular wiring to document and space UI queries', async () => {
    const manifestProvider = new AppManifestProvider({ manifestPath });
    const { documentUiSchemaQuery } = createDocumentFeatureWiring({
      manifestProvider,
    });

    // 1. Verify Fast-Track Read port reads DocumentUiSchema directly bypassing domain
    const uiSchema = await documentUiSchemaQuery.getDocumentUiSchema('procurement-request');
    expect(uiSchema).toBeDefined();
    expect(uiSchema?.layout).toEqual(['requestTitle', 'estimatedCost', 'vendorCategory']);
    expect(uiSchema?.fields?.requestTitle?.label).toBe('Request Subject');
    expect(uiSchema?.events?.onSubmit?.catchAllWorkflow).toBe('SubmitProcurement');

    // 2. Verify SpaceUiSchema is queryable via documentSpaceUiSchemaQuery
    const { documentSpaceUiSchemaQuery } = createDocumentSpaceFeatureWiring({
      rawManifestProvider: manifestProvider,
      storageAdapter: { fetchSpaces: async () => [], resolveStorageLocation: async () => ({ provider: 'p', abstractStorageId: 'id' }) },
    });
    const spaceUiSchema = await documentSpaceUiSchemaQuery.getSpaceUiSchema('procurement-space');
    expect(spaceUiSchema).toBeDefined();
    expect(spaceUiSchema?.layout).toEqual(['departmentName']);
    expect(spaceUiSchema?.fields?.departmentName?.label).toBe('Department Name');
  });

  it('integrates with createApp to expose modular wiring', async () => {
    const app = createApp({
      manifestPath,
      skipSpaceValidation: true,
    });

    expect(app.documentUiSchemaQuery).toBeDefined();

    const uiSchema = await app.documentUiSchemaQuery!.getDocumentUiSchema('procurement-request');
    expect(uiSchema?.layout).toEqual(['requestTitle', 'estimatedCost', 'vendorCategory']);
  });

  it('computes evaluationOrder end-to-end and emits safe order on uiSchema with uncomputed fields first', async () => {
    const calcDocPath = path.join(tempDir, 'calc-doc.json');
    const calcDocContent = {
      key: 'calc-doc',
      name: 'Calculated Document',
      documentSchema: {
        fields: [
          { key: 'qty', name: 'Quantity', type: 'number', required: true },
          { key: 'rate', name: 'Rate', type: 'number', required: true },
          { key: 'total', name: 'Total', type: 'number', required: true },
        ],
      },
      documentUiSchema: {
        fields: {
          qty: { label: 'Quantity' },
          rate: { label: 'Rate' },
          total: {
            label: 'Total',
            computeValue: {
              and: [{ var: 'data.qty' }, { var: 'data.rate' }],
            },
          },
        },
      },
    };
    await fs.writeFile(calcDocPath, JSON.stringify(calcDocContent, null, 2), 'utf-8');

    const calcManifestPath = path.join(tempDir, 'calc-manifest.json');
    await fs.writeFile(
      calcManifestPath,
      JSON.stringify({ documentTypes: ['./calc-doc.json'] }, null, 2),
      'utf-8'
    );

    const manifestProvider = new AppManifestProvider({ manifestPath: calcManifestPath });
    const { documentUiSchemaQuery } = createDocumentFeatureWiring({
      manifestProvider,
    });

    const uiSchema = await documentUiSchemaQuery.getDocumentUiSchema('calc-doc');
    expect(uiSchema?.evaluationOrder).toEqual(['qty', 'rate', 'total']);
  });

  it('fails loudly when loading a manifest containing circular dependencies in computeValue', async () => {
    const cycleDocPath = path.join(tempDir, 'cycle-doc.json');
    const cycleDocContent = {
      key: 'cycle-doc',
      name: 'Cycle Document',
      documentSchema: {
        fields: [
          { key: 'nodeA', name: 'Node A', type: 'string', required: true },
          { key: 'nodeB', name: 'Node B', type: 'string', required: true },
        ],
      },
      documentUiSchema: {
        fields: {
          nodeA: { computeValue: { var: 'data.nodeB' } },
          nodeB: { computeValue: { var: 'data.nodeA' } },
        },
      },
    };
    await fs.writeFile(cycleDocPath, JSON.stringify(cycleDocContent, null, 2), 'utf-8');

    const cycleManifestPath = path.join(tempDir, 'cycle-manifest.json');
    await fs.writeFile(
      cycleManifestPath,
      JSON.stringify({ documentTypes: ['./cycle-doc.json'] }, null, 2),
      'utf-8'
    );

    const manifestProvider = new AppManifestProvider({ manifestPath: cycleManifestPath });
    const { documentUiSchemaQuery } = createDocumentFeatureWiring({
      manifestProvider,
    });

    await expect(documentUiSchemaQuery.getDocumentUiSchema('cycle-doc')).rejects.toThrow(
      /Circular dependency detected in computeValue rules/i
    );
  });
});
