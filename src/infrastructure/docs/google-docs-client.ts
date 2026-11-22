import { google, type docs_v1 } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';
import { Value } from '@sinclair/typebox/value';
import {
  GoogleDocsDocumentSchema,
  type DocsOperationOptions,
  type GoogleDocsClientOptions,
  type GoogleDocsDocument,
  type GoogleDocsDocumentTab,
  type GoogleDocsFormExtractResult,
  type GoogleDocsFormFieldValue,
  type GoogleDocsStructuralElement,
  type GoogleDocsTab,
} from './types';
import {
  GoogleDocsApiError,
  GoogleDocsCorruptedError,
  GoogleDocsNotFoundError,
} from './errors';

const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;

function extractHttpStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const err = error as {
    statusCode?: unknown;
    status?: unknown;
    code?: unknown;
    response?: { status?: unknown };
  };
  if (typeof err.statusCode === 'number') return err.statusCode;
  if (typeof err.status === 'number') return err.status;
  if (err.response && typeof err.response.status === 'number') return err.response.status;
  if (typeof err.code === 'number') return err.code;
  if (typeof err.code === 'string' && err.code.trim() !== '' && !Number.isNaN(Number(err.code))) {
    return Number(err.code);
  }
  return undefined;
}

function formatErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof (error as { message: unknown }).message === 'string'
  ) {
    return (error as { message: string }).message;
  }
  return String(error);
}
const PURE_HANDLEBARS_PLACEHOLDER_REGEX = /^(?:\{\{[^{}]*\}\}[\s\-_./]*)+$/;
const DIVIDER_PUNCTUATION_REGEX = /^[–—-]+$/;

type GoogleDocsTable = NonNullable<GoogleDocsStructuralElement['table']>;
type GoogleDocsTableRow = NonNullable<GoogleDocsTable['tableRows']>[number];
type GoogleDocsTableCell = NonNullable<GoogleDocsTableRow['tableCells']>[number];
type GoogleDocsParagraph = NonNullable<GoogleDocsStructuralElement['paragraph']>;
type GoogleDocsParagraphElement = NonNullable<GoogleDocsParagraph['elements']>[number];
type GoogleDocsDropdownElement = NonNullable<GoogleDocsParagraphElement['dropdown']>;
type GoogleDocsDropdownDefinition = NonNullable<GoogleDocsDocumentTab['dropdownDefinitions']>[string];

const UNSET_DROPDOWN_GLYPH_REGEX = /^(?:☐|⬚|□|\[\s*\])$/;
const UNSET_DROPDOWN_PROMPT_REGEX = /^(?:select\b|choose\b|[-—–]+$)/i;

const UNCHECKED_TOKENS = new Set(['', '☐', '⬚', '□', '[ ]', '[  ]', '()', '( )']);
const CHECKED_TOKENS = new Set(['☑', '☒', '✓', '✔', '✕', '✖', 'x', 'X', '[x]', '[X]', '(x)', '(X)']);
const EXPLICIT_CHECKBOX_MARKERS = new Set([
  '☐',
  '⬚',
  '□',
  '[ ]',
  '[  ]',
  '()',
  '( )',
  '☑',
  '☒',
  '✓',
  '✔',
  '✕',
  '✖',
  '[x]',
  '[X]',
  '(x)',
  '(X)',
]);

export function normalizeFormLabelKey(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().replace(/[.:]+$/, '').trim();
}

function isPlausibleFieldLabel(key: string): boolean {
  return (
    key.length >= 1 &&
    key.length <= 40 &&
    !PURE_HANDLEBARS_PLACEHOLDER_REGEX.test(key) &&
    !DIVIDER_PUNCTUATION_REGEX.test(key)
  );
}

function normalizeStaticSingleLineLabel(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (raw.includes('\ue907') || /[\r\n]/.test(raw)) return undefined;
  const normalized = normalizeFormLabelKey(raw);
  return isPlausibleFieldLabel(normalized) ? normalized : undefined;
}

function resolveDropdownDisplayText(
  dropdown: GoogleDocsDropdownElement,
  dropdownDefs: Record<string, GoogleDocsDropdownDefinition>
): string {
  const props = dropdown.dropdownProperties;
  const rawDisplay = props?.displayValue;
  if (rawDisplay !== null && rawDisplay !== undefined && rawDisplay !== '') {
    return rawDisplay;
  }
  const def = props?.dropdownDefinitionId ? dropdownDefs[props.dropdownDefinitionId] : undefined;
  if (props?.selectedOptionId && def?.dropdownDefinitionProperties?.options) {
    const matchedOption = def.dropdownDefinitionProperties.options.find(
      (opt) => opt.optionId === props.selectedOptionId
    );
    if (matchedOption?.displayValue !== null && matchedOption?.displayValue !== undefined) {
      return matchedOption.displayValue;
    }
  }
  return '';
}

function isUnsetDropdownOption(
  def: GoogleDocsDropdownDefinition | undefined,
  selectedOptionId: string | null | undefined,
  displayValue: string
): boolean {
  const trimmed = displayValue.trim();
  if (!trimmed) return true;
  if (UNSET_DROPDOWN_GLYPH_REGEX.test(trimmed)) {
    return true;
  }
  const firstOptId = def?.dropdownDefinitionProperties?.options?.[0]?.optionId;
  const isFirstOrAbsent =
    !def ||
    !selectedOptionId ||
    (firstOptId !== null && firstOptId !== undefined && selectedOptionId === firstOptId);
  return isFirstOrAbsent && UNSET_DROPDOWN_PROMPT_REGEX.test(trimmed);
}

function extractStaticLabel(cell: GoogleDocsTableCell): string | undefined {
  const lines: string[] = [];
  for (const contentEl of cell.content ?? []) {
    if (!contentEl.paragraph) {
      return undefined;
    }
    let rawParaText = '';
    for (const pe of contentEl.paragraph.elements ?? []) {
      if (pe.dropdown || pe.dateElement || pe.person) {
        return undefined;
      }
      if (pe.textRun?.content) {
        if (pe.textRun.content.includes('\ue907')) {
          return undefined;
        }
        rawParaText += pe.textRun.content;
      }
    }
    const strippedPara = rawParaText.replace(/\n$/, '');
    if (/[\r\n]/.test(strippedPara)) {
      return undefined;
    }
    lines.push(strippedPara);
  }

  if (lines.length !== 1) {
    return undefined;
  }

  const normalized = normalizeFormLabelKey(lines[0]!);
  return isPlausibleFieldLabel(normalized) ? normalized : undefined;
}

function serializeCellElements(
  cell: GoogleDocsTableCell,
  dropdownDefs: Record<string, GoogleDocsDropdownDefinition>
): string | undefined {
  const lines: string[] = [];

  for (const contentEl of cell.content ?? []) {
    if (!contentEl.paragraph) continue;
    let paraStr = '';
    for (const pe of contentEl.paragraph.elements ?? []) {
      if (pe.dropdown) {
        const props = pe.dropdown.dropdownProperties;
        const def = props?.dropdownDefinitionId ? dropdownDefs[props.dropdownDefinitionId] : undefined;
        const display = resolveDropdownDisplayText(pe.dropdown, dropdownDefs);
        if (!isUnsetDropdownOption(def, props?.selectedOptionId, display)) {
          paraStr += display.trim();
        }
      } else if (pe.textRun?.content) {
        paraStr += pe.textRun.content.replace(/\ue907/g, '').replace(/\n$/, '');
      }
    }
    lines.push(paraStr);
  }

  const joined = lines.join('\n').trim();
  if (!joined || PURE_HANDLEBARS_PLACEHOLDER_REGEX.test(joined)) {
    return undefined;
  }
  return joined;
}

function classifyParagraphHeading(
  paragraph: GoogleDocsParagraph
): { kind: 'blank' } | { kind: 'heading'; label: string } | { kind: 'reset' } {
  let rawParaText = '';
  for (const pe of paragraph.elements ?? []) {
    if (pe.dropdown || pe.dateElement || pe.person) {
      return { kind: 'reset' };
    }
    if (pe.textRun?.content) {
      if (pe.textRun.content.includes('\ue907')) {
        return { kind: 'reset' };
      }
      rawParaText += pe.textRun.content;
    }
  }

  const strippedPara = rawParaText.replace(/\n$/, '');
  if (/[\r\n]/.test(strippedPara)) {
    return { kind: 'reset' };
  }
  if (strippedPara.trim() === '') {
    return { kind: 'blank' };
  }

  const normalized = normalizeFormLabelKey(strippedPara);
  return isPlausibleFieldLabel(normalized)
    ? { kind: 'heading', label: normalized }
    : { kind: 'reset' };
}

function classifyCheckboxCell(
  cell: GoogleDocsTableCell,
  dropdownDefs: Record<string, GoogleDocsDropdownDefinition>
): { state: 'checked' | 'unchecked' | 'not_checkbox'; hasExplicitMarkerOrDropdown: boolean } {
  let hasDropdown = false;
  const lines: string[] = [];

  for (const contentEl of cell.content ?? []) {
    if (!contentEl.paragraph) {
      return { state: 'not_checkbox', hasExplicitMarkerOrDropdown: false };
    }
    let paraStr = '';
    for (const pe of contentEl.paragraph.elements ?? []) {
      if (pe.dateElement || pe.person) {
        return { state: 'not_checkbox', hasExplicitMarkerOrDropdown: false };
      }
      if (pe.dropdown) {
        hasDropdown = true;
        paraStr += resolveDropdownDisplayText(pe.dropdown, dropdownDefs).trim();
      } else if (pe.textRun?.content) {
        if (pe.textRun.content.includes('\ue907')) {
          return { state: 'not_checkbox', hasExplicitMarkerOrDropdown: false };
        }
        paraStr += pe.textRun.content.replace(/\n$/, '');
      }
    }
    lines.push(paraStr);
  }

  const trimmed = lines.join('\n').trim();
  const hasExplicitMarkerOrDropdown = hasDropdown || EXPLICIT_CHECKBOX_MARKERS.has(trimmed);

  if (UNCHECKED_TOKENS.has(trimmed)) {
    return { state: 'unchecked', hasExplicitMarkerOrDropdown };
  }
  if (CHECKED_TOKENS.has(trimmed)) {
    return { state: 'checked', hasExplicitMarkerOrDropdown };
  }
  return { state: 'not_checkbox', hasExplicitMarkerOrDropdown: false };
}

function walkStructuralElementsForDropdowns(
  elements: GoogleDocsStructuralElement[] | null | undefined,
  visit: (dropdown: GoogleDocsDropdownElement) => void
): void {
  for (const el of elements ?? []) {
    if (el.paragraph) {
      for (const pe of el.paragraph.elements ?? []) {
        if (pe.dropdown) {
          visit(pe.dropdown);
        }
      }
    }
    if (el.table) {
      for (const row of el.table.tableRows ?? []) {
        for (const cell of row.tableCells ?? []) {
          walkStructuralElementsForDropdowns(cell.content, visit);
        }
      }
    }
  }
}

function isUnmergedCell(cell: GoogleDocsTableCell | undefined): cell is GoogleDocsTableCell {
  if (!cell) return false;
  return (cell.tableCellStyle?.columnSpan ?? 1) === 1 && (cell.tableCellStyle?.rowSpan ?? 1) === 1;
}

interface ParsedCheckboxOptionRow {
  state: 'checked' | 'unchecked';
  optionLabel: string;
  c0: GoogleDocsTableCell;
}

function parseCheckboxOptionTable(
  rows: GoogleDocsTableRow[],
  dropdownDefs: Record<string, GoogleDocsDropdownDefinition>
): ParsedCheckboxOptionRow[] | undefined {
  const optionRows: ParsedCheckboxOptionRow[] = [];
  let hasExplicitMarkerOrDropdown = false;

  for (const row of rows) {
    const cells = row.tableCells ?? [];
    const c0 = cells[0];
    if (!c0) return undefined;

    if ((c0.tableCellStyle?.columnSpan ?? 1) > 1) {
      // Ignore full-row merged disclaimer banners
      continue;
    }

    const c1 = cells[1];
    if (
      !c1 ||
      (c0.tableCellStyle?.columnSpan ?? 1) !== 1 ||
      (c0.tableCellStyle?.rowSpan ?? 1) !== 1 ||
      (c1.tableCellStyle?.columnSpan ?? 1) !== 1
    ) {
      return undefined;
    }

    const optionLabel = extractStaticLabel(c1);
    if (optionLabel === undefined) return undefined;

    const classification = classifyCheckboxCell(c0, dropdownDefs);
    if (classification.state === 'not_checkbox') return undefined;

    if (classification.hasExplicitMarkerOrDropdown) {
      hasExplicitMarkerOrDropdown = true;
    }
    optionRows.push({ state: classification.state, optionLabel, c0 });
  }

  return optionRows.length >= 2 && hasExplicitMarkerOrDropdown ? optionRows : undefined;
}

function parseKeyValueTable(
  rows: GoogleDocsTableRow[]
): Array<{ label: string; valueCell: GoogleDocsTableCell }> | undefined {
  const parsedRows: Array<{ label: string; valueCell: GoogleDocsTableCell }> = [];
  for (const row of rows) {
    const cells = row.tableCells ?? [];
    const col0 = cells[0];
    const col1 = cells[1];
    if (cells.length !== 2 || !isUnmergedCell(col0) || !isUnmergedCell(col1)) {
      return undefined;
    }
    const label = extractStaticLabel(col0);
    if (label === undefined) return undefined;
    parsedRows.push({ label, valueCell: col1 });
  }
  return parsedRows;
}

function validateGoogleDocsDocument(input: unknown): GoogleDocsDocument {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new GoogleDocsCorruptedError('Google Docs payload must be a non-null object');
  }

  if (!Value.Check(GoogleDocsDocumentSchema, input)) {
    const errors = [...Value.Errors(GoogleDocsDocumentSchema, input)]
      .slice(0, 3)
      .map((err) => `${err.path || '/'}: ${err.message}`)
      .join('; ');
    throw new GoogleDocsCorruptedError(
      `Invalid Google Docs document structure${errors ? `: ${errors}` : ''}`
    );
  }

  const hasTabs = Array.isArray(input.tabs);
  const hasBody = input.body !== undefined && input.body !== null;
  if (!hasTabs && !hasBody) {
    throw new GoogleDocsCorruptedError('Google Docs document is missing both tabs and body');
  }

  return input;
}

function collectDocumentTabs(tabs: GoogleDocsTab[] | null | undefined): GoogleDocsDocumentTab[] {
  const out: GoogleDocsDocumentTab[] = [];
  for (const tab of tabs ?? []) {
    if (tab.documentTab) {
      out.push(tab.documentTab);
    }
    if (tab.childTabs) {
      out.push(...collectDocumentTabs(tab.childTabs));
    }
  }
  return out;
}

export class GoogleDocsClient {
  private readonly defaultDocs: docs_v1.Docs;
  private readonly defaultRequestTimeoutMs: number;

  constructor(options: GoogleDocsClientOptions = {}) {
    this.defaultRequestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;

    if (options.docs) {
      this.defaultDocs = options.docs;
    } else if (typeof options.auth === 'string') {
      this.defaultDocs = this.createDocsClientFromToken(options.auth);
    } else if (options.auth) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      this.defaultDocs = google.docs({ version: 'v1', auth: options.auth as any });
    } else {
      this.defaultDocs = google.docs({ version: 'v1' });
    }
  }

  private createDocsClientFromToken(oauthCred: string): docs_v1.Docs {
    const oauth2Client = new OAuth2Client();
    oauth2Client.setCredentials({ access_token: oauthCred });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return google.docs({ version: 'v1', auth: oauth2Client as any });
  }

  extractFormData(document: unknown): GoogleDocsFormExtractResult {
    const validDoc = validateGoogleDocsDocument(document);
    const docTabs: GoogleDocsDocumentTab[] =
      validDoc.tabs && validDoc.tabs.length > 0
        ? collectDocumentTabs(validDoc.tabs)
        : validDoc.body
          ? [{ body: validDoc.body }]
          : [];

    const fieldMap = new Map<string, GoogleDocsFormFieldValue>();
    const ambiguousSet = new Set<string>();
    const capturedDropdownIds = new Set<string>();
    const capturedDropdowns = new WeakSet<GoogleDocsDropdownElement>();
    let widgetCount = 0;

    const markDropdownCaptured = (dropdown: GoogleDocsDropdownElement): void => {
      capturedDropdowns.add(dropdown);
      if (dropdown.dropdownId) {
        capturedDropdownIds.add(dropdown.dropdownId);
      }
    };

    const isDropdownCaptured = (dropdown: GoogleDocsDropdownElement): boolean => {
      if (capturedDropdowns.has(dropdown)) return true;
      if (dropdown.dropdownId && capturedDropdownIds.has(dropdown.dropdownId)) return true;
      return false;
    };

    const markCellDropdownsCaptured = (cell: GoogleDocsTableCell): void => {
      walkStructuralElementsForDropdowns(cell.content, markDropdownCaptured);
    };

    for (const tab of docTabs) {
      const dropdownDefs = tab.dropdownDefinitions ?? {};
      let precedingHeadingLabel: string | undefined;
      let blankSpacerCount = 0;

      for (const el of tab.body?.content ?? []) {
        if (el.sectionBreak || el.tableOfContents) {
          precedingHeadingLabel = undefined;
          blankSpacerCount = 0;
          continue;
        }

        if (el.paragraph) {
          const state = classifyParagraphHeading(el.paragraph);
          if (state.kind === 'heading') {
            precedingHeadingLabel = state.label;
            blankSpacerCount = 0;
          } else if (state.kind === 'blank') {
            if (precedingHeadingLabel !== undefined) {
              blankSpacerCount += 1;
              if (blankSpacerCount > 2) {
                precedingHeadingLabel = undefined;
                blankSpacerCount = 0;
              }
            }
          } else {
            precedingHeadingLabel = undefined;
            blankSpacerCount = 0;
          }
          continue;
        }

        if (!el.table) {
          precedingHeadingLabel = undefined;
          blankSpacerCount = 0;
          continue;
        }

        const activeHeadingLabel = precedingHeadingLabel;
        precedingHeadingLabel = undefined;
        blankSpacerCount = 0;

        const rows = el.table.tableRows ?? [];
        const rowCount = rows.length;
        const colCount = el.table.columns ?? rows[0]?.tableCells?.length ?? 0;

        // Pattern 1: Heading + Checkbox Option Table (evaluated ahead of Pattern 4)
        if (activeHeadingLabel !== undefined && rowCount >= 2 && colCount >= 2) {
          const optionRows = parseCheckboxOptionTable(rows, dropdownDefs);
          if (optionRows) {
            for (const optRow of optionRows) {
              markCellDropdownsCaptured(optRow.c0);
            }
            widgetCount += 1;
            const checkedLabels = optionRows
              .filter((optRow) => optRow.state === 'checked')
              .map((optRow) => optRow.optionLabel);

            if (checkedLabels.length === 1) {
              const checkedLabel = checkedLabels[0]!;
              if (!ambiguousSet.has(activeHeadingLabel)) {
                if (fieldMap.has(activeHeadingLabel)) {
                  if (fieldMap.get(activeHeadingLabel) !== checkedLabel) {
                    fieldMap.delete(activeHeadingLabel);
                    ambiguousSet.add(activeHeadingLabel);
                  }
                } else {
                  fieldMap.set(activeHeadingLabel, checkedLabel);
                }
              }
            } else if (checkedLabels.length >= 2) {
              fieldMap.delete(activeHeadingLabel);
              ambiguousSet.add(activeHeadingLabel);
            }
            continue;
          }
        }

        // Pattern 4: N x 2 Key/Value Form Tables (e.g. 1x2 "Submittal No.")
        if (colCount === 2 && rowCount >= 1) {
          const parsedRows = parseKeyValueTable(rows);
          if (parsedRows) {
            for (const { label, valueCell } of parsedRows) {
              widgetCount += 1;
              markCellDropdownsCaptured(valueCell);
              const val = serializeCellElements(valueCell, dropdownDefs);
              if (val !== undefined && !fieldMap.has(label) && !ambiguousSet.has(label)) {
                fieldMap.set(label, val);
              }
            }
          }
        }
      }

      // Pattern 5: Standalone Dropdown Smart Chips (outside captured table cells)
      walkStructuralElementsForDropdowns(tab.body?.content, (dropdown) => {
        if (isDropdownCaptured(dropdown)) return;
        const props = dropdown.dropdownProperties;
        const def = props?.dropdownDefinitionId
          ? dropdownDefs[props.dropdownDefinitionId]
          : undefined;
        const label = normalizeStaticSingleLineLabel(def?.dropdownDefinitionProperties?.title);
        if (label === undefined) return;
        markDropdownCaptured(dropdown);
        widgetCount += 1;
        const displayText = resolveDropdownDisplayText(dropdown, dropdownDefs);
        if (!isUnsetDropdownOption(def, props?.selectedOptionId, displayText)) {
          const trimmedVal = displayText.trim();
          if (!fieldMap.has(label) && !ambiguousSet.has(label)) {
            fieldMap.set(label, trimmedVal);
          }
        }
      });
    }

    const fields: Record<string, GoogleDocsFormFieldValue> = {};
    for (const [key, value] of fieldMap.entries()) {
      Object.defineProperty(fields, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }

    return {
      widgetCount,
      fields,
      ...(ambiguousSet.size > 0 ? { ambiguousFields: [...ambiguousSet] } : {}),
    };
  }

  private getDocs(options?: DocsOperationOptions): docs_v1.Docs {
    const credential = options?.accessToken ?? options?.auth;
    if (credential) {
      if (typeof credential === 'string') {
        return this.createDocsClientFromToken(credential);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return google.docs({ version: 'v1', auth: credential as any });
    }
    return this.defaultDocs;
  }

  private wrapApiError(methodName: string, error: unknown): never {
    if (error instanceof GoogleDocsApiError) {
      throw error;
    }
    const statusCode = extractHttpStatusCode(error);
    const message = `Google Docs API error in ${methodName}: ${formatErrorMessage(error)}`;

    if (statusCode === 404) {
      throw new GoogleDocsNotFoundError(message, { cause: error, statusCode: 404 });
    }

    throw new GoogleDocsApiError(message, { cause: error, statusCode });
  }

  async extractDocumentFormFields(
    documentId: string,
    options?: DocsOperationOptions
  ): Promise<GoogleDocsFormExtractResult> {
    const docs = this.getDocs(options);
    const timeout = options?.requestTimeoutMs ?? this.defaultRequestTimeoutMs;

    let response: { data: unknown };
    try {
      response = await docs.documents.get(
        {
          documentId,
          includeTabsContent: true,
          suggestionsViewMode: 'PREVIEW_WITHOUT_SUGGESTIONS',
        },
        { timeout }
      );
    } catch (error) {
      this.wrapApiError('extractDocumentFormFields', error);
    }

    return this.extractFormData(response.data);
  }
}
