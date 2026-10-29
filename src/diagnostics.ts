import * as fs from 'node:fs';
import * as path from 'node:path';
import * as net from 'node:net';

export interface DiagnosticCheck { name: string; status: 'ok'|'warning'|'info'; detail: string }
function reachable(port: number | undefined): Promise<boolean> {
  if (!Number.isInteger(port) || !port || port < 1 || port > 65535) return Promise.resolve(false);
  return new Promise(resolve => {
    const socket=net.createConnection({host:'127.0.0.1',port}); let done=false;
    const finish=(value:boolean)=>{if(done)return;done=true;socket.destroy();resolve(value);};
    socket.setTimeout(1000,()=>finish(false));socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));
  });
}
export async function diagnoseRuntime(input: {
  root: string; appVersion: string; patchVersion: string; proxyPort?: number; languageServerPort?: number;
  accounts: Array<{ cooldownUntil?: number; lastQuota?: {checkedAt?: number} }>;
  models: Array<{ enabled?: boolean }>; invalidModels: number; fallbackConfigured: boolean;
}) {
  const checks:DiagnosticCheck[]=[];
  const add=(name:string,status:DiagnosticCheck['status'],detail:string)=>checks.push({name,status,detail});
  const [proxy,language]=await Promise.all([reachable(input.proxyPort),reachable(input.languageServerPort)]);
  add('Local proxy',proxy?'ok':'warning',proxy?'Loopback port responds.':'Proxy is not reachable. Restart Antigravity or rerun the patch check.');
  add('Language server',language?'ok':'warning',language?'Loopback port responds.':'Language server is not reachable. Wait for startup or restart Antigravity.');
  let sqlite=false;try{sqlite=!!require('node:sqlite').DatabaseSync;}catch{}
  add('SQLite telemetry',sqlite?'ok':'warning',sqlite?'Built-in SQLite is available.':'This runtime cannot read local telemetry.');
  const catalog=fs.existsSync(path.join(input.root,'conversation_summaries.db'));
  add('Local history',catalog?'ok':'info',catalog?'Conversation catalog exists.':'No local conversation catalog yet.');
  add('Account pool',input.accounts.length?'ok':'info',`${input.accounts.length} configured; ${input.accounts.filter(account=>(account.cooldownUntil||0)>Date.now()).length} in account-wide cooldown.`);
  const recent=input.accounts.filter(account=>typeof account.lastQuota?.checkedAt==='number'&&Date.now()-account.lastQuota.checkedAt<15*60000).length;
  add('Quota freshness',input.accounts.length&&!recent?'warning':'info',`${recent} of ${input.accounts.length} accounts have a reading from the past 15 minutes.`);
  add('Custom models',input.invalidModels?'warning':'ok',`${input.models.length} configured; ${input.models.filter(model=>model.enabled!==false).length} enabled; ${input.invalidModels} invalid.`);
  add('Gemini BYOK fallback','info',input.fallbackConfigured?'An eligible Gemini API-key fallback is selected.':'Disabled or no eligible Gemini API-key model is selected.');
  add('External access','info','Not tested. No provider requests or paid model calls were made.');
  add('Patch compatibility','info','Runtime is loaded. Full read-only preflight is available through installer --check.');

  return {success:true,report:{schema:1,checkedAt:new Date().toISOString(),application:input.appVersion,
    patch:input.patchVersion,platform:process.platform,architecture:process.arch,node:process.versions.node,
    healthy:!checks.some(check=>check.status==='warning'),checks}};
}
