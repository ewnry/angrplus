import { installThemeIcons } from './themeIcons';
import { app, dialog, session, Menu, MenuItem, BrowserWindow } from 'electron';
import { registerCustomModelHandlers } from './customIpc';
import { getProxyPort, stopProxy } from './proxy';

let installed = false;

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

          }
        }
      }
      (PatchedBrowserWindow as any).__isPatched = true;
      Object.setPrototypeOf(PatchedBrowserWindow, OriginalBrowserWindow);
      try {
        electron.BrowserWindow = PatchedBrowserWindow;
      } catch {

      }
    }
  } catch {

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

  try {
    const { setLanguageServerPortResolver } = require('./proxy');
    setLanguageServerPortResolver(getLanguageServerPort);
  } catch {

  }

  if (typeof process !== 'undefined' && typeof process.on === 'function') {
    process.on('uncaughtException', (err) => {
      console.error('[Antigravity+ Uncaught Exception]', err);
    });
    process.on('unhandledRejection', (reason) => {
      console.error('[Antigravity+ Unhandled Rejection]', reason);
    });
  }

  registerCustomModelHandlers();
  installThemeIcons();

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

  }

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

            console.log('[Antigravity+] Suppressed premature port 0 createWindow:', url);
            return null;
          }
          return origCreate(url, storage);
        };
      }
    }
  } catch {

  }

  void app.whenReady().then(() => {

    try {
      session.defaultSession.setCertificateVerifyProc((request, callback) => {
        if (request.hostname === '127.0.0.1' || request.hostname === 'localhost') {
          callback(0);
        } else {
          callback(-3);
        }
      });
    } catch {

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

    }

    const updateAppMenu = () => {
      try {
        const menu = Menu.getApplicationMenu();
        if (!menu) return;

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

    }

    if (win.webContents && typeof win.webContents.on === 'function') {
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
