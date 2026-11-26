/**
 * Antigravity Multi-Account Pool & Hot-Swap Engine.
 * Manages multiple Google accounts, aggregates quotas/limits, and enables seamless hot-swapping during generation.
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { app } from 'electron';
import log from 'electron-log';

// OAuth credentials are supplied by the environment in public builds.
export const ANTIGRAVITY_CLIENT_ID = process.env.ANTIGRAVITY_OAUTH_CLIENT_ID || '';
export const ANTIGRAVITY_CLIENT_SECRET = process.env.ANTIGRAVITY_OAUTH_CLIENT_SECRET || '';
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
export type UIThemeMode = 'antigravity' | 'antigravity-old' | 'antigravity-flatnew' | 'claude';

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
  combinedRemainingFraction: number; // 0.0 - 1.0
  totalCapacityPercent: number; // e.g. 175% across 2 accounts
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
          activeAccountId: undefined,
          autoHotswap: false,
          combineLimits: false,
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
          accounts: [],
        };
      }
    }
  } catch (err) {
    log.error('[AccountPool] Failed to load config:', err);
  }
  return {
    autoHotswap: false,
    combineLimits: false,
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
    const existing = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
    fs.writeFileSync(tmp, JSON.stringify({ ...existing, ...config, accounts: existing.accounts || [], activeAccountId: existing.activeAccountId, autoHotswap: existing.autoHotswap, combineLimits: existing.combineLimits }, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (err) {
    log.error('[AccountPool] Failed to save config:', err);
    throw err;
  }
}

type CombinedQuotaResult = { summary: CombinedQuotaSummary; aggregatedResponse: Record<string, unknown> };
export async function readNativeWindowsCredential(): Promise<{
  refreshToken?: string;
  accessToken?: string;
  expiry?: string;
  email?: string;
  clientId?: string;
} | null> { throw new Error('Account Pool is unavailable in the GitHub edition'); }
export async function captureActiveNativeSession(): Promise<PooledAccount> { throw new Error('Account Pool is unavailable in the GitHub edition'); }
export async function enrichAccountProfile(accountId: string): Promise<void> { throw new Error('Account Pool is unavailable in the GitHub edition'); }
export function refreshPooledAccount(account: PooledAccount): Promise<PooledAccount> { throw new Error('Account Pool is unavailable in the GitHub edition'); }
export async function fetchAccountQuota(account: PooledAccount, rawHeaders?: http.IncomingHttpHeaders): Promise<PooledAccount['lastQuota']> { throw new Error('Account Pool is unavailable in the GitHub edition'); }
export function fetchCombinedPoolQuota(rawHeaders?: http.IncomingHttpHeaders): Promise<CombinedQuotaResult> { throw new Error('Account Pool is unavailable in the GitHub edition'); }
export function mergeAccountQuotas(
  accounts: PooledAccount[],
  quotaResults: Array<PooledAccount['lastQuota']>,
  configOverride?: Partial<AccountPoolConfig>,
): {
  summary: CombinedQuotaSummary;
  aggregatedResponse: Record<string, unknown>;
} { throw new Error('Account Pool is unavailable in the GitHub edition'); }
export function isClaudeModel(modelName?: string): boolean { throw new Error('Account Pool is unavailable in the GitHub edition'); }
export function isAccountExhaustedForModel(account: PooledAccount, modelName?: string, now = Date.now()): boolean { throw new Error('Account Pool is unavailable in the GitHub edition'); }
export function getAccountQuotaForModel(account: PooledAccount, modelName?: string): number { throw new Error('Account Pool is unavailable in the GitHub edition'); }
export function findBestAvailableAccount(
  modelName?: string,
  excludeAccountIds?: Set<string>,
): PooledAccount | null { throw new Error('Account Pool is unavailable in the GitHub edition'); }
export async function getEffectiveAccountForRequest(modelName?: string): Promise<{
  account: PooledAccount;
  didHotSwap: boolean;
  swappedFrom?: string;
}> { throw new Error('Account Pool is unavailable in the GitHub edition'); }
export async function reportAccountExhaustion(
  accountId: string,
  statusCode: number,
  retryAfterMs?: number,
  modelName?: string,
  excludeAccountIds?: Set<string>,
): Promise<{ nextAccount: PooledAccount | null; previousEmail: string }> { throw new Error('Account Pool is unavailable in the GitHub edition'); }
export async function startAddGoogleAccountFlow(openExternal: (url: string) => Promise<unknown>): Promise<PooledAccount> { throw new Error('Account Pool is unavailable in the GitHub edition'); }
export function cancelAddGoogleAccountFlow(): void { throw new Error('Account Pool is unavailable in the GitHub edition'); }
