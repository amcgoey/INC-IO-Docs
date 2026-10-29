import { execFileSync } from 'node:child_process';
import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

export const CloudRunConditionSchema = Type.Object({
  type: Type.String({ minLength: 1 }),
  status: Type.Optional(Type.String()),
  reason: Type.Optional(Type.String()),
  message: Type.Optional(Type.String()),
});

export const CloudRunServiceDescriptorSchema = Type.Object({
  uri: Type.Optional(Type.String()),
  latestReadyRevisionName: Type.Optional(Type.String()),
  latestCreatedRevisionName: Type.Optional(Type.String()),
  conditions: Type.Optional(Type.Array(CloudRunConditionSchema)),
  status: Type.Optional(
    Type.Object({
      url: Type.Optional(Type.String()),
      address: Type.Optional(
        Type.Object({
          url: Type.Optional(Type.String()),
        })
      ),
      latestReadyRevisionName: Type.Optional(Type.String()),
      latestCreatedRevisionName: Type.Optional(Type.String()),
      conditions: Type.Optional(Type.Array(CloudRunConditionSchema)),
    })
  ),
});

export type CloudRunServiceDescriptor = Static<typeof CloudRunServiceDescriptorSchema>;

export const WorkspaceAddonDeploymentDescriptorSchema = Type.Object({
  name: Type.Optional(Type.String()),
  addOns: Type.Optional(
    Type.Object({
      common: Type.Optional(
        Type.Object({
          homepageTrigger: Type.Optional(
            Type.Object({
              runFunction: Type.Optional(Type.String()),
            })
          ),
        })
      ),
    })
  ),
});

export type WorkspaceAddonDeploymentDescriptor = Static<
  typeof WorkspaceAddonDeploymentDescriptorSchema
>;

export const WorkspaceCardActionNavigationSchema = Type.Object({
  action: Type.Object({
    navigations: Type.Array(Type.Record(Type.String(), Type.Unknown()), { minItems: 1 }),
  }),
});

export const WorkspaceCardRenderActionsSchema = Type.Object({
  renderActions: Type.Record(Type.String(), Type.Unknown()),
});

export const WorkspaceCardResponseSchema = Type.Union([
  WorkspaceCardActionNavigationSchema,
  WorkspaceCardRenderActionsSchema,
]);

export type WorkspaceCardResponse = Static<typeof WorkspaceCardResponseSchema>;

export interface HttpProbeResponse {
  status: number;
  body: string;
}

export interface DeploymentReadinessPort {
  describeCloudRunService(params: {
    serviceName: string;
    region: string;
    projectId: string;
  }): Promise<unknown>;
  describeWorkspaceAddonDeployment(params: {
    repoName: string;
    projectId: string;
  }): Promise<unknown>;
  postWorkspaceHomepage(params: {
    url: string;
    authorizationBearer?: string | undefined;
  }): Promise<HttpProbeResponse>;
  log?: ((message: string) => void) | undefined;
}

export interface VerifyDeploymentReadinessOptions {
  serviceUrl: string;
  serviceName: string;
  region: string;
  projectId: string;
  repoName: string;
  oidcBearerCredential: string;
}

export interface VerifyDeploymentReadinessResult {
  readyRevisionName: string;
  serviceUri: string;
  homepageTriggerUrl: string;
  unauthenticatedStatusCode: number;
  authenticatedStatusCode: number;
}

/**
 * Deep module that verifies post-deployment readiness across all 4 control-plane and HTTP checks:
 * 1. Cloud Run revision readiness (URI match, latestReady === latestCreated, Ready === True)
 * 2. Google Workspace Add-on deployment homepageTrigger alignment
 * 3. Cloud Run IAM privacy check (unauthenticated POST rejected with 401 or 403)
 * 4. Live container & Workspace Addon execution check (OIDC-authenticated POST returns 200 + Card JSON)
 */
export async function verifyDeploymentReadiness(
  options: VerifyDeploymentReadinessOptions,
  port: DeploymentReadinessPort
): Promise<VerifyDeploymentReadinessResult> {
  const log = port.log ?? ((msg: string) => console.log(msg));
  const expectedUrl = options.serviceUrl.trim().replace(/\/+$/, '');
  if (!expectedUrl.startsWith('https://')) {
    throw new Error(
      `serviceUrl must be a valid HTTPS URL starting with "https://", received: "${options.serviceUrl}"`
    );
  }

  // Check 1: Cloud Run Revision Readiness
  log('==> Check 1: Cloud Run Revision Readiness');
  let rawCloudRun: unknown;
  try {
    rawCloudRun = await port.describeCloudRunService({
      serviceName: options.serviceName,
      region: options.region,
      projectId: options.projectId,
    });
  } catch (error) {
    throw new Error(
      `Error: Failed to query Cloud Run service ${options.serviceName} in ${options.region}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }

  if (!Value.Check(CloudRunServiceDescriptorSchema, rawCloudRun)) {
    throw new Error('Cloud Run service descriptor failed schema validation');
  }

  const uri =
    rawCloudRun.uri ?? rawCloudRun.status?.url ?? rawCloudRun.status?.address?.url;
  if (!uri || uri !== expectedUrl) {
    throw new Error(`Cloud Run URI mismatch: expected "${expectedUrl}", got "${uri ?? ''}"`);
  }

  const latestReady =
    rawCloudRun.latestReadyRevisionName ?? rawCloudRun.status?.latestReadyRevisionName;
  const latestCreated =
    rawCloudRun.latestCreatedRevisionName ?? rawCloudRun.status?.latestCreatedRevisionName;
  if (!latestReady || latestReady !== latestCreated) {
    throw new Error(
      `Cloud Run revision mismatch: latestReady="${latestReady ?? ''}", latestCreated="${
        latestCreated ?? ''
      }"`
    );
  }

  const conditions = rawCloudRun.status?.conditions ?? rawCloudRun.conditions ?? [];
  const readyCond = conditions.find((c) => c.type === 'Ready');
  if (!readyCond || readyCond.status !== 'True') {
    throw new Error(
      `Cloud Run Ready condition status is not True: ${JSON.stringify(readyCond)}`
    );
  }

  log(`✓ Cloud Run revision readiness verified: ${latestReady} (Ready=True, URI=${uri})`);

  // Check 2: Workspace Add-on Deployment Trigger Alignment
  log('==> Check 2: Workspace Add-on Deployment Trigger Alignment');
  let rawAddon: unknown;
  try {
    rawAddon = await port.describeWorkspaceAddonDeployment({
      repoName: options.repoName,
      projectId: options.projectId,
    });
  } catch (error) {
    throw new Error(
      `Error: Failed to query Workspace Add-on deployment ${options.repoName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
      { cause: error }
    );
  }

  if (!Value.Check(WorkspaceAddonDeploymentDescriptorSchema, rawAddon)) {
    throw new Error('Workspace Add-on deployment descriptor failed schema validation');
  }

  const expectedTrigger = `${expectedUrl}/workspace/homepage`;
  const runFunction = rawAddon.addOns?.common?.homepageTrigger?.runFunction;
  if (runFunction !== expectedTrigger) {
    throw new Error(
      `Workspace Add-on trigger mismatch: expected "${expectedTrigger}", got "${
        runFunction ?? ''
      }"`
    );
  }

  log(`✓ Workspace Add-on homepageTrigger verified: ${runFunction}`);

  // Check 3: Cloud Run IAM Privacy Check (Unauthenticated Probe)
  log('==> Check 3: Cloud Run IAM Privacy Check (Unauthenticated Probe)');
  const unauthResp = await port.postWorkspaceHomepage({
    url: expectedTrigger,
  });

  if (unauthResp.status !== 401 && unauthResp.status !== 403) {
    throw new Error(
      `Error: Cloud Run IAM privacy check failed: unauthenticated POST to ${expectedTrigger} returned HTTP ${unauthResp.status} (expected 401 or 403)`
    );
  }

  log(`✓ IAM privacy verified: unauthenticated request rejected with HTTP ${unauthResp.status}`);

  // Check 4: Live Container & Workspace Addon Execution (Authenticated OIDC Probe)
  log('==> Check 4: Live Container & Workspace Addon Execution (Authenticated OIDC Probe)');
  const trimmedCredential = options.oidcBearerCredential.trim();
  if (!trimmedCredential) {
    throw new Error(`Error: Failed to obtain OIDC identity token for audience: ${expectedUrl}`);
  }

  const authResp = await port.postWorkspaceHomepage({
    url: expectedTrigger,
    authorizationBearer: trimmedCredential,
  });

  if (authResp.status !== 200) {
    throw new Error(
      `Error: Authenticated probe failed with HTTP ${authResp.status} (expected 200)\nResponse body: ${authResp.body}`
    );
  }

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(authResp.body);
  } catch (error) {
    throw new Error(`Response is not valid JSON: ${authResp.body}`, { cause: error });
  }

  if (!Value.Check(WorkspaceCardResponseSchema, parsedBody)) {
    throw new Error(
      `Response is not a valid Google Workspace Card response: ${JSON.stringify(parsedBody)}`
    );
  }

  log('✓ Authenticated Workspace Add-on execution verified (valid Card JSON received)');

  return {
    readyRevisionName: latestReady,
    serviceUri: uri,
    homepageTriggerUrl: runFunction,
    unauthenticatedStatusCode: unauthResp.status,
    authenticatedStatusCode: authResp.status,
  };
}

/**
 * Production adapter for DeploymentReadinessPort using gcloud CLI and native fetch.
 */
export function createCliAndHttpReadinessAdapter(
  log?: (message: string) => void
): DeploymentReadinessPort {
  return {
    log,
    async describeCloudRunService({ serviceName, region, projectId }) {
      const stdout = execFileSync(
        'gcloud',
        [
          'run',
          'services',
          'describe',
          serviceName,
          `--region=${region}`,
          `--project=${projectId}`,
          '--format=json',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      return JSON.parse(stdout);
    },
    async describeWorkspaceAddonDeployment({ repoName, projectId }) {
      const stdout = execFileSync(
        'gcloud',
        [
          'workspace-add-ons',
          'deployments',
          'describe',
          repoName,
          `--project=${projectId}`,
          '--format=json',
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
      );
      return JSON.parse(stdout);
    },
    async postWorkspaceHomepage({ url, authorizationBearer }) {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (authorizationBearer) {
        headers['Authorization'] = `Bearer ${authorizationBearer}`;
      }
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: '{}',
      });
      const body = await response.text();
      return {
        status: response.status,
        body,
      };
    },
  };
}
