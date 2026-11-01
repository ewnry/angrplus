import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import * as readline from 'node:readline';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(path.resolve('src/languageServer.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
}).outputText;

function createFixture() {
  const startProxy = vi.fn<() => Promise<number>>();
  const logStreams: { end: ReturnType<typeof vi.fn>; write: ReturnType<typeof vi.fn> }[] = [];
  const createWriteStream = vi.fn(() => {
    const log = { end: vi.fn(), write: vi.fn() };
    logStreams.push(log);
    return log;
  });
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const spawn = vi.fn((_binary: string, _args: string[], _options: unknown) => child);
  const shellEnvSync = vi.fn(() => ({}));
  const dependencies: Record<string, unknown> = {
    child_process: { spawn },
    electron: { app: { isPackaged: false, getVersion: () => '2.12.2' }, session: {} },
    'shell-env': { shellEnvSync },
    fs: { createWriteStream },
    path,
    readline,
    stream: { PassThrough },
    './paths': {
      getLsLogPath: () => path.resolve('fixture', 'language-server.log'),
      getAppDataDirName: () => 'fixture',
      getActivePortFilePath: () => path.resolve('fixture', 'port'),
    },
    './constants': {},
    './utils': { setupNodeWrapper: vi.fn() },
    './proxy': { startProxy },
  };
  const module = {
    exports: {} as {
      startLanguageServer: (port: number, csrf: string) => Promise<{ port: number; exitPromise: Promise<unknown> }>;
    },
  };
  runInNewContext(source, {
    exports: module.exports,
    module,
    require: (id: string) => {
      if (!Object.hasOwn(dependencies, id)) throw new Error(`Unexpected dependency: ${id}`);
      return dependencies[id];
    },
    __dirname: path.resolve('src'),
    process: { platform: process.platform, env: {} },
    console: { error: vi.fn(), log: vi.fn() },
    setTimeout,
    clearTimeout,
  });
  return { startProxy, spawn, shellEnvSync, logStreams, child, start: module.exports.startLanguageServer };
}

describe('language-server proxy startup dependency', () => {
  it.each([
    ['EADDRINUSE', 'Port 50999 is occupied. The patched language server requires this exact port'],
    ['EINVAL', 'Invalid antigravity-proxy.json: the binary patch requires port 50999'],
    ['EACCES', 'Proxy listener permission denied'],
  ])('does not spawn or silently select a remote fallback after proxy rejection: %s', async (code, message) => {
    const fixture = createFixture();
    const failure = Object.assign(new Error(message), { code });
    fixture.startProxy.mockRejectedValue(failure);
    await expect(fixture.start(0, 'fixture-token')).rejects.toBe(failure);
    expect(fixture.spawn).not.toHaveBeenCalled();
    expect(fixture.shellEnvSync).not.toHaveBeenCalled();
    expect(fixture.logStreams[0].end).toHaveBeenCalledOnce();
  });

  it('can retry successfully after the proxy startup condition is resolved', async () => {
    const fixture = createFixture();
    const failure = Object.assign(new Error('Port 50999 is occupied'), { code: 'EADDRINUSE' });
    fixture.startProxy.mockRejectedValueOnce(failure).mockResolvedValueOnce(50999);
    await expect(fixture.start(0, 'fixture-token')).rejects.toBe(failure);

    const pending = fixture.start(0, 'fixture-token');
    await new Promise((resolve) => setImmediate(resolve));
    expect(fixture.spawn).toHaveBeenCalledOnce();
    const args = fixture.spawn.mock.calls[0][1] as string[];
    expect(args[args.indexOf('--api_server_url') + 1]).toBe('http://127.0.0.1:50999');
    fixture.child.stdout.write('listening on HTTP port at 60001 for HTTP\n');
    const handle = await pending;
    expect(handle.port).toBe(60001);
    fixture.child.emit('exit', 0, null);
    await handle.exitPromise;
    fixture.child.stdout.end();
    fixture.child.stderr.end();
    expect(fixture.logStreams.every((stream) => stream.end.mock.calls.length === 1)).toBe(true);
  });

  it('uses a dynamic proxy port when normal unpatched startup succeeds', async () => {
    const fixture = createFixture();
    fixture.startProxy.mockResolvedValue(61002);
    const pending = fixture.start(0, 'fixture-token');
    await new Promise((resolve) => setImmediate(resolve));
    const args = fixture.spawn.mock.calls[0][1] as string[];
    for (const flag of ['--api_server_url', '--cloud_code_endpoint', '--inference_api_server_url']) {
      expect(args[args.indexOf(flag) + 1]).toBe('http://127.0.0.1:61002');
    }
    fixture.child.stdout.write('listening on HTTP port at 60003 for HTTP\n');
    const handle = await pending;
    expect(handle.port).toBe(60003);
    fixture.child.emit('exit', 0, null);
    await handle.exitPromise;
    fixture.child.stdout.end();
    fixture.child.stderr.end();
  });
});
