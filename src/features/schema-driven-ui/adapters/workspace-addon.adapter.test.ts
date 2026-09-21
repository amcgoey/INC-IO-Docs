import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { UiViewModel, type UiView } from '../domain';
import {
  WorkspaceAddonAdapter,
  WORKSPACE_ADDON_VIEW_ID,
} from './workspace-addon.adapter';
import type { UiViewAdapterContext } from '../ports';

describe('WorkspaceAddonAdapter', () => {
  let adapter: WorkspaceAddonAdapter;

  const assertValidUiView = (view: UiView): void => {
    expect(Value.Check(UiViewModel, view)).toBe(true);
  };

  const createContext = (
    overrides?: Partial<UiViewAdapterContext>
  ): UiViewAdapterContext => ({
    viewId: adapter.viewId,
    ...overrides,
  });

  beforeEach(() => {
    adapter = new WorkspaceAddonAdapter();
  });

  it('initializes with hard-coded viewId and standard process header per ADR-0010', async () => {
    expect(adapter.viewId).toBe(WORKSPACE_ADDON_VIEW_ID);

    const view = await adapter.composeView(createContext());
    expect(view.id).toBe(WORKSPACE_ADDON_VIEW_ID);
    expect(view.header?.title).toBe('INC-IO Engine');
    expect(view.header?.subtitle).toBe('Process Document');
    assertValidUiView(view);
  });

  it('composes minimal view containing admin section when context is sparse', async () => {
    const view = await adapter.composeView(createContext());
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0].header).toBe('Admin');
    assertValidUiView(view);
  });

  it('orchestrates status message block first when validation errors are provided', async () => {
    const context = createContext({
      validationErrors: ['Document title is required', 'Cost must be positive'],
    });

    const view = await adapter.composeView(context);
    expect(view.sections).toHaveLength(2);
    expect(view.sections[0].widgets[0].textParagraph?.text).toContain('Document title is required');
    expect(view.sections[0].widgets[0].textParagraph?.text).toContain('Cost must be positive');
    expect(view.sections[1].header).toBe('Admin');
    assertValidUiView(view);
  });

  it('orchestrates selection section with action triggers when selectionState is present', async () => {
    const context = createContext({
      selectionState: {
        spaceTypes: [{ text: 'Department', value: 'dept' }],
        spaces: ['Engineering'],
        documentTypes: [{ text: 'Invoice', value: 'inv' }],
      },
    });

    const view = await adapter.composeView(context);
    expect(view.sections).toHaveLength(2);
    const selectionSection = view.sections[0];
    expect(selectionSection.header).toBe('Document Type');
    expect(selectionSection.widgets).toHaveLength(3);
    expect(selectionSection.widgets[0].selectionInput?.onChangeAction).toEqual({
      action: 'onSpaceTypeChange',
    });
    expect(selectionSection.widgets[2].selectionInput?.onChangeAction).toEqual({
      action: 'onDocumentTypeChange',
    });
    assertValidUiView(view);
  });

  it('orchestrates document info section when documentSchema and uiSchema are provided', async () => {
    const context = createContext({
      documentSchema: {
        fields: [
          { key: 'invoiceNumber', type: 'string' },
          { key: 'totalAmount', type: 'number' },
        ],
      },
      uiSchema: {
        layout: ['invoiceNumber', 'totalAmount'],
        fields: {
          invoiceNumber: { label: 'Invoice #' },
          totalAmount: { label: 'Total ($)' },
        },
      },
    });

    const view = await adapter.composeView(context);
    expect(view.sections).toHaveLength(2);
    const infoSection = view.sections[0];
    expect(infoSection.header).toBe('Document Data');
    expect(infoSection.widgets).toHaveLength(2);
    expect(infoSection.widgets[0].textInput?.label).toBe('Invoice #');
    expect(infoSection.widgets[1].textInput?.label).toBe('Total ($)');
    assertValidUiView(view);
  });

  it('propagates evaluationOrder from uiSchema to the UiView root', async () => {
    const context = createContext({
      uiSchema: {
        evaluationOrder: ['qty', 'unitPrice', 'total'],
      },
    });

    const view = await adapter.composeView(context);
    expect(view.evaluationOrder).toEqual(['qty', 'unitPrice', 'total']);
    assertValidUiView(view);
  });

  it('declaratively composes full end-to-end card with all sections in expected schema order', async () => {
    const context = createContext({
      validationErrors: ['Error A'],
      selectionState: {
        spaceTypes: [{ text: 'Default', value: 'default' }],
        spaces: ['Main'],
        documentTypes: [{ text: 'Form', value: 'form' }],
      },
      documentSchema: {
        fields: [{ key: 'title', type: 'string' }],
      },
      uiSchema: {
        layout: ['title'],
        fields: { title: { label: 'Title' } },
        evaluationOrder: ['title'],
      },
    });

    const view = await adapter.composeView(context);

    // Assert sections order per declarative schema:
    // 1. Status Message Section
    // 2. Document Type Selection Section
    // 3. Document Info Section
    // 4. Admin Section
    expect(view.sections).toHaveLength(4);
    expect(view.sections[0].widgets[0].textParagraph?.text).toContain('Error A');
    expect(view.sections[1].header).toBe('Document Type');
    expect(view.sections[2].header).toBe('Document Data');
    expect(view.sections[3].header).toBe('Admin');
    expect(view.evaluationOrder).toEqual(['title']);
    assertValidUiView(view);
  });

  it('resolves human-readable document type names via DocumentTypeDisplayNameResolverPort when provided', async () => {
    const mockResolver = {
      getDisplayName: vi.fn().mockImplementation(async (key: string) => {
        if (key === 'inv') return 'Invoice Document';
        return undefined;
      }),
    };

    const customAdapter = new WorkspaceAddonAdapter(mockResolver);
    const context = createContext({
      selectionState: {
        spaceTypes: [{ text: 'Department', value: 'dept' }],
        spaces: ['Engineering'],
        documentTypes: [{ text: 'inv', value: 'inv' }],
      },
    });

    const view = await customAdapter.composeView(context);
    const selectionSection = view.sections[0];
    const docTypeDropdown = selectionSection.widgets[2].selectionInput;
    expect(docTypeDropdown?.items?.[0].text).toBe('Invoice Document');
    expect(docTypeDropdown?.items?.[0].value).toBe('inv');
    assertValidUiView(view);
  });

  it('renders Process Document button in Document Data section when documentTypeKey is provided', async () => {
    const context = createContext({
      documentTypeKey: 'invoice',
      documentSchema: {
        fields: [{ key: 'invoiceNumber', type: 'string' }],
      },
      uiSchema: {
        layout: ['invoiceNumber'],
        fields: { invoiceNumber: { label: 'Invoice #' } },
      },
    });

    const view = await adapter.composeView(context);
    expect(view.sections).toHaveLength(2);

    const infoSection = view.sections[0];
    expect(infoSection.header).toBe('Document Data');
    expect(infoSection.widgets).toHaveLength(2);
    expect(infoSection.widgets[0].textInput?.name).toBe('invoiceNumber');
    expect(infoSection.widgets[1].buttonList?.buttons).toEqual([
      { text: 'Process Document', onClick: { action: 'processDocument' } },
    ]);

    const adminSection = view.sections[1];
    expect(adminSection.header).toBe('Admin');
    expect(adminSection.widgets[0].buttonList?.buttons).toEqual([
      { text: 'Refresh Document', onClick: { action: 'refresh' } },
      { text: 'View Raw JSON', onClick: { action: 'viewJson' } },
    ]);
    assertValidUiView(view);
  });

  it('excludes Process Document button when documentTypeKey is empty or undefined', async () => {
    const contextUndefined = createContext({
      documentSchema: {
        fields: [{ key: 'invoiceNumber', type: 'string' }],
      },
    });

    const viewUndefined = await adapter.composeView(contextUndefined);
    const infoSectionUndefined = viewUndefined.sections[0];
    expect(infoSectionUndefined.widgets.some((w) => w.buttonList !== undefined)).toBe(false);

    const contextEmpty = createContext({
      documentTypeKey: '',
      documentSchema: {
        fields: [{ key: 'invoiceNumber', type: 'string' }],
      },
    });

    const viewEmpty = await adapter.composeView(contextEmpty);
    const infoSectionEmpty = viewEmpty.sections[0];
    expect(infoSectionEmpty.widgets.some((w) => w.buttonList !== undefined)).toBe(false);
  });
});
