import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const compiled = ts.transpileModule(readFileSync(path.resolve('src/customIpc.ts'), 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;

describe('pool status startup contract', () => {
  it('returns saved theme and prompt settings without fetching remote quotas', async () => {
    const handlers = new Map<string, (...args: any[]) => any>();
    const refresh = vi.fn();
    const merge = vi.fn(() => ({ summary: { totalAccounts: 0 } }));
    const dependencies: Record<string, unknown> = {
      './themeIcons': { applyThemeIcon: vi.fn() },
      electron: { app: { getPath: () => 'C:/fixture' }, ipcMain: { handle: (name: string, handler: any) => handlers.set(name, handler) }, shell: {} },
      'node:path': path,
      './cryptoStore': {},
      './modelManagement': { createModelManager: () => ({ store: {} }) },
      './accountPool': {
        loadPoolConfig: () => ({ accounts: [], uiThemeMode: 'claude', promptEngineMode: 'custom', customPromptText: 'fixture', soundEnabled: false }),
        mergeAccountQuotas: merge, fetchCombinedPoolQuota: refresh,
      },
      './plusUpdater': { ANTIGRAVITY_PLUS_VERSION: '2.1.6' },
    };
    const exports: any = {};
    runInNewContext(compiled, { exports, require: (name: string) => dependencies[name], process, console });
    exports.registerCustomModelHandlers();
    const result = await handlers.get('pool:get-status')!({});
    expect(result).toMatchObject({ success: true, uiThemeMode: 'claude', promptEngineMode: 'custom', customPromptText: 'fixture', soundEnabled: false });
    expect(refresh).not.toHaveBeenCalled();
    expect(merge).toHaveBeenCalledOnce();
  });
});
