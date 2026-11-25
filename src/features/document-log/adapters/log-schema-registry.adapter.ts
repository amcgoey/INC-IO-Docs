import * as path from 'node:path';
import { Value } from '@sinclair/typebox/value';
import {
  DocumentLogConfigurationError,
  DocumentLogDiscoveryConfigOverrideSchema,
  DocumentLogDiscoveryConfigSchema,
  DocumentLogSchemaSchema,
  DocumentSpaceFetchMethodSchema,
  LogTargetCalculatedFieldSchema,
  LogTargetDocumentFieldSchema,
  LogTargetDocumentOptionTupleSchema,
  LogTargetDocumentSchemaSchema,
  LogTargetOptionSourceSchema,
  type DocumentLogDiscoveryConfig,
  type DocumentLogDiscoveryConfigOverride,
  type DocumentLogHistoryDisplay,
  type DocumentLogSchema,
  type DocumentSpaceFetchMethod,
  type LogParsedMustacheTemplate,
  type LogSchemaRegistryPort,
  type LogTargetCalculatedField,
  type LogTargetDocumentField,
  type LogTargetDocumentOptionTuple,
  type LogTargetDocumentSchema,
  type LogTargetOptionSource,
  type LogTemplateParserPort,
  type RawManifestProviderPort,
} from '../ports';

const DOCUMENT_SPACE_ALLOWED_PROPERTIES = new Set([
  'id',
  'typeId',
  'name',
  'abstractStorageId',
]);

const DISALLOWED_TEMPLATE_NAMESPACES = new Set([
  'Document',
  'calculated',
  'StorageContext',
  'Context',
  'DocumentSpace',
]);

function formatTypeboxErrors(errors: Iterable<{ path: string; message: string }>): string {
  return [...errors].map((e) => `${e.path}: ${e.message}`).join(', ');
}

function assertNonBlankString(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new DocumentLogConfigurationError(`${label} must be a non-empty string`);
  }
}

function parseTemplateOrThrow(
  parser: LogTemplateParserPort | undefined,
  template: string,
  contextLabel: string
): LogParsedMustacheTemplate {
  if (!parser) {
    throw new DocumentLogConfigurationError(
      `${contextLabel} requires a LogTemplateParserPort to validate templates`
    );
  }
  try {
    return parser.parseMustacheTemplate(template);
  } catch (error) {
    throw new DocumentLogConfigurationError(
      `${contextLabel} has invalid template "${template}": ${error instanceof Error ? error.message : String(error)}`,
      { cause: error }
    );
  }
}

const DISCOVERY_STRING_FIELDS = [
  'preferredFolderPath',
  'fileNameContains',
  'templateSpreadsheetId',
  'copyNameTemplate',
] as const;

const DISCOVERY_ARRAY_FIELDS = [
  'excludePrefixes',
  'excludeSubstrings',
] as const;

function validateDiscoveryConfig(
  rawConfig: unknown,
  parser: LogTemplateParserPort | undefined,
  configLabel = 'configuration.documentLog'
): DocumentLogDiscoveryConfig {
  if (!Value.Check(DocumentLogDiscoveryConfigSchema, rawConfig)) {
    const details = formatTypeboxErrors(Value.Errors(DocumentLogDiscoveryConfigSchema, rawConfig));
    throw new DocumentLogConfigurationError(
      `Invalid ${configLabel} structure: ${details}`
    );
  }

  const config = rawConfig as DocumentLogDiscoveryConfig;
  for (const field of DISCOVERY_STRING_FIELDS) {
    assertNonBlankString(config[field], `${configLabel}.${field}`);
  }
  for (const field of DISCOVERY_ARRAY_FIELDS) {
    for (const item of config[field]) {
      assertNonBlankString(item, `${configLabel}.${field}[]`);
    }
  }

  const parsedCopyName = parseTemplateOrThrow(
    parser,
    config.copyNameTemplate,
    `${configLabel}.copyNameTemplate`
  );
  for (const token of parsedCopyName.tokens) {
    if (
      token.parts.length !== 2 ||
      token.parts[0] !== 'DocumentSpace' ||
      !DOCUMENT_SPACE_ALLOWED_PROPERTIES.has(token.parts[1] ?? '')
    ) {
      throw new DocumentLogConfigurationError(
        `${configLabel}.copyNameTemplate references unsupported variable "{{${token.original}}}" (only DocumentSpace.* properties are allowed)`
      );
    }
  }

  return structuredClone(config);
}

function validateDiscoveryConfigOverride(
  rawOverride: unknown,
  configLabel: string
): DocumentLogDiscoveryConfigOverride {
  if (!Value.Check(DocumentLogDiscoveryConfigOverrideSchema, rawOverride)) {
    const details = formatTypeboxErrors(
      Value.Errors(DocumentLogDiscoveryConfigOverrideSchema, rawOverride)
    );
    throw new DocumentLogConfigurationError(`Invalid ${configLabel} structure: ${details}`);
  }

  const override = rawOverride as DocumentLogDiscoveryConfigOverride;
  for (const field of DISCOVERY_STRING_FIELDS) {
    const value = override[field];
    if (value !== undefined) {
      assertNonBlankString(value, `${configLabel}.${field}`);
    }
  }
  for (const field of DISCOVERY_ARRAY_FIELDS) {
    const items = override[field];
    if (items !== undefined) {
      for (const item of items) {
        assertNonBlankString(item, `${configLabel}.${field}[]`);
      }
    }
  }

  return override;
}

function mergeDiscoveryConfig(
  baseConfig: DocumentLogDiscoveryConfig | undefined,
  override: DocumentLogDiscoveryConfigOverride,
  parser: LogTemplateParserPort | undefined,
  configLabel: string
): DocumentLogDiscoveryConfig {
  const merged: Record<string, unknown> = baseConfig ? structuredClone(baseConfig) : {};
  for (const [key, value] of Object.entries(override)) {
    if (value !== undefined) {
      merged[key] = structuredClone(value);
    }
  }
  return validateDiscoveryConfig(merged, parser, configLabel);
}

function buildTargetDocumentSchema(
  rawDocSchema: Record<string, unknown> | undefined,
  relPath: string
): {
  targetSchema: LogTargetDocumentSchema;
  knownFieldKeys: Set<string>;
  calcFieldKeys: Set<string>;
} {
  const rawFields = Array.isArray(rawDocSchema?.fields) ? rawDocSchema.fields : [];
  const rawCalcFields = Array.isArray(rawDocSchema?.calculatedFields)
    ? rawDocSchema.calculatedFields
    : [];
  const rawOptions =
    rawDocSchema?.options && typeof rawDocSchema.options === 'object'
      ? (rawDocSchema.options as Record<string, unknown>)
      : undefined;
  const rawIdentity =
    rawDocSchema?.identity && typeof rawDocSchema.identity === 'object'
      ? (rawDocSchema.identity as Record<string, unknown>)
      : undefined;

  const targetFields: LogTargetDocumentField[] = [];
  const knownFieldKeys = new Set<string>();
  for (const rawField of rawFields) {
    if (!rawField || typeof rawField !== 'object') {
      continue;
    }
    const cleanedField = Value.Clean(LogTargetDocumentFieldSchema, structuredClone(rawField));
    if (Value.Check(LogTargetDocumentFieldSchema, cleanedField)) {
      knownFieldKeys.add(cleanedField.key);
      targetFields.push(cleanedField);
    }
  }

  const calcFieldKeys = new Set<string>();
  const targetCalcFields: LogTargetCalculatedField[] = [];
  for (const rawCalc of rawCalcFields) {
    if (!rawCalc || typeof rawCalc !== 'object') {
      continue;
    }
    const cleanedCalc = Value.Clean(LogTargetCalculatedFieldSchema, structuredClone(rawCalc));
    if (Value.Check(LogTargetCalculatedFieldSchema, cleanedCalc)) {
      calcFieldKeys.add(cleanedCalc.key);
      targetCalcFields.push(cleanedCalc);
    }
  }

  let cleanedOptions: Record<string, LogTargetDocumentOptionTuple[]> | undefined;
  if (rawOptions) {
    cleanedOptions = {};
    for (const [sourceKey, rawTuples] of Object.entries(rawOptions)) {
      if (!Array.isArray(rawTuples)) {
        continue;
      }
      const validTuples: LogTargetDocumentOptionTuple[] = [];
      for (const rawTuple of rawTuples) {
        if (!rawTuple || typeof rawTuple !== 'object') {
          continue;
        }
        const cleanedTuple = Value.Clean(
          LogTargetDocumentOptionTupleSchema,
          structuredClone(rawTuple)
        );
        if (Value.Check(LogTargetDocumentOptionTupleSchema, cleanedTuple)) {
          validTuples.push(cleanedTuple);
        }
      }
      cleanedOptions[sourceKey] = validTuples;
    }
  }

  let identity: Record<string, string> | undefined;
  if (rawIdentity) {
    const entries: Record<string, string> = {};
    for (const [k, v] of Object.entries(rawIdentity)) {
      if (typeof v === 'string') {
        entries[k] = v;
      }
    }
    if (Object.keys(entries).length > 0) {
      identity = entries;
    }
  }

  const rawOptionSources = rawDocSchema?.optionSources;
  let cleanedOptionSources: Record<string, LogTargetOptionSource> | undefined;
  if (rawOptionSources !== undefined) {
    if (
      rawOptionSources === null ||
      typeof rawOptionSources !== 'object' ||
      Array.isArray(rawOptionSources)
    ) {
      throw new DocumentLogConfigurationError(
        `Invalid documentSchema.optionSources in "${relPath}": must be an object`
      );
    }
    cleanedOptionSources = {};
    for (const [sourceKey, rawSource] of Object.entries(
      rawOptionSources as Record<string, unknown>
    )) {
      assertNonBlankString(
        sourceKey,
        `documentSchema.optionSources key in "${relPath}"`
      );
      if (!Value.Check(LogTargetOptionSourceSchema, rawSource)) {
        const details = formatTypeboxErrors(
          Value.Errors(LogTargetOptionSourceSchema, rawSource)
        );
        throw new DocumentLogConfigurationError(
          `Invalid documentSchema.optionSources["${sourceKey}"] in "${relPath}": ${details}`
        );
      }
      const typedSource = structuredClone(rawSource) as LogTargetOptionSource;
      if (typedSource.properties !== undefined) {
        for (const prop of typedSource.properties) {
          assertNonBlankString(
            prop,
            `documentSchema.optionSources["${sourceKey}"].properties[] in "${relPath}"`
          );
        }
      }
      if (
        typedSource.provider === 'google_drive' &&
        typedSource.relativePath !== undefined
      ) {
        assertNonBlankString(
          typedSource.relativePath,
          `documentSchema.optionSources["${sourceKey}"].relativePath in "${relPath}"`
        );
      }
      cleanedOptionSources[sourceKey] = typedSource;
    }
  }

  const candidateTargetSchema: LogTargetDocumentSchema = {
    fields: targetFields,
    ...(targetCalcFields.length > 0 ? { calculatedFields: targetCalcFields } : {}),
    ...(identity !== undefined ? { identity } : {}),
    ...(cleanedOptions !== undefined ? { options: cleanedOptions } : {}),
    ...(cleanedOptionSources !== undefined ? { optionSources: cleanedOptionSources } : {}),
  };

  if (!Value.Check(LogTargetDocumentSchemaSchema, candidateTargetSchema)) {
    const details = formatTypeboxErrors(
      Value.Errors(LogTargetDocumentSchemaSchema, candidateTargetSchema)
    );
    throw new DocumentLogConfigurationError(
      `Invalid LogTargetDocumentSchema in "${relPath}": ${details}`
    );
  }

  return {
    targetSchema: candidateTargetSchema,
    knownFieldKeys,
    calcFieldKeys,
  };
}

const SIMPLE_ALLOWED_CARD_HTML_TAGS = new Set(['b', 'i', 'u', 's', 'time']);
const ALLOWED_CARD_CLOSING_TAGS = new Set(['b', 'i', 'u', 's', 'font', 'a', 'time']);
const SAFE_FONT_COLOR_REGEX = /^(?:#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[a-zA-Z]{1,32})$/;
const SINGLE_ATTR_REGEX = /^([a-zA-Z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')$/;

function isValidHttpOrHttpsUrl(rawUrl: string): boolean {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0 || /[\r\n]/.test(trimmed)) {
    return false;
  }
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function validateSafeCardHtmlLiterals(
  literals: readonly string[],
  contextLabel: string
): void {
  const openTags: string[] = [];

  for (const literal of literals) {
    let cursor = 0;
    while (cursor < literal.length) {
      const ltIndex = literal.indexOf('<', cursor);
      const gtIndex = literal.indexOf('>', cursor);

      if (ltIndex === -1) {
        if (gtIndex !== -1) {
          throw new DocumentLogConfigurationError(
            `${contextLabel} contains an unmatched ">" character in HTML text`
          );
        }
        break;
      }

      if (gtIndex !== -1 && gtIndex < ltIndex) {
        throw new DocumentLogConfigurationError(
          `${contextLabel} contains an unmatched ">" character in HTML text`
        );
      }

      const closeBracket = literal.indexOf('>', ltIndex + 1);
      if (closeBracket === -1) {
        throw new DocumentLogConfigurationError(
          `${contextLabel} contains an unclosed "<" tag or mustache token inside an HTML tag`
        );
      }

      const rawTagContent = literal.slice(ltIndex + 1, closeBracket);
      if (rawTagContent.includes('<')) {
        throw new DocumentLogConfigurationError(
          `${contextLabel} contains malformed nested "<" inside HTML tag`
        );
      }

      const trimmedContent = rawTagContent.trim();
      if (trimmedContent.length === 0) {
        throw new DocumentLogConfigurationError(`${contextLabel} contains an empty "<>" HTML tag`);
      }

      if (trimmedContent.startsWith('/')) {
        const closeNameRaw = trimmedContent.slice(1).trim();
        if (!/^[a-zA-Z]+$/.test(closeNameRaw)) {
          throw new DocumentLogConfigurationError(
            `${contextLabel} contains invalid closing HTML tag "<${rawTagContent}>"`
          );
        }
        const closeName = closeNameRaw.toLowerCase();
        if (!ALLOWED_CARD_CLOSING_TAGS.has(closeName)) {
          throw new DocumentLogConfigurationError(
            `${contextLabel} uses disallowed closing HTML tag "</${closeNameRaw}>"`
          );
        }
        const expected = openTags.pop();
        if (expected !== closeName) {
          throw new DocumentLogConfigurationError(
            `${contextLabel} has unbalanced HTML tag "</${closeNameRaw}>" (expected ${expected ? `"</${expected}>"` : 'no closing tag'})`
          );
        }
      } else {
        const selfClosing = trimmedContent.endsWith('/');
        const withoutSlash = selfClosing ? trimmedContent.slice(0, -1).trim() : trimmedContent;
        const nameMatch = /^([a-zA-Z]+)(?:\s+([\s\S]*))?$/.exec(withoutSlash);
        if (!nameMatch) {
          throw new DocumentLogConfigurationError(
            `${contextLabel} contains unsupported or malformed HTML tag "<${rawTagContent}>"`
          );
        }
        const tagName = nameMatch[1].toLowerCase();
        const attrText = (nameMatch[2] ?? '').trim();

        if (tagName === 'br') {
          if (attrText.length > 0) {
            throw new DocumentLogConfigurationError(
              `${contextLabel} does not allow attributes on "<br>"`
            );
          }
        } else if (SIMPLE_ALLOWED_CARD_HTML_TAGS.has(tagName)) {
          if (selfClosing || attrText.length > 0) {
            throw new DocumentLogConfigurationError(
              `${contextLabel} does not allow attributes or self-closing syntax on "<${tagName}>"`
            );
          }
          openTags.push(tagName);
        } else if (tagName === 'font') {
          if (selfClosing) {
            throw new DocumentLogConfigurationError(
              `${contextLabel} does not allow self-closing "<font/>"`
            );
          }
          const attrMatch = SINGLE_ATTR_REGEX.exec(attrText);
          const attrName = attrMatch?.[1]?.toLowerCase();
          const attrValue = attrMatch?.[2] ?? attrMatch?.[3] ?? '';
          if (!attrMatch || attrName !== 'color' || !SAFE_FONT_COLOR_REGEX.test(attrValue)) {
            throw new DocumentLogConfigurationError(
              `${contextLabel} requires '<font color="...">' with a safe color value and no extra attributes`
            );
          }
          openTags.push('font');
        } else if (tagName === 'a') {
          if (selfClosing) {
            throw new DocumentLogConfigurationError(
              `${contextLabel} does not allow self-closing "<a/>"`
            );
          }
          if (openTags.includes('a')) {
            throw new DocumentLogConfigurationError(
              `${contextLabel} does not allow nested "<a>" tags`
            );
          }
          const attrMatch = SINGLE_ATTR_REGEX.exec(attrText);
          const attrName = attrMatch?.[1]?.toLowerCase();
          const attrValue = attrMatch?.[2] ?? attrMatch?.[3] ?? '';
          if (!attrMatch || attrName !== 'href' || !isValidHttpOrHttpsUrl(attrValue)) {
            throw new DocumentLogConfigurationError(
              `${contextLabel} requires '<a href="https://...">' with a valid http(s) URL and no extra attributes`
            );
          }
          openTags.push('a');
        } else {
          throw new DocumentLogConfigurationError(
            `${contextLabel} uses disallowed HTML tag "<${nameMatch[1]}>"`
          );
        }
      }

      cursor = closeBracket + 1;
    }
  }

  if (openTags.length > 0) {
    throw new DocumentLogConfigurationError(
      `${contextLabel} has unclosed HTML tag(s): ${openTags.map((t) => `<${t}>`).join(', ')}`
    );
  }
}

function validateStage1TemplateTokens(params: {
  template: string;
  contextLabel: string;
  requireAtLeastOneToken: boolean;
  parser: LogTemplateParserPort | undefined;
  targetSchema: LogTargetDocumentSchema;
  knownFieldKeys: ReadonlySet<string>;
  calcFieldKeys: ReadonlySet<string>;
}): LogParsedMustacheTemplate {
  const {
    template,
    contextLabel,
    requireAtLeastOneToken,
    parser,
    targetSchema,
    knownFieldKeys,
    calcFieldKeys,
  } = params;

  const parsed = parseTemplateOrThrow(parser, template, contextLabel);

  if (requireAtLeastOneToken && parsed.tokens.length === 0) {
    throw new DocumentLogConfigurationError(
      `${contextLabel} must reference at least one Stage-1 DocumentField token`
    );
  }

  for (const token of parsed.tokens) {
    if (
      token.parts.length < 1 ||
      token.parts.length > 2 ||
      token.parts.some((part) => part.trim().length === 0)
    ) {
      throw new DocumentLogConfigurationError(
        `${contextLabel} has invalid field path "${token.original}" (expected fieldKey or fieldKey.property)`
      );
    }

    const [fieldKey, property] = token.parts;
    if (DISALLOWED_TEMPLATE_NAMESPACES.has(fieldKey)) {
      throw new DocumentLogConfigurationError(
        `${contextLabel} uses disallowed namespace "${fieldKey}" in Stage-1 template`
      );
    }

    if (calcFieldKeys.has(fieldKey) && !knownFieldKeys.has(fieldKey)) {
      throw new DocumentLogConfigurationError(
        `${contextLabel} targets CalculatedField "${fieldKey}"`
      );
    }

    if (!knownFieldKeys.has(fieldKey)) {
      throw new DocumentLogConfigurationError(`${contextLabel} targets unknown field "${fieldKey}"`);
    }

    if (property !== undefined) {
      const targetField = targetSchema.fields.find((f) => f.key === fieldKey)!;
      if (!targetField.options) {
        throw new DocumentLogConfigurationError(
          `${contextLabel} accesses property ".${property}" on non-LookupField "${fieldKey}"`
        );
      }

      const optionSource = targetSchema.optionSources?.[targetField.options.source];
      if (optionSource !== undefined) {
        if (optionSource.properties !== undefined) {
          if (!optionSource.properties.includes(property)) {
            throw new DocumentLogConfigurationError(
              `${contextLabel} accesses unknown property ".${property}" on LookupField "${fieldKey}"`
            );
          }
        } else if (targetField.options.dynamicConfig === undefined) {
          const keyProp = targetField.options.key;
          const nameProp = targetField.options.name ?? keyProp;
          if (property !== keyProp && property !== nameProp) {
            throw new DocumentLogConfigurationError(
              `${contextLabel} accesses unknown property ".${property}" on LookupField "${fieldKey}"`
            );
          }
        }
      } else if (targetField.options.dynamicConfig === undefined) {
        const staticTuples = targetSchema.options?.[targetField.options.source];
        if (staticTuples !== undefined) {
          const keyProp = targetField.options.key;
          const nameProp = targetField.options.name ?? keyProp;
          const isValidProp =
            property === keyProp ||
            property === nameProp ||
            staticTuples.some((tuple) => property in tuple);
          if (!isValidProp) {
            throw new DocumentLogConfigurationError(
              `${contextLabel} accesses unknown property ".${property}" on LookupField "${fieldKey}"`
            );
          }
        }
      }
    }
  }

  return parsed;
}

function validateColumnTemplateBinding(params: {
  template: string;
  columnName: string;
  relPath: string;
  parser: LogTemplateParserPort | undefined;
  targetSchema: LogTargetDocumentSchema;
  knownFieldKeys: ReadonlySet<string>;
  calcFieldKeys: ReadonlySet<string>;
}): void {
  validateStage1TemplateTokens({
    template: params.template,
    contextLabel: `documentLogSchema column "${params.columnName}" in "${params.relPath}"`,
    requireAtLeastOneToken: true,
    parser: params.parser,
    targetSchema: params.targetSchema,
    knownFieldKeys: params.knownFieldKeys,
    calcFieldKeys: params.calcFieldKeys,
  });
}

function validateHistoryDisplay(params: {
  historyDisplay: DocumentLogHistoryDisplay;
  relPath: string;
  parser: LogTemplateParserPort | undefined;
  targetSchema: LogTargetDocumentSchema;
  knownFieldKeys: ReadonlySet<string>;
  calcFieldKeys: ReadonlySet<string>;
}): void {
  const { historyDisplay, relPath, parser, targetSchema, knownFieldKeys, calcFieldKeys } = params;

  const textLabel = `documentLogSchema.historyDisplay.text in "${relPath}"`;
  assertNonBlankString(historyDisplay.text, textLabel);
  const parsedText = validateStage1TemplateTokens({
    template: historyDisplay.text,
    contextLabel: textLabel,
    requireAtLeastOneToken: true,
    parser,
    targetSchema,
    knownFieldKeys,
    calcFieldKeys,
  });
  validateSafeCardHtmlLiterals(parsedText.literals, textLabel);

  if (historyDisplay.topLabel !== undefined) {
    const topLabelCtx = `documentLogSchema.historyDisplay.topLabel in "${relPath}"`;
    assertNonBlankString(historyDisplay.topLabel, topLabelCtx);
    validateStage1TemplateTokens({
      template: historyDisplay.topLabel,
      contextLabel: topLabelCtx,
      requireAtLeastOneToken: false,
      parser,
      targetSchema,
      knownFieldKeys,
      calcFieldKeys,
    });
  }

  if (historyDisplay.bottomLabel !== undefined) {
    const bottomLabelCtx = `documentLogSchema.historyDisplay.bottomLabel in "${relPath}"`;
    assertNonBlankString(historyDisplay.bottomLabel, bottomLabelCtx);
    validateStage1TemplateTokens({
      template: historyDisplay.bottomLabel,
      contextLabel: bottomLabelCtx,
      requireAtLeastOneToken: false,
      parser,
      targetSchema,
      knownFieldKeys,
      calcFieldKeys,
    });
  }
}

function validateDocumentLogSchema(params: {
  rawLogSchema: unknown;
  relPath: string;
  parser: LogTemplateParserPort | undefined;
  targetSchema: LogTargetDocumentSchema;
  knownFieldKeys: ReadonlySet<string>;
  calcFieldKeys: ReadonlySet<string>;
}): DocumentLogSchema {
  const { rawLogSchema, relPath, parser, targetSchema, knownFieldKeys, calcFieldKeys } = params;

  if (!Value.Check(DocumentLogSchemaSchema, rawLogSchema)) {
    const details = formatTypeboxErrors(Value.Errors(DocumentLogSchemaSchema, rawLogSchema));
    throw new DocumentLogConfigurationError(
      `Invalid documentLogSchema in "${relPath}": ${details}`
    );
  }

  const logSchema = rawLogSchema as DocumentLogSchema;
  assertNonBlankString(logSchema.target.sheetName, `documentLogSchema.target.sheetName in "${relPath}"`);
  assertNonBlankString(logSchema.target.rangeName, `documentLogSchema.target.rangeName in "${relPath}"`);
  assertNonBlankString(logSchema.target.extentMarker, `documentLogSchema.target.extentMarker in "${relPath}"`);
  assertNonBlankString(
    logSchema.target.groupDividerMarker,
    `documentLogSchema.target.groupDividerMarker in "${relPath}"`
  );
  assertNonBlankString(logSchema.grouping.groupBy, `documentLogSchema.grouping.groupBy in "${relPath}"`);
  assertNonBlankString(logSchema.grouping.sortBy, `documentLogSchema.grouping.sortBy in "${relPath}"`);

  const identity = targetSchema.identity ?? {};
  if (
    typeof identity[logSchema.grouping.groupBy] !== 'string' ||
    identity[logSchema.grouping.groupBy].trim().length === 0
  ) {
    throw new DocumentLogConfigurationError(
      `documentLogSchema.grouping.groupBy "${logSchema.grouping.groupBy}" in "${relPath}" does not exist in documentSchema.identity`
    );
  }
  if (
    typeof identity[logSchema.grouping.sortBy] !== 'string' ||
    identity[logSchema.grouping.sortBy].trim().length === 0
  ) {
    throw new DocumentLogConfigurationError(
      `documentLogSchema.grouping.sortBy "${logSchema.grouping.sortBy}" in "${relPath}" does not exist in documentSchema.identity`
    );
  }

  for (const [columnName, binding] of Object.entries(logSchema.columns)) {
    assertNonBlankString(columnName, `documentLogSchema.columns key in "${relPath}"`);
    if ('template' in binding) {
      validateColumnTemplateBinding({
        template: binding.template,
        columnName,
        relPath,
        parser,
        targetSchema,
        knownFieldKeys,
        calcFieldKeys,
      });
    } else if (binding.label !== undefined) {
      assertNonBlankString(
        binding.label,
        `documentLogSchema.columns["${columnName}"].label in "${relPath}"`
      );
    }
  }

  if (logSchema.historyDisplay !== undefined) {
    validateHistoryDisplay({
      historyDisplay: logSchema.historyDisplay,
      relPath,
      parser,
      targetSchema,
      knownFieldKeys,
      calcFieldKeys,
    });
  }

  const optionBindings = logSchema.optionBindings;
  if (optionBindings !== undefined) {
    for (const [sourceKey, binding] of Object.entries(optionBindings)) {
      assertNonBlankString(sourceKey, `documentLogSchema.optionBindings key in "${relPath}"`);
      assertNonBlankString(
        binding.sheetName,
        `documentLogSchema.optionBindings["${sourceKey}"].sheetName in "${relPath}"`
      );
      assertNonBlankString(
        binding.rangeName,
        `documentLogSchema.optionBindings["${sourceKey}"].rangeName in "${relPath}"`
      );
      if (binding.validationRangeName !== undefined) {
        assertNonBlankString(
          binding.validationRangeName,
          `documentLogSchema.optionBindings["${sourceKey}"].validationRangeName in "${relPath}"`
        );
      }
      assertNonBlankString(
        binding.endMarker,
        `documentLogSchema.optionBindings["${sourceKey}"].endMarker in "${relPath}"`
      );
      for (const [headerName, propName] of Object.entries(binding.columns)) {
        assertNonBlankString(
          headerName,
          `documentLogSchema.optionBindings["${sourceKey}"].columns header in "${relPath}"`
        );
        assertNonBlankString(
          propName,
          `documentLogSchema.optionBindings["${sourceKey}"].columns["${headerName}"] in "${relPath}"`
        );
      }
      if (binding.aliasesColumn !== undefined) {
        assertNonBlankString(
          binding.aliasesColumn,
          `documentLogSchema.optionBindings["${sourceKey}"].aliasesColumn in "${relPath}"`
        );
      }
      const optionSource = targetSchema.optionSources?.[sourceKey];
      if (!optionSource || optionSource.provider !== 'document_log') {
        throw new DocumentLogConfigurationError(
          `documentLogSchema.optionBindings["${sourceKey}"] in "${relPath}" does not match a document_log OptionSource in documentSchema.optionSources`
        );
      }
    }
  }

  for (const [sourceKey, optionSource] of Object.entries(targetSchema.optionSources ?? {})) {
    if (optionSource.provider !== 'document_log') {
      continue;
    }
    const binding = optionBindings?.[sourceKey];
    if (!binding) {
      throw new DocumentLogConfigurationError(
        `documentLogSchema.optionBindings in "${relPath}" is missing binding for document_log OptionSource "${sourceKey}"`
      );
    }
    const mappedProperties = new Set(Object.values(binding.columns));
    const missingProperties = optionSource.properties.filter(
      (prop) => !mappedProperties.has(prop)
    );
    if (missingProperties.length > 0) {
      throw new DocumentLogConfigurationError(
        `documentLogSchema.optionBindings["${sourceKey}"] in "${relPath}" is missing column mappings for declared properties: ${missingProperties.join(', ')}`
      );
    }
  }

  return structuredClone(logSchema);
}

function validateDocumentLogWorkflowSteps(params: {
  rawWorkflowConfig: unknown;
  relPath: string;
  hasDocumentLogSchema: boolean;
}): void {
  const { rawWorkflowConfig, relPath, hasDocumentLogSchema } = params;
  if (!rawWorkflowConfig || typeof rawWorkflowConfig !== 'object') {
    return;
  }
  const workflows = (rawWorkflowConfig as { workflows?: unknown }).workflows;
  if (!Array.isArray(workflows)) {
    return;
  }

  for (const workflow of workflows) {
    if (!workflow || typeof workflow !== 'object') {
      continue;
    }
    const wfName = String((workflow as { name?: unknown }).name ?? 'unnamed');
    const activitySequence = (workflow as { activitySequence?: unknown }).activitySequence;
    if (!Array.isArray(activitySequence)) {
      continue;
    }

    const seenStepIds = new Set<string>();
    for (const rawActivity of activitySequence) {
      if (!rawActivity || typeof rawActivity !== 'object') {
        continue;
      }
      const activity = rawActivity as {
        id?: unknown;
        type?: unknown;
        payload?: unknown;
      };

      if (activity.type === 'WRITE_LOG' || activity.type === 'READ_LOG') {
        if (!hasDocumentLogSchema) {
          throw new DocumentLogConfigurationError(
            `Workflow "${wfName}" in "${relPath}" uses ${activity.type} without declaring documentLogSchema`
          );
        }

        if (
          activity.type === 'WRITE_LOG' &&
          activity.payload &&
          typeof activity.payload === 'object' &&
          'fileSourceStepId' in activity.payload &&
          (activity.payload as { fileSourceStepId?: unknown }).fileSourceStepId !== undefined
        ) {
          const stepId = (activity.payload as { fileSourceStepId: unknown }).fileSourceStepId;
          if (typeof stepId !== 'string' || !seenStepIds.has(stepId)) {
            throw new DocumentLogConfigurationError(
              `WRITE_LOG step in workflow "${wfName}" ("${relPath}") has invalid fileSourceStepId "${String(stepId)}": must match an earlier Activity.id`
            );
          }
        }
      }

      if (typeof activity.id === 'string' && activity.id.trim().length > 0) {
        seenStepIds.add(activity.id);
      }
    }
  }
}

/**
 * Hydrates and fail-fast validates `configuration.documentLog`, per-`DocumentSpaceType`
 * `documentLog` overrides / `fetchMethod`, per-`DocumentType` `documentLogSchema`,
 * and minimal target `DocumentSchema` metadata from `RawManifestProviderPort`.
 */
export class LogSchemaRegistryAdapter implements LogSchemaRegistryPort {
  private discoveryConfig: DocumentLogDiscoveryConfig | undefined;
  private readonly spaceDiscoveryConfigs = new Map<string, DocumentLogDiscoveryConfig>();
  private readonly spaceFetchMethods = new Map<string, DocumentSpaceFetchMethod>();
  private readonly logSchemas = new Map<string, DocumentLogSchema>();
  private readonly targetSchemas = new Map<string, LogTargetDocumentSchema>();
  private initialized = false;

  constructor(
    private readonly manifestProvider?: RawManifestProviderPort | undefined,
    private readonly templateParser?: LogTemplateParserPort | undefined
  ) {}

  async initialize(): Promise<void> {
    if (this.initialized) {
      return;
    }
    if (!this.manifestProvider) {
      this.initialized = true;
      return;
    }

    const rawManifest = await this.manifestProvider.getRawManifest();
    if (!rawManifest || typeof rawManifest !== 'object') {
      this.initialized = true;
      return;
    }

    const manifest = rawManifest as {
      documentTypes?: unknown[];
      configuration?: { documentLog?: unknown };
      DocumentSpaceTypes?: unknown[];
    };

    const rawDiscovery = manifest.configuration?.documentLog;
    const nextDiscoveryConfig =
      rawDiscovery !== undefined
        ? validateDiscoveryConfig(rawDiscovery, this.templateParser)
        : undefined;

    const nextSpaceDiscoveryConfigs = new Map<string, DocumentLogDiscoveryConfig>();
    const nextSpaceFetchMethods = new Map<string, DocumentSpaceFetchMethod>();
    const spaceTypes = Array.isArray(manifest.DocumentSpaceTypes)
      ? manifest.DocumentSpaceTypes
      : [];

    for (const rawSpaceType of spaceTypes) {
      if (!rawSpaceType || typeof rawSpaceType !== 'object') {
        continue;
      }
      const spaceType = rawSpaceType as {
        id?: unknown;
        storageConfig?: unknown;
        documentLog?: unknown;
      };
      const spaceTypeId = typeof spaceType.id === 'string' ? spaceType.id.trim() : '';
      const hasId = spaceTypeId.length > 0;

      if (spaceType.documentLog !== undefined) {
        if (!hasId) {
          throw new DocumentLogConfigurationError(
            'DocumentSpaceTypes entry declaring documentLog must have a non-empty id'
          );
        }
        const configLabel = `DocumentSpaceTypes["${spaceTypeId}"].documentLog`;
        const validatedOverride = validateDiscoveryConfigOverride(
          spaceType.documentLog,
          configLabel
        );
        const mergedConfig = mergeDiscoveryConfig(
          nextDiscoveryConfig,
          validatedOverride,
          this.templateParser,
          configLabel
        );
        nextSpaceDiscoveryConfigs.set(spaceTypeId, mergedConfig);
      }

      if (hasId && spaceType.storageConfig && typeof spaceType.storageConfig === 'object') {
        const rawFetchMethod = (spaceType.storageConfig as { fetchMethod?: unknown }).fetchMethod;
        if (Value.Check(DocumentSpaceFetchMethodSchema, rawFetchMethod)) {
          nextSpaceFetchMethods.set(spaceTypeId, rawFetchMethod);
        }
      }
    }

    const nextLogSchemas = new Map<string, DocumentLogSchema>();
    const nextTargetSchemas = new Map<string, LogTargetDocumentSchema>();
    const documentTypes = Array.isArray(manifest.documentTypes) ? manifest.documentTypes : [];

    for (const item of documentTypes) {
      const relPath =
        typeof item === 'string'
          ? item
          : typeof (item as { path?: unknown })?.path === 'string'
            ? (item as { path: string }).path
            : undefined;
      if (!relPath) {
        continue;
      }

      const rawDocDef = await this.manifestProvider.readParsedSchema(relPath);
      if (!rawDocDef || typeof rawDocDef !== 'object') {
        continue;
      }

      const docDef = rawDocDef as Record<string, unknown>;
      const documentTypeKey =
        typeof docDef.key === 'string' && docDef.key.trim().length > 0
          ? docDef.key.trim()
          : path.basename(relPath, '.json');

      const rawDocSchema =
        docDef.documentSchema && typeof docDef.documentSchema === 'object'
          ? (docDef.documentSchema as Record<string, unknown>)
          : undefined;

      const { targetSchema, knownFieldKeys, calcFieldKeys } = buildTargetDocumentSchema(
        rawDocSchema,
        relPath
      );
      nextTargetSchemas.set(documentTypeKey, targetSchema);

      const hasDocumentLogSchema = docDef.documentLogSchema !== undefined;
      if (!hasDocumentLogSchema) {
        for (const [sourceKey, optionSource] of Object.entries(targetSchema.optionSources ?? {})) {
          if (optionSource.provider === 'document_log') {
            throw new DocumentLogConfigurationError(
              `DocumentType "${relPath}" declares document_log OptionSource "${sourceKey}" without declaring documentLogSchema`
            );
          }
        }
      } else {
        const validatedLogSchema = validateDocumentLogSchema({
          rawLogSchema: docDef.documentLogSchema,
          relPath,
          parser: this.templateParser,
          targetSchema,
          knownFieldKeys,
          calcFieldKeys,
        });
        nextLogSchemas.set(documentTypeKey, validatedLogSchema);
      }

      validateDocumentLogWorkflowSteps({
        rawWorkflowConfig: docDef.documentWorkflowConfig,
        relPath,
        hasDocumentLogSchema,
      });
    }

    if (nextLogSchemas.size > 0 && nextDiscoveryConfig === undefined) {
      throw new DocumentLogConfigurationError(
        'Manifest configuration.documentLog is required when at least one DocumentType declares documentLogSchema'
      );
    }

    this.discoveryConfig = nextDiscoveryConfig;
    this.spaceDiscoveryConfigs.clear();
    for (const [k, v] of nextSpaceDiscoveryConfigs.entries()) {
      this.spaceDiscoveryConfigs.set(k, v);
    }
    this.spaceFetchMethods.clear();
    for (const [k, v] of nextSpaceFetchMethods.entries()) {
      this.spaceFetchMethods.set(k, v);
    }
    this.logSchemas.clear();
    for (const [k, v] of nextLogSchemas.entries()) {
      this.logSchemas.set(k, v);
    }
    this.targetSchemas.clear();
    for (const [k, v] of nextTargetSchemas.entries()) {
      this.targetSchemas.set(k, v);
    }
    this.initialized = true;
  }

  getDiscoveryConfig(spaceTypeId?: string): DocumentLogDiscoveryConfig | undefined {
    if (spaceTypeId !== undefined) {
      const override = this.spaceDiscoveryConfigs.get(spaceTypeId);
      if (override !== undefined) {
        return override;
      }
    }
    return this.discoveryConfig;
  }

  getSpaceFetchMethod(spaceTypeId: string): DocumentSpaceFetchMethod | undefined {
    return this.spaceFetchMethods.get(spaceTypeId);
  }

  getDocumentLogSchema(documentTypeKey: string): DocumentLogSchema | undefined {
    return this.logSchemas.get(documentTypeKey);
  }

  getTargetSchema(documentTypeKey: string): LogTargetDocumentSchema | undefined {
    return this.targetSchemas.get(documentTypeKey);
  }
}
