import { autoUpdater } from 'electron-updater';
import { app, BrowserWindow, dialog, Menu } from 'electron';
import * as path from 'path';
import { spawn } from 'child_process';

export enum MenuUpdateStep {
  CheckForUpdates = 'Check for Updates',
  CheckingForUpdates = 'Checking for Updates...',
  DownloadingUpdate = 'Downloading Update...',
  RestartToUpdate = 'Restart to Update',
}

export const updateActions: Record<string, (() => void) | undefined> = {
  [MenuUpdateStep.CheckForUpdates]: () => checkForUpdates(true),
  [MenuUpdateStep.CheckingForUpdates]: undefined,
  [MenuUpdateStep.DownloadingUpdate]: undefined,
  [MenuUpdateStep.RestartToUpdate]: () => quitAndInstall(),
};


let isManualCheck = false;

const INITIAL_CHECK_DELAY_MS = 10000;

const CHECK_INTERVAL_MS = 60 * 60 * 1000;

export interface UpdaterState {
  type: string;
  update?: { version: string };
}

let currentState: UpdaterState = { type: 'idle' };


export function getUpdaterState(): UpdaterState {
  return {
    ...currentState,
    ...(currentState.update ? { update: { ...currentState.update } } : {}),
  };
}


export function broadcastState(state: UpdaterState): void {
  currentState = {
    ...state,
    ...(state.update ? { update: { ...state.update } } : {}),
  };
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('updater:state-changed', getUpdaterState());
  }
}


function updateMenuState(step: MenuUpdateStep): void {
  const menu = Menu.getApplicationMenu();
  if (menu) {
    const item = menu.getMenuItemById('check-for-updates');
    if (item) {
      item.label = step;
      item.enabled = updateActions[step] !== undefined;
    }
  }
}


export function initAutoUpdater(isHeadless: boolean): void {


  if (!app.isPackaged) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.updateConfigPath = path.join(app.getAppPath(), 'dev-app-update.yml');
  }



  if (process.platform === 'win32') {
    autoUpdater.channel = `latest-${process.arch}-win`;
  } else {
    autoUpdater.channel = `latest-${process.arch}`;
  }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = app.isPackaged;

  autoUpdater.on('checking-for-update', () => {
    console.log('[AutoUpdater] Checking for update…');
    broadcastState({ type: 'checking for updates' });
    updateMenuState(MenuUpdateStep.CheckingForUpdates);
  });
  autoUpdater.on('update-available', (info) => {
    console.log(`[AutoUpdater] Update available: ${info.version}`);
    broadcastState({
      type: 'available for download',
      update: { version: info.version },
    });
    updateMenuState(MenuUpdateStep.DownloadingUpdate);
    isManualCheck = false;
  });
  autoUpdater.on('update-not-available', (info) => {
    console.log(`[AutoUpdater] Up to date (${info.version})`);
    broadcastState({ type: 'idle' });
    updateMenuState(MenuUpdateStep.CheckForUpdates);
    if (isManualCheck && !isHeadless) {
      const win = BrowserWindow.getFocusedWindow();
      const options = {
        type: 'info' as const,
        title: 'Check for Updates',
        message: 'No updates available',
        buttons: ['OK'],
      };
      if (win) {
        dialog.showMessageBox(win, options);
      } else {
        dialog.showMessageBox(options);
      }
    }
    isManualCheck = false;
  });
  autoUpdater.on('download-progress', () => {
    broadcastState({ type: 'downloading' });
    updateMenuState(MenuUpdateStep.DownloadingUpdate);
  });
  autoUpdater.on('update-downloaded', (info) => {
    console.log(`[AutoUpdater] Update downloaded: ${info.version}`);
    if (isHeadless) {

      if (app.isPackaged) {
        if (process.platform === 'linux') {
          const downloadedFilePath = info.downloadedFile;
          headlessQuitAndInstall(downloadedFilePath);
        } else {
          autoUpdater.quitAndInstall();
        }
      } else {
        console.log('[AutoUpdater] Headless mode: Skipping quitAndInstall (not packaged).');
      }
      return;
    }
    broadcastState({
      type: 'ready',
      update: { version: info.version },
    });
    updateMenuState(MenuUpdateStep.RestartToUpdate);
  });
  autoUpdater.on('error', (err) => {
    console.error('[AutoUpdater] Error:', err.message);
    broadcastState({ type: 'idle' });
    updateMenuState(MenuUpdateStep.CheckForUpdates);
    isManualCheck = false;
  });

  setTimeout(() => {
    checkForUpdates();
    setInterval(checkForUpdates, CHECK_INTERVAL_MS);
  }, INITIAL_CHECK_DELAY_MS);
}

export function checkForUpdates(isManual = false): void {
  isManualCheck = isManual;
  autoUpdater.checkForUpdates().catch((err) => {
    console.error('[AutoUpdater] Failed to check for updates:', err.message);
  });
}

export function quitAndInstall(): void {
  autoUpdater.quitAndInstall();
}


function headlessQuitAndInstall(downloadedFilePath: string): void {
  console.log('[AutoUpdater] Headless mode: Scheduling post-quit restart.');
  try {
    const currentPid = process.pid;
    const appPath = process.env.APPIMAGE || process.execPath;
    const args = ['--ozone-platform=headless', '--headless', '--disable-gpu', '--no-sandbox'];
    let script = '';
    if (downloadedFilePath) {
      console.log(`[AutoUpdater] Will manually replace ${appPath} with ${downloadedFilePath}`);
      script = `
        while kill -0 ${currentPid} 2>/dev/null; do sleep 0.5; done
        cp -f "${downloadedFilePath}" "${appPath}"
        chmod +x "${appPath}"
        "${appPath}" ${args.join(' ')}
      `;
    } else {
      console.warn('[AutoUpdater] No downloaded file path found, relaunching without update.');
      script = `
        while kill -0 ${currentPid} 2>/dev/null; do sleep 0.5; done
        sleep 3
        "${appPath}" ${args.join(' ')}
      `;
    }
    const child = spawn('sh', ['-c', script], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, ELECTRON_OZONE_PLATFORM_HINT: 'headless' },
    });
    child.unref();
  } catch (e) {
    console.error('[AutoUpdater] Failed to schedule restart:', e);
  }
  app.quit();
}
