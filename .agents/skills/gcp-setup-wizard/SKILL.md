---
name: gcp-setup-wizard
description: GCP project setup and Workspace Add-on configuration wizard.
---

## 1. Project and Billing
Ask the user to perform the following in the Google Cloud Console:
1. Create a new Google Cloud project.
2. Link the project to their Master Billing Account.
3. Provide the resulting `PROJECT_ID`.

**Completion criterion:** User provides the `PROJECT_ID` and explicitly confirms billing is linked.

## 2. Infrastructure Deployment
Use the `PROJECT_ID` provided by the user to execute the deployment.
1. Run `infra/bootstrap.ps1` with the user's `PROJECT_ID` to provision the state bucket and Workload Identity Federation configuration.
2. Run `npm --prefix infra/pulumi run typecheck` and `npm --prefix infra/pulumi test` to ensure stability before deployment.
3. Ask the user to authenticate locally if needed using `gcloud auth login` or rely on the GitHub Actions pipeline by committing and pushing. If deploying locally, run `pulumi up` from `infra/pulumi`.

**Completion criterion:** Agent verifies the Cloud Run service is active, the state bucket is created, and the WIF pool is correctly configured.

## 3. OAuth Consent Screen
Ask the user to configure the OAuth consent screen in the Google Cloud Console.
1. Navigate to **APIs & Services > OAuth consent screen**.
2. Select the **Internal** User Type and create the screen.
3. Fill out the required App information ("INC IO Documents") and contact emails.
4. Add the Google Drive API scopes (e.g. `https://www.googleapis.com/auth/drive`).

**Completion criterion:** User confirms the OAuth consent screen is created and the specific Google Drive scopes are added.

## 4. Workspace Marketplace SDK
Ask the user to configure the Workspace Add-on marketplace listing in the Google Cloud Console.
1. Navigate to **APIs & Services > Library** and enable the **Google Workspace Marketplace SDK**.
2. Open the SDK configuration and complete the **App Configuration** tab.
3. Select **Google Workspace Add-on** and set it to use **Alternate Runtime**.
4. Set the Alternate Runtime URL to the deployed Cloud Run service URL.
5. Provide the email for the dedicated invoker service account (e.g., `addon-invoker@...`).
6. Complete the **Store Listing** tab and install the app using the "Test App" link.

**Completion criterion:** User confirms the Marketplace SDK App Configuration is fully configured and the test app is installed in their Google Drive.
