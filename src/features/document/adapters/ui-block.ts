import type { DocumentSchema, DocumentField } from '../domain';
import type { DocumentUiSchema, DocumentUiSchemaQueryPort, EvaluationOrderCalculator } from '../ports';
import {
  buildCard,
  buildTitleBlock,
  type Card,
  type CardSection,
  type CardWidget,
} from '../../../infrastructure/workspace-addon/ui-blocks';

export function camelCaseToTitleCase(str: string): string {
  return str
    .replace(/([A-Z]+)/g, ' $1')
    .replace(/([0-9]+)/g, ' $1')
    .replace(/^./, (s) => s.toUpperCase())
    .trim()
    .replace(/\s+/g, ' ');
}

export function inferDefaultWidget(field: DocumentField): 'textInput' | 'selectionInput' {
  if (field.options || field.type === 'boolean') {
    return 'selectionInput';
  }
  return 'textInput';
}

export function buildDocumentFormWidgets(
  documentSchema: DocumentSchema,
  uiSchema?: DocumentUiSchema
): CardWidget[] {
  const widgets: CardWidget[] = [];
  const layout =
    uiSchema?.layout && uiSchema.layout.length > 0
      ? uiSchema.layout
      : documentSchema.fields.map((f) => f.key);

  const fieldMap = new Map<string, DocumentField>();
  for (const field of documentSchema.fields) {
    fieldMap.set(field.key, field);
  }

  for (const fieldKey of layout) {
    const field = fieldMap.get(fieldKey);
    if (!field) {
      continue;
    }

    const uiField = uiSchema?.fields?.[fieldKey];
    const label = uiField?.label ?? camelCaseToTitleCase(field.key);
    const widgetType = uiField?.widget ?? inferDefaultWidget(field);

    if (widgetType === 'selectionInput') {
      const customProps = (uiField?.props as Record<string, unknown> | undefined) ?? {};
      widgets.push({
        selectionInput: {
          name: field.key,
          label,
          type: 'DROPDOWN',
          items: [],
          ...customProps,
        },
      });
    } else {
      const customProps = (uiField?.props as Record<string, unknown> | undefined) ?? {};
      widgets.push({
        textInput: {
          name: field.key,
          label,
          ...(field.defaultValue !== undefined ? { value: field.defaultValue } : {}),
          ...customProps,
        },
      });
    }
  }

  return widgets;
}

export interface DocumentFormCardOptions {
  title?: string;
  subtitle?: string;
  sectionHeader?: string;
}

export function buildDocumentFormCard(
  documentSchema: DocumentSchema,
  uiSchema?: DocumentUiSchema,
  options?: DocumentFormCardOptions,
  evaluationOrderCalculator?: EvaluationOrderCalculator
): Card {
  const header = buildTitleBlock({
    title: options?.title ?? 'Document Form',
    ...(options?.subtitle ? { subtitle: options.subtitle } : {}),
  });

  const widgets = buildDocumentFormWidgets(documentSchema, uiSchema);
  const section: CardSection = {
    ...(options?.sectionHeader ? { header: options.sectionHeader } : {}),
    widgets,
  };

  const evaluationOrder =
    uiSchema?.evaluationOrder ??
    (evaluationOrderCalculator ? evaluationOrderCalculator(documentSchema, uiSchema) : undefined);

  return buildCard(header, [section], evaluationOrder);
}

export class DocumentUiBlockAdapter {
  constructor(
    private readonly uiSchemaQuery: DocumentUiSchemaQueryPort,
    private readonly evaluationOrderCalculator?: EvaluationOrderCalculator
  ) {}

  async renderDocumentCard(
    documentTypeKey: string,
    documentSchema: DocumentSchema,
    options?: DocumentFormCardOptions
  ): Promise<Card> {
    const uiSchema = await this.uiSchemaQuery.getDocumentUiSchema(documentTypeKey);
    return buildDocumentFormCard(
      documentSchema,
      uiSchema,
      options,
      this.evaluationOrderCalculator
    );
  }
}
