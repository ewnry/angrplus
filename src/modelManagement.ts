import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  ModelStore,
  ModelEntry,
  SecretCodec,
  decodeSecret,
  isMaskedSecret,
  writeJsonAtomic,
  redactModel,
} from './modelStore';
import { PROVIDERS, getProvider, resolveApiFormat } from './providers';
import { loginGoogleAccount, GoogleLoginOptions } from './googleOAuth';
import {
  GoogleAccount,
  GooglePoolOptions,
  refreshGoogleAccount,
  fetchGoogleQuota,
  fetchGoogleModels,
  getGooglePoolStatus,
  configureGoogleAccountPersistence,
  resetGoogleAccountState,
} from './googleAccounts';

export interface ProbeParams {
  name?: string;
  provider: string;
  apiUrl: string;
  apiKey?: string;
  apiFormat?: 'openai' | 'anthropic' | 'google';
  externalModelName?: string;
  allowUnauthorized?: boolean;
  customHeaders?: Record<string, string>;
  googleAccounts?: GoogleAccount[];
  googleProject?: string;
  googlePool?: GooglePoolOptions;
}
export interface GatewayConnection {
  url: string;
  token?: string;
  dashboardUrl?: string;
}
export interface DiscoveredModel {
  id: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  supportsVision?: boolean;
  supportsThinking?: boolean;
}

export function checkedUrl(value: string): URL {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password)
    throw new Error('Use an HTTP(S) URL without embedded credentials');
  url.hash = '';
  return url;
}

/** Small bounded requests, no credential forwarding across redirects. */
export function requestJson(
  urlValue: string,
  headers: Record<string, string> = {},
  allowUnauthorized = false,
): Promise<{ status: number; data: unknown }> {
  const url = checkedUrl(urlValue);
  return new Promise((resolve, reject) => {
    let completed = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (error?: Error, value?: { status: number; data: unknown }) => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value!);
    };
    const req = (url.protocol === 'https:' ? https : http).request(
      url,
      {
        method: 'GET',
        headers: { Accept: 'application/json', ...headers },
        rejectUnauthorized: !allowUnauthorized,
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2 * 1024 * 1024) {
            finish(new Error('Response exceeds 2 MB'));
            req.destroy();
            res.destroy();
          } else chunks.push(chunk);
        });
        res.on('error', (error) => finish(error));
        res.on('aborted', () => finish(new Error('Server closed the response early')));
        res.on('end', () => {
          const status = res.statusCode || 502;
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            finish(undefined, { status, data: text ? JSON.parse(text) : {} });
          } catch {
            finish(undefined, { status, data: null });
          }
        });
      },
    );
    timer = setTimeout(() => {
      finish(new Error('Connection timed out after 10 seconds'));
      req.destroy();
    }, 10000);
    req.on('error', (error) => finish(error));
    req.end();
  });
}

function statusError(status: number): string {
  const messages: Record<number, string> = {
    401: 'Authentication rejected — check the API key',
    403: 'Access denied — check provider permissions',
    404: 'Model listing endpoint not found — check the API URL',
    405: 'Provider does not support model listing',
    429: 'Rate limited — check provider quota and retry later',
  };
  return `${messages[status] || 'Provider request failed'} (HTTP ${status})`;
}

export function modelListUrl(apiUrl: string, format: string, provider?: string): string {
  const url = checkedUrl(apiUrl);
  url.search = '';
  let pathname = url.pathname.replace(/\/+$/, '');
  pathname = pathname
    .replace(/\/(chat\/completions|completions|responses|messages)$/, '')
    .replace(/\/models(?:\/.*)?$/, '');
  if (provider === 'dashscope') {
    url.pathname = `${pathname.replace(/\/(?:compatible-mode\/)?v1$/, '')}/api/v1/models`;
    url.searchParams.set('capabilities', 'TG');
    url.searchParams.set('page_no', '1');
    url.searchParams.set('page_size', '100');
    return url.toString();
  }
  if (provider === 'fireworks') {
    url.pathname = `${pathname.replace(/\/(?:inference\/)?v1$/, '')}/v1/accounts/fireworks/models`;
    url.searchParams.set('pageSize', '200');
    return url.toString();
  }
  if (format === 'google') {
    if (!/\/v1(?:beta)?$/.test(pathname)) pathname += '/v1beta';
  } else if (!/(?:^|\/)v\d+(?:beta\d*)?(?:\/|$)/.test(pathname)) pathname += '/v1';
  url.pathname = `${pathname}/models`;
  if (provider === 'siliconflow') url.searchParams.set('sub_type', 'chat');
  return url.toString();
}

function parseModels(data: unknown, provider?: string): DiscoveredModel[] {
  if (!data || typeof data !== 'object') throw new Error('Provider did not return a JSON model list');
  const root = data as { data?: unknown; models?: unknown; output?: { models?: unknown } };
  const items = Array.isArray(data) ? data : Array.isArray(root.data) ? root.data : root.models || root.output?.models;
  if (!Array.isArray(items)) throw new Error('Provider response has no model list');
  const positiveLimit = (...values: unknown[]): number | undefined =>
    values.find(
      (value): value is number =>
        typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 1_000_000_000,
    );
  const seen = new Set<string>();
  return items
    .filter((item) => item && typeof item === 'object')
    .filter((item) => provider !== 'together' || item.type === 'chat')
    .filter(
      (item) =>
        provider !== 'fireworks' ||
        (item.supportsServerless !== false &&
          (!item.state || item.state === 'READY') &&
          item.kind !== 'EMBEDDING_MODEL'),
    )
    .filter((item) => !['embedding', 'embeddings', 'image', 'audio', 'rerank', 'moderation'].includes(item.type))
    .filter(
      (item) =>
        !Array.isArray(item.architecture?.output_modalities) || item.architecture.output_modalities.includes('text'),
    )
    .map((item) => {
      const providerLimits = Array.isArray(item.providers)
        ? item.providers.map((value: { context_length?: unknown } | null) => positiveLimit(value?.context_length))
        : [];
      const contextWindow = positiveLimit(
        item.contextWindow,
        item.context_window,
        item.context_length,
        item.context_size,
        item.inputTokenLimit,
        item.top_provider?.context_length,
        item.model_info?.context_window,
        providerLimits.length && providerLimits.every((value: unknown) => typeof value === 'number')
          ? Math.min(...providerLimits)
          : undefined,
      );
      const maxOutputTokens = positiveLimit(
        item.maxOutputTokens,
        item.max_output_tokens,
        item.max_completion_tokens,
        item.outputTokenLimit,
        item.top_provider?.max_completion_tokens,
      );
      const supportsVision =
        typeof item.supportsVision === 'boolean'
          ? item.supportsVision
          : Array.isArray(item.architecture?.input_modalities)
            ? item.architecture.input_modalities.includes('image')
            : Array.isArray(item.inference_metadata?.request_modality)
              ? item.inference_metadata.request_modality.includes('Image')
              : undefined;
      const supportsThinking =
        typeof item.supportsThinking === 'boolean'
          ? item.supportsThinking
          : Array.isArray(item.supported_parameters)
            ? item.supported_parameters.some((value: unknown) => value === 'reasoning' || value === 'reasoning_effort')
            : undefined;
      return {
        id: String(item.id || item.model || item.name || '').replace(/^models\//, ''),
        displayName: String(
          item.displayName || item.display_name || item.title || item.name || item.id || item.model || '',
        ),
        ...(contextWindow ? { contextWindow } : {}),
        ...(maxOutputTokens ? { maxOutputTokens } : {}),
        ...(supportsVision !== undefined ? { supportsVision } : {}),
        ...(supportsThinking !== undefined ? { supportsThinking } : {}),
      };
    })
    .filter((item) => {
      if (!item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
}

export function createModelManager(
  directory: string,
  codec: SecretCodec,
  openExternal: (url: string) => Promise<unknown>,
  dependencies = { loginGoogleAccount, refreshGoogleAccount, fetchGoogleQuota, now: Date.now },
) {
  const pending = new Map<string, { account: GoogleAccount; expiresAt: number }>();
  let loginController: AbortController | undefined;
  function pendingAccount(id: string) {
    for (const [key, value] of pending) if (value.expiresAt <= dependencies.now()) pending.delete(key);
    return pending.get(id)?.account;
  }
  const store = new ModelStore(path.join(directory, 'custom_models.json'), codec, (id) => {
    const account = pendingAccount(id);
    return account ? { ...account } : undefined;
  });
  function persistGoogleAccount(modelName: string, account: GoogleAccount, previous?: GoogleAccount) {
    const raw = store.read().find((item) => item.name === modelName);
    if (!raw || !Array.isArray(raw.googleAccounts)) return;
    const stored = raw.googleAccounts.find((item) => item.id === account.id);
    if (!stored) return;
    if (previous) {
      const secret = (value: string | undefined) =>
        raw.encryptedGoogleAccounts ? decodeSecret(value, codec) : value || '';
      if (
        stored.clientId !== previous.clientId ||
        (secret(stored.refreshToken) || secret(stored.accessToken)) !==
          (previous.refreshToken || previous.accessToken || '')
      )
        return;
    }
    const model = redactModel(raw);
    if (!Array.isArray(model.googleAccounts)) return;
    const index = model.googleAccounts.findIndex((item) => item.id === account.id);
    if (index < 0) return; // Account or model removed while a request was in flight.
    model.googleAccounts[index] = {
      ...model.googleAccounts[index],
      accessToken: account.accessToken,
      refreshToken: account.refreshToken,
      expiresAt: account.expiresAt,
    };
    store.save(model);
  }
  configureGoogleAccountPersistence(persistGoogleAccount);
  function saveModel(model: ModelEntry) {
    store.save(model);
    if (Array.isArray(model.googleAccounts))
      for (const account of model.googleAccounts) {
        pending.delete(account.id);
        resetGoogleAccountState(account.id);
      }
    return { success: true };
  }
  function resolveGoogleAccount(input: { modelName?: string; accountId?: string; account?: GoogleAccount }) {
    const savedModel = input.modelName ? store.read().find((item) => item.name === input.modelName) : undefined;
    const id = input.accountId || input.account?.id;
    const saved = Array.isArray(savedModel?.googleAccounts)
      ? savedModel.googleAccounts.find((item) => item.id === id)
      : undefined;
    const temporary = id ? pendingAccount(id) : undefined;
    const account: GoogleAccount = { ...(saved || temporary || {}), ...(input.account || {}) };
    if (!account.id) throw new Error('Select a Google account first');
    for (const field of ['accessToken', 'refreshToken', 'clientSecret'] as const) {
      const supplied = input.account?.[field];
      if (supplied && !isMaskedSecret(supplied)) account[field] = supplied;
      else if (saved?.[field])
        account[field] = savedModel?.encryptedGoogleAccounts ? decodeSecret(saved[field], codec) : saved[field];
      else account[field] = temporary?.[field];
    }
    return account;
  }
  const gatewayFile = path.join(directory, 'gateway_connection.json');
  function gatewayRaw(): GatewayConnection {
    try {
      return JSON.parse(fs.readFileSync(gatewayFile, 'utf8'));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return { url: 'http://127.0.0.1:51000', dashboardUrl: 'http://127.0.0.1:51001', token: '' };
      throw error;
    }
  }
  function resolveGateway(input?: GatewayConnection): GatewayConnection {
    const previous = gatewayRaw();
    const connection = input ? { ...previous, ...input } : previous;
    connection.url = checkedUrl(connection.url).toString().replace(/\/$/, '');
    if (
      input &&
      checkedUrl(connection.url).origin !== checkedUrl(previous.url).origin &&
      (!input.token || isMaskedSecret(input.token))
    ) {
      throw new Error('Enter the token for the new gateway address');
    }
    if (connection.dashboardUrl) connection.dashboardUrl = checkedUrl(connection.dashboardUrl).toString();
    connection.token =
      isMaskedSecret(connection.token) || connection.token === undefined
        ? decodeSecret(previous.token, codec)
        : decodeSecret(connection.token, codec);
    if (!connection.token) throw new Error('Gateway access token is required. Run gateway setup to obtain it.');
    return connection;
  }
  function resolveProbe(input: ProbeParams): ProbeParams {
    const stored = input.name ? store.read().find((model) => model.name === input.name) : undefined;
    const model = { ...(stored || {}), ...input } as ProbeParams;
    if (
      stored &&
      (stored.provider !== model.provider || checkedUrl(stored.apiUrl).origin !== checkedUrl(model.apiUrl).origin)
    ) {
      if (
        (stored.apiKey &&
          stored.apiKey !== 'none' &&
          (!input.apiKey || isMaskedSecret(input.apiKey) || input.apiKey === stored.apiKey)) ||
        Object.values(model.customHeaders || {}).some(isMaskedSecret) ||
        (input.customHeaders === undefined && Object.keys(model.customHeaders || {}).length)
      ) {
        throw new Error('Enter fresh credentials when changing the provider or server address');
      }
    }
    if (isMaskedSecret(model.apiKey) || model.apiKey === undefined) model.apiKey = stored?.apiKey;
    if (isMaskedSecret(model.apiKey)) throw new Error('Enter an API key or select a saved model');
    model.apiKey = decodeSecret(model.apiKey, codec);
    const savedHeaders = (stored?.customHeaders || {}) as Record<string, string>;
    model.customHeaders = Object.fromEntries(
      Object.entries(model.customHeaders || {}).map(([key, value]) => {
        const saved = isMaskedSecret(value) || value === savedHeaders[key];
        const resolved = isMaskedSecret(value) ? savedHeaders[key] : value;
        if (!resolved || isMaskedSecret(resolved)) throw new Error(`Enter a value for header ${key}`);
        return [key, saved && stored?.encryptedHeaders ? decodeSecret(resolved, codec) : resolved];
      }),
    );
    return model;
  }
  async function discoverModels(input: ProbeParams) {
    if (input.provider === 'google-cloudcode') {
      const saved = input.name ? store.read().find((model) => model.name === input.name) : undefined;
      const accounts = input.googleAccounts || (saved?.googleAccounts as GoogleAccount[] | undefined);
      const selected = accounts?.find((account) => account.enabled !== false);
      if (!selected) throw new Error('Add or enable a Google account before discovering models');
      const previous = resolveGoogleAccount({ modelName: input.name, account: selected });
      previous.project ||= input.googleProject || (saved?.googleProject as string | undefined);
      const account = await dependencies.refreshGoogleAccount(previous);
      // Persist refreshed tokens only if their source credentials are still current.
      if (input.name) persistGoogleAccount(input.name, account, previous);
      else if (pending.has(account.id))
        pending.set(account.id, { account, expiresAt: dependencies.now() + 10 * 60 * 1000 });
      return { success: true, models: await fetchGoogleModels(account, input.apiUrl), status: 200 };
    }
    const model = resolveProbe(input);
    const format = resolveApiFormat(model.provider, model.apiFormat);
    const headers: Record<string, string> = {};
    if (model.provider === 'fireworks') {
      if (model.apiKey) headers.Authorization = `Bearer ${model.apiKey}`;
    } else if (format === 'anthropic') {
      headers['anthropic-version'] = '2023-06-01';
      if (model.apiKey) headers['x-api-key'] = model.apiKey;
    } else if (format === 'google') {
      if (model.apiKey) headers['x-goog-api-key'] = model.apiKey;
    } else if (model.apiKey) headers.Authorization = `Bearer ${model.apiKey}`;
    for (const [key, value] of Object.entries(model.customHeaders || {})) {
      if (/^(host|content-length|connection|transfer-encoding)$/i.test(key)) throw new Error('Reserved HTTP header');
      http.validateHeaderName(key);
      http.validateHeaderValue(key, value);
      headers[key] = value;
    }
    const listUrl = new URL(modelListUrl(model.apiUrl, format, model.provider));
    const models = new Map<string, DiscoveredModel>();
    const cursors = new Set<string>();
    const deadline = Date.now() + 30000;
    let received = 0;
    for (let page = 1; page <= 50; page++) {
      if (Date.now() >= deadline) throw new Error('Model discovery exceeded its 30-second time budget');
      const response = await requestJson(listUrl.toString(), headers, model.allowUnauthorized);
      if (response.status < 200 || response.status >= 300)
        throw Object.assign(new Error(statusError(response.status)), { status: response.status });
      for (const found of parseModels(response.data, model.provider)) models.set(found.id, found);
      if (models.size > 10000) throw new Error('Model catalog exceeds 10000 entries');
      const data = response.data as { output?: { models?: unknown[]; total?: number }; nextPageToken?: string };
      if (model.provider === 'dashscope' && Array.isArray(data.output?.models)) {
        received += data.output.models.length;
        const total = data.output.total;
        if (typeof total === 'number' && Number.isSafeInteger(total) && total >= 0 && received < total) {
          if (!data.output.models.length) throw new Error('Provider returned an incomplete model catalog');
          listUrl.searchParams.set('page_no', String(page + 1));
          continue;
        }
        if (total === undefined && data.output.models.length === 100) {
          listUrl.searchParams.set('page_no', String(page + 1));
          continue;
        }
      } else if (model.provider === 'fireworks' && data.nextPageToken) {
        const token = data.nextPageToken;
        if (typeof token !== 'string' || token.length > 4096 || cursors.has(token))
          throw new Error('Provider returned an invalid model page token');
        cursors.add(token);
        listUrl.searchParams.set('pageToken', token);
        continue;
      }
      return { success: true, models: [...models.values()], status: response.status };
    }
    throw new Error('Model discovery exceeded the maximum number of pages');
  }
  async function gatewayModels(input?: GatewayConnection) {
    const connection = resolveGateway(input);
    const response = await requestJson(`${connection.url}/models`, { Authorization: `Bearer ${connection.token}` });
    if (response.status !== 200) throw new Error(statusError(response.status));
    return { connection, models: parseModels(response.data) };
  }
  return {
    store,
    saveModel,
    presets: () => PROVIDERS,
    discoverModels,
    async googleLogin(options: GoogleLoginOptions) {
      if (loginController) throw new Error('A Google login is already in progress');
      const controller = new AbortController();
      loginController = controller;
      try {
        const account = await dependencies.loginGoogleAccount(
          {
            clientId: options.clientId,
            clientSecret: options.clientSecret,
            label: options.label,
            signal: controller.signal,
          },
          openExternal,
        );
        pendingAccount(account.id);
        if (pending.size >= 20) pending.delete(pending.keys().next().value!);
        pending.set(account.id, { account, expiresAt: dependencies.now() + 10 * 60 * 1000 });
        const masked = redactModel({
          name: '',
          provider: '',
          apiUrl: '',
          externalModelName: '',
          googleAccounts: [account],
        });
        return { success: true, account: (masked.googleAccounts as GoogleAccount[])[0] };
      } finally {
        if (loginController === controller) loginController = undefined;
      }
    },
    googleLoginCancel() {
      loginController?.abort();
      return { success: true };
    },
    googlePoolStatus() {
      return { success: true, accounts: getGooglePoolStatus() };
    },
    async googleTestAccount(input: { modelName?: string; accountId?: string; account?: GoogleAccount }) {
      const previous = resolveGoogleAccount(input);
      const account = await dependencies.refreshGoogleAccount(previous);
      if (input.modelName) persistGoogleAccount(input.modelName, account, previous);
      else if (pending.has(account.id))
        pending.set(account.id, { account, expiresAt: dependencies.now() + 10 * 60 * 1000 });
      const quota = await dependencies.fetchGoogleQuota(account);
      return { success: true, quota };
    },
    async testModel(input: ProbeParams) {
      const result = await discoverModels(input);
      const selected = input.externalModelName?.replace(/^models\//, '');
      if (selected && !result.models.some((model) => model.id === selected)) {
        return {
          success: false,
          status: result.status,
          error: `Endpoint authenticated, but model "${selected}" was not listed. Generation was not tested.`,
        };
      }
      return {
        success: true,
        status: result.status,
        message: `Model listing verified (${result.models.length} models). Generation was not tested.`,
      };
    },
    async discoverLocal() {
      const targets = [
        ['ollama', 11434],
        ['lmstudio', 1234],
        ['llamacpp', 8080],
        ['vllm', 8000],
        ['textgen', 5000],
        ['tabby', 5001],
        ['localai', 8081],
        ['litellm', 4000],
        ['aphrodite', 2242],
      ] as const;
      const results = await Promise.allSettled(
        targets.map(async ([provider, port]) => {
          const apiUrl = `http://127.0.0.1:${port}/v1`;
          const found = await discoverModels({ provider, apiUrl, apiFormat: 'openai', apiKey: '' });
          return { provider: getProvider(provider)?.id || 'custom', apiUrl, models: found.models };
        }),
      );
      return {
        success: true,
        servers: results
          .filter(
            (r): r is PromiseFulfilledResult<{ provider: string; apiUrl: string; models: DiscoveredModel[] }> =>
              r.status === 'fulfilled',
          )
          .map((r) => r.value),
      };
    },
    getGateway() {
      const connection = gatewayRaw();
      return { ...connection, token: connection.token ? '********' : '' };
    },
    saveGateway(input: GatewayConnection) {
      const connection = resolveGateway(input);
      writeJsonAtomic(gatewayFile, { ...connection, token: codec.encryptString(connection.token!) });
      return { success: true };
    },
    async testGateway(input?: GatewayConnection) {
      const { models } = await gatewayModels(input);
      return { success: true, message: `Gateway authenticated; ${models.length} model aliases available`, models };
    },
    async importGatewayModels(input?: GatewayConnection) {
      const { connection, models } = await gatewayModels(input);
      if (!models.length) throw new Error('Gateway has no model aliases. Add them in the dashboard first.');
      const incoming: ModelEntry[] = models.map((model) => ({
        name: `models/gateway-${model.id}`,
        externalModelName: model.id,
        displayName: `${model.displayName} (Gateway)`,
        provider: 'google',
        apiFormat: 'google',
        gateway: true,
        contextWindow: model.contextWindow ?? 128000,
        supportsVision: model.supportsVision ?? false,
        supportsThinking: model.supportsThinking ?? false,
        ...(model.maxOutputTokens ? { maxOutputTokens: model.maxOutputTokens } : {}),
        apiUrl: `${connection.url}/v1beta`,
        apiKey: connection.token,
        enabled: true,
      }));
      const count = store.import({ models: incoming });
      writeJsonAtomic(gatewayFile, { ...connection, token: codec.encryptString(connection.token!) });
      return { success: true, count };
    },
    async openDashboard() {
      const connection = gatewayRaw();
      if (!connection.dashboardUrl) throw new Error('Set the dashboard URL first');
      await openExternal(checkedUrl(connection.dashboardUrl).toString());
      return { success: true };
    },
  };
}
