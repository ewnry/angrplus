import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import { BrowserWindow } from 'electron';
import { EventEmitter } from 'events';


export class StorageManager {
  private storagePath: string;
  private defaults: Map<string, boolean> | undefined;
  private emitter: EventEmitter;
  onDidChange: (listener: (changes: Record<string, string | null>) => void) => { dispose(): void };

  constructor(storagePath: string, defaults?: Map<string, boolean>) {
    this.storagePath = storagePath;
    this.defaults = defaults;
    this.emitter = new EventEmitter();
    this.onDidChange = (listener) => {
      this.emitter.on('changed', listener);
      return {
        dispose: () => this.emitter.off('changed', listener),
      };
    };
  }


  async getRawItems(): Promise<Record<string, string>> {
    try {
      if (!existsSync(this.storagePath)) {
        return {};
      }
      const content = await fs.readFile(this.storagePath, 'utf-8');
      if (!content || content.trim() === '') {
        return {};
      }
      return JSON.parse(content);
    } catch (e) {
      console.error('Error reading storage items:', e);
      return {};
    }
  }


  async getItems(): Promise<Record<string, string | null>> {
    const items = await this.getRawItems();
    const merged: Record<string, string | null> = { ...items };
    if (this.defaults) {
      for (const [key, value] of this.defaults.entries()) {
        if (merged[key] === undefined) {
          merged[key] = String(value);
        }
      }
    }
    return merged;
  }


  async updateItems(changes: Record<string, string | null>): Promise<void> {
    try {
      const currentItems = await this.getRawItems();
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) {
          delete currentItems[key];
        } else {
          currentItems[key] = value;
        }
      }

      const dir = path.dirname(this.storagePath);
      if (!existsSync(dir)) {
        await fs.mkdir(dir, { recursive: true });
      }
      await fs.writeFile(this.storagePath, JSON.stringify(currentItems, null, 2), 'utf-8');
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        win.webContents.send('storage:changed', changes);
      }
      this.emitter.emit('changed', changes);
    } catch (e) {
      console.error('Error updating storage items:', e);
      throw e;
    }
  }
}
