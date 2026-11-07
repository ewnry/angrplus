import * as fs from 'node:fs';
import { app, BrowserWindow } from 'electron';
import { discoverPlugins, pluginFile, pluginDirectory } from './pluginCatalog';
import { createPluginUI } from './pluginUI';

export function installPlugins(getLanguageServerPort: () => number): void {
  const plugins = discoverPlugins().filter(p => p.manifest.enabled);
  const disposers: Array<() => void> = [];
  for (const plugin of plugins) {
    const {manifest, directory} = plugin;
    if (!manifest.main) continue;
    try {
      const entry = require(pluginFile(directory, manifest.main));
      const activate = typeof entry === 'function' ? entry : entry.activate;
      if (typeof activate !== 'function') throw new Error('main must export activate(api)');
      const ui = createPluginUI(manifest.id);
      disposers.push(() => ui.dispose());
      const data = Object.freeze({ json: async (url: string) => { const response = await fetch(url); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }, languageServer: () => ({ port: getLanguageServerPort(), ready: getLanguageServerPort() > 0 }) });
      const api = Object.freeze({ id: manifest.id, ui, data, app, BrowserWindow, electron: require('electron'), getLanguageServerPort, pluginsDirectory: pluginDirectory(), log: (...args: unknown[]) => console.log(`[Antigravity+ plugin ${manifest.id}]`, ...args) });
      const dispose = activate(api);
      if (typeof dispose === 'function') disposers.push(dispose);
      else if (dispose && typeof dispose.then === 'function') void dispose.then((d: unknown) => { if (typeof d === 'function') disposers.push(d as () => void); }).catch((e: unknown) => console.error(`[Antigravity+ plugin ${manifest.id}]`, e));
    } catch (error) { console.error(`[Antigravity+ plugin ${manifest.id}]`, error); }
  }
  app.on('web-contents-created', (_event: unknown, contents: any) => {
    if (contents.getType() !== 'window') return;
    contents.on('dom-ready', () => {
      const url = contents.getURL();
      if (!/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url)) return;
      for (const {manifest, directory} of plugins) {
        try {
          if (manifest.css) void contents.insertCSS(fs.readFileSync(pluginFile(directory, manifest.css), 'utf8')).catch((e: unknown) => console.error('[Antigravity+ plugin CSS]', e));
          if (manifest.renderer) {
            const code = fs.readFileSync(pluginFile(directory, manifest.renderer), 'utf8');
            void contents.executeJavaScript(`(()=>{\n${code}\n})()`).catch((e: unknown) => console.error(`[Antigravity+ plugin ${manifest.id}]`, e));
          }
        } catch (error) { console.error(`[Antigravity+ plugin ${manifest.id}]`, error); }
      }
    });
  });
  app.on('before-quit', () => { for (const dispose of disposers.splice(0).reverse()) try { dispose(); } catch (error) { console.error('[Antigravity+ plugin shutdown]', error); } });
}
