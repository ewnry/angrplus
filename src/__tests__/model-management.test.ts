import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { ModelStore, normalizeModelConfig } from '../modelStore';
import { createModelManager, modelListUrl, requestJson } from '../modelManagement';
import { GoogleLoginOptions } from '../googleOAuth';
import { GoogleAccount } from '../googleAccounts';

const codec = {
  encryptString: (value: string) => `test:${Buffer.from(value).toString('base64')}`,
  decryptString: (value: string) =>
    value.startsWith('test:') ? Buffer.from(value.slice(5), 'base64').toString() : value,
};
const directories: string[] = [];
const servers: http.Server[] = [];
function setup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'model-management-'));
  directories.push(directory);
  return { directory, manager: createModelManager(directory, codec, async () => {}) };
}
async function server(handler: http.RequestListener) {
  const instance = http.createServer(handler);
  servers.push(instance);
  await new Promise<void>((resolve) => instance.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(instance.address() as AddressInfo).port}`;
}
const entry = {
  name: 'models/test',
  provider: 'openai',
  apiUrl: 'https://example.test/v1',
  externalModelName: 'test',
  apiKey: 'private-key',
  customHeaders: { 'x-project': 'private-header' },
};
const googleEntry = {
  name: 'models/cloud',
  provider: 'google-cloudcode',
  apiUrl: 'https://daily-cloudcode-pa.googleapis.com',
  externalModelName: 'gemini-test',
  apiKey: '',
};
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (instance) =>
        new Promise<void>((resolve) => {
          instance.close(resolve as () => void);
          instance.closeAllConnections();
        }),
    ),
  );
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe('model storage and compatibility', () => {
  it('encrypts preserved legacy plaintext secrets when a masked model is saved', () => {
    const { manager } = setup();
    fs.writeFileSync(manager.store.filename, JSON.stringify({ models: [entry] }));
    manager.saveModel(manager.store.list()[0]);
    expect(fs.readFileSync(manager.store.filename, 'utf8')).not.toContain('private-');
    const stored = manager.store.read()[0];
    expect(codec.decryptString(stored.apiKey!)).toBe('private-key');
    expect(codec.decryptString((stored.customHeaders as Record<string, string>)['x-project'])).toBe('private-header');
  });

  it('requires fresh secrets before saving or discovering at a different provider origin', async () => {
    const { manager } = setup();
    let calls = 0;
    const destination = await server((_req, res) => {
      calls++;
      res.end('{"data":[]}');
    });
    manager.saveModel(entry);
    const masked = manager.store.list()[0];
    expect(() => manager.saveModel({ ...masked, apiUrl: destination })).toThrow('fresh credentials');
    await expect(
      manager.discoverModels({ name: entry.name, provider: entry.provider, apiUrl: destination }),
    ).rejects.toThrow('fresh credentials');
    await expect(manager.discoverModels({ ...masked, apiUrl: destination })).rejects.toThrow('fresh credentials');
    await expect(
      manager.discoverModels({ name: entry.name, provider: entry.provider, apiUrl: destination, apiKey: 'fresh-key' }),
    ).rejects.toThrow('fresh credentials');
    await expect(
      manager.discoverModels({
        name: entry.name,
        provider: entry.provider,
        apiUrl: destination,
        apiKey: 'fresh-key',
        customHeaders: {},
      }),
    ).resolves.toMatchObject({ success: true });
    expect(calls).toBe(1);
  });

  it('discovers and verifies Cloud Code model metadata through the selected OAuth account', async () => {
    const { manager } = setup();
    const destination = await server(async (req, res) => {
      expect(req.url).toBe('/v1internal:fetchAvailableModels');
      expect(req.headers.authorization).toBe('Bearer private-access');
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      expect(JSON.parse(Buffer.concat(chunks).toString())).toEqual({ project: 'fixture-project' });
      res.end(JSON.stringify({ models: { 'gemini-test': { displayName: 'Fixture Gemini' } } }));
    });
    manager.saveModel({
      ...googleEntry,
      apiUrl: destination,
      googleProject: 'fixture-project',
      googleAccounts: [{ id: 'a', accessToken: 'private-access', expiresAt: Date.now() + 3600000 }],
    });
    const listed = manager.store.list()[0];
    const result = await manager.discoverModels(listed);
    expect(result.models).toEqual([{ id: 'gemini-test', displayName: 'Fixture Gemini' }]);
    await expect(manager.testModel(listed)).resolves.toMatchObject({ success: true });
  });

  it('does not let a stale refresh overwrite credentials edited while a test was in flight', async () => {
    const { directory } = setup();
    let finish!: (account: GoogleAccount) => void;
    const manager = createModelManager(directory, codec, async () => {}, {
      loginGoogleAccount: async () => {
        throw new Error('Not used');
      },
      refreshGoogleAccount: () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
      fetchGoogleQuota: async (account) => ({ accountId: account.id, checkedAt: 123, buckets: [] }),
      now: Date.now,
    });
    manager.saveModel({ ...googleEntry, googleAccounts: [{ id: 'a', refreshToken: 'old-refresh' }] });
    const testing = manager.googleTestAccount({ modelName: googleEntry.name, accountId: 'a' });
    manager.saveModel({ ...googleEntry, googleAccounts: [{ id: 'a', refreshToken: 'new-refresh' }] });
    finish({ id: 'a', refreshToken: 'stale-refresh', accessToken: 'stale-access' });
    await testing;
    const stored = (manager.store.read()[0].googleAccounts as GoogleAccount[])[0];
    expect(codec.decryptString(stored.refreshToken!)).toBe('new-refresh');
    expect(stored.accessToken).toBeUndefined();
  });
  it('encrypts nested account credentials, preserves masked edits and excludes them from exports', () => {
    const { manager } = setup();
    manager.saveModel({
      ...googleEntry,
      googleAccounts: [
        { id: 'a', accessToken: 'private-access', refreshToken: 'private-refresh', clientSecret: 'private-client' },
      ],
    });
    expect(fs.readFileSync(manager.store.filename, 'utf8')).not.toContain('private-');
    const masked = manager.store.list()[0];
    expect((masked.googleAccounts as GoogleAccount[])[0]).toMatchObject({
      accessToken: '********',
      refreshToken: '********',
      clientSecret: '********',
    });
    manager.saveModel({ ...masked, displayName: 'Edited' });
    const account = (manager.store.read()[0].googleAccounts as GoogleAccount[])[0];
    expect(codec.decryptString(account.refreshToken!)).toBe('private-refresh');
    expect((manager.store.export().models[0].googleAccounts as GoogleAccount[])[0]).toEqual({ id: 'a' });
    expect(() => manager.saveModel({ ...googleEntry, googleAccounts: [{ id: 'a' }, { id: 'a' }] })).toThrow(
      /unique|Duplicate/,
    );
  });

  it('keeps login tokens in the main process until the masked account is saved', async () => {
    const { directory } = setup();
    let now = 1000;
    const account = {
      id: 'pending',
      accessToken: 'private-access',
      refreshToken: 'private-refresh',
      expiresAt: 1000000,
      clientId: 'fixture.apps.googleusercontent.com',
    };
    const manager = createModelManager(directory, codec, async () => {}, {
      loginGoogleAccount: async () => account,
      refreshGoogleAccount: async (value) => value,
      fetchGoogleQuota: async (value) => ({ accountId: value.id, checkedAt: now, buckets: [] }),
      now: () => now,
    });
    const login = await manager.googleLogin({ clientId: account.clientId });
    expect(JSON.stringify(login)).not.toContain('private-');
    expect(fs.existsSync(manager.store.filename)).toBe(false);
    await expect(manager.googleTestAccount({ account: login.account })).resolves.toMatchObject({ success: true });
    manager.saveModel({ ...googleEntry, googleAccounts: [login.account] });
    expect(codec.decryptString((manager.store.read()[0].googleAccounts as GoogleAccount[])[0].refreshToken!)).toBe(
      'private-refresh',
    );
    const next = await manager.googleLogin({ clientId: account.clientId });
    now += 600001;
    expect(() => manager.saveModel({ ...googleEntry, name: 'models/expired', googleAccounts: [next.account] })).toThrow(
      'expired',
    );
  });

  it('resolves saved masked tokens for quota checks without saving unsaved edits', async () => {
    const { directory } = setup();
    let received: GoogleAccount | undefined;
    const manager = createModelManager(directory, codec, async () => {}, {
      loginGoogleAccount: async () => {
        throw new Error('Not used');
      },
      refreshGoogleAccount: async (account) => {
        received = account;
        return { ...account, accessToken: 'private-fresh', expiresAt: 999999 };
      },
      fetchGoogleQuota: async (account) => ({ accountId: account.id, checkedAt: 123, buckets: [] }),
      now: Date.now,
    });
    manager.saveModel({
      ...googleEntry,
      googleAccounts: [{ id: 'saved', accessToken: 'private-access', refreshToken: 'private-refresh' }],
    });
    const masked = (manager.store.list()[0].googleAccounts as GoogleAccount[])[0];
    await manager.googleTestAccount({ modelName: googleEntry.name, account: { ...masked, label: 'Unsaved' } });
    expect(received).toMatchObject({
      accessToken: 'private-access',
      refreshToken: 'private-refresh',
      label: 'Unsaved',
    });
    expect((manager.store.read()[0].googleAccounts as GoogleAccount[])[0].label).toBeUndefined();
    await manager.googleTestAccount({ modelName: googleEntry.name, accountId: 'saved' });
    expect(codec.decryptString((manager.store.read()[0].googleAccounts as GoogleAccount[])[0].accessToken!)).toBe(
      'private-fresh',
    );
  });

  it('cancels an active login and rejects overlapping login attempts', async () => {
    const { directory } = setup();
    const manager = createModelManager(directory, codec, async () => {}, {
      loginGoogleAccount: (options: GoogleLoginOptions) =>
        new Promise((_resolve, reject) =>
          options.signal!.addEventListener('abort', () => reject(new Error('Cancelled'))),
        ),
      refreshGoogleAccount: async (value) => value,
      fetchGoogleQuota: async (value) => ({ accountId: value.id, checkedAt: 1, buckets: [] }),
      now: Date.now,
    });
    const result = manager.googleLogin({ clientId: 'fixture.apps.googleusercontent.com' });
    await expect(manager.googleLogin({ clientId: 'fixture.apps.googleusercontent.com' })).rejects.toThrow('already');
    manager.googleLoginCancel();
    await expect(result).rejects.toThrow('Cancelled');
  });
  it('keeps encrypted keys and headers through edits, copies, renames and export', () => {
    const { manager } = setup();
    manager.store.save(entry);
    const raw = fs.readFileSync(manager.store.filename, 'utf8');
    expect(raw).not.toContain('private-key');
    expect(raw).not.toContain('private-header');
    const listed = manager.store.list()[0];
    expect(listed.apiKey).toBe('********');
    expect(listed.customHeaders).toEqual({ 'x-project': '********' });
    manager.store.save({ ...listed, name: 'models/copy', copyFrom: entry.name });
    manager.store.save({ ...listed, name: 'models/renamed', originalName: entry.name, displayName: 'Renamed' });
    expect(manager.store.read().map((m) => m.name)).toEqual(['models/renamed', 'models/copy']);
    for (const model of manager.store.read()) expect(codec.decryptString(model.apiKey!)).toBe('private-key');
    const exported = manager.store.export();
    expect(exported.models[0]).not.toHaveProperty('apiKey');
    expect(exported.models[0]).not.toHaveProperty('customHeaders');
    expect(JSON.stringify(exported)).not.toContain('private-');
  });

  it('migrates grouped provider exports, including disabled groups and field aliases', () => {
    const payload = {
      providers: [
        {
          id: 'local',
          provider: 'ollama',
          apiUrl: 'http://localhost:11434/v1',
          enabled: false,
          models: [{ id: 'llama', supportsImages: false, extraHeaders: { 'x-id': 'hi' } }],
        },
      ],
    };
    const models = normalizeModelConfig(payload);
    expect(models[0]).toMatchObject({
      name: 'models/local-llama',
      externalModelName: 'llama',
      enabled: false,
      supportsVision: false,
      customHeaders: { 'x-id': 'hi' },
    });
    expect(models[0]).not.toHaveProperty('extraHeaders');
    expect(normalizeModelConfig(Buffer.from(JSON.stringify(payload)).toString('base64'))).toEqual(models);
  });

  it('bulk import is atomic when any model fails validation', () => {
    const { manager } = setup();
    manager.store.save(entry);
    const before = fs.readFileSync(manager.store.filename, 'utf8');
    expect(() =>
      manager.store.import({
        models: [
          { ...entry, name: 'models/new' },
          { ...entry, apiUrl: 'file:///secret' },
        ],
      }),
    ).toThrow();
    expect(fs.readFileSync(manager.store.filename, 'utf8')).toBe(before);
    expect(fs.readdirSync(path.dirname(manager.store.filename))).not.toContain('.tmp');
  });

  it('does not overwrite malformed configuration or import duplicate names', () => {
    const { manager } = setup();
    fs.writeFileSync(manager.store.filename, '{broken');
    expect(() => manager.store.save(entry)).toThrow();
    expect(fs.readFileSync(manager.store.filename, 'utf8')).toBe('{broken');
    fs.writeFileSync(manager.store.filename, '{"models":[]}');
    expect(() => manager.store.import([entry, entry])).toThrow('Duplicate');
    expect(manager.store.list()).toEqual([]);
  });

  it('retargets fallback references on rename and removes deleted references', () => {
    const { manager } = setup();
    manager.store.save(entry);
    manager.store.save({ ...entry, name: 'models/other', fallbackModels: [entry.name] });
    manager.store.save({ ...manager.store.list()[0], originalName: entry.name, name: 'models/new' });
    expect(manager.store.read()[1].fallbackModels).toEqual(['models/new']);
    manager.store.delete('models/new');
    expect(manager.store.read()[0].fallbackModels).toEqual([]);
  });

  it('does not accept a masked or foreign encrypted key for a new model', () => {
    const { manager } = setup();
    expect(() => manager.store.save({ ...entry, apiKey: '********' })).toThrow('Enter a key');
    expect(() => manager.store.save({ ...entry, apiKey: 'enc:foreign' })).toThrow('cannot be imported');
  });
});

describe('provider discovery and saved credentials', () => {
  it('discovers a large OpenRouter-style catalog with metadata and skips non-chat outputs', async () => {
    const catalog = Array.from({ length: 450 }, (_, index) => ({
      id: `vendor/model-${index}`,
      name: `Model ${index}`,
      context_length: 128000,
      top_provider: { max_completion_tokens: 8192 },
      architecture: { input_modalities: ['text', 'image'], output_modalities: ['text'] },
      supported_parameters: ['tools', 'reasoning'],
    }));
    const url = await server((req, res) => {
      expect(req.url).toBe('/api/v1/models');
      expect(req.headers.authorization).toBe('Bearer catalog-key');
      res.end(
        JSON.stringify({
          data: [...catalog, catalog[0], { id: 'image-only', architecture: { output_modalities: ['image'] } }],
        }),
      );
    });
    const { manager } = setup();
    const found = await manager.discoverModels({
      provider: 'openrouter',
      apiUrl: `${url}/api/v1/chat/completions`,
      apiKey: 'catalog-key',
    });
    expect(found.models).toHaveLength(450);
    expect(found.models[449]).toEqual({
      id: 'vendor/model-449',
      displayName: 'Model 449',
      contextWindow: 128000,
      maxOutputTokens: 8192,
      supportsVision: true,
      supportsThinking: true,
    });
  });

  it('accepts Together-style top-level arrays and keeps chat models with context limits', async () => {
    const url = await server((_req, res) =>
      res.end(
        JSON.stringify([
          { id: 'org/chat-model', display_name: 'Chat model', type: 'chat', context_length: 64000 },
          { id: 'org/embedding-model', type: 'embedding' },
          { id: 'org/image-model', type: 'image' },
        ]),
      ),
    );
    const { manager } = setup();
    const found = await manager.discoverModels({
      provider: 'together',
      apiUrl: `${url}/v1/chat/completions`,
      apiKey: 'test',
    });
    expect(found.models).toEqual([{ id: 'org/chat-model', displayName: 'Chat model', contextWindow: 64000 }]);
  });

  it('uses the DashScope listing API on the configured origin and reads every advertised page', async () => {
    const paths: string[] = [];
    const url = await server((req, res) => {
      expect(req.headers.authorization).toBe('Bearer regional-key');
      const requested = new URL(req.url!, 'http://localhost');
      expect(requested.pathname).toBe('/api/v1/models');
      expect(requested.searchParams.get('capabilities')).toBe('TG');
      expect(requested.searchParams.get('page_size')).toBe('100');
      paths.push(requested.searchParams.get('page_no')!);
      const page = requested.searchParams.get('page_no');
      res.end(
        JSON.stringify({
          output: {
            total: 2,
            models: [
              {
                model: `qwen-${page}`,
                name: `Friendly Qwen ${page}`,
                model_info: { context_window: 32768 },
                inference_metadata: { request_modality: ['Text', 'Image'] },
              },
            ],
          },
        }),
      );
    });
    const { manager } = setup();
    const found = await manager.discoverModels({
      provider: 'dashscope',
      apiFormat: 'openai',
      apiUrl: `${url}/compatible-mode/v1/chat/completions`,
      apiKey: 'regional-key',
    });
    expect(paths).toEqual(['1', '2']);
    expect(found.models).toEqual(
      [1, 2].map((i) => ({
        id: `qwen-${i}`,
        displayName: `Friendly Qwen ${i}`,
        contextWindow: 32768,
        supportsVision: true,
      })),
    );
  });

  it('uses Fireworks resource names, Bearer listing auth, and continuation tokens', async () => {
    const pages: string[] = [];
    const url = await server((req, res) => {
      expect(req.headers.authorization).toBe('Bearer fireworks-key');
      const requested = new URL(req.url!, 'http://localhost');
      expect(requested.pathname).toBe('/v1/accounts/fireworks/models');
      expect(requested.searchParams.get('pageSize')).toBe('200');
      const cursor = requested.searchParams.get('pageToken') || '';
      pages.push(cursor);
      res.end(
        JSON.stringify({
          models: [
            {
              name: `accounts/fireworks/models/chat-${pages.length}`,
              displayName: 'Example chat',
              kind: 'HF_BASE_MODEL',
              state: 'READY',
              supportsServerless: true,
            },
            { name: 'embedding', kind: 'EMBEDDING_MODEL' },
            { name: 'private-only', supportsServerless: false },
          ],
          ...(cursor ? {} : { nextPageToken: 'cursor+/=' }),
        }),
      );
    });
    const { manager } = setup();
    const found = await manager.discoverModels({
      provider: 'fireworks',
      apiUrl: `${url}/inference/v1/chat/completions`,
      apiKey: 'fireworks-key',
    });
    expect(pages).toEqual(['', 'cursor+/=']);
    expect(found.models.map((value) => value.id)).toEqual([
      'accounts/fireworks/models/chat-1',
      'accounts/fireworks/models/chat-2',
    ]);
  });

  it('rejects repeated model page tokens instead of looping or returning a partial catalog', async () => {
    let calls = 0;
    const url = await server((_req, res) => {
      calls++;
      res.end(JSON.stringify({ models: [{ name: 'accounts/fireworks/models/one' }], nextPageToken: 'repeat' }));
    });
    const { manager } = setup();
    await expect(
      manager.discoverModels({ provider: 'fireworks', apiUrl: `${url}/inference/v1`, apiKey: 'test' }),
    ).rejects.toThrow('invalid model page token');
    expect(calls).toBe(2);
  });

  it('keeps HF context conservative and maps Novita/SambaNova catalog fields', async () => {
    const url = await server((_req, res) =>
      res.end(
        JSON.stringify({
          data: [
            { id: 'hf/model', providers: [{ context_length: 32768 }, { context_length: 65536 }] },
            { id: 'hf/unknown-route', providers: [{ context_length: 32768 }, {}] },
            { id: 'novita/model', title: 'Novita model', context_size: 8192 },
            { id: 'samba/model', context_length: 16384, max_completion_tokens: 4096 },
            { id: 'deepseek/model', context_window: 131072, max_output_tokens: 8192 },
            { id: 'hf/incomplete', providers: [null, { context_length: 32768 }] },
          ],
        }),
      ),
    );
    const { manager } = setup();
    const found = await manager.discoverModels({ provider: 'custom', apiUrl: `${url}/v1` });
    expect(found.models[0]).toMatchObject({ contextWindow: 32768 });
    expect(found.models[1]).not.toHaveProperty('contextWindow');
    expect(found.models[2]).toMatchObject({ displayName: 'Novita model', contextWindow: 8192 });
    expect(found.models[3]).toMatchObject({ contextWindow: 16384, maxOutputTokens: 4096 });
    expect(found.models[4]).toMatchObject({ contextWindow: 131072, maxOutputTokens: 8192 });
    expect(found.models[5]).not.toHaveProperty('contextWindow');
  });

  it('probes saved masked credentials and verifies the chosen model without generating', async () => {
    const requests: string[] = [];
    const url = await server((req, res) => {
      requests.push(`${req.method} ${req.url}`);
      expect(req.headers.authorization).toBe('Bearer private-key');
      expect(req.headers['x-project']).toBe('private-header');
      res.end(JSON.stringify({ data: [{ id: 'test' }] }));
    });
    const { manager } = setup();
    manager.store.save({ ...entry, apiUrl: url });
    const result = await manager.testModel(manager.store.list()[0]);
    expect(result.success).toBe(true);
    expect(result.message).toContain('Generation was not tested');
    expect(requests).toEqual(['GET /v1/models']);
    expect((await manager.testModel({ ...manager.store.list()[0], externalModelName: 'missing' })).success).toBe(false);
  });

  it.each([301, 400, 401, 403, 404, 405, 422, 429, 500])(
    'rejects HTTP %i instead of claiming a working model',
    async (status) => {
      const url = await server((_req, res) => {
        res.writeHead(status);
        res.end('{}');
      });
      const { manager } = setup();
      await expect(manager.testModel({ provider: 'openai', apiUrl: url })).rejects.toThrow(`HTTP ${status}`);
    },
  );

  it('rejects HTML success pages and malformed/empty model lists', async () => {
    const url = await server((_req, res) => res.end('<html>login</html>'));
    const { manager } = setup();
    await expect(manager.discoverModels({ provider: 'custom', apiUrl: url })).rejects.toThrow('JSON model list');
  });

  it('bounds incoming bodies and never follows redirects with credentials', async () => {
    const url = await server((_req, res) => res.end('x'.repeat(2 * 1024 * 1024 + 1)));
    await expect(requestJson(url)).rejects.toThrow('exceeds');
    let redirected = false;
    const target = await server((_req, res) => {
      redirected = true;
      res.end('{}');
    });
    const redirect = await server((_req, res) => {
      res.writeHead(302, { Location: target });
      res.end();
    });
    expect((await requestJson(redirect, { Authorization: 'Bearer secret' })).status).toBe(302);
    expect(redirected).toBe(false);
  });

  it.each([
    ['https://x.test/v1/chat/completions', 'openai', 'https://x.test/v1/models'],
    ['https://x.test/anthropic/v1/messages', 'anthropic', 'https://x.test/anthropic/v1/models'],
    ['https://x.test/v1beta/models/a:generateContent', 'google', 'https://x.test/v1beta/models'],
    ['https://x.test/v3/openai/chat/completions', 'openai', 'https://x.test/v3/openai/models'],
    ['https://x.test/openai/v1/chat/completions', 'openai', 'https://x.test/openai/v1/models'],
    ['https://x.test/compatible-mode/v1/chat/completions', 'openai', 'https://x.test/compatible-mode/v1/models'],
  ])('normalizes model discovery path %s', (url, format, expected) => expect(modelListUrl(url, format)).toBe(expected));
});

describe('authenticated gateway integration', () => {
  it('imports gateway aliases, encrypts the token, and keeps secrets out of the renderer', async () => {
    const url = await server((req, res) => {
      expect(req.url).toBe('/models');
      expect(req.headers.authorization).toBe('Bearer gateway-secret');
      res.end(
        JSON.stringify({
          models: [
            {
              name: 'models/fast',
              displayName: 'Fast',
              contextWindow: 8192,
              supportsVision: false,
              supportsThinking: true,
            },
          ],
        }),
      );
    });
    const { directory, manager } = setup();
    await expect(manager.importGatewayModels({ url, token: 'gateway-secret', dashboardUrl: url })).resolves.toEqual({
      success: true,
      count: 1,
    });
    const model = manager.store.list()[0];
    expect(model).toMatchObject({
      provider: 'google',
      apiFormat: 'google',
      externalModelName: 'fast',
      apiUrl: `${url}/v1beta`,
      apiKey: '********',
    });
    expect(model).toMatchObject({ gateway: true, contextWindow: 8192, supportsVision: false, supportsThinking: true });
    expect(manager.getGateway().token).toBe('********');
    expect(fs.readFileSync(path.join(directory, 'gateway_connection.json'), 'utf8')).not.toContain('gateway-secret');
    expect((await manager.testGateway()).success).toBe(true);
    expect(() => manager.saveGateway({ url: 'https://different.test', token: '********' })).toThrow('new gateway');
  });

  it('fails closed when local credential decryption fails', async () => {
    const { directory } = setup();
    const manager = createModelManager(
      directory,
      { ...codec, decryptString: () => 'DECRYPTION_FAILED' },
      async () => {},
    );
    new ModelStore(manager.store.filename, codec).save(entry);
    await expect(manager.discoverModels(manager.store.list()[0])).rejects.toThrow('cannot be decrypted');
  });
});
