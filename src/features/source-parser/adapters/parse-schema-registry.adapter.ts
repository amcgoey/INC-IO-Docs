import * as path from 'node:path';
import { Value } from '@sinclair/typebox/value';
import jsonLogic from 'json-logic-js';
import {
  DocumentParseSchemaSchema,
  DocumentFormSchemaSchema,
  AliasDictionarySchema,
  ParseTargetDocumentFieldSchema,
  ParseTargetCalculatedFieldSchema,
  ParseTargetDocumentOptionTupleSchema,
  ParseTargetDocumentSchemaSchema,
  ParseTargetOptionSourceSchema,
  type DocumentParseSchema,
  type DocumentFormSchema,
  type ParseTargetDocumentSchema,
  type ParseTargetDocumentField,
  type ParseTargetCalculatedField,
  type ParseTargetDocumentOptionTuple,
  type ParseTargetOptionSource,
  type ParseSchemaRegistryPort,
  type RawManifestProviderPort,
  type AliasDictionary,
  type FormTemplateParserPort,
} from '../ports';
import {
  classifyFormFieldMatcher,
  parseDocumentFieldTemplate,
} from '../form-field-parser';

export function validateJsonLogicAst(rule: unknown): void {
  if (rule === null || rule === undefined || typeof rule !== 'object') {
    return;
  }
  if (Array.isArray(rule)) {
    for (const item of rule) {
      validateJsonLogicAst(item);
    }
    return;
  }
  const keys = Object.keys(rule);
  if (keys.length !== 1) {
    throw new Error(
      `Invalid JsonLogic rule: operation object must have exactly 1 key, found ${keys.length}`
    );
  }
  const op = keys[0];
  if (typeof op !== 'string' || op.trim().length === 0) {
    throw new Error('Invalid JsonLogic rule: empty operator');
  }
  try {
    jsonLogic.apply({ [op]: [] }, {});
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Unrecognized operation')) {
      throw new Error(`Invalid JsonLogic AST: ${err.message}`, { cause: err });
    }
  }
  const operand = (rule as Record<string, unknown>)[op];
  validateJsonLogicAst(operand);
}

function assertTargetableFieldKey(
  fieldKey: string,
  knownFieldKeys: Set<string>,
  calcFieldKeys: Set<string>,
  linkedFieldKeys: Set<string>,
  prefix: string
): void {
  if (calcFieldKeys.has(fieldKey) && !knownFieldKeys.has(fieldKey)) {
    throw new Error(`${prefix} targets CalculatedField "${fieldKey}"`);
  }
  if (!knownFieldKeys.has(fieldKey)) {
    throw new Error(`${prefix} targets unknown field "${fieldKey}"`);
  }
  if (linkedFieldKeys.has(fieldKey)) {
    throw new Error(`${prefix} targets direct LinkedField "${fieldKey}"`);
  }
}

function validateUniqueNormalizedAliases(
  entries: Iterable<[string, unknown[]]>,
  messages: {
    emptyAlias: (canonicalKey: string) => string;
    duplicateAlias: (alias: string, norm: string, existingKey: string, canonicalKey: string) => string;
  }
): void {
  const seenAliases = new Map<string, string>();
  for (const [canonicalKey, aliases] of entries) {
    for (const alias of aliases) {
      if (typeof alias !== 'string' || alias.trim().length === 0) {
        throw new Error(messages.emptyAlias(canonicalKey));
      }
      const norm = alias.trim().toLowerCase();
      const existingKey = seenAliases.get(norm);
      if (existingKey !== undefined && existingKey !== canonicalKey) {
        throw new Error(messages.duplicateAlias(alias, norm, existingKey, canonicalKey));
      }
      seenAliases.set(norm, canonicalKey);
    }
  }
}

function validateValueMap(
  valueMap: Record<string, string>,
  targetField: ParseTargetDocumentField,
  cleanedOptions: Record<string, ParseTargetDocumentOptionTuple[]> | undefined,
  cleanedOptionSources: Record<string, ParseTargetOptionSource> | undefined,
  prefix: string
): void {
  if (!targetField.options) {
    throw new Error(`${prefix} specifies valueMap for non-LookupField "${targetField.key}"`);
  }

  const seenLabels = new Map<string, string>();
  for (const [mapKey, mapLabel] of Object.entries(valueMap)) {
    if (mapKey.trim().length === 0 || mapLabel.trim().length === 0) {
      throw new Error(`${prefix} contains empty or whitespace-only valueMap key or value`);
    }
    const normLabel = mapLabel.trim().toLowerCase();
    const existingKey = seenLabels.get(normLabel);
    if (existingKey !== undefined && existingKey !== mapKey) {
      throw new Error(
        `${prefix} contains duplicate case-insensitive valueMap label "${mapLabel}" across keys "${existingKey}" and "${mapKey}"`
      );
    }
    seenLabels.set(normLabel, mapKey);
  }

  if (cleanedOptionSources?.[targetField.options.source] !== undefined) {
    return;
  }

  const staticTuples = cleanedOptions?.[targetField.options.source];
  if (!staticTuples) {
    return;
  }

  const keyProp = targetField.options.key ?? 'key';
  const nameProp = targetField.options.name ?? 'name';

  for (const [mapKey, mapLabel] of Object.entries(valueMap)) {
    const matchesTuple = staticTuples.some(
      (tuple) => String(tuple[keyProp] ?? '') === mapKey
    );
    if (!matchesTuple) {
      throw new Error(
        `${prefix} valueMap key "${mapKey}" does not match any canonical option in "${targetField.options.source}"`
      );
    }

    const normLabel = mapLabel.trim().toLowerCase();
    for (const tuple of staticTuples) {
      const tupleKey = String(tuple[keyProp] ?? '');
      if (tupleKey === mapKey) {
        continue;
      }
      const tupleName = typeof tuple[nameProp] === 'string' ? tuple[nameProp] : undefined;
      if (
        tupleKey.trim().toLowerCase() === normLabel ||
        (tupleName !== undefined && tupleName.trim().toLowerCase() === normLabel)
      ) {
        throw new Error(
          `${prefix} valueMap label "${mapLabel}" for key "${mapKey}" collides with canonical option "${tupleKey}"`
        );
      }
    }
  }
}

function validateDocumentFormSchema(params: {
  rawFormSchema: unknown;
  relPath: string;
  formTemplateParser: FormTemplateParserPort | undefined;
  targetFields: ParseTargetDocumentField[];
  knownFieldKeys: Set<string>;
  calcFieldKeys: Set<string>;
  linkedFieldKeys: Set<string>;
  cleanedOptions: Record<string, ParseTargetDocumentOptionTuple[]> | undefined;
  cleanedOptionSources: Record<string, ParseTargetOptionSource> | undefined;
}): DocumentFormSchema {
  const {
    rawFormSchema,
    relPath,
    formTemplateParser,
    targetFields,
    knownFieldKeys,
    calcFieldKeys,
    linkedFieldKeys,
    cleanedOptions,
    cleanedOptionSources,
  } = params;

  if (!Value.Check(DocumentFormSchemaSchema, rawFormSchema)) {
    const errors = [...Value.Errors(DocumentFormSchemaSchema, rawFormSchema)]
      .map((e) => `${e.path}: ${e.message}`)
      .join(', ');
    throw new Error(`Invalid DocumentFormSchema structure in "${relPath}": ${errors}`);
  }

  if (!formTemplateParser) {
    throw new Error(
      `DocumentFormSchema in "${relPath}" requires a FormTemplateParserPort to validate field templates`
    );
  }

  const formSchema = rawFormSchema as DocumentFormSchema;

  for (const [formFieldName, binding] of Object.entries(formSchema.fields)) {
    if (formFieldName.trim().length === 0) {
      throw new Error(`DocumentFormSchema in "${relPath}" contains an empty form field name`);
    }

    const prefix = `DocumentFormSchema field "${formFieldName}" in "${relPath}"`;
    const parsed = parseDocumentFieldTemplate(formTemplateParser, binding.template);

    const seenFieldKeys = new Set<string>();
    for (const token of parsed.tokens) {
      if (seenFieldKeys.has(token.fieldKey)) {
        throw new Error(`${prefix} references duplicate field "${token.fieldKey}"`);
      }
      seenFieldKeys.add(token.fieldKey);

      assertTargetableFieldKey(
        token.fieldKey,
        knownFieldKeys,
        calcFieldKeys,
        linkedFieldKeys,
        prefix
      );

      const targetField = targetFields.find((f) => f.key === token.fieldKey)!;

      if (token.property !== undefined) {
        if (!targetField.options) {
          throw new Error(
            `${prefix} accesses property ".${token.property}" on non-LookupField "${token.fieldKey}"`
          );
        }
        const optionSource = cleanedOptionSources?.[targetField.options.source];
        if (optionSource !== undefined) {
          if (optionSource.properties !== undefined) {
            if (!optionSource.properties.includes(token.property)) {
              throw new Error(
                `${prefix} accesses unknown property ".${token.property}" on LookupField "${token.fieldKey}"`
              );
            }
          } else {
            const keyProp = targetField.options.key ?? 'key';
            const nameProp = targetField.options.name ?? keyProp;
            if (token.property !== keyProp && token.property !== nameProp) {
              throw new Error(
                `${prefix} accesses unknown property ".${token.property}" on LookupField "${token.fieldKey}"`
              );
            }
          }
        } else {
          const staticTuples = cleanedOptions?.[targetField.options.source];
          if (staticTuples !== undefined) {
            const keyProp = targetField.options.key ?? 'key';
            const nameProp = targetField.options.name ?? 'name';
            const isValidProp =
              token.property === keyProp ||
              token.property === nameProp ||
              staticTuples.some((tuple) => token.property! in tuple);
            if (!isValidProp) {
              throw new Error(
                `${prefix} accesses unknown property ".${token.property}" on LookupField "${token.fieldKey}"`
              );
            }
          }
        }
      }

      if (parsed.tokens.length > 1 && classifyFormFieldMatcher(targetField) === undefined) {
        throw new Error(
          `${prefix} multi-token template targets unsupported field "${token.fieldKey}"`
        );
      }
    }

    if (parsed.tokens.length > 1) {
      if (binding.format === 'date') {
        throw new Error(`${prefix} cannot specify format: "date" on a multi-token template`);
      }
      if (binding.valueMap !== undefined) {
        throw new Error(`${prefix} cannot specify valueMap on a multi-token template`);
      }
    } else if (binding.valueMap !== undefined) {
      const singleTargetField = targetFields.find((f) => f.key === parsed.tokens[0].fieldKey)!;
      validateValueMap(
        binding.valueMap,
        singleTargetField,
        cleanedOptions,
        cleanedOptionSources,
        prefix
      );
    }
  }

  return formSchema;
}

export class ParseSchemaRegistryAdapter implements ParseSchemaRegistryPort {
  private readonly parseSchemas = new Map<string, DocumentParseSchema>();
  private readonly targetSchemas = new Map<string, ParseTargetDocumentSchema>();
  private readonly formSchemas = new Map<string, DocumentFormSchema>();
  private readonly aliasDictionaries = new Map<string, AliasDictionary>();
  private initialized = false;

  constructor(
    private readonly manifestProvider?: RawManifestProviderPort | undefined,
    private readonly formTemplateParser?: FormTemplateParserPort | undefined
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

    const manifest = rawManifest as { documentTypes?: unknown[] };
    const documentTypes = Array.isArray(manifest.documentTypes) ? manifest.documentTypes : [];

    for (const item of documentTypes) {
      const relPath =
        typeof item === 'string'
          ? item
          : typeof (item as { path?: unknown })?.path === 'string'
            ? ((item as { path: string }).path)
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
      const rawFields = Array.isArray(rawDocSchema?.fields) ? rawDocSchema.fields : [];
      const rawCalcFields = Array.isArray(rawDocSchema?.calculatedFields)
        ? rawDocSchema.calculatedFields
        : [];
      const rawOptions =
        rawDocSchema?.options && typeof rawDocSchema.options === 'object'
          ? (rawDocSchema.options as Record<string, unknown>)
          : undefined;

      const targetFields: ParseTargetDocumentField[] = [];
      const knownFieldKeys = new Set<string>();
      const linkedFieldKeys = new Set<string>();

      for (const f of rawFields) {
        if (!f || typeof f !== 'object') {
          continue;
        }
        const rawOptions = (f as { options?: unknown }).options;
        if (
          rawOptions !== null &&
          typeof rawOptions === 'object' &&
          'dynamicConfig' in rawOptions &&
          (rawOptions as { dynamicConfig?: unknown }).dynamicConfig !== undefined
        ) {
          const fieldKey = (f as { key?: unknown }).key;
          throw new Error(
            `Field "${String(fieldKey ?? '')}" in "${relPath}" uses legacy options.dynamicConfig which is no longer supported; use documentSchema.optionSources instead`
          );
        }
        const cleanedField = Value.Clean(ParseTargetDocumentFieldSchema, structuredClone(f));
        if (Value.Check(ParseTargetDocumentFieldSchema, cleanedField)) {
          knownFieldKeys.add(cleanedField.key);
          if (cleanedField.linkedField) {
            linkedFieldKeys.add(cleanedField.key);
          }
          targetFields.push(cleanedField);
        }
      }

      let cleanedOptions: Record<string, ParseTargetDocumentOptionTuple[]> | undefined;
      if (rawOptions) {
        cleanedOptions = {};
        for (const [sourceKey, rawTuples] of Object.entries(rawOptions)) {
          if (!Array.isArray(rawTuples)) {
            continue;
          }
          const keyProp =
            targetFields.find((f) => f.options?.source === sourceKey)?.options?.key ?? 'key';
          const aliasEntries: Array<[string, unknown[]]> = [];
          const validTuples: ParseTargetDocumentOptionTuple[] = [];

          for (const rawTuple of rawTuples) {
            if (!rawTuple || typeof rawTuple !== 'object') {
              continue;
            }
            const tupleRec = rawTuple as Record<string, unknown>;
            const canonicalKey = String(tupleRec[keyProp] ?? tupleRec.key ?? '');
            if ('aliases' in tupleRec && tupleRec.aliases !== undefined) {
              if (!Array.isArray(tupleRec.aliases)) {
                throw new Error(
                  `Invalid aliases in option tuple for key "${canonicalKey}" in DocumentType "${documentTypeKey}": must be an array`
                );
              }
              aliasEntries.push([canonicalKey, tupleRec.aliases]);
            }
            const cleanedTuple = Value.Clean(
              ParseTargetDocumentOptionTupleSchema,
              structuredClone(tupleRec)
            );
            if (Value.Check(ParseTargetDocumentOptionTupleSchema, cleanedTuple)) {
              validTuples.push(cleanedTuple);
            }
          }

          validateUniqueNormalizedAliases(aliasEntries, {
            emptyAlias: (canonicalKey) =>
              `Empty or whitespace-only alias found in DocumentType "${documentTypeKey}" options "${sourceKey}" for key "${canonicalKey}"`,
            duplicateAlias: (alias, norm, existingKey, canonicalKey) =>
              `Duplicate alias "${alias}" (normalized "${norm}") in DocumentType "${documentTypeKey}" options "${sourceKey}" between keys "${existingKey}" and "${canonicalKey}"`,
          });

          cleanedOptions[sourceKey] = validTuples;
        }
      }

      const calcFieldKeys = new Set<string>();
      const targetCalcFields: ParseTargetCalculatedField[] = [];
      for (const cf of rawCalcFields) {
        if (!cf || typeof cf !== 'object') {
          continue;
        }
        const cleanedCalc = Value.Clean(ParseTargetCalculatedFieldSchema, structuredClone(cf));
        if (Value.Check(ParseTargetCalculatedFieldSchema, cleanedCalc)) {
          calcFieldKeys.add(cleanedCalc.key);
          targetCalcFields.push(cleanedCalc);
        }
      }

      const rawOptionSources = rawDocSchema?.optionSources;
      let cleanedOptionSources: Record<string, ParseTargetOptionSource> | undefined;
      if (rawOptionSources !== undefined) {
        if (
          rawOptionSources === null ||
          typeof rawOptionSources !== 'object' ||
          Array.isArray(rawOptionSources)
        ) {
          throw new Error(`Invalid documentSchema.optionSources in "${relPath}": must be an object`);
        }
        cleanedOptionSources = {};
        for (const [sourceKey, rawSource] of Object.entries(
          rawOptionSources as Record<string, unknown>
        )) {
          if (sourceKey.trim().length === 0) {
            throw new Error(
              `Invalid documentSchema.optionSources key in "${relPath}": must be non-empty`
            );
          }
          if (!Value.Check(ParseTargetOptionSourceSchema, rawSource)) {
            const errors = [...Value.Errors(ParseTargetOptionSourceSchema, rawSource)]
              .map((e) => `${e.path}: ${e.message}`)
              .join(', ');
            throw new Error(
              `Invalid documentSchema.optionSources["${sourceKey}"] in "${relPath}": ${errors}`
            );
          }
          const typedSource = structuredClone(rawSource) as ParseTargetOptionSource;
          if (typedSource.properties !== undefined) {
            for (const prop of typedSource.properties) {
              if (prop.trim().length === 0) {
                throw new Error(
                  `Invalid documentSchema.optionSources["${sourceKey}"] in "${relPath}": property names must be non-empty`
                );
              }
            }
          }
          if (
            typedSource.provider === 'google_drive' &&
            typedSource.relativePath !== undefined &&
            typedSource.relativePath.trim().length === 0
          ) {
            throw new Error(
              `Invalid documentSchema.optionSources["${sourceKey}"] in "${relPath}": relativePath must be non-empty`
            );
          }
          cleanedOptionSources[sourceKey] = typedSource;
        }
      }

      const candidateTargetSchema = Value.Clean(ParseTargetDocumentSchemaSchema, {
        fields: targetFields,
        calculatedFields: targetCalcFields,
        ...(cleanedOptions !== undefined ? { options: cleanedOptions } : {}),
        ...(cleanedOptionSources !== undefined ? { optionSources: cleanedOptionSources } : {}),
      });
      if (!Value.Check(ParseTargetDocumentSchemaSchema, candidateTargetSchema)) {
        const errors = [...Value.Errors(ParseTargetDocumentSchemaSchema, candidateTargetSchema)]
          .map((e) => `${e.path}: ${e.message}`)
          .join(', ');
        throw new Error(`Invalid ParseTargetDocumentSchema in "${relPath}": ${errors}`);
      }
      this.targetSchemas.set(documentTypeKey, candidateTargetSchema);

      let validatedFormSchema: DocumentFormSchema | undefined;
      if (docDef.documentFormSchema !== undefined) {
        validatedFormSchema = validateDocumentFormSchema({
          rawFormSchema: docDef.documentFormSchema,
          relPath,
          formTemplateParser: this.formTemplateParser,
          targetFields,
          knownFieldKeys,
          calcFieldKeys,
          linkedFieldKeys,
          cleanedOptions,
          cleanedOptionSources,
        });
        this.formSchemas.set(documentTypeKey, validatedFormSchema);
      }

      if (!docDef.documentParseSchema) {
        continue;
      }

      if (!Value.Check(DocumentParseSchemaSchema, docDef.documentParseSchema)) {
        const errors = [...Value.Errors(DocumentParseSchemaSchema, docDef.documentParseSchema)]
          .map((e) => `${e.path}: ${e.message}`)
          .join(', ');
        throw new Error(
          `Invalid DocumentParseSchema structure in "${relPath}": ${errors}`
        );
      }

      const parseSchema = docDef.documentParseSchema as DocumentParseSchema;

      for (const extractor of parseSchema.extractors) {
        if (extractor.match !== undefined) {
          validateJsonLogicAst(extractor.match);
        }

        if (extractor.source === 'form') {
          if (!validatedFormSchema) {
            throw new Error(
              `DocumentParseSchema in "${relPath}" declares a { source: "form" } extractor without a documentFormSchema`
            );
          }
          continue;
        }

        for (const [fieldKey, ruleOrRules] of Object.entries(extractor.fields)) {
          assertTargetableFieldKey(
            fieldKey,
            knownFieldKeys,
            calcFieldKeys,
            linkedFieldKeys,
            `DocumentParseSchema in "${relPath}"`
          );

          const rules = Array.isArray(ruleOrRules) ? ruleOrRules : [ruleOrRules];
          for (const rule of rules) {
            if (rule && typeof rule === 'object') {
              const typedRule = rule as {
                when?: unknown;
                pattern?: unknown;
                flags?: unknown;
                lookup?: unknown;
                excludePattern?: unknown;
              };
              if (typedRule.when !== undefined) {
                validateJsonLogicAst(typedRule.when);
              }
              if (typeof typedRule.pattern === 'string') {
                try {
                  new RegExp(typedRule.pattern, typeof typedRule.flags === 'string' ? typedRule.flags : 'i');
                } catch (err) {
                  throw new Error(
                    `DocumentParseSchema in "${relPath}" contains invalid RegExp pattern "${typedRule.pattern}": ${err instanceof Error ? err.message : String(err)}`,
                    { cause: err }
                  );
                }
              }
              if (typedRule.lookup === true) {
                const targetFld = targetFields.find((f) => f.key === fieldKey);
                if (!targetFld?.options) {
                  throw new Error(
                    `DocumentParseSchema in "${relPath}" specifies lookup: true for field "${fieldKey}" which does not have options`
                  );
                }
                if (typeof typedRule.excludePattern === 'string') {
                  try {
                    new RegExp(typedRule.excludePattern, 'i');
                  } catch (err) {
                    throw new Error(
                      `DocumentParseSchema in "${relPath}" contains invalid excludePattern "${typedRule.excludePattern}": ${err instanceof Error ? err.message : String(err)}`,
                      { cause: err }
                    );
                  }
                }
              }
            }
          }
        }
      }

      if (parseSchema.fallback?.fields) {
        for (const fieldKey of parseSchema.fallback.fields) {
          assertTargetableFieldKey(
            fieldKey,
            knownFieldKeys,
            calcFieldKeys,
            linkedFieldKeys,
            `DocumentParseSchema fallback in "${relPath}"`
          );
        }
      }

      this.parseSchemas.set(documentTypeKey, parseSchema);
    }

    const rawAliases = (manifest as { aliases?: unknown }).aliases;
    if (rawAliases && typeof rawAliases === 'object') {
      for (const [sourceKey, relPath] of Object.entries(rawAliases as Record<string, unknown>)) {
        if (typeof relPath !== 'string') {
          continue;
        }
        const rawDict = await this.manifestProvider.readParsedSchema(relPath);
        if (!rawDict || typeof rawDict !== 'object') {
          throw new Error(`Failed to load AliasDictionary at "${relPath}"`);
        }
        if (!Value.Check(AliasDictionarySchema, rawDict)) {
          const errors = [...Value.Errors(AliasDictionarySchema, rawDict)]
            .map((e) => `${e.path}: ${e.message}`)
            .join(', ');
          throw new Error(`Invalid AliasDictionary in "${relPath}": ${errors}`);
        }
        const aliasDict = rawDict as AliasDictionary;
        if (aliasDict.source !== sourceKey) {
          throw new Error(
            `AliasDictionary file "${relPath}" specifies source "${aliasDict.source}" but manifest expects "${sourceKey}"`
          );
        }
        validateUniqueNormalizedAliases(Object.entries(aliasDict.mappings), {
          emptyAlias: (canonicalKey) =>
            `Empty or whitespace-only alias in AliasDictionary "${relPath}" for key "${canonicalKey}"`,
          duplicateAlias: (alias, norm, existingKey, canonicalKey) =>
            `Duplicate alias "${alias}" (normalized "${norm}") in AliasDictionary "${relPath}" between keys "${existingKey}" and "${canonicalKey}"`,
        });

        const normalizedMappings: Record<string, string[]> = {};
        for (const [rawKey, aliases] of Object.entries(aliasDict.mappings)) {
          const normKey = rawKey.trim().toLowerCase();
          if (normKey.length === 0) {
            throw new Error(`Empty or whitespace-only key in AliasDictionary "${relPath}"`);
          }
          if (Object.prototype.hasOwnProperty.call(normalizedMappings, normKey)) {
            throw new Error(
              `Duplicate normalized key "${normKey}" in AliasDictionary "${relPath}" (for "${rawKey}")`
            );
          }
          normalizedMappings[normKey] = [...aliases];
        }

        this.aliasDictionaries.set(sourceKey, {
          source: aliasDict.source,
          mappings: normalizedMappings,
        });
      }
    }

    this.initialized = true;
  }

  getParseSchema(documentTypeKey: string): DocumentParseSchema | undefined {
    return this.parseSchemas.get(documentTypeKey);
  }

  getTargetSchema(documentTypeKey: string): ParseTargetDocumentSchema | undefined {
    return this.targetSchemas.get(documentTypeKey);
  }

  getDocumentFormSchema(documentTypeKey: string): DocumentFormSchema | undefined {
    return this.formSchemas.get(documentTypeKey);
  }

  getAliasDictionary(sourceKey: string): AliasDictionary | undefined {
    return this.aliasDictionaries.get(sourceKey);
  }
}
