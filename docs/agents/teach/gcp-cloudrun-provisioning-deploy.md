# Provisioning and Deploying to Google Cloud Run (Test and Prod)

This guide covers options for provisioning Google Cloud Run environments (Test and Production) and automating deployments using GitHub Actions.

## 1. Provisioning Infrastructure: Terraform vs Pulumi vs Google Cloud Console

To maintain isolation between Test and Prod environments, it is recommended to use either separate Google Cloud Projects (strongest isolation for production) or separate Cloud Run Services within the same project. 

### Terraform
*   **Overview:** The industry standard for Infrastructure as Code (IaC). Uses HCL (HashiCorp Configuration Language) and declarative configuration.
*   **Key Resources:** `google_cloud_run_v2_service`, `google_artifact_registry_repository`, `google_service_account`.
*   **State Management:** Requires a remote state backend (e.g., Google Cloud Storage bucket) for team collaboration and locking.
*   **Environments:** Use Terraform Workspaces or separate state directories (e.g., `environments/test` and `environments/prod`) to separate Test and Prod resources.
*   **Primary Source:** [Terraform Google Provider - Cloud Run V2](https://registry.terraform.io/providers/hashicorp/google/latest/docs/resources/cloud_run_v2_service)

### Pulumi
*   **Overview:** Allows you to define infrastructure using general-purpose programming languages like TypeScript, Python, or Go.
*   **Environments:** Pulumi "Stacks" naturally map to environments (e.g., `test` and `prod`), allowing you to deploy the same Pulumi program with different configuration values.
*   **State Management:** Can use Pulumi Cloud or self-managed backends (like a GCS bucket).
*   **Primary Source:** [Pulumi Google Cloud Classic Provider](https://www.pulumi.com/registry/packages/gcp/api-docs/cloudrunv2/service/)

### Google Cloud Console (ClickOps)
*   **Overview:** Manual provisioning via the web interface.
*   **Pros:** Good for prototyping, learning the service, or doing a one-off test.
*   **Cons:** Not repeatable, prone to human error, and leads to configuration drift. **Not recommended** for Production or CI/CD integration.
*   **Primary Source:** [Google Cloud Run Documentation](https://cloud.google.com/run/docs/deploying)

## 2. CI/CD with GitHub Actions (develop -> Test, main -> Prod)

Following the "Build Once, Deploy Many" principle, the pipeline should build the container image once, store it in Google Artifact Registry, and promote it across environments.

### Authentication: Workload Identity Federation
Avoid storing long-lived JSON service account keys in GitHub Secrets. Use Workload Identity Federation (WIF) for keyless, secure authentication between GitHub and Google Cloud.
*   **Action:** `google-github-actions/auth`
*   **Primary Source:** [Google GitHub Actions - Auth](https://github.com/google-github-actions/auth)

### Deployment Actions
Use official Google actions to deploy the container to Cloud Run.
*   **Action:** `google-github-actions/deploy-cloudrun`
*   **Primary Source:** [Google GitHub Actions - Deploy Cloud Run](https://github.com/google-github-actions/deploy-cloudrun)

### Workflow Strategy
1.  **Trigger:**
    *   Push to `develop` -> Sets environment variables for `Test`
    *   Push to `main` -> Sets environment variables for `Prod`
2.  **Build & Push:** Use `docker build` and push the image to Artifact Registry, tagged with the commit SHA.
3.  **Deploy:** Run the `deploy-cloudrun` action specifying the target environment's service name and region.

### Example GitHub Actions Workflow (`.github/workflows/deploy.yml`)

```yaml
name: CI/CD Pipeline

on:
  push:
    branches:
      - develop
      - main

env:
  PROJECT_ID: my-gcp-project
  REGION: us-central1
  REPO_NAME: my-app-repo
  IMAGE_NAME: my-app
  # WIF Provider: projects/123456789/locations/global/workloadIdentityPools/my-pool/providers/my-provider

jobs:
  build-and-deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: 'read'
      id-token: 'write' # Required for Workload Identity Federation

    steps:
      - name: Checkout code
        uses: actions/checkout@v4

      - name: Set Environment Variables
        run: |
          if [[ "${{ github.ref }}" == "refs/heads/main" ]]; then
            echo "ENV_NAME=prod" >> $GITHUB_ENV
            echo "SERVICE_NAME=my-app-prod" >> $GITHUB_ENV
          else
            echo "ENV_NAME=test" >> $GITHUB_ENV
            echo "SERVICE_NAME=my-app-test" >> $GITHUB_ENV
          fi

      - name: Authenticate to Google Cloud
        id: auth
        uses: google-github-actions/auth@v2
        with:
          workload_identity_provider: '${{ secrets.WIF_PROVIDER }}'
          service_account: '${{ secrets.GCP_SERVICE_ACCOUNT }}'

      - name: Set up Cloud SDK
        uses: google-github-actions/setup-gcloud@v2

      - name: Docker Auth
        run: |-
          gcloud auth configure-docker ${{ env.REGION }}-docker.pkg.dev

      - name: Build and Push Container
        run: |-
          IMAGE_PATH="${{ env.REGION }}-docker.pkg.dev/${{ env.PROJECT_ID }}/${{ env.REPO_NAME }}/${{ env.IMAGE_NAME }}:${{ github.sha }}"
          docker build -t $IMAGE_PATH .
          docker push $IMAGE_PATH
          echo "IMAGE_PATH=$IMAGE_PATH" >> $GITHUB_ENV

      - name: Deploy to Cloud Run
        uses: google-github-actions/deploy-cloudrun@v2
        with:
          service: ${{ env.SERVICE_NAME }}
          region: ${{ env.REGION }}
          image: ${{ env.IMAGE_PATH }}
          env_vars: |
            ENVIRONMENT=${{ env.ENV_NAME }}
```

## 3. Best Practices
*   **Separation of Duties:** Ensure the Google Cloud Service Account used by GitHub Actions has the least-privilege IAM roles required (e.g., `roles/run.admin`, `roles/iam.serviceAccountUser`, `roles/artifactregistry.writer`).
*   **Secrets Management:** Store sensitive configuration (like database passwords or API keys) in Google Cloud Secret Manager and mount them into Cloud Run, rather than passing them as plain environment variables.
