import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'http';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { getRequiredProxyPort, listenProxy } from '../proxy/listen';

const servers: Server[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'antigravity-port-'));
  directories.push(directory);
  return directory;
}
function server() {
  const result = createServer();
  servers.push(result);
  return result;
}

describe('proxy listener used by the language server', () => {
  it('retains dynamic fallback when no fixed binary endpoint is required', async () => {
    const occupied = await listenProxy(server(), 0);
    const actual = await listenProxy(server(), occupied);
    expect(actual).not.toBe(occupied);
    expect(actual).toBeGreaterThan(0);
  });

  it('fails explicitly when the binary-required port is occupied', async () => {
    const occupied = await listenProxy(server(), 0);
    await expect(listenProxy(server(), occupied, false)).rejects.toMatchObject({
      code: 'EADDRINUSE',
      message: expect.stringContaining('requires this exact port'),
    });
  });

  it('uses the installer marker to require the fixed port', () => {
    const directory = fixture();
    expect(getRequiredProxyPort(directory)).toBeUndefined();
    writeFileSync(join(directory, 'antigravity-proxy.json'), JSON.stringify({ requiredPort: 50999 }));
    expect(getRequiredProxyPort(directory)).toBe(50999);
  });

  it.each(['{', '{"requiredPort":80}', '{}'])('rejects invalid marker %s rather than choosing another port', (value) => {
    const directory = fixture();
    writeFileSync(join(directory, 'antigravity-proxy.json'), value);
    expect(() => getRequiredProxyPort(directory)).toThrow();
  });
});
