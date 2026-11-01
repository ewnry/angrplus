import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import * as revisions from '../messageRevisions';
const code = ts.transpileModule(readFileSync(path.resolve('src/proxy.ts'), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;
it('rewrites the actual proxy envelope before HTTPS forwarding and adds only one timeout callback for a streamed response', async () => {
  const store = new revisions.MessageRevisionStore();
  const revision = store.create({conversationId:'c',targetOrdinal:0,targetStepIndex:0,originalText:'original',text:'replacement'});
  const user = (text:string) => ({role:'user',parts:[{text:`<USER_REQUEST>\n${text}\n</USER_REQUEST>`}]});
  const body = JSON.stringify({model:'gemini-flash',request:{contents:[user('original'),{role:'model',parts:[{text:'stale answer'}]},user(`replacement\n\n${revisions.revisionToken(revision.id)}`)]}});
  let written = '', upstream: any;
  let done!:()=>void; const finished = new Promise<void>(resolve=>done=resolve);
  const response = Object.assign(new EventEmitter(),{statusCode:200,headers:{'content-type':'text/event-stream'},pipe:vi.fn((res)=>res.end()),resume:vi.fn()});
  const modules:any = {
    './accountPool':{loadPoolConfig:()=>({accounts:[]})}, http:{}, https:{request:vi.fn((_url,_options,callback)=>{
      upstream=Object.assign(new EventEmitter(),{destroyed:false,setTimeout:vi.fn(),write:vi.fn((chunk)=>{written+=chunk.toString()}),destroy:vi.fn(),end:()=>queueMicrotask(()=>{callback(response);for(let i=0;i<30;i++)response.emit('data',Buffer.from('data: {"text":"ok"}\n\n'));response.emit('end')})});return upstream;
    })}, fs:{},path,electron:{app:{}},'electron-log':{info:vi.fn(),warn:vi.fn(),error:vi.fn()},
    './proxy/loopbackSecurity':{guardLoopbackRequest:()=>true},'./messageRevisions':{...revisions,getMessageRevisionStore:()=>store},
  };
  const exports:any={};runInNewContext(code+'\nexports.handle=handleRequest;', {exports,require:(name:string)=>modules[name]||{},process,console,URL,Buffer,setTimeout,clearTimeout});
  const req=Object.assign(new EventEmitter(),{url:'/v1internal:streamGenerateContent',method:'POST',headers:{'content-length':String(Buffer.byteLength(body))}});
  const res=Object.assign(new EventEmitter(),{headersSent:false,writableEnded:false,destroyed:false,writeHead:vi.fn(()=>{res.headersSent=true}),end:vi.fn(()=>{res.writableEnded=true;done()})});
  exports.handle(req,res);req.emit('data',Buffer.from(body));req.emit('end');await finished;
  const sent=JSON.parse(written);expect(sent.request.contents).toHaveLength(1);expect(sent.request.contents[0].parts[0].text).toContain('replacement');expect(written).not.toContain('stale answer');expect(written).not.toContain('AGY_REVISION');
  expect(Number(req.headers['content-length'])).toBe(Buffer.byteLength(written));
  expect(upstream.setTimeout.mock.calls.filter((args:any[])=>typeof args[1]==='function')).toHaveLength(1);
});
