#!/usr/bin/env bash
set -e

# Configuration / Environment Variables
PROJECT_ID="$"{PROJECT_ID:-inc-io-docs-dev}"
REGION="$"{REGION:-us-east4}"
BUCKET_NAME="$"{PROJECT_ID}-pulumi-state"
SA_NAME="ci-deployer"
SA_EMAIL="$"{SA_NAME}@$"{PROJECT_ID}.iam.gserviceaccount.com"
WIF_POOL="github-actions-pool"
WIF_PROVIDER="github-provider"
REPO="amcgoey/INC-IO-Docs"

# Pre-flight checks
echo "Checking gcloud authentication..."
if ! gcloud auth print-access-token &>/dev/null; then
  echo "Error: You are not authenticated with gcloud."
  echo "Please run 'gcloud auth login' and try again."
  exit 1
fi

echo ""
echo "=========================================================="
echo " Bootstrap Configuration (DRY RUN)"
echo "=========================================================="
echo "Project ID:      $"{PROJECT_ID}"
echo "Region:          $"{REGION}"
echo "Bucket Name:     $"{BUCKET_NAME}"
echo "Service Account: $"{SA_NAME}"
echo "WIF Pool:        $"{WIF_POOL}"
echo "WIF Provider:    $"{WIF_PROVIDER}"
echo "Repository:      $"{REPO}"
echo "=========================================================="
echo ""

read -p "Proceed with these configurations? [y/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
    echo "Aborted."
    exit 1
fi

echo "Setting active project..."
gcloud config set project "$"{PROJECT_ID}"

echo "Enabling foundational GCP APIs..."
gcloud services enable \
    iamcredentials.googleapis.com \
    cloudresourcemanager.googleapis.com \
    iam.googleapis.com \
    --project "$"{PROJECT_ID}"

echo "Configuring GCS Bucket for Pulumi State..."
if gsutil ls "gs://$"{BUCKET_NAME}" &>/dev/null; then
    echo "Bucket gs://$"{BUCKET_NAME} already exists."
else
    echo "Creating bucket gs://$"{BUCKET_NAME} in $"{REGION}..."
    gsutil mb -p "$"{PROJECT_ID}" -l "$"{REGION}" "gs://$"{BUCKET_NAME}"
fi
echo "Enabling Object Versioning on bucket..."
gsutil versioning set on "gs://$"{BUCKET_NAME}"

echo "Configuring Service Account: $"{SA_NAME}..."
if gcloud iam service-accounts describe "$"{SA_EMAIL}" --project "$"{PROJECT_ID}" &>/dev/null; then
    echo "Service Account $"{SA_NAME} already exists."
else
    echo "Creating Service Account $"{SA_NAME}..."
    gcloud iam service-accounts create "$"{SA_NAME}" \
        --display-name="CI Deployer Service Account" \
        --project="$"{PROJECT_ID}"
fi

echo "Granting roles to Service Account..."
ROLES=(
    "roles/editor"
    "roles/run.admin"
    "roles/iam.serviceAccountUser"
    "roles/artifactregistry.admin"
)
for role in "$"{ROLES[@]}"; do
    gcloud projects add-iam-policy-binding "$"{PROJECT_ID}" \
        --member="serviceAccount:$"{SA_EMAIL}" \
        --role="$"{role}" \
        --condition=None \
        > /dev/null
done

echo "Configuring WIF Pool: $"{WIF_POOL}..."
if gcloud iam workload-identity-pools describe "$"{WIF_POOL}" --location="global" --project="$"{PROJECT_ID}" &>/dev/null; then
    echo "WIF Pool $"{WIF_POOL} already exists."
else
    echo "Creating WIF Pool $"{WIF_POOL}..."
    gcloud iam workload-identity-pools create "$"{WIF_POOL}" \
        --location="global" \
        --display-name="GitHub Actions Pool" \
        --project="$"{PROJECT_ID}"
fi

echo "Configuring WIF Provider: $"{WIF_PROVIDER}..."
if gcloud iam workload-identity-pools providers describe "$"{WIF_PROVIDER}" \
    --workload-identity-pool="$"{WIF_POOL}" \
    --location="global" --project="$"{PROJECT_ID}" &>/dev/null; then
    echo "WIF Provider $"{WIF_PROVIDER} already exists."
else
    echo "Creating WIF Provider $"{WIF_PROVIDER}..."
    gcloud iam workload-identity-pools providers create-oidc "$"{WIF_PROVIDER}" \
        --workload-identity-pool="$"{WIF_POOL}" \
        --location="global" \
        --display-name="GitHub Provider" \
        --issuer-uri="https://token.actions.githubusercontent.com" \
        --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" \
        --attribute-condition="attribute.repository == '$"{REPO}'" \
        --project="$"{PROJECT_ID}"
fi

echo "Binding Service Account to WIF Pool..."
PROJECT_NUMBER=$(gcloud projects describe "$"{PROJECT_ID}" --format='value(projectNumber)')
gcloud iam service-accounts add-iam-policy-binding "$"{SA_EMAIL}" \
    --project="$"{PROJECT_ID}" \
    --role="roles/iam.workloadIdentityUser" \
    --member="principalSet://iam.googleapis.com/projects/$"{PROJECT_NUMBER}/locations/global/workloadIdentityPools/$"{WIF_POOL}/attribute.repository/$"{REPO}" \
    > /dev/null

echo "Bootstrap complete!"
