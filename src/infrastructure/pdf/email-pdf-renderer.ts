import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import type { EmailPdfRenderInput } from './types';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 50;
const PRINTABLE_WIDTH = PAGE_WIDTH - MARGIN * 2; // 512
const TOP_Y = PAGE_HEIGHT - MARGIN; // 742
const BOTTOM_MARGIN = MARGIN; // 50
const LINE_HEIGHT = 14;
const FONT_SIZE = 10;
const FOOTER_FONT_SIZE = 9;
const FOOTER_Y = 25;
const FOOTER_CENTER_X = 306;
const DIVIDER_THICKNESS = 0.75;
const DIVIDER_PADDING = 10;
const DIVIDER_COLOR = rgb(0.7, 0.7, 0.7);
const FOOTER_COLOR = rgb(0.4, 0.4, 0.4);

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  mdash: '--',
  ndash: '-',
  hellip: '...',
  bull: '*',
  copy: '(C)',
  trade: '(TM)',
};

/**
 * Decodes standard HTML entities, named typographical entities, and decimal/hex numeric entities.
 */
export function decodeHtmlEntities(input: string): string {
  return input.replace(
    /&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z0-9]+);/g,
    (fullMatch, entity: string) => {
      if (entity.startsWith('#x') || entity.startsWith('#X')) {
        const hex = entity.slice(2);
        const code = parseInt(hex, 16);
        if (!isNaN(code)) {
          if (code === 160) return ' ';
          try {
            return String.fromCodePoint(code);
          } catch {
            return fullMatch;
          }
        }
      } else if (entity.startsWith('#')) {
        const dec = entity.slice(1);
        const code = parseInt(dec, 10);
        if (!isNaN(code)) {
          if (code === 160) return ' ';
          try {
            return String.fromCodePoint(code);
          } catch {
            return fullMatch;
          }
        }
      } else {
        const lower = entity.toLowerCase();
        if (lower in NAMED_ENTITIES) {
          return NAMED_ENTITIES[lower]!;
        }
      }
      return fullMatch;
    }
  );
}

/**
 * Converts an HTML email body into clean, structured plain text:
 * 1. Pre-purges <style>, <script>, <head>, and <!-- ... --> comments.
 * 2. Converts </td> and </th> to spaces.
 * 3. Converts <br>, <br/>, </p>, </div>, </li>, and </tr> to newlines.
 * 4. Strips all remaining HTML tags (<[^>]+>).
 * 5. Decodes HTML entities (standard, typographical, numeric decimal & hex, and normalizes &nbsp; to ASCII space).
 */
export function convertHtmlToPlainText(html: string): string {
  const purged = html
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '');

  const whitespaceNormalized = purged
    .replace(/<\/(td|th)>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr)>/gi, '\n');

  const strippedTags = whitespaceNormalized.replace(/<[^>]+>/g, '');

  return decodeHtmlEntities(strippedTags);
}

/**
 * Sanitizes input text to only include characters supported by standard WinAnsi encoding.
 * Converts Unicode typographical symbols (smart quotes, dashes, ellipsis, bullets) into
 * ASCII equivalents and replaces any remaining unsupported characters with '?'.
 */
export function sanitizeWinAnsiText(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/\t/g, '    ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/\u2013/g, '-')
    .replace(/\u2014/g, '--')
    .replace(/\u2026/g, '...')
    .replace(/\u2022/g, '*')
    .replace(/\u00A9/g, '(C)')
    .replace(/\u2122/g, '(TM)')
    .replace(/[^\x20-\x7E\xA0-\xFF\n]/gu, '?');
}

/**
 * Greedily wraps words in a text string to fit within maxWidth.
 * If any single word exceeds maxWidth, it is broken character-by-character across lines.
 */
export function wrapWords(
  text: string,
  font: PDFFont,
  fontSize: number,
  maxWidth: number
): string[] {
  const sanitized = sanitizeWinAnsiText(text);
  const lines: string[] = [];
  const paragraphs = sanitized.split('\n');

  for (let p = 0; p < paragraphs.length; p++) {
    const paragraph = paragraphs[p];
    if (paragraph === undefined) continue;
    if (paragraph.length === 0) {
      lines.push('');
      continue;
    }

    const words = paragraph.split(' ');
    let currentLine = '';

    for (let w = 0; w < words.length; w++) {
      const word = words[w];
      if (word === undefined) continue;

      const wordWidth = font.widthOfTextAtSize(word, fontSize);

      if (wordWidth > maxWidth) {
        if (currentLine.length > 0) {
          lines.push(currentLine);
        }

        let chunk = '';
        for (let c = 0; c < word.length; c++) {
          const char = word[c]!;
          if (font.widthOfTextAtSize(chunk + char, fontSize) > maxWidth) {
            lines.push(chunk);
            chunk = char;
          } else {
            chunk += char;
          }
        }
        currentLine = chunk;
      } else {
        if (currentLine.length === 0) {
          currentLine = word;
        } else {
          const candidate = `${currentLine} ${word}`;
          if (font.widthOfTextAtSize(candidate, fontSize) <= maxWidth) {
            currentLine = candidate;
          } else {
            lines.push(currentLine);
            currentLine = word;
          }
        }
      }
    }

    if (currentLine.length > 0) {
      lines.push(currentLine);
    }
  }

  return lines;
}

interface HeaderField {
  label: string;
  value: string;
}

export class EmailPdfRenderer {
  /**
   * Renders an email message payload into a standardized multi-page Letter-sized PDF Uint8Array.
   */
  async render(email: EmailPdfRenderInput): Promise<Uint8Array> {
    const doc = await PDFDocument.create();
    const fontRegular = await doc.embedFont(StandardFonts.Helvetica);
    const fontBold = await doc.embedFont(StandardFonts.HelveticaBold);

    let currentPage: PDFPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
    let cursorY = TOP_Y;

    // Helper to ensure vertical space, allocating a new page if needed
    const ensureVerticalSpace = (requiredHeight: number) => {
      if (cursorY - requiredHeight < BOTTOM_MARGIN) {
        currentPage = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
        cursorY = TOP_Y;
      }
    };

    // 1. Build list of header fields
    const headerFields: HeaderField[] = [];

    const messageIdVal =
      (email.rfcMessageId !== undefined && email.rfcMessageId.trim().length > 0)
        ? email.rfcMessageId.trim()
        : email.messageId.trim();
    headerFields.push({ label: 'Message ID: ', value: messageIdVal });

    const subjectVal =
      email.subject !== undefined && email.subject.trim().length > 0
        ? email.subject.trim()
        : '(No Subject)';
    headerFields.push({ label: 'Subject: ', value: subjectVal });

    if (email.from !== undefined && email.from.trim().length > 0) {
      headerFields.push({ label: 'From: ', value: email.from.trim() });
    }

    if (email.to !== undefined && email.to.trim().length > 0) {
      headerFields.push({ label: 'To: ', value: email.to.trim() });
    }

    if (email.cc !== undefined && email.cc.trim().length > 0) {
      headerFields.push({ label: 'Cc: ', value: email.cc.trim() });
    }

    if (email.date !== undefined && email.date.trim().length > 0) {
      headerFields.push({ label: 'Date: ', value: email.date.trim() });
    }

    if (email.attachmentNames !== undefined && email.attachmentNames.length > 0) {
      const attachmentsStr = email.attachmentNames.join(', ').trim();
      if (attachmentsStr.length > 0) {
        headerFields.push({ label: 'Attachments: ', value: attachmentsStr });
      }
    }

    // 2. Render Header Fields
    for (const field of headerFields) {
      const sanitizedLabel = sanitizeWinAnsiText(field.label);
      const sanitizedVal = sanitizeWinAnsiText(field.value);

      const labelWidth = fontBold.widthOfTextAtSize(sanitizedLabel, FONT_SIZE);
      const valWidth = fontRegular.widthOfTextAtSize(sanitizedVal, FONT_SIZE);

      if (labelWidth + valWidth <= PRINTABLE_WIDTH) {
        // Entire header field fits on a single line
        ensureVerticalSpace(LINE_HEIGHT);
        currentPage.drawText(sanitizedLabel, {
          x: MARGIN,
          y: cursorY - 10,
          size: FONT_SIZE,
          font: fontBold,
        });
        currentPage.drawText(sanitizedVal, {
          x: MARGIN + labelWidth,
          y: cursorY - 10,
          size: FONT_SIZE,
          font: fontRegular,
        });
        cursorY -= LINE_HEIGHT;
      } else {
        // Header value wraps across multiple lines
        const availableLine1 = PRINTABLE_WIDTH - labelWidth;
        const words = sanitizedVal.split(' ');
        let line1Value = '';
        let wordIndex = 0;

        while (wordIndex < words.length) {
          const word = words[wordIndex]!;
          const candidate = line1Value.length === 0 ? word : `${line1Value} ${word}`;
          if (fontRegular.widthOfTextAtSize(candidate, FONT_SIZE) <= availableLine1) {
            line1Value = candidate;
            wordIndex++;
          } else {
            break;
          }
        }

        // Draw line 1 with label and fitting value
        ensureVerticalSpace(LINE_HEIGHT);
        currentPage.drawText(sanitizedLabel, {
          x: MARGIN,
          y: cursorY - 10,
          size: FONT_SIZE,
          font: fontBold,
        });
        if (line1Value.length > 0) {
          currentPage.drawText(line1Value, {
            x: MARGIN + labelWidth,
            y: cursorY - 10,
            size: FONT_SIZE,
            font: fontRegular,
          });
        }
        cursorY -= LINE_HEIGHT;

        // Wrap remaining words to full printable width (512 pt)
        if (wordIndex < words.length) {
          const remainingText = words.slice(wordIndex).join(' ');
          const subLines = wrapWords(remainingText, fontRegular, FONT_SIZE, PRINTABLE_WIDTH);
          for (const subLine of subLines) {
            ensureVerticalSpace(LINE_HEIGHT);
            currentPage.drawText(subLine, {
              x: MARGIN,
              y: cursorY - 10,
              size: FONT_SIZE,
              font: fontRegular,
            });
            cursorY -= LINE_HEIGHT;
          }
        }
      }
    }

    // 3. Render Divider Line
    ensureVerticalSpace(DIVIDER_PADDING * 2);
    cursorY -= DIVIDER_PADDING;
    currentPage.drawLine({
      start: { x: MARGIN, y: cursorY },
      end: { x: MARGIN + PRINTABLE_WIDTH, y: cursorY },
      thickness: DIVIDER_THICKNESS,
      color: DIVIDER_COLOR,
    });
    cursorY -= DIVIDER_PADDING;

    // 4. Render Body (HTML converted, or fallback to plain text)
    const rawBody =
      email.htmlBody !== undefined
        ? convertHtmlToPlainText(email.htmlBody)
        : email.plainTextBody;

    if (rawBody !== undefined && rawBody.length > 0) {
      const bodyLines = wrapWords(rawBody, fontRegular, FONT_SIZE, PRINTABLE_WIDTH);
      for (const line of bodyLines) {
        ensureVerticalSpace(LINE_HEIGHT);
        if (line.length > 0) {
          currentPage.drawText(line, {
            x: MARGIN,
            y: cursorY - 10,
            size: FONT_SIZE,
            font: fontRegular,
          });
        }
        cursorY -= LINE_HEIGHT;
      }
    }

    // 5. Post-render pass: stamp centered "Page X of Y" footer on every page
    const pages = doc.getPages();
    const totalPages = pages.length;
    for (let i = 0; i < totalPages; i++) {
      const page = pages[i]!;
      const footerText = `Page ${i + 1} of ${totalPages}`;
      const textWidth = fontRegular.widthOfTextAtSize(footerText, FOOTER_FONT_SIZE);
      page.drawText(footerText, {
        x: FOOTER_CENTER_X - textWidth / 2,
        y: FOOTER_Y,
        size: FOOTER_FONT_SIZE,
        font: fontRegular,
        color: FOOTER_COLOR,
      });
    }

    return await doc.save();
  }
}
