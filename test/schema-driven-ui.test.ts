import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import { ManifestUiAdapter } from '../src/features/schema-driven-ui/adapters/manifest.adapter';
import { ensureEvaluationOrder } from '../src/infrastructure/validation/json-logic-graph';
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
            name: 'Request Title',
            type: 'string',
            required: true,
          },
          {
            key: 'estimatedCost',
            name: 'Estimated Cost',
            type: 'number',
            required: true,
          },
          {
            key: 'vendorCategory',
            name: 'Vendor Category',
            type: 'string',
            required: false,
          },
        ],
      },
      documentUiSchema: {
        layout: ['requestTitle', 'estimatedCost', 'vendorCategory'],
        fields: {
          requestTitle: {
            widget: 'textInput',
            label: 'Request Subject',
            props: { placeholder: 'Brief summary of purchase' },
          },
          estimatedCost: {
            widget: 'textInput',
            label: 'Estimated Cost ($)',
          },
          vendorCategory: {
            widget: 'dropdown',
            label: 'Vendor Category',
            props: {
              options: ['Hardware', 'Software', 'Consulting'],
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
    await fs.writeFile(procurementDocPath, JSON.stringify(procurementDocContent, null, 2), 'utf-8');

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
    const uiAdapter = new ManifestUiAdapter(
      manifestProvider,
      (ui, doc) => ensureEvaluationOrder(ui, doc) ?? ui
    );

    // 1. Verify Fast-Track Read port reads DocumentUiSchema directly bypassing domain
    const uiSchema = await uiAdapter.getUiSchema('procurement-request');
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

    expect(app.documentSpaceUiSchemaQuery).toBeDefined();

    const spaceUiSchema = await app.documentSpaceUiSchemaQuery!.getSpaceUiSchema('procurement-space');
    expect(spaceUiSchema?.layout).toEqual(['departmentName']);
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
    const uiAdapter = new ManifestUiAdapter(
      manifestProvider,
      (ui, doc) => ensureEvaluationOrder(ui, doc) ?? ui
    );

    const uiSchema = await uiAdapter.getUiSchema('calc-doc');
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
    const uiAdapter = new ManifestUiAdapter(
      manifestProvider,
      (ui, doc) => ensureEvaluationOrder(ui, doc) ?? ui
    );

    await expect(uiAdapter.getUiSchema('cycle-doc')).rejects.toThrow(
      /Circular dependency detected in computeValue rules/i
    );
  });
});
