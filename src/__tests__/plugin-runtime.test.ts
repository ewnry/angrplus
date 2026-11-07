import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
const mocks = vi.hoisted(() => ({ app: new (require('node:events').EventEmitter)(), plugins: [] as any[] }));
vi.mock('electron', () => ({ app: mocks.app, BrowserWindow: class {} }));
vi.mock('../pluginCatalog', () => ({ discoverPlugins: () => mocks.plugins, pluginDirectory: () => 'plugins', pluginFile: (_dir: string, file: string) => file }));
import { installPlugins } from '../pluginRuntime';
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
