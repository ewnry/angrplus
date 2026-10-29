import {
  app,
  BrowserWindow,
  type BrowserWindowInstance,
  nativeTheme,
  nativeImage,
  powerSaveBlocker,
  shell,
} from 'electron';
import { WINDOW_ORIGIN } from './constants';
import { registerKeybindings } from './keybindings';
import * as path from 'path';
import * as fs from 'fs';
import { getSettingsPbPath } from './paths';
import { attachLoadingOverlay } from './loadingOverlay';

export let showQuitConfirmation = false;

export function setShowQuitConfirmation(value: boolean): void {
  showQuitConfirmation = value;
}

export function isMacOS(): boolean {
  return process.platform === 'darwin';
}


function getThemeMode(): string {
  try {
    const filePath = getSettingsPbPath();
    if (!fs.existsSync(filePath)) {
      return 'DARK';
    }
    const content = fs.readFileSync(filePath, 'utf-8');
    const config = JSON.parse(content) as Record<string, unknown>;
    const themeMode = (config?.userSettings as Record<string, unknown>)?.themeMode as string | undefined;
    if (themeMode && themeMode.includes('INHERIT')) {
      return nativeTheme.shouldUseDarkColors ? 'DARK' : 'LIGHT';
    }
    if (themeMode && themeMode.includes('LIGHT')) {
      return 'LIGHT';
    }
    return 'DARK';
  } catch (e) {
    console.error('Error reading theme mode:', e);
    return 'DARK';
  }
}


function ensureAppIsInDock(): void {
  void app.dock?.show();
  if (isMacOS() && app.dock) {
    const iconPath = path.join(__dirname, '..', 'icon.png');
    app.dock.setIcon(nativeImage.createFromPath(iconPath));
  }
}






export function createWindow(url: string): BrowserWindowInstance {
  ensureAppIsInDock();
  const theme = getThemeMode().toUpperCase();
  const isLight = theme.includes('LIGHT');
  const backgroundColor = isLight ? '#FAFAFA' : '#131313';
  const foregroundColor = isLight ? '#383A42' : '#FAFAFA';
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: app.getName(),
    icon: path.join(__dirname, '..', 'icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: isMacOS()
      ? false
      : {
          color: backgroundColor,
          symbolColor: foregroundColor,
          height: 30,
        },
    backgroundColor,
    trafficLightPosition: { x: 12, y: 12 },
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  win.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url);
    return { action: 'deny' };
  });
  attachLoadingOverlay(win, foregroundColor, backgroundColor);
  registerKeybindings(win, {
    createNewWindow: () => {
      void createWindow(url);
    },
    onQuitRequested: () => {
      showQuitConfirmation = true;
      app.quit();
    },
  });
  void win.loadURL(url);
  return win;
}


export const showOrCreateWindow = (port: number): void => {
  const wins = BrowserWindow.getAllWindows();
  if (wins.length > 0) {
    wins[0].show();
    wins[0].focus();
  } else {
    createWindow(`${WINDOW_ORIGIN}:${port}/`);
  }
};


export class SleepBlocker {
  private static instance: SleepBlocker;
  private currentBlockerId: number | null = null;

  static getInstance(): SleepBlocker {
    if (!SleepBlocker.instance) {
      SleepBlocker.instance = new SleepBlocker();
    }
    return SleepBlocker.instance;
  }

  shouldKeepComputerAwake(keep: boolean | undefined): void {
    if (keep) {
      if (this.currentBlockerId === null) {
        this.currentBlockerId = powerSaveBlocker.start('prevent-display-sleep');
        console.log('Power save blocker started:', this.currentBlockerId);
      }
    } else {
      if (this.currentBlockerId !== null) {
        powerSaveBlocker.stop(this.currentBlockerId);
        console.log('Power save blocker stopped:', this.currentBlockerId);
        this.currentBlockerId = null;
      }
    }
  }
}

interface NodeWrapperPaths {
  newEnvPath: string;
  nodeWrapperPath: string | undefined;
  binPath: string | undefined;
}

export function getNodeWrapperPaths(
  envPath: string,
  os: string,
  isPackaged: boolean,
  userDataPath: string,
  baseDir: string,
): NodeWrapperPaths {
  const delimiter = os === 'win32' ? ';' : ':';
  if (!isPackaged) {
    const devBinPath = path.join(baseDir, '..', 'node_modules', '.bin');
    return {
      newEnvPath: `${devBinPath}${delimiter}${envPath || ''}`,
      nodeWrapperPath: undefined,
      binPath: undefined,
    };
  }
  const binPath = path.join(userDataPath, 'bin');
  const nodeWrapperPath = path.join(binPath, os === 'win32' ? 'agy-node.cmd' : 'agy-node');
  return {
    newEnvPath: `${binPath}${delimiter}${envPath || ''}`,
    nodeWrapperPath,
    binPath,
  };
}


export function setupNodeWrapper(env: Record<string, string | undefined>): void {
  const userDataPath = app.isPackaged ? app.getPath('userData') : '';




  const isWindows = process.platform === 'win32';
  const pathKey = isWindows ? Object.keys(env).find((k) => k.toUpperCase() === 'PATH') || 'PATH' : 'PATH';
  const { newEnvPath, nodeWrapperPath, binPath } = getNodeWrapperPaths(
    env[pathKey] || '',
    process.platform,
    app.isPackaged,
    userDataPath,
    __dirname,
  );
  env[pathKey] = newEnvPath;

  if (!nodeWrapperPath || !binPath) {
    return;
  }
  if (!fs.existsSync(binPath)) {
    fs.mkdirSync(binPath, { recursive: true });
  }
  let nodeWrapperContent = '';
  switch (process.platform) {
    case 'win32':
      nodeWrapperContent = `@echo off\nset ELECTRON_RUN_AS_NODE=1\n"${process.execPath}" %*\n`;
      break;
    case 'darwin': {



      const appName = path.basename(process.execPath);
      let electronBinary = process.execPath;
      const helperPath = path.join(
        path.dirname(process.execPath),
        '..',
        'Frameworks',
        `${appName} Helper.app`,
        'Contents',
        'MacOS',
        `${appName} Helper`,
      );
      if (fs.existsSync(helperPath)) {
        electronBinary = helperPath;
      }
      nodeWrapperContent = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${electronBinary}" "$@"\n`;
      break;
    }
    default:
      nodeWrapperContent = `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec "${process.execPath}" "$@"\n`;
      break;
  }
  try {
    const existingContent = fs.existsSync(nodeWrapperPath) ? fs.readFileSync(nodeWrapperPath, 'utf-8') : '';
    if (existingContent !== nodeWrapperContent) {
      fs.writeFileSync(nodeWrapperPath, nodeWrapperContent);
      if (process.platform !== 'win32') {
        fs.chmodSync(nodeWrapperPath, 0o755);
      }
    }
  } catch (err) {
    console.error(`Failed to create node wrapper: ${err}`);
  }
}
