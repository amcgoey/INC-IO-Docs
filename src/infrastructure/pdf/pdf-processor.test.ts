import { describe, it, expect, vi } from 'vitest';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { PdfProcessor } from './pdf-processor';
import type { EmailPdfRenderInput } from './types';
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
  });
});

