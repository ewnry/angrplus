import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

describe('theme interface API', () => {
  it('replaces and restores a native view, reattaches after rerender and binds native actions', async () => {
    const source = readFileSync('src/customPreload.ts', 'utf8');
    const start = source.indexOf('function createPlusUiApi()');
    const end = source.indexOf('\nfunction applyPlusCustomizations()', start);
    const code = ts.transpileModule(source.slice(start, end) + '\nthis.createApi = createPlusUiApi;', { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    const dom = new JSDOM('<body><main><button id="native">Native</button><input id="input"></main></body>');
    const context: any = { document: dom.window.document, HTMLElement: dom.window.HTMLElement, HTMLInputElement: dom.window.HTMLInputElement, HTMLTextAreaElement: dom.window.HTMLTextAreaElement, MutationObserver: dom.window.MutationObserver, Event: dom.window.Event, console };
    runInNewContext(code, context);
    const api = context.createApi(), first = dom.window.document.querySelector('#native') as HTMLButtonElement;
    const clicked = vi.fn(), input = vi.fn(); first.addEventListener('click', clicked); dom.window.document.querySelector('#input')!.addEventListener('input', input);
    api.ui.replace('#native', () => { const el = dom.window.document.createElement('button'); el.className = 'replacement'; return el; });
    expect(first.style.display).toBe('none'); expect(dom.window.document.querySelectorAll('.replacement')).toHaveLength(1);
    expect(api.ui.click('#native')).toBe(true); expect(clicked).toHaveBeenCalledOnce();
    expect(api.ui.setValue('#input', 'hello')).toBe(true); expect(input).toHaveBeenCalledOnce();
    const next = dom.window.document.createElement('button'); next.id = 'native'; first.replaceWith(next);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(next.style.display).toBe('none'); expect(dom.window.document.querySelectorAll('.replacement')).toHaveLength(1);
    api.dispose(); expect(next.style.display).toBe(''); expect(dom.window.document.querySelector('.replacement')).toBeNull();
  });

  it('uses the native bridge for model changes and exposes only supported effort', async () => {
    const source = readFileSync('src/customPreload.ts', 'utf8');
    const start = source.indexOf('function createPlusThemeServices()');
    const end = source.indexOf('\nfunction applyPlusCustomizations()', start);
    const code = ts.transpileModule(source.slice(start, end) + '\nthis.createServices = createPlusThemeServices;', { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    const dom = new JSDOM('<body></body>');
    const select = vi.fn().mockResolvedValue(true), setEffort = vi.fn().mockResolvedValue(true);
    const options = [{ label: 'Model (Low)', value: 1 }, { label: 'Model (High)', value: 2 }, { label: 'Model (Medium)', value: 3, disabled: true }];
    const context: any = { window: dom.window, document: dom.window.document, getModelFiberProps: () => ({ selectedModel: options[0], modelOptions: options, setSelectedModel: select }), modelFamily: (label: string) => label.replace(/\s*\((?:Low|Medium|High|Thinking|Auto)\)\s*$/i, '').trim(), setAntigravityEffort: setEffort, console };
    runInNewContext(code, context);
    const services = context.createServices();
    expect(Array.from(services.models.effort().options)).toEqual(['Low', 'High']);
    expect(await services.models.select(2)).toBe(true); expect(select).toHaveBeenCalledWith(options[1]);
    expect(await services.models.select(3)).toBe(false);
    expect(await services.models.setEffort('High')).toBe(true); expect(setEffort).toHaveBeenCalledWith('High');
    const changed = vi.fn(); services.models.subscribe(changed); expect(changed).toHaveBeenCalledOnce(); services.dispose();
  });
});
