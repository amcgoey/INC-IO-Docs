import Handlebars from 'handlebars';

export class HandlebarsAdapter {
  /**
   * Extracts all variable names referenced in the Handlebars template AST.
   */
  public extractVariables(template: string): string[] {
    try {
      const ast = Handlebars.parse(template);
      const variables: string[] = [];

      const traverse = (node: unknown): void => {
        if (!node || typeof node !== 'object') {
          return;
        }

        const astNode = node as {
          type?: string;
          path?: { type?: string; original?: string; parts?: string[] };
          body?: unknown[];
          program?: unknown;
          inverse?: unknown;
          params?: unknown[];
        };

        if (astNode.type === 'MustacheStatement' || astNode.type === 'BlockStatement') {
          if (astNode.path?.type === 'PathExpression' && astNode.path.original) {
            variables.push(astNode.path.original);
          }
        }

        if (Array.isArray(astNode.body)) {
          for (const child of astNode.body) {
            traverse(child);
          }
        }

        if (astNode.program) {
          traverse(astNode.program);
        }

        if (astNode.inverse) {
          traverse(astNode.inverse);
        }

        if (Array.isArray(astNode.params)) {
          for (const param of astNode.params) {
            traverse(param);
          }
        }
      };

      traverse(ast);
      return [...new Set(variables)];
    } catch {
      return [];
    }
  }

  /**
   * Validates that the template parses successfully and all referenced variables
   * exist within the list of allowed variables.
   */
  public validate(template: string, allowedVariables: string[]): boolean {
    try {
      // Ensure the template parses without error
      Handlebars.parse(template);
      const referencedVariables = this.extractVariables(template);
      const allowedSet = new Set(allowedVariables);

      return referencedVariables.every((variable) => allowedSet.has(variable));
    } catch {
      return false;
    }
  }

  /**
   * Evaluates the template against the provided context using noEscape to preserve raw strings.
   */
  public evaluate(template: string, context: Record<string, unknown>): string {
    const compiled = Handlebars.compile(template, { noEscape: true });
    return compiled(context);
  }
}
