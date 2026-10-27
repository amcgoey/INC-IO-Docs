# 15. Multi-Environment GCP Workload Identity Isolation and Least-Privilege IAM

Date: 2026-10-26

## Status

Accepted

## Context

In the initial development infrastructure (`inc-io-docs-dev`), `infra/bootstrap.ps1` and `infra/pulumi/` exhibited three security and multi-environment isolation gaps:
1. **Unrestricted Repository OIDC Trust**: The GCP Workload Identity Federation (WIF) OIDC provider checked only `attribute.repository == 'amcgoey/INC-IO-Docs'`, allowing a workflow triggered from any branch or environment in the repository to impersonate the `ci-deployer` service account.
2. **Primitive `roles/editor` on `ci-deployer`**: The CI deployment service account held `roles/editor` across the entire GCP project, granting broad read/write access to all resources and buckets rather than only the permissions required to converge Pulumi and update the `Workspace Addon` deployment.
3. **Default Compute Engine Runtime Identity**: The Cloud Run v2 service omitted `template.serviceAccount`, causing the runtime container to execute under the default Compute Engine service account (`<projectNumber>-compute@developer.gserviceaccount.com`), even though the `Workspace Addon` authenticates to Google Drive and Gmail exclusively via the end-user's delegated OAuth token (`authorizationEventObject.userOAuthToken`) and requires zero GCP IAM permissions at runtime.

Meanwhile, Pulumi's self-managed GCS state backend (`gs://<project>-pulumi-state`) uses passphrase-based PBKDF2 key derivation where the public `encryptionsalt` lives in `Pulumi.<stack>.yaml` in the repository and must stay synchronized with the `PULUMI_CONFIG_PASSPHRASE` secret stored in the corresponding GitHub Environment.

## Decision

We establish the following architectural invariants across `inc-io-docs-dev` (`dev` stack, `develop` branch) and `inc-io-docs-prod` (`prod` stack, `main` branch):

1. **Three-Way WIF OIDC Claim Binding (Repository + GitHub Environment + Branch Ref)**:
   - Each GCP project's WIF OIDC provider maps `attribute.ref=assertion.ref,attribute.environment=assertion.environment` and enforces:
     `has(assertion.environment) && assertion.environment == '<env>' && assertion.repository == '<repo>' && assertion.ref == 'refs/heads/<branch>'`
   - GitHub Actions deployment jobs explicitly bind `environment: dev` (restricted to `develop`) or `environment: prod` (restricted to `main`), ensuring that only workflows executing in the matching GitHub Environment and branch can mint OIDC tokens accepted by that GCP project's WIF provider.
2. **Least-Privilege `ci-deployer` IAM (7 Project Roles + 1 Bucket-Scoped Role)**:
   - Primitive `roles/editor` (and `roles/viewer`) bindings on `ci-deployer` are prohibited and idempotently removed during bootstrap.
   - `ci-deployer` is granted:
     - **Bucket-scoped** `roles/storage.admin` strictly on `gs://<project>-pulumi-state` (providing `storage.buckets.get` and `storage.objects.*` for Pulumi's GCS backend driver without access to any other bucket).
     - **Project-scoped** `roles/serviceusage.serviceUsageAdmin`, `roles/browser` (for `resourcemanager.projects.get` metadata lookup without data read access), `roles/iam.serviceAccountAdmin`, `roles/iam.serviceAccountUser`, `roles/artifactregistry.admin`, `roles/run.admin`, and `roles/gsuiteaddons.developer`.
3. **Zero-Privilege Cloud Run Runtime Service Account (`addon-runtime`)**:
   - `AppInfrastructure` provisions a dedicated `addon-runtime` service account with **zero** project IAM bindings and attaches it to the Cloud Run v2 revision via `template.serviceAccount`.
   - Inbound Cloud Run invocation (`roles/run.invoker`) remains restricted exclusively to `addon-invoker` and the Google Workspace Add-ons system service agent (`service-<projectNumber>@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`), whose existence is guaranteed via `gcp.projects.ServiceIdentity` before IAM binding.
4. **Synchronized Stack `encryptionsalt` in Git**:
   - Both `Pulumi.dev.yaml` and `Pulumi.prod.yaml` commit a valid, non-secret `encryptionsalt` synchronized with their respective GitHub Environment `PULUMI_CONFIG_PASSPHRASE` secret so ephemeral CI runners derive identical state encryption keys without requiring Google Cloud KMS.

## Consequences

- **Pros**:
  - Cryptographically prevents non-`main` branches or non-`prod` jobs from impersonating `inc-io-docs-prod` in GCP STS/WIF.
  - Eliminates `roles/editor` from both CI (`ci-deployer`) and runtime (`addon-runtime`) identities.
  - Prevents first-run race conditions on fresh GCP projects when binding `roles/run.invoker` to the Google Workspace Add-ons service agent.
  - Ensures deterministic Pulumi state decryption across ephemeral GitHub Actions runners without external KMS dependencies.
- **Cons**:
  - Any GitHub Actions workflow that authenticates to GCP via WIF must declare `environment: dev` or `environment: prod` so GitHub includes the `environment` claim in the OIDC token.
  - Adding a new GCP service resource type to `AppInfrastructure` requires explicitly granting the corresponding admin role to `ci-deployer` in `infra/bootstrap.ps1`.
