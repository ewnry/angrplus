import {describe,it,expect} from 'vitest';
import {createServer} from 'node:net';
import {diagnoseRuntime} from '../diagnostics';

describe('Local diagnostics',()=>{
  it('checks loopback services and exports only allowlisted non-secret fields',async()=>{
    const server=createServer(socket=>socket.end());
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{
      const port=(server.address() as any).port;
      const result=await diagnoseRuntime({root:'C:/private-fixture-path',appVersion:'2.26',patchVersion:'2.1.13',proxyPort:port,languageServerPort:port,
        accounts:[{email:'private@example.org',accessToken:'secret-token',lastQuota:{checkedAt:Date.now()}}] as any,
        models:[{enabled:true,apiKey:'secret-key',apiUrl:'https://private.invalid'}] as any,invalidModels:0,fallbackConfigured:false});
      expect(result.report.checks.find(check=>check.name==='Local proxy')?.status).toBe('ok');
      expect(result.report.checks.find(check=>check.name==='Language server')?.status).toBe('ok');
      const json=JSON.stringify(result);
      for(const secret of ['private-fixture-path','private@example.org','secret-token','secret-key','private.invalid'])expect(json).not.toContain(secret);
      expect(json).toContain('No provider requests');
    }finally{await new Promise<void>(resolve=>server.close(()=>resolve()));}
  });
  it('reports unavailable services and invalid config without provider calls',async()=>{
    const result=await diagnoseRuntime({root:'not-present',appVersion:'test',patchVersion:'test',proxyPort:-1,languageServerPort:70000,accounts:[],models:[],invalidModels:1,fallbackConfigured:false});
    expect(result.report.healthy).toBe(false);
    expect(result.report.checks.filter(check=>check.status==='warning').map(check=>check.name)).toEqual(expect.arrayContaining(['Local proxy','Language server','Custom models']));
  });
});
