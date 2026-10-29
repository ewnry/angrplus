import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { spawn } from 'node:child_process';

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
export const GEMINI_URL = 'https://gemini.google.com/app';
export function isGeminiPage(url: string): boolean {
  try { const u = new URL(url); return u.protocol === 'https:' && u.hostname === 'gemini.google.com' && u.pathname.startsWith('/app'); } catch { return false; }
}

class Cdp {
  private socket: WebSocket;
  private next = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  async connect(url: string) {
    const u = new URL(url);
    if (u.protocol !== 'ws:' || !['127.0.0.1', 'localhost'].includes(u.hostname)) throw new Error('Browser debugger must be on loopback.');
    this.socket = new WebSocket(url);
    this.socket.addEventListener('message', event => {
      let value: any; try { value = JSON.parse(String(event.data)); } catch { return; }
      const item = this.pending.get(value.id); if (!item) return;
      clearTimeout(item.timer); this.pending.delete(value.id);
      value.error ? item.reject(new Error(value.error.message)) : item.resolve(value.result);
    });
    this.socket.addEventListener('close', () => this.rejectAll());
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.socket.close(); reject(new Error('Browser connection timed out.')); }, 10000);
      this.socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      this.socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('Cannot connect to browser.')); }, { once: true });
    });
  }
  private rejectAll() {
    for (const item of this.pending.values()) { clearTimeout(item.timer); item.reject(new Error('Browser connection closed.')); }
    this.pending.clear();
  }
  call(method: string, params: any = {}, timeoutMs = 15000): Promise<any> {
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Browser operation timed out: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression: string, timeoutMs = 15000) {
    const result = await this.call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (result.exceptionDetails) throw new Error('Gemini Web page operation failed.');
    return result.result?.value;
  }
  close() { this.rejectAll(); this.socket?.close(); }
}


export function inspectGeminiPage() {
  const visible = (e: Element) => !!(e as HTMLElement).getClientRects().length;
  const editor = Array.from(document.querySelectorAll('rich-textarea [contenteditable="true"], [contenteditable="true"][role="textbox"]')).find(visible);
  const responses = Array.from(document.querySelectorAll('model-response')).filter(visible);
  const last = responses[responses.length - 1];
  const body = last?.querySelector('message-content') || last?.querySelector('.model-response-text') || last;
  const stop = Array.from(document.querySelectorAll('button')).some(e => visible(e) && /stop|остановить/i.test(`${e.getAttribute('aria-label')} ${e.getAttribute('data-test-id')}`));
  const send = Array.from(document.querySelectorAll('button')).find(e => visible(e) && (e.matches('[data-test-id="send-button"], .send-button') || /^(send message|send|отправить сообщение|отправить)$/i.test(e.getAttribute('aria-label') || '')));
  const model = document.querySelector('[data-test-id="bard-mode-menu-button"], .bard-mode-menu-button, button[aria-label*="model"]');
  const alerts = Array.from(document.querySelectorAll('[role="alert"], .error-message, .response-error')).filter(visible).map(e => e.textContent?.trim()).filter(Boolean);
  const generating=last&&Array.from(last.querySelectorAll('[role="progressbar"],mat-progress-spinner,.generation-status.loading')).some(visible);
  const mediaCount=last?.querySelectorAll('img[src],video,audio').length||0;
  return { url: location.href, ready: !!editor, busy: !!stop||!!generating, responseCount: responses.length, text: (body as HTMLElement)?.innerText?.trim() || '', model: model?.textContent?.trim() || null, sendReady: !!send && !(send as HTMLButtonElement).disabled, alerts, mediaCount };
}

export function snapshotGeminiPage() {
  const conversations: { id: string; title: string }[] = [];
  const seen = new Set<string>();
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    let url: URL; try { url = new URL(anchor.href); } catch { continue; }
    const match = /^\/app\/([a-zA-Z0-9_-]+)$/.exec(url.pathname);
    if (url.origin !== 'https://gemini.google.com' || !match || seen.has(match[1])) continue;
    const title = anchor.innerText?.trim(); if (!title) continue;
    seen.add(match[1]); conversations.push({ id: match[1], title: title.slice(0, 500) });
  }
  const messages = Array.from(document.querySelectorAll('user-query,model-response')).map((node, index) => {
    const user = node.tagName.toLowerCase() === 'user-query';
    const body = user ? node.querySelector('.query-text, .query-content, user-query-content') || node : node.querySelector('message-content, .model-response-text');
    let text = (body as HTMLElement)?.innerText?.trim() || '';
    if (user) {
      const lines = Array.from(body.querySelectorAll<HTMLElement>('.query-text-line'));
      if (lines.length) text = lines.map(line => line.innerText || line.textContent || '').join('\n').trim();
      else { const copy = body.cloneNode(true) as HTMLElement; copy.querySelectorAll('.cdk-visually-hidden,[aria-hidden="true"],button').forEach(e => e.remove()); text = copy.textContent?.trim() || ''; }
    }
    const media = Array.from(node.querySelectorAll<HTMLImageElement|HTMLVideoElement|HTMLAudioElement>('img,video,audio')).filter(e=>e.tagName!=='IMG'||!!e.closest('generated-image,single-image')||(!/avatar|profile|icon/i.test(e.className||'')&&((e as HTMLImageElement).naturalWidth>24||(!e.closest('button')&&(e as HTMLImageElement).naturalWidth===0)))).map((e,i)=>{const src=(e as any).currentSrc||e.getAttribute('src')||e.querySelector('source')?.getAttribute('src')||'';let hash=0;for(let c=0;c<src.length;c++)hash=(hash*31+src.charCodeAt(c))|0;return {id:String(i),kind:e.tagName.toLowerCase(),label:e.getAttribute('alt')||e.getAttribute('aria-label')||'',width:(e as HTMLImageElement).naturalWidth||0,height:(e as HTMLImageElement).naturalHeight||0,revision:String(hash),src};}).filter(e=>e.src);
    const activities = Array.from(node.querySelectorAll<HTMLElement>('[role="status"], [role="progressbar"], .tool-status, .generation-status')).map(e=>e.innerText?.trim()||e.getAttribute('aria-label')||'').filter(Boolean);
    return { id: String(index), role: user ? 'user' : 'assistant', text, html: user ? '' : body?.innerHTML?.slice(0, 1000000) || '', media, activities };
  });
  const dialogs=Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"]')).filter(e=>e.getClientRects().length).map(e=>({text:e.innerText?.trim().slice(0,3000)||'',actions:Array.from(e.querySelectorAll<HTMLButtonElement>('button')).filter(b=>b.getClientRects().length).map(b=>({name:b.innerText.trim()||b.getAttribute('aria-label')||'',disabled:b.disabled})).filter(b=>b.name)}));
  return { conversations, messages, dialogs, chatId: /^\/app\/([a-zA-Z0-9_-]+)$/.exec(location.pathname)?.[1] || '', url: location.href };
}

function menuItemsInPage() {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"], [role="menuitemradio"], [role="option"]')).filter(e => e.getClientRects().length).map(e => {
    const lines = e.innerText.trim().split('\n').map(v => v.trim()).filter(Boolean);
    return { name: lines[0] || '', description: lines.slice(1).join(' '), selected: e.getAttribute('aria-checked') === 'true' || e.getAttribute('aria-selected') === 'true' || !!e.querySelector('[data-mat-icon-name="check"]'), disabled: e.getAttribute('aria-disabled') === 'true', submenu: e.getAttribute('aria-haspopup') === 'menu' || /reasoning|effort|уровень|рассуждени/i.test(lines[0] || '') };
  }).filter(e => e.name);
}

export class GeminiWeb {
  readonly profile: string;
  private busy = false;
  private activeRequest: AbortController;
  constructor(root = path.join(os.homedir(), '.gemini', 'antigravity')) { this.profile = path.join(root, 'gemini-web-profile'); }
  private async port(): Promise<number> {
    const raw = await fs.readFile(path.join(this.profile, 'DevToolsActivePort'), 'utf8');
    const port = Number(raw.split('\n')[0]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid dedicated browser port.');
    return port;
  }
  private async tabs(): Promise<any[]> {
    const port = await this.port();
    const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!response.ok) throw new Error('Dedicated browser is unavailable.');
    return response.json();
  }
  private async connect(): Promise<Cdp> {
    let tabs: any[];
    try { tabs = await this.tabs(); } catch {
      await this.open('background');
      for (let i = 0; i < 24; i++) { await pause(500); try { tabs = await this.tabs(); break; } catch {  } }
      if (!tabs) throw new Error('GEMINI_SIGN_IN_REQUIRED: Open sign-in, log in, then close the sign-in window. Cowork will reconnect automatically.');
    }
    const tab = tabs.find(t => t.type === 'page' && isGeminiPage(t.url));
    if (!tab) throw new Error('GEMINI_SIGN_IN_REQUIRED: Sign in to Google in the separate browser.');
    const cdp = new Cdp(); await cdp.connect(tab.webSocketDebuggerUrl); return cdp;
  }
  async open(mode: 'signin' | 'connect' | 'background' = 'signin'): Promise<any> {
    let restoreUrl = GEMINI_URL;
    try {
      const port = await this.port();
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
      const version: any = await response.json();
      if (mode !== 'signin') {
        if (mode === 'background' && !/HeadlessChrome/.test(version['User-Agent'] || '')) {
          const tab=(await this.tabs()).find(t=>t.type==='page'&&isGeminiPage(t.url));
          if(tab){const page=new Cdp();await page.connect(tab.webSocketDebuggerUrl);try{await this.ensureIdle(page);restoreUrl=tab.url;}catch{return {opened:true,message:'Existing Gemini request or draft preserved.'};}finally{page.close();}}
          const cdp = new Cdp(); await cdp.connect(version.webSocketDebuggerUrl);
          try { await cdp.call('Browser.close'); } catch {  } finally { cdp.close(); }
          await pause(1500);
        } else {
          return { opened: true, message: 'Dedicated browser is connected in the background.' };
        }
      } else {
        const cdp = new Cdp(); await cdp.connect(version.webSocketDebuggerUrl);
        try { await cdp.call('Browser.close'); } catch {  } finally { cdp.close(); }
        await pause(1500);
      }
    } catch {  }
    const candidates = process.platform === 'win32' ? [
      path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(process.env.LOCALAPPDATA || '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    ] : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'] : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge'];
    let browser: string;
    for (const candidate of candidates) { try { await fs.access(candidate); browser = candidate; break; } catch {  } }
    if (!browser) throw new Error('Install Chrome, Chromium or Edge to use Gemini Web.');
    await fs.mkdir(this.profile, { recursive: true, mode: 0o700 });
    const child = spawn(browser, [`--user-data-dir=${this.profile}`, ...(mode !== 'signin' ? ['--headless=new', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', '--disable-gpu', '--mute-audio', '--window-size=1100,800', '--disable-extensions', '--disable-sync'] : []), '--disable-background-mode', '--no-first-run', '--no-default-browser-check', restoreUrl], { detached: true, stdio: 'ignore', windowsHide: true });
    await new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    child.unref();
    return { opened: true, message: mode === 'signin' ? 'Sign in manually and choose the Web model. Then close this dedicated browser completely and call gemini_web_open with mode connect. No cookies need to be exported.' : 'Connecting to the saved browser session. Call gemini_web_status to check readiness. If the browser was already open without debugging, close its dedicated windows first and retry.' };
  }
  async status() {
    const cdp = await this.connect();
    try {
      const { text: _text, ...status } = await cdp.evaluate(`(${inspectGeminiPage.toString()})()`);
      return status;
    } finally { cdp.close(); }
  }
  async stop(){
    const cdp=await this.connect();
    try{const stopped=await cdp.evaluate(`(() => {const b=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length && /stop|остановить/i.test((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('data-test-id')||'')));if(!b)return false;b.click();return true;})()`);this.activeRequest?.abort();return {success:true,stopped};}finally{cdp.close();}
  }
  async snapshot() {
    const cdp = await this.connect();
    try {
      const state = await cdp.evaluate(`(${inspectGeminiPage.toString()})()`);
      const snapshot = await cdp.evaluate(`(${snapshotGeminiPage.toString()})()`);
      return { ...snapshot, messages:snapshot.messages.map((m:any)=>({...m,media:m.media.map(({src,...item}:any)=>item)})), ready: state.ready, busy: state.busy, model: state.model, alerts: state.alerts };
    } finally { cdp.close(); }
  }
  async media(messageId: string, mediaId: string, expectedChat: string) {
    const cdp=await this.connect();
    try {
      const state=await cdp.evaluate(`(${snapshotGeminiPage.toString()})()`);
      if(state.chatId!==expectedChat)throw new Error('Gemini conversation changed.');
      const media=state.messages.find((m:any)=>m.id===messageId)?.media.find((m:any)=>m.id===mediaId);
      if(!media)throw new Error('Media is no longer available.');
      const url=new URL(media.src);
      if(url.protocol!=='blob:' && (url.protocol!=='https:' || !/(^|\.)(googleusercontent\.com|googlevideo\.com|gstatic\.com|gemini\.google\.com)$/.test(url.hostname)))throw new Error('Unsupported Gemini media origin.');
      if(url.protocol==='https:'){
        let stream:string;
        try {
          const tree=await cdp.call('Page.getFrameTree');
          const result=await cdp.call('Network.loadNetworkResource',{frameId:tree.frameTree.frame.id,url:media.src,options:{disableCache:false,includeCredentials:true}},120000);
          const resource=result.resource;stream=resource?.stream;
          if(resource?.success&&stream){
            const headers=resource.headers||{};const key=Object.keys(headers).find(k=>k.toLowerCase()==='content-type');
            const mime=(key?String(headers[key]).split(';')[0]:'')||(media.kind==='video'?'video/mp4':media.kind==='audio'?'audio/mpeg':'image/png');
            if(!/^(image|video|audio)\//.test(mime))throw new Error('Unsupported media type.');
            const chunks:Buffer[]=[];let size=0;
            for(;;){const part=await cdp.call('IO.read',{handle:stream,size:1024*1024},120000);const chunk=Buffer.from(part.data,part.base64Encoded?'base64':'utf8');size+=chunk.length;if(size>64*1024*1024)throw new Error('Media exceeds 64 MB preview limit.');chunks.push(chunk);if(part.eof)break;}
            return {dataUrl:`data:${mime};base64,${Buffer.concat(chunks).toString('base64')}`,mime};
          }
        } finally {if(stream)await cdp.call('IO.close',{handle:stream}).catch(()=>{});}
      }
      return await cdp.evaluate(`(async()=>{const r=await fetch(${JSON.stringify(media.src)},{credentials:'include'});if(!r.ok)throw Error('Media download failed');const blob=await r.blob();if(blob.size>64*1024*1024)throw Error('Media exceeds 64 MB preview limit');if(!/^(image|video|audio)\\//.test(blob.type))throw Error('Unsupported media type');return await new Promise((resolve,reject)=>{const f=new FileReader();f.onload=()=>resolve({dataUrl:f.result,mime:blob.type});f.onerror=reject;f.readAsDataURL(blob);});})()`,120000);
    } finally { cdp.close(); }
  }
  async tools() {
    const cdp = await this.connect();
    try {
      await this.ensureIdle(cdp);
      await this.openTools(cdp);
      return await cdp.evaluate(`(() => {const seen=new Set();return [...document.querySelectorAll('[role="menu"] button,[role="menu"] [role="menuitem"],[role="menu"] [tabindex],[role="menu"] .mat-mdc-list-item')].filter(e=>e.getClientRects().length).map(e=>({name:e.innerText.trim().split('\\n')[0],disabled:e.getAttribute('aria-disabled')==='true'})).filter(e=>e.name && e.name.length<100 && !/загруз|upload|диск|drive|другие варианты/i.test(e.name) && !seen.has(e.name) && seen.add(e.name));})()`);
    } finally { await this.escape(cdp); cdp.close(); }
  }
  private async escape(cdp: Cdp) { await cdp.call('Input.dispatchKeyEvent', { type:'keyDown',key:'Escape',code:'Escape' }).catch(()=>{}); await cdp.call('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape'}).catch(()=>{}); }
  private async openTools(cdp: Cdp) {
    await this.escape(cdp);
    const point = await cdp.evaluate(`(() => {const b=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length && /^(Загрузка и инструменты|Uploads and tools|Tools|Инструменты)$/.test(e.getAttribute('aria-label')||''));if(!b)return null;const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
    if(!point)throw new Error('Gemini Web tools menu is unavailable.');
    await cdp.call('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
    await cdp.call('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    await pause(400);
  }
  async selectTool(name: string) {
    if(typeof name!=='string'||!name||name.length>100)throw new Error('Invalid Gemini tool.');
    const cdp=await this.connect();
    try { await this.ensureIdle(cdp);await this.openTools(cdp);
      const clicked=await cdp.evaluate(`(() => {const name=${JSON.stringify(name)};const e=[...document.querySelectorAll('[role="menu"] button,[role="menu"] [role="menuitem"],[role="menu"] [tabindex],[role="menu"] .mat-mdc-list-item')].find(e=>e.getClientRects().length && e.innerText.trim().split('\\n')[0]===name);if(!e)return false;e.click();return true;})()`);
      if(!clicked)throw new Error('The tool is no longer available in Gemini Web.');
      await pause(300);return this.snapshot();
    } finally { cdp.close(); }
  }
  async dialogAction(name:string){
    if(typeof name!=='string'||!name||name.length>300)throw new Error('Invalid dialog action.');
    const cdp=await this.connect();
    try{const clicked=await cdp.evaluate(`(() => {const b=[...document.querySelectorAll('[role="dialog"] button')].find(b=>b.getClientRects().length && (b.innerText.trim()||b.getAttribute('aria-label')||'')===${JSON.stringify(name)});if(!b||b.disabled)return false;b.click();return true;})()`);if(!clicked)throw new Error('The Gemini dialog changed. Refresh Cowork.');return {success:true};}finally{cdp.close();}
  }
  async attach(files: string[]) {
    if(!Array.isArray(files)||!files.length||files.length>10)throw new Error('Choose between 1 and 10 files.');
    for(const file of files){if(typeof file!=='string'||!path.isAbsolute(file))throw new Error('Invalid attachment path.');const stat=await fs.stat(file);if(!stat.isFile()||stat.size>100*1024*1024)throw new Error('Attachments must be files smaller than 100 MB.');}
    const cdp=await this.connect();
    try {
      await this.ensureIdle(cdp);await this.openTools(cdp);
      for(const group of [files.filter(f=>/\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(f)),files.filter(f=>! /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(f))]) {
        if(!group.length)continue;
        await this.openTools(cdp);
        const image=/\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(group[0]);
        const result=await cdp.call('Runtime.evaluate',{expression:`[...document.querySelectorAll('input[type="file"]')].find(e=>${image?`e.accept.includes('image')`:`!e.accept.includes('image')`})`,returnByValue:false});
        const objectId=result.result?.objectId;if(!objectId)throw new Error('Gemini upload input is unavailable for this file type.');
        await cdp.call('DOM.setFileInputFiles',{objectId,files:group});
      }
      await this.escape(cdp);await pause(1000);return {success:true};
    } finally { cdp.close(); }
  }
  async edit(index: number, text: string, expectedChat: string) {
    if(!Number.isInteger(index)||index<0||typeof text!=='string'||!text.trim()||text.length>100000)throw new Error('Invalid edited message.');
    const cdp=await this.connect();
    try {
      await this.ensureIdle(cdp);
      const clicked=await cdp.evaluate(`(() => {if(location.pathname!==${JSON.stringify('/app/'+expectedChat)})return false;const q=document.querySelectorAll('user-query,model-response')[${index}];if(q?.tagName.toLowerCase()!=='user-query')return false;const b=[...q.querySelectorAll('button')].find(b=>/^(Изменить|Редактировать|Edit)$/i.test(b.getAttribute('aria-label')||''));if(!b)return false;b.click();return true;})()`);
      if(!clicked)throw new Error('This message cannot be edited in the current Gemini Web conversation.');
      await pause(200);
      const focused=await cdp.evaluate(`(() => {const e=[...document.querySelectorAll('user-query textarea,user-query [contenteditable="true"]')].find(e=>e.getClientRects().length);if(!e)return false;e.focus();if(e.tagName==='TEXTAREA')e.select();else{const s=getSelection(),r=document.createRange();r.selectNodeContents(e);s.removeAllRanges();s.addRange(r);}return true;})()`);
      if(!focused)throw new Error('Gemini edit field changed. Finish editing in the browser.');
      await cdp.call('Input.insertText',{text});
      const submitted=await cdp.evaluate(`(() => {const q=document.querySelectorAll('user-query,model-response')[${index}];const b=[...q.querySelectorAll('button')].find(e=>e.getClientRects().length && /^(Обновить|Сохранить|Отправить|Update|Save|Submit)$/i.test(e.innerText.trim()));if(!b||b.disabled)return false;b.click();return true;})()`);
      if(!submitted)throw new Error('Gemini edit was not submitted. Review it in the browser.');
      return {success:true};
    } finally { cdp.close(); }
  }
  private async ensureIdle(cdp: Cdp) {
    if (this.busy) throw new Error('Wait for the current Gemini request to finish.');
    let locked = false;
    try { await fs.access(path.join(this.profile, 'mcp-request.lock')); locked = true; } catch {  }
    if (locked) throw new Error('Another Gemini Web request is active.');
    const state = await cdp.evaluate(`(${inspectGeminiPage.toString()})()`);
    if (state.busy) throw new Error('Gemini Web is generating.');
    const draft = await cdp.evaluate(`[...document.querySelectorAll('rich-textarea [contenteditable="true"], [contenteditable="true"][role="textbox"]')].some(e=>e.innerText.trim())`);
    if (draft) throw new Error('Gemini Web has an unsent draft. Send or clear it in the browser first.');
  }
  async navigate(chatId = '') {
    if (typeof chatId !== 'string' || (chatId && !/^[a-zA-Z0-9_-]+$/.test(chatId))) throw new Error('Invalid Gemini chat ID.');
    const cdp = await this.connect();
    try {
      await this.ensureIdle(cdp);
      const before=await cdp.evaluate(`(${snapshotGeminiPage.toString()})()`);
      if(before.chatId===chatId&&(!chatId||before.messages.length))return this.snapshot();
      const targetPath='/app'+(chatId?'/'+chatId:'');
      const routed=await cdp.evaluate(`(() => {window.__agyPreviousGeminiTurn=document.querySelector('user-query');const a=[...document.querySelectorAll('a[href]')].find(a=>{try{return new URL(a.href).origin==='https://gemini.google.com'&&new URL(a.href).pathname===${JSON.stringify(targetPath)};}catch{return false;}});if(!a)return false;a.click();return true;})()`);
      if(!routed)await cdp.call('Page.navigate', { url: GEMINI_URL + (chatId ? '/' + chatId : '') });
      for (let i = 0; i < 40; i++) {
        await pause(500);
        try {
          const state = await cdp.evaluate(`(${inspectGeminiPage.toString()})()`);
          const current = await cdp.evaluate(`(${snapshotGeminiPage.toString()})()`);
          const stale=routed&&await cdp.evaluate(`!!window.__agyPreviousGeminiTurn && window.__agyPreviousGeminiTurn===document.querySelector('user-query')`);
          const emptyReply=current.messages.some((m:any)=>m.role==='assistant'&&!m.text?.trim()&&!m.media.length);
          if (state.ready && current.chatId === chatId && (chatId?current.messages.length>0:current.messages.length===0) && (!emptyReply||state.busy||i>=7) && (!stale||JSON.stringify(current.messages)!==JSON.stringify(before.messages))) {
            await cdp.evaluate('delete window.__agyPreviousGeminiTurn');
            return { ...current, messages:current.messages.map((m:any)=>({...m,media:m.media.map(({src,...item}:any)=>item)})), ready: true, busy: state.busy, model: state.model };
          }
        } catch {  }
      }
      throw new Error('Gemini chat is still loading. Refresh Cowork in a moment.');
    } finally { cdp.close(); }
  }
  private async openModelMenu(cdp: Cdp, parent = '') {
    await this.ensureIdle(cdp);
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    const opened = await cdp.evaluate(`(() => {const b=document.querySelector('[data-test-id="bard-mode-menu-button"]');if(!b)return false;b.click();return true;})()`);
    if (!opened) throw new Error('Gemini Web model selector is unavailable.');
    await pause(200);
    const rootItems = parent ? await cdp.evaluate(`(${menuItemsInPage.toString()})()`) : [];
    if (parent) {
      const selected = await this.clickMenuItem(cdp, parent); if (!selected) throw new Error('Web model submenu changed. Refresh the model list.');
      await pause(200);
    }
    return rootItems.map((item: any) => item.name);
  }
  private clickMenuItem(cdp: Cdp, name: string) {
    if (typeof name !== 'string' || !name || name.length > 200) throw new Error('Invalid Web menu choice.');
    return cdp.evaluate(`(() => {const name=${JSON.stringify(name)};const e=[...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"]')].find(e=>e.getClientRects().length && e.innerText.trim().split('\\n')[0].trim()===name);if(!e || e.getAttribute('aria-disabled')==='true')return false;e.click();return true;})()`);
  }
  async models(parent = '') {
    const cdp = await this.connect();
    try {
      const rootNames = await this.openModelMenu(cdp, parent);
      const items = await cdp.evaluate(`(${menuItemsInPage.toString()})()`);
      return parent ? items.filter((item: any) => !rootNames.includes(item.name)) : items;
    } finally {
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' }).catch(() => {});
      await cdp.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' }).catch(() => {});
      cdp.close();
    }
  }
  async selectModel(name: string, parent = '') {
    const cdp = await this.connect();
    try {
      await this.openModelMenu(cdp, parent);
      if (!await this.clickMenuItem(cdp, name)) throw new Error('Web model choice changed. Refresh the model list.');
      await pause(500);
    } finally { cdp.close(); }
    return this.snapshot();
  }
  async ask(prompt: string, signal?: AbortSignal, attachmentOnly = false) {
    if (typeof prompt !== 'string' || (!prompt.trim() && !attachmentOnly) || prompt.length > 100000) throw new Error('Prompt must contain 1–100000 characters.');
    if (this.busy) throw new Error('Another Gemini Web request is running. Wait for it to finish.');
    this.busy = true;
    this.activeRequest=new AbortController();signal=signal?AbortSignal.any([signal,this.activeRequest.signal]):this.activeRequest.signal;
    let cdp: Cdp;
    let lock: fs.FileHandle;
    const lockPath = path.join(this.profile, 'mcp-request.lock');
    try {
      signal?.throwIfAborted();
      cdp = await this.connect();
      try { lock = await fs.open(lockPath, 'wx', 0o600); }
      catch (error: any) {
        if (error.code !== 'EEXIST') throw error;
        const owner = Number(await fs.readFile(lockPath, 'utf8'));
        let alive = true;
        if (Number.isInteger(owner) && owner > 0) { try { process.kill(owner, 0); } catch (e: any) { if (e.code === 'ESRCH') alive = false; } }
        if (alive) throw new Error('Another Gemini Web MCP process is running a request.');
        await fs.unlink(lockPath); lock = await fs.open(lockPath, 'wx', 0o600);
      }
      await lock.writeFile(String(process.pid));
      const inspect = () => cdp.evaluate(`(${inspectGeminiPage.toString()})()`);
      const before = await inspect();
      if (!before.ready) throw new Error('Sign in to Gemini Web in the dedicated browser first.');
      if (before.busy) throw new Error('Gemini Web is already generating.');
      const focused = await cdp.evaluate(`(() => { const e = [...document.querySelectorAll('rich-textarea [contenteditable="true"], [contenteditable="true"][role="textbox"]')].find(e=>e.getClientRects().length); if(!e || e.innerText.trim()) return false; e.focus(); return true; })()`);
      if (!focused) throw new Error('The Gemini input already contains a draft, or its layout changed. Draft preserved.');
      await cdp.call('Input.insertText', { text: prompt });
      signal?.throwIfAborted();
      for(let i=0;i<150;i++){const state=await inspect();if(state.sendReady)break;if(state.alerts.length)throw new Error(state.alerts.join(' '));await pause(400);signal?.throwIfAborted();}
      const sent = await cdp.evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(e=>e.getClientRects().length && (e.matches('[data-test-id="send-button"], .send-button') || /^(send message|send|отправить сообщение|отправить)$/i.test(e.getAttribute('aria-label')||''))); if (!b || b.disabled) return false; b.click(); return true; })()`);
      if (!sent) throw new Error('Send button unavailable. Prompt left in browser; no automatic retry.');
      const deadline = Date.now() + 600000;
      let previous = '', stable = 0;
      while (Date.now() < deadline) {
        await pause(1000); signal?.throwIfAborted();
        const state = await inspect();
        if (!isGeminiPage(state.url)) throw new Error('Gemini navigated away. Check the browser; request was not retried.');
        if (state.alerts.length) throw new Error(`Gemini Web: ${state.alerts.join(' ').slice(0, 1000)}`);
        if (state.responseCount > before.responseCount && (state.text || state.mediaCount) && !state.busy) {
          const signature=state.text+':'+state.mediaCount;
          stable = signature === previous ? stable + 1 : 0; previous = signature;
          if (stable >= 3) {
            if (/^I seem to be encountering an error\.|^Something went wrong\b|^Произошла ошибка\b/i.test(state.text)) throw new Error(`Gemini Web returned an error: ${state.text.slice(0, 1000)}`);
            return { text: state.text, model: state.model, source: 'Gemini Web', url: state.url };
          }
        } else { stable = 0; previous = ''; }
      }
      throw new Error('Gemini Web response timed out. Check the browser before trying again; the request was not resent.');
    } finally {
      cdp?.close();
      if (lock) { await lock.close(); await fs.unlink(lockPath).catch(() => {}); }
      this.busy = false;
      this.activeRequest=undefined;
    }
  }
}
