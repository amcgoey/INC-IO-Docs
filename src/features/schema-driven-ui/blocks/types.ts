export interface AbstractDataField {
  key: string;
  type?: string;
  options?: unknown;
  defaultValue?: unknown;
}

export interface AbstractDataSchema {
  fields: AbstractDataField[];
}
