$PROJECT_ID = if ([bool]$env:PROJECT_ID) { $env:PROJECT_ID } else { "inc-io-docs-dev" }
$REGION = if ([bool]$env:REGION) { $env:REGION } else { "us-east4" }
$BUCKET_NAME = "${PROJECT_ID}-pulumi-state"
$SA_NAME = "ci-deployer"
$SA_EMAIL = "${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
$WIF_POOL = "github-actions-pool"
$WIF_PROVIDER = "github-provider"
$REPO = "amcgoey/INC-IO-Docs"

function Assert-Success {
    param([string]$Message)
    if ($LASTEXITCODE -ne 0) {
        Write-Host "FATAL ERROR: $Message" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

Write-Host "Checking gcloud authentication..."
$null = gcloud auth print-access-token 2>&1
Assert-Success "You are not authenticated with gcloud. Please run 'gcloud auth login' and try again."

Write-Host ""
Write-Host "=========================================================="
Write-Host " Bootstrap Configuration Summary"
Write-Host "=========================================================="
Write-Host "Project ID:      $PROJECT_ID"
Write-Host "Region:          $REGION"
Write-Host "Bucket Name:     $BUCKET_NAME"
Write-Host "Service Account: $SA_NAME"
Write-Host "WIF Pool:        $WIF_POOL"
Write-Host "WIF Provider:    $WIF_PROVIDER"
Write-Host "Repository:      $REPO"
Write-Host "=========================================================="
Write-Host ""

$response = Read-Host "Proceed? [y/N]"
if ($response -notmatch '^[Yy]$') {
    Write-Host "Aborted." -ForegroundColor Yellow
    exit 1
}

Write-Host "Enabling foundational GCP APIs..."
gcloud services enable `
    iamcredentials.googleapis.com `
    cloudresourcemanager.googleapis.com `
    iam.googleapis.com `
    --project $PROJECT_ID
Assert-Success "Failed to enable GCP APIs. Make sure the project '$PROJECT_ID' exists and you have permissions."

Write-Host "Configuring GCS Bucket for Pulumi State..."
$null = gcloud storage ls "gs://$BUCKET_NAME" --project "$PROJECT_ID" 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "Bucket gs://$BUCKET_NAME already exists." -ForegroundColor Cyan
} else {
    Write-Host "Creating bucket gs://$BUCKET_NAME in $REGION..."
    gcloud storage buckets create "gs://$BUCKET_NAME" --project "$PROJECT_ID" --location "$REGION"
    Assert-Success "Failed to create GCS bucket."
}
Write-Host "Enabling Object Versioning on bucket..."
gcloud storage buckets update "gs://$BUCKET_NAME" --versioning --project "$PROJECT_ID" | Out-Null
Assert-Success "Failed to enable bucket versioning."

Write-Host "Configuring Service Account: $SA_NAME..."
$null = gcloud iam service-accounts describe $SA_EMAIL --project $PROJECT_ID 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "Service Account $SA_NAME already exists." -ForegroundColor Cyan
} else {
    Write-Host "Creating Service Account $SA_NAME..."
    gcloud iam service-accounts create $SA_NAME `
        --display-name="CI Deployer Service Account" `
        --project="$PROJECT_ID"
    Assert-Success "Failed to create Service Account."
}

Write-Host "Granting roles to Service Account..."
$ROLES = @(
    "roles/editor",
    "roles/run.admin",
    "roles/iam.serviceAccountUser",
    "roles/artifactregistry.admin"
)
foreach ($role in $ROLES) {
    gcloud projects add-iam-policy-binding $PROJECT_ID `
        --member="serviceAccount:$SA_EMAIL" `
        --role="$role" `
        --condition=None | Out-Null
    Assert-Success "Failed to bind role $role to Service Account."
}

Write-Host "Configuring WIF Pool: $WIF_POOL..."
$null = gcloud iam workload-identity-pools describe $WIF_POOL --location="global" --project="$PROJECT_ID" 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "WIF Pool $WIF_POOL already exists." -ForegroundColor Cyan
} else {
    Write-Host "Creating WIF Pool $WIF_POOL..."
    gcloud iam workload-identity-pools create $WIF_POOL `
        --location="global" `
        --display-name="GitHub Actions Pool" `
        --project="$PROJECT_ID"
    Assert-Success "Failed to create WIF Pool."
}

Write-Host "Configuring WIF Provider: $WIF_PROVIDER..."
$null = gcloud iam workload-identity-pools providers describe $WIF_PROVIDER `
    --workload-identity-pool="$WIF_POOL" `
    --location="global" --project="$PROJECT_ID" 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "WIF Provider $WIF_PROVIDER already exists." -ForegroundColor Cyan
} else {
    Write-Host "Creating WIF Provider $WIF_PROVIDER..."
    gcloud iam workload-identity-pools providers create-oidc $WIF_PROVIDER `
        --workload-identity-pool="$WIF_POOL" `
        --location="global" `
        --display-name="GitHub Provider" `
        --issuer-uri="https://token.actions.githubusercontent.com" `
        --attribute-mapping="google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository" `
        --attribute-condition="attribute.repository == '$REPO'" `
        --project="$PROJECT_ID"
    Assert-Success "Failed to create WIF Provider."
}

Write-Host "Binding Service Account to WIF Pool..."
$projectNumber = (gcloud projects describe $PROJECT_ID --format="value(projectNumber)")
gcloud iam service-accounts add-iam-policy-binding $SA_EMAIL `
    --project="$PROJECT_ID" `
    --role="roles/iam.workloadIdentityUser" `
    --member="principalSet://iam.googleapis.com/projects/$projectNumber/locations/global/workloadIdentityPools/$WIF_POOL/attribute.repository/$REPO" | Out-Null
Assert-Success "Failed to bind Service Account to WIF Pool."

Write-Host "Bootstrap complete!" -ForegroundColor Green
