import {
  PDFDocument,
  EncryptedPDFError,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
  StandardFonts,
} from 'pdf-lib';
import {
  PdfCorruptedError,
  PdfEncryptionError,
  PdfOutOfBoundsError,
  PdfProcessorError,
} from './errors';

export class PdfProcessor {
  /**
   * Safely loads a PDF document from an in-memory Uint8Array buffer,
   * translating any third-party parsing errors into standardized domain errors.
   *
   * @throws {@link PdfEncryptionError} if the PDF is password-protected or encrypted.
   * @throws {@link PdfCorruptedError} if the PDF buffer is malformed or corrupted.
   */
  private async loadPdfDocument(buffer: Uint8Array): Promise<PDFDocument> {
    try {
      return await PDFDocument.load(buffer);
    } catch (error: unknown) {
      if (
        error instanceof EncryptedPDFError ||
        (error instanceof Error && /encrypted|password/i.test(error.message))
      ) {
        throw new PdfEncryptionError(
          'PDF document is encrypted and password-protected',
          { cause: error }
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

      return await targetDoc.save();
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
   * Merges multiple PDF documents into a single PDF document in the sequence provided.
   *
   * @remarks
   * **Error Handling:**
   * - Throws {@link PdfCorruptedError} if `buffers` is empty or if any input buffer is malformed or invalid.
   * - Throws {@link PdfEncryptionError} if any PDF document is encrypted or password-protected.
   *
   * @param buffers - An array of raw binary `Uint8Array` PDF buffers to concatenate.
   * @returns A promise that resolves to a `Uint8Array` containing the combined PDF.
   */
  async mergeDocuments(buffers: Uint8Array[]): Promise<Uint8Array> {
    if (buffers.length === 0) {
      throw new PdfCorruptedError(
        'Cannot merge an empty array of PDF buffers: at least one PDF buffer is required'
      );
    }

    try {
      const targetDoc = await PDFDocument.create();

      for (const buffer of buffers) {
        const srcDoc = await this.loadPdfDocument(buffer);
        const pageIndices = srcDoc.getPageIndices();
        const copiedPages = await targetDoc.copyPages(srcDoc, pageIndices);
        for (const copiedPage of copiedPages) {
          targetDoc.addPage(copiedPage);
        }
      }

      return await targetDoc.save();
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
          data[name] = field.getSelected();
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
    formData: Record<string, string | number | boolean | string[] | undefined | null>
  ): Promise<Uint8Array> {
    try {
      const srcDoc = await this.loadPdfDocument(buffer);
      const form = srcDoc.getForm();

      for (const [name, value] of Object.entries(formData)) {
        if (value === undefined || value === null) {
          continue;
        }

        const field = form.getFieldMaybe(name);
        if (!field) {
          continue;
        }

        if (field instanceof PDFTextField) {
          field.setText(typeof value === 'string' ? value : String(value));
        } else if (field instanceof PDFCheckBox) {
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
          if (typeof value === 'string') {
            field.select(value);
          }
        } else if (
          field instanceof PDFDropdown ||
          field instanceof PDFOptionList
        ) {
          if (typeof value === 'string' || Array.isArray(value)) {
            field.select(value);
          }
        }
      }

      const fallbackFont = await srcDoc.embedFont(StandardFonts.Helvetica);
      form.updateFieldAppearances(fallbackFont);

      return await srcDoc.save();
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
}

