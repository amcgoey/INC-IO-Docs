# Google Workspace Add-on Provisioning and Deployment Guide

This guide details how to configure, deploy, and locally test Google Workspace Add-ons (specifically Alternate Runtime / HTTP-based Add-ons) using the `gcloud workspace-add-ons` CLI and local tunneling.

---

## 1. Architecture Overview (Alternate Runtimes)

Google Workspace Add-ons built on **Alternate Runtimes** interact with external HTTP backends (such as Google Cloud Run or a local development server via ngrok) rather than Apps Script runtime code.

Key components:
* **Deployment Manifest (`infra/deployment.json`)**: Declares the add-on name, icons, required OAuth scopes, and webhook trigger URLs.
* **Backend Webhooks**:
  * `POST /workspace/homepage`: Triggered when opening the Add-on in Google Drive. Returns the initial UI card.
  * `POST /workspace/action`: Triggered on interactive widget events (e.g. clicking buttons).
* **CLI Management**: The `gcloud workspace-add-ons` CLI command group provisions and manages deployments directly against the Google Cloud project.

---

## 2. Manifest Configuration (`infra/deployment.json`)

The deployment manifest defines the entry points and security scopes for the Add-on:

```json
{
  "oauthScopes": [
    "https://www.googleapis.com/auth/drive",
    "https://www.googleapis.com/auth/drive.addons.metadata.readonly",
    "https://www.googleapis.com/auth/userinfo.email"
  ],
  "addOns": {
    "common": {
      "name": "INC-IO Docs",
      "logoUrl": "https://www.gstatic.com/images/branding/product/1x/drive_2020q4_48dp.png",
      "homepageTrigger": {
        "runFunction": "https://<TUNNEL_OR_DEPLOYED_URL>/workspace/homepage"
      }
    },
    "drive": {
      "homepageTrigger": {
        "runFunction": "https://<TUNNEL_OR_DEPLOYED_URL>/workspace/homepage"
      },
      "onItemsSelectedTrigger": {
        "runFunction": "https://<TUNNEL_OR_DEPLOYED_URL>/workspace/homepage"
      }
    }
  }
}
```

### OAuth Scopes
* `https://www.googleapis.com/auth/drive`: Required to execute file and folder operations (such as moving selected items to `!TestMove`).
* `https://www.googleapis.com/auth/drive.addons.metadata.readonly`: Allows Workspace to pass contextual file metadata (`drive.selectedItems`) in event payloads.
* `https://www.googleapis.com/auth/userinfo.email`: Identifies the executing user context.

---

## 3. Google Cloud Setup & Authorization

### Step 1: Enable Required APIs
Ensure the Google Workspace Add-ons API is enabled in your target GCP project:

```bash
gcloud services enable \
    gsuiteaddons.googleapis.com \
    drive.googleapis.com \
    --project=inc-io-docs-dev
```

### Step 2: Discover and Authorize the Add-on Service Account
Google Workspace invokes your HTTP backend via a dedicated internal service account. Retrieve its email address:

```bash
gcloud workspace-add-ons get-authorization --project=inc-io-docs-dev
```

If deploying to Google Cloud Run, grant this service account the `roles/run.invoker` role:

```bash
gcloud run services add-iam-policy-binding inc-io-docs \
    --region=us-east4 \
    --member="serviceAccount:<SERVICE_ACCOUNT_EMAIL>" \
    --role="roles/run.invoker" \
    --project=inc-io-docs-dev
```

---

## 4. Deployment Management via `gcloud` CLI

### Create a Deployment
Create a new deployment configuration from the manifest file:

```bash
gcloud workspace-add-ons deployments create inc-io-docs-dev \
    --deployment-file=infra/deployment.json \
    --project=inc-io-docs-dev
```

### Update / Replace a Deployment
When `infra/deployment.json` changes (e.g. updating the webhook URL or scopes), replace the existing deployment:

```bash
gcloud workspace-add-ons deployments replace inc-io-docs-dev \
    --deployment-file=infra/deployment.json \
    --project=inc-io-docs-dev
```

### List Deployments
List all deployments in the project:

```bash
gcloud workspace-add-ons deployments list --project=inc-io-docs-dev
```

### Describe a Deployment
View the active configuration of a specific deployment:

```bash
gcloud workspace-add-ons deployments describe inc-io-docs-dev --project=inc-io-docs-dev
```

### Install for Development / Testing
Install the deployment into your Google Workspace account (the user currently logged in via `gcloud auth login`):

```bash
gcloud workspace-add-ons deployments install inc-io-docs-dev --project=inc-io-docs-dev
```

> **Note:** Once installed, open Google Drive in your web browser. You will see the **INC-IO Docs** icon in the right-side companion bar.

### Uninstall
To remove the development add-on from your workspace session:

```bash
gcloud workspace-add-ons deployments uninstall inc-io-docs-dev --project=inc-io-docs-dev
```

### Delete a Deployment
To delete the deployment permanently from GCP:

```bash
gcloud workspace-add-ons deployments delete inc-io-docs-dev --project=inc-io-docs-dev
```

---

## 5. Local Development & Tunneling Workflow (Windows)

For rapid local iteration, use the automated PowerShell helper script [`infra/tunnel.ps1`](file:///c:/Users/amcgoey/Documents/Code/INC-IO-Docs/infra/tunnel.ps1).

### Automated Helper: `infra/tunnel.ps1`

The script performs the following:
1. Verifies `ngrok` installation (and offers automatic installation via `choco` or `winget` if missing).
2. Configures your `ngrok` authtoken if supplied.
3. Launches an HTTPS tunnel to local port `8080` (or specified `-Port`).
4. Queries ngrok's local API (`http://127.0.0.1:4040`) to obtain the public tunnel URL.
5. Dynamically updates `infra/deployment.json` with the active ngrok URL.
6. Displays the exact `gcloud workspace-add-ons deployments replace` command (or automatically executes it if `-AutoDeploy` is specified).

### Usage Examples

**Start tunnel and update manifest:**
```powershell
.\infra\tunnel.ps1
```

**Start tunnel, specify authtoken, and auto-deploy to GCP:**
```powershell
.\infra\tunnel.ps1 -AuthToken "your-ngrok-token" -DeploymentId "inc-io-docs-dev" -AutoDeploy
```

**Run on a custom application port:**
```powershell
.\infra\tunnel.ps1 -Port 3000
```

---

## 6. Verification & Troubleshooting

1. **HTTP 403 / Signature Verification Errors**:
   - Ensure incoming requests to `/workspace/action` and `/workspace/homepage` verify bearer tokens issued by Google (`https://accounts.google.com`).
2. **Manifest Schema Validation**:
   - Run automated validation tests with `npx vitest run test/validation/deployment-manifest.test.ts`.
3. **Endpoint Reachability**:
   - Open `http://127.0.0.1:4040` in a browser to inspect incoming ngrok requests and responses during manual testing in Google Drive.
