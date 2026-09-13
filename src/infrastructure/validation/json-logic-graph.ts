import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

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

export const StringArraySchema = Type.Array(Type.String());

export const SchemaOrKeysSchema = Type.Union([
  StringArraySchema,
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
 * (e.g. `data.firstName` -> `firstName`, or `data` / `""` -> `*` representing entire root data context).
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

      if (varPath === 'data' || varPath === '') {
        // Direct root data context access: depends on all fields
        dependencies.add('*');
      } else if (varPath && varPath.startsWith(prefix)) {
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

interface GraphSortResult {
  evaluationOrder: string[];
  adjacency: Map<string, string[]>;
  allFieldKeys: string[];
}

function buildAndSortGraph(
  schemaOrKeys?: SchemaOrKeys,
  uiSchema?: { layout?: string[]; fields?: Record<string, unknown>; evaluationOrder?: string[] }
): GraphSortResult {
  if (schemaOrKeys !== undefined && !Value.Check(SchemaOrKeysSchema, schemaOrKeys)) {
    const errors = [...Value.Errors(SchemaOrKeysSchema, schemaOrKeys)]
      .map((e) => `${e.path}: ${e.message}`)
      .join(', ');
    throw new Error(`Invalid schemaOrKeys: ${errors}`);
  }

  if (uiSchema !== undefined && !Value.Check(ContainerWithLayoutSchema, uiSchema)) {
    const errors = [...Value.Errors(ContainerWithLayoutSchema, uiSchema)]
      .map((e) => `${e.path}: ${e.message}`)
      .join(', ');
    throw new Error(`Invalid uiSchema: ${errors}`);
  }

  const allFieldKeys: string[] = [];
  const seenKeys = new Set<string>();

  function addKey(key: string) {
    if (key && !seenKeys.has(key)) {
      seenKeys.add(key);
      allFieldKeys.push(key);
    }
  }

  if (schemaOrKeys !== undefined) {
    if (Value.Check(StringArraySchema, schemaOrKeys)) {
      for (const k of schemaOrKeys) {
        addKey(k);
      }
    } else if (Value.Check(ContainerWithFieldsSchema, schemaOrKeys) && schemaOrKeys.fields) {
      if (Array.isArray(schemaOrKeys.fields)) {
        for (const field of schemaOrKeys.fields) {
          addKey(field.key);
        }
      } else {
        for (const k of Object.keys(schemaOrKeys.fields)) {
          addKey(k);
        }
      }
    } else if (typeof schemaOrKeys === 'object' && schemaOrKeys !== null) {
      for (const k of Object.keys(schemaOrKeys)) {
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
    return {
      evaluationOrder: [],
      adjacency: new Map(),
      allFieldKeys: [],
    };
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
      (schemaOrKeys &&
      typeof schemaOrKeys === 'object' &&
      'fields' in schemaOrKeys &&
      !Array.isArray((schemaOrKeys as { fields?: unknown }).fields)
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

      const dependsOnAll = uniqueDeps.includes('*');
      const directDeps = uniqueDeps.filter((d) => d !== '*');
      const targetDeps = new Set<string>();

      if (dependsOnAll) {
        for (const otherKey of allFieldKeys) {
          if (otherKey !== key) {
            targetDeps.add(otherKey);
          }
        }
      }

      for (const dep of directDeps) {
        if (dep === key) {
          throw new Error(`Circular dependency detected in computeValue rules: ${key}`);
        }
        if (inDegrees.has(dep)) {
          targetDeps.add(dep);
        }
      }

      for (const dep of targetDeps) {
        adjacency.get(dep)!.push(key);
        reverseAdjacency.get(key)!.push(dep);
        inDegrees.set(key, (inDegrees.get(key) ?? 0) + 1);
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
    // Use Tarjan's SCC on reverseAdjacency to find true cycle participants
    const trueCycleNodes = findCycleNodes(unresolvedNodes, reverseAdjacency);
    const reportedNodes = trueCycleNodes.length > 0 ? trueCycleNodes : unresolvedNodes;
    throw new Error(
      `Circular dependency detected in computeValue rules: ${reportedNodes.join(', ')}`
    );
  }

  return {
    evaluationOrder,
    adjacency,
    allFieldKeys,
  };
}

/**
 * Validates an explicit evaluationOrder against schema fields and DAG dependencies.
 * Throws an error if any field is missing, duplicated, or if a dependency is violated.
 */
function validateExplicitEvaluationOrder(
  explicitOrder: string[],
  allFieldKeys: string[],
  adjacency: Map<string, string[]>
): void {
  const allKeysSet = new Set(allFieldKeys);
  const explicitSet = new Set(explicitOrder);

  for (const key of explicitOrder) {
    if (!allKeysSet.has(key)) {
      throw new Error(`Invalid evaluationOrder: unknown field "${key}" not found in schema`);
    }
  }
  for (const key of allFieldKeys) {
    if (!explicitSet.has(key)) {
      throw new Error(`Invalid evaluationOrder: missing field "${key}" in evaluationOrder`);
    }
  }
  if (explicitOrder.length !== allFieldKeys.length) {
    throw new Error(`Invalid evaluationOrder: contains duplicate fields`);
  }

  const positionMap = new Map<string, number>();
  explicitOrder.forEach((key, index) => positionMap.set(key, index));

  for (const [dep, dependents] of adjacency.entries()) {
    const depPos = positionMap.get(dep)!;
    for (const dependent of dependents) {
      const dependentPos = positionMap.get(dependent)!;
      if (depPos >= dependentPos) {
        throw new Error(
          `Invalid evaluationOrder: field "${dependent}" depends on "${dep}", but "${dep}" is evaluated after "${dependent}"`
        );
      }
    }
  }
}

/**
 * Computes an execution order for field evaluation using Kahn's algorithm (topological sort).
 * Validates that no circular dependencies exist among computeValue expressions.
 */
export function computeEvaluationOrder(
  schemaOrKeys?: SchemaOrKeys,
  uiSchema?: { layout?: string[]; fields?: Record<string, unknown>; evaluationOrder?: string[] }
): string[] {
  return buildAndSortGraph(schemaOrKeys, uiSchema).evaluationOrder;
}

/**
 * Ensures evaluationOrder is computed and attached to a container if fields or layout exist.
 * Validates DAG topology and validates explicit evaluationOrder when present.
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

  const hasFields = Boolean(container.fields && Object.keys(container.fields).length > 0);
  const hasLayout = Boolean(container.layout && container.layout.length > 0);
  const hasSchema = Boolean(schemaOrKeys);

  if (hasFields || hasLayout || hasSchema) {
    const { evaluationOrder: computedOrder, allFieldKeys, adjacency } = buildAndSortGraph(
      schemaOrKeys,
      container
    );

    if (container.evaluationOrder) {
      validateExplicitEvaluationOrder(container.evaluationOrder, allFieldKeys, adjacency);
      return {
        ...container,
        evaluationOrder: container.evaluationOrder,
      };
    }

    return {
      ...container,
      evaluationOrder: computedOrder,
    };
  }

  return container as T & { evaluationOrder?: string[] };
}
