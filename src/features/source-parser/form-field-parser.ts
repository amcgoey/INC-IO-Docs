import {
  SUPPORTED_FORM_MIME_TYPES,
  type CanonicalOptionsProviderPort,
  type DocumentFormFieldBinding,
  type DocumentFormSchema,
  type DriveItemHierarchy,
  type ExtractFieldsRequest,
  type FieldCandidateNormalize,
  type FormExtractorPort,
  type FormExtractorRule,
  type FormFieldValue,
  type FormTemplateParserPort,
  type FormTemplateToken,
  type ParsedFormTemplate,
  type ParseSchemaRegistryPort,
  type ParseTargetDocumentField,
  type ParseTargetDocumentOptionTuple,
  type ParseTargetDocumentSchema,
  type PredicateEvaluatorPort,
} from './ports';
import {
  applyFieldCandidateNormalize,
  deriveLinkedFields,
  DRIVE_METADATA_EXTRACT_ERROR_MESSAGE,
  evaluateCondition,
  resolveCanonicalOptionFromCandidate,
  validateCandidateWithTuple,
  type CanonicalOptionResolverDeps,
} from './candidate-resolver';

export const PDF_FORM_ENCRYPTED_ERROR_MESSAGE =
  'Could not read PDF form fields because the file is password-protected; you can enter them manually.';

export const DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE =
  'Could not read document form fields because the file could not be parsed; you can enter them manually.';

export const PDF_FORM_FILE_TOO_LARGE_ERROR_MESSAGE =
  'Could not read document form fields because the file exceeds the maximum in-memory size limit; you can enter them manually.';

export type FormFieldMatcherKind = 'lookup' | 'sixDigitCode' | 'numericSequence' | 'revision';

export function classifyFormFieldMatcher(
  targetField: ParseTargetDocumentField
): FormFieldMatcherKind | undefined {
  if (targetField.options !== undefined) {
    return 'lookup';
  }
  if (targetField.pattern === '^\\d{6}$') {
    return 'sixDigitCode';
  }
  if (/^\^\\d\{3,?\}\$$/.test(targetField.pattern ?? '')) {
    return 'numericSequence';
  }
  if (targetField.key === 'revision') {
    return 'revision';
  }
  return undefined;
}

export function parseDocumentFieldTemplate(
  parser: FormTemplateParserPort,
  template: string
): ParsedFormTemplate {
  const parsed = parser.parseMustacheTemplate(template);
  if (parsed.tokens.length === 0) {
    throw new Error('Field template must reference at least one Stage-1 DocumentField token');
  }

  const tokens: FormTemplateToken[] = [];
  for (const token of parsed.tokens) {
    if (
      token.parts.length < 1 ||
      token.parts.length > 2 ||
      token.parts.some((part) => part.trim().length === 0)
    ) {
      throw new Error(
        `Invalid field path "${token.original}" in field template (expected fieldKey or fieldKey.property)`
      );
    }

    const [fieldKey, property] = token.parts;
    if (fieldKey === 'calculated' || fieldKey === 'Document') {
      throw new Error(`Disallowed namespace "${fieldKey}" in Stage-1 field template`);
    }

    tokens.push(property !== undefined ? { fieldKey, property } : { fieldKey });
  }

  return {
    tokens,
    literals: parsed.literals,
  };
}

export function formatAmbiguousFormFieldMessage(fieldName: string): string {
  return `Could not pre-populate from "${fieldName}" because multiple options are selected; please verify manually.`;
}

function isFormVarKey(key: unknown): boolean {
  if (typeof key !== 'string') {
    return true;
  }
  return key === '' || key === 'form' || key.startsWith('form.');
}

function referencesFormInJsonLogic(rule: unknown): boolean {
  if (rule === null || rule === undefined || typeof rule !== 'object') {
    return false;
  }
  if (Array.isArray(rule)) {
    return rule.some((entry) => referencesFormInJsonLogic(entry));
  }

  for (const [op, operand] of Object.entries(rule)) {
    if (op === 'var') {
      if (Array.isArray(operand)) {
        const pathExpr = operand.length > 0 ? operand[0] : undefined;
        if (isFormVarKey(pathExpr)) {
          return true;
        }
        if (operand.length > 1 && referencesFormInJsonLogic(operand[1])) {
          return true;
        }
        continue;
      }
      if (isFormVarKey(operand)) {
        return true;
      }
      continue;
    }

    if (op === 'missing') {
      const keys = Array.isArray(operand) ? operand : [operand];
      if (keys.some((key) => isFormVarKey(key))) {
        return true;
      }
      continue;
    }

    if (op === 'missing_some') {
      if (!Array.isArray(operand)) {
        return true;
      }
      if (referencesFormInJsonLogic(operand[0])) {
        return true;
      }
      const keys = operand[1];
      if (!Array.isArray(keys) || keys.some((key) => isFormVarKey(key))) {
        return true;
      }
      continue;
    }

    if (referencesFormInJsonLogic(operand)) {
      return true;
    }
  }

  return false;
}

interface HydratedDriveFormItemContext {
  hierarchy: DriveItemHierarchy;
  driveContext: Record<string, unknown>;
}

const SIX_DIGIT_CODE_TOKEN_REGEX = /^(?:\d{6}|\d{2}([\s._-])\d{2}\1\d{2})(?=$|[\s_./-])/;
const SPEC_TAG_CODE_TOKEN_REGEX = /^([A-Za-z]{2}[\s._-]?\d{3}[A-Za-z]?)(?=$|[\s_./-])/;
const FALLBACK_DELIMITER_SEGMENT_REGEX = /^([^\s_./-]+)(?=$|[\s_./-])/;
const LEADING_FORM_SEPARATOR_REGEX = /^[\s_./-]+/;
const EXPLICIT_REVISION_PREFIX_REGEX =
  /^(?:(?:v|ver\.?|version)[\s_.-]*\d|rev(?:ision)?\.?(?:[\s_.-]*\d|[\s_.-]+[A-Za-z]\b)|r(?:[\s_.]*\d|[\s_.-]+[A-Za-z]\b))/i;
const OPTIONAL_SUBMITTAL_NUMBER_REGEX =
  /^(?:(?:submittal(?:[\s_.-]+no\.?)?|sub\.?|no\.?)[\s_.:-]*#?[\s_.-]*|#[\s_.-]*)?(\d+)(?=$|[\s_./-])/i;

function isTargetableField(
  targetField: ParseTargetDocumentField | undefined
): targetField is ParseTargetDocumentField {
  return targetField !== undefined && !targetField.linkedField;
}

function hasUnpopulatedTargetToken(
  tokens: FormTemplateToken[],
  targetSchema: ParseTargetDocumentSchema | undefined,
  workingFields: Readonly<Record<string, unknown>>
): boolean {
  return tokens.some((token) => {
    const targetField = targetSchema?.fields.find((f) => f.key === token.fieldKey);
    return isTargetableField(targetField) && !(token.fieldKey in workingFields);
  });
}

function consumeSixDigitCodeToken(
  remaining: string,
  targetField: ParseTargetDocumentField,
  targetSchema: ParseTargetDocumentSchema | undefined
): { value: string; nextRemaining: string } | undefined {
  const match = remaining.match(SIX_DIGIT_CODE_TOKEN_REGEX);
  if (!match) {
    return undefined;
  }
  const normalized = applyFieldCandidateNormalize(match[0], 'digits6');
  const validated = validateCandidateWithTuple(normalized, targetField, targetSchema);
  if (!validated) {
    return undefined;
  }
  const nextRemaining = remaining
    .slice(match[0].length)
    .replace(LEADING_FORM_SEPARATOR_REGEX, '');
  return { value: validated.value, nextRemaining };
}

function consumeNumericSequenceToken(
  remaining: string,
  matchedSixDigitInField: boolean,
  targetField: ParseTargetDocumentField,
  targetSchema: ParseTargetDocumentSchema | undefined
): { value: string; nextRemaining: string } | undefined {
  if (matchedSixDigitInField && EXPLICIT_REVISION_PREFIX_REGEX.test(remaining)) {
    return undefined;
  }
  const match = remaining.match(OPTIONAL_SUBMITTAL_NUMBER_REGEX);
  if (!match || match[1] === undefined) {
    return undefined;
  }
  const afterNum = remaining
    .slice(match[0].length)
    .replace(LEADING_FORM_SEPARATOR_REGEX, '');
  if (!matchedSixDigitInField && afterNum.length > 0) {
    const trailingRevision = applyFieldCandidateNormalize(afterNum, 'revision');
    if (trailingRevision === undefined) {
      return undefined;
    }
  }
  const normalized = applyFieldCandidateNormalize(match[1], 'pad3');
  const validated = validateCandidateWithTuple(normalized, targetField, targetSchema);
  if (!validated) {
    return undefined;
  }
  return { value: validated.value, nextRemaining: afterNum };
}

function resolveRevisionToken(
  remaining: string,
  targetField: ParseTargetDocumentField,
  targetSchema: ParseTargetDocumentSchema | undefined
): string | undefined {
  const stripped = remaining.replace(LEADING_FORM_SEPARATOR_REGEX, '');
  if (stripped.length === 0) {
    return undefined;
  }
  const normalized = applyFieldCandidateNormalize(stripped, 'revision');
  const validated = validateCandidateWithTuple(normalized, targetField, targetSchema);
  return validated?.value;
}

async function resolveLookupCandidate(params: {
  candidate: string;
  property: string | undefined;
  targetField: ParseTargetDocumentField;
  targetSchema: ParseTargetDocumentSchema | undefined;
  spaceId: string | undefined;
  resolverDeps: CanonicalOptionResolverDeps;
}): Promise<{ value: string; matchedTuple?: ParseTargetDocumentOptionTuple | undefined } | undefined> {
  const { candidate, property, targetField, targetSchema, spaceId, resolverDeps } = params;
  const useCanonicalLookup =
    (targetField.options?.source !== undefined &&
      targetSchema?.optionSources?.[targetField.options.source] !== undefined) ||
    targetField.options?.allowUserInput === true;

  if (useCanonicalLookup) {
    return resolveCanonicalOptionFromCandidate(
      candidate,
      targetField,
      spaceId,
      targetSchema,
      resolverDeps
    );
  }

  const validated = validateCandidateWithTuple(candidate, targetField, targetSchema);
  if (validated) {
    return validated;
  }

  if (property !== undefined && targetField.options) {
    const keyProp = targetField.options.key ?? 'key';
    const staticTuples = targetSchema?.options?.[targetField.options.source] ?? [];
    const normCandidate = candidate.trim().toLowerCase();
    const matchedByProp = staticTuples.find((tuple) => {
      const propVal = tuple[property];
      return typeof propVal === 'string' && propVal.trim().toLowerCase() === normCandidate;
    });
    if (matchedByProp) {
      const canonicalKey = matchedByProp[keyProp] ?? matchedByProp.key;
      if (canonicalKey !== undefined && canonicalKey !== null) {
        return validateCandidateWithTuple(String(canonicalKey), targetField, targetSchema);
      }
    }
  }

  return undefined;
}

async function consumeLookupFieldToken(params: {
  remaining: string;
  property: string | undefined;
  targetField: ParseTargetDocumentField;
  targetSchema: ParseTargetDocumentSchema | undefined;
  spaceId: string | undefined;
  resolverDeps: CanonicalOptionResolverDeps;
}): Promise<
  | {
      value: string;
      matchedTuple?: ParseTargetDocumentOptionTuple | undefined;
      nextRemaining: string;
    }
  | undefined
> {
  const { remaining, property, targetField, targetSchema, spaceId, resolverDeps } = params;
  let rawToken: string;
  let candidate: string | undefined;

  const specMatch = remaining.match(SPEC_TAG_CODE_TOKEN_REGEX);
  if (specMatch) {
    rawToken = specMatch[0];
    candidate = applyFieldCandidateNormalize(specMatch[1], 'compactAlnum');
  } else {
    const fallbackMatch = remaining.match(FALLBACK_DELIMITER_SEGMENT_REGEX);
    if (!fallbackMatch) {
      return undefined;
    }
    rawToken = fallbackMatch[0];
    candidate = fallbackMatch[1];
  }

  if (candidate === undefined) {
    return undefined;
  }

  const resolved = await resolveLookupCandidate({
    candidate,
    property,
    targetField,
    targetSchema,
    spaceId,
    resolverDeps,
  });
  if (!resolved) {
    return undefined;
  }

  const nextRemaining = remaining
    .slice(rawToken.length)
    .replace(LEADING_FORM_SEPARATOR_REGEX, '');
  return {
    value: resolved.value,
    matchedTuple: resolved.matchedTuple,
    nextRemaining,
  };
}

function recordExtractedField(params: {
  fieldKey: string;
  value: string;
  matchedTuple: ParseTargetDocumentOptionTuple | undefined;
  targetSchema: ParseTargetDocumentSchema | undefined;
  workingFields: Record<string, unknown>;
  extractedFields: Record<string, unknown>;
}): void {
  const { fieldKey, value, matchedTuple, targetSchema, workingFields, extractedFields } = params;
  workingFields[fieldKey] = value;
  extractedFields[fieldKey] = value;
  const linked = deriveLinkedFields(fieldKey, matchedTuple, targetSchema, workingFields);
  Object.assign(workingFields, linked);
  Object.assign(extractedFields, linked);
}

async function evaluateMultiTokenBinding(params: {
  parsed: ParsedFormTemplate;
  rawCandidate: string;
  targetSchema: ParseTargetDocumentSchema | undefined;
  workingFields: Record<string, unknown>;
  extractedFields: Record<string, unknown>;
  spaceId: string | undefined;
  resolverDeps: CanonicalOptionResolverDeps;
}): Promise<boolean> {
  const { parsed, rawCandidate, targetSchema, workingFields, extractedFields, spaceId, resolverDeps } =
    params;
  let remaining = rawCandidate.trim();
  let matchedSixDigitInField = false;
  let populatedAny = false;

  for (const token of parsed.tokens) {
    if (remaining.length === 0) {
      break;
    }

    const targetField = targetSchema?.fields.find((f) => f.key === token.fieldKey);
    if (!isTargetableField(targetField)) {
      continue;
    }

    switch (classifyFormFieldMatcher(targetField)) {
      case 'lookup': {
        const matched = await consumeLookupFieldToken({
          remaining,
          property: token.property,
          targetField,
          targetSchema,
          spaceId,
          resolverDeps,
        });
        if (matched) {
          remaining = matched.nextRemaining;
          if (!(token.fieldKey in workingFields)) {
            recordExtractedField({
              fieldKey: token.fieldKey,
              value: matched.value,
              matchedTuple: matched.matchedTuple,
              targetSchema,
              workingFields,
              extractedFields,
            });
            populatedAny = true;
          }
        }
        break;
      }

      case 'sixDigitCode': {
        const matched = consumeSixDigitCodeToken(remaining, targetField, targetSchema);
        if (matched) {
          matchedSixDigitInField = true;
          remaining = matched.nextRemaining;
          if (!(token.fieldKey in workingFields)) {
            workingFields[token.fieldKey] = matched.value;
            extractedFields[token.fieldKey] = matched.value;
            populatedAny = true;
          }
        }
        break;
      }

      case 'numericSequence': {
        const matched = consumeNumericSequenceToken(
          remaining,
          matchedSixDigitInField,
          targetField,
          targetSchema
        );
        if (matched) {
          remaining = matched.nextRemaining;
          if (!(token.fieldKey in workingFields)) {
            workingFields[token.fieldKey] = matched.value;
            extractedFields[token.fieldKey] = matched.value;
            populatedAny = true;
          }
        }
        break;
      }

      case 'revision': {
        const revValue = resolveRevisionToken(remaining, targetField, targetSchema);
        if (revValue !== undefined) {
          if (!(token.fieldKey in workingFields)) {
            workingFields[token.fieldKey] = revValue;
            extractedFields[token.fieldKey] = revValue;
            populatedAny = true;
          }
          remaining = '';
        }
        break;
      }

      default:
        break;
    }
  }

  return populatedAny;
}

function coerceFormFieldValue(raw: FormFieldValue | undefined): string[] {
  if (raw === undefined || raw === false) {
    return [];
  }
  if (raw === true) {
    return ['true'];
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return [];
}

function resolveFormValueMapKey(
  candidate: string,
  valueMap: Record<string, string>
): string | undefined {
  const normalized = candidate.trim().toLowerCase();
  for (const [canonicalKey, mappedLabel] of Object.entries(valueMap)) {
    if (
      canonicalKey.trim().toLowerCase() === normalized ||
      mappedLabel.trim().toLowerCase() === normalized
    ) {
      return canonicalKey;
    }
  }
  return undefined;
}

function inferPlainFieldNormalizeMode(
  targetField: ParseTargetDocumentField,
  binding: DocumentFormFieldBinding
): FieldCandidateNormalize | undefined {
  if (binding.format === 'date') {
    return 'formDate';
  }
  switch (classifyFormFieldMatcher(targetField)) {
    case 'sixDigitCode':
      return 'digits6';
    case 'numericSequence':
      return 'pad3';
    case 'revision':
      return 'revision';
    default:
      return undefined;
  }
}

async function resolveSingleTokenLookupCandidate(params: {
  rawCandidate: string;
  binding: DocumentFormFieldBinding;
  property: string | undefined;
  targetField: ParseTargetDocumentField;
  targetSchema: ParseTargetDocumentSchema | undefined;
  spaceId: string | undefined;
  resolverDeps: CanonicalOptionResolverDeps;
}): Promise<{ value: string; matchedTuple?: ParseTargetDocumentOptionTuple | undefined } | undefined> {
  const { rawCandidate, binding, property, targetField, targetSchema, spaceId, resolverDeps } =
    params;
  const mappedKey =
    binding.valueMap !== undefined
      ? resolveFormValueMapKey(rawCandidate, binding.valueMap)
      : undefined;
  let candidateToResolve: string | undefined = mappedKey ?? rawCandidate;
  if (mappedKey === undefined && binding.format === 'date') {
    candidateToResolve = applyFieldCandidateNormalize(rawCandidate, 'formDate');
    if (candidateToResolve === undefined) {
      return undefined;
    }
  }

  return resolveLookupCandidate({
    candidate: candidateToResolve,
    property,
    targetField,
    targetSchema,
    spaceId,
    resolverDeps,
  });
}

export async function extractFormExtractorFields(params: {
  extractor: FormExtractorRule;
  validItemIds: string[];
  request: ExtractFieldsRequest;
  targetSchema: ParseTargetDocumentSchema | undefined;
  jsonLogicContext: Record<string, unknown>;
  existingFields: Readonly<Record<string, unknown>>;
  parseSchemaRegistry: ParseSchemaRegistryPort;
  formExtractor: FormExtractorPort | undefined;
  formTemplateParser: FormTemplateParserPort | undefined;
  canonicalOptionsProvider?: CanonicalOptionsProviderPort | undefined;
  predicateEvaluator?: PredicateEvaluatorPort | undefined;
  getHydratedDriveItem: (itemId: string) => Promise<HydratedDriveFormItemContext>;
}): Promise<{ fields: Record<string, unknown>; statusMessages: string[] }> {
  const {
    extractor,
    validItemIds,
    request,
    targetSchema,
    jsonLogicContext,
    existingFields,
    parseSchemaRegistry,
    formExtractor,
    formTemplateParser,
    canonicalOptionsProvider,
    predicateEvaluator,
    getHydratedDriveItem,
  } = params;

  const emptyResult = { fields: {}, statusMessages: [] };

  if (request.context.email && request.context.isDriveUrl !== true) {
    return emptyResult;
  }

  if (validItemIds.length === 0 || !formExtractor) {
    return emptyResult;
  }

  const documentFormSchema: DocumentFormSchema | undefined =
    await parseSchemaRegistry.getDocumentFormSchema?.(request.documentTypeKey);
  if (!documentFormSchema || Object.keys(documentFormSchema.fields).length === 0) {
    return emptyResult;
  }

  if (!formTemplateParser) {
    throw new Error('FormTemplateParserPort is required to evaluate documentFormSchema');
  }

  const parsedBindings: Array<{
    formFieldName: string;
    binding: DocumentFormFieldBinding;
    parsed: ParsedFormTemplate;
  }> = [];
  const referencedTargetKeys = new Set<string>();

  for (const [formFieldName, binding] of Object.entries(documentFormSchema.fields)) {
    const parsed = parseDocumentFieldTemplate(formTemplateParser, binding.template);
    parsedBindings.push({ formFieldName, binding, parsed });
    for (const token of parsed.tokens) {
      const targetField = targetSchema?.fields.find((f) => f.key === token.fieldKey);
      if (isTargetableField(targetField)) {
        referencedTargetKeys.add(token.fieldKey);
      }
    }
  }

  if (
    referencedTargetKeys.size === 0 ||
    Array.from(referencedTargetKeys).every((key) => key in existingFields)
  ) {
    return emptyResult;
  }

  const resolverDeps: CanonicalOptionResolverDeps = {
    canonicalOptionsProvider,
    parseSchemaRegistry,
    documentTypeKey: request.documentTypeKey,
    ...(request.selectedLogId !== undefined ? { selectedLogId: request.selectedLogId } : {}),
  };
  const workingFields: Record<string, unknown> = { ...existingFields };
  const extractedFields: Record<string, unknown> = {};
  const statusMessages: string[] = [];

  const matchReferencesForm =
    extractor.match !== undefined && referencesFormInJsonLogic(extractor.match);

  for (const candidateItemId of validItemIds) {
    let hydrated: HydratedDriveFormItemContext;
    try {
      hydrated = await getHydratedDriveItem(candidateItemId);
    } catch {
      statusMessages.push(DRIVE_METADATA_EXTRACT_ERROR_MESSAGE);
      continue;
    }

    const { hierarchy, driveContext } = hydrated;
    const mimeType = hierarchy.item.mimeType;
    if (!mimeType || !(SUPPORTED_FORM_MIME_TYPES as readonly string[]).includes(mimeType)) {
      continue;
    }

    const itemJsonLogicContext = { ...jsonLogicContext, drive: driveContext };
    if (
      extractor.match !== undefined &&
      !matchReferencesForm &&
      !evaluateCondition(extractor.match, itemJsonLogicContext, predicateEvaluator)
    ) {
      continue;
    }

    const outcome = await formExtractor.extractFormFields({
      id: hierarchy.item.id,
      mimeType,
      ...(hierarchy.item.size !== undefined ? { size: hierarchy.item.size } : {}),
    });

    if (outcome.status === 'encrypted') {
      statusMessages.push(PDF_FORM_ENCRYPTED_ERROR_MESSAGE);
      continue;
    }
    if (outcome.status === 'corrupted') {
      statusMessages.push(DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE);
      continue;
    }
    if (outcome.status === 'file_too_large') {
      statusMessages.push(PDF_FORM_FILE_TOO_LARGE_ERROR_MESSAGE);
      continue;
    }
    if (outcome.status === 'source_error') {
      statusMessages.push(DRIVE_METADATA_EXTRACT_ERROR_MESSAGE);
      continue;
    }

    if (outcome.widgetCount === 0) {
      continue;
    }

    if (
      extractor.match !== undefined &&
      matchReferencesForm &&
      !evaluateCondition(
        extractor.match,
        {
          ...itemJsonLogicContext,
          form: outcome.fields,
        },
        predicateEvaluator
      )
    ) {
      continue;
    }

    let populatedAnyInItem = false;
    let encounteredAmbiguousBoundWidget = false;

    for (const { formFieldName, binding, parsed } of parsedBindings) {
      if (outcome.ambiguousFields?.includes(formFieldName)) {
        if (hasUnpopulatedTargetToken(parsed.tokens, targetSchema, workingFields)) {
          statusMessages.push(formatAmbiguousFormFieldMessage(formFieldName));
          encounteredAmbiguousBoundWidget = true;
        }
        continue;
      }

      const rawValue = Object.prototype.hasOwnProperty.call(outcome.fields, formFieldName)
        ? outcome.fields[formFieldName]
        : undefined;
      const candidates = coerceFormFieldValue(rawValue);
      if (candidates.length === 0) {
        continue;
      }

      if (parsed.tokens.length > 1) {
        if (!hasUnpopulatedTargetToken(parsed.tokens, targetSchema, workingFields)) {
          continue;
        }

        for (const rawCandidate of candidates) {
          if (
            await evaluateMultiTokenBinding({
              parsed,
              rawCandidate,
              targetSchema,
              workingFields,
              extractedFields,
              spaceId: request.spaceId,
              resolverDeps,
            })
          ) {
            populatedAnyInItem = true;
            break;
          }
        }
        continue;
      }

      const token = parsed.tokens[0];
      if (token.fieldKey in workingFields) {
        continue;
      }

      const targetField = targetSchema?.fields.find((f) => f.key === token.fieldKey);
      if (!isTargetableField(targetField)) {
        continue;
      }

      for (const rawCandidate of candidates) {
        const accepted =
          targetField.options !== undefined
            ? await resolveSingleTokenLookupCandidate({
                rawCandidate,
                binding,
                property: token.property,
                targetField,
                targetSchema,
                spaceId: request.spaceId,
                resolverDeps,
              })
            : (() => {
                const normalizeMode = inferPlainFieldNormalizeMode(targetField, binding);
                const normalized = applyFieldCandidateNormalize(rawCandidate, normalizeMode);
                return validateCandidateWithTuple(normalized, targetField, targetSchema);
              })();

        if (accepted) {
          recordExtractedField({
            fieldKey: token.fieldKey,
            value: accepted.value,
            matchedTuple: accepted.matchedTuple,
            targetSchema,
            workingFields,
            extractedFields,
          });
          populatedAnyInItem = true;
          break;
        }
      }
    }

    if (populatedAnyInItem || encounteredAmbiguousBoundWidget) {
      break;
    }
  }

  return { fields: extractedFields, statusMessages };
}
