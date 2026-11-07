import * as messageRevisions from '../messageRevisions';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createModelManager } from '../modelManagement';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const fixtureHomes: string[] = [];
afterEach(() => {
  for (const home of fixtureHomes.splice(0)) rmSync(home, { recursive: true, force: true });
});

type Handler = (...args: unknown[]) => unknown;
type State = { type: string; update?: { version: string } };

// Execute the production CommonJS modules with an explicit Electron boundary.
// No app, updater, shell or network operation runs here; model files use isolated temporary homes.
const compiled = new Map(
  ['updater', 'ipcHandlers', 'customIpc', 'preload', 'customPreload'].map((name) => [
    name,
    ts.transpileModule(readFileSync(path.resolve('src', `${name}.ts`), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
    }).outputText,
  ]),
);

function loadModule(name: string, dependencies: Record<string, unknown>, globals: Record<string, unknown> = {}) {
  const module = { exports: {} as Record<string, Handler> };
  runInNewContext(compiled.get(name)!, {
    module,
    exports: module.exports,
    require: (id: string) => {
      if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected dependency: ${id}`);
      return dependencies[id];
    },
    process,
    console,
    URL,
    ...globals,
  });
  return module.exports;
}

function createFixture(customOnly = false) {
  const handlers = new Map<string, Handler>();
  const listeners = new Map<string, Set<Handler>>();
  const exposed: Record<string, Record<string, Handler>> = {};
  const stat = vi.fn();
  const homePath = mkdtempSync(path.join(tmpdir(), 'antigravity-ipc-'));
  fixtureHomes.push(homePath);
  let savedModels = '{"models":[]}';
  const readFile = vi.fn(async () => savedModels);
  const writeFile = vi.fn(async (_filename: string, contents: string) => {
    savedModels = contents;
  });
  const mkdir = vi.fn();
  const showOpenDialog = vi.fn();
  const showItemInFolder = vi.fn();
  let responseStatus = 200;
  const request = vi.fn((_options: unknown, onResponse: (response: unknown) => void) => ({
    setTimeout: vi.fn(),
    on: vi.fn(),
    end: () => onResponse({ statusCode: responseStatus, resume: vi.fn() }),
  }));
  const idePath = path.resolve('fixture', 'Antigravity IDE');
  const send = vi.fn((channel: string, ...args: unknown[]) => {
    for (const callback of listeners.get(channel) || []) callback({}, ...args);
  });
  const electron = {
    app: { isPackaged: false, getPath: () => homePath },
    BrowserWindow: { getAllWindows: () => [{ webContents: { send } }] },
    dialog: { showOpenDialog },
    shell: { showItemInFolder },
    ipcMain: {
      handle: (channel: string, handler: Handler) => {
        if (handlers.has(channel)) {
          throw new Error(`Attempted to register a second handler for '${channel}'`);
        }
        handlers.set(channel, handler);
      },
    },
    ipcRenderer: {
      invoke: async (channel: string, ...args: unknown[]) => {
        const handler = handlers.get(channel);
        if (!handler) throw new Error(`No handler registered for ${channel}`);
        return handler({}, ...args);
      },
      on: (channel: string, callback: Handler) => {
        if (!listeners.has(channel)) listeners.set(channel, new Set());
        listeners.get(channel)!.add(callback);
      },
      removeListener: (channel: string, callback: Handler) => listeners.get(channel)?.delete(callback),
    },
    contextBridge: {
      exposeInMainWorld: (name: string, api: Record<string, Handler>) => {
        exposed[name] = api;
      },
    },
    webFrame: {},
  };
  const dependencies = {
    './themeIcons': { applyThemeIcon: vi.fn() },
    electron,
    path,
    'node:path': path,
    './modelManagement': { createModelManager },
    './messageRevisions': {...messageRevisions, getMessageRevisionStore: () => new messageRevisions.MessageRevisionStore(path.join(homePath, 'message-revisions.json'))},
    child_process: {},
    'electron-updater': { autoUpdater: {} },
    'electron-log/main': {},
    'fs/promises': { stat, readFile, writeFile, mkdir },
    http: { request },
    https: { request },
    './cryptoStore': {
      encryptString: (value: string) => `encrypted:${value}`,
      decryptString: (value: string) => value.replace(/^encrypted:/, ''),
    },
    './customScheme': { extensionAuthorities: new Map() },
    './tray': {},
    './ideInstall/constants': { getIdeInstallPath: () => idePath },
  };
  const updater = loadModule('updater', dependencies);
  const customIpc = loadModule('customIpc', dependencies);
  if (customOnly) {
    customIpc.registerCustomModelHandlers();
  } else {
    const ipc = loadModule('ipcHandlers', { ...dependencies, './updater': updater, './customIpc': customIpc });
    ipc.registerIpcHandlers({});
  }
  const globals = { window: { addEventListener: vi.fn() } };
  const customPreload = loadModule('customPreload', dependencies, globals);
  if (!customOnly) loadModule('preload', { ...dependencies, './customPreload': customPreload }, globals);
  return {
    handlers,
    invoke: electron.ipcRenderer.invoke,
    readFile,
    writeFile,
    mkdir,
    homePath,
    exposed,
    updater,
    stat,
    showOpenDialog,
    showItemInFolder,
    idePath,
    send,
    request,
    setResponseStatus: (status: number) => {
      responseStatus = status;
    },
  };
}

describe('renderer compatibility IPC contracts', () => {
  let fixture: ReturnType<typeof createFixture>;
  beforeEach(() => {
    fixture = createFixture();
  });

  it('resolves the renderer startup state before an updater event has occurred', async () => {
    await expect(fixture.exposed.electronUpdater.getState()).resolves.toEqual({ type: 'idle' });
  });

  it('recovers missed updater events and returns independent state snapshots', async () => {
    const state = { type: 'ready', update: { version: '2.12.2' } };
    fixture.updater.broadcastState(state);
    state.update.version = 'mutated input';
    const snapshot = (await fixture.exposed.electronUpdater.getState()) as State;
    expect(snapshot).toEqual({ type: 'ready', update: { version: '2.12.2' } });
    snapshot.update!.version = 'mutated snapshot';
    await expect(fixture.exposed.electronUpdater.getState()).resolves.toEqual({
      type: 'ready',
      update: { version: '2.12.2' },
    });
  });

  it('preserves subscriptions, unsubscribe, and the existing apply API', async () => {
    const changed = vi.fn();
    const unsubscribe = fixture.exposed.electronUpdater.onStateChanged(changed) as () => void;
    await fixture.exposed.electronUpdater.applyUpdate();
    expect(changed).toHaveBeenCalledWith({ type: 'ready' });
    await expect(fixture.exposed.electronUpdater.getState()).resolves.toEqual({ type: 'ready' });
    unsubscribe();
    fixture.updater.broadcastState({ type: 'idle' });
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('returns all selected workspaces while preserving the singular API', async () => {
    const folders = [path.resolve('first folder'), path.resolve('second folder')];
    fixture.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: folders });
    await expect(fixture.exposed.dialog.showOpenMultipleFolderDialog()).resolves.toEqual(folders);
    expect(fixture.showOpenDialog).toHaveBeenLastCalledWith({
      properties: ['openDirectory', 'createDirectory', 'multiSelections'],
      title: 'Open workspaces',
    });
    await expect(fixture.exposed.dialog.showOpenDialog()).resolves.toBe(folders[0]);
    expect(fixture.showOpenDialog.mock.lastCall![0].properties).not.toContain('multiSelections');
  });

  it.each([
    { canceled: true, filePaths: [path.resolve('ignored')] },
    { canceled: false, filePaths: [] },
  ])('returns undefined for a canceled or empty folder selection: %j', async (result) => {
    fixture.showOpenDialog.mockResolvedValue(result);
    await expect(fixture.exposed.dialog.showOpenMultipleFolderDialog()).resolves.toBeUndefined();
  });

  it('reveals an existing absolute path without executing a command', async () => {
    const filename = path.resolve('fixture', 'folder with spaces', 'report.txt');
    fixture.stat.mockResolvedValue({ isDirectory: () => false });
    await expect(fixture.exposed.electronNative.revealInFilePicker(filename)).resolves.toBeUndefined();
    expect(fixture.stat).toHaveBeenCalledWith(filename);
    expect(fixture.showItemInFolder).toHaveBeenCalledWith(filename);
  });

  it.each(['', '   ', 'relative/path', 'https://example.com/file', `bad\0path`, null, 42])(
    'rejects an invalid reveal argument before accessing the filesystem: %j',
    async (filename) => {
      await expect(fixture.exposed.electronNative.revealInFilePicker(filename)).rejects.toThrow(
        'absolute filesystem path',
      );
      expect(fixture.stat).not.toHaveBeenCalled();
      expect(fixture.showItemInFolder).not.toHaveBeenCalled();
    },
  );

  it('does not reveal a missing file', async () => {
    fixture.stat.mockRejectedValue(Object.assign(new Error('File not found'), { code: 'ENOENT' }));
    await expect(fixture.exposed.electronNative.revealInFilePicker(path.resolve('missing'))).rejects.toThrow(
      'File not found',
    );
    expect(fixture.showItemInFolder).not.toHaveBeenCalled();
  });

  it('reports an existing IDE installation directory', async () => {
    fixture.stat.mockResolvedValue({ isDirectory: () => true });
    await expect(fixture.exposed.ide.isInstalled()).resolves.toBe(true);
    expect(fixture.stat).toHaveBeenCalledWith(fixture.idePath);
  });

  it('does not mistake a file for an IDE installation', async () => {
    fixture.stat.mockResolvedValue({ isDirectory: () => false });
    await expect(fixture.exposed.ide.isInstalled()).resolves.toBe(false);
  });

  it.each(['ENOENT', 'EACCES'])('keeps startup working when IDE lookup returns %s', async (code) => {
    fixture.stat.mockRejectedValue(Object.assign(new Error(code), { code }));
    await expect(fixture.exposed.ide.isInstalled()).resolves.toBe(false);
  });

  // Provider HTTP status/body/credential behavior is exercised against real local
  // servers in model-management.test.ts.
});

describe('standalone custom model addon', () => {
  it('persists message revisions through addon IPC and returns a unique opaque transport marker', async () => {
    const fixture = createFixture(true);
    const created: any = await fixture.invoke('messages:create-revision', {conversationId:'fixture-c',targetOrdinal:0,targetStepIndex:0,originalText:'before',text:'after'});
    expect(created.success).toBe(true); expect(created.message).toContain('AGY_REVISION:');
    const loaded: any = await fixture.invoke('messages:list-revisions', 'fixture-c');
    expect(loaded.revisions).toEqual([created.revision]);
    expect(await fixture.invoke('messages:list-revisions', 'other-c')).toEqual({success:true,revisions:[]});
  });

  it('registers only addon storage channels and exposes no replacement renderer APIs', () => {
    const fixture = createFixture(true);
    expect([...fixture.handlers.keys()]).toEqual([
      'plus-channels:status', 'plus-channels:open', 'plus-channels:dismiss',
      'plus-customizations:themes', 'plus-customizations:theme-read', 'plus-customizations:themes-open', 'plus-plugins:list', 'plus-plugins:open', 'plus-plugins:set-enabled', 'plus-customizations:read', 'plus-customizations:save',
      'gemini-web:stage-file', 'gemini-web:release-file', 'gemini-web:pick-files', 'gemini-web:tools', 'gemini-web:stop', 'gemini-web:dialog-action', 'gemini-web:select-tool', 'gemini-web:edit', 'gemini-web:media',
      'gemini-web:configure', 'gemini-web:open', 'gemini-web:status',
      'gemini-web:snapshot', 'gemini-web:navigate', 'gemini-web:models', 'gemini-web:select-model', 'gemini-web:ask',
      'telemetry:read', 'pool:history', 'pool:fallback-models', 'plus:diagnostics', 'storage:inspect-space', 'storage:clean-space',
      'messages:list-revisions',
      'messages:create-revision',
      'storage:get-custom-models',
      'storage:save-custom-model',
      'storage:delete-custom-model',
      'storage:test-model-connection',
      'storage:get-provider-presets',
      'storage:discover-models',
      'storage:discover-local',
      'storage:export-custom-models',
      'storage:import-custom-models',
      'storage:get-gateway',
      'storage:save-gateway',
      'storage:test-gateway',
      'storage:import-gateway-models',
      'storage:open-gateway-dashboard',
      'storage:google-login',
      'storage:google-login-cancel',
      'storage:google-test-account',
      'storage:google-pool-status',
      'pool:get-status',
      'pool:capture-native',
      'pool:start-login',
      'pool:cancel-login',
      'pool:set-active',
      'pool:set-options',
      'plus:check-admin',
      'plus:relaunch-admin',
      'pool:remove-account',
      'pool:refresh-quota',
      'pool:export-config',
      'pool:import-config',
      'sound:get-audio-data',
      'sound:play-sound-native',
      'plus:get-version',
      'plus:check-update',
      'plus:download-and-apply-update',
    ]);
    expect(fixture.exposed).toEqual({});
  });

  it('persists, masks, edits and deletes models using the existing configuration location', async () => {
    const fixture = createFixture(true);
    const model = {
      name: 'models/my-model',
      displayName: 'My model',
      provider: 'openai',
      apiUrl: 'https://provider.example/v1',
      apiKey: 'secret-long-api-key',
      externalModelName: 'provider-model',
    };
    await expect(fixture.invoke('storage:save-custom-model', { ...model })).resolves.toEqual({ success: true });
    const filename = path.join(fixture.homePath, '.gemini', 'antigravity', 'custom_models.json');
    const persisted = JSON.parse(readFileSync(filename, 'utf8'));
    expect(persisted.models).toEqual([{ ...model, apiKey: 'encrypted:secret-long-api-key', encrypted: true }]);

    const models = (await fixture.invoke('storage:get-custom-models')) as Array<typeof model>;
    expect(models[0].apiKey).toBe('********');
    await fixture.invoke('storage:save-custom-model', { ...models[0], displayName: 'Renamed model' });
    const edited = JSON.parse(readFileSync(filename, 'utf8'));
    expect(edited.models).toHaveLength(1);
    expect(edited.models[0]).toMatchObject({
      displayName: 'Renamed model',
      apiKey: 'encrypted:secret-long-api-key',
      encrypted: true,
    });

    await expect(fixture.invoke('storage:delete-custom-model', model.name)).resolves.toEqual({ success: true });
    await expect(fixture.invoke('storage:get-custom-models')).resolves.toEqual([]);
  });

  it('keeps provider connectivity failures available through its own IPC handler', async () => {
    const fixture = createFixture(true);

    await expect(
      fixture.invoke('storage:test-model-connection', {
        apiUrl: 'file:///not-an-api',
        provider: 'openai',
      }),
    ).resolves.toMatchObject({ success: false, error: expect.stringContaining('HTTP(S)') });
  });

  it('guarantees custom IPC handlers do not collide with vanilla IPC channels', () => {
    const customFixture = createFixture(true);
    const customChannels = new Set(customFixture.handlers.keys());
    const vanillaChannels = [
      'dialog:open-workspace',
      'dialog:open-workspaces',
      'updater:apply',
      'updater:quit-and-install',
      'updater:get-state',
      'notification:send',
      'storage:get-items',
      'storage:update-items',
      'logs:electron',
      'extensions:send-authorities',
      'agent:update-active-count',
      'window:minimize',
      'window:maximize',
      'window:unmaximize',
      'window:is-maximized',
      'window:close',
      'window:toggle-devtools',
      'updater:check-for-updates',
      'shell:open-external',
      'shell:reveal-in-file-picker',
      'ide:is-installed',
    ];
    for (const channel of vanillaChannels) {
      expect(customChannels.has(channel)).toBe(false);
    }
  });
});

