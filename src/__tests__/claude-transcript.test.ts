import {afterEach,describe,it,expect,vi} from 'vitest';
import {JSDOM} from 'jsdom';
import ts from 'typescript';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {runInContext} from 'node:vm';
const source=ts.createSourceFile('customPreload.ts',readFileSync(resolve('src/customPreload.ts'),'utf8'),ts.ScriptTarget.Latest,true);
const declaration=source.statements.find(node=>ts.isFunctionDeclaration(node)&&node.name?.text==='syncClaudeTranscriptInPage')!;
const compiled=ts.transpileModule(declaration.getText(source),{compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
const windows:JSDOM[]=[];afterEach(()=>windows.splice(0).forEach(dom=>dom.window.close()));
function fixture(){const dom=new JSDOM('<body class="agy-theme-claude"><main data-testid="autoscroll-viewport"></main></body>',{runScripts:'outside-only'});windows.push(dom);const context=dom.getInternalVMContext();runInContext(compiled,context);return {dom,document:dom.window.document,view:dom.window.document.querySelector('main')!,sync:()=>runInContext('syncClaudeTranscriptInPage()',context)};}
function attach(node:Element,props:any,parent?:any){(node as any).__reactFiber$fixture={memoizedProps:props,return:parent};}
function step(name:string,prefix:string,uri='file:///fixture/test.txt',diff?:{additions:number;deletions:number}){return {status:3,metadata:{toolCall:{name}},step:{case:'generic',value:{result:{stepRenderInfo:{titlePrefix:prefix,titleParts:[{part:{case:diff?'fileDiff':'file',value:{uri,...(diff?{diffStats:diff}:{})}}}]}}}}};}
describe('Claude native transcript skin',()=>{
 it('summarizes actual create/read steps and diff counts while keeping the native toggle',()=>{
  const f=fixture();f.view.innerHTML='<div><button data-testid="tool-group-collapsible" aria-expanded="false"><span>Explored, edited file</span><svg></svg></button></div>';
  const button=f.view.querySelector('button')!;const clicked=vi.fn();button.addEventListener('click',clicked);
  attach(button,{steps:[step('write_to_file','Created',undefined,{additions:2,deletions:0}),step('view_file','Read')],isRunning:false});
  f.sync();f.sync();expect(f.view.querySelectorAll('.agy-transcript-summary')).toHaveLength(1);
  expect(f.view.querySelector('.agy-tool-verb')?.textContent).toBe('Created and read');expect(f.view.querySelector('.agy-tool-file')?.textContent).toBe('test.txt');
  expect(f.view.querySelector('.agy-tool-added')?.textContent).toBe('+2');expect(f.view.querySelector('.agy-tool-removed')?.textContent).toBe('−0');button.click();expect(clicked).toHaveBeenCalledOnce();
  f.document.body.classList.remove('agy-theme-claude');f.sync();expect(f.view.querySelector('.agy-transcript-summary')).toBeNull();expect(button.textContent).toBe('Explored, edited file');expect(f.view.querySelector('[data-agy-transcript]')).toBeNull();
 });
 it('keeps unknown, failed and permission-waiting actions honest instead of claiming success',()=>{
  const f=fixture();f.view.innerHTML='<div><button data-testid="tool-group-collapsible"><span>Original status</span></button></div>';const button=f.view.querySelector('button')!;
  for(const steps of [[{step:{case:'unknown'},status:3}],[{...step('write_to_file','Created'),status:4}],[{...step('view_file','Read'),status:6}]]){attach(button,{steps,isRunning:false});f.sync();expect(button.textContent).toBe('Original status');}
 });
 it('uses real thinking text and duration without moving or replacing native disclosure content',()=>{
  const f=fixture();f.view.innerHTML='<div><button data-testid="thinking-collapsible-trigger" aria-expanded="false"><span>Thought for 13s</span><svg></svg></button><div id="native-content">Existing reasoning</div></div>';
  const button=f.view.querySelector('button')!;attach(button,{thinking:'I should check the existing files.\nThen read the result.'});
  f.sync();expect(f.view.querySelector('.agy-thought-preview')?.textContent).toBe('I should check the existing files.');expect(f.view.querySelector('.agy-transcript-duration')?.textContent).toBe('13s');expect(f.document.getElementById('native-content')?.textContent).toBe('Existing reasoning');
  button.setAttribute('aria-expanded','true');f.sync();expect(button.dataset.agyToolState).toBe('expanded');
 });
 it('renders only structured task data, including running and completed states',()=>{
  const f=fixture();f.view.innerHTML='<div><div class="group min-h-8" role="button">Update tasks</div></div>';const trigger=f.view.querySelector('[role=button]')!;
  attach(trigger,{title:'Tasks',supplementaryView:null,status:3,loading:false}, {memoizedProps:{step:{step:{case:'generic',value:{args:{Todos:[{content:'Check files',status:'completed'},{content:'Write file',status:'in_progress'},{content:'Read it back',status:'pending'}]}}}}}});
  f.sync();f.sync();expect(f.view.querySelectorAll('.agy-transcript-tasks')).toHaveLength(1);expect(f.view.querySelectorAll('li')).toHaveLength(3);expect(f.view.querySelector('[data-status=running]')?.textContent).toBe('Write file');expect(f.view.querySelector('[data-status=done]')?.textContent).toContain('Check files');
  f.document.body.classList.remove('agy-theme-claude');f.sync();expect(f.view.querySelector('ul')).toBeNull();expect(trigger.getAttribute('role')).toBe('button');
 });
 it('does not restyle the native theme or interpret tool content as HTML',()=>{
  const f=fixture();f.view.innerHTML='<div><button data-testid="tool-group-collapsible"><span>Original</span></button></div>';const button=f.view.querySelector('button')!;
  attach(button,{steps:[step('view_file','Read','file:///fixture/%3Cimg%20onerror%3Dalert(1)%3E.txt')],isRunning:false});f.sync();expect(f.view.querySelector('img')).toBeNull();expect(f.view.textContent).toContain('<img onerror=alert(1)>.txt');
  f.document.body.classList.remove('agy-theme-claude');f.sync();expect(button.textContent).toBe('Original');
 });
 it('reads the committed React tree after streaming updates instead of stale alternate props',()=>{
  const f=fixture();f.view.innerHTML='<div><button data-testid="tool-group-collapsible"><span>Original</span></button></div>';const button=f.view.querySelector('button')!;
  const oldRoot:any={memoizedProps:{},stateNode:{current:{}}};
  const current={memoizedProps:{steps:[step('write_to_file','Created',undefined,{additions:5,deletions:1})],isRunning:false}};
  (button as any).__reactFiber$fixture={memoizedProps:{steps:[],isRunning:true},return:oldRoot,alternate:current};
  f.sync();expect(f.view.querySelector('.agy-tool-added')?.textContent).toBe('+5');expect(f.view.querySelector('.agy-tool-verb')?.textContent).toBe('Created');
 });
});
