import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

describe('plugin account provider', () => {
  it('routes through the registered provider, preserves fallback operations and restores on disposal', async () => {
    const source = readFileSync('src/proxy.ts', 'utf8');
    const start = source.indexOf('type AccountPoolProvider =');
    const end = source.indexOf('// Dynamic imports', start);
    const text = source.slice(start, end).replace('export function registerAccountProvider', 'function registerAccountProvider') + '\nthis.register = registerAccountProvider; this.getPool = getAccountPool;';
    const js = ts.transpileModule(text, { compilerOptions: { target: ts.ScriptTarget.ES2020 } }).outputText;
    const builtin = { loadPoolConfig: () => ({ accounts: [] }), getEffectiveAccountForRequest: vi.fn(), fetchCombinedPoolQuota: vi.fn() };
    const context: any = { require: () => builtin, console }; runInNewContext(js, context);
    const selection = vi.fn().mockResolvedValue({ account: { id: 'custom' } });
    const provider = { loadPoolConfig: () => ({ accounts: [{ id: 'custom' }] }), getEffectiveAccountForRequest: selection };
    const dispose = context.register(provider);
    expect(context.getPool().loadPoolConfig().accounts[0].id).toBe('custom');
    expect((await context.getPool().getEffectiveAccountForRequest('model')).account.id).toBe('custom');
    expect(context.getPool().fetchCombinedPoolQuota).toBe(builtin.fetchCombinedPoolQuota);
    expect(() => context.register(provider)).toThrow('already registered');
    dispose(); expect(context.getPool()).toBe(builtin);
  });
});
