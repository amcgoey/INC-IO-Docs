import {
  PDFDocument,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
  EncryptedPDFError,
  ParseSpeeds,
} from 'pdf-lib';
import { extractText } from 'unpdf';
import {
  PdfCorruptedError,
  PdfEncryptionError,
  PdfFileTooLargeError,
  PdfOutOfBoundsError,
  PdfProcessorError,
  PdfUnsupportedFormError,
  type PdfSourceRole,
} from './errors';
import { EmailPdfRenderer } from './email-pdf-renderer';
import type {
  EmailPdfRenderInput,
  PdfCreateDocumentFromPagesOptions,
  PdfFormData,
  PdfInsertPagesOptions,
  PdfMergeDocumentsOptions,
} from './types';
import {
  DEFAULT_MAX_IN_MEMORY_FILE_BYTES,
  resolveMaxInMemoryFileBytesFromEnv,
} from '../manifest/app-manifest-provider';
import {
  FAST_SAVE_OBJECTS_PER_TICK,
  graftPagesIntoTarget,
  hasActiveCryptographicSignature,
  populateFormFields,
  precheckAndHandleXfa,
} from './acroform-grafting';

export interface PdfProcessorOptions {
  getMaxInMemoryFileBytes?:
    | (() => Promise<number | undefined> | number | undefined)
    | undefined;
}

export class PdfProcessor {
  constructor(private readonly options?: PdfProcessorOptions) {}

  private async resolveMaxInMemoryFileBytes(): Promise<number> {
    const provided = this.options?.getMaxInMemoryFileBytes
      ? await this.options.getMaxInMemoryFileBytes()
      : undefined;
    const resolved =
      provided ??
      resolveMaxInMemoryFileBytesFromEnv() ??
      DEFAULT_MAX_IN_MEMORY_FILE_BYTES;
    if (typeof resolved !== 'number' || !Number.isFinite(resolved) || resolved <= 0) {
      throw new Error(
        `Invalid maxInMemoryFileBytes configuration "${String(resolved)}": must be a positive finite number`
      );
    }
    return resolved;
  }

  private async assertWithinByteLimit(buffers: readonly Uint8Array[]): Promise<void> {
    const maxBytes = await this.resolveMaxInMemoryFileBytes();
    let totalBytes = 0;
    for (const buffer of buffers) {
      totalBytes += buffer.byteLength;
    }
    if (totalBytes > maxBytes) {
      throw new PdfFileTooLargeError(
        `PDF cumulative payload size (${totalBytes} bytes) exceeds maximum in-memory size limit of ${maxBytes} bytes`,
        { totalBytes, maxBytes }
      );
    }
  }

  private computeEmailPayloadBytes(email: EmailPdfRenderInput): number {
    let total = 0;
    const stringFields = [
      email.subject,
      email.from,
      email.to,
      email.cc,
      email.date,
      email.plainTextBody,
      email.htmlBody,
      ...(email.attachmentNames ?? []),
    ];
    for (const value of stringFields) {
      if (typeof value === 'string') {
        total += Buffer.byteLength(value, 'utf8');
      }
    }
    for (const img of email.inlineImages ?? []) {
      total += img.data.byteLength;
    }
    return total;
  }
  /**
   * Safely loads a PDF document from an in-memory Uint8Array buffer,
   * translating any third-party parsing errors into standardized domain errors.
   *
   * @throws {@link PdfEncryptionError} if the PDF is password-protected or encrypted.
   * @throws {@link PdfCorruptedError} if the PDF buffer is malformed or corrupted.
   */
  private async loadPdfDocument(
    buffer: Uint8Array,
    sourceRole?: PdfSourceRole
  ): Promise<PDFDocument> {
    try {
      return await PDFDocument.load(buffer, { parseSpeed: ParseSpeeds.Fast });
    } catch (error: unknown) {
      if (
        error instanceof EncryptedPDFError ||
        (error instanceof Error && /encrypted|password/i.test(error.message))
      ) {
        throw new PdfEncryptionError(
          'PDF document is encrypted and password-protected',
          { sourceRole, cause: error }
        );
      }
      throw new PdfCorruptedError(
        `Failed to parse PDF document: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }

  private async savePdfDocument(doc: PDFDocument): Promise<Uint8Array> {
    return await doc.save({
      updateFieldAppearances: false,
      objectsPerTick: FAST_SAVE_OBJECTS_PER_TICK,
    });
  }

  private resolveValidatedSourcePageIndices(
    totalPages: number,
    sourcePages: number[] | undefined
  ): number[] {
    if (sourcePages === undefined) {
      if (totalPages === 0) {
        throw new PdfOutOfBoundsError(
          'Inserted PDF document contains zero pages'
        );
      }
      return Array.from({ length: totalPages }, (_, idx) => idx);
    }

    if (sourcePages.length === 0) {
      throw new PdfOutOfBoundsError(
        'At least one source page must be specified for insertion'
      );
    }

    const seen = new Set<number>();
    const indices: number[] = [];
    for (const page of sourcePages) {
      if (!Number.isInteger(page) || page < 1 || page > totalPages) {
        throw new PdfOutOfBoundsError(
          `Page ${page} is out of bounds for document with ${totalPages} total page(s). Pages must be 1-indexed integers between 1 and ${totalPages}.`
        );
      }
      if (seen.has(page)) {
        throw new PdfProcessorError(
          `Duplicate source page ${page} in sourcePages`
        );
      }
      seen.add(page);
      indices.push(page - 1);
    }
    return indices;
  }

  private resolveInsertIndex(
    targetPageCount: number,
    position: PdfInsertPagesOptions['position']
  ): number {
    if (position === undefined || position === 'start') {
      return 0;
    }
    if (position === 'end') {
      return targetPageCount;
    }
    if (
      !Number.isInteger(position) ||
      position < 0 ||
      position > targetPageCount
    ) {
      throw new PdfOutOfBoundsError(
        `Insert position ${position} is out of bounds for target document with ${targetPageCount} page(s). Expected 'start', 'end', or integer between 0 and ${targetPageCount}.`
      );
    }
    return position;
  }

  /**
   * Extracts specific pages from a source PDF buffer and returns a new PDF buffer
   * containing only those pages in the specified order.
   *
   * @remarks
   * **Page Indexing Convention:**
   * This method uses **1-indexed** page numbers. For example:
   * - `pages: [1]` extracts the first page.
   * - `pages: [1, 3]` extracts the first and third pages.
   * - `pages: [3, 1]` extracts the third and first pages in that exact sequence.
   *
   * **Error Handling:**
   * - Throws {@link PdfOutOfBoundsError} if `pages` is empty, or any page number is `<= 0`, non-integer, or exceeds the document's total page count.
   * - Throws {@link PdfCorruptedError} if the input buffer is malformed or invalid.
   * - Throws {@link PdfEncryptionError} if the PDF document is encrypted or password-protected.
   *
   * @param buffer - The raw binary `Uint8Array` of the source PDF.
   * @param pages - An array of 1-indexed page numbers to extract (e.g. `[1, 2]`).
   * @returns A promise that resolves to a `Uint8Array` containing the newly formed PDF.
   */
  async extractPages(buffer: Uint8Array, pages: number[]): Promise<Uint8Array> {
    await this.assertWithinByteLimit([buffer]);

    if (pages.length === 0) {
      throw new PdfOutOfBoundsError(
        'At least one page must be specified for extraction'
      );
    }

    try {
      const srcDoc = await this.loadPdfDocument(buffer);
      const totalPages = srcDoc.getPageCount();

      // Validate 1-indexed page numbers against document bounds
      for (const page of pages) {
        if (!Number.isInteger(page) || page < 1 || page > totalPages) {
          throw new PdfOutOfBoundsError(
            `Page ${page} is out of bounds for document with ${totalPages} total page(s). Pages must be 1-indexed integers between 1 and ${totalPages}.`
          );
        }
      }

      const targetDoc = await PDFDocument.create();
      const pageIndices = pages.map((p) => p - 1);
      const copiedPages = await targetDoc.copyPages(srcDoc, pageIndices);
      for (const copiedPage of copiedPages) {
        targetDoc.addPage(copiedPage);
      }

      return await this.savePdfDocument(targetDoc);
    } catch (error: unknown) {
      if (
        error instanceof PdfProcessorError ||
        error instanceof TypeError ||
        error instanceof RangeError
      ) {
        throw error;
      }
      throw new PdfCorruptedError(
        `Failed to extract pages: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }

  /**
   * Inserts selected pages from `insertBuffer` into `targetBuffer` (opened as the base
   * `PDFDocument` to preserve target outlines, links, metadata, and existing content)
   * without ever flattening any AcroForm fields.
   *
   * @throws {@link PdfFileTooLargeError} if cumulative bytes exceed `maxInMemoryFileBytes`.
   * @throws {@link PdfEncryptionError} if either document is encrypted.
   * @throws {@link PdfUnsupportedFormError} if `insertBuffer` uses XFA, `targetBuffer` uses pure XFA (or hybrid under `'error'`), or `targetBuffer` is cryptographically signed.
   * @throws {@link PdfOutOfBoundsError} if `sourcePages` or numeric `position` is out of bounds.
   * @throws {@link PdfFormFieldError} if `formData` contains an invalid choice option or exceeds `maxLength`.
   * @throws {@link PdfCorruptedError} if either buffer is malformed.
   */
  async insertPages(
    targetBuffer: Uint8Array,
    insertBuffer: Uint8Array,
    options?: PdfInsertPagesOptions
  ): Promise<Uint8Array> {
    await this.assertWithinByteLimit([targetBuffer, insertBuffer]);

    const xfaPolicy = options?.xfaPolicy ?? 'fallbackHybrid';
    const targetAcroFormPolicy = options?.targetAcroFormPolicy ?? 'namespace';
    const targetFieldNamespace = options?.targetFieldNamespace ?? '__target';

    try {
      const insertDoc = await this.loadPdfDocument(insertBuffer, 'insert');

      precheckAndHandleXfa(insertDoc, {
        rejectAnyXfa: true,
        xfaPolicy: 'error',
        roleLabel: 'Inserted PDF',
        sourceRole: 'insert',
      });

      const srcPageIndices = this.resolveValidatedSourcePageIndices(
        insertDoc.getPageCount(),
        options?.sourcePages
      );

      const targetDoc = await this.loadPdfDocument(targetBuffer, 'target');

      if (hasActiveCryptographicSignature(targetDoc)) {
        throw new PdfUnsupportedFormError(
          'Target PDF is cryptographically signed and cannot be modified',
          { reason: 'signed', sourceRole: 'target' }
        );
      }

      precheckAndHandleXfa(targetDoc, {
        rejectAnyXfa: false,
        xfaPolicy,
        roleLabel: 'Target PDF',
        sourceRole: 'target',
      });

      const insertIndex = this.resolveInsertIndex(
        targetDoc.getPageCount(),
        options?.position
      );

      if (options?.formData && insertDoc.catalog.getAcroForm()) {
        await populateFormFields(insertDoc, options.formData);
      }

      await graftPagesIntoTarget(targetDoc, insertDoc, {
        insertIndex,
        srcPageIndices,
        targetAcroFormPolicy,
        targetFieldNamespace,
        clearNeedAppearances: options?.formData !== undefined,
      });

      return await this.savePdfDocument(targetDoc);
    } catch (error: unknown) {
      if (
        error instanceof PdfProcessorError ||
        error instanceof TypeError ||
        error instanceof RangeError
      ) {
        throw error;
      }
      throw new PdfCorruptedError(
        `Failed to insert pages: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }

  /**
   * Creates a standalone editable AcroForm-preserving PDF from `sourceBuffer`
   * (optionally filtered to 1-indexed `sourcePages` and populated with `formData`)
   * without flattening any fields.
   */
  async createDocumentFromPages(
    sourceBuffer: Uint8Array,
    options?: PdfCreateDocumentFromPagesOptions
  ): Promise<Uint8Array> {
    await this.assertWithinByteLimit([sourceBuffer]);

    try {
      const sourceDoc = await this.loadPdfDocument(sourceBuffer, 'insert');

      precheckAndHandleXfa(sourceDoc, {
        rejectAnyXfa: true,
        xfaPolicy: 'error',
        roleLabel: 'Inserted PDF',
        sourceRole: 'insert',
      });

      const srcPageIndices = this.resolveValidatedSourcePageIndices(
        sourceDoc.getPageCount(),
        options?.sourcePages
      );

      if (options?.formData && sourceDoc.catalog.getAcroForm()) {
        await populateFormFields(sourceDoc, options.formData);
      }

      const outDoc = await PDFDocument.create();
      await graftPagesIntoTarget(outDoc, sourceDoc, {
        insertIndex: 0,
        srcPageIndices,
        targetAcroFormPolicy: 'namespace',
        targetFieldNamespace: '__target',
        clearNeedAppearances: options?.formData !== undefined,
      });

      return await this.savePdfDocument(outDoc);
    } catch (error: unknown) {
      if (
        error instanceof PdfProcessorError ||
        error instanceof TypeError ||
        error instanceof RangeError
      ) {
        throw error;
      }
      throw new PdfCorruptedError(
        `Failed to create PDF from pages: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }

  /**
   * Merges multiple PDF documents into a single PDF document in the sequence provided,
   * preserving AcroForm fields without flattening via shared `PDFObjectCopier` and
   * `"namespace"` (or `"strip"`) collision isolation.
   *
   * @remarks
   * **Error Handling:**
   * - Throws {@link PdfCorruptedError} if `buffers` is empty or if any input buffer is malformed or invalid.
   * - Throws {@link PdfEncryptionError} if any PDF document is encrypted or password-protected.
   *
   * @param buffers - An array of raw binary `Uint8Array` PDF buffers to concatenate.
   * @param options - Optional AcroForm preservation and XFA policies.
   * @returns A promise that resolves to a `Uint8Array` containing the combined PDF.
   */
  async mergeDocuments(
    buffers: Uint8Array[],
    options?: PdfMergeDocumentsOptions
  ): Promise<Uint8Array> {
    await this.assertWithinByteLimit(buffers);

    if (buffers.length === 0) {
      throw new PdfCorruptedError(
        'Cannot merge an empty array of PDF buffers: at least one PDF buffer is required'
      );
    }

    const acroFormPolicy = options?.acroFormPolicy ?? 'namespace';
    const xfaPolicy = options?.xfaPolicy ?? 'fallbackHybrid';
    const targetFieldNamespace = options?.targetFieldNamespace ?? '__target';

    try {
      const targetDoc = await PDFDocument.create();

      for (const buffer of buffers) {
        const srcDoc = await this.loadPdfDocument(buffer);
        precheckAndHandleXfa(srcDoc, {
          rejectAnyXfa: false,
          xfaPolicy,
          roleLabel: 'Merged PDF',
        });

        const srcPageIndices = srcDoc.getPageIndices();
        if (srcPageIndices.length === 0) {
          continue;
        }

        await graftPagesIntoTarget(targetDoc, srcDoc, {
          insertIndex: targetDoc.getPageCount(),
          srcPageIndices,
          targetAcroFormPolicy: acroFormPolicy,
          targetFieldNamespace,
          clearNeedAppearances: false,
        });
      }

      return await this.savePdfDocument(targetDoc);
    } catch (error: unknown) {
      if (
        error instanceof PdfProcessorError ||
        error instanceof TypeError ||
        error instanceof RangeError
      ) {
        throw error;
      }
      throw new PdfCorruptedError(
        `Failed to merge documents: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }

  /**
   * Extracts interactive form field data (AcroForm widgets) from a source PDF buffer.
   *
   * @remarks
   * **Domain Mapping:**
   * This method extracts raw internal field keys mapped to their respective values.
   * Mapping raw keys to domain models is strictly out of scope for the processor and
   * is the responsibility of higher-level domain services.
   *
   * **Field Types Supported:**
   * - Text fields (`PDFTextField`): returns `string` or `undefined` if empty.
   * - Checkboxes (`PDFCheckBox`): returns `boolean` (`true` if checked, `false` otherwise).
   * - Radio groups (`PDFRadioGroup`): returns selected option `string` or `undefined` if none selected.
   * - Dropdowns (`PDFDropdown`): returns selected options `string[]`.
   * - Option lists (`PDFOptionList`): returns selected options `string[]`.
   * - Other field types: returns `undefined`.
   *
   * **Error Handling:**
   * - Throws {@link PdfCorruptedError} if the input buffer is malformed or invalid.
   * - Throws {@link PdfEncryptionError} if the PDF document is encrypted or password-protected.
   *
   * @param buffer - The raw binary `Uint8Array` of the source PDF.
   * @returns A promise that resolves to a map of raw field names to their values.
   */
  async extractFormData(
    buffer: Uint8Array
  ): Promise<Record<string, string | boolean | string[] | undefined>> {
    await this.assertWithinByteLimit([buffer]);

    try {
      const srcDoc = await this.loadPdfDocument(buffer);
      const form = srcDoc.getForm();
      const fields = form.getFields();

      const data: Record<string, string | boolean | string[] | undefined> = {};

      for (const field of fields) {
        const name = field.getName();
        if (field instanceof PDFTextField) {
          data[name] = field.getText();
        } else if (field instanceof PDFCheckBox) {
          data[name] = field.isChecked();
        } else if (field instanceof PDFRadioGroup) {
          const selected = field.getSelected();
          // pdf-lib reads /V rather than widget /AS appearance states when /V is a valid member of getOptions().
          // Ignore stale/orphaned /V dictionary entries (e.g. /Choice10, /Choice5) that are not valid options.
          data[name] =
            selected !== undefined && field.getOptions().includes(selected)
              ? selected
              : undefined;
        } else if (
          field instanceof PDFDropdown ||
          field instanceof PDFOptionList
        ) {
          data[name] = field.getSelected();
        } else {
          data[name] = undefined;
        }
      }

      return data;
    } catch (error: unknown) {
      if (
        error instanceof PdfProcessorError ||
        error instanceof TypeError ||
        error instanceof RangeError
      ) {
        throw error;
      }
      throw new PdfCorruptedError(
        `Failed to extract form data: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }

  /**
   * Populates interactive form fields (AcroForm widgets) from a provided data map
   * without flattening the document, preserving interactivity and future markup workflows.
   * Uses standard font fallback (Helvetica) for fields missing embedded fonts.
   *
   * @remarks
   * **Interactivity & Workflows:**
   * This method strictly avoids flattening the document (`form.flatten()` is NOT called),
   * ensuring that all form fields remain editable and interactive AcroForm widgets.
   *
   * **Font Fallback:**
   * Standard Helvetica is embedded and provided to `updateFieldAppearances` so that any
   * field missing an embedded font renders properly.
   *
   * **Field Types Supported:**
   * - Text fields (`PDFTextField`): sets text value (string or string representation).
   * - Checkboxes (`PDFCheckBox`): checks if truthy / true, unchecks if falsy / false.
   * - Radio groups (`PDFRadioGroup`): selects the specified option string.
   * - Dropdowns (`PDFDropdown`): selects the specified string or array of strings.
   * - Option lists (`PDFOptionList`): selects the specified string or array of strings.
   *
   * **Error Handling:**
   * - Throws {@link PdfCorruptedError} if the input buffer is malformed or invalid.
   * - Throws {@link PdfEncryptionError} if the PDF document is encrypted or password-protected.
   *
   * @param buffer - The raw binary `Uint8Array` of the source PDF.
   * @param formData - A map of field names to values to populate into the form.
   * @returns A promise that resolves to a `Uint8Array` containing the updated interactive PDF.
   */
  async processFormSubmission(
    buffer: Uint8Array,
    formData: PdfFormData
  ): Promise<Uint8Array> {
    await this.assertWithinByteLimit([buffer]);

    try {
      const srcDoc = await this.loadPdfDocument(buffer);
      precheckAndHandleXfa(srcDoc, {
        rejectAnyXfa: false,
        xfaPolicy: 'fallbackHybrid',
        roleLabel: 'Form PDF',
      });

      await populateFormFields(srcDoc, formData);

      return await this.savePdfDocument(srcDoc);
    } catch (error: unknown) {
      if (
        error instanceof PdfProcessorError ||
        error instanceof TypeError ||
        error instanceof RangeError
      ) {
        throw error;
      }
      throw new PdfCorruptedError(
        `Failed to process form submission: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }

  /**
   * Extracts text content from specific pages of a source PDF buffer.
   *
   * @remarks
   * **Page Indexing Convention:**
   * This method uses **1-indexed** page numbers (matching `extractPages`).
   *
   * **Hybrid Technology Stack:**
   * Internally isolates the requested page subset using `pdf-lib` via `extractPages`,
   * then passes the smaller buffer to `unpdf` (`pdf.js`) to parse and return the raw string text.
   * Parsing runs synchronously on the main thread (disabling the Web Worker) with minimal overhead
   * because only the isolated page subset is parsed.
   *
   * **AcroForm Isolation:**
   * This method extracts static text content streams and strictly does not parse
   * interactive AcroForm widget values.
   *
   * **Error Handling:**
   * - Throws {@link PdfOutOfBoundsError} if `pages` is empty, or any page number is `<= 0`, non-integer, or exceeds document bounds.
   * - Throws {@link PdfCorruptedError} if the input buffer is malformed or invalid.
   * - Throws {@link PdfEncryptionError} if the PDF document is encrypted or password-protected.
   *
   * @param buffer - The raw binary `Uint8Array` of the source PDF.
   * @param pages - An array of 1-indexed page numbers to extract text from (e.g. `[1, 2]`).
   * @returns A promise that resolves to the extracted text string.
   */
  async extractTextFromPages(
    buffer: Uint8Array,
    pages: number[]
  ): Promise<string> {
    try {
      const subsetBuffer = await this.extractPages(buffer, pages);
      const { text } = await extractText(subsetBuffer, { mergePages: true });
      return text;
    } catch (error: unknown) {
      if (
        error instanceof PdfProcessorError ||
        error instanceof TypeError ||
        error instanceof RangeError
      ) {
        throw error;
      }
      throw new PdfCorruptedError(
        `Failed to extract text from PDF pages: ${
          error instanceof Error ? error.message : String(error)
        }`,
        { cause: error }
      );
    }
  }

  /**
   * Renders an email message payload into a standardized multi-page Letter-sized PDF.
   *
   * @param email - The email metadata, body, and attachments to render.
   * @returns A promise resolving to the binary Uint8Array of the generated PDF document.
   */
  async generateEmailPdf(email: EmailPdfRenderInput): Promise<Uint8Array> {
    const maxBytes = await this.resolveMaxInMemoryFileBytes();
    const totalBytes = this.computeEmailPayloadBytes(email);
    if (totalBytes > maxBytes) {
      throw new PdfFileTooLargeError(
        `Email PDF payload size (${totalBytes} bytes) exceeds maximum in-memory size limit of ${maxBytes} bytes`,
        { totalBytes, maxBytes }
      );
    }
    const renderer = new EmailPdfRenderer();
    const rendered = await renderer.render(email);
    if (rendered.byteLength > maxBytes) {
      throw new PdfFileTooLargeError(
        `Rendered email PDF size (${rendered.byteLength} bytes) exceeds maximum in-memory size limit of ${maxBytes} bytes`,
        { totalBytes: rendered.byteLength, maxBytes }
      );
    }
    return rendered;
  }
}


