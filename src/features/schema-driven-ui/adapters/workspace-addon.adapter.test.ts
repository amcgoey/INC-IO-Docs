import { describe, it, expect, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { UiViewModel } from '../domain';
import * as blocks from '../blocks';
import {
  WorkspaceAddonAdapter,
  WORKSPACE_ADDON_VIEW_ID,
} from './workspace-addon.adapter';
import type { UiViewAdapterContext } from '../ports';

describe('WorkspaceAddonAdapter', () => {
  it('initializes with hard-coded viewId and standard process header per ADR-0010', () => {
    const adapter = new WorkspaceAddonAdapter();
    expect(adapter.viewId).toBe(WORKSPACE_ADDON_VIEW_ID);

    const view = adapter.composeView({ viewId: adapter.viewId });
    expect(view.id).toBe(WORKSPACE_ADDON_VIEW_ID);
    expect(view.header?.title).toBe('INC-IO Engine');
    expect(view.header?.subtitle).toBe('Process Document');
    expect(Value.Check(UiViewModel, view)).toBe(true);
  });

  it('composes minimal view containing admin section when context is sparse', () => {
    const adapter = new WorkspaceAddonAdapter();
    const context: UiViewAdapterContext = { viewId: adapter.viewId };

    const view = adapter.composeView(context);
    expect(view.sections).toHaveLength(1);
    expect(view.sections[0].header).toBe('Admin');
    expect(Value.Check(UiViewModel, view)).toBe(true);
  });

  it('orchestrates status message block first when validation errors are provided', () => {
    const adapter = new WorkspaceAddonAdapter();
    const context: UiViewAdapterContext = {
      viewId: adapter.viewId,
      validationErrors: ['Document title is required', 'Cost must be positive'],
    };

    const view = adapter.composeView(context);
    expect(view.sections).toHaveLength(2);
    expect(view.sections[0].widgets[0].textParagraph?.text).toContain('Document title is required');
    expect(view.sections[0].widgets[0].textParagraph?.text).toContain('Cost must be positive');
    expect(view.sections[1].header).toBe('Admin');
    expect(Value.Check(UiViewModel, view)).toBe(true);
  });

  it('orchestrates selection section with action triggers when selectionState is present', () => {
    const adapter = new WorkspaceAddonAdapter();
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
    expect(Value.Check(UiViewModel, view)).toBe(true);
  });

  it('orchestrates document info section when documentSchema and uiSchema are provided', () => {
    const adapter = new WorkspaceAddonAdapter();
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
    expect(Value.Check(UiViewModel, view)).toBe(true);
  });

  it('propagates evaluationOrder from uiSchema to the UiView root', () => {
    const adapter = new WorkspaceAddonAdapter();
    const context: UiViewAdapterContext = {
      viewId: adapter.viewId,
      uiSchema: {
        evaluationOrder: ['qty', 'unitPrice', 'total'],
      },
    };

    const view = adapter.composeView(context);
    expect(view.evaluationOrder).toEqual(['qty', 'unitPrice', 'total']);
    expect(Value.Check(UiViewModel, view)).toBe(true);
  });

  it('verifies adapter composition by walking schema context and invoking the right blocks', () => {
    const statusSpy = vi.spyOn(blocks, 'buildStatusMessageSection');
    const selectionSpy = vi.spyOn(blocks, 'buildDocumentTypeSelectionSection');
    const infoSpy = vi.spyOn(blocks, 'buildDocumentInfoSection');
    const adminSpy = vi.spyOn(blocks, 'buildDocumentAdminSection');

    const adapter = new WorkspaceAddonAdapter();
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

    expect(statusSpy).toHaveBeenCalledWith({ validationErrors: ['Error A'] });
    expect(selectionSpy).toHaveBeenCalledWith(context.selectionState, {
      onSpaceTypeChangeAction: { action: 'onSpaceTypeChange' },
      onDocumentTypeChangeAction: { action: 'onDocumentTypeChange' },
    });
    expect(infoSpy).toHaveBeenCalledWith(
      context.documentSchema,
      context.uiSchema,
      { sectionHeader: 'Document Data' }
    );
    expect(adminSpy).toHaveBeenCalled();

    expect(view.sections).toHaveLength(4);
    expect(Value.Check(UiViewModel, view)).toBe(true);

    statusSpy.mockRestore();
    selectionSpy.mockRestore();
    infoSpy.mockRestore();
    adminSpy.mockRestore();
  });
});
