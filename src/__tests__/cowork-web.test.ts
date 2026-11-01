import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';
const source=readFileSync('src/customPreload.ts','utf8');
const block=source.slice(source.indexOf('type CoworkInvoke'),source.indexOf('let coworkView: CoworkView'));
const compiled=ts.transpileModule('const CLAUDE_ICONS={spark:"<svg></svg>"};\n'+block+'\nglobalThis.CoworkTest={CoworkView,safeWebContent};',{compilerOptions:{target:ts.ScriptTarget.ES2020,module:ts.ModuleKind.CommonJS}}).outputText;
const windows:JSDOM[]=[];
afterEach(()=>windows.splice(0).forEach(d=>d.window.close()));
const settle=async()=>{for(let i=0;i<12;i++)await Promise.resolve();};
function fixture(){
 const dom=new JSDOM('<nav role="navigation" aria-label="Sidebar"><div id="agy-claude-sidebar-header"></div><div id="native-history">Code chat</div><button id="agy-claude-user-card"></button></nav><main><textarea id="code-draft">Code draft stays</textarea></main>',{url:'http://localhost/',runScripts:'outside-only'});windows.push(dom);dom.window.document.body.classList.add('agy-theme-claude');
 const state={ready:true,busy:false,model:'Argon',chatId:'web-one',conversations:[{id:'web-one',title:'Web one'},{id:'web-two',title:'Web two'}],messages:[{id:'0',role:'user',text:'Hello'},{id:'1',role:'assistant',text:'Answer',html:'<p>Answer <strong>bold</strong></p><script>window.pwned=1</script><img src="https://evil.invalid/track"><a href="javascript:alert(1)" onclick="alert(1)">bad</a><pre><code>const x=1;</code></pre>'}]};
 const invoke=vi.fn(async(channel:string,...args:any[])=>{
  if(channel==='gemini-web:snapshot')return structuredClone(state);
  if(channel==='gemini-web:navigate'){state.chatId=args[0];return structuredClone(state);}
  if(channel==='gemini-web:models')return args[0]?[{name:'High',description:'Deep',selected:true}]:[{name:'4 Argon',description:'Complex tasks',selected:true},{name:'Effort',submenu:true}];
  if(channel==='gemini-web:select-model')return structuredClone(state);
  if(channel==='gemini-web:ask')return {text:'4'};
  if(channel==='gemini-web:edit')return {success:true};
  if(channel==='gemini-web:pick-files')return [{id:'selected-file',name:'photo.png',size:100,preview:'data:image/png;base64,AA=='}];
  if(channel==='gemini-web:tools')return [{name:'Create video',disabled:false}];
  if(channel==='gemini-web:select-tool')return {success:true};
  if(channel==='gemini-web:media')return {dataUrl:'data:video/mp4;base64,AA=='};
  throw new Error(channel);
 });
 const context=dom.getInternalVMContext();runInContext(compiled,context);const view=new (dom.window as any).CoworkTest.CoworkView(invoke);
 return {dom,document:dom.window.document,view,invoke,state};
}
describe('Gemini Web Cowork renderer',()=>{
 it('keeps the chat mounted when the native sidebar temporarily disappears',async()=>{
  const f=fixture();f.view.sync(true);await settle();const root=f.document.querySelector('#agy-cowork-root'),sidebar=f.document.querySelector('#agy-cowork-chats'),native=f.document.querySelector('nav')!;
  native.remove();f.view.sync(true);expect(f.document.querySelector('#agy-cowork-root')).toBe(root);
  f.document.body.prepend(native);f.view.sync(true);expect(f.document.querySelector('#agy-cowork-root')).toBe(root);expect(f.document.querySelector('#agy-cowork-chats')).toBe(sidebar);
 });
 it('does not bubble Web chat clicks to native sidebar navigation handlers',async()=>{
  const f=fixture();f.view.sync(true);await settle();const nativeClick=vi.fn();f.document.querySelector('nav')!.addEventListener('click',nativeClick);
  f.document.querySelector<HTMLButtonElement>('#agy-cowork-chats button')!.click();await settle();expect(nativeClick).not.toHaveBeenCalled();
 });
 it('preserves sidebar rows, message nodes and scroll position on unchanged refreshes',async()=>{
  const f=fixture();f.view.sync(true);await settle();
  const sidebar=f.document.querySelector('#agy-cowork-chats')!,row=sidebar.querySelector('button'),thread=f.document.querySelector<HTMLElement>('.agy-cowork-thread')!,message=thread.querySelector('article');
  Object.defineProperty(thread,'scrollHeight',{value:1000,configurable:true});Object.defineProperty(thread,'clientHeight',{value:300,configurable:true});thread.scrollTop=120;
  await f.view.refresh();await settle();
  expect(f.document.querySelector('#agy-cowork-chats')).toBe(sidebar);expect(sidebar.querySelector('button')).toBe(row);expect(thread.querySelector('article')).toBe(message);expect(thread.scrollTop).toBe(120);
  f.state.messages[1].text='Updated answer';f.state.messages[1].html='<p>Updated answer</p>';
  await f.view.refresh();expect(thread.querySelector('article')).toBe(message);expect(thread.querySelectorAll('article')[1].textContent).toContain('Updated answer');
 });
 it('keeps the old chat visible with a spinner until the requested chat is ready',async()=>{
  const f=fixture();f.view.sync(true);await settle();const thread=f.document.querySelector('.agy-cowork-thread')!,message=thread.querySelector('article'),row=f.document.querySelector('#agy-cowork-chats button');
  let resolveNavigation:(value:any)=>void;
  f.invoke.mockImplementation(async(channel:string,...args:any[])=>channel==='gemini-web:navigate'?new Promise(resolve=>{resolveNavigation=resolve;}):structuredClone(f.state));
  const pending=f.view.navigate('web-two');await settle();
  expect(message?.isConnected).toBe(true);expect(f.document.querySelector('#agy-cowork-chats button')).toBe(row);expect(f.document.querySelector('.agy-cowork-loading')).not.toBeNull();expect(f.document.querySelector('#agy-cowork-root')?.getAttribute('aria-busy')).toBe('true');
  resolveNavigation!({...structuredClone(f.state),chatId:'web-two',messages:[{id:'0',role:'user',text:'Second chat'}]});await pending;
  expect(f.document.querySelector('.agy-cowork-loading')).toBeNull();expect(thread.textContent).toContain('Second chat');
  const back=f.view.navigate('web-one');await settle();expect(thread.querySelector('article')).toBe(message);
  resolveNavigation!(structuredClone(f.state));await back;
 });
 it('preserves an already loaded video element when an unrelated message changes',async()=>{
  const f=fixture();(f.state.messages[1] as any).media=[{id:'0',kind:'video',label:'Video'}];f.view.sync(true);await settle();f.document.querySelector<HTMLButtonElement>('.agy-cowork-media button')!.click();await settle();
  const video=f.document.querySelector('video');f.state.messages[0].text='Changed user text';await f.view.refresh();expect(f.document.querySelector('video')).toBe(video);
  f.state.messages[1].text='Updated video caption';f.state.messages[1].html='<p>Updated video caption</p>';await f.view.refresh();expect(f.document.querySelector('video')).toBe(video);
 });
 it('renders tool status and a playable media result without an empty disclosure',async()=>{
  const f=fixture();(f.state.messages[1] as any).activities=['Creating video'];(f.state.messages[1] as any).media=[{id:'0',kind:'video',label:'Generated video'}];
  f.view.sync(true);await settle();expect(f.document.querySelector('.agy-cowork-activity')?.textContent).toBe('Creating video');expect(f.document.querySelector('details.agy-cowork-activity')).toBeNull();
  f.document.querySelector<HTMLButtonElement>('.agy-cowork-media button')!.click();await settle();
  expect(f.invoke).toHaveBeenCalledWith('gemini-web:media','1','0','web-one');expect(f.document.querySelector<HTMLVideoElement>('.agy-cowork-media video')?.controls).toBe(true);
 });
 it('uses valid SVG actions and supports editing through the native Web action',async()=>{
  const f=fixture();f.view.sync(true);await settle();
  const copy=f.document.querySelector('.agy-cowork-actions button[aria-label="Copy response"]')!;
  expect(copy.querySelector('rect')?.getAttribute('rx')).toBe('1');expect(copy.querySelector('rect')?.children.length).toBe(0);
  f.document.querySelector<HTMLButtonElement>('[aria-label="Edit message"]')!.click();
  const editor=f.document.querySelector<HTMLTextAreaElement>('.agy-cowork-edit')!;editor.value='Edited prompt';
  Array.from(f.document.querySelectorAll<HTMLButtonElement>('.agy-cowork-actions button')).find(e=>e.textContent==='Save & send')!.click();await settle();
  expect(f.invoke).toHaveBeenCalledWith('gemini-web:edit','0','Edited prompt','web-one');
 });
 it('previews selected files, submits their approved IDs and exposes Web tools',async()=>{
  const f=fixture();f.view.sync(true);await settle();
  f.document.querySelector<HTMLButtonElement>('.agy-cowork-files')!.click();await settle();
  expect(f.document.querySelector('.agy-cowork-attachment img')).not.toBeNull();
  f.document.querySelector<HTMLTextAreaElement>('#agy-cowork-root textarea')!.value='Look at this photo';
  f.document.querySelector('form')!.dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));await settle();
  expect(f.invoke).toHaveBeenCalledWith('gemini-web:ask','Look at this photo','web-one',['selected-file']);
  f.document.querySelector<HTMLButtonElement>('.agy-cowork-plus')!.click();await settle();
  expect(f.document.querySelector('.agy-cowork-menu')!.textContent).toContain('Create video');
 });
 it('shows Web chats and sanitized messages while preserving Code DOM and draft',async()=>{
  const f=fixture();f.view.sync(true);await settle();
  expect(f.document.querySelector('#agy-cowork-chats')!.textContent).toContain('Web two');
  const root=f.document.querySelector('#agy-cowork-root')!;
  expect(root.textContent).toContain('Argon');expect(root.querySelector('strong')?.textContent).toBe('bold');
  expect(root.querySelector('script,img,[onclick]')).toBeNull();expect(root.querySelector('a')?.hasAttribute('href')).toBe(false);
  expect(root.querySelector('pre code')?.textContent).toBe('const x=1;');
  f.view.sync(false);expect(f.document.querySelector('#agy-cowork-root')).toBeNull();expect(f.document.querySelector('#native-history')?.isConnected).toBe(true);
  expect(f.document.querySelector<HTMLTextAreaElement>('#code-draft')!.value).toBe('Code draft stays');
 });
 it('keeps its draft across mode switches and submits to the expected Web chat',async()=>{
  const f=fixture();f.view.sync(true);await settle();let input=f.document.querySelector<HTMLTextAreaElement>('#agy-cowork-root textarea')!;input.value='Question';
  f.view.sync(false);f.view.sync(true);await settle();input=f.document.querySelector<HTMLTextAreaElement>('#agy-cowork-root textarea')!;
  expect(input.value).toBe('Question');
  f.document.querySelector('#agy-cowork-root form')!.dispatchEvent(new f.dom.window.Event('submit',{bubbles:true,cancelable:true}));await settle();
  expect(f.invoke).toHaveBeenCalledWith('gemini-web:ask','Question','web-one');expect(input.value).toBe('');
 });
 it('selects Web chats and uses real model and nested effort choices',async()=>{
  const f=fixture();f.view.sync(true);await settle();
  const chat=Array.from(f.document.querySelectorAll<HTMLButtonElement>('#agy-cowork-chats button')).find(b=>b.textContent==='Web two')!;chat.click();await settle();
  expect(f.invoke).toHaveBeenCalledWith('gemini-web:navigate','web-two');
  f.document.querySelector<HTMLButtonElement>('.agy-cowork-model')!.click();await settle();
  expect(f.document.querySelector('.agy-cowork-menu [aria-checked=true]')?.textContent).toContain('4 Argon');
  const effort=Array.from(f.document.querySelectorAll<HTMLButtonElement>('.agy-cowork-menu button')).find(b=>b.textContent==='Effort')!;effort.click();await settle();
  expect(f.invoke).toHaveBeenCalledWith('gemini-web:models','Effort');
  f.document.querySelector<HTMLButtonElement>('.agy-cowork-menu[data-submenu] button')!.click();await settle();
  expect(f.invoke).toHaveBeenCalledWith('gemini-web:select-model','High','Effort');expect(f.document.querySelector('.agy-cowork-model')?.textContent).toContain('High');
 });
 it('retains the prompt on errors and does not resend automatically',async()=>{
  const f=fixture();f.view.sync(true);await settle();f.invoke.mockImplementation(async(channel:string)=>channel==='gemini-web:ask'?{success:false,error:'Web error'}:structuredClone(f.state));
  const input=f.document.querySelector<HTMLTextAreaElement>('#agy-cowork-root textarea')!;input.value='Keep me';f.document.querySelector('form')!.dispatchEvent(new f.dom.window.Event('submit',{cancelable:true}));await settle();
  expect(input.value).toBe('Keep me');expect(f.document.querySelector('.agy-cowork-error')?.textContent).toBe('Web error');
  expect(f.invoke.mock.calls.filter(c=>c[0]==='gemini-web:ask')).toHaveLength(1);
 });
});
