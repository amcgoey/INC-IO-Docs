import type {
  DriveItemHierarchy,
  SourceContext,
  InferredRoutingResult,
  ExtractFieldsRequest,
  ExtractedFieldsResult,
  SourceParserSpaceTypeConfig,
  DriveSourceContextPort,
  SourceParserSpaceConfigPort,
  SourceParserConfigPort,
  SourceParserPort,
  CandidateSpaceDescriptor,
  ParseSchemaRegistryPort,
  PredicateEvaluatorPort,
  FallbackFieldExtractorPort,
  DocumentParseSchema,
  ParseTargetDocumentSchema,
  ParseTargetDocumentField,
  GmailFieldRule,
  GmailLookupFieldRule,
  GmailExtractSource,
  DriveFieldRule,
  DriveLookupFieldRule,
  DriveExtractSource,
  DriveExtractorRule,
  CanonicalOptionsProviderPort,
  ParseTargetDocumentOptionTuple,
  FormExtractorPort,
  FormTemplateParserPort,
} from './ports';
import {
  extractFormExtractorFields,
  parseDocumentFieldTemplate,
  PDF_FORM_ENCRYPTED_ERROR_MESSAGE,
  DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE,
  formatAmbiguousFormFieldMessage,
} from './form-field-parser';
import {
  applyFieldCandidateNormalize,
  DRIVE_METADATA_EXTRACT_ERROR_MESSAGE,
  escapeRegExp,
  evaluateCondition,
  extractEmailDomain,
  getYearMonthDayInTimeZone,
  normalizeCompactAlnumCandidate,
  normalizeDigits6Candidate,
  normalizePad3Candidate,
  parseRecipient,
  populateLinkedFields,
  resolveCanonicalOptionFromCandidate,
  validateCandidateWithTuple,
  type ValidatedCandidate,
} from './candidate-resolver';
import { formatYymmdd } from './form-date';

export {
  PDF_FORM_ENCRYPTED_ERROR_MESSAGE,
  DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE,
  formatAmbiguousFormFieldMessage,
  DRIVE_METADATA_EXTRACT_ERROR_MESSAGE,
  escapeRegExp,
  extractEmailDomain,
  parseRecipient,
};

export const CSI_SECTION_REGEX =
  /(?<=^|[\s_./-])(?:\d{6}|\d{2}([\s._-])\d{2}\1\d{2})(?:[\s_.-]*(?:submittal|sub\.?|no\.?)[\s_.-]*#?[\s_.-]*|[\s_.-]*#[\s_.-]*|[\s_.-]+)\d{1,3}(?![A-Za-z0-9])(?!-\d{2}[-_.]\d{2,4})/i;
export const FFE_SPEC_TAG_REGEX =
  /(?<=^|[\s_./-])[A-Z]{2}[\s._-]?\d{3}[A-Z]?(?:-[A-Za-z0-9]+)?(?=[\s_./-]|$)/;
export const FFE_PROXIMITY_REGEX_1 = /(?<=^|[\s_./-])FF&?E(?=[\s_./-]|$).{0,100}(?<=^|[\s_./-])Submittals?(?=[\s_./-]|$)/is;
export const FFE_PROXIMITY_REGEX_2 = /(?<=^|[\s_./-])Submittals?(?=[\s_./-]|$).{0,100}(?<=^|[\s_./-])FF&?E(?=[\s_./-]|$)/is;
export const GENERIC_SUBMITTAL_REGEX = /(?<=^|[\s_./-])Submittals?(?=[\s_./-]|$)/i;

export const ARCH_SUBMITTAL_NOTIFICATION_REGEX =
  /(?<=^|[\s_.-])Submittal\s*#?\s*\d+\b/i;
export const PROCORE_AUTODESK_SUBMITTAL_REGEX =
  /(?<=^|[\s_.-])(?:Procore|Autodesk\s+(?:Build|Construction\s+Cloud)?)\s*(?:[-:]|\b).{0,50}(?<=^|[\s_.-])Submittal(?=[\s_.-]|$)/is;
export const PROCORE_AUTODESK_SUBMITTAL_REVERSE_REGEX =
  /(?<=^|[\s_.-])Submittal(?=[\s_.-]|$).{0,50}(?<=^|[\s_.-])(?:Procore|Autodesk\s+(?:Build|Construction\s+Cloud)?)(?=[\s_.-]|$)/is;

export const DRIVE_HIERARCHY_ERROR_MESSAGE =
  'Could not inspect Google Drive folder hierarchy; please verify Document Space and Document Type.';

export function extractTextFromHtml(html?: string): string {
  if (!html || typeof html !== 'string') {
    return '';
  }
  let text = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
  return text.replace(/\s+/g, ' ').trim();
}

export function inferSubmittalTypeFromText(
  text?: string
): 'submittal-arch' | 'submittal-ffe' | undefined {
  if (!text || typeof text !== 'string') {
    return undefined;
  }
  const clean = text.trim();
  if (clean.length === 0) {
    return undefined;
  }
  if (
    FFE_SPEC_TAG_REGEX.test(clean) ||
    FFE_PROXIMITY_REGEX_1.test(clean) ||
    FFE_PROXIMITY_REGEX_2.test(clean)
  ) {
    return 'submittal-ffe';
  }
  if (
    CSI_SECTION_REGEX.test(clean) ||
    ARCH_SUBMITTAL_NOTIFICATION_REGEX.test(clean) ||
    PROCORE_AUTODESK_SUBMITTAL_REGEX.test(clean) ||
    PROCORE_AUTODESK_SUBMITTAL_REVERSE_REGEX.test(clean)
  ) {
    return 'submittal-arch';
  }
  return undefined;
}

export function inferDocumentTypeFromFilename(
  filename?: string
): 'submittal-arch' | 'submittal-ffe' | undefined {
  return inferSubmittalTypeFromText(filename);
}

export function findSpaceTypeForDocumentType(
  spaceTypes: SourceParserSpaceTypeConfig[],
  documentTypeKey: string
): string | undefined {
  return spaceTypes.find((st) => st.spaceSchema?.allowedDocumentTypes?.includes(documentTypeKey))?.id;
}

export function findMatchingCandidatesInText(
  text: string,
  candidateSpaces: CandidateSpaceDescriptor[],
  isSubject: boolean
): CandidateSpaceDescriptor[] {
  const matches: CandidateSpaceDescriptor[] = [];

  for (const candidate of candidateSpaces) {
    const name = typeof candidate?.name === 'string' ? candidate.name.trim() : '';
    if (name.length <= 1) {
      continue;
    }

    if (name.length >= 2 && name.length <= 3) {
      if (!isSubject) {
        continue;
      }
      const pattern = new RegExp(
        `(?<=^|[\\s_.,;:()[\\]/\\\\\\-"'])${escapeRegExp(name)}(?=[\\s_.,;:()[\\]/\\\\\\-"']|$)`
      );
      if (pattern.test(text)) {
        matches.push(candidate);
      }
    } else if (name.length >= 4) {
      const pattern = new RegExp(
        `(?<=^|[\\s_.,;:()[\\]/\\\\\\-"'])${escapeRegExp(name)}(?=[\\s_.,;:()[\\]/\\\\\\-"']|$)`,
        'i'
      );
      if (pattern.test(text)) {
        matches.push(candidate);
      }
    }
  }

  return matches;
}

export function resolveCandidateTieBreaking(
  matches: CandidateSpaceDescriptor[]
): CandidateSpaceDescriptor | undefined {
  if (matches.length === 0) {
    return undefined;
  }
  if (matches.length === 1) {
    return matches[0];
  }

  const sorted = [...matches].sort((a, b) => b.name.trim().length - a.name.trim().length);
  const longest = sorted[0];
  const longestName = longest.name.trim().toLowerCase();

  if (sorted[1].name.trim().length === longest.name.trim().length) {
    if (sorted[1].id !== longest.id || sorted[1].name.trim().toLowerCase() !== longestName) {
      return undefined;
    }
  }

  for (let i = 1; i < sorted.length; i++) {
    const other = sorted[i];
    if (other.id === longest.id) {
      continue;
    }
    const otherName = other.name.trim().toLowerCase();
    if (longestName.length <= otherName.length || !longestName.includes(otherName)) {
      return undefined;
    }
  }

  return longest;
}

export function isSystemLabel(label: string): boolean {
  const upper = label.toUpperCase();
  return (
    upper === 'INBOX' ||
    upper === 'SENT' ||
    upper === 'DRAFT' ||
    upper === 'TRASH' ||
    upper === 'SPAM' ||
    upper === 'UNREAD' ||
    upper === 'STARRED' ||
    upper === 'IMPORTANT' ||
    upper === 'CHAT' ||
    upper.startsWith('CATEGORY_')
  );
}

export function extractNonSystemLabelTokens(labels?: string[]): string[] {
  if (!labels || labels.length === 0) {
    return [];
  }
  const result: string[] = [];
  for (const label of labels) {
    if (typeof label !== 'string') continue;
    const trimmed = label.trim();
    if (!trimmed || isSystemLabel(trimmed)) continue;
    result.push(trimmed);
    const segments = trimmed.split('/');
    for (const seg of segments) {
      const segTrimmed = seg.trim();
      if (segTrimmed && segTrimmed !== trimmed) {
        result.push(segTrimmed);
      }
    }
  }
  return result;
}

export function matchCandidateSpaces(
  candidateSpaces?: CandidateSpaceDescriptor[],
  subject?: string,
  body?: string,
  labels?: string[]
): CandidateSpaceDescriptor | undefined {
  if (!candidateSpaces || candidateSpaces.length === 0) {
    return undefined;
  }

  if (labels && labels.length > 0) {
    const labelTokens = extractNonSystemLabelTokens(labels);
    for (const token of labelTokens) {
      const labelMatches = findMatchingCandidatesInText(token, candidateSpaces, true);
      if (labelMatches.length > 0) {
        const resolved = resolveCandidateTieBreaking(labelMatches);
        if (resolved) {
          return resolved;
        }
      }
    }
  }

  if (subject && typeof subject === 'string' && subject.trim().length > 0) {
    const subjectMatches = findMatchingCandidatesInText(subject, candidateSpaces, true);
    if (subjectMatches.length > 0) {
      return resolveCandidateTieBreaking(subjectMatches);
    }
  }

  if (body && typeof body === 'string' && body.trim().length > 0) {
    const bodyMatches = findMatchingCandidatesInText(body, candidateSpaces, false);
    if (bodyMatches.length > 0) {
      return resolveCandidateTieBreaking(bodyMatches);
    }
  }

  return undefined;
}

export function cleanSubject(subject?: string): string {
  if (!subject || typeof subject !== 'string') {
    return '';
  }
  const stripped = subject.replace(/^(?:(?:re|fwd?|aw)\s*:\s*)+/i, '');
  return stripped.trim();
}

const NAMED_TIMEZONE_OFFSETS: Record<string, number> = {
  EDT: -240,
  EST: -300,
  CDT: -300,
  CST: -360,
  MDT: -360,
  MST: -420,
  PDT: -420,
  PST: -480,
  GMT: 0,
  UT: 0,
  UTC: 0,
};

export function parseDateToYymmdd(dateString?: string, timeZone?: string): string | undefined {
  if (!dateString || typeof dateString !== 'string') {
    return undefined;
  }
  const trimmed = dateString.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  let offsetMinutes: number | undefined;
  const numericMatch = trimmed.match(/([+-])(\d{2}):?(\d{2})\b/);
  if (numericMatch) {
    const sign = numericMatch[1] === '-' ? -1 : 1;
    const hours = parseInt(numericMatch[2], 10);
    const minutes = parseInt(numericMatch[3], 10);
    offsetMinutes = sign * (hours * 60 + minutes);
  } else {
    const namedMatch = trimmed.match(/\b(EDT|EST|CDT|CST|MDT|MST|PDT|PST|GMT|UT|UTC)\b/);
    if (namedMatch && NAMED_TIMEZONE_OFFSETS[namedMatch[1]] !== undefined) {
      offsetMinutes = NAMED_TIMEZONE_OFFSETS[namedMatch[1]];
    }
  }

  const hasTimeComponent = trimmed.includes('T') || /\d{1,2}:\d{2}/.test(trimmed);

  let parsed: Date;
  if (offsetMinutes === undefined) {
    if (trimmed.includes('T')) {
      parsed = new Date(trimmed.endsWith('Z') || trimmed.endsWith('z') ? trimmed : `${trimmed}Z`);
    } else {
      parsed = new Date(`${trimmed} UTC`);
    }
    if (isNaN(parsed.getTime())) {
      parsed = new Date(trimmed);
    }
  } else {
    parsed = new Date(trimmed);
    if (isNaN(parsed.getTime())) {
      const namedMatch = trimmed.match(/\b(EDT|EST|CDT|CST|MDT|MST|PDT|PST|GMT|UT|UTC)\b/);
      if (namedMatch && NAMED_TIMEZONE_OFFSETS[namedMatch[1]] !== undefined) {
        const offsetMin = NAMED_TIMEZONE_OFFSETS[namedMatch[1]];
        const sign = offsetMin < 0 ? '-' : '+';
        const absMin = Math.abs(offsetMin);
        const h = String(Math.floor(absMin / 60)).padStart(2, '0');
        const m = String(absMin % 60).padStart(2, '0');
        const replaced = trimmed.replace(namedMatch[1], `${sign}${h}${m}`);
        parsed = new Date(replaced);
      }
    }
  }

  if (isNaN(parsed.getTime())) {
    return undefined;
  }

  if (offsetMinutes !== undefined || !hasTimeComponent) {
    const effectiveOffset = offsetMinutes ?? 0;
    const targetMs = parsed.getTime() + effectiveOffset * 60_000;
    const targetDate = new Date(targetMs);

    return formatYymmdd(
      targetDate.getUTCFullYear(),
      targetDate.getUTCMonth() + 1,
      targetDate.getUTCDate()
    );
  }

  const ymd = getYearMonthDayInTimeZone(parsed, timeZone);
  if (!ymd) {
    return undefined;
  }

  return formatYymmdd(ymd.year, ymd.month, ymd.day);
}

export function normalizeHtmlBodyForPass2(html?: string): string {
  if (!html || typeof html !== 'string') {
    return '';
  }
  let text = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ');
  text = text.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ');
  text = text.replace(/<\/(td|th)>/gi, ' ');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<\/(p|div|tr|li|h[1-6])>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&ndash;/gi, '\u2013')
    .replace(/&#8211;/gi, '\u2013')
    .replace(/&#x2013;/gi, '\u2013')
    .replace(/&mdash;/gi, '\u2014')
    .replace(/&#8212;/gi, '\u2014')
    .replace(/&#x2014;/gi, '\u2014')
    .replace(/&amp;/gi, '&');

  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/[^\S\r\n]+/g, ' ').trim())
    .join('\n')
    .trim();
}

export function extractEmailAddress(raw?: string): string {
  if (!raw || typeof raw !== 'string') {
    return '';
  }
  const match = raw.match(/<([^>]+)>/);
  const addr = match ? match[1].trim() : raw.trim();
  return addr.toLowerCase();
}

export function buildJsonLogicContext(context: SourceContext): Record<string, unknown> {
  const { email } = context;
  let emailContext: Record<string, unknown> | null = null;

  if (email) {
    const rawSubject = typeof email.subject === 'string' ? email.subject : '';
    const subjectClean = cleanSubject(rawSubject);
    const rawFrom = typeof email.from === 'string' ? email.from : '';
    const fromAddress = extractEmailAddress(rawFrom);
    const fromDomain = extractEmailDomain(fromAddress);

    const attachmentNames: string[] = [];
    if (context.items) {
      for (const item of context.items) {
        if (item?.name && typeof item.name === 'string' && item.name.trim().length > 0) {
          attachmentNames.push(item.name.trim());
        }
      }
    }
    if (email.attachments) {
      for (const att of email.attachments) {
        if (att?.name && typeof att.name === 'string' && att.name.trim().length > 0) {
          const trimmed = att.name.trim();
          if (!attachmentNames.includes(trimmed)) {
            attachmentNames.push(trimmed);
          }
        }
      }
    }

    emailContext = {
      id: email.id,
      subject: rawSubject,
      subjectClean,
      from: rawFrom,
      fromAddress,
      fromDomain,
      to: typeof email.to === 'string' ? email.to : '',
      cc: typeof email.cc === 'string' ? email.cc : '',
      date: typeof email.date === 'string' ? email.date : '',
      labels: Array.isArray(email.labels) ? email.labels : [],
      attachmentNames,
      hasAttachments: attachmentNames.length > 0,
    };
  }

  return {
    isDriveUrl: Boolean(context.isDriveUrl),
    items: context.items ?? [],
    email: emailContext,
  };
}

function extractRegexMatchValues(
  text: string,
  rule: { pattern?: string | undefined; flags?: string | undefined; group?: number | undefined },
  populatedFields: Record<string, unknown>
): string[] {
  if (!rule.pattern) {
    return [text];
  }
  const baseFlags = typeof rule.flags === 'string' ? rule.flags : 'i';
  const iterFlags = baseFlags.includes('g') ? baseFlags : `${baseFlags}g`;
  const regex = new RegExp(rule.pattern, iterFlags);
  const results: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    if (match[0].length === 0) {
      regex.lastIndex++;
    }
    if (!matchesCorrelatedCode(match, rule.group, populatedFields)) {
      continue;
    }
    const { group: groupIndex } = rule;
    const val = groupIndex !== undefined ? match[groupIndex] : (match[1] ?? match[0]);
    if (val !== undefined) {
      results.push(val);
    }
  }
  return results;
}

export function getCandidateAttachmentNames(context: SourceContext): string[] {
  if (context.isDriveUrl) {
    return [];
  }
  const names: string[] = [];
  if (context.items && context.items.length > 0) {
    for (const item of context.items) {
      if (typeof item?.name === 'string' && item.name.trim().length > 0) {
        names.push(item.name.trim());
      }
    }
  }
  if (names.length === 0 && context.email?.attachments && context.email.attachments.length > 0) {
    for (const att of context.email.attachments) {
      if (typeof att?.name === 'string' && att.name.trim().length > 0) {
        names.push(att.name.trim());
      }
    }
  }
  return names;
}

export function matchesCorrelatedCode(
  match: RegExpMatchArray,
  groupIndex: number | undefined,
  populatedFields: Record<string, unknown>
): boolean {
  if (groupIndex === undefined || groupIndex <= 1) {
    return true;
  }

  // Check section (+ number for groupIndex >= 3) correlation with uniform CSI delimiters
  const rawGroup1 = match[1]?.trim();
  if (
    rawGroup1 !== undefined &&
    /^(?:\d{6}|\d{2}([\s._-])\d{2}\1\d{2})$/.test(rawGroup1)
  ) {
    const normSection = normalizeDigits6Candidate(rawGroup1);
    if (normSection !== undefined) {
      if (
        populatedFields.section !== undefined &&
        normSection !== String(populatedFields.section)
      ) {
        return false;
      }
      if (groupIndex >= 3 && match[2] !== undefined) {
        const normNumber = normalizePad3Candidate(match[2]);
        if (
          normNumber !== undefined &&
          populatedFields.number !== undefined &&
          normNumber !== String(populatedFields.number)
        ) {
          return false;
        }
      }
    }
  }

  // Check specTag correlation (FF&E spec tag codes: group 1 = 2 letters + optional delimiter + 3 digits + optional letter)
  if (rawGroup1 !== undefined && /^[A-Za-z]{2}[\s._-]?\d{3}[A-Za-z]?$/.test(rawGroup1)) {
    const normMatchTag = normalizeCompactAlnumCandidate(rawGroup1);
    if (normMatchTag !== undefined && populatedFields.specTag !== undefined) {
      const populatedTag = String(populatedFields.specTag);
      const normPopulatedTag = normalizeCompactAlnumCandidate(populatedTag) ?? populatedTag.trim();
      if (normMatchTag.toLowerCase() !== normPopulatedTag.toLowerCase()) {
        return false;
      }
    }
  }

  return true;
}

export interface RuleExtractionContext {
  sourceContext: SourceContext;
  candidateAttachmentNames: string[];
  boundAttachmentName?: string | undefined;
  populatedFields: Record<string, unknown>;
  timeZone?: string | undefined;
  now?: (() => Date) | undefined;
}

export interface ExtractedCandidateResult {
  value: string;
  matchedTuple?: ParseTargetDocumentOptionTuple | undefined;
  matchedAttachmentName?: string | undefined;
}

interface RuleSourceItem {
  text: string;
  attachmentName?: string;
}

function computeDriveFileNameStem(name: string, mimeType?: string): string {
  if (mimeType && mimeType.startsWith('application/vnd.google-apps.')) {
    return name;
  }
  return name.replace(/\.[A-Za-z0-9]{1,8}$/, '');
}

function buildDriveJsonLogicContext(hierarchy: DriveItemHierarchy): Record<string, unknown> {
  const { item } = hierarchy;
  const ancestorNames = hierarchy.ancestors.map((a) => a.name);
  const mimeType = item.mimeType ?? '';
  return {
    id: item.id,
    fileName: item.name,
    fileNameStem: computeDriveFileNameStem(item.name, item.mimeType),
    mimeType,
    isFolder: mimeType === 'application/vnd.google-apps.folder',
    createdTime: item.createdTime ?? '',
    modifiedTime: item.modifiedTime ?? '',
    parentName: ancestorNames.length > 0 ? ancestorNames[ancestorNames.length - 1] : '',
    folderPath: ancestorNames.join('/'),
    ancestors: ancestorNames,
    driveId: hierarchy.driveId ?? '',
    driveName: hierarchy.driveName ?? '',
  };
}

function getDriveSourceText(fromSource: DriveExtractSource, hierarchy: DriveItemHierarchy): string {
  const { item } = hierarchy;
  switch (fromSource) {
    case 'drive.fileName':
      return item.name;
    case 'drive.fileNameStem':
      return computeDriveFileNameStem(item.name, item.mimeType);
    case 'drive.modifiedTime':
      return item.modifiedTime ?? '';
    case 'drive.createdTime':
      return item.createdTime ?? '';
    default:
      return '';
  }
}

function resolveRuleSourceItems(
  fromSource: GmailExtractSource,
  sourceContext: SourceContext,
  extractionContext: RuleExtractionContext,
  isLookup: boolean
): RuleSourceItem[] {
  if (fromSource === 'attachmentName') {
    const candidateNamesToTest =
      extractionContext.boundAttachmentName !== undefined
        ? [extractionContext.boundAttachmentName]
        : extractionContext.candidateAttachmentNames;
    return candidateNamesToTest.map((attName) => ({
      text: attName,
      attachmentName: attName,
    }));
  }

  if (fromSource === 'email.labels') {
    return extractNonSystemLabelTokens(sourceContext.email?.labels).map((token) => ({
      text: token,
    }));
  }

  if (isLookup && (fromSource === 'email.to' || fromSource === 'email.cc')) {
    const rawRecipientsText =
      fromSource === 'email.to'
        ? (sourceContext.email?.to ?? '')
        : (sourceContext.email?.cc ?? '');
    return splitRfc5322Recipients(rawRecipientsText).map((recipient) => ({
      text: recipient,
    }));
  }

  const sourceText = getSourceText(fromSource, sourceContext);
  return sourceText.trim().length > 0 ? [{ text: sourceText }] : [];
}

function isDateTimestampSource(fromSource: GmailExtractSource | DriveExtractSource): boolean {
  return (
    fromSource === 'email.date' ||
    fromSource === 'drive.modifiedTime' ||
    fromSource === 'drive.createdTime'
  );
}

function extractRuleCandidatesForText(
  text: string,
  fromSource: GmailExtractSource | DriveExtractSource,
  rule: { pattern?: string | undefined; flags?: string | undefined; group?: number | undefined },
  populatedFields: Record<string, unknown>,
  applyDateFormatting: boolean,
  timeZone?: string
): string[] {
  if (applyDateFormatting && isDateTimestampSource(fromSource) && !rule.pattern) {
    const formatted = parseDateToYymmdd(text, timeZone);
    return formatted !== undefined ? [formatted] : [];
  }
  return extractRegexMatchValues(text, rule, populatedFields);
}

function extractCandidateFromSourceItems(
  rule: GmailFieldRule | DriveFieldRule,
  sourceItems: RuleSourceItem[],
  fromSource: GmailExtractSource | DriveExtractSource | undefined,
  targetField: ParseTargetDocumentField,
  targetSchema: ParseTargetDocumentSchema | undefined,
  populatedFields: Record<string, unknown>,
  timeZone?: string,
  now?: () => Date
): ExtractedCandidateResult | undefined {
  if ('set' in rule) {
    const validated = validateCandidateWithTuple(rule.set, targetField, targetSchema);
    return validated !== undefined
      ? { value: validated.value, ...(validated.matchedTuple ? { matchedTuple: validated.matchedTuple } : {}) }
      : undefined;
  }

  if (!fromSource) {
    return undefined;
  }

  for (const item of sourceItems) {
    const candidates = extractRuleCandidatesForText(
      item.text,
      fromSource,
      rule,
      populatedFields,
      true,
      timeZone
    );
    for (const rawCandidate of candidates) {
      const normalizedCandidate = applyFieldCandidateNormalize(
        rawCandidate,
        'normalize' in rule ? rule.normalize : undefined,
        timeZone,
        now,
        fromSource,
        item.text
      );
      if (normalizedCandidate === undefined) {
        continue;
      }
      const validated = validateCandidateWithTuple(normalizedCandidate, targetField, targetSchema);
      if (validated !== undefined) {
        return {
          value: validated.value,
          ...(validated.matchedTuple ? { matchedTuple: validated.matchedTuple } : {}),
          ...(item.attachmentName !== undefined ? { matchedAttachmentName: item.attachmentName } : {}),
        };
      }
    }
  }

  return undefined;
}

function extractCandidateFromRule(
  rule: GmailFieldRule,
  targetField: ParseTargetDocumentField,
  targetSchema: ParseTargetDocumentSchema | undefined,
  extractionContext: RuleExtractionContext
): ExtractedCandidateResult | undefined {
  if ('set' in rule) {
    return extractCandidateFromSourceItems(
      rule,
      [],
      undefined,
      targetField,
      targetSchema,
      extractionContext.populatedFields,
      extractionContext.timeZone,
      extractionContext.now
    );
  }
  if (!('from' in rule)) {
    return undefined;
  }
  const sourceItems = resolveRuleSourceItems(
    rule.from,
    extractionContext.sourceContext,
    extractionContext,
    false
  );
  return extractCandidateFromSourceItems(
    rule,
    sourceItems,
    rule.from,
    targetField,
    targetSchema,
    extractionContext.populatedFields,
    extractionContext.timeZone,
    extractionContext.now
  );
}

export function splitRfc5322Recipients(input: string): string[] {
  if (!input || input.trim().length === 0) {
    return [];
  }
  const recipients: string[] = [];
  let current = '';
  let inQuotes = false;
  let isEscaped = false;

  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (isEscaped) {
      current += char;
      isEscaped = false;
      continue;
    }
    if (char === '\\') {
      current += char;
      isEscaped = true;
      continue;
    }
    if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
      continue;
    }
    if (char === ',' && !inQuotes) {
      const trimmed = current.trim();
      if (trimmed.length > 0) {
        recipients.push(trimmed);
      }
      current = '';
      continue;
    }
    current += char;
  }
  const trimmed = current.trim();
  if (trimmed.length > 0) {
    recipients.push(trimmed);
  }
  return recipients;
}

function getSourceText(fromSource: GmailExtractSource, sourceContext: SourceContext): string {
  const { email } = sourceContext;
  switch (fromSource) {
    case 'email.date':
      return email?.date ?? '';
    case 'email.subjectClean':
      return cleanSubject(email?.subject);
    case 'email.subject':
      return email?.subject ?? '';
    case 'email.plainTextBody':
      return email?.plainTextBody ?? '';
    case 'email.htmlBody':
      return email?.htmlBody ?? '';
    case 'email.body': {
      const { plainTextBody: rawPlain } = email ?? {};
      if (typeof rawPlain === 'string' && rawPlain.trim().length > 0) {
        return rawPlain.trim();
      }
      return normalizeHtmlBodyForPass2(email?.htmlBody);
    }
    case 'email.from':
      return email?.from ?? '';
    case 'email.to':
      return email?.to ?? '';
    case 'email.cc':
      return email?.cc ?? '';
    case 'email.labels':
      return (email?.labels ?? []).join(', ');
    default:
      return '';
  }
}

async function extractLookupCandidateFromSourceItems(
  rule: GmailLookupFieldRule | DriveLookupFieldRule,
  sourceItems: RuleSourceItem[],
  fromSource: GmailExtractSource | DriveExtractSource,
  request: ExtractFieldsRequest,
  targetField: ParseTargetDocumentField,
  targetSchema: ParseTargetDocumentSchema | undefined,
  deps: SourceParserServiceDeps | undefined,
  populatedFields: Record<string, unknown>,
  timeZone?: string
): Promise<{ value: string; matchedTuple: ParseTargetDocumentOptionTuple; matchedAttachmentName?: string } | undefined> {
  const excludeRegex = rule.excludePattern ? new RegExp(rule.excludePattern, 'i') : undefined;

  for (const item of sourceItems) {
    if (excludeRegex && excludeRegex.test(item.text)) {
      continue;
    }

    const candidates = extractRuleCandidatesForText(
      item.text,
      fromSource,
      rule,
      populatedFields,
      false
    );

    for (const candidateText of candidates) {
      const normalizedCandidate = applyFieldCandidateNormalize(
        candidateText,
        'normalize' in rule ? rule.normalize : undefined,
        timeZone,
        deps?.now,
        fromSource,
        item.text
      );
      if (normalizedCandidate === undefined || normalizedCandidate.trim().length === 0) {
        continue;
      }

      const match = await resolveCanonicalOptionFromCandidate(
        normalizedCandidate,
        targetField,
        request.spaceId,
        targetSchema,
        deps
          ? {
              ...deps,
              documentTypeKey: request.documentTypeKey,
              ...(request.selectedLogId !== undefined ? { selectedLogId: request.selectedLogId } : {}),
            }
          : {
              documentTypeKey: request.documentTypeKey,
              ...(request.selectedLogId !== undefined ? { selectedLogId: request.selectedLogId } : {}),
            }
      );
      if (match) {
        return {
          ...match,
          ...(item.attachmentName !== undefined ? { matchedAttachmentName: item.attachmentName } : {}),
        };
      }
    }
  }

  return undefined;
}

async function extractLookupCandidate(
  rule: GmailLookupFieldRule,
  request: ExtractFieldsRequest,
  targetField: ParseTargetDocumentField,
  targetSchema: ParseTargetDocumentSchema | undefined,
  deps: SourceParserServiceDeps | undefined,
  extractionContext: RuleExtractionContext
): Promise<{ value: string; matchedTuple: ParseTargetDocumentOptionTuple; matchedAttachmentName?: string } | undefined> {
  const sourceItems = resolveRuleSourceItems(
    rule.from,
    request.context,
    extractionContext,
    true
  );
  return extractLookupCandidateFromSourceItems(
    rule,
    sourceItems,
    rule.from,
    request,
    targetField,
    targetSchema,
    deps,
    extractionContext.populatedFields,
    extractionContext.timeZone
  );
}

export interface SourceParserServiceDeps {
  parseSchemaRegistry?: ParseSchemaRegistryPort | undefined;
  predicateEvaluator?: PredicateEvaluatorPort | undefined;
  fallbackExtractor?: FallbackFieldExtractorPort | undefined;
  canonicalOptionsProvider?: CanonicalOptionsProviderPort | undefined;
  formExtractor?: FormExtractorPort | undefined;
  formTemplateParser?: FormTemplateParserPort | undefined;
  configPort?: SourceParserConfigPort | undefined;
  now?: (() => Date) | undefined;
}

interface HydratedDriveItemContext {
  hierarchy: DriveItemHierarchy;
  driveContext: Record<string, unknown>;
}

function areExtractorFieldsPopulated(
  fields: Record<string, unknown>,
  populatedFields: Record<string, unknown>
): boolean {
  return Object.keys(fields).every((k) => k in populatedFields);
}

export class SourceParserService implements SourceParserPort {
  constructor(
    private readonly driveContextPort: DriveSourceContextPort,
    private readonly spaceConfigPort: SourceParserSpaceConfigPort,
    private readonly deps?: SourceParserServiceDeps | undefined
  ) {}

  async extractFields(request: ExtractFieldsRequest): Promise<ExtractedFieldsResult> {
    const populatedFields: Record<string, unknown> = {};

    if (request.existingData) {
      for (const [key, value] of Object.entries(request.existingData)) {
        if (
          typeof value === 'string'
            ? value.trim().length > 0
            : value !== undefined && value !== null
        ) {
          populatedFields[key] = value;
        }
      }
    }

    if (!this.deps?.parseSchemaRegistry) {
      return { fields: populatedFields };
    }

    let parseSchema: DocumentParseSchema | undefined;
    let targetSchema: ParseTargetDocumentSchema | undefined;

    try {
      parseSchema = await this.deps.parseSchemaRegistry.getParseSchema(request.documentTypeKey);
      targetSchema = await this.deps.parseSchemaRegistry.getTargetSchema(request.documentTypeKey);
    } catch (err) {
      console.warn(`Could not load parse schema for ${request.documentTypeKey}:`, err);
      return {
        fields: populatedFields,
        statusMessages: [`Could not load parse schema for ${request.documentTypeKey}`],
      };
    }

    if (!parseSchema || ((!parseSchema.extractors || parseSchema.extractors.length === 0) && !parseSchema.fallback)) {
      return { fields: populatedFields };
    }

    const statusMessages: string[] = [];
    const jsonLogicContext = buildJsonLogicContext(request.context);
    const candidateAttachmentNames = getCandidateAttachmentNames(request.context);
    const hydratedDriveItems = new Map<string, HydratedDriveItemContext>();
    let resolvedTimeZone: string | undefined;
    let timeZoneLoaded = false;

    const getWorkspaceTimeZone = async (): Promise<string | undefined> => {
      if (!timeZoneLoaded) {
        timeZoneLoaded = true;
        resolvedTimeZone = await this.deps?.configPort?.getWorkspaceTimeZone();
      }
      return resolvedTimeZone;
    };

    const getHydratedDriveItem = async (itemId: string): Promise<HydratedDriveItemContext> => {
      const existing = hydratedDriveItems.get(itemId);
      if (existing) {
        return existing;
      }
      const hierarchy = await this.driveContextPort.getItemHierarchy(itemId);
      const entry: HydratedDriveItemContext = {
        hierarchy,
        driveContext: buildDriveJsonLogicContext(hierarchy),
      };
      hydratedDriveItems.set(itemId, entry);
      return entry;
    };

    const validItemIds = (request.context.items ?? [])
      .map((item) => (typeof item?.id === 'string' ? item.id.trim() : ''))
      .filter((id) => id.length > 0);

    for (const extractor of parseSchema.extractors ?? []) {
      try {
        if (extractor.source === 'drive') {
          if (request.context.email && request.context.isDriveUrl !== true) {
            continue;
          }
          if (validItemIds.length === 0) {
            continue;
          }
          if (areExtractorFieldsPopulated(extractor.fields, populatedFields)) {
            continue;
          }
          const timeZone = await getWorkspaceTimeZone();
          await this.extractDriveExtractorFields({
            extractor,
            validItemIds,
            request,
            targetSchema,
            jsonLogicContext,
            populatedFields,
            timeZone,
            getHydratedDriveItem,
          });
          continue;
        }

        if (extractor.source === 'form') {
          const formResult = await extractFormExtractorFields({
            extractor,
            validItemIds,
            request,
            targetSchema,
            jsonLogicContext,
            existingFields: populatedFields,
            parseSchemaRegistry: this.deps.parseSchemaRegistry,
            formExtractor: this.deps.formExtractor,
            formTemplateParser: this.deps.formTemplateParser,
            canonicalOptionsProvider: this.deps.canonicalOptionsProvider,
            predicateEvaluator: this.deps.predicateEvaluator,
            getHydratedDriveItem,
          });
          Object.assign(populatedFields, formResult.fields);
          statusMessages.push(...formResult.statusMessages);
          continue;
        }

        if (extractor.source !== 'gmail') {
          continue;
        }

        if (!request.context.email) {
          continue;
        }

        if (!evaluateCondition(extractor.match, jsonLogicContext, this.deps.predicateEvaluator)) {
          continue;
        }

        if (areExtractorFieldsPopulated(extractor.fields, populatedFields)) {
          continue;
        }

        const timeZone = await getWorkspaceTimeZone();
        let boundAttachmentName: string | undefined = undefined;

        for (const [fieldKey, ruleOrRules] of Object.entries(extractor.fields)) {
          if (fieldKey in populatedFields) {
            continue;
          }

          const targetField = targetSchema?.fields.find((f) => f.key === fieldKey);
          if (!targetField) {
            continue;
          }

          const rules = Array.isArray(ruleOrRules) ? ruleOrRules : [ruleOrRules];
          for (const rule of rules) {
            if (!evaluateCondition(rule.when, jsonLogicContext, this.deps.predicateEvaluator)) {
              continue;
            }

            const extractionContext: RuleExtractionContext = {
              sourceContext: request.context,
              candidateAttachmentNames,
              boundAttachmentName,
              populatedFields,
              timeZone,
              now: this.deps?.now,
            };

            const result: ExtractedCandidateResult | undefined =
              'lookup' in rule && rule.lookup === true
                ? await extractLookupCandidate(
                    rule,
                    request,
                    targetField,
                    targetSchema,
                    this.deps,
                    extractionContext
                  )
                : extractCandidateFromRule(
                    rule as GmailFieldRule,
                    targetField,
                    targetSchema,
                    extractionContext
                  );

            if (result !== undefined) {
              if (boundAttachmentName === undefined && result.matchedAttachmentName !== undefined) {
                // nosemgrep: domain-pass-through-read
                boundAttachmentName = result.matchedAttachmentName;
              }
              const { value: candidateValue, matchedTuple } = result;
              populatedFields[fieldKey] = candidateValue;
              populateLinkedFields(fieldKey, matchedTuple, targetSchema, populatedFields);
              break;
            }
          }
        }
      } catch (err) {
        if (extractor.source === 'drive') {
          statusMessages.push(DRIVE_METADATA_EXTRACT_ERROR_MESSAGE);
        } else {
          const errorMsg = err instanceof Error ? err.message : String(err);
          statusMessages.push(
            `Could not extract fields from ${extractor.name ?? extractor.source}: ${errorMsg}`
          );
        }
      }
    }

    if (parseSchema.fallback && this.deps.fallbackExtractor) {
      const allTargetableKeys = (targetSchema?.fields ?? [])
        .filter((f) => !f.linkedField)
        .map((f) => f.key);
      const targetableKeys = parseSchema.fallback.fields
        ? parseSchema.fallback.fields.filter((k) => allTargetableKeys.includes(k))
        : allTargetableKeys;
      const unpopulatedTargetKeys = targetableKeys.filter((k) => !(k in populatedFields));

      if (unpopulatedTargetKeys.length > 0) {
        try {
          const fallbackResult = await this.deps.fallbackExtractor.extractFields({
            ...request,
            existingData: { ...populatedFields },
          });
          const unpopulatedSet = new Set(unpopulatedTargetKeys);
          const lookupFieldKeys = new Set<string>();
          for (const ext of parseSchema.extractors ?? []) {
            if (ext.source === 'gmail' || ext.source === 'drive') {
              for (const [fKey, ruleOrRules] of Object.entries(ext.fields)) {
                const rules = Array.isArray(ruleOrRules) ? ruleOrRules : [ruleOrRules];
                if (rules.some((r) => 'lookup' in r && r.lookup === true)) {
                  lookupFieldKeys.add(fKey);
                }
              }
            }
          }
          if (this.deps.parseSchemaRegistry.getDocumentFormSchema && this.deps.formTemplateParser) {
            const formSchema = await this.deps.parseSchemaRegistry.getDocumentFormSchema(
              request.documentTypeKey
            );
            if (formSchema) {
              for (const binding of Object.values(formSchema.fields)) {
                try {
                  const parsed = parseDocumentFieldTemplate(
                    this.deps.formTemplateParser,
                    binding.template
                  );
                  for (const token of parsed.tokens) {
                    const fld = targetSchema?.fields.find((f) => f.key === token.fieldKey);
                    if (fld?.options) {
                      lookupFieldKeys.add(token.fieldKey);
                    }
                  }
                } catch {
                  // Ignore invalid form templates during fallback lookup key discovery
                }
              }
            }
          }

          for (const [key, value] of Object.entries(fallbackResult ?? {})) {
            if (!unpopulatedSet.has(key) || key in populatedFields || value === undefined || value === null) {
              continue;
            }
            const targetField = targetSchema?.fields.find((f) => f.key === key);
            if (!targetField) {
              continue;
            }
            const strVal = typeof value === 'string' ? value : String(value);
            let accepted: ValidatedCandidate | undefined;
            if (targetField.options) {
              const useCanonicalLookup =
                targetSchema?.optionSources?.[targetField.options.source] !== undefined ||
                lookupFieldKeys.has(key) ||
                targetField.options.allowUserInput === true;
              accepted = useCanonicalLookup
                ? await resolveCanonicalOptionFromCandidate(
                    strVal,
                    targetField,
                    request.spaceId,
                    targetSchema,
                    {
                      ...this.deps,
                      documentTypeKey: request.documentTypeKey,
                      ...(request.selectedLogId !== undefined
                        ? { selectedLogId: request.selectedLogId }
                        : {}),
                    }
                  )
                : validateCandidateWithTuple(strVal, targetField, targetSchema);
            } else {
              accepted = validateCandidateWithTuple(strVal, targetField, targetSchema);
            }
            if (accepted) {
              const { value: acceptedVal, matchedTuple: acceptedTuple } = accepted;
              populatedFields[key] = acceptedVal;
              populateLinkedFields(key, acceptedTuple, targetSchema, populatedFields);
            }
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          statusMessages.push(`Fallback extraction failed: ${errorMsg}`);
        }
      }
    }

    const deduplicatedStatus =
      statusMessages.length > 0 ? Array.from(new Set(statusMessages)) : undefined;

    return {
      fields: populatedFields,
      ...(deduplicatedStatus ? { statusMessages: deduplicatedStatus } : {}),
    };
  }

  private async extractDriveExtractorFields(params: {
    extractor: DriveExtractorRule;
    validItemIds: string[];
    request: ExtractFieldsRequest;
    targetSchema: ParseTargetDocumentSchema | undefined;
    jsonLogicContext: Record<string, unknown>;
    populatedFields: Record<string, unknown>;
    timeZone: string | undefined;
    getHydratedDriveItem: (itemId: string) => Promise<HydratedDriveItemContext>;
  }): Promise<void> {
    const {
      extractor,
      validItemIds,
      request,
      targetSchema,
      jsonLogicContext,
      populatedFields,
      timeZone,
      getHydratedDriveItem,
    } = params;

    let boundDriveItemId: string | undefined = undefined;

    for (const [fieldKey, ruleOrRules] of Object.entries(extractor.fields)) {
      if (fieldKey in populatedFields) {
        continue;
      }

      const targetField = targetSchema?.fields.find((f) => f.key === fieldKey);
      if (!targetField) {
        continue;
      }

      const rules = Array.isArray(ruleOrRules) ? ruleOrRules : [ruleOrRules];
      for (const rule of rules) {
        const candidateItemIds: string[] = boundDriveItemId !== undefined ? [boundDriveItemId] : validItemIds;
        let fieldPopulated = false;

        for (const candidateItemId of candidateItemIds) {
          const { hierarchy, driveContext } = await getHydratedDriveItem(candidateItemId);
          const itemJsonLogicContext = { ...jsonLogicContext, drive: driveContext };

          if (!evaluateCondition(extractor.match, itemJsonLogicContext, this.deps?.predicateEvaluator)) {
            continue;
          }
          if (!evaluateCondition(rule.when, itemJsonLogicContext, this.deps?.predicateEvaluator)) {
            continue;
          }

          let result: ExtractedCandidateResult | undefined;
          if ('set' in rule) {
            result = extractCandidateFromSourceItems(
              rule,
              [],
              undefined,
              targetField,
              targetSchema,
              populatedFields,
              timeZone,
              this.deps?.now
            );
          } else if ('from' in rule) {
            const sourceText = getDriveSourceText(rule.from, hierarchy);
            const sourceItems: RuleSourceItem[] = sourceText.trim().length > 0 ? [{ text: sourceText }] : [];
            if ('lookup' in rule && rule.lookup === true) {
              result = await extractLookupCandidateFromSourceItems(
                rule,
                sourceItems,
                rule.from,
                request,
                targetField,
                targetSchema,
                this.deps,
                populatedFields,
                timeZone
              );
            } else {
              result = extractCandidateFromSourceItems(
                rule,
                sourceItems,
                rule.from,
                targetField,
                targetSchema,
                populatedFields,
                timeZone,
                this.deps?.now
              );
            }
          }

          if (result !== undefined) {
            if (boundDriveItemId === undefined) {
              // nosemgrep: domain-pass-through-read
              boundDriveItemId = candidateItemId;
            }
            const { value: candidateValue, matchedTuple } = result;
            populatedFields[fieldKey] = candidateValue;
            populateLinkedFields(fieldKey, matchedTuple, targetSchema, populatedFields);
            fieldPopulated = true;
            break;
          }
        }

        if (fieldPopulated) {
          break;
        }
      }
    }
  }

  async inferRouting(context: SourceContext): Promise<InferredRoutingResult> {
    const rawSpaceTypes = await this.spaceConfigPort.getDocumentSpaceTypes();
    const spaceTypes = rawSpaceTypes ?? [];

    const isDriveUrl =
      context.isDriveUrl === true ||
      (context.isDriveUrl === undefined && !context.email);

    if (context.email && !isDriveUrl) {
      return this.inferFromEmail(context, spaceTypes);
    }

    const rawItems = context.items ?? [];
    const validItems = rawItems.filter(
      (item) => typeof item?.id === 'string' && item.id.trim().length > 0
    );

    let winningSpaceTypeId: string | undefined;
    let winningSpaceIdOrName: string | undefined;
    let winningDocumentTypeKey: string | undefined;
    const statusMessages: string[] = [];

    if (validItems.length > 0) {
      try {
        for (const item of validItems) {
          const hierarchy = await this.driveContextPort.getItemHierarchy(item.id.trim());
          const itemResult = this.inferFromDriveHierarchy(hierarchy, spaceTypes);

          if (!winningSpaceTypeId) {
            if (itemResult.spaceTypeId) {
              // nosemgrep: domain-pass-through-read
              winningSpaceTypeId = itemResult.spaceTypeId;
              if (winningSpaceIdOrName === undefined && itemResult.spaceIdOrName !== undefined) {
                // nosemgrep: domain-pass-through-read
                winningSpaceIdOrName = itemResult.spaceIdOrName;
              }
              if (winningDocumentTypeKey === undefined && itemResult.documentTypeKey !== undefined) {
                // nosemgrep: domain-pass-through-read
                winningDocumentTypeKey = itemResult.documentTypeKey;
              }
            }
          } else {
            const isCompatible =
              itemResult.spaceTypeId === undefined || itemResult.spaceTypeId === winningSpaceTypeId;

            if (isCompatible) {
              if (winningSpaceIdOrName === undefined && itemResult.spaceIdOrName !== undefined) {
                // nosemgrep: domain-pass-through-read
                winningSpaceIdOrName = itemResult.spaceIdOrName;
              }
              if (winningDocumentTypeKey === undefined && itemResult.documentTypeKey !== undefined) {
                const spaceConfig = spaceTypes.find((st) => st.id === winningSpaceTypeId);
                const allowed = spaceConfig?.spaceSchema?.allowedDocumentTypes ?? [];
                if (allowed.length === 0 || allowed.includes(itemResult.documentTypeKey)) {
                  // nosemgrep: domain-pass-through-read
                  winningDocumentTypeKey = itemResult.documentTypeKey;
                }
              }
            }
          }

          if (
            winningSpaceTypeId !== undefined &&
            winningSpaceIdOrName !== undefined &&
            winningDocumentTypeKey !== undefined
          ) {
            break;
          }
        }
      } catch {
        statusMessages.push(DRIVE_HIERARCHY_ERROR_MESSAGE);
      }
    }

    if (context.email) {
      const emailResult = this.inferFromEmail(context, spaceTypes);

      if (emailResult.statusMessages) {
        statusMessages.push(...emailResult.statusMessages);
      }

      if (!winningSpaceTypeId && emailResult.spaceTypeId) {
        // nosemgrep: domain-pass-through-read
        winningSpaceTypeId = emailResult.spaceTypeId;
      }

      if (winningSpaceIdOrName === undefined && emailResult.spaceIdOrName !== undefined) {
        const matchedCandidate = context.candidateSpaces?.find((c) => c.id === emailResult.spaceIdOrName);
        const isCompatible =
          winningSpaceTypeId === undefined ||
          matchedCandidate?.typeId === undefined ||
          matchedCandidate.typeId === winningSpaceTypeId;
        if (isCompatible) {
          // nosemgrep: domain-pass-through-read
          winningSpaceIdOrName = emailResult.spaceIdOrName;
          if (!winningSpaceTypeId && matchedCandidate?.typeId) {
            // nosemgrep: domain-pass-through-read
            winningSpaceTypeId = matchedCandidate.typeId;
          }
        }
      }

      if (winningDocumentTypeKey === undefined && emailResult.documentTypeKey !== undefined) {
        if (winningSpaceTypeId) {
          const spaceConfig = spaceTypes.find((st) => st.id === winningSpaceTypeId);
          const allowed = spaceConfig?.spaceSchema?.allowedDocumentTypes ?? [];
          if (allowed.length === 0 || allowed.includes(emailResult.documentTypeKey)) {
            // nosemgrep: domain-pass-through-read
            winningDocumentTypeKey = emailResult.documentTypeKey;
          }
        } else {
          // nosemgrep: domain-pass-through-read
          winningDocumentTypeKey = emailResult.documentTypeKey;
          winningSpaceTypeId = findSpaceTypeForDocumentType(spaceTypes, emailResult.documentTypeKey);
        }
      }
    }

    const deduplicatedStatus =
      statusMessages.length > 0 ? Array.from(new Set(statusMessages)) : undefined;

    return {
      ...(winningSpaceTypeId !== undefined ? { spaceTypeId: winningSpaceTypeId } : {}),
      ...(winningSpaceIdOrName !== undefined ? { spaceIdOrName: winningSpaceIdOrName } : {}),
      ...(winningDocumentTypeKey !== undefined ? { documentTypeKey: winningDocumentTypeKey } : {}),
      ...(deduplicatedStatus ? { statusMessages: deduplicatedStatus } : {}),
    };
  }

  private inferFromEmail(
    context: SourceContext,
    spaceTypes: SourceParserSpaceTypeConfig[]
  ): InferredRoutingResult {
    const email = context.email!;
    const attachmentFilenames: string[] = [];

    if (context.items) {
      for (const item of context.items) {
        if (item?.name && typeof item.name === 'string' && item.name.trim().length > 0) {
          attachmentFilenames.push(item.name.trim());
        }
      }
    }

    if (email.attachments) {
      for (const att of email.attachments) {
        // nosemgrep: domain-pass-through-read
        const name = att.name;
        if (name && typeof name === 'string' && name.trim().length > 0) {
          const trimmed = name.trim();
          if (!attachmentFilenames.includes(trimmed)) {
            attachmentFilenames.push(trimmed);
          }
        }
      }
    }

    let inferredDocType: string | undefined;
    let inferredDocTypeSpaceTypeId: string | undefined;

    // 1. Inspect candidate/selected attachment filenames in order
    for (const filename of attachmentFilenames) {
      const match = inferSubmittalTypeFromText(filename);
      if (match) {
        inferredDocType = match;
        inferredDocTypeSpaceTypeId = findSpaceTypeForDocumentType(spaceTypes, match);
        break;
      }
    }

    const nonSystemLabelTokens = extractNonSystemLabelTokens(email.labels);

    // 2. Inspect non-system labels for specific submittal codes
    if (!inferredDocType && nonSystemLabelTokens.length > 0) {
      for (const token of nonSystemLabelTokens) {
        const match = inferSubmittalTypeFromText(token);
        if (match) {
          inferredDocType = match;
          inferredDocTypeSpaceTypeId = findSpaceTypeForDocumentType(spaceTypes, match);
          break;
        }
      }
    }

    // 3. Inspect subject for specific submittal codes
    if (!inferredDocType && email.subject && typeof email.subject === 'string' && email.subject.trim().length > 0) {
      const match = inferSubmittalTypeFromText(email.subject);
      if (match) {
        inferredDocType = match;
        inferredDocTypeSpaceTypeId = findSpaceTypeForDocumentType(spaceTypes, match);
      }
    }

    // 4. Inspect body text for specific submittal codes (plainTextBody or derived from htmlBody)
    // nosemgrep: domain-pass-through-read
    const rawPlain = email.plainTextBody;
    const hasPlain = typeof rawPlain === 'string' && rawPlain.trim().length > 0;
    const bodyText = hasPlain
      ? rawPlain.trim()
      : extractTextFromHtml(email.htmlBody);

    if (!inferredDocType && bodyText.length > 0) {
      const match = inferSubmittalTypeFromText(bodyText);
      if (match) {
        inferredDocType = match;
        inferredDocTypeSpaceTypeId = findSpaceTypeForDocumentType(spaceTypes, match);
      }
    }

    // 5. If none matched specific codes, check for generic Submittal / Submittals token in non-system labels -> submittal-arch
    if (!inferredDocType && nonSystemLabelTokens.length > 0) {
      for (const token of nonSystemLabelTokens) {
        if (GENERIC_SUBMITTAL_REGEX.test(token)) {
          inferredDocType = 'submittal-arch';
          inferredDocTypeSpaceTypeId = findSpaceTypeForDocumentType(spaceTypes, 'submittal-arch');
          break;
        }
      }
    }

    // 6. Candidate spaces matching in labels first, subject second, body text third
    const winningCandidate = matchCandidateSpaces(
      context.candidateSpaces,
      email.subject,
      bodyText,
      email.labels
    );

    let winningSpaceTypeId: string | undefined;
    let winningSpaceIdOrName: string | undefined;

    if (inferredDocTypeSpaceTypeId !== undefined) {
      winningSpaceTypeId = inferredDocTypeSpaceTypeId;
      if (winningCandidate) {
        // nosemgrep: domain-pass-through-read
        const candidateType = winningCandidate.typeId;
        const isCompatible = candidateType === undefined || candidateType === inferredDocTypeSpaceTypeId;
        if (isCompatible) {
          // nosemgrep: domain-pass-through-read
          winningSpaceIdOrName = winningCandidate.id;
        }
      }
    } else if (winningCandidate) {
      // nosemgrep: domain-pass-through-read
      winningSpaceIdOrName = winningCandidate.id;
      if (winningCandidate.typeId !== undefined) {
        // nosemgrep: domain-pass-through-read
        winningSpaceTypeId = winningCandidate.typeId;
      }
    }

    return {
      ...(winningSpaceTypeId !== undefined ? { spaceTypeId: winningSpaceTypeId } : {}),
      ...(winningSpaceIdOrName !== undefined ? { spaceIdOrName: winningSpaceIdOrName } : {}),
      ...(inferredDocType !== undefined ? { documentTypeKey: inferredDocType } : {}),
    };
  }

  private inferFromDriveHierarchy(
    hierarchy: DriveItemHierarchy,
    spaceTypes: SourceParserSpaceTypeConfig[]
  ): InferredRoutingResult {
    let winningSpaceTypeId: string | undefined;
    let winningSpaceIdOrName: string | undefined;

    const folderBackedTypes = spaceTypes.filter(
      (st) => st.storageConfig?.fetchMethod === 'folders'
    );
    const sharedDrivesTypes = spaceTypes.filter(
      (st) => st.storageConfig?.fetchMethod === 'shared_drives'
    );

    const dedicatedSharedDriveNames = new Set(
      folderBackedTypes
        .map((st) =>
          typeof st.storageConfig?.sharedDriveName === 'string'
            ? st.storageConfig.sharedDriveName.trim().toLowerCase()
            : undefined
        )
        .filter((name): name is string => name !== undefined && name.length > 0)
    );

    // 1. Evaluate folder-backed space types first
    for (const spaceType of folderBackedTypes) {
      const cfg = spaceType.storageConfig as SourceParserSpaceTypeConfig['storageConfig'];
      const expectedSharedDriveName =
        typeof cfg?.sharedDriveName === 'string'
          ? cfg.sharedDriveName.trim().toLowerCase()
          : undefined;
      const expectedParentFolderName =
        typeof cfg?.parentFolderName === 'string'
          ? cfg.parentFolderName.trim().toLowerCase()
          : undefined;

      if (expectedSharedDriveName) {
        const actualDriveName = hierarchy.driveName?.trim().toLowerCase();
        if (actualDriveName !== expectedSharedDriveName) {
          continue;
        }
      }

      if (expectedParentFolderName) {
        const parentIndex = hierarchy.ancestors.findIndex(
          (a) => a.name.trim().toLowerCase() === expectedParentFolderName
        );

        if (parentIndex !== -1) {
          winningSpaceTypeId = spaceType.id as string;
          if (parentIndex + 1 < hierarchy.ancestors.length) {
            const childFolder = hierarchy.ancestors[parentIndex + 1];
            winningSpaceIdOrName = childFolder.id as string;
          } else {
            winningSpaceIdOrName = hierarchy.item.id as string;
          }
          break;
        }
      }
    }

    // 2. Evaluate Shared-Drive-backed space types second
    if (!winningSpaceTypeId) {
      const itemDriveId = hierarchy.driveId?.trim();
      const itemDriveName = hierarchy.driveName?.trim().toLowerCase();

      if (itemDriveId && (!itemDriveName || !dedicatedSharedDriveNames.has(itemDriveName))) {
        for (const spaceType of sharedDrivesTypes) {
          winningSpaceTypeId = spaceType.id as string;
          winningSpaceIdOrName = itemDriveId;
          break;
        }
      }
    }

    // 3. DocumentType inference from ancestor folder paths
    let documentTypeKey = this.inferDocumentTypeFromHierarchy(
      hierarchy,
      winningSpaceTypeId
    );

    // 4. Underscore-safe submittal filename fallback when ancestor folder paths do not resolve a DocumentType
    if (!documentTypeKey) {
      const filenameMatch = inferDocumentTypeFromFilename(hierarchy.item.name);
      if (filenameMatch) {
        documentTypeKey = filenameMatch;
        if (!winningSpaceTypeId) {
          winningSpaceTypeId = findSpaceTypeForDocumentType(spaceTypes, documentTypeKey);
        }
      }
    }

    return {
      ...(winningSpaceTypeId !== undefined ? { spaceTypeId: winningSpaceTypeId } : {}),
      ...(winningSpaceIdOrName !== undefined ? { spaceIdOrName: winningSpaceIdOrName } : {}),
      ...(documentTypeKey !== undefined ? { documentTypeKey } : {}),
    };
  }

  private inferDocumentTypeFromHierarchy(
    hierarchy: DriveItemHierarchy,
    spaceTypeId?: string
  ): string | undefined {
    if (spaceTypeId === 'proposals') {
      return 'communication-proposal';
    }

    const ancestorNames = hierarchy.ancestors.map((a) => a.name.trim().toLowerCase());

    const has6Construction = ancestorNames.some(
      (name) =>
        name === '6 construction' ||
        name.startsWith('6 construction/') ||
        name.startsWith('6 construction /')
    );
    if (has6Construction) {
      return 'submittal-arch';
    }

    const has3FFE = ancestorNames.some(
      (name) =>
        name === '3 ffe' ||
        name.startsWith('3 ffe/') ||
        name.startsWith('3 ffe /')
    );
    if (has3FFE) {
      return 'submittal-ffe';
    }

    const has1AdminComm = ancestorNames.some(
      (name) =>
        name === '1 admin/communication' ||
        name === '1 admin / communication'
    );
    if (has1AdminComm) {
      return 'communication-project';
    }

    const adminIndex = ancestorNames.findIndex((name) => name === '1 admin');
    if (
      adminIndex !== -1 &&
      ancestorNames.slice(adminIndex + 1).some((n) => n.includes('communication'))
    ) {
      return 'communication-project';
    }

    return undefined;
  }
}
