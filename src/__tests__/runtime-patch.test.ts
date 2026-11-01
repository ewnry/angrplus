import { describe, expect, it, vi } from 'vitest';
import { runInNewContext } from 'node:vm';
import { planRuntimePatch } from '../../scripts/runtime-patch.mjs';

const vendorMain = `
const electron_1 = require('electron');
const hostBridge = require('./hostBridgeServer');
electron_1.app.whenReady().then(() => hostBridge.start());
`;

const vendorServer = `
exports.startLanguageServer = startLanguageServer;
function startLanguageServer(port, csrf, options = {}) {
  const { headless, hostBridgeUrl, hostBridgeToken, wsl } = options;
  return new Promise((resolve) => {
    record('vendor-start');
    const args = ['--standalone', '--https_server_port', String(port), '--csrf_token', csrf,
      '--api_server_url', 'https://generativelanguage.googleapis.com',
      '--cloud_code_endpoint', 'https://daily-cloudcode-pa.googleapis.com', '--enable_sidecars'];
    if (hostBridgeUrl && hostBridgeToken) args.push('--host_bridge_url=' + hostBridgeUrl, '--host_bridge_token=' + hostBridgeToken);
    if (headless) args.push('--headless');
    if (wsl) args.push('--wsl-distro=' + wsl.distro, '--exit_on_stdin_close');
    resolve({ args, wsl });
  });
}
exports.setupLocalCertTrust = () => 'vendor certificate policy';
`;

const vendorPreload = `
const electron_1 = require('electron');
const storageAPI = { getItems: () => electron_1.ipcRenderer.invoke('storage:get-items') };
electron_1.contextBridge.exposeInMainWorld('nativeStorage', storageAPI);
electron_1.contextBridge.exposeInMainWorld('wsl', { getState: () => 'vendor WSL' });
electron_1.contextBridge.exposeInMainWorld('futureBridge', { newMethod: () => 'future vendor API' });
`;

// Deliberately reuse vendor lexical bindings; the appended preload must isolate them.
const customPreload = `
"use strict";
Object.defineProperty(exports, '__esModule', { value: true });
const electron_1 = require('electron');
const storageAPI = { getCustomModels: () => electron_1.ipcRenderer.invoke('models:get-custom-models') };
window.addEventListener('DOMContentLoaded', () => storageAPI.getCustomModels());
`;

function fixture(overrides: Record<string, string> = {}, build = customPreload) {
  const files: Record<string, string> = {
    'dist/main.js': vendorMain,
    'dist/languageServer.js': vendorServer,
    'dist/preload.js': vendorPreload,
    ...overrides,
  };
  const readVendor = vi.fn((name: string) => Buffer.from(files[name]));
  const readBuild = vi.fn((name: string) => {
    expect(name).toBe('customPreload.js');
    return Buffer.from(build);
  });
  const plan = () => planRuntimePatch(readVendor, readBuild) as Map<string, Buffer>;
  return { files, readVendor, readBuild, plan };
}

function serverFixture(source = vendorServer) {
  const patched = fixture({ 'dist/languageServer.js': source }).plan().get('dist/languageServer.js')!.toString();
  const exports: Record<string, (...args: unknown[]) => Promise<{ args: string[]; wsl?: unknown }>> = {};
  const record = vi.fn();
  const startProxy = vi.fn().mockResolvedValue(61001);
  runInNewContext(patched, {
    exports,
    record,
    require: (name: string) => {
      expect(name).toBe('./modelPatch/proxy');
      return { startProxy };
    },
  });
  return { exports, record, startProxy };
}

describe('vendor runtime adapter', () => {
  it('plans only three vendor edits without evaluating code', () => {
    const f = fixture({ 'dist/main.js': `throw new Error('must not execute');\n${vendorMain}` });
    const patched = f.plan();
    expect([...patched.keys()]).toEqual(['dist/main.js', 'dist/languageServer.js', 'dist/preload.js']);
    expect([...patched.values()].every(Buffer.isBuffer)).toBe(true);
    expect(patched.get('dist/main.js')!.toString()).toContain("throw new Error('must not execute')");
    expect(patched.get('dist/languageServer.js')!.toString()).toContain(
      "exports.setupLocalCertTrust = () => 'vendor certificate policy'",
    );
  });

  it('installs the extension before the vendor ready handler and supplies the current port getter', () => {
    const calls: string[] = [];
    let port = 60111;
    let getPort: () => number;
    runInNewContext(fixture().plan().get('dist/main.js')!.toString(), {
      require: (name: string) =>
        ({
          electron: { app: { whenReady: () => ({ then: () => calls.push('vendor-ready') }) } },
          './hostBridgeServer': {},
          './modelPatch/desktop': {
            install: (getter: () => number) => {
              getPort = getter;
              calls.push('patch-install');
            },
          },
          './languageServer': { getLsPort: () => port },
        })[name],
    });
    expect(calls).toEqual(['patch-install', 'vendor-ready']);
    expect(getPort!()).toBe(60111);
    port = 60222;
    expect(getPort!()).toBe(60222);
  });

  it('patches whenReady().catch() to log startup errors rather than swallowing them', () => {
    const mainWithCatch = `
const electron_1 = require('electron');
const hostBridge = require('./hostBridgeServer');
electron_1.app.whenReady().then(() => hostBridge.start()).catch(() => { hasStartedMainApplication = true; });
`;
    const f = fixture({ 'dist/main.js': mainWithCatch });
    const patched = f.plan().get('dist/main.js')!.toString();
    expect(patched).toContain("console.error('[Antigravity Startup Error]', err)");
  });

  it('awaits the local proxy before startup and retains host-bridge arguments', async () => {
    const f = serverFixture();
    let resolvePort: (port: number) => void;
    f.startProxy.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolvePort = resolve;
        }),
    );
    const pending = f.exports.startLanguageServer(60123, 'csrf', {
      headless: true,
      hostBridgeUrl: 'http://localhost:62000',
      hostBridgeToken: 'bridge-token',
    });
    expect(f.record).not.toHaveBeenCalled();
    resolvePort!(61005);
    const { args } = await pending;
    for (const flag of ['--api_server_url', '--cloud_code_endpoint', '--inference_api_server_url']) {
      expect(args[args.indexOf(flag) + 1]).toBe('http://127.0.0.1:61005');
    }
    expect(args).toContain('--host_bridge_url=http://localhost:62000');
    expect(args).toContain('--host_bridge_token=bridge-token');
    expect(args).toContain('--headless');
  });

  it('preserves vendor WSL startup without starting or routing through the host proxy', async () => {
    const f = serverFixture();
    const wsl = { distro: 'Ubuntu', binaryPath: '/opt/vendor/language_server' };
    const result = await f.exports.startLanguageServer(60123, 'csrf', { wsl });
    expect(f.startProxy).not.toHaveBeenCalled();
    expect(result.wsl).toBe(wsl);
    expect(result.args[result.args.indexOf('--api_server_url') + 1]).toBe('https://generativelanguage.googleapis.com');
    expect(result.args[result.args.indexOf('--cloud_code_endpoint') + 1]).toBe(
      'https://daily-cloudcode-pa.googleapis.com',
    );
    expect(result.args).not.toContain('--inference_api_server_url');
    expect(result.args).toContain('--wsl-distro=Ubuntu');
    expect(result.args).toContain('--exit_on_stdin_close');
  });

  it('propagates a proxy startup failure before the language server starts', async () => {
    const f = serverFixture();
    const error = new Error('Port unavailable');
    f.startProxy.mockRejectedValue(error);
    await expect(f.exports.startLanguageServer(0, 'csrf')).rejects.toBe(error);
    expect(f.record).not.toHaveBeenCalled();
  });

  it('updates an existing inference endpoint once, preserving its vendor value in WSL mode', async () => {
    const f = serverFixture(
      vendorServer.replace("'--standalone'", "'--inference_api_server_url', 'https://inference.vendor.example'"),
    );
    const local = await f.exports.startLanguageServer(0, 'csrf');
    expect(local.args.filter((arg) => arg === '--inference_api_server_url')).toHaveLength(1);
    expect(local.args[local.args.indexOf('--inference_api_server_url') + 1]).toBe('http://127.0.0.1:61001');
    f.startProxy.mockClear();
    const remote = await f.exports.startLanguageServer(0, 'csrf', { wsl: { distro: 'Ubuntu' } });
    expect(remote.args[remote.args.indexOf('--inference_api_server_url') + 1]).toBe('https://inference.vendor.example');
    expect(f.startProxy).not.toHaveBeenCalled();
  });

  it('retains the legacy standalone headless argument', async () => {
    const source = vendorServer
      .replace('options = {}', 'headless')
      .replace(
        'const { headless, hostBridgeUrl, hostBridgeToken, wsl } = options;',
        'const hostBridgeUrl = undefined, hostBridgeToken = undefined, wsl = undefined;',
      );
    const f = serverFixture(source);
    const { args } = await f.exports.startLanguageServer(0, 'csrf', true);
    expect(f.startProxy).toHaveBeenCalledOnce();
    expect(args).toContain('--headless');
    expect(args[args.indexOf('--api_server_url') + 1]).toBe('http://127.0.0.1:61001');
  });

  it('preserves all vendor bridges and appends an isolated sandbox-compatible preload', () => {
    const source = fixture().plan().get('dist/preload.js')!.toString();
    expect(source.startsWith(vendorPreload)).toBe(true);
    const exposed: Record<string, Record<string, () => unknown>> = {};
    const invoke = vi.fn();
    let domReady: () => void;
    runInNewContext(source, {
      require: (name: string) => {
        expect(name).toBe('electron');
        return {
          ipcRenderer: { invoke },
          contextBridge: {
            exposeInMainWorld: (name: string, api: Record<string, () => unknown>) => {
              expect(exposed[name]).toBeUndefined();
              exposed[name] = api;
            },
          },
        };
      },
      window: {
        addEventListener: (_name: string, callback: () => void) => {
          domReady = callback;
        },
      },
    });
    expect(exposed.wsl.getState()).toBe('vendor WSL');
    expect(exposed.futureBridge.newMethod()).toBe('future vendor API');
    exposed.nativeStorage.getItems();
    expect(invoke).toHaveBeenLastCalledWith('storage:get-items');
    domReady!();
    expect(invoke).toHaveBeenLastCalledWith('models:get-custom-models');
  });

  it.each([
    ['missing ready hook', 'dist/main.js', "require('electron');"],
    ['duplicate ready hook', 'dist/main.js', vendorMain + '\nelectron_1.app.whenReady();'],
    ['nested ready hook', 'dist/main.js', "const e = require('electron'); (() => e.app.whenReady())();"],
    ['missing startup function', 'dist/languageServer.js', 'exports.start = () => {};'],
    ['duplicate startup function', 'dist/languageServer.js', vendorServer + '\nfunction startLanguageServer() {}'],
    ['unknown startup signature', 'dist/languageServer.js', vendorServer.replace('options = {}', 'config = {}')],
    ['missing endpoint', 'dist/languageServer.js', vendorServer.replace('--api_server_url', '--renamed_url')],
    [
      'duplicate endpoint',
      'dist/languageServer.js',
      vendorServer.replace("'--standalone'", "'--api_server_url', 'https://duplicate.example'"),
    ],
    [
      'later endpoint override',
      'dist/languageServer.js',
      vendorServer.replace(
        'resolve({ args, wsl });',
        "args.push('--api_server_url', 'https://later.example'); resolve({ args, wsl });",
      ),
    ],
    ['spread args', 'dist/languageServer.js', vendorServer.replace("'--standalone'", '...otherArgs')],
    [
      'nonliteral endpoint',
      'dist/languageServer.js',
      vendorServer.replace("'https://generativelanguage.googleapis.com'", 'getEndpoint()'),
    ],
    ['invalid JavaScript', 'dist/preload.js', 'const = ;'],
  ])('fails closed on %s', (_label, name, source) => {
    expect(() => fixture({ [name]: source }).plan()).toThrow('UNSUPPORTED_RUNTIME');
  });

  it('rejects repeated patching instead of appending another extension', () => {
    const first = fixture().plan();
    const files = Object.fromEntries([...first].map(([name, data]) => [name, data.toString()]));
    expect(() => fixture(files).plan()).toThrow('already patched');
  });

  it.each(['dist/main.js', 'dist/languageServer.js', 'dist/preload.js'])(
    'explains a missing required vendor file: %s',
    (missing) => {
      const f = fixture();
      expect(() =>
        planRuntimePatch((name: string) => {
          if (name === missing) throw Object.assign(new Error('File not found'), { code: 'ENOENT' });
          return f.readVendor(name);
        }, f.readBuild),
      ).toThrow(
        new RegExp(`UNSUPPORTED_RUNTIME: ${missing.replaceAll('.', '\\.')}.*cannot read required runtime file`),
      );
    },
  );

  it.each([
    "require('./proxy');",
    "require('./modelPatch/desktop').install();",
    'session.defaultSession.webRequest.onBeforeRequest(() => {});',
    "session.defaultSession.webRequest['onBeforeRequest'](() => {});",
  ])('rejects conflicting or older runtime patches with clean reinstall guidance: %s', (conflict) => {
    expect(() => fixture({ 'dist/main.js': conflict + vendorMain }).plan()).toThrow('UNSUPPORTED_RUNTIME');
    expect(() => fixture({ 'dist/main.js': conflict + vendorMain }).plan()).toThrow('reinstall a clean vendor build');
  });

  it.each([
    "require('./customHelpers');",
    'require(someModule);',
    "require('electron').contextBridge.exposeInMainWorld('nativeStorage', {});",
    "import('./other.js');",
  ])('rejects a custom preload that breaks its isolated sandbox contract: %s', (source) => {
    expect(() => fixture({}, source).plan()).toThrow('UNSUPPORTED_RUNTIME');
  });
});
