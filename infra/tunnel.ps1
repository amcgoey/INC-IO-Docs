<#
.SYNOPSIS
    Automates local tunneling with ngrok and updates Google Workspace Add-on deployment.json.

.DESCRIPTION
    Checks/installs ngrok (via Chocolatey or winget), configures the auth token, spins up
    an HTTP tunnel for local development, queries the ngrok API for the public URL, and
    dynamically updates infra/deployment.json without BOM.

.PARAMETER Port
    The local port where the development server is listening. Default is 8080.

.PARAMETER AuthToken
    Optional ngrok auth token. If omitted, checks $env:NGROK_AUTHTOKEN or existing ngrok config.

.PARAMETER ManifestPath
    Path to deployment.json. Default is "$PSScriptRoot/deployment.json".

.PARAMETER DeploymentId
    Optional GCP Workspace Add-on deployment ID.

.PARAMETER ProjectId
    Optional GCP Project ID. Default is $env:PROJECT_ID.

.PARAMETER AutoDeploy
    If specified, automatically runs 'gcloud workspace-add-ons deployments replace'.

.PARAMETER SkipInstall
    Skip automatic package manager checks for ngrok.

.PARAMETER NonInteractive
    Do not wait for user keystroke to terminate; leaves tunnel running in background.
#>
param (
    [int]$Port = 8080,
    [string]$AuthToken = "",
    [string]$ManifestPath = "$PSScriptRoot/deployment.json",
    [string]$DeploymentId = "",
    [string]$ProjectId = $env:PROJECT_ID,
    [switch]$AutoDeploy,
    [switch]$SkipInstall,
    [switch]$NonInteractive
)

$ErrorActionPreference = "Stop"

function Assert-Success {
    param([string]$Message)
    if ($LASTEXITCODE -ne 0) {
        Write-Host "ERROR: $Message" -ForegroundColor Red
        exit $LASTEXITCODE
    }
}

function Stop-TunnelProcess {
    param($Process)
    if ($Process -and -not $Process.HasExited) {
        Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
    }
}

function Get-ActiveHttpsTunnel {
    param([string]$ApiUrl = "http://127.0.0.1:4040/api/tunnels")
    try {
        $response = Invoke-RestMethod -Uri $ApiUrl -Method Get -TimeoutSec 2 -ErrorAction SilentlyContinue
        if ($response -and $response.tunnels -and $response.tunnels.Count -gt 0) {
            $httpsTunnel = $response.tunnels | Where-Object { $_.public_url -like "https://*" } | Select-Object -First 1
            if ($httpsTunnel) {
                return $httpsTunnel.public_url
            }
        }
    } catch {
        # Endpoint not reachable yet
    }
    return ""
}

Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host " INC-IO Docs: Workspace Add-on Tunnel & Dev Helper" -ForegroundColor Cyan
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "Target Port:   $Port"
Write-Host "Manifest Path: $ManifestPath"
if ($ProjectId) { Write-Host "GCP Project:   $ProjectId" }
if ($DeploymentId) { Write-Host "Deployment ID: $DeploymentId" }
Write-Host "=========================================================="
Write-Host ""

# 1. Check for ngrok installation
$ngrokCmd = Get-Command ngrok -ErrorAction SilentlyContinue
if (-not $ngrokCmd -and -not $SkipInstall) {
    Write-Host "ngrok not found in PATH. Checking package managers..." -ForegroundColor Yellow

    $chocoCmd = Get-Command choco -ErrorAction SilentlyContinue
    $wingetCmd = Get-Command winget -ErrorAction SilentlyContinue

    if ($chocoCmd) {
        Write-Host "Installing ngrok via Chocolatey..." -ForegroundColor Cyan
        choco install ngrok -y
        Assert-Success "Failed to install ngrok via Chocolatey."
    } elseif ($wingetCmd) {
        Write-Host "Installing ngrok via winget..." -ForegroundColor Cyan
        winget install ngrok.ngrok --accept-source-agreements --accept-package-agreements
        Assert-Success "Failed to install ngrok via winget."
    } else {
        Write-Host "Neither Chocolatey nor winget was found." -ForegroundColor Red
        Write-Host "Please install ngrok manually from https://ngrok.com/download or install Chocolatey/winget." -ForegroundColor Red
        exit 1
    }

    # Refresh PATH for current session
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path", "User")
    $ngrokCmd = Get-Command ngrok -ErrorAction SilentlyContinue
    if (-not $ngrokCmd) {
        Write-Host "ngrok was installed but is not yet available in the current session PATH. Please restart your shell." -ForegroundColor Red
        exit 1
    }
} elseif (-not $ngrokCmd) {
    Write-Host "ngrok not found. Please install ngrok and ensure it is on your PATH." -ForegroundColor Red
    exit 1
}

# 2. Configure Auth Token if provided
$effectiveToken = if ($AuthToken) { $AuthToken } elseif ($env:NGROK_AUTHTOKEN) { $env:NGROK_AUTHTOKEN } else { "" }
if ($effectiveToken) {
    Write-Host "Configuring ngrok authtoken..." -ForegroundColor Cyan
    ngrok config add-authtoken $effectiveToken | Out-Null
    Assert-Success "Failed to configure ngrok authtoken."
}

# 3. Check for existing or start new tunnel
$tunnelProcess = $null
$publicHttpsUrl = Get-ActiveHttpsTunnel

if ($publicHttpsUrl) {
    Write-Host "Found existing ngrok tunnel: $publicHttpsUrl" -ForegroundColor Green
} else {
    Write-Host "Starting ngrok tunnel for port $Port..." -ForegroundColor Cyan
    $tunnelProcess = Start-Process -FilePath "ngrok" -ArgumentList "http", "$Port", "--log=stdout" -PassThru -WindowStyle Minimized

    # Poll API until tunnel is ready (up to 20 seconds)
    $attempts = 0
    $maxAttempts = 20
    while ($attempts -lt $maxAttempts -and -not $publicHttpsUrl) {
        Start-Sleep -Seconds 1
        $attempts++
        $publicHttpsUrl = Get-ActiveHttpsTunnel
    }
}

if (-not $publicHttpsUrl) {
    Write-Host "FATAL: Could not retrieve public tunnel URL from ngrok." -ForegroundColor Red
    Stop-TunnelProcess -Process $tunnelProcess
    exit 1
}

Write-Host "Active HTTPS Tunnel: $publicHttpsUrl" -ForegroundColor Green

# 4. Update deployment.json
if (-not (Test-Path $ManifestPath)) {
    Write-Host "ERROR: Manifest file not found at '$ManifestPath'." -ForegroundColor Red
    Stop-TunnelProcess -Process $tunnelProcess
    exit 1
}

Write-Host "Updating manifest at '$ManifestPath'..." -ForegroundColor Cyan
$manifestContent = Get-Content -Path $ManifestPath -Raw | ConvertFrom-Json

$homepageUrl = "$publicHttpsUrl/workspace/homepage"

if ($manifestContent.addOns) {
    if ($manifestContent.addOns.common -and $manifestContent.addOns.common.homepageTrigger) {
        $manifestContent.addOns.common.homepageTrigger.runFunction = $homepageUrl
    }
    if ($manifestContent.addOns.drive) {
        if ($manifestContent.addOns.drive.homepageTrigger) {
            $manifestContent.addOns.drive.homepageTrigger.runFunction = $homepageUrl
        }
        if ($manifestContent.addOns.drive.onItemsSelectedTrigger) {
            $manifestContent.addOns.drive.onItemsSelectedTrigger.runFunction = $homepageUrl
        }
    }
}

$updatedJson = $manifestContent | ConvertTo-Json -Depth 10
$utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllText((Resolve-Path $ManifestPath).Path, $updatedJson, $utf8NoBom)

Write-Host "Manifest updated successfully with $homepageUrl" -ForegroundColor Green
Write-Host ""
Write-Host "==========================================================" -ForegroundColor Green
Write-Host " Workspace Add-on Endpoints:" -ForegroundColor Green
Write-Host "   Homepage: $homepageUrl"
Write-Host "   Action:   $publicHttpsUrl/workspace/action"
Write-Host "   Web UI:   http://127.0.0.1:4040"
Write-Host "==========================================================" -ForegroundColor Green
Write-Host ""

# 5. Deployment helper
$targetDeployment = if ($DeploymentId) { $DeploymentId } else { "inc-io-docs-dev" }
$projectArg = if ($ProjectId) { " --project=$ProjectId" } else { "" }

if ($AutoDeploy) {
    Write-Host "Auto-deploying to GCP Workspace Add-ons..." -ForegroundColor Cyan
    gcloud workspace-add-ons deployments replace $targetDeployment --deployment-file="$ManifestPath"$projectArg
    Assert-Success "Failed to update Workspace Add-on deployment in GCP."
    Write-Host "Deployment '$targetDeployment' updated in GCP!" -ForegroundColor Green
} else {
    Write-Host "To update your GCP deployment with the new tunnel URL, run:" -ForegroundColor Yellow
    Write-Host "  gcloud workspace-add-ons deployments replace $targetDeployment --deployment-file=$ManifestPath$projectArg" -ForegroundColor White
    Write-Host ""
    Write-Host "To install the deployment for testing in your Workspace account, run:" -ForegroundColor Yellow
    Write-Host "  gcloud workspace-add-ons deployments install $targetDeployment$projectArg" -ForegroundColor White
}

Write-Host ""

# 6. Interactive tunnel management
if ($tunnelProcess -and -not $NonInteractive) {
    Write-Host "Tunnel is running (PID: $($tunnelProcess.Id))." -ForegroundColor Cyan
    Write-Host "Press [Enter] to stop the tunnel and exit..."
    Read-Host | Out-Null
    Write-Host "Stopping ngrok tunnel..."
    Stop-TunnelProcess -Process $tunnelProcess
    Write-Host "Tunnel stopped." -ForegroundColor Yellow
}
