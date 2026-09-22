import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import { UiViewModel, UiViewActionSchema, type UiView } from '../domain';
import {
  WorkspaceAddonAdapter,
  WORKSPACE_ADDON_VIEW_ID,
} from './workspace-addon.adapter';
import type { UiViewAdapterContext } from '../ports';

describe('WorkspaceAddonAdapter', () => {
  let adapter: WorkspaceAddonAdapter;

  const assertValidAgnosticAction = (action: unknown): void => {
    expect(action).toBeDefined();
    expect(Value.Check(UiViewActionSchema, action)).toBe(true);
  };

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

  it('namespaces document data widget names with documentTypeKey when provided in context', async () => {
    const context = createContext({
      documentTypeKey: 'invoice-doc',
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
    expect(infoSection.widgets).toHaveLength(3); // 2 inputs + Process Document button
    expect(infoSection.widgets[0].textInput?.name).toBe('invoiceNumber_invoice-doc');
    expect(infoSection.widgets[1].textInput?.name).toBe('totalAmount_invoice-doc');
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
    expect(infoSection.widgets[0].textInput?.name).toBe('invoiceNumber_invoice');
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
    assertValidUiView(viewUndefined);
    const infoSectionUndefined = viewUndefined.sections[0];
    expect(infoSectionUndefined.widgets.some((w) => w.buttonList !== undefined)).toBe(false);

    const contextEmpty = createContext({
      documentTypeKey: '',
      documentSchema: {
        fields: [{ key: 'invoiceNumber', type: 'string' }],
      },
    });

    const viewEmpty = await adapter.composeView(contextEmpty);
    assertValidUiView(viewEmpty);
    const infoSectionEmpty = viewEmpty.sections[0];
    expect(infoSectionEmpty.widgets.some((w) => w.buttonList !== undefined)).toBe(false);
  });

  describe('Agnostic UiAction and UiView Boundary Assertions', () => {
    it('strictly translates full context into agnostic UiView and UiActions without Google Workspace formats', async () => {
      const context = createContext({
        validationErrors: ['Missing required field "amount"'],
        selectionState: {
          spaceTypes: [
            { text: 'Engineering Space', value: 'eng-space', selected: true },
            { text: 'Operations Space', value: 'ops-space' },
          ],
          spaces: ['Eng-Project-Alpha', 'Eng-Project-Beta'],
          documentTypes: [
            { text: 'Invoice Doc', value: 'invoice-doc', selected: true },
            { text: 'Receipt Doc', value: 'receipt-doc' },
          ],
        },
        documentTypeKey: 'invoice-doc',
        documentSchema: {
          fields: [
            { key: 'amount', type: 'string', defaultValue: '100' },
            { key: 'status', type: 'string', options: ['PENDING', 'APPROVED'] },
          ],
        },
        uiSchema: {
          layout: ['amount', 'status'],
          fields: {
            amount: { label: 'Total Amount', onChange: true },
            status: { label: 'Approval Status', onChange: 'onStatusChanged' },
          },
          evaluationOrder: ['amount', 'status'],
        },
        formData: {
          'amount_invoice-doc': '250',
          status: 'PENDING',
        },
      });

      const view = await adapter.composeView(context);

      // 1. Boundary assertion: view strictly satisfies UiViewModel
      assertValidUiView(view);
      expect(view.id).toBe(WORKSPACE_ADDON_VIEW_ID);
      expect(view.header).toEqual({
        title: 'INC-IO Engine',
        subtitle: 'Process Document',
      });
      expect(view.evaluationOrder).toEqual(['amount', 'status']);
      expect(view.sections).toHaveLength(4);

      // 2. Section 0: Status message section
      const statusSection = view.sections[0];
      expect(statusSection.widgets[0].textParagraph?.text).toContain('Missing required field "amount"');

      // 3. Section 1: Document Type selection section
      const selectionSection = view.sections[1];
      expect(selectionSection.header).toBe('Document Type');
      expect(selectionSection.widgets).toHaveLength(3);

      const spaceTypeAction = selectionSection.widgets[0].selectionInput?.onChangeAction;
      assertValidAgnosticAction(spaceTypeAction);
      expect(spaceTypeAction).toEqual({ action: 'onSpaceTypeChange' });

      const spaceWidget = selectionSection.widgets[1].textInput;
      expect(spaceWidget?.name).toBe('SelectDocumentSpace_eng-space');
      expect(spaceWidget?.value).toBe('Eng-Project-Alpha');
      expect(spaceWidget?.autocomplete).toEqual([
        { text: 'Eng-Project-Alpha', value: 'Eng-Project-Alpha' },
        { text: 'Eng-Project-Beta', value: 'Eng-Project-Beta' },
      ]);

      const docTypeAction = selectionSection.widgets[2].selectionInput?.onChangeAction;
      assertValidAgnosticAction(docTypeAction);
      expect(docTypeAction).toEqual({ action: 'onDocumentTypeChange' });

      // 4. Section 2: Document Info section
      const infoSection = view.sections[2];
      expect(infoSection.header).toBe('Document Data');
      expect(infoSection.widgets).toHaveLength(3); // 2 inputs + Process Document button

      const amountAction = infoSection.widgets[0].textInput?.onChangeAction;
      assertValidAgnosticAction(amountAction);
      expect(amountAction).toEqual({ action: 'onFormChange' });
      expect(infoSection.widgets[0].textInput?.value).toBe('250');

      const statusAction = infoSection.widgets[1].selectionInput?.onChangeAction;
      assertValidAgnosticAction(statusAction);
      expect(statusAction).toEqual({ action: 'onStatusChanged' });

      const processButton = infoSection.widgets[2].buttonList?.buttons[0];
      expect(processButton?.text).toBe('Process Document');
      assertValidAgnosticAction(processButton?.onClick);
      expect(processButton?.onClick).toEqual({ action: 'processDocument' });

      // 5. Section 3: Admin section
      const adminSection = view.sections[3];
      expect(adminSection.header).toBe('Admin');
      expect(adminSection.collapsible).toBe(true);

      const adminButtons = adminSection.widgets[0].buttonList?.buttons;
      expect(adminButtons).toHaveLength(2);
      assertValidAgnosticAction(adminButtons?.[0].onClick);
      expect(adminButtons?.[0].onClick).toEqual({ action: 'refresh' });
      assertValidAgnosticAction(adminButtons?.[1].onClick);
      expect(adminButtons?.[1].onClick).toEqual({ action: 'viewJson' });
    });

    it('strictly preserves agnostic boundaries when displayNameResolver asynchronously updates document types', async () => {
      const mockResolver = {
        getDisplayName: vi.fn().mockImplementation(async (key: string) => {
          if (key === 'doc-contract') return 'Legal Contract';
          return undefined; // fallback to raw text
        }),
      };

      const customAdapter = new WorkspaceAddonAdapter(mockResolver);
      const context = createContext({
        selectionState: {
          spaceTypes: [{ text: 'Legal', value: 'legal' }],
          spaces: [],
          documentTypes: [
            { text: 'Contract Key', value: 'doc-contract' },
            { text: 'Unknown Key', value: 'doc-unknown' },
          ],
        },
      });

      const view = await customAdapter.composeView(context);

      assertValidUiView(view);

      const selectionSection = view.sections[0];
      const docTypeItems = selectionSection.widgets[2].selectionInput?.items;
      expect(docTypeItems).toEqual([
        { text: 'Legal Contract', value: 'doc-contract' },
        { text: 'Unknown Key', value: 'doc-unknown' },
      ]);

      // Assert actions remain pure agnostic UiViewAction
      const docTypeAction = selectionSection.widgets[2].selectionInput?.onChangeAction;
      assertValidAgnosticAction(docTypeAction);
      expect(docTypeAction).toEqual({ action: 'onDocumentTypeChange' });
    });

    it('strictly preserves agnostic boundaries when only sparse context is provided', async () => {
      const view = await adapter.composeView(createContext());
      assertValidUiView(view);

      expect(view.sections).toHaveLength(1);
      const adminSection = view.sections[0];
      expect(adminSection.header).toBe('Admin');
      for (const btn of adminSection.widgets[0].buttonList?.buttons ?? []) {
        assertValidAgnosticAction(btn.onClick);
      }
    });

    it('translates document info without documentTypeKey maintaining agnostic boundary and omitting process button', async () => {
      const context = createContext({
        documentSchema: {
          fields: [
            { key: 'notes', type: 'string' },
          ],
        },
        uiSchema: {
          layout: ['notes'],
          fields: {
            notes: { label: 'General Notes', onChange: true },
          },
        },
      });

      const view = await adapter.composeView(context);
      assertValidUiView(view);

      expect(view.sections).toHaveLength(2);
      const infoSection = view.sections[0];
      expect(infoSection.header).toBe('Document Data');
      expect(infoSection.widgets).toHaveLength(1); // input only, no process button
      expect(infoSection.widgets[0].textInput?.name).toBe('notes');

      const onChangeAction = infoSection.widgets[0].textInput?.onChangeAction;
      assertValidAgnosticAction(onChangeAction);
      expect(onChangeAction).toEqual({ action: 'onFormChange' });
    });

    it('translates text input with options to agnostic autocomplete items', async () => {
      const context = createContext({
        documentTypeKey: 'report',
        documentSchema: {
          fields: [
            {
              key: 'category',
              type: 'string',
              options: ['Financial', 'Operational', 'Technical'],
            },
          ],
        },
        uiSchema: {
          layout: ['category'],
          fields: {
            category: { widget: 'textInput', label: 'Report Category' },
          },
        },
      });

      const view = await adapter.composeView(context);
      assertValidUiView(view);

      const infoSection = view.sections[0];
      const textInput = infoSection.widgets[0].textInput;
      expect(textInput?.autocomplete).toEqual([
        { text: 'Financial', value: 'Financial' },
        { text: 'Operational', value: 'Operational' },
        { text: 'Technical', value: 'Technical' },
      ]);
    });

    it('composes status and selection sections together without document info adhering to boundary', async () => {
      const context = createContext({
        validationErrors: ['Invalid document state'],
        selectionState: {
          spaceTypes: [{ text: 'Default Space', value: 'default-space' }],
          spaces: [],
          documentTypes: [{ text: 'Default Doc', value: 'default-doc' }],
        },
      });

      const view = await adapter.composeView(context);
      assertValidUiView(view);

      expect(view.sections).toHaveLength(3); // Status, Selection, Admin
      expect(view.sections[0].widgets[0].textParagraph?.text).toContain('Invalid document state');
      expect(view.sections[1].header).toBe('Document Type');
      expect(view.sections[2].header).toBe('Admin');

      assertValidAgnosticAction(view.sections[1].widgets[0].selectionInput?.onChangeAction);
      assertValidAgnosticAction(view.sections[1].widgets[2].selectionInput?.onChangeAction);
      assertValidAgnosticAction(view.sections[2].widgets[0].buttonList?.buttons[0].onClick);
    });
  });
});

