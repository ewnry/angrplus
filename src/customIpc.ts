import { applyThemeIcon } from './themeIcons';

import { app, ipcMain, shell } from 'electron';
import * as path from 'node:path';
import * as cryptoStore from './cryptoStore';
import { getMessageRevisionStore, revisionToken } from './messageRevisions';
import { createModelManager } from './modelManagement';

export function hasNativeNotificationSettings(version = app.getVersion?.() || ''): boolean {
  const parts = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return !!parts && (Number(parts[1]) > 2 || (Number(parts[1]) === 2 && Number(parts[2]) >= 26));
}

export function registerCustomModelHandlers(): void {
  const manager = createModelManager(path.join(app.getPath('home'), '.gemini', 'antigravity'), cryptoStore, (url) =>
    shell.openExternal(url),
  );
  const handle = (channel: string, action: (...args: any[]) => unknown) => {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await action(...args);
      } catch (error) {
        if (channel === 'storage:get-custom-models' || channel === 'storage:export-custom-models') throw error;
        const status = (error as { status?: number }).status;
        return { success: false, error: (error as Error).message, ...(status ? { status } : {}) };
      }
    });
  };
  const insightsRoot = path.join(app.getPath('home'), '.gemini', 'antigravity');
  let geminiWeb: any;
  const web = () => geminiWeb ||= new (require('./geminiWeb').GeminiWeb)(insightsRoot);
  const webFiles = new Map<string, { path:string; name:string; size:number; temporary?:boolean }>();
  const releaseWebFile=async(id:string)=>{const file=webFiles.get(id);webFiles.delete(id);if(file?.temporary)await require('node:fs/promises').unlink(file.path).catch(()=>{});};
  handle('gemini-web:stage-file',async(dataUrl:string,name:string)=>{
    if(typeof dataUrl!=='string'||dataUrl.length>28*1024*1024||typeof name!=='string')throw new Error('For files over 20 MB, use the attachment button.');
    const match=/^data:([a-zA-Z0-9.+_-]+\/[a-zA-Z0-9.+_-]+)?;base64,([a-zA-Z0-9+/=]*)$/.exec(dataUrl);if(!match)throw new Error('Invalid attachment.');
    const bytes=Buffer.from(match[2],'base64');if(bytes.length>20*1024*1024)throw new Error('For files over 20 MB, use the attachment button.');
    const fs=require('node:fs/promises'),id=require('node:crypto').randomUUID();
    const safeName=name.replace(/[\\/\x00-\x1f]/g,'_').slice(-160)||'attachment';
    const directory=path.join(app.getPath('temp'),'antigravity-cowork');await fs.mkdir(directory,{recursive:true});
    const file=path.join(directory,id+'-'+safeName);await fs.writeFile(file,bytes,{mode:0o600});
    webFiles.set(id,{path:file,name:safeName,size:bytes.length,temporary:true});
    return {id,name:safeName,size:bytes.length,...(/^image\/(png|jpeg|gif|webp)$/.test(match[1]||'')?{preview:dataUrl}:{})};
  });
  handle('gemini-web:release-file',(id:string)=>releaseWebFile(id));
  handle('gemini-web:pick-files', async () => {
    const result=await require('electron').dialog.showOpenDialog({title:'Attach to Gemini Web',properties:['openFile','multiSelections']});
    if(result.canceled)return [];
    const fs=require('node:fs/promises'),crypto=require('node:crypto');
    const selected=[];
    for(const file of result.filePaths.slice(0,10)){
      const stat=await fs.stat(file);if(!stat.isFile()||stat.size>100*1024*1024)throw new Error('Choose files smaller than 100 MB.');
      const id=crypto.randomUUID(),name=path.basename(file),ext=path.extname(file).toLowerCase();
      const mime=({'.png':'image/png','.jpg':'image/jpeg','.jpeg':'image/jpeg','.gif':'image/gif','.webp':'image/webp'} as any)[ext];
      const preview=mime&&stat.size<=5*1024*1024?`data:${mime};base64,${(await fs.readFile(file)).toString('base64')}`:undefined;
      webFiles.set(id,{path:file,name,size:stat.size});selected.push({id,name,size:stat.size,preview});
    }
    return selected;
  });
  handle('gemini-web:tools',()=>web().tools());
  handle('gemini-web:stop',()=>web().stop());
  handle('gemini-web:dialog-action',(name:string)=>web().dialogAction(name));
  handle('gemini-web:select-tool',(name:string)=>web().selectTool(name));
  handle('gemini-web:edit',(id:string,text:string,chat:string)=>web().edit(Number(id),text,chat));
  handle('gemini-web:media',(id:string,mediaId:string,chat:string)=>web().media(id,mediaId,chat));
  handle('gemini-web:configure', (enabled: boolean) => {
    if (typeof enabled !== 'boolean') throw new Error('Expected enabled boolean.');
    return require('./geminiWebSetup').configureGeminiWebMcp(app.getPath('home'), enabled);
  });
  handle('gemini-web:open', (mode = 'signin') => {
    if (!['signin', 'connect','background'].includes(mode)) throw new Error('Invalid browser mode.');
    return web().open(mode);
  });
  handle('gemini-web:status', () => web().status());
  handle('gemini-web:snapshot', () => web().snapshot());
  handle('gemini-web:navigate', (chatId = '') => web().navigate(chatId));
  handle('gemini-web:models', (parent = '') => {
    if (typeof parent !== 'string' || parent.length > 200) throw new Error('Invalid model submenu.');
    return web().models(parent);
  });
  handle('gemini-web:select-model', (name: string, parent = '') => {
    if (typeof name !== 'string' || !name || name.length > 200 || typeof parent !== 'string' || parent.length > 200) throw new Error('Invalid model choice.');
    return web().selectModel(name, parent);
  });
  handle('gemini-web:ask', async (prompt: string, expectedChat: string, fileIds: string[] = []) => {
    const state = await web().snapshot();
    if (typeof expectedChat !== 'string' || state.chatId !== expectedChat) throw new Error('The Web conversation changed. Refresh Cowork before sending.');
    if(!Array.isArray(fileIds)||fileIds.length>10||fileIds.some(id=>!webFiles.has(id)))throw new Error('Attachments changed. Choose the files again.');
    if(fileIds.length)await web().attach(fileIds.map(id=>webFiles.get(id)!.path));
    const result=await web().ask(prompt,undefined,fileIds.length>0);
    for(const id of fileIds)await releaseWebFile(id);
    return result;
  });
  handle('telemetry:read', (options = {}) => require('./telemetry').readTelemetry(insightsRoot, options.conversationId || '', options.days || 0));
  handle('pool:history', () => {
    const config = require('./accountPool').loadPoolConfig();
    const history = require('./quotaHistory');
    for (const account of config.accounts) if (account.lastQuota) history.recordQuota(insightsRoot, account.id, account.lastQuota);
    return history.getQuotaHistory(insightsRoot, config.accounts.map((account: any) => account.id));
  });
  handle('pool:fallback-models', () => manager.store.list().filter((model:any) => require('./geminiFallback').isGeminiByok(model)).map((model:any) => ({ name:model.name, label:model.displayName || model.externalModelName })));
  handle('plus:diagnostics', () => {
    const proxy = require('./proxy'), config = require('./accountPool').loadPoolConfig();
    const models = manager.store.list();
    const invalidModels = models.filter((model:any) => !require('./schemaValidator').validateCustomModel(model).valid).length;
    const fallbackConfigured = !!config.geminiFallbackModel && models.some((model:any) => model.name === config.geminiFallbackModel && require('./geminiFallback').isGeminiByok(model));
    return require('./diagnostics').diagnoseRuntime({ root: insightsRoot, appVersion: app.getVersion(), patchVersion: require('./plusUpdater').ANTIGRAVITY_PLUS_VERSION,
      proxyPort: proxy.getProxyPort(), languageServerPort: proxy.getLanguageServerPort(), accounts: config.accounts, models, invalidModels, fallbackConfigured });
  });
  handle('storage:inspect-space', () => require('./storageInsights').inspectStorage(insightsRoot, app.getPath('userData')));
  handle('storage:clean-space', (previewId: string) => require('./storageInsights').cleanStorage(previewId, (file: string) => shell.trashItem(file)));
  handle('messages:list-revisions', (conversationId: string) => ({ success: true, revisions: getMessageRevisionStore().list(conversationId) }));
  handle('messages:create-revision', (input) => {
    const revision = getMessageRevisionStore().create(input);
    return { success: true, revision, message: `${revision.text}\n\n${revisionToken(revision.id)}` };
  });
  handle('storage:get-custom-models', () => manager.store.list());
  handle('storage:save-custom-model', manager.saveModel);
  handle('storage:delete-custom-model', (name) => {
    manager.store.delete(name);
    return { success: true };
  });
  handle('storage:test-model-connection', (model) => manager.testModel(model));
  handle('storage:get-provider-presets', manager.presets);
  handle('storage:discover-models', manager.discoverModels);
  handle('storage:discover-local', manager.discoverLocal);
  handle('storage:export-custom-models', () => manager.store.export());
  handle('storage:import-custom-models', (payload) => ({ success: true, count: manager.store.import(payload) }));
  handle('storage:get-gateway', manager.getGateway);
  handle('storage:save-gateway', manager.saveGateway);
  handle('storage:test-gateway', manager.testGateway);
  handle('storage:import-gateway-models', manager.importGatewayModels);
  handle('storage:open-gateway-dashboard', manager.openDashboard);
  handle('storage:google-login', manager.googleLogin);
  handle('storage:google-login-cancel', manager.googleLoginCancel);
  handle('storage:google-test-account', manager.googleTestAccount);
  handle('storage:google-pool-status', manager.googlePoolStatus);


  let accountPool: typeof import('./accountPool') | null = null;
  try {
    accountPool = require('./accountPool');
  } catch {

  }

  let plusUpdater: typeof import('./plusUpdater') | null = null;
  try {
    plusUpdater = require('./plusUpdater');
  } catch {

  }

  handle('pool:get-status', async () => {
    if (!accountPool) return { success: false, accounts: [], autoHotswap: true, combineLimits: true };
    const cfg = accountPool.loadPoolConfig();
    let summary = null;
    try {

      const res = accountPool.mergeAccountQuotas(cfg.accounts, cfg.accounts.map((account) => account.lastQuota), cfg);
      summary = res.summary;
    } catch {

    }
    return {
      success: true,
      accounts: cfg.accounts.map((a: any) => ({
        id: a.id,
        email: a.email,
        name: a.name,
        picture: a.picture,
        label: a.label,
        cooldownUntil: a.cooldownUntil || 0,
        isActive: a.id === cfg.activeAccountId,
        lastQuota: a.lastQuota,
      })),
      activeAccountId: cfg.activeAccountId,
      autoHotswap: cfg.autoHotswap !== false,
      combineLimits: cfg.combineLimits !== false,
      quotaDisplayMode: cfg.quotaDisplayMode || 'normalized',
      showActiveInLimits: cfg.showActiveInLimits === true,
      nativeNotifications: hasNativeNotificationSettings(),
      geminiFallbackModel: cfg.geminiFallbackModel || '',
      soundEnabled: cfg.soundEnabled !== false,
      soundTheme: cfg.soundTheme || 'ps5-notification.mp3',
      updateServerUrl: cfg.updateServerUrl || 'https://antigravity-plus-updates.unalty-api.workers.dev',
      autoCheckUpdates: cfg.autoCheckUpdates !== false,
      uiThemeMode: cfg.uiThemeMode || 'antigravity',
      promptEngineMode: cfg.promptEngineMode || 'antigravity',
      customPromptText: cfg.customPromptText || '',
      appVersion: plusUpdater?.ANTIGRAVITY_PLUS_VERSION || '2.1.0',
      summary,
    };
  });

  handle('pool:capture-native', async () => {
    if (!accountPool) return { success: false, error: 'Module not available' };
    const account = await accountPool.captureActiveNativeSession();
    return { success: true, account };
  });

  handle('pool:start-login', async () => {
    if (!accountPool) return { success: false, error: 'Module not available' };
    try {
      const account = await accountPool.startAddGoogleAccountFlow((url: string) => shell.openExternal(url));
      return { success: true, account };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });

  handle('pool:cancel-login', () => {
    if (accountPool) accountPool.cancelAddGoogleAccountFlow();
    return { success: true };
  });

  handle('pool:set-active', (accountId: string) => {
    if (!accountPool) return { success: false, error: 'Module not available' };
    const cfg = accountPool.loadPoolConfig();
    if (cfg.accounts.some((a: any) => a.id === accountId)) {
      cfg.activeAccountId = accountId;
      accountPool.savePoolConfig(cfg);
      return { success: true };
    }
    return { success: false, error: 'Account not found' };
  });

  handle(
    'pool:set-options',
    (options: {
      geminiFallbackModel?: string;
      autoHotswap?: boolean;
      combineLimits?: boolean;
      quotaDisplayMode?: 'normalized' | 'additive' | 'active';
      showActiveInLimits?: boolean;
      soundEnabled?: boolean;
      soundTheme?: string;
      updateServerUrl?: string;
      autoCheckUpdates?: boolean;
      promptEngineMode?: import('./accountPool').PromptEngineMode;
      customPromptText?: string;
      uiThemeMode?: import('./accountPool').UIThemeMode;
    }) => {
      if (!accountPool) return { success: false, error: 'Module not available' };
      const cfg = accountPool.loadPoolConfig();
      if (typeof options.autoHotswap === 'boolean') cfg.autoHotswap = options.autoHotswap;
      if (typeof options.combineLimits === 'boolean') cfg.combineLimits = options.combineLimits;
      if (options.quotaDisplayMode) cfg.quotaDisplayMode = options.quotaDisplayMode;
      if (typeof options.showActiveInLimits === 'boolean') cfg.showActiveInLimits = options.showActiveInLimits;
      if (typeof options.soundEnabled === 'boolean') cfg.soundEnabled = options.soundEnabled;
      if (options.soundTheme) cfg.soundTheme = options.soundTheme;
      if (options.updateServerUrl) cfg.updateServerUrl = options.updateServerUrl;
      if (typeof options.autoCheckUpdates === 'boolean') cfg.autoCheckUpdates = options.autoCheckUpdates;
      if (options.promptEngineMode) cfg.promptEngineMode = options.promptEngineMode;
      if (typeof options.customPromptText === 'string') cfg.customPromptText = options.customPromptText;
      if (options.uiThemeMode) cfg.uiThemeMode = options.uiThemeMode;
      if (typeof options.geminiFallbackModel === 'string') {
        if (options.geminiFallbackModel && !manager.store.list().some((model:any) => model.name === options.geminiFallbackModel && require('./geminiFallback').isGeminiByok(model))) throw new Error('Select an enabled Google Gemini API-key model on the official Gemini endpoint.');
        cfg.geminiFallbackModel = options.geminiFallbackModel;
      }
      accountPool.savePoolConfig(cfg);
      if (options.uiThemeMode) applyThemeIcon(options.uiThemeMode);
      return { success: true };
    },
  );

  handle('plus:check-admin', async () => {
    const elevation = require('./elevation');
    return elevation.checkAdministratorStatus(elevation.getAgentProcessId());
  });

  handle('plus:relaunch-admin', () => require('./elevation').relaunchAsAdministrator());

  handle('pool:remove-account', (accountId: string) => {
    if (!accountPool) return { success: false, error: 'Module not available' };
    const cfg = accountPool.loadPoolConfig();
    cfg.accounts = cfg.accounts.filter((a: any) => a.id !== accountId);
    if (cfg.activeAccountId === accountId) {
      cfg.activeAccountId = cfg.accounts[0]?.id;
    }
    accountPool.savePoolConfig(cfg);
    return { success: true };
  });

  handle('pool:refresh-quota', async () => {
    if (!accountPool) return { success: false, error: 'Module not available' };
    const { summary } = await accountPool.fetchCombinedPoolQuota();
    return { success: true, summary };
  });

  handle('pool:export-config', () => {
    if (!accountPool) return { success: false, error: 'Module not available' };
    const cfg = accountPool.loadPoolConfig();
    return { success: true, json: JSON.stringify(cfg, null, 2) };
  });

  handle('pool:import-config', (jsonStr: string) => {
    if (!accountPool) return { success: false, error: 'Module not available' };
    try {
      const data = JSON.parse(jsonStr);
      if (!data || !Array.isArray(data.accounts)) {
        return { success: false, error: 'Invalid config format: missing accounts array.' };
      }
      const existing = accountPool.loadPoolConfig();
      let importedCount = 0;
      for (const acc of data.accounts) {
        if (!acc.email || !acc.refreshToken) continue;
        const matchIdx = existing.accounts.findIndex((a: any) => a.email === acc.email);
        if (matchIdx >= 0) {
          existing.accounts[matchIdx] = { ...existing.accounts[matchIdx], ...acc };
        } else {
          existing.accounts.push(acc);
        }
        importedCount++;
      }
      if (data.quotaDisplayMode) existing.quotaDisplayMode = data.quotaDisplayMode;
      if (typeof data.showActiveInLimits === 'boolean') existing.showActiveInLimits = data.showActiveInLimits;
      if (typeof data.autoHotswap === 'boolean') existing.autoHotswap = data.autoHotswap;
      if (typeof data.combineLimits === 'boolean') existing.combineLimits = data.combineLimits;
      if (typeof data.soundEnabled === 'boolean') existing.soundEnabled = data.soundEnabled;
      if (data.soundTheme) existing.soundTheme = data.soundTheme;
      if (data.activeAccountId) existing.activeAccountId = data.activeAccountId;
      if (data.updateServerUrl) existing.updateServerUrl = data.updateServerUrl;
      if (typeof data.autoCheckUpdates === 'boolean') existing.autoCheckUpdates = data.autoCheckUpdates;

      accountPool.savePoolConfig(existing);
      return { success: true, count: importedCount };
    } catch (e: any) {
      return { success: false, error: `Import failed: ${e?.message || String(e)}` };
    }
  });

  handle('sound:get-audio-data', (soundName: string) => {
    const fs = require('node:fs');
    const safeName = path.basename(soundName || 'minecraft-notification.mp3');
    const candidatePaths = [
      path.join(app.getPath('home'), '.gemini', 'antigravity', 'sounds', safeName),
      path.join(__dirname, '..', '..', 'assets', 'sounds', safeName),
      path.join(app.getAppPath(), 'assets', 'sounds', safeName),
      path.join(app.getPath('home'), 'Downloads', safeName),
    ];
    for (const p of candidatePaths) {
      if (fs.existsSync(p)) {
        const buf = fs.readFileSync(p);
        return { success: true, dataUri: `data:audio/mpeg;base64,${buf.toString('base64')}`, filePath: p };
      }
    }
    const soundsDir = path.join(app.getPath('home'), '.gemini', 'antigravity', 'sounds');
    if (fs.existsSync(soundsDir)) {
      try {
        const files = fs.readdirSync(soundsDir).filter((f: string) => f.endsWith('.mp3'));
        if (files.length > 0) {
          const p = path.join(soundsDir, files[0]);
          const buf = fs.readFileSync(p);
          return { success: true, dataUri: `data:audio/mpeg;base64,${buf.toString('base64')}`, filePath: p };
        }
      } catch {

      }
    }
    return { success: false, error: 'Sound not found: ' + safeName };
  });

  handle('sound:play-sound-native', (soundName: string) => {
    return playNativeCompletionSound(soundName);
  });




  handle('plus:get-version', () => ({
    version: plusUpdater?.ANTIGRAVITY_PLUS_VERSION || '2.1.0',
  }));

  handle('plus:check-update', async (customUrl?: string) => {
    if (!plusUpdater) return { success: false, updateAvailable: false, error: 'Updater module not available' };
    const cfg = accountPool?.loadPoolConfig();
    const url = customUrl || cfg?.updateServerUrl || plusUpdater.DEFAULT_UPDATE_SERVER_URL;
    return await plusUpdater.checkForUpdates(url);
  });

  handle('plus:download-and-apply-update', async (targetUrl?: string) => {
    if (!plusUpdater) return { success: false, error: 'Updater module not available' };
    try {
      const { BrowserWindow } = require('electron');
      const onProgress = (progress: any) => {
        try {
          if (BrowserWindow) {
            for (const win of BrowserWindow.getAllWindows()) {
              win.webContents.send('plus:update-progress', progress);
            }
          }
        } catch {

        }
      };

      let url = targetUrl;
      if (!url) {
        const cfg = accountPool?.loadPoolConfig();
        const serverUrl = cfg?.updateServerUrl || plusUpdater.DEFAULT_UPDATE_SERVER_URL;
        const check = await plusUpdater.checkForUpdates(serverUrl);
        url = check.asarUrl || check.downloadUrl;
      }

      if (!url) {
        return { success: false, error: 'No update URL specified or available' };
      }

      const downloaded = await plusUpdater.downloadUpdate(url, onProgress);
      if (downloaded.type === 'asar') {
        plusUpdater.applyDirectAsarUpdate(downloaded.filePath);
      } else {
        plusUpdater.applyUpdateAndRestart(downloaded.filePath);
      }
      return { success: true, filePath: downloaded.filePath, type: downloaded.type };
    } catch (err: any) {
      return { success: false, error: err?.message || String(err) };
    }
  });
}

export function playNativeCompletionSound(soundName?: string): { success: boolean; filePath?: string; error?: string } {
  try {
    if (hasNativeNotificationSettings()) return { success: true };
    let soundTheme = soundName;
    try {
      const accountPool = require('./accountPool');
      const cfg = accountPool?.loadPoolConfig ? accountPool.loadPoolConfig() : null;
      if (cfg) {
        if (cfg.soundEnabled === false) return { success: true };
        if (!soundTheme && cfg.soundTheme) soundTheme = cfg.soundTheme;
      }
    } catch {

    }

    const safeName = path.basename(soundTheme || 'minecraft-notification.mp3');


    try {
      const { BrowserWindow } = require('electron');
      const wins = BrowserWindow?.getAllWindows?.() || [];
      for (const win of wins) {
        if (!win.isDestroyed?.()) {
          win.webContents?.send?.('agent:play-sound', safeName);
        }
      }
    } catch {

    }

    return { success: true };
  } catch (err: any) {
    return { success: false, error: err?.message || String(err) };
  }
}

