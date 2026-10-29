import * as fs from 'node:fs';
import * as path from 'node:path';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

type Wire = Map<number, number | Uint8Array>;
export const CONVERSATION_ID = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;


export function wireFields(input: Uint8Array): Wire {
  if (input.length > 8 * 1024 * 1024) throw new Error('Metadata record too large');
  const fields: Wire = new Map(); let offset = 0;
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      if (offset >= input.length) throw new Error('Truncated metadata');
      const byte = input[offset++]; value |= BigInt(byte & 127) << shift;
      if (!(byte & 128)) return value;
    }
    throw new Error('Invalid varint');
  };
  while (offset < input.length) {
    const key = Number(varint()), tag = key >>> 3, type = key & 7;
    if (!tag) throw new Error('Invalid metadata tag');
    if (type === 0) {
      const value = varint();
      if (value <= BigInt(Number.MAX_SAFE_INTEGER)) fields.set(tag, Number(value));
    } else if (type === 2) {
      const length = Number(varint());
      if (!Number.isSafeInteger(length) || length < 0 || offset + length > input.length) throw new Error('Truncated field');
      fields.set(tag, input.subarray(offset, offset + length)); offset += length;
    } else if (type === 1 || type === 5) {
      offset += type === 1 ? 8 : 4;
      if (offset > input.length) throw new Error('Truncated scalar');
    } else throw new Error('Unsupported metadata wire type');
  }
  return fields;
}
const nested = (fields: Wire, tag: number): Wire => {
  const value = fields.get(tag); return value instanceof Uint8Array ? wireFields(value) : new Map();
};
const count = (fields: Wire, tag: number): number => typeof fields.get(tag) === 'number' ? fields.get(tag) as number : 0;
const label = (fields: Wire, tag: number): string => {
  const value = fields.get(tag);
  return value instanceof Uint8Array ? Buffer.from(value).toString('utf8').replace(/[\x00-\x1f]/g, '').slice(0, 120) : '';
};
export interface TokenCall {
  index: number; time: number; dateEstimated: boolean; model: string;
  input: number; cached: number; output: number; thinking: number; response: number; hasUsage: boolean;
  context?: { used: number; limit: number; source: 'server-estimate'; truncated: boolean };
}
export function decodeTokenCall(bytes: Uint8Array, index: number, fallbackTime: number): TokenCall | null {
  const model = nested(wireFields(bytes), 1);
  if (!model.size) return null;
  const usage = nested(model, 4), start = nested(model, 9), window = nested(start, 10);
  const time = fallbackTime;
  const input = count(usage, 2), cached = count(usage, 5), output = count(usage, 3);
  const limit = count(window, 4);
  return {
    index, time, dateEstimated: time === fallbackTime, model: label(model, 19) || `Model ${count(usage, 1) || count(model, 3) || 'unknown'}`,
    input, cached, output, thinking: count(usage, 9), response: count(usage, 10),
    hasUsage: [2, 3, 5, 9, 10].some(tag => usage.has(tag)),
    ...(limit > 0 ? { context: { used: Math.max(count(window, 1), input + cached), limit,
      source: 'server-estimate' as const, truncated: !!label(window, 3) } } : {}),
  };
}
export function summarizeCalls(calls: TokenCall[], days = 0, now = Date.now()) {
  const measured = calls.filter(call => call.hasUsage && (!days || call.time >= now - days * 86400000) && call.time <= now);
  const models: Record<string, { calls: number; input: number; cached: number; output: number; thinking: number }> = {};
  const daily: Record<string, number> = {};
  let input = 0, cached = 0, output = 0, thinking = 0;
  for (const call of measured) {
    input += call.input; cached += call.cached; output += call.output; thinking += call.thinking;
    const row = models[call.model] ||= { calls: 0, input: 0, cached: 0, output: 0, thinking: 0 };
    row.calls++; row.input += call.input; row.cached += call.cached; row.output += call.output; row.thinking += call.thinking;
    const date = new Date(call.time), key = `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
    daily[key] = (daily[key] || 0) + call.input + call.cached + call.output;
  }
  return { calls: measured.length, input, cached, output, thinking, total: input + cached + output,
    cacheRate: input + cached > 0 ? cached / (input + cached) : null, models, daily,
    approximateDates: measured.some(call => call.dateEstimated) };
}
const safeFile = (root: string, name: string) => {
  const full = path.resolve(root, name);
  if (path.dirname(full) !== path.resolve(root) || fs.lstatSync(full).isSymbolicLink()) throw new Error('Unsafe telemetry path');
  return full;
};

export class TelemetryReader {
  private cache = new Map<string, { signature: string; calls: TokenCall[]; modified: number; activity: {time:number; type:number}[] }>();
  constructor(private root: string) {}
  read(conversationId = '', days = 0) {
    if (conversationId && !CONVERSATION_ID.test(conversationId)) throw new Error('Invalid conversation ID');
    const { DatabaseSync } = require('node:sqlite');
    const dir = path.join(this.root, 'conversations');
    if (!fs.existsSync(dir)) return { success: true, checkedAt: Date.now(), summary: summarizeCalls([], days), context: null, sessions: 0, unavailable: 0 };
    if (fs.lstatSync(dir).isSymbolicLink()) throw new Error('Linked conversation directory is not supported');
    const names = fs.readdirSync(dir).filter(name => CONVERSATION_ID.test(name.replace(/\.db$/, '')) && name.endsWith('.db'));
    const ids = new Set(names.map(name => name.slice(0, -3)));
    for (const id of this.cache.keys()) if (!ids.has(id)) this.cache.delete(id);
    let unavailable = 0;
    for (const name of names) {
      const id = name.slice(0, -3); let db: any;
      try {
        const file = safeFile(dir, name), stat = fs.statSync(file);
        const wal = fs.existsSync(file + '-wal') ? fs.lstatSync(file + '-wal') : null;
        if (wal?.isSymbolicLink()) throw new Error('Linked WAL');
        const signature = `${stat.size}/${stat.mtimeMs}/${wal?.size}/${wal?.mtimeMs}`;
        if (this.cache.get(id)?.signature === signature) continue;
        db = new DatabaseSync(file, { readOnly: true });
        db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=200;');
        const rows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx LIMIT 50001').all();
        if (rows.length > 50000) throw new Error('Conversation metadata limit exceeded');
        const times = new Map<number, number>(), activity: {time:number; type:number}[] = [];
        for (const step of db.prepare('SELECT idx, step_type, metadata FROM steps LIMIT 50000').all()) {
          let time = stat.mtimeMs;
          try { const seconds = count(nested(wireFields(step.metadata), 1), 1); if (seconds >= 1577836800 && seconds < 4102444800) { time=seconds*1000; times.set(Number(step.idx), time); } } catch {  }
          if (step.step_type === 14 || step.step_type === 15) activity.push({time,type:step.step_type});
        }
        const calls: TokenCall[] = [];
        for (const row of rows) {
          try {
            const call = decodeTokenCall(row.data, Number(row.idx), stat.mtimeMs);
            if (!call) continue;
            const indices = wireFields(row.data).get(4);
            if (indices instanceof Uint8Array) {
              let value=0, shift=0;
              for (const byte of indices) {
                value+=(byte&127)*2**shift;
                if(byte&128){shift+=7;if(shift>49)break;continue;}
                const time=times.get(value);if(time){call.time=time;call.dateEstimated=false;break;}value=0;shift=0;
              }
            }
            calls.push(call);
          } catch { unavailable++; }
        }
        this.cache.set(id, { signature, calls, modified: stat.mtimeMs, activity });
      } catch { unavailable++; this.cache.delete(id); }
      finally { db?.close(); }
    }
    const active = this.cache.get(conversationId), last = active?.calls[active.calls.length - 1];
    const windows = active?.calls.filter(call => call.context) || [];
    let reductions = 0;
    for (let i = 1; i < windows.length; i++) {
      const previous = windows[i-1].context!, current = windows[i].context!;
      if (current.used < previous.used * 0.7 && previous.used - current.used > 5000) reductions++;
    }
    const daily: Record<string,number> = {}, hours = Array(24).fill(0);
    let messages=0, sessions=0;
    const cutoff=days ? Date.now()-days*86400000 : 0;
    for(const value of this.cache.values()) {
      const events=value.activity.filter(event=>event.time>=cutoff && event.time<=Date.now());
      if(events.length)sessions++;
      for(const event of events){messages++;const date=new Date(event.time),key=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;daily[key]=(daily[key]||0)+1;hours[date.getHours()]++;}
    }
    return { success: true, checkedAt: Date.now(), sessions: this.cache.size, unavailable,
      activity: { sessions,messages,daily,activeDays:Object.keys(daily).length,peakHour:hours.some(Boolean)?hours.indexOf(Math.max(...hours)):null },
      summary: summarizeCalls([...this.cache.values()].flatMap(item => item.calls), days),
      context: last?.context ? { ...last.context, model: last.model, savedAt: active!.modified, reductions,
        calls: active!.calls.filter(call => call.hasUsage).length,
        usage: summarizeCalls(active!.calls),
        timeline: windows.slice(-40).map(call => ({ index: call.index, used: call.context!.used, limit: call.context!.limit })) } : null };
  }
}

if (!isMainThread && workerData?.antigravityTelemetry === true) {
  const reader = new TelemetryReader(workerData.root);
  parentPort!.on('message', ({ id, conversationId, days }) => {
    try { parentPort!.postMessage({ id, result: reader.read(conversationId, days) }); }
    catch { parentPort!.postMessage({ id, result: { success: false, error: 'Local telemetry is unavailable in this runtime.' } }); }
  });
}
let worker: Worker | undefined, sequence = 0;
const pending = new Map<number, { resolve: (value: any) => void; timer: ReturnType<typeof setTimeout> }>();
export function readTelemetry(root: string, conversationId = '', days = 0): Promise<any> {
  if (conversationId && !CONVERSATION_ID.test(conversationId)) return Promise.resolve({ success: false, error: 'Invalid conversation ID' });
  if (![0, 7, 30].includes(days)) return Promise.resolve({ success: false, error: 'Invalid time range' });
  if (!worker) {
    worker = new Worker(__filename, { workerData: { antigravityTelemetry: true, root } });
    worker.unref();
    worker.on('message', ({ id, result }) => { const request = pending.get(id); if (request) { clearTimeout(request.timer); pending.delete(id); request.resolve(result); } });
    const fail = () => {
      worker = undefined;
      for (const request of pending.values()) { clearTimeout(request.timer); request.resolve({ success: false, error: 'Telemetry worker stopped.' }); }
      pending.clear();
    };
    worker.on('error', fail); worker.on('exit', fail);
  }
  if (pending.size >= 4) return Promise.resolve({ success: false, error: 'Telemetry scan is busy.' });
  return new Promise(resolve => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); resolve({ success: false, error: 'Telemetry scan timed out.' }); }, 20000);
    pending.set(id, { resolve, timer }); worker!.postMessage({ id, conversationId, days });
  });
}
