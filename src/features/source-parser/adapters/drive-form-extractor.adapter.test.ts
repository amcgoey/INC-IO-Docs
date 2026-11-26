import { describe, it, expect, vi } from 'vitest';
import { PDFDocument, PDFName } from 'pdf-lib';
import { DriveFormExtractorAdapter } from './drive-form-extractor.adapter';
import type {
  DriveFormMediaClientPort,
  PdfFormExtractorPort,
  GoogleDocsFormReaderPort,
} from '../ports';
import { PdfProcessor } from '../../../infrastructure/pdf/pdf-processor';
import {
  PdfProcessorError,
  PdfEncryptionError,
  PdfCorruptedError,
  PdfFileTooLargeError,
} from '../../../infrastructure/pdf/errors';
import { GoogleDriveFileTooLargeError } from '../../../infrastructure/drive/drive-client';
import {
  GoogleDocsApiError,
  GoogleDocsCorruptedError,
  GoogleDocsNotFoundError,
} from '../../../infrastructure/docs/errors';

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
    const driveMediaClient: DriveFormMediaClientPort = {
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

    const driveMediaClient: DriveFormMediaClientPort = {
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
    const driveMediaClient: DriveFormMediaClientPort = {
      downloadFileMedia: vi.fn().mockRejectedValue(new Error('Drive 403 Forbidden')),
    };
    const pdfProcessor: PdfFormExtractorPort = {
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

  it('classifies PdfEncryptionError as encrypted and PdfCorruptedError/PdfProcessorError/TypeError/RangeError as corrupted', async () => {
    const driveMediaClient: DriveFormMediaClientPort = {
      downloadFileMedia: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
    };
    const pdfProcessor: PdfFormExtractorPort = {
      extractFormData: vi
        .fn()
        .mockRejectedValueOnce(new PdfEncryptionError())
        .mockRejectedValueOnce(new PdfCorruptedError())
        .mockRejectedValueOnce(new PdfProcessorError('Generic PDF parse failure'))
        .mockRejectedValueOnce(new TypeError('Malformed xref'))
        .mockRejectedValueOnce(new RangeError('Out-of-bounds offset')),
    };
    const adapter = new DriveFormExtractorAdapter({ driveMediaClient, pdfProcessor });

    await expect(
      adapter.extractFormFields({ id: 'enc-pdf', mimeType: 'application/pdf' })
    ).resolves.toEqual({ status: 'encrypted' });

    await expect(
      adapter.extractFormFields({ id: 'corrupt-pdf', mimeType: 'application/pdf' })
    ).resolves.toEqual({ status: 'corrupted' });

    await expect(
      adapter.extractFormFields({ id: 'procerr-pdf', mimeType: 'application/pdf' })
    ).resolves.toEqual({ status: 'corrupted' });

    await expect(
      adapter.extractFormFields({ id: 'typeerr-pdf', mimeType: 'application/pdf' })
    ).resolves.toEqual({ status: 'corrupted' });

    await expect(
      adapter.extractFormFields({ id: 'rangeerr-pdf', mimeType: 'application/pdf' })
    ).resolves.toEqual({ status: 'corrupted' });
  });

  it('defaults Google Docs to 0-widget no-op with zero I/O when googleDocsFormReader is omitted, and delegates/maps outcomes when injected', async () => {
    const driveMediaClient: DriveFormMediaClientPort = {
      downloadFileMedia: vi.fn(),
    };
    const pdfProcessor: PdfFormExtractorPort = {
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

    const googleDocsFormReader: GoogleDocsFormReaderPort = {
      extractDocumentFormFields: vi
        .fn()
        .mockResolvedValueOnce({
          widgetCount: 2,
          fields: { 'Submittal Response': 'No Exceptions Taken' },
          ambiguousFields: ['Date'],
        })
        .mockResolvedValueOnce({
          widgetCount: 1,
          fields: { 'Submittal Response': 'Rejected' },
          ambiguousFields: [],
        })
        .mockRejectedValueOnce(Object.assign(new Error('Invalid Doc'), { name: 'GoogleDocsCorruptedError' }))
        .mockRejectedValueOnce(new TypeError('Invalid table shape'))
        .mockRejectedValueOnce(new RangeError('Invalid cell index'))
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
    const emptyAmbiguousOutcome = await docsAdapter.extractFormFields({
      id: 'gdoc-empty-ambig',
      mimeType: 'application/vnd.google-apps.document',
    });
    expect(emptyAmbiguousOutcome).toEqual({
      status: 'ok',
      widgetCount: 1,
      fields: { 'Submittal Response': 'Rejected' },
    });
    expect('ambiguousFields' in emptyAmbiguousOutcome).toBe(false);

    await expect(
      docsAdapter.extractFormFields({
        id: 'gdoc-corrupt',
        mimeType: 'application/vnd.google-apps.document',
      })
    ).resolves.toEqual({ status: 'corrupted' });
    await expect(
      docsAdapter.extractFormFields({
        id: 'gdoc-typeerr',
        mimeType: 'application/vnd.google-apps.document',
      })
    ).resolves.toEqual({ status: 'corrupted' });
    await expect(
      docsAdapter.extractFormFields({
        id: 'gdoc-rangeerr',
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

  it('classifies real GoogleDocsCorruptedError as corrupted and GoogleDocsApiError / GoogleDocsNotFoundError as source_error', async () => {
    const driveMediaClient: DriveFormMediaClientPort = {
      downloadFileMedia: vi.fn(),
    };
    const pdfProcessor: PdfFormExtractorPort = {
      extractFormData: vi.fn(),
    };
    const googleDocsFormReader: GoogleDocsFormReaderPort = {
      extractDocumentFormFields: vi
        .fn()
        .mockRejectedValueOnce(new GoogleDocsCorruptedError('Invalid body'))
        .mockRejectedValueOnce(new GoogleDocsApiError('Rate limit exhausted', { statusCode: 429 }))
        .mockRejectedValueOnce(new GoogleDocsApiError('Permission denied', { statusCode: 403 }))
        .mockRejectedValueOnce(new GoogleDocsNotFoundError('Document not found')),
    };

    const adapter = new DriveFormExtractorAdapter({
      driveMediaClient,
      pdfProcessor,
      googleDocsFormReader,
    });

    await expect(
      adapter.extractFormFields({
        id: 'gdoc-real-corrupt',
        mimeType: 'application/vnd.google-apps.document',
      })
    ).resolves.toEqual({ status: 'corrupted' });

    await expect(
      adapter.extractFormFields({
        id: 'gdoc-real-429',
        mimeType: 'application/vnd.google-apps.document',
      })
    ).resolves.toEqual({ status: 'source_error' });

    await expect(
      adapter.extractFormFields({
        id: 'gdoc-real-403',
        mimeType: 'application/vnd.google-apps.document',
      })
    ).resolves.toEqual({ status: 'source_error' });

    await expect(
      adapter.extractFormFields({
        id: 'gdoc-real-404',
        mimeType: 'application/vnd.google-apps.document',
      })
    ).resolves.toEqual({ status: 'source_error' });
  });

  it('returns 0-widget no-op with zero I/O for unsupported MIME types', async () => {
    const driveMediaClient: DriveFormMediaClientPort = {
      downloadFileMedia: vi.fn(),
    };
    const pdfProcessor: PdfFormExtractorPort = {
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
    const driveMediaClient: DriveFormMediaClientPort = {
      downloadFileMedia: vi.fn().mockResolvedValue(new Uint8Array([1])),
    };
    const pdfProcessor: PdfFormExtractorPort = {
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

  it('classifies PdfFileTooLargeError, GoogleDriveFileTooLargeError, and oversized item.size as file_too_large outside corrupted status', async () => {
    const driveMediaClient: DriveFormMediaClientPort = {
      downloadFileMedia: vi
        .fn()
        .mockResolvedValueOnce(new Uint8Array([1, 2, 3]))
        .mockRejectedValueOnce(
          new GoogleDriveFileTooLargeError('Too large stream', { maxBytes: 100 })
        ),
    };
    const pdfProcessor: PdfFormExtractorPort = {
      extractFormData: vi
        .fn()
        .mockRejectedValueOnce(new PdfFileTooLargeError('Too large PDF')),
    };

    const adapter = new DriveFormExtractorAdapter({
      driveMediaClient,
      pdfProcessor,
      getMaxInMemoryFileBytes: vi.fn().mockResolvedValue(100),
    });

    // 1. Pre-download size metadata check avoids downloadFileMedia & PdfProcessor
    await expect(
      adapter.extractFormFields({
        id: 'oversized-meta-pdf',
        mimeType: 'application/pdf',
        size: 101,
      })
    ).resolves.toEqual({ status: 'file_too_large' });
    expect(driveMediaClient.downloadFileMedia).not.toHaveBeenCalled();

    // 2. PdfFileTooLargeError from PdfProcessor classifies as file_too_large (not corrupted)
    await expect(
      adapter.extractFormFields({
        id: 'oversized-pdf-proc',
        mimeType: 'application/pdf',
      })
    ).resolves.toEqual({ status: 'file_too_large' });

    // 3. GoogleDriveFileTooLargeError from downloadFileMedia classifies as file_too_large (not source_error)
    await expect(
      adapter.extractFormFields({
        id: 'oversized-drive-stream',
        mimeType: 'application/pdf',
      })
    ).resolves.toEqual({ status: 'file_too_large' });
  });
});
