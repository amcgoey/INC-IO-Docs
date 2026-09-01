import { describe, it, expect, vi } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { PdfProcessor } from './pdf-processor';
import {
  PdfCorruptedError,
  PdfEncryptionError,
  PdfOutOfBoundsError,
} from './errors';

describe('PdfProcessor', () => {
  const processor = new PdfProcessor();

  async function createSamplePdf(pageCount: number): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    for (let i = 0; i < pageCount; i++) {
      const page = doc.addPage([200, 200]);
      page.drawText(`Page ${i + 1}`);
    }
    return await doc.save();
  }

  describe('extractPages', () => {
    it('throws PdfCorruptedError when given malformed or invalid buffer', async () => {
      const invalidBuffer = new Uint8Array([0, 1, 2, 3, 4, 5]);
      await expect(processor.extractPages(invalidBuffer, [1])).rejects.toThrow(
        PdfCorruptedError
      );
    });

    it('throws PdfEncryptionError when given an encrypted PDF', async () => {
      // Simulate encrypted PDF loading error from pdf-lib
      const loadSpy = vi.spyOn(PDFDocument, 'load').mockRejectedValueOnce(
        new Error('Input document is encrypted')
      );

      const buffer = new Uint8Array([37, 80, 68, 70]); // %PDF
      await expect(processor.extractPages(buffer, [1])).rejects.toThrow(
        PdfEncryptionError
      );

      loadSpy.mockRestore();
    });

    it('throws PdfOutOfBoundsError when requesting page number 0 or negative', async () => {
      const pdfBuffer = await createSamplePdf(3);

      await expect(processor.extractPages(pdfBuffer, [0])).rejects.toThrow(
        PdfOutOfBoundsError
      );
      await expect(processor.extractPages(pdfBuffer, [-1])).rejects.toThrow(
        PdfOutOfBoundsError
      );
    });

    it('throws PdfOutOfBoundsError when requesting non-integer page number', async () => {
      const pdfBuffer = await createSamplePdf(3);

      await expect(processor.extractPages(pdfBuffer, [1.5])).rejects.toThrow(
        PdfOutOfBoundsError
      );
    });

    it('throws PdfOutOfBoundsError when requesting page beyond document length', async () => {
      const pdfBuffer = await createSamplePdf(3);

      await expect(processor.extractPages(pdfBuffer, [4])).rejects.toThrow(
        PdfOutOfBoundsError
      );
      await expect(processor.extractPages(pdfBuffer, [1, 5])).rejects.toThrow(
        PdfOutOfBoundsError
      );
    });

    it('extracts a single page (1-indexed) into a new PDF', async () => {
      const pdfBuffer = await createSamplePdf(3);

      const extracted = await processor.extractPages(pdfBuffer, [2]);
      const extractedDoc = await PDFDocument.load(extracted);

      expect(extractedDoc.getPageCount()).toBe(1);
    });

    it('extracts multiple pages in requested order into a new PDF', async () => {
      const pdfBuffer = await createSamplePdf(4);

      const extracted = await processor.extractPages(pdfBuffer, [3, 1]);
      const extractedDoc = await PDFDocument.load(extracted);

      expect(extractedDoc.getPageCount()).toBe(2);
    });

    it('handles extracting all pages', async () => {
      const pdfBuffer = await createSamplePdf(2);

      const extracted = await processor.extractPages(pdfBuffer, [1, 2]);
      const extractedDoc = await PDFDocument.load(extracted);

      expect(extractedDoc.getPageCount()).toBe(2);
    });
  });
});
