import * as fallback from '../geminiFallback';
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const code = ts.transpileModule(readFileSync(path.resolve('src/proxy.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

async function request(status: number, body: string, options: {fallback?:boolean;nativeModel?:string;rotate?:boolean;accounts?:number;standby?:boolean;cancel?:boolean} = {}) {
  const account = { id: 'a', email: 'a@example.invalid', accessToken: 'fixture' };
  const standby = {id:'b',accessToken:'fixture2'};
  const reportAccountExhaustion = vi.fn(async () => ({ nextAccount: options.standby && reportAccountExhaustion.mock.calls.length === 1 ? standby : null }));
  const runCustomModelRequest = vi.fn(async (res:any) => {res.writeHead(200,{});res.end('byok-response');});
  const payload = {contents:[{role:'user',parts:[{text:'full context'},{inlineData:{mimeType:'image/png',data:'AAE='}}]}],systemInstruction:{parts:[{text:'system instructions'}]},tools:[{functionDeclarations:[{name:'fixture_tool'}]}]};
  const upstreamRequest = vi.fn((_url, _options, callback) => {
    const upstream = Object.assign(new EventEmitter(), { statusCode: status, headers: { 'content-type': 'application/json', 'retry-after': '3' },
      resume: vi.fn(), pipe: (res:any) => {res.end(Buffer.from(body));}, destroy: vi.fn() });
    const req = Object.assign(new EventEmitter(), { setTimeout: vi.fn(), write: vi.fn(), destroy: vi.fn(),
      end: () => queueMicrotask(() => { callback(upstream); upstream.emit('data', Buffer.from(body)); upstream.emit('end'); }) });
    return req;
  });
  const modules: Record<string, unknown> = {
    http: {}, https: { request: upstreamRequest }, fs: {}, path,
    electron: { app: {} }, 'electron-log': { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    './geminiFallback': fallback, './proxy/customRequest': {runCustomModelRequest,recordGenerationStart:vi.fn(),recordGenerationEnd:vi.fn()},
    './accountPool': { loadPoolConfig: () => ({ accounts: options.accounts === 0 ? [] : options.accounts === 1 ? [account] : [account, standby], activeAccountId: 'a', autoHotswap: options.rotate !== false, geminiFallbackModel:options.fallback ? 'selected' : '' }),
      getEffectiveAccountForRequest: async () => ({ account, didHotSwap: false }), reportAccountExhaustion },
  };
  const exports: any = {};
  runInNewContext(code + '\nloadCustomModels = () => fixtureModels; exports.forward = proxyToGoogle;', {
    fixtureModels:[{name:'selected',displayName:'BYOK',provider:'google',externalModelName:'gemini-flash',apiKey:'fixture-key',apiUrl:'https://generativelanguage.googleapis.com',fallbackModels:['other-paid'],contextWindow:10}],
    exports, require: (name: string) => modules[name] || {}, console, process, URL, Buffer, setTimeout, clearTimeout,
  });
  const req = Object.assign(new EventEmitter(), { url: '/v1internal:streamGenerateContent', method: 'POST', headers: {} });
  let finish: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const res = Object.assign(new EventEmitter(), { headersSent: false, writableEnded: false, destroyed: false,
    writeHead: vi.fn(() => { res.headersSent = true; }),
    end: vi.fn(() => { res.writableEnded = true; finish(); }) });
  if(options.cancel){res.destroyed=true;finish!();}
  await exports.forward(req, res, Buffer.from(JSON.stringify({model:options.nativeModel || 'gemini-flash',request:payload})));
  await done;
  return { res, reportAccountExhaustion, upstreamRequest, runCustomModelRequest,payload };
}

describe('Google hot-swap error forwarding', () => {
  it('returns the original 429 body when no standby is usable instead of piping a destroyed stream', async () => {
    const body = '{"error":{"status":"RESOURCE_EXHAUSTED"}}';
    const f = await request(429, body);
    expect(f.res.end).toHaveBeenCalledWith(Buffer.from(body));
    expect(f.reportAccountExhaustion.mock.calls[0].slice(0, 4)).toEqual(['a', 429, 3000, 'gemini-flash']);
    expect((f.reportAccountExhaustion.mock.calls[0] as any)[4].has('a')).toBe(true);
    expect(f.upstreamRequest).toHaveBeenCalledOnce();
  });
  it('forwards licensing errors without exhausting or rotating every account', async () => {
    const body = '{"error":{"status":"PERMISSION_DENIED","reason":"SUBSCRIPTION_REQUIRED"}}';
    const f = await request(403, body);
    expect(f.reportAccountExhaustion).not.toHaveBeenCalled();
    expect(f.res.end).toHaveBeenCalledWith(Buffer.from(body));
  });
});

describe('Opt-in Gemini API fallback',()=>{
  it('is disabled by default even after exhausting the account pool',async()=>{
    const f=await request(429,'quota');expect(f.runCustomModelRequest).not.toHaveBeenCalled();
  });
  it.each([0,1,2])('uses the selected API model with %i pool accounts after quota exhaustion',async accounts=>{
    const f=await request(429,'quota',{fallback:true,accounts});
    expect(f.runCustomModelRequest).toHaveBeenCalledOnce();
    const [res,model,payload,stream,models,envelope]=f.runCustomModelRequest.mock.calls[0] as any;
    expect(payload).toEqual(f.payload);expect(stream).toBe(true);expect(envelope).toBe(true);
    expect(model.contextWindow).toBeUndefined();expect(model.fallbackModels).toEqual([]);expect(models).toEqual([model]);
    expect(res.end).toHaveBeenCalledWith('byok-response');
  });
  it('rotates to standby before considering BYOK',async()=>{
    const f=await request(429,'quota',{fallback:true,standby:true});
    expect(f.upstreamRequest).toHaveBeenCalledTimes(2);expect(f.runCustomModelRequest).toHaveBeenCalledOnce();
  });
  it('supports quota-marked 403 but ignores licensing, geo, server and successful responses',async()=>{
    const quota=await request(403,'RESOURCE_EXHAUSTED',{fallback:true});expect(quota.runCustomModelRequest).toHaveBeenCalledOnce();
    for(const [status,body] of [[403,'SUBSCRIPTION_REQUIRED'],[400,'location unsupported'],[500,'server error'],[200,'partial output']] as const){
      const f=await request(status,body,{fallback:true});expect(f.runCustomModelRequest).not.toHaveBeenCalled();
    }
  });
  it('does not substitute Gemini for native Claude or unknown models',async()=>{
    for(const nativeModel of ['claude-sonnet','12345']){
      const f=await request(429,'quota',{fallback:true,nativeModel});expect(f.runCustomModelRequest).not.toHaveBeenCalled();
    }
  });
  it('can use BYOK with account rotation off and never retries a cancelled request',async()=>{
    const f=await request(429,'quota',{fallback:true,rotate:false});expect(f.runCustomModelRequest).toHaveBeenCalledOnce();
    const cancelled=await request(429,'quota',{fallback:true,cancel:true});expect(cancelled.runCustomModelRequest).not.toHaveBeenCalled();
  });
});
