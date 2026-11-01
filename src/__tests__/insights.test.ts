import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { decodeTokenCall, summarizeCalls, TelemetryReader, wireFields } from '../telemetry';
import { recordQuota, getQuotaHistory, summarizeQuota } from '../quotaHistory';
import { inspectStorage, cleanStorage } from '../storageInsights';
import { DatabaseSync } from 'node:sqlite';

const roots: string[] = [];
function temp() { const dir = fs.mkdtempSync(path.join(os.tmpdir(),'ag-insights-test-')); roots.push(dir); return dir; }
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root,{recursive:true,force:true}); });
function v(value: number) { let n=BigInt(value); const bytes:number[]=[];do{let b=Number(n&127n);n>>=7n;if(n)b|=128;bytes.push(b);}while(n);return Buffer.from(bytes); }
function num(tag:number,n:number){return Buffer.concat([v(tag*8),v(n)]);}
function msg(tag:number,data:Uint8Array){return Buffer.concat([v(tag*8+2),v(data.length),data]);}
function metadata(used=180000,limit=256000,input=1000,cached=9000,output=500){return Buffer.concat([
  msg(1,Buffer.concat([msg(1,Buffer.from('not a timestamp')),msg(19,Buffer.from('gemini-test')),msg(4,Buffer.concat([num(2,input),num(3,output),num(5,cached),num(9,200),num(10,300)])),msg(9,msg(10,Buffer.concat([num(1,used),num(4,limit)])))])),
  msg(4,v(2)),
]);}

describe('local telemetry',()=>{
  it('decodes context independently from usage and does not double count thinking',()=>{
    const call=decodeTokenCall(metadata(),0,Date.now())!;
    expect(call.context).toMatchObject({used:180000,limit:256000,source:'server-estimate'});
    expect(call).toMatchObject({input:1000,cached:9000,output:500,thinking:200});
    const summary=summarizeCalls([call]);expect(summary.total).toBe(10500);expect(summary.cacheRate).toBe(.9);
  });
  it('does not invent a context ceiling when metadata is missing',()=>{
    const call=decodeTokenCall(msg(1,msg(4,num(2,1200))),0,Date.now())!;
    expect(call.context).toBeUndefined();expect(summarizeCalls([call]).total).toBe(1200);
  });
  it('rejects malformed protobuf lengths and invalid identifiers',()=>{
    expect(()=>wireFields(Buffer.from([10,127,1]))).toThrow('Truncated');
    expect(()=>wireFields(Buffer.from([8,128]))).toThrow('Truncated');
    expect(()=>new TelemetryReader(temp()).read('../secrets')).toThrow('Invalid conversation');
  });
  it('reads WAL updates, rebuilds on replacement/undo, and uses step timestamps',()=>{
    const root=temp(),dir=path.join(root,'conversations');fs.mkdirSync(dir);
    const id='00000000-0000-0000-0000-000000000001',file=path.join(dir,`${id}.db`);
    const db=new DatabaseSync(file);db.exec('PRAGMA journal_mode=WAL; CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data BLOB); CREATE TABLE steps(idx INTEGER PRIMARY KEY,metadata BLOB,step_type INTEGER DEFAULT 14)');
    const stamp=Date.now()-3600000;db.prepare('INSERT INTO steps(idx,metadata) VALUES(2,?)').run(msg(1,num(1,Math.floor(stamp/1000))));
    db.prepare('INSERT INTO gen_metadata VALUES(0,?)').run(metadata());
    const reader=new TelemetryReader(root);let result=reader.read(id,7);
    expect(result.summary.calls).toBe(1);expect(result.summary.approximateDates).toBe(false);expect(result.context?.used).toBe(180000);
    db.prepare('UPDATE gen_metadata SET data=? WHERE idx=0').run(metadata(60000));
    result=reader.read(id);expect(result.context?.used).toBe(60000);expect(result.summary.calls).toBe(1);
    db.exec('DELETE FROM gen_metadata');expect(reader.read(id).context).toBeNull();db.close();
  });
  it('does not multiply cached call totals across scans',()=>{
    const now=Date.now(),call=decodeTokenCall(metadata(),0,now)!;
    expect(summarizeCalls([call],7,now).total).toBe(10500);
    expect(summarizeCalls([{...call,time:now-31*86400000}],30,now).calls).toBe(0);
  });
});

describe('quota history',()=>{
  it('stores only allowlisted metrics, skips unknown fractions and deduplicates snapshots',()=>{
    const root=temp(),at=Date.now(),quota={checkedAt:at,rawResponse:{accessToken:'secret'},groups:[{displayName:'Gemini',buckets:[{id:'main',remainingFraction:.5},{id:'unknown'},{id:'invalid',remainingFraction:2}]}]};
    recordQuota(root,'account',quota);recordQuota(root,'account',quota);
    const text=fs.readFileSync(path.join(root,'quota-history.json'),'utf8');expect(text).not.toContain('secret');expect(JSON.parse(text)).toHaveLength(1);
    expect(getQuotaHistory(root,[]).rows).toHaveLength(0);expect(getQuotaHistory(root,['account']).rows).toHaveLength(1);
  });
  it('requires sufficient declining samples and invalidates forecasts after reset or stale data',()=>{
    const now=Date.now();const points=[.9,.8,.7].map((remaining,i)=>({at:now-(2-i)*1800000,remaining,account:'a',group:'g',bucket:'b',label:'Gemini'}));
    expect(summarizeQuota(points,now)[0].etaMs).toBeGreaterThan(0);
    expect(summarizeQuota(points,now+16*60000)[0].etaMs).toBeNull();
    expect(summarizeQuota([...points,{...points[2],at:now+1,remaining:1}],now+1)[0].etaMs).toBeNull();
    expect(summarizeQuota(points.slice(1),now)[0].etaMs).toBeNull();
  });
});

describe('storage cleanup preview',()=>{
  it('keeps conversations, fresh files and changed files; consumes the preview once',async()=>{
    const root=temp(),user=path.join(root,'user'),gemini=path.join(root,'gemini');
    fs.mkdirSync(path.join(user,'logs'),{recursive:true});fs.mkdirSync(path.join(gemini,'conversations'),{recursive:true});
    const old=path.join(user,'logs','old.log'),changed=path.join(user,'logs','changed.log');
    for(const file of [old,changed,path.join(user,'logs','fresh.log'),path.join(gemini,'conversations','chat.db')])fs.writeFileSync(file,'keep or trash');
    const past=new Date(Date.now()-8*86400000);for(const file of [old,changed])fs.utimesSync(file,past,past);
    const scan=await inspectStorage(gemini,user);expect(scan.candidates).toBe(2);expect(scan.rows.find(r=>r.name==='Conversation databases')?.reclaimable).toBe(0);
    fs.appendFileSync(changed,'changed');const trash=vi.fn(async()=>{});const result=await cleanStorage(scan.id,trash);
    expect(result.removed).toBe(1);expect(result.skipped).toBe(1);expect(trash).toHaveBeenCalledWith(old);
    await expect(cleanStorage(scan.id,trash)).rejects.toThrow('expired');
  });
  it('rejects expired previews without deleting anything',async()=>{
    const root=temp(),scan=await inspectStorage(root,path.join(root,'user'),Date.now()-11*60000),trash=vi.fn();
    await expect(cleanStorage(scan.id,trash)).rejects.toThrow('expired');expect(trash).not.toHaveBeenCalled();
  });
});
