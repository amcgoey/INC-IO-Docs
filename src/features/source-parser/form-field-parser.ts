import {
  SUPPORTED_FORM_MIME_TYPES,
  type DocumentFormFieldBinding,
  type DocumentFormSchema,
  type DriveItemHierarchy,
  type ExtractFieldsRequest,
  type FieldCandidateNormalize,
  type FormExtractorPort,
  type FormExtractorRule,
  type FormFieldValue,
  type FormTemplateParserPort,
  type ParsedFormTemplate,
  type ParseSchemaRegistryPort,
  type ParseTargetDocumentField,
  type ParseTargetDocumentOptionTuple,
  type ParseTargetDocumentSchema,
} from './ports';

export const PDF_FORM_ENCRYPTED_ERROR_MESSAGE =
  'Could not read PDF form fields because the file is password-protected; you can enter them manually.';

export const DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE =
  'Could not read document form fields because the file could not be parsed; you can enter them manually.';

interface HydratedDriveFormItemContext {
  hierarchy: DriveItemHierarchy;
  driveContext: Record<string, unknown>;
}

interface FormFieldEvaluatorHelpers {
  applyFieldCandidateNormalize: (
    candidate: string,
    normalize: FieldCandidateNormalize | undefined,
    timeZone: string | undefined,
    now?: (() => Date) | undefined
  ) => string | undefined;
  validateCandidateWithTuple: (
    candidate: string | undefined,
    targetField: ParseTargetDocumentField,
    targetSchema?: ParseTargetDocumentSchema
  ) => { value: string; matchedTuple?: ParseTargetDocumentOptionTuple | undefined } | undefined;
  resolveCanonicalOptionFromCandidate: (
    candidate: string,
    targetField: ParseTargetDocumentField,
    spaceId: string | undefined,
    targetSchema: ParseTargetDocumentSchema | undefined
  ) => Promise<{ value: string; matchedTuple: ParseTargetDocumentOptionTuple } | undefined>;
  populateLinkedFields: (
    fieldKey: string,
    matchedTuple: ParseTargetDocumentOptionTuple | undefined,
    targetSchema: ParseTargetDocumentSchema | undefined,
    populatedFields: Record<string, unknown>
  ) => void;
  evaluateCondition: (predicate: unknown, data: Record<string, unknown>) => boolean;
  driveMetadataErrorMessage: string;
  now?: (() => Date) | undefined;
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
  fieldKey: string
): FieldCandidateNormalize | undefined {
  if (targetField.pattern === '^\\d{6}$') {
    return 'digits6';
  }
  if (/^\^\\d\{3,?\}\$$/.test(targetField.pattern ?? '')) {
    return 'pad3';
  }
  if (fieldKey === 'revision') {
    return 'revision';
  }
  return undefined;
}

async function resolveSingleTokenLookupCandidate(params: {
  rawCandidate: string;
  binding: DocumentFormFieldBinding;
  property: string | undefined;
  targetField: ParseTargetDocumentField;
  targetSchema: ParseTargetDocumentSchema | undefined;
  spaceId: string | undefined;
  helpers: FormFieldEvaluatorHelpers;
}): Promise<{ value: string; matchedTuple?: ParseTargetDocumentOptionTuple | undefined } | undefined> {
  const { rawCandidate, binding, property, targetField, targetSchema, spaceId, helpers } = params;
  const mappedKey =
    binding.valueMap !== undefined
      ? resolveFormValueMapKey(rawCandidate, binding.valueMap)
      : undefined;
  const candidateToResolve = mappedKey ?? rawCandidate;

  const useCanonicalLookup =
    targetField.options?.dynamicConfig !== undefined ||
    targetField.options?.allowUserInput === true;

  if (useCanonicalLookup) {
    return helpers.resolveCanonicalOptionFromCandidate(
      candidateToResolve,
      targetField,
      spaceId,
      targetSchema
    );
  }

  const validated = helpers.validateCandidateWithTuple(
    candidateToResolve,
    targetField,
    targetSchema
  );
  if (validated) {
    return validated;
  }

  if (property !== undefined && targetField.options) {
    const keyProp = targetField.options.key ?? 'key';
    const staticTuples = targetSchema?.options?.[targetField.options.source] ?? [];
    const normCandidate = candidateToResolve.trim().toLowerCase();
    const matchedByProp = staticTuples.find((tuple) => {
      const propVal = tuple[property];
      return typeof propVal === 'string' && propVal.trim().toLowerCase() === normCandidate;
    });
    if (matchedByProp) {
      const canonicalKey = matchedByProp[keyProp] ?? matchedByProp.key;
      if (canonicalKey !== undefined && canonicalKey !== null) {
        return helpers.validateCandidateWithTuple(
          String(canonicalKey),
          targetField,
          targetSchema
        );
      }
    }
  }

  return undefined;
}

export async function extractFormExtractorFields(params: {
  extractor: FormExtractorRule;
  validItemIds: string[];
  request: ExtractFieldsRequest;
  targetSchema: ParseTargetDocumentSchema | undefined;
  jsonLogicContext: Record<string, unknown>;
  populatedFields: Record<string, unknown>;
  statusMessages: string[];
  timeZone: string | undefined;
  parseSchemaRegistry: ParseSchemaRegistryPort;
  formExtractor: FormExtractorPort | undefined;
  formTemplateParser: FormTemplateParserPort | undefined;
  getHydratedDriveItem: (itemId: string) => Promise<HydratedDriveFormItemContext>;
  helpers: FormFieldEvaluatorHelpers;
}): Promise<void> {
  const {
    extractor,
    validItemIds,
    request,
    targetSchema,
    jsonLogicContext,
    populatedFields,
    statusMessages,
    timeZone,
    parseSchemaRegistry,
    formExtractor,
    formTemplateParser,
    getHydratedDriveItem,
    helpers,
  } = params;

  if (request.context.email && request.context.isDriveUrl !== true) {
    return;
  }

  if (validItemIds.length === 0 || !formExtractor) {
    return;
  }

  const documentFormSchema: DocumentFormSchema | undefined =
    await parseSchemaRegistry.getDocumentFormSchema?.(request.documentTypeKey);
  if (!documentFormSchema || Object.keys(documentFormSchema.fields).length === 0) {
    return;
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
    const parsed = formTemplateParser.parseFieldTemplate(binding.template);
    parsedBindings.push({ formFieldName, binding, parsed });
    for (const token of parsed.tokens) {
      const targetField = targetSchema?.fields.find((f) => f.key === token.fieldKey);
      if (targetField && !targetField.linkedField) {
        referencedTargetKeys.add(token.fieldKey);
      }
    }
  }

  if (
    referencedTargetKeys.size === 0 ||
    Array.from(referencedTargetKeys).every((key) => key in populatedFields)
  ) {
    return;
  }

  for (const candidateItemId of validItemIds) {
    let hydrated: HydratedDriveFormItemContext;
    try {
      hydrated = await getHydratedDriveItem(candidateItemId);
    } catch {
      statusMessages.push(helpers.driveMetadataErrorMessage);
      continue;
    }

    const { hierarchy, driveContext } = hydrated;
    const mimeType = hierarchy.item.mimeType;
    if (!mimeType || !(SUPPORTED_FORM_MIME_TYPES as readonly string[]).includes(mimeType)) {
      continue;
    }

    const itemJsonLogicContext = { ...jsonLogicContext, drive: driveContext };
    if (extractor.match !== undefined && !helpers.evaluateCondition(extractor.match, itemJsonLogicContext)) {
      continue;
    }

    const outcome = await formExtractor.extractFormFields({
      id: hierarchy.item.id,
      mimeType,
    });

    if (outcome.status === 'encrypted') {
      statusMessages.push(PDF_FORM_ENCRYPTED_ERROR_MESSAGE);
      continue;
    }
    if (outcome.status === 'corrupted') {
      statusMessages.push(DOCUMENT_FORM_CORRUPTED_ERROR_MESSAGE);
      continue;
    }
    if (outcome.status === 'source_error') {
      statusMessages.push(helpers.driveMetadataErrorMessage);
      continue;
    }

    if (outcome.widgetCount === 0) {
      continue;
    }

    let populatedAnyInItem = false;

    for (const { formFieldName, binding, parsed } of parsedBindings) {
      if (outcome.ambiguousFields?.includes(formFieldName)) {
        continue;
      }

      const rawValue = Object.prototype.hasOwnProperty.call(outcome.fields, formFieldName)
        ? outcome.fields[formFieldName]
        : undefined;
      const candidates = coerceFormFieldValue(rawValue);
      if (candidates.length === 0) {
        continue;
      }

      if (parsed.tokens.length !== 1) {
        continue;
      }

      const token = parsed.tokens[0];
      if (token.fieldKey in populatedFields) {
        continue;
      }

      const targetField = targetSchema?.fields.find((f) => f.key === token.fieldKey);
      if (!targetField || targetField.linkedField) {
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
                helpers,
              })
            : (() => {
                const normalizeMode = inferPlainFieldNormalizeMode(targetField, token.fieldKey);
                const normalized = helpers.applyFieldCandidateNormalize(
                  rawCandidate,
                  normalizeMode,
                  timeZone,
                  helpers.now
                );
                return helpers.validateCandidateWithTuple(normalized, targetField, targetSchema);
              })();

        if (accepted) {
          populatedFields[token.fieldKey] = accepted.value;
          helpers.populateLinkedFields(
            token.fieldKey,
            accepted.matchedTuple,
            targetSchema,
            populatedFields
          );
          populatedAnyInItem = true;
          break;
        }
      }
    }

    if (populatedAnyInItem) {
      break;
    }
  }
}
