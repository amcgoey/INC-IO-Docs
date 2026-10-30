# Deployment & Release Architecture Guide

Operational and architectural reference for provisioning isolated Google Cloud Platform (`GCP`) environments, converging Pulumi Infrastructure as Code, generating deterministic [`Workspace Addon`](../CONTEXT.md) manifests and branding assets, publishing the Private (`PRIVATE_DOMAIN_ONLY`) Google Workspace Marketplace listing, and operating the `v0.5.0` CI/CD release pipeline.

> **Domain Glossary (`CONTEXT.md`)**: Use canonical vocabulary from [`CONTEXT.md`](../CONTEXT.md) when referring to the `Workspace Addon`, runtime `Manifest`, or `AppConfiguration`.

---

## 1. Multi-Environment GCP Isolation & Least-Privilege IAM (ADR 0015)

`INC-IO Docs` enforces strict project, state, and identity isolation between development (`dev`) and production (`prod`) environments per [ADR-0015](adr/0015-multi-environment-gcp-isolation-and-least-privilege-iam.md), provisioned via [`infra/bootstrap.ps1`](../infra/bootstrap.ps1).

### Environment Topology & Parameterized Bootstrap (`infra/bootstrap.ps1`)

| Dimension | Development (`dev`) | Production (`prod`) |
| :--- | :--- | :--- |
| **Git Branch** | `develop` (`refs/heads/develop`) | `main` (`refs/heads/main`) |
| **GitHub Environment** | `dev` | `prod` |
| **GCP Project ID** | `inc-io-docs-dev` | `inc-io-docs-prod` |
| **GCP Region** | `us-east4` | `us-east4` |
| **Pulumi State Bucket** | `gs://inc-io-docs-dev-pulumi-state` | `gs://inc-io-docs-prod-pulumi-state` |
| **Pulumi Stack** | `dev` ([`infra/pulumi/Pulumi.dev.yaml`](../infra/pulumi/Pulumi.dev.yaml)) | `prod` ([`infra/pulumi/Pulumi.prod.yaml`](../infra/pulumi/Pulumi.prod.yaml)) |
| **Cloud Run Service** | `inc-io-docs-dev` | `inc-io-docs-prod` |
| **CI Deployer Identity** | `ci-deployer@inc-io-docs-dev.iam.gserviceaccount.com` | `ci-deployer@inc-io-docs-prod.iam.gserviceaccount.com` |
| **Runtime Identity** | `addon-runtime@inc-io-docs-dev.iam.gserviceaccount.com` | `addon-runtime@inc-io-docs-prod.iam.gserviceaccount.com` |
| **Invoker Identity** | `addon-invoker@inc-io-docs-dev.iam.gserviceaccount.com` | `addon-invoker@inc-io-docs-prod.iam.gserviceaccount.com` |

Run [`infra/bootstrap.ps1`](../infra/bootstrap.ps1) with `-Environment dev` or `-Environment prod` to idempotently bootstrap or update a target environment:

```powershell
# Bootstrap or converge the development GCP project and 'dev' GitHub Environment
./infra/bootstrap.ps1 -Environment dev

# Bootstrap or converge the production GCP project and 'prod' GitHub Environment
./infra/bootstrap.ps1 -Environment prod
```

`infra/bootstrap.ps1` performs the following idempotent sequence:
1. **Foundational API Enablement**: Enables `iamcredentials.googleapis.com`, `cloudresourcemanager.googleapis.com`, `iam.googleapis.com`, `serviceusage.googleapis.com`, and `storage.googleapis.com`.
2. **Versioned Pulumi State Bucket**: Creates `gs://<project>-pulumi-state` (`gs://inc-io-docs-dev-pulumi-state` or `gs://inc-io-docs-prod-pulumi-state`) in `us-east4` and enables GCS object versioning.
3. **Least-Privilege `ci-deployer` Provisioning**: Creates `ci-deployer`, strips any legacy `roles/editor` or `roles/viewer` bindings, and binds bucket-scoped and project-scoped roles.
4. **Workload Identity Federation (WIF)**: Creates or updates (`update-oidc`) the `github-actions-pool` pool and `github-provider` OIDC provider with a 3-way attribute condition.
5. **GitHub Environment Provisioning (`gh`)**: Configures the `dev` or `prod` GitHub Environment with custom deployment branch policies (`develop` for `dev`, `main` for `prod`), sets environment variables (`PROJECT_ID`, `REGION`, `REPO_NAME`, `SERVICE_NAME`, `PULUMI_STACK`, `PULUMI_STATE_BUCKET`), and writes environment secrets (`WIF_PROVIDER`, `GCP_SERVICE_ACCOUNT`, `PULUMI_CONFIG_PASSPHRASE`).

### Hardened 3-Way OIDC Workload Identity Federation

Each project's WIF OIDC provider (`github-provider` inside `github-actions-pool`) maps GitHub Actions OIDC claims (`google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.environment=assertion.environment`) and enforces a 3-way CEL attribute condition binding **repository**, **GitHub Environment**, and **branch ref**:

```cel
has(assertion.environment) && assertion.environment == '<Environment>' && assertion.repository == 'amcgoey/INC-IO-Docs' && assertion.ref == 'refs/heads/<Branch>'
```

- **`inc-io-docs-dev`**: Requires `assertion.environment == 'dev'` and `assertion.ref == 'refs/heads/develop'`.
- **`inc-io-docs-prod`**: Requires `assertion.environment == 'prod'` and `assertion.ref == 'refs/heads/main'`.

### Three-Identity Service Account Separation

| Identity | Scope & Role Bindings | Architectural Purpose |
| :--- | :--- | :--- |
| **`ci-deployer`** (`ci-deployer@<project>.iam.gserviceaccount.com`) | **Bucket-scoped** `roles/storage.admin` strictly on `gs://<project>-pulumi-state`, plus **7 project-level roles**: `roles/serviceusage.serviceUsageAdmin`, `roles/browser`, `roles/iam.serviceAccountAdmin`, `roles/iam.serviceAccountUser`, `roles/run.admin`, `roles/artifactregistry.admin`, `roles/gsuiteaddons.developer`. | Impersonated by GitHub Actions via WIF to read/write Pulumi state, push images to Artifact Registry, deploy Cloud Run revisions, and update the `Workspace Addon` deployment without `roles/editor`. |
| **`addon-runtime`** (`addon-runtime@<project>.iam.gserviceaccount.com`) | **Zero GCP project IAM roles.** Attached to the Cloud Run v2 revision via `template.serviceAccount`. | Executes the `Workspace Addon` HTTP server. Stores no user data in GCP and invokes Google Drive, Gmail, and Sheets APIs exclusively with the caller's delegated OAuth token (`authorizationEventObject.userOAuthToken`, [ADR-0005](adr/0005-per-request-dependency-injection-for-context.md)). |
| **`addon-invoker` & `gcp-sa-gsuiteaddons`** (`addon-invoker@<project>.iam.gserviceaccount.com` & `service-<projectNumber>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`) | **Service-scoped** `roles/run.invoker` on the Cloud Run v2 service. | Restricts inbound HTTP invocation of the private Cloud Run service exclusively to the Google Workspace Add-ons execution infrastructure and the dedicated invoker account. |

---

## 2. Pulumi Infrastructure as Code (`infra/pulumi/`)

All project runtime infrastructure is managed declaratively by the shared `AppInfrastructure` (`custom:app:AppInfrastructure`) construct in [`infra/pulumi/app-infrastructure.ts`](../infra/pulumi/app-infrastructure.ts) and instantiated by [`infra/pulumi/index.ts`](../infra/pulumi/index.ts).

### Stack Configuration (`Pulumi.dev.yaml` & `Pulumi.prod.yaml`)

Both [`infra/pulumi/Pulumi.dev.yaml`](../infra/pulumi/Pulumi.dev.yaml) and [`infra/pulumi/Pulumi.prod.yaml`](../infra/pulumi/Pulumi.prod.yaml) share the same `AppInfrastructure` construct and commit a synchronized public `encryptionsalt` paired with each GitHub Environment's `PULUMI_CONFIG_PASSPHRASE` secret:

| Config Key | `Pulumi.dev.yaml` (`dev`) | `Pulumi.prod.yaml` (`prod`) | Description |
| :--- | :--- | :--- | :--- |
| **`gcp:project`** | `inc-io-docs-dev` | `inc-io-docs-prod` | Target GCP project ID (`gcpConfig.require("project")`). |
| **`gcp:region`** | `us-east4` | `us-east4` | Target GCP region for Artifact Registry and Cloud Run. |
| **`inc-io-docs-infra:repositoryName`** | `inc-io-docs` | `inc-io-docs` | Artifact Registry Docker repository ID (`repositoryName`). |
| **`inc-io-docs-infra:serviceName`** | `inc-io-docs-dev` | `inc-io-docs-prod` | Cloud Run v2 service name (`serviceName`). |
| **`inc-io-docs-infra:invokerName`** | `addon-invoker` | `addon-invoker` | Dedicated Cloud Run invoker service account ID (`invokerName`). |
| **`inc-io-docs-infra:image`** *(CI override)* | `<region>-docker.pkg.dev/...:<imageTag>` | `<region>-docker.pkg.dev/...:<imageTag>` | Container image tag (`image` / `imageTag`) injected via Pulumi `config-map` during CI deployment. |

### Provisioned Resources & Stack Outputs

1. **Managed Project APIs (`gcp.projects.Service`)**: Enables `artifactregistry.googleapis.com`, `run.googleapis.com`, `compute.googleapis.com`, `drive.googleapis.com`, `appsmarket.googleapis.com`, `gsuiteaddons.googleapis.com`, and `gmail.googleapis.com` with `disableOnDestroy: false`.
2. **Artifact Registry Repository (`gcp.artifactregistry.Repository`)**: Provisions the `DOCKER` repository `inc-io-docs` in `us-east4` and exports `repositoryUrl` (`us-east4-docker.pkg.dev/<project>/inc-io-docs`).
3. **Service Accounts (`gcp.serviceaccount.Account`)**: Provisions `addon-invoker` (exporting `invokerServiceAccountEmail`) and the zero-privilege `addon-runtime` runtime identity.
4. **Cloud Run v2 Service (`gcp.cloudrunv2.Service`)**: Deploys `inc-io-docs-dev` or `inc-io-docs-prod` bound to `template.serviceAccount = runtimeServiceAccount.email` (`addon-runtime`), listening on container port `8080` with `2` vCPU / `4Gi` memory limits and environment variables `NODE_ENV=production`, `NODE_OPTIONS=--max-old-space-size=3584`, and `SKIP_SPACE_VALIDATION=true`. Exports the HTTPS endpoint as `serviceUrl`.
5. **`ServiceIdentity` & Cloud Run Invoker Bindings (`CloudRunInvokerBinding`)**: Provisions `gcp.projects.ServiceIdentity` for `gsuiteaddons.googleapis.com`, resolves the project number dynamically via `gcp.organizations.getProjectOutput`, and binds `roles/run.invoker` (`gcp.cloudrunv2.ServiceIamMember`) to both `addon-invoker` and `service-<projectNumber>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`.

Run the Pulumi infrastructure unit tests and TypeScript typechecks locally via:

```bash
npm run typecheck:infra
npm run test:infra
```

---

## 3. `Workspace Addon` Deployment Manifest & Branding Pipeline

### Deployment Manifest Generation (`npm run generate:manifest`)

Rather than mutating a tracked deployment file in place, the repository tracks [`infra/deployment.template.json`](../infra/deployment.template.json) and gitignores the rendered `infra/deployment.json` output.

`infra/deployment.template.json` declares the 5 required Google OAuth scopes (`drive`, `drive.addons.metadata.readonly`, `gmail.addons.execute`, `gmail.readonly`, `userinfo.email`) and three template tokens:
- `{{ADDON_NAME}}`: Environment-specific display name (`"INC-IO Docs (Dev)"` for `dev`, `"INC-IO Docs"` for `prod`).
- `{{LOGO_URL}}`: Companion icon HTTPS URL (`DEFAULT_DEV_LOGO_URL` pointing to [`assets/branding/icon-dev-48x48.png`](../assets/branding/icon-dev-48x48.png) on `develop`, or `DEFAULT_PROD_LOGO_URL` pointing to [`assets/branding/icon-48x48.png`](../assets/branding/icon-48x48.png) on `main`).
- `{{BASE_URL}}`: Normalized Cloud Run HTTPS `serviceUrl` injected into:
  - `addOns.common.homepageTrigger.runFunction`: `{{BASE_URL}}/workspace/homepage`
  - `addOns.drive.homepageTrigger.runFunction`: `{{BASE_URL}}/workspace/homepage`
  - `addOns.drive.onItemsSelectedTrigger.runFunction`: `{{BASE_URL}}/workspace/drive-items-selected`
  - `addOns.gmail.contextualTriggers[0].onTriggerFunction`: `{{BASE_URL}}/workspace/gmail-contextual`

Render and validate `infra/deployment.json` using [`infra/generate-deployment-manifest.ts`](../infra/generate-deployment-manifest.ts) (backed by `generateDeploymentManifest()` and `DeploymentManifestSchema` in [`infra/deployment-manifest.ts`](../infra/deployment-manifest.ts)):

```bash
# Render infra/deployment.json for development
npm run generate:manifest -- --service-url https://inc-io-docs-dev-example.a.run.app --environment dev

# Render infra/deployment.json for production
npm run generate:manifest -- --service-url https://inc-io-docs-prod-example.a.run.app --environment prod
```

`generateDeploymentManifest()` enforces `^https://` on `serviceUrl` and `logoUrl`, strips trailing slashes from `serviceUrl`, fails fast if any `{{...}}` token remains unresolved, and validates the rendered JSON against `DeploymentManifestSchema`.

### Deterministic PNG Branding Pipeline (`npm run generate:branding`)

[`infra/generate-branding.ts`](../infra/generate-branding.ts) implements a deterministic, zero-native-dependency PNG codec (RFC 2083 scanline filter `0`, `zlib.deflateSync` level `9`, and IEEE 802.3 CRC32) that downsamples [`assets/branding/icon-128x128.png`](../assets/branding/icon-128x128.png) and composites the Marketplace graphic suite:

```bash
npm run generate:branding
```

| Asset File | Dimensions | Role & Visual Specification |
| :--- | :--- | :--- |
| [`assets/branding/icon-48x48.png`](../assets/branding/icon-48x48.png) | `48x48` | Production (`prod`) companion icon (`companionLogoProd48`): pure black (`#000000`) hex mark with area-averaged alpha on a transparent background. |
| [`assets/branding/icon-dev-48x48.png`](../assets/branding/icon-dev-48x48.png) | `48x48` | Development (`dev`) companion icon (`companionLogoDev48`): medium-gray (`#808080`) hex mark composited onto a solid light-gray (`#EAEAEA`) opaque tile. |
| [`assets/branding/screenshot-1280x800.png`](../assets/branding/screenshot-1280x800.png) | `1280x800` | Google Workspace Marketplace promotional screenshot blitting [`logo-one-line-220x30.png`](../assets/branding/logo-one-line-220x30.png), [`banner-220x140.png`](../assets/branding/banner-220x140.png), and [`icon-48x48.png`](../assets/branding/icon-48x48.png) inside a `Workspace Addon` filing sidebar. |
| [`assets/branding/icon-32x32.png`](../assets/branding/icon-32x32.png) & [`favicon-32x32.png`](../assets/branding/favicon-32x32.png) | `32x32` | Marketplace `applicationIcon32` and favicon assets. |
| [`assets/branding/icon-128x128.png`](../assets/branding/icon-128x128.png) | `128x128` | Master source bitmap and Marketplace `applicationIcon128` asset. |
| [`assets/branding/banner-220x140.png`](../assets/branding/banner-220x140.png) | `220x140` | Marketplace `cardBanner220x140` asset. |
| [`assets/branding/logo-one-line-220x30.png`](../assets/branding/logo-one-line-220x30.png) | `220x30` | Horizontal wordmark banner displayed in [`README.md`](../README.md) and composited into the Marketplace screenshot header. |

All branding asset paths, dimensions, OAuth consent screen rules, and Store Listing metadata are codified in [`assets/branding/marketplace-listing.json`](../assets/branding/marketplace-listing.json) and verified against `MarketplaceListingConfigSchema` by `test/validation/branding.test.ts` (asserting zero byte-for-byte drift against in-memory generation).

---

## 4. Private (Domain-Only) Google Workspace Marketplace Publishing

Production (`inc-io-docs-prod`) distributes `INC-IO Docs` to organization members through a **Private (Domain-Only)** Google Workspace Marketplace listing (`visibility: "PRIVATE_DOMAIN_ONLY"` in [`assets/branding/marketplace-listing.json`](../assets/branding/marketplace-listing.json)) paired with an **Internal (`INTERNAL`)** OAuth Consent Screen.

### Internal OAuth Consent Screen vs. Marketplace SDK Store Listing

Configuring external `https://github.com/...` links on the Google Cloud OAuth Consent Screen causes Google Cloud Console to add `github.com` to **Authorized domains**, triggering a mandatory Google Search Console domain ownership verification check that cannot be completed for `github.com`. Keep the two surfaces strictly separated:

| Configuration Surface | Required Settings in `inc-io-docs-prod` | Why |
| :--- | :--- | :--- |
| **OAuth Consent Screen** (`APIs & Services > OAuth consent screen`) | - **User Type**: `INTERNAL`<br>- **App name**: `"INC-IO Docs"`<br>- **User support email**: Select logged-in Workspace account or domain Google Group from dropdown<br>- **Application home page**: *(leave BLANK)*<br>- **Application privacy policy link**: *(leave BLANK)*<br>- **Application terms of service link**: *(leave BLANK)*<br>- **Authorized domains**: *(leave BLANK)*<br>- **App logo**: *(leave BLANK)*<br>- **Scopes**: Exact 5 `oauthScopes` from [`marketplace-listing.json`](../assets/branding/marketplace-listing.json) | `INTERNAL` restricts OAuth consent to organization users without external CASA review. Leaving App Domains and App Logo blank on the OAuth Consent Screen prevents Google Cloud Console from demanding Google Search Console ownership verification for `github.com`. |
| **Google Workspace Marketplace SDK — App Configuration** (`APIs & Services > Enabled APIs > Google Workspace Marketplace SDK > App Configuration`) | - **App Visibility**: `Private` (`PRIVATE_DOMAIN_ONLY`)<br>- **Installation Settings**: Allow individual and Admin Console domain install<br>- **App Integration**: Google Workspace Add-on linked to the `inc-io-docs` deployment (`gcloud workspace-add-ons deployments replace`)<br>- **OAuth Scopes**: Exact 5 `oauthScopes` matching [`infra/deployment.template.json`](../infra/deployment.template.json) | Binds the Marketplace listing to the Cloud Run `Workspace Addon` deployment and restricts visibility strictly to the Google Workspace domain. |
| **Google Workspace Marketplace SDK — Store Listing** (`Google Workspace Marketplace SDK > Store Listing`) | - **App Details**: `"INC-IO Docs"`, category `Productivity`, language `en`, `shortDescription` (`<= 200` chars), and `detailedDescription` from [`marketplace-listing.json`](../assets/branding/marketplace-listing.json)<br>- **URLs**: `homepageUrl`, `supportUrl`, `privacyPolicyUrl`, and `termsOfServiceUrl` (`https://github.com/amcgoey/INC-IO-Docs...`)<br>- **Graphic Assets**: [`icon-32x32.png`](../assets/branding/icon-32x32.png), [`icon-128x128.png`](../assets/branding/icon-128x128.png), [`banner-220x140.png`](../assets/branding/banner-220x140.png), and [`screenshot-1280x800.png`](../assets/branding/screenshot-1280x800.png) | The Marketplace Store Listing accepts external `https://github.com/...` support/privacy/terms URLs and graphic assets without triggering OAuth domain verification. |
| **Google Workspace Admin Console** (`Admin Console > Apps > Google Workspace Marketplace apps > Apps list`) | - Install the published `PRIVATE_DOMAIN_ONLY` `"INC-IO Docs"` app for the organization domain or target organizational units and pre-grant the 5 OAuth scopes. | Deploys `"INC-IO Docs"` automatically into the right-hand companion sidebar of Google Drive and Gmail for domain users without per-user OAuth consent prompts. |

---

## 5. CI/CD Quality Gates & `v0.5.0` GitHub Release Pipeline

### Deterministic PR & Branch Quality Gates

Every pull request and deployment branch run executes three deterministic verification gates defined in [`package.json`](../package.json):

```bash
npm run lint
npm run typecheck
npm run test:all
```

1. **`npm run lint`**: Executes ESLint (`npm run lint:eslint`) and Semgrep (`npm run lint:semgrep` against `semgrep.yml`) to enforce hexagonal architecture boundaries (ensuring `domain.ts` and `ports.ts` never import from `adapters/`, and `src/infrastructure/` never imports from `src/features/`).
2. **`npm run typecheck`**: Runs `tsc --noEmit` across the root TypeScript project and `npm --prefix infra/pulumi run typecheck` across the Pulumi infrastructure module.
3. **`npm run test:all`** (and `npm test`): Runs the full Vitest suite (unit, integration, schema validation, branding byte-drift validation, deployment manifest validation, and documentation contract validation) followed by the Pulumi unit test suite (`npm --prefix infra/pulumi test`).

### Automated Cloud Run & `Workspace Addon` Deployment (`develop` → `dev`, `main` → `prod`)

The deployment workflow ([`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml)) converges Cloud Run and the `Workspace Addon` deployment for `develop` (`environment: dev` → `inc-io-docs-dev`) and `main` (`environment: prod` → `inc-io-docs-prod`):

1. **Isolated Production Container Build**: Runs `docker build` before cloud mutations. The multi-stage `Dockerfile` compiles only runtime `src/**/*.ts` code via `npm run build` (`tsc -p tsconfig.build.json`), while `.dockerignore` excludes `infra/`, `test/`, `docs/`, `.agents/`, `.github/`, and `.env`.
2. **3-Way WIF Authentication**: Authenticates to GCP via `google-github-actions/auth@v3` using the GitHub Environment's `WIF_PROVIDER` and `GCP_SERVICE_ACCOUNT` secrets.
3. **Bootstrap & Artifact Registry Convergence**: Resolves the currently deployed Cloud Run image (or falls back to `us-docker.pkg.dev/cloudrun/container/hello` on first run) and runs `pulumi up` on the target stack (`dev` or `prod` in `gs://<project>-pulumi-state`) so the Artifact Registry repository exists before pushing.
4. **Image Push & Cloud Run Rollout**: Pushes the tagged container image (`:<github.sha>` and `:v0.5.0` / `:latest`) to `us-east4-docker.pkg.dev/<project>/inc-io-docs/inc-io-docs`, then executes `pulumi up` with the immutable image tag to roll out the new Cloud Run v2 revision.
5. **Manifest Generation & Add-on Update**: Reads `serviceUrl` from `pulumi stack output serviceUrl`, executes `npm run generate:manifest -- --service-url "$SERVICE_URL" --environment <dev|prod>`, and updates the `Workspace Addon` deployment via:
   ```bash
   gcloud workspace-add-ons deployments replace inc-io-docs \
     --deployment-file=infra/deployment.json \
     --project="$PROJECT_ID"
   ```

### `v0.5.0` GitHub Release Pipeline on `main`

When changes land on `main` and the `prod` Cloud Run and `Workspace Addon` deployment succeeds:
- The release stage tags the verified commit on `main` as `v0.5.0` and publishes the `v0.5.0` GitHub Release with auto-generated release notes (`gh release create v0.5.0 --verify-tag --generate-notes`), providing an immutable audit trail and GitHub's native release source archives alongside the live `inc-io-docs-prod` deployment.
