import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { JSDOM } from 'jsdom';
const mocks = vi.hoisted(() => ({ app: new (require('node:events').EventEmitter)(), windows: [] as any[] }));
vi.mock('electron', () => ({ app: mocks.app, BrowserWindow: { getAllWindows: () => mocks.windows } }));
import { createPluginUI } from '../pluginUI';
const flush = () => new Promise(resolve => setTimeout(resolve, 10));
describe('plugin panel API', () => {
  it('renders data, updates it, and removes the panel on dispose', async () => {
    const dom = new JSDOM('<body></body>', {runScripts:'outside-only'}); let value = 'first';
    const wc = new EventEmitter() as any; wc.getURL = () => 'http://localhost:1234/'; wc.isDestroyed = () => false; wc.executeJavaScript = vi.fn(async (script: string) => dom.window.eval(script));
    const win = new EventEmitter() as any; win.isDestroyed = () => false; win.webContents = wc; mocks.windows.push(win);
    const ui = createPluginUI('example'); const dispose = ui.panel({id:'status',title:'Status',className:'my-native-class',read:() => value});
    await flush(); expect(dom.window.document.body.textContent).toContain('first'); expect(dom.window.document.querySelector('section')?.className).toBe('my-native-class'); expect(dom.window.document.querySelector('section')?.hasAttribute('style')).toBe(false);
    value = 'second'; wc.emit('dom-ready'); await flush(); expect(dom.window.document.body.textContent).toContain('second');
    dispose(); await flush(); expect(dom.window.document.querySelector('section')).toBeNull();
    expect(mocks.app.listenerCount('browser-window-created')).toBe(0); mocks.windows.length = 0; dom.window.close();
  });
  it('does not read or inject into external pages', async () => {
    const wc = new EventEmitter() as any; wc.getURL = () => 'https://example.com/'; wc.isDestroyed = () => false; wc.executeJavaScript = vi.fn();
    const win = new EventEmitter() as any; win.isDestroyed = () => false; win.webContents = wc; mocks.windows.push(win);
    const read = vi.fn(() => 'secret'); const ui = createPluginUI('example'); ui.panel({id:'status',title:'Status',read});
    wc.emit('dom-ready'); await flush(); expect(read).not.toHaveBeenCalled(); expect(wc.executeJavaScript).not.toHaveBeenCalled();
    ui.dispose(); mocks.windows.length = 0;
  });
});
