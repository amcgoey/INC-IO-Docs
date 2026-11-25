import { Type, type Static } from '@sinclair/typebox';

export const MessageCatalogSchema = Type.Object({
  fieldHint: Type.Record(Type.String(), Type.String()),
  statusSection: Type.Record(Type.String(), Type.String()),
  validationError: Type.Record(Type.String(), Type.String()),
});

export type MessageCatalog = Static<typeof MessageCatalogSchema>;

export const DEFAULT_MESSAGE_CATALOG: MessageCatalog = {
  fieldHint: {
    missing_space: 'Select a Space first',
    empty: 'No options found',
    path_not_found: "Folder '{targetPath}' not found",
    ambiguous_path: "Ambiguous folder path '{targetPath}'",
    missing_log: 'Copy Document Log to load options',
    ambiguous_log: 'Select a Document Log first',
    config_error: 'Option table configuration error',
    timeout: 'Timed out loading options',
    error: 'Error loading options',
  },
  statusSection: {
    path_not_found: 'Folder "{targetPath}" was not found in the selected Document Space.',
    ambiguous_path:
      'Multiple folders found along path "{targetPath}" in the selected Document Space. Please resolve this ambiguity in Google Drive manually.',
    missing_log: 'Document Log not found in the selected Document Space. Click Copy Log to create one.',
    ambiguous_log: 'Multiple Document Logs found in the selected Document Space. Please select one.',
    config_error: 'Document Log option table configuration error.',
    timeout: 'Timed out loading options from "{targetPath}".',
    error: 'Failed to load options from "{targetPath}".',
  },
  validationError: {
    missing_space: 'Option not found.',
    empty: 'Option not found.',
    path_not_found: 'Folder "{targetPath}" was not found in the selected Document Space.',
    ambiguous_path:
      'Multiple folders found along path "{targetPath}" in the selected Document Space. Please resolve this ambiguity in Google Drive manually.',
    missing_log: 'Document Log not found in the selected Document Space.',
    ambiguous_log: 'Multiple Document Logs found in the selected Document Space. Please select one.',
    config_error: 'Document Log option table configuration error.',
    option_not_found: 'Option not found.',
    ambiguous_option:
      'Multiple folders found with this name. Please resolve this ambiguity in Google Drive manually.',
    timeout: 'Validation timed out.',
    error: 'An unexpected error occurred during dynamic option validation.',
  },
};

function normalizeTargetPath(targetPath?: string): string {
  if (typeof targetPath !== 'string') {
    return 'root';
  }
  const trimmed = targetPath.trim();
  return trimmed.length > 0 ? trimmed : 'root';
}

export function formatFieldHint(
  catalog: MessageCatalog,
  status: string,
  targetPath?: string
): string | undefined {
  const template = catalog.fieldHint[status];
  if (!template) {
    return undefined;
  }
  return template.replace(/\{targetPath\}/g, normalizeTargetPath(targetPath));
}

export function formatStatusSectionMessage(
  catalog: MessageCatalog,
  status: string,
  targetPath?: string
): string | undefined {
  const template = catalog.statusSection[status];
  if (!template) {
    return undefined;
  }
  return template.replace(/\{targetPath\}/g, normalizeTargetPath(targetPath));
}

export function formatValidationError(
  catalog: MessageCatalog,
  status: string,
  targetPath?: string
): string | undefined {
  const template = catalog.validationError[status];
  if (!template) {
    return undefined;
  }
  return template.replace(/\{targetPath\}/g, normalizeTargetPath(targetPath));
}
