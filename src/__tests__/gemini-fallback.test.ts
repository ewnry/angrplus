import {describe,it,expect} from 'vitest';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {isGeminiByok,selectGeminiFallback,resolveFallbackFiles} from '../geminiFallback';
import type {CustomModel} from '../proxy';

const model={name:'byok',displayName:'Gemini',description:'',provider:'google',apiKey:'fixture',apiUrl:'https://generativelanguage.googleapis.com',externalModelName:'gemini-flash'} satisfies CustomModel;
describe('Gemini fallback eligibility and context',()=>{
  it('accepts only enabled Gemini API-key models on the official endpoint',()=>{
    expect(isGeminiByok(model)).toBe(true);
    for(const change of [{provider:'anthropic'},{externalModelName:'claude-sonnet'},{apiKey:''},{apiKey:'none'},{enabled:false},{rawUrl:true},{gateway:true},{apiFormat:'openai'},
      {apiUrl:'http://generativelanguage.googleapis.com'},{apiUrl:'https://generativelanguage.googleapis.com.example.org'},
      {apiUrl:'https://user:pass@generativelanguage.googleapis.com'},{apiUrl:'https://generativelanguage.googleapis.com?key=unexpected'},
      {googleAccounts:[{id:'fixture'}]}]) expect(isGeminiByok({...model,...change} as any)).toBe(false);
  });
  it('requires explicit selection and a native Gemini request, without trimming history or following another fallback chain',()=>{
    expect(selectGeminiFallback([model],undefined,'gemini-flash')).toBeUndefined();
    expect(selectGeminiFallback([model],'byok','claude')).toBeUndefined();
    const original={...model,contextWindow:200,fallbackModels:['paid-other']};
    expect(selectGeminiFallback([original],'byok','models/gemini-flash')).toMatchObject({fallbackModels:[]});
    expect(selectGeminiFallback([original],'byok','gemini-flash')?.contextWindow).toBeUndefined();
    expect(original.contextWindow).toBe(200);
  });
  it('preserves binary attachments, system instructions and tool context',async()=>{
    const root=await mkdtemp(join(tmpdir(),'gemini-fallback-'));
    try{
      const filename=join(root,'attachment.bin');const binary=Buffer.from([0,255,128,1,0]);await writeFile(filename,binary);
      const body:any={systemInstruction:{parts:[{text:'instructions'}]},tools:[{functionDeclarations:[{name:'tool'}]}],contents:[{parts:[{text:'message'},{fileData:{fileUri:pathToFileURL(filename).href,mimeType:'application/octet-stream'}}]}]};
      await resolveFallbackFiles(body,'');
      expect(body.contents[0].parts[1]).toEqual({inlineData:{mimeType:'application/octet-stream',data:binary.toString('base64')}});
      expect(body.systemInstruction.parts[0].text).toBe('instructions');expect(body.tools).toHaveLength(1);
    }finally{await rm(root,{recursive:true,force:true});}
  });
  it('rejects unresolved attachments instead of silently dropping them or forwarding credentials to another host',async()=>{
    await expect(resolveFallbackFiles({contents:[{parts:[{fileData:{fileUri:'https://example.org/file',mimeType:'image/png'}}]}]},'Bearer fixture')).rejects.toThrow('cannot be resolved');
  });
});
