import { app } from 'electron';
import path from 'path';
import os from 'os';
import { LS_LOG_FILE_NAME } from './constants';

export function getAppDataDirName(): string {
  return `antigravity${app.isPackaged ? '' : '-dev'}`;
}

export function getAppDataDir(): string {
  return path.join(os.homedir(), '.gemini', getAppDataDirName());
}

export function getSettingsPbPath(): string {
  return path.join(os.homedir(), '.gemini', 'config', 'config.json');
}


export function getAppStoragePath(): string {
  return path.join(app.getPath('userData'), 'app_storage.json');
}


export function getActivePortFilePath(): string {
  return path.join(app.getPath('userData'), 'DevToolsActivePort');
}

export function getLsLogPath(): string {
  return path.join(app.getPath('logs'), LS_LOG_FILE_NAME);
}


export const IDE_OLD_DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity');

export const IDE_NEW_DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity-ide');

export const IDE_BACKUP_DATA_DIR = path.join(os.homedir(), '.gemini', 'antigravity-backup');
