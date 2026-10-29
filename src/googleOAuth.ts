
import * as http from 'node:http';
import * as https from 'node:https';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';

export const GOOGLE_AUTHORIZATION_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPES = 'openid email profile https://www.googleapis.com/auth/cloud-platform';

export interface GoogleLoginOptions {
  clientId: string;
  clientSecret?: string;
  label?: string;
  scope?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}
export interface GoogleLoginAccount {
  id: string;
  label?: string;
  email?: string;
  name?: string;
  picture?: string;
  idToken?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  clientId: string;
  clientSecret?: string;
}
interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
}
export interface GoogleOAuthDependencies {

  exchangeToken?: (parameters: URLSearchParams, signal: AbortSignal) => Promise<TokenResponse>;
  now?: () => number;
}

function cancellation(message = 'Google login cancelled'): Error {
  return Object.assign(new Error(message), { name: 'AbortError' });
}

function exchangeToken(parameters: URLSearchParams, signal: AbortSignal): Promise<TokenResponse> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(cancellation());
      return;
    }
    const body = parameters.toString();
    let settled = false;
    const finish = (error?: Error, value?: TokenResponse) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value!);
    };
    const req = https.request(
      GOOGLE_TOKEN_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
          Accept: 'application/json',
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 256 * 1024) {
            finish(new Error('Google token response exceeded the size limit'));
            res.destroy();
            req.destroy();
          } else chunks.push(chunk);
        });
        res.on('aborted', () => finish(new Error('Google token exchange ended unexpectedly')));
        res.on('error', () => finish(new Error('Google token exchange failed')));
        res.on('end', () => {
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            const rawBody = Buffer.concat(chunks).toString('utf8');
            let errorDetail = '';
            try {
              const parsed = JSON.parse(rawBody);
              errorDetail = parsed.error_description || parsed.error || rawBody;
            } catch {
              errorDetail = rawBody;
            }
            console.error('[Google OAuth Token Error]', res.statusCode, rawBody);
            finish(
              new Error(
                `Google token exchange failed (HTTP ${res.statusCode || 0}): ${errorDetail || 'Check your OAuth client configuration.'}`,
              ),
            );
            return;
          }
          try {
            const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as TokenResponse;
            if (typeof value.access_token !== 'string' || !value.access_token || value.access_token.length > 16384)
              throw new Error();
            if (
              value.refresh_token !== undefined &&
              (typeof value.refresh_token !== 'string' || value.refresh_token.length > 16384)
            )
              throw new Error();
            if (
              value.id_token !== undefined &&
              (typeof value.id_token !== 'string' || value.id_token.length > 65536)
            )
              throw new Error();
            finish(undefined, value);
          } catch {
            finish(new Error('Google returned an invalid token response'));
          }
        });
      },
    );
    const abort = () => {
      finish(cancellation());
      req.destroy();
    };
    signal.addEventListener('abort', abort, { once: true });
    req.on('error', () => finish(new Error('Could not connect to Google to complete login')));
    req.setTimeout(30000, () => {
      finish(new Error('Google token exchange timed out'));
      req.destroy();
    });
    req.end(body);
  });
}


export async function loginGoogleAccount(
  options: GoogleLoginOptions,
  openExternal: (url: string) => Promise<unknown>,
  dependencies: GoogleOAuthDependencies = {},
): Promise<GoogleLoginAccount> {
  const clientId = options.clientId?.trim();
  const clientSecret = options.clientSecret?.trim();
  if (!clientId || !/^[A-Za-z0-9_.-]+\.apps\.googleusercontent\.com$/.test(clientId) || clientId.length > 512) {
    throw new Error('Enter your Google Desktop OAuth client ID (.apps.googleusercontent.com).');
  }
  if (clientSecret && (clientSecret.length > 2048 || /\s/.test(clientSecret)))
    throw new Error('OAuth client secret is invalid');
  if (options.signal?.aborted) throw cancellation();
  const timeoutMs = options.timeoutMs ?? 120000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > 600000)
    throw new Error('OAuth timeout must be between 1 and 600000 milliseconds');
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(64).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const tokenController = new AbortController();

  return new Promise<GoogleLoginAccount>((resolve, reject) => {
    let finished = false,
      exchanging = false;
    let redirectUri = '';
    let timer: ReturnType<typeof setTimeout>;
    const cleanup = () => {
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      tokenController.abort();
      server.close();
      server.closeIdleConnections();
    };
    const finish = (error?: Error, account?: GoogleLoginAccount) => {
      if (finished) return;
      finished = true;
      cleanup();
      if (error) reject(error);
      else resolve(account!);
    };
    const onAbort = () => finish(cancellation());
    const server = http.createServer((req, res) => {
      const reply = (status: number, text: string) => {
        res.writeHead(status, {
          'Content-Type': 'text/plain; charset=utf-8',
          'Cache-Control': 'no-store',
          'Content-Security-Policy': "default-src 'none'",
          'Referrer-Policy': 'no-referrer',
          Connection: 'close',
        });
        res.end(text);
      };
      if (finished || !redirectUri) {
        reply(410, 'This login attempt has ended.');
        return;
      }
      if (req.method !== 'GET' || (req.url?.length || 0) > 8192) {
        reply(405, 'Unsupported callback request.');
        return;
      }
      let callback: URL;
      try {
        callback = new URL(req.url || '/', redirectUri);
      } catch {
        reply(400, 'Invalid callback.');
        return;
      }
      const expected = new URL(redirectUri);
      if (
        req.headers.host !== expected.host ||
        callback.origin !== expected.origin ||
        callback.pathname !== '/oauth2callback'
      ) {
        reply(404, 'Not found.');
        return;
      }
      const receivedState = callback.searchParams.get('state') || '';
      if (
        callback.searchParams.getAll('state').length !== 1 ||
        receivedState.length !== state.length ||
        !/^[A-Za-z0-9_-]+$/.test(receivedState) ||
        !timingSafeEqual(Buffer.from(receivedState), Buffer.from(state))
      ) {
        reply(400, 'Login state did not match. Continue using the browser window opened by the application.');
        return;
      }
      if (callback.searchParams.has('error')) {
        reply(400, 'Google login was not approved. You can close this page.');
        finish(new Error('Google login was denied or cancelled.'));
        return;
      }
      const code = callback.searchParams.get('code');
      if (!code || code.length > 4096 || callback.searchParams.getAll('code').length !== 1) {
        reply(400, 'Authorization code is missing or invalid.');
        return;
      }
      if (exchanging) {
        reply(409, 'Login is already being completed.');
        return;
      }
      exchanging = true;
      const parameters = new URLSearchParams({
        client_id: clientId,
        code,
        code_verifier: verifier,
        grant_type: 'authorization_code',
        redirect_uri: redirectUri,
      });
      if (clientSecret) parameters.set('client_secret', clientSecret);
      void (dependencies.exchangeToken || exchangeToken)(parameters, tokenController.signal)
        .then((tokens) => {
          if (finished) {
            reply(410, 'This login attempt has ended.');
            return;
          }
          if (!tokens.access_token || typeof tokens.access_token !== 'string')
            throw new Error('Google did not return an access token');
          const seconds = Number(tokens.expires_in);
          const expiresIn = Number.isFinite(seconds) && seconds > 0 ? Math.min(seconds, 86400) : 3600;

          let email: string | undefined;
          let name: string | undefined;
          let picture: string | undefined;
          if (tokens.id_token) {
            try {
              const parts = tokens.id_token.split('.');
              if (parts.length >= 2) {
                const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
                if (typeof payload.email === 'string') email = payload.email;
                if (typeof payload.name === 'string') name = payload.name;
                if (typeof payload.picture === 'string') picture = payload.picture;
              }
            } catch {

            }
          }

          reply(
            200,
            'Google login completed. Return to Antigravity and save the model to retain this account. You can close this page.',
          );
          finish(undefined, {
            id: randomUUID(),
            label: options.label?.trim() || email || 'Google account',
            email,
            name,
            picture,
            idToken: tokens.id_token,
            accessToken: tokens.access_token,
            ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
            expiresAt: (dependencies.now || Date.now)() + expiresIn * 1000,
            clientId,
            ...(clientSecret ? { clientSecret } : {}),
          });
        })
        .catch((error) => {
          reply(502, 'Login could not be completed. Return to the application for details.');
          finish(error instanceof Error ? error : new Error('Google login failed'));
        });
    });
    server.headersTimeout = 10000;
    server.requestTimeout = 10000;
    server.keepAliveTimeout = 1000;
    server.maxConnections = 8;
    server.on('connection', (socket) => socket.setTimeout(10000, () => socket.destroy()));
    server.on('error', () => finish(new Error('Could not open the local Google login callback')));
    options.signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => finish(cancellation('Google login timed out. Start login again.')), timeoutMs);
    server.listen(0, '127.0.0.1', () => {
      if (finished) {
        server.close();
        return;
      }
      const address = server.address();
      if (!address || typeof address === 'string') {
        finish(new Error('Google login callback did not start'));
        return;
      }
      redirectUri = `http://127.0.0.1:${address.port}/oauth2callback`;
      const authorization = new URL(GOOGLE_AUTHORIZATION_URL);
      authorization.search = new URLSearchParams({
        client_id: clientId,
        redirect_uri: redirectUri,
        response_type: 'code',
        scope: options.scope?.trim() || SCOPES,
        access_type: 'offline',
        prompt: 'select_account consent',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
      }).toString();
      void Promise.resolve()
        .then(() => openExternal(authorization.toString()))
        .catch(() => finish(new Error('Could not open the browser for Google login')));
    });
  });
}
