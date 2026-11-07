import { WebContentsView, type BrowserWindowInstance } from 'electron';

export const MINIMUM_SPLASH_MS = 3200;

export function getLoadingHtml(foregroundColor: string, backgroundColor: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { margin: 0; height: 100vh; display: grid; place-items: center; overflow: hidden;
      background: ${backgroundColor}; color: ${foregroundColor}; font-family: system-ui, -apple-system, sans-serif;
      -webkit-app-region: drag; user-select: none; }
    .brand { display: flex; align-items: center; justify-content: center; animation: shimmer 2.8s ease-in-out infinite; }
    .mark { width: 66px; height: 66px; flex: none; position: relative; animation: mark-in .65s cubic-bezier(.22,.61,.36,1) both; }
    .mark > svg:not(.badge) { width: 100%; height: 100%;  }
    .badge { position: absolute; right: 6px; top: 9px; width: 10px; height: 10px;
      color: inherit; opacity: 0; transform: scale(.3); animation: badge-in .65s .65s cubic-bezier(.22,.61,.36,1) forwards; }
    .word-wrap { overflow: hidden; max-width: 0; animation: reveal 1.15s 1.15s cubic-bezier(.22,.61,.36,1) forwards; }
    .word { display: flex; align-items: baseline; white-space: nowrap; padding-left: 8px;
      font-size: 26px; letter-spacing: -.035em; font-weight: 500; }
    .plus { display: inline-block; opacity: 0; animation: drop .65s 2.1s cubic-bezier(.22,.61,.36,1) forwards; }
    @keyframes shimmer { 0%, 100% { opacity: .58; } 50% { opacity: 1; } }
    @keyframes mark-in { from { opacity: 0; transform: scale(.92); } to { opacity: 1; transform: scale(1); } }
    @keyframes badge-in { to { opacity: 1; transform: scale(1); } }
    @keyframes reveal { to { max-width: 240px; } }
    @keyframes drop { from { opacity: 0; transform: translateY(-15px); } to { opacity: 1; transform: translateY(0); } }
    @media (prefers-reduced-motion: reduce) { .brand, .mark, .mark > svg:not(.badge), .badge, .word-wrap, .plus { animation: none; opacity: 1; transform: none; } .word-wrap { max-width: 240px; } }
  </style></head><body><div class="brand" role="status" aria-label="Loading Antigravity Plus">
    <div class="mark"><svg viewBox="0 0 180 180" aria-hidden="true"><path fill="currentColor" d="M144.248 149.062C151.748 154.688 162.998 150.938 152.685 140.625C121.748 110.625 128.31 28.125 89.8727 28.125C51.4352 28.125 57.9977 110.625 27.0602 140.625C15.8102 151.875 27.9977 154.688 35.4977 149.062C64.5602 129.375 62.6852 94.6875 89.8727 94.6875C117.06 94.6875 115.185 129.375 144.248 149.062Z"/></svg>
      <svg class="badge" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v18M3 12h18" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/></svg></div>
    <div class="word-wrap"><div class="word">Antigravity<span class="plus">+</span></div></div>
  </div></body></html>`;
}

export function attachLoadingOverlay(win: BrowserWindowInstance, foregroundColor: string, backgroundColor: string): void {
  const view = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true } });
  const started = Date.now();
  void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(getLoadingHtml(foregroundColor, backgroundColor))}`);
  win.contentView.addChildView(view);
  const updateBounds = () => { if (!win.isDestroyed()) { const [width, height] = win.getContentSize(); view.setBounds({ x: 0, y: 0, width, height }); } };
  updateBounds();
  win.on('resize', updateBounds);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cleanup = () => { if (timer) clearTimeout(timer); win.off('resize', updateBounds); if (!win.isDestroyed()) { try { win.contentView.removeChildView(view); } catch { /* Window already closed. */ } } const contents = view.webContents as any; if (!contents.isDestroyed()) contents.close(); };
  win.once('closed', cleanup);
  win.webContents.once('did-finish-load', () => {
    timer = setTimeout(() => { win.off('closed', cleanup); cleanup(); }, Math.max(0, MINIMUM_SPLASH_MS - (Date.now() - started)));
  });
}

