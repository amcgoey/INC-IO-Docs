const ENGLISH_MONTHS: Readonly<Record<string, number>> = {
  jan: 1,
  january: 1,
  feb: 2,
  february: 2,
  mar: 3,
  march: 3,
  apr: 4,
  april: 4,
  may: 5,
  jun: 6,
  june: 6,
  jul: 7,
  july: 7,
  aug: 8,
  august: 8,
  sep: 9,
  sept: 9,
  september: 9,
  oct: 10,
  october: 10,
  nov: 11,
  november: 11,
  dec: 12,
  december: 12,
};

const ISO_TIMESTAMP_PREFIX_REGEX = /^(\d{4})-(\d{2})-(\d{2})T/;
const ISO_FOUR_DIGIT_DATE_REGEX = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})$/;
const US_FOUR_DIGIT_DATE_REGEX = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{4})$/;
const US_TWO_DIGIT_DATE_REGEX = /^(\d{1,2})([-/.])(\d{1,2})\2(\d{2})$/;
const WRITTEN_MONTH_FIRST_REGEX =
  /^([A-Za-z]+)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:\s*,\s*|\s+)(\d{2}|\d{4})$/i;
const WRITTEN_DAY_FIRST_REGEX =
  /^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\.?(?:\s*,\s*|\s+)(\d{2}|\d{4})$/i;
const SIX_DIGIT_YYMMDD_REGEX = /^(\d{2})(\d{2})(\d{2})$/;

export function isValidCalendarDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) {
    return false;
  }
  const utcDate = new Date(Date.UTC(year, month - 1, day));
  utcDate.setUTCFullYear(year);
  return (
    utcDate.getUTCFullYear() === year &&
    utcDate.getUTCMonth() === month - 1 &&
    utcDate.getUTCDate() === day
  );
}

export function formatYymmdd(year: number, month: number, day: number): string {
  const yy = String(year).slice(-2).padStart(2, '0');
  const mm = String(month).padStart(2, '0');
  const dd = String(day).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

function tryFormatFormDate(year: number, month: number, day: number): string | undefined {
  if (year < 2000 || year > 2099) {
    return undefined;
  }
  if (!isValidCalendarDate(year, month, day)) {
    return undefined;
  }
  return formatYymmdd(year, month, day);
}

function parseWrittenYear(rawYear: string): number {
  return rawYear.length === 2 ? 2000 + parseInt(rawYear, 10) : parseInt(rawYear, 10);
}

/**
 * Parses human-entered and ISO form date strings into INC `yyMMdd` format
 * with explicit `2000 <= year <= 2099` bounds and `Date.UTC` calendar validation.
 */
export function normalizeFormDateCandidate(candidate: string): string | undefined {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const isoTimestampMatch = trimmed.match(ISO_TIMESTAMP_PREFIX_REGEX);
  if (isoTimestampMatch) {
    return tryFormatFormDate(
      parseInt(isoTimestampMatch[1], 10),
      parseInt(isoTimestampMatch[2], 10),
      parseInt(isoTimestampMatch[3], 10)
    );
  }

  const isoDateMatch = trimmed.match(ISO_FOUR_DIGIT_DATE_REGEX);
  if (isoDateMatch) {
    return tryFormatFormDate(
      parseInt(isoDateMatch[1], 10),
      parseInt(isoDateMatch[3], 10),
      parseInt(isoDateMatch[4], 10)
    );
  }

  const usFourDigitMatch = trimmed.match(US_FOUR_DIGIT_DATE_REGEX);
  if (usFourDigitMatch) {
    return tryFormatFormDate(
      parseInt(usFourDigitMatch[4], 10),
      parseInt(usFourDigitMatch[1], 10),
      parseInt(usFourDigitMatch[3], 10)
    );
  }

  const usTwoDigitMatch = trimmed.match(US_TWO_DIGIT_DATE_REGEX);
  if (usTwoDigitMatch) {
    return tryFormatFormDate(
      2000 + parseInt(usTwoDigitMatch[4], 10),
      parseInt(usTwoDigitMatch[1], 10),
      parseInt(usTwoDigitMatch[3], 10)
    );
  }

  const monthFirstMatch = trimmed.match(WRITTEN_MONTH_FIRST_REGEX);
  if (monthFirstMatch) {
    const month = ENGLISH_MONTHS[monthFirstMatch[1].toLowerCase()];
    if (month === undefined) {
      return undefined;
    }
    return tryFormatFormDate(
      parseWrittenYear(monthFirstMatch[3]),
      month,
      parseInt(monthFirstMatch[2], 10)
    );
  }

  const dayFirstMatch = trimmed.match(WRITTEN_DAY_FIRST_REGEX);
  if (dayFirstMatch) {
    const month = ENGLISH_MONTHS[dayFirstMatch[2].toLowerCase()];
    if (month === undefined) {
      return undefined;
    }
    return tryFormatFormDate(
      parseWrittenYear(dayFirstMatch[3]),
      month,
      parseInt(dayFirstMatch[1], 10)
    );
  }

  const sixDigitMatch = trimmed.match(SIX_DIGIT_YYMMDD_REGEX);
  if (sixDigitMatch) {
    return tryFormatFormDate(
      2000 + parseInt(sixDigitMatch[1], 10),
      parseInt(sixDigitMatch[2], 10),
      parseInt(sixDigitMatch[3], 10)
    );
  }

  return undefined;
}
