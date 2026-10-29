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
  --id-token <token>       OIDC ID token for authorization (or env OIDC_ID_TOKEN)
`);
  process.exit(1);
}

function getRequiredOption(
  values: Record<string, string | boolean | undefined>,
  flag: string,
  envVar: string
): string {
  const value = ((values[flag] as string | undefined) ?? process.env[envVar])?.trim();
  if (!value) {
    printUsageAndExit(`Missing required "--${flag}" (or ${envVar} env var)`);
  }
  return value;
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
        'id-token': { type: 'string' },
      },
      allowPositionals: false,
    });
    values = parsed.values;
  } catch (error) {
    printUsageAndExit(error instanceof Error ? error.message : String(error));
  }

  const serviceUrl = getRequiredOption(values, 'service-url', 'SERVICE_URL');
  const serviceName = getRequiredOption(values, 'service-name', 'SERVICE_NAME');
  const region = getRequiredOption(values, 'region', 'REGION');
  const projectId = getRequiredOption(values, 'project-id', 'PROJECT_ID');
  const repoName = getRequiredOption(values, 'repo-name', 'REPO_NAME');
  const oidcBearerCredential = getRequiredOption(values, 'id-token', 'OIDC_ID_TOKEN');

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
