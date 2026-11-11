// GitHub App authentication: a JWT signed with the App's private key,
// exchanged for an installation token scoped to one repository.

import { createPrivateKey, sign } from 'node:crypto';
import { createClient } from './github.mjs';

// The permissions the check needs. The token asks for no more.
export const APP_PERMISSIONS = { checks: 'write', contents: 'read', pull_requests: 'read' };

const b64url = (data) => Buffer.from(data).toString('base64url');

// appJwt returns an RS256 JWT for the App, valid for nine minutes. It
// is backdated a minute to allow for clock drift, as GitHub suggests.
export function appJwt(appId, privateKey, now = Date.now()) {
  const iss = String(appId ?? '').trim();
  if (!/^[1-9]\d*$/.test(iss)) throw new Error('app_id must be a numeric GitHub App id');
  let key;
  try {
    // Secrets pasted on one line sometimes carry literal "\n"s.
    key = createPrivateKey(String(privateKey ?? '').replace(/\\n/g, '\n').trim());
  } catch {
    // The error from node may quote the input, so it is not passed on.
    throw new Error('private_key is not a PEM private key');
  }
  if (key.asymmetricKeyType !== 'rsa') throw new Error('private_key must be an RSA key');
  const iat = Math.floor(now / 1000) - 60;
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify({ iat, exp: iat + 600, iss }));
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), key);
  return `${header}.${payload}.${b64url(signature)}`;
}

// installationToken mints a token for the App's installation on repo.
// It returns the token and the App's slug and bot login.
export async function installationToken({ appId, privateKey, repo, apiUrl, fetch, now }) {
  const jwt = appJwt(appId, privateKey, now);
  const app = createClient({ token: jwt, apiUrl, fetch });
  const info = await app.request('GET', '/app');
  if (!info?.slug) throw new Error('GET /app returned no slug');
  const installation = await app.request('GET', `/repos/${repo}/installation`);
  if (!Number.isInteger(installation?.id)) throw new Error(`the App is not installed on ${repo}`);
  const minted = await app.request('POST', `/app/installations/${installation.id}/access_tokens`, {
    body: { repositories: [repo.split('/')[1]], permissions: APP_PERMISSIONS },
  });
  if (typeof minted?.token !== 'string' || !minted.token) throw new Error('GitHub returned no installation token');
  return { token: minted.token, slug: info.slug, login: `${info.slug}[bot]` };
}
