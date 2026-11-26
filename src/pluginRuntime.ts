import * as fs from 'node:fs';
import { app, BrowserWindow, ipcMain } from 'electron';
import { discoverPlugins, pluginFile, pluginDirectory } from './pluginCatalog';
import { createPluginUI } from './pluginUI';

// This self-contained function is serialized into the plugin renderer world.
export function createRendererApi(id: string) {
  const cleanups = new Set<() => void>();
  let requestSequence = 0;
  const callPool = (method: string, args: unknown[] = []): Promise<any> => new Promise((resolve, reject) => {
    const requestId = `${id}:${Date.now()}:${++requestSequence}:${Math.random().toString(36).slice(2)}`;
    let finished = false;
    const finish = (error?: string, value?: unknown) => { if (finished) return; finished = true; clearTimeout(timer); window.removeEventListener('agy:plugin-response', listener); cleanups.delete(cancel); if (error) reject(new Error(error)); else resolve(value); };
    const listener = (event: Event) => {
      try { const result = JSON.parse((event as CustomEvent<string>).detail); if (result.requestId === requestId) finish(result.error, result.value); } catch { /* unrelated event */ }
    };
    const cancel = () => finish('Plugin renderer closed');
    const timer = setTimeout(() => finish('Plugin request timed out'), 10000);
    cleanups.add(cancel); window.addEventListener('agy:plugin-response', listener);
    window.dispatchEvent(new CustomEvent('agy:plugin-request', { detail: JSON.stringify({ pluginId: id, requestId, method, args }) }));
  });
  const pool = Object.freeze({ status: () => callPool('pool.status'), activate: (accountId: string) => callPool('pool.activate', [accountId]), setAutoHotswap: (enabled: boolean) => callPool('pool.setAutoHotswap', [enabled]) });
  const modelProps = (): any => {
    const element = document.querySelector('[data-testid="model-selector-trigger"]');
    const key = element && Object.keys(element).find(name => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
    let fiber = element && key && (element as any)[key];
    while (fiber) { if (fiber.memoizedProps?.modelOptions && typeof fiber.memoizedProps.setSelectedModel === 'function') return fiber.memoizedProps; fiber = fiber.return; }
    return null;
  };
  const family = (label: string) => label.replace(/\s*\((?:Low|Medium|High|Thinking|Auto)\)\s*$/i, '').trim();
  const models = Object.freeze({
    get: () => {
      const props = modelProps();
      if (!props) return { ready: false, selected: null, options: [] };
      const normalize = (option: any) => ({ label: String(option.label || ''), value: option.value, disabled: !!option.disabled });
      return { ready: true, selected: props.selectedModel ? normalize(props.selectedModel) : null, options: (Array.isArray(props.modelOptions) ? props.modelOptions : []).map(normalize) };
    },
    select: async (value: string | number) => {
      const props = modelProps(), option = props?.modelOptions?.find((item: any) => String(item.value) === String(value) && !item.disabled);
      if (!option) return false;
      const accepted = await props.setSelectedModel(option); if (accepted === false) return false;
      props.setIsOpen?.(false); return true;
    },
    effort: () => {
      const props = modelProps(), label = String(props?.selectedModel?.label || ''), currentFamily = family(label);
      const options = ['Low', 'Medium', 'High'].filter(level => props?.modelOptions?.some((item: any) => !item.disabled && family(String(item.label || '')) === currentFamily && new RegExp(`\\b${level}\\b`, 'i').test(String(item.label || ''))));
      return { selected: options.find(level => new RegExp(`\\b${level}\\b`, 'i').test(label)) || null, options };
    },
    setEffort: async (value: string) => {
      if (!['Low', 'Medium', 'High'].includes(value)) return false;
      const props = modelProps(), currentFamily = family(String(props?.selectedModel?.label || ''));
      const option = props?.modelOptions?.find((item: any) => !item.disabled && family(String(item.label || '')) === currentFamily && new RegExp(`\\b${value}\\b`, 'i').test(String(item.label || '')));
      if (!option) return false;
      const accepted = await props.setSelectedModel(option); if (accepted === false) return false;
      props.setIsOpen?.(false); return true;
    },
    subscribe: (callback: (state: any) => void) => {
      if (typeof callback !== 'function') throw new Error('Expected a callback');
      let last = '', pending = false, stopped = false;
      const emit = () => { pending = false; if (stopped) return; const state = models.get(), serialized = JSON.stringify(state); if (serialized !== last) { last = serialized; callback(state); } };
      const observer = new MutationObserver(() => { if (!pending) { pending = true; queueMicrotask(emit); } });
      observer.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
      const dispose = () => { stopped = true; observer.disconnect(); cleanups.delete(dispose); }; cleanups.add(dispose); emit(); return dispose;
    },
  });
  const permissions = Object.freeze({
    get: () => { const trigger = document.querySelector<HTMLButtonElement>('[data-testid="permissions-selector-trigger"]'); return { available: !!trigger && !trigger.disabled, selected: trigger?.textContent?.trim() || '' }; },
    open: () => { const trigger = document.querySelector<HTMLButtonElement>('[data-testid="permissions-selector-trigger"]'); if (!trigger || trigger.disabled) return false; trigger.click(); return true; },
    select: async (label: string) => {
      const trigger = document.querySelector<HTMLButtonElement>('[data-testid="permissions-selector-trigger"]');
      if (!trigger || trigger.disabled || !label.trim()) return false;
      if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline) {
        const controlled = trigger.getAttribute('aria-controls');
        const menu = controlled ? document.getElementById(controlled) : document.querySelector('[role="menu"][data-state="open"], [role="listbox"][data-state="open"]');
        const items = menu ? Array.from(menu.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [role="option"], button')) : [];
        const item = items.find(entry => !entry.hasAttribute('disabled') && [entry.getAttribute('aria-label'), entry.textContent, ...Array.from(entry.querySelectorAll('span, strong, div')).map(node => node.textContent)].some(text => (text || '').trim().toLowerCase() === label.trim().toLowerCase()));
        if (item) { item.click(); return true; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (trigger.getAttribute('aria-expanded') === 'true') trigger.click();
      return false;
    },
  });
  const ui = {
    find: (selector: string) => document.querySelector<HTMLElement>(selector),
    click: (selector: string) => { const el = document.querySelector<HTMLElement>(selector); if (!el || (el as HTMLButtonElement).disabled) return false; el.click(); return true; },
    setValue: (selector: string, value: string) => {
      const el = document.querySelector<HTMLElement>(selector);
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value);
      } else if (el?.isContentEditable) el.textContent = value;
      else return false;
      el.dispatchEvent(new Event('input', { bubbles: true })); el.dispatchEvent(new Event('change', { bubbles: true })); return true;
    },
    replace: (selector: string, render: (original: HTMLElement) => HTMLElement) => {
      if (typeof selector !== 'string' || typeof render !== 'function') throw new Error('ui.replace expects a selector and render function');
      let original: HTMLElement | null = null, replacement: HTMLElement | null = null, stopped = false, oldDisplay = '', oldPriority = '';
      const restore = () => { if (original) { if (oldDisplay) original.style.setProperty('display', oldDisplay, oldPriority); else original.style.removeProperty('display'); } replacement?.remove(); original = null; replacement = null; };
      const attach = () => {
        if (stopped || (original?.isConnected && replacement?.isConnected)) return;
        restore(); const target = document.querySelector<HTMLElement>(selector); if (!target?.parentElement) return;
        const node = render(target); if (!(node instanceof HTMLElement) || node === target || node.contains(target)) throw new Error('ui.replace render must return a new HTML element');
        original = target; replacement = node; oldDisplay = target.style.getPropertyValue('display'); oldPriority = target.style.getPropertyPriority('display');
        target.style.setProperty('display', 'none', 'important'); node.setAttribute('data-agy-custom-view', ''); target.after(node);
      };
      const observer = new MutationObserver(() => { try { attach(); } catch (error) { console.error('[Antigravity+ plugin UI]', error); } });
      observer.observe(document.documentElement, { childList: true, subtree: true });
      try { attach(); } catch (error) { observer.disconnect(); restore(); throw error; }
      const dispose = () => { if (stopped) return; stopped = true; observer.disconnect(); restore(); cleanups.delete(dispose); };
      cleanups.add(dispose); return dispose;
    },
  };
  return Object.freeze({ id, ui: Object.freeze(ui), models, permissions, pool, dispose: () => { for (const cleanup of [...cleanups]) cleanup(); }, log: (...args: unknown[]) => console.log(`[Antigravity+ plugin ${id}]`, ...args) });
}

export function createPluginPoolApi() {
  return Object.freeze({
    status: () => {
      const accountPool = require('./accountPool'), cfg = accountPool.loadPoolConfig();
      return { activeAccountId: cfg.activeAccountId || null, autoHotswap: cfg.autoHotswap !== false, accounts: cfg.accounts.map((account: any) => ({ id: account.id, name: account.name, email: account.email, label: account.label, isActive: account.id === cfg.activeAccountId, lastQuota: account.lastQuota, cooldownUntil: account.cooldownUntil || 0 })) };
    },
    activate: (id: string) => {
      const accountPool = require('./accountPool'), cfg = accountPool.loadPoolConfig();
      if (typeof id !== 'string' || !cfg.accounts.some((account: any) => account.id === id)) return false;
      cfg.activeAccountId = id; accountPool.savePoolConfig(cfg); return true;
    },
    setAutoHotswap: (enabled: boolean) => { if (typeof enabled !== 'boolean') throw new Error('Expected a boolean'); const accountPool = require('./accountPool'), cfg = accountPool.loadPoolConfig(); cfg.autoHotswap = enabled; accountPool.savePoolConfig(cfg); },
  });
}

export function installPlugins(getLanguageServerPort: () => number): void {
  const plugins = discoverPlugins().filter(p => p.manifest.enabled);
  const enabledIds = new Set(plugins.map(plugin => plugin.manifest.id));
  const pool = createPluginPoolApi();
  ipcMain.handle('plus-plugin:call', async (event: any, request: any) => {
    const url = event.senderFrame?.url || '';
    let origin: URL;
    try { origin = new URL(url); } catch { throw new Error('Plugin request is not authorized'); }
    if (!['http:', 'https:'].includes(origin.protocol) || !['localhost', '127.0.0.1'].includes(origin.hostname) || Number(origin.port) !== getLanguageServerPort() || event.senderFrame !== event.sender.mainFrame || !enabledIds.has(request?.pluginId)) throw new Error('Plugin request is not authorized');
    if (!Array.isArray(request.args)) throw new Error('Invalid plugin request');
    if (request.method === 'pool.status' && request.args.length === 0) return pool.status();
    if (request.method === 'pool.activate' && request.args.length === 1) return pool.activate(request.args[0]);
    if (request.method === 'pool.setAutoHotswap' && request.args.length === 1) return pool.setAutoHotswap(request.args[0]);
    throw new Error('Unknown plugin request');
  });
  const disposers: Array<() => void> = [];
  for (const plugin of plugins) {
    const {manifest, directory} = plugin;
    if (!manifest.main) continue;
    const registeredProviders: Array<() => void> = [];
    try {
      const entry = require(pluginFile(directory, manifest.main));
      const activate = typeof entry === 'function' ? entry : entry.activate;
      if (typeof activate !== 'function') throw new Error('main must export activate(api)');
      const ui = createPluginUI(manifest.id);
      disposers.push(() => ui.dispose());
      const data = Object.freeze({ json: async (url: string) => { const response = await fetch(url); if (!response.ok) throw new Error(`HTTP ${response.status}`); return response.json(); }, languageServer: () => ({ port: getLanguageServerPort(), ready: getLanguageServerPort() > 0 }) });
      // Trusted plugins can opt into the same low-level modules used by the patcher.
      const modules = Object.freeze({ accountPool: () => require('./accountPool'), proxy: () => require('./proxy'), network: () => require('./networkRoute'), models: () => require('./modelStore'), electron: () => require('electron') });
      const pluginPool = Object.freeze({ ...pool, registerProvider: (provider: any) => { const dispose = require('./proxy').registerAccountProvider(provider); registeredProviders.push(dispose); disposers.push(dispose); return dispose; } });
      const api = Object.freeze({ id: manifest.id, ui, data, pool: pluginPool, modules, app, BrowserWindow, electron: require('electron'), getLanguageServerPort, pluginsDirectory: pluginDirectory(), log: (...args: unknown[]) => console.log(`[Antigravity+ plugin ${manifest.id}]`, ...args) });
      const dispose = activate(api);
      if (typeof dispose === 'function') disposers.push(dispose);
      else if (dispose && typeof dispose.then === 'function') void dispose.then((d: unknown) => { if (typeof d === 'function') disposers.push(d as () => void); }).catch((e: unknown) => { for (const cleanup of registeredProviders) cleanup(); console.error(`[Antigravity+ plugin ${manifest.id}]`, e); });
    } catch (error) { for (const cleanup of registeredProviders) cleanup(); console.error(`[Antigravity+ plugin ${manifest.id}]`, error); }
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
            void contents.executeJavaScript(`(()=>{const api=(${createRendererApi.toString()})(${JSON.stringify(manifest.id)});window.addEventListener('beforeunload',()=>api.dispose(),{once:true});{\n${code}\n}})()`).catch((e: unknown) => console.error(`[Antigravity+ plugin ${manifest.id}]`, e));
          }
        } catch (error) { console.error(`[Antigravity+ plugin ${manifest.id}]`, error); }
      }
    });
  });
  app.on('before-quit', () => { for (const dispose of disposers.splice(0).reverse()) try { dispose(); } catch (error) { console.error('[Antigravity+ plugin shutdown]', error); } });
}
