import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  PDFArray,
  PDFDict,
  PDFDocument,
  PDFName,
  PDFPage,
  PDFRef,
  PDFString,
  StandardFonts,
} from 'pdf-lib';
import { PdfProcessor } from './pdf-processor';
import type { EmailPdfRenderInput } from './types';
import {
  PdfCorruptedError,
  PdfEncryptionError,
  PdfFileTooLargeError,
  PdfFormFieldError,
  PdfOutOfBoundsError,
  PdfProcessorError,
  PdfUnsupportedFormError,
} from './errors';
import { createAnonymizedSubmittalCoverSheetPdf } from '../../../test/fixtures/submittal-cover-sheet.fixture';

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

    it('returns undefined for PDFRadioGroup when stale /V value is not in getOptions() and returns option string for valid selection', async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([400, 400]);
      const form = doc.getForm();

      const staleChoice10Radio = form.createRadioGroup('Submittal Response');
      staleChoice10Radio.addOptionToPage('NET', page, { x: 20, y: 300, width: 15, height: 15 });
      staleChoice10Radio.addOptionToPage('NOC', page, { x: 40, y: 300, width: 15, height: 15 });
      staleChoice10Radio.addOptionToPage('RR', page, { x: 60, y: 300, width: 15, height: 15 });
      staleChoice10Radio.acroField.dict.set(PDFName.of('V'), PDFName.of('Choice10'));

      const staleChoice5Radio = form.createRadioGroup('Legacy.Status');
      staleChoice5Radio.addOptionToPage('Approved', page, { x: 20, y: 260, width: 15, height: 15 });
      staleChoice5Radio.addOptionToPage('Rejected', page, { x: 40, y: 260, width: 15, height: 15 });
      staleChoice5Radio.acroField.dict.set(PDFName.of('V'), PDFName.of('Choice5'));

      const validRadio = form.createRadioGroup('Valid.Response');
      validRadio.addOptionToPage('NET', page, { x: 20, y: 220, width: 15, height: 15 });
      validRadio.addOptionToPage('RR', page, { x: 40, y: 220, width: 15, height: 15 });
      validRadio.select('RR');

      const pdfBytes = await doc.save();
      const extracted = await processor.extractFormData(pdfBytes);

      expect(extracted['Submittal Response']).toBeUndefined();
      expect(extracted['Legacy.Status']).toBeUndefined();
      expect(extracted['Valid.Response']).toBe('RR');
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

  describe('generateEmailPdf', () => {
    it('generates a Letter-sized PDF with standard margins, headers, and footer', async () => {
      const email: EmailPdfRenderInput = {
        messageId: '<msg-123@example.com>',
        subject: 'Quarterly Financial Summary',
        from: 'alice@example.com',
        to: 'bob@example.com',
        date: '2026-10-18 10:00:00',
        plainTextBody: 'Hello Bob,\nPlease find attached the report.\nBest,\nAlice',
      };

      const pdfBytes = await processor.generateEmailPdf(email);
      expect(pdfBytes).toBeInstanceOf(Uint8Array);

      const doc = await PDFDocument.load(pdfBytes);
      expect(doc.getPageCount()).toBe(1);

      const page = doc.getPage(0);
      expect(page.getWidth()).toBe(612);
      expect(page.getHeight()).toBe(792);

      const text = await processor.extractTextFromPages(pdfBytes, [1]);
      expect(text).toContain('Message ID: <msg-123@example.com>');
      expect(text).toContain('Subject: Quarterly Financial Summary');
      expect(text).toContain('From: alice@example.com');
      expect(text).toContain('To: bob@example.com');
      expect(text).toContain('Date: 2026-10-18 10:00:00');
      expect(text).toContain('Hello Bob,');
      expect(text).toContain('Page 1 of 1');
    });

    it('falls back to (No Subject) when subject is missing, empty, or whitespace-only', async () => {
      const emailMissing: EmailPdfRenderInput = {
        messageId: 'id-1',
      };
      const textMissing = await processor.extractTextFromPages(
        await processor.generateEmailPdf(emailMissing),
        [1]
      );
      expect(textMissing).toContain('Subject: (No Subject)');

      const emailEmpty: EmailPdfRenderInput = {
        messageId: 'id-2',
        subject: '',
      };
      const textEmpty = await processor.extractTextFromPages(
        await processor.generateEmailPdf(emailEmpty),
        [1]
      );
      expect(textEmpty).toContain('Subject: (No Subject)');

      const emailWhitespace: EmailPdfRenderInput = {
        messageId: 'id-3',
        subject: '   \t  ',
      };
      const textWhitespace = await processor.extractTextFromPages(
        await processor.generateEmailPdf(emailWhitespace),
        [1]
      );
      expect(textWhitespace).toContain('Subject: (No Subject)');
    });

    it('prefers rfcMessageId over internal messageId when present', async () => {
      const email: EmailPdfRenderInput = {
        messageId: '18a123456789abcd',
        rfcMessageId: '<custom-rfc-id@domain.com>',
      };
      const text = await processor.extractTextFromPages(
        await processor.generateEmailPdf(email),
        [1]
      );
      expect(text).toContain('Message ID: <custom-rfc-id@domain.com>');
      expect(text).not.toContain('Message ID: 18a123456789abcd');
    });

    it('strictly omits Cc and Attachments when absent or empty', async () => {
      const emailWithoutOptional: EmailPdfRenderInput = {
        messageId: 'id-opt',
        subject: 'Test Subject',
        from: 'sender@example.com',
        to: 'recipient@example.com',
      };
      const textWithout = await processor.extractTextFromPages(
        await processor.generateEmailPdf(emailWithoutOptional),
        [1]
      );
      expect(textWithout).not.toContain('Cc:');
      expect(textWithout).not.toContain('Attachments:');

      const emailWithEmptyOptional: EmailPdfRenderInput = {
        messageId: 'id-empty-opt',
        subject: 'Test Subject',
        cc: '   ',
        attachmentNames: [],
      };
      const textEmpty = await processor.extractTextFromPages(
        await processor.generateEmailPdf(emailWithEmptyOptional),
        [1]
      );
      expect(textEmpty).not.toContain('Cc:');
      expect(textEmpty).not.toContain('Attachments:');
    });

    it('renders Cc and Attachments when populated', async () => {
      const email: EmailPdfRenderInput = {
        messageId: 'id-with-att',
        subject: 'Invoice & Proposal',
        cc: 'charlie@example.com, dana@example.com',
        attachmentNames: ['Invoice-101.pdf', 'Proposal.docx'],
      };
      const text = await processor.extractTextFromPages(
        await processor.generateEmailPdf(email),
        [1]
      );
      expect(text).toContain('Cc: charlie@example.com, dana@example.com');
      expect(text).toContain('Attachments: Invoice-101.pdf, Proposal.docx');
    });

    it('wraps long header values and paginates onto new Letter pages when header exceeds vertical space', async () => {
      // 100 recipients will wrap to ~55-60 lines, exceeding 1 Letter page printable height (~49 lines)
      const manyRecipients = Array.from(
        { length: 100 },
        (_, i) => `long-recipient-address-${i + 1}@enterprise-organization.com`
      ).join(', ');

      const email: EmailPdfRenderInput = {
        messageId: 'header-pagination-test',
        subject: 'Executive Board Announcement',
        to: manyRecipients,
        plainTextBody: 'Final meeting agenda follows.',
      };

      const pdfBytes = await processor.generateEmailPdf(email);
      const doc = await PDFDocument.load(pdfBytes);

      expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);

      const page1Text = await processor.extractTextFromPages(pdfBytes, [1]);
      expect(page1Text).toContain('Subject: Executive Board Announcement');
      expect(page1Text).toContain('long-recipient-address-1@enterprise-organization.com');
      expect(page1Text).toContain('Page 1 of 2');

      const page2Text = await processor.extractTextFromPages(pdfBytes, [2]);
      expect(page2Text).toContain('long-recipient-address-100@enterprise-organization.com');
      expect(page2Text).toContain('Final meeting agenda follows.');
      expect(page2Text).toContain('Page 2 of 2');
    });

    it('gracefully handles missing or empty plainTextBody rendering only header block and divider', async () => {
      const emailMissingBody: EmailPdfRenderInput = {
        messageId: 'empty-body-test-1',
        subject: 'Header Only Email',
        from: 'sender@example.com',
      };

      const pdfBytes = await processor.generateEmailPdf(emailMissingBody);
      const doc = await PDFDocument.load(pdfBytes);
      expect(doc.getPageCount()).toBe(1);

      const text = await processor.extractTextFromPages(pdfBytes, [1]);
      expect(text).toContain('Message ID: empty-body-test-1');
      expect(text).toContain('Subject: Header Only Email');
      expect(text).toContain('From: sender@example.com');
      expect(text).toContain('Page 1 of 1');

      const emailEmptyStringBody: EmailPdfRenderInput = {
        messageId: 'empty-body-test-2',
        subject: 'Empty String Body Email',
        plainTextBody: '',
      };

      const pdfBytes2 = await processor.generateEmailPdf(emailEmptyStringBody);
      const doc2 = await PDFDocument.load(pdfBytes2);
      expect(doc2.getPageCount()).toBe(1);

      const text2 = await processor.extractTextFromPages(pdfBytes2, [1]);
      expect(text2).toContain('Subject: Empty String Body Email');
      expect(text2).toContain('Page 1 of 1');
    });

    it('breaks single words wider than 512 pt printable width across lines without error', async () => {
      // 150 consecutive characters without spaces is ~1050 pt wide (> 2x 512 pt)
      const unbrokenToken = 'X'.repeat(150);
      const email: EmailPdfRenderInput = {
        messageId: 'unbroken-word-test',
        subject: 'Long Token Email',
        plainTextBody: `Start token: ${unbrokenToken} End token`,
      };

      const pdfBytes = await processor.generateEmailPdf(email);
      const doc = await PDFDocument.load(pdfBytes);
      expect(doc.getPageCount()).toBe(1);

      const text = await processor.extractTextFromPages(pdfBytes, [1]);
      expect(text).toContain('Start token:');
      expect(text).toContain('End token');
      // All 150 Xs should be present in the extracted text
      expect(text).toContain('X'.repeat(50));
    });

    it('paginates body content across multiple pages with accurate Page X of Y footers', async () => {
      // 120 body lines will span across ~3 pages
      const lines = Array.from(
        { length: 120 },
        (_, i) => `Paragraph line ${i + 1}: The quick brown fox jumps over the lazy dog.`
      );

      const email: EmailPdfRenderInput = {
        messageId: 'multi-page-body-test',
        subject: 'Multi-Page Body Email',
        plainTextBody: lines.join('\n'),
      };

      const pdfBytes = await processor.generateEmailPdf(email);
      const doc = await PDFDocument.load(pdfBytes);
      const totalPages = doc.getPageCount();

      expect(totalPages).toBeGreaterThanOrEqual(3);

      const page1Text = await processor.extractTextFromPages(pdfBytes, [1]);
      expect(page1Text).toContain('Subject: Multi-Page Body Email');
      expect(page1Text).toContain('Paragraph line 1:');
      expect(page1Text).toContain(`Page 1 of ${totalPages}`);

      const lastPageText = await processor.extractTextFromPages(pdfBytes, [totalPages]);
      expect(lastPageText).toContain('Paragraph line 120:');
      expect(lastPageText).toContain(`Page ${totalPages} of ${totalPages}`);
    });

    it('sanitizes Unicode typographical characters, CRLF line endings, and tabs without throwing', async () => {
      const email: EmailPdfRenderInput = {
        messageId: 'unicode-sanitization-test',
        subject: 'Meeting Notes: “Project Alpha” – Q3 & Q4…',
        plainTextBody:
          'Notes:\r\n\t• Alice said: ‘Ready’\r\n\t• Em dash: 2025—2026\r\n\t• Special chars: © and ™\r\n\t• Zero\u200BWidth\uFEFFSpace\r\n\t• Emojis 🚀 and foreign text 漢字 are safely escaped.',
      };

      const pdfBytes = await processor.generateEmailPdf(email);
      expect(pdfBytes).toBeInstanceOf(Uint8Array);

      const text = await processor.extractTextFromPages(pdfBytes, [1]);
      expect(text).toContain('Meeting Notes: "Project Alpha" - Q3 & Q4...');
      expect(text).toContain("* Alice said: 'Ready'");
      expect(text).toContain('Em dash: 2025--2026');
      expect(text).toContain('Special chars: (C) and (TM)');
      expect(text).toContain('ZeroWidthSpace');
      // Confirm CRLF \r\n did not leave ?\n
      expect(text).not.toContain('?\n');
      expect(text).not.toContain('?•');
      // Confirm tab \t did not leave ?
      expect(text).not.toContain('?\t');
      // Confirm foreign text/emojis became ? without throwing
      expect(text).toContain('Emojis ? and foreign text ?? are safely escaped.');
    });

    it('renders htmlBody when provided and falls back to plainTextBody when undefined', async () => {
      const emailWithHtml: EmailPdfRenderInput = {
        messageId: 'html-body-test',
        subject: 'HTML Email Test',
        htmlBody: '<p>Hello from <b>HTML</b> body!</p>',
        plainTextBody: 'Hello from plain text body!',
      };

      const pdfBytesHtml = await processor.generateEmailPdf(emailWithHtml);
      const textHtml = await processor.extractTextFromPages(pdfBytesHtml, [1]);
      expect(textHtml).toContain('Hello from HTML body!');
      expect(textHtml).not.toContain('Hello from plain text body!');

      const emailFallback: EmailPdfRenderInput = {
        messageId: 'fallback-test',
        subject: 'Fallback Email Test',
        plainTextBody: 'Fallback to plain text!',
      };

      const pdfBytesFallback = await processor.generateEmailPdf(emailFallback);
      const textFallback = await processor.extractTextFromPages(pdfBytesFallback, [1]);
      expect(textFallback).toContain('Fallback to plain text!');
    });

    it('pre-purges style, script, head, and HTML comments completely from htmlBody', async () => {
      const email: EmailPdfRenderInput = {
        messageId: 'purge-test',
        subject: 'Purge Security & Metadata Test',
        htmlBody: `
          <!DOCTYPE html>
          <html>
            <HEAD>
              <title>Secret Metadata Document Title</title>
              <meta name="author" content="Malicious Hacker" />
            </HEAD>
            <style type="text/css">
              body { font-family: Arial; color: #ff0000; }
              .hidden { display: none; visibility: hidden; }
            </style>
            <body>
              <!-- Internal developer note: AWS_SECRET_KEY=12345 -->
              <p>Actual visible email content that should be preserved.</p>
              <script type="text/javascript">
                console.log("malicious javascript execution");
                window.location.href = "https://phishing.example.com";
              </script>
            </body>
          </html>
        `,
      };

      const pdfBytes = await processor.generateEmailPdf(email);
      const text = await processor.extractTextFromPages(pdfBytes, [1]);

      expect(text).toContain('Actual visible email content that should be preserved.');
      expect(text).not.toContain('Secret Metadata Document Title');
      expect(text).not.toContain('Malicious Hacker');
      expect(text).not.toContain('color: #ff0000');
      expect(text).not.toContain('font-family: Arial');
      expect(text).not.toContain('AWS_SECRET_KEY');
      expect(text).not.toContain('malicious javascript execution');
      expect(text).not.toContain('phishing.example.com');
    });

    it('converts table cells to spaces, block tags and breaks to newlines, and strips all remaining tags', async () => {
      const email: EmailPdfRenderInput = {
        messageId: 'table-and-blocks-test',
        subject: 'Table & Block Tags Test',
        htmlBody: `
          <div>Heading Banner</div>
          <p>Line Alpha<br>Line Beta<br/>Line Gamma<br />Line Delta</p>
          <ul>
            <li>Bullet Option 1</li>
            <li>Bullet Option 2</li>
          </ul>
          <table>
            <thead>
              <tr><th>HeaderA</th><th>HeaderB</th></tr>
            </thead>
            <tbody>
              <tr><td>Cell1</td><td>Cell2</td></tr>
            </tbody>
          </table>
          <footer><span>Nested footer inline text</span></footer>
        `,
      };

      const pdfBytes = await processor.generateEmailPdf(email);
      const text = await processor.extractTextFromPages(pdfBytes, [1]);

      expect(text).toContain('Heading Banner');
      expect(text).toContain('Line Alpha');
      expect(text).toContain('Line Beta');
      expect(text).toContain('Line Gamma');
      expect(text).toContain('Line Delta');
      expect(text).toContain('Bullet Option 1');
      expect(text).toContain('Bullet Option 2');
      // Table headers and cells separated by spaces
      expect(text).toContain('HeaderA HeaderB');
      expect(text).toContain('Cell1 Cell2');
      expect(text).toContain('Nested footer inline text');
      // Confirm all HTML tags were stripped
      expect(text).not.toContain('<div');
      expect(text).not.toContain('</div>');
      expect(text).not.toContain('<p');
      expect(text).not.toContain('</p>');
      expect(text).not.toContain('<table');
      expect(text).not.toContain('</table>');
      expect(text).not.toContain('<span');
      expect(text).not.toContain('</span>');
    });

    it('decodes standard, typographical, and numeric decimal/hex HTML entities in htmlBody', async () => {
      const email: EmailPdfRenderInput = {
        messageId: 'entities-test',
        subject: 'Entity Decoding Test',
        htmlBody: `
          <p>Standard: &amp; &lt; &gt; &quot; &#39; &apos;</p>
          <p>Nbsp: Space&nbsp;Separated</p>
          <p>Typographical: &lsquo;single&rsquo; and &ldquo;double&rdquo; &mdash; dash &ndash; &hellip; bullet &bull; &copy; 2026 &trade;</p>
          <p>Decimal: &#65;&#66;&#67; &#8212;</p>
          <p>Hexadecimal: &#x41;&#x42;&#x43; &#x2013;</p>
          <p>NumericNbsp: Numeric&#160;and&#xA0;HexNbsp</p>
        `,
      };

      const pdfBytes = await processor.generateEmailPdf(email);
      const text = await processor.extractTextFromPages(pdfBytes, [1]);

      expect(text).toContain('Standard: & < > " \' \'');
      expect(text).toContain('Nbsp: Space Separated');
      expect(text).toContain('Typographical: \'single\' and "double" -- dash - ... bullet * (C) 2026 (TM)');
      expect(text).toContain('Decimal: ABC --');
      expect(text).toContain('Hexadecimal: ABC -');
      expect(text).toContain('NumericNbsp: Numeric and HexNbsp');
    });

    it('embeds inline PNG image referenced by CID in htmlBody', async () => {
      const samplePng = new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64'
        )
      );

      const embedPngSpy = vi.spyOn(PDFDocument.prototype, 'embedPng');
      const drawImageSpy = vi.spyOn(PDFPage.prototype, 'drawImage');

      const email: EmailPdfRenderInput = {
        messageId: 'inline-png-test',
        subject: 'Inline PNG Test',
        htmlBody: `
          <p>Paragraph before image.</p>
          <p><img src="cid:chart-logo.png" alt="Company Chart" /></p>
          <p>Paragraph after image.</p>
        `,
        inlineImages: [
          {
            cid: 'chart-logo.png',
            mimeType: 'image/png',
            data: samplePng,
          },
        ],
      };

      const pdfBytes = await processor.generateEmailPdf(email);
      expect(pdfBytes).toBeInstanceOf(Uint8Array);

      expect(embedPngSpy).toHaveBeenCalledTimes(1);
      expect(drawImageSpy).toHaveBeenCalledTimes(1);

      const text = await processor.extractTextFromPages(pdfBytes, [1]);
      expect(text).toContain('Paragraph before image.');
      expect(text).toContain('Paragraph after image.');

      embedPngSpy.mockRestore();
      drawImageSpy.mockRestore();
    });

    it('embeds JPEG inline images and normalizes CID references with angle brackets and URL encoding', async () => {
      const sampleJpeg = new Uint8Array(
        Buffer.from(
          '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
          'base64'
        )
      );

      const embedJpgSpy = vi.spyOn(PDFDocument.prototype, 'embedJpg');
      const drawImageSpy = vi.spyOn(PDFPage.prototype, 'drawImage');

      const email: EmailPdfRenderInput = {
        messageId: 'jpeg-cid-normalization-test',
        subject: 'JPEG CID Test',
        htmlBody: `
          <p>Introductory text.</p>
          <img src="cid:<photo.jpeg@enterprise.com>" />
          <p>Middle text.</p>
          <img src="cid:diagram%20report.jpg" />
          <p>Closing text.</p>
        `,
        inlineImages: [
          {
            // CID in metadata without brackets, case-insensitive match
            cid: 'PHOTO.JPEG@ENTERPRISE.COM',
            mimeType: 'image/jpeg',
            data: sampleJpeg,
          },
          {
            // CID with spaces (matching %20 in HTML)
            cid: '<diagram report.jpg>',
            mimeType: 'image/jpg',
            data: sampleJpeg,
          },
        ],
      };

      const pdfBytes = await processor.generateEmailPdf(email);
      expect(pdfBytes).toBeInstanceOf(Uint8Array);

      expect(embedJpgSpy).toHaveBeenCalledTimes(2);
      expect(drawImageSpy).toHaveBeenCalledTimes(2);

      const text = await processor.extractTextFromPages(pdfBytes, [1]);
      expect(text).toContain('Introductory text.');
      expect(text).toContain('Middle text.');
      expect(text).toContain('Closing text.');

      embedJpgSpy.mockRestore();
      drawImageSpy.mockRestore();
    });

    it('caches embedded PDFImage instances by CID so repeated CIDs embed only once', async () => {
      const samplePng = new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64'
        )
      );

      const embedPngSpy = vi.spyOn(PDFDocument.prototype, 'embedPng');
      const drawImageSpy = vi.spyOn(PDFPage.prototype, 'drawImage');

      const email: EmailPdfRenderInput = {
        messageId: 'repeated-cid-caching-test',
        subject: 'Repeated CID Test',
        htmlBody: `
          <p>Occurrence 1</p>
          <img src="cid:signature-icon" />
          <p>Occurrence 2</p>
          <img src="cid:<SIGNATURE-ICON>" />
          <p>Occurrence 3</p>
          <img src="cid:signature-icon" />
        `,
        inlineImages: [
          {
            cid: 'signature-icon',
            mimeType: 'image/png',
            data: samplePng,
          },
        ],
      };

      const pdfBytes = await processor.generateEmailPdf(email);
      expect(pdfBytes).toBeInstanceOf(Uint8Array);

      // Embedded only once, but drawn 3 times
      expect(embedPngSpy).toHaveBeenCalledTimes(1);
      expect(drawImageSpy).toHaveBeenCalledTimes(3);

      const text = await processor.extractTextFromPages(pdfBytes, [1]);
      expect(text).toContain('Occurrence 1');
      expect(text).toContain('Occurrence 2');
      expect(text).toContain('Occurrence 3');

      embedPngSpy.mockRestore();
      drawImageSpy.mockRestore();
    });

    it('scales oversized images proportionally to fit within 512 pt width and 692 pt height', async () => {
      const samplePng = new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64'
        )
      );

      const realEmbedPng = PDFDocument.prototype.embedPng;
      const embedPngSpy = vi.spyOn(PDFDocument.prototype, 'embedPng').mockImplementation(async function (this: PDFDocument, ...args) {
        const realImg = await realEmbedPng.apply(this, args);
        // Create an image object with simulated oversized dimensions 1024 x 512
        return Object.create(realImg, {
          width: { value: 1024 },
          height: { value: 512 },
        });
      });

      const drawImageSpy = vi.spyOn(PDFPage.prototype, 'drawImage');

      const email: EmailPdfRenderInput = {
        messageId: 'proportional-scaling-test',
        subject: 'Scaling Test',
        htmlBody: '<p>Before</p><img src="cid:oversized.png" /><p>After</p>',
        inlineImages: [
          {
            cid: 'oversized.png',
            mimeType: 'image/png',
            data: samplePng,
          },
        ],
      };

      const pdfBytes = await processor.generateEmailPdf(email);
      expect(pdfBytes).toBeInstanceOf(Uint8Array);

      expect(drawImageSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          width: 512,
          height: 256,
        })
      );

      embedPngSpy.mockRestore();
      drawImageSpy.mockRestore();
    });

    it('skips images with non-positive dimensions (width <= 0 or height <= 0)', async () => {
      const samplePng = new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64'
        )
      );

      const realEmbedPng = PDFDocument.prototype.embedPng;
      const embedPngSpy = vi.spyOn(PDFDocument.prototype, 'embedPng').mockImplementation(async function (this: PDFDocument, ...args) {
        const realImg = await realEmbedPng.apply(this, args);
        return Object.create(realImg, {
          width: { value: 0 },
          height: { value: 100 },
        });
      });

      const drawImageSpy = vi.spyOn(PDFPage.prototype, 'drawImage');

      const email: EmailPdfRenderInput = {
        messageId: 'zero-dimension-test',
        subject: 'Zero Dimension Test',
        htmlBody: '<p>Before</p><img src="cid:zero-dim.png" /><p>After</p>',
        inlineImages: [
          {
            cid: 'zero-dim.png',
            mimeType: 'image/png',
            data: samplePng,
          },
        ],
      };

      const pdfBytes = await processor.generateEmailPdf(email);
      expect(pdfBytes).toBeInstanceOf(Uint8Array);

      expect(drawImageSpy).not.toHaveBeenCalled();

      embedPngSpy.mockRestore();
      drawImageSpy.mockRestore();
    });

    it('allocates a new Letter page when remaining vertical space is insufficient for image', async () => {
      const samplePng = new Uint8Array(
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
          'base64'
        )
      );

      // Simulate a tall image of 500 pt
      const realEmbedPng = PDFDocument.prototype.embedPng;
      const embedPngSpy = vi.spyOn(PDFDocument.prototype, 'embedPng').mockImplementation(async function (this: PDFDocument, ...args) {
        const realImg = await realEmbedPng.apply(this, args);
        return Object.create(realImg, {
          width: { value: 400 },
          height: { value: 500 },
        });
      });

      // 30 lines of text take ~420 pt. With headers (~150 pt), cursor is ~172 pt.
      // 500 pt image cannot fit on page 1 (172 - 500 < 50), so it must paginate onto page 2!
      const paragraphs = Array.from({ length: 30 }, (_, i) => `<p>Paragraph ${i + 1}</p>`).join('');

      const email: EmailPdfRenderInput = {
        messageId: 'image-pagination-test',
        subject: 'Image Pagination Test',
        htmlBody: `
          ${paragraphs}
          <img src="cid:tall-diagram.png" />
          <p>Text on page 2 following tall image.</p>
        `,
        inlineImages: [
          {
            cid: 'tall-diagram.png',
            mimeType: 'image/png',
            data: samplePng,
          },
        ],
      };

      const pdfBytes = await processor.generateEmailPdf(email);
      const doc = await PDFDocument.load(pdfBytes);

      expect(doc.getPageCount()).toBeGreaterThanOrEqual(2);

      const page1Text = await processor.extractTextFromPages(pdfBytes, [1]);
      expect(page1Text).toContain('Paragraph 1');
      expect(page1Text).toContain('Page 1 of 2');

      const page2Text = await processor.extractTextFromPages(pdfBytes, [2]);
      expect(page2Text).toContain('Text on page 2 following tall image.');
      expect(page2Text).toContain('Page 2 of 2');

      embedPngSpy.mockRestore();
    });

    it('gracefully degrades when CID images are missing, corrupted, empty, or unsupported without throwing', async () => {
      const corruptedBytes = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
      const emptyBytes = new Uint8Array([]);
      const dummyBytes = new Uint8Array([1, 2, 3, 4]);

      const drawImageSpy = vi.spyOn(PDFPage.prototype, 'drawImage');

      const email: EmailPdfRenderInput = {
        messageId: 'graceful-degradation-test',
        subject: 'Graceful Degradation Test',
        htmlBody: `
          <p>Start of body.</p>
          <img src="cid:missing-reference" />
          <img src="cid:corrupted-png" />
          <img src="cid:empty-jpeg" />
          <img src="cid:animated.gif" />
          <img src="cid:modern.webp" />
          <img src="cid:vector.svg" />
          <p>End of body.</p>
        `,
        inlineImages: [
          {
            cid: 'corrupted-png',
            mimeType: 'image/png',
            data: corruptedBytes,
          },
          {
            cid: 'empty-jpeg',
            mimeType: 'image/jpeg',
            data: emptyBytes,
          },
          {
            cid: 'animated.gif',
            mimeType: 'image/gif',
            data: dummyBytes,
          },
          {
            cid: 'modern.webp',
            mimeType: 'image/webp',
            data: dummyBytes,
          },
          {
            cid: 'vector.svg',
            mimeType: 'image/svg+xml',
            data: dummyBytes,
          },
        ],
      };

      const pdfBytes = await processor.generateEmailPdf(email);
      expect(pdfBytes).toBeInstanceOf(Uint8Array);

      expect(drawImageSpy).not.toHaveBeenCalled();

      const text = await processor.extractTextFromPages(pdfBytes, [1]);
      expect(text).toContain('Start of body.');
      expect(text).toContain('End of body.');

      const doc = await PDFDocument.load(pdfBytes);
      expect(doc.getPageCount()).toBe(1);

      drawImageSpy.mockRestore();
    });
  });

  describe('centralized in-memory file-size guard', () => {
    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('enforces async size-limit provider across single-buffer operations and cumulative mergeDocuments', async () => {
      const pdfBytes = await createSamplePdf(1);
      const limit = pdfBytes.byteLength + 10;
      const getMaxInMemoryFileBytes = vi.fn().mockResolvedValue(limit);
      const guarded = new PdfProcessor({ getMaxInMemoryFileBytes });

      // Single buffer within limit passes
      await expect(guarded.extractPages(pdfBytes, [1])).resolves.toBeInstanceOf(Uint8Array);
      await expect(guarded.extractFormData(pdfBytes)).resolves.toEqual({});

      // Cumulative mergeDocuments exceeds limit even though each buffer is below limit
      await expect(guarded.mergeDocuments([pdfBytes, pdfBytes])).rejects.toThrow(
        PdfFileTooLargeError
      );
      expect(getMaxInMemoryFileBytes).toHaveBeenCalled();

      // Strict lower limit rejects single-buffer operations before parsing
      const tightGuarded = new PdfProcessor({
        getMaxInMemoryFileBytes: async () => pdfBytes.byteLength - 1,
      });
      await expect(tightGuarded.extractPages(pdfBytes, [1])).rejects.toThrow(
        PdfFileTooLargeError
      );
      await expect(tightGuarded.extractFormData(pdfBytes)).rejects.toThrow(
        PdfFileTooLargeError
      );
      await expect(
        tightGuarded.processFormSubmission(pdfBytes, { Field: 'val' })
      ).rejects.toThrow(PdfFileTooLargeError);
      await expect(tightGuarded.extractTextFromPages(pdfBytes, [1])).rejects.toThrow(
        PdfFileTooLargeError
      );
      await expect(
        tightGuarded.generateEmailPdf({
          messageId: 'msg-oversized',
          inlineImages: [
            {
              cid: 'img-1',
              mimeType: 'image/png',
              data: new Uint8Array(pdfBytes.byteLength),
            },
          ],
        })
      ).rejects.toThrow(PdfFileTooLargeError);
    });

    it('honors MAX_IN_MEMORY_FILE_BYTES environment override when no custom provider is passed', async () => {
      const pdfBytes = await createSamplePdf(1);
      vi.stubEnv('MAX_IN_MEMORY_FILE_BYTES', String(pdfBytes.byteLength - 1));

      const defaultProcessor = new PdfProcessor();
      await expect(defaultProcessor.extractFormData(pdfBytes)).rejects.toThrow(
        PdfFileTooLargeError
      );
    });

    it('rejects non-positive or non-finite maxInMemoryFileBytes overrides consistently', async () => {
      const pdfBytes = await createSamplePdf(1);
      const invalidProcessor = new PdfProcessor({ getMaxInMemoryFileBytes: () => -10 });

      await expect(invalidProcessor.extractFormData(pdfBytes)).rejects.toThrow(
        /Invalid maxInMemoryFileBytes configuration.*must be a positive finite number/
      );
    });
  });

  describe('insertPages', () => {
    it('prepends an anonymized editable cover sheet with single-pass form fill, preserving target metadata, widget /P refs, and zero flattening', async () => {
      const targetDoc = await PDFDocument.create();
      targetDoc.setTitle('Manufacturer Product Data');
      targetDoc.setAuthor('Vendor Engineering');
      const p1 = targetDoc.addPage([612, 792]);
      p1.drawText('Target Page 1');
      const p2 = targetDoc.addPage([612, 792]);
      p2.drawText('Target Page 2');
      const targetBytes = await targetDoc.save();

      const coverBytes = await createAnonymizedSubmittalCoverSheetPdf();

      const resultBytes = await processor.insertPages(targetBytes, coverBytes, {
        position: 'start',
        sourcePages: [1],
        formData: {
          'Submittal No': '08 11 00-001-0',
        },
      });

      const resultDoc = await PDFDocument.load(resultBytes);
      expect(resultDoc.getPageCount()).toBe(3);
      expect(resultDoc.getTitle()).toBe('Manufacturer Product Data');
      expect(resultDoc.getAuthor()).toBe('Vendor Engineering');

      // Ensure no ghost pages were created in context
      const pageLeafCount = resultDoc.context
        .enumerateIndirectObjects()
        .filter(([, obj]) => obj instanceof PDFDict && obj.get(PDFName.of('Type')) === PDFName.of('Page')).length;
      expect(pageLeafCount).toBe(3);

      // Verify cover sheet is page 1 and target pages follow
      const page1Text = await processor.extractTextFromPages(resultBytes, [1]);
      const page2Text = await processor.extractTextFromPages(resultBytes, [2]);
      expect(page1Text).toContain('SUBMITTAL COVER SHEET');
      expect(page2Text).toContain('Target Page 1');

      // Verify all cover-sheet AcroForm fields remain unflattened and editable
      const resultForm = resultDoc.getForm();
      expect(resultForm.getFields().map((f) => f.getName())).toEqual([
        'Submittal No',
        'Submittal Response',
        'Date',
        'Reviewed By',
        'REMARKS',
      ]);

      // Verify every widget on page 1 points /P to page 1's actual PDFRef
      const insertedPageRef = resultDoc.getPage(0).ref;
      for (const field of resultForm.getFields()) {
        for (const widget of field.acroField.getWidgets()) {
          expect(widget.P()).toBe(insertedPageRef);
        }
      }

      // Verify extractFormData round-trip and subsequent editability
      expect(await processor.extractFormData(resultBytes)).toEqual({
        'Submittal No': '08 11 00-001-0',
        'Submittal Response': undefined,
        Date: undefined,
        'Reviewed By': undefined,
        REMARKS: undefined,
      });

      const editedBytes = await processor.processFormSubmission(resultBytes, {
        'Submittal Response': 'No Exceptions Taken',
        Date: '2026-11-26',
        'Reviewed By': 'A. Reviewer',
        REMARKS: 'Approved for fabrication.',
      });
      expect(await processor.extractFormData(editedBytes)).toEqual({
        'Submittal No': '08 11 00-001-0',
        'Submittal Response': 'No Exceptions Taken',
        Date: '2026-11-26',
        'Reviewed By': 'A. Reviewer',
        REMARKS: 'Approved for fabrication.',
      });
    });

    it('supports position "end" and numeric insertion indices while rejecting out-of-bounds or invalid sourcePages', async () => {
      const targetBytes = await createSamplePdf(2);
      const insertDoc = await PDFDocument.create();
      for (let i = 1; i <= 3; i++) {
        const p = insertDoc.addPage([300, 300]);
        p.drawText(`Insert ${i}`);
      }
      const insertBytes = await insertDoc.save();

      // Insert at 'end'
      const atEnd = await processor.insertPages(targetBytes, insertBytes, {
        position: 'end',
        sourcePages: [2],
      });
      expect(await processor.extractTextFromPages(atEnd, [1, 2, 3])).toBe(
        'Page 1\nPage 2\nInsert 2'
      );

      // Insert at numeric index 1 (between Page 1 and Page 2)
      const atMiddle = await processor.insertPages(targetBytes, insertBytes, {
        position: 1,
        sourcePages: [3, 1],
      });
      expect(await processor.extractTextFromPages(atMiddle, [1, 2, 3, 4])).toBe(
        'Page 1\nInsert 3\nInsert 1\nPage 2'
      );

      // Reject empty, out-of-range, non-integer, and duplicate sourcePages
      await expect(
        processor.insertPages(targetBytes, insertBytes, { sourcePages: [] })
      ).rejects.toThrow(PdfOutOfBoundsError);
      await expect(
        processor.insertPages(targetBytes, insertBytes, { sourcePages: [0] })
      ).rejects.toThrow(PdfOutOfBoundsError);
      await expect(
        processor.insertPages(targetBytes, insertBytes, { sourcePages: [4] })
      ).rejects.toThrow(PdfOutOfBoundsError);
      await expect(
        processor.insertPages(targetBytes, insertBytes, { sourcePages: [1.5] })
      ).rejects.toThrow(PdfOutOfBoundsError);
      await expect(
        processor.insertPages(targetBytes, insertBytes, { sourcePages: [1, 1] })
      ).rejects.toThrow(PdfProcessorError);

      // Reject out-of-bounds numeric position
      await expect(
        processor.insertPages(targetBytes, insertBytes, { position: -1 })
      ).rejects.toThrow(PdfOutOfBoundsError);
      await expect(
        processor.insertPages(targetBytes, insertBytes, { position: 3 })
      ).rejects.toThrow(PdfOutOfBoundsError);
      await expect(
        processor.insertPages(targetBytes, insertBytes, { position: 0.5 })
      ).rejects.toThrow(PdfOutOfBoundsError);
    });

    it('filters /AcroForm/Fields, multi-page widget /Kids, and /CO strictly to sourcePages without ghost pages', async () => {
      const targetBytes = await createSamplePdf(1);

      const insertDoc = await PDFDocument.create();
      const page1 = insertDoc.addPage([400, 400]);
      const page2 = insertDoc.addPage([400, 400]);
      const form = insertDoc.getForm();

      const p1Field = form.createTextField('Page1Only');
      p1Field.setText('KeepMe');
      p1Field.addToPage(page1, { x: 20, y: 300, width: 100, height: 20 });

      const p2Field = form.createTextField('Page2Only');
      p2Field.setText('DropMe');
      p2Field.addToPage(page2, { x: 20, y: 300, width: 100, height: 20 });

      // Multi-widget field spanning both page 1 and page 2
      const sharedField = form.createTextField('SharedSpanning');
      sharedField.setText('SharedVal');
      sharedField.addToPage(page1, { x: 20, y: 240, width: 100, height: 20 });
      sharedField.addToPage(page2, { x: 20, y: 240, width: 100, height: 20 });

      // Populate /CO referencing both selected and unselected fields
      form.acroForm.dict.set(
        PDFName.of('CO'),
        insertDoc.context.obj([p1Field.ref, p2Field.ref])
      );

      const insertBytes = await insertDoc.save();

      const resultBytes = await processor.insertPages(targetBytes, insertBytes, {
        position: 'start',
        sourcePages: [1],
      });

      const resultDoc = await PDFDocument.load(resultBytes);
      expect(resultDoc.getPageCount()).toBe(2);

      // No ghost page 2 in indirect objects
      const pageLeafCount = resultDoc.context
        .enumerateIndirectObjects()
        .filter(
          ([, obj]) =>
            obj instanceof PDFDict && obj.get(PDFName.of('Type')) === PDFName.of('Page')
        ).length;
      expect(pageLeafCount).toBe(2);

      const resultForm = resultDoc.getForm();
      expect(resultForm.getFields().map((f) => f.getName())).toEqual([
        'Page1Only',
        'SharedSpanning',
      ]);
      expect(resultForm.getTextField('SharedSpanning').acroField.getWidgets()).toHaveLength(
        1
      );

      const co = resultForm.acroForm.dict.lookupMaybe(PDFName.of('CO'), PDFArray);
      expect(co?.size()).toBe(1);
    });

    it('isolates colliding target root fields (including hierarchical /Kids and unsigned PDFSignature) under PDFAcroNonTerminal namespace and avoids collision on re-submission', async () => {
      // Build target PDF with colliding, non-colliding, hierarchical, and unsigned signature fields
      const targetDoc = await PDFDocument.create();
      const tPage = targetDoc.addPage([612, 792]);
      const tForm = targetDoc.getForm();

      const tSubmittalNo = tForm.createTextField('Submittal No');
      tSubmittalNo.setText('TARGET-001');
      tSubmittalNo.addToPage(tPage, { x: 50, y: 700, width: 150, height: 20 });

      const tProjectName = tForm.createTextField('Project Name');
      tProjectName.setText('Tower North');
      tProjectName.addToPage(tPage, { x: 50, y: 660, width: 150, height: 20 });

      const tGroupField = tForm.createTextField('Group.ItemA');
      tGroupField.setText('GroupVal');
      tGroupField.addToPage(tPage, { x: 50, y: 620, width: 150, height: 20 });

      const tSigRef = targetDoc.context.register(
        targetDoc.context.obj({
          FT: 'Sig',
          T: PDFString.of('ApproverSig'),
          Type: 'Annot',
          Subtype: 'Widget',
          Rect: [50, 560, 200, 600],
          P: tPage.ref,
        })
      );
      tForm.acroForm.addField(tSigRef);
      tPage.node.addAnnot(tSigRef);

      const targetBytes = await targetDoc.save();

      // Build cover sheet with colliding "Submittal No", "Group.CoverItem", and unsigned "ApproverSig"
      const insertDoc = await PDFDocument.create();
      const iPage = insertDoc.addPage([612, 792]);
      const iForm = insertDoc.getForm();
      iForm.createTextField('Submittal No').addToPage(iPage, { x: 50, y: 700, width: 150, height: 20 });
      const iGroup = iForm.createTextField('Group.CoverItem');
      iGroup.setText('CoverGroupVal');
      iGroup.addToPage(iPage, { x: 50, y: 660, width: 150, height: 20 });
      const iSigRef = insertDoc.context.register(
        insertDoc.context.obj({
          FT: 'Sig',
          T: PDFString.of('ApproverSig'),
          Type: 'Annot',
          Subtype: 'Widget',
          Rect: [50, 560, 200, 600],
          P: iPage.ref,
        })
      );
      iForm.acroForm.addField(iSigRef);
      iPage.node.addAnnot(iSigRef);
      const insertBytes = await insertDoc.save();

      const onceBytes = await processor.insertPages(targetBytes, insertBytes, {
        formData: { 'Submittal No': 'COVER-001' },
      });

      const onceExtracted = await processor.extractFormData(onceBytes);
      expect(onceExtracted).toEqual({
        '__target.Submittal No': 'TARGET-001',
        'Project Name': 'Tower North',
        '__target.Group.ItemA': 'GroupVal',
        '__target.ApproverSig': undefined,
        'Submittal No': 'COVER-001',
        'Group.CoverItem': 'CoverGroupVal',
        ApproverSig: undefined,
      });

      // Target namespaced field remains editable
      const editedOnce = await processor.processFormSubmission(onceBytes, {
        '__target.Submittal No': 'TARGET-001-REV',
      });
      expect((await processor.extractFormData(editedOnce))['__target.Submittal No']).toBe(
        'TARGET-001-REV'
      );

      // Re-submit onto already-grafted PDF: uses non-colliding __target_1 namespace
      const cover2Bytes = await createAnonymizedSubmittalCoverSheetPdf();
      const twiceBytes = await processor.insertPages(onceBytes, cover2Bytes, {
        formData: { 'Submittal No': 'COVER-002' },
      });
      const twiceExtracted = await processor.extractFormData(twiceBytes);
      expect(twiceExtracted['Submittal No']).toBe('COVER-002');
      expect(twiceExtracted['__target_1.Submittal No']).toBe('COVER-001');
      expect(twiceExtracted['__target.Submittal No']).toBe('TARGET-001');
      expect(twiceExtracted['Project Name']).toBe('Tower North');
    });

    it('supports targetAcroFormPolicy "strip" without flattening while preserving non-widget annotations', async () => {
      const targetDoc = await PDFDocument.create();
      const page = targetDoc.addPage([400, 400]);
      const form = targetDoc.getForm();
      const tf = form.createTextField('TargetField');
      tf.setText('TargetText');
      tf.addToPage(page, { x: 20, y: 300, width: 100, height: 20 });

      const linkAnnotRef = targetDoc.context.register(
        targetDoc.context.obj({
          Type: 'Annot',
          Subtype: 'Link',
          Rect: [20, 200, 120, 220],
        })
      );
      page.node.addAnnot(linkAnnotRef);
      const targetBytes = await targetDoc.save();

      const coverBytes = await createAnonymizedSubmittalCoverSheetPdf();
      const resultBytes = await processor.insertPages(targetBytes, coverBytes, {
        targetAcroFormPolicy: 'strip',
        formData: { 'Submittal No': 'STRIP-001' },
      });

      const resultDoc = await PDFDocument.load(resultBytes);
      expect(resultDoc.getPageCount()).toBe(2);

      // Target page retains its Link annotation, has no Widget annotations
      const targetPageAnnots = resultDoc.getPage(1).node.Annots();
      expect(targetPageAnnots?.size()).toBe(1);
      expect(
        targetPageAnnots?.lookupMaybe(0, PDFDict)?.get(PDFName.of('Subtype'))
      ).toBe(PDFName.of('Link'));

      // Only cover-sheet fields remain editable
      expect(await processor.extractFormData(resultBytes)).toEqual({
        'Submittal No': 'STRIP-001',
        'Submittal Response': undefined,
        Date: undefined,
        'Reviewed By': undefined,
        REMARKS: undefined,
      });
    });

    it('rejects XFA on cover sheets and pure-XFA targets with PdfUnsupportedFormError, while allowing hybrid XFA fallback by default', async () => {
      const targetBytes = await createSamplePdf(1);
      const coverBytes = await createAnonymizedSubmittalCoverSheetPdf();

      // Cover sheet with XFA is always rejected
      const xfaCoverDoc = await PDFDocument.load(coverBytes);
      const xfaStream = xfaCoverDoc.context.flateStream('<xdp:xdp/>');
      xfaCoverDoc.catalog
        .getOrCreateAcroForm()
        .dict.set(PDFName.of('XFA'), xfaCoverDoc.context.register(xfaStream));
      const xfaCoverBytes = await xfaCoverDoc.save({ updateFieldAppearances: false });

      await expect(
        processor.insertPages(targetBytes, xfaCoverBytes)
      ).rejects.toThrow(PdfUnsupportedFormError);

      // Pure XFA target (has /XFA, empty /Fields, 0 widgets) is rejected
      const pureXfaTargetDoc = await PDFDocument.create();
      pureXfaTargetDoc.addPage([400, 400]);
      const pureAcro = pureXfaTargetDoc.catalog.getOrCreateAcroForm();
      pureAcro.dict.set(
        PDFName.of('XFA'),
        pureXfaTargetDoc.context.register(pureXfaTargetDoc.context.flateStream('<xdp/>'))
      );
      const pureXfaBytes = await pureXfaTargetDoc.save({ updateFieldAppearances: false });

      await expect(
        processor.insertPages(pureXfaBytes, coverBytes)
      ).rejects.toThrow(PdfUnsupportedFormError);

      // Hybrid XFA target (has /XFA AND real AcroForm field + widget) falls back by default
      const hybridTargetDoc = await PDFDocument.create();
      const hPage = hybridTargetDoc.addPage([400, 400]);
      const hForm = hybridTargetDoc.getForm();
      const hField = hForm.createTextField('ExistingHybrid');
      hField.setText('HybridVal');
      hField.addToPage(hPage, { x: 20, y: 300, width: 100, height: 20 });
      hForm.acroForm.dict.set(
        PDFName.of('XFA'),
        hybridTargetDoc.context.register(hybridTargetDoc.context.flateStream('<xdp/>'))
      );
      const hybridBytes = await hybridTargetDoc.save({ updateFieldAppearances: false });

      const graftedHybrid = await processor.insertPages(hybridBytes, coverBytes, {
        formData: { 'Submittal No': 'HYB-001' },
      });
      const graftedHybridDoc = await PDFDocument.load(graftedHybrid);
      expect(
        graftedHybridDoc.catalog.getAcroForm()?.dict.has(PDFName.of('XFA'))
      ).toBe(false);
      expect(await processor.extractFormData(graftedHybrid)).toMatchObject({
        ExistingHybrid: 'HybridVal',
        'Submittal No': 'HYB-001',
      });

      // Hybrid XFA rejected under xfaPolicy: 'error'
      await expect(
        processor.insertPages(hybridBytes, coverBytes, { xfaPolicy: 'error' })
      ).rejects.toThrow(PdfUnsupportedFormError);
    });

    it('treats /XFA with non-empty /Fields (0 widgets) or empty /Fields with page widgets as hybrid XFA rather than pure XFA', async () => {
      const coverBytes = await createAnonymizedSubmittalCoverSheetPdf();

      // Case 1: /XFA + non-empty /Fields (field dict without /Subtype /Widget or /Rect) and 0 widgets
      const fieldsOnlyDoc = await PDFDocument.create();
      fieldsOnlyDoc.addPage([400, 400]);
      const fieldsOnlyAcro = fieldsOnlyDoc.catalog.getOrCreateAcroForm();
      const nonWidgetFieldRef = fieldsOnlyDoc.context.register(
        fieldsOnlyDoc.context.obj({
          FT: 'Tx',
          T: PDFString.of('NonWidgetField'),
          V: PDFString.of('FieldVal'),
        })
      );
      fieldsOnlyAcro.addField(nonWidgetFieldRef);
      fieldsOnlyAcro.dict.set(
        PDFName.of('XFA'),
        fieldsOnlyDoc.context.register(fieldsOnlyDoc.context.flateStream('<xdp/>'))
      );
      const fieldsOnlyBytes = await fieldsOnlyDoc.save({ updateFieldAppearances: false });

      const graftedFieldsOnly = await processor.insertPages(fieldsOnlyBytes, coverBytes, {
        formData: { 'Submittal No': 'HYB-FIELDS-001' },
      });
      const graftedFieldsOnlyDoc = await PDFDocument.load(graftedFieldsOnly);
      expect(
        graftedFieldsOnlyDoc.catalog.getAcroForm()?.dict.has(PDFName.of('XFA'))
      ).toBe(false);
      expect(graftedFieldsOnlyDoc.getPageCount()).toBe(2);

      // Case 2: /XFA + empty /Fields + page widget annotation in /Annots
      const pageWidgetDoc = await PDFDocument.create();
      const page = pageWidgetDoc.addPage([400, 400]);
      const pageWidgetAcro = pageWidgetDoc.catalog.getOrCreateAcroForm();
      const widgetAnnotRef = pageWidgetDoc.context.register(
        pageWidgetDoc.context.obj({
          Type: 'Annot',
          Subtype: 'Widget',
          Rect: [20, 300, 120, 320],
          P: page.ref,
        })
      );
      page.node.set(PDFName.of('Annots'), pageWidgetDoc.context.obj([widgetAnnotRef]));
      pageWidgetAcro.dict.set(
        PDFName.of('XFA'),
        pageWidgetDoc.context.register(pageWidgetDoc.context.flateStream('<xdp/>'))
      );
      const pageWidgetBytes = await pageWidgetDoc.save({ updateFieldAppearances: false });

      const graftedPageWidget = await processor.insertPages(pageWidgetBytes, coverBytes, {
        formData: { 'Submittal No': 'HYB-WIDGET-001' },
      });
      const graftedPageWidgetDoc = await PDFDocument.load(graftedPageWidget);
      expect(
        graftedPageWidgetDoc.catalog.getAcroForm()?.dict.has(PDFName.of('XFA'))
      ).toBe(false);
      expect(graftedPageWidgetDoc.getPageCount()).toBe(2);
    });

    it('detects active cryptographic signatures (ByteRange/Contents) and throws PdfUnsupportedFormError without touching unsigned PDFSignature fields', async () => {
      const signedDoc = await PDFDocument.create();
      const page = signedDoc.addPage([400, 400]);
      const form = signedDoc.getForm();
      const sigValRef = signedDoc.context.register(
        signedDoc.context.obj({
          Type: 'Sig',
          Filter: 'Adobe.PPKLite',
          ByteRange: [0, 100, 200, 300],
          Contents: PDFString.of('0000'),
        })
      );
      const sigRef = signedDoc.context.register(
        signedDoc.context.obj({
          FT: 'Sig',
          T: PDFString.of('DigitalSig'),
          V: sigValRef,
          Type: 'Annot',
          Subtype: 'Widget',
          Rect: [20, 300, 180, 340],
          P: page.ref,
        })
      );
      form.acroForm.addField(sigRef);
      form.acroForm.dict.set(PDFName.of('SigFlags'), signedDoc.context.obj(3));
      page.node.addAnnot(sigRef);
      const signedBytes = await signedDoc.save({ updateFieldAppearances: false });

      const coverBytes = await createAnonymizedSubmittalCoverSheetPdf();

      let caught: unknown;
      try {
        await processor.insertPages(signedBytes, coverBytes);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(PdfUnsupportedFormError);
      expect((caught as PdfUnsupportedFormError).reason).toBe('signed');
    });

    it('validates choice options before WinAnsi sanitization, rejects unknown dropdown/radio options and ExceededMaxLengthError with PdfFormFieldError, registers /DR/Font, and clears /NeedAppearances', async () => {
      const doc = await PDFDocument.create();
      const page = doc.addPage([400, 500]);
      const form = doc.getForm();

      const limitedText = form.createTextField('Code');
      limitedText.setMaxLength(5);
      limitedText.addToPage(page, { x: 20, y: 420, width: 120, height: 20 });
      limitedText.acroField.setDefaultAppearance('/Helv 10 Tf 0 g');

      const dropdown = form.createDropdown('Status');
      dropdown.setOptions(['Option--A', 'Option B', 'Café — Special']);
      dropdown.addToPage(page, { x: 20, y: 380, width: 120, height: 20 });

      const radio = form.createRadioGroup('Decision');
      radio.addOptionToPage('Yes', page, { x: 20, y: 350, width: 14, height: 14 });
      radio.addOptionToPage('No', page, { x: 50, y: 350, width: 14, height: 14 });

      const notes = form.createTextField('Notes');
      notes.addToPage(page, { x: 20, y: 300, width: 200, height: 40 });

      const untouched = form.createTextField('Untouched');
      untouched.setText('KeepOriginalAp');
      untouched.addToPage(page, { x: 20, y: 240, width: 140, height: 20 });
      untouched.defaultUpdateAppearances(await doc.embedFont(StandardFonts.Helvetica));
      const originalUntouchedApRef = untouched.acroField.getWidgets()[0]!.getNormalAppearance();

      // Set /NeedAppearances true on source form
      form.acroForm.dict.set(PDFName.of('NeedAppearances'), doc.context.obj(true));
      const templateBytes = await doc.save({ updateFieldAppearances: false });
      const targetBytes = await createSamplePdf(1);

      // Unknown dropdown option (even when em-dash would sanitize to '--') throws PdfFormFieldError
      await expect(
        processor.insertPages(targetBytes, templateBytes, {
          formData: { Status: 'Option\u2014A' },
        })
      ).rejects.toThrow(PdfFormFieldError);

      await expect(
        processor.processFormSubmission(templateBytes, { Status: 'UnknownOption' })
      ).rejects.toThrow(PdfFormFieldError);

      await expect(
        processor.processFormSubmission(templateBytes, { Decision: 'Maybe' })
      ).rejects.toThrow(PdfFormFieldError);

      // ExceededMaxLengthError throws PdfFormFieldError
      await expect(
        processor.insertPages(targetBytes, templateBytes, {
          formData: { Code: '123456' },
        })
      ).rejects.toThrow(PdfFormFieldError);

      // Valid fill with non-WinAnsi text sanitizes text field cleanly, keeps valid non-WinAnsi dropdown option in /V, registers /DR/Font, clears /NeedAppearances, and leaves untouched AP stream intact
      const filledBytes = await processor.insertPages(targetBytes, templateBytes, {
        formData: {
          Code: 'A1',
          Status: 'Café — Special',
          Decision: 'Yes',
          Notes: '“Smart” — ellipsis… 🚀',
        },
      });

      const filledDoc = await PDFDocument.load(filledBytes);
      const acro = filledDoc.catalog.getAcroForm()!;
      expect(acro.dict.has(PDFName.of('NeedAppearances'))).toBe(false);

      const drFont = acro.dict
        .lookupMaybe(PDFName.of('DR'), PDFDict)
        ?.lookupMaybe(PDFName.of('Font'), PDFDict);
      expect(drFont?.has(PDFName.of('Helv'))).toBe(true);
      expect(drFont?.has(PDFName.of('Helvetica'))).toBe(true);

      // Untouched field was not needlessly marked dirty or given a new appearance stream when checking processFormSubmission
      const resubmitted = await processor.processFormSubmission(templateBytes, {
        Code: 'B2',
      });
      const resubDoc = await PDFDocument.load(resubmitted);
      const resubUntouched = resubDoc.getForm().getTextField('Untouched');
      expect(resubUntouched.getText()).toBe('KeepOriginalAp');
      expect(originalUntouchedApRef).toBeInstanceOf(PDFRef);

      expect(await processor.extractFormData(filledBytes)).toEqual({
        Code: 'A1',
        Status: ['Café — Special'],
        Decision: 'Yes',
        Notes: '"Smart" -- ellipsis... ?',
        Untouched: 'KeepOriginalAp',
      });
    });

    it('preserves merged field+widget identity via shared PDFObjectCopier and skips regenerating untouched fields appearances', async () => {
      const targetBytes = await createSamplePdf(1);

      const insertDoc = await PDFDocument.create();
      const page = insertDoc.addPage([400, 400]);
      const form = insertDoc.getForm();

      // Merged field+widget dictionary (no /Kids)
      const mergedStream = insertDoc.context.formXObject([]);
      const mergedApRef = insertDoc.context.register(mergedStream);
      const mergedFieldRef = insertDoc.context.register(
        insertDoc.context.obj({
          FT: 'Tx',
          T: PDFString.of('MergedWidget'),
          V: PDFString.of('InitialMerged'),
          Type: 'Annot',
          Subtype: 'Widget',
          Rect: [20, 320, 180, 340],
          P: page.ref,
          AP: { N: mergedApRef },
        })
      );
      form.acroForm.addField(mergedFieldRef);
      page.node.addAnnot(mergedFieldRef);

      const editableField = form.createTextField('EditedField');
      editableField.addToPage(page, { x: 20, y: 260, width: 160, height: 20 });

      const insertBytes = await insertDoc.save({ updateFieldAppearances: false });

      const resultBytes = await processor.insertPages(targetBytes, insertBytes, {
        formData: { EditedField: 'Stamped' },
      });
      const resultDoc = await PDFDocument.load(resultBytes);
      const insertedPage = resultDoc.getPage(0);
      const resultForm = resultDoc.getForm();

      const mergedField = resultForm.getTextField('MergedWidget');
      const widgets = mergedField.acroField.getWidgets();
      expect(widgets).toHaveLength(1);
      expect(widgets[0]!.P()).toBe(insertedPage.ref);

      // Merged ref in /AcroForm/Fields matches annot ref on page
      const annots = insertedPage.node.Annots()!;
      const annotRefs = Array.from({ length: annots.size() }, (_, i) => annots.get(i));
      expect(annotRefs).toContain(mergedField.ref);

      // Untouched MergedWidget kept its original custom AP stream (not overwritten)
      expect(mergedField.getText()).toBe('InitialMerged');
      expect(widgets[0]!.getNormalAppearance()).toBeInstanceOf(PDFRef);
      expect(await processor.extractFormData(resultBytes)).toEqual({
        MergedWidget: 'InitialMerged',
        EditedField: 'Stamped',
      });
    });

    it('enforces cumulative byte limit across targetBuffer and insertBuffer in insertPages', async () => {
      const targetBytes = await createSamplePdf(1);
      const coverBytes = await createAnonymizedSubmittalCoverSheetPdf();
      const singleMax = Math.max(targetBytes.byteLength, coverBytes.byteLength);

      const guarded = new PdfProcessor({
        getMaxInMemoryFileBytes: async () => singleMax + 10,
      });

      // Individual buffers fit, cumulative sum exceeds limit
      await expect(guarded.insertPages(targetBytes, coverBytes)).rejects.toThrow(
        PdfFileTooLargeError
      );
    });
  });

  describe('mergeDocuments AcroForm preservation', () => {
    it('preserves colliding and non-colliding AcroForm fields across merged documents using namespace isolation without flattening', async () => {
      const doc1 = await PDFDocument.create();
      const p1 = doc1.addPage([400, 400]);
      const f1 = doc1.getForm();
      const f1Shared = f1.createTextField('Title');
      f1Shared.setText('First Doc');
      f1Shared.addToPage(p1, { x: 20, y: 300, width: 120, height: 20 });
      const f1Unique = f1.createTextField('Doc1Only');
      f1Unique.setText('Alpha');
      f1Unique.addToPage(p1, { x: 20, y: 260, width: 120, height: 20 });

      const doc2 = await PDFDocument.create();
      const p2 = doc2.addPage([400, 400]);
      const f2 = doc2.getForm();
      const f2Shared = f2.createTextField('Title');
      f2Shared.setText('Second Doc');
      f2Shared.addToPage(p2, { x: 20, y: 300, width: 120, height: 20 });
      const f2Unique = f2.createTextField('Doc2Only');
      f2Unique.setText('Beta');
      f2Unique.addToPage(p2, { x: 20, y: 260, width: 120, height: 20 });

      const mergedBytes = await processor.mergeDocuments([
        await doc1.save(),
        await doc2.save(),
      ]);

      expect(await processor.extractFormData(mergedBytes)).toEqual({
        '__target.Title': 'First Doc',
        Doc1Only: 'Alpha',
        Title: 'Second Doc',
        Doc2Only: 'Beta',
      });

      // Merged fields remain editable
      const editedMerged = await processor.processFormSubmission(mergedBytes, {
        '__target.Title': 'Updated First',
        Title: 'Updated Second',
      });
      expect(await processor.extractFormData(editedMerged)).toEqual({
        '__target.Title': 'Updated First',
        Doc1Only: 'Alpha',
        Title: 'Updated Second',
        Doc2Only: 'Beta',
      });
    });

    it('supports acroFormPolicy "strip" and rejects pure XFA in mergeDocuments', async () => {
      const doc1 = await PDFDocument.create();
      const p1 = doc1.addPage([400, 400]);
      const tf = doc1.getForm().createTextField('KeepOrStrip');
      tf.setText('Val1');
      tf.addToPage(p1, { x: 20, y: 300, width: 120, height: 20 });

      const doc2 = await PDFDocument.create();
      doc2.addPage([400, 400]);

      const strippedBytes = await processor.mergeDocuments(
        [await doc1.save(), await doc2.save()],
        { acroFormPolicy: 'strip' }
      );
      expect(await processor.extractFormData(strippedBytes)).toEqual({});

      const pureXfa = await PDFDocument.create();
      pureXfa.addPage([400, 400]);
      pureXfa.catalog
        .getOrCreateAcroForm()
        .dict.set(
          PDFName.of('XFA'),
          pureXfa.context.register(pureXfa.context.flateStream('<xdp/>'))
        );
      await expect(
        processor.mergeDocuments([await doc2.save(), await pureXfa.save({ updateFieldAppearances: false })])
      ).rejects.toThrow(PdfUnsupportedFormError);
    });
  });

  describe('createDocumentFromPages & sourceRole attribution (#380)', () => {
    it('creates a standalone editable PDF from selected sourcePages and formData without flattening', async () => {
      const coverDoc = await PDFDocument.load(await createAnonymizedSubmittalCoverSheetPdf());
      const page2 = coverDoc.addPage([612, 792]);
      page2.drawText('Extra Template Instructions');
      const twoPageCoverBytes = await coverDoc.save({ updateFieldAppearances: false });

      const siblingBytes = await processor.createDocumentFromPages(twoPageCoverBytes, {
        sourcePages: [1],
        formData: { 'Submittal No': '071200-001-0' },
      });

      const siblingDoc = await PDFDocument.load(siblingBytes);
      expect(siblingDoc.getPageCount()).toBe(1);
      expect(await processor.extractFormData(siblingBytes)).toEqual({
        'Submittal No': '071200-001-0',
        'Submittal Response': undefined,
        Date: undefined,
        'Reviewed By': undefined,
        REMARKS: undefined,
      });

      // Verify remaining fields stay editable
      const edited = await processor.processFormSubmission(siblingBytes, {
        'Submittal Response': 'No Exceptions Taken',
      });
      expect((await processor.extractFormData(edited))['Submittal Response']).toBe(
        'No Exceptions Taken'
      );
    });

    it('tags sourceRole as insert vs target on XFA errors in insertPages', async () => {
      const targetBytes = await createSamplePdf(1);
      const coverBytes = await createAnonymizedSubmittalCoverSheetPdf();

      const xfaCover = await PDFDocument.load(coverBytes);
      xfaCover.catalog
        .getOrCreateAcroForm()
        .dict.set(PDFName.of('XFA'), xfaCover.context.register(xfaCover.context.flateStream('<xdp/>')));
      const xfaCoverBytes = await xfaCover.save({ updateFieldAppearances: false });

      let insertErr: unknown;
      try {
        await processor.insertPages(targetBytes, xfaCoverBytes);
      } catch (err) {
        insertErr = err;
      }
      expect(insertErr).toBeInstanceOf(PdfUnsupportedFormError);
      expect((insertErr as PdfUnsupportedFormError).sourceRole).toBe('insert');

      const pureXfaTarget = await PDFDocument.create();
      pureXfaTarget.addPage([400, 400]);
      pureXfaTarget.catalog
        .getOrCreateAcroForm()
        .dict.set(PDFName.of('XFA'), pureXfaTarget.context.register(pureXfaTarget.context.flateStream('<xdp/>')));
      const pureXfaTargetBytes = await pureXfaTarget.save({ updateFieldAppearances: false });

      let targetErr: unknown;
      try {
        await processor.insertPages(pureXfaTargetBytes, coverBytes);
      } catch (err) {
        targetErr = err;
      }
      expect(targetErr).toBeInstanceOf(PdfUnsupportedFormError);
      expect((targetErr as PdfUnsupportedFormError).sourceRole).toBe('target');
    });
  });
});

