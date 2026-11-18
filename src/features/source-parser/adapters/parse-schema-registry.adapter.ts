import * as path from 'node:path';
import { Value } from '@sinclair/typebox/value';
import jsonLogic from 'json-logic-js';
import {
  DocumentParseSchemaSchema,
  AliasDictionarySchema,
  type DocumentParseSchema,
  type ParseTargetDocumentSchema,
  type ParseTargetDocumentField,
  type ParseTargetDocumentOptionTuple,
  type ParseSchemaRegistryPort,
  type RawManifestProviderPort,
  type AliasDictionary,
} from '../ports';

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

export class ParseSchemaRegistryAdapter implements ParseSchemaRegistryPort {
  private readonly parseSchemas = new Map<string, DocumentParseSchema>();
  private readonly targetSchemas = new Map<string, ParseTargetDocumentSchema>();
  private readonly aliasDictionaries = new Map<string, AliasDictionary>();
  private initialized = false;

  constructor(private readonly manifestProvider?: RawManifestProviderPort | undefined) {}

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
    if (!Array.isArray(manifest.documentTypes)) {
      this.initialized = true;
      return;
    }

    for (const item of manifest.documentTypes) {
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

      const rawDocSchema = docDef.documentSchema as Record<string, unknown> | undefined;
      const rawFields = Array.isArray(rawDocSchema?.fields) ? rawDocSchema.fields : [];
      const rawCalcFields = Array.isArray(rawDocSchema?.calculatedFields)
        ? rawDocSchema.calculatedFields
        : [];
      const rawOptions =
        rawDocSchema?.options && typeof rawDocSchema.options === 'object'
          ? (rawDocSchema.options as Record<string, ParseTargetDocumentOptionTuple[]>)
          : undefined;

      const targetFields: ParseTargetDocumentField[] = [];
      const knownFieldKeys = new Set<string>();
      const linkedFieldKeys = new Set<string>();

      for (const f of rawFields) {
        if (f && typeof f === 'object' && typeof (f as { key?: unknown }).key === 'string') {
          const fieldObj = f as {
            key: string;
            name?: unknown;
            type?: unknown;
            minLength?: unknown;
            pattern?: unknown;
            options?: {
              source?: unknown;
              key?: unknown;
              name?: unknown;
              allowUserInput?: unknown;
              dynamicConfig?: unknown;
            };
            linkedField?: {
              sourceField?: unknown;
              sourceProperty?: unknown;
            };
          };

          knownFieldKeys.add(fieldObj.key);
          if (fieldObj.linkedField) {
            linkedFieldKeys.add(fieldObj.key);
          }

          targetFields.push({
            key: fieldObj.key,
            ...(typeof fieldObj.name === 'string' ? { name: fieldObj.name } : {}),
            ...(typeof fieldObj.type === 'string' ? { type: fieldObj.type } : {}),
            ...(typeof fieldObj.minLength === 'number' ? { minLength: fieldObj.minLength } : {}),
            ...(typeof fieldObj.pattern === 'string' ? { pattern: fieldObj.pattern } : {}),
            ...(fieldObj.options && typeof fieldObj.options === 'object'
              ? {
                  options: {
                    source: String(fieldObj.options.source ?? ''),
                    key: String(fieldObj.options.key ?? 'key'),
                    ...(typeof fieldObj.options.name === 'string'
                      ? { name: fieldObj.options.name }
                      : {}),
                    ...(typeof fieldObj.options.allowUserInput === 'boolean'
                      ? { allowUserInput: fieldObj.options.allowUserInput }
                      : {}),
                    ...(fieldObj.options.dynamicConfig && typeof fieldObj.options.dynamicConfig === 'object'
                      ? { dynamicConfig: fieldObj.options.dynamicConfig as Record<string, unknown> }
                      : {}),
                  },
                }
              : {}),
            ...(fieldObj.linkedField && typeof fieldObj.linkedField === 'object'
              ? {
                  linkedField: {
                    sourceField: String(fieldObj.linkedField.sourceField ?? ''),
                    sourceProperty: String(fieldObj.linkedField.sourceProperty ?? ''),
                  },
                }
              : {}),
          });
        }
      }

      if (rawOptions && typeof rawOptions === 'object') {
        for (const [sourceKey, tuples] of Object.entries(rawOptions)) {
          if (Array.isArray(tuples)) {
            const seenTier1Aliases = new Map<string, string>();
            for (const tuple of tuples) {
              if (tuple && typeof tuple === 'object') {
                const canonicalKey = String(tuple.key ?? '');
                if ('aliases' in tuple && tuple.aliases !== undefined) {
                  if (!Array.isArray(tuple.aliases)) {
                    throw new Error(
                      `Invalid aliases in option tuple for key "${canonicalKey}" in DocumentType "${documentTypeKey}": must be an array`
                    );
                  }
                  for (const alias of tuple.aliases) {
                    if (typeof alias !== 'string' || alias.trim().length === 0) {
                      throw new Error(
                        `Empty or whitespace-only alias found in DocumentType "${documentTypeKey}" options "${sourceKey}" for key "${canonicalKey}"`
                      );
                    }
                    const norm = alias.trim().toLowerCase();
                    const existingKey = seenTier1Aliases.get(norm);
                    if (existingKey !== undefined && existingKey !== canonicalKey) {
                      throw new Error(
                        `Duplicate alias "${alias}" (normalized "${norm}") in DocumentType "${documentTypeKey}" options "${sourceKey}" between keys "${existingKey}" and "${canonicalKey}"`
                      );
                    }
                    seenTier1Aliases.set(norm, canonicalKey);
                  }
                }
              }
            }
          }
        }
      }

      const calcFieldKeys = new Set<string>();
      const targetCalcFields: Array<{ key: string; name?: string }> = [];
      for (const cf of rawCalcFields) {
        if (cf && typeof cf === 'object' && typeof (cf as { key?: unknown }).key === 'string') {
          const key = (cf as { key: string }).key;
          calcFieldKeys.add(key);
          targetCalcFields.push({
            key,
            ...(typeof (cf as { name?: unknown }).name === 'string'
              ? { name: (cf as { name: string }).name }
              : {}),
          });
        }
      }

      this.targetSchemas.set(documentTypeKey, {
        fields: targetFields,
        calculatedFields: targetCalcFields,
        ...(rawOptions !== undefined ? { options: rawOptions } : {}),
      });

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

        for (const [fieldKey, ruleOrRules] of Object.entries(extractor.fields)) {
          if (calcFieldKeys.has(fieldKey) && !knownFieldKeys.has(fieldKey)) {
            throw new Error(
              `DocumentParseSchema in "${relPath}" targets CalculatedField "${fieldKey}"`
            );
          }
          if (!knownFieldKeys.has(fieldKey)) {
            throw new Error(
              `DocumentParseSchema in "${relPath}" targets unknown field "${fieldKey}"`
            );
          }
          if (linkedFieldKeys.has(fieldKey)) {
            throw new Error(
              `DocumentParseSchema in "${relPath}" targets direct LinkedField "${fieldKey}"`
            );
          }

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
          if (calcFieldKeys.has(fieldKey) && !knownFieldKeys.has(fieldKey)) {
            throw new Error(
              `DocumentParseSchema fallback in "${relPath}" targets CalculatedField "${fieldKey}"`
            );
          }
          if (!knownFieldKeys.has(fieldKey)) {
            throw new Error(
              `DocumentParseSchema fallback in "${relPath}" targets unknown field "${fieldKey}"`
            );
          }
          if (linkedFieldKeys.has(fieldKey)) {
            throw new Error(
              `DocumentParseSchema fallback in "${relPath}" targets direct LinkedField "${fieldKey}"`
            );
          }
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
        const cleaned = Value.Clean(AliasDictionarySchema, structuredClone(rawDict));
        if (!Value.Check(AliasDictionarySchema, cleaned)) {
          const errors = [...Value.Errors(AliasDictionarySchema, cleaned)]
            .map((e) => `${e.path}: ${e.message}`)
            .join(', ');
          throw new Error(`Invalid AliasDictionary in "${relPath}": ${errors}`);
        }
        const aliasDict = cleaned as AliasDictionary;
        if (aliasDict.source !== sourceKey) {
          throw new Error(
            `AliasDictionary file "${relPath}" specifies source "${aliasDict.source}" but manifest expects "${sourceKey}"`
          );
        }
        const seenTier3Aliases = new Map<string, string>();
        for (const [canonicalKey, aliases] of Object.entries(aliasDict.mappings)) {
          for (const alias of aliases) {
            if (typeof alias !== 'string' || alias.trim().length === 0) {
              throw new Error(
                `Empty or whitespace-only alias in AliasDictionary "${relPath}" for key "${canonicalKey}"`
              );
            }
            const norm = alias.trim().toLowerCase();
            const existingKey = seenTier3Aliases.get(norm);
            if (existingKey !== undefined && existingKey !== canonicalKey) {
              throw new Error(
                `Duplicate alias "${alias}" (normalized "${norm}") in AliasDictionary "${relPath}" between keys "${existingKey}" and "${canonicalKey}"`
              );
            }
            seenTier3Aliases.set(norm, canonicalKey);
          }
        }
        this.aliasDictionaries.set(sourceKey, aliasDict);
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

  getAliasDictionary(sourceKey: string): AliasDictionary | undefined {
    return this.aliasDictionaries.get(sourceKey);
  }
}
