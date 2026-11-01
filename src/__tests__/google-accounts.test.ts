import { afterEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import {
  acquireGoogleAccount,
  configureGoogleAccountPersistence,
  fetchGoogleQuota,
  fetchGoogleModels,
  getGooglePoolStatus,
  refreshGoogleAccount,
  resetGoogleAccountState,
  type GoogleAccount,
} from '../googleAccounts';

const servers: http.Server[] = [];
afterEach(async () => {
  configureGoogleAccountPersistence(undefined);
  resetGoogleAccountState();
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.closeAllConnections();
          server.close(() => resolve());
        }),
    ),
  );
});
async function serve(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
function account(id: string): GoogleAccount {
  return { id, label: id, accessToken: `access-${id}`, expiresAt: Date.now() + 3_600_000 };
}

describe('Google OAuth with user-provided app credentials', () => {
  it('refreshes expired tokens once, coalesces simultaneous refreshes and persists rotated credentials through the injected callback', async () => {
    let calls = 0;
    let params: URLSearchParams;
    const endpoint = await serve(async (req, res) => {
      calls++;
      let data = '';
      for await (const chunk of req) data += chunk;
      params = new URLSearchParams(data);
      res.end(JSON.stringify({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600 }));
    });
    const original = {
      id: 'refresh',
      clientId: 'user-owned-oauth-app',
      clientSecret: 'user-owned-secret',
      refreshToken: 'refresh-token',
      expiresAt: 1,
    };
    const [first, second] = await Promise.all([
      refreshGoogleAccount(original, endpoint),
      refreshGoogleAccount(original, endpoint),
    ]);
    expect(calls).toBe(1);
    expect(first).toEqual(second);
    expect(first.accessToken).toBe('new-access');
    expect(params!.get('client_id')).toBe('user-owned-oauth-app');
    expect(params!.get('client_secret')).toBe('user-owned-secret');
    expect(params!.get('grant_type')).toBe('refresh_token');
    const persist = vi.fn();
    configureGoogleAccountPersistence(persist);
    const lease = await acquireGoogleAccount('models/google', [original]);
    expect(persist).toHaveBeenCalledWith(
      'models/google',
      expect.objectContaining({ refreshToken: 'rotated-refresh' }),
      original,
    );
    lease.release();
  });

  it('does not require a client secret for public OAuth apps and refuses credential redirects to third parties', async () => {
    const endpoint = await serve(async (req, res) => {
      let data = '';
      for await (const chunk of req) data += chunk;
      expect(new URLSearchParams(data).has('client_secret')).toBe(false);
      res.end(JSON.stringify({ access_token: 'new-access', expires_in: 3600 }));
    });
    await expect(
      refreshGoogleAccount({ id: 'public', clientId: 'public-app', refreshToken: 'token' }, endpoint),
    ).resolves.toHaveProperty('accessToken');
    await expect(
      refreshGoogleAccount({ id: 'bad-host', clientId: 'app', refreshToken: 'token' }, 'https://example.com/token'),
    ).rejects.toThrow(/official service/);
  });

  it('reports revoked credentials without returning upstream bodies or secret values', async () => {
    const endpoint = await serve((_req, res) => {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'invalid_grant', error_description: 'sensitive-token-value' }));
    });
    await expect(
      refreshGoogleAccount({ id: 'revoked', clientId: 'app', refreshToken: 'sensitive-token-value' }, endpoint),
    ).rejects.toMatchObject({
      status: 401,
      message: 'Google rejected these OAuth credentials; reconnect this account.',
    });
    await expect(refreshGoogleAccount({ id: 'missing-app', refreshToken: 'token' }, endpoint)).rejects.toThrow(
      /OAuth client ID/,
    );
  });
});

describe('Google account selection and quota', () => {
  it('discovers authenticated Cloud Code models with the account project and returns only IDs and labels', async () => {
    const endpoint = await serve(async (req, res) => {
      expect(req.url).toBe('/v1internal:fetchAvailableModels');
      expect(req.method).toBe('POST');
      expect(req.headers.authorization).toBe('Bearer access-discovery');
      let raw = '';
      for await (const chunk of req) raw += chunk;
      expect(JSON.parse(raw)).toEqual({ project: 'project-id' });
      res.end(
        JSON.stringify({
          models: {
            'gemini-custom': { displayName: 'Gemini Custom', model: 'MODEL_ENUM', secret: 'private' },
            invalid: null,
          },
        }),
      );
    });
    await expect(fetchGoogleModels({ ...account('discovery'), project: 'project-id' }, endpoint)).resolves.toEqual([
      { id: 'gemini-custom', displayName: 'Gemini Custom' },
    ]);
  });
  it('round robins healthy accounts and respects per-account concurrency limits', async () => {
    const accounts = [account('a'), account('b')];
    const first = await acquireGoogleAccount('models/test', accounts, { maxConcurrency: 1 });
    const second = await acquireGoogleAccount('models/test', accounts, { maxConcurrency: 1 });
    expect(first.account.id).toBe('a');
    expect(second.account.id).toBe('b');
    await expect(acquireGoogleAccount('models/test', accounts, { maxConcurrency: 1 })).rejects.toThrow(/concurrency/);
    first.release();
    second.release();
    expect(getGooglePoolStatus().every((state) => state.inFlight === 0)).toBe(true);
    expect(JSON.stringify(getGooglePoolStatus())).not.toContain('access-');
  });

  it('retains explicit conversation identity and excludes accounts requiring reauthentication', async () => {
    const accounts = [account('sticky-a'), account('sticky-b')];
    const first = await acquireGoogleAccount('models/test', accounts, {}, 'conversation');
    first.release();
    const second = await acquireGoogleAccount('models/test', accounts, {}, 'conversation');
    expect(second.account.id).toBe(first.account.id);
    second.release({ status: 401 });
    const third = await acquireGoogleAccount('models/test', accounts, {}, 'conversation');
    expect(third.account.id).not.toBe(first.account.id);
    third.release();
    expect(getGooglePoolStatus()).toContainEqual(
      expect.objectContaining({ id: first.account.id, status: 'unauthorized' }),
    );
  });

  it('shares account capacity across different models and rotated credential values', async () => {
    const first = await acquireGoogleAccount('models/first', [account('shared')], { maxConcurrency: 1 });
    await expect(
      acquireGoogleAccount('models/second', [{ ...account('shared'), accessToken: 'rotated-access' }], {
        maxConcurrency: 1,
      }),
    ).rejects.toThrow(/concurrency/);
    first.release();
    const second = await acquireGoogleAccount(
      'models/second',
      [{ ...account('shared'), accessToken: 'rotated-access' }],
      { maxConcurrency: 1 },
    );
    second.release();
    expect(getGooglePoolStatus().filter((state) => state.id === 'shared')).toHaveLength(1);
  });

  it('cooldowns rate-limited accounts, recovers after the interval, and skips disabled accounts', async () => {
    const accounts = [account('cooling'), { ...account('disabled'), enabled: false }];
    const lease = await acquireGoogleAccount('models/test', accounts, { cooldownMs: 20 });
    lease.release({ status: 429 });
    await expect(acquireGoogleAccount('models/test', accounts)).rejects.toThrow(/eligible/);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const recovered = await acquireGoogleAccount('models/test', accounts);
    expect(recovered.account.id).toBe('cooling');
    recovered.release();
  });

  it('uses measured quotas for quota-aware selection and preserves unknown quota as unknown', async () => {
    const endpoint = await serve((req, res) => {
      expect(req.url).toBe('/v1internal:retrieveUserQuotaSummary');
      const fraction = req.headers.authorization === 'Bearer access-quota-a' ? 0.2 : 0.8;
      res.end(
        JSON.stringify({
          groups: [{ buckets: [{ bucketId: '5h', remainingFraction: fraction, resetTime: '2026-10-01T00:00:00Z' }] }],
        }),
      );
    });
    const accounts = [account('quota-a'), account('quota-b')];
    await Promise.all(accounts.map((entry) => fetchGoogleQuota(entry, endpoint)));
    const lease = await acquireGoogleAccount('models/test', accounts, { strategy: 'quota' });
    expect(lease.account.id).toBe('quota-b');
    lease.release();
    const empty = await serve((_req, res) => res.end('{}'));
    const result = await fetchGoogleQuota(account('unknown'), empty);
    expect(result.remainingFraction).toBeUndefined();
    expect(result.buckets).toEqual([]);
    await expect(fetchGoogleQuota(account('bad-host'), 'https://example.com')).rejects.toThrow(/official service/);
  });
});
