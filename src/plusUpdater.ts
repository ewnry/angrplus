

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as https from 'node:https';
import * as cp from 'node:child_process';
import * as zlib from 'node:zlib';
import { createHash, randomUUID } from 'node:crypto';
import { app } from 'electron';
import log from 'electron-log';

export const ANTIGRAVITY_PLUS_VERSION = '2.1.17';
export const DEFAULT_UPDATE_SERVER_URL = 'https://antigravity-plus-updates.unalty-api.workers.dev';

export interface RemoteVersionInfo {
  version: string;
  downloadUrl: string;
  asarUrl?: string;
  changelog?: string;
  releaseDate?: string;
  minAppVersion?: string;
}

export interface UpdateCheckResult {
  success: boolean;
  updateAvailable: boolean;
  currentVersion: string;
  latestVersion?: string;
  downloadUrl?: string;
  asarUrl?: string;
  changelog?: string;
  releaseDate?: string;
  error?: string;
}

export interface DownloadProgress {
  percent: number;
  downloadedBytes: number;
  totalBytes: number;
}

export interface DownloadedUpdate {
  filePath: string;
  type: 'asar' | 'installer';
}


export function compareVersions(v1: string, v2: string): number {
  const clean = (v: string) =>
    v
      .replace(/^[^\d]*/, '')
      .split('-')[0]
      .split('.')
      .map((part) => parseInt(part, 10) || 0);

  const p1 = clean(v1);
  const p2 = clean(v2);
  const len = Math.max(p1.length, p2.length);

  for (let i = 0; i < len; i++) {
    const num1 = p1[i] || 0;
    const num2 = p2[i] || 0;
    if (num1 > num2) return 1;
    if (num1 < num2) return -1;
  }
  return 0;
}

function fetchUrl(targetUrl: string, maxRedirects = 5): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) {
      reject(new Error('Too many redirects while reaching update server'));
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(targetUrl);
    } catch {
      reject(new Error(`Invalid URL: ${targetUrl}`));
      return;
    }

    const client = parsedUrl.protocol === 'https:' ? https : http;
    const req = client.get(
      parsedUrl,
      {
        headers: {
          'User-Agent': `AntigravityPlus/${ANTIGRAVITY_PLUS_VERSION} (${process.platform}; ${process.arch})`,
          Accept: 'application/json, application/octet-stream, */*',
        },
      },
      (res) => {
        const status = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          const redirectTarget = new URL(res.headers.location, targetUrl).toString();
          res.resume();
          fetchUrl(redirectTarget, maxRedirects - 1).then(resolve, reject);
          return;
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        res.on('end', () => {
          resolve({
            status,
            headers: res.headers,
            body: Buffer.concat(chunks),
          });
        });
      },
    );

    req.on('error', reject);
    req.setTimeout(15000, () => {
      req.destroy(new Error('Update request timed out after 15 seconds'));
    });
  });
}


export async function checkForUpdates(serverUrl = DEFAULT_UPDATE_SERVER_URL): Promise<UpdateCheckResult> {
  const current = ANTIGRAVITY_PLUS_VERSION;
  const normalizedServer = serverUrl.replace(/\/+$/, '');
  const versionUrl = `${normalizedServer}/api/version`;

  try {
    const res = await fetchUrl(versionUrl);
    if (res.status < 200 || res.status >= 300) {
      return {
        success: false,
        updateAvailable: false,
        currentVersion: current,
        error: `Server responded with HTTP ${res.status}`,
      };
    }

    const info: RemoteVersionInfo = JSON.parse(res.body.toString('utf8'));
    if (!info.version) {
      return {
        success: false,
        updateAvailable: false,
        currentVersion: current,
        error: 'Invalid response from update server: missing version property',
      };
    }

    const hasUpdate = compareVersions(info.version, current) > 0;
    let downloadUrl = info.downloadUrl || `${normalizedServer}/api/download`;
    if (!downloadUrl.startsWith('http://') && !downloadUrl.startsWith('https://')) {
      downloadUrl = new URL(downloadUrl, normalizedServer).toString();
    }

    let asarUrl = info.asarUrl;
    if (asarUrl && !asarUrl.startsWith('http://') && !asarUrl.startsWith('https://')) {
      asarUrl = new URL(asarUrl, normalizedServer).toString();
    } else if (!asarUrl) {
      asarUrl = `${normalizedServer}/app.asar.gz`;
    }

    return {
      success: true,
      updateAvailable: hasUpdate,
      currentVersion: current,
      latestVersion: info.version,
      downloadUrl,
      asarUrl,
      changelog: info.changelog || 'Performance improvements and bug fixes.',
      releaseDate: info.releaseDate,
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('[PlusUpdater] Failed to check for updates:', msg);
    return {
      success: false,
      updateAvailable: false,
      currentVersion: current,
      error: `Update check failed: ${msg}`,
    };
  }
}


export function getAppAsarPath(): string {

  if (process.resourcesPath) {
    const candidate = path.join(process.resourcesPath, 'app.asar');
    if (fs.existsSync(candidate)) return candidate;
  }


  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
    const candidates = [
      path.join(localAppData, 'Programs', 'antigravity', 'resources', 'app.asar'),
      path.join(localAppData, 'Programs', 'Antigravity', 'resources', 'app.asar'),
      path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Antigravity', 'resources', 'app.asar'),
    ];
    for (const p of candidates) {
      if (fs.existsSync(p)) return p;
    }
  }


  if (process.platform === 'darwin') {
    const macCandidates = [
      '/Applications/Antigravity.app/Contents/Resources/app.asar',
      path.join(process.env.HOME || '', 'Applications', 'Antigravity.app', 'Contents', 'Resources', 'app.asar'),
      '/Applications/Antigravity IDE.app/Contents/Resources/app.asar',
      path.join(process.env.HOME || '', 'Applications', 'Antigravity IDE.app', 'Contents', 'Resources', 'app.asar'),
    ];
    for (const p of macCandidates) {
      if (fs.existsSync(p)) return p;
    }
  }


  if (process.platform === 'linux') {
    const linuxCandidates = [
      '/opt/Antigravity/resources/app.asar',
      '/usr/lib/antigravity/resources/app.asar',
      '/usr/share/antigravity/resources/app.asar',
      path.join(process.env.HOME || '', '.local', 'share', 'antigravity', 'resources', 'app.asar'),
    ];
    for (const p of linuxCandidates) {
      if (fs.existsSync(p)) return p;
    }
  }

  return path.join(process.resourcesPath || '', 'app.asar');
}


export function getRestartExecutable(targetAsarPath?: string): { execPath: string; appBundle?: string } {
  const currentExec = process.execPath;
  const isNode = currentExec && (currentExec.toLowerCase().endsWith('node.exe') || currentExec.toLowerCase().endsWith('node'));

  const asar = targetAsarPath || getAppAsarPath();
  const resourcesDir = path.dirname(asar);
  const appRoot = path.dirname(resourcesDir);

  if (process.platform === 'darwin') {
    const bundle = path.resolve(resourcesDir, '..', '..');
    return {
      execPath: isNode ? '/usr/bin/open' : currentExec,
      appBundle: fs.existsSync(bundle) ? bundle : '/Applications/Antigravity.app',
    };
  }

  if (process.platform === 'win32') {
    const exeCandidate = path.join(appRoot, 'Antigravity.exe');
    if (fs.existsSync(exeCandidate)) {
      return { execPath: exeCandidate };
    }
    if (!isNode && currentExec) {
      return { execPath: currentExec };
    }
    return { execPath: exeCandidate };
  }


  const linuxExe = path.join(appRoot, 'antigravity');
  if (fs.existsSync(linuxExe)) {
    return { execPath: linuxExe };
  }
  return { execPath: !isNode && currentExec ? currentExec : 'antigravity' };
}

export function isValidAsarBuffer(buf: Buffer): boolean {
  if (buf.length < 16) return false;
  return buf[0] === 0x04 && buf[1] === 0x00 && buf[2] === 0x00 && buf[3] === 0x00;
}

export function readAsarPackageVersion(buf: Buffer): string {
  if (!isValidAsarBuffer(buf)) throw new Error('Invalid ASAR archive');
  const headerSize = buf.readUInt32LE(4);
  const jsonSize = buf.readUInt32LE(12);
  if (jsonSize > 64 * 1024 * 1024 || jsonSize + 8 > headerSize || 8 + headerSize > buf.length) throw new Error('Invalid ASAR header bounds');
  const header = JSON.parse(buf.subarray(16, 16 + jsonSize).toString('utf8'));
  const entry = header.files?.['package.json'];
  const offset = Number(entry?.offset);
  const size = Number(entry?.size);
  const start = 8 + headerSize + offset;
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(size) || size < 1 || size > 1024 * 1024 || start + size > buf.length) throw new Error('Invalid ASAR package.json bounds');
  const pkg = JSON.parse(buf.subarray(start, start + size).toString('utf8'));
  if (pkg.name !== 'antigravity' || typeof pkg.version !== 'string' || !pkg.version) throw new Error('Update is not an Antigravity archive');
  return pkg.version;
}


export function downloadUpdate(
  downloadUrl: string,
  onProgress?: (progress: DownloadProgress) => void,
  maxRedirects = 5,
): Promise<DownloadedUpdate> {
  return new Promise((resolve, reject) => {
    if (maxRedirects < 0) {
      reject(new Error('Too many redirects while downloading update'));
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(downloadUrl);
    } catch {
      reject(new Error(`Invalid download URL: ${downloadUrl}`));
      return;
    }

    const client = parsedUrl.protocol === 'https:' ? https : http;
    const req = client.get(
      parsedUrl,
      {
        headers: {
          'User-Agent': `AntigravityPlus/${ANTIGRAVITY_PLUS_VERSION} (${process.platform}; ${process.arch})`,
          Accept: '*/*',
        },
      },
      (res) => {
        const status = res.statusCode || 0;

        if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
          const redirectTarget = new URL(res.headers.location, downloadUrl).toString();
          res.resume();
          downloadUpdate(redirectTarget, onProgress, maxRedirects - 1).then(resolve, reject);
          return;
        }

        if (status < 200 || status >= 300) {
          res.resume();
          reject(new Error(`Download failed with HTTP ${status}`));
          return;
        }

        const totalBytes = parseInt(String(res.headers['content-length'] || '0'), 10) || 0;
        let downloadedBytes = 0;

        const tempDir = app?.getPath ? app.getPath('temp') : require('node:os').tmpdir();
        const rawDownloadPath = path.join(tempDir, `ag_update_raw_${randomUUID()}.tmp`);
        const fileStream = fs.createWriteStream(rawDownloadPath);
        const cleanup = (error: Error) => {
          res.destroy();
          fileStream.destroy();
          fileStream.once('close', () => { try { fs.unlinkSync(rawDownloadPath); } catch {} });
          reject(error);
        };
        fileStream.on('error', cleanup);
        res.on('aborted', () => cleanup(new Error('Update download was interrupted')));

        res.on('data', (chunk: Buffer) => {
          downloadedBytes += chunk.length;
          if (!fileStream.write(chunk)) { res.pause(); fileStream.once('drain', () => res.resume()); }
          if (totalBytes > 0 && onProgress) {
            const percent = Math.min(100, Math.round((downloadedBytes / totalBytes) * 100));
            onProgress({ percent, downloadedBytes, totalBytes });
          }
        });

        res.on('end', () => {
          fileStream.end(() => {
            try {
              let finalBuffer = fs.readFileSync(rawDownloadPath);


              if (finalBuffer.length >= 2 && finalBuffer[0] === 0x1f && finalBuffer[1] === 0x8b) {
                try {
                  finalBuffer = zlib.gunzipSync(finalBuffer);
                } catch (gzErr) {
                  reject(new Error(`Failed to decompress gzipped update: ${gzErr}`));
                  return;
                }
              }


              if (isValidAsarBuffer(finalBuffer)) {
                const targetAsar = path.join(tempDir, `app.asar.update_${Date.now()}`);
                fs.writeFileSync(targetAsar, finalBuffer);
                try {
                  fs.unlinkSync(rawDownloadPath);
                } catch {

                }
                log.info(`[PlusUpdater] Downloaded and verified ASAR package: ${targetAsar} (${finalBuffer.length} bytes)`);
                resolve({ filePath: targetAsar, type: 'asar' });
                return;
              }


              if (finalBuffer.length >= 2 && finalBuffer[0] === 0x4d && finalBuffer[1] === 0x5a) {
                const targetExe = path.join(tempDir, `AntigravityPlus_Update_${Date.now()}.exe`);
                fs.writeFileSync(targetExe, finalBuffer);
                try {
                  fs.unlinkSync(rawDownloadPath);
                } catch {

                }
                log.info(`[PlusUpdater] Downloaded Windows setup installer: ${targetExe} (${finalBuffer.length} bytes)`);
                resolve({ filePath: targetExe, type: 'installer' });
                return;
              }

              fs.unlinkSync(rawDownloadPath);
              reject(new Error('Downloaded update is neither an ASAR archive nor a Windows executable'));
            } catch (err) {
              reject(err);
            } finally {
              try { fs.unlinkSync(rawDownloadPath); } catch {}
            }
          });
        });

        res.on('error', (err) => {
          fileStream.destroy();
          try {
            if (fs.existsSync(rawDownloadPath)) fs.unlinkSync(rawDownloadPath);
          } catch {

          }
          reject(err);
        });
      },
    );

    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy(new Error('Download timed out after 60 seconds'));
    });
  });
}


export async function downloadUpdateInstaller(
  downloadUrl: string,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<string> {
  const result = await downloadUpdate(downloadUrl, onProgress);
  return result.filePath;
}


export function applyDirectAsarUpdate(newAsarPath: string): void {
  if (!fs.existsSync(newAsarPath)) {
    throw new Error(`New ASAR file not found at ${newAsarPath}`);
  }

  const targetAsar = getAppAsarPath();
  if (!fs.existsSync(targetAsar)) {
    throw new Error(`Active app.asar target could not be found (checked ${targetAsar})`);
  }

  const resourcesDir = path.dirname(targetAsar);
  const newBytes = fs.readFileSync(newAsarPath);
  const incomingVersion = readAsarPackageVersion(newBytes);
  const installedVersion = readAsarPackageVersion(fs.readFileSync(targetAsar));
  if (incomingVersion !== installedVersion) throw new Error(`Update targets Antigravity ${incomingVersion}, installed ${installedVersion}. Build a patch for the installed version.`);
  const backupAsar = path.join(resourcesDir, 'app.asar.vanilla_backup');

  if (!fs.existsSync(backupAsar) || readAsarPackageVersion(fs.readFileSync(backupAsar)) !== installedVersion) {
    throw new Error('Clean vanilla backup is missing or belongs to a different Antigravity version. Repair the installation before updating.');
  }

  const { execPath, appBundle } = getRestartExecutable(targetAsar);
  const currentPid = process.pid;
  const tempDir = app?.getPath ? app.getPath('temp') : require('node:os').tmpdir();

  log.info(`[PlusUpdater] Preparing direct ASAR hot-update. Target: ${targetAsar}, Executable: ${execPath}`);

  let updateHelper: cp.ChildProcess;
  if (process.platform === 'win32') {
    const scriptPath = path.join(tempDir, `ag_hotupdate_${randomUUID()}.ps1`);
    const quote = (value: string) => "'" + value.replace(/'/g, "''") + "'";
    const expectedHash = createHash('sha256').update(newBytes).digest('hex');
    const script = `$ErrorActionPreference = 'Stop'
$target = ${quote(targetAsar)}
$incoming = ${quote(newAsarPath)}
$executable = ${quote(execPath)}
$staged = $target + '.staged.' + [Guid]::NewGuid().ToString('N')
$rollback = $target + '.previous_backup'
try {
  for ($attempt = 0; $attempt -lt 60; $attempt++) {
    if (-not (Get-Process -Id ${currentPid} -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  if (Get-Process -Id ${currentPid} -ErrorAction SilentlyContinue) { throw 'Antigravity did not exit; update preserved for retry.' }
  Copy-Item -LiteralPath $incoming -Destination $staged
  if ((Get-FileHash -LiteralPath $staged -Algorithm SHA256).Hash -ne '${expectedHash}') { throw 'Staged update checksum mismatch.' }
  $replaced = $false
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try { [IO.File]::Replace($staged, $target, $rollback, $true); $replaced = $true; break }
    catch { if ($attempt -eq 19) { throw }; Start-Sleep -Milliseconds 500 }
  }
  if (-not $replaced) { throw 'Could not replace app.asar.' }
  Remove-Item -LiteralPath $incoming
  Start-Process -FilePath $executable -WindowStyle Hidden
  Remove-Item -LiteralPath $PSCommandPath
} catch {
  $_ | Out-String | Set-Content -LiteralPath ($incoming + '.error.log')
  if (Test-Path -LiteralPath $staged) { Remove-Item -LiteralPath $staged }
  exit 1
}
`;
    fs.writeFileSync(scriptPath, script, 'utf8');
    const child = cp.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    child.once('error', (error) => log.error('[PlusUpdater] Could not start atomic update helper:', error));
    updateHelper = child;
    child.unref();
  } else {

    const shPath = path.join(tempDir, `ag_hotupdate_${Date.now()}.sh`);
    const isMac = process.platform === 'darwin' ? 1 : 0;
    const bundlePath = appBundle || '';

    const shContent = `#!/bin/bash
PID=${currentPid}
TARGET_ASAR="${targetAsar}"
NEW_ASAR="${newAsarPath}"
EXEC_PATH="${execPath}"
IS_MAC=${isMac}
APP_BUNDLE="${bundlePath}"

while kill -0 "$PID" 2>/dev/null; do
    sleep 0.5
done
sleep 0.5

BACKUP_PATH="$(dirname "$TARGET_ASAR")/app.asar.vanilla_backup"
if [ ! -f "$BACKUP_PATH" ]; then
    cp -p "$TARGET_ASAR" "$BACKUP_PATH" 2>/dev/null || true
fi

mv -f "$NEW_ASAR" "$TARGET_ASAR"

if [ "$IS_MAC" -eq 1 ] && [ -d "$APP_BUNDLE" ]; then
    command -v xattr >/dev/null 2>&1 && xattr -cr "$APP_BUNDLE" 2>/dev/null || true
    command -v codesign >/dev/null 2>&1 && codesign --force --deep --sign - "$APP_BUNDLE" 2>/dev/null || true
    open "$APP_BUNDLE"
else
    nohup "$EXEC_PATH" >/dev/null 2>&1 &
fi

rm -f "$0"
`;
    fs.writeFileSync(shPath, shContent, { encoding: 'utf8', mode: 0o755 });

    const child = cp.spawn('/bin/bash', [shPath], {
      detached: true,
      stdio: 'ignore',
    });
    updateHelper = child;
    child.unref();
  }


  updateHelper.once('spawn', () => setTimeout(() => {
    log.info('[PlusUpdater] Exiting Antigravity process for hot-swap...');
    const appAny = app as any;
    if (appAny && typeof appAny.exit === 'function') {
      appAny.exit(0);
    } else if (appAny && typeof appAny.quit === 'function') {
      appAny.quit();
    }
  }, 300));
}


export function applyUpdateAndRestart(installerPath: string): void {
  if (!fs.existsSync(installerPath)) {
    throw new Error(`Installer executable not found at ${installerPath}`);
  }

  log.info(`[PlusUpdater] Spawning update installer: ${installerPath} --updating`);

  const child = cp.spawn(installerPath, ['--updating'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.once('error', (error) => log.error('[PlusUpdater] Could not launch installer:', error));
  child.unref();

  child.once('spawn', () => setTimeout(() => {
    log.info('[PlusUpdater] Quitting Antigravity for automated in-place patch application...');
    const appAny = app as any;
    if (appAny && typeof appAny.exit === 'function') {
      appAny.exit(0);
    } else if (appAny && typeof appAny.quit === 'function') {
      appAny.quit();
    }
  }, 500));
}
