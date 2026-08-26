import Handlebars from 'handlebars';

interface HandlebarsAstNode {
  type?: string;
  path?: { type?: string; original?: string; parts?: string[] };
  body?: unknown[];
  program?: unknown;
  inverse?: unknown;
  params?: unknown[];
}

export class HandlebarsAdapter {
  /**
   * Traverses the Handlebars AST recursively and executes the visitor on each node.
   */
  private walkAst(node: unknown, visitor: (node: HandlebarsAstNode) => boolean | void): void {
    if (!node || typeof node !== 'object') {
      return;
    }

    const astNode = node as HandlebarsAstNode;
    const shouldStop = visitor(astNode);
    if (shouldStop === false) {
      return;
    }

    if (Array.isArray(astNode.body)) {
      for (const child of astNode.body) {
        this.walkAst(child, visitor);
      }
    }

    if (astNode.program) {
      this.walkAst(astNode.program, visitor);
    }

    if (astNode.inverse) {
      this.walkAst(astNode.inverse, visitor);
    }
  }

  /**
   * Extracts all variable names referenced in pure Handlebars mustache statements.
   */
  public extractVariables(template: string): string[] {
    try {
      const ast = Handlebars.parse(template);
      const variables: string[] = [];

      this.walkAst(ast, (astNode) => {
        if (
          astNode.type === 'MustacheStatement' &&
          astNode.path?.type === 'PathExpression' &&
          astNode.path.original &&
          (!astNode.params || astNode.params.length === 0)
        ) {
          variables.push(astNode.path.original);
        }
      });

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

      this.walkAst(ast, (astNode) => {
        if (
          astNode.type === 'BlockStatement' ||
          astNode.type === 'SubExpression' ||
          (astNode.type === 'MustacheStatement' && Array.isArray(astNode.params) && astNode.params.length > 0)
        ) {
          containsLogic = true;
          return false; // stop traversal
        }
      });

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
  public evaluate(template: string, context: { [key: string]: unknown }): string {
    const compiled = Handlebars.compile(template, { noEscape: true });
    return compiled(context);
  }
}
