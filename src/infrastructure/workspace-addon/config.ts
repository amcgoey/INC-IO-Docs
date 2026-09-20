import type { WorkspaceConfiguration } from '../manifest/app-manifest-provider';

export type { WorkspaceConfiguration };

export interface WorkspaceConfigProviderPort {
  getWorkspaceConfig(): Promise<WorkspaceConfiguration | undefined>;
}
