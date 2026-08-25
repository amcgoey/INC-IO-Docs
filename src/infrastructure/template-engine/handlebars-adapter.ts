import Handlebars from 'handlebars';

export class HandlebarsAdapter {
  /**
   * Extracts all variable names referenced in pure Handlebars mustache statements.
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
          params?: unknown[];
        };

        if (
          astNode.type === 'MustacheStatement' &&
          astNode.path?.type === 'PathExpression' &&
          astNode.path.original &&
          (!astNode.params || astNode.params.length === 0)
        ) {
          variables.push(astNode.path.original);
        }

        if (Array.isArray(astNode.body)) {
          for (const child of astNode.body) {
            traverse(child);
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
   * Validates that the template parses successfully, strictly contains no logic blocks
   * or helper calls (ADR 0003), and all referenced variables exist within the allowed variables list.
   */
  public validate(template: string, allowedVariables: string[]): boolean {
    try {
      const ast = Handlebars.parse(template);
      let containsLogic = false;

      const inspectNode = (node: unknown): void => {
        if (!node || typeof node !== 'object' || containsLogic) {
          return;
        }

        const astNode = node as {
          type?: string;
          body?: unknown[];
          program?: unknown;
          inverse?: unknown;
          params?: unknown[];
        };

        // ADR 0003: Disallow block statements, subexpressions, and helper calls with parameters
        if (
          astNode.type === 'BlockStatement' ||
          astNode.type === 'SubExpression' ||
          (astNode.type === 'MustacheStatement' && Array.isArray(astNode.params) && astNode.params.length > 0)
        ) {
          containsLogic = true;
          return;
        }

        if (Array.isArray(astNode.body)) {
          for (const child of astNode.body) {
            inspectNode(child);
          }
        }

        if (astNode.program) {
          inspectNode(astNode.program);
        }

        if (astNode.inverse) {
          inspectNode(astNode.inverse);
        }
      };

      inspectNode(ast);

      if (containsLogic) {
        return false;
      }

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
