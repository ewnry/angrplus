import { describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => tmpdir()),
    quit: vi.fn(),
  },
}));

vi.mock('electron-log', () => ({
  default: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  },
}));

import {
  ANTIGRAVITY_PLUS_VERSION,
  compareVersions,
  checkForUpdates,
  downloadUpdateInstaller,
  downloadUpdate,
  isValidAsarBuffer,
  getAppAsarPath,
  getRestartExecutable,
  readAsarPackageVersion,
} from '../plusUpdater';
import * as zlib from 'node:zlib';

describe('plusUpdater', () => {
  it('reads the actual vendor version and refuses invalid archive offsets', () => {
    const pkg = Buffer.from(JSON.stringify({ name: 'antigravity', version: '2.24.0' }));
    const json = Buffer.from(JSON.stringify({ files: { 'package.json': { offset: '0', size: pkg.length } } }));
    const headerSize = 8 + Math.ceil(json.length / 4) * 4;
    const bytes = Buffer.alloc(8 + headerSize + pkg.length);
    bytes.writeUInt32LE(4, 0); bytes.writeUInt32LE(headerSize, 4);
    bytes.writeUInt32LE(headerSize - 4, 8); bytes.writeUInt32LE(json.length, 12);
    json.copy(bytes, 16); pkg.copy(bytes, 8 + headerSize);
    expect(readAsarPackageVersion(bytes)).toBe('2.24.0');
    bytes.writeUInt32LE(0xffffffff, 4);
    expect(() => readAsarPackageVersion(bytes)).toThrow(/bounds/);
  });
  describe('compareVersions', () => {
    it('correctly compares semantic versions', () => {
      expect(compareVersions('2.1.1', '2.1.0')).toBe(1);
      expect(compareVersions('2.1.0', '2.1.1')).toBe(-1);
      expect(compareVersions('2.1.0', '2.1.0')).toBe(0);
      expect(compareVersions('v2.2.0', '2.1.9')).toBe(1);
      expect(compareVersions('3.0.0', '2.99.99')).toBe(1);
      expect(compareVersions('2.1.0-beta.1', '2.1.0')).toBe(0);
    });
  });

  describe('isValidAsarBuffer', () => {
    it('identifies valid ASAR headers', () => {
      const validAsar = Buffer.from([0x04, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
      expect(isValidAsarBuffer(validAsar)).toBe(true);

      const invalid = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x10, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08]);
      expect(isValidAsarBuffer(invalid)).toBe(false);

      const tooShort = Buffer.from([0x04, 0x00, 0x00, 0x00]);
      expect(isValidAsarBuffer(tooShort)).toBe(false);
    });
  });

  describe('getAppAsarPath and getRestartExecutable', () => {
    it('returns a non-empty string path for app.asar', () => {
      const asarPath = getAppAsarPath();
      expect(typeof asarPath).toBe('string');
      expect(asarPath.length).toBeGreaterThan(0);
    });

    it('returns executable info for restart', () => {
      const restart = getRestartExecutable();
      expect(restart.execPath).toBeDefined();
    });
  });

  describe('checkForUpdates with local mock server', () => {
    it('detects a newer version when available and resolves asarUrl', async () => {
      const server = http.createServer((req, res) => {
        if (req.url === '/api/version') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              version: '99.0.0',
              downloadUrl: '/api/download',
              asarUrl: '/app.asar.gz',
              installerSha256: 'a'.repeat(64),
              changelog: 'Super update',
              releaseDate: '2026-10-15',
            }),
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as any).port;
      const serverUrl = `http://127.0.0.1:${port}`;

      try {
        const result = await checkForUpdates(serverUrl);
        expect(result.success).toBe(true);
        expect(result.updateAvailable).toBe(true);
        expect(result.latestVersion).toBe('99.0.0');
        expect(result.downloadUrl).toBe(`${serverUrl}/api/download`);
        expect(result.installerSha256).toBe('a'.repeat(64));
        expect(result.asarUrl).toBe(`${serverUrl}/app.asar.gz`);
        expect(result.changelog).toBe('Super update');
      } finally {
        server.close();
      }
    });

    it('reports no update when already on the latest version', async () => {
      const server = http.createServer((req, res) => {
        if (req.url === '/api/version') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              version: ANTIGRAVITY_PLUS_VERSION,
              downloadUrl: '/api/download',
            }),
          );
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as any).port;
      const serverUrl = `http://127.0.0.1:${port}`;

      try {
        const result = await checkForUpdates(serverUrl);
        expect(result.success).toBe(true);
        expect(result.updateAvailable).toBe(false);
        expect(result.currentVersion).toBe(ANTIGRAVITY_PLUS_VERSION);
      } finally {
        server.close();
      }
    });

    it('gracefully handles server errors', async () => {
      const result = await checkForUpdates('http://127.0.0.1:59999');
      expect(result.success).toBe(false);
      expect(result.updateAvailable).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe('downloadUpdate', () => {
    it('rejects an HTML error page even if its URL ends with .exe', async () => {
      const server = http.createServer((_req, res) => res.end('<html>upstream unavailable</html>'));
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      try {
        await expect(downloadUpdate(`http://127.0.0.1:${(server.address() as any).port}/update.exe`)).rejects.toThrow(/neither/);
      } finally { server.close(); }
    });
    it('downloads and transparently decompress gzipped ASAR', async () => {
      // Mock ASAR header + payload
      const mockAsar = Buffer.alloc(100);
      mockAsar[0] = 0x04;
      mockAsar[1] = 0x00;
      mockAsar[2] = 0x00;
      mockAsar[3] = 0x00;
      mockAsar.write('{"files":{}}', 16, 'utf8');

      const gzipped = zlib.gzipSync(mockAsar);

      const server = http.createServer((req, res) => {
        if (req.url === '/app.asar.gz') {
          res.writeHead(200, {
            'Content-Type': 'application/gzip',
            'Content-Length': String(gzipped.length),
          });
          res.end(gzipped);
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as any).port;
      const downloadUrl = `http://127.0.0.1:${port}/app.asar.gz`;

      try {
        let progressCalled = false;
        const result = await downloadUpdate(downloadUrl, (p) => {
          progressCalled = true;
          expect(p.percent).toBeGreaterThanOrEqual(0);
        });

        expect(result.type).toBe('asar');
        expect(fs.existsSync(result.filePath)).toBe(true);
        expect(fs.readFileSync(result.filePath)).toEqual(mockAsar);
        expect(progressCalled).toBe(true);

        try {
          fs.unlinkSync(result.filePath);
        } catch {
          /* ignore */
        }
      } finally {
        server.close();
      }
    });

    it('downloads binary PE executable installer as type: installer', async () => {
      const payload = Buffer.alloc(1024 * 10, 0);
      payload[0] = 0x4d; // 'M'
      payload[1] = 0x5a; // 'Z'

      const server = http.createServer((req, res) => {
        if (req.url === '/api/download') {
          res.writeHead(200, {
            'Content-Type': 'application/vnd.microsoft.portable-executable',
            'Content-Length': String(payload.length),
          });
          res.end(payload);
        } else {
          res.writeHead(404);
          res.end();
        }
      });

      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
      const port = (server.address() as any).port;
      const downloadUrl = `http://127.0.0.1:${port}/api/download`;

      try {
        const result = await downloadUpdate(downloadUrl);
        expect(result.type).toBe('installer');
        expect(fs.existsSync(result.filePath)).toBe(true);
        expect(fs.readFileSync(result.filePath)).toEqual(payload);

        try {
          fs.unlinkSync(result.filePath);
        } catch {
          /* ignore */
        }
      } finally {
        server.close();
      }
    });
  });
});
