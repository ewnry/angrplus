import { installThemeIcons } from './themeIcons';
import { installPlugins } from './pluginRuntime';
import { app, dialog, session, Menu, MenuItem, BrowserWindow, ipcMain } from 'electron';
import { registerCustomModelHandlers } from './customIpc';
import { getProxyPort, stopProxy } from './proxy';

let installed = false;

export function recoveryHtml(profiles: Array<{ id: string; name: string; mode: string }>, activeId: string | null): string {
  const escape = (value: string) => String(value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
  const rows = profiles.map(profile => `<button class="row" type="button" data-recovery-profile="${escape(profile.id)}"><span><strong>${escape(profile.name)}</strong><small>${escape(profile.mode.toUpperCase())}</small></span><span class="state">${profile.id === activeId ? 'Активен' : 'Выбрать'} <span aria-hidden="true">›</span></span></button>`).join('');
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><title>Antigravity+</title><style>
  *{box-sizing:border-box}body{margin:0;background:#1f2438;color:#d5def5;font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}main{width:min(560px,calc(100% - 40px));margin:clamp(26px,7vh,80px) auto}h1{font-size:19px;font-weight:600;margin:0 0 8px}p{color:#9caaca;line-height:1.55;margin:0 0 22px}.section{display:flex;justify-content:space-between;align-items:center;margin:0 0 8px;color:#b8c4e2;font-size:12px;font-weight:600}.list{border:1px solid #3a4057;border-radius:9px;overflow:auto;background:#2b3045;max-height:32vh}.row{font:inherit;width:100%;display:flex;align-items:center;justify-content:space-between;gap:16px;color:inherit;background:transparent;text-align:left;padding:11px 13px;min-height:54px;border:0;border-bottom:1px solid #3b4158;cursor:pointer}.row:last-child{border-bottom:0}.row:hover,.row:focus-visible{background:#373d54;outline:0}.row strong{font-size:13px;font-weight:500;display:block;overflow-wrap:anywhere}.row small{display:block;color:#929fbe;font-size:11px;margin-top:3px}.state{color:#a7b5d9;font-size:12px;white-space:nowrap}.state span{font-size:17px;margin-left:5px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin-top:18px}.button{font:inherit;border:1px solid #454b63;border-radius:7px;background:#343a50;color:#d4def5;cursor:pointer;padding:8px 12px}.button:hover,.button:focus-visible{background:#41475f;outline:1px solid #aaa0dc}.primary{background:#c3aaef;color:#211b30;border-color:transparent;font-weight:600}.primary:hover{background:#d4c1f5}.subtle{border:0;background:transparent;color:#bbc7e4;padding:5px 8px}.note{font-size:12px;color:#8f9cbc;margin-top:15px}.form{margin-top:14px;padding:14px;background:#2b3045;border:1px solid #3c425b;border-radius:9px}.form[hidden],.key[hidden]{display:none}.form label{display:block;color:#c1cce5;font-size:12px;margin-bottom:11px}.form input,.form select{display:block;margin-top:5px;width:100%;background:#21263a;border:1px solid #4a526e;border-radius:6px;color:#e0e7f8;font:13px inherit;font-family:inherit;padding:9px}.form input:focus,.form select:focus{outline:1px solid #b69be9}.error{color:#f3a2a9;min-height:0;margin:10px 0 0;overflow-wrap:anywhere}
  </style></head><body data-agy-recovery><main><h1>Не удалось подключиться</h1><p>Antigravity не дождался ответа. Проверьте соединение или выберите другое подключение.</p><div class="section"><span>Подключения</span><button type="button" class="button subtle" data-recovery-add>+ Добавить</button></div><div class="list">${rows}<button class="row" type="button" data-recovery-direct><span><strong>Без прокси</strong><small>Прямое подключение</small></span><span class="state">Выбрать <span aria-hidden="true">›</span></span></button></div><form class="form" data-recovery-form hidden><label>Название<input name="name" required maxlength="80" autocomplete="off"></label><label>Тип подключения<select name="mode"><option value="socks5">SOCKS5</option><option value="socks4">SOCKS4</option><option value="http">HTTP / HTTPS proxy</option><option value="relay">Custom server / Worker</option></select></label><label>Адрес сервера<input name="endpoint" required placeholder="socks5://host:port" autocomplete="off"></label><label class="key" hidden>Ключ сервера<input name="secret" type="password" autocomplete="new-password"></label><div class="actions"><button type="submit" class="button primary">Сохранить и подключиться</button><button type="button" class="button" data-recovery-cancel>Отмена</button></div></form><div class="actions"><button class="button primary" type="button" data-recovery-retry>Повторить подключение</button></div><p class="error" role="alert" data-recovery-error></p><div class="note">Сохранённые подключения и данные аккаунтов останутся на месте.</div></main></body></html>`;
}

// Patch BrowserWindow constructor so DevTools is enabled even in production
if (typeof BrowserWindow !== 'undefined' && typeof (BrowserWindow as any) === 'function') {
  try {
    const electron = require('electron');
    const OriginalBrowserWindow = electron.BrowserWindow || BrowserWindow;
    if (OriginalBrowserWindow && !(OriginalBrowserWindow as any).__isPatched) {
      class PatchedBrowserWindow extends OriginalBrowserWindow {
        constructor(options?: any) {
          if (options) {
            if (!options.webPreferences) {
              options.webPreferences = {};
            }
            options.webPreferences.devTools = true;
            options.webPreferences.autoplayPolicy = 'no-user-gesture-required';
            options.autoHideMenuBar = true;
          }
          super(options);
          try {
            if (typeof this.setMenuBarVisibility === 'function') this.setMenuBarVisibility(false);
            if (typeof this.setAutoHideMenuBar === 'function') this.setAutoHideMenuBar(true);
          } catch {
            /* ignore */
          }
        }
      }
      (PatchedBrowserWindow as any).__isPatched = true;
      Object.setPrototypeOf(PatchedBrowserWindow, OriginalBrowserWindow);
      try {
        electron.BrowserWindow = PatchedBrowserWindow;
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

export function enableVendorDevTools(cache = require.cache): void {
  for (const [filename, module] of Object.entries(cache || {})) {
    if (filename.replace(/\\/g, '/').endsWith('/dist/debugConsole.js') && typeof module?.exports?.isDebugConsoleEnabled === 'function') {
      module.exports.isDebugConsoleEnabled = () => true;
    }
  }
}

export function install(getLanguageServerPort: () => number): void {
  if (installed) return;
  installed = true;
  enableVendorDevTools();
  try { installPlugins(getLanguageServerPort); } catch (error) { console.error('[Antigravity+ plugins]', error); }
  try {
    const vendorLoading = module.require(['..', 'loadingOverlay'].join('/'));
    vendorLoading.attachLoadingOverlay = require('./loadingOverlay').attachLoadingOverlay;
  } catch (error) {
    console.error('[Antigravity+] Could not install loading animation:', error);
  }

  try {
    const { setLanguageServerPortResolver } = require('./proxy');
    setLanguageServerPortResolver(getLanguageServerPort);
  } catch {
    /* ignore */
  }

  if (typeof process !== 'undefined' && typeof process.on === 'function') {
    process.on('uncaughtException', (err) => {
      console.error('[Antigravity+ Uncaught Exception]', err);
    });
    process.on('unhandledRejection', (reason) => {
      console.error('[Antigravity+ Unhandled Rejection]', reason);
    });
  }

  const recoveryWindows = new Map<number, () => void>();
  ipcMain.handle('agy-recovery:retry', (event) => {
    const retry = recoveryWindows.get(event.sender.id);
    if (retry) { retry(); return { success: true }; }
    // A restored renderer may have a different WebContents identity from the
    // original window. Only accept our own recovery document in that case.
    const currentUrl = event.sender.getURL();
    const port = getLanguageServerPort();
    if (!currentUrl.startsWith('data:text/html;charset=utf-8,') || !currentUrl.includes('data-agy-recovery') || port <= 0) {
      return { success: false, error: 'Сервер Antigravity ещё не готов. Попробуйте снова.' };
    }
    setTimeout(() => {
      if (!event.sender.isDestroyed()) void event.sender.loadURL(`https://127.0.0.1:${port}/`).catch((error: unknown) => console.error('[Antigravity+] Recovery retry failed:', error));
    }, 50);
    return { success: true };
  });
  registerCustomModelHandlers();
  installThemeIcons();

  // Guard loadURL on BrowserWindow.prototype against port 0 (ERR_UNSAFE_PORT)
  try {
    const electron = require('electron');
    const BW = electron.BrowserWindow || BrowserWindow;
    if (BW && BW.prototype && typeof BW.prototype.loadURL === 'function') {
      const origLoadURL = BW.prototype.loadURL;
      if (!(origLoadURL as any).__agyPatched) {
        const patchedLoadURL = function (this: any, url: string, options?: any) {
          if (typeof url === 'string' && (url.includes(':0/') || url.endsWith(':0') || url.includes('127.0.0.1:0'))) {
            const p = getLanguageServerPort();
            if (p > 0) {
              const fixedUrl = url.replace(':0/', `:${p}/`).replace(/:0$/, `:${p}`);
              console.log('[Antigravity+] Rewriting port 0 loadURL to:', fixedUrl);
              return origLoadURL.call(this, fixedUrl, options);
            }
            console.warn('[Antigravity+] Guarded premature port 0 loadURL, awaiting LS port...');
            return new Promise<void>((resolve, reject) => {
              let attempts = 0;
              const interval = setInterval(() => {
                attempts++;
                const readyPort = getLanguageServerPort();
                if (readyPort > 0) {
                  clearInterval(interval);
                  if (this.isDestroyed()) return resolve();
                  const fixedUrl = url.replace(':0/', `:${readyPort}/`).replace(/:0$/, `:${readyPort}`);
                  console.log('[Antigravity+] LS port ready (' + readyPort + '), loading:', fixedUrl);
                  origLoadURL.call(this, fixedUrl, options).then(resolve, reject);
                } else if (attempts >= 100) {
                  clearInterval(interval);
                  console.error('[Antigravity+] LS port timed out waiting for port 0 loadURL replacement');
                  resolve();
                }
              }, 100);
            });
          }
          return origLoadURL.call(this, url, options);
        };
        (patchedLoadURL as any).__agyPatched = true;
        BW.prototype.loadURL = patchedLoadURL;
      }
    }
  } catch {
    /* ignore */
  }

  // Intercept utils.showOrCreateWindow and utils.createWindow to prevent port 0 navigation
  try {
    let utils: any;
    try {
      const utilsEntry = Object.keys(require.cache || {}).find(
        (k) => k.replace(/\\/g, '/').endsWith('/utils.js') || k.endsWith('utils.js'),
      );
      if (utilsEntry) {
        utils = (require.cache as any)[utilsEntry]?.exports;
      }
      if (!utils) {
        const utilsPath = ['..', 'utils'].join('/');
        utils = (module.require || require)(utilsPath);
      }
    } catch {
      /* ignore */
    }
    if (utils) {
      if (typeof utils.showOrCreateWindow === 'function') {
        const origShowOrCreate = utils.showOrCreateWindow;
        utils.showOrCreateWindow = (port: number) => {
          const wins = BrowserWindow.getAllWindows();
          if (wins.length > 0) {
            const win = wins[0];
            if (win.isMinimized()) win.restore();
            win.show();
            win.focus();
            return;
          }
          const p = typeof port === 'number' && port > 0 ? port : getLanguageServerPort();
          if (p > 0) {
            return origShowOrCreate(p);
          }
          let attempts = 0;
          const timer = setInterval(() => {
            attempts++;
            const readyPort = getLanguageServerPort();
            if (readyPort > 0) {
              clearInterval(timer);
              origShowOrCreate(readyPort);
            } else if (attempts >= 100) {
              clearInterval(timer);
            }
          }, 100);
        };
      }
      if (typeof utils.createWindow === 'function') {
        const origCreate = utils.createWindow;
        utils.createWindow = (url: string, storage: any) => {
          if (typeof url === 'string' && (url.includes(':0/') || url.endsWith(':0') || url.includes('127.0.0.1:0'))) {
            const p = getLanguageServerPort();
            if (p > 0) {
              url = url.replace(':0/', `:${p}/`).replace(/:0$/, `:${p}`);
              return origCreate(url, storage);
            }
            // Language server has not reported its port yet.
            // On Windows, the app 'activate' event fires during early startup when getLsPort() is 0.
            // Main startup will open the real window once the language server is actually ready.
            console.log('[Antigravity+] Suppressed premature port 0 createWindow:', url);
            return null;
          }
          return origCreate(url, storage);
        };
      }
    }
  } catch {
    /* ignore */
  }

  // Registered before the vendor's ready callback, without replacing its startup,
  // updater, WSL integration, certificate policy, or window configuration.
  void app.whenReady().then(() => {
    // Ensure local certificate trust for loopback HTTPS
    try {
      session.defaultSession.setCertificateVerifyProc((request, callback) => {
        if (request.hostname === '127.0.0.1' || request.hostname === 'localhost') {
          callback(0); // Accept local cert
        } else {
          callback(-3); // Default validation
        }
      });
    } catch {
      /* ignore */
    }

    try {
      const origSetApplicationMenu = Menu.setApplicationMenu;
      Menu.setApplicationMenu = function (menu: Menu | null) {
        if (menu?.items) {
          for (const item of menu.items) {
            if (item.label === 'Antigravity') {
              item.label = 'Antigravity+';
            }
          }
        }
        return origSetApplicationMenu.call(this, menu);
      };
    } catch {
      /* ignore */
    }

    const updateAppMenu = () => {
      try {
        const menu = Menu.getApplicationMenu();
        if (!menu) return;

        // Unhide DevTools across all menus
        const unhideDevTools = (m: any) => {
          if (!m?.items) return;
          for (const item of m.items) {
            if (item.role?.toLowerCase() === 'toggledevtools' || item.id === 'toggledevtools') {
              item.visible = true;
            }
            if (item.submenu) unhideDevTools(item.submenu);
          }
        };
        unhideDevTools(menu);

        const agyItem = menu.items.find((item) => item.label === 'Antigravity' || item.label === 'Antigravity+');
        if (agyItem) {
          agyItem.label = 'Antigravity+';
          if (agyItem.submenu) {
            if (!agyItem.submenu.items.some((i: any) => i.id === 'agy-switcher')) {
              agyItem.submenu.insert(
                0,
                new MenuItem({
                  id: 'agy-switcher',
                  label: 'Antigravity+ Account Switcher',
                  accelerator: 'CmdOrCtrl+Alt+S',
                  click: () => {
                    const wins = BrowserWindow.getAllWindows();
                    if (wins.length > 0) {
                      wins[0].webContents.send('open-account-pool');
                    }
                  },
                }),
              );
            }
            if (!agyItem.submenu.items.some((i: any) => i.id === 'agy-devtools')) {
              agyItem.submenu.insert(
                1,
                new MenuItem({
                  id: 'agy-devtools',
                  label: 'Toggle Developer Tools',
                  accelerator: 'F12',
                  click: () => {
                    const focused = (typeof BrowserWindow.getFocusedWindow === 'function' ? BrowserWindow.getFocusedWindow() : null) || BrowserWindow.getAllWindows()[0];
                    if (focused) {
                      try {
                        const wc = focused.webContents as any;
                        if (typeof wc.toggleDevTools === 'function') {
                          wc.toggleDevTools();
                        } else if (typeof wc.isDevToolsOpened === 'function' && wc.isDevToolsOpened()) {
                          wc.closeDevTools();
                        } else if (typeof wc.openDevTools === 'function') {
                          wc.openDevTools({ mode: 'detach' });
                        }
                      } catch {
                        /* ignore */
                      }
                    }
                  },
                }),
              );
            }
          }
          Menu.setApplicationMenu(menu);
        }
      } catch {
        /* ignore */
      }
    };
    updateAppMenu();
    if (typeof setTimeout !== 'undefined') {
      setTimeout(updateAppMenu, 1500);
    }

    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const proxyPort = getProxyPort();
      const lsPort = getLanguageServerPort();
      if (!proxyPort || !lsPort) return callback({});
      const url = new URL(details.url);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        Number(url.port) !== lsPort
      ) {
        return callback({});
      }
      if (/(?:\/|\.)LanguageServerService\/SetCloudCodeURL$/.test(url.pathname)) {
        callback({ cancel: true });
      } else if (/(?:\/|\.)LanguageServerService\/GetAvailableModels$/.test(url.pathname)) {
        (callback as (value: { redirectURL: string }) => void)({
          redirectURL: `http://127.0.0.1:${proxyPort}/GetAvailableModels?ls=${encodeURIComponent(details.url)}`,
        });
      } else callback({});
    });
  });

  app.on('browser-window-created', (_event, win) => {
    try {
      if (typeof win.setTitle === 'function') {
        win.setTitle('Antigravity+ — Antigravity, but better.');
      }
      if (typeof win.on === 'function') {
        win.on('page-title-updated', (event: any) => {
          if (event && typeof event.preventDefault === 'function') {
            event.preventDefault();
          }
          if (typeof win.setTitle === 'function') {
            win.setTitle('Antigravity+');
          }
        });
      }

      if (win.webContents && typeof win.webContents.on === 'function') {
        win.webContents.on('before-input-event', (event: any, input: any) => {
          if (input.type === 'keyDown') {
            if (input.control && input.alt && input.key.toLowerCase() === 's') {
              win.webContents.send('open-account-pool');
            }
            const isF12 = input.key === 'F12';
            const isDevTools = (input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i';
            if (isF12 || isDevTools) {
              event.preventDefault?.();
              try {
                const wc = win.webContents as any;
                if (typeof wc.toggleDevTools === 'function') {
                  wc.toggleDevTools();
                } else if (typeof wc.isDevToolsOpened === 'function' && wc.isDevToolsOpened()) {
                  wc.closeDevTools();
                } else if (typeof wc.openDevTools === 'function') {
                  wc.openDevTools({ mode: 'detach' });
                }
              } catch (err) {
                console.error('[Model Patch] Failed to toggle DevTools:', err);
              }
            }
          }
        });
      }
    } catch {
      /* ignore */
    }

    if (win.webContents && typeof win.webContents.on === 'function') {
      let loadRetries = 0;
      let recoveryUrl = '';
      const retryRecovery = () => {
        if (!recoveryUrl) return;
        const url = recoveryUrl;
        recoveryUrl = '';
        recoveryWindows.delete(win.webContents.id);
        loadRetries = 0;
        const port = getLanguageServerPort();
        const nextUrl = port > 0 ? url.replace(/^(https?:\/\/(?:127\.0\.0\.1|localhost):)\d+/i, (_match: string, prefix: string) => prefix + port) : url;
        setTimeout(() => { if (!win.isDestroyed()) void win.loadURL(nextUrl).catch((error: unknown) => console.error('[Antigravity+] Recovery retry failed:', error)); }, 50);
      };
      win.webContents.on('destroyed', () => recoveryWindows.delete(win.webContents.id));
      win.webContents.on('did-finish-load', () => { loadRetries = 0; });
      win.webContents.on('did-fail-load', (_event: any, code: number, description: string, url: string, isMainFrame: boolean) => {
        if (
          !isMainFrame ||
          code === -3 ||
          code === -312 ||
          (typeof url === 'string' && (url.includes(':0/') || url.endsWith(':0'))) ||
          (typeof win.isDestroyed === 'function' && win.isDestroyed())
        ) {
          return;
        }
        if (code === -7 && typeof url === 'string' && /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\//i.test(url)) {
          let activeProxy = false;
          try { activeProxy = require('./networkRoute').readSettings().mode !== 'direct'; } catch (error) { console.error('[Antigravity+] Unable to read network settings:', error); }
          if (activeProxy) {
            recoveryUrl = url;
            recoveryWindows.set(win.webContents.id, retryRecovery);
            let profiles: Array<{ id: string; name: string; mode: string }> = [], activeId: string | null = null;
            try { ({ profiles, activeId } = require('./networkRoute').listProfiles()); }
            catch (error) { console.error('[Antigravity+] Could not load saved connections:', error); }
            const html = recoveryHtml(profiles, activeId);
            void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch((error: unknown) => console.error('[Antigravity+] Recovery page failed:', error));
            return;
          }
        }
        if (code === -7 && typeof url === 'string' && /^https?:\/\/(?:127\.0\.0\.1|localhost):\d+\//i.test(url) && loadRetries < 3) {
          loadRetries++;
          console.warn(`[Model Patch] Local page timed out, retrying (${loadRetries}/3)`);
          setTimeout(() => {
            if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return;
            const port = getLanguageServerPort();
            const retryUrl = port > 0 ? url.replace(/^(https?:\/\/(?:127\.0\.0\.1|localhost):)\d+/i, (_match: string, prefix: string) => prefix + port) : url;
            void win.loadURL(retryUrl).catch((error: unknown) => console.error('[Model Patch] Local retry failed:', error));
          }, 1500);
          return;
        }
        console.error('[Model Patch] Desktop page failed to load:', code, description, url);
        dialog.showErrorBox(
          'Antigravity could not load',
          `${description} (${code})\n\nCheck the Electron and language-server logs. ` +
            'If this began after an update, reinstall a clean vendor build and run the patch preflight again.',
        );
      });
      win.webContents.on('preload-error', (_event: any, _preload: any, error: any) => {
        console.error('[Model Patch] Preload failed:', error);
      });
    }
  });
  app.on('will-quit', () => {
    void stopProxy();
  });
}

