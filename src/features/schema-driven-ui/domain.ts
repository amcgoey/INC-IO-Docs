import { Type, type Static, type TSchema, type TTuple } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type {
  UiManifestPort,
  UiViewSchemaAdapterPort,
  UiViewAdapterContext,
} from './ports';

import {
  SelectionItemSchema,
  type SelectionItem,
  SelectionStateSchema,
  type SelectionState,
  GenerateViewRequestSchema,
  type GenerateViewRequest,
} from './ports';

export {
  SelectionItemSchema,
  type SelectionItem,
  SelectionStateSchema,
  type SelectionState,
  GenerateViewRequestSchema,
  type GenerateViewRequest,
};

// --- JSON Logic Schema ---

const DataVarString = Type.String({ pattern: '^data(\\..+)?$' });

const createBinaryOp = <K extends string, S extends TSchema>(op: K, schema: S) =>
  Type.Object(
    { [op]: Type.Tuple([schema, schema]) } as { [P in K]: TTuple<[S, S]> },
    {
      additionalProperties: false,
    }
  );

export const JSONLogicRuleType = Type.Recursive(
  (Self) => {
    const RuleOrPlainObject = Type.Union([
      Self,
      Type.Record(Type.String(), Type.Unknown()),
    ]);

    return Type.Union([
      // Primitives
      Type.String(),
      Type.Number(),
      Type.Boolean(),
      Type.Null(),
      Type.Array(Self),
      // Comparison Operators
      createBinaryOp('==', Self),
      createBinaryOp('!=', Self),
      createBinaryOp('<', Self),
      createBinaryOp('>', Self),
      createBinaryOp('<=', Self),
      createBinaryOp('>=', Self),
      // Arithmetic Operators
      Type.Object({ '+': Type.Array(Self, { minItems: 1 }) }, { additionalProperties: false }),
      Type.Object({ '-': Type.Union([Type.Tuple([Self]), Type.Tuple([Self, Self])]) }, { additionalProperties: false }),
      Type.Object({ '*': Type.Array(Self, { minItems: 2 }) }, { additionalProperties: false }),
      createBinaryOp('/', Self),
      createBinaryOp('%', Self),
      // Logical Operators
      Type.Object({ and: Type.Array(Self, { minItems: 1 }) }, { additionalProperties: false }),
      Type.Object({ or: Type.Array(Self, { minItems: 1 }) }, { additionalProperties: false }),
      Type.Object({ '!': Type.Union([Self, Type.Tuple([Self])]) }, { additionalProperties: false }),
      Type.Object({ '!!': Type.Union([Self, Type.Tuple([Self])]) }, { additionalProperties: false }),
      // Data Access
      Type.Object(
        {
          var: Type.Union([
            DataVarString,
            Type.Tuple([DataVarString]),
            Type.Tuple([DataVarString, RuleOrPlainObject]),
          ]),
        },
        { additionalProperties: false }
      ),
      // Utility Operators
      Type.Object({ cat: Type.Array(Self, { minItems: 1 }) }, { additionalProperties: false }),
      Type.Object({ in: Type.Tuple([Self, RuleOrPlainObject]) }, { additionalProperties: false }),
      Type.Object({ log: Type.Union([Self, Type.Tuple([Self])]) }, { additionalProperties: false }),
    ]);
  },
  { $id: 'SchemaDrivenUiJSONLogicRule' }
);

export type JSONLogicRule = Static<typeof JSONLogicRuleType>;

// --- UI Field & Event Schemas ---

export const UiFieldSchema = Type.Object({
  widget: Type.Optional(Type.String()),
  label: Type.Optional(Type.String()),
  props: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
  showIf: Type.Optional(JSONLogicRuleType),
  disableIf: Type.Optional(JSONLogicRuleType),
  computeValue: Type.Optional(JSONLogicRuleType),
  onChange: Type.Optional(Type.Union([Type.Boolean(), Type.String()])),
});

export type UiField = Static<typeof UiFieldSchema>;

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

export const UiSchema = Type.Object({
  layout: Type.Optional(Type.Array(Type.String())),
  fields: Type.Optional(Type.Record(Type.String(), UiFieldSchema)),
  events: Type.Optional(Type.Record(Type.String(), UiEventType)),
  evaluationOrder: Type.Optional(Type.Array(Type.String())),
});

export type UiSchema = Static<typeof UiSchema>;

// --- Abstract UI View Schemas ---

export const UiViewHeaderSchema = Type.Object(
  {
    title: Type.String({ minLength: 1 }),
    subtitle: Type.Optional(Type.String()),
    imageUrl: Type.Optional(Type.String()),
    imageType: Type.Optional(
      Type.Union([Type.Literal('SQUARE'), Type.Literal('CIRCLE')])
    ),
  },
  { additionalProperties: false }
);

export type UiViewHeader = Static<typeof UiViewHeaderSchema>;

const BaseInputWidgetProps = {
  name: Type.String(),
  label: Type.Optional(Type.String()),
  onChangeAction: Type.Optional(Type.Unknown()),
};

export const UiViewWidgetSchema = Type.Object(
  {
    type: Type.Optional(Type.String()),
    textParagraph: Type.Optional(
      Type.Object(
        {
          text: Type.String(),
        },
        { additionalProperties: false }
      )
    ),
    textInput: Type.Optional(
      Type.Object(
        {
          ...BaseInputWidgetProps,
          hintText: Type.Optional(Type.String()),
          value: Type.Optional(Type.String()),
        },
        { additionalProperties: false }
      )
    ),
    selectionInput: Type.Optional(
      Type.Object(
        {
          ...BaseInputWidgetProps,
          type: Type.Optional(Type.String()),
          items: Type.Optional(Type.Array(SelectionItemSchema)),
        },
        { additionalProperties: false }
      )
    ),
    buttonList: Type.Optional(
      Type.Object(
        {
          buttons: Type.Array(
            Type.Object(
              {
                text: Type.String(),
                onClick: Type.Optional(Type.Unknown()),
              },
              { additionalProperties: false }
            )
          ),
        },
        { additionalProperties: false }
      )
    ),
  },
  { additionalProperties: false }
);

export type UiViewWidget = Static<typeof UiViewWidgetSchema>;

export const UiViewSectionSchema = Type.Object(
  {
    header: Type.Optional(Type.String()),
    widgets: Type.Array(UiViewWidgetSchema),
    collapsible: Type.Optional(Type.Boolean()),
    uncollapsibleWidgetsCount: Type.Optional(Type.Number()),
  },
  { additionalProperties: false }
);

export type UiViewSection = Static<typeof UiViewSectionSchema>;

export const UiViewModel = Type.Object(
  {
    id: Type.Optional(Type.String()),
    header: Type.Optional(UiViewHeaderSchema),
    sections: Type.Array(UiViewSectionSchema),
    evaluationOrder: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: false }
);

export type UiView = Static<typeof UiViewModel>;

// --- Validation Helpers ---

function formatValidationErrors<T extends TSchema>(schema: T, value: unknown): string[] {
  return [...Value.Errors(schema, value)].map((e) => `${e.path}: ${e.message}`);
}

function validateOrThrow<T extends TSchema>(schema: T, value: unknown, errorMessagePrefix: string): void {
  if (!Value.Check(schema, value)) {
    const errors = formatValidationErrors(schema, value);
    throw new Error(`${errorMessagePrefix}: ${errors.join(', ')}`);
  }
}

// --- Domain Service (Guarded Read) ---

export class SchemaDrivenUiService {
  private readonly adapters: ReadonlyMap<string, UiViewSchemaAdapterPort>;

  constructor(
    private readonly manifestPort: UiManifestPort,
    adapters: UiViewSchemaAdapterPort[] = []
  ) {
    const adapterMap = new Map<string, UiViewSchemaAdapterPort>();
    for (const adapter of adapters) {
      if (!adapter.viewId) {
        throw new Error('Cannot register UiViewSchema adapter without a viewId');
      }
      adapterMap.set(adapter.viewId, adapter);
    }
    this.adapters = adapterMap;
  }

  async generateView(request: GenerateViewRequest): Promise<UiView> {
    validateOrThrow(GenerateViewRequestSchema, request, 'Invalid GenerateViewRequest');

    const adapter = this.adapters.get(request.viewId);
    if (!adapter) {
      throw new Error(`UiViewSchema adapter not registered for viewId "${request.viewId}"`);
    }

    let resolvedUiSchema: UiSchema | undefined = undefined;
    let resolvedDocSchema: UiViewAdapterContext['documentSchema'] = undefined;

    if (request.documentTypeKey) {
      resolvedUiSchema = await this.manifestPort.getUiSchema(request.documentTypeKey);
      if (!resolvedUiSchema) {
        throw new Error(`UiSchema not found for documentTypeKey "${request.documentTypeKey}"`);
      }
      validateOrThrow(
        UiSchema,
        resolvedUiSchema,
        `Invalid UiSchema for documentTypeKey "${request.documentTypeKey}"`
      );

      resolvedDocSchema = await this.manifestPort.getDocumentSchema(request.documentTypeKey);
    }

    const adapterContext: UiViewAdapterContext = {
      ...request,
      uiSchema: resolvedUiSchema,
      documentSchema: resolvedDocSchema,
    };

    const view = await adapter.composeView(adapterContext);

    validateOrThrow(UiViewModel, view, 'Generated UiView failed validation');

    return view;
  }
}
