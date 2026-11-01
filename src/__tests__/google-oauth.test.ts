import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import * as http from 'node:http';
import { loginGoogleAccount, GOOGLE_AUTHORIZATION_URL, GOOGLE_TOKEN_URL } from '../googleOAuth';

const clientId = 'unit-test-client.apps.googleusercontent.com';
const tokenResponse = { access_token: 'test-access', refresh_token: 'test-refresh', expires_in: 120 };
function request(url: string, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => resolve({ status: res.statusCode || 0, body }));
    });
    req.on('error', reject);
    req.setTimeout(1000, () => req.destroy(new Error('Test callback timeout')));
    req.end();
  });
}
function makeAttempt(
  options: Parameters<typeof loginGoogleAccount>[0] = { clientId },
  exchange = vi.fn(async () => tokenResponse),
) {
  let opened!: (value: URL) => void;
  const authorization = new Promise<URL>((done) => (opened = done));
  const openExternal = vi.fn(async (url: string) => {
    opened(new URL(url));
  });
  const result = loginGoogleAccount(options, openExternal, { exchangeToken: exchange, now: () => 1000000 });
  // Failure cases must have a rejection handler before triggering abort/denial.
  void result.catch(() => {});
  return { authorization, result, exchange, openExternal };
}
function callback(authorization: URL, params: Record<string, string> = {}): string {
  const url = new URL(authorization.searchParams.get('redirect_uri')!);
  url.search = new URLSearchParams({
    code: 'test-code',
    state: authorization.searchParams.get('state')!,
    ...params,
  }).toString();
  return url.toString();
}

describe('explicit Google desktop OAuth', () => {
  it('uses official endpoints, a random loopback port, state and PKCE without exposing tokens to the browser', async () => {
    const attempt = makeAttempt({ clientId, clientSecret: 'test-client-secret', label: 'Personal' });
    const auth = await attempt.authorization;
    expect(`${auth.origin}${auth.pathname}`).toBe(GOOGLE_AUTHORIZATION_URL);
    expect(GOOGLE_TOKEN_URL).toBe('https://oauth2.googleapis.com/token');
    expect(auth.searchParams.get('client_id')).toBe(clientId);
    expect(auth.searchParams.has('client_secret')).toBe(false);
    expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
    expect(auth.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const redirect = new URL(auth.searchParams.get('redirect_uri')!);
    expect(redirect.hostname).toBe('127.0.0.1');
    expect(Number(redirect.port)).toBeGreaterThan(0);
    expect(redirect.pathname).toBe('/oauth2callback');
    const response = await request(callback(auth));
    expect(response.status).toBe(200);
    expect(response.body).not.toContain('test-access');
    expect(response.body).not.toContain('test-refresh');
    const parameters = attempt.exchange.mock.calls[0][0] as URLSearchParams;
    expect(parameters.get('client_secret')).toBe('test-client-secret');
    expect(parameters.get('code')).toBe('test-code');
    expect(parameters.get('redirect_uri')).toBe(redirect.toString());
    expect(parameters.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(createHash('sha256').update(parameters.get('code_verifier')!).digest('base64url')).toBe(
      auth.searchParams.get('code_challenge'),
    );
    expect(await attempt.result).toMatchObject({
      accessToken: 'test-access',
      refreshToken: 'test-refresh',
      expiresAt: 1120000,
      clientId,
      clientSecret: 'test-client-secret',
      label: 'Personal',
    });
  });

  it('rejects wrong and malformed state without consuming the valid login attempt', async () => {
    const attempt = makeAttempt();
    const auth = await attempt.authorization;
    expect((await request(callback(auth, { state: 'wrong' }))).status).toBe(400);
    expect((await request(callback(auth, { state: 'é'.repeat(43) }))).status).toBe(400);
    const duplicate = callback(auth) + '&state=duplicate';
    expect((await request(duplicate)).status).toBe(400);
    expect(attempt.exchange).not.toHaveBeenCalled();
    expect((await request(callback(auth))).status).toBe(200);
    await attempt.result;
    expect(attempt.exchange).toHaveBeenCalledOnce();
  });

  it('handles consent denial without exchanging a token', async () => {
    const attempt = makeAttempt();
    const auth = await attempt.authorization;
    expect((await request(callback(auth, { error: 'access_denied' }))).status).toBe(400);
    await expect(attempt.result).rejects.toThrow('denied or cancelled');
    expect(attempt.exchange).not.toHaveBeenCalled();
    await expect(request(callback(auth))).rejects.toThrow();
  });

  it('closes the listener on timeout and on explicit cancellation', async () => {
    const timed = makeAttempt({ clientId, timeoutMs: 100 });
    const timedAuth = await timed.authorization;
    await expect(timed.result).rejects.toThrow('timed out');
    await expect(request(callback(timedAuth))).rejects.toThrow();
    const controller = new AbortController();
    const cancelled = makeAttempt({ clientId, signal: controller.signal });
    const cancelAuth = await cancelled.authorization;
    controller.abort();
    await expect(cancelled.result).rejects.toMatchObject({ name: 'AbortError' });
    await expect(request(callback(cancelAuth))).rejects.toThrow();
  });

  it('does not open a browser for invalid or already-cancelled inputs', async () => {
    const openExternal = vi.fn();
    await expect(loginGoogleAccount({ clientId: '' }, openExternal)).rejects.toThrow('client ID');
    await expect(loginGoogleAccount({ clientId: 'https://other.example' }, openExternal)).rejects.toThrow('client ID');
    const controller = new AbortController();
    controller.abort();
    await expect(loginGoogleAccount({ clientId, signal: controller.signal }, openExternal)).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('cleans up when the browser cannot be opened', async () => {
    let auth: URL | undefined;
    await expect(
      loginGoogleAccount({ clientId }, async (url) => {
        auth = new URL(url);
        throw new Error('Cannot launch');
      }),
    ).rejects.toThrow('Could not open the browser');
    await expect(request(callback(auth!))).rejects.toThrow();
  });

  it('cancels an in-flight exchange and rejects duplicate callbacks', async () => {
    const controller = new AbortController();
    let exchangeSignal: AbortSignal | undefined;
    const exchange = vi.fn(
      (_parameters: URLSearchParams, signal: AbortSignal) =>
        new Promise<typeof tokenResponse>((_resolve, reject) => {
          exchangeSignal = signal;
          signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
    );
    const attempt = makeAttempt({ clientId, signal: controller.signal }, exchange);
    const auth = await attempt.authorization;
    const first = request(callback(auth));
    await vi.waitFor(() => expect(exchange).toHaveBeenCalledOnce());
    expect((await request(callback(auth))).status).toBe(409);
    controller.abort();
    await expect(attempt.result).rejects.toMatchObject({ name: 'AbortError' });
    expect(exchangeSignal?.aborted).toBe(true);
    expect((await first).status).toBe(502);
  });
});
