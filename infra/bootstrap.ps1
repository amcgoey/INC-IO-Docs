param(
    [ValidateSet("dev", "prod")]
    [string]$Environment = "dev",

    [string]$ProjectId,

    [string]$Region,

    [string]$Repo = "amcgoey/INC-IO-Docs",

    [string]$Branch,

    [string]$PulumiPassphrase,

    [switch]$Force
)

# Enforce strict parameter precedence:
# CLI -ProjectId wins first.
# If omitted and -Environment was explicitly passed, map from preset ($Environment).
# Else fall back to ambient $env:PROJECT_ID.
# Else default to preset ($Environment).
if ([bool]$ProjectId) {
    $PROJECT_ID = $ProjectId
} elseif ($PSBoundParameters.ContainsKey('Environment')) {
    $PROJECT_ID = if ($Environment -eq "prod") { "inc-io-docs-prod" } else { "inc-io-docs-dev" }
} elseif ([bool]$env:PROJECT_ID) {
    $PROJECT_ID = $env:PROJECT_ID
} else {
    $PROJECT_ID = if ($Environment -eq "prod") { "inc-io-docs-prod" } else { "inc-io-docs-dev" }
}

# Region precedence: explicit -Region > ambient $env:REGION > default "us-east4"
$REGION = if ([bool]$Region) {
    $Region
} elseif ([bool]$env:REGION) {
    $env:REGION
} else {
    "us-east4"
}

# Branch precedence: explicit -Branch (stripping refs/heads/) > default ("develop" for dev, "main" for prod)
if ([bool]$Branch) {
    $BRANCH = $Branch -replace '^refs/heads/', ''
} else {
    $BRANCH = if ($Environment -eq "prod") { "main" } else { "develop" }
}

$REPO = if ([bool]$Repo) { $Repo } else { "amcgoey/INC-IO-Docs" }
$ServiceName = "inc-io-docs-$Environment"
$BUCKET_NAME = "${PROJECT_ID}-pulumi-state"
$PulumiStack = $Environment
$SA_NAME = "ci-deployer"
$SA_EMAIL = "${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
$WIF_POOL = "github-actions-pool"
$WIF_PROVIDER = "github-provider"

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

Write-Host "Checking gh authentication..."
$null = gh auth status 2>&1
Assert-Success "You are not authenticated with the GitHub CLI (gh). Please run 'gh auth login' and try again."

Write-Host ""
Write-Host "=========================================================="
Write-Host " Bootstrap Configuration Summary"
Write-Host "=========================================================="
Write-Host "Environment:     $Environment"
Write-Host "Project ID:      $PROJECT_ID"
Write-Host "Region:          $REGION"
Write-Host "Branch:          $BRANCH"
Write-Host "Service Name:    $ServiceName"
Write-Host "Bucket Name:     $BUCKET_NAME"
Write-Host "Pulumi Stack:    $PulumiStack"
Write-Host "Service Account: $SA_NAME"
Write-Host "WIF Pool:        $WIF_POOL"
Write-Host "WIF Provider:    $WIF_PROVIDER"
Write-Host "Repository:      $REPO"
Write-Host "=========================================================="
Write-Host ""

if (-not $Force) {
    $response = Read-Host "Proceed? [y/N]"
    if ($response -notmatch '^[Yy]$') {
        Write-Host "Aborted." -ForegroundColor Yellow
        exit 1
    }
}

Write-Host "Enabling foundational GCP APIs..."
gcloud services enable `
    iamcredentials.googleapis.com `
    cloudresourcemanager.googleapis.com `
    iam.googleapis.com `
    serviceusage.googleapis.com `
    storage.googleapis.com `
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

Write-Host "Granting bucket-scoped roles/storage.admin to $SA_NAME on gs://$BUCKET_NAME..."
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET_NAME" `
    --member="serviceAccount:$SA_EMAIL" `
    --role="roles/storage.admin" | Out-Null
Assert-Success "Failed to bind roles/storage.admin on bucket gs://$BUCKET_NAME to Service Account."

Write-Host "Inspecting project IAM policy for legacy primitive roles on $SA_EMAIL..."
$policyJson = gcloud projects get-iam-policy $PROJECT_ID --format=json 2>$null
if ($policyJson) {
    try {
        $policy = ($policyJson -join "`n") | ConvertFrom-Json
        $legacyRoles = @("roles/editor", "roles/viewer")
        foreach ($role in $legacyRoles) {
            $hasRole = $false
            if ($policy -and $policy.bindings) {
                foreach ($binding in $policy.bindings) {
                    if ($binding.role -eq $role -and $binding.members -contains "serviceAccount:$SA_EMAIL") {
                        $hasRole = $true
                        break
                    }
                }
            }
            if ($hasRole) {
                Write-Host "Removing legacy $role from $SA_EMAIL..." -ForegroundColor Yellow
                gcloud projects remove-iam-policy-binding $PROJECT_ID `
                    --member="serviceAccount:$SA_EMAIL" `
                    --role="$role" `
                    --condition=None | Out-Null
                Assert-Success "Failed to remove $role from Service Account."
            } else {
                Write-Host "Service Account does not have $role." -ForegroundColor Cyan
            }
        }
    } catch {
        Write-Warning "Failed to parse project IAM policy: $_"
    }
}

Write-Host "Granting least-privilege project roles to Service Account..."
$ROLES = @(
    "roles/serviceusage.serviceUsageAdmin",
    "roles/browser",
    "roles/iam.serviceAccountAdmin",
    "roles/iam.serviceAccountUser",
    "roles/run.admin",
    "roles/artifactregistry.admin",
    "roles/gsuiteaddons.developer"
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
$attributeMapping = "google.subject=assertion.sub,attribute.actor=assertion.actor,attribute.repository=assertion.repository,attribute.ref=assertion.ref,attribute.environment=assertion.environment"
$attributeCondition = "has(assertion.environment) && assertion.environment == '$Environment' && assertion.repository == '$REPO' && assertion.ref == 'refs/heads/$BRANCH'"

$null = gcloud iam workload-identity-pools providers describe $WIF_PROVIDER `
    --workload-identity-pool="$WIF_POOL" `
    --location="global" --project="$PROJECT_ID" 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "WIF Provider $WIF_PROVIDER already exists. Updating in place..." -ForegroundColor Cyan
    gcloud iam workload-identity-pools providers update-oidc $WIF_PROVIDER `
        --workload-identity-pool="$WIF_POOL" `
        --location="global" `
        --attribute-mapping="$attributeMapping" `
        --attribute-condition="$attributeCondition" `
        --project="$PROJECT_ID"
    Assert-Success "Failed to update WIF Provider."
} else {
    Write-Host "Creating WIF Provider $WIF_PROVIDER..."
    gcloud iam workload-identity-pools providers create-oidc $WIF_PROVIDER `
        --workload-identity-pool="$WIF_POOL" `
        --location="global" `
        --display-name="GitHub Provider" `
        --issuer-uri="https://token.actions.githubusercontent.com" `
        --attribute-mapping="$attributeMapping" `
        --attribute-condition="$attributeCondition" `
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

$fullWifProvider = "projects/$projectNumber/locations/global/workloadIdentityPools/$WIF_POOL/providers/$WIF_PROVIDER"

Write-Host "Configuring GitHub Environment '$Environment' in repository '$REPO'..."
$envPolicy = '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
$envPolicy | gh api --method PUT "repos/$REPO/environments/$Environment" --input - | Out-Null
Assert-Success "Failed to configure GitHub Environment '$Environment'."

Write-Host "Checking deployment branch policies for Environment '$Environment'..."
$branchPoliciesJson = gh api "repos/$REPO/environments/$Environment/deployment-branch-policies" 2>$null
$hasBranchPolicy = $false
if ($branchPoliciesJson) {
    try {
        $policies = ($branchPoliciesJson -join "`n") | ConvertFrom-Json
        if ($policies -and $policies.branch_policies) {
            foreach ($bp in $policies.branch_policies) {
                if ($bp.name -eq $BRANCH) {
                    $hasBranchPolicy = $true
                    break
                }
            }
        }
    } catch {
        Write-Warning "Failed to parse deployment branch policies: $_"
    }
}

if ($hasBranchPolicy) {
    Write-Host "Deployment branch policy for '$BRANCH' already exists on Environment '$Environment'." -ForegroundColor Cyan
} else {
    Write-Host "Adding deployment branch policy for branch '$BRANCH' on Environment '$Environment'..."
    $bpBody = (@{ name = $BRANCH } | ConvertTo-Json -Compress)
    $bpBody | gh api --method POST "repos/$REPO/environments/$Environment/deployment-branch-policies" --input - | Out-Null
    Assert-Success "Failed to create deployment branch policy for branch '$BRANCH'."
}

Write-Host "Configuring GitHub Environment variables for '$Environment'..."
$envVars = [ordered]@{
    "PROJECT_ID"          = $PROJECT_ID
    "REGION"              = $REGION
    "REPO_NAME"           = "inc-io-docs"
    "SERVICE_NAME"        = $ServiceName
    "PULUMI_STACK"        = $PulumiStack
    "PULUMI_STATE_BUCKET" = "gs://$BUCKET_NAME"
}
foreach ($varName in $envVars.Keys) {
    $varValue = $envVars[$varName]
    Write-Host "Setting variable $varName = $varValue on Environment '$Environment'..."
    gh variable set $varName --body "$varValue" --env "$Environment" --repo "$REPO" | Out-Null
    Assert-Success "Failed to set GitHub Environment variable '$varName'."
}

Write-Host "Configuring GitHub Environment secrets for '$Environment'..."
Write-Host "Setting WIF_PROVIDER secret..."
gh secret set WIF_PROVIDER --body "$fullWifProvider" --env "$Environment" --repo "$REPO" | Out-Null
Assert-Success "Failed to set WIF_PROVIDER secret."

Write-Host "Setting GCP_SERVICE_ACCOUNT secret..."
gh secret set GCP_SERVICE_ACCOUNT --body "$SA_EMAIL" --env "$Environment" --repo "$REPO" | Out-Null
Assert-Success "Failed to set GCP_SERVICE_ACCOUNT secret."

$passphrase = if ([bool]$PulumiPassphrase) {
    $PulumiPassphrase
} elseif ([bool]$env:PULUMI_CONFIG_PASSPHRASE) {
    $env:PULUMI_CONFIG_PASSPHRASE
} else {
    $null
}

$passphraseConfigured = $false

if (-not $passphrase) {
    Write-Host "Checking if PULUMI_CONFIG_PASSPHRASE secret already exists in GitHub Environment '$Environment'..."
    $secretList = gh secret list --env "$Environment" --repo "$REPO" 2>$null
    $hasPassphrase = $false
    if ($secretList) {
        $lines = $secretList -split "`r?`n"
        foreach ($line in $lines) {
            if ($line -match '^\s*PULUMI_CONFIG_PASSPHRASE\b') {
                $hasPassphrase = $true
                break
            }
        }
    }
    if ($hasPassphrase) {
        Write-Host "PULUMI_CONFIG_PASSPHRASE already configured in GitHub Environment '$Environment'; retaining existing secret." -ForegroundColor Cyan
        $passphraseConfigured = $true
    } elseif (-not $Force) {
        $passphrase = Read-Host "Enter PULUMI_CONFIG_PASSPHRASE for $Environment"
    }
}

if ($passphrase) {
    Write-Host "Setting PULUMI_CONFIG_PASSPHRASE secret..."
    gh secret set PULUMI_CONFIG_PASSPHRASE --body "$passphrase" --env "$Environment" --repo "$REPO" | Out-Null
    Assert-Success "Failed to set PULUMI_CONFIG_PASSPHRASE secret."
    $passphraseConfigured = $true
}

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host " Bootstrap complete! " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green
Write-Host "GitHub Environment '$Environment' in $REPO configured successfully."
Write-Host "Variables: PROJECT_ID, REGION, REPO_NAME, SERVICE_NAME, PULUMI_STACK, PULUMI_STATE_BUCKET"
if ($passphraseConfigured) {
    Write-Host "Secrets:   WIF_PROVIDER, GCP_SERVICE_ACCOUNT, PULUMI_CONFIG_PASSPHRASE"
} else {
    Write-Host "Secrets:   WIF_PROVIDER, GCP_SERVICE_ACCOUNT"
    Write-Warning "PULUMI_CONFIG_PASSPHRASE was not configured (omitted under -Force). Ensure this secret is set in GitHub Environment '$Environment' before running CI deployments."
}
Write-Host "==========================================================" -ForegroundColor Green
Write-Host ""
