

import * as http from 'node:http';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { app } from 'electron';
import log from 'electron-log';
import { loginGoogleAccount } from './googleOAuth';

export const ANTIGRAVITY_CLIENT_ID = String.fromCharCode(49, 48, 55, 49, 48, 48, 54, 48, 54, 48, 53, 57, 49, 45, 116, 109, 104, 115, 115, 105, 110, 50, 104, 50, 49, 108, 99, 114, 101, 50, 51, 53, 118, 116, 111, 108, 111, 106, 104, 52, 103, 52, 48, 51, 101, 112, 46, 97, 112, 112, 115, 46, 103, 111, 111, 103, 108, 101, 117, 115, 101, 114, 99, 111, 110, 116, 101, 110, 116, 46, 99, 111, 109);
export const ANTIGRAVITY_CLIENT_SECRET = String.fromCharCode(71, 79, 67, 83, 80, 88, 45, 75, 53, 56, 70, 87, 82, 52, 56, 54, 76, 100, 76, 74, 49, 109, 76, 66, 56, 115, 88, 67, 52, 122, 54, 113, 68, 65, 102);
export const CLOUDCODE_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com';

export interface QuotaBucketInfo {
  id: string;
  displayName?: string;
  description?: string;
  window?: string;
  remainingFraction?: number;
  remainingAmount?: number;
  resetTime?: string;
}

export interface QuotaGroupInfo {
  displayName?: string;
  description?: string;
  buckets: QuotaBucketInfo[];
}

export interface PooledAccount {
  id: string;
  email: string;
  label?: string;
  name?: string;
  picture?: string;
  refreshToken: string;
  accessToken?: string;
  expiresAt?: number;
  clientId: string;
  clientSecret?: string;
  project?: string;
  cooldownUntil: number;
  modelCooldowns?: Record<string, number>;
  lastQuota?: {
    checkedAt: number;
    remainingFraction?: number;
    resetTime?: string;
    groups?: QuotaGroupInfo[];
    rawResponse?: Record<string, unknown>;
  };
}

export type QuotaDisplayMode = 'normalized' | 'additive' | 'active';
export type PromptEngineMode = 'antigravity' | 'claude' | 'custom';
export type UIThemeMode = 'antigravity' | 'claude';

export interface AccountPoolConfig {
  activeAccountId?: string;
  autoHotswap: boolean;
  combineLimits: boolean;
  quotaDisplayMode: QuotaDisplayMode;
  showActiveInLimits: boolean;
  soundEnabled?: boolean;
  soundTheme?: string;
  updateServerUrl?: string;
  autoCheckUpdates?: boolean;
  promptEngineMode?: PromptEngineMode;
  customPromptText?: string;
  uiThemeMode?: UIThemeMode;
  geminiFallbackModel?: string;
  accounts: PooledAccount[];
}

export interface CombinedQuotaSummary {
  checkedAt: number;
  totalAccounts: number;
  activeAccountsCount: number;
  combinedRemainingFraction: number;
  totalCapacityPercent: number;
  earliestResetTime?: string;
  groups: QuotaGroupInfo[];
  rawResponse?: Record<string, unknown>;
}

function getPoolFilePath(): string {
  const geminiDir = path.join(app.getPath('home'), '.gemini', 'antigravity');
  return path.join(geminiDir, 'account_pool.json');
}

export function loadPoolConfig(): AccountPoolConfig {
  const file = getPoolFilePath();
  try {
    if (fs.existsSync(file)) {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (data && Array.isArray(data.accounts)) {
        return {
          activeAccountId: data.activeAccountId || (data.accounts[0]?.id),
          autoHotswap: data.autoHotswap !== false,
          combineLimits: data.combineLimits !== false,
          quotaDisplayMode: data.quotaDisplayMode || 'normalized',
          showActiveInLimits: data.showActiveInLimits === true,
          soundEnabled: data.soundEnabled !== false,
          soundTheme: data.soundTheme || 'ps5-notification.mp3',
          updateServerUrl: data.updateServerUrl || 'https://antigravity-plus-updates.unalty-api.workers.dev',
          autoCheckUpdates: data.autoCheckUpdates !== false,
          promptEngineMode: data.promptEngineMode || 'antigravity',
          customPromptText: data.customPromptText || '',
          uiThemeMode: data.uiThemeMode || 'antigravity',
          geminiFallbackModel: typeof data.geminiFallbackModel === 'string' ? data.geminiFallbackModel : '',
          accounts: data.accounts,
        };
      }
    }
  } catch (err) {
    log.error('[AccountPool] Failed to load config:', err);
  }
  return {
    autoHotswap: true,
    combineLimits: true,
    quotaDisplayMode: 'normalized',
    showActiveInLimits: false,
    soundEnabled: true,
    soundTheme: 'ps5-notification.mp3',
    updateServerUrl: 'https://antigravity-plus-updates.unalty-api.workers.dev',
    autoCheckUpdates: true,
    promptEngineMode: 'antigravity',
    customPromptText: '',
    uiThemeMode: 'antigravity',
    accounts: [],
  };
}

export function savePoolConfig(config: AccountPoolConfig): void {
  const file = getPoolFilePath();
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp.${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    log.error('[AccountPool] Failed to save config:', err);
    throw err;
  }
}


export async function readNativeWindowsCredential(): Promise<{
  refreshToken?: string;
  accessToken?: string;
  expiry?: string;
  email?: string;
  clientId?: string;
} | null> {
  if (process.platform !== 'win32') return null;

  return new Promise((resolve) => {
    const pyScript = `
import ctypes, json, sys
from ctypes import wintypes
class C(ctypes.Structure):
    _fields_ = [
        ('F', wintypes.DWORD), ('T', wintypes.DWORD),
        ('TN', wintypes.LPWSTR), ('C', wintypes.LPWSTR),
        ('LW', wintypes.FILETIME), ('S', wintypes.DWORD),
        ('B', ctypes.POINTER(ctypes.c_byte)), ('P', wintypes.DWORD),
        ('AC', wintypes.DWORD), ('A', ctypes.c_void_p),
        ('TA', wintypes.LPWSTR), ('UN', wintypes.LPWSTR)
    ]
p = ctypes.POINTER(C)()
if ctypes.windll.advapi32.CredReadW('gemini:antigravity', 1, 0, ctypes.byref(p)):
    sys.stdout.write(ctypes.string_at(p.contents.B, p.contents.S).decode('utf-8'))
    ctypes.windll.advapi32.CredFree(p)
else:
    sys.exit(1)
`;
    execFile('python', ['-c', pyScript], (err, stdout) => {
      if (err || !stdout) {
        log.warn('[AccountPool] Could not read native credential via python:', err?.message);
        resolve(null);
        return;
      }
      try {
        const parsed = JSON.parse(stdout);
        const token = parsed.token || {};
        let email: string | undefined;
        let clientId: string | undefined;

        if (parsed.id_token) {
          try {
            const parts = parsed.id_token.split('.');
            if (parts.length >= 2) {
              const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
              email = payload.email;
              clientId = payload.azp || payload.aud;
            }
          } catch {

          }
        }

        resolve({
          refreshToken: token.refresh_token,
          accessToken: token.access_token,
          expiry: token.expiry,
          email,
          clientId: clientId || ANTIGRAVITY_CLIENT_ID,
        });
      } catch (e) {
        log.error('[AccountPool] Parse error on native credential:', e);
        resolve(null);
      }
    });
  });
}


export async function captureActiveNativeSession(): Promise<PooledAccount> {
  const cred = await readNativeWindowsCredential();
  if (!cred || !cred.refreshToken) {
    throw new Error('No active Antigravity session found in Windows Credential Manager.');
  }

  const config = loadPoolConfig();
  const email = cred.email || 'antigravity-user@gmail.com';
  const existingIndex = config.accounts.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());

  let account: PooledAccount;
  if (existingIndex >= 0) {
    account = {
      ...config.accounts[existingIndex],
      refreshToken: cred.refreshToken,
      accessToken: cred.accessToken || config.accounts[existingIndex].accessToken,
      expiresAt: cred.expiry ? new Date(cred.expiry).getTime() : Date.now() + 3600_000,
    };
    config.accounts[existingIndex] = account;
  } else {
    account = {
      id: `acc-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      email,
      label: config.accounts.length === 0 ? 'Primary Account' : `Account ${config.accounts.length + 1}`,
      refreshToken: cred.refreshToken,
      accessToken: cred.accessToken,
      expiresAt: cred.expiry ? new Date(cred.expiry).getTime() : Date.now() + 3600_000,
      clientId: cred.clientId || ANTIGRAVITY_CLIENT_ID,
      clientSecret: ANTIGRAVITY_CLIENT_SECRET,
      cooldownUntil: 0,
    };
    config.accounts.push(account);
  }

  if (!config.activeAccountId) {
    config.activeAccountId = account.id;
  }

  savePoolConfig(config);
  log.info(`[AccountPool] Captured native account: ${account.email}`);


  void enrichAccountProfile(account.id);
  return account;
}


export async function enrichAccountProfile(accountId: string): Promise<void> {
  const config = loadPoolConfig();
  const account = config.accounts.find((a) => a.id === accountId);
  if (!account) return;

  try {
    const validAcc = await refreshPooledAccount(account);
    const fetchJson = (url: string): Promise<Record<string, unknown> | null> => {
      return new Promise((resolve) => {
        const req = https.request(url, {
          headers: { Authorization: `Bearer ${validAcc.accessToken}` },
        }, (res) => {
          let data = '';
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            try {
              if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
                resolve(JSON.parse(data));
              } else {
                resolve(null);
              }
            } catch {
              resolve(null);
            }
          });
        });
        req.on('error', () => resolve(null));
        req.end();
      });
    };

    let info = await fetchJson('https://www.googleapis.com/oauth2/v2/userinfo');
    if (!info || !info.email) {
      info = await fetchJson(`https://oauth2.googleapis.com/tokeninfo?access_token=${validAcc.accessToken}`);
    }

    if (info) {
      const latestCfg = loadPoolConfig();
      const target = latestCfg.accounts.find((a) => a.id === accountId);
      if (target) {
        let changed = false;
        if (typeof info.email === 'string' && info.email && target.email !== info.email) {
          target.email = info.email;
          changed = true;
        }
        if (typeof info.name === 'string' && info.name && target.name !== info.name) {
          target.name = info.name;
          changed = true;
        }
        if (typeof info.picture === 'string' && info.picture && target.picture !== info.picture) {
          target.picture = info.picture;
          changed = true;
        }
        if (changed) savePoolConfig(latestCfg);
      }
    }
  } catch {

  }
}


const tokenRefreshes = new Map<string, { refreshToken: string; promise: Promise<PooledAccount> }>();

export function refreshPooledAccount(account: PooledAccount): Promise<PooledAccount> {
  const pending = tokenRefreshes.get(account.id);
  if (pending?.refreshToken === account.refreshToken) return pending.promise;
  const promise = refreshPooledAccountOnce(account);
  tokenRefreshes.set(account.id, { refreshToken: account.refreshToken, promise });
  const clear = () => { if (tokenRefreshes.get(account.id)?.promise === promise) tokenRefreshes.delete(account.id); };
  void promise.then(clear, clear);
  return promise;
}

async function refreshPooledAccountOnce(account: PooledAccount): Promise<PooledAccount> {
  const now = Date.now();
  if (account.accessToken && account.expiresAt && account.expiresAt > now + 90_000) {
    return account;
  }

  const clientId = account.clientId || ANTIGRAVITY_CLIENT_ID;
  const clientSecret = account.clientSecret || ANTIGRAVITY_CLIENT_SECRET;

  return new Promise((resolve, reject) => {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: account.refreshToken,
      client_id: clientId,
    });
    if (clientSecret) body.set('client_secret', clientSecret);

    const bodyStr = body.toString();
    const req = https.request('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(bodyStr),
      },
    }, (res) => {
      res.on('error', reject);
      res.on('aborted', () => reject(new Error('Account token response was interrupted')));
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300 && json.access_token) {
            const expiresIn = typeof json.expires_in === 'number' ? json.expires_in : 3600;
            const updated: PooledAccount = {
              ...account,
              accessToken: json.access_token,
              expiresAt: Date.now() + expiresIn * 1000,
            };
            if (json.refresh_token) updated.refreshToken = json.refresh_token;


            const cfg = loadPoolConfig();
            const idx = cfg.accounts.findIndex((a) => a.id === account.id);
            if (idx >= 0) {

              cfg.accounts[idx] = { ...cfg.accounts[idx], accessToken: updated.accessToken,
                expiresAt: updated.expiresAt, refreshToken: updated.refreshToken };
              savePoolConfig(cfg);
              resolve(cfg.accounts[idx]);
              return;
            }
            resolve(updated);
          } else {
            reject(new Error(json.error_description || `OAuth refresh failed (${res.statusCode})`));
          }
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Account token refresh timed out')));
    req.write(bodyStr);
    req.end();
  });
}


export async function fetchAccountQuota(account: PooledAccount, rawHeaders?: http.IncomingHttpHeaders): Promise<PooledAccount['lastQuota']> {
  const refreshed = await refreshPooledAccount(account);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${refreshed.accessToken}`,
  };


  if (rawHeaders) {
    for (const key of ['x-goog-api-client', 'user-agent']) {
      if (rawHeaders[key]) headers[key] = String(rawHeaders[key]);
    }
  }

  const reqBody = JSON.stringify(account.project ? { project: account.project } : {});

  return new Promise((resolve) => {
    const req = https.request(`${CLOUDCODE_ENDPOINT}/v1internal:retrieveUserQuotaSummary`, {
      method: 'POST',
      headers: { ...headers, 'Content-Length': Buffer.byteLength(reqBody) },
    }, (res) => {
      res.on('error', () => resolve(undefined));
      res.on('aborted', () => resolve(undefined));
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            const json = JSON.parse(data);
            const groups: QuotaGroupInfo[] = [];
            const rawGroups = Array.isArray(json.groups) ? json.groups : [{ buckets: json.buckets }];

            for (const rg of rawGroups) {
              const buckets: QuotaBucketInfo[] = [];
              for (const b of (Array.isArray(rg?.buckets) ? rg.buckets : [])) {
                if (!b) continue;
                buckets.push({
                  id: b.bucketId || b.id || 'quota',
                  displayName: b.displayName,
                  description: b.description,
                  window: b.window,
                  remainingFraction: typeof b.remainingFraction === 'number' ? Math.max(0, Math.min(1, b.remainingFraction)) : undefined,
                  remainingAmount: typeof b.remainingAmount === 'number' ? b.remainingAmount : undefined,
                  resetTime: b.resetTime,
                });
              }
              groups.push({
                displayName: rg?.displayName,
                description: rg?.description,
                buckets,
              });
            }

            const allFractions = groups.flatMap((g) => g.buckets.flatMap((b) => b.remainingFraction !== undefined ? [b.remainingFraction] : []));
            const minFraction = allFractions.length ? Math.min(...allFractions) : undefined;
            const resetTimes = groups.flatMap((g) => g.buckets.flatMap((b) => b.resetTime ? [b.resetTime] : []));

            const quotaSnapshot = {
              checkedAt: Date.now(),
              remainingFraction: minFraction,
              resetTime: resetTimes[0],
              groups,
              rawResponse: json,
            };


            const cfg = loadPoolConfig();
            const idx = cfg.accounts.findIndex((a) => a.id === account.id);
            if (idx >= 0) {
              cfg.accounts[idx].lastQuota = quotaSnapshot;
              savePoolConfig(cfg);
              try { require('./quotaHistory').recordQuota(path.dirname(getPoolFilePath()), account.id, quotaSnapshot); }
              catch {  }
            }

            resolve(quotaSnapshot);
          } else {
            resolve(undefined);
          }
        } catch {
          resolve(undefined);
        }
      });
    });

    req.on('error', () => resolve(undefined));
    req.setTimeout(15000, () => req.destroy(new Error('Account quota request timed out')));
    req.write(reqBody);
    req.end();
  });
}


type CombinedQuotaResult = { summary: CombinedQuotaSummary; aggregatedResponse: Record<string, unknown> };
let combinedQuotaRequest: Promise<CombinedQuotaResult> | undefined;
export function fetchCombinedPoolQuota(rawHeaders?: http.IncomingHttpHeaders): Promise<CombinedQuotaResult> {
  if (combinedQuotaRequest) return combinedQuotaRequest;
  const promise = fetchCombinedPoolQuotaOnce(rawHeaders);
  combinedQuotaRequest = promise;
  const clear = () => { if (combinedQuotaRequest === promise) combinedQuotaRequest = undefined; };
  void promise.then(clear, clear);
  return promise;
}

async function fetchCombinedPoolQuotaOnce(rawHeaders?: http.IncomingHttpHeaders): Promise<{
  summary: CombinedQuotaSummary;
  aggregatedResponse: Record<string, unknown>;
}> {
  const config = loadPoolConfig();
  const accounts = config.accounts;

  if (accounts.length === 0) {
    return {
      summary: {
        checkedAt: Date.now(),
        totalAccounts: 0,
        activeAccountsCount: 0,
        combinedRemainingFraction: 1.0,
        totalCapacityPercent: 100,
        groups: [],
      },
      aggregatedResponse: { groups: [], buckets: [] },
    };
  }


  const quotaResults = await Promise.all(
    accounts.map(async (acc) => {
      try {
        return await fetchAccountQuota(acc, rawHeaders);
      } catch {
        return acc.lastQuota;
      }
    }),
  );

  return mergeAccountQuotas(accounts, quotaResults, config);
}

export function mergeAccountQuotas(
  accounts: PooledAccount[],
  quotaResults: Array<PooledAccount['lastQuota']>,
  configOverride?: Partial<AccountPoolConfig>,
): {
  summary: CombinedQuotaSummary;
  aggregatedResponse: Record<string, unknown>;
} {
  const N = accounts.length;
  const config = { ...loadPoolConfig(), ...(configOverride || {}) };
  const mode = config.quotaDisplayMode || 'normalized';
  const showActive = config.showActiveInLimits === true;


  const mergedGroupsMap = new Map<string, {
    displayName?: string;
    description?: string;
    bucketsMap: Map<string, {
      bucketId: string;
      displayName?: string;
      description?: string;
      window?: string;
      fractions: number[];
      resetTimes: string[];
      activeFraction?: number;
      activeResetTime?: string;
    }>;
  }>();

  quotaResults.forEach((q, accIdx) => {
    if (!q || !q.groups) return;
    const isThisActive = accounts[accIdx].id === config.activeAccountId;

    q.groups.forEach((g, gIdx) => {
      const gKey = g.displayName || `group-${gIdx}`;
      let groupEntry = mergedGroupsMap.get(gKey);
      if (!groupEntry) {
        groupEntry = {
          displayName: g.displayName,
          description: g.description,
          bucketsMap: new Map(),
        };
        mergedGroupsMap.set(gKey, groupEntry);
      }

      g.buckets.forEach((b) => {
        let bEntry = groupEntry.bucketsMap.get(b.id);
        if (!bEntry) {
          bEntry = {
            bucketId: b.id,
            displayName: b.displayName,
            description: b.description,
            window: b.window,
            fractions: [],
            resetTimes: [],
          };
          groupEntry.bucketsMap.set(b.id, bEntry);
        }
        if (typeof b.remainingFraction === 'number') {
          bEntry.fractions.push(b.remainingFraction);
          if (isThisActive) {
            bEntry.activeFraction = b.remainingFraction;
          }
        }
        if (b.resetTime) {
          bEntry.resetTimes.push(b.resetTime);
          if (isThisActive) {
            bEntry.activeResetTime = b.resetTime;
          }
        }
      });
    });
  });

  const finalGroups: QuotaGroupInfo[] = [];
  const rawGroups: Array<Record<string, unknown>> = [];

  mergedGroupsMap.forEach((g) => {
    const buckets: QuotaBucketInfo[] = [];
    const rawBuckets: Array<Record<string, unknown>> = [];

    g.bucketsMap.forEach((b) => {
      const totalFractionSum = b.fractions.reduce((sum, v) => sum + v, 0);
      const avgFraction = b.fractions.length ? totalFractionSum / N : 1.0;

      const sortedResets = [...b.resetTimes].sort();
      const earliestReset = sortedResets[0];



      const isWeekly = /weekly/i.test(b.bucketId) || /weekly/i.test(b.displayName || '');
      const is5h = /5h/i.test(b.bucketId) || /five\s*hour/i.test(b.displayName || '');
      let baseTitle = b.displayName || b.bucketId;
      if (isWeekly) baseTitle = 'Weekly';
      else if (is5h) baseTitle = '5 Hours';

      let displayFraction = avgFraction;
      let label = `${baseTitle} (${N} accounts)`;

      if (mode === 'additive') {
        displayFraction = totalFractionSum;
        label = `${baseTitle} (${N} accounts)`;
      } else if (mode === 'active') {
        displayFraction = b.activeFraction !== undefined ? b.activeFraction : avgFraction;
        label = `${baseTitle} (Active)`;
      } else {

        displayFraction = Math.max(0, Math.min(1.0, avgFraction));
        label = `${baseTitle} (${N} accounts)`;
      }

      const bucketInfo: QuotaBucketInfo = {
        id: b.bucketId,
        displayName: label,
        description: b.description,
        window: b.window,
        remainingFraction: displayFraction,
        resetTime: mode === 'active' && b.activeResetTime ? b.activeResetTime : earliestReset,
      };
      buckets.push(bucketInfo);

      rawBuckets.push({
        bucketId: b.bucketId,
        displayName: label,
        description: b.description,
        window: b.window,
        remainingFraction: displayFraction,
        resetTime: mode === 'active' && b.activeResetTime ? b.activeResetTime : earliestReset,
      });


      if (showActive && mode !== 'active' && b.activeFraction !== undefined && N > 1) {
        const activeLabel = `${baseTitle} (Active)`;
        const activeBucket: QuotaBucketInfo = {
          id: `${b.bucketId}-active`,
          displayName: activeLabel,
          description: 'Current active account',
          window: b.window,
          remainingFraction: b.activeFraction,
          resetTime: b.activeResetTime || earliestReset,
        };
        buckets.push(activeBucket);
        rawBuckets.push({
          bucketId: `${b.bucketId}-active`,
          displayName: activeLabel,
          description: 'Current active account',
          window: b.window,
          remainingFraction: b.activeFraction,
          resetTime: b.activeResetTime || earliestReset,
        });
      }
    });

    finalGroups.push({
      displayName: g.displayName,
      description: g.description,
      buckets,
    });

    rawGroups.push({
      displayName: g.displayName,
      description: g.description,
      buckets: rawBuckets,
    });
  });


  const accountFractions: number[] = accounts.map((_acc, idx) => {
    const q = quotaResults[idx];
    if (!q || !q.groups) return 1.0;
    const fracs: number[] = [];
    q.groups.forEach((group) => {
      group.buckets.forEach((b) => {
        if (typeof b.remainingFraction === 'number') fracs.push(b.remainingFraction);
      });
    });
    return fracs.length ? Math.min(...fracs) : 1.0;
  });

  const sumFractions = accountFractions.reduce((sum, v) => sum + v, 0);
  const avgFraction = N > 0 ? sumFractions / N : 1.0;
  const activeAccountIdx = accounts.findIndex((a) => a.id === config.activeAccountId);
  const activeFraction = activeAccountIdx >= 0 ? accountFractions[activeAccountIdx] : (accountFractions[0] ?? 1.0);
  const activeCount = accounts.filter((a) => (a.cooldownUntil || 0) <= Date.now()).length;

  let poolFraction = avgFraction;
  let totalCapPercent = Math.round(sumFractions * 100);

  if (mode === 'normalized') {
    poolFraction = Math.max(0, Math.min(1.0, avgFraction));
    totalCapPercent = Math.round(avgFraction * 100);
  } else if (mode === 'additive') {
    poolFraction = sumFractions;
    totalCapPercent = Math.round(sumFractions * 100);
  } else if (mode === 'active') {
    poolFraction = Math.max(0, Math.min(1.0, activeFraction));
    totalCapPercent = Math.round(activeFraction * 100);
  }

  const summary: CombinedQuotaSummary = {
    checkedAt: Date.now(),
    totalAccounts: N,
    activeAccountsCount: activeCount,
    combinedRemainingFraction: poolFraction,
    totalCapacityPercent: totalCapPercent,
    earliestResetTime: finalGroups[0]?.buckets[0]?.resetTime,
    groups: finalGroups,
  };

  const aggregatedResponse: Record<string, unknown> = {
    groups: rawGroups,
    description: `Antigravity Multi-Account Pool: ${N} accounts connected. Mode: ${mode}.`,
  };

  return { summary, aggregatedResponse };
}


export function isClaudeModel(modelName?: string): boolean {
  if (!modelName) return false;
  const lower = modelName.toLowerCase();
  return lower.includes('claude') || lower.includes('sonnet') || lower.includes('opus') || lower.includes('3p') || lower.includes('gpt');
}


export function isAccountExhaustedForModel(account: PooledAccount, modelName?: string, now = Date.now()): boolean {

  if ((account.cooldownUntil || 0) > now) return true;

  const isClaude = isClaudeModel(modelName);
  const modelKey = isClaude ? 'claude' : 'gemini';


  if (account.modelCooldowns && (account.modelCooldowns[modelKey] || 0) > now) {
    return true;
  }


  if (account.lastQuota && Array.isArray(account.lastQuota.groups) && account.lastQuota.groups.length > 0) {
    if (isClaude) {
      const claudeGroup = account.lastQuota.groups.find((g) =>
        (g.displayName && /claude|3p|gpt/i.test(g.displayName)) ||
        g.buckets.some((b) => /3p/i.test(b.id))
      );
      if (claudeGroup && claudeGroup.buckets.length > 0) {
        const fractions = claudeGroup.buckets
          .map((b) => b.remainingFraction)
          .filter((f): f is number => typeof f === 'number');
        if (fractions.length > 0) {
          return Math.min(...fractions) <= 0.01;
        }
      }
    } else {
      const geminiGroup = account.lastQuota.groups.find((g) =>
        (g.displayName && /gemini/i.test(g.displayName)) ||
        g.buckets.some((b) => /gemini/i.test(b.id))
      );
      if (geminiGroup && geminiGroup.buckets.length > 0) {
        const fractions = geminiGroup.buckets
          .map((b) => b.remainingFraction)
          .filter((f): f is number => typeof f === 'number');
        if (fractions.length > 0) {
          return Math.min(...fractions) <= 0.01;
        }
      }
    }
  }


  if (account.lastQuota?.remainingFraction !== undefined && account.lastQuota.remainingFraction <= 0.01) {
    return true;
  }

  return false;
}


export function getAccountQuotaForModel(account: PooledAccount, modelName?: string): number {
  const isClaude = isClaudeModel(modelName);
  if (account.lastQuota && Array.isArray(account.lastQuota.groups)) {
    if (isClaude) {
      const claudeGroup = account.lastQuota.groups.find((g) =>
        (g.displayName && /claude|3p|gpt/i.test(g.displayName)) ||
        g.buckets.some((b) => /3p/i.test(b.id))
      );
      if (claudeGroup && claudeGroup.buckets.length > 0) {
        const fractions = claudeGroup.buckets
          .map((b) => b.remainingFraction)
          .filter((f): f is number => typeof f === 'number');
        if (fractions.length > 0) return Math.min(...fractions);
      }
    } else {
      const geminiGroup = account.lastQuota.groups.find((g) =>
        (g.displayName && /gemini/i.test(g.displayName)) ||
        g.buckets.some((b) => /gemini/i.test(b.id))
      );
      if (geminiGroup && geminiGroup.buckets.length > 0) {
        const fractions = geminiGroup.buckets
          .map((b) => b.remainingFraction)
          .filter((f): f is number => typeof f === 'number');
        if (fractions.length > 0) return Math.min(...fractions);
      }
    }
  }
  return account.lastQuota?.remainingFraction ?? 0.5;
}


export function findBestAvailableAccount(
  modelName?: string,
  excludeAccountIds?: Set<string>,
): PooledAccount | null {
  const config = loadPoolConfig();
  const now = Date.now();
  const candidates = config.accounts.filter((a) => {
    if (excludeAccountIds && excludeAccountIds.has(a.id)) return false;
    return !isAccountExhaustedForModel(a, modelName, now);
  });
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => getAccountQuotaForModel(b, modelName) - getAccountQuotaForModel(a, modelName));
  return candidates[0];
}


export async function getEffectiveAccountForRequest(modelName?: string): Promise<{
  account: PooledAccount;
  didHotSwap: boolean;
  swappedFrom?: string;
}> {
  const config = loadPoolConfig();
  if (config.accounts.length === 0) {
    throw new Error('No accounts available in Antigravity account pool.');
  }

  const now = Date.now();
  let activeAccount = config.accounts.find((a) => a.id === config.activeAccountId) || config.accounts[0];

  const isActiveExhausted = isAccountExhaustedForModel(activeAccount, modelName, now);

  if (isActiveExhausted && config.autoHotswap && config.accounts.length > 1) {
    const candidates = config.accounts.filter(
      (a) => a.id !== activeAccount.id && !isAccountExhaustedForModel(a, modelName, now),
    );
    if (candidates.length > 0) {
      candidates.sort((a, b) => getAccountQuotaForModel(b, modelName) - getAccountQuotaForModel(a, modelName));
      for (const nextAccount of candidates) {
        try {
          const refreshed = await refreshPooledAccount(nextAccount);
          const latest = loadPoolConfig();
          if (!latest.accounts.some((account) => account.id === nextAccount.id)) continue;
          latest.activeAccountId = nextAccount.id;
          savePoolConfig(latest);
          log.info(`[AccountPool] HOT-SWAP: Selected healthy standby for ${modelName || 'default'}.`);
          return { account: refreshed, didHotSwap: true, swappedFrom: activeAccount.email };
        } catch (error) { log.warn('[AccountPool] Standby token refresh failed; trying next candidate', error); }
      }
    }
  }

  const refreshed = await refreshPooledAccount(activeAccount);
  return { account: refreshed, didHotSwap: false };
}


export async function reportAccountExhaustion(
  accountId: string,
  statusCode: number,
  retryAfterMs?: number,
  modelName?: string,
  excludeAccountIds?: Set<string>,
): Promise<{ nextAccount: PooledAccount | null; previousEmail: string }> {
  const config = loadPoolConfig();
  const accountIndex = config.accounts.findIndex((a) => a.id === accountId);
  if (accountIndex < 0) return { nextAccount: null, previousEmail: 'unknown' };

  const current = config.accounts[accountIndex];
  const cooldownDuration = retryAfterMs || 3600_000;
  const now = Date.now();
  const isClaude = isClaudeModel(modelName);

  if (!current.modelCooldowns) current.modelCooldowns = {};
  if (isClaude) {
    current.modelCooldowns['claude'] = now + cooldownDuration;
    if (current.lastQuota?.groups) {
      const g = current.lastQuota.groups.find((grp) =>
        (grp.displayName && /claude|3p|gpt/i.test(grp.displayName)) ||
        grp.buckets.some((b) => /3p/i.test(b.id)),
      );
      if (g) g.buckets.forEach((b) => (b.remainingFraction = 0));
    }
  } else if (modelName) {
    current.modelCooldowns['gemini'] = now + cooldownDuration;
    if (current.lastQuota?.groups) {
      const g = current.lastQuota.groups.find((grp) =>
        (grp.displayName && /gemini/i.test(grp.displayName)) ||
        grp.buckets.some((b) => /gemini/i.test(b.id)),
      );
      if (g) g.buckets.forEach((b) => (b.remainingFraction = 0));
    }
  } else {
    current.cooldownUntil = now + cooldownDuration;
    if (current.lastQuota) {
      current.lastQuota.remainingFraction = 0.0;
    }
  }
  savePoolConfig(config);

  log.warn(`[AccountPool] Account ${current.email} marked in cooldown for ${Math.round(cooldownDuration / 1000)}s for ${modelName || 'all'} (HTTP ${statusCode})`);

  if (config.autoHotswap && config.accounts.length > 1) {
    const candidates = config.accounts.filter((a) => {
      if (a.id === current.id) return false;
      if (excludeAccountIds && excludeAccountIds.has(a.id)) return false;
      return !isAccountExhaustedForModel(a, modelName, now);
    });

    if (candidates.length > 0) {
      candidates.sort((a, b) => getAccountQuotaForModel(b, modelName) - getAccountQuotaForModel(a, modelName));
      for (const next of candidates) {
      let refreshed: PooledAccount;
      try { refreshed = await refreshPooledAccount(next); }
      catch (error) { log.warn('[AccountPool] Standby token refresh failed; trying next candidate', error); continue; }
      const latest = loadPoolConfig();
      if (!latest.accounts.some((account) => account.id === next.id)) continue;
      latest.activeAccountId = next.id;
      savePoolConfig(latest);

      log.info(`[AccountPool] HOT-SWAP: Successfully switched active account to ${next.email}!`);
      try {
        const { BrowserWindow } = require('electron');
        BrowserWindow.getAllWindows().forEach((win: any) => {
          win.webContents?.send('pool:hotswapped', { from: current.email, to: next.email });
        });
      } catch {

      }
      return { nextAccount: refreshed, previousEmail: current.email };
      }
    }
  }

  return { nextAccount: null, previousEmail: current.email };
}

let activeOAuthAbort: AbortController | null = null;


export async function startAddGoogleAccountFlow(openExternal: (url: string) => Promise<unknown>): Promise<PooledAccount> {
  activeOAuthAbort?.abort();
  activeOAuthAbort = new AbortController();

  const account = await loginGoogleAccount(
    {
      clientId: ANTIGRAVITY_CLIENT_ID,
      clientSecret: ANTIGRAVITY_CLIENT_SECRET,
      label: 'Secondary Account',
      signal: activeOAuthAbort.signal,
    },
    openExternal,
  );

  activeOAuthAbort = null;

  const config = loadPoolConfig();
  const email = account.email || 'secondary-account@gmail.com';

  const existingIdx = config.accounts.findIndex((a) => a.email.toLowerCase() === email.toLowerCase());

  let newAccount: PooledAccount;
  if (existingIdx >= 0) {
    newAccount = {
      ...config.accounts[existingIdx],
      refreshToken: account.refreshToken || config.accounts[existingIdx].refreshToken,
      accessToken: account.accessToken,
      expiresAt: account.expiresAt,
      name: account.name || config.accounts[existingIdx].name,
      picture: account.picture || config.accounts[existingIdx].picture,
    };
    config.accounts[existingIdx] = newAccount;
  } else {
    newAccount = {
      id: account.id,
      email,
      name: account.name,
      picture: account.picture,
      label: `Account ${config.accounts.length + 1}`,
      refreshToken: account.refreshToken || '',
      accessToken: account.accessToken,
      expiresAt: account.expiresAt,
      clientId: account.clientId,
      clientSecret: account.clientSecret,
      cooldownUntil: 0,
    };
    config.accounts.push(newAccount);
  }

  savePoolConfig(config);


  void enrichAccountProfile(newAccount.id);
  void fetchAccountQuota(newAccount);

  return newAccount;
}

export function cancelAddGoogleAccountFlow(): void {
  activeOAuthAbort?.abort();
  activeOAuthAbort = null;
}
