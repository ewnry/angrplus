import { app, BrowserWindow } from 'electron';

type Place = 'top-right' | 'bottom-right' | 'top-left' | 'bottom-left';
export interface PanelOptions { id: string; title: string; position?: Place; className?: string; read: () => unknown | Promise<unknown>; refreshMs?: number; }
type WindowLike = { webContents: any; on: (event: string, listener: (...args: any[]) => void) => unknown; removeListener?: (event: string, listener: (...args: any[]) => void) => unknown; isDestroyed: () => boolean };
const localPage = (url: string): boolean => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?\//i.test(url);

export function createPluginUI(pluginId: string) {
  const panels = new Map<string, () => void>();
  function panel(options: PanelOptions): () => void {
    if (!options || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(options.id) || typeof options.title !== 'string' || typeof options.read !== 'function') throw new Error('Invalid panel definition');
    if (panels.has(options.id)) throw new Error(`Panel already registered: ${options.id}`);
    const position = options.position || 'bottom-right';
    if (!['top-right','bottom-right','top-left','bottom-left'].includes(position)) throw new Error('Invalid panel position');
    const refreshMs = options.refreshMs === undefined ? 0 : options.refreshMs;
    if (!Number.isFinite(refreshMs) || refreshMs < 0 || (refreshMs > 0 && refreshMs < 1000)) throw new Error('refreshMs must be 0 or at least 1000');
    const key = `agy-plugin-panel-${pluginId}-${options.id}`, windows = new Map<any, () => void>();
    let stopped = false;
    const attach = (win: WindowLike) => {
      if (stopped || !win || windows.has(win) || win.isDestroyed()) return;
      const wc = win.webContents; let timer: ReturnType<typeof setInterval> | undefined, closed = false, loading = false, pending = false, generation = 0;
      const refresh = async () => {
        if (stopped || closed || wc.isDestroyed() || !localPage(wc.getURL())) return;
        if (loading) { pending = true; return; }
        const current = generation; loading = true;
        try {
          const value = await options.read();
          if (stopped || closed || current !== generation || wc.isDestroyed() || !localPage(wc.getURL())) return;
          const content = value == null ? '' : typeof value === 'string' ? value : JSON.stringify(value, null, 2);
          const model = JSON.stringify({key, title: options.title, position: options.position || '', className: options.className || '', content}).replace(/</g, '\\u003c');
          await wc.executeJavaScript(`(()=>{const m=${model};let el=document.getElementById(m.key);if(!el){el=document.createElement('section');el.id=m.key;el.setAttribute('role','region');el.setAttribute('aria-label',m.title);el.className=m.className;el.dataset.agyPluginPanel='';if(m.position){el.dataset.agyPosition=m.position;let sheet=document.getElementById('agy-plugin-position-style');if(!sheet){sheet=document.createElement('style');sheet.id='agy-plugin-position-style';sheet.textContent=':where([data-agy-plugin-panel][data-agy-position]){position:fixed;z-index:1000}:where([data-agy-position^=top]){top:16px}:where([data-agy-position^=bottom]){bottom:16px}:where([data-agy-position$=left]){left:16px}:where([data-agy-position$=right]){right:16px}';document.head.appendChild(sheet)}};const h=document.createElement('strong');h.className='agy-panel-title';const v=document.createElement('pre');v.className='agy-panel-value';el.append(h,v);document.body.appendChild(el)}el.querySelector('.agy-panel-title').textContent=m.title;el.querySelector('.agy-panel-value').textContent=m.content;})()`);
        } catch (error) { console.error(`[Antigravity+ plugin ${pluginId} panel ${options.id}]`, error); }
        finally { loading = false; if (pending) { pending = false; void refresh(); } }
      };
      const ready = () => { generation++; void refresh(); };
      const cleanup = () => { if (closed) return; closed = true; generation++; if (timer) clearInterval(timer); wc.removeListener('dom-ready', ready); win.removeListener?.('closed', cleanup); windows.delete(win); };
      wc.on('dom-ready', ready); win.on('closed', cleanup);
      if (refreshMs) { timer = setInterval(() => void refresh(), refreshMs); timer.unref?.(); }
      windows.set(win, cleanup); if (localPage(wc.getURL())) void refresh();
    };
    const onWindow = (_event: unknown, win: WindowLike) => attach(win);
    app.on('browser-window-created', onWindow);
    for (const win of BrowserWindow.getAllWindows()) attach(win as unknown as WindowLike);
    const dispose = () => {
      if (stopped) return; stopped = true; (app as any).removeListener('browser-window-created', onWindow);
      for (const [win, cleanup] of windows) { const wc = win.webContents; if (!wc.isDestroyed() && localPage(wc.getURL())) void wc.executeJavaScript(`document.getElementById(${JSON.stringify(key)})?.remove()`).catch(() => {}); cleanup(); }
      panels.delete(options.id);
    };
    panels.set(options.id, dispose); return dispose;
  }
  return { panel, dispose: () => { for (const dispose of [...panels.values()]) dispose(); } };
}
