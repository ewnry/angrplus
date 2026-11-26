import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as https from 'node:https';

const disk = vi.hoisted(() => ({ file:'', temporary:'' }));
vi.mock('electron', () => ({ app: { getPath: () => 'C:/fixture' } }));
vi.mock('../cryptoStore', () => ({ encryptString:(s:string) => s ? `enc:${s}` : '', decryptString:(s:string) => s.startsWith('enc:') ? s.slice(4) : s }));
vi.mock('node:fs', () => ({
  existsSync: () => !!disk.file,
  readFileSync: () => disk.file,
  mkdirSync: () => undefined,
  writeFileSync: (_path:string, content:string) => { disk.temporary=content; },
  renameSync: () => { disk.file=disk.temporary; },
}));
vi.mock('node:https', () => ({ request: vi.fn(() => ({})) }));
import { publicSettings, requestGoogle, saveSettings, listProfiles, upsertProfile, activateProfile, deleteProfile } from '../networkRoute';

beforeEach(() => { disk.file=''; disk.temporary=''; vi.clearAllMocks(); });
describe('Google network routing', () => {
  it('keeps direct mode and leaves unrelated providers untouched', () => {
    requestGoogle('https://daily-cloudcode-pa.googleapis.com/v1internal:test', {method:'POST'}, () => {});
    expect(vi.mocked(https.request)).toHaveBeenCalledTimes(1);
    expect((vi.mocked(https.request).mock.calls[0][1] as any).agent).toBeUndefined();
  });
  it('encrypts relay settings, routes the allowlisted Google host and keeps TLS verification', () => {
    saveSettings({mode:'relay',endpoint:'https://relay.example/base',secret:'private-key'});
    expect(JSON.parse(disk.file).profiles[0].secret).toBe('enc:private-key');
    expect(publicSettings()).toEqual({mode:'relay',endpoint:'https://relay.example/base',hasSecret:true});
    requestGoogle('https://daily-cloudcode-pa.googleapis.com/v1internal:test?alt=sse', {method:'POST',headers:{host:'daily-cloudcode-pa.googleapis.com',authorization:'Bearer local'},rejectUnauthorized:false}, () => {});
    const [url,options] = vi.mocked(https.request).mock.calls[0] as any;
    expect(url.toString()).toBe('https://relay.example/base/relay/cloudcode/v1internal:test?alt=sse');
    expect(options.headers.host).toBeUndefined();
    expect(options.headers['x-agy-relay-key']).toBe('private-key');
    expect(options.headers.authorization).toBe('Bearer local');
    expect(options.rejectUnauthorized).toBe(true);
    requestGoogle('https://example.org/path', {method:'GET'}, () => {});
    expect((vi.mocked(https.request).mock.calls[1][0] as URL).hostname).toBe('example.org');
  });
  it.each([['socks4','socks4a://proxy.example:1080'],['socks5','socks5://proxy.example:1080'],['http','http://proxy.example:8080']] as const)('sets up the %s proxy agent', (mode,endpoint) => {
    saveSettings({mode,endpoint,secret:''});
    requestGoogle('https://oauth2.googleapis.com/token',{method:'POST'},()=>{});
    expect((vi.mocked(https.request).mock.calls[0][1] as any).agent).toBeTruthy();
  });
  it('rejects non-HTTPS relays and does not expose proxy credentials', () => {
    expect(() => saveSettings({mode:'relay',endpoint:'http://relay.example',secret:'key'})).toThrow();
    saveSettings({mode:'socks5',endpoint:'socks5://user:password@proxy.example:1080',secret:''});
    expect(publicSettings().endpoint).not.toContain('password');
  });
  it('migrates an existing connection and supports independent profiles with safe activation and deletion', () => {
    disk.file=JSON.stringify({mode:'relay',endpoint:'enc:https://legacy.example',secret:'enc:legacy-key'});
    expect(readCurrent()).toBe('https://legacy.example');
    expect(listProfiles().activeId).toBe('legacy');
    upsertProfile({name:'Proxy',mode:'socks5',endpoint:'socks5://user:pass@proxy.example:1080',secret:''});
    const entries=listProfiles();expect(entries.profiles).toHaveLength(2);expect(entries.activeId).toBe('legacy');
    const added=entries.profiles.find(p=>p.name==='Proxy')!;
    activateProfile(added.id);expect(publicSettings().mode).toBe('socks5');
    upsertProfile({...added,name:'Updated',secret:''});
    expect(JSON.stringify(listProfiles())).not.toContain('pass');
    deleteProfile(added.id);expect(publicSettings().mode).toBe('direct');expect(listProfiles().profiles).toHaveLength(1);
  });
});
function readCurrent(){return publicSettings().endpoint;}
