import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const preload = ts.transpileModule(readFileSync(resolve('src/customPreload.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const windows: JSDOM[] = [];
afterEach(() => { windows.splice(0).forEach((dom) => dom.window.close()); vi.useRealTimers(); });

function fixture(path = '/') {
  const dom = new JSDOM('<main><button data-testid="project-selector-trigger"><span class="truncate"></span></button><div data-testid="virtuoso-item-list"></div><div id="antigravity.agentSidePanelInputBox"><textarea></textarea></div></main>', {
    url: `http://localhost${path}`, runScripts: 'outside-only', pretendToBeVisual: true,
  });
  windows.push(dom);
  dom.window.HTMLCanvasElement.prototype.getContext = vi.fn(() => ({clearRect:vi.fn(),fillRect:vi.fn(),fillStyle:""})) as any;
  const context = dom.getInternalVMContext();
  const executeJavaScript = vi.fn(async (code: string) => runInContext(code, context));
  Object.assign(context, { exports: {}, require: () => ({ ipcRenderer: { invoke: vi.fn(async () => ({})) }, webFrame: { executeJavaScript } }) });
  // Exercise the DOM patch directly without initializing IPC or network listeners.
  const addEventListener = dom.window.addEventListener;
  dom.window.addEventListener = vi.fn() as any;
  runInContext(preload, context);
  dom.window.addEventListener = addEventListener;
  const morph = () => runInContext('morphToClaudeDesktop()', context);
  return { dom, document: dom.window.document, morph, context, executeJavaScript };
}

function models(f: ReturnType<typeof fixture>) {
  const trigger = f.document.createElement('button');
  trigger.dataset.testid = 'model-selector-trigger';
  const options = ['Low', 'Medium', 'High'].map((effort, value) => ({ label: `Gemini 3.8 Flash (${effort})`, value }));
  const props = { selectedModel: options[2], modelOptions: [...options, { label: 'Local custom model', value: 99 }],
    setIsOpen: vi.fn(), setSelectedModel: vi.fn((option) => { props.selectedModel = option; trigger.textContent = option.label; }) };
  (trigger as any).__reactFiber$fixture = { memoizedProps: props };
  f.document.body.append(trigger);
  return { props, trigger };
}

describe('Claude composer DOM stability', () => {
  it('shows the patch version beside the native app version and avoids duplicate rows', () => {
    const f = fixture();
    const menu = f.document.createElement('div');
    menu.innerHTML = '<div><button data-testid="title-menu-bar-option">Version 2.29.0</button></div><div><button data-testid="title-menu-bar-option">Check for Updates</button></div>';
    f.document.body.append(menu);
    runInContext('injectPlusMenuVersion("2.1.18"); injectPlusMenuVersion("2.1.18")', f.context);
    expect(menu.querySelectorAll('#agy-plus-menu-version')).toHaveLength(1);
    expect(menu.children[1].textContent).toBe('Antigravity+ 2.1.18');
    expect(menu.children[2].textContent).toBe('Check for Updates');
    menu.remove();
    runInContext('injectPlusMenuVersion("2.1.18")', f.context);
    expect(f.document.getElementById('agy-plus-menu-version')).toBeNull();
  });
  it('shows Telegram invitation inside the page and saves its dismissal', async () => {
    const f = fixture();
    const invoke = vi.fn(async (channel: string) => channel === 'plus-channels:status' ? {success:true,show:true,opened:{}} : {success:true});
    Object.assign(f.context, { testChannelInvoke: invoke });
    runInContext('electron_1.ipcRenderer.invoke = testChannelInvoke', f.context);
    await runInContext('showChannelWelcome()', f.context);
    expect(f.document.querySelector('#agy-channel-welcome [role="dialog"]')).not.toBeNull();
    (f.document.querySelector('#agy-channel-welcome [data-channel="angrplus"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(invoke).toHaveBeenCalledWith('plus-channels:open', 'angrplus');
    (f.document.querySelector('#agy-channel-welcome .agy-welcome-close') as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(invoke).toHaveBeenCalledWith('plus-channels:dismiss');
    expect(f.document.getElementById('agy-channel-welcome')).toBeNull();
  });
  it('renders the new settings dropdown, selects an option and closes on Escape', () => {
    const f = fixture();
    const source = readFileSync(resolve('src/customPreload.ts'), 'utf8');
    const start = source.indexOf('  function createNativeSelect<');
    const end = source.indexOf('  function createNativeButton(', start);
    expect(start).toBeGreaterThan(-1); expect(end).toBeGreaterThan(start);
    const fn = ts.transpileModule(source.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    runInContext(fn + `\nwindow.selectedOption = ''; document.body.append(createNativeSelect([{value:'new',label:'Antigravity New'},{value:'flat',label:'Antigravity FlatNew'}], 'new', v => { window.selectedOption = v; }));`, f.context);
    const trigger = f.document.querySelector<HTMLButtonElement>('.agy-general-select-trigger')!;
    trigger.click();
    expect(f.document.querySelectorAll('[role="option"]')).toHaveLength(2);
    (f.document.querySelectorAll<HTMLButtonElement>('[role="option"]')[1]).click();
    expect((f.dom.window as any).selectedOption).toBe('flat');
    expect(f.document.querySelector('[role="listbox"]')).toBeNull();
    trigger.click(); f.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
    expect(f.document.querySelector('[role="listbox"]')).toBeNull();
  });
  it('enables and removes the flat Antigravity appearance without changing the native layout', () => {
    const f = fixture();
    runInContext('applyOldAntigravityTheme(true)', f.context);
    expect(f.document.body.classList.contains('agy-theme-antigravity-old')).toBe(true);
    expect(f.document.getElementById('agy-antigravity-old-theme')?.textContent).toContain('box-shadow:none');
    runInContext('applyOldAntigravityTheme(false)', f.context);
    expect(f.document.body.classList.contains('agy-theme-antigravity-old')).toBe(false);
    expect(f.document.getElementById('agy-antigravity-old-theme')).toBeNull();
    runInContext('applyOldAntigravityTheme(true, true)', f.context);
    expect(f.document.body.classList.contains('agy-theme-antigravity-flatnew')).toBe(true);
    runInContext('applyOldAntigravityTheme(true, false)', f.context);
    expect(f.document.body.classList.contains('agy-theme-antigravity-flatnew')).toBe(false);
    expect(f.document.body.classList.contains('agy-theme-antigravity-old')).toBe(true);
  });

  it('reserves space between top pane actions and the window buttons', () => {
    const f = fixture(); f.morph();
    const controls = f.document.querySelector<HTMLElement>('.agy-chrome-trailing')!;
    controls.getBoundingClientRect = () => ({ left: 850 }) as DOMRect;
    const parent = f.document.createElement('div');
    parent.getBoundingClientRect = () => ({ top: 0, right: 1000, width: 600, height: 36 }) as DOMRect;
    const toolbar = f.document.createElement('div'); toolbar.dataset.testid = 'pane-titlebar-toolbar';
    parent.append(toolbar); f.document.body.append(parent);
    f.morph();
    expect(toolbar.style.getPropertyValue('--agy-window-gap')).toBe('158px');
    expect(toolbar.hasAttribute('data-agy-window-gap')).toBe(true);
    runInContext('applyClaudeTheme(false)', f.context);
    expect(toolbar.hasAttribute('data-agy-window-gap')).toBe(false);
    expect(toolbar.style.getPropertyValue('--agy-window-gap')).toBe('');
  });
  it('applies and cleans up .plus theme elements, scripts and plugins', () => {
    const f = fixture();
    const source = '@plus 1\n@layout native\n@add body | div | theme-badge | Theme\n@script\ndocument.body.dataset.themeActive = "yes";\nreturn () => delete document.body.dataset.themeActive;\n@end\n@css\n.theme-badge { color: red; }';
    Object.assign(f.context, { testPlusSource: source });
    runInContext(`const compiledTheme = compilePlusTheme(testPlusSource);
      plusCustomizations = { css: compiledTheme.css, cssEnabled: true, themeScript: compiledTheme.script,
        plugins: [{ id: 'fixture', name: 'Fixture', enabled: true, code: 'document.body.dataset.pluginActive = "yes"; return () => delete document.body.dataset.pluginActive;' }] };
      applyPlusCustomizations();`, f.context);
    expect(f.document.querySelector('.theme-badge')?.textContent).toBe('Theme');
    expect(f.document.body.dataset.themeActive).toBe('yes');
    expect(f.document.body.dataset.pluginActive).toBe('yes');
    expect(f.document.getElementById('agy-user-custom-css')?.textContent).toContain('@antigravity-layout: native');
    runInContext('plusCustomizations = { css: "", cssEnabled: false, plugins: [] }; applyPlusCustomizations()', f.context);
    expect(f.document.querySelector('.theme-badge')).toBeNull();
    expect(f.document.body.dataset.themeActive).toBeUndefined();
    expect(f.document.body.dataset.pluginActive).toBeUndefined();
    expect(f.document.getElementById('agy-user-custom-css')).toBeNull();
  });
  it('recognizes the 2.29 home screen with a separately docked composer', () => {
    const f = fixture();
    const input = f.document.getElementById('antigravity.agentSidePanelInputBox')!;
    const home = f.document.createElement('div');
    home.className = 'agy-home';
    home.innerHTML = '<div><div class="home-scroll"><div><div data-testid="home-greeting">Native greeting</div></div></div><div class="home-composer"></div></div>';
    home.querySelector('.home-composer')!.append(input);
    f.document.body.append(home);
    f.morph(); f.morph();
    const screen = home.querySelector('[data-agy-new-chat="v229"]');
    expect(screen).not.toBeNull();
    expect(screen!.querySelectorAll('#agy-new-chat-welcome')).toHaveLength(1);
    expect(screen!.querySelectorAll('#agy-chat-history-overview')).toHaveLength(1);
    expect(screen!.contains(input)).toBe(false);
  });
  it('skins settings without replacing native buttons and filters real sections through search', () => {
    const f=fixture();const dialog=f.document.createElement('div');dialog.setAttribute('role','dialog');dialog.setAttribute('aria-label','Settings');
    dialog.innerHTML='<div style="display:flex;flex-direction:row"><aside><div class="bg-sidebar"><button data-testid="settings-nav-item-General">General</button><button data-testid="settings-nav-item-Models">Models</button></div></aside><main>Native controls</main></div>';
    const general=dialog.querySelector<HTMLButtonElement>('button')!;const nativeClick=vi.fn();general.addEventListener('click',nativeClick);f.document.body.append(dialog);
    runInContext('syncClaudeSettingsSkin();syncClaudeSettingsSkin()',f.context);expect(dialog.querySelectorAll('#agy-settings-search')).toHaveLength(1);
    expect(dialog.querySelector('[data-agy-settings-content]')?.textContent).toBe('Native controls');expect(general.isConnected).toBe(true);general.click();expect(nativeClick).toHaveBeenCalledOnce();
    const search=dialog.querySelector<HTMLInputElement>('input')!;search.value='Models';search.dispatchEvent(new f.dom.window.Event('input'));
    expect(general.hasAttribute('data-agy-settings-filtered')).toBe(true);expect(dialog.querySelector('[data-testid="settings-nav-item-Models"]')!.hasAttribute('data-agy-settings-filtered')).toBe(false);
    search.value='';search.dispatchEvent(new f.dom.window.Event('input'));expect(general.hasAttribute('data-agy-settings-filtered')).toBe(false);
  });

  it('does not treat native settings as owned mutations merely because the body has the Claude theme', () => {
    const f=fixture();const native=f.document.createElement('button');native.textContent='General';f.document.body.append(native);
    expect(runInContext('isOwnedUiMutationTarget(document.body.lastElementChild)',f.context)).toBe(false);
    expect(runInContext('isOwnedUiMutationTarget(document.body)',f.context)).toBe(false);
    native.id='agy-tab-general-plus';expect(runInContext('isOwnedUiMutationTarget(document.body.lastElementChild)',f.context)).toBe(true);
  });

  it('opens the native permission menu, mirrors native selection and anchors above the footer', async () => {
    const f = fixture();
    const native = f.document.createElement('button'); native.dataset.testid = 'permissions-selector-trigger'; native.textContent = 'Default';
    native.setAttribute('aria-controls','native-permissions'); native.setAttribute('aria-expanded','false');
    const positioner = f.document.createElement('div'); const menu = f.document.createElement('div'); menu.id = 'native-permissions'; menu.setAttribute('role','menu'); positioner.append(menu);
    const clicked = vi.fn(() => { native.setAttribute('aria-expanded','true'); f.document.body.append(positioner); }); native.addEventListener('click',clicked);f.document.body.append(native);
    f.morph(); const pill = f.document.getElementById('agy-pill-permissions') as HTMLButtonElement;
    expect(pill.hidden).toBe(false);expect(pill.textContent).toBe('Default');pill.click();
    expect(clicked).toHaveBeenCalledOnce();expect(positioner.hasAttribute('data-agy-permissions-menu')).toBe(true);expect(pill.getAttribute('aria-expanded')).toBe('true');
    native.textContent='Request Review';f.morph();expect(pill.textContent).toBe('Request Review');expect(f.document.querySelectorAll('#agy-pill-permissions')).toHaveLength(1);
    f.document.body.classList.remove('agy-theme-claude');runInContext('syncPermissionsControl()',f.context);expect(positioner.hasAttribute('data-agy-permissions-menu')).toBe(false);
  });

  it('keeps a single Clawd above the composer and uses actual streamed reasoning as an accessible toggle', () => {
    const f = fixture('/c/reasoning-test');
    f.morph(); f.morph();
    expect(f.document.querySelectorAll('#agy-clawd')).toHaveLength(1);
    expect(f.document.querySelector('#agy-clawd svg')).toBeNull();
    expect(f.document.querySelector('#agy-clawd canvas')?.getAttribute('data-state')).toBe('LookingAround');
    expect(runInContext('Object.entries(CLAWD_ORIGINAL_SPRITES).every(([name,s]) => { const frames=decodeClawdFrames(s); return frames.length===s.deltas.length+1 && frames.every(frame=>frame.length===s.w*s.h && [...frame].every(pixel=>pixel===255 || pixel<s.palette.length)); })', f.context)).toBe(true);
    expect(runInContext('decodeClawdFrames(CLAWD_ORIGINAL_SPRITES.Laptop).length', f.context)).toBe(43);
    f.document.getElementById('agy-clawd')!.click();
    expect(f.document.querySelector('#agy-clawd canvas')?.getAttribute('data-state')).toBe('JumpingHappy');

    expect(f.document.getElementById('agy-clawd')?.parentElement?.id).toBe('antigravity.agentSidePanelInputBox');
    const turn = f.document.createElement('div'); turn.dataset.turnContent = 'latest';
    const trigger = f.document.createElement('button'); trigger.dataset.testid = 'thinking-collapsible-trigger';
    trigger.textContent = 'Thought for 120s'; const toggle = vi.fn(); trigger.addEventListener('click', toggle); turn.append(trigger); f.document.body.append(turn);
    runInContext('nativeControlState = {modelOptions:[],running:true,conversationId:"reasoning-test",reasoningPreview:"Checking the existing implementation"}; syncClaudeActivity()', f.context);
    const label = f.document.querySelector<HTMLButtonElement>('.agy-activity-label')!;
    expect(label.textContent).toBe('Checking the existing implementation'); expect(label.disabled).toBe(false);
    label.click(); expect(toggle).toHaveBeenCalledOnce();
    runInContext('nativeControlState.running = false; syncClaudeActivity()', f.context);
    expect(f.document.getElementById('agy-response-activity')).toBeNull();
    expect(trigger.textContent).toBe('Thought for 120s');
  });

  it('edits inline, cancels without changing history, and sends a replacement without invoking Undo', async () => {
    const f = fixture('/c/edit-test');
    const step = f.document.createElement('div'); step.dataset.testid = 'user-input-step';
    step.innerHTML = '<div class="w-full"><div data-quotable="true">Old message</div><div class="user-input-buttons-container"><span>12:00</span><button data-testid="revert-button">Undo</button></div></div>';
    const undo = vi.fn(); step.querySelector('button')!.addEventListener('click', undo); f.document.body.append(step);
    const metadata = { sourceTrajectoryStepInfo: { stepIndex: 0 } };
    const provider = { getState: () => ({ trajectorySlice: { stepsInSlice: [{ step: { case: 'userInput' }, metadata }] } }) };
    (step as any).__reactFiber$edit = { memoizedProps: { cascadeId: 'edit-test', step: { items: [], media: [] }, metadata }, return: {
      memoizedProps: { value: { inputBoxRef: {}, cascadeContext: { state: { agentStateProvider: provider } } } }, return: null } };
    const nativeComposer = f.document.getElementById('antigravity.agentSidePanelInputBox')!;
    const editable = f.document.createElement('div'); editable.setAttribute('contenteditable', 'true'); nativeComposer.append(editable);
    nativeComposer.parentElement!.setAttribute('data-testid', 'agent-input-box');
    const send = f.document.createElement('button'); send.dataset.tooltipId = 'input-send-button-send-tooltip'; const sent = vi.fn(); send.addEventListener('click', () => { sent(editable.textContent); editable.textContent = ''; }); nativeComposer.append(send);
    f.document.execCommand = vi.fn((_command, _ui, text) => { editable.textContent = text || ''; return true; });
    const create = vi.fn((data) => ({ success: true, revision: { ...data, id: '12345678-1234-1234-1234-123456789abc' }, message: data.text + '\n\n\u2063AGY_REVISION:12345678-1234-1234-1234-123456789abc\u2063' }));
    Object.assign(f.context, { __createRevision: create });
    runInContext('electron_1.ipcRenderer.invoke = async (channel, data) => channel === "messages:create-revision" ? __createRevision(data) : {success:true,revisions:[]}; nativeControlState = {modelOptions:[],running:false,conversationId:"edit-test"}', f.context);
    f.morph(); step.querySelector<HTMLButtonElement>('[aria-label="Edit message"]')!.click();
    const textarea = step.querySelector('textarea')!; expect(textarea.value).toBe('Old message'); textarea.value = 'Changed';
    [...step.querySelectorAll<HTMLButtonElement>('form button')].find((button) => button.textContent === 'Cancel')!.click();
    expect(step.querySelector('form')).toBeNull(); expect(step.querySelector('[data-quotable]')!.textContent).toBe('Old message'); expect(undo).not.toHaveBeenCalled();
    step.querySelector<HTMLButtonElement>('[aria-label="Edit message"]')!.click(); step.querySelector('textarea')!.value = 'Replacement';
    step.querySelector('form')!.dispatchEvent(new f.dom.window.Event('submit', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(sent).toHaveBeenCalledOnce());
    expect(create).toHaveBeenCalledWith(expect.objectContaining({targetOrdinal:0,originalText:'Old message',text:'Replacement'}));
    expect(undo).not.toHaveBeenCalled(); expect(sent.mock.calls[0][0]).toContain('AGY_REVISION:');
  });

  it('keeps one original sprite strip alive across DOM updates and removes it at completion', () => {
    const f = fixture();
    const latest = f.document.createElement('div'); latest.dataset.turnContent = 'latest'; f.document.body.append(latest);
    const animate = vi.fn(() => ({ finished: Promise.resolve() }));
    f.dom.window.HTMLElement.prototype.animate = animate as any;
    runInContext('nativeControlState = {modelOptions: [], running: true, conversationId: "test"}', f.context);
    f.morph(); const row = f.document.getElementById('agy-response-activity')!;
    expect(row.textContent).toContain('Working on it');
    expect(row.querySelector('svg')!.getAttribute('viewBox')).toBe('0 0 100 1500');
    f.morph(); f.morph(); expect(f.document.getElementById('agy-response-activity')).toBe(row);
    expect(animate).toHaveBeenCalledOnce();
    runInContext('claudeActivityWord = 2; syncClaudeActivity()', f.context);
    expect(row.textContent).toContain('Sifting');
    runInContext('nativeControlState.running = false; syncClaudeActivity()', f.context);
    expect(f.document.getElementById('agy-response-activity')).toBeNull();
    expect(runInContext('claudeActivityTimer', f.context)).toBeUndefined();
  });
  it('fades only appended prose with an overlay, preserving React text nodes and excluding code', async () => {
    const f = fixture();
    const latest = f.document.createElement('div'); latest.dataset.turnContent = 'latest';
    const response = f.document.createElement('div'); response.dataset.testid = 'planner-response-text';
    const paragraph = f.document.createElement('p'); const text = f.document.createTextNode('Existing text.'); paragraph.append(text);
    const code = f.document.createElement('code'); code.textContent = 'old'; response.append(paragraph, code); latest.append(response); f.document.body.append(latest);
    const highlights = new Map();
    Object.assign(f.dom.window, { CSS: { highlights }, Highlight: class { constructor(public ranges: any) {} } });
    const finishes: Array<() => void> = [];
    f.dom.window.HTMLElement.prototype.animate = vi.fn(() => ({ finished: new Promise<void>((resolve) => finishes.push(resolve)) })) as any;
    f.dom.window.Range.prototype.getClientRects = vi.fn(() => [{ left: 10, top: 10, width: 20, height: 16, bottom: 26 }]) as any;
    runInContext('nativeControlState = {modelOptions: [], running: true, conversationId: "test"}; syncStreamingTextEffects(true)', f.context);
    text.appendData(' New words.'); code.textContent += ' newCode';
    runInContext('flushStreamingTextEffects()', f.context);
    expect(paragraph.firstChild).toBe(text); expect(paragraph.childNodes).toHaveLength(1);
    expect([...f.document.querySelectorAll('#agy-stream-overlay span')].map((node) => node.textContent)).toEqual(['New', 'words.']);
    expect(highlights.has('agy-stream-incoming')).toBe(true);
    const calls = (f.dom.window.HTMLElement.prototype.animate as any).mock.calls.length;
    runInContext('flushStreamingTextEffects()', f.context);
    expect((f.dom.window.HTMLElement.prototype.animate as any).mock.calls).toHaveLength(calls);
    finishes.forEach((finish) => finish()); await Promise.resolve();
    expect(highlights.has('agy-stream-incoming')).toBe(false);
    expect(paragraph.textContent).toBe('Existing text. New words.');
    runInContext('syncStreamingTextEffects(false); clearIncomingTextEffects()', f.context);
  });

  it('uses exactly one effort marker per supported variant, including a non-contiguous subset', () => {
    const f = fixture(); const { props } = models(f);
    props.modelOptions = props.modelOptions.filter((option) => option.label !== 'Gemini 3.8 Flash (Medium)');
    f.morph(); runInContext('openClaudeEffortPopover()', f.context);
    expect([...f.document.querySelectorAll('.agy-effort-ticks span')].map((tick) => tick.getAttribute('data-effort'))).toEqual(['Low', 'High']);
    expect(f.document.querySelectorAll('#agy-effort-choices option')).toHaveLength(2);
    expect((f.document.getElementById('agy-effort-slider') as HTMLInputElement).max).toBe('1');
  });
  it('shows model shortcut numbers and selects the real model using a number key', async () => {
    const f = fixture(); const { props } = models(f);
    runInContext('setupNativeControlBridge()', f.context); await Promise.resolve(); f.morph();
    f.document.getElementById('agy-pill-model')!.click();
    const option = f.document.querySelector<HTMLButtonElement>('[data-model-shortcut="2"]')!;
    expect(option.querySelector('.agy-model-opt-check')!.textContent).toBe('2');
    expect(option.getAttribute('aria-keyshortcuts')).toBe('2');
    f.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(props.selectedModel.value).toBe(99));
  });

  it('aggregates real session starts and labels steps without inventing tokens or models', () => {
    const f = fixture();
    const now = new Date(2026, 9, 21, 12).getTime();
    Object.assign(f.context, { __history: [
      { created: now - 86400000, steps: 7 }, { created: now - 2 * 86400000, steps: 5 },
      { created: now - 40 * 86400000, steps: 99 },
    ], __now: now });
    const stats = runInContext('summarizeChatHistory(__history, 7, __now)', f.context);
    expect(stats.sessions).toBe(2); expect(stats.steps).toBe(12); expect(stats.activeDays).toBe(2);
    runInContext('nativeControlState = {modelOptions: [], history: {entries: __history, loaded: true}}', f.context);
    const screen = f.document.createElement('div'); screen.className = 'pt-[30vh]';
    const input = f.document.getElementById('antigravity.agentSidePanelInputBox')!;
    input.before(screen); screen.append(input); f.morph();
    expect(f.document.querySelector('.agy-history-cards')!.textContent).toContain('Steps111');
    expect(f.document.querySelector('.agy-history-cards')!.textContent).toContain('Projects0');
    expect(f.document.querySelectorAll('.agy-history-heatmap span')).toHaveLength(182);
    f.document.querySelector<HTMLButtonElement>('[data-history-tab="models"]')!.click();
    expect(f.document.querySelector('.agy-history-content')!.textContent).toContain('No recorded model usage in this range.');
    expect(f.document.getElementById('antigravity.agentSidePanelInputBox')).toBe(input);
  });

  it('keeps the native status node and builds one new-chat welcome without replacing the editor', () => {
    const f = fixture();
    const screen = f.document.createElement('div'); screen.className = 'pt-[30vh]';
    const editor = f.document.getElementById('antigravity.agentSidePanelInputBox')!;
    editor.before(screen); screen.append(editor);
    const row = f.document.createElement('div'); row.dataset.testid = 'conversation-row-sidebar';
    row.innerHTML = '<a></a><div><div><div><button>Actions</button></div><div><svg data-testid="status-loading-spinner"></svg></div></div></div>';
    f.document.body.append(row); const status = row.querySelector('svg');
    const nav = f.document.createElement('div'); nav.setAttribute('role', 'navigation'); nav.setAttribute('aria-label', 'Sidebar'); f.document.body.append(nav);
    f.morph(); f.morph();
    expect(f.document.querySelectorAll('#agy-new-chat-welcome')).toHaveLength(1);
    expect(f.document.getElementById('antigravity.agentSidePanelInputBox')).toBe(editor);
    expect(row.querySelector('[data-agy-row-status] svg')).toBe(status);
    expect(f.document.querySelector('#agy-sidebar-more summary svg')).toBeTruthy();
  });

  it('opens the native file input directly, without opening Add context', () => {
    const f = fixture();
    const input = f.document.createElement('input'); input.type = 'file'; input.multiple = true;
    f.document.getElementById('antigravity.agentSidePanelInputBox')!.append(input);
    const clickFile = vi.spyOn(input, 'click').mockImplementation(() => {});
    const native = f.document.createElement('button'); native.setAttribute('aria-label', 'Add context');
    const clickContext = vi.fn(); native.addEventListener('click', clickContext); f.document.body.append(native);
    f.morph(); f.document.getElementById('agy-btn-attach')!.click();
    f.document.getElementById('agy-plus-opt-files')!.click();
    expect(clickFile).toHaveBeenCalledOnce(); expect(clickContext).not.toHaveBeenCalled();
    expect(f.document.getElementById('agy-claude-plus-popover')).toBeNull();
  });
  it('presents folder basenames without replacing native project labels', () => {
    const f = fixture();
    const header = f.document.createElement('button'); header.dataset.testid = 'project-header';
    header.dataset.projectLabel = 'C:/Users/example/Downloads';
    header.innerHTML = '<span class="truncate">C:/Users/example/Downloads</span>';
    f.document.body.append(header); f.morph();
    expect(header.querySelector('span')!.dataset.agyFolderName).toBe('Downloads');
    expect(header.textContent).toBe('C:/Users/example/Downloads');
    expect(header.title).toBe('C:/Users/example/Downloads');
    expect(f.document.getElementById('agy-top-title-trigger')).toBeNull();
  });

  it('anchors the native project menu to the visible pill and removes Local', () => {
    const f = fixture(); f.morph();
    const anchor = f.document.getElementById('agy-project-folder-btn')!;
    const native = f.document.querySelector<HTMLButtonElement>('[data-testid="project-selector-trigger"]')!;
    const bounds = { left: 200, top: 180, width: 120, height: 30 };
    vi.spyOn(anchor, 'getBoundingClientRect').mockImplementation(() => bounds as DOMRect);
    const click = vi.fn(() => {
      expect(native.style.getPropertyValue('--agy-project-left')).toBe('200px');
      expect(native.style.getPropertyValue('--agy-project-top')).toBe('180px');
      expect(native.style.getPropertyValue('--agy-project-width')).toBe('120px');
    });
    native.addEventListener('click', click);
    anchor.click();
    expect(click).toHaveBeenCalledOnce();
    expect(native.hasAttribute('data-agy-project-anchor')).toBe(true);
    expect(f.document.getElementById('agy-claude-project-pills')!.textContent).not.toMatch(/\bLocal\b/);
    bounds.left = 320;
    f.dom.window.dispatchEvent(new f.dom.window.Event('resize'));
    expect(native.style.getPropertyValue('--agy-project-left')).toBe('320px');
    f.document.querySelector('[data-testid="virtuoso-item-list"]')!.append(f.document.createElement('article'));
    f.morph();
    expect(native.hasAttribute('data-agy-project-anchor')).toBe(false);
  });
  it('preserves buttons and SVG nodes across repeated updates', () => {
    const f = fixture();
    f.morph();
    const attach = f.document.getElementById('agy-btn-attach');
    const svg = attach!.firstElementChild;
    const mutations: unknown[] = [];
    const observer = new f.dom.window.MutationObserver(() => {});
    observer.observe(f.document.body, { childList: true, subtree: true });
    for (let i = 0; i < 10; i++) f.morph();
    mutations.push(...observer.takeRecords());
    observer.disconnect();
    expect(f.document.getElementById('agy-btn-attach')).toBe(attach);
    expect(attach!.firstElementChild).toBe(svg);
    expect(mutations).toHaveLength(0);
  });

  it('shows folders on an empty new chat and removes them when a message appears', () => {
    const f = fixture();
    f.document.querySelector('span.truncate')!.textContent = '<img src=x onerror=alert(1)>';
    f.morph();
    expect(f.document.getElementById('agy-project-folder-name')!.textContent).toBe('<img src=x onerror=alert(1)>');
    expect(f.document.querySelector('#agy-project-folder-name img')).toBeNull();
    f.document.querySelector('[data-testid="virtuoso-item-list"]')!.append(f.document.createElement('article'));
    f.morph();
    expect(f.document.getElementById('agy-claude-project-pills')).toBeNull();
  });

  it('keeps folders hidden while an existing chat is still loading', () => {
    const f = fixture('/chat/existing-conversation');
    f.morph();
    expect(f.document.getElementById('agy-claude-project-pills')).toBeNull();
  });

  it('reattaches the same controls when React moves the composer', () => {
    const f = fixture();
    f.morph();
    const footer = f.document.getElementById('agy-claude-composer-footer');
    const nextPane = f.document.createElement('section');
    f.document.body.append(nextPane);
    nextPane.append(f.document.getElementById('antigravity.agentSidePanelInputBox')!);
    f.morph();
    expect(f.document.getElementById('antigravity.agentSidePanelInputBox')!.nextSibling).toBe(footer);
    expect(footer!.parentElement).toBe(nextPane);
  });

  it('recognizes generation even though the theme hides the native cancel button', () => {
    const f = fixture();
    f.morph();
    const cancel = f.document.createElement('button');
    cancel.dataset.tooltipId = 'input-send-button-cancel-tooltip';
    cancel.style.display = 'none';
    f.document.getElementById('antigravity.agentSidePanelInputBox')!.append(cancel);
    f.morph();
    expect(f.document.querySelector('.agy-enter-btn')!.classList.contains('is-generating')).toBe(true);
    cancel.remove();
    f.morph();
    expect(f.document.querySelector('.agy-enter-btn')!.classList.contains('is-generating')).toBe(false);
  });

  it('offers only Low, Medium and High for Flash effort', () => {
    const f = fixture();
    models(f);
    f.morph();
    runInContext('openClaudeEffortPopover()', f.context);
    expect([...f.document.querySelectorAll('.agy-effort-sub span')].map((el) => el.textContent)).toEqual(['Faster', 'Smarter']);
    expect(f.document.getElementById('agy-claude-effort-popover')!.textContent).not.toMatch(/\bAuto\b/);
  });

  it('keeps its own model picker open on a single click and selects real custom options', async () => {
    const f = fixture();
    const { props, trigger } = models(f);
    const nativeClick = vi.fn(); trigger.addEventListener('click', nativeClick);
    runInContext('setupNativeControlBridge()', f.context);
    await Promise.resolve();
    f.morph();
    f.document.getElementById('agy-pill-model')!.click();
    expect(f.document.getElementById('agy-claude-model-popover')).toBeTruthy();
    f.document.querySelector<HTMLButtonElement>('[data-model-value="99"]')!.click();
    await vi.waitFor(() => expect(props.setSelectedModel).toHaveBeenCalledWith(expect.objectContaining({ value: 99 })));
    expect(nativeClick).not.toHaveBeenCalled();
    expect(f.executeJavaScript).toHaveBeenCalled();
    expect(props.setIsOpen).toHaveBeenCalledWith(false);
  });

  it('changes the native model variant when effort changes', async () => {
    const f = fixture(); const { props } = models(f);
    runInContext('setupNativeControlBridge()', f.context);
    await Promise.resolve(); f.morph();
    f.document.getElementById('agy-pill-effort')!.click();
    const slider = f.document.getElementById('agy-effort-slider') as HTMLInputElement;
    slider.value = '0'; slider.dispatchEvent(new f.dom.window.Event('change'));
    await vi.waitFor(() => expect(props.selectedModel.value).toBe(0));
    expect(props.selectedModel.label).toBe('Gemini 3.8 Flash (Low)');
  });

  it('notifies once at the end of a run, keeps cancellation, and ignores navigation', () => {
    vi.useFakeTimers();
    const f = fixture(); const notify = vi.fn();
    Object.assign(f.context, { setTimeout, clearTimeout, __notify: notify });
    const notifier = runInContext('createGenerationNotifier(__notify)', f.context);
    const state = (running: boolean, conversationId = 'a') => ({ running, conversationId, modelOptions: [] });
    notifier.update(state(true));
    vi.advanceTimersByTime(10000); expect(notify).not.toHaveBeenCalled();
    notifier.update(state(false)); vi.advanceTimersByTime(200);
    notifier.update(state(true)); vi.advanceTimersByTime(1000); expect(notify).not.toHaveBeenCalled();
    notifier.update(state(false)); notifier.update(state(false));
    vi.advanceTimersByTime(500); expect(notify).toHaveBeenCalledTimes(1);
    notifier.update(state(true)); notifier.cancel(); vi.advanceTimersByTime(12000);
    notifier.update(state(false)); vi.advanceTimersByTime(500); expect(notify).toHaveBeenCalledTimes(1);
    notifier.update(state(true)); notifier.update(state(false, 'b'));
    vi.advanceTimersByTime(500); expect(notify).toHaveBeenCalledTimes(1);
    notifier.dispose();
  });
});


describe('Antigravity 2.26 native prompts and geo errors', () => {
  it('does not classify unrelated HTTP 400 or old geo errors as a current geo block', () => {
    const f=fixture();
    expect(runInContext('latestErrorIsGeoBlocked({errorCode:400,fullError:"User location is not supported for API use"})',f.context)).toBe(true);
    expect(runInContext('latestErrorIsGeoBlocked({errorCode:400,fullError:"Invalid argument: unsupported model"})',f.context)).toBe(false);
    expect(runInContext('latestErrorIsGeoBlocked({errorCode:403,fullError:"User location is not supported for API use"})',f.context)).toBe(false);
    expect(runInContext('latestErrorIsGeoBlocked({stepsInSlice:[{errorCode:400,fullError:"User location is not supported for API use"},{errorCode:400,fullError:"Invalid model"}]})',f.context)).toBe(false);
  });
  it('keeps docked native prompts clear and resumes animation after the question closes', () => {
    const f=fixture(); f.document.body.classList.add('agy-theme-claude');
    const turn=f.document.createElement('div');turn.dataset.turnContent='latest';f.document.body.append(turn);
    const prompt=f.document.createElement('div');prompt.dataset.testid='ask-question-header-text';prompt.getBoundingClientRect=()=>({height:24} as DOMRect);f.document.body.append(prompt);
    runInContext('nativeControlState={modelOptions:[],running:true};syncOriginalClawd(document.getElementById("antigravity.agentSidePanelInputBox"));syncClaudeActivity()',f.context);
    expect(f.document.getElementById('agy-clawd')!.style.visibility).toBe('hidden');expect(f.document.getElementById('agy-response-activity')).toBeNull();
    prompt.remove();runInContext('syncOriginalClawd(document.getElementById("antigravity.agentSidePanelInputBox"));syncClaudeActivity()',f.context);
    expect(f.document.getElementById('agy-clawd')!.style.visibility).toBe('');expect(f.document.getElementById('agy-response-activity')).not.toBeNull();
  });
  it('shows a useful geo message while keeping the native Retry action and clears it for ordinary errors', () => {
    const f=fixture();const turn=f.document.createElement('div');turn.dataset.turnContent='latest';const debug=f.document.createElement('button');Object.defineProperty(debug,'innerText',{value:'Copy debug info'});const generic=f.document.createElement('p');Object.defineProperty(generic,'innerText',{value:'Agent execution terminated due to error.'});const retry=f.document.createElement('button');retry.textContent='Retry';const click=vi.fn();retry.addEventListener('click',click);
    const error={errorCode:400,fullError:'User location is not supported for API use'};(debug as any).__reactFiber$geo={memoizedProps:{trajectorySlice:{stepsInSlice:[error]}},return:null};turn.append(generic,debug,retry);f.document.body.append(turn);
    runInContext('syncGeoErrorHint()',f.context);expect(f.document.getElementById('agy-geo-error')!.textContent).toContain('VPN');expect(generic.style.display).toBe('none');retry.click();expect(click).toHaveBeenCalledOnce();
    error.fullError='Invalid argument: unsupported model';runInContext('syncGeoErrorHint()',f.context);expect(f.document.getElementById('agy-geo-error')).toBeNull();expect(generic.style.display).toBe('');
  });
});



describe('shared compact context menu', () => {
  it('uses blue, yellow and red ring thresholds and clamps invalid values', () => {
    const f=fixture();
    expect(runInContext('getContextRingSvg(25)',f.context)).toContain('#58a6ff');
    expect(runInContext('getContextRingSvg(80)',f.context)).toContain('#d6b458');
    expect(runInContext('getContextRingSvg(100)',f.context)).toContain('#e05252');
    expect(runInContext('getContextRingSvg(NaN)',f.context)).not.toContain('NaN');
  });
  it('keeps context as a ring, opens only three compact tabs, and closes without a modal overlay', async () => {
    const f=fixture();f.morph();const input=f.document.getElementById('antigravity.agentSidePanelInputBox')!;input.dataset.testid='agent-input-box';
    runInContext('insightsData={success:true,context:{used:81000,limit:100000,model:"gemini",savedAt:Date.now(),reductions:0},summary:{input:20,cached:10,output:5,thinking:2,calls:1}}; insightsReadKey="/0";insightsReadAt=Date.now();syncInsightsUi();openInsightsPopover("context")',f.context);
    await Promise.resolve();await Promise.resolve();
    const anchor=f.document.getElementById('agy-pill-context')!;
    expect(anchor.querySelector('svg.agy-context-ring')).not.toBeNull();expect(anchor.textContent?.trim()).toBe('');
    const pop=f.document.getElementById('agy-insights-popover')!;
    expect(pop.querySelectorAll('[role=tab]')).toHaveLength(3);expect(pop.textContent).toContain('Context window');
    const breakdown=pop.querySelector<HTMLDetailsElement>('.agy-claude-context-details')!;
    expect(breakdown.open).toBe(false);expect(pop.querySelector('.agy-claude-context-count')?.textContent).toContain('(81%)');
    const detailsButton=pop.querySelector<HTMLButtonElement>('.agy-context-detail-footer button')!;
    expect(detailsButton.textContent).toBe('See detailed breakdown');detailsButton.click();expect(breakdown.open).toBe(true);
    expect(breakdown.textContent).toContain('Used context');expect(breakdown.textContent).toContain('Free space');
    expect(breakdown.textContent).toContain('does not include a breakdown');
    expect(pop.textContent).not.toMatch(/Storage|Continue in new chat/);expect(f.document.getElementById('agy-modal-overlay')).toBeNull();
    expect(anchor.getAttribute('aria-expanded')).toBe('true');
    f.document.dispatchEvent(new f.dom.window.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
    expect(f.document.getElementById('agy-insights-popover')).toBeNull();expect(anchor.getAttribute('aria-expanded')).toBe('false');
  });
  it('has a native host without Claude branding and clears Claude-only home elements on theme change', () => {
    const f=fixture();f.morph();const input=f.document.getElementById('antigravity.agentSidePanelInputBox')!;input.dataset.testid='agent-input-box';
    runInContext('applyClaudeTheme(false);syncInsightsUi()',f.context);
    expect(f.document.getElementById('agy-clawd')).toBeNull();expect(f.document.getElementById('agy-new-chat-welcome')).toBeNull();
    expect(f.document.getElementById('agy-native-insights-controls')).not.toBeNull();
    runInContext('openInsightsPopover("usage",document.getElementById("agy-native-usage"))',f.context);
    expect(f.document.getElementById('agy-insights-popover')!.classList.contains('agy-claude-popover')).toBe(false);
    f.document.body.dispatchEvent(new f.dom.window.MouseEvent('click',{bubbles:true}));
    expect(f.document.getElementById('agy-insights-popover')).toBeNull();
  });
});


describe('Claude workspace environment controls', () => {
  it('mirrors native Local/Worktree and branch controls without replacing their actions', () => {
    const f=fixture();const host=f.document.createElement('div');host.id='agy-claude-project-pills';host.innerHTML='<button id="agy-project-folder-btn">Folder</button>';f.document.body.append(host);f.document.body.classList.add('agy-theme-claude');
    const native=f.document.createElement('button');native.setAttribute('aria-label','Select Environment');native.textContent='Local';native.setAttribute('aria-expanded','false');f.document.body.append(native);
    const dialog=f.document.createElement('div');dialog.setAttribute('role','dialog');dialog.setAttribute('data-side','bottom');dialog.innerHTML='<button>Local</button><button>New Worktree</button>';const positioner=f.document.createElement('div');positioner.append(dialog);
    const click=vi.fn(()=>{native.setAttribute('aria-expanded','true');f.document.body.append(positioner);});native.addEventListener('click',click);
    runInContext('syncEnvironmentControl()',f.context);const pill=f.document.getElementById('agy-project-environment-btn')!;expect(host.firstChild).toBe(pill);pill.click();
    expect(click).toHaveBeenCalledOnce();expect(dialog.getAttribute('data-agy-workspace-popup')).toBe('environment');expect(dialog.querySelector('[data-agy-selected-environment]')!.textContent).toBe('Local');
    native.textContent='New Worktree';const branch=f.document.createElement('button');branch.setAttribute('aria-label','Select Default Branch');branch.textContent='master';f.document.body.append(branch);const choose=vi.fn();branch.addEventListener('click',choose);
    runInContext('syncEnvironmentControl()',f.context);expect(pill.textContent).toBe('New Worktree');f.document.getElementById('agy-project-branch-btn')!.click();expect(choose).toHaveBeenCalledOnce();
    branch.remove();runInContext('syncEnvironmentControl()',f.context);expect(f.document.getElementById('agy-project-branch-btn')).toBeNull();
    f.document.body.classList.remove('agy-theme-claude');runInContext('syncEnvironmentControl()',f.context);expect(dialog.hasAttribute('data-agy-workspace-popup')).toBe(false);
  });
});
