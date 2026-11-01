import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync('src/desktop.ts', 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

async function fixture(proxyPort = 50999, lsPort = 54321) {
  const events = new Map<string, (...args: unknown[]) => void>();
  let intercept: (details: { url: string }, callback: ReturnType<typeof vi.fn>) => void;
  const register = vi.fn();
  const stop = vi.fn().mockResolvedValue(undefined);
  const showErrorBox = vi.fn();
  const origLoadURL = vi.fn().mockResolvedValue(undefined);
  class MockBrowserWindow {
    loadURL(url: string, options?: unknown) {
      return origLoadURL(url, options);
    }
    isDestroyed() {
      return false;
    }
  }
  MockBrowserWindow.prototype.loadURL = origLoadURL;

  let currentLsPort = lsPort;
  const exported: { install?: (getPort: () => number) => void; enableVendorDevTools?: (cache: any) => void } = {};
  const dependencies = {
    './themeIcons': { installThemeIcons: vi.fn(), applyThemeIcon: vi.fn() },
    electron: {
      app: { whenReady: () => Promise.resolve(), on: (name: string, fn: (...args: unknown[]) => void) => events.set(name, fn) },
      session: { defaultSession: { webRequest: { onBeforeRequest: (fn: any) => (intercept = fn) } } },
      dialog: { showErrorBox },
      BrowserWindow: MockBrowserWindow,
    },
    './customIpc': { registerCustomModelHandlers: register },
    './proxy': { getProxyPort: () => proxyPort, stopProxy: stop },
  };
  runInNewContext(compiled, {
    exports: exported,
    require: (name: string) => (dependencies as any)[name],
    URL,
    console,
    setInterval,
    clearInterval,
    setTimeout,
    clearTimeout,
  });
  exported.install!(() => currentLsPort);
  exported.install!(() => currentLsPort);
  await Promise.resolve();
  return {
    enableVendorDevTools: exported.enableVendorDevTools!,
    events,
    register,
    stop,
    showErrorBox,
    BrowserWindow: dependencies.electron.BrowserWindow,
    origLoadURL,
    setLsPort(p: number) {
      currentLsPort = p;
    },
    request(url: string) {
      const callback = vi.fn();
      intercept!({ url }, callback);
      expect(callback).toHaveBeenCalledTimes(1);
      return callback.mock.calls[0][0];
    },
  };
}

describe('additive desktop integration', () => {
  const route = '/exa.language_server_pb.LanguageServerService/';

  it('registers only once, redirects local model lists and leaves generation to the LS', async () => {
    const f = await fixture();
    expect(f.register).toHaveBeenCalledTimes(1);
    const url = `https://127.0.0.1:54321${route}GetAvailableModels`;
    expect(f.request(url)).toEqual({
      redirectURL: `http://127.0.0.1:50999/GetAvailableModels?ls=${encodeURIComponent(url)}`,
    });
    expect(f.request(`https://127.0.0.1:54321${route}SetCloudCodeURL`)).toEqual({ cancel: true });
    expect(f.request(`https://127.0.0.1:54321${route}GenerateContent`)).toEqual({});
  });

  it.each([
    'https://example.com:54321',
    'https://127.0.0.1:11111',
    'http://127.0.0.1:50999',
    'https://localhost.evil.example:54321',
  ])('does not intercept other origins: %s', async (origin) => {
    const f = await fixture();
    expect(f.request(`${origin}${route}GetAvailableModels`)).toEqual({});
    expect(f.request(`${origin}${route}SetCloudCodeURL`)).toEqual({});
  });

  it.each([
    [0, 54321],
    [50999, 0],
  ])('passes through without both local services (proxy %s, LS %s)', async (proxy, ls) => {
    const f = await fixture(proxy, ls);
    expect(f.request(`https://127.0.0.1:54321${route}SetCloudCodeURL`)).toEqual({});
  });

  it('closes its proxy on exit', async () => {
    const f = await fixture();
    f.events.get('will-quit')!();
    expect(f.stop).toHaveBeenCalledTimes(1);
  });

  it('reports document load failures while ignoring subframes and canceled navigation', async () => {
    const f = await fixture();
    const events = new Map<string, (...args: unknown[]) => void>();
    f.events.get('browser-window-created')!(
      {},
      {
        isDestroyed: () => false,
        webContents: { on: (name, callback) => events.set(name, callback) },
      },
    );
    const onFailed = events.get('did-fail-load')!;
    onFailed({}, -3, 'ERR_ABORTED', '', true);
    onFailed({}, -202, 'ERR_CERT_AUTHORITY_INVALID', '', false);
    expect(f.showErrorBox).not.toHaveBeenCalled();
    onFailed({}, -202, 'ERR_CERT_AUTHORITY_INVALID', '', true);
    expect(f.showErrorBox).toHaveBeenCalledWith(
      'Antigravity could not load',
      expect.stringContaining('ERR_CERT_AUTHORITY_INVALID'),
    );
  });

  it('rewrites premature port 0 loadURL immediately when LS port is already known', async () => {
    const f = await fixture(50999, 54321);
    const win = new f.BrowserWindow();
    await win.loadURL('https://127.0.0.1:0/');
    expect(f.origLoadURL).toHaveBeenCalledWith('https://127.0.0.1:54321/', undefined);
  });

  it('guards premature port 0 loadURL and awaits LS port resolution when port is 0 initially', async () => {
    const f = await fixture(50999, 0);
    const win = new f.BrowserWindow();
    const loadPromise = win.loadURL('https://127.0.0.1:0/');
    expect(f.origLoadURL).not.toHaveBeenCalled();

    // Now LS finishes startup and port becomes known
    f.setLsPort(62345);

    // Give the guard interval (100ms) a chance to pick it up
    await new Promise((resolve) => setTimeout(resolve, 250));
    await loadPromise;

    expect(f.origLoadURL).toHaveBeenCalledWith('https://127.0.0.1:62345/', undefined);
  });

  it('passes normal URLs through loadURL untouched', async () => {
    const f = await fixture(50999, 54321);
    const win = new f.BrowserWindow();
    await win.loadURL('https://127.0.0.1:54321/index.html');
    expect(f.origLoadURL).toHaveBeenCalledWith('https://127.0.0.1:54321/index.html', undefined);
  });
});


describe('production DevTools unlock', () => {
  it('enables the vendor BrowserWindow preference without replacing other vendor exports', async () => {
    const f=await fixture();const configure=vi.fn();const native={exports:{isDebugConsoleEnabled:()=>false,configureDebugConsoleMenu:configure}};
    f.enableVendorDevTools({'C:\\app\\resources\\app.asar\\dist\\debugConsole.js':native});
    expect(native.exports.isDebugConsoleEnabled()).toBe(true);expect(native.exports.configureDebugConsoleMenu).toBe(configure);
  });
  it('handles F12 once and prevents a second menu-accelerator toggle', async () => {
    const f=await fixture(),events=new Map<string,any>(),toggle=vi.fn(),preventDefault=vi.fn();
    f.events.get('browser-window-created')!({}, {webContents:{on:(name:string,callback:any)=>events.set(name,callback),toggleDevTools:toggle}});
    events.get('before-input-event')({preventDefault},{type:'keyDown',key:'F12'});
    expect(toggle).toHaveBeenCalledOnce();expect(preventDefault).toHaveBeenCalledOnce();
    events.get('before-input-event')({preventDefault},{type:'keyUp',key:'F12'});expect(toggle).toHaveBeenCalledOnce();
  });
});
