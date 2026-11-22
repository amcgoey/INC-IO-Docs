import Handlebars from 'handlebars';

interface HandlebarsPathNode {
  type?: string;
  original?: string;
  parts?: string[];
  data?: boolean;
  depth?: number;
}

interface HandlebarsAstNode {
  type?: string;
  original?: string;
  value?: string;
  escaped?: boolean;
  path?: HandlebarsPathNode;
  body?: unknown[];
  program?: unknown;
  inverse?: unknown;
  params?: unknown[];
  hash?: { pairs?: unknown[] };
}

interface ParsedTemplateToken {
  fieldKey: string;
  property?: string | undefined;
}

interface ParsedFieldTemplate {
  tokens: ParsedTemplateToken[];
  literals: string[];
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
      const hasCatchAll = allowedSet.has('*');
      const wildcardPrefixes = allowedVariables
        .filter((pattern) => pattern.endsWith('.*') || (pattern.endsWith('*') && pattern !== '*'))
        .map((pattern) => (pattern.endsWith('.*') ? pattern.slice(0, -2) : pattern.slice(0, -1)));

      return referencedVariables.every((variable) => {
        if (hasCatchAll || allowedSet.has(variable)) {
          return true;
        }
        for (const prefix of wildcardPrefixes) {
          if (variable === prefix || variable.startsWith(`${prefix}.`)) {
            return true;
          }
        }
        return false;
      });
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

  /**
   * Parses a Stage-1 DocumentField Handlebars template into ordered field tokens and literal
   * separators, rejecting logic blocks, helpers, comments, partials, unescaped mustaches,
   * relative/context paths, deeper paths, and non-Stage-1 namespaces (ADR 0003 & ADR 0016).
   */
  public parseFieldTemplate(template: string): ParsedFieldTemplate {
    const ast = Handlebars.parse(template) as unknown as HandlebarsAstNode;
    const body = Array.isArray(ast.body) ? ast.body : [];

    const tokens: ParsedTemplateToken[] = [];
    const literals: string[] = [];
    let currentLiteral = '';

    for (const rawStatement of body) {
      const stmt = rawStatement as HandlebarsAstNode;
      if (stmt.type === 'ContentStatement') {
        currentLiteral += typeof stmt.value === 'string' ? stmt.value : (stmt.original ?? '');
        continue;
      }

      if (stmt.type !== 'MustacheStatement') {
        throw new Error(`Unsupported Handlebars statement "${stmt.type ?? 'unknown'}" in field template`);
      }

      if (stmt.escaped === false) {
        throw new Error('Triple-stash unescaped expressions ({{{...}}}) are not allowed in field templates');
      }

      if (Array.isArray(stmt.params) && stmt.params.length > 0) {
        throw new Error('Helper parameters are not allowed in field templates');
      }

      if (stmt.hash && Array.isArray(stmt.hash.pairs) && stmt.hash.pairs.length > 0) {
        throw new Error('Hash arguments are not allowed in field templates');
      }

      const pathNode = stmt.path;
      if (!pathNode || pathNode.type !== 'PathExpression') {
        throw new Error('SubExpressions and literal mustaches are not allowed in field templates');
      }

      if (pathNode.data === true) {
        throw new Error(`Data variables ("${pathNode.original ?? '@'}") are not allowed in field templates`);
      }

      if (typeof pathNode.depth === 'number' && pathNode.depth > 0) {
        throw new Error(`Parent path traversal ("${pathNode.original ?? '../'}") is not allowed in field templates`);
      }

      const original = pathNode.original ?? '';
      if (
        original === 'this' ||
        original.startsWith('this.') ||
        original === '.' ||
        original.startsWith('./')
      ) {
        throw new Error(`Relative context path "${original}" is not allowed in field templates`);
      }

      const parts = Array.isArray(pathNode.parts) ? pathNode.parts : [];
      if (parts.length === 0 || parts.length > 2 || parts.some((part) => part.trim().length === 0)) {
        throw new Error(`Invalid field path "${original}" in field template (expected fieldKey or fieldKey.property)`);
      }

      const [fieldKey, property] = parts;
      if (fieldKey === 'calculated' || fieldKey === 'Document') {
        throw new Error(`Disallowed namespace "${fieldKey}" in Stage-1 field template`);
      }

      literals.push(currentLiteral);
      currentLiteral = '';
      tokens.push(property !== undefined ? { fieldKey, property } : { fieldKey });
    }

    literals.push(currentLiteral);

    if (tokens.length === 0) {
      throw new Error('Field template must reference at least one Stage-1 DocumentField token');
    }

    return { tokens, literals };
  }
}
