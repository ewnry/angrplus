import {afterEach,describe,it,expect,vi} from 'vitest';
import {JSDOM} from 'jsdom';import ts from 'typescript';import {readFileSync} from 'node:fs';import {resolve} from 'node:path';import {runInContext} from 'node:vm';
const source=ts.createSourceFile('preload.ts',readFileSync(resolve('src/customPreload.ts'),'utf8'),ts.ScriptTarget.Latest,true);
const fn=source.statements.find(n=>ts.isFunctionDeclaration(n)&&n.name?.text==='syncClaudeFilePreviewsInPage')!;
const code=ts.transpileModule(fn.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
const windows:JSDOM[]=[];afterEach(()=>windows.splice(0).forEach(w=>w.window.close()));
function fixture(kind='read',status=3){
 const dom=new JSDOM(`<body class="agy-theme-claude"><main><div data-agy-transcript="tool" data-agy-tool-kind="${kind}"><div data-agy-transcript="tool-trigger"><button data-uri="file:///C:/fixture/test.txt">test.txt</button><div class="shrink-0"></div></div></div></main></body>`,{runScripts:'outside-only'});windows.push(dom);
 const d=dom.window.document,root=d.querySelector('[data-agy-transcript=tool]')!,trigger=d.querySelector('[data-agy-transcript=tool-trigger]')!,file=d.querySelector('button')!;
 const step:any={status,metadata:{sourceTrajectoryStepInfo:{cascadeId:'fixture',stepIndex:14}},step:{case:'generic',value:{args:{},result:{stepRenderInfo:{titlePrefix:kind==='create'?'Created':'Read',titleParts:[{part:{case:'file',value:{uri:'file:///C:/fixture/test.txt'}}}]}}}}};
 const provider={stat:vi.fn(async()=>({type:1,size:30})),readFile:vi.fn(async()=>new TextEncoder().encode('one\n<img src=x>\nthree\n'))};
 const api={getCodeActionDiff:vi.fn(async()=>({diff:{unifiedDiff:{lines:[{type:2,text:'old'},{type:1,text:'new'}]}}}))};
 const providerFiber={memoizedProps:{value:new Map([['',provider]])}};
 const apiFiber={memoizedProps:{value:api},return:providerFiber};
 (trigger as any).__reactFiber$fixture={memoizedProps:{step},return:apiFiber};
 const context=dom.getInternalVMContext();Object.assign(context,{TextDecoder});runInContext(code,context);
 const sync=()=>runInContext('syncClaudeFilePreviewsInPage()',context);
 const opened=vi.fn();file.addEventListener('click',opened);
 return {dom,d,root,trigger,file,step,provider,api,opened,sync,toggle:()=>d.querySelector<HTMLButtonElement>('.agy-inline-file-toggle')!,pane:()=>d.querySelector<HTMLElement>('.agy-inline-file-preview')!};
}
describe('Claude inline file previews',()=>{
 it('loads only when the arrow is clicked and keeps the native file link independent',async()=>{
  const f=fixture();f.sync();f.sync();expect(f.d.querySelectorAll('.agy-inline-file-toggle')).toHaveLength(1);expect(f.provider.readFile).not.toHaveBeenCalled();
  f.file.click();expect(f.opened).toHaveBeenCalledOnce();expect(f.pane().hidden).toBe(true);
  f.toggle().click();await vi.waitFor(()=>expect(f.pane().querySelectorAll('.agy-inline-file-line')).toHaveLength(3));expect(f.toggle().querySelector('svg')).not.toBeNull();expect(f.pane().querySelector('.agy-inline-file-note')).toBeNull();
  expect(f.provider.readFile).toHaveBeenCalledWith('file:///C:/fixture/test.txt',{conversationId:'fixture',userInitiated:true});
  expect(f.pane().querySelector('img')).toBeNull();expect(f.pane().textContent).toContain('<img src=x>');expect(f.opened).toHaveBeenCalledOnce();
  expect(f.pane().querySelector('.agy-inline-file-path')?.textContent).toBe('C:\\fixture\\test.txt');
  f.toggle().click();expect(f.pane().hidden).toBe(true);f.toggle().click();expect(f.provider.readFile).toHaveBeenCalledOnce();
 });
 it('shows the saved diff for changes, including additions and removals',async()=>{
  const f=fixture('edit');f.sync();f.toggle().click();await vi.waitFor(()=>expect(f.pane().querySelectorAll('.agy-inline-file-line')).toHaveLength(2));
  expect(f.api.getCodeActionDiff).toHaveBeenCalledWith({cascadeId:'fixture',stepIndex:14});expect(f.pane().querySelector('[data-type=removed] code')?.textContent).toBe('old');expect(f.pane().querySelector('[data-type=added] code')?.textContent).toBe('new');expect(f.provider.readFile).not.toHaveBeenCalled();
 });
 it('falls back to saved created content without reading a changed disk file',async()=>{
  const f=fixture('create');f.api.getCodeActionDiff.mockRejectedValueOnce(new Error('Unavailable'));f.step.step.value.args.Content='saved\ncontent';
  f.sync();f.toggle().click();await vi.waitFor(()=>expect(f.pane().querySelectorAll('[data-type=added]')).toHaveLength(2));expect(f.pane().textContent).toContain('saved');expect(f.provider.readFile).not.toHaveBeenCalled();
 });
 it('respects native errors and size limits without opening the sidebar automatically',async()=>{
  const f=fixture();f.provider.stat.mockResolvedValueOnce({type:1,size:3*1024*1024});f.sync();f.toggle().click();await vi.waitFor(()=>expect(f.pane().textContent).toContain('too large'));expect(f.provider.readFile).not.toHaveBeenCalled();expect(f.opened).not.toHaveBeenCalled();
  f.toggle().click();f.provider.stat.mockRejectedValueOnce(new f.dom.window.Error('Access denied'));f.toggle().click();await vi.waitFor(()=>expect(f.pane().textContent).toContain('Access denied'));expect(f.provider.readFile).not.toHaveBeenCalled();
 });
 it('removes its controls and ignores late results when Claude mode is disabled',async()=>{
  const f=fixture();let done:any;f.provider.readFile.mockImplementationOnce(()=>new Promise(resolve=>done=resolve));f.sync();f.toggle().click();await vi.waitFor(()=>expect(f.provider.readFile).toHaveBeenCalledOnce());
  f.d.body.classList.remove('agy-theme-claude');f.sync();done(new TextEncoder().encode('late'));await Promise.resolve();await Promise.resolve();expect(f.d.querySelector('.agy-inline-file-preview')).toBeNull();expect(f.file.isConnected).toBe(true);
 });
 it('uses one-based line ranges from native file metadata',async()=>{
  const f=fixture();f.step.step.value.result.stepRenderInfo.titleParts[0].part.value.startLine=1;f.step.step.value.result.stepRenderInfo.titleParts[0].part.value.endLine=3;
  f.sync();f.toggle().click();await vi.waitFor(()=>expect(f.pane().querySelectorAll('.agy-inline-file-line')).toHaveLength(3));expect(f.pane().querySelector('.agy-inline-file-number')?.textContent).toBe('1');
 });
 it.each(['tool-group-collapsible','worked-for-collapsible'])('flattens a single finished file action in %s without reading until requested',testid=>{
  const f=fixture(),container=f.d.createElement('div'),button=f.d.createElement('button');button.dataset.testid=testid;button.setAttribute('aria-expanded','false');container.append(button);f.d.querySelector('main')!.append(container);
  (button as any).__reactFiber$fixture={memoizedProps:testid==='worked-for-collapsible'?{segment:{steps:[f.step]}}:{steps:[f.step]}};f.step.metadata.toolCall={name:'read_file'};
  button.addEventListener('click',()=>{const open=button.getAttribute('aria-expanded')!=='true';button.setAttribute('aria-expanded',String(open));if(open){container.append(f.d.createElement('div'));}else button.nextElementSibling?.remove();});
  f.sync();f.sync();expect(button.getAttribute('aria-expanded')).toBe('true');expect(container.hasAttribute('data-agy-single-file')).toBe(true);expect(f.provider.readFile).not.toHaveBeenCalled();
  f.d.body.classList.remove('agy-theme-claude');f.sync();expect(button.getAttribute('aria-expanded')).toBe('false');expect(container.hasAttribute('data-agy-single-file')).toBe(false);
 });
 it('does not preview failed or unfinished tools',()=>{for(const status of [1,2,4,6,7]){const f=fixture('read',status);f.sync();expect(f.toggle()).toBeNull();expect(f.provider.readFile).not.toHaveBeenCalled();}});
});
