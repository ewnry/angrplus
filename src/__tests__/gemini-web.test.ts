import { describe, it, expect } from 'vitest';
import { JSDOM } from 'jsdom';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { isGeminiPage, inspectGeminiPage, snapshotGeminiPage, GeminiWeb } from '../geminiWeb';
import { configureGeminiWebMcp } from '../geminiWebSetup';

describe('Gemini Web dedicated browser', () => {
  it('includes generated images wrapped in viewer buttons and excludes button icons',()=>{
    const dom=new JSDOM('<model-response><generated-image><button><img class="image loaded" src="https://lh3.googleusercontent.com/result"></button></generated-image><button><img class="icon" src="https://gstatic.com/icon"></button></model-response>',{url:'https://gemini.google.com/app/image-chat'});
    const previousDocument=globalThis.document,previousLocation=globalThis.location;
    try{(globalThis as any).document=dom.window.document;(globalThis as any).location=dom.window.location;const result=snapshotGeminiPage();expect(result.messages[0].media).toHaveLength(1);expect(result.messages[0].media[0].src).toContain('googleusercontent.com/result');}finally{(globalThis as any).document=previousDocument;(globalThis as any).location=previousLocation;dom.window.close();}
  });
  it('only accepts the exact HTTPS Gemini app origin', () => {
    expect(isGeminiPage('https://gemini.google.com/app/abc')).toBe(true);
    for (const url of ['https://gemini.google.com.evil/app', 'http://gemini.google.com/app', 'https://accounts.google.com/app', 'file:///app']) expect(isGeminiPage(url)).toBe(false);
  });
  it('reads the latest response and selected model from visible UI, without reasoning text', () => {
    const dom = new JSDOM('<rich-textarea><div role="textbox" contenteditable="true"></div></rich-textarea><button data-test-id="bard-mode-menu-button">Thinking</button><model-response><message-content>Old</message-content></model-response><model-response><aside>Private reasoning</aside><message-content>Answer</message-content></model-response><button data-test-id="send-button">Send</button>', { url: 'https://gemini.google.com/app' });
    dom.window.Element.prototype.getClientRects = function () { return [{ width: 1 }] as any; };
    Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', { get() { return this.textContent; } });
    const run = new dom.window.Function(`return (${inspectGeminiPage.toString()})()`);
    // jsdom's default Function uses the host realm; execute in its own context instead.
    const previousDocument = globalThis.document, previousLocation = globalThis.location;
    try {
      (globalThis as any).document = dom.window.document; (globalThis as any).location = dom.window.location;
      const result = run();
      expect(result).toMatchObject({ ready: true, busy: false, text: 'Answer', responseCount: 2, model: 'Thinking', sendReady: true });
    } finally { (globalThis as any).document = previousDocument; (globalThis as any).location = previousLocation; dom.window.close(); }
  });
  it('rejects invalid prompts before accessing the browser', async () => {
    const web = new GeminiWeb('missing');
    await expect(web.ask('')).rejects.toThrow('Prompt');
    await expect(web.ask('x'.repeat(100001))).rejects.toThrow('Prompt');
  });
  it('reads only Gemini chats and avoids duplicate screen-reader prompt labels', () => {
    const dom = new JSDOM('<a href="/app/abc123">Real chat</a><a href="/app/abc123">Duplicate</a><a href="https://evil.invalid/app/foreign">Foreign</a><user-query><div class="query-text"><h5 class="cdk-visually-hidden">Your prompt: Hello</h5><p class="query-text-line">Hello</p></div></user-query><model-response><message-content><p>Answer</p></message-content></model-response>', { url:'https://gemini.google.com/app/abc123' });
    Object.defineProperty(dom.window.HTMLElement.prototype,'innerText',{get(){return this.textContent;}});
    const previousDocument=globalThis.document,previousLocation=globalThis.location;
    try {
      (globalThis as any).document=dom.window.document;(globalThis as any).location=dom.window.location;
      const state=snapshotGeminiPage();
      expect(state.conversations).toEqual([{id:'abc123',title:'Real chat'}]);expect(state.chatId).toBe('abc123');
      expect(state.messages[0].text).toBe('Hello');expect(state.messages[1].html).toBe('<p>Answer</p>');
    } finally {(globalThis as any).document=previousDocument;(globalThis as any).location=previousLocation;dom.window.close();}
  });
});

describe('Gemini Web MCP setup', () => {
  it('preserves other servers and config, copies standalone modules, and removes only its entry', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'agy-web-'));
    try {
      const configDir = path.join(home, '.gemini', 'config'), build = path.join(home, 'build');
      await mkdir(configDir, { recursive: true }); await mkdir(build);
      const original = { otherSetting: true, mcpServers: { existing: { command: 'original' } } };
      await writeFile(path.join(configDir, 'mcp_config.json'), JSON.stringify(original));
      for (const name of ['geminiWeb.js', 'geminiWebMcp.js']) await writeFile(path.join(build, name), '// fixture');
      await configureGeminiWebMcp(home, true, 'test-node', build);
      const enabled = JSON.parse(await readFile(path.join(configDir, 'mcp_config.json'), 'utf8'));
      expect(enabled.otherSetting).toBe(true); expect(enabled.mcpServers.existing).toEqual(original.mcpServers.existing);
      expect(enabled.mcpServers['antigravity-gemini-web']).toMatchObject({ command: 'test-node', timeoutSeconds: 180 });
      await configureGeminiWebMcp(home, false, 'test-node', build);
      expect(JSON.parse(await readFile(path.join(configDir, 'mcp_config.json'), 'utf8'))).toEqual(original);
    } finally { await rm(home, { recursive: true, force: true }); }
  });
  it('leaves malformed config untouched', async () => {
    const home = await mkdtemp(path.join(os.tmpdir(), 'agy-web-'));
    try {
      const dir = path.join(home, '.gemini', 'config'); await mkdir(dir, { recursive: true });
      await writeFile(path.join(dir, 'mcp_config.json'), '{bad');
      await expect(configureGeminiWebMcp(home, true)).rejects.toThrow('left unchanged');
      expect(await readFile(path.join(dir, 'mcp_config.json'), 'utf8')).toBe('{bad');
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
