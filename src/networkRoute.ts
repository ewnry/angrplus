import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import * as https from 'node:https';
import { app } from 'electron';
import { decryptString, encryptString } from './cryptoStore';
import { randomUUID } from 'node:crypto';
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

export type NetworkMode = 'direct' | 'socks4' | 'socks5' | 'http' | 'relay';
export interface NetworkSettings { mode: NetworkMode; endpoint: string; secret: string }
interface NetworkProfile extends NetworkSettings { id:string; name:string }
interface ProfileStore { activeId:string | null; profiles:NetworkProfile[] }
const HOSTS: Record<string,string> = {
  'daily-cloudcode-pa.googleapis.com': 'cloudcode',
  'cloudcode-pa.googleapis.com': 'cloudcode',
  'oauth2.googleapis.com': 'oauth',
  'www.googleapis.com': 'googleapis',
  'generativelanguage.googleapis.com': 'generative',
};

function filePath(): string {
  return path.join(app.getPath('home'), '.gemini', 'antigravity', 'network-route.json');
}
function loadStore(): ProfileStore {
  const file = filePath();
  if (!fs.existsSync(file)) return { activeId:null, profiles:[] };
  const data = JSON.parse(fs.readFileSync(file,'utf8'));
  const decrypt = (value: string) => value ? decryptString(value) : '';
  const entries = Array.isArray(data.profiles) ? data.profiles : data.mode && data.mode !== 'direct' ? [{id:'legacy',name:'Saved connection',...data}] : [];
  const profiles = entries.map((entry: any) => ({id:entry.id,name:entry.name,mode:entry.mode,endpoint:decrypt(entry.endpoint || ''),secret:decrypt(entry.secret || '')}));
  if (profiles.some((entry: NetworkProfile) => entry.endpoint.startsWith('DECRYPTION_FAILED') || entry.secret.startsWith('DECRYPTION_FAILED'))) throw new Error('Network credentials could not be decrypted');
  const activeId = Array.isArray(data.profiles) ? data.activeId || null : profiles[0]?.id || null;
  if (activeId && !profiles.some((entry: NetworkProfile) => entry.id === activeId)) throw new Error('Active network connection is missing');
  return {activeId,profiles};
}
function writeStore(store: ProfileStore): void {
  const file=filePath(); fs.mkdirSync(path.dirname(file),{recursive:true});
  const tmp=`${file}.${process.pid}.tmp`;
  const profiles=store.profiles.map(entry=>({...entry,endpoint:encryptString(entry.endpoint),secret:encryptString(entry.secret)}));
  fs.writeFileSync(tmp,JSON.stringify({version:2,activeId:store.activeId,profiles},null,2),{mode:0o600});
  fs.renameSync(tmp,file);
}
export function readSettings(): NetworkSettings {
  const store=loadStore();
  return store.profiles.find(entry=>entry.id===store.activeId) || {mode:'direct',endpoint:'',secret:''};
}
export function publicSettings(): {mode:NetworkMode;endpoint:string;hasSecret:boolean} {
  const settings = readSettings();
  let endpoint = settings.endpoint;
  if (endpoint) { const parsed = new URL(endpoint); parsed.username=''; parsed.password=''; endpoint=parsed.toString().replace(/\/$/,''); }
  return {mode:settings.mode,endpoint,hasSecret:!!settings.secret};
}
function validateSettings(input: NetworkSettings, previous?: NetworkSettings): NetworkSettings {
  if (!['direct','socks4','socks5','http','relay'].includes(input.mode)) throw new Error('Invalid network mode');
  let endpoint = input.endpoint.trim();
  let secret = input.secret || '';
  if (input.mode !== 'direct') {
    const url = new URL(endpoint);
    const allowed: Record<Exclude<NetworkMode,'direct'>,string[]> = { socks4:['socks4:','socks4a:'], socks5:['socks5:','socks5h:'], http:['http:','https:'], relay:['https:'] };
    if (!allowed[input.mode].includes(url.protocol) || !url.hostname || url.hash || url.search) throw new Error('Invalid server address for this mode');
    if (input.mode === 'relay' && (url.username || url.password)) throw new Error('Relay credentials must be entered in the key field');
    if (!url.username && !url.password && previous?.mode === input.mode && previous.endpoint) {
      const old = new URL(previous.endpoint);
      if (old.protocol === url.protocol && old.hostname === url.hostname && old.port === url.port && old.pathname === url.pathname) { url.username=old.username; url.password=old.password; }
    }
    endpoint = url.toString().replace(/\/$/,'');
    if (!secret && previous?.mode === input.mode && previous.endpoint === endpoint) secret=previous.secret;
    if (input.mode === 'relay' && !secret) throw new Error('Enter the relay key');
  } else { endpoint=''; secret=''; }
  return {mode:input.mode,endpoint,secret};
}
export function saveSettings(input: NetworkSettings): void {
  const store=loadStore();
  if (input.mode === 'direct') { store.activeId=null; writeStore(store); return; }
  const previous=store.profiles.find(entry=>entry.id===store.activeId);
  const settings=validateSettings(input,previous);
  if (previous) Object.assign(previous,settings);
  else { const profile={...settings,id:randomUUID(),name:'Saved connection'};store.profiles.push(profile);store.activeId=profile.id; }
  writeStore(store);
}
export function listProfiles(): {activeId:string|null; profiles:Array<{id:string;name:string;mode:NetworkMode;endpoint:string;hasSecret:boolean}>} {
  const store=loadStore();
  return {activeId:store.activeId,profiles:store.profiles.map(entry=>{
    const parsed=new URL(entry.endpoint); parsed.username='';parsed.password='';
    return {id:entry.id,name:entry.name,mode:entry.mode,endpoint:parsed.toString().replace(/\/$/,''),hasSecret:!!entry.secret};
  })};
}
export function upsertProfile(input: NetworkSettings & {id?:string;name:string}): string {
  const store=loadStore(), previous=input.id ? store.profiles.find(entry=>entry.id===input.id) : undefined;
  if (input.id && !previous) throw new Error('Connection no longer exists');
  if (input.mode === 'direct') throw new Error('Direct connection does not need a profile');
  const name=typeof input.name==='string' ? input.name.trim().slice(0,80) : '';
  if (!name) throw new Error('Enter a connection name');
  const value=validateSettings(input,previous);
  const id = previous?.id || randomUUID();
  if (previous) Object.assign(previous,value,{name});
  else store.profiles.push({...value,id,name});
  writeStore(store);
  return id;
}
export function activateProfile(id:string|null): void {
  const store=loadStore(); if (id && !store.profiles.some(entry=>entry.id===id)) throw new Error('Connection no longer exists');
  store.activeId=id || null; writeStore(store);
}
export function deleteProfile(id:string): void {
  const store=loadStore(); if (!store.profiles.some(entry=>entry.id===id)) throw new Error('Connection no longer exists');
  store.profiles=store.profiles.filter(entry=>entry.id!==id); if (store.activeId===id) store.activeId=null; writeStore(store);
}
export function requestGoogle(urlValue: string | URL, options: https.RequestOptions, callback: (res:http.IncomingMessage)=>void): http.ClientRequest {
  const url = new URL(urlValue.toString());
  const host = url.hostname.toLowerCase();
  const route = HOSTS[host];
  if (!route || url.protocol !== 'https:') return https.request(url,options,callback);
  const cfg = readSettings();
  if (cfg.mode === 'direct') return https.request(url,options,callback);
  if (cfg.mode === 'relay') {
    const base = new URL(cfg.endpoint + '/');
    const target = new URL(`relay/${route}${url.pathname}${url.search}`,base);
    if (target.origin !== base.origin) throw new Error('Invalid relay target');
    const headers = { ...options.headers, 'x-agy-relay-key':cfg.secret } as http.OutgoingHttpHeaders;
    for (const key of Object.keys(headers)) if (key.toLowerCase()==='host') delete headers[key];
    return https.request(target,{...options,headers,rejectUnauthorized:true},callback);
  }
  const agent = cfg.mode === 'http' ? new HttpsProxyAgent(cfg.endpoint) : new SocksProxyAgent(cfg.endpoint);
  return https.request(url,{...options,agent},callback);
}
