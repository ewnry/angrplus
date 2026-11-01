// eslint-disable-next-line @typescript-eslint/no-var-requires
const { safeStorage, app } = require('electron');
import * as fs from 'fs';
import * as path from 'path';
import { randomBytes, createCipheriv, createDecipheriv } from 'crypto';

function localKey(create: boolean): Buffer {
  const directory = path.join(app.getPath('home'), '.gemini', 'antigravity');
  const filename = path.join(directory, '.model-credentials-key');
  if (create && !fs.existsSync(filename)) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      fs.writeFileSync(filename, randomBytes(32), { mode: 0o600, flag: 'wx' });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  const key = fs.readFileSync(filename);
  if (key.length !== 32) throw new Error('Invalid local credential encryption key');
  return key;
}

function encryptLocal(value: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', localKey(true), iv);
  const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return 'local-gcm:' + Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64');
}

/**
 * Creates a backup of the specified file with a .bak extension.
 */
export function backupFile(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      const backupPath = filePath + '.bak';
      fs.copyFileSync(filePath, backupPath);
      console.log(`[CryptoStore] Backup created successfully at: ${backupPath}`);
    }
  } catch (err) {
    console.error('[CryptoStore] Failed to create file backup:', err);
  }
}

/**
 * Checks if Electron's safeStorage API is fully functional on the current system.
 */
export function isEncryptionAvailable(): boolean {
  try {
    return !!(safeStorage && safeStorage.isEncryptionAvailable());
  } catch (_e) {
    return false;
  }
}

/**
 * Use OS-backed storage when available; otherwise AES-GCM with a local user key.
 */
export function encryptString(plainText: string): string {
  if (!plainText || plainText === 'none') return plainText;

  if (isEncryptionAvailable()) {
    try {
      const buffer = safeStorage.encryptString(plainText);
      return 'enc:' + buffer.toString('base64');
    } catch (err) {
      console.error('[CryptoStore] safeStorage encryption failed; using local authenticated encryption.');
      return encryptLocal(plainText);
    }
  } else {
    return encryptLocal(plainText);
  }
}

/**
 * Decrypts a previously encrypted string. Handles safeStorage, base64 fallback, and plaintext gracefully.
 */
export function decryptString(encryptedText: string): string {
  if (!encryptedText || encryptedText === 'none') return encryptedText;

  if (encryptedText.startsWith('local-gcm:')) {
    try {
      const bytes = Buffer.from(encryptedText.slice(10), 'base64');
      if (bytes.length < 28) throw new Error('Truncated ciphertext');
      const cipher = createDecipheriv('aes-256-gcm', localKey(false), bytes.subarray(0, 12));
      cipher.setAuthTag(bytes.subarray(12, 28));
      return Buffer.concat([cipher.update(bytes.subarray(28)), cipher.final()]).toString('utf8');
    } catch {
      return 'DECRYPTION_FAILED';
    }
  }

  if (encryptedText.startsWith('enc:')) {
    const base64Data = encryptedText.substring(4);
    if (isEncryptionAvailable()) {
      try {
        const buffer = Buffer.from(base64Data, 'base64');
        return safeStorage.decryptString(buffer);
      } catch (err) {
        console.error('[CryptoStore] safeStorage decryption failed:', err);
        return 'DECRYPTION_FAILED';
      }
    } else {
      console.error(
        '[CryptoStore] safeStorage is unavailable, but data was encrypted with it. Trying fallback raw data.',
      );
      return 'DECRYPTION_FAILED_STORAGE_UNAVAILABLE';
    }
  } else if (encryptedText.startsWith('fallback:')) {
    const base64Data = encryptedText.substring(9);
    try {
      return Buffer.from(base64Data, 'base64').toString('utf-8');
    } catch (err) {
      console.error('[CryptoStore] Fallback base64 decryption failed:', err);
      return 'DECRYPTION_FAILED';
    }
  }

  // Plaintext (older config, not yet migrated)
  return encryptedText;
}

interface ModelWithKey {
  apiKey?: string;
  encrypted?: boolean;
  provider?: string;
  [key: string]: unknown;
}

/**
 * Iterates through a list of custom models and encrypts their API keys.
 */
export function encryptModels(models: ModelWithKey[] | null): ModelWithKey[] {
  if (!models || !Array.isArray(models)) return [];
  return models.map((model) => {
    if (model.apiKey && model.apiKey !== 'none' && !model.encrypted) {
      return {
        ...model,
        apiKey: encryptString(model.apiKey),
        encrypted: true,
      };
    }
    return model;
  });
}

/**
 * Iterates through a list of custom models and decrypts their API keys for in-memory use.
 */
export function decryptModels(models: ModelWithKey[] | null): ModelWithKey[] {
  if (!models || !Array.isArray(models)) return [];
  return models.map((model) => {
    if (model.encrypted) {
      return {
        ...model,
        apiKey: decryptString(model.apiKey as string),
        encrypted: false,
      };
    }
    return model;
  });
}
