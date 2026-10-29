import type { CustomModel } from './proxy';
import * as fs from 'node:fs/promises';
import * as https from 'node:https';
import { fileURLToPath } from 'node:url';
import { authenticatedGoogleFileUrl } from './proxy/loopbackSecurity';
import type { GeminiBody } from './proxy/requestOptions';

export async function resolveFallbackFiles(body: GeminiBody, authorization: string): Promise<void> {
  let total = 0;
  const limit = 20 * 1024 * 1024;
  for (const content of body.contents || []) for (const part of content.parts || []) {
    const file = part.fileData as {fileUri?:string;mimeType?:string} | undefined;
    if (!file) continue;
    if (!file.fileUri || !file.mimeType) throw new Error('Incomplete attachment reference');
    let data: Buffer;
    if (file.fileUri.startsWith('file://')) {
      const filename = fileURLToPath(file.fileUri);
      const stat = await fs.stat(filename);
      if (!stat.isFile() || stat.size + total > limit) throw new Error('Attachment exceeds fallback limit');
      data = await fs.readFile(filename);
    } else {
      const url = authenticatedGoogleFileUrl(file.fileUri);
      if (!url || !authorization) throw new Error('Attachment cannot be resolved for fallback');
      data = await new Promise<Buffer>((resolve,reject) => {
        const request = https.request(url,{method:'GET',headers:{Authorization:authorization}},response=>{
          if(response.statusCode!==200){response.resume();reject(new Error('Attachment download failed'));return;}
          const chunks:Buffer[]=[];let bytes=0;
          response.on('data',(chunk:Buffer)=>{bytes+=chunk.length;if(bytes+total>limit)request.destroy(new Error('Attachment exceeds fallback limit'));else chunks.push(Buffer.from(chunk));});
          response.on('end',()=>resolve(Buffer.concat(chunks)));response.on('error',reject);
        });
        request.setTimeout(30000,()=>request.destroy(new Error('Attachment download timed out')));
        request.on('error',reject);request.end();
      });
    }
    total += data.length;
    if(total>limit)throw new Error('Attachments exceed fallback limit');
    delete part.fileData;
    part.inlineData={mimeType:file.mimeType,data:data.toString('base64')};
  }
}

export function isGeminiByok(model: Partial<CustomModel>): boolean {
  try {
    const url = new URL(model.apiUrl || '');
    return model.enabled !== false && model.provider === 'google' &&
      (!model.apiFormat || model.apiFormat === 'google') && /^gemini[-.]/i.test(model.externalModelName || '') &&
      typeof model.apiKey === 'string' && !!model.apiKey.trim() && model.apiKey !== 'none' &&
      !model.rawUrl && !model.gateway && !model.googleAccounts?.length &&
      url.protocol === 'https:' && url.hostname === 'generativelanguage.googleapis.com' &&
      !url.username && !url.password && !url.port && !url.search && !url.hash;
  } catch { return false; }
}

export function selectGeminiFallback(models: CustomModel[], selected: string | undefined, nativeModel: string | undefined): CustomModel | undefined {
  if (!selected || typeof nativeModel !== 'string' || !/^(?:models\/)?gemini[-.]/i.test(nativeModel)) return undefined;
  const match = models.find(model => model.name === selected && isGeminiByok(model));
  if (!match) return undefined;

  return { ...match, fallbackModels: [], contextWindow: undefined };
}

let uses = 0, lastUsedAt: number | null = null;
export function recordGeminiFallback(): void { uses++; lastUsedAt = Date.now(); }
export function geminiFallbackStatus() { return { uses, lastUsedAt }; }
