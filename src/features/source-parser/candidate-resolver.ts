import type {
  CanonicalOptionsProviderPort,
  DriveExtractSource,
  FieldCandidateNormalize,
  GmailExtractSource,
  ParseSchemaRegistryPort,
  ParseTargetDocumentField,
  ParseTargetDocumentOptionTuple,
  ParseTargetDocumentSchema,
  PredicateEvaluatorPort,
} from './ports';
import {
  formatYymmdd,
  isValidCalendarDate,
  normalizeFormDateCandidate,
} from './form-date';

export const DRIVE_METADATA_EXTRACT_ERROR_MESSAGE =
  'Could not read Google Drive file metadata or document form fields to pre-populate fields; you can enter them manually.';

export interface ParsedRecipient {
  raw: string;
  displayName?: string | undefined;
  email?: string | undefined;
  domain?: string | undefined;
}

export interface ValidatedCandidate {
  value: string;
  matchedTuple?: ParseTargetDocumentOptionTuple | undefined;
}

export interface YearMonthDay {
  year: number;
  month: number;
  day: number;
}

export interface CanonicalOptionResolverDeps {
  canonicalOptionsProvider?: CanonicalOptionsProviderPort | undefined;
  parseSchemaRegistry?: ParseSchemaRegistryPort | undefined;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function extractEmailDomain(fromAddress: string): string {
  const atIndex = fromAddress.lastIndexOf('@');
  return atIndex !== -1 ? fromAddress.slice(atIndex + 1).toLowerCase() : '';
}

export function parseRecipient(recipient: string): ParsedRecipient {
  const trimmed = recipient.trim();
  if (!trimmed) {
    return { raw: '' };
  }

  const angleMatch = trimmed.match(/^(.*)<([^<>]+)>$/);
  if (angleMatch) {
    let rawName = (angleMatch[1] ?? '').trim();
    if (
      (rawName.startsWith('"') && rawName.endsWith('"') && rawName.length >= 2) ||
      (rawName.startsWith("'") && rawName.endsWith("'") && rawName.length >= 2)
    ) {
      rawName = rawName.slice(1, -1).trim();
    }
    const displayName = rawName.length > 0 ? rawName : undefined;
    const email = (angleMatch[2] ?? '').trim().toLowerCase();
    const atIdx = email.lastIndexOf('@');
    const rawDomain = atIdx !== -1 ? email.slice(atIdx + 1) : '';
    const domain = rawDomain.length > 0 ? rawDomain : undefined;
    return {
      raw: trimmed,
      displayName,
      email: email.length > 0 ? email : undefined,
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

export function getYearMonthDayInTimeZone(date: Date, timeZone?: string): YearMonthDay | undefined {
  const effectiveTimeZone =
    typeof timeZone === 'string' && timeZone.trim().length > 0 ? timeZone.trim() : 'UTC';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: effectiveTimeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  let yearStr = '';
  let monthStr = '';
  let dayStr = '';
  for (const { type, value } of parts) {
    if (type === 'year') yearStr = value;
    else if (type === 'month') monthStr = value;
    else if (type === 'day') dayStr = value;
  }

  const year = parseInt(yearStr, 10);
  const month = parseInt(monthStr, 10);
  const day = parseInt(dayStr, 10);
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day)) {
    return undefined;
  }
  return { year, month, day };
}

function isWithinRollingTwelveMonths(
  year: number,
  month: number,
  day: number,
  today: YearMonthDay
): boolean {
  const minYear = today.year - 1;
  const maxDayInMinMonth = new Date(Date.UTC(minYear, today.month, 0)).getUTCDate();
  const minDay = Math.min(today.day, maxDayInMinMonth);

  const candYmd = year * 10000 + month * 100 + day;
  const minYmd = minYear * 10000 + today.month * 100 + minDay;
  const todayYmd = today.year * 10000 + today.month * 100 + today.day;

  return candYmd >= minYmd && candYmd <= todayYmd;
}

function tryFormatBoundedDate(
  year: number,
  month: number,
  day: number,
  today: YearMonthDay
): string | undefined {
  if (!isValidCalendarDate(year, month, day)) {
    return undefined;
  }
  if (!isWithinRollingTwelveMonths(year, month, day, today)) {
    return undefined;
  }
  return formatYymmdd(year, month, day);
}

/**
 * Extracts and validates an explicit date token formatted as INC `yyMMdd`
 * within the rolling `[today - 12 months, today]` window in the workspace timezone.
 */
function normalizeYymmddCandidate(
  candidate: string,
  timeZone: string | undefined,
  nowDate: Date
): string | undefined {
  const today = getYearMonthDayInTimeZone(nowDate, timeZone);
  if (!today) {
    return undefined;
  }

  // Tier 1: 4-digit-year delimited formats (YYYY[-_.]MM[-_.]DD or MM[-_.]DD[-_.]YYYY)
  const fourDigitYearRegex =
    /(?<![A-Za-z0-9])(?:(\d{4})([-_.])(\d{2})\2(\d{2})|(\d{2})([-_.])(\d{2})\6(\d{4}))(?![A-Za-z0-9])/g;
  for (const match of candidate.matchAll(fourDigitYearRegex)) {
    const year = match[1] !== undefined ? parseInt(match[1], 10) : parseInt(match[8], 10);
    const month = match[3] !== undefined ? parseInt(match[3], 10) : parseInt(match[5], 10);
    const day = match[4] !== undefined ? parseInt(match[4], 10) : parseInt(match[7], 10);
    const formatted = tryFormatBoundedDate(year, month, day, today);
    if (formatted !== undefined) {
      return formatted;
    }
  }

  // Tier 2: 2-digit-year delimited format (MM[-_.]DD[-_.]YY)
  const twoDigitDelimitedRegex = /(?<![A-Za-z0-9])(\d{2})([-_.])(\d{2})\2(\d{2})(?![A-Za-z0-9])/g;
  for (const match of candidate.matchAll(twoDigitDelimitedRegex)) {
    const month = parseInt(match[1], 10);
    const day = parseInt(match[3], 10);
    const year = 2000 + parseInt(match[4], 10);
    const formatted = tryFormatBoundedDate(year, month, day, today);
    if (formatted !== undefined) {
      return formatted;
    }
  }

  // Tier 3: INC 6-digit yyMMdd format, skipping CSI/submittal prefixes followed by -\d{1,3}
  const sixDigitRegex = /(?<![A-Za-z0-9])(\d{2})(\d{2})(\d{2})(?![A-Za-z0-9])(?!-\d{1,3}(?!\d))/g;
  for (const match of candidate.matchAll(sixDigitRegex)) {
    const year = 2000 + parseInt(match[1], 10);
    const month = parseInt(match[2], 10);
    const day = parseInt(match[3], 10);
    const formatted = tryFormatBoundedDate(year, month, day, today);
    if (formatted !== undefined) {
      return formatted;
    }
  }

  return undefined;
}

export function normalizeDigits6Candidate(candidate: string): string | undefined {
  const digits = candidate.replace(/\D/g, '');
  return digits.length === 6 ? digits : undefined;
}

export function normalizePad3Candidate(candidate: string): string | undefined {
  const trimmed = candidate.trim();
  if (!/^\d+$/.test(trimmed)) {
    return undefined;
  }
  return trimmed.padStart(3, '0');
}

export function normalizeCompactAlnumCandidate(candidate: string): string | undefined {
  const compacted = candidate.replace(/[\s._-]+/g, '');
  if (compacted.length === 0 || !/^[A-Za-z0-9]+$/.test(compacted)) {
    return undefined;
  }
  return compacted;
}

const REVISION_MARKER_REGEX =
  /(?<=^|[\s_.-])(?:(v|ver\.?|version)[\s_.-]*(\d+)(?:\.(\d+))?|(rev\.?|revision)(?:[\s_.-]*(\d{1,2})|[\s_.-]+(\d{1,2}[A-Za-z]?|[A-Za-z]\d{0,2}))|(r)(?:[\s_.]*(\d{1,2})|[\s_.]+([A-Za-z])))(?![A-Za-z0-9]|\.\d)/gi;

function normalizeRevisionCandidate(candidate: string): string | undefined {
  const trimmed = candidate.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  // Tight code-suffix token (e.g. "-A", "A", "-0", "0", "-R", "R", "-12", "12")
  if (/^-?(?:\d{1,2}|[A-Za-z])$/.test(trimmed)) {
    return trimmed.startsWith('-') ? trimmed.slice(1) : trimmed;
  }

  for (const match of trimmed.matchAll(REVISION_MARKER_REGEX)) {
    if (match[1] !== undefined && match[2] !== undefined) {
      const major = parseInt(match[2], 10);
      if (match[3] !== undefined && parseInt(match[3], 10) !== 0) {
        continue;
      }
      return major === 0 ? '0' : String(major - 1);
    }
    if (match[4] !== undefined) {
      const revVal = match[5] ?? match[6];
      if (revVal !== undefined && revVal.length > 0) {
        return revVal;
      }
    }
    if (match[7] !== undefined) {
      const rVal = match[8] ?? match[9];
      if (rVal !== undefined && rVal.length > 0) {
        return rVal;
      }
    }
  }

  return undefined;
}

const FILENAME_EXTENSION_REGEX = /\.(?!(?:inc|ltd)$)[A-Za-z0-9]{1,8}$/i;

function normalizeCleanFilenameTextCandidate(
  candidate: string,
  fromSource?: GmailExtractSource | DriveExtractSource,
  originalSourceText?: string
): string | undefined {
  let text = candidate.trim();
  if (fromSource === 'drive.fileName' || fromSource === 'attachmentName') {
    const trimmedOriginal = originalSourceText?.trim();
    if (trimmedOriginal === undefined || text === trimmedOriginal) {
      text = text.replace(FILENAME_EXTENSION_REGEX, '');
    } else {
      const sourceExt = trimmedOriginal.match(FILENAME_EXTENSION_REGEX)?.[0];
      if (sourceExt && text.toLowerCase().endsWith(sourceExt.toLowerCase())) {
        text = text.slice(0, -sourceExt.length);
      }
    }
  }
  text = text
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s\-–—_:.]+|[\s\-–—_:.]+$/g, '');
  return text.length > 0 ? text : undefined;
}

export function applyFieldCandidateNormalize(
  candidate: string,
  normalize: FieldCandidateNormalize | undefined,
  timeZone?: string | undefined,
  now?: (() => Date) | undefined,
  fromSource?: GmailExtractSource | DriveExtractSource,
  originalSourceText?: string
): string | undefined {
  if (normalize === undefined) {
    return candidate;
  }
  switch (normalize) {
    case 'digits6':
      return normalizeDigits6Candidate(candidate);
    case 'pad3':
      return normalizePad3Candidate(candidate);
    case 'compactAlnum':
      return normalizeCompactAlnumCandidate(candidate);
    case 'revision':
      return normalizeRevisionCandidate(candidate);
    case 'yymmdd': {
      const nowDate = now ? now() : new Date();
      return normalizeYymmddCandidate(candidate, timeZone, nowDate);
    }
    case 'formDate':
      return normalizeFormDateCandidate(candidate);
    case 'cleanFilenameText':
      return normalizeCleanFilenameTextCandidate(candidate, fromSource, originalSourceText);
    default:
      return undefined;
  }
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

export function validateCandidateWithTuple(
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

export function deriveLinkedFields(
  fieldKey: string,
  matchedTuple: ParseTargetDocumentOptionTuple | undefined,
  targetSchema: ParseTargetDocumentSchema | undefined,
  existingFields: Readonly<Record<string, unknown>>
): Record<string, unknown> {
  const derived: Record<string, unknown> = {};
  if (!matchedTuple || !targetSchema?.fields) {
    return derived;
  }
  for (const sibling of targetSchema.fields) {
    if (
      sibling.linkedField &&
      sibling.linkedField.sourceField === fieldKey &&
      !(sibling.key in existingFields)
    ) {
      const propVal = matchedTuple[sibling.linkedField.sourceProperty];
      if (
        propVal !== undefined &&
        propVal !== null &&
        (typeof propVal === 'string' ? propVal.trim().length > 0 : true)
      ) {
        derived[sibling.key] = String(propVal);
      }
    }
  }
  return derived;
}

export function populateLinkedFields(
  fieldKey: string,
  matchedTuple: ParseTargetDocumentOptionTuple | undefined,
  targetSchema: ParseTargetDocumentSchema | undefined,
  populatedFields: Record<string, unknown>
): void {
  Object.assign(
    populatedFields,
    deriveLinkedFields(fieldKey, matchedTuple, targetSchema, populatedFields)
  );
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

function matchesDelimitedPhrase(
  haystack: string,
  phrase: string,
  caseInsensitive: boolean
): boolean {
  const regex = new RegExp(
    `(?<=^|[\\s<(\\[_,;:"'-])${escapeRegExp(phrase)}(?=[\\s>)\\]_,;:."'-]|$)`,
    caseInsensitive ? 'i' : ''
  );
  return regex.test(haystack);
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
        if (nameTrimmed.length >= 4 && matchesDelimitedPhrase(haystack, nameTrimmed, true)) {
          longestMatchedNeedle = nameTrimmed;
        }
      }
    }

    for (const alias of opt.aliases) {
      const aliasTrimmed = alias.trim();
      if (aliasTrimmed.length >= 4) {
        if (
          matchesDelimitedPhrase(haystack, aliasTrimmed, true) &&
          (!longestMatchedNeedle || aliasTrimmed.length > longestMatchedNeedle.length)
        ) {
          longestMatchedNeedle = aliasTrimmed;
        }
      } else if (aliasTrimmed.length === 2 || aliasTrimmed.length === 3) {
        if (
          matchesDelimitedPhrase(haystack, aliasTrimmed, false) &&
          (!longestMatchedNeedle || aliasTrimmed.length > longestMatchedNeedle.length)
        ) {
          longestMatchedNeedle = aliasTrimmed;
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

export async function resolveCanonicalOptionFromCandidate(
  candidate: string,
  targetField: ParseTargetDocumentField,
  spaceId: string | undefined,
  targetSchema: ParseTargetDocumentSchema | undefined,
  deps: CanonicalOptionResolverDeps | undefined
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

export function evaluateCondition(
  predicate: unknown,
  data: Record<string, unknown>,
  evaluator: PredicateEvaluatorPort | undefined
): boolean {
  if (predicate === undefined) {
    return true;
  }
  if (!evaluator) {
    return false;
  }
  return evaluator.evaluate(predicate, data);
}
