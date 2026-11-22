import { describe, it, expect, vi } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import {
  DriveFormExtractorAdapter,
  type DriveFormMediaClient,
  type PdfFormExtractor,
  type GoogleDocsFormReader,
} from './drive-form-extractor.adapter';
import { PdfProcessor } from '../../../infrastructure/pdf/pdf-processor';
import { PdfEncryptionError, PdfCorruptedError } from '../../../infrastructure/pdf/errors';

async function createStampedSubmittalPdf(options?: {
  response?: string;
  date?: string;
  checkedFlag?: boolean;
  staleChoice?: boolean;
}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.addPage([600, 400]);
  const form = doc.getForm();

  const radio = form.createRadioGroup('Submittal Response');
  radio.addOptionToPage('No Exceptions Taken', doc.getPage(0), { x: 50, y: 300, width: 12, height: 12 });
  radio.addOptionToPage('No Objections As Corrected', doc.getPage(0), { x: 50, y: 280, width: 12, height: 12 });
  radio.addOptionToPage('Revise and Resubmit', doc.getPage(0), { x: 50, y: 260, width: 12, height: 12 });
  if (options?.response) {
    radio.select(options.response);
  } else if (options?.staleChoice) {
    radio.acroField.dict.set(PDFName.of('V'), PDFName.of('Choice10'));
  }

  const dateField = form.createTextField('Date');
  dateField.addToPage(doc.getPage(0), { x: 200, y: 300, width: 120, height: 20 });
  if (options?.date !== undefined) {
    dateField.setText(options.date);
  }

  const checkBox = form.createCheckBox('Reviewed');
  checkBox.addToPage(doc.getPage(0), { x: 200, y: 260, width: 12, height: 12 });
  if (options?.checkedFlag) {
    checkBox.check();
  }

  return doc.save();
}

describe('DriveFormExtractorAdapter', () => {
  it('downloads PDF via downloadFileMedia, extracts AcroForm widgets with PdfProcessor, omits undefined values, and preserves false/"0"', async () => {
    const pdfBytes = await createStampedSubmittalPdf({
      response: 'Revise and Resubmit',
      date: '0',
      checkedFlag: false,
    });
    const driveMediaClient: DriveFormMediaClient = {
      downloadFileMedia: vi.fn().mockResolvedValue(pdfBytes),
    };
    const adapter = new DriveFormExtractorAdapter({
      driveMediaClient,
      pdfProcessor: new PdfProcessor(),
    });

    const outcome = await adapter.extractFormFields({
      id: 'pdf-1',
      mimeType: 'application/pdf',
    });

    expect(driveMediaClient.downloadFileMedia).toHaveBeenCalledTimes(1);
    expect(driveMediaClient.downloadFileMedia).toHaveBeenCalledWith('pdf-1');
    expect(outcome).toEqual({
      status: 'ok',
      widgetCount: 3,
      fields: {
        'Submittal Response': 'Revise and Resubmit',
        Date: '0',
        Reviewed: false,
      },
    });
  });

  it('returns widgetCount: 0 for flat PDFs and preserves widgetCount > 0 with empty fields for blank/stale radio PDFs', async () => {
    const flatPdf = await (await PDFDocument.create()).save();
    const staleBlankPdf = await createStampedSubmittalPdf({ staleChoice: true });

    const driveMediaClient: DriveFormMediaClient = {
      downloadFileMedia: vi
        .fn()
        .mockResolvedValueOnce(flatPdf)
        .mockResolvedValueOnce(staleBlankPdf),
    };
    const adapter = new DriveFormExtractorAdapter({
      driveMediaClient,
      pdfProcessor: new PdfProcessor(),
    });

    const flatOutcome = await adapter.extractFormFields({
      id: 'flat-pdf',
      mimeType: 'application/pdf',
    });
    expect(flatOutcome).toEqual({ status: 'ok', widgetCount: 0, fields: {} });

    const blankOutcome = await adapter.extractFormFields({
      id: 'stale-blank-pdf',
      mimeType: 'application/pdf',
    });
    expect(blankOutcome).toEqual({
      status: 'ok',
      widgetCount: 3,
      fields: {
        Reviewed: false,
      },
    });
  });

  it('classifies Drive media download errors as source_error without invoking PdfProcessor', async () => {
    const driveMediaClient: DriveFormMediaClient = {
      downloadFileMedia: vi.fn().mockRejectedValue(new Error('Drive 403 Forbidden')),
    };
    const pdfProcessor: PdfFormExtractor = {
      extractFormData: vi.fn(),
    };
    const adapter = new DriveFormExtractorAdapter({ driveMediaClient, pdfProcessor });

    const outcome = await adapter.extractFormFields({
      id: 'pdf-err',
      mimeType: 'application/pdf',
    });

    expect(outcome).toEqual({ status: 'source_error' });
    expect(pdfProcessor.extractFormData).not.toHaveBeenCalled();
  });

  it('classifies PdfEncryptionError as encrypted and PdfCorruptedError/TypeError/RangeError as corrupted', async () => {
    const driveMediaClient: DriveFormMediaClient = {
      downloadFileMedia: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    };
    const pdfProcessor: PdfFormExtractor = {
      extractFormData: vi
        .fn()
        .mockRejectedValueOnce(new PdfEncryptionError())
        .mockRejectedValueOnce(new PdfCorruptedError())
        .mockRejectedValueOnce(new TypeError('Malformed xref')),
    };
    const adapter = new DriveFormExtractorAdapter({ driveMediaClient, pdfProcessor });

    await expect(
      adapter.extractFormFields({ id: 'enc-pdf', mimeType: 'application/pdf' })
    ).resolves.toEqual({ status: 'encrypted' });

    await expect(
      adapter.extractFormFields({ id: 'corrupt-pdf', mimeType: 'application/pdf' })
    ).resolves.toEqual({ status: 'corrupted' });

    await expect(
      adapter.extractFormFields({ id: 'typeerr-pdf', mimeType: 'application/pdf' })
    ).resolves.toEqual({ status: 'corrupted' });
  });

  it('defaults Google Docs to 0-widget no-op with zero I/O when googleDocsFormReader is omitted, and delegates when injected', async () => {
    const driveMediaClient: DriveFormMediaClient = {
      downloadFileMedia: vi.fn(),
    };
    const pdfProcessor: PdfFormExtractor = {
      extractFormData: vi.fn(),
    };

    const defaultAdapter = new DriveFormExtractorAdapter({ driveMediaClient, pdfProcessor });
    await expect(
      defaultAdapter.extractFormFields({
        id: 'gdoc-1',
        mimeType: 'application/vnd.google-apps.document',
      })
    ).resolves.toEqual({ status: 'ok', widgetCount: 0, fields: {} });
    expect(driveMediaClient.downloadFileMedia).not.toHaveBeenCalled();
    expect(pdfProcessor.extractFormData).not.toHaveBeenCalled();

    const googleDocsFormReader: GoogleDocsFormReader = {
      extractDocumentFormFields: vi
        .fn()
        .mockResolvedValueOnce({
          status: 'ok',
          widgetCount: 2,
          fields: { 'Submittal Response': 'No Exceptions Taken' },
          ambiguousFields: ['Date'],
        })
        .mockRejectedValueOnce(Object.assign(new Error('Invalid Doc'), { name: 'GoogleDocsCorruptedError' }))
        .mockRejectedValueOnce(new Error('Docs 500')),
    };
    const docsAdapter = new DriveFormExtractorAdapter({
      driveMediaClient,
      pdfProcessor,
      googleDocsFormReader,
    });

    await expect(
      docsAdapter.extractFormFields({
        id: 'gdoc-2',
        mimeType: 'application/vnd.google-apps.document',
      })
    ).resolves.toEqual({
      status: 'ok',
      widgetCount: 2,
      fields: { 'Submittal Response': 'No Exceptions Taken' },
      ambiguousFields: ['Date'],
    });
    await expect(
      docsAdapter.extractFormFields({
        id: 'gdoc-corrupt',
        mimeType: 'application/vnd.google-apps.document',
      })
    ).resolves.toEqual({ status: 'corrupted' });
    await expect(
      docsAdapter.extractFormFields({
        id: 'gdoc-err',
        mimeType: 'application/vnd.google-apps.document',
      })
    ).resolves.toEqual({ status: 'source_error' });
    expect(driveMediaClient.downloadFileMedia).not.toHaveBeenCalled();
  });

  it('returns 0-widget no-op with zero I/O for unsupported MIME types', async () => {
    const driveMediaClient: DriveFormMediaClient = {
      downloadFileMedia: vi.fn(),
    };
    const pdfProcessor: PdfFormExtractor = {
      extractFormData: vi.fn(),
    };
    const adapter = new DriveFormExtractorAdapter({ driveMediaClient, pdfProcessor });

    await expect(
      adapter.extractFormFields({
        id: 'sheet-1',
        mimeType: 'application/vnd.google-apps.spreadsheet',
      })
    ).resolves.toEqual({ status: 'ok', widgetCount: 0, fields: {} });
    expect(driveMediaClient.downloadFileMedia).not.toHaveBeenCalled();
    expect(pdfProcessor.extractFormData).not.toHaveBeenCalled();
  });

  it('memoizes in-flight and settled promises per ${mimeType}:${id}', async () => {
    const driveMediaClient: DriveFormMediaClient = {
      downloadFileMedia: vi.fn().mockResolvedValue(new Uint8Array([1])),
    };
    const pdfProcessor: PdfFormExtractor = {
      extractFormData: vi.fn().mockResolvedValue({ 'Submittal Response': 'No Exceptions Taken' }),
    };
    const adapter = new DriveFormExtractorAdapter({ driveMediaClient, pdfProcessor });

    const [first, second] = await Promise.all([
      adapter.extractFormFields({ id: 'same-id', mimeType: 'application/pdf' }),
      adapter.extractFormFields({ id: 'same-id', mimeType: 'application/pdf' }),
    ]);
    const third = await adapter.extractFormFields({ id: 'same-id', mimeType: 'application/pdf' });

    expect(first).toEqual(second);
    expect(third).toEqual(first);
    expect(driveMediaClient.downloadFileMedia).toHaveBeenCalledTimes(1);
    expect(pdfProcessor.extractFormData).toHaveBeenCalledTimes(1);

    // Different mimeType for same id does not collide
    const otherMime = await adapter.extractFormFields({
      id: 'same-id',
      mimeType: 'application/vnd.google-apps.document',
    });
    expect(otherMime).toEqual({ status: 'ok', widgetCount: 0, fields: {} });
  });
});
