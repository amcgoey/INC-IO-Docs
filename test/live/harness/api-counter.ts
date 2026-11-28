// nosemgrep: adapter-leakage-warning
import type { drive_v3 } from '@googleapis/drive';
// nosemgrep: adapter-leakage-warning
import type { sheets_v4 } from '@googleapis/sheets';

export interface ApiCallCategoryCounts {
  reads: number;
  writes: number;
  total: number;
  byMethod: Record<string, number>;
}

export interface ApiCallCounts {
  sheets: ApiCallCategoryCounts;
  drive: ApiCallCategoryCounts;
  total: number;
}

export interface ApiCallTracker {
  instrumentSheetsApi: (sheetsApi: sheets_v4.Sheets) => sheets_v4.Sheets;
  instrumentDriveApi: (driveApi: drive_v3.Drive) => drive_v3.Drive;
  getCounts: () => ApiCallCounts;
  reset: () => void;
  measure: <T>(fn: () => Promise<T>) => Promise<{ result: T; counts: ApiCallCounts }>;
}

const SHEETS_READ_METHODS = new Set([
  'spreadsheets.get',
  'spreadsheets.getByDataFilter',
  'spreadsheets.values.get',
  'spreadsheets.values.batchGet',
  'spreadsheets.values.batchGetByDataFilter',
]);

const DRIVE_READ_METHODS = new Set([
  'files.get',
  'files.list',
  'files.export',
  'drives.list',
  'drives.get',
]);

interface MutableCategoryCounters {
  reads: number;
  writes: number;
  byMethod: Record<string, number>;
}

function createMutableCategory(): MutableCategoryCounters {
  return { reads: 0, writes: 0, byMethod: {} };
}

function cloneCategory(source: MutableCategoryCounters): ApiCallCategoryCounts {
  return {
    reads: source.reads,
    writes: source.writes,
    total: source.reads + source.writes,
    byMethod: { ...source.byMethod },
  };
}

function diffCategory(
  before: ApiCallCategoryCounts,
  after: ApiCallCategoryCounts
): ApiCallCategoryCounts {
  const byMethod: Record<string, number> = {};
  for (const [method, afterCount] of Object.entries(after.byMethod)) {
    const delta = afterCount - (before.byMethod[method] ?? 0);
    if (delta > 0) {
      byMethod[method] = delta;
    }
  }
  const reads = after.reads - before.reads;
  const writes = after.writes - before.writes;
  return {
    reads,
    writes,
    total: reads + writes,
    byMethod,
  };
}

/**
 * Computes the delta between two `ApiCallCounts` snapshots.
 */
export function diffApiCallCounts(
  before: ApiCallCounts,
  after: ApiCallCounts
): ApiCallCounts {
  const sheets = diffCategory(before.sheets, after.sheets);
  const drive = diffCategory(before.drive, after.drive);
  return {
    sheets,
    drive,
    total: sheets.total + drive.total,
  };
}

function createResourceProxy<T extends object>(
  resource: T,
  prefix: string,
  onCall: (methodName: string) => void,
  nestedKeys: ReadonlySet<string> = new Set()
): T {
  const proxyCache = new Map<string | symbol, unknown>();
  // Use an empty child prototype object as the Proxy target so read-only, non-configurable
  // resource properties on googleapis instances (e.g. spreadsheets.values) never violate Proxy invariants.
  const proxyTarget = Object.create(resource) as T;
  return new Proxy(proxyTarget, {
    get(_target, prop) {
      if (typeof prop !== 'string') {
        return Reflect.get(resource, prop, resource);
      }
      if (proxyCache.has(prop)) {
        return proxyCache.get(prop);
      }
      const value = Reflect.get(resource, prop, resource);
      if (typeof value === 'function') {
        const methodName = `${prefix}.${prop}`;
        const wrapped = (...args: unknown[]) => {
          onCall(methodName);
          return Reflect.apply(value, resource, args);
        };
        proxyCache.set(prop, wrapped);
        return wrapped;
      }
      if (nestedKeys.has(prop) && typeof value === 'object' && value !== null) {
        const nestedProxy = createResourceProxy(
          value,
          `${prefix}.${prop}`,
          onCall
        );
        proxyCache.set(prop, nestedProxy);
        return nestedProxy;
      }
      return value;
    },
  });
}

/**
 * Creates a non-mutating Proxy-based API call counter for Google Sheets (`sheets_v4.Sheets`)
 * and Google Drive (`drive_v3.Drive`) SDK clients, tracking reads, writes, and per-method counts.
 */
export function createApiCallTracker(): ApiCallTracker {
  let sheets = createMutableCategory();
  let drive = createMutableCategory();

  const recordCall = (
    category: MutableCategoryCounters,
    readMethods: ReadonlySet<string>,
    methodName: string
  ): void => {
    if (readMethods.has(methodName)) {
      category.reads += 1;
    } else {
      category.writes += 1;
    }
    category.byMethod[methodName] = (category.byMethod[methodName] ?? 0) + 1;
  };

  const instrumentSheetsApi = (sheetsApi: sheets_v4.Sheets): sheets_v4.Sheets => {
    const spreadsheetsProxy = sheetsApi.spreadsheets
      ? createResourceProxy(
          sheetsApi.spreadsheets,
          'spreadsheets',
          (method) => recordCall(sheets, SHEETS_READ_METHODS, method),
          new Set(['values'])
        )
      : sheetsApi.spreadsheets;

    const facade = Object.create(sheetsApi) as sheets_v4.Sheets;
    return new Proxy(facade, {
      get(_target, prop) {
        if (prop === 'spreadsheets') {
          return spreadsheetsProxy;
        }
        return Reflect.get(sheetsApi, prop, sheetsApi);
      },
    });
  };

  const instrumentDriveApi = (driveApi: drive_v3.Drive): drive_v3.Drive => {
    const filesProxy = driveApi.files
      ? createResourceProxy(driveApi.files, 'files', (method) =>
          recordCall(drive, DRIVE_READ_METHODS, method)
        )
      : driveApi.files;
    const drivesProxy = driveApi.drives
      ? createResourceProxy(driveApi.drives, 'drives', (method) =>
          recordCall(drive, DRIVE_READ_METHODS, method)
        )
      : driveApi.drives;

    const facade = Object.create(driveApi) as drive_v3.Drive;
    return new Proxy(facade, {
      get(_target, prop) {
        if (prop === 'files') {
          return filesProxy;
        }
        if (prop === 'drives') {
          return drivesProxy;
        }
        return Reflect.get(driveApi, prop, driveApi);
      },
    });
  };

  const getCounts = (): ApiCallCounts => {
    const sheetsSnapshot = cloneCategory(sheets);
    const driveSnapshot = cloneCategory(drive);
    return {
      sheets: sheetsSnapshot,
      drive: driveSnapshot,
      total: sheetsSnapshot.total + driveSnapshot.total,
    };
  };

  const reset = (): void => {
    sheets = createMutableCategory();
    drive = createMutableCategory();
  };

  const measure = async <T>(
    fn: () => Promise<T>
  ): Promise<{ result: T; counts: ApiCallCounts }> => {
    const before = getCounts();
    const result = await fn();
    const after = getCounts();
    return {
      result,
      counts: diffApiCallCounts(before, after),
    };
  };

  return {
    instrumentSheetsApi,
    instrumentDriveApi,
    getCounts,
    reset,
    measure,
  };
}
