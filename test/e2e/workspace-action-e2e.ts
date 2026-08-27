import * as fs from 'node:fs';
import * as path from 'node:path';
import { OAuth2Client } from 'google-auth-library';
import { createApp } from '../../src/app/server';

function loadEnvFile(): void {
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    if (typeof process.loadEnvFile === 'function') {
      process.loadEnvFile(envPath);
    } else {
      const content = fs.readFileSync(envPath, 'utf-8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const [key, ...values] = trimmed.split('=');
          process.env[key.trim()] = values.join('=').trim();
        }
      }
    }
  }
}

async function runE2E(): Promise<void> {
  loadEnvFile();

  const clientId = process.env.GOOGLE_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  const refreshToken = process.env.GOOGLE_REFRESH_TOKEN;
  let accessToken = process.env.GOOGLE_ACCESS_TOKEN;
  const targetFileId = process.env.TEST_DRIVE_FILE_ID;

  console.log('--- Workspace-to-Drive E2E Synthetic Test Runner ---');

  if (!accessToken && (!clientId || !clientSecret || !refreshToken)) {
    console.log(
      'Notice: Live Google OAuth credentials not found in environment or .env file.\n' +
        'To run against live Google Drive API:\n' +
        '  1. Copy .env.example to .env\n' +
        '  2. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, and GOOGLE_REFRESH_TOKEN (or GOOGLE_ACCESS_TOKEN)\n' +
        '  3. Re-run: npx tsx test/e2e/workspace-action-e2e.ts\n'
    );
    console.log('Running dry-run verification with synthetic in-memory app...');
  }

  if (!accessToken && clientId && clientSecret && refreshToken) {
    console.log('Minting user OAuth access token using refresh token...');
    const oauth2Client = new OAuth2Client(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });
    const tokenResponse = await oauth2Client.getAccessToken();
    if (!tokenResponse.token) {
      throw new Error('Failed to retrieve access token from Google OAuth');
    }
    accessToken = tokenResponse.token;
    console.log('Successfully minted OAuth access token.');
  }

  const manifestPath =
    process.env.APP_MANIFEST_PATH ?? path.resolve(process.cwd(), 'test/fixtures/manifest.json');
  
  const app = createApp({
    manifestPath,
    logger: false,
    authVerifier: {
      verifyToken: async () => ({
        isValid: true,
        payload: { email: 'e2e-tester@example.com' },
      }),
    },
    driveService: {
      getFile: async (fileId) => ({
        id: fileId,
        name: 'E2E_Test_Document.pdf',
        parents: ['root'],
      }),
      findOrCreateFolder: async () => ({
        id: 'mock-testmove-folder-id',
        name: '!TestMove',
        parents: ['root'],
      }),
      moveFile: async (fileId) => ({
        id: fileId,
        name: 'E2E_Test_Document.pdf',
        parents: ['mock-testmove-folder-id'],
      }),
    },
  });

  await app.initialize();

  const fileId = targetFileId || 'e2e-synthetic-file-id';
  const fileName = 'E2E_Test_Document.pdf';

  console.log(`Sending synthetic HTTP POST to /workspace/action for fileId: ${fileId}...`);

  const response = await app.server.inject({
    method: 'POST',
    url: '/workspace/action',
    headers: {
      authorization: 'Bearer synthetic-e2e-token',
    },
    payload: {
      authorizationEventObject: {
        userOAuthToken: accessToken ?? 'mock-access-token',
      },
      commonEventObject: {
        hostApp: 'DRIVE',
        platform: 'WEB',
      },
      drive: {
        selectedItems: [
          {
            id: fileId,
            title: fileName,
            mimeType: 'application/pdf',
          },
        ],
      },
      record: {
        type: 'test-record',
        data: {
          title: fileName,
        },
      },
    },
  });

  console.log(`Response Status: ${response.statusCode}`);
  console.log(`Response Payload: ${response.payload}`);

  if (response.statusCode === 200) {
    console.log('✅ E2E Synthetic Test Successful!');
  } else {
    console.error('❌ E2E Test Failed with non-200 status code.');
    process.exit(1);
  }
}

if (require.main === module) {
  runE2E().catch((err) => {
    console.error('E2E Execution Error:', err);
    process.exit(1);
  });
}
