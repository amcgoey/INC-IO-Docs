import { describe, it, expect, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
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

    it('throws PdfOutOfBoundsError when page list is empty', async () => {
      const pdfBuffer = await createSamplePdf(2);

      await expect(processor.extractPages(pdfBuffer, [])).rejects.toThrow(
        PdfOutOfBoundsError
      );
    });

    it('handles extracting all pages', async () => {
      const pdfBuffer = await createSamplePdf(2);

      const extracted = await processor.extractPages(pdfBuffer, [1, 2]);
      const extractedDoc = await PDFDocument.load(extracted);

      expect(extractedDoc.getPageCount()).toBe(2);
    });
  });

  describe('mergeDocuments', () => {
    it('throws PdfCorruptedError when buffer array is empty', async () => {
      await expect(processor.mergeDocuments([])).rejects.toThrow(
        PdfCorruptedError
      );
    });

    it('throws PdfCorruptedError when any input buffer is corrupted or invalid', async () => {
      const validBuffer = await createSamplePdf(2);
      const invalidBuffer = new Uint8Array([0, 1, 2, 3, 4, 5]);

      await expect(
        processor.mergeDocuments([validBuffer, invalidBuffer])
      ).rejects.toThrow(PdfCorruptedError);
    });

    it('throws PdfEncryptionError when any input document is encrypted', async () => {
      const loadSpy = vi.spyOn(PDFDocument, 'load').mockRejectedValueOnce(
        new Error('Input document is encrypted')
      );

      const validBuffer = await createSamplePdf(2);
      const encryptedBuffer = new Uint8Array([37, 80, 68, 70]); // %PDF

      await expect(
        processor.mergeDocuments([encryptedBuffer, validBuffer])
      ).rejects.toThrow(PdfEncryptionError);

      loadSpy.mockRestore();
    });

    it('throws PdfEncryptionError when a subsequent document in the array is encrypted', async () => {
      const validDoc = await createSamplePdf(1);
      const encryptedBuffer = new Uint8Array([37, 80, 68, 70]);

      const originalLoad = PDFDocument.load.bind(PDFDocument);
      const loadSpy = vi.spyOn(PDFDocument, 'load');
      loadSpy.mockImplementationOnce((buffer, options) => originalLoad(buffer, options));
      loadSpy.mockRejectedValueOnce(new Error('Input document is encrypted'));

      await expect(
        processor.mergeDocuments([validDoc, encryptedBuffer])
      ).rejects.toThrow(PdfEncryptionError);

      loadSpy.mockRestore();
    });

    it('merges multiple PDF documents in sequence into a single PDF', async () => {
      const doc1 = await createSamplePdf(2);
      const doc2 = await createSamplePdf(3);
      const doc3 = await createSamplePdf(1);

      const merged = await processor.mergeDocuments([doc1, doc2, doc3]);
      const mergedDoc = await PDFDocument.load(merged);

      expect(mergedDoc.getPageCount()).toBe(6);
    });

    it('merges a single PDF document returning a valid combined PDF', async () => {
      const doc = await createSamplePdf(4);

      const merged = await processor.mergeDocuments([doc]);
      const mergedDoc = await PDFDocument.load(merged);

      expect(mergedDoc.getPageCount()).toBe(4);
    });
  });

  describe('extractFormData', () => {
    it('throws PdfCorruptedError when given malformed or invalid buffer', async () => {
      const invalidBuffer = new Uint8Array([0, 1, 2, 3, 4, 5]);
      await expect(processor.extractFormData(invalidBuffer)).rejects.toThrow(
        PdfCorruptedError
      );
    });

    it('throws PdfEncryptionError when given an encrypted PDF', async () => {
      const loadSpy = vi.spyOn(PDFDocument, 'load').mockRejectedValueOnce(
        new Error('Input document is encrypted')
      );

      const buffer = new Uint8Array([37, 80, 68, 70]); // %PDF
      await expect(processor.extractFormData(buffer)).rejects.toThrow(
        PdfEncryptionError
      );

      loadSpy.mockRestore();
    });

    it('returns an empty record when the PDF contains no form fields', async () => {
      const plainPdf = await createSamplePdf(2);
      const data = await processor.extractFormData(plainPdf);

      expect(data).toEqual({});
    });

    it('extracts text fields, check boxes, radio groups, dropdowns, and option lists with raw keys', async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([400, 600]);
      const form = doc.getForm();

      const textField = form.createTextField('raw.user.name');
      textField.setText('Alice Smith');
      textField.addToPage(page, { x: 50, y: 500, width: 200, height: 30 });

      const emptyTextField = form.createTextField('raw.user.notes');
      emptyTextField.addToPage(page, { x: 50, y: 450, width: 200, height: 30 });

      const checkedBox = form.createCheckBox('raw.agreement.terms');
      checkedBox.check();
      checkedBox.addToPage(page, { x: 50, y: 400, width: 20, height: 20 });

      const uncheckedBox = form.createCheckBox('raw.agreement.marketing');
      uncheckedBox.addToPage(page, { x: 50, y: 360, width: 20, height: 20 });

      const radioGroup = form.createRadioGroup('raw.contact.channel');
      radioGroup.addOptionToPage('Email', page, { x: 50, y: 320, width: 20, height: 20 });
      radioGroup.addOptionToPage('Phone', page, { x: 100, y: 320, width: 20, height: 20 });
      radioGroup.select('Email');

      const unselectedRadio = form.createRadioGroup('raw.priority.level');
      unselectedRadio.addOptionToPage('Low', page, { x: 50, y: 280, width: 20, height: 20 });
      unselectedRadio.addOptionToPage('High', page, { x: 100, y: 280, width: 20, height: 20 });

      const dropdown = form.createDropdown('raw.location.country');
      dropdown.setOptions(['US', 'CA', 'GB']);
      dropdown.select('CA');
      dropdown.addToPage(page, { x: 50, y: 240, width: 100, height: 20 });

      const optionList = form.createOptionList('raw.roles.assigned');
      optionList.setOptions(['Admin', 'Reviewer', 'Editor']);
      optionList.select('Editor');
      optionList.addToPage(page, { x: 50, y: 180, width: 100, height: 50 });

      const pdfBytes = await doc.save();
      const extracted = await processor.extractFormData(pdfBytes);

      expect(extracted).toEqual({
        'raw.user.name': 'Alice Smith',
        'raw.user.notes': undefined,
        'raw.agreement.terms': true,
        'raw.agreement.marketing': false,
        'raw.contact.channel': 'Email',
        'raw.priority.level': undefined,
        'raw.location.country': ['CA'],
        'raw.roles.assigned': ['Editor'],
      });
    });

    it('does not alter or perform domain mapping on raw keys', async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([300, 300]);
      const form = doc.getForm();

      const field1 = form.createTextField('COMPLEX_Field__Name[0].SubField');
      field1.setText('TestValue');
      field1.addToPage(page, { x: 50, y: 200, width: 100, height: 20 });

      const pdfBytes = await doc.save();
      const extracted = await processor.extractFormData(pdfBytes);

      expect(Object.keys(extracted)).toEqual(['COMPLEX_Field__Name[0].SubField']);
      expect(extracted['COMPLEX_Field__Name[0].SubField']).toBe('TestValue');
    });
  });

  describe('processFormSubmission', () => {
    it('throws PdfCorruptedError when given malformed or invalid buffer', async () => {
      const invalidBuffer = new Uint8Array([0, 1, 2, 3, 4, 5]);
      await expect(
        processor.processFormSubmission(invalidBuffer, { 'user.name': 'Alice' })
      ).rejects.toThrow(PdfCorruptedError);
    });

    it('throws PdfEncryptionError when given an encrypted PDF', async () => {
      const loadSpy = vi.spyOn(PDFDocument, 'load').mockRejectedValueOnce(
        new Error('Input document is encrypted')
      );

      const buffer = new Uint8Array([37, 80, 68, 70]); // %PDF
      await expect(
        processor.processFormSubmission(buffer, { 'user.name': 'Alice' })
      ).rejects.toThrow(PdfEncryptionError);

      loadSpy.mockRestore();
    });

    it('populates text fields, check boxes, radio groups, dropdowns, and option lists', async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([400, 600]);
      const form = doc.getForm();

      const textField = form.createTextField('user.name');
      textField.addToPage(page, { x: 50, y: 500, width: 200, height: 30 });

      const termsCheck = form.createCheckBox('agree.terms');
      termsCheck.addToPage(page, { x: 50, y: 450, width: 20, height: 20 });

      const optOutCheck = form.createCheckBox('agree.optout');
      optOutCheck.check();
      optOutCheck.addToPage(page, { x: 50, y: 400, width: 20, height: 20 });

      const channelRadio = form.createRadioGroup('contact.channel');
      channelRadio.addOptionToPage('Email', page, { x: 50, y: 350, width: 20, height: 20 });
      channelRadio.addOptionToPage('Phone', page, { x: 100, y: 350, width: 20, height: 20 });

      const countryDropdown = form.createDropdown('location.country');
      countryDropdown.setOptions(['US', 'CA', 'GB']);
      countryDropdown.addToPage(page, { x: 50, y: 300, width: 100, height: 20 });

      const rolesList = form.createOptionList('user.roles');
      rolesList.setOptions(['Admin', 'Reviewer', 'Editor']);
      rolesList.addToPage(page, { x: 50, y: 220, width: 100, height: 60 });

      const originalBytes = await doc.save();

      const submissionData = {
        'user.name': 'Bob Vance',
        'agree.terms': true,
        'agree.optout': false,
        'contact.channel': 'Phone',
        'location.country': 'CA',
        'user.roles': ['Admin', 'Editor'],
      };

      const resultBytes = await processor.processFormSubmission(
        originalBytes,
        submissionData
      );

      // Verify populated data can be extracted back
      const extracted = await processor.extractFormData(resultBytes);

      expect(extracted).toEqual({
        'user.name': 'Bob Vance',
        'agree.terms': true,
        'agree.optout': false,
        'contact.channel': 'Phone',
        'location.country': ['CA'],
        'user.roles': ['Admin', 'Editor'],
      });
    });

    it('strictly does NOT flatten the document so interactivity is preserved', async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([300, 300]);
      const form = doc.getForm();

      const textField = form.createTextField('interactive.field');
      textField.addToPage(page, { x: 50, y: 200, width: 100, height: 20 });

      const originalBytes = await doc.save();
      const filledBytes = await processor.processFormSubmission(originalBytes, {
        'interactive.field': 'Editable Text',
      });

      // Reload and inspect the AcroForm directly
      const filledDoc = await PDFDocument.load(filledBytes);
      const filledForm = filledDoc.getForm();
      const fields = filledForm.getFields();

      // If flattened, getFields() would be empty (0 fields)
      expect(fields.length).toBe(1);
      expect(fields[0].getName()).toBe('interactive.field');
      expect(filledForm.getTextField('interactive.field').getText()).toBe(
        'Editable Text'
      );
    });

    it('handles font fallback using Helvetica for appearance streams', async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([300, 300]);
      const form = doc.getForm();

      const textField = form.createTextField('custom.field');
      textField.addToPage(page, { x: 50, y: 200, width: 100, height: 20 });

      const originalBytes = await doc.save();

      // Filling and saving without flattening must succeed and generate valid appearance streams
      const filledBytes = await processor.processFormSubmission(originalBytes, {
        'custom.field': 'Fallback Font Content',
      });

      expect(filledBytes).toBeInstanceOf(Uint8Array);
      expect(filledBytes.length).toBeGreaterThan(0);

      const extracted = await processor.extractFormData(filledBytes);
      expect(extracted['custom.field']).toBe('Fallback Font Content');
    });

    it('gracefully ignores form data keys that do not exist in the document', async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([300, 300]);
      const form = doc.getForm();

      const textField = form.createTextField('existing.field');
      textField.addToPage(page, { x: 50, y: 200, width: 100, height: 20 });

      const originalBytes = await doc.save();
      const filledBytes = await processor.processFormSubmission(originalBytes, {
        'existing.field': 'Valid',
        'nonexistent.field': 'Ignore Me',
      });

      const extracted = await processor.extractFormData(filledBytes);
      expect(extracted).toEqual({
        'existing.field': 'Valid',
      });
    });

    it('handles empty formData without error', async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([300, 300]);
      const form = doc.getForm();

      const textField = form.createTextField('test.field');
      textField.setText('Original Value');
      textField.addToPage(page, { x: 50, y: 200, width: 100, height: 20 });

      const originalBytes = await doc.save();
      const resultBytes = await processor.processFormSubmission(
        originalBytes,
        {}
      );

      const extracted = await processor.extractFormData(resultBytes);
      expect(extracted).toEqual({
        'test.field': 'Original Value',
      });
    });

    it('populates numbers and handles string/number boolean coercion for checkboxes and text fields', async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([300, 300]);
      const form = doc.getForm();

      const ageField = form.createTextField('user.age');
      ageField.addToPage(page, { x: 50, y: 200, width: 100, height: 20 });

      const check1 = form.createCheckBox('check.one');
      check1.addToPage(page, { x: 50, y: 150, width: 20, height: 20 });

      const check2 = form.createCheckBox('check.two');
      check2.check();
      check2.addToPage(page, { x: 50, y: 120, width: 20, height: 20 });

      const check3 = form.createCheckBox('check.three');
      check3.addToPage(page, { x: 50, y: 90, width: 20, height: 20 });

      const originalBytes = await doc.save();
      const filledBytes = await processor.processFormSubmission(originalBytes, {
        'user.age': 42,
        'check.one': 'yes',
        'check.two': 0,
        'check.three': 1,
      });

      const extracted = await processor.extractFormData(filledBytes);
      expect(extracted).toEqual({
        'user.age': '42',
        'check.one': true,
        'check.two': false,
        'check.three': true,
      });
    });
  });

  describe('extractTextFromPages', () => {
    it('throws PdfCorruptedError when given malformed or invalid buffer', async () => {
      const invalidBuffer = new Uint8Array([0, 1, 2, 3, 4, 5]);
      await expect(
        processor.extractTextFromPages(invalidBuffer, [1])
      ).rejects.toThrow(PdfCorruptedError);
    });

    it('throws PdfEncryptionError when given an encrypted PDF', async () => {
      const loadSpy = vi.spyOn(PDFDocument, 'load').mockRejectedValueOnce(
        new Error('Input document is encrypted')
      );

      const buffer = new Uint8Array([37, 80, 68, 70]); // %PDF
      await expect(
        processor.extractTextFromPages(buffer, [1])
      ).rejects.toThrow(PdfEncryptionError);

      loadSpy.mockRestore();
    });

    it('throws PdfOutOfBoundsError when requesting page number 0 or negative', async () => {
      const pdfBuffer = await createSamplePdf(3);

      await expect(
        processor.extractTextFromPages(pdfBuffer, [0])
      ).rejects.toThrow(PdfOutOfBoundsError);
      await expect(
        processor.extractTextFromPages(pdfBuffer, [-1])
      ).rejects.toThrow(PdfOutOfBoundsError);
    });

    it('throws PdfOutOfBoundsError when requesting non-integer page number', async () => {
      const pdfBuffer = await createSamplePdf(3);

      await expect(
        processor.extractTextFromPages(pdfBuffer, [1.5])
      ).rejects.toThrow(PdfOutOfBoundsError);
    });

    it('throws PdfOutOfBoundsError when requesting page beyond document length', async () => {
      const pdfBuffer = await createSamplePdf(3);

      await expect(
        processor.extractTextFromPages(pdfBuffer, [4])
      ).rejects.toThrow(PdfOutOfBoundsError);
      await expect(
        processor.extractTextFromPages(pdfBuffer, [1, 5])
      ).rejects.toThrow(PdfOutOfBoundsError);
    });

    it('throws PdfOutOfBoundsError when page list is empty', async () => {
      const pdfBuffer = await createSamplePdf(2);

      await expect(
        processor.extractTextFromPages(pdfBuffer, [])
      ).rejects.toThrow(PdfOutOfBoundsError);
    });

    it('extracts text from a single page (1-indexed)', async () => {
      const pdfBuffer = await createSamplePdf(3);

      const text = await processor.extractTextFromPages(pdfBuffer, [2]);
      expect(text).toBe('Page 2');
    });

    it('extracts and joins text across multiple pages in the requested sequence', async () => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const p1 = doc.addPage([400, 400]);
      p1.drawText('First Page Paragraph', { x: 50, y: 350, font, size: 12 });
      const p2 = doc.addPage([400, 400]);
      p2.drawText('Second Page Paragraph', { x: 50, y: 350, font, size: 12 });
      const p3 = doc.addPage([400, 400]);
      p3.drawText('Third Page Paragraph', { x: 50, y: 350, font, size: 12 });
      const pdfBytes = await doc.save();

      const text = await processor.extractTextFromPages(pdfBytes, [3, 1]);
      expect(text).toBe('Third Page Paragraph\nFirst Page Paragraph');
    });

    it('returns an empty string when the extracted page contains no text', async () => {
      const doc = await PDFDocument.create();
      doc.addPage([200, 200]); // Blank page
      const pdfBytes = await doc.save();

      const text = await processor.extractTextFromPages(pdfBytes, [1]);
      expect(text).toBe('');
    });

    it('strictly does not extract interactive AcroForm widget values (static stream only)', async () => {
      const doc = await PDFDocument.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const page = doc.addPage([400, 400]);
      page.drawText('Static Document Header', { x: 50, y: 350, font, size: 12 });

      const form = doc.getForm();
      const textField = form.createTextField('user.interactive');
      textField.setText('Unflattened Form Input');
      textField.addToPage(page, { x: 50, y: 150, width: 150, height: 20 });

      const pdfBytes = await doc.save();

      const text = await processor.extractTextFromPages(pdfBytes, [1]);
      expect(text).toContain('Static Document Header');
      expect(text).not.toContain('Unflattened Form Input');
    });

    it('translates unpdf parsing failures into PdfCorruptedError', async () => {
      const validBuffer = await createSamplePdf(1);
      const extractPagesSpy = vi
        .spyOn(processor, 'extractPages')
        .mockResolvedValueOnce(new Uint8Array([1, 2, 3]));

      await expect(
        processor.extractTextFromPages(validBuffer, [1])
      ).rejects.toThrow(PdfCorruptedError);

      extractPagesSpy.mockRestore();
    });
  });
});

