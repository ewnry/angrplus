import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(fs.readFileSync(path.resolve('src/cryptoStore.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const directories: string[] = [];
function fixture(available = false, failEncryption = false) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-crypto-'));
  directories.push(directory);
  const api = {} as { encryptString(value: string): string; decryptString(value: string): string };
  const dependencies: Record<string, unknown> = {
    fs,
    path,
    crypto,
    electron: {
      app: { getPath: () => directory },
      safeStorage: {
        isEncryptionAvailable: () => available,
        encryptString: (value: string) => {
          if (failEncryption) throw new Error('fixture');
          return Buffer.from(`os:${value}`);
        },
        decryptString: (value: Buffer) => value.toString().slice(3),
      },
    },
  };
  runInNewContext(source, {
    exports: api,
    require: (id: string) => {
      if (!(id in dependencies)) throw new Error(`Unexpected import: ${id}`);
      return dependencies[id];
    },
    Buffer,
    console: { log() {}, error() {} },
  });
  return { ...api, directory, keyPath: path.join(directory, '.gemini', 'antigravity', '.model-credentials-key') };
}
afterEach(() => {
  for (const directory of directories.splice(0)) {
    if (path.dirname(directory) !== path.resolve(os.tmpdir()) || !path.basename(directory).startsWith('agy-crypto-'))
      throw new Error('Invalid fixture path');
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
describe('credential encryption', () => {
  it('uses randomized authenticated encryption when OS storage is unavailable', () => {
    const codec = fixture();
    const first = codec.encryptString('secret-token');
    const second = codec.encryptString('secret-token');
    expect(first).toMatch(/^local-gcm:/);
    expect(second).not.toBe(first);
    expect(codec.decryptString(first)).toBe('secret-token');
    expect(fs.readFileSync(codec.keyPath)).toHaveLength(32);
    const tampered = Buffer.from(first.slice(10), 'base64');
    tampered[tampered.length - 1] ^= 1;
    expect(codec.decryptString(`local-gcm:${tampered.toString('base64')}`)).toBe('DECRYPTION_FAILED');
  });
  it('fails closed for missing, replaced or truncated encryption data', () => {
    const codec = fixture();
    const encrypted = codec.encryptString('secret');
    fs.writeFileSync(codec.keyPath, crypto.randomBytes(32));
    expect(codec.decryptString(encrypted)).toBe('DECRYPTION_FAILED');
    fs.unlinkSync(codec.keyPath);
    expect(codec.decryptString(encrypted)).toBe('DECRYPTION_FAILED');
    expect(fs.existsSync(codec.keyPath)).toBe(false);
    expect(codec.decryptString('local-gcm:AA==')).toBe('DECRYPTION_FAILED');
    expect(codec.decryptString('enc:AA==')).toBe('DECRYPTION_FAILED_STORAGE_UNAVAILABLE');
  });
  it('prefers OS storage and can still read legacy configuration', () => {
    const codec = fixture(true);
    const encrypted = codec.encryptString('secret');
    expect(encrypted).toMatch(/^enc:/);
    expect(codec.decryptString(encrypted)).toBe('secret');
    expect(fs.existsSync(codec.keyPath)).toBe(false);
    expect(codec.decryptString('fallback:c2VjcmV0')).toBe('secret');
    expect(codec.decryptString('plain-old-key')).toBe('plain-old-key');
  });
  it('uses authenticated fallback when OS encryption throws', () => {
    const codec = fixture(true, true);
    const encrypted = codec.encryptString('secret');
    expect(encrypted).toMatch(/^local-gcm:/);
    expect(codec.decryptString(encrypted)).toBe('secret');
  });
});
