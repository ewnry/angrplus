import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import * as https from 'node:https';

const disk = vi.hoisted(() => ({ current: '', temporary: '' }));
vi.mock('electron', () => ({ app: { getPath: () => 'C:/fixture' } }));
vi.mock('electron-log', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('node:fs', () => ({
  existsSync: () => true,
  readFileSync: () => disk.current,
  writeFileSync: (_path: string, content: string) => { disk.temporary = content; },
  renameSync: () => { disk.current = disk.temporary; },
}));
vi.mock('node:https', () => ({ request: vi.fn() }));
import { loadPoolConfig, savePoolConfig, refreshPooledAccount, type PooledAccount } from '../accountPool';

afterEach(() => vi.clearAllMocks());
describe('pool OAuth concurrency', () => {
  it('shares one refresh and preserves quota/cooldown changes made while waiting', async () => {
    const account: PooledAccount = { id: 'a', email: 'fixture@example.invalid', refreshToken: 'fixture-refresh', clientId: 'fixture', cooldownUntil: 0 };
    disk.current = JSON.stringify({ accounts: [account] });
    let respond: (response: EventEmitter) => void;
    const request = Object.assign(new EventEmitter(), { write: vi.fn(), end: vi.fn(), setTimeout: vi.fn(), destroy: vi.fn() });
    vi.mocked(https.request).mockImplementation(((_url, _options, callback) => { respond = callback; return request; }) as any);
    const first = refreshPooledAccount(account);
    const second = refreshPooledAccount(account);
    expect(first).toBe(second);
    expect(https.request).toHaveBeenCalledTimes(1);
    const config = loadPoolConfig();
    config.accounts[0].cooldownUntil = 123456;
    config.accounts[0].modelCooldowns = { claude: 987654 };
    savePoolConfig(config);
    const response = Object.assign(new EventEmitter(), { statusCode: 200 });
    respond!(response);
    response.emit('data', JSON.stringify({ access_token: 'fixture-access', expires_in: 3600 })); response.emit('end');
    const refreshed = await first;
    expect(refreshed.cooldownUntil).toBe(123456);
    expect(loadPoolConfig().accounts[0]).toMatchObject({ accessToken: 'fixture-access', modelCooldowns: { claude: 987654 } });
  });
});
