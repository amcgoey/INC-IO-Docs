import { Type, type Static, type TSchema } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type {
  ActivityDispatcherPort,
  DocumentSchemaRegistryPort,
  DocumentServicePort,
  SchemaQueryPort,
  TemplateEvaluationContext,
  TemplateEvaluatorPort,
} from './ports';

export function formatValidationErrors<T extends TSchema>(schema: T, value: unknown): string[] {
  return [...Value.Errors(schema, value)].map((e) => `${e.path}: ${e.message}`);
}

export const DocumentModel = Type.Object({
  // STUB: Pending Chunk 3
  id: Type.Optional(Type.String()),
  // STUB: Pending Chunk 3
  idDocument: Type.Optional(Type.String()),
  // STUB: Pending Chunk 3
  idGroup: Type.Optional(Type.String()),
  type: Type.String(),
  data: Type.Record(Type.String(), Type.Unknown()),
});

export type Document = Static<typeof DocumentModel>;

export const ActivityType = Type.Object({
  type: Type.String(),
  payload: Type.Record(Type.String(), Type.Unknown()),
});

export type Activity = Static<typeof ActivityType>;

export const FileLocatorType = Type.Object({
  id: Type.String(),
  name: Type.String(),
  parentName: Type.Optional(Type.String()),
  mimeType: Type.Optional(Type.String()),
  uri: Type.Optional(Type.String()),
});

export type FileLocator = Static<typeof FileLocatorType>;

export const ActivityOutputType = Type.Object({
  success: Type.Optional(Type.Boolean()),
  error: Type.Optional(Type.String()),
  documentDataPatch: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  contextVariables: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  files: Type.Optional(Type.Array(FileLocatorType)),
});

export type ActivityOutput = Static<typeof ActivityOutputType>;

/**
 * ExecutionContext represents ambient infrastructure runtime variables (credentials, target resources)
 * passed into activity dispatching.
 *
 * NOTE ON CODE DUPLICATION:
 * This schema is intentionally defined independently within the `document` feature boundary and mirrors
 * `WorkspaceDocumentExecutionContextSchema` in the `workspace` feature. In accordance with ADR 0001
 * (Hybrid Hexagonal Architecture - Locality over Layering) and Hexagonal Architecture boundary rules,
 * feature slices are self-contained and must not share internal domain models across feature boundaries.
 */
export const ExecutionContextSchema = Type.Object({
  credentials: Type.Optional(
    Type.Object({
      oauthToken: Type.Optional(Type.String()),
    })
  ),
  resources: Type.Optional(
    Type.Object({
      primaryTargetId: Type.Optional(Type.String()),
    })
  ),
});

export type ExecutionContext = Static<typeof ExecutionContextSchema>;

export const DocumentFieldOptionType = Type.Object({
  source: Type.String(),
  key: Type.String(),
  name: Type.String(),
  allowUserInput: Type.Optional(Type.Boolean()),
});

export type DocumentFieldOption = Static<typeof DocumentFieldOptionType>;

export const DocumentFieldType = Type.Object({
  key: Type.String(),
  name: Type.String(),
  type: Type.String(),
  description: Type.Optional(Type.String()),
  required: Type.Optional(Type.Boolean()),
  defaultValue: Type.Optional(Type.String()),
  format: Type.Optional(Type.String()),
  options: Type.Optional(DocumentFieldOptionType),
});

export type DocumentField = Static<typeof DocumentFieldType>;

export const DocumentSchemaOptionTupleType = Type.Record(Type.String(), Type.Unknown());

export type DocumentSchemaOptionTuple = Static<typeof DocumentSchemaOptionTupleType>;

export const DocumentIdentitySchemaType = Type.Object(
  {
    id: Type.Optional(Type.String()),
    idDocument: Type.Optional(Type.String()),
    idGroup: Type.Optional(Type.String()),
  },
  { additionalProperties: Type.String() }
);

export type DocumentIdentitySchema = Static<typeof DocumentIdentitySchemaType>;

export const CalculatedFieldType = Type.Object({
  key: Type.String(),
  template: Type.String(),
  description: Type.Optional(Type.String()),
});

export type CalculatedField = Static<typeof CalculatedFieldType>;

export const SystemContextSchema = Type.Object({
  // STUB: Reserved for future system context expansion
});

export type SystemContext = Static<typeof SystemContextSchema>;

export const DocumentSchemaType = Type.Object({
  fields: Type.Array(DocumentFieldType),
  calculatedFields: Type.Optional(Type.Array(CalculatedFieldType)),
  identity: Type.Optional(DocumentIdentitySchemaType),
  options: Type.Optional(Type.Record(Type.String(), Type.Array(DocumentSchemaOptionTupleType))),
});

export type DocumentSchema = Static<typeof DocumentSchemaType>;

export const UiEventRuleType = Type.Object({
  matchFields: Type.Optional(Type.Record(Type.String(), Type.String())),
  workflow: Type.String(),
});

export type UiEventRule = Static<typeof UiEventRuleType>;

export const UiEventType = Type.Object({
  rules: Type.Optional(Type.Array(UiEventRuleType)),
  catchAllWorkflow: Type.Optional(Type.String()),
});

export type UiEvent = Static<typeof UiEventType>;

export const DocumentUiConfigType = Type.Object({
  events: Type.Optional(Type.Record(Type.String(), UiEventType)),
});

export type DocumentUiConfig = Static<typeof DocumentUiConfigType>;

export const WorkflowType = Type.Object({
  name: Type.String(),
  activitySequence: Type.Optional(Type.Array(ActivityType)),
});

export type Workflow = Static<typeof WorkflowType>;

export const DocumentWorkflowConfigType = Type.Object({
  workflows: Type.Array(WorkflowType),
});

export type DocumentWorkflowConfig = Static<typeof DocumentWorkflowConfigType>;

export const StorageContextConfigType = Type.Record(Type.String(), Type.Unknown());

export type StorageContextConfig = Static<typeof StorageContextConfigType>;

export const DocumentTypeSchema = Type.Object({
  key: Type.String(),
  name: Type.String(),
  documentSchema: DocumentSchemaType,
  documentUiConfig: Type.Optional(DocumentUiConfigType),
  documentWorkflowConfig: Type.Optional(DocumentWorkflowConfigType),
  storageContextConfig: Type.Optional(StorageContextConfigType),
});

export type DocumentType = Static<typeof DocumentTypeSchema>;

export const FormSchemaType = Type.Object({
  key: Type.String(),
  name: Type.String(),
  documentSchema: DocumentSchemaType,
  documentUiConfig: Type.Optional(DocumentUiConfigType),
});

export type FormSchema = Static<typeof FormSchemaType>;

export type ProcessDocumentResult =
  | {
      success: true;
      data: Document;
      activities: Activity[];
      outputs: ActivityOutput[];
      contextVariables?: { [key: string]: unknown } | undefined;
    }
  | { success: false; errors: string[] };

/**
 * Maps property names in DocumentIdentitySchema to property names in the Document entity model.
 * DocumentIdentitySchema defines 'id', 'idDocument', and 'idGroup' which map directly to 'id', 'idDocument', and 'idGroup' on the Document entity.
 */
const IDENTITY_SCHEMA_TO_DOCUMENT_FIELD_MAPPING = {
  id: 'id',
  idDocument: 'idDocument',
  idGroup: 'idGroup',
} as const;

function compileFieldSchema(field: DocumentField, documentSchema: DocumentSchema, documentTypeKey: string): TSchema {
  let fieldSchema: TSchema;
  if (field.type === 'string') {
    if (field.options && !field.options.allowUserInput) {
      const { source, key } = field.options;
      const optionTuples = documentSchema.options?.[source] ?? [];
      const uniqueKeys = Array.from(
        new Set(
          optionTuples
            .map((tuple) => tuple[key])
            .filter((val): val is string => typeof val === 'string')
        )
      );
      const literals = uniqueKeys.map((val) => Type.Literal(val));
      if (literals.length === 0) {
        fieldSchema = Type.Never();
      } else if (literals.length === 1) {
        fieldSchema = literals[0];
      } else {
        fieldSchema = Type.Union(literals);
      }
    } else {
      fieldSchema = Type.String();
    }
  } else {
    throw new Error(`Unsupported field type '${field.type}' in DocumentType '${documentTypeKey}'`);
  }

  if (!field.required) {
    fieldSchema = Type.Optional(fieldSchema);
  }

  return fieldSchema;
}

function matchesRule(matchFields: { [key: string]: string } | undefined, document: Document): boolean {
  if (!matchFields || Object.keys(matchFields).length === 0) {
    return true;
  }
  const documentData = document.data as { [key: string]: unknown };
  const documentObj = document as unknown as { [key: string]: unknown };

  for (const [key, expectedValue] of Object.entries(matchFields)) {
    const rawValue = documentData[key] !== undefined ? documentData[key] : documentObj[key];
    if (rawValue === undefined || rawValue === null) {
      return false;
    }
    if (typeof rawValue === 'string') {
      if (rawValue !== expectedValue) {
        return false;
      }
    } else if (typeof rawValue === 'object') {
      const obj = rawValue as { [key: string]: unknown };
      const match =
        obj.key === expectedValue ||
        obj.id === expectedValue ||
        obj.code === expectedValue ||
        Object.values(obj).some((v) => String(v) === expectedValue);
      if (!match) {
        return false;
      }
    } else if (String(rawValue) !== expectedValue) {
      return false;
    }
  }
  return true;
}

function resolvePayloadTemplates(
  value: unknown,
  evaluator: TemplateEvaluatorPort,
  context: TemplateEvaluationContext
): unknown {
  if (typeof value === 'string') {
    return evaluator.evaluate(value, context);
  }
  if (Array.isArray(value)) {
    return value.map((item) => resolvePayloadTemplates(item, evaluator, context));
  }
  if (value !== null && typeof value === 'object') {
    const result: { [key: string]: unknown } = {};
    for (const [k, v] of Object.entries(value as { [key: string]: unknown })) {
      result[k] = resolvePayloadTemplates(v, evaluator, context);
    }
    return result;
  }
  return value;
}

export class DocumentService implements DocumentServicePort, SchemaQueryPort {
  private documentTypes: DocumentType[] = [];
  private compiledSchemas = new Map<string, TSchema>();

  constructor(
    private readonly dispatcher: ActivityDispatcherPort,
    private readonly documentSchemaRegistry: DocumentSchemaRegistryPort,
    private readonly templateEvaluator: TemplateEvaluatorPort,
  ) {}

  async initialize(): Promise<void> {
    this.documentTypes = await this.documentSchemaRegistry.loadAll();
    this.compiledSchemas.clear();

    for (const documentType of this.documentTypes) {
      const properties: { [key: string]: TSchema } = {};
      for (const field of documentType.documentSchema.fields) {
        properties[field.key] = compileFieldSchema(field, documentType.documentSchema, documentType.key);
      }
      this.compiledSchemas.set(documentType.key, Type.Object(properties));
    }
  }

  async getForms(): Promise<FormSchema[]> {
    return this.documentTypes.map((documentType) => {
      const formSchema: FormSchema = {
        key: documentType.key,
        name: documentType.name,
        documentSchema: documentType.documentSchema,
      };

      if (documentType.documentUiConfig !== undefined) {
        formSchema.documentUiConfig = documentType.documentUiConfig;
      }

      return formSchema;
    });
  }

  async processDocument(
    payload?: unknown,
    eventName?: string,
    context?: ExecutionContext
  ): Promise<ProcessDocumentResult> {
    if (!Value.Check(DocumentModel, payload)) {
      const errors = formatValidationErrors(DocumentModel, payload);
      return {
        success: false,
        errors: errors.length > 0 ? errors : ['Invalid document payload'],
      };
    }

    const document = payload;
    const documentType = this.documentTypes.find((rt) => rt.key === document.type);
    const schema = this.compiledSchemas.get(document.type);
    if (!schema || !documentType) {
      return {
        success: false,
        errors: [`Unknown document type: ${document.type}`],
      };
    }

    if (!Value.Check(schema, document.data)) {
      const errors = formatValidationErrors(schema, document.data);
      return {
        success: false,
        errors: errors.length > 0 ? errors : ['Invalid document data payload'],
      };
    }

    // Anti-Corruption Layer: Context Enrichment & Fallback Tuple Synthesis
    const rawData = document.data as { [key: string]: unknown };
    const enrichedData: { [key: string]: unknown } = { ...rawData };

    for (const field of documentType.documentSchema.fields) {
      if (field.options) {
        const rawValue = rawData[field.key];
        if (typeof rawValue === 'string') {
          const optionTuples = documentType.documentSchema.options?.[field.options.source] ?? [];
          const matchedTuple = optionTuples.find((tuple) => tuple[field.options!.key] === rawValue);
          if (matchedTuple) {
            enrichedData[field.key] = { ...matchedTuple };
          } else if (field.options.allowUserInput) {
            enrichedData[field.key] = {
              [field.options.key]: rawValue,
              [field.options.name]: rawValue,
            };
          }
        }
      }
    }

    // STUB: SystemContext incorporates global system runtime variables
    const systemContext: SystemContext = {};
    const basePayload: { [key: string]: unknown } = {
      ...systemContext,
      ...enrichedData,
    };

    let resolvedData: { [key: string]: unknown } = { ...enrichedData };
    if (documentType.documentSchema.calculatedFields) {
      const calculatedValues: { [key: string]: unknown } = {};
      for (const calculatedField of documentType.documentSchema.calculatedFields) {
        calculatedValues[calculatedField.key] = this.templateEvaluator.evaluate(
          calculatedField.template,
          basePayload
        );
      }
      resolvedData = {
        ...resolvedData,
        ...calculatedValues,
      };
    }

    const identityUpdates: Partial<Document> = {};
    if (documentType.documentSchema.identity) {
      for (const [schemaKey, targetKey] of Object.entries(IDENTITY_SCHEMA_TO_DOCUMENT_FIELD_MAPPING)) {
        const template = documentType.documentSchema.identity[schemaKey as keyof typeof IDENTITY_SCHEMA_TO_DOCUMENT_FIELD_MAPPING];
        if (typeof template === 'string') {
          identityUpdates[targetKey] = this.templateEvaluator.evaluate(
            template,
            basePayload
          );
        }
      }
    }

    let enrichedDocument: Document = {
      ...document,
      ...identityUpdates,
      data: resolvedData,
    };

    let selectedWorkflowName: string | undefined;

    if (eventName && documentType.documentUiConfig?.events?.[eventName]) {
      const uiEvent = documentType.documentUiConfig.events[eventName];
      if (uiEvent.rules && uiEvent.rules.length > 0) {
        for (const rule of uiEvent.rules) {
          if (matchesRule(rule.matchFields, enrichedDocument)) {
            selectedWorkflowName = rule.workflow;
            break;
          }
        }
      }

      if (!selectedWorkflowName && uiEvent.catchAllWorkflow) {
        selectedWorkflowName = uiEvent.catchAllWorkflow;
      }
    }

    if (!selectedWorkflowName) {
      return {
        success: true,
        data: enrichedDocument,
        activities: [],
        outputs: [],
      };
    }

    const workflow = documentType.documentWorkflowConfig?.workflows.find(
      (w) => w.name === selectedWorkflowName
    );

    if (!workflow) {
      throw new Error(
        `Workflow '${selectedWorkflowName}' not found in configuration for DocumentType '${documentType.key}'`
      );
    }

    const activities = workflow.activitySequence ?? [];
    let storageContext: unknown;
    if (documentType.storageContextConfig !== undefined) {
      storageContext = resolvePayloadTemplates(
        documentType.storageContextConfig,
        this.templateEvaluator,
        { Document: enrichedDocument }
      );
    }

    const evaluationContext: TemplateEvaluationContext = {
      Document: enrichedDocument,
      documentSchema: documentType.documentSchema,
      ...(storageContext !== undefined ? { StorageContext: storageContext } : {}),
    };

    const accumulatedContextVariables: { [key: string]: unknown } = {};
    const resolvedActivities: Activity[] = [];
    const collectedOutputs: ActivityOutput[] = [];
    for (const activity of activities) {
      const resolvedPayload = (resolvePayloadTemplates(
        activity.payload,
        this.templateEvaluator,
        evaluationContext
      ) ?? {}) as { [key: string]: unknown };

      const resolvedActivity: Activity = {
        type: activity.type,
        payload: resolvedPayload,
      };

      const output = (context !== undefined
        ? await this.dispatcher.dispatch(resolvedActivity, context)
        : await this.dispatcher.dispatch(resolvedActivity)) as ActivityOutput | void;

      resolvedActivities.push(resolvedActivity);

      if (output) {
        collectedOutputs.push(output);
        if (output.success === false) {
          return {
            success: false,
            errors: [output.error ?? `Activity execution failed for ${activity.type}`],
          };
        }
        if (output.documentDataPatch) {
          enrichedDocument = {
            ...enrichedDocument,
            data: {
              ...enrichedDocument.data,
              ...output.documentDataPatch,
            },
          };
          evaluationContext.Document = enrichedDocument;
        }
        if (output.contextVariables) {
          Object.assign(evaluationContext, output.contextVariables);
          Object.assign(accumulatedContextVariables, output.contextVariables);
        }
      }
    }

    const finalResult: ProcessDocumentResult = {
      success: true,
      data: enrichedDocument,
      activities: resolvedActivities,
      outputs: collectedOutputs,
    };
    if (Object.keys(accumulatedContextVariables).length > 0) {
      finalResult.contextVariables = accumulatedContextVariables;
    }

    return finalResult;
  }
}

/**
 * Recursively flattens an object into dot-notation paths.
 */
function flattenObjectPaths(obj: unknown, prefix = ''): string[] {
  const paths: string[] = [];
  if (obj === null || obj === undefined) {
    return paths;
  }
  if (typeof obj === 'object') {
    if (Array.isArray(obj)) {
      if (prefix) paths.push(prefix);
      obj.forEach((item, index) => {
        const itemPrefix = prefix ? `${prefix}.${index}` : `${index}`;
        paths.push(itemPrefix);
        paths.push(...flattenObjectPaths(item, itemPrefix));
      });
    } else {
      if (prefix) paths.push(prefix);
      for (const [key, value] of Object.entries(obj as { [key: string]: unknown })) {
        const keyPrefix = prefix ? `${prefix}.${key}` : key;
        paths.push(keyPrefix);
        paths.push(...flattenObjectPaths(value, keyPrefix));
      }
    }
  }
  return paths;
}

/**
 * Traverses an arbitrary JSON structure and invokes a callback for every string template encountered.
 */
export function walkTemplates(
  obj: unknown,
  currentPath: string,
  callback: (path: string, template: string) => void
): void {
  if (obj === null || obj === undefined) {
    return;
  }
  if (typeof obj === 'string') {
    callback(currentPath, obj);
    return;
  }
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      walkTemplates(item, `${currentPath}[${index}]`, callback);
    });
    return;
  }
  if (typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj as { [key: string]: unknown })) {
      const propPath = currentPath ? `${currentPath}.${key}` : key;
      walkTemplates(value, propPath, callback);
    }
  }
}

/**
 * Compiles the list of base variables available during document hydration and identity/calculatedField resolution.
 */
function getBaseVariables(manifest: DocumentType): string[] {
  const vars: string[] = [
    ...Object.keys(SystemContextSchema.properties),
  ];

  for (const field of manifest.documentSchema.fields) {
    vars.push(field.key);
    if (field.options) {
      if (field.options.key) {
        vars.push(`${field.key}.${field.options.key}`);
      }
      if (field.options.name) {
        vars.push(`${field.key}.${field.options.name}`);
      }
      const optionTuples = manifest.documentSchema.options?.[field.options.source] ?? [];
      for (const tuple of optionTuples) {
        vars.push(...flattenObjectPaths(tuple, field.key));
      }
    }
  }

  return Array.from(new Set(vars));
}

/**
 * Compiles the list of execution variables available during storage context and workflow activity evaluation.
 */
function getExecutionVariables(manifest: DocumentType, baseVariables: string[]): string[] {
  const vars: string[] = [
    'Document.id',
    'Document.type',
  ];

  for (const baseVar of baseVariables) {
    vars.push(`Document.data.${baseVar}`);
  }

  if (manifest.documentSchema.calculatedFields) {
    for (const calcField of manifest.documentSchema.calculatedFields) {
      vars.push(`Document.data.${calcField.key}`);
    }
  }

  const documentSchemaPaths = flattenObjectPaths(manifest.documentSchema, 'documentSchema');
  vars.push(...documentSchemaPaths);

  if (manifest.storageContextConfig) {
    vars.push('StorageContext');
    const storagePaths = flattenObjectPaths(manifest.storageContextConfig, 'StorageContext');
    vars.push(...storagePaths);
  }

  vars.push('Context.*');

  return Array.from(new Set(vars));
}

/**
 * Pure domain function to statically validate all Handlebars templates within a DocumentType manifest.
 * Returns an array of formatted error strings using exact dot-notation paths.
 */
export function validateManifestTemplates(
  manifest: DocumentType,
  evaluator: TemplateEvaluatorPort
): string[] {
  const errors: string[] = [];

  const baseVariables = getBaseVariables(manifest);
  const executionVariables = getExecutionVariables(manifest, baseVariables);

  if (manifest.documentSchema.calculatedFields) {
    manifest.documentSchema.calculatedFields.forEach((calcField, index) => {
      const path = `documentSchema.calculatedFields[${index}].template`;
      if (!evaluator.validate(calcField.template, baseVariables)) {
        errors.push(`Invalid template at "${path}": references unknown fields or is malformed.`);
      }
    });
  }

  if (manifest.documentSchema.identity) {
    for (const [propKey, template] of Object.entries(manifest.documentSchema.identity)) {
      if (typeof template === 'string') {
        const path = `documentSchema.identity.${propKey}`;
        if (!evaluator.validate(template, baseVariables)) {
          errors.push(`Invalid template at "${path}": references unknown fields or is malformed.`);
        }
      }
    }
  }

  if (manifest.storageContextConfig) {
    walkTemplates(manifest.storageContextConfig, 'storageContextConfig', (path, template) => {
      if (!evaluator.validate(template, executionVariables)) {
        errors.push(`Invalid template at "${path}": references unknown fields or is malformed.`);
      }
    });
  }

  if (manifest.documentWorkflowConfig) {
    walkTemplates(manifest.documentWorkflowConfig, 'documentWorkflowConfig', (path, template) => {
      if (!evaluator.validate(template, executionVariables)) {
        errors.push(`Invalid template at "${path}": references unknown fields or is malformed.`);
      }
    });
  }

  return errors;
}



