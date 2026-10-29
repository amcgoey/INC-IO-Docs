import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseArgs } from 'node:util';
import { generateDeploymentManifest } from './deployment-manifest';

function printUsageAndExit(errorMessage?: string): never {
  if (errorMessage) {
    console.error(`Error: ${errorMessage}\n`);
  }
  console.error(`Usage: npm run generate:manifest -- --service-url <url> --environment <dev|prod> [options]

Options:
  --service-url <url>      HTTPS base URL where the service is deployed (required)
  --environment <env>      Target environment: "dev" or "prod" (required)
  --template <path>        Path to deployment manifest template (default: infra/deployment.template.json)
  --output <path>          Path to write generated deployment manifest (default: infra/deployment.json)
  --addon-name <name>      Optional custom add-on display name override
  --logo-url <url>         Optional custom logo URL override
  --logo-version <version> Optional logo version cache buster
`);
  process.exit(1);
}

function main(): void {
  let values: Record<string, string | boolean | undefined>;
  try {
    const parsed = parseArgs({
      args: process.argv.slice(2),
      options: {
        'service-url': { type: 'string' },
        environment: { type: 'string' },
        template: { type: 'string' },
        output: { type: 'string' },
        'addon-name': { type: 'string' },
        'logo-url': { type: 'string' },
        'logo-version': { type: 'string' },
      },
      allowPositionals: false,
    });
    values = parsed.values;
  } catch (error) {
    printUsageAndExit(error instanceof Error ? error.message : String(error));
  }

  const serviceUrl = values['service-url'] as string | undefined;
  if (!serviceUrl) {
    printUsageAndExit('Missing required option "--service-url"');
  }

  const environment = values['environment'] as string | undefined;
  if (!environment || (environment !== 'dev' && environment !== 'prod')) {
    printUsageAndExit('Option "--environment" must be either "dev" or "prod"');
  }

  const templatePath = (values['template'] as string | undefined) ?? path.resolve(__dirname, 'deployment.template.json');
  const outputPath = (values['output'] as string | undefined) ?? path.resolve(__dirname, 'deployment.json');
  const addOnName = values['addon-name'] as string | undefined;
  const logoUrl = values['logo-url'] as string | undefined;
  const logoVersion = values['logo-version'] as string | undefined;

  if (!fs.existsSync(templatePath)) {
    console.error(`Error: Deployment manifest template not found at "${templatePath}"`);
    process.exit(1);
  }

  const templateContent = fs.readFileSync(templatePath, 'utf8');

  let result;
  try {
    result = generateDeploymentManifest({
      templateContent,
      serviceUrl,
      environment,
      ...(addOnName ? { addOnName } : {}),
      ...(logoUrl ? { logoUrl } : {}),
      ...(logoVersion ? { logoVersion } : {}),
    });
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }

  const outputDir = path.dirname(path.resolve(outputPath));
  if (!fs.existsSync(outputDir)) {
    fs.mkdirSync(outputDir, { recursive: true });
  }

  // Writing string with 'utf8' encoding writes UTF-8 without BOM
  fs.writeFileSync(path.resolve(outputPath), result.json, { encoding: 'utf8' });

  console.log(
    `Successfully generated deployment manifest for "${environment}" (${result.manifest.addOns.common.name}) at "${outputPath}".`
  );
}

main();
