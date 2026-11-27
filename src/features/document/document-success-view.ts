import { Type, type Static } from '@sinclair/typebox';
import type {
  DocumentField,
  DocumentSchema,
  DocumentWorkflowConfig,
  OptionSource,
} from './domain';
import type { ParsedMustacheTemplate, TemplateEvaluatorPort } from './ports';

export const DocumentUiSuccessSummarySchema = Type.Object(
  {
    topLabel: Type.Optional(Type.String()),
    text: Type.String(),
    bottomLabel: Type.Optional(Type.String()),
  },
  { additionalProperties: false }
);
export type DocumentUiSuccessSummary = Static<typeof DocumentUiSuccessSummarySchema>;

export const DocumentUiSuccessArtifactSchema = Type.Object(
  {
    stepId: Type.String(),
    label: Type.String(),
    whenWorkflow: Type.Optional(Type.Record(Type.String(), Type.String())),
    fallbackLabel: Type.Optional(Type.String()),
  },
  { additionalProperties: false }
);
export type DocumentUiSuccessArtifact = Static<typeof DocumentUiSuccessArtifactSchema>;

export const DocumentUiSuccessViewSchema = Type.Object(
  {
    summary: Type.Optional(DocumentUiSuccessSummarySchema),
    artifacts: Type.Optional(Type.Array(DocumentUiSuccessArtifactSchema)),
  },
  { additionalProperties: false }
);
export type DocumentUiSuccessView = Static<typeof DocumentUiSuccessViewSchema>;

const SIMPLE_ALLOWED_CARD_HTML_TAGS = new Set(['b', 'i', 'u', 's', 'time']);
const ALLOWED_CARD_CLOSING_TAGS = new Set(['b', 'i', 'u', 's', 'font', 'a', 'time']);
const SAFE_FONT_COLOR_REGEX = /^(?:#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|[a-zA-Z]{1,32})$/;
const SINGLE_ATTR_REGEX = /^([a-zA-Z]+)\s*=\s*(?:"([^"]*)"|'([^']*)')$/;
const DISALLOWED_TEMPLATE_NAMESPACES = new Set([
  'Document',
  'calculated',
  'StorageContext',
  'Context',
  'DocumentSpace',
  'space',
]);

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
  contextLabel: string,
  errors: string[]
): void {
  const openTags: string[] = [];

  for (const literal of literals) {
    let cursor = 0;
    while (cursor < literal.length) {
      const ltIndex = literal.indexOf('<', cursor);
      const gtIndex = literal.indexOf('>', cursor);

      if (ltIndex === -1) {
        if (gtIndex !== -1) {
          errors.push(
            `Invalid HTML at "${contextLabel}": contains an unmatched ">" character.`
          );
          return;
        }
        break;
      }

      if (gtIndex !== -1 && gtIndex < ltIndex) {
        errors.push(
          `Invalid HTML at "${contextLabel}": contains an unmatched ">" character.`
        );
        return;
      }

      const closeBracket = literal.indexOf('>', ltIndex + 1);
      if (closeBracket === -1) {
        errors.push(
          `Invalid HTML at "${contextLabel}": contains an unclosed "<" tag or mustache token inside an HTML tag.`
        );
        return;
      }

      const rawTagContent = literal.slice(ltIndex + 1, closeBracket);
      if (rawTagContent.includes('<')) {
        errors.push(
          `Invalid HTML at "${contextLabel}": contains malformed nested "<" inside HTML tag.`
        );
        return;
      }

      const trimmedContent = rawTagContent.trim();
      if (trimmedContent.length === 0) {
        errors.push(`Invalid HTML at "${contextLabel}": contains an empty "<>" HTML tag.`);
        return;
      }

      if (trimmedContent.startsWith('/')) {
        const closeNameRaw = trimmedContent.slice(1).trim();
        if (!/^[a-zA-Z]+$/.test(closeNameRaw)) {
          errors.push(
            `Invalid HTML at "${contextLabel}": contains invalid closing HTML tag "<${rawTagContent}>".`
          );
          return;
        }
        const closeName = closeNameRaw.toLowerCase();
        if (!ALLOWED_CARD_CLOSING_TAGS.has(closeName)) {
          errors.push(
            `Invalid HTML at "${contextLabel}": uses disallowed closing HTML tag "</${closeNameRaw}>".`
          );
          return;
        }
        const expected = openTags.pop();
        if (expected !== closeName) {
          errors.push(
            `Invalid HTML at "${contextLabel}": has unbalanced HTML tag "</${closeNameRaw}>".`
          );
          return;
        }
      } else {
        const selfClosing = trimmedContent.endsWith('/');
        const withoutSlash = selfClosing ? trimmedContent.slice(0, -1).trim() : trimmedContent;
        const nameMatch = /^([a-zA-Z]+)(?:\s+([\s\S]*))?$/.exec(withoutSlash);
        if (!nameMatch || !nameMatch[1]) {
          errors.push(
            `Invalid HTML at "${contextLabel}": contains unsupported or malformed HTML tag "<${rawTagContent}>".`
          );
          return;
        }
        const tagName = nameMatch[1].toLowerCase();
        const attrText = (nameMatch[2] ?? '').trim();

        if (tagName === 'br') {
          if (attrText.length > 0) {
            errors.push(
              `Invalid HTML at "${contextLabel}": does not allow attributes on "<br>".`
            );
            return;
          }
        } else if (SIMPLE_ALLOWED_CARD_HTML_TAGS.has(tagName)) {
          if (selfClosing || attrText.length > 0) {
            errors.push(
              `Invalid HTML at "${contextLabel}": does not allow attributes or self-closing syntax on "<${tagName}>".`
            );
            return;
          }
          openTags.push(tagName);
        } else if (tagName === 'font') {
          if (selfClosing) {
            errors.push(
              `Invalid HTML at "${contextLabel}": does not allow self-closing "<font/>".`
            );
            return;
          }
          const attrMatch = SINGLE_ATTR_REGEX.exec(attrText);
          const attrName = attrMatch?.[1]?.toLowerCase();
          const attrValue = attrMatch?.[2] ?? attrMatch?.[3] ?? '';
          if (!attrMatch || attrName !== 'color' || !SAFE_FONT_COLOR_REGEX.test(attrValue)) {
            errors.push(
              `Invalid HTML at "${contextLabel}": requires '<font color="...">' with a safe color value and no extra attributes.`
            );
            return;
          }
          openTags.push('font');
        } else if (tagName === 'a') {
          if (selfClosing) {
            errors.push(
              `Invalid HTML at "${contextLabel}": does not allow self-closing "<a/>".`
            );
            return;
          }
          if (openTags.includes('a')) {
            errors.push(
              `Invalid HTML at "${contextLabel}": does not allow nested "<a>" tags.`
            );
            return;
          }
          const attrMatch = SINGLE_ATTR_REGEX.exec(attrText);
          const attrName = attrMatch?.[1]?.toLowerCase();
          const attrValue = attrMatch?.[2] ?? attrMatch?.[3] ?? '';
          if (!attrMatch || attrName !== 'href' || !isValidHttpOrHttpsUrl(attrValue)) {
            errors.push(
              `Invalid HTML at "${contextLabel}": requires '<a href="https://...">' with a valid http(s) URL and no extra attributes.`
            );
            return;
          }
          openTags.push('a');
        } else {
          errors.push(
            `Invalid HTML at "${contextLabel}": uses disallowed HTML tag "<${nameMatch[1]}>".`
          );
          return;
        }
      }

      cursor = closeBracket + 1;
    }
  }

  if (openTags.length > 0) {
    errors.push(
      `Invalid HTML at "${contextLabel}": has unclosed HTML tag(s): ${openTags.map((t) => `<${t}>`).join(', ')}.`
    );
  }
}

function validatePlainTextLiterals(
  literals: readonly string[],
  contextLabel: string,
  errors: string[]
): void {
  for (const literal of literals) {
    if (/<\/?[a-zA-Z!?]/.test(literal) || literal.includes('<>')) {
      errors.push(
        `Invalid plain text at "${contextLabel}": HTML tags are not allowed in topLabel or bottomLabel.`
      );
      return;
    }
  }
}

function collectStage1DocumentDataVariables(documentSchema: DocumentSchema): string[] {
  const vars: string[] = [];
  for (const field of documentSchema.fields) {
    vars.push(field.key);
    if (field.options) {
      const optionSource: OptionSource | undefined =
        documentSchema.optionSources?.[field.options.source];
      if (optionSource?.properties) {
        for (const prop of optionSource.properties) {
          vars.push(`${field.key}.${prop}`);
        }
      } else {
        if (field.options.key) {
          vars.push(`${field.key}.${field.options.key}`);
        }
        if (field.options.name) {
          vars.push(`${field.key}.${field.options.name}`);
        }
        const tuples = documentSchema.options?.[field.options.source] ?? [];
        for (const tuple of tuples) {
          if (tuple && typeof tuple === 'object') {
            for (const propKey of Object.keys(tuple)) {
              vars.push(`${field.key}.${propKey}`);
            }
          }
        }
      }
    }
  }
  return Array.from(new Set(vars));
}

function isValidLookupProperty(
  field: DocumentField,
  property: string,
  documentSchema: DocumentSchema
): boolean {
  if (!field.options) {
    return false;
  }
  const optionSource = documentSchema.optionSources?.[field.options.source];
  if (optionSource !== undefined) {
    if (optionSource.properties !== undefined) {
      return optionSource.properties.includes(property);
    }
    const keyProp = field.options.key ?? 'key';
    const nameProp = field.options.name ?? keyProp;
    return property === keyProp || property === nameProp;
  }
  const tuples = documentSchema.options?.[field.options.source];
  if (tuples !== undefined) {
    const keyProp = field.options.key ?? 'key';
    const nameProp = field.options.name ?? keyProp;
    return (
      property === keyProp ||
      property === nameProp ||
      tuples.some((tuple) => property in tuple)
    );
  }
  return true;
}

function validateSummaryTemplate(params: {
  template: string;
  contextLabel: string;
  allowSafeCardHtml: boolean;
  documentSchema: DocumentSchema;
  stage1Vars: string[];
  fieldsByKey: ReadonlyMap<string, DocumentField>;
  calcFieldKeys: ReadonlySet<string>;
  evaluator: TemplateEvaluatorPort;
  errors: string[];
}): void {
  const {
    template,
    contextLabel,
    allowSafeCardHtml,
    documentSchema,
    stage1Vars,
    fieldsByKey,
    calcFieldKeys,
    evaluator,
    errors,
  } = params;

  if (template.trim().length === 0) {
    errors.push(`Invalid template at "${contextLabel}": must not be blank.`);
    return;
  }

  if (!evaluator.validate(template, stage1Vars)) {
    errors.push(
      `Invalid template at "${contextLabel}": references unknown fields or is malformed.`
    );
    return;
  }

  let parsed: ParsedMustacheTemplate | undefined;
  if (evaluator.parseMustacheTemplate) {
    try {
      parsed = evaluator.parseMustacheTemplate(template);
    } catch (error) {
      errors.push(
        `Invalid template at "${contextLabel}": ${error instanceof Error ? error.message : String(error)}`
      );
      return;
    }

    for (const token of parsed.tokens) {
      if (
        token.parts.length < 1 ||
        token.parts.length > 2 ||
        token.parts.some((part) => part.trim().length === 0)
      ) {
        errors.push(
          `Invalid template at "${contextLabel}": invalid field path "${token.original}".`
        );
        continue;
      }

      const [fieldKey, property] = token.parts;
      if (!fieldKey || DISALLOWED_TEMPLATE_NAMESPACES.has(fieldKey)) {
        errors.push(
          `Invalid template at "${contextLabel}": disallowed namespace "${fieldKey ?? ''}".`
        );
        continue;
      }

      if (calcFieldKeys.has(fieldKey) && !fieldsByKey.has(fieldKey)) {
        errors.push(
          `Invalid template at "${contextLabel}": targets CalculatedField "${fieldKey}".`
        );
        continue;
      }

      const targetField = fieldsByKey.get(fieldKey);
      if (!targetField) {
        errors.push(
          `Invalid template at "${contextLabel}": targets unknown field "${fieldKey}".`
        );
        continue;
      }

      if (property !== undefined && !isValidLookupProperty(targetField, property, documentSchema)) {
        errors.push(
          `Invalid template at "${contextLabel}": accesses unknown property ".${property}" on field "${fieldKey}".`
        );
      }
    }
  }

  const literals = parsed
    ? parsed.literals
    : [template.replace(/\{\{[\s\S]*?\}\}/g, '')];

  if (allowSafeCardHtml) {
    validateSafeCardHtmlLiterals(literals, contextLabel, errors);
  } else {
    validatePlainTextLiterals(literals, contextLabel, errors);
  }
}

/**
 * Validates `documentUiSchema.successView` templates, safe Card HTML literals,
 * plain-text labels, and `artifacts[].stepId` / `whenWorkflow` keys against workflows.
 */
export function validateDocumentUiSuccessView(params: {
  successView: DocumentUiSuccessView | undefined;
  documentSchema: DocumentSchema;
  workflowConfig?: DocumentWorkflowConfig | undefined;
  evaluator: TemplateEvaluatorPort;
  errors: string[];
}): void {
  const { successView, documentSchema, workflowConfig, evaluator, errors } = params;
  if (!successView) {
    return;
  }

  const stage1Vars = collectStage1DocumentDataVariables(documentSchema);
  const fieldsByKey = new Map(documentSchema.fields.map((f) => [f.key, f]));
  const calcFieldKeys = new Set((documentSchema.calculatedFields ?? []).map((cf) => cf.key));

  if (successView.summary) {
    const { summary } = successView;
    validateSummaryTemplate({
      template: summary.text,
      contextLabel: 'documentUiSchema.successView.summary.text',
      allowSafeCardHtml: true,
      documentSchema,
      stage1Vars,
      fieldsByKey,
      calcFieldKeys,
      evaluator,
      errors,
    });

    if (summary.topLabel !== undefined) {
      validateSummaryTemplate({
        template: summary.topLabel,
        contextLabel: 'documentUiSchema.successView.summary.topLabel',
        allowSafeCardHtml: false,
        documentSchema,
        stage1Vars,
        fieldsByKey,
        calcFieldKeys,
        evaluator,
        errors,
      });
    }

    if (summary.bottomLabel !== undefined) {
      validateSummaryTemplate({
        template: summary.bottomLabel,
        contextLabel: 'documentUiSchema.successView.summary.bottomLabel',
        allowSafeCardHtml: false,
        documentSchema,
        stage1Vars,
        fieldsByKey,
        calcFieldKeys,
        evaluator,
        errors,
      });
    }
  }

  if (successView.artifacts) {
    const workflows = workflowConfig?.workflows ?? [];
    const workflowNames = new Set(workflows.map((w) => w.name));
    const workflowStepIds = new Set<string>();
    for (const wf of workflows) {
      for (const act of wf.activitySequence ?? []) {
        if (act.id !== undefined) {
          workflowStepIds.add(act.id);
        }
      }
    }

    successView.artifacts.forEach((artifact, index) => {
      const prefix = `documentUiSchema.successView.artifacts[${index}]`;
      if (artifact.stepId.trim().length === 0) {
        errors.push(`Invalid artifact at "${prefix}.stepId": must not be blank.`);
      } else if (!workflowStepIds.has(artifact.stepId)) {
        errors.push(
          `Invalid artifact at "${prefix}.stepId": unknown stepId "${artifact.stepId}" (not found in documentWorkflowConfig.workflows).`
        );
      }

      if (artifact.label.trim().length === 0) {
        errors.push(`Invalid artifact at "${prefix}.label": must not be blank.`);
      }

      if (artifact.fallbackLabel !== undefined && artifact.fallbackLabel.trim().length === 0) {
        errors.push(`Invalid artifact at "${prefix}.fallbackLabel": must not be blank.`);
      }

      if (artifact.whenWorkflow) {
        for (const [wfName, wfLabel] of Object.entries(artifact.whenWorkflow)) {
          if (!workflowNames.has(wfName)) {
            errors.push(
              `Invalid artifact at "${prefix}.whenWorkflow.${wfName}": unknown workflow "${wfName}" (not found in documentWorkflowConfig.workflows).`
            );
          }
          if (wfLabel.trim().length === 0) {
            errors.push(
              `Invalid artifact at "${prefix}.whenWorkflow.${wfName}": label must not be blank.`
            );
          }
        }
      }
    });
  }
}
