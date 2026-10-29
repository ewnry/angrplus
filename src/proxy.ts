

import * as http from 'http';
import * as https from 'https';
import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import log from 'electron-log';



export interface CustomModel {
  name: string;
  displayName: string;
  description: string;
  provider: string;
  apiKey: string;
  apiUrl: string;
  externalModelName: string;
  allowUnauthorized?: boolean;
  encrypted?: boolean;
  _slug?: string;
  timeout?: number;
  maxRetries?: number;
  enabled?: boolean;
  apiFormat?: import('./providers').ApiFormat;
  fallbackModels?: string[];
  reasoningEffort?: 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';
  thinkingBudget?: number;
  maxOutputTokens?: number;
  contextWindow?: number;
  idleTimeout?: number;
  retryBudgetMs?: number;
  circuitBreaker?: import('./proxy/circuitBreaker').CircuitBreakerOptions;
  customHeaders?: Record<string, string>;
  encryptedHeaders?: boolean;
  extraBody?: Record<string, unknown>;
  rawUrl?: boolean;
  gateway?: boolean;
  supportsVision?: boolean;
  supportsThinking?: boolean;
  googleProject?: string;
  googleAccounts?: import('./googleAccounts').GoogleAccount[];
  googlePool?: import('./googleAccounts').GooglePoolOptions;
  encryptedGoogleAccounts?: boolean;
}

interface GeminiRequestBody {
  model?: string;
  modelId?: string;
  model_id?: string;
  sessionId?: string;
  conversationId?: string;
  request?: GeminiRequestBody;
  systemInstruction?: { parts: { text?: string }[] };
  contents?: {
    parts?: { text?: string; functionCall?: unknown; functionResponse?: unknown; thought?: boolean }[];
    role?: string;
  }[];
  tools?: unknown[];
  generationConfig?: {
    temperature?: number;
    maxOutputTokens?: number;
  };
}



import { getMessageRevisionStore, rewriteRevisionHistory } from './messageRevisions';

let server: http.Server | null = null;
let proxyPort = 0;
let startingProxy: Promise<number> | null = null;
let stoppingProxy: Promise<void> | null = null;


import {
  modelToolCallIds,
  modelReasoningContent,
  activeStreamContexts,
  translatedToolCalls,
  stateTimestamps,
  startCleanupInterval,
  stopCleanupInterval,
} from './proxy/shared';


import { detectModelCapabilities } from './proxy/modelUtils';


import { runCustomModelRequest, getProxyMetrics, stopCustomRequests } from './proxy/customRequest';
import { selectGeminiFallback, recordGeminiFallback, resolveFallbackFiles } from './geminiFallback';
import { readModelConfig, writeJsonAtomic } from './modelStore';
import { getRequiredProxyPort, listenProxy } from './proxy/listen';
import {
  guardLoopbackRequest,
  languageServerModelsUrl,
  authenticatedGoogleFileUrl,
} from './proxy/loopbackSecurity';
import { applyPromptEngine } from './promptEngine';

let languageServerPortResolver: (() => number) | null = null;
export function setLanguageServerPortResolver(resolver: () => number): void {
  languageServerPortResolver = resolver;
}
export function getLanguageServerPort(): number | undefined {
  return languageServerPortResolver ? languageServerPortResolver() : undefined;
}

function getAccountPool(): typeof import('./accountPool') | null {
  try {

    return require('./accountPool');
  } catch {
    return null;
  }
}



const cryptoStore = require('./cryptoStore');



function generateModelPlaceholderId(model: CustomModel): string {
  const input = (model.displayName || model.name || 'custom-model').toLowerCase();
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (hash << 5) + hash + input.charCodeAt(i);
    hash = hash & hash;
  }
  const placeholderNum = 400 + (Math.abs(hash) % 200);
  return `MODEL_PLACEHOLDER_M${placeholderNum}`;
}

function getCustomModelsPath(): string {
  const geminiDir = path.join(app.getPath('home'), '.gemini', 'antigravity');
  return path.join(geminiDir, 'custom_models.json');
}

function toSlug(model: CustomModel): string {
  return (
    'custom-' +
    (model.externalModelName || model.name)
      .replace(/^models\//, '')
      .replace(/[^a-zA-Z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .toLowerCase()
  );
}



function loadCustomModels(): CustomModel[] {
  const filePath = getCustomModelsPath();

  const { validateCustomModel } = require('./schemaValidator');

  if (!fs.existsSync(filePath)) {
    const defaultModels = {
      models: [
        {
          name: 'models/gpt-4o',
          displayName: 'GPT-4o (OpenAI via Proxy)',
          description: 'OpenAI GPT-4o model redirected through proxy',
          provider: 'openai',
          apiKey: process.env.OPENAI_API_KEY || 'YOUR_OPENAI_API_KEY',
          apiUrl: 'https://api.openai.com/v1/chat/completions',
          externalModelName: 'gpt-4o',
        },
        {
          name: 'models/claude-3-5-sonnet',
          displayName: 'Claude 3.5 Sonnet (Anthropic via Proxy)',
          description: 'Anthropic Claude 3.5 Sonnet model redirected through proxy',
          provider: 'anthropic',
          apiKey: process.env.ANTHROPIC_API_KEY || 'YOUR_ANTHROPIC_API_KEY',
          apiUrl: 'https://api.anthropic.com/v1/messages',
          externalModelName: 'claude-3-5-sonnet-latest',
        },
        {
          name: 'models/llama3',
          displayName: 'Llama 3 (Local Ollama)',
          description: 'Local Ollama Llama 3 model run on your machine',
          provider: 'ollama',
          apiUrl: 'http://localhost:11434/v1/chat/completions',
          externalModelName: 'llama3',
        },
      ],
    };
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      (defaultModels.models as CustomModel[]).forEach((m) => {
        (m as unknown as Record<string, unknown>).encrypted = false;
      });
      const encrypted = cryptoStore.encryptModels(defaultModels.models);
      fs.writeFileSync(filePath, JSON.stringify({ models: encrypted }, null, 2), 'utf-8');
    } catch (e) {
      log.error('[Proxy] Failed to write default custom_models.json', e);
    }
    return cryptoStore.decryptModels(defaultModels.models);
  }

  try {
    const models = readModelConfig(filePath) as CustomModel[];


    const unprotected = (value: unknown) => typeof value === 'string' && value && value !== 'none' && !/^(enc:|fallback:|local-gcm:)/.test(value);
    const needsMigration = models.some((m) =>
      (!m.encrypted && unprotected(m.apiKey)) ||
      (!m.encryptedHeaders && Object.values(m.customHeaders || {}).some(unprotected)) ||
      (!m.encryptedGoogleAccounts && (m.googleAccounts || []).some((account) => [account.accessToken, account.refreshToken, account.clientSecret].some(unprotected))),
    );
    if (needsMigration) {
      log.info('[Proxy] Plaintext custom_models.json detected. Migrating to encrypted format...');
      cryptoStore.backupFile(filePath);
      const encryptedModels = cryptoStore.encryptModels(models);
      for (const model of encryptedModels) {
        if (model.customHeaders && !model.encryptedHeaders) {
          model.customHeaders = Object.fromEntries(Object.entries(model.customHeaders).map(([name, value]) => [name, unprotected(value) ? cryptoStore.encryptString(value) : value]));
          model.encryptedHeaders = true;
        }
        if (model.googleAccounts && !model.encryptedGoogleAccounts) {
          model.googleAccounts = model.googleAccounts.map((account) => {
            const encrypted = { ...account };
            for (const field of ['accessToken', 'refreshToken', 'clientSecret']) if (unprotected(encrypted[field])) encrypted[field] = cryptoStore.encryptString(encrypted[field]);
            return encrypted;
          });
          model.encryptedGoogleAccounts = true;
        }
      }
      try {
        writeJsonAtomic(filePath, { models: encryptedModels });
        log.info('[Proxy] Successfully migrated custom_models.json to encrypted format.');

      } catch (err) {
        log.error('[Proxy] Failed to write encrypted custom_models.json during migration:', err);
      }
    }

    const decrypted = cryptoStore.decryptModels(models) as CustomModel[];
    for (const model of decrypted) {
      if (/^(DECRYPTION_FAILED|enc:|fallback:|local-gcm:)/.test(model.apiKey || '')) {
        model.enabled = false;
        log.warn('[Proxy] Skipping a model whose API key could not be decrypted');
        continue;
      }
      if (model.googleAccounts) {
        model.googleAccounts = model.googleAccounts.flatMap((account) => {
          const decryptedAccount = { ...account };
          for (const field of ['accessToken', 'refreshToken', 'clientSecret'] as const) {
            const value = decryptedAccount[field];
            if (!value) continue;
            if (model.encryptedGoogleAccounts) decryptedAccount[field] = cryptoStore.decryptString(value);
            if (/^(DECRYPTION_FAILED|enc:|fallback:|local-gcm:)/.test(decryptedAccount[field] || '')) {
              log.warn('[Proxy] Skipping a Google account whose credentials could not be decrypted');
              return [];
            }
          }
          return [decryptedAccount];
        });
        model.encryptedGoogleAccounts = false;
      }
      if (model.encryptedHeaders && model.customHeaders) {
        model.customHeaders = Object.fromEntries(Object.entries(model.customHeaders).map(([key, value]) => {
          const decryptedHeader = cryptoStore.decryptString(value);
          if (/^(DECRYPTION_FAILED|enc:|fallback:|local-gcm:)/.test(decryptedHeader || '')) {
            model.enabled = false;
            log.warn('[Proxy] Skipping a model whose custom header could not be decrypted');
          }
          return [key, decryptedHeader];
        }));
        model.encryptedHeaders = false;
      }
    }


    const validModels: CustomModel[] = [];
    for (let i = 0; i < decrypted.length; i++) {
      const validation = validateCustomModel(decrypted[i]) as { valid: boolean; error?: string };
      if (validation.valid) {
        if (decrypted[i].enabled !== false) validModels.push(decrypted[i]);
      } else {
        log.warn(`[Proxy] Skipping invalid model at index ${i}: ${validation.error}`);
      }
    }
    if (validModels.length < decrypted.length) {
      log.info(
        `[Proxy] Loaded ${validModels.length}/${decrypted.length} valid models (${decrypted.length - validModels.length} skipped)`,
      );
    }

    return validModels;
  } catch (e) {
    log.error('[Proxy] Failed to parse custom_models.json', e);
    return [];
  }
}

let activeGenerations = 0;
let generationSettleTimer: NodeJS.Timeout | null = null;

export function recordGenerationStart(): void {
  activeGenerations++;
  if (generationSettleTimer) {
    clearTimeout(generationSettleTimer);
    generationSettleTimer = null;
  }
}

export function recordGenerationEnd(info: { hasText: boolean; hasFunctionCall: boolean; wasAborted: boolean }): void {
  activeGenerations = Math.max(0, activeGenerations - 1);


  if (info.wasAborted) {
    log.info('[Proxy] Generation was aborted or client closed; suppressing completion chime.');
    return;
  }


  if (info.hasFunctionCall) {
    log.info('[Proxy] Generation contained functionCall (intermediate tool step); suppressing completion chime.');
    return;
  }


  if (!info.hasText) {
    return;
  }


  if (activeGenerations > 0) {
    return;
  }


  if (generationSettleTimer) clearTimeout(generationSettleTimer);
  generationSettleTimer = setTimeout(() => {
    generationSettleTimer = null;
    if (activeGenerations > 0) return;
    log.info('[Proxy] Agent response completely finished with text and no tool calls. Broadcasting completion event.');
    notifyGenerationComplete();
  }, 1200);
}

let lastCompletionNotify = 0;
export function notifyGenerationComplete(): void {
  const now = Date.now();
  if (now - lastCompletionNotify < 2500) return;
  lastCompletionNotify = now;

  try {
    const electron = require('electron');
    const wins = electron.BrowserWindow?.getAllWindows?.() || [];
    for (const win of wins) {
      if (!win.isDestroyed?.()) {
        win.webContents?.send?.('agent:generation-complete');
      }
    }
  } catch {

  }
}


export function isGoogleQuotaError(status: number, body: string): boolean {
  return status === 429 || (status === 403 && /RESOURCE_EXHAUSTED|quota.?exceed|rate.?limit/i.test(body));
}



async function proxyToGoogle(req: http.IncomingMessage, res: http.ServerResponse, reqBody: Buffer): Promise<void> {
  const isCloudCodeUrl = req.url!.includes('v1internal') || req.url!.includes('daily-cloudcode');
  const targetUrl = isCloudCodeUrl
    ? 'https://daily-cloudcode-pa.googleapis.com'
    : 'https://generativelanguage.googleapis.com';
  const parsedUrl = new URL(req.url!, targetUrl);

  const baseHeaders: Record<string, string | string[] | undefined> = {
    ...(req.headers as Record<string, string | string[] | undefined>),
  };
  baseHeaders['host'] = isCloudCodeUrl ? 'daily-cloudcode-pa.googleapis.com' : 'generativelanguage.googleapis.com';
  delete baseHeaders['connection'];
  delete baseHeaders['keep-alive'];

  const isGeneration = req.url!.includes('generateContent') || req.url!.includes('streamGenerateContent');
  const shouldBufferAndModify = isCloudCodeUrl && !isGeneration;

  if (shouldBufferAndModify) {
    delete baseHeaders['accept-encoding'];
  }


  let requestedModelName: string | undefined;
  try {
    if (reqBody && reqBody.length > 0) {
      const parsed = JSON.parse(reqBody.toString('utf8'));
      requestedModelName = parsed.model || parsed.modelId || parsed.model_id || parsed.request?.model || parsed.request?.modelId;
    }
  } catch {

  }
  if (!requestedModelName && req.url) {
    const urlMatch = req.url.match(/models\/([^:]+)/);
    if (urlMatch) requestedModelName = urlMatch[1];
  }


  const accountPool = getAccountPool();
  const poolCfg = accountPool ? accountPool.loadPoolConfig() : null;
  let poolAccount: import('./accountPool').PooledAccount | null = null;
  if (isCloudCodeUrl && accountPool && poolCfg && poolCfg.accounts.length > 0) {
    try {
      const selection = await accountPool.getEffectiveAccountForRequest(requestedModelName);
      poolAccount = selection.account;
      if (selection.didHotSwap) {
        log.info(`[Proxy] Account pool routed to ${poolAccount.email} for ${requestedModelName || 'default'} (swapped from ${selection.swappedFrom})`);
      }
    } catch (e) {
      log.warn('[Proxy] Failed to get effective pool account:', e);
    }
  }

  let effectiveReqBody = reqBody;
  if (isGeneration && poolCfg && poolCfg.promptEngineMode && poolCfg.promptEngineMode !== 'antigravity') {
    try {
      const parsedBody = JSON.parse(reqBody.toString('utf8'));
      const targetPayload = ((parsedBody as any).request || parsedBody) as GeminiRequestBody;
      applyPromptEngine(targetPayload, poolCfg.promptEngineMode, poolCfg.customPromptText);
      effectiveReqBody = Buffer.from(JSON.stringify(parsedBody), 'utf8');
      baseHeaders['content-length'] = String(effectiveReqBody.length);
    } catch (err) {
      log.warn('[Proxy] Failed to apply prompt engine to Google generation request:', err);
    }
  }

  const MAX_HOTSWAP_ATTEMPTS = Math.max(3, poolCfg ? poolCfg.accounts.length : 1);
  let attempt = 0;
  const triedAccountIds = new Set<string>();
  const fallbackModel = isCloudCodeUrl && isGeneration && poolCfg?.geminiFallbackModel
    ? selectGeminiFallback(loadCustomModels(), poolCfg.geminiFallbackModel, requestedModelName) : undefined;
  let fallbackStarted = false;
  async function tryByokFallback(): Promise<boolean> {
    if (!fallbackModel || fallbackStarted || res.headersSent || res.destroyed || res.writableEnded) return false;
    const parsed = JSON.parse(effectiveReqBody.toString('utf8'));
    const payload = parsed.request || parsed;
    if (!Array.isArray(payload.contents) || !payload.contents.length) return false;
    const fileHeaders = { ...baseHeaders };
    if (poolAccount?.accessToken) fileHeaders.authorization = `Bearer ${poolAccount.accessToken}`;
    await resolveFallbackFiles(payload, String(fileHeaders.authorization || fileHeaders.Authorization || ''));
    if (res.headersSent || res.destroyed || res.writableEnded) return false;
    fallbackStarted = true;
    recordGeminiFallback();
    try {
      const wins = require('electron').BrowserWindow?.getAllWindows?.() || [];
      for (const win of wins) win.webContents?.send('pool:byok-fallback', { model: fallbackModel.displayName || fallbackModel.externalModelName });
    } catch {}
    await runCustomModelRequest(res, fallbackModel, payload, req.url!.includes('streamGenerateContent'), [fallbackModel], true);
    return true;
  }

  function doRequest(targetAcc: import('./accountPool').PooledAccount | null): void {
    if (res.destroyed || res.writableEnded) return;
    attempt++;
    if (targetAcc) triedAccountIds.add(targetAcc.id);

    const headers: Record<string, string | string[] | undefined> = { ...baseHeaders };
    if (targetAcc && targetAcc.accessToken) {
      headers['authorization'] = `Bearer ${targetAcc.accessToken}`;
      delete headers['Authorization'];
    }

    const options: https.RequestOptions = {
      method: req.method,
      headers: headers as Record<string, string>,
    };

    const streamTimeoutMs = isGeneration ? 120_000 : 60_000;

    const proxyReq = https.request(parsedUrl, options, (proxyRes) => {
      const resetStreamTimeout = () => { if (!proxyReq.destroyed) proxyReq.setTimeout(streamTimeoutMs); };
      resetStreamTimeout();


      const effectiveTargetAcc = targetAcc || (poolCfg ? (poolCfg.accounts.find((a) => a.id === poolCfg.activeAccountId) || poolCfg.accounts[0]) : null);
      const canRotate = !!(effectiveTargetAcc && accountPool && poolCfg?.autoHotswap && poolCfg.accounts.length > 1 && attempt < MAX_HOTSWAP_ATTEMPTS);
      if (isGeneration && (canRotate || fallbackModel) &&
        (proxyRes.statusCode === 429 || proxyRes.statusCode === 403)) {
        const chunks: Buffer[] = [];
        let bytes = 0;
        proxyRes.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes <= 1024 * 1024) chunks.push(Buffer.from(chunk));
        });
        const forwardError = () => {
          if (res.headersSent || res.destroyed || res.writableEnded) return;
          const body = bytes <= 1024 * 1024 ? Buffer.concat(chunks) : Buffer.from('{"error":{"message":"Google API rejected the request"}}');
          const headers = { ...proxyRes.headers, 'content-length': String(body.length) };
          if (bytes > 1024 * 1024) { delete headers['content-encoding']; headers['content-type'] = 'application/json'; }
          res.writeHead(proxyRes.statusCode || 502, headers);
          res.end(body);
        };
        proxyRes.on('error', () => { proxyReq.setTimeout(0); forwardError(); });
        proxyRes.on('end', async () => {
          proxyReq.setTimeout(0);
          if (res.destroyed || res.writableEnded) return;
          let errorText = Buffer.concat(chunks).toString('utf8');
          if (proxyRes.headers['content-encoding'] === 'gzip') {
            try { errorText = require('zlib').gunzipSync(Buffer.concat(chunks)).toString('utf8'); } catch {}
          }
          if (!isGoogleQuotaError(proxyRes.statusCode || 0, errorText)) { forwardError(); return; }
          const retryAfter = String(proxyRes.headers['retry-after'] || '');
          const retryAfterMs = /^\d+(?:\.\d+)?$/.test(retryAfter) ? Number(retryAfter) * 1000 :
            Math.max(0, Date.parse(retryAfter) - Date.now()) || undefined;
          try {
            const { nextAccount } = effectiveTargetAcc && accountPool
              ? await accountPool.reportAccountExhaustion(effectiveTargetAcc.id, proxyRes.statusCode!, retryAfterMs, requestedModelName, triedAccountIds)
              : { nextAccount: null };
            if (res.destroyed || res.writableEnded) return;
            if (canRotate && nextAccount && !triedAccountIds.has(nextAccount.id)) doRequest(nextAccount);
            else if (!await tryByokFallback()) forwardError();
          } catch (error) { log.error('[Proxy] Hot-swap failed:', error); forwardError(); }
        });
        return;
      }

      if (shouldBufferAndModify) {
        proxyRes.on('end', () => proxyReq.setTimeout(0));
        proxyRes.on('error', () => proxyReq.setTimeout(0));
        const responseChunks: Buffer[] = [];
        proxyRes.on('data', (chunk) => responseChunks.push(chunk));
        proxyRes.on('end', () => {
          const fullResBody = Buffer.concat(responseChunks);
          let text: string;
          const encoding = proxyRes.headers['content-encoding'];
          if (encoding === 'gzip') {
            try {
              const zlib = require('zlib');
              text = zlib.gunzipSync(fullResBody).toString('utf-8');
            } catch (e) {
              log.error('[Proxy] gunzipSync failed:', e);
              text = fullResBody.toString('utf-8');
            }
          } else {
            text = fullResBody.toString('utf-8');
          }

          log.info(
            `[Proxy] Response for ${req.url} (status: ${proxyRes.statusCode}, encoding: ${encoding}, length: ${text.length})`,
          );

          const proxyHost = req.headers.host || 'localhost';
          text = text.replace(/https:(\/\/)daily-cloudcode-pa\.googleapis\.com/g, `http:$1${proxyHost}`);
          text = text.replace(/https:(\/\/)cloudcode-pa\.googleapis\.com/g, `http:$1${proxyHost}`);
          text = text.replace(/https:(\/\/)generativelanguage\.googleapis\.com/g, `http:$1${proxyHost}`);

          const modifiedHeaders: Record<string, string | string[] | undefined> = { ...proxyRes.headers };
          delete modifiedHeaders['content-encoding'];

          const modifiedBuffer = Buffer.from(text, 'utf-8');
          modifiedHeaders['content-length'] = String(modifiedBuffer.length);

          res.writeHead(proxyRes.statusCode || 200, modifiedHeaders as Record<string, string>);
          res.end(modifiedBuffer);
        });
      } else {
        res.writeHead(proxyRes.statusCode || 200, proxyRes.headers as Record<string, string>);
        if (isGeneration && req.method === 'POST') {
          recordGenerationStart();
          let hasText = false;
          let hasFunctionCall = false;
          let wasAborted = false;

          req.on('aborted', () => {
            wasAborted = true;
          });
          req.on('close', () => {
            if (!res.writableEnded) wasAborted = true;
          });

          proxyRes.on('data', (chunk: Buffer) => {
            resetStreamTimeout();
            try {
              const str = chunk.toString('utf-8');
              if (
                str.includes('"functionCall"') ||
                str.includes('"function_call"') ||
                str.includes('"toolCall"') ||
                str.includes('"tool_calls"')
              ) {
                hasFunctionCall = true;
              }
              if (str.includes('"text"')) {
                hasText = true;
              }
            } catch {

            }
          });

          proxyRes.on('end', () => {
            proxyReq.setTimeout(0);
            recordGenerationEnd({
              hasText,
              hasFunctionCall,
              wasAborted: wasAborted || (proxyRes.statusCode ? proxyRes.statusCode >= 400 : false),
            });
          });

          proxyRes.on('error', () => {
            proxyReq.setTimeout(0);
            recordGenerationEnd({ hasText, hasFunctionCall, wasAborted: true });
          });
        }
        proxyRes.pipe(res);
      }
    });

    proxyReq.setTimeout(streamTimeoutMs, () => {
      if (proxyReq.destroyed) return;
      log.error(`[Proxy] Google proxy request timed out after ${streamTimeoutMs / 1000}s`);
      proxyReq.destroy();
      if (!res.headersSent) { res.writeHead(504, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: 'Google API request timed out' } })); }
      else if (!res.writableEnded) res.destroy();
    });
    res.once('close', () => { if (!res.writableEnded) proxyReq.destroy(); });

    proxyReq.on('error', (err) => {
      proxyReq.setTimeout(0);
      log.error('[Proxy] Google Forwarding Error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Proxy forwarding failed: ' + err.message } }));
      }
    });

    if (effectiveReqBody && effectiveReqBody.length > 0) {
      proxyReq.write(effectiveReqBody);
    }
    proxyReq.end();
  }

  doRequest(poolAccount);
}



async function resolveFileData(body: GeminiRequestBody, reqHeaders: Record<string, string | string[] | undefined>): Promise<void> {
  const contents = body.contents;
  if (!contents) return;
  const authHeader = (reqHeaders['authorization'] || reqHeaders['Authorization'] || '') as string;
  for (const item of contents) {
    if (!item.parts) continue;
    for (let i = 0; i < item.parts.length; i++) {
      const p = item.parts[i] as Record<string, unknown>;
      const fd = p.fileData as { mimeType?: string; fileUri?: string } | undefined;
      if (!fd?.fileUri) continue;
      try {
        const uri = fd.fileUri; let fileContent = '';
        if (uri.startsWith('file://')) {
          const fp = uri.replace('file://', '').replace(/\//g, path.sep);
          if (fs.existsSync(fp)) fileContent = fs.readFileSync(fp, 'utf-8');
        } else if (authHeader && uri.startsWith('https://')) {
          const validGoogleUrl = authenticatedGoogleFileUrl(uri);
          if (validGoogleUrl) {
            fileContent = await downloadFileContent(validGoogleUrl.href, authHeader);
          }
        }
        if (fileContent) {
          (item.parts[i] as Record<string, unknown>) = { text: '[File content]:\n\n' + fileContent };
        }
      } catch (e) { log.warn('[Proxy] File resolve failed:', (e as Error).message); }
    }
  }
}

function downloadFileContent(url: string, authHeader: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    (u.protocol === 'https:' ? https : http).request({
      hostname: u.hostname, path: u.pathname + u.search,
      method: 'GET', headers: { 'Authorization': authHeader }, timeout: 30000,
    }, (res) => {
      if (res.statusCode !== 200) { reject(new Error('HTTP ' + res.statusCode)); return; }
      let d = ''; res.on('data', (c: Buffer) => d += c.toString()); res.on('end', () => resolve(d));
    }).on('error', reject).end();
  });
}



function handleCustomModelRequest(res: http.ServerResponse, model: CustomModel, body: GeminiRequestBody, isStream: boolean, cloudEnvelope = true): void {
  void runCustomModelRequest(res, model, body as import('./proxy/requestOptions').GeminiBody, isStream, loadCustomModels(), cloudEnvelope);
}



interface ProtoField {
  tag: number;
  wireType: number;
  fieldNum: number;
  value: number | Buffer | ProtoField[];
  start: number;
  end: number;
}

function readVarint(buf: Buffer, offset: number): { value: number; bytes: number } {
  let result = 0;
  let shift = 0;
  let bytes = 0;
  while (offset + bytes < buf.length) {
    const byte = buf[offset + bytes];
    result |= (byte & 0x7f) << shift;
    bytes++;
    if (!(byte & 0x80)) break;
    shift += 7;
  }
  return { value: result >>> 0, bytes };
}

function encodeVarint(value: number): Buffer {
  const parts: number[] = [];
  let v = value >>> 0;
  do {
    let b = v & 0x7f;
    v >>>= 7;
    if (v !== 0) b |= 0x80;
    parts.push(b);
  } while (v !== 0);
  return Buffer.from(parts);
}

function parseProto(buf: Buffer, offset: number, end: number): ProtoField[] {
  const fields: ProtoField[] = [];
  let pos = offset;
  while (pos < end) {
    const start = pos;
    const tagVarint = readVarint(buf, pos);
    const tag = tagVarint.value;
    const wireType = tag & 0x07;
    const fieldNum = tag >>> 3;
    pos += tagVarint.bytes;

    if (wireType === 0) {
      const v = readVarint(buf, pos);
      fields.push({ tag, wireType, fieldNum, value: v.value, start, end: pos + v.bytes });
      pos += v.bytes;
    } else if (wireType === 2) {
      const lenVarint = readVarint(buf, pos);
      pos += lenVarint.bytes;
      const len = lenVarint.value;
      const children = parseProto(buf, pos, pos + len);
      const hasChildren = children.length > 0;
      fields.push({ tag, wireType, fieldNum, value: hasChildren ? children : buf.subarray(pos, pos + len), start, end: pos + len });
      pos += len;
    } else if (wireType === 1) {
      fields.push({ tag, wireType, fieldNum, value: buf.subarray(pos, pos + 8), start, end: pos + 8 });
      pos += 8;
    } else if (wireType === 5) {
      fields.push({ tag, wireType, fieldNum, value: buf.subarray(pos, pos + 4), start, end: pos + 4 });
      pos += 4;
    } else {
      break;
    }
  }
  return fields;
}

function encodeProtoBuf(fields: { tag: number; value: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const field of fields) {
    const tagBuf = encodeVarint(field.tag);
    const data = field.value;
    const lenBuf = encodeVarint(data.length);
    parts.push(tagBuf, lenBuf, data);
  }
  return Buffer.concat(parts);
}

function findModelEntryFieldTag(fields: ProtoField[]): number | null {
  const tagCounts = new Map<number, number>();
  for (const f of fields) {
    if (f.wireType === 2) {
      tagCounts.set(f.tag, (tagCounts.get(f.tag) || 0) + 1);
    }
  }
  let bestTag: number | null = null;
  let bestCount = 0;
  for (const [tag, count] of tagCounts) {
    if (count > bestCount) {
      bestCount = count;
      bestTag = tag;
    }
  }
  if (bestTag !== null && bestCount >= 2) {

    const sample = fields.find((f) => f.tag === bestTag && Array.isArray(f.value));
    if (sample) return bestTag;
  }
  return bestTag;
}

function extractFieldMapping(entry: ProtoField[]): Map<number, 'string' | 'varint' | 'bytes'> {
  const mapping = new Map<number, 'string' | 'varint' | 'bytes'>();
  for (const f of entry) {
    if (f.wireType === 2 && Buffer.isBuffer(f.value)) {
      mapping.set(f.fieldNum, 'string');
    } else if (f.wireType === 0) {
      mapping.set(f.fieldNum, 'varint');
    } else if (f.wireType === 2 && Array.isArray(f.value)) {
      mapping.set(f.fieldNum, 'bytes');
    }
  }
  return mapping;
}

function encodeModelEntryForGetModels(
  name: string,
  displayName: string,
  mapping: Map<number, 'string' | 'varint' | 'bytes'>,
): Buffer {
  const fields: { tag: number; value: Buffer }[] = [];
  for (const [fieldNum, protoType] of mapping) {
    if (protoType === 'string') {
      const tag = (fieldNum << 3) | 2;
      if (fieldNum === 1) {
        fields.push({ tag, value: Buffer.from(name, 'utf-8') });
      } else if (fieldNum === 2) {
        fields.push({ tag, value: Buffer.from(displayName, 'utf-8') });
      } else {
        fields.push({ tag, value: Buffer.alloc(0) });
      }
    } else if (protoType === 'varint') {
      const tag = (fieldNum << 3) | 0;
      fields.push({ tag, value: encodeVarint(0) });
    } else {
      const tag = (fieldNum << 3) | 2;
      fields.push({ tag, value: Buffer.alloc(0) });
    }
  }
  return encodeProtoBuf(fields);
}



function handleGetAvailableModelsProxy(
  res: http.ServerResponse,
  reqBody: Buffer,
  lsUrl: string,
): void {
  const verifiedUrl = languageServerModelsUrl(lsUrl, getLanguageServerPort());
  let lsParsed: URL;
  if (verifiedUrl) {
    lsParsed = verifiedUrl;
  } else {
    try {
      lsParsed = new URL(lsUrl);
      if (!['http:', 'https:'].includes(lsParsed.protocol)) throw new Error('Invalid protocol');
    } catch {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Invalid language server URL' } }));
      return;
    }
  }
  const client = lsParsed.protocol === 'https:' ? https : http;

  const options: https.RequestOptions = {
    method: 'POST',
    hostname: lsParsed.hostname,
    port: lsParsed.port || (lsParsed.protocol === 'https:' ? '443' : '80'),
    path: lsParsed.pathname + lsParsed.search,
    headers: {
      'Content-Type': 'application/grpc-web+proto',
      'Accept': 'application/grpc-web+proto',
      'Content-Length': String(reqBody.length),
    },
    rejectUnauthorized: false,
  };

  const lsReq = client.request(options, (lsRes) => {
    const chunks: Buffer[] = [];
    lsRes.on('data', (chunk: Buffer) => chunks.push(chunk));
    lsRes.on('end', () => {
      const responseBuf = Buffer.concat(chunks);
      const customModels = loadCustomModels();
      let modifiedBuf = responseBuf;

      if (customModels.length > 0 && responseBuf.length > 6) {
        try {
          const flags = responseBuf[0];
          const msgLen = responseBuf.readUInt32BE(1);
          if (5 + msgLen <= responseBuf.length) {
            const msgBody = responseBuf.subarray(5, 5 + msgLen);
            const parsed = parseProto(msgBody, 0, msgBody.length);
            const modelTag = findModelEntryFieldTag(parsed);

            if (modelTag !== null) {
              const sampleEntry = parsed.find(
                (f) => f.tag === modelTag && Array.isArray(f.value),
              );
              if (sampleEntry && Array.isArray(sampleEntry.value)) {
                const fieldMapping = extractFieldMapping(sampleEntry.value);
                const newParts: Buffer[] = [msgBody];

                for (const m of customModels) {
                  const placeholderId = generateModelPlaceholderId(m);
                  const entry = encodeModelEntryForGetModels(
                    'models/' + placeholderId,
                    m.displayName,
                    fieldMapping,
                  );
                  const tagBuf = encodeVarint(modelTag);
                  const lenBuf = encodeVarint(entry.length);
                  newParts.push(tagBuf, lenBuf, entry);
                  log.info(
                    `[Proxy] Injected into GetAvailableModels: ${m.displayName} => ${placeholderId}`,
                  );
                }

                const newMsgBody = Buffer.concat(newParts);
                const newHeader = Buffer.alloc(5);
                newHeader[0] = flags;
                newHeader.writeUInt32BE(newMsgBody.length, 1);
                modifiedBuf = Buffer.concat([newHeader, newMsgBody]);
              }
            }
          }
        } catch (err) {
          log.error('[Proxy] Failed to inject models into GetAvailableModels:', err);
        }
      }

      res.writeHead(lsRes.statusCode || 200, {
        'Content-Type': 'application/grpc-web+proto',
        'Content-Length': String(modifiedBuf.length),
      });
      res.end(modifiedBuf);
    });

    lsRes.on('error', (err) => {
      log.error('[Proxy] LS error for GetAvailableModels:', err.message);
      if (!res.headersSent) {
        res.writeHead(502);
        res.end();
      }
    });
  });

  lsReq.setTimeout(30_000, () => {
    log.error('[Proxy] GetAvailableModels forward timed out');
    lsReq.destroy();
    if (!res.headersSent) {
      res.writeHead(504);
      res.end();
    }
  });

  lsReq.on('error', (err) => {
    log.error('[Proxy] GetAvailableModels forward error:', err.message);
    if (!res.headersSent) {
      res.writeHead(502);
      res.end();
    }
  });

  lsReq.write(reqBody);
  lsReq.end();
}



function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!guardLoopbackRequest(req, res, getLanguageServerPort())) {
    return;
  }
  let requestUrl: URL;
  try {
    req.url = (req.url || '/').replace(/^.*\/dummy_path_padding/, '');

    req.url = req.url.replace(/\/v1internal\/x{7}/, '');

    if (!req.url.startsWith('/') || /^[\\/]{2}/.test(req.url)) throw new Error('Invalid target');
    requestUrl = new URL(req.url, 'http://localhost');
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Invalid request target' } }));
    return;
  }


  if (req.method === 'GET' && (req.url === '/health' || req.url === '/healthz')) {
    const memUsage = process.memoryUsage();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        status: 'ok',
        uptime: process.uptime(),
        port: proxyPort,
        memory: {
          rssMB: Math.round(memUsage.rss / 1024 / 1024),
          heapUsedMB: Math.round(memUsage.heapUsed / 1024 / 1024),
          heapTotalMB: Math.round(memUsage.heapTotal / 1024 / 1024),
        },
        state: {
          activeStreamContexts: activeStreamContexts.size,
          modelToolCallIds: modelToolCallIds.size,
          translatedToolCalls: translatedToolCalls.size,
          modelReasoningContent: modelReasoningContent.size,
        },
        timestamp: new Date().toISOString(),
      }),
    );
    return;
  }

  if (req.method === 'GET' && requestUrl.pathname === '/metrics') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(getProxyMetrics()));
    return;
  }


  const MAX_BODY_SIZE = 10 * 1024 * 1024;
  let bodyLength = 0;
  let bodyRejected = false;

  const bodyChunks: Buffer[] = [];
  req.on('data', (chunk) => {
    bodyLength += chunk.length;
    if (bodyLength > MAX_BODY_SIZE) {
      if (!bodyRejected) {
        bodyRejected = true;
        log.warn(`[Proxy] Request body exceeds ${MAX_BODY_SIZE / 1024 / 1024}MB limit (${req.method} ${req.url})`);
        req.destroy();
        if (!res.headersSent) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({ error: { message: `Request body too large. Maximum: ${MAX_BODY_SIZE / 1024 / 1024}MB` } }),
          );
        }
      }
      return;
    }
    bodyChunks.push(chunk);
  });
  req.on('end', () => {
    if (bodyRejected) return;

    let fullBody = Buffer.concat(bodyChunks);
    let bodyStr = fullBody.toString('utf-8');
    if (/generateContent/i.test(req.url || '') && bodyStr.includes('AGY_REVISION:')) {
      try {
        const envelope = JSON.parse(bodyStr);
        if (rewriteRevisionHistory(envelope, getMessageRevisionStore().list())) {
          bodyStr = JSON.stringify(envelope); fullBody = Buffer.from(bodyStr, 'utf8');
          req.headers['content-length'] = String(fullBody.length); delete req.headers['transfer-encoding'];
        }
      } catch (error) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: error instanceof Error ? error.message : 'Message edit failed' } })); return;
      }
    }



    log.info(`[Proxy] Request: ${req.method} ${req.url}`);


    if (req.url!.startsWith('/GetAvailableModels')) {
      const gavParsed = new URL(req.url!, 'http://127.0.0.1');
      const lsUrl = gavParsed.searchParams.get('ls');
      if (lsUrl) {
        handleGetAvailableModelsProxy(res, fullBody, lsUrl);
        return;
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing ls parameter' }));
      return;
    }


    if (req.url!.includes('/v1internal:retrieveUserQuotaSummary')) {
      const accountPool = getAccountPool();
      const config = accountPool ? accountPool.loadPoolConfig() : null;
      if (accountPool && config && config.accounts.length > 0 && config.combineLimits) {
        log.info(`[Proxy] Intercepting retrieveUserQuotaSummary to return combined pool quota (${config.accounts.length} accounts)`);
        accountPool.fetchCombinedPoolQuota(req.headers)
          .then(({ aggregatedResponse }: any) => {
            const respBuf = Buffer.from(JSON.stringify(aggregatedResponse), 'utf-8');
            res.writeHead(200, {
              'Content-Type': 'application/json',
              'Content-Length': String(respBuf.length),
            });
            res.end(respBuf);
          })
          .catch((err: any) => {
            log.error('[Proxy] Failed to aggregate pool quota, falling back to Google:', err);
            void proxyToGoogle(req, res, fullBody);
          });
        return;
      }
    }


    if (req.url!.includes('/v1internal:fetchAvailableModels')) {
      log.info('[Proxy] Intercepting fetchAvailableModels request');

      const targetUrl = 'https://daily-cloudcode-pa.googleapis.com';
      const parsedUrl = new URL(req.url!, targetUrl);
      const fwdHeaders: Record<string, string | string[] | undefined> = {
        ...(req.headers as Record<string, string | string[] | undefined>),
      };
      fwdHeaders['host'] = 'daily-cloudcode-pa.googleapis.com';
      delete fwdHeaders['connection'];
      delete fwdHeaders['keep-alive'];
      delete fwdHeaders['accept-encoding'];

      const fwdOptions: https.RequestOptions = {
        method: req.method,
        headers: fwdHeaders as Record<string, string>,
      };

      const googleReq = https.request(parsedUrl, fwdOptions, (googleRes) => {

        googleReq.setTimeout(30_000, () => {
          log.error('[Proxy] fetchAvailableModels forward request timed out');
          googleReq.destroy();
          if (!res.headersSent) {
            const customModels = loadCustomModels();
            const mappedCustom: Record<string, unknown> = {};
            customModels.forEach((m) => {
              const slug = toSlug(m);
              mappedCustom[slug] = {
                displayName: m.displayName,
                maxTokens: detectModelCapabilities(m).maxTokens,
                maxOutputTokens: detectModelCapabilities(m).maxOutputTokens,
                model: generateModelPlaceholderId(m),
                apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                modelProvider: 'MODEL_PROVIDER_GOOGLE',
              };
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: mappedCustom }));
          }
        });

        let googleBody = '';
        googleRes.on('data', (chunk) => (googleBody += chunk));
        googleRes.on('end', () => {
          try {
            log.info(
              `[Proxy] fetchAvailableModels response status: ${googleRes.statusCode}, body length: ${googleBody.length}`,
            );

            const googleJson = JSON.parse(googleBody) as Record<string, unknown>;
            const customModels = loadCustomModels();

            log.info(`[Proxy] Loaded custom models count: ${customModels.length}`);

            const mergeModels = (target: unknown): unknown => {
              if (Array.isArray(target)) {
                const mapped = customModels.map((m) => {
                  const cap = detectModelCapabilities(m, true);
                  return {
                    name: 'models/' + generateModelPlaceholderId(m),
                    version: '1.0',
                    displayName: m.displayName,
                    description: m.description,
                    inputTokenLimit: cap.maxTokens,
                    outputTokenLimit: cap.maxOutputTokens,
                    supportedGenerationMethods: ['generateContent', 'countTokens'],
                    temperature: cap.isThinking ? undefined : 0.7,
                    topP: cap.isThinking ? undefined : 0.9,
                    topK: cap.isThinking ? undefined : 40,
                  };
                });
                return [...mapped, ...target];
              } else if (target && typeof target === 'object') {
                const result = { ...(target as Record<string, unknown>) };
                customModels.forEach((m) => {
                  const slug = toSlug(m);
                  const cap = detectModelCapabilities(m, true);
                  const entry: Record<string, unknown> = {
                    displayName: m.displayName,
                    supportsImages: cap.supportsImages,
                    supportsThinking: cap.isThinking,
                    recommended: true,
                    maxTokens: cap.maxTokens,
                    maxOutputTokens: cap.maxOutputTokens,
                    tokenizerType: 'LLAMA_WITH_SPECIAL',
                    model: generateModelPlaceholderId(m),
                    apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                    modelProvider: 'MODEL_PROVIDER_GOOGLE',
                  };
                  if (cap.supportsImages) {
                    entry.supportsVideo = false;
                    entry.supportedMimeTypes = {
                      'image/png': true,
                      'image/jpeg': true,
                      'image/webp': true,
                      'image/gif': true,
                      'image/heic': true,
                      'image/heif': true,
                      'text/plain': true,
                      'text/markdown': true,
                      'text/html': true,
                      'text/css': true,
                      'text/xml': true,
                      'text/csv': true,
                      'application/json': true,
                      'application/pdf': true,
                      'application/x-javascript': true,
                      'application/x-typescript': true,
                      'application/x-python-code': true,
                      'application/x-ipynb+json': true,
                    };
                  } else {
                    entry.supportsVideo = false;
                    entry.supportedMimeTypes = {
                      'text/plain': true,
                      'text/markdown': true,
                      'text/html': true,
                      'text/css': true,
                      'text/xml': true,
                      'text/csv': true,
                      'application/json': true,
                      'application/pdf': true,
                      'application/x-javascript': true,
                      'application/x-typescript': true,
                      'application/x-python-code': true,
                      'application/x-ipynb+json': true,
                    };
                  }
                  (result as Record<string, unknown>)[slug] = entry;
                  m._slug = slug;
                  log.info(
                    `[Proxy] Custom model "${m.displayName}" => slug: ${slug} => model: ${generateModelPlaceholderId(m)} => thinking: ${cap.isThinking} => images: ${cap.supportsImages}`,
                  );
                });
                return result;
              }
              return target;
            };

            let merged = false;
            if (googleJson.models) {
              googleJson.models = mergeModels(googleJson.models);
              merged = true;
            }
            if (googleJson.availableModels) {
              googleJson.availableModels = mergeModels(googleJson.availableModels);
              merged = true;
            }
            if (googleJson.available_models) {
              googleJson.available_models = mergeModels(googleJson.available_models);
              merged = true;
            }

            if (!merged) {
              const modelsMap: Record<string, unknown> = {};
              customModels.forEach((m) => {
                const slug = toSlug(m);
                modelsMap[slug] = {
                  displayName: m.displayName,
                  recommended: true,
                  maxTokens: detectModelCapabilities(m).maxTokens,
                  maxOutputTokens: detectModelCapabilities(m).maxOutputTokens,
                  tokenizerType: 'LLAMA_WITH_SPECIAL',
                  model: generateModelPlaceholderId(m),
                  apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                  modelProvider: 'MODEL_PROVIDER_GOOGLE',
                };
                m._slug = slug;
              });
              googleJson.models = modelsMap;
            }


            const customSlugs = customModels.map((m) => m._slug).filter(Boolean) as string[];
            if (customSlugs.length > 0) {
              if (googleJson.agentModelSorts && Array.isArray(googleJson.agentModelSorts)) {
                (googleJson.agentModelSorts as { groups?: { modelIds?: string[] }[] }[]).forEach((sort) => {
                  if (sort.groups && Array.isArray(sort.groups)) {
                    sort.groups.forEach((group) => {
                      if (group.modelIds && Array.isArray(group.modelIds)) {
                        customSlugs.forEach((slug) => {
                          if (!group.modelIds!.includes(slug)) {
                            group.modelIds!.push(slug);
                          }
                        });
                      }
                    });
                  }
                });
              }
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(googleJson));
          } catch (err) {
            log.error('[Proxy] Parsing fetchAvailableModels failed, returning custom models:', err);
            const customModels = loadCustomModels();
            const mappedCustom: Record<string, unknown> = {};
            customModels.forEach((m) => {
              const slug = toSlug(m);
              mappedCustom[slug] = {
                displayName: m.displayName,
                maxTokens: detectModelCapabilities(m).maxTokens,
                maxOutputTokens: detectModelCapabilities(m).maxOutputTokens,
                model: generateModelPlaceholderId(m),
                apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
                modelProvider: 'MODEL_PROVIDER_GOOGLE',
              };
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: mappedCustom }));
          }
        });
      });

      googleReq.on('error', (err) => {
        log.error('[Proxy] Forwarding fetchAvailableModels failed:', err);
        const customModels = loadCustomModels();
        const mappedCustom: Record<string, unknown> = {};
        customModels.forEach((m) => {
          const slug = toSlug(m);
          mappedCustom[slug] = {
            displayName: m.displayName,
            maxTokens: detectModelCapabilities(m).maxTokens,
            maxOutputTokens: detectModelCapabilities(m).maxOutputTokens,
            model: generateModelPlaceholderId(m),
            apiProvider: 'API_PROVIDER_GOOGLE_GEMINI',
            modelProvider: 'MODEL_PROVIDER_GOOGLE',
          };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ models: mappedCustom }));
      });

      if (fullBody && fullBody.length > 0) {
        googleReq.write(fullBody);
      }
      googleReq.end();
      return;
    }


    if (req.method === 'GET' && (req.url!.endsWith('/models') || req.url!.includes('/models?'))) {
      log.info('[Proxy] Intercepting models list request');

      const targetUrl = 'https://generativelanguage.googleapis.com';
      const parsedUrl = new URL(req.url!, targetUrl);
      const mdlHeaders: Record<string, string | string[] | undefined> = {
        ...(req.headers as Record<string, string | string[] | undefined>),
      };
      mdlHeaders['host'] = 'generativelanguage.googleapis.com';
      delete mdlHeaders['connection'];
      delete mdlHeaders['accept-encoding'];

      const mdlOptions: https.RequestOptions = { method: 'GET', headers: mdlHeaders as Record<string, string> };

      const googleReq = https.request(parsedUrl, mdlOptions, (googleRes) => {

        googleReq.setTimeout(30_000, () => {
          log.error('[Proxy] Models list forward request timed out');
          googleReq.destroy();
          if (!res.headersSent) {
            const customModels = loadCustomModels();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                models: customModels.map((m) => ({
                  name: m.name,
                  displayName: m.displayName,
                  description: m.description,
                  supportedGenerationMethods: ['generateContent'],
                })),
              }),
            );
          }
        });

        let googleBody = '';
        googleRes.on('data', (chunk) => (googleBody += chunk));
        googleRes.on('end', () => {
          try {
            const googleJson = JSON.parse(googleBody) as { models?: unknown[] };
            const customModels = loadCustomModels();

            const mappedCustom = customModels.map((m) => ({
              name: 'models/' + generateModelPlaceholderId(m),
              version: '1.0',
              displayName: m.displayName,
              description: m.description,
              inputTokenLimit: detectModelCapabilities(m).maxTokens,
              outputTokenLimit: detectModelCapabilities(m).maxOutputTokens,
              supportedGenerationMethods: ['generateContent', 'countTokens'],
              temperature: 0.7,
              topP: 0.9,
              topK: 40,
            }));

            if (googleJson.models) {
              googleJson.models = [...mappedCustom, ...googleJson.models];
            } else {
              googleJson.models = mappedCustom;
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(googleJson));
          } catch (err) {
            log.error('[Proxy] Google list models failed, returning custom models list only:', err);
            const customModels = loadCustomModels();
            const mappedCustom = customModels.map((m) => ({
              name: 'models/' + generateModelPlaceholderId(m),
              version: '1.0',
              displayName: m.displayName,
              description: m.description,
              inputTokenLimit: detectModelCapabilities(m).maxTokens,
              outputTokenLimit: detectModelCapabilities(m).maxOutputTokens,
              supportedGenerationMethods: ['generateContent', 'countTokens'],
            }));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ models: mappedCustom }));
          }
        });
      });

      googleReq.on('error', (err) => {
        log.error('[Proxy] Google models list request error:', err);
        const customModels = loadCustomModels();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            models: customModels.map((m) => ({
              name: m.name,
              displayName: m.displayName,
              description: m.description,
              supportedGenerationMethods: ['generateContent'],
            })),
          }),
        );
      });
      googleReq.end();
      return;
    }


    const isCloudCodeStream =
      req.url!.includes('/v1internal:streamGenerateContent') || req.url!.includes('/v1internal:generateContent');
    if (req.method === 'POST' && isCloudCodeStream) {
      try {
        const reqJson = JSON.parse(bodyStr) as Record<string, unknown>;
        const modelName = reqJson.model as string | undefined;
        const modelId = (reqJson.modelId || reqJson.model_id) as string | undefined;
        log.info(
          `[Proxy] Cloud Code generation request model: ${modelName}, modelId: ${modelId}, url: ${req.url}, bodyKeys: ${Object.keys(reqJson).join(',')}`,
        );
        if (modelName) {
          const customModels = loadCustomModels();
          const matchedCustomModel = customModels.find((m) => {
            const enumName = generateModelPlaceholderId(m);
            return m.name === modelName || toSlug(m) === modelName || enumName === modelName || enumName === modelId;
          });
          if (matchedCustomModel) {
            log.info(
              `[Proxy] Intercepting Cloud Code generation for custom model: ${modelName} => ${matchedCustomModel.displayName}`,
            );
            const isStream = req.url!.includes('streamGenerateContent') || req.url!.includes('alt=sse');
            const actualGeminiBody = { ...(reqJson.request || reqJson) as GeminiRequestBody };
            if (typeof reqJson.sessionId === 'string') actualGeminiBody.sessionId = reqJson.sessionId;
            if (typeof reqJson.conversationId === 'string') actualGeminiBody.conversationId = reqJson.conversationId;

            resolveFileData(actualGeminiBody, req.headers as Record<string, string | string[] | undefined>).then(() => {
              const accountPool = getAccountPool();
              const poolCfg = accountPool ? accountPool.loadPoolConfig() : null;
              if (poolCfg && poolCfg.promptEngineMode && poolCfg.promptEngineMode !== 'antigravity') {
                applyPromptEngine(actualGeminiBody, poolCfg.promptEngineMode, poolCfg.customPromptText);
              }
              handleCustomModelRequest(res, matchedCustomModel, actualGeminiBody, isStream);
            });
            return;
          }
        }
      } catch (err) {
        log.error('[Proxy] Failed to parse Cloud Code stream body:', err);
      }
    }


    const generateMatch = req.url!.match(/\/(?:v1|v1beta)\/(models\/[^:]+):generateContent/);
    const streamMatch = req.url!.match(/\/(?:v1|v1beta)\/(models\/[^:]+):streamGenerateContent/);

    const isGenerate = !!generateMatch;
    const isStandardStream = !!streamMatch;

    if (req.method === 'POST' && (isGenerate || isStandardStream)) {
      let matchedModelName: string;
      try { matchedModelName = decodeURIComponent(isGenerate ? generateMatch![1] : streamMatch![1]); }
      catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Invalid model URL encoding' } }));
        return;
      }
      const customModels = loadCustomModels();
      const matchedCustomModel = customModels.find((m) => {
        const enumName = generateModelPlaceholderId(m);
        return (
          m.name === matchedModelName ||
          toSlug(m) === matchedModelName ||
          enumName === matchedModelName ||
          'models/' + enumName === matchedModelName
        );
      });

      if (matchedCustomModel) {
        try {
          const geminiBody = JSON.parse(bodyStr) as GeminiRequestBody;
          resolveFileData(geminiBody, req.headers as Record<string, string | string[] | undefined>).then(() => {
            const accountPool = getAccountPool();
            const poolCfg = accountPool ? accountPool.loadPoolConfig() : null;
            if (poolCfg && poolCfg.promptEngineMode && poolCfg.promptEngineMode !== 'antigravity') {
              applyPromptEngine(geminiBody, poolCfg.promptEngineMode, poolCfg.customPromptText);
            }
            handleCustomModelRequest(res, matchedCustomModel, geminiBody, isStandardStream, false);
          });
          return;
        } catch (e) {
          log.error('[Proxy] JSON parse error in request body:', e);
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: { message: 'Invalid JSON request body' } }));
          return;
        }
      }
    }


    void proxyToGoogle(req, res, fullBody);
  });
}



export async function startProxy(): Promise<number> {
  if (stoppingProxy) await stoppingProxy;
  if (server?.listening && proxyPort) return proxyPort;
  if (startingProxy) return startingProxy;


  try {
    const accountPool = getAccountPool();
    if (accountPool) {
      const poolCfg = accountPool.loadPoolConfig();
      if (poolCfg.accounts.length === 0) {
        accountPool.captureActiveNativeSession().catch((e: any) => {
          log.info('[Proxy] Native session auto-capture skipped:', e.message);
        });
      }
    }
  } catch {

  }

  const requiredPort = getRequiredProxyPort(app.getAppPath());
  const newServer = http.createServer(handleRequest);
  server = newServer;
  startCleanupInterval();
  startingProxy = listenProxy(newServer, requiredPort ?? 50999, requiredPort === undefined)
    .then((port) => {
      proxyPort = port;
      log.info(`[Proxy] Server listening on http://127.0.0.1:${proxyPort}`);
      return proxyPort;
    })
    .catch((error) => {
      stopCleanupInterval();
      server = null;
      proxyPort = 0;
      log.error('[Proxy] Startup failed:', error);
      throw error;
    })
    .finally(() => {
      startingProxy = null;
    });
  return startingProxy;
}

export function stopProxy(): Promise<void> {
  if (stoppingProxy) return stoppingProxy;
  stoppingProxy = (async () => {

    if (startingProxy) {
      try {
        await startingProxy;
      } catch {

      }
    }
    stopCleanupInterval();
    stopCustomRequests();
    if (server) {
      const closingServer = server;
      await new Promise<void>((resolve) => closingServer.close(() => resolve()));
      log.info('[Proxy] Server stopped');
    }
    server = null;
    proxyPort = 0;
  })().finally(() => {
    stoppingProxy = null;
  });
  return stoppingProxy;
}

export function getProxyPort(): number {
  return proxyPort;
}
