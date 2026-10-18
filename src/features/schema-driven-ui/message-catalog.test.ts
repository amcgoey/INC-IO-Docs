import { describe, it, expect } from 'vitest';
import { Value } from '@sinclair/typebox/value';
import {
  MessageCatalogSchema,
  DEFAULT_MESSAGE_CATALOG,
  formatFieldHint,
  formatStatusSectionMessage,
  formatValidationError,
} from './message-catalog';

describe('Message Catalog', () => {
  it('validates DEFAULT_MESSAGE_CATALOG against MessageCatalogSchema', () => {
    expect(Value.Check(MessageCatalogSchema, DEFAULT_MESSAGE_CATALOG)).toBe(true);
  });

  describe('formatFieldHint', () => {
    it('formats missing_space without needing targetPath', () => {
      expect(formatFieldHint(DEFAULT_MESSAGE_CATALOG, 'missing_space')).toBe('Select a Space first');
    });

    it('formats empty without needing targetPath', () => {
      expect(formatFieldHint(DEFAULT_MESSAGE_CATALOG, 'empty')).toBe('No options found');
    });

    it('formats path_not_found with provided targetPath', () => {
      expect(formatFieldHint(DEFAULT_MESSAGE_CATALOG, 'path_not_found', 'Communications')).toBe(
        "Folder 'Communications' not found"
      );
    });

    it('formats path_not_found falling back to root when targetPath is omitted or empty', () => {
      expect(formatFieldHint(DEFAULT_MESSAGE_CATALOG, 'path_not_found')).toBe("Folder 'root' not found");
      expect(formatFieldHint(DEFAULT_MESSAGE_CATALOG, 'path_not_found', '')).toBe("Folder 'root' not found");
      expect(formatFieldHint(DEFAULT_MESSAGE_CATALOG, 'path_not_found', '   ')).toBe("Folder 'root' not found");
    });

    it('formats ambiguous_path with targetPath', () => {
      expect(formatFieldHint(DEFAULT_MESSAGE_CATALOG, 'ambiguous_path', 'Communications')).toBe(
        "Ambiguous folder path 'Communications'"
      );
    });

    it('formats timeout without targetPath', () => {
      expect(formatFieldHint(DEFAULT_MESSAGE_CATALOG, 'timeout')).toBe('Timed out loading options');
    });

    it('formats error without targetPath', () => {
      expect(formatFieldHint(DEFAULT_MESSAGE_CATALOG, 'error')).toBe('Error loading options');
    });

    it('returns undefined for ready or unknown statuses', () => {
      expect(formatFieldHint(DEFAULT_MESSAGE_CATALOG, 'ready')).toBeUndefined();
      expect(formatFieldHint(DEFAULT_MESSAGE_CATALOG, 'unknown_status')).toBeUndefined();
    });
  });

  describe('formatStatusSectionMessage', () => {
    it('returns undefined for statuses without a statusSection message', () => {
      expect(formatStatusSectionMessage(DEFAULT_MESSAGE_CATALOG, 'ready')).toBeUndefined();
      expect(formatStatusSectionMessage(DEFAULT_MESSAGE_CATALOG, 'missing_space')).toBeUndefined();
      expect(formatStatusSectionMessage(DEFAULT_MESSAGE_CATALOG, 'empty')).toBeUndefined();
      expect(formatStatusSectionMessage(DEFAULT_MESSAGE_CATALOG, 'unknown')).toBeUndefined();
    });

    it('formats path_not_found with targetPath and root fallback', () => {
      expect(
        formatStatusSectionMessage(DEFAULT_MESSAGE_CATALOG, 'path_not_found', 'Communications')
      ).toBe('Folder "Communications" was not found in the selected Document Space.');
      expect(formatStatusSectionMessage(DEFAULT_MESSAGE_CATALOG, 'path_not_found')).toBe(
        'Folder "root" was not found in the selected Document Space.'
      );
    });

    it('formats ambiguous_path with targetPath', () => {
      expect(
        formatStatusSectionMessage(DEFAULT_MESSAGE_CATALOG, 'ambiguous_path', 'Communications')
      ).toBe(
        'Multiple folders found along path "Communications" in the selected Document Space. Please resolve this ambiguity in Google Drive manually.'
      );
    });

    it('formats timeout with targetPath and root fallback', () => {
      expect(
        formatStatusSectionMessage(DEFAULT_MESSAGE_CATALOG, 'timeout', 'Communications')
      ).toBe('Timed out loading options from "Communications".');
      expect(formatStatusSectionMessage(DEFAULT_MESSAGE_CATALOG, 'timeout')).toBe(
        'Timed out loading options from "root".'
      );
    });

    it('formats error with targetPath and root fallback', () => {
      expect(
        formatStatusSectionMessage(DEFAULT_MESSAGE_CATALOG, 'error', 'Communications')
      ).toBe('Failed to load options from "Communications".');
      expect(formatStatusSectionMessage(DEFAULT_MESSAGE_CATALOG, 'error')).toBe(
        'Failed to load options from "root".'
      );
    });
  });

  describe('formatValidationError', () => {
    it('formats missing_space and empty', () => {
      expect(formatValidationError(DEFAULT_MESSAGE_CATALOG, 'missing_space')).toBe('Option not found.');
      expect(formatValidationError(DEFAULT_MESSAGE_CATALOG, 'empty')).toBe('Option not found.');
    });

    it('formats path_not_found and ambiguous_path with targetPath interpolation', () => {
      expect(formatValidationError(DEFAULT_MESSAGE_CATALOG, 'path_not_found', 'Communications')).toBe(
        'Folder "Communications" was not found in the selected Document Space.'
      );
      expect(formatValidationError(DEFAULT_MESSAGE_CATALOG, 'ambiguous_path', 'Communications')).toBe(
        'Multiple folders found along path "Communications" in the selected Document Space. Please resolve this ambiguity in Google Drive manually.'
      );
    });

    it('formats option_not_found and ambiguous_option', () => {
      expect(formatValidationError(DEFAULT_MESSAGE_CATALOG, 'option_not_found')).toBe('Option not found.');
      expect(formatValidationError(DEFAULT_MESSAGE_CATALOG, 'ambiguous_option')).toBe(
        'Multiple folders found with this name. Please resolve this ambiguity in Google Drive manually.'
      );
    });

    it('formats timeout and error', () => {
      expect(formatValidationError(DEFAULT_MESSAGE_CATALOG, 'timeout')).toBe('Validation timed out.');
      expect(formatValidationError(DEFAULT_MESSAGE_CATALOG, 'error')).toBe(
        'An unexpected error occurred during dynamic option validation.'
      );
    });

    it('returns undefined for unknown validation statuses', () => {
      expect(formatValidationError(DEFAULT_MESSAGE_CATALOG, 'ready')).toBeUndefined();
      expect(formatValidationError(DEFAULT_MESSAGE_CATALOG, 'non_existent')).toBeUndefined();
    });
  });
});
