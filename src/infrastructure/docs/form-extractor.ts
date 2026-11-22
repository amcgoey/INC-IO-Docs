import { Value } from '@sinclair/typebox/value';
import {
  GoogleDocsDocumentSchema,
  type GoogleDocsDocument,
  type GoogleDocsDocumentTab,
  type GoogleDocsFormExtractResult,
  type GoogleDocsFormFieldValue,
  type GoogleDocsStructuralElement,
  type GoogleDocsTab,
} from './types';
import { GoogleDocsCorruptedError } from './errors';

const SMART_CHIP_PLACEHOLDER_CHAR = '\ue907';
const SMART_CHIP_PLACEHOLDER_REGEX = /\ue907/g;
const MAX_PLAUSIBLE_LABEL_LENGTH = 40;

const PURE_HANDLEBARS_PLACEHOLDER_REGEX = /^(?:\{\{[^{}]*\}\}[\s\-_./]*)+$/;
const DIVIDER_PUNCTUATION_REGEX = /^[–—-]+$/;
const ISO_DATE_PREFIX_REGEX = /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}/;
const SLASH_OR_DASH_DATE_PREFIX_REGEX = /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}/;
const MONTH_NAME_ALTERNATION =
  '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WRITTEN_MONTH_DATE_REGEX = new RegExp(
  `^(?:${MONTH_NAME_ALTERNATION}\\.?\\s+\\d{1,2}(?:st|nd|rd|th)?(?:\\s*,\\s*|\\s+)\\d{2,4}|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH_NAME_ALTERNATION}\\.?(?:\\s*,\\s*|\\s+)\\d{2,4})$`,
  'i'
);
const SIX_DIGIT_PREFIX_CODE_REGEX = /^\d{6}/;
const ALPHA_NUMERIC_CODE_PREFIX_REGEX = /^[A-Za-z]{2}\s*\d{3}/;
const PURE_NUMERIC_REGEX = /^\d+$/;
const PURE_ALPHABETIC_CAPTION_REGEX = /^[A-Za-z][A-Za-z\s/&'-]*$/;

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

function normalizeFormLabelKey(raw: string): string {
  return raw.replace(/\s+/g, ' ').trim().replace(/[.:]+$/, '').trim();
}

function isPlausibleFieldLabel(key: string): boolean {
  return (
    key.length >= 1 &&
    key.length <= MAX_PLAUSIBLE_LABEL_LENGTH &&
    !PURE_HANDLEBARS_PLACEHOLDER_REGEX.test(key) &&
    !DIVIDER_PUNCTUATION_REGEX.test(key)
  );
}

function normalizeStaticSingleLineLabel(raw: string | null | undefined): string | undefined {
  if (raw === null || raw === undefined) return undefined;
  if (raw.includes(SMART_CHIP_PLACEHOLDER_CHAR) || /[\r\n]/.test(raw)) return undefined;
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

function isDateLikeText(text: string): boolean {
  return (
    ISO_DATE_PREFIX_REGEX.test(text) ||
    SLASH_OR_DASH_DATE_PREFIX_REGEX.test(text) ||
    WRITTEN_MONTH_DATE_REGEX.test(text)
  );
}

function isStructuredCodeText(text: string): boolean {
  return SIX_DIGIT_PREFIX_CODE_REGEX.test(text) || ALPHA_NUMERIC_CODE_PREFIX_REGEX.test(text);
}

function extractStaticSingleLineParagraphText(paragraph: GoogleDocsParagraph): string | undefined {
  let rawParaText = '';
  for (const pe of paragraph.elements ?? []) {
    if (pe.dropdown || pe.dateElement || pe.person) {
      return undefined;
    }
    if (pe.textRun?.content) {
      if (pe.textRun.content.includes(SMART_CHIP_PLACEHOLDER_CHAR)) {
        return undefined;
      }
      rawParaText += pe.textRun.content;
    }
  }

  const strippedPara = rawParaText.replace(/\n$/, '');
  if (/[\r\n]/.test(strippedPara)) {
    return undefined;
  }
  return strippedPara;
}

function extractRawStaticSingleLineText(cell: GoogleDocsTableCell): string | undefined {
  const content = cell.content ?? [];
  if (content.length !== 1 || !content[0]?.paragraph) {
    return undefined;
  }

  const paraText = extractStaticSingleLineParagraphText(content[0].paragraph);
  return paraText !== undefined ? paraText.trim() : undefined;
}

function extractStaticLabel(cell: GoogleDocsTableCell): string | undefined {
  return normalizeStaticSingleLineLabel(extractRawStaticSingleLineText(cell));
}

function formatDateElement(
  dateElement: NonNullable<GoogleDocsParagraphElement['dateElement']>
): string | undefined {
  const props = dateElement.dateElementProperties;
  const rawTimestamp = props?.timestamp;
  if (rawTimestamp) {
    const d = new Date(rawTimestamp);
    if (!Number.isNaN(d.getTime())) {
      const timeZone = props?.timeZoneId || 'UTC';
      try {
        const parts = new Intl.DateTimeFormat('en-CA', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).formatToParts(d);
        const y = parts.find((p) => p.type === 'year')?.value;
        const m = parts.find((p) => p.type === 'month')?.value;
        const day = parts.find((p) => p.type === 'day')?.value;
        if (y && m && day) {
          return `${y}-${m}-${day}`;
        }
      } catch {
        // Unrecognized timeZoneId -> fall back to UTC ISO date
      }
      return d.toISOString().slice(0, 10);
    }
  }
  const fallback = props?.displayText?.replace(SMART_CHIP_PLACEHOLDER_REGEX, '').trim();
  return fallback || undefined;
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
      } else if (pe.dateElement) {
        const formatted = formatDateElement(pe.dateElement);
        if (formatted) {
          paraStr += formatted;
        }
      } else if (pe.person) {
        const personName = pe.person.personProperties?.name?.trim();
        const personEmail = pe.person.personProperties?.email?.trim();
        paraStr += personName || personEmail || '';
      } else if (pe.textRun?.content) {
        paraStr += pe.textRun.content.replace(SMART_CHIP_PLACEHOLDER_REGEX, '').replace(/\n$/, '');
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
  const strippedPara = extractStaticSingleLineParagraphText(paragraph);
  if (strippedPara === undefined) {
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
        if (pe.textRun.content.includes(SMART_CHIP_PLACEHOLDER_CHAR)) {
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
  checkboxCell: GoogleDocsTableCell;
}

function parseCheckboxOptionTable(
  rows: GoogleDocsTableRow[],
  dropdownDefs: Record<string, GoogleDocsDropdownDefinition>
): ParsedCheckboxOptionRow[] | undefined {
  const optionRows: ParsedCheckboxOptionRow[] = [];
  let hasExplicitMarkerOrDropdown = false;

  for (const row of rows) {
    const cells = row.tableCells ?? [];
    const checkboxCell = cells[0];
    if (!checkboxCell) return undefined;

    if ((checkboxCell.tableCellStyle?.columnSpan ?? 1) > 1) {
      // Ignore full-row merged disclaimer banners
      continue;
    }

    const optionLabelCell = cells[1];
    if (
      !optionLabelCell ||
      (checkboxCell.tableCellStyle?.columnSpan ?? 1) !== 1 ||
      (checkboxCell.tableCellStyle?.rowSpan ?? 1) !== 1 ||
      (optionLabelCell.tableCellStyle?.columnSpan ?? 1) !== 1
    ) {
      return undefined;
    }

    const optionLabel = extractStaticLabel(optionLabelCell);
    if (optionLabel === undefined) return undefined;

    const classification = classifyCheckboxCell(checkboxCell, dropdownDefs);
    if (classification.state === 'not_checkbox') return undefined;

    if (classification.hasExplicitMarkerOrDropdown) {
      hasExplicitMarkerOrDropdown = true;
    }
    optionRows.push({ state: classification.state, optionLabel, checkboxCell });
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

function cellContainsSmartChipOrDatePlaceholder(cell: GoogleDocsTableCell): boolean {
  for (const contentEl of cell.content ?? []) {
    if (contentEl.paragraph) {
      for (const pe of contentEl.paragraph.elements ?? []) {
        if (pe.dateElement || pe.person || pe.dropdown) {
          return true;
        }
        if (pe.textRun?.content?.includes(SMART_CHIP_PLACEHOLDER_CHAR)) {
          return true;
        }
      }
    } else if (contentEl.table) {
      for (const row of contentEl.table.tableRows ?? []) {
        for (const nestedCell of row.tableCells ?? []) {
          if (cellContainsSmartChipOrDatePlaceholder(nestedCell)) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

interface ParsedBottomCaptionColumn {
  label: string;
  valueCell: GoogleDocsTableCell;
  value: string | undefined;
}

function parseBottomCaptionTable(
  rows: GoogleDocsTableRow[],
  colCount: number,
  dropdownDefs: Record<string, GoogleDocsDropdownDefinition>
): ParsedBottomCaptionColumn[] | undefined {
  const row0Cells = rows[0]?.tableCells ?? [];
  const row1Cells = rows[1]?.tableCells ?? [];
  if (row0Cells.length !== colCount || row1Cells.length !== colCount) {
    return undefined;
  }

  for (let c = 0; c < colCount; c++) {
    if (!isUnmergedCell(row0Cells[c]) || !isUnmergedCell(row1Cells[c])) {
      return undefined;
    }
  }

  const row1Labels: string[] = [];
  const row1RawTexts: string[] = [];
  for (let c = 0; c < colCount; c++) {
    const rawText = extractRawStaticSingleLineText(row1Cells[c]!);
    if (rawText === undefined) return undefined;
    const label = normalizeStaticSingleLineLabel(rawText);
    if (label === undefined) return undefined;
    if (isDateLikeText(label) || isStructuredCodeText(label) || PURE_NUMERIC_REGEX.test(label)) {
      return undefined;
    }
    row1Labels.push(label);
    row1RawTexts.push(rawText);
  }

  const row0Values: Array<string | undefined> = [];
  let hasExplicitValueSignal = false;
  let hasDateOrCodeValue = false;

  for (let c = 0; c < colCount; c++) {
    const valueCell = row0Cells[c]!;
    const val = serializeCellElements(valueCell, dropdownDefs);
    row0Values.push(val);

    if (
      val === undefined ||
      cellContainsSmartChipOrDatePlaceholder(valueCell) ||
      val.includes('\n') ||
      val.length > MAX_PLAUSIBLE_LABEL_LENGTH
    ) {
      hasExplicitValueSignal = true;
    } else if (isDateLikeText(val) || isStructuredCodeText(val)) {
      hasDateOrCodeValue = true;
    }
  }

  const allRow1PureAlphabetic = row1RawTexts.every((raw) => PURE_ALPHABETIC_CAPTION_REGEX.test(raw));
  if (!hasExplicitValueSignal && !(hasDateOrCodeValue && allRow1PureAlphabetic)) {
    return undefined;
  }

  return row1Labels.map((label, c) => ({
    label,
    valueCell: row0Cells[c]!,
    value: row0Values[c],
  }));
}

function setFieldIfUnclaimed(
  fieldMap: Map<string, GoogleDocsFormFieldValue>,
  ambiguousSet: ReadonlySet<string>,
  label: string,
  value: GoogleDocsFormFieldValue | undefined
): void {
  if (value !== undefined && !fieldMap.has(label) && !ambiguousSet.has(label)) {
    fieldMap.set(label, value);
  }
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

function extractFormDataValidated(document: unknown): GoogleDocsFormExtractResult {
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
            markCellDropdownsCaptured(optRow.checkboxCell);
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

      // Pattern 2: 2 x 1 Stacked Field Box (e.g. "REMARKS")
      if (rowCount === 2 && colCount === 1) {
        const r0Cells = rows[0]?.tableCells ?? [];
        const r1Cells = rows[1]?.tableCells ?? [];
        if (
          r0Cells.length === 1 &&
          r1Cells.length === 1 &&
          isUnmergedCell(r0Cells[0]) &&
          isUnmergedCell(r1Cells[0])
        ) {
          const label = extractStaticLabel(r0Cells[0]);
          if (label !== undefined) {
            widgetCount += 1;
            markCellDropdownsCaptured(r1Cells[0]);
            setFieldIfUnclaimed(
              fieldMap,
              ambiguousSet,
              label,
              serializeCellElements(r1Cells[0], dropdownDefs)
            );
            continue;
          }
        }
      }

      // Pattern 3: 2 x N Signature / Bottom-Caption Table (e.g. 2x2 "Reviewed By | Date")
      if (rowCount === 2 && colCount >= 2) {
        const parsedCols = parseBottomCaptionTable(rows, colCount, dropdownDefs);
        if (parsedCols) {
          for (const { label, valueCell, value } of parsedCols) {
            widgetCount += 1;
            markCellDropdownsCaptured(valueCell);
            setFieldIfUnclaimed(fieldMap, ambiguousSet, label, value);
          }
          continue;
        }
      }

      // Pattern 4: N x 2 Key/Value Form Tables (e.g. 1x2 "Field Label | Value")
      if (colCount === 2 && rowCount >= 1) {
        const parsedRows = parseKeyValueTable(rows);
        if (parsedRows) {
          for (const { label, valueCell } of parsedRows) {
            widgetCount += 1;
            markCellDropdownsCaptured(valueCell);
            setFieldIfUnclaimed(
              fieldMap,
              ambiguousSet,
              label,
              serializeCellElements(valueCell, dropdownDefs)
            );
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
        setFieldIfUnclaimed(fieldMap, ambiguousSet, label, displayText.trim());
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

export function extractGoogleDocsFormData(document: unknown): GoogleDocsFormExtractResult {
  try {
    return extractFormDataValidated(document);
  } catch (error) {
    if (error instanceof GoogleDocsCorruptedError) {
      throw error;
    }
    if (error instanceof TypeError || error instanceof RangeError) {
      throw new GoogleDocsCorruptedError(
        `Malformed Google Docs document structure: ${error.message}`,
        { cause: error }
      );
    }
    throw error;
  }
}
