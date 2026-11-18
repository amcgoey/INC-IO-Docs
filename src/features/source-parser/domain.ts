import type {
  DriveItemHierarchy,
  SourceContext,
  InferredRoutingResult,
  ExtractFieldsRequest,
  ExtractedFieldsResult,
  SourceParserSpaceTypeConfig,
  DriveSourceContextPort,
  SourceParserSpaceConfigPort,
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
  CanonicalOptionsProviderPort,
  ParseTargetDocumentOptionTuple,
} from './ports';

export const CSI_SECTION_REGEX = /(?<=^|[\s_.-])\d{6}-\d{3}(?:-[A-Za-z0-9]+)?(?=[\s_.-]|$)/;
export const FFE_SPEC_TAG_REGEX = /(?<=^|[\s_.-])[A-Za-z]{2}\d{3}[A-Za-z]?-[A-Za-z0-9]+(?=[\s_.-]|$)/i;
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

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
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

export function parseDateToYymmdd(dateString?: string): string | undefined {
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

  const effectiveOffset = offsetMinutes ?? 0;
  const targetMs = parsed.getTime() + effectiveOffset * 60_000;
  const targetDate = new Date(targetMs);

  const yy = String(targetDate.getUTCFullYear()).slice(-2);
  const mm = String(targetDate.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(targetDate.getUTCDate()).padStart(2, '0');

  return `${yy}${mm}${dd}`;
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

export function extractEmailDomain(fromAddress: string): string {
  const atIndex = fromAddress.lastIndexOf('@');
  return atIndex !== -1 ? fromAddress.slice(atIndex + 1).toLowerCase() : '';
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

function getTupleKey(tuple: ParseTargetDocumentOptionTuple, keyProp: string): string {
  if (tuple[keyProp] !== undefined && tuple[keyProp] !== null) {
    return String(tuple[keyProp]);
  }
  if (tuple.key !== undefined && tuple.key !== null) {
    return String(tuple.key);
  }
  return '';
}

function getTupleName(tuple: ParseTargetDocumentOptionTuple, nameProp: string): string | undefined {
  const raw = tuple[nameProp] ?? tuple.name;
  if (raw === undefined || raw === null) {
    return undefined;
  }
  const str = String(raw);
  return str.length > 0 ? str : undefined;
}

function passesFieldConstraints(
  value: string,
  targetField: ParseTargetDocumentField
): boolean {
  if (targetField.minLength !== undefined && value.length < targetField.minLength) {
    return false;
  }
  if (targetField.pattern !== undefined) {
    const regex = new RegExp(targetField.pattern);
    if (!regex.test(value)) {
      return false;
    }
  }
  return true;
}

interface ValidatedCandidate {
  value: string;
  matchedTuple?: ParseTargetDocumentOptionTuple | undefined;
}

function validateCandidateWithTuple(
  candidate: string | undefined,
  targetField: ParseTargetDocumentField,
  targetSchema?: ParseTargetDocumentSchema
): ValidatedCandidate | undefined {
  if (candidate === undefined || candidate === null) {
    return undefined;
  }
  const trimmed = String(candidate).trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  if (targetField.options !== undefined) {
    // nosemgrep: domain-pass-through-read
    const { source: sourceKey, key: optKey, name: optName } = targetField.options;
    const keyProp = optKey ?? 'key';
    const nameProp = optName ?? 'name';
    const optionTuples = targetSchema?.options?.[sourceKey] ?? [];
    const matched = optionTuples.find((tuple) => {
      const tupleKey = getTupleKey(tuple, keyProp);
      const tupleName = getTupleName(tuple, nameProp);
      return (
        tupleKey === trimmed ||
        (tupleName !== undefined && tupleName.toLowerCase() === trimmed.toLowerCase())
      );
    });
    if (!matched) {
      return undefined;
    }
    const emittedValue = getTupleKey(matched, keyProp);
    if (!passesFieldConstraints(emittedValue, targetField)) {
      return undefined;
    }
    return { value: emittedValue, matchedTuple: matched };
  }
  if (!passesFieldConstraints(trimmed, targetField)) {
    return undefined;
  }
  return { value: trimmed };
}

function populateLinkedFields(
  fieldKey: string,
  matchedTuple: ParseTargetDocumentOptionTuple | undefined,
  targetSchema: ParseTargetDocumentSchema | undefined,
  populatedFields: Record<string, unknown>
): void {
  if (!matchedTuple || !targetSchema?.fields) {
    return;
  }
  for (const sibling of targetSchema.fields) {
    if (
      sibling.linkedField &&
      sibling.linkedField.sourceField === fieldKey &&
      !(sibling.key in populatedFields)
    ) {
      const propVal = matchedTuple[sibling.linkedField.sourceProperty];
      if (
        propVal !== undefined &&
        propVal !== null &&
        (typeof propVal === 'string' ? propVal.trim().length > 0 : true)
      ) {
        populatedFields[sibling.key] = String(propVal);
      }
    }
  }
}

function extractRegexMatchValue(
  text: string,
  rule: { pattern?: string | undefined; flags?: string | undefined; group?: number | undefined },
  populatedFields: Record<string, unknown>
): string | undefined {
  if (!rule.pattern) {
    return text;
  }
  const flags = typeof rule.flags === 'string' ? rule.flags : 'i';
  const regex = new RegExp(rule.pattern, flags);
  const match = text.match(regex);
  if (!match) {
    return undefined;
  }
  if (!matchesCorrelatedCode(match, rule.group, populatedFields)) {
    return undefined;
  }
  const { group: groupIndex } = rule;
  if (groupIndex !== undefined && match[groupIndex] !== undefined) {
    return match[groupIndex];
  }
  if (match[1] !== undefined) {
    return match[1];
  }
  return match[0];
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

  // Check section + number correlation (CSI codes: group 1 = 6 digits, group 2 = 3 digits)
  if (groupIndex >= 3 && match[1] !== undefined && match[2] !== undefined) {
    if (/^\d{6}$/.test(match[1]) && /^\d{3}$/.test(match[2])) {
      if (
        populatedFields.section !== undefined &&
        match[1] !== String(populatedFields.section)
      ) {
        return false;
      }
      if (
        populatedFields.number !== undefined &&
        match[2] !== String(populatedFields.number)
      ) {
        return false;
      }
    }
  }

  // Check specTag correlation (FF&E spec tag codes: group 1 = 2 letters + 3 digits + optional letter)
  if (groupIndex >= 2 && match[1] !== undefined) {
    if (/^[A-Za-z]{2}\d{3}[A-Za-z]?$/i.test(match[1])) {
      if (
        populatedFields.specTag !== undefined &&
        match[1].toLowerCase() !== String(populatedFields.specTag).toLowerCase()
      ) {
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
}

export interface ExtractedCandidateResult {
  value: string;
  matchedTuple?: ParseTargetDocumentOptionTuple | undefined;
  matchedAttachmentName?: string | undefined;
}

function extractCandidateFromRule(
  rule: GmailFieldRule,
  targetField: ParseTargetDocumentField,
  targetSchema: ParseTargetDocumentSchema | undefined,
  extractionContext: RuleExtractionContext
): ExtractedCandidateResult | undefined {
  if ('set' in rule) {
    const validated = validateCandidateWithTuple(rule.set, targetField, targetSchema);
    return validated !== undefined
      ? { value: validated.value, ...(validated.matchedTuple ? { matchedTuple: validated.matchedTuple } : {}) }
      : undefined;
  }

  if (!('from' in rule)) {
    return undefined;
  }

  const { from: fromSource } = rule;
  const { sourceContext } = extractionContext;
  const { email } = sourceContext;

  if (fromSource === 'attachmentName') {
    const candidateNamesToTest =
      extractionContext.boundAttachmentName !== undefined
        ? [extractionContext.boundAttachmentName]
        : extractionContext.candidateAttachmentNames;

    for (const attName of candidateNamesToTest) {
      const rawCandidate = extractRegexMatchValue(attName, rule, extractionContext.populatedFields);
      const validated = validateCandidateWithTuple(rawCandidate, targetField, targetSchema);
      if (validated !== undefined) {
        return {
          value: validated.value,
          ...(validated.matchedTuple ? { matchedTuple: validated.matchedTuple } : {}),
          matchedAttachmentName: attName,
        };
      }
    }
    return undefined;
  }

  if (fromSource === 'email.labels') {
    const tokens = extractNonSystemLabelTokens(email?.labels);
    for (const token of tokens) {
      const candidateForToken = extractRegexMatchValue(token, rule, extractionContext.populatedFields);
      const validated = validateCandidateWithTuple(candidateForToken, targetField, targetSchema);
      if (validated !== undefined) {
        return {
          value: validated.value,
          ...(validated.matchedTuple ? { matchedTuple: validated.matchedTuple } : {}),
        };
      }
    }
    return undefined;
  }

  const sourceText = getSourceText(fromSource, sourceContext);
  const rawCandidate =
    fromSource === 'email.date' && !rule.pattern
      ? parseDateToYymmdd(sourceText)
      : extractRegexMatchValue(sourceText, rule, extractionContext.populatedFields);

  const validated = validateCandidateWithTuple(rawCandidate, targetField, targetSchema);
  return validated !== undefined
    ? { value: validated.value, ...(validated.matchedTuple ? { matchedTuple: validated.matchedTuple } : {}) }
    : undefined;
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

export interface ParsedRecipient {
  raw: string;
  displayName?: string | undefined;
  email?: string | undefined;
  domain?: string | undefined;
}

export function parseRecipient(recipient: string): ParsedRecipient {
  const trimmed = recipient.trim();
  if (!trimmed) {
    return { raw: '' };
  }

  const angleMatch = trimmed.match(/^(?:["']?([^"']*)["']?\s*)?<([^>]+)>$/);
  if (angleMatch) {
    const rawName = angleMatch[1]?.trim();
    const email = angleMatch[2]?.trim();
    const domain = email && email.includes('@') ? email.split('@')[1]?.toLowerCase() : undefined;
    const displayName = rawName && rawName.length > 0 ? rawName : undefined;
    return {
      raw: trimmed,
      displayName,
      email,
      domain,
    };
  }

  if (trimmed.includes('@')) {
    const email = trimmed;
    const domain = email.split('@')[1]?.toLowerCase();
    return {
      raw: trimmed,
      email,
      domain,
    };
  }

  return {
    raw: trimmed,
    displayName: trimmed,
  };
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

interface TierOption {
  tuple: ParseTargetDocumentOptionTuple;
  aliases: string[];
}

type TierMatchOutcome =
  | { kind: 'matched'; tuple: ParseTargetDocumentOptionTuple }
  | { kind: 'ambiguous' }
  | { kind: 'none' };

function extractEmailTokens(candidate: string, parsed: ParsedRecipient): string[] {
  const tokens = new Set<string>();
  if (parsed.email && !/\s/.test(parsed.email)) {
    tokens.add(parsed.email.toLowerCase());
  }
  const matches = candidate.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g);
  if (matches) {
    for (const m of matches) {
      tokens.add(m.toLowerCase());
    }
  }
  return [...tokens];
}

function matchEmailOrDomainInTier(
  candidate: string,
  emailTokens: string[],
  options: TierOption[],
  keyProp: string
): TierMatchOutcome {
  const matches = new Map<string, ParseTargetDocumentOptionTuple>();
  const candidateLower = candidate.trim().toLowerCase();
  const bareAtDomain =
    candidateLower.startsWith('@') && !/\s/.test(candidateLower)
      ? candidateLower.slice(1)
      : undefined;

  for (const opt of options) {
    const tupleKey = getTupleKey(opt.tuple, keyProp);
    for (const alias of opt.aliases) {
      const aliasLower = alias.trim().toLowerCase();
      if (aliasLower.length === 0) {
        continue;
      }

      if (aliasLower.startsWith('@')) {
        const aliasDomain = aliasLower.slice(1);
        if (aliasDomain.length === 0) {
          continue;
        }
        const matchesTokenDomain = emailTokens.some((token) => {
          const domain = extractEmailDomain(token);
          return domain === aliasDomain || domain.endsWith(`.${aliasDomain}`);
        });
        const matchesBareDomain =
          bareAtDomain !== undefined &&
          (bareAtDomain === aliasDomain || bareAtDomain.endsWith(`.${aliasDomain}`));
        if (matchesTokenDomain || matchesBareDomain) {
          matches.set(tupleKey, opt.tuple);
          break;
        }
      } else if (aliasLower.includes('@') && emailTokens.includes(aliasLower)) {
        matches.set(tupleKey, opt.tuple);
        break;
      }
    }
  }

  if (matches.size === 1) {
    return { kind: 'matched', tuple: [...matches.values()][0] };
  }
  if (matches.size > 1) {
    return { kind: 'ambiguous' };
  }
  return { kind: 'none' };
}

function matchExactInTier(
  candidate: string,
  parsed: ParsedRecipient,
  options: TierOption[],
  keyProp: string,
  nameProp: string,
  includeCanonical: boolean
): TierMatchOutcome {
  const matches = new Map<string, ParseTargetDocumentOptionTuple>();
  const candidateLower = candidate.trim().toLowerCase();
  const displayNameLower = parsed.displayName ? parsed.displayName.trim().toLowerCase() : undefined;

  for (const opt of options) {
    const tupleKey = getTupleKey(opt.tuple, keyProp);
    const keyLower = tupleKey.trim().toLowerCase();
    const tupleName = getTupleName(opt.tuple, nameProp);
    const nameLower = tupleName ? tupleName.trim().toLowerCase() : undefined;
    const aliasLowers = opt.aliases.map((a) => a.trim().toLowerCase());

    const matchesTarget = (valLower: string): boolean =>
      aliasLowers.includes(valLower) ||
      (includeCanonical &&
        ((keyLower.length > 0 && valLower === keyLower) ||
          (nameLower !== undefined && valLower === nameLower)));

    if (matchesTarget(candidateLower) || (displayNameLower !== undefined && matchesTarget(displayNameLower))) {
      matches.set(tupleKey, opt.tuple);
    }
  }

  if (matches.size === 1) {
    return { kind: 'matched', tuple: [...matches.values()][0] };
  }
  if (matches.size > 1) {
    return { kind: 'ambiguous' };
  }
  return { kind: 'none' };
}

function matchBoundedPhraseInTier(
  candidate: string,
  options: TierOption[],
  keyProp: string,
  nameProp: string,
  includeCanonical: boolean
): TierMatchOutcome {
  const step3Matches = new Map<string, { tuple: ParseTargetDocumentOptionTuple; longestNeedle: string }>();
  const haystack = candidate;

  for (const opt of options) {
    const tupleKey = getTupleKey(opt.tuple, keyProp);
    let longestMatchedNeedle: string | undefined;

    if (includeCanonical) {
      const tupleName = getTupleName(opt.tuple, nameProp);
      if (tupleName) {
        const nameTrimmed = tupleName.trim();
        if (nameTrimmed.length >= 4) {
          const regex = new RegExp(
            `(?<=^|[\\s<(\\[_,;:"'-])${escapeRegExp(nameTrimmed)}(?=[\\s>)\\]_,;:."'-]|$)`,
            'i'
          );
          if (regex.test(haystack)) {
            longestMatchedNeedle = nameTrimmed;
          }
        }
      }
    }

    for (const alias of opt.aliases) {
      const aliasTrimmed = alias.trim();
      if (aliasTrimmed.length >= 4) {
        const regex = new RegExp(
          `(?<=^|[\\s<(\\[_,;:"'-])${escapeRegExp(aliasTrimmed)}(?=[\\s>)\\]_,;:."'-]|$)`,
          'i'
        );
        if (regex.test(haystack)) {
          if (!longestMatchedNeedle || aliasTrimmed.length > longestMatchedNeedle.length) {
            longestMatchedNeedle = aliasTrimmed;
          }
        }
      } else if (aliasTrimmed.length === 2 || aliasTrimmed.length === 3) {
        const regex = new RegExp(
          `(?<=^|[\\s<(\\[_,;:"'-])${escapeRegExp(aliasTrimmed)}(?=[\\s>)\\]_,;:."'-]|$)`
        );
        if (regex.test(haystack)) {
          if (!longestMatchedNeedle || aliasTrimmed.length > longestMatchedNeedle.length) {
            longestMatchedNeedle = aliasTrimmed;
          }
        }
      }
    }

    if (longestMatchedNeedle) {
      step3Matches.set(tupleKey, {
        tuple: opt.tuple,
        longestNeedle: longestMatchedNeedle,
      });
    }
  }

  if (step3Matches.size === 0) {
    return { kind: 'none' };
  }
  if (step3Matches.size === 1) {
    return { kind: 'matched', tuple: [...step3Matches.values()][0].tuple };
  }

  const matches = [...step3Matches.values()].sort(
    (a, b) => b.longestNeedle.length - a.longestNeedle.length
  );
  const best = matches[0];
  const second = matches[1];

  if (best.longestNeedle.length === second.longestNeedle.length) {
    return { kind: 'ambiguous' };
  }

  const bestLower = best.longestNeedle.toLowerCase();
  for (let i = 1; i < matches.length; i++) {
    const other = matches[i];
    if (other.longestNeedle.length >= best.longestNeedle.length) {
      return { kind: 'ambiguous' };
    }
    if (!bestLower.includes(other.longestNeedle.toLowerCase())) {
      return { kind: 'ambiguous' };
    }
  }

  return { kind: 'matched', tuple: best.tuple };
}

async function resolveCanonicalOptionFromCandidate(
  candidate: string,
  targetField: ParseTargetDocumentField,
  spaceId: string | undefined,
  targetSchema: ParseTargetDocumentSchema | undefined,
  deps: SourceParserServiceDeps | undefined
): Promise<{ value: string; matchedTuple: ParseTargetDocumentOptionTuple } | undefined> {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  const parsed = parseRecipient(trimmed);
  const emailTokens = extractEmailTokens(trimmed, parsed);

  let canonicalTuples: ParseTargetDocumentOptionTuple[] = [];

  if (targetField.options?.dynamicConfig) {
    const cleanSpace = spaceId ? spaceId.trim() : '';
    if (!cleanSpace || !deps?.canonicalOptionsProvider) {
      return undefined;
    }
    canonicalTuples = await deps.canonicalOptionsProvider.getCanonicalOptions(cleanSpace, targetField);
  } else if (targetField.options?.source) {
    canonicalTuples = targetSchema?.options?.[targetField.options.source] ?? [];
  }

  if (!canonicalTuples || canonicalTuples.length === 0) {
    return undefined;
  }

  const keyProp = targetField.options?.key ?? 'key';
  const nameProp = targetField.options?.name ?? 'name';
  const sourceKey = targetField.options?.source ?? '';
  const localTuples = targetSchema?.options?.[sourceKey] ?? [];
  const localTuplesMap = new Map<string, ParseTargetDocumentOptionTuple>();
  for (const t of localTuples) {
    localTuplesMap.set(getTupleKey(t, keyProp), t);
  }
  const sharedDict = deps?.parseSchemaRegistry?.getAliasDictionary?.(sourceKey);

  const seenNormalizedAliases = new Set<string>();

  // Tier 1: Local option aliases
  const tier1: TierOption[] = [];
  for (const tuple of canonicalTuples) {
    const tupleKey = getTupleKey(tuple, keyProp);
    const localTuple = localTuplesMap.get(tupleKey);
    const rawAliases = (localTuple?.aliases ?? []).filter((a) => typeof a === 'string' && a.trim().length > 0);
    for (const a of rawAliases) {
      seenNormalizedAliases.add(a.trim().toLowerCase());
    }
    tier1.push({ tuple, aliases: rawAliases });
  }

  // Tier 2: Dynamic option aliases (from tuple.aliases)
  const tier2: TierOption[] = [];
  for (const tuple of canonicalTuples) {
    const rawAliases = (tuple.aliases ?? []).filter((a) => typeof a === 'string' && a.trim().length > 0);
    const filtered = rawAliases.filter((a) => !seenNormalizedAliases.has(a.trim().toLowerCase()));
    for (const a of filtered) {
      seenNormalizedAliases.add(a.trim().toLowerCase());
    }
    tier2.push({ tuple, aliases: filtered });
  }

  // Tier 3: Shared Manifest AliasDictionary
  const tier3: TierOption[] = [];
  for (const tuple of canonicalTuples) {
    const tupleKey = getTupleKey(tuple, keyProp);
    const rawAliases = (sharedDict?.mappings?.[tupleKey] ?? []).filter(
      (a) => typeof a === 'string' && a.trim().length > 0
    );
    const filtered = rawAliases.filter((a) => !seenNormalizedAliases.has(a.trim().toLowerCase()));
    tier3.push({ tuple, aliases: filtered });
  }

  const tiers = [tier1, tier2, tier3];
  const stepEvaluators: Array<(tierOptions: TierOption[], tierIndex: number) => TierMatchOutcome> = [
    (tierOptions) => matchEmailOrDomainInTier(trimmed, emailTokens, tierOptions, keyProp),
    (tierOptions, tierIndex) =>
      matchExactInTier(trimmed, parsed, tierOptions, keyProp, nameProp, tierIndex === 0),
    (tierOptions, tierIndex) =>
      matchBoundedPhraseInTier(trimmed, tierOptions, keyProp, nameProp, tierIndex === 0),
  ];

  let matchedTuple: ParseTargetDocumentOptionTuple | undefined;
  for (const evaluateStep of stepEvaluators) {
    for (let tierIndex = 0; tierIndex < tiers.length; tierIndex++) {
      const outcome = evaluateStep(tiers[tierIndex], tierIndex);
      if (outcome.kind === 'ambiguous') {
        return undefined;
      }
      if (outcome.kind === 'matched') {
        const { tuple: outcomeTuple } = outcome;
        matchedTuple = outcomeTuple;
        break;
      }
    }
    if (matchedTuple) {
      break;
    }
  }

  if (!matchedTuple) {
    return undefined;
  }

  const emittedValue = getTupleKey(matchedTuple, keyProp);
  if (!passesFieldConstraints(emittedValue, targetField)) {
    return undefined;
  }

  return {
    value: emittedValue,
    matchedTuple,
  };
}

async function extractLookupCandidate(
  rule: GmailLookupFieldRule,
  request: ExtractFieldsRequest,
  targetField: ParseTargetDocumentField,
  targetSchema: ParseTargetDocumentSchema | undefined,
  deps: SourceParserServiceDeps | undefined,
  extractionContext: RuleExtractionContext
): Promise<{ value: string; matchedTuple: ParseTargetDocumentOptionTuple; matchedAttachmentName?: string } | undefined> {
  const { from: fromSource } = rule;

  if (fromSource === 'email.to' || fromSource === 'email.cc') {
    const rawRecipientsText =
      fromSource === 'email.to'
        ? (request.context.email?.to ?? '')
        : (request.context.email?.cc ?? '');
    const recipients = splitRfc5322Recipients(rawRecipientsText);
    const excludeRegex = rule.excludePattern ? new RegExp(rule.excludePattern, 'i') : undefined;

    const filteredRecipients = excludeRegex
      ? recipients.filter((r) => !excludeRegex.test(r))
      : recipients;

    for (const recipient of filteredRecipients) {
      const match = await resolveCanonicalOptionFromCandidate(
        recipient,
        targetField,
        request.spaceId,
        targetSchema,
        deps
      );
      if (match) {
        return match;
      }
    }
    return undefined;
  }

  if (fromSource === 'attachmentName') {
    const candidateNamesToTest =
      extractionContext.boundAttachmentName !== undefined
        ? [extractionContext.boundAttachmentName]
        : extractionContext.candidateAttachmentNames;

    const excludeRegex = rule.excludePattern ? new RegExp(rule.excludePattern, 'i') : undefined;

    for (const attName of candidateNamesToTest) {
      if (excludeRegex && excludeRegex.test(attName)) {
        continue;
      }
      const candidateText = extractRegexMatchValue(attName, rule, extractionContext.populatedFields);
      if (!candidateText || candidateText.trim().length === 0) {
        continue;
      }

      const match = await resolveCanonicalOptionFromCandidate(
        candidateText,
        targetField,
        request.spaceId,
        targetSchema,
        deps
      );
      if (match) {
        return {
          ...match,
          matchedAttachmentName: attName,
        };
      }
    }
    return undefined;
  }

  if (fromSource === 'email.labels') {
    const tokens = extractNonSystemLabelTokens(request.context.email?.labels);
    const excludeRegex = rule.excludePattern ? new RegExp(rule.excludePattern, 'i') : undefined;

    for (const token of tokens) {
      if (excludeRegex && excludeRegex.test(token)) {
        continue;
      }
      const candidateText = extractRegexMatchValue(token, rule, extractionContext.populatedFields);
      if (!candidateText || candidateText.trim().length === 0) {
        continue;
      }

      const match = await resolveCanonicalOptionFromCandidate(
        candidateText,
        targetField,
        request.spaceId,
        targetSchema,
        deps
      );
      if (match) {
        return match;
      }
    }
    return undefined;
  }

  const sourceText = getSourceText(fromSource, request.context);
  if (!sourceText || sourceText.trim().length === 0) {
    return undefined;
  }

  if (rule.excludePattern && new RegExp(rule.excludePattern, 'i').test(sourceText)) {
    return undefined;
  }

  const candidateText = extractRegexMatchValue(sourceText, rule, extractionContext.populatedFields);
  if (!candidateText || candidateText.trim().length === 0) {
    return undefined;
  }

  return resolveCanonicalOptionFromCandidate(
    candidateText,
    targetField,
    request.spaceId,
    targetSchema,
    deps
  );
}

export interface SourceParserServiceDeps {
  parseSchemaRegistry?: ParseSchemaRegistryPort | undefined;
  predicateEvaluator?: PredicateEvaluatorPort | undefined;
  fallbackExtractor?: FallbackFieldExtractorPort | undefined;
  canonicalOptionsProvider?: CanonicalOptionsProviderPort | undefined;
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

    for (const extractor of parseSchema.extractors ?? []) {
      try {
        if (extractor.source !== 'gmail') {
          // Structural placeholders (drive, pdfForm, googleDoc) are skipped in Pass 2 deterministic Gmail pipeline
          continue;
        }

        if (!request.context.email) {
          continue;
        }

        if (extractor.match !== undefined && this.deps.predicateEvaluator) {
          const matchResult = this.deps.predicateEvaluator.evaluate(
            extractor.match,
            jsonLogicContext
          );
          if (!matchResult) {
            continue;
          }
        }

        const extractorTargetKeys = Object.keys(extractor.fields);
        const allAlreadyPopulated = extractorTargetKeys.every((k) => k in populatedFields);
        if (allAlreadyPopulated) {
          continue;
        }

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
            if (rule.when !== undefined && this.deps.predicateEvaluator) {
              const whenResult = this.deps.predicateEvaluator.evaluate(
                rule.when,
                jsonLogicContext
              );
              if (!whenResult) {
                continue;
              }
            }

            const extractionContext: RuleExtractionContext = {
              sourceContext: request.context,
              candidateAttachmentNames,
              boundAttachmentName,
              populatedFields,
            };

            if ('lookup' in rule && rule.lookup === true) {
              const lookupResult = await extractLookupCandidate(
                rule,
                request,
                targetField,
                targetSchema,
                this.deps,
                extractionContext
              );
              if (lookupResult !== undefined) {
                if (boundAttachmentName === undefined && lookupResult.matchedAttachmentName !== undefined) {
                  // nosemgrep: domain-pass-through-read
                  boundAttachmentName = lookupResult.matchedAttachmentName;
                }
                const { value: lookupVal, matchedTuple: lookupTuple } = lookupResult;
                populatedFields[fieldKey] = lookupVal;
                populateLinkedFields(fieldKey, lookupTuple, targetSchema, populatedFields);
                break;
              }
            } else {
              const candidateResult = extractCandidateFromRule(
                rule as GmailFieldRule,
                targetField,
                targetSchema,
                extractionContext
              );

              if (candidateResult !== undefined) {
                if (boundAttachmentName === undefined && candidateResult.matchedAttachmentName !== undefined) {
                  // nosemgrep: domain-pass-through-read
                  boundAttachmentName = candidateResult.matchedAttachmentName;
                }
                const { value: candidateVal, matchedTuple: candidateTuple } = candidateResult;
                populatedFields[fieldKey] = candidateVal;
                populateLinkedFields(fieldKey, candidateTuple, targetSchema, populatedFields);
                break;
              }
            }
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        statusMessages.push(
          `Could not extract fields from ${extractor.name ?? extractor.source}: ${errorMsg}`
        );
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
            if (ext.source === 'gmail') {
              for (const [fKey, ruleOrRules] of Object.entries(ext.fields)) {
                const rules = Array.isArray(ruleOrRules) ? ruleOrRules : [ruleOrRules];
                if (rules.some((r) => 'lookup' in r && r.lookup === true)) {
                  lookupFieldKeys.add(fKey);
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
                targetField.options.dynamicConfig !== undefined ||
                lookupFieldKeys.has(key) ||
                targetField.options.allowUserInput === true;
              accepted = useCanonicalLookup
                ? await resolveCanonicalOptionFromCandidate(
                    strVal,
                    targetField,
                    request.spaceId,
                    targetSchema,
                    this.deps
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
