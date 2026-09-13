export interface ComputationFieldLike {
  computeValue?: unknown;
  [key: string]: unknown;
}

export interface ContainerWithFieldsLike {
  fields?: Array<{ key: string }> | Record<string, ComputationFieldLike>;
  [key: string]: unknown;
}

export interface ContainerWithLayoutLike {
  layout?: string[];
  fields?: Record<string, ComputationFieldLike>;
  evaluationOrder?: string[];
  [key: string]: unknown;
}

/**
 * Recursively inspects a JSONLogic AST to extract all referenced field names
 * from `var` operators pointing to the `data` namespace (e.g., `data.firstName` -> `firstName`).
 */
export function extractJsonLogicDependencies(rule: unknown): string[] {
  const dependencies = new Set<string>();

  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') {
      return;
    }

    if (Array.isArray(node)) {
      for (const item of node) {
        walk(item);
      }
      return;
    }

    const record = node as Record<string, unknown>;

    if ('var' in record) {
      const varVal = record.var;
      let varPath: string | undefined;

      if (typeof varVal === 'string') {
        varPath = varVal;
      } else if (Array.isArray(varVal) && typeof varVal[0] === 'string') {
        varPath = varVal[0];
        if (varVal.length > 1) {
          walk(varVal[1]);
        }
      } else if (typeof varVal === 'object' && varVal !== null) {
        walk(varVal);
      }

      if (varPath && varPath.startsWith('data.')) {
        const fieldName = varPath.slice(5).split('.')[0];
        if (fieldName) {
          dependencies.add(fieldName);
        }
      }
    }

    for (const [key, value] of Object.entries(record)) {
      if (key !== 'var') {
        walk(value);
      }
    }
  }

  walk(rule);
  return Array.from(dependencies);
}

/**
 * Computes the safe topological evaluation order for fields using Kahn's algorithm.
 * Fields without `computeValue` are ordered first so their static/default values are
 * ready before dependent computations execute.
 *
 * If circular dependencies exist in `computeValue` rules, throws an Error detailing
 * the offending fields.
 */
export function computeEvaluationOrder(
  schemaOrKeys?: string[] | ContainerWithFieldsLike,
  uiSchema?: ContainerWithLayoutLike
): string[] {
  const fieldKeySet = new Set<string>();
  const allFieldKeys: string[] = [];

  const addKey = (key: string) => {
    if (key && !fieldKeySet.has(key)) {
      fieldKeySet.add(key);
      allFieldKeys.push(key);
    }
  };

  if (Array.isArray(schemaOrKeys)) {
    for (const key of schemaOrKeys) {
      if (typeof key === 'string') {
        addKey(key);
      }
    }
  } else if (schemaOrKeys && typeof schemaOrKeys === 'object') {
    if (Array.isArray(schemaOrKeys.fields)) {
      for (const field of schemaOrKeys.fields) {
        if (field?.key) {
          addKey(field.key);
        }
      }
    } else if (schemaOrKeys.fields && typeof schemaOrKeys.fields === 'object') {
      for (const key of Object.keys(schemaOrKeys.fields)) {
        addKey(key);
      }
    }
  }

  if (uiSchema?.layout) {
    for (const key of uiSchema.layout) {
      addKey(key);
    }
  }

  if (uiSchema?.fields) {
    for (const key of Object.keys(uiSchema.fields)) {
      addKey(key);
    }
  }

  if (allFieldKeys.length === 0) {
    return [];
  }

  const inDegrees = new Map<string, number>();
  const adjacency = new Map<string, string[]>();
  const hasComputeValueMap = new Map<string, boolean>();

  for (const key of allFieldKeys) {
    inDegrees.set(key, 0);
    adjacency.set(key, []);
    hasComputeValueMap.set(key, false);
  }

  for (const key of allFieldKeys) {
    const uiField =
      uiSchema?.fields?.[key] ??
      (!Array.isArray(schemaOrKeys) &&
      schemaOrKeys?.fields &&
      !Array.isArray(schemaOrKeys.fields)
        ? (schemaOrKeys.fields as Record<string, ComputationFieldLike>)[key]
        : undefined);

    if (uiField?.computeValue !== undefined) {
      hasComputeValueMap.set(key, true);
      const rawDeps = extractJsonLogicDependencies(uiField.computeValue);
      const uniqueDeps = Array.from(new Set(rawDeps));

      for (const dep of uniqueDeps) {
        if (dep === key) {
          throw new Error(`Circular dependency detected in computeValue rules: ${key}`);
        }

        if (inDegrees.has(dep)) {
          adjacency.get(dep)!.push(key);
          inDegrees.set(key, (inDegrees.get(key) ?? 0) + 1);
        }
      }
    }
  }

  // Fields without computeValue are prioritized to evaluate first
  const withoutCompute = allFieldKeys.filter(
    (k) => !hasComputeValueMap.get(k) && (inDegrees.get(k) ?? 0) === 0
  );
  const withComputeZeroInDegree = allFieldKeys.filter(
    (k) => hasComputeValueMap.get(k) && (inDegrees.get(k) ?? 0) === 0
  );

  const queue: string[] = [...withoutCompute, ...withComputeZeroInDegree];
  const evaluationOrder: string[] = [];

  while (queue.length > 0) {
    const current = queue.shift()!;
    evaluationOrder.push(current);

    const neighbors = adjacency.get(current) ?? [];
    for (const neighbor of neighbors) {
      const currentInDegree = inDegrees.get(neighbor) ?? 0;
      const nextInDegree = currentInDegree - 1;
      inDegrees.set(neighbor, nextInDegree);

      if (nextInDegree === 0) {
        queue.push(neighbor);
      }
    }
  }

  if (evaluationOrder.length !== allFieldKeys.length) {
    const cyclicNodes = allFieldKeys.filter((k) => (inDegrees.get(k) ?? 0) > 0);
    throw new Error(
      `Circular dependency detected in computeValue rules: ${cyclicNodes.join(', ')}`
    );
  }

  return evaluationOrder;
}
