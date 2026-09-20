import { describe, it, expect, beforeEach } from 'vitest';
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

  beforeEach(() => {
    adapter = new WorkspaceAddonAdapter();
  });

  it('initializes with hard-coded viewId and standard process header per ADR-0010', () => {
    expect(adapter.viewId).toBe(WORKSPACE_ADDON_VIEW_ID);

    const view = adapter.composeView({ viewId: adapter.viewId });
    expect(view.id).toBe(WORKSPACE_ADDON_VIEW_ID);
    expect(view.header?.title).toBe('INC-IO Engine');
    expect(view.header?.subtitle).toBe('Process Document');
    assertValidUiView(view);
  });

  it('composes minimal view containing admin section when context is sparse', () => {
    const context: UiViewAdapterContext = { viewId: adapter.viewId };

    const view = adapter.composeView(context);
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0].header).toBe('Admin');
    assertValidUiView(view);
  });

  it('orchestrates status message block first when validation errors are provided', () => {
    const context: UiViewAdapterContext = {
      viewId: adapter.viewId,
      validationErrors: ['Document title is required', 'Cost must be positive'],
    };

    const view = adapter.composeView(context);
    expect(view.sections).toHaveLength(2);
    expect(view.sections[0].widgets[0].textParagraph?.text).toContain('Document title is required');
    expect(view.sections[0].widgets[0].textParagraph?.text).toContain('Cost must be positive');
    expect(view.sections[1].header).toBe('Admin');
    assertValidUiView(view);
  });

  it('orchestrates selection section with action triggers when selectionState is present', () => {
    const context: UiViewAdapterContext = {
      viewId: adapter.viewId,
      selectionState: {
        spaceTypes: [{ text: 'Department', value: 'dept' }],
        spaces: ['Engineering'],
        documentTypes: [{ text: 'Invoice', value: 'inv' }],
      },
    };

    const view = adapter.composeView(context);
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

  it('orchestrates document info section when documentSchema and uiSchema are provided', () => {
    const context: UiViewAdapterContext = {
      viewId: adapter.viewId,
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
    };

    const view = adapter.composeView(context);
    expect(view.sections).toHaveLength(2);
    const infoSection = view.sections[0];
    expect(infoSection.header).toBe('Document Data');
    expect(infoSection.widgets).toHaveLength(2);
    expect(infoSection.widgets[0].textInput?.label).toBe('Invoice #');
    expect(infoSection.widgets[1].textInput?.label).toBe('Total ($)');
    assertValidUiView(view);
  });

  it('propagates evaluationOrder from uiSchema to the UiView root', () => {
    const context: UiViewAdapterContext = {
      viewId: adapter.viewId,
      uiSchema: {
        evaluationOrder: ['qty', 'unitPrice', 'total'],
      },
    };

    const view = adapter.composeView(context);
    expect(view.evaluationOrder).toEqual(['qty', 'unitPrice', 'total']);
    assertValidUiView(view);
  });

  it('declaratively composes full end-to-end card with all sections in expected schema order', () => {
    const context: UiViewAdapterContext = {
      viewId: adapter.viewId,
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
    };

    const view = adapter.composeView(context);

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
});
