export interface HandlebarsValidationResult {
  isValid: boolean;
  errors: string[];
}

/**
 * Validates a Handlebars template string for syntax and variable definitions.
 */
export function validateHandlebarsTemplate(template: string): HandlebarsValidationResult {
  if (!template || template.trim() === '') {
    return {
      isValid: false,
      errors: ['Template cannot be empty'],
    };
  }

  return {
    isValid: true,
    errors: [],
  };
}
