import { parseArgs } from 'node:util';
import {
  createCliAndHttpReadinessAdapter,
  verifyDeploymentReadiness,
} from './deployment-readiness';

function printUsageAndExit(errorMessage?: string): never {
  if (errorMessage) {
    console.error(`Error: ${errorMessage}\n`);
  }
  console.error(`Usage: npm run verify:deployment -- [options]

Options:
  --service-url <url>      HTTPS base URL where the Cloud Run service is deployed (or env SERVICE_URL)
  --service-name <name>    Cloud Run service name (or env SERVICE_NAME)
  --region <region>        GCP region (or env REGION)
  --project-id <id>        GCP project ID (or env PROJECT_ID)
  --repo-name <name>       Workspace Add-on deployment / repository name (or env REPO_NAME)
`);
  process.exit(1);
}

async function main(): Promise<void> {
  let values: Record<string, string | boolean | undefined>;
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        'service-url': { type: 'string' },
        'service-name': { type: 'string' },
        region: { type: 'string' },
        'project-id': { type: 'string' },
        'repo-name': { type: 'string' },
      },
      allowPositionals: false,
    });
    values = parsed.values;
  } catch (error) {
    printUsageAndExit(error instanceof Error ? error.message : String(error));
  }

  const serviceUrl =
    (values['service-url'] as string | undefined) ?? process.env['SERVICE_URL'];
  if (!serviceUrl) {
    printUsageAndExit('Missing required "--service-url" (or SERVICE_URL env var)');
  }

  const serviceName =
    (values['service-name'] as string | undefined) ?? process.env['SERVICE_NAME'];
  if (!serviceName) {
    printUsageAndExit('Missing required "--service-name" (or SERVICE_NAME env var)');
  }

  const region = (values['region'] as string | undefined) ?? process.env['REGION'];
  if (!region) {
    printUsageAndExit('Missing required "--region" (or REGION env var)');
  }

  const projectId =
    (values['project-id'] as string | undefined) ?? process.env['PROJECT_ID'];
  if (!projectId) {
    printUsageAndExit('Missing required "--project-id" (or PROJECT_ID env var)');
  }

  const repoName =
    (values['repo-name'] as string | undefined) ?? process.env['REPO_NAME'];
  if (!repoName) {
    printUsageAndExit('Missing required "--repo-name" (or REPO_NAME env var)');
  }

  const oidcBearerCredential = process.env['OIDC_ID_TOKEN']?.trim() ?? '';
  const adapter = createCliAndHttpReadinessAdapter();

  try {
    await verifyDeploymentReadiness(
      {
        serviceUrl,
        serviceName,
        region,
        projectId,
        repoName,
        oidcBearerCredential,
      },
      adapter
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

void main();
