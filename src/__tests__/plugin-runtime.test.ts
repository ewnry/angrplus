import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
const mocks = vi.hoisted(() => ({ app: new (require('node:events').EventEmitter)(), plugins: [] as any[], handlers: new Map<string, any>() }));
vi.mock('electron', () => ({ app: mocks.app, BrowserWindow: class {}, ipcMain: { handle: (name: string, fn: any) => mocks.handlers.set(name, fn) } }));
vi.mock('../pluginCatalog', () => ({ discoverPlugins: () => mocks.plugins, pluginDirectory: () => 'plugins', pluginFile: (_dir: string, file: string) => file }));
import { installPlugins } from '../pluginRuntime';
import { JSDOM } from 'jsdom';
import { runInNewContext } from 'node:vm';
it('injects enabled renderer and CSS only into local application windows', async () => {
  const fs = await import('node:fs');
  const os = await import('node:os'); const path = await import('node:path'); const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-runtime-')); const script = path.join(dir, 'renderer.js'), css = path.join(dir, 'style.css'); fs.writeFileSync(script, 'window.pluginLoaded = true'); fs.writeFileSync(css, 'body { color: red }');
  mocks.plugins.push({directory:'plugin',manifest:{id:'test',enabled:true,renderer:script,css:css}});
  installPlugins(() => 1234);
  const contents = new EventEmitter() as any; contents.getType = () => 'window'; contents.getURL = () => 'http://127.0.0.1:1234/'; contents.insertCSS = vi.fn().mockResolvedValue('key'); contents.executeJavaScript = vi.fn().mockResolvedValue(undefined);
  mocks.app.emit('web-contents-created', {}, contents); contents.emit('dom-ready');
  expect(contents.insertCSS).toHaveBeenCalledOnce(); expect(contents.executeJavaScript).toHaveBeenCalledOnce();
  contents.getURL = () => 'https://example.com/'; contents.emit('dom-ready'); expect(contents.executeJavaScript).toHaveBeenCalledOnce();
  fs.rmSync(dir, { recursive: true, force: true }); mocks.plugins.length = 0; mocks.app.removeAllListeners();
});

it('provides renderer plugins a working replacement API with cleanup', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-plugin-ui-')); const script = path.join(dir, 'renderer.js');
  fs.writeFileSync(script, `api.ui.replace('#native', original => { const b=document.createElement('button'); b.id='custom'; b.onclick=()=>original.click(); return b; });`);
  mocks.plugins.push({ directory: 'plugin', manifest: { id: 'testui', enabled: true, renderer: script } }); installPlugins(() => 1234);
  const contents = new EventEmitter() as any; contents.getType = () => 'window'; contents.getURL = () => 'http://127.0.0.1:1234/'; contents.executeJavaScript = vi.fn().mockResolvedValue(undefined);
  mocks.app.emit('web-contents-created', {}, contents); contents.emit('dom-ready');
  const dom = new JSDOM('<body><button id="native">Native</button></body>');
  const clicked = vi.fn(); dom.window.document.querySelector('#native')!.addEventListener('click', clicked);
  runInNewContext(contents.executeJavaScript.mock.calls[0][0], { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event, console });
  (dom.window.document.querySelector('#custom') as HTMLButtonElement).click(); expect(clicked).toHaveBeenCalledOnce();
  dom.window.dispatchEvent(new dom.window.Event('beforeunload')); expect(dom.window.document.querySelector('#custom')).toBeNull();
  expect((dom.window.document.querySelector('#native') as HTMLElement).style.display).toBe('');
  fs.rmSync(dir, { recursive: true, force: true }); mocks.plugins.length = 0; mocks.app.removeAllListeners();
});

it('reads real model props and invokes model, effort and permission actions', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-model-api-')); const script = path.join(dir, 'renderer.js');
  fs.writeFileSync(script, 'window.testApi = api;');
  mocks.plugins.push({ directory: 'plugin', manifest: { id: 'models', enabled: true, renderer: script } }); installPlugins(() => 1234);
  const contents = new EventEmitter() as any; contents.getType = () => 'window'; contents.getURL = () => 'http://127.0.0.1:1234/'; contents.executeJavaScript = vi.fn().mockResolvedValue(undefined);
  mocks.app.emit('web-contents-created', {}, contents); contents.emit('dom-ready');
  const dom = new JSDOM('<body><button data-testid="model-selector-trigger"></button><button data-testid="permissions-selector-trigger" aria-controls="mode-menu" aria-expanded="true">Default</button><div id="mode-menu" role="menu"><button role="menuitem">Turbo</button></div></body>');
  const options = [{ label: 'Example (Low)', value: 1 }, { label: 'Example (High)', value: 2 }, { label: 'Other (High)', value: 3 }, { label: 'Example (Medium)', value: 4, disabled: true }];
  const setSelectedModel = vi.fn(); const trigger = dom.window.document.querySelector('[data-testid="model-selector-trigger"]') as any;
  trigger.__reactFiber$test = { memoizedProps: { modelOptions: options, selectedModel: options[0], setSelectedModel } };
  const selected = vi.fn(); dom.window.document.querySelector('#mode-menu button')!.addEventListener('click', selected);
  runInNewContext(contents.executeJavaScript.mock.calls[0][0], { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event, console, setTimeout, queueMicrotask });
  const api = (dom.window as any).testApi;
  expect(api.models.get().options).toHaveLength(4);
  expect(Array.from(api.models.effort().options)).toEqual(['Low', 'High']);
  expect(await api.models.setEffort('High')).toBe(true); expect(setSelectedModel).toHaveBeenCalledWith(options[1]);
  expect(await api.models.select(4)).toBe(false);
  expect(await api.permissions.select('Turbo')).toBe(true); expect(selected).toHaveBeenCalledOnce();
  dom.window.dispatchEvent(new dom.window.Event('beforeunload')); fs.rmSync(dir, { recursive: true, force: true }); mocks.plugins.length = 0; mocks.app.removeAllListeners();
});

it('connects renderer pool methods to the bridge and rejects untrusted callers', async () => {
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-pool-api-')); const script = path.join(dir, 'renderer.js'); fs.writeFileSync(script, 'window.testApi = api;');
  mocks.plugins.push({ directory: 'plugin', manifest: { id: 'pool-test', enabled: true, renderer: script } }); installPlugins(() => 1234);
  const contents = new EventEmitter() as any; contents.getType = () => 'window'; contents.getURL = () => 'http://127.0.0.1:1234/'; contents.executeJavaScript = vi.fn().mockResolvedValue(undefined);
  mocks.app.emit('web-contents-created', {}, contents); contents.emit('dom-ready');
  const handler = mocks.handlers.get('plus-plugin:call'); const frame = { url: 'https://127.0.0.1:1234/' };
  await expect(handler({ senderFrame: { url: 'https://example.com/' }, sender: { mainFrame: frame } }, { pluginId: 'pool-test', method: 'pool.status', args: [] })).rejects.toThrow('not authorized');
  await expect(handler({ senderFrame: frame, sender: { mainFrame: frame } }, { pluginId: 'other', method: 'pool.status', args: [] })).rejects.toThrow('not authorized');
  const dom = new JSDOM('<body></body>');
  dom.window.addEventListener('agy:plugin-request', (event: any) => { const request = JSON.parse(event.detail); dom.window.dispatchEvent(new dom.window.CustomEvent('agy:plugin-response', { detail: JSON.stringify({ requestId: request.requestId, value: { activeAccountId: 'one', accounts: [] } }) })); });
  runInNewContext(contents.executeJavaScript.mock.calls[0][0], { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event, CustomEvent: dom.window.CustomEvent, console, setTimeout, clearTimeout, queueMicrotask });
  expect((await (dom.window as any).testApi.pool.status()).activeAccountId).toBe('one');
  dom.window.dispatchEvent(new dom.window.Event('beforeunload')); fs.rmSync(dir, { recursive: true, force: true }); mocks.plugins.length = 0; mocks.app.removeAllListeners();
});
