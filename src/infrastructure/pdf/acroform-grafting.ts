import {
  ExceededMaxLengthError,
  PDFAcroForm,
  PDFAcroNonTerminal,
  PDFAcroSignature,
  PDFAcroTerminal,
  PDFArray,
  PDFCheckBox,
  PDFDict,
  PDFDocument,
  PDFDropdown,
  PDFField,
  PDFFont,
  PDFName,
  PDFObject,
  PDFObjectCopier,
  PDFOptionList,
  PDFPage,
  PDFPageLeaf,
  PDFRadioGroup,
  PDFRef,
  PDFSignature,
  PDFTextField,
  StandardFonts,
  defaultDropdownAppearanceProvider,
  defaultOptionListAppearanceProvider,
} from 'pdf-lib';
import { PdfFormFieldError, PdfUnsupportedFormError, type PdfSourceRole } from './errors';
import type {
  PdfFormData,
  PdfTargetAcroFormPolicy,
  PdfXfaPolicy,
} from './types';
import { sanitizeWinAnsiText } from './winansi';

const DA_FONT_REGEX = /\/([^\0\t\n\f\r ]+)[\0\t\n\f\r ]*(?:\d*\.\d+|\d+)?[\0\t\n\f\r ]+Tf/g;

export const FAST_SAVE_OBJECTS_PER_TICK = 1500;

function isWidgetDict(dict: PDFDict): boolean {
  return (
    dict.get(PDFName.of('Subtype')) === PDFName.of('Widget') ||
    dict.has(PDFName.of('Rect'))
  );
}

/**
 * Counts interactive widget annotations across AcroForm fields and page `/Annots`
 * without calling `doc.getForm()` (which would mutate the catalog).
 */
function countDocumentWidgets(doc: PDFDocument, acroForm: PDFAcroForm): number {
  let count = 0;
  const visitedRefs = new Set<PDFRef>();

  const visitDict = (dict: PDFDict, ref?: PDFRef): void => {
    if (ref) {
      if (visitedRefs.has(ref)) return;
      visitedRefs.add(ref);
    }

    const kids = dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (kids && kids.size() > 0) {
      for (let i = 0; i < kids.size(); i++) {
        const kidRef = kids.get(i);
        const kidDict = kids.lookupMaybe(i, PDFDict);
        if (kidDict) {
          visitDict(kidDict, kidRef instanceof PDFRef ? kidRef : undefined);
        }
      }
      return;
    }

    if (isWidgetDict(dict)) {
      count++;
    }
  };

  for (const [field, ref] of acroForm.getFields()) {
    visitDict(field.dict, ref);
  }

  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annotDict = annots.lookupMaybe(i, PDFDict);
      if (annotDict && annotDict.get(PDFName.of('Subtype')) === PDFName.of('Widget')) {
        count++;
      }
    }
  }

  return count;
}

/**
 * Inspects `Catalog.AcroForm` for `/XFA` before calling `doc.getForm()`.
 * - Rejects XFA unconditionally when `rejectAnyXfa` is true (cover-sheet templates or `xfaPolicy: 'error'`).
 * - Always rejects pure XFA (`hasXFA` with empty `/Fields` and zero widgets) with `PdfUnsupportedFormError`.
 * - Allows hybrid XFA fallback when `xfaPolicy === 'fallbackHybrid'` by disconnecting `/XFA`.
 */
export function precheckAndHandleXfa(
  doc: PDFDocument,
  options: {
    rejectAnyXfa: boolean;
    xfaPolicy: PdfXfaPolicy;
    roleLabel: string;
    sourceRole?: PdfSourceRole | undefined;
  }
): void {
  const acroForm = doc.catalog.getAcroForm();
  if (!acroForm) return;

  const hasXfa = acroForm.dict.has(PDFName.of('XFA'));
  if (!hasXfa) return;

  if (options.rejectAnyXfa || options.xfaPolicy === 'error') {
    throw new PdfUnsupportedFormError(
      `${options.roleLabel} contains XFA form data, which is not supported`,
      { reason: 'xfa', sourceRole: options.sourceRole }
    );
  }

  const fields = acroForm.Fields();
  const hasFields = fields !== undefined && fields.size() > 0;
  const widgetCount = countDocumentWidgets(doc, acroForm);
  if (!hasFields && widgetCount === 0) {
    throw new PdfUnsupportedFormError(
      `${options.roleLabel} uses pure XFA form data without AcroForm fields`,
      { reason: 'xfa', sourceRole: options.sourceRole }
    );
  }

  // Hybrid XFA fallback: strip /XFA so PDF viewers render AcroForm fields.
  acroForm.dict.delete(PDFName.of('XFA'));
}

function isSignedSignatureDict(
  context: PDFDocument['context'],
  candidate: unknown
): boolean {
  const dict = candidate instanceof PDFRef ? context.lookupMaybe(candidate, PDFDict) : candidate;
  if (!(dict instanceof PDFDict)) return false;
  return dict.has(PDFName.of('ByteRange')) && dict.has(PDFName.of('Contents'));
}

function hasSignatureDictValue(
  context: PDFDocument['context'],
  dict: PDFDict
): boolean {
  const ft = context.lookupMaybe(dict.get(PDFName.of('FT')), PDFName);
  if (ft === PDFName.of('Sig')) {
    return isSignedSignatureDict(context, dict.get(PDFName.of('V')));
  }
  return false;
}

/**
 * Detects whether the PDF contains an active cryptographic signature
 * (`/FT /Sig` with a `/V` signature dictionary containing `ByteRange` and `Contents`,
 * or catalog `/Perms` signature references). Unsigned `/FT /Sig` boxes return `false`.
 */
export function hasActiveCryptographicSignature(doc: PDFDocument): boolean {
  const perms = doc.catalog.lookupMaybe(PDFName.of('Perms'), PDFDict);
  if (perms) {
    for (const [, value] of perms.entries()) {
      if (isSignedSignatureDict(doc.context, value)) {
        return true;
      }
    }
  }

  const acroForm = doc.catalog.getAcroForm();
  if (acroForm) {
    for (const [field] of acroForm.getAllFields()) {
      if (
        (field instanceof PDFAcroSignature &&
          isSignedSignatureDict(doc.context, field.V())) ||
        hasSignatureDictValue(doc.context, field.dict)
      ) {
        return true;
      }
      if (field instanceof PDFAcroTerminal) {
        for (const widget of field.getWidgets()) {
          if (hasSignatureDictValue(doc.context, widget.dict)) {
            return true;
          }
        }
      }
    }
  }

  for (const page of doc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const annotDict = annots.lookupMaybe(i, PDFDict);
      if (annotDict && hasSignatureDictValue(doc.context, annotDict)) {
        return true;
      }
    }
  }

  return false;
}

function getOrCreateAcroFormDrFontDict(acroForm: PDFAcroForm): PDFDict {
  const { context } = acroForm.dict;
  let dr = acroForm.dict.lookupMaybe(PDFName.of('DR'), PDFDict);
  if (!dr) {
    dr = context.obj({});
    acroForm.dict.set(PDFName.of('DR'), dr);
  }
  let fontDict = dr.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!fontDict) {
    fontDict = context.obj({});
    dr.set(PDFName.of('Font'), fontDict);
  }
  return fontDict;
}

function collectDaFontNames(acroForm: PDFAcroForm): Set<string> {
  const fontNames = new Set<string>();
  const scanDa = (da: string | undefined) => {
    if (!da) return;
    DA_FONT_REGEX.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DA_FONT_REGEX.exec(da)) !== null) {
      if (match[1]) fontNames.add(match[1]);
    }
  };

  const formDa = acroForm.dict.get(PDFName.of('DA'));
  if (formDa && 'decodeText' in formDa && typeof formDa.decodeText === 'function') {
    scanDa(formDa.decodeText());
  } else if (formDa && 'asString' in formDa && typeof formDa.asString === 'function') {
    scanDa(formDa.asString());
  }

  for (const [field] of acroForm.getAllFields()) {
    scanDa(field.getDefaultAppearance());
    if (field instanceof PDFAcroTerminal) {
      for (const widget of field.getWidgets()) {
        scanDa(widget.getDefaultAppearance());
      }
    }
  }

  return fontNames;
}

/**
 * Ensures `/AcroForm/DR/Font` contains the embedded fallback Helvetica font and
 * resolves every font name referenced in `/DA` strings across the AcroForm.
 */
export async function ensureAcroFormDrFont(
  doc: PDFDocument,
  acroForm: PDFAcroForm,
  existingFallbackFont?: PDFFont
): Promise<PDFFont | undefined> {
  const missingDaFonts: string[] = [];
  const existingDr = acroForm.dict.lookupMaybe(PDFName.of('DR'), PDFDict);
  const existingFontDict = existingDr?.lookupMaybe(PDFName.of('Font'), PDFDict);

  for (const daFontName of collectDaFontNames(acroForm)) {
    const key = PDFName.of(daFontName);
    if (!existingFontDict?.has(key)) {
      missingDaFonts.push(daFontName);
    }
  }

  if (!existingFallbackFont && missingDaFonts.length === 0) {
    return undefined;
  }

  const drFont = getOrCreateAcroFormDrFontDict(acroForm);
  const fallbackFont =
    existingFallbackFont ?? (await doc.embedFont(StandardFonts.Helvetica));

  drFont.set(PDFName.of(fallbackFont.name), fallbackFont.ref);

  for (const daFontName of missingDaFonts) {
    drFont.set(PDFName.of(daFontName), fallbackFont.ref);
  }

  return fallbackFont;
}

function applyChoiceFieldValue(
  field: PDFDropdown | PDFOptionList,
  name: string,
  value: string | string[]
): void {
  const optionsArr = Array.isArray(value) ? value : [value];
  const validOptions = field.getOptions();

  for (const opt of optionsArr) {
    if (!validOptions.includes(opt)) {
      throw new PdfFormFieldError(
        `Invalid option "${opt}" for choice field "${name}"`,
        { fieldName: name }
      );
    }
  }

  if (optionsArr.length === 0) {
    field.clear();
    return;
  }

  field.select(optionsArr);
}

function updateDirtyFieldAppearance(field: PDFField, fallbackFont: PDFFont): void {
  if (field instanceof PDFSignature) {
    return;
  }

  if (field instanceof PDFDropdown) {
    try {
      field.defaultUpdateAppearances(fallbackFont);
    } catch {
      field.updateAppearances(fallbackFont, (dropdown, widget, font) => {
        const originalGetSelected = dropdown.getSelected.bind(dropdown);
        const selected = originalGetSelected();
        dropdown.getSelected = () => selected.map(sanitizeWinAnsiText);
        try {
          return defaultDropdownAppearanceProvider(dropdown, widget, font);
        } finally {
          dropdown.getSelected = originalGetSelected;
        }
      });
    }
    return;
  }

  if (field instanceof PDFOptionList) {
    try {
      field.defaultUpdateAppearances(fallbackFont);
    } catch {
      field.updateAppearances(fallbackFont, (optionList, widget, font) => {
        const originalGetOptions = optionList.getOptions.bind(optionList);
        const originalGetSelected = optionList.getSelected.bind(optionList);
        const options = originalGetOptions();
        const selected = originalGetSelected();
        optionList.getOptions = () => options.map(sanitizeWinAnsiText);
        optionList.getSelected = () => selected.map(sanitizeWinAnsiText);
        try {
          return defaultOptionListAppearanceProvider(optionList, widget, font);
        } finally {
          optionList.getOptions = originalGetOptions;
          optionList.getSelected = originalGetSelected;
        }
      });
    }
    return;
  }

  if (field.needsAppearancesUpdate()) {
    field.defaultUpdateAppearances(fallbackFont);
  }
}

/**
 * Populates interactive form fields without flattening, validates choice options
 * before WinAnsi sanitization, regenerates appearances ONLY on dirty fields,
 * registers `/AcroForm/DR/Font`, and clears `/NeedAppearances`.
 */
export async function populateFormFields(
  doc: PDFDocument,
  formData: PdfFormData
): Promise<void> {
  const form = doc.getForm();
  const acroForm = form.acroForm;

  for (const [name, value] of Object.entries(formData)) {
    if (value === undefined || value === null) {
      continue;
    }

    const field = form.getFieldMaybe(name);
    if (!field) {
      continue;
    }

    if (field instanceof PDFTextField) {
      if (Array.isArray(value)) {
        throw new PdfFormFieldError(
          `Expected scalar value for text field "${name}", received array`,
          { fieldName: name }
        );
      }
      const rawText = typeof value === 'string' ? value : String(value);
      const sanitized = sanitizeWinAnsiText(rawText);
      const maxLength = field.getMaxLength();
      if (maxLength !== undefined && sanitized.length > maxLength) {
        throw new PdfFormFieldError(
          `Attempted to set text with length=${sanitized.length} for TextField with maxLength=${maxLength} and name=${name}`,
          { fieldName: name }
        );
      }
      try {
        field.setText(sanitized);
      } catch (error: unknown) {
        if (
          error instanceof ExceededMaxLengthError ||
          (error instanceof Error &&
            /TextField with maxLength=/i.test(error.message))
        ) {
          throw new PdfFormFieldError(error.message, {
            fieldName: name,
            cause: error,
          });
        }
        throw error;
      }
    } else if (field instanceof PDFCheckBox) {
      if (Array.isArray(value)) {
        throw new PdfFormFieldError(
          `Expected scalar value for checkbox "${name}", received array`,
          { fieldName: name }
        );
      }
      let shouldCheck = false;
      if (typeof value === 'boolean') {
        shouldCheck = value;
      } else if (typeof value === 'string') {
        shouldCheck = ['true', 'yes', '1'].includes(value.toLowerCase());
      } else if (typeof value === 'number') {
        shouldCheck = value !== 0;
      }

      if (shouldCheck) {
        field.check();
      } else {
        field.uncheck();
      }
    } else if (field instanceof PDFRadioGroup) {
      if (typeof value !== 'string') {
        throw new PdfFormFieldError(
          `Expected string option for radio group "${name}"`,
          { fieldName: name }
        );
      }
      if (!field.getOptions().includes(value)) {
        throw new PdfFormFieldError(
          `Invalid option "${value}" for radio group "${name}"`,
          { fieldName: name }
        );
      }
      field.select(value);
    } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      if (typeof value !== 'string' && !Array.isArray(value)) {
        throw new PdfFormFieldError(
          `Expected string or string[] option for choice field "${name}"`,
          { fieldName: name }
        );
      }
      applyChoiceFieldValue(field, name, value);
    }
  }

  const dirtyFields = form
    .getFields()
    .filter((field) => form.fieldIsDirty(field.ref));

  let fallbackFont: PDFFont | undefined;
  if (dirtyFields.length > 0) {
    fallbackFont = await doc.embedFont(StandardFonts.Helvetica);
    await ensureAcroFormDrFont(doc, acroForm, fallbackFont);
    for (const field of dirtyFields) {
      updateDirtyFieldAppearance(field, fallbackFont);
    }
  }

  await ensureAcroFormDrFont(doc, acroForm, fallbackFont);
  acroForm.dict.delete(PDFName.of('NeedAppearances'));
}

/**
 * Strips target AcroForm metadata and widget annotations without flattening.
 */
function stripTargetAcroForm(targetDoc: PDFDocument): void {
  for (const page of targetDoc.getPages()) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const annotDict = annots.lookupMaybe(i, PDFDict);
      if (annotDict && annotDict.get(PDFName.of('Subtype')) === PDFName.of('Widget')) {
        annots.remove(i);
      }
    }
    if (annots.size() === 0) {
      page.node.delete(PDFName.of('Annots'));
    }
  }
  targetDoc.catalog.delete(PDFName.of('AcroForm'));
}

function collectSelectedPageAnnotRefs(srcPages: PDFPage[]): Set<PDFRef> {
  const annotRefs = new Set<PDFRef>();
  for (const page of srcPages) {
    const annots = page.node.Annots();
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      if (ref instanceof PDFRef) {
        annotRefs.add(ref);
      }
    }
  }
  return annotRefs;
}

/**
 * Prunes `srcAcroForm` `/Fields`, hierarchical `/Kids`, and `/CO` in-place on the
 * ephemeral `srcDoc` so only fields and widgets belonging to `selectedPages` remain.
 * This prevents `PDFObjectCopier` from pulling unselected pages in via `/Kids` or `/P`.
 */
function pruneSrcAcroFormToSelectedPages(
  srcDoc: PDFDocument,
  srcAcroForm: PDFAcroForm,
  selectedPages: PDFPage[]
): Set<PDFRef> {
  const selectedPageRefs = new Set(selectedPages.map((p) => p.ref));
  const selectedAnnotRefs = collectSelectedPageAnnotRefs(selectedPages);
  const survivingFieldRefs = new Set<PDFRef>();

  const isWidgetSelected = (widgetRef: PDFRef, widgetDict: PDFDict): boolean => {
    const pRef = widgetDict.get(PDFName.of('P'));
    if (pRef instanceof PDFRef) {
      return selectedPageRefs.has(pRef);
    }
    return selectedAnnotRefs.has(widgetRef);
  };

  const pruneFieldNode = (fieldRef: PDFRef): boolean => {
    const fieldDict = srcDoc.context.lookupMaybe(fieldRef, PDFDict);
    if (!fieldDict) return false;

    const kids = fieldDict.lookupMaybe(PDFName.of('Kids'), PDFArray);
    if (!kids) {
      // Merged field+widget
      const keep = isWidgetSelected(fieldRef, fieldDict);
      if (keep) survivingFieldRefs.add(fieldRef);
      return keep;
    }

    const keptKidRefs: PDFRef[] = [];
    for (let i = 0; i < kids.size(); i++) {
      const kidRef = kids.get(i);
      if (!(kidRef instanceof PDFRef)) continue;
      const kidDict = srcDoc.context.lookupMaybe(kidRef, PDFDict);
      if (!kidDict) continue;

      if (kidDict.has(PDFName.of('T')) || kidDict.has(PDFName.of('FT'))) {
        // Child field (non-terminal or terminal field)
        if (pruneFieldNode(kidRef)) {
          keptKidRefs.push(kidRef);
        }
      } else if (isWidgetSelected(kidRef, kidDict)) {
        keptKidRefs.push(kidRef);
      }
    }

    if (keptKidRefs.length === 0) {
      return false;
    }

    const nextKids = srcDoc.context.obj(keptKidRefs);
    fieldDict.set(PDFName.of('Kids'), nextKids);
    survivingFieldRefs.add(fieldRef);
    return true;
  };

  const fields = srcAcroForm.Fields();
  if (fields) {
    const keptRootRefs: PDFRef[] = [];
    for (let i = 0; i < fields.size(); i++) {
      const ref = fields.get(i);
      if (ref instanceof PDFRef && pruneFieldNode(ref)) {
        keptRootRefs.push(ref);
      }
    }
    srcAcroForm.dict.set(PDFName.of('Fields'), srcDoc.context.obj(keptRootRefs));
  }

  const co = srcAcroForm.dict.lookupMaybe(PDFName.of('CO'), PDFArray);
  if (co) {
    const keptCoRefs: PDFRef[] = [];
    for (let i = 0; i < co.size(); i++) {
      const ref = co.get(i);
      if (ref instanceof PDFRef && survivingFieldRefs.has(ref)) {
        keptCoRefs.push(ref);
      }
    }
    if (keptCoRefs.length > 0) {
      srcAcroForm.dict.set(PDFName.of('CO'), srcDoc.context.obj(keptCoRefs));
    } else {
      srcAcroForm.dict.delete(PDFName.of('CO'));
    }
  }

  return survivingFieldRefs;
}

function chooseUniqueNamespaceName(
  preferred: string,
  targetRootNames: Set<string>,
  srcRootNames: Set<string>
): string {
  if (!targetRootNames.has(preferred) && !srcRootNames.has(preferred)) {
    return preferred;
  }
  let suffix = 1;
  while (true) {
    const candidate = `${preferred}_${suffix}`;
    if (!targetRootNames.has(candidate) && !srcRootNames.has(candidate)) {
      return candidate;
    }
    suffix++;
  }
}

function namespaceCollidingTargetRootFields(
  targetDoc: PDFDocument,
  targetAcroForm: PDFAcroForm,
  srcRootNames: Set<string>,
  preferredNamespace: string
): void {
  const targetRootFields = targetAcroForm.getFields();
  if (targetRootFields.length === 0 || srcRootNames.size === 0) return;

  const targetRootNames = new Set<string>();
  const collidingIndices = new Set<number>();

  targetRootFields.forEach(([field], idx) => {
    const partial = field.getPartialName();
    if (partial !== undefined && partial.length > 0) {
      targetRootNames.add(partial);
      if (srcRootNames.has(partial)) {
        collidingIndices.add(idx);
      }
    }
  });

  if (collidingIndices.size === 0) return;

  const namespaceName = chooseUniqueNamespaceName(
    preferredNamespace,
    targetRootNames,
    srcRootNames
  );
  const namespaceParent = PDFAcroNonTerminal.create(targetDoc.context);
  namespaceParent.setPartialName(namespaceName);

  const nextRootRefs: PDFRef[] = [];
  let insertedNamespaceRef = false;

  targetRootFields.forEach(([field, ref], idx) => {
    if (collidingIndices.has(idx)) {
      field.setParent(namespaceParent.ref);
      namespaceParent.addField(ref);
      if (!insertedNamespaceRef) {
        nextRootRefs.push(namespaceParent.ref);
        insertedNamespaceRef = true;
      }
    } else {
      nextRootRefs.push(ref);
    }
  });

  targetAcroForm.dict.set(
    PDFName.of('Fields'),
    targetDoc.context.obj(nextRootRefs)
  );
}

function copyAcroFormResources(
  srcAcroForm: PDFAcroForm,
  targetAcroForm: PDFAcroForm,
  copier: PDFObjectCopier
): void {
  const srcDr = srcAcroForm.dict.lookupMaybe(PDFName.of('DR'), PDFDict);
  if (!srcDr) return;
  const srcFontDict = srcDr.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!srcFontDict) return;

  const targetFontDict = getOrCreateAcroFormDrFontDict(targetAcroForm);
  for (const [fontName, fontObj] of srcFontDict.entries()) {
    if (!targetFontDict.has(fontName)) {
      targetFontDict.set(fontName, copier.copy(fontObj));
    }
  }
}

export interface GraftPagesOptions {
  /** 0-based insertion index in `targetDoc`. */
  insertIndex: number;
  /** 0-based page indices in `srcDoc` to graft. */
  srcPageIndices: number[];
  targetAcroFormPolicy: PdfTargetAcroFormPolicy;
  targetFieldNamespace: string;
  clearNeedAppearances: boolean;
}

function getTraversedObjectsMap(
  copier: PDFObjectCopier
): Map<PDFObject, PDFObject> {
  const candidate = copier as unknown as {
    traversedObjects?: Map<PDFObject, PDFObject>;
  };
  if (!(candidate.traversedObjects instanceof Map)) {
    throw new Error(
      'Unsupported pdf-lib PDFObjectCopier: missing traversedObjects Map'
    );
  }
  return candidate.traversedObjects;
}

/**
 * Grafts `srcPageIndices` from `srcDoc` into `targetDoc` using one shared `PDFObjectCopier`
 * with pre-populated `traversedObjects` (`srcPage.ref -> copiedPageRef`), rewriting widget `/P`
 * references and preserving/isolating AcroForm fields without ever flattening.
 */
export async function graftPagesIntoTarget(
  targetDoc: PDFDocument,
  srcDoc: PDFDocument,
  options: GraftPagesOptions
): Promise<void> {
  if (options.targetAcroFormPolicy === 'strip') {
    stripTargetAcroForm(targetDoc);
  }

  await srcDoc.flush();

  const srcPages = srcDoc.getPages();
  const selectedPages = options.srcPageIndices.map((idx) => srcPages[idx]!);

  const srcAcroForm = srcDoc.catalog.getAcroForm();
  if (srcAcroForm) {
    pruneSrcAcroFormToSelectedPages(srcDoc, srcAcroForm, selectedPages);
  }

  const copier = PDFObjectCopier.for(srcDoc.context, targetDoc.context);
  const traversedObjects = getTraversedObjectsMap(copier);

  // Pre-populate traversedObjects with srcPage.ref -> destRef before copying pages or fields
  const pendingCopies: Array<{ srcPage: PDFPage; destRef: PDFRef }> = [];
  for (const srcPage of selectedPages) {
    const destRef = targetDoc.context.nextRef();
    traversedObjects.set(srcPage.ref, destRef);
    pendingCopies.push({ srcPage, destRef });
  }

  const copiedPagePairs: Array<{ page: PDFPage; ref: PDFRef }> = [];
  for (const { srcPage, destRef } of pendingCopies) {
    const copiedPageDict = copier.copy(srcPage.node) as PDFPageLeaf;
    targetDoc.context.assign(destRef, copiedPageDict);

    // Ensure every copied widget annotation explicitly points /P to the copied page ref
    const annots = copiedPageDict.Annots();
    if (annots) {
      for (let i = 0; i < annots.size(); i++) {
        const annotDict = annots.lookupMaybe(i, PDFDict);
        if (annotDict && annotDict.get(PDFName.of('Subtype')) === PDFName.of('Widget')) {
          annotDict.set(PDFName.of('P'), destRef);
        }
      }
    }

    copiedPagePairs.push({
      page: PDFPage.of(copiedPageDict, destRef, targetDoc),
      ref: destRef,
    });
  }

  for (let i = 0; i < copiedPagePairs.length; i++) {
    targetDoc.insertPage(options.insertIndex + i, copiedPagePairs[i]!.page);
  }

  if (!srcAcroForm) {
    return;
  }

  const srcRootFields = srcAcroForm.getFields();
  if (srcRootFields.length === 0) {
    return;
  }

  const targetAcroForm = targetDoc.catalog.getOrCreateAcroForm();

  if (options.targetAcroFormPolicy === 'namespace') {
    const srcRootNames = new Set<string>();
    for (const [field] of srcRootFields) {
      const partial = field.getPartialName();
      if (partial !== undefined && partial.length > 0) {
        srcRootNames.add(partial);
      }
    }
    namespaceCollidingTargetRootFields(
      targetDoc,
      targetAcroForm,
      srcRootNames,
      options.targetFieldNamespace
    );
  }

  for (const [, srcRef] of srcRootFields) {
    const copiedRef = copier.copy(srcRef);
    targetAcroForm.addField(copiedRef);
  }

  const srcCo = srcAcroForm.dict.lookupMaybe(PDFName.of('CO'), PDFArray);
  if (srcCo && srcCo.size() > 0) {
    let targetCo = targetAcroForm.dict.lookupMaybe(PDFName.of('CO'), PDFArray);
    if (!targetCo) {
      targetCo = targetDoc.context.obj([]);
      targetAcroForm.dict.set(PDFName.of('CO'), targetCo);
    }
    for (let i = 0; i < srcCo.size(); i++) {
      const srcCoRef = srcCo.get(i);
      const copiedCoRef = traversedObjects.get(srcCoRef);
      if (copiedCoRef instanceof PDFRef) {
        targetCo.push(copiedCoRef);
      }
    }
  }

  copyAcroFormResources(srcAcroForm, targetAcroForm, copier);
  await ensureAcroFormDrFont(targetDoc, targetAcroForm);

  if (options.clearNeedAppearances) {
    targetAcroForm.dict.delete(PDFName.of('NeedAppearances'));
  }
}
