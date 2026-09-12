import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { AppManifestProvider } from '../src/infrastructure/manifest/app-manifest-provider';
import { createDocumentFeatureWiring } from '../src/app/document.wiring';
import { createApp } from '../src/app/server';
import { UiCardSchema } from '../src/infrastructure/workspace-addon/ui-blocks';

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
          },
          {
            key: 'vendorCategory',
            name: 'vendorCategory',
            type: 'string',
            options: {
              source: 'inline',
              key: 'cat',
              name: 'Category',
            },
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
            props: { placeholder: 'Enter procurement title' },
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

    await fs.writeFile(procurementDocPath, JSON.stringify(procurementDocContent, null, 2), 'utf-8');

    const manifestContent = {
      documentTypes: ['./procurement.json'],
      configuration: {
        workspace: {
          appTitle: 'Procurement App',
        },
      },
      DocumentSpaceTypes: [
        {
          id: 'procurement-space',
          displayName: 'Procurement Space',
          allowedDocumentTypes: ['procurement-request'],
          storageConfig: {
            rootFolder: 'ProcurementDocs',
          },
          spaceUiSchema: {
            layout: ['departmentName'],
            fields: {
              departmentName: {
                widget: 'textInput',
                label: 'Department Name',
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

  it('flows from raw manifest JSON through modular wiring to the final valid UiCard', async () => {
    const manifestProvider = new AppManifestProvider({ manifestPath });
    const { documentUiSchemaQuery, documentUiBlock } = createDocumentFeatureWiring({
      manifestProvider,
    });

    // 1. Verify Fast-Track Read port reads DocumentUiSchema directly bypassing domain
    const uiSchema = await documentUiSchemaQuery.getDocumentUiSchema('procurement-request');
    expect(uiSchema).toBeDefined();
    expect(uiSchema?.layout).toEqual(['requestTitle', 'estimatedCost', 'vendorCategory']);
    expect(uiSchema?.fields?.requestTitle?.label).toBe('Request Subject');
    expect(uiSchema?.events?.onSubmit?.catchAllWorkflow).toBe('SubmitProcurement');

    // 2. Verify SpaceUiSchema is queryable
    const spaceUiSchema = await documentUiSchemaQuery.getSpaceUiSchema('procurement-space');
    expect(spaceUiSchema).toBeDefined();
    expect(spaceUiSchema?.layout).toEqual(['departmentName']);
    expect(spaceUiSchema?.fields?.departmentName?.label).toBe('Department Name');

    // 3. Render final UiCard via UiBlock adapter
    const rawProcurementDoc = (await manifestProvider.readParsedSchema('./procurement.json')) as {
      documentSchema: import('../src/features/document/domain').DocumentSchema;
    };

    const card = await documentUiBlock.renderDocumentCard(
      'procurement-request',
      rawProcurementDoc.documentSchema,
      { title: 'New Procurement Request', subtitle: 'Fill in all fields' }
    );

    // 4. Validate output schema as a valid UiCard
    expect(Value.Check(UiCardSchema, card)).toBe(true);
    expect(card.header.title).toBe('New Procurement Request');
    expect(card.header.subtitle).toBe('Fill in all fields');
    expect(card.sections).toHaveLength(1);

    const widgets = card.sections[0].widgets;
    // Exactly 3 widgets in layout order (internalNotes was omitted from layout)
    expect(widgets).toHaveLength(3);

    // Widget 1: Explicit label & widget from uiSchema
    expect(widgets[0].textInput).toBeDefined();
    expect(widgets[0].textInput?.name).toBe('requestTitle');
    expect(widgets[0].textInput?.label).toBe('Request Subject');

    // Widget 2: Omitted from fields -> Inferred default widget (textInput) and Title Case label
    expect(widgets[1].textInput).toBeDefined();
    expect(widgets[1].textInput?.name).toBe('estimatedCost');
    expect(widgets[1].textInput?.label).toBe('Estimated Cost');

    // Widget 3: Explicit selectionInput with props
    expect(widgets[2].selectionInput).toBeDefined();
    expect(widgets[2].selectionInput?.name).toBe('vendorCategory');
    expect(widgets[2].selectionInput?.label).toBe('Vendor Category Group');
    expect(widgets[2].selectionInput?.items).toEqual([
      { text: 'Hardware', value: 'hw' },
      { text: 'Software', value: 'sw' },
    ]);
  });

  it('integrates with createApp to expose modular wiring', async () => {
    const app = createApp({
      manifestPath,
      skipSpaceValidation: true,
    });

    expect(app.documentUiSchemaQuery).toBeDefined();
    expect(app.documentUiBlock).toBeDefined();

    const uiSchema = await app.documentUiSchemaQuery!.getDocumentUiSchema('procurement-request');
    expect(uiSchema?.layout).toEqual(['requestTitle', 'estimatedCost', 'vendorCategory']);
  });
});
