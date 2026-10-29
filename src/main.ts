import { app, BrowserWindow, dialog, ipcMain, session, Menu } from 'electron';
import log from 'electron-log/main';
import { registerIpcHandlers } from './ipcHandlers';
import * as fs from 'fs';
import * as crypto from 'crypto';
import * as readline from 'readline';
import { createWindow, showQuitConfirmation, setShowQuitConfirmation, showOrCreateWindow } from './utils';
import {
  startAndMonitorLanguageServer,
  getLsPort,
  killLanguageServer,
  getLsCL,
  LS_BINARY,
  setupLocalCertTrust,
  getLsProcess,
} from './languageServer';
import { initAutoUpdater } from './updater';
import { WINDOW_ORIGIN, DYNAMIC_PORT } from './constants';
import { createTray } from './tray';
import { StorageManager } from './storage';
import { getAppStoragePath, getLsLogPath } from './paths';
import { setupApplicationMenu } from './menu';
import { registerCustomSchemes, registerCustomSchemeHandlers } from './customScheme';
import { DEFAULTS, SettingsService, SettingKey } from './services/settingsService';
import { maybeShowIdeInstallWizard } from './ideInstall';

const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
  process.exit(0);
}



let storageManager: StorageManager;
let settingsService: SettingsService;
let hasStartedMainApplication = false;
let isQuitting = false;






const HEADLESS = process.env.ELECTRON_OZONE_PLATFORM_HINT === 'headless';


const DEV_URL = process.env.DEV_URL;

if (HEADLESS) {
  app.commandLine.appendSwitch('ozone-platform', 'headless');
  app.commandLine.appendSwitch('headless');
  app.commandLine.appendSwitch('disable-gpu');
  app.commandLine.appendSwitch('no-sandbox');
}

if (!app.commandLine.hasSwitch('remote-debugging-port')) {
  app.commandLine.appendSwitch('remote-debugging-port', '0');
}



let pendingDeepLink: string | null = null;

function handleDeepLink(url: string): void {
  const wins = BrowserWindow.getAllWindows();

  if (wins.length > 0) {
    if (wins[0].isMinimized()) {
      wins[0].restore();
    }
    wins[0].show();
    wins[0].focus();
    app.focus({ steal: true });
    wins[0].webContents.send('deep-link', url);
  } else {
    pendingDeepLink = url;
  }
}

app.on('second-instance', (_event, commandLine: string[]) => {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0) {
    if (wins[0].isMinimized()) {
      wins[0].restore();
    }
    wins[0].show();
    wins[0].focus();
    app.focus({ steal: true });
  }
  const url = commandLine.find((arg) => arg.startsWith('antigravity://'));
  if (url) {
    handleDeepLink(url);
  }
});

registerCustomSchemes();


const PROTOCOL = 'antigravity';
if (!app.isDefaultProtocolClient(PROTOCOL)) {
  app.setAsDefaultProtocolClient(PROTOCOL);
}

app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});


app
  .whenReady()
  .then(async () => {

    log.initialize();
    Object.assign(console, log.functions);

    const storagePath = getAppStoragePath();
    storageManager = new StorageManager(storagePath, DEFAULTS);
    settingsService = new SettingsService(storageManager);


    const deepLinkFromArg = process.argv.find((arg) => arg.startsWith('antigravity://'));
    if (deepLinkFromArg) {
      console.log('Launched with deep link:', deepLinkFromArg);
      pendingDeepLink = deepLinkFromArg;
    }


    registerIpcHandlers(storageManager);
    ipcMain.handle('deep-link:get-stored', () => {
      const link = pendingDeepLink;
      pendingDeepLink = null;
      return link;
    });


    registerCustomSchemeHandlers();




    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (details.url.includes('SetCloudCodeURL')) {
        console.log(`[Proxy Intercept] Blocked SetCloudCodeURL: ${details.url}`);
        callback({ cancel: true });
        return;
      }
      if (details.url.includes('LanguageServerService/GetAvailableModels')) {
        const proxyPort = (require('./proxy').getProxyPort as () => number)();
        if (proxyPort > 0) {
          const redirectTarget = `http://127.0.0.1:${proxyPort}/GetAvailableModels?ls=${encodeURIComponent(details.url)}`;
          console.log(`[Proxy Intercept] Redirecting GetAvailableModels to proxy: ${redirectTarget}`);
          (callback as (opts: { cancel?: boolean; redirectURL?: string }) => void)({ redirectURL: redirectTarget });
          return;
        }
      }
      if (details.url.includes('CloudCode') || details.url.includes('LanguageServerService')) {
        console.log(`[Proxy Intercept] Request URL: ${details.url}`);
      }
      callback({});
    });


    const cl = await getLsCL();
    app.setAboutPanelOptions({
      applicationName: 'Antigravity',
      applicationVersion: app.getVersion(),
      version: cl || undefined,
    });



    if (!HEADLESS) {
      await maybeShowIdeInstallWizard(storageManager);
    }

    if (DEV_URL) {
      console.log('Starting in dev mode with URL:', DEV_URL);
      createWindow(DEV_URL);
      hasStartedMainApplication = true;
      return;
    }

    if (!fs.existsSync(LS_BINARY)) {
      const msg = `language_server binary not found at:\n${LS_BINARY}\n\nPlease build/set a valid location.`;
      if (HEADLESS) {
        console.error('ERROR:', msg);
      } else {
        await dialog.showErrorBox('Binary not found', msg);
      }
      app.quit();
      return;
    }

    const csrf = crypto.randomUUID();
    console.log(`Starting app (v${app.getVersion()}) with dynamic port…`);

    let handle: { port: number };
    const targetPort = Number(process.env.JETSKI_LS_PORT) || DYNAMIC_PORT;
    try {
      handle = await startAndMonitorLanguageServer(targetPort, csrf, {
        headless: HEADLESS,
        onPortChanged: (newPort: number) => {
          const newUrl = `${WINDOW_ORIGIN}:${newPort}/`;
          console.log(`[Auto-Restart] Port changed! Reloading all windows with URL: ${newUrl}`);

          setupLocalCertTrust();
          if (!HEADLESS) {
            const windows = BrowserWindow.getAllWindows();
            for (const win of windows) {
              void win.loadURL(newUrl);
            }
          }
        },
      });
    } catch (err) {
      const msg = (err as Error).message;
      if (HEADLESS) {
        console.error('Startup failed:', msg);
      } else {
        await dialog.showErrorBox('Startup failed', msg);
      }
      app.quit();
      return;
    }

    const url = `${WINDOW_ORIGIN}:${handle.port}/`;
    console.log('\n' + '='.repeat(60));
    console.log(`  Local:       ${url}`);
    console.log(`  LS Logs:     ${getLsLogPath()}`);
    console.log(`  Electron Logs: ${log.transports.file.getFile().path}`);
    console.log('='.repeat(60) + '\n');

    if (HEADLESS) {

      const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      rl.on('line', (line) => {
        const lsProc = getLsProcess();
        if (lsProc && lsProc.stdin) {
          lsProc.stdin.write(line + '\n');
          console.log('-> Forwarded input to Language Server.');
        } else {
          console.log('Language Server process is not running.');
        }
      });
    }


    if (!HEADLESS) {
      setupApplicationMenu(url);
      const mainWindow = createWindow(url);
      if (app.dock) {
        const dockMenu = Menu.buildFromTemplate([
          {
            label: 'New Window',
            click: () => createWindow(url),
          },
        ]);
        app.dock.setMenu(dockMenu);
      }
      createTray([
        {
          id: 'running-agents',
          label: 'No agents running',
          enabled: false,
        },
        { type: 'separator' },
        {
          label: `Open ${app.getName()}`,
          click: () => showOrCreateWindow(getLsPort()),
        },
        {
          label: 'Quit',
          click: () => {

            app.quit();
          },
        },
      ]);
    }


    initAutoUpdater(HEADLESS);
    hasStartedMainApplication = true;
  })
  .catch(() => {
    hasStartedMainApplication = true;
  });


app.on('window-all-closed', async () => {
  if (isQuitting) {
    return;
  }
  if (!hasStartedMainApplication) {
    return;
  }
  const runInBackground = await settingsService.getSetting(SettingKey.RUN_IN_BACKGROUND);
  if (!runInBackground) {

    app.quit();
  } else {
    app.dock?.hide();
  }
});


app.on('before-quit', async (event) => {
  if (isQuitting) {
    return;
  }
  if (!showQuitConfirmation) {
    event.preventDefault();
    isQuitting = true;

    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      win.destroy();
    }

    await Promise.all([
      session.defaultSession.closeAllConnections().catch((err: Error) => {
        console.error('Failed to close session connections:', err);
      }),
      killLanguageServer(),
    ]);
    app.quit();
    return;
  }

  event.preventDefault();
  const win = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const options: Electron.MessageBoxOptions = {
    type: 'question',
    buttons: ['Cancel', 'Quit'],
    defaultId: 1,
    cancelId: 0,
    title: 'Confirm Quit',
    message: 'Are you sure you want to quit?',
    detail: 'There may be agents or background tasks running.',
  };
  setShowQuitConfirmation(false);
  if (win) {
    void dialog.showMessageBox(win, options).then((result) => {
      if (result.response === 1) {

        app.quit();
      }
    });
  }
});


app.on('activate', () => {


  if (!HEADLESS && BrowserWindow.getAllWindows().length === 0) {
    const url = DEV_URL ?? `${WINDOW_ORIGIN}:${getLsPort()}/`;
    createWindow(url);
  }
});
