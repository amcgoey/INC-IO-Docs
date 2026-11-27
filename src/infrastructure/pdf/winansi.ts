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
