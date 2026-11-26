import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

describe('Codex .plus theme', () => {
  it('mounts native-backed navigation, model picker and effort and cleans up', async () => {
    const source = readFileSync('src/customPreload.ts', 'utf8');
    const start = source.indexOf('function createPlusUiApi()'), end = source.indexOf('\nfunction createPlusThemeServices()', start);
    const uiCode = ts.transpileModule(source.slice(start, end) + '\nthis.createUi = createPlusUiApi;', { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    const theme = readFileSync('themes/codex-desktop.plus', 'utf8');
    const script = theme.split('@script\n')[1].split('\n@end\n')[0];
    const dom = new JSDOM('<body><nav role="navigation" aria-label="Sidebar"><button data-testid="new-conversation-button"></button><div data-testid="project-header" data-project-label="C:/work/project"><span class="truncate">C:/work/project</span></div></nav><button id="agy-native-quotas"></button><div data-testid="home-greeting"></div><div id="antigravity.agentSidePanelInputBox"><button data-testid="model-selector-trigger"></button></div></body>');
    const c: any = { window: dom.window, document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event, console };
    runInNewContext(uiCode, c); const ext = c.createUi();
    const state = { ready: true, selected: {label:'Gemini (High)',value:2}, options: [{label:'Gemini (Low)',value:1}, {label:'Gemini (High)',value:2}, {label:'Claude',value:3}, {label:'Claude (Thinking)',value:4}] };
    const setEffort = vi.fn().mockResolvedValue(true), unsubscribe = vi.fn();
    let mode = 'code'; const setMode = vi.fn((value:string) => { mode = value; return true; }); const openSettings = vi.fn(); const openAccounts = vi.fn();
    const api = { ui: ext.ui, layout: { get: () => mode, set: setMode, openSettings, openAccounts }, models: { get: () => state, effort: () => ({selected:'High',options:['Low','High']}), setEffort, select: vi.fn().mockResolvedValue(true), subscribe: (cb:any) => { cb(state); return unsubscribe; } } };
    const dispose = new Function('document','window','api','MutationObserver',script)(dom.window.document,dom.window,api,dom.window.MutationObserver);
    expect(dom.window.document.querySelector('.codex-nav-rail')).not.toBeNull();
    expect((dom.window.document.querySelector('[data-testid=project-header] span') as HTMLElement).dataset.codexProjectName).toBe('project');
    const quotaClick = vi.fn(); dom.window.document.querySelector('#agy-native-quotas')!.addEventListener('click',quotaClick); (dom.window.document.querySelector('[aria-label="Лимиты моделей"]') as HTMLButtonElement).click(); expect(quotaClick).toHaveBeenCalledOnce();
    expect(dom.window.document.querySelector('.codex-home-greeting')?.textContent).toContain('Что будем создавать');
    (dom.window.document.querySelector('.codex-mode-trigger') as HTMLButtonElement).click();
    (dom.window.document.querySelector('.codex-mode-menu .codex-menu-row') as HTMLButtonElement).click();
    expect(setMode).toHaveBeenCalledWith('cowork'); expect(dom.window.document.querySelector('.codex-mode-trigger')?.textContent).toContain('Gemini Web');
    (dom.window.document.querySelector('[aria-label="Профиль"]') as HTMLButtonElement).click();
    const profileActions = dom.window.document.querySelectorAll<HTMLButtonElement>('.codex-profile-action'); profileActions[1].click(); expect(openSettings).toHaveBeenCalled();
    const trigger = dom.window.document.querySelector('.codex-picker-trigger') as HTMLButtonElement; expect(trigger.textContent).toContain('Gemini'); trigger.click();
    const range = dom.window.document.querySelector('.codex-effort-range') as HTMLInputElement; expect(range).not.toBeNull(); expect(dom.window.document.querySelector('.codex-effort-thumb')).not.toBeNull(); range.value='0'; range.dispatchEvent(new dom.window.Event('input')); expect((dom.window.document.querySelector('.codex-effort-track') as HTMLElement).style.getPropertyValue('--progress')).toBe('0%'); range.dispatchEvent(new dom.window.Event('change'));
    await new Promise(resolve => setTimeout(resolve,0)); expect(setEffort).toHaveBeenCalledWith('Low');
    (dom.window.document.querySelector('.codex-effort-model') as HTMLButtonElement).click(); const modelNames = Array.from(dom.window.document.querySelectorAll('.codex-model-option')).map(x => x.textContent); expect(modelNames).toContain('Claude'); expect(modelNames).toContain('Claude (Thinking)');
    dispose(); ext.dispose(); expect(dom.window.document.querySelector('.codex-nav-rail')).toBeNull(); expect((dom.window.document.querySelector('[data-testid="model-selector-trigger"]') as HTMLElement).style.display).toBe('');
  });
});
