import * as fs from 'node:fs';
import * as path from 'node:path';
import { describe, it, expect } from 'vitest';

export interface DocumentationContract {
  /** Path relative to the repository root (e.g., 'README.md'). */
  readonly relativePath: string;
  /** Headings or section markers that must appear in strict ascending character order. */
  readonly orderedSections: readonly string[];
  /** Canonical glossary, architectural, or configuration terms that must appear in the file. */
  readonly requiredTerms: readonly string[];
  /** Additional file-specific forbidden substrings beyond the global retired terminology list. */
  readonly forbiddenTerms?: readonly string[];
  /** Relative link targets that must be explicitly linked from the document. */
  readonly requiredLinks?: readonly string[];
}

export interface DocumentationValidationResult {
  readonly exists: boolean;
  readonly nonEmpty: boolean;
  readonly missingSections: string[];
  readonly outOfOrderSections: string[];
  readonly missingTerms: string[];
  readonly foundForbiddenTerms: string[];
  readonly brokenLinks: Array<{ rawTarget: string; resolvedPath: string }>;
  readonly missingRequiredLinks: string[];
  readonly invalidNpmScripts: string[];
  readonly extractedLinks: string[];
  readonly extractedNpmScripts: string[];
}

export const RETIRED_GLOSSARY_AND_CONFIG_TERMS: readonly string[] = [
  'RecordType',
  'recordSchema',
  'recordField',
  '!TestMove',
  'appTitle',
  'actionButtonText',
  'defaultEventName',
];

export const V0_5_0_NPM_SCRIPT_ALLOWLIST: readonly string[] = [
  'generate:manifest',
  'generate:branding',
];

export const CANONICAL_GLOSSARY_TERMS: readonly string[] = [
  'DocumentType',
  'DocumentSchema',
  'DocumentUiSchema',
  'DocumentSpaceType',
  'DocumentSpace',
  'SpaceUiSchema',
  'Document',
  'DocumentField',
  'CalculatedField',
  'LookupField',
  'Identity',
  'StorageContext',
  'SourceFile',
  'Activity',
  'ActivityOutput',
  'FileLocator',
  'Manifest',
  'AppConfiguration',
  'Workspace Addon',
  'UiProcessManager',
  'SchemaDrivenUi',
  'UiBlock',
  'UiView',
  'UiViewSchema',
];

export const EXPECTED_ADR_FILES: readonly string[] = [
  'docs/adr/0001-hybrid-hexagonal-architecture.md',
  'docs/adr/0002-explicit-app-manifest-for-configuration-discovery.md',
  'docs/adr/0003-handlebars-for-injection-not-logic.md',
  'docs/adr/0004-unified-activity-output.md',
  'docs/adr/0005-per-request-dependency-injection-for-context.md',
  'docs/adr/0006-drive-file-resolution-strategy.md',
  'docs/adr/0007-drive-content-memory-models.md',
  'docs/adr/0008-hybrid-pdf-processor-stack.md',
  'docs/adr/0009-split-manifest-configuration-and-feature-schema-hydration.md',
  'docs/adr/0010-schema-driven-ui.md',
  'docs/adr/0011-fast-track-and-guarded-reads.md',
  'docs/adr/0012-feature-based-composition-roots.md',
  'docs/adr/0013-cqrs-ui-orchestration.md',
  'docs/adr/0014-ui-process-manager-space-resolution.md',
  'docs/adr/0015-multi-environment-gcp-isolation-and-least-privilege-iam.md',
];

/**
 * Extracts all Markdown link and image targets (`[label](target)` and `![alt](target)`) from Markdown content.
 */
export function extractMarkdownTargets(markdown: string): string[] {
  const targets: string[] = [];
  const markdownLinkRegex = /!?\[[^\]]*\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = markdownLinkRegex.exec(markdown)) !== null) {
    const rawInsideParens = match[1].trim();
    // Handle optional Markdown link titles: [label](path "title")
    const target = rawInsideParens.split(/\s+/)[0].replace(/^<|>$/g, '');
    if (target.length > 0) {
      targets.push(target);
    }
  }
  return targets;
}

/**
 * Extracts all `npm run <script>` script names from Markdown content.
 */
export function extractNpmRunScripts(markdown: string): string[] {
  const scripts: string[] = [];
  const npmRunRegex = /\bnpm\s+run\s+([a-zA-Z0-9:_-]+)/g;
  let match: RegExpExecArray | null;
  while ((match = npmRunRegex.exec(markdown)) !== null) {
    scripts.push(match[1]);
  }
  return scripts;
}

/**
 * Validates a single documentation file against its declared contract, disk link targets, and package.json scripts.
 */
export function validateDocumentationContract(
  repoRoot: string,
  contract: DocumentationContract,
  validNpmScripts: ReadonlySet<string>
): DocumentationValidationResult {
  const absoluteFilePath = path.resolve(repoRoot, contract.relativePath);
  if (!fs.existsSync(absoluteFilePath)) {
    return {
      exists: false,
      nonEmpty: false,
      missingSections: [...contract.orderedSections],
      outOfOrderSections: [],
      missingTerms: [...contract.requiredTerms],
      foundForbiddenTerms: [],
      brokenLinks: [],
      missingRequiredLinks: [...(contract.requiredLinks ?? [])],
      invalidNpmScripts: [],
      extractedLinks: [],
      extractedNpmScripts: [],
    };
  }

  const content = fs.readFileSync(absoluteFilePath, 'utf8');
  const nonEmpty = content.trim().length > 0;

  // 1. Section presence & ordering
  const missingSections: string[] = [];
  const outOfOrderSections: string[] = [];
  let lastSectionIndex = -1;

  for (const section of contract.orderedSections) {
    const idx = content.indexOf(section);
    if (idx === -1) {
      missingSections.push(section);
    } else {
      if (idx <= lastSectionIndex) {
        outOfOrderSections.push(section);
      }
      lastSectionIndex = Math.max(lastSectionIndex, idx);
    }
  }

  // 2. Required terms
  const missingTerms = contract.requiredTerms.filter((term) => !content.includes(term));

  // 3. Forbidden / retired terminology
  const allForbiddenTerms = [
    ...RETIRED_GLOSSARY_AND_CONFIG_TERMS,
    ...(contract.forbiddenTerms ?? []),
  ];
  const foundForbiddenTerms = allForbiddenTerms.filter((term) => content.includes(term));

  // 4. Relative Markdown link resolution on disk
  const extractedLinks = extractMarkdownTargets(content);
  const brokenLinks: Array<{ rawTarget: string; resolvedPath: string }> = [];
  const normalizedRelativeTargets = new Set<string>();
  const docDir = path.dirname(absoluteFilePath);

  for (const rawTarget of extractedLinks) {
    if (/^https?:\/\//i.test(rawTarget) || /^mailto:/i.test(rawTarget)) {
      continue;
    }
    const withoutAnchor = rawTarget.split('#')[0];
    if (withoutAnchor.length === 0) {
      // Pure in-document anchor (e.g., #section)
      continue;
    }
    const normalizedTarget = withoutAnchor.replace(/^\.\//, '');
    normalizedRelativeTargets.add(normalizedTarget);

    const resolvedPath = path.resolve(docDir, withoutAnchor);
    if (!fs.existsSync(resolvedPath)) {
      brokenLinks.push({ rawTarget, resolvedPath });
    }
  }

  const missingRequiredLinks = (contract.requiredLinks ?? []).filter(
    (reqLink) => !normalizedRelativeTargets.has(reqLink.replace(/^\.\//, ''))
  );

  // 5. npm run <script> validation
  const extractedNpmScripts = extractNpmRunScripts(content);
  const invalidNpmScripts = extractedNpmScripts.filter(
    (script) => !validNpmScripts.has(script) && !V0_5_0_NPM_SCRIPT_ALLOWLIST.includes(script)
  );

  return {
    exists: true,
    nonEmpty,
    missingSections,
    outOfOrderSections,
    missingTerms,
    foundForbiddenTerms,
    brokenLinks,
    missingRequiredLinks,
    invalidNpmScripts,
    extractedLinks,
    extractedNpmScripts,
  };
}

export const DOCUMENTATION_CONTRACTS: readonly DocumentationContract[] = [
  {
    relativePath: 'README.md',
    orderedSections: [
      '# INC-IO Docs',
      '## User Guide — Filing Documents in Google Drive & Gmail',
      '## System Overview & Domain Glossary',
      '## Architecture & Repository Structure',
      '## Configuration & Schema Overview',
      '## Getting Started & Local Development',
      '## Deployment & Release Summary',
      '## License',
    ],
    requiredTerms: [
      ...CANONICAL_GLOSSARY_TERMS,
      // Feature slices
      'document',
      'document-space',
      'ui-process-manager',
      'schema-driven-ui',
      // Key user-guide & configuration terms
      'communication-project',
      'communication-proposal',
      '1 Admin/Communication',
      'Communications',
      'INC Marketing',
      'Opportunities',
      'allowUserInput',
      'onItemsSelectedTrigger',
      'contextualTriggers',
      'GENERATE_EMAIL_PDF',
      'MOVE_FILE',
      'ExecutionContext',
      'UiProcessResultSchema',
      // Environment variables from .env.example
      'APP_MANIFEST_PATH',
      'PORT',
      'HOST',
      'GOOGLE_CLIENT_ID',
      'GOOGLE_CLIENT_SECRET',
      'GOOGLE_REFRESH_TOKEN',
      'TEST_DRIVE_FILE_ID',
      'SKIP_JWT_VERIFICATION',
      // Deployment & release comparison terms
      'inc-io-docs-dev',
      'inc-io-docs-prod',
      'INC-IO Docs (Dev)',
      'INC-IO Docs',
      'icon-dev-48x48.png',
      'icon-48x48.png',
      'logo-one-line-220x30.png',
      'PRIVATE_DOMAIN_ONLY',
      'v0.5.0',
    ],
    forbiddenTerms: ['ngrok', 'tunnel.ps1', 'APP_SUMMARY'],
    requiredLinks: [
      'assets/branding/logo-one-line-220x30.png',
      'assets/branding/icon-48x48.png',
      'assets/branding/icon-dev-48x48.png',
      'CONTEXT.md',
      'CODING_STANDARDS.md',
      'assets/manifest.json',
      'assets/document-types/communication-project.json',
      'assets/document-types/communication-proposal.json',
      'docs/configuration-and-schemas.md',
      'docs/deployment-and-release.md',
      '.env.example',
      'LICENSE',
      ...EXPECTED_ADR_FILES,
    ],
  },
  {
    relativePath: 'docs/configuration-and-schemas.md',
    orderedSections: [
      '# Configuration & Schema Guide',
      '## 1. Runtime `Manifest` & `AppConfiguration`',
      '## 2. Anatomy of a `DocumentType` Schema',
      '## 3. Supported `Activity` Types & Data Flow Reference',
    ],
    requiredTerms: [
      'Manifest',
      'AppConfiguration',
      'documentTypes',
      'WorkspaceConfigurationSchema',
      'AppManifestProvider',
      'defaultDocumentSpaceType: "projects"',
      'defaultDocumentType: "communication-project"',
      'defaultFolderName: "Unfiled"',
      'maxRetries',
      'initialDelayMs',
      'backoffFactor',
      'defaultHeaderRangeName',
      'defaultDataRangeName',
      'DocumentSpaceTypes',
      'DocumentSpaceManifestRegistryAdapter',
      'shared_drives',
      'folders',
      'INC Marketing',
      'Opportunities',
      'communication-project',
      'communication-proposal',
      'allowEmptySourceFiles',
      'documentSchema',
      'DocumentField',
      'LookupField',
      'allowUserInput',
      'dynamicConfig',
      'list_folders',
      'calculatedFields',
      'CalculatedField',
      'commFolderName',
      '{{date}} {{direction.key}} - {{description}}',
      'identity',
      'Identity',
      'idDocument',
      'idGroup',
      'storageContextConfig',
      '1 Admin/Communication',
      'Communications',
      'documentUiSchema',
      'selectionInput',
      'textInput',
      'catchAllWorkflow',
      'FileCommProject',
      'FileCommProposal',
      'documentWorkflowConfig',
      'activitySequence',
      '{{Document.space.abstractStorageId}}',
      '{{StorageContext.basePath}}',
      'MOVE_FILE',
      'CREATE_DOCUMENT',
      'GENERATE_EMAIL_PDF',
      'APPEND_SHEET_ROW',
      'SourceFile',
      'ActivityOutput',
      'documentDataPatch',
      'contextVariables',
      'FileLocator',
    ],
    forbiddenTerms: ['APP_SUMMARY'],
    requiredLinks: [
      '../CONTEXT.md',
      '../assets/manifest.json',
      '../assets/document-types/communication-project.json',
      '../assets/document-types/communication-proposal.json',
      'adr/0002-explicit-app-manifest-for-configuration-discovery.md',
      'adr/0003-handlebars-for-injection-not-logic.md',
      'adr/0004-unified-activity-output.md',
      'adr/0009-split-manifest-configuration-and-feature-schema-hydration.md',
      'adr/0014-ui-process-manager-space-resolution.md',
    ],
  },
  {
    relativePath: 'docs/deployment-and-release.md',
    orderedSections: [
      '# Deployment & Release Architecture Guide',
      '## 1. Multi-Environment GCP Isolation & Least-Privilege IAM (ADR 0015)',
      '## 2. Pulumi Infrastructure as Code (`infra/pulumi/`)',
      '## 3. `Workspace Addon` Deployment Manifest & Branding Pipeline',
      '## 4. Private (Domain-Only) Google Workspace Marketplace Publishing',
      '## 5. CI/CD Quality Gates & `v0.5.0` GitHub Release Pipeline',
    ],
    requiredTerms: [
      'Workspace Addon',
      'inc-io-docs-dev',
      'inc-io-docs-prod',
      'gs://inc-io-docs-dev-pulumi-state',
      'gs://inc-io-docs-prod-pulumi-state',
      'bootstrap.ps1',
      '-Environment dev',
      '-Environment prod',
      'refs/heads/develop',
      'refs/heads/main',
      'ci-deployer',
      'roles/storage.admin',
      'addon-runtime',
      'addon-invoker',
      'gcp-sa-gsuiteaddons',
      'roles/run.invoker',
      'AppInfrastructure',
      'Pulumi.dev.yaml',
      'Pulumi.prod.yaml',
      'gcp:project',
      'gcp:region',
      'serviceName',
      'imageTag',
      'NODE_ENV=production',
      'ServiceIdentity',
      'CloudRunInvokerBinding',
      'deployment.template.json',
      '{{ADDON_NAME}}',
      '{{LOGO_URL}}',
      '{{BASE_URL}}',
      'npm run generate:manifest',
      'npm run generate:branding',
      'icon-48x48.png',
      'icon-dev-48x48.png',
      'screenshot-1280x800.png',
      'marketplace-listing.json',
      'INTERNAL',
      'PRIVATE_DOMAIN_ONLY',
      'github.com',
      'npm run lint',
      'npm run typecheck',
      'npm run test:all',
      'gcloud workspace-add-ons deployments replace',
      'v0.5.0',
    ],
    forbiddenTerms: ['APP_SUMMARY'],
    requiredLinks: [
      '../CONTEXT.md',
      'adr/0005-per-request-dependency-injection-for-context.md',
      'adr/0015-multi-environment-gcp-isolation-and-least-privilege-iam.md',
      '../infra/bootstrap.ps1',
      '../infra/pulumi/app-infrastructure.ts',
      '../infra/pulumi/index.ts',
      '../infra/pulumi/Pulumi.dev.yaml',
      '../infra/pulumi/Pulumi.prod.yaml',
      '../infra/deployment.template.json',
      '../infra/generate-deployment-manifest.ts',
      '../infra/deployment-manifest.ts',
      '../infra/generate-branding.ts',
      '../assets/branding/marketplace-listing.json',
      '../assets/branding/icon-48x48.png',
      '../assets/branding/icon-dev-48x48.png',
      '../assets/branding/screenshot-1280x800.png',
      '../.github/workflows/deploy.yml',
      '../package.json',
    ],
  },
];

describe('Repository Documentation Contract Validation', () => {
  const repoRoot = path.resolve(__dirname, '../..');
  const packageJsonPath = path.join(repoRoot, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as {
    scripts?: Record<string, string>;
  };
  const validNpmScripts = new Set<string>(Object.keys(packageJson.scripts ?? {}));

  describe('APP_SUMMARY.md Retirement', () => {
    it('deletes standalone APP_SUMMARY.md from the repository root', () => {
      const appSummaryPath = path.join(repoRoot, 'APP_SUMMARY.md');
      expect(fs.existsSync(appSummaryPath)).toBe(false);
    });

    it('contains zero references to APP_SUMMARY in active documentation files', () => {
      for (const contract of DOCUMENTATION_CONTRACTS) {
        const filePath = path.join(repoRoot, contract.relativePath);
        const content = fs.readFileSync(filePath, 'utf8');
        expect(content).not.toContain('APP_SUMMARY');
      }
    });
  });

  describe('Registered Documentation Contracts', () => {
    for (const contract of DOCUMENTATION_CONTRACTS) {
      describe(contract.relativePath, () => {
        const result = validateDocumentationContract(repoRoot, contract, validNpmScripts);

        it('exists on disk and is non-empty', () => {
          expect(result.exists).toBe(true);
          expect(result.nonEmpty).toBe(true);
        });

        it('presents all required sections in strict user-first order', () => {
          expect(result.missingSections).toEqual([]);
          expect(result.outOfOrderSections).toEqual([]);
        });

        it('documents all required canonical glossary, architectural, env, and deployment terms', () => {
          expect(result.missingTerms).toEqual([]);
        });

        it('contains zero retired glossary/config terms or forbidden tunneling references', () => {
          expect(result.foundForbiddenTerms).toEqual([]);
        });

        it('resolves every non-external Markdown link and image target to an existing path on disk', () => {
          expect(result.brokenLinks).toEqual([]);
          expect(result.missingRequiredLinks).toEqual([]);
        });

        it('references only valid npm run scripts defined in package.json or the v0.5.0 allowlist', () => {
          expect(result.extractedNpmScripts.length).toBeGreaterThan(0);
          expect(result.invalidNpmScripts).toEqual([]);
        });
      });
    }
  });

  describe('Root README.md Specific Cross-Checks against Repository Sources of Truth', () => {
    const readmeContent = fs.readFileSync(path.join(repoRoot, 'README.md'), 'utf8');

    it('documents every environment variable key present in .env.example', () => {
      const envExampleContent = fs.readFileSync(path.join(repoRoot, '.env.example'), 'utf8');
      const envKeys = envExampleContent
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0 && !line.startsWith('#'))
        .map((line) => line.split('=')[0].trim())
        .filter((key) => key.length > 0);

      expect(envKeys.length).toBe(8);
      for (const key of envKeys) {
        expect(readmeContent).toContain(key);
      }
    });

    it('links to every ADR file currently in docs/adr/', () => {
      const adrDir = path.join(repoRoot, 'docs/adr');
      const adrFilesOnDisk = fs
        .readdirSync(adrDir)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .map((f) => `docs/adr/${f}`);

      expect(adrFilesOnDisk).toEqual([...EXPECTED_ADR_FILES]);
      for (const adrRelativePath of adrFilesOnDisk) {
        expect(readmeContent).toContain(`(${adrRelativePath})`);
      }
    });

    it('documents all 10 required development and quality-gate commands', () => {
      const expectedCommands = [
        'npm run dev',
        'npm run build',
        'npm start',
        'npm test',
        'npm run test:all',
        'npm run test:infra',
        'npm run typecheck',
        'npm run lint',
        'npm run generate:manifest',
        'npm run generate:branding',
      ];
      for (const cmd of expectedCommands) {
        expect(readmeContent).toContain(cmd);
      }
    });
  });

  describe('Validator Seam Unit Behavior', () => {
    it('detects out-of-order sections, retired terms, broken links, and invalid npm scripts', () => {
      const tmpDir = path.join(repoRoot, 'scratch/doc-validator-test');
      fs.mkdirSync(tmpDir, { recursive: true });
      const sampleFile = path.join(tmpDir, 'synthetic.md');

      try {
        fs.writeFileSync(
          sampleFile,
          [
            '## Second Section',
            '## First Section',
            'Uses retired RecordType and ngrok tunnel.ps1.',
            'Broken link to [missing](./does-not-exist.md) and valid [readme](../../README.md#license).',
            'External link [Google](https://google.com) and mail [support](mailto:test@example.com).',
            'Run `npm run nonexistent:script` and `npm run lint`.',
          ].join('\n'),
          'utf8'
        );

        const syntheticContract: DocumentationContract = {
          relativePath: 'scratch/doc-validator-test/synthetic.md',
          orderedSections: ['## First Section', '## Second Section', '## Missing Section'],
          requiredTerms: ['PresentTerm'],
          forbiddenTerms: ['ngrok', 'tunnel.ps1'],
          requiredLinks: ['../../README.md', './missing-required.md'],
        };

        const res = validateDocumentationContract(repoRoot, syntheticContract, validNpmScripts);
        expect(res.exists).toBe(true);
        expect(res.nonEmpty).toBe(true);
        expect(res.missingSections).toEqual(['## Missing Section']);
        expect(res.outOfOrderSections).toEqual(['## Second Section']);
        expect(res.missingTerms).toEqual(['PresentTerm']);
        expect(res.foundForbiddenTerms).toEqual(['RecordType', 'ngrok', 'tunnel.ps1']);
        expect(res.brokenLinks).toHaveLength(1);
        expect(res.brokenLinks[0].rawTarget).toBe('./does-not-exist.md');
        expect(res.missingRequiredLinks).toEqual(['./missing-required.md']);
        expect(res.invalidNpmScripts).toEqual(['nonexistent:script']);
      } finally {
        if (fs.existsSync(sampleFile)) {
          fs.unlinkSync(sampleFile);
        }
        if (fs.existsSync(tmpDir)) {
          fs.rmdirSync(tmpDir);
        }
      }
    });
  });
});
