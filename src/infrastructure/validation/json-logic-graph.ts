import { Type, type Static } from '@sinclair/typebox';

export const ComputationFieldSchema = Type.Object(
  {
    computeValue: Type.Optional(Type.Unknown()),
  },
  { additionalProperties: true }
);
export type ComputationFieldLike = Static<typeof ComputationFieldSchema>;

export const FieldWithKeySchema = Type.Object(
  {
    key: Type.String(),
  },
  { additionalProperties: true }
);

export const ContainerWithFieldsSchema = Type.Object(
  {
    fields: Type.Optional(
      Type.Union([
        Type.Array(FieldWithKeySchema),
        Type.Record(Type.String(), Type.Unknown()),
      ])
    ),
  },
  { additionalProperties: true }
);
export type ContainerWithFieldsLike = Static<typeof ContainerWithFieldsSchema>;

export const ContainerWithLayoutSchema = Type.Object(
  {
    layout: Type.Optional(Type.Array(Type.String())),
    fields: Type.Optional(Type.Record(Type.String(), Type.Unknown())),
    evaluationOrder: Type.Optional(Type.Array(Type.String())),
  },
  { additionalProperties: true }
);
export type ContainerWithLayoutLike = Static<typeof ContainerWithLayoutSchema>;

export const SchemaOrKeysSchema = Type.Union([
  Type.Array(Type.String()),
  ContainerWithFieldsSchema,
  Type.Record(Type.String(), Type.Unknown()),
]);
export type SchemaOrKeys =
  | string[]
  | { fields?: Array<{ key: string }> | Record<string, unknown> }
  | Record<string, unknown>;

/**
 * Recursively inspects a JSONLogic AST to extract all referenced field names
 * from `var` operators pointing to the `data` namespace
 * (e.g. `data.firstName` -> `firstName`).
 */
export function extractJsonLogicDependencies(rule: unknown): string[] {
  const dependencies = new Set<string>();
  const prefix = 'data.';

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

      if (varPath && varPath.startsWith(prefix)) {
        const fieldName = varPath.slice(prefix.length).split('.')[0];
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
 * Finds all nodes participating in cycles within a directed graph using Tarjan's SCC algorithm.
 * Excludes innocent downstream nodes that are merely reachable from a cycle.
 */
function findCycleNodes(nodes: string[], adjacency: Map<string, string[]>): string[] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Map<string, boolean>();
  const stack: string[] = [];
  const cycleNodes = new Set<string>();

  function strongConnect(v: string) {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.set(v, true);

    const neighbors = adjacency.get(v) ?? [];
    for (const w of neighbors) {
      if (!nodes.includes(w)) {
        continue;
      }
      if (!indices.has(w)) {
        strongConnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.get(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.set(w, false);
        scc.push(w);
      } while (w !== v);

      // An SCC is a cycle if it has more than 1 node or a single node with a self-loop
      if (scc.length > 1) {
        for (const node of scc) {
          cycleNodes.add(node);
        }
      } else if (scc.length === 1) {
        const singleNode = scc[0];
        if ((adjacency.get(singleNode) ?? []).includes(singleNode)) {
          cycleNodes.add(singleNode);
        }
      }
    }
  }

  for (const node of nodes) {
    if (!indices.has(node)) {
      strongConnect(node);
    }
  }

  return Array.from(cycleNodes);
}

/**
 * Computes an execution order for field evaluation using Kahn's algorithm (topological sort).
 * Validates that no circular dependencies exist among computeValue expressions.
 */
export function computeEvaluationOrder(
  schemaOrKeys?: SchemaOrKeys,
  uiSchema?: { layout?: string[]; fields?: Record<string, unknown>; evaluationOrder?: string[] }
): string[] {
  const allFieldKeys: string[] = [];
  const seenKeys = new Set<string>();

  function addKey(key: string) {
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key);
      allFieldKeys.push(key);
    }
  }

  if (Array.isArray(schemaOrKeys)) {
    for (const k of schemaOrKeys) {
      if (typeof k === 'string') {
        addKey(k);
      }
    }
  } else if (schemaOrKeys && typeof schemaOrKeys === 'object' && 'fields' in schemaOrKeys) {
    const rawFields = (schemaOrKeys as { fields?: unknown }).fields;
    if (Array.isArray(rawFields)) {
      for (const field of rawFields) {
        if (field && typeof field === 'object' && 'key' in field && typeof field.key === 'string') {
          addKey(field.key);
        }
      }
    } else if (rawFields && typeof rawFields === 'object') {
      for (const k of Object.keys(rawFields)) {
        addKey(k);
      }
    }
  }

  if (uiSchema?.layout && Array.isArray(uiSchema.layout)) {
    for (const k of uiSchema.layout) {
      addKey(k);
    }
  }

  if (uiSchema?.fields && typeof uiSchema.fields === 'object') {
    for (const k of Object.keys(uiSchema.fields)) {
      addKey(k);
    }
  }

  if (allFieldKeys.length === 0) {
    return [];
  }

  // Build dependency graph and in-degrees
  // An edge exists: dep -> key (dep must be evaluated before key)
  const adjacency = new Map<string, string[]>();
  const reverseAdjacency = new Map<string, string[]>();
  const inDegrees = new Map<string, number>();
  const hasComputeValueMap = new Map<string, boolean>();

  for (const key of allFieldKeys) {
    adjacency.set(key, []);
    reverseAdjacency.set(key, []);
    inDegrees.set(key, 0);
  }

  for (const key of allFieldKeys) {
    const candidateField =
      uiSchema?.fields?.[key] ??
      (schemaOrKeys && typeof schemaOrKeys === 'object' && 'fields' in schemaOrKeys && !Array.isArray((schemaOrKeys as { fields?: unknown }).fields)
        ? (schemaOrKeys as { fields?: Record<string, unknown> }).fields?.[key]
        : undefined);
    const uiField =
      candidateField && typeof candidateField === 'object'
        ? (candidateField as ComputationFieldLike)
        : undefined;

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
          reverseAdjacency.get(key)!.push(dep);
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
    const unresolvedNodes = allFieldKeys.filter((k) => (inDegrees.get(k) ?? 0) > 0);
    // Use Tarjan's SCC on reverseAdjacency (or adjacency) to find true cycle participants
    // Note: dependency is dep -> key in adjacency, so dep in reverseAdjacency of key means key depends on dep.
    const trueCycleNodes = findCycleNodes(unresolvedNodes, reverseAdjacency);
    const reportedNodes = trueCycleNodes.length > 0 ? trueCycleNodes : unresolvedNodes;
    throw new Error(
      `Circular dependency detected in computeValue rules: ${reportedNodes.join(', ')}`
    );
  }

  return evaluationOrder;
}

/**
 * Ensures evaluationOrder is computed and attached to a container if fields exist.
 * Validates DAG topology even if evaluationOrder is already present.
 * Returns a shallow copy containing evaluationOrder to avoid mutating input references.
 */
export function ensureEvaluationOrder<
  T extends { layout?: string[]; fields?: Record<string, unknown>; evaluationOrder?: string[] }
>(
  container?: T,
  schemaOrKeys?: SchemaOrKeys
): (T & { evaluationOrder?: string[] }) | undefined {
  if (!container) {
    return container;
  }
  if (container.fields) {
    const computedOrder = computeEvaluationOrder(schemaOrKeys, container);
    return {
      ...container,
      evaluationOrder: computedOrder,
    };
  }
  return container as T & { evaluationOrder?: string[] };
}
