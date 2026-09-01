import { PDFDocument, EncryptedPDFError } from 'pdf-lib';
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
   * - Throws {@link PdfOutOfBoundsError} if any page number is `<= 0`, non-integer, or exceeds the document's total page count.
   * - Throws {@link PdfCorruptedError} if the input buffer is malformed or invalid.
   * - Throws {@link PdfEncryptionError} if the PDF document is encrypted or password-protected.
   *
   * @param buffer - The raw binary `Uint8Array` of the source PDF.
   * @param pages - An array of 1-indexed page numbers to extract (e.g. `[1, 2]`).
   * @returns A promise that resolves to a `Uint8Array` containing the newly formed PDF.
   */
  async extractPages(buffer: Uint8Array, pages: number[]): Promise<Uint8Array> {
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

      if (pages.length > 0) {
        // Convert 1-indexed page numbers to 0-indexed indices for pdf-lib
        const pageIndices = pages.map((p) => p - 1);
        const copiedPages = await targetDoc.copyPages(srcDoc, pageIndices);
        for (const copiedPage of copiedPages) {
          targetDoc.addPage(copiedPage);
        }
      }

      return await targetDoc.save();
    } catch (error: unknown) {
      if (error instanceof PdfProcessorError) {
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
}
