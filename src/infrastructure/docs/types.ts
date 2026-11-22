import { Type, type Static, type TSchema } from '@sinclair/typebox';
import type { OAuth2Client } from 'google-auth-library';
import type { docs_v1 } from 'googleapis';

export type GoogleDocsFormFieldValue = string | boolean | string[];

export interface GoogleDocsFormExtractResult {
  widgetCount: number;
  fields: Record<string, GoogleDocsFormFieldValue>;
  ambiguousFields?: string[] | undefined;
}

export interface DocsRetryOptions {
  maxRetries?: number | undefined;
  initialDelayMs?: number | undefined;
  backoffFactor?: number | undefined;
  requestTimeoutMs?: number | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
}

export interface DocsOperationOptions {
  auth?: OAuth2Client | string | undefined;
  accessToken?: string | undefined;
  requestTimeoutMs?: number | undefined;
}

export interface GoogleDocsClientOptions {
  auth?: OAuth2Client | string | undefined;
  docs?: docs_v1.Docs | undefined;
  requestTimeoutMs?: number | undefined;
  retryOptions?: DocsRetryOptions | undefined;
}

const nullableOptional = <T extends TSchema>(schema: T) =>
  Type.Optional(Type.Union([schema, Type.Null(), Type.Undefined()]));

export const GoogleDocsParagraphElementSchema = Type.Object({
  textRun: nullableOptional(
    Type.Object({
      content: nullableOptional(Type.String()),
    })
  ),
  dropdown: nullableOptional(
    Type.Object({
      dropdownId: nullableOptional(Type.String()),
      dropdownProperties: nullableOptional(
        Type.Object({
          dropdownDefinitionId: nullableOptional(Type.String()),
          selectedOptionId: nullableOptional(Type.String()),
          displayValue: nullableOptional(Type.String()),
        })
      ),
    })
  ),
  dateElement: nullableOptional(
    Type.Object({
      dateElementProperties: nullableOptional(
        Type.Object({
          timestamp: nullableOptional(Type.String()),
          timeZoneId: nullableOptional(Type.String()),
          displayText: nullableOptional(Type.String()),
        })
      ),
    })
  ),
  person: nullableOptional(
    Type.Object({
      personProperties: nullableOptional(
        Type.Object({
          name: nullableOptional(Type.String()),
          email: nullableOptional(Type.String()),
        })
      ),
    })
  ),
});

export const GoogleDocsParagraphSchema = Type.Object({
  elements: nullableOptional(Type.Array(GoogleDocsParagraphElementSchema)),
});

export const GoogleDocsTableCellStyleSchema = Type.Object({
  columnSpan: nullableOptional(Type.Number()),
  rowSpan: nullableOptional(Type.Number()),
});

export const GoogleDocsStructuralElementSchema = Type.Recursive((Self) =>
  Type.Object({
    paragraph: nullableOptional(GoogleDocsParagraphSchema),
    table: nullableOptional(
      Type.Object({
        rows: nullableOptional(Type.Number()),
        columns: nullableOptional(Type.Number()),
        tableRows: nullableOptional(
          Type.Array(
            Type.Object({
              tableCells: nullableOptional(
                Type.Array(
                  Type.Object({
                    content: nullableOptional(Type.Array(Self)),
                    tableCellStyle: nullableOptional(GoogleDocsTableCellStyleSchema),
                  })
                )
              ),
            })
          )
        ),
      })
    ),
    sectionBreak: nullableOptional(Type.Object({})),
    tableOfContents: nullableOptional(Type.Object({})),
  })
);

export type GoogleDocsStructuralElement = Static<typeof GoogleDocsStructuralElementSchema>;

export const GoogleDocsBodySchema = Type.Object({
  content: Type.Array(GoogleDocsStructuralElementSchema),
});

export type GoogleDocsBody = Static<typeof GoogleDocsBodySchema>;

export const GoogleDocsDropdownOptionSchema = Type.Object({
  optionId: nullableOptional(Type.String()),
  displayValue: nullableOptional(Type.String()),
});

export const GoogleDocsDropdownDefinitionSchema = Type.Object({
  dropdownDefinitionId: nullableOptional(Type.String()),
  dropdownDefinitionProperties: nullableOptional(
    Type.Object({
      title: nullableOptional(Type.String()),
      options: nullableOptional(Type.Array(GoogleDocsDropdownOptionSchema)),
    })
  ),
});

export const GoogleDocsDocumentTabSchema = Type.Object({
  body: nullableOptional(GoogleDocsBodySchema),
  dropdownDefinitions: nullableOptional(
    Type.Record(Type.String(), GoogleDocsDropdownDefinitionSchema)
  ),
});

export type GoogleDocsDocumentTab = Static<typeof GoogleDocsDocumentTabSchema>;

export const GoogleDocsTabSchema = Type.Recursive((Self) =>
  Type.Object({
    tabProperties: nullableOptional(
      Type.Object({
        tabId: nullableOptional(Type.String()),
        title: nullableOptional(Type.String()),
      })
    ),
    documentTab: nullableOptional(GoogleDocsDocumentTabSchema),
    childTabs: nullableOptional(Type.Array(Self)),
  })
);

export type GoogleDocsTab = Static<typeof GoogleDocsTabSchema>;

export const GoogleDocsDocumentSchema = Type.Object({
  documentId: nullableOptional(Type.String()),
  title: nullableOptional(Type.String()),
  tabs: nullableOptional(Type.Array(GoogleDocsTabSchema)),
  body: nullableOptional(GoogleDocsBodySchema),
});

export type GoogleDocsDocument = Static<typeof GoogleDocsDocumentSchema>;
