import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

describe('recovery window interactions', () => {
  it('switches to direct and retries without navigating externally', async () => {
    const source = readFileSync('src/customPreload.ts', 'utf8').split('function applyOldAntigravityTheme')[0];
    const code = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS } }).outputText;
    const dom = new JSDOM(`<body data-agy-recovery><form data-recovery-form hidden><input name="name"><select name="mode"><option value="socks5">SOCKS5</option><option value="relay">Relay</option></select><input name="endpoint"><label class="key" hidden><input name="secret"></label></form><p data-recovery-error></p><button data-recovery-direct>Direct</button></body>`, { url: 'https://local.test/' });
    const invoke = vi.fn().mockResolvedValue({ success: true });
    runInNewContext(code, { exports: {}, require: () => ({ ipcRenderer: { invoke } }), window: dom.window, document: dom.window.document });
    dom.window.dispatchEvent(new dom.window.Event('DOMContentLoaded'));
    (dom.window.document.querySelector('[data-recovery-direct]') as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(invoke.mock.calls).toEqual([['network-route:activate', null], ['agy-recovery:retry']]);
    expect(dom.window.location.href).toBe('https://local.test/');
  });
});
