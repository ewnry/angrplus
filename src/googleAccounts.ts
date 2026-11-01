/** Google Cloud Code account pools. OAuth applications and credentials are supplied by the user. */
import * as http from 'http';
import * as https from 'https';
import { createHash } from 'crypto';

export interface GoogleAccount {
  id: string;
  label?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  clientId?: string;
  clientSecret?: string;
  project?: string;
  enabled?: boolean;
}
export interface GooglePoolOptions {
  strategy?: 'round-robin' | 'least-loaded' | 'quota';
  maxConcurrency?: number;
  cooldownMs?: number;
}
export interface GoogleQuotaSnapshot {
  accountId: string;
  checkedAt: number;
  remainingFraction?: number;
  buckets: { id: string; remainingFraction?: number; resetTime?: string }[];
}
interface PoolState {
  id: string;
  label?: string;
  inFlight: number;
  lastUsed: number;
  cooldownUntil: number;
  authState?: 'unauthorized' | 'forbidden';
  quota?: GoogleQuotaSnapshot;
}
export interface GoogleAccountLease {
  account: GoogleAccount;
  release(result?: { status?: number; retryAfterMs?: number }): void;
}
export class GoogleAccountError extends Error {
  constructor(
    message: string,
    readonly status = 503,
  ) {
    super(message);
  }
}

const tokenCache = new Map<string, GoogleAccount>();
const refreshing = new Map<string, Promise<GoogleAccount>>();
const poolStates = new Map<string, PoolState>();
const sticky = new Map<string, { accountKey: string; at: number }>();
let selectionOrder = 0;
let persistAccount:
  | ((modelName: string, account: GoogleAccount, previousAccount: GoogleAccount) => Promise<void> | void)
  | undefined;

export function configureGoogleAccountPersistence(callback?: typeof persistAccount): void {
  persistAccount = callback;
}
function accountKey(account: GoogleAccount): string {
  return createHash('sha256')
    .update(JSON.stringify([account.id, account.clientId, account.refreshToken || account.accessToken]))
    .digest('hex');
}
function poolKey(account: GoogleAccount): string {
  // Account IDs survive refreshed/rotated credentials, so parallel models share one capacity limit.
  return createHash('sha256')
    .update(JSON.stringify([account.id, account.clientId]))
    .digest('hex');
}
function stateFor(account: GoogleAccount): PoolState {
  const key = poolKey(account);
  let state = poolStates.get(key);
  if (!state) {
    state = { id: account.id, label: account.label, inFlight: 0, lastUsed: 0, cooldownUntil: 0 };
    poolStates.set(key, state);
  }
  return state;
}
function validAccess(account: GoogleAccount): boolean {
  return (
    !!account.accessToken &&
    !/^(enc:|fallback:|local-gcm:|DECRYPTION_FAILED)/.test(account.accessToken) &&
    (!account.expiresAt || account.expiresAt > Date.now() + 60_000)
  );
}
function checkedEndpoint(value: string, hosts: string[]): URL {
  const url = new URL(value);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    (!local && (url.protocol !== 'https:' || !hosts.includes(url.hostname))) ||
    url.username ||
    url.password
  ) {
    throw new GoogleAccountError('Google credentials may only be sent to the configured official service.', 400);
  }
  return url;
}

async function postJson(
  url: URL,
  headers: http.OutgoingHttpHeaders,
  body: string,
): Promise<{ status: number; data: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(
      url,
      { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(body) } },
      (response) => {
        let bytes = 0;
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > 2 * 1024 * 1024)
            request.destroy(new GoogleAccountError('Google account response is too large.', 502));
          else chunks.push(chunk);
        });
        response.on('error', () => reject(new GoogleAccountError('Google account response was interrupted.', 502)));
        response.on('end', () => {
          try {
            resolve({ status: response.statusCode || 502, data: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
          } catch {
            reject(new GoogleAccountError('Google account service returned invalid JSON.', 502));
          }
        });
      },
    );
    const timeout = setTimeout(
      () => request.destroy(new GoogleAccountError('Google account request timed out.', 504)),
      10_000,
    );
    request.once('close', () => clearTimeout(timeout));
    request.once('error', (error) =>
      reject(
        error instanceof GoogleAccountError
          ? error
          : new GoogleAccountError('Google account service could not be reached.', 502),
      ),
    );
    request.end(body);
  });
}

/** Refresh requests are coalesced and cached. Endpoint override is restricted to localhost fixtures. */
export async function refreshGoogleAccount(
  account: GoogleAccount,
  tokenEndpointOverride = 'https://oauth2.googleapis.com/token',
): Promise<GoogleAccount> {
  for (const [key, cached] of tokenCache) if (cached.expiresAt && cached.expiresAt < Date.now()) tokenCache.delete(key);
  const key = accountKey(account);
  const cached = tokenCache.get(key);
  if (cached && validAccess(cached))
    return {
      ...account,
      accessToken: cached.accessToken,
      refreshToken: cached.refreshToken,
      expiresAt: cached.expiresAt,
    };
  if (validAccess(account)) return { ...account };
  if (
    !account.refreshToken ||
    !account.clientId ||
    /^(enc:|fallback:|local-gcm:|DECRYPTION_FAILED)/.test(account.refreshToken)
  ) {
    throw new GoogleAccountError(
      'This account requires a valid access token or a refresh token and your OAuth client ID.',
      401,
    );
  }
  const active = refreshing.get(key);
  if (active) return active;
  const refresh = (async () => {
    const endpoint = checkedEndpoint(tokenEndpointOverride, ['oauth2.googleapis.com']);
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken!,
      client_id: account.clientId!,
    });
    if (account.clientSecret) body.set('client_secret', account.clientSecret);
    const { status, data } = await postJson(
      endpoint,
      { 'Content-Type': 'application/x-www-form-urlencoded' },
      body.toString(),
    );
    if (status < 200 || status >= 300 || typeof data.access_token !== 'string' || !data.access_token) {
      const invalidGrant = data.error === 'invalid_grant' || data.error === 'invalid_client';
      throw new GoogleAccountError(
        invalidGrant
          ? 'Google rejected these OAuth credentials; reconnect this account.'
          : `Google OAuth returned HTTP ${status}.`,
        invalidGrant ? 401 : status >= 400 ? status : 502,
      );
    }
    const expiresIn = typeof data.expires_in === 'number' && data.expires_in > 0 ? data.expires_in : 3600;
    const updated = { ...account, accessToken: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    if (typeof data.refresh_token === 'string' && data.refresh_token) updated.refreshToken = data.refresh_token;
    tokenCache.set(key, updated);
    tokenCache.set(accountKey(updated), updated);
    return updated;
  })().finally(() => refreshing.delete(key));
  refreshing.set(key, refresh);
  return refresh;
}

/** Explicit quota refresh; never infers subscription eligibility or fabricates an available quota. */
export async function fetchGoogleQuota(
  account: GoogleAccount,
  baseURL = 'https://daily-cloudcode-pa.googleapis.com',
): Promise<GoogleQuotaSnapshot> {
  const endpoint = checkedEndpoint(baseURL, ['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com']);
  endpoint.pathname = '/v1internal:retrieveUserQuotaSummary';
  endpoint.search = '';
  const current = await refreshGoogleAccount(account);
  const { status, data } = await postJson(
    endpoint,
    { 'Content-Type': 'application/json', Authorization: `Bearer ${current.accessToken}` },
    JSON.stringify(account.project ? { project: account.project } : {}),
  );
  if (status < 200 || status >= 300)
    throw new GoogleAccountError(`Google quota service returned HTTP ${status}.`, status);
  const buckets: GoogleQuotaSnapshot['buckets'] = [];
  const groups = Array.isArray(data.groups) ? data.groups : [{ buckets: data.buckets }];
  for (const group of groups) {
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      if (!bucket || typeof bucket !== 'object') continue;
      buckets.push({
        id: typeof bucket.bucketId === 'string' ? bucket.bucketId : typeof bucket.id === 'string' ? bucket.id : 'quota',
        remainingFraction:
          typeof bucket.remainingFraction === 'number' ? Math.max(0, Math.min(1, bucket.remainingFraction)) : undefined,
        resetTime: typeof bucket.resetTime === 'string' ? bucket.resetTime : undefined,
      });
    }
  }
  const remaining = buckets.flatMap((bucket) =>
    bucket.remainingFraction === undefined ? [] : [bucket.remainingFraction],
  );
  const snapshot: GoogleQuotaSnapshot = {
    accountId: account.id,
    checkedAt: Date.now(),
    buckets,
    remainingFraction: remaining.length ? Math.min(...remaining) : undefined,
  };
  stateFor(account).quota = snapshot;
  return snapshot;
}

/** Discover only the models returned for this authenticated account/project. */
export async function fetchGoogleModels(
  account: GoogleAccount,
  baseURL = 'https://daily-cloudcode-pa.googleapis.com',
): Promise<{ id: string; displayName: string }[]> {
  const endpoint = checkedEndpoint(baseURL, ['daily-cloudcode-pa.googleapis.com', 'cloudcode-pa.googleapis.com']);
  endpoint.pathname = '/v1internal:fetchAvailableModels';
  endpoint.search = '';
  const current = await refreshGoogleAccount(account);
  const { status, data } = await postJson(
    endpoint,
    { 'Content-Type': 'application/json', Authorization: `Bearer ${current.accessToken}` },
    JSON.stringify(current.project ? { project: current.project } : {}),
  );
  if (status < 200 || status >= 300)
    throw new GoogleAccountError(`Google model discovery returned HTTP ${status}.`, status);
  const models = data.models || data.availableModels || data.available_models;
  if (!models || typeof models !== 'object')
    throw new GoogleAccountError('Google did not return an available model list.', 502);
  const entries = Array.isArray(models) ? models.map((value) => ['', value] as const) : Object.entries(models);
  const found = new Map<string, { id: string; displayName: string }>();
  for (const [key, value] of entries) {
    if (!value || typeof value !== 'object') continue;
    const model = value as Record<string, unknown>;
    const candidate = model.id || model.name || key || model.modelId || model.model;
    if (typeof candidate !== 'string' || !candidate) continue;
    const id = candidate.replace(/^models\//, '');
    const displayName = typeof model.displayName === 'string' ? model.displayName : id;
    found.set(id, { id, displayName });
  }
  return [...found.values()];
}

export async function acquireGoogleAccount(
  modelName: string,
  accounts: GoogleAccount[],
  options: GooglePoolOptions = {},
  requestIdentity?: string,
): Promise<GoogleAccountLease> {
  const attempted = new Set<string>();
  const identityKey = requestIdentity
    ? createHash('sha256').update(`${modelName}\0${requestIdentity}`).digest('hex')
    : undefined;
  for (const [key, entry] of sticky) if (Date.now() - entry.at > 3_600_000) sticky.delete(key);
  if (sticky.size > 2000) sticky.delete(sticky.keys().next().value!);
  while (attempted.size < accounts.length) {
    const now = Date.now();
    let candidates = accounts.filter((account) => {
      const state = stateFor(account);
      return (
        account.enabled !== false &&
        !attempted.has(poolKey(account)) &&
        !state.authState &&
        state.cooldownUntil <= now &&
        state.inFlight < (options.maxConcurrency ?? 2)
      );
    });
    candidates = candidates.sort((left, right) => {
      const a = stateFor(left),
        b = stateFor(right);
      if (options.strategy === 'least-loaded' && a.inFlight !== b.inFlight) return a.inFlight - b.inFlight;
      if (options.strategy === 'quota') {
        const qa = a.quota?.remainingFraction ?? 0.5,
          qb = b.quota?.remainingFraction ?? 0.5;
        if (qa !== qb) return qb - qa;
      }
      return a.lastUsed - b.lastUsed;
    });
    const stick = identityKey ? sticky.get(identityKey) : undefined;
    const selected = candidates.find((account) => poolKey(account) === stick?.accountKey) || candidates[0];
    if (!selected)
      throw new GoogleAccountError(
        'No Google account is currently eligible: check authentication, cooldown and concurrency limits.',
        503,
      );
    const key = poolKey(selected),
      state = stateFor(selected);
    attempted.add(key);
    state.inFlight += 1;
    state.lastUsed = ++selectionOrder;
    try {
      const updated = await refreshGoogleAccount(selected);
      if (
        updated.accessToken !== selected.accessToken ||
        updated.refreshToken !== selected.refreshToken ||
        updated.expiresAt !== selected.expiresAt
      ) {
        await persistAccount?.(modelName, updated, selected);
      }
      if (identityKey) sticky.set(identityKey, { accountKey: key, at: Date.now() });
      let released = false;
      return {
        account: updated,
        release(result = {}) {
          if (released) return;
          released = true;
          state.inFlight = Math.max(0, state.inFlight - 1);
          if (result.status === 401 || result.status === 403) {
            state.authState = result.status === 401 ? 'unauthorized' : 'forbidden';
            tokenCache.delete(accountKey(selected));
            tokenCache.delete(accountKey(updated));
          } else if (result.status === 429 || (result.status && result.status >= 500)) {
            state.cooldownUntil = Date.now() + Math.max(result.retryAfterMs || 0, options.cooldownMs ?? 60_000);
          }
        },
      };
    } catch (error) {
      state.inFlight = Math.max(0, state.inFlight - 1);
      if (error instanceof GoogleAccountError && [401, 403].includes(error.status))
        state.authState = error.status === 401 ? 'unauthorized' : 'forbidden';
      else state.cooldownUntil = Date.now() + (options.cooldownMs ?? 60_000);
    }
  }
  throw new GoogleAccountError(
    'No Google account could authenticate; reconnect an account or check its OAuth client configuration.',
    401,
  );
}

export function getGooglePoolStatus() {
  return [...poolStates.values()].map((state) => ({
    id: state.id,
    label: state.label,
    inFlight: state.inFlight,
    status: state.authState || (state.cooldownUntil > Date.now() ? 'cooldown' : 'ready'),
    cooldownUntil: state.cooldownUntil,
    quota: state.quota,
  }));
}

/** Clear volatile account state after explicit account edits or sign-in. */
export function resetGoogleAccountState(id?: string): void {
  for (const [key, state] of poolStates) if (!id || state.id === id) poolStates.delete(key);
  for (const [key, account] of tokenCache) if (!id || account.id === id) tokenCache.delete(key);
  if (!id) {
    tokenCache.clear();
    sticky.clear();
  }
}
