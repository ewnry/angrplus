import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const preload = ts.transpileModule(readFileSync(resolve('src/customPreload.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const model = {
  name: 'models/primary',
  displayName: 'Primary',
  provider: 'openai',
  apiFormat: 'openai',
  apiUrl: 'https://provider.example/v1',
  apiKey: '********',
  externalModelName: 'model-a',
  customHeaders: { 'X-Workspace': '********' },
  enabled: true,
};
const presets = [
  { id: 'openai', label: 'OpenAI', defaultUrl: 'https://provider.example/v1', apiFormat: 'openai', keyRequired: true },
  { id: 'ollama', label: 'Ollama', defaultUrl: 'http://127.0.0.1:11434/v1', apiFormat: 'openai', keyRequired: false },
  {
    id: 'google-cloudcode',
    label: 'Google Cloud Code accounts',
    defaultUrl: 'https://daily-cloudcode-pa.googleapis.com',
    apiFormat: 'google',
    keyRequired: false,
  },
];
const openWindows: JSDOM[] = [];
afterEach(() => {
  for (const dom of openWindows.splice(0)) dom.window.close();
});
const settle = () => new Promise<void>((done) => setImmediate(done));

async function fixture(
  html = '<section id="settings"><h2>Models &amp; Usage</h2></section>',
  initialModels: Record<string, unknown>[] = [model],
) {
  const dom = new JSDOM(`<!doctype html><html><head></head><body>${html}</body></html>`, {
    url: 'http://127.0.0.1:54321/settings',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  openWindows.push(dom);
  await new Promise<void>((done) => dom.window.addEventListener('DOMContentLoaded', () => done(), { once: true }));
  let models = initialModels.map((value) => ({ ...value }));
  const handlers: Record<string, (...args: any[]) => unknown> = {
    'storage:get-custom-models': () => models.map((entry) => ({ ...entry })),
    'storage:get-provider-presets': () => presets,
    'storage:save-custom-model': (entry) => {
      const index = models.findIndex(
        (value) => value.name === (entry.copyFrom ? entry.name : entry.originalName || entry.name),
      );
      if (index < 0) models.push({ ...entry });
      else models[index] = { ...entry };
      return { success: true };
    },
    'storage:delete-custom-model': (name) => {
      models = models.filter((entry) => entry.name !== name);
      return { success: true };
    },
    'storage:test-model-connection': () => ({
      success: true,
      message: 'Model listing verified. Generation was not tested.',
    }),
    'storage:discover-models': () => ({
      success: true,
      models: [
        { id: 'model-b', displayName: 'Second model' },
        { id: 'model-c', displayName: '<script>bad()</script>' },
      ],
    }),
    'storage:discover-local': () => ({
      success: true,
      servers: [{ provider: 'ollama', apiUrl: 'http://127.0.0.1:11434/v1', models: [{ id: 'local-model' }] }],
    }),
    'storage:export-custom-models': () => ({
      version: 1,
      models: [{ name: 'models/primary', provider: 'openai', apiUrl: model.apiUrl, externalModelName: 'model-a' }],
    }),
    'storage:import-custom-models': () => ({ success: true, count: 2 }),
    'storage:get-gateway': () => ({
      url: 'https://gateway.example',
      token: '********',
      dashboardUrl: 'https://dashboard.example',
    }),
    'storage:save-gateway': () => ({ success: true }),
    'storage:test-gateway': () => ({ success: true, message: 'Gateway authenticated; 2 aliases available' }),
    'storage:import-gateway-models': () => ({ success: true, count: 2 }),
    'storage:open-gateway-dashboard': () => ({ success: true }),
    'storage:google-login': () => ({
      success: true,
      account: {
        id: 'pending-account',
        label: 'New account',
        clientId: 'desktop.apps.googleusercontent.com',
        refreshToken: '********',
        accessToken: '********',
        expiresAt: 2000000000000,
      },
    }),
    'storage:google-login-cancel': () => ({ success: true }),
    'storage:google-test-account': () => ({ success: true, message: 'Quota checked', quota: { remaining: 75 } }),
    'storage:google-pool-status': () => ({ success: true, accounts: [{ id: 'saved-account', inFlight: 0 }] }),
  };
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (!handlers[channel]) throw new Error(`Unexpected IPC: ${channel}`);
    return handlers[channel](...args);
  });
  const vendorStorage = Object.freeze({ getItems: vi.fn(), updateItems: vi.fn() });
  const context = dom.getInternalVMContext();
  Object.assign(context, {
    exports: {},
    require: (id: string) => {
      if (id !== 'electron') throw new Error(`Sandbox dependency: ${id}`);
      return { ipcRenderer: { invoke } };
    },
    Response,
    Request,
  });
  Object.assign(dom.window, {
    nativeStorage: vendorStorage,
    fetch: vi.fn(async () => new Response('{"models":{}}', { headers: { 'content-type': 'application/json' } })),
    confirm: vi.fn(() => true),
  });
  runInContext(preload, context);
  dom.window.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
  await settle();
  const document = dom.window.document;
  function input(id: string, value?: string): HTMLInputElement {
    const node = document.getElementById(id) as HTMLInputElement;
    expect(node, `Missing #${id}`).toBeTruthy();
    if (value !== undefined) node.value = value;
    return node;
  }
  async function click(label: string, within: Element | Document = document) {
    const node = Array.from(within.querySelectorAll<HTMLButtonElement>('button')).find(
      (value) => value.textContent === label,
    );
    expect(node, `Missing button ${label}`).toBeTruthy();
    node!.click();
    await settle();
  }
  return { dom, document, invoke, handlers, input, click, vendorStorage, getModels: () => models };
}

describe('custom model settings in the preserved vendor preload', () => {
  it('mounts under a div-based Models & Usage heading without a text Refresh button', async () => {
    const f = await fixture(
      '<nav><button><span>Models &amp; Usage</span></button></nav><main class="overflow-y-auto"><div id="settings"><div><span>Models &amp; Usage</span><button aria-label="Refresh quota"></button></div></div></main>',
    );
    expect(f.document.querySelector('#settings > #agy-custom-models-section')).toBeTruthy();
    expect(f.document.querySelector('nav #agy-custom-models-section')).toBeNull();
    expect((f.dom.window as unknown as { nativeStorage: unknown }).nativeStorage).toBe(f.vendorStorage);
    expect(f.document.querySelectorAll('#agy-custom-models-section')).toHaveLength(1);
  });

  it('reinjects after the settings pane is replaced at the same URL and ignores unrelated panes', async () => {
    const f = await fixture(
      '<section id="settings"><h2>MCP Servers</h2><div><div><button>Refresh</button></div></div></section>',
    );
    f.document.getElementById('settings')!.remove();
    f.document.body.innerHTML = '<nav><button>Models &amp; Usage</button></nav><section><h2>Appearance</h2></section>';
    await new Promise((done) => setTimeout(done, 200));
    expect(f.document.querySelector('#agy-custom-models-section')).toBeNull();
    f.document.body.innerHTML = '<section id="new-settings"><h2>Models &amp; Usage</h2></section>';
    await vi.waitFor(() => expect(f.document.querySelector('#new-settings #agy-custom-models-section')).toBeTruthy());
    expect(f.document.querySelectorAll('#agy-custom-models-section')).toHaveLength(1);
    expect(f.document.querySelectorAll('#agy-manager-style')).toHaveLength(1);
  });

  it('edits and renames while roundtripping masked credentials and advanced options', async () => {
    const f = await fixture();
    await f.click('Edit');
    expect(f.input('agy-api-key').type).toBe('password');
    expect(f.input('agy-api-key').value).toBe('********');
    f.input('agy-model-name', 'models/renamed');
    f.input('agy-model-id', 'model-a-v2');
    f.input('agy-display-name', 'Updated model');
    f.input('agy-reasoning-effort', 'high');
    f.input('agy-thinking-budget', '2048');
    f.input('agy-max-output', '8192');
    f.input('agy-context-window', '128000');
    f.input('agy-timeout', '45000');
    f.input('agy-max-retries', '2');
    f.input('agy-vision', 'false');
    f.input('agy-raw-url', 'true');
    f.input('agy-fallback-models', 'models/backup, models/local');
    f.input('agy-extra-body', '{"temperature":0.2}');
    await f.click('Save model');
    expect(f.invoke).toHaveBeenCalledWith(
      'storage:save-custom-model',
      expect.objectContaining({
        name: 'models/renamed',
        originalName: 'models/primary',
        externalModelName: 'model-a-v2',
        apiKey: '********',
        customHeaders: { 'X-Workspace': '********' },
        reasoningEffort: 'high',
        thinkingBudget: 2048,
        maxOutputTokens: 8192,
        contextWindow: 128000,
        timeout: 45000,
        maxRetries: 2,
        supportsVision: false,
        rawUrl: true,
        extraBody: { temperature: 0.2 },
        fallbackModels: ['models/backup', 'models/local'],
      }),
    );
    expect(f.document.querySelector('[role="dialog"]')).toBeNull();
    expect(f.document.querySelector('#agy-custom-models-content')!.textContent).toContain('Updated model');
  });

  it('duplicates with copyFrom and never renames the source record', async () => {
    const f = await fixture();
    await f.click('Duplicate');
    await f.click('Save model');
    const call = f.invoke.mock.calls.find(([channel]) => channel === 'storage:save-custom-model');
    expect(call?.[1]).toMatchObject({
      name: 'models/primary-copy',
      copyFrom: 'models/primary',
      apiKey: '********',
      customHeaders: { 'X-Workspace': '********' },
    });
    expect(call?.[1]).not.toHaveProperty('originalName');
    expect(f.getModels().map((value) => value.name)).toEqual(['models/primary', 'models/primary-copy']);
  });

  it('enables and disables a provider group while preserving each saved key', async () => {
    const f = await fixture(undefined, [
      model,
      { ...model, name: 'models/second', externalModelName: 'model-b', enabled: false },
    ]);
    await f.click('Enable group');
    expect(f.getModels().every((value) => value.enabled === true)).toBe(true);
    await f.click('Disable group');
    expect(f.getModels().every((value) => value.enabled === false && value.apiKey === '********')).toBe(true);
    expect(f.document.querySelectorAll('.agy-row[data-enabled="false"]')).toHaveLength(2);
  });

  it('discovers models with the saved identity and adds only selected IDs', async () => {
    const f = await fixture();
    await f.click('Discover models');
    await f.click('Fetch provider models');
    expect(f.invoke).toHaveBeenCalledWith(
      'storage:discover-models',
      expect.objectContaining({ name: model.name, apiKey: '********', apiUrl: model.apiUrl }),
    );
    expect(f.document.querySelector('#agy-modal-card script')).toBeNull();
    expect(f.document.querySelector('.agy-discovery')!.textContent).toContain('<script>bad()</script>');
    await f.click('Select all');
    await f.click('Add selected');
    const saves = f.invoke.mock.calls
      .filter(([channel]) => channel === 'storage:save-custom-model')
      .map((call) => call[1] as Record<string, unknown>);
    expect(saves).toHaveLength(2);
    expect(saves.map((value) => value.externalModelName)).toEqual(['model-b', 'model-c']);
    expect(saves.every((value) => value.copyFrom === model.name && !value.originalName)).toBe(true);
  });

  it('configures discovered local servers without requiring a key or nonexistent copy source', async () => {
    const f = await fixture();
    await f.click('Discover local');
    await f.click('Configure');
    f.input('agy-model-id', 'local-model');
    await f.click('Save model');
    const call = f.invoke.mock.calls.find(([channel]) => channel === 'storage:save-custom-model');
    expect(call?.[1]).toMatchObject({ provider: 'ollama', apiKey: 'none', externalModelName: 'local-model' });
    expect(call?.[1]).not.toHaveProperty('copyFrom');
  });

  it('filters hundreds of provider models, retains selection across searches, and imports catalog metadata', async () => {
    const f = await fixture();
    f.handlers['storage:discover-models'] = () => ({
      success: true,
      models: Array.from({ length: 450 }, (_, i) => ({
        id: `vendor/model-${i}`,
        displayName: `Catalog model ${i}`,
        contextWindow: 65536,
        maxOutputTokens: 4096,
        supportsVision: true,
        supportsThinking: false,
      })),
    });
    await f.click('Discover models');
    await f.click('Fetch provider models');
    const search = f.input('agy-discovery-search', 'model-449');
    search.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    expect(f.document.querySelectorAll('.agy-choice')).toHaveLength(1);
    await f.click('Select filtered');
    search.value = 'model-448';
    search.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    expect(f.document.querySelector('.agy-discovery')!.textContent).toContain('1 selected');
    await f.click('Select filtered');
    search.value = 'missing';
    search.dispatchEvent(new f.dom.window.Event('input', { bubbles: true }));
    expect(f.document.querySelector('.agy-discovery')!.textContent).toContain('No provider models match');
    await f.click('Add selected');
    const saved = f.getModels().filter((value) => value.name !== model.name);
    expect(saved.map((value) => value.externalModelName)).toEqual(['vendor/model-448', 'vendor/model-449']);
    expect(saved[0]).toMatchObject({
      contextWindow: 65536,
      maxOutputTokens: 4096,
      supportsVision: true,
      supportsThinking: false,
    });
  });

  it('keeps explicit limit overrides when importing catalog choices', async () => {
    const f = await fixture();
    f.handlers['storage:discover-models'] = () => ({
      success: true,
      models: [{ id: 'new-model', contextWindow: 32000, maxOutputTokens: 8000, supportsVision: true }],
    });
    await f.click('Discover models');
    f.input('agy-context-window', '16000');
    f.input('agy-max-output', '2048');
    f.input('agy-vision', 'false');
    await f.click('Fetch provider models');
    await f.click('Select all');
    await f.click('Add selected');
    expect(f.getModels().find((value) => value.externalModelName === 'new-model')).toMatchObject({
      contextWindow: 16000,
      maxOutputTokens: 2048,
      supportsVision: false,
    });
  });

  it('uses the redacted export endpoint and imports base64 without parsing it as JSON in the renderer', async () => {
    const f = await fixture();
    await f.click('Export');
    const exported = f.input('agy-config-json');
    expect(exported.value).not.toMatch(/apiKey|customHeaders|\*{8}/);
    expect(exported.readOnly).toBe(true);
    await f.click('Close');
    await f.click('Import');
    const encoded = Buffer.from('{"models":[]}').toString('base64');
    f.input('agy-config-json', encoded);
    await f.click('Import configuration');
    expect(f.invoke).toHaveBeenCalledWith('storage:import-custom-models', encoded);
    expect(f.document.querySelector('[role="dialog"]')!.textContent).toContain('Imported 2 models');
  });

  it('shows validation and backend errors, retaining the form so the user can correct it', async () => {
    const f = await fixture();
    await f.click('Edit');
    f.input('agy-custom-headers', '{"Authorization":42}');
    await f.click('Save model');
    expect(f.document.querySelector('[role="dialog"]')!.textContent).toContain('Custom header values must be strings');
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'storage:save-custom-model')).toBe(false);
    f.input('agy-custom-headers', '{}');
    f.handlers['storage:save-custom-model'] = () => ({ success: false, error: 'Configuration is read-only' });
    await f.click('Save model');
    expect(f.document.querySelector('[role="dialog"]')!.textContent).toContain('Configuration is read-only');
    expect(
      Array.from(f.document.querySelectorAll<HTMLButtonElement>('button')).find(
        (node) => node.textContent === 'Save model',
      )!.disabled,
    ).toBe(false);
  });

  it('keeps remote token masked while saving, testing, importing, and opening a dashboard', async () => {
    const f = await fixture();
    await f.click('Remote gateway');
    expect(f.input('agy-gateway-token').type).toBe('password');
    expect(f.input('agy-gateway-token').value).toBe('********');
    await f.click('Test gateway');
    expect(f.invoke).toHaveBeenCalledWith('storage:test-gateway', {
      url: 'https://gateway.example',
      token: '********',
      dashboardUrl: 'https://dashboard.example',
    });
    await f.click('Import model aliases');
    expect(f.invoke).toHaveBeenCalledWith('storage:save-gateway', expect.objectContaining({ token: '********' }));
    expect(f.invoke).toHaveBeenCalledWith('storage:import-gateway-models');
    await f.click('Open dashboard');
    expect(f.invoke).toHaveBeenCalledWith('storage:open-gateway-dashboard');
    f.handlers['storage:test-gateway'] = () => ({ success: false, error: 'Authentication rejected (HTTP 401)' });
    await f.click('Test gateway');
    expect(f.document.querySelector('[role="dialog"]')!.textContent).toContain('HTTP 401');
  });

  it('filters disabled models from response injection and honors model limits', async () => {
    const f = await fixture(undefined, [
      { ...model, contextWindow: 32000, maxOutputTokens: 2048 },
      { ...model, name: 'models/disabled', externalModelName: 'disabled', enabled: false },
    ]);
    const response = await f.dom.window.fetch('http://127.0.0.1:50999/fetchAvailableModels');
    const result = await response.json();
    expect(result.models['custom-model-a']).toMatchObject({ maxTokens: 32000, maxOutputTokens: 2048 });
    expect(result.models['custom-disabled']).toBeUndefined();
  });

  it('edits a Google account pool without revealing persisted secrets', async () => {
    const savedAccount = {
      id: 'saved-account',
      label: 'Personal',
      refreshToken: '********',
      accessToken: '********',
      clientId: 'desktop.apps.googleusercontent.com',
      clientSecret: '********',
      enabled: true,
    };
    const f = await fixture(undefined, [
      {
        ...model,
        provider: 'google-cloudcode',
        apiFormat: 'google',
        apiKey: '',
        googleAccounts: [savedAccount],
        googlePool: { strategy: 'quota', maxConcurrency: 3, cooldownMs: 90000 },
      },
    ]);
    await f.click('Edit');
    expect(f.document.getElementById('agy-google-account-config')!.hidden).toBe(false);
    expect(f.input('agy-api-key').closest('label')!.hidden).toBe(true);
    await f.click('Test account');
    expect(f.invoke).toHaveBeenCalledWith('storage:google-test-account', {
      modelName: model.name,
      accountId: 'saved-account',
    });
    await f.click('Edit account');
    expect(f.input('agy-account-refresh-token').type).toBe('password');
    expect(f.input('agy-account-client-secret').value).toBe('********');
    f.input('agy-account-label', 'Renamed account');
    await f.click('Apply account');
    f.input('agy-google-pool-strategy', 'round-robin');
    f.input('agy-google-project', 'my-project');
    await f.click('Test account');
    expect(f.invoke).toHaveBeenLastCalledWith('storage:google-test-account', {
      modelName: model.name,
      account: expect.objectContaining({ id: 'saved-account', label: 'Renamed account', refreshToken: '********' }),
    });
    await f.click('Test connection');
    expect(f.invoke).toHaveBeenLastCalledWith(
      'storage:test-model-connection',
      expect.objectContaining({
        name: model.name,
        googleAccounts: [expect.objectContaining({ id: 'saved-account', refreshToken: '********' })],
        googleProject: 'my-project',
        googlePool: { strategy: 'round-robin', maxConcurrency: 3, cooldownMs: 90000 },
      }),
    );
    await f.click('Fetch provider models');
    expect(f.invoke).toHaveBeenLastCalledWith(
      'storage:discover-models',
      expect.objectContaining({
        name: model.name,
        googleAccounts: [expect.objectContaining({ id: 'saved-account', refreshToken: '********' })],
        googleProject: 'my-project',
      }),
    );
    await f.click('Save model');
    expect(f.invoke).toHaveBeenCalledWith(
      'storage:save-custom-model',
      expect.objectContaining({
        googleAccounts: [
          expect.objectContaining({
            id: 'saved-account',
            label: 'Renamed account',
            refreshToken: '********',
            clientSecret: '********',
          }),
        ],
        googleProject: 'my-project',
        googlePool: { strategy: 'round-robin', maxConcurrency: 3, cooldownMs: 90000 },
      }),
    );
  });

  it('starts browser login only after the explicit click and saves the pending masked account', async () => {
    const f = await fixture(undefined, []);
    await f.click('Add model');
    const provider = f.input('agy-provider', 'google-cloudcode');
    provider.dispatchEvent(new f.dom.window.Event('change'));
    expect(f.invoke.mock.calls.some(([channel]) => channel === 'storage:google-login')).toBe(false);
    f.input('agy-google-login-client-id', 'desktop.apps.googleusercontent.com');
    f.input('agy-google-login-client-secret', 'user-entered-client-secret');
    f.input('agy-google-login-label', 'New account');
    await f.click('Sign in with Google');
    expect(f.invoke).toHaveBeenCalledWith('storage:google-login', {
      clientId: 'desktop.apps.googleusercontent.com',
      clientSecret: 'user-entered-client-secret',
      label: 'New account',
    });
    expect(f.input('agy-google-login-client-secret').value).toBe('');
    expect(f.document.getElementById('agy-google-accounts-list')!.textContent).toContain('New account');
    expect(f.document.getElementById('agy-google-accounts-list')!.textContent).not.toContain('********');
    expect(f.document.querySelector('[role="dialog"]')!.textContent).toContain('within 10 minutes');
    f.input('agy-model-id', 'gemini-model');
    await f.click('Save model');
    expect(f.invoke).toHaveBeenCalledWith(
      'storage:save-custom-model',
      expect.objectContaining({
        googleAccounts: [
          expect.objectContaining({ id: 'pending-account', refreshToken: '********', accessToken: '********' }),
        ],
      }),
    );
  });

  it('imports user-owned account JSON without performing login or quota requests', async () => {
    const f = await fixture(undefined, []);
    await f.click('Add model');
    f.input('agy-provider', 'google-cloudcode').dispatchEvent(new f.dom.window.Event('change'));
    f.input(
      'agy-google-account-json',
      JSON.stringify({
        type: 'authorized_user',
        client_id: 'desktop.apps.googleusercontent.com',
        client_secret: 'entered-secret',
        refresh_token: 'entered-refresh',
        quota_project_id: 'owned-project',
      }),
    );
    await f.click('Import accounts');
    expect(f.input('agy-google-account-json').value).toBe('');
    expect(
      f.invoke.mock.calls.some(
        ([channel]) => channel === 'storage:google-login' || channel === 'storage:google-test-account',
      ),
    ).toBe(false);
    f.input('agy-model-id', 'gemini-model');
    await f.click('Save model');
    expect(f.invoke).toHaveBeenCalledWith(
      'storage:save-custom-model',
      expect.objectContaining({
        googleAccounts: [
          expect.objectContaining({
            clientId: 'desktop.apps.googleusercontent.com',
            refreshToken: 'entered-refresh',
            project: 'owned-project',
          }),
        ],
      }),
    );
  });

  it('cancels an unfinished browser login when the model dialog closes', async () => {
    const f = await fixture(undefined, []);
    await f.click('Add model');
    f.input('agy-provider', 'google-cloudcode').dispatchEvent(new f.dom.window.Event('change'));
    let finishLogin!: (value: unknown) => void;
    f.handlers['storage:google-login'] = () => new Promise((resolve) => (finishLogin = resolve));
    f.handlers['storage:google-login-cancel'] = () => {
      finishLogin({ success: false, error: 'Google login cancelled' });
      return { success: true };
    };
    f.input('agy-google-login-client-id', 'desktop.apps.googleusercontent.com');
    await f.click('Sign in with Google');
    await f.click('Close');
    expect(f.invoke).toHaveBeenCalledWith('storage:google-login-cancel');
    expect(f.document.querySelector('[role="dialog"]')).toBeNull();
  });
});
