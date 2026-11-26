import { PDFDocument, StandardFonts } from 'pdf-lib';

export interface SubmittalCoverSheetFixtureOptions {
  /** Optional pre-filled submittal number. */
  submittalNo?: string;
  /** Optional pre-selected submittal response radio option. */
  submittalResponse?:
    | 'No Exceptions Taken'
    | 'No Objections As Corrected'
    | 'Revise and Resubmit'
    | 'Rejected'
    | 'Not Reviewed';
  /** Optional pre-filled date text. */
  date?: string;
  /** Optional pre-filled reviewer name. */
  reviewedBy?: string;
  /** Optional pre-filled remarks text. */
  remarks?: string;
}

/**
 * Programmatically generates an anonymized 1-page Letter-sized AcroForm PDF
 * fixture representing a submittal cover sheet without any confidential content
 * or external template IDs.
 */
export async function createAnonymizedSubmittalCoverSheetPdf(
  options?: SubmittalCoverSheetFixtureOptions
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const boldFont = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);

  page.drawText('SUBMITTAL COVER SHEET', {
    x: 50,
    y: 740,
    size: 16,
    font: boldFont,
  });

  const form = doc.getForm();

  page.drawText('Submittal No:', { x: 50, y: 690, size: 11, font });
  const submittalNo = form.createTextField('Submittal No');
  submittalNo.addToPage(page, { x: 160, y: 682, width: 220, height: 22 });
  if (options?.submittalNo !== undefined) {
    submittalNo.setText(options.submittalNo);
  }

  page.drawText('Submittal Response:', { x: 50, y: 645, size: 11, font });
  const responseOptions = [
    'No Exceptions Taken',
    'No Objections As Corrected',
    'Revise and Resubmit',
    'Rejected',
    'Not Reviewed',
  ] as const;
  const responseGroup = form.createRadioGroup('Submittal Response');
  responseOptions.forEach((opt, idx) => {
    const y = 615 - idx * 24;
    responseGroup.addOptionToPage(opt, page, { x: 60, y, width: 14, height: 14 });
    page.drawText(opt, { x: 82, y: y + 2, size: 10, font });
  });
  if (options?.submittalResponse !== undefined) {
    responseGroup.select(options.submittalResponse);
  }

  page.drawText('Date:', { x: 50, y: 470, size: 11, font });
  const dateField = form.createTextField('Date');
  dateField.addToPage(page, { x: 160, y: 462, width: 180, height: 22 });
  if (options?.date !== undefined) {
    dateField.setText(options.date);
  }

  page.drawText('Reviewed By:', { x: 50, y: 430, size: 11, font });
  const reviewedByField = form.createTextField('Reviewed By');
  reviewedByField.addToPage(page, { x: 160, y: 422, width: 220, height: 22 });
  if (options?.reviewedBy !== undefined) {
    reviewedByField.setText(options.reviewedBy);
  }

  page.drawText('REMARKS:', { x: 50, y: 385, size: 11, font });
  const remarksField = form.createTextField('REMARKS');
  remarksField.enableMultiline();
  remarksField.addToPage(page, { x: 50, y: 240, width: 512, height: 130 });
  if (options?.remarks !== undefined) {
    remarksField.setText(options.remarks);
  }

  return await doc.save();
}
