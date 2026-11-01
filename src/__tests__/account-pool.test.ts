import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => 'C:\\Users\\ewinnerka'),
  },
}));

import {
  mergeAccountQuotas,
  isClaudeModel,
  isAccountExhaustedForModel,
  getAccountQuotaForModel,
  type PooledAccount,
  type QuotaGroupInfo,
} from '../accountPool';

function makeMockAccount(id: string, email: string): PooledAccount {
  return {
    id,
    email,
    clientId: 'test-client',
    refreshToken: 'mock-refresh',
    cooldownUntil: 0,
  };
}

function makeMockQuota(
  geminiWeekly: number,
  gemini5h: number,
  claudeWeekly: number,
  claude5h: number,
): PooledAccount['lastQuota'] {
  return {
    checkedAt: Date.now(),
    remainingFraction: Math.min(geminiWeekly, gemini5h, claudeWeekly, claude5h),
    resetTime: '2026-10-14T18:00:00Z',
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            id: 'gemini-weekly',
            displayName: 'Weekly Limit Remaining (Combined 4/5)',
            remainingFraction: geminiWeekly,
            resetTime: '2026-10-21T00:00:00Z',
          },
          {
            id: 'gemini-5h',
            displayName: 'Five Hour Limit Remaining (Combined 4/5)',
            remainingFraction: gemini5h,
            resetTime: '2026-10-14T18:00:00Z',
          },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          {
            id: '3p-weekly',
            displayName: 'Weekly Limit Remaining (Combined 4/5)',
            remainingFraction: claudeWeekly,
            resetTime: '2026-10-21T00:00:00Z',
          },
          {
            id: '3p-5h',
            displayName: 'Five Hour Limit Remaining (Combined 4/5)',
            remainingFraction: claude5h,
            resetTime: '2026-10-14T18:00:00Z',
          },
        ],
      },
    ],
  };
}

describe('Antigravity Account Pool Quota Aggregation', () => {
  const acc1 = makeMockAccount('acc-1', 'user1@gmail.com');
  const acc2 = makeMockAccount('acc-2', 'user2@gmail.com');

  // Account 1: Gemini 84% weekly, 81% 5h; Claude 0% weekly, 100% 5h
  const quota1 = makeMockQuota(0.84, 0.81, 0.0, 1.0);
  // Account 2: Gemini 100% weekly, 100% 5h; Claude 100% weekly, 100% 5h
  const quota2 = makeMockQuota(1.0, 1.0, 1.0, 1.0);

  it('Mode 1 (normalized): scales to 0..100% max and shortens bucket labels to Weekly (2 accounts)', () => {
    const { summary, aggregatedResponse } = mergeAccountQuotas(
      [acc1, acc2],
      [quota1, quota2],
      {
        activeAccountId: 'acc-1',
        quotaDisplayMode: 'normalized',
        showActiveInLimits: false,
      },
    );

    // Sum of acc min fractions: acc1 has min 0.0, acc2 has min 1.0 -> avg = 0.5
    expect(summary.totalAccounts).toBe(2);
    expect(summary.combinedRemainingFraction).toBeCloseTo(0.5, 2);
    expect(summary.totalCapacityPercent).toBe(50);

    // Check bucket formatting in Gemini group
    const geminiGroup = summary.groups.find((g) => g.displayName === 'Gemini Models');
    expect(geminiGroup).toBeDefined();

    const weeklyBucket = geminiGroup!.buckets.find((b) => b.id === 'gemini-weekly');
    expect(weeklyBucket).toBeDefined();
    // Label should be clean and short: "Weekly (2 accounts)"
    expect(weeklyBucket!.displayName).toBe('Weekly (2 accounts)');
    // Average of 0.84 and 1.0 = 0.92
    expect(weeklyBucket!.remainingFraction).toBeCloseTo(0.92, 2);

    const fiveHourBucket = geminiGroup!.buckets.find((b) => b.id === 'gemini-5h');
    expect(fiveHourBucket).toBeDefined();
    expect(fiveHourBucket!.displayName).toBe('5 Hours (2 accounts)');
    // Average of 0.81 and 1.0 = 0.905
    expect(fiveHourBucket!.remainingFraction).toBeCloseTo(0.905, 2);

    // Check raw response structure for Antigravity's internal API
    const rawGroups = aggregatedResponse.groups as Array<{ buckets: Array<{ displayName: string }> }>;
    expect(rawGroups[0].buckets[0].displayName).toBe('Weekly (2 accounts)');
  });

  it('Mode 2 (additive): sums fractions across accounts (e.g. 184%)', () => {
    const { summary } = mergeAccountQuotas(
      [acc1, acc2],
      [quota1, quota2],
      {
        activeAccountId: 'acc-1',
        quotaDisplayMode: 'additive',
        showActiveInLimits: false,
      },
    );

    const geminiGroup = summary.groups.find((g) => g.displayName === 'Gemini Models');
    const weeklyBucket = geminiGroup!.buckets.find((b) => b.id === 'gemini-weekly');
    // Sum of 0.84 + 1.0 = 1.84 (184%)
    expect(weeklyBucket!.remainingFraction).toBeCloseTo(1.84, 2);
    expect(weeklyBucket!.displayName).toBe('Weekly (2 accounts)');
  });

  it('Mode 3 (active): displays active account quota only', () => {
    const { summary } = mergeAccountQuotas(
      [acc1, acc2],
      [quota1, quota2],
      {
        activeAccountId: 'acc-1',
        quotaDisplayMode: 'active',
        showActiveInLimits: false,
      },
    );

    const geminiGroup = summary.groups.find((g) => g.displayName === 'Gemini Models');
    const weeklyBucket = geminiGroup!.buckets.find((b) => b.id === 'gemini-weekly');
    // Active account (acc-1) has 0.84
    expect(weeklyBucket!.remainingFraction).toBeCloseTo(0.84, 2);
    expect(weeklyBucket!.displayName).toBe('Weekly (Active)');
  });

  it('appends an extra Active Account row when showActiveInLimits is true', () => {
    const { summary } = mergeAccountQuotas(
      [acc1, acc2],
      [quota1, quota2],
      {
        activeAccountId: 'acc-1',
        quotaDisplayMode: 'normalized',
        showActiveInLimits: true,
      },
    );

    const geminiGroup = summary.groups.find((g) => g.displayName === 'Gemini Models');
    // Should have 4 buckets: Weekly (2 accounts), Weekly (Active), 5 Hours (2 accounts), 5 Hours (Active)
    expect(geminiGroup!.buckets.length).toBe(4);

    const activeWeekly = geminiGroup!.buckets.find((b) => b.id === 'gemini-weekly-active');
    expect(activeWeekly).toBeDefined();
    expect(activeWeekly!.displayName).toBe('Weekly (Active)');
    expect(activeWeekly!.remainingFraction).toBeCloseTo(0.84, 2);

    const active5h = geminiGroup!.buckets.find((b) => b.id === 'gemini-5h-active');
    expect(active5h).toBeDefined();
    expect(active5h!.displayName).toBe('5 Hours (Active)');
    expect(active5h!.remainingFraction).toBeCloseTo(0.81, 2);
  });

  describe('Model-Aware Account Selection & Exhaustion', () => {
    it('correctly identifies Claude and 3P models', () => {
      expect(isClaudeModel('claude-sonnet-4-6')).toBe(true);
      expect(isClaudeModel('claude-3-5-sonnet')).toBe(true);
      expect(isClaudeModel('3p-model-xyz')).toBe(true);
      expect(isClaudeModel('gpt-oss')).toBe(true);
      expect(isClaudeModel('gemini-2.5-pro')).toBe(false);
      expect(isClaudeModel('gemini-3.8-flash-high')).toBe(false);
      expect(isClaudeModel(undefined)).toBe(false);
    });

    it('considers account exhausted for Claude when 3P bucket is 0 even if Gemini quota is 100%', () => {
      const acc = makeMockAccount('acc-1', 'user1@gmail.com');
      acc.lastQuota = makeMockQuota(1.0, 1.0, 0.0, 1.0); // 0% Claude weekly, 100% Gemini

      expect(isAccountExhaustedForModel(acc, 'claude-sonnet-4-6')).toBe(true);
      expect(isAccountExhaustedForModel(acc, 'gemini-2.5-pro')).toBe(false);
    });

    it('considers account exhausted for Gemini when Gemini bucket is 0 even if Claude quota is 100%', () => {
      const acc = makeMockAccount('acc-2', 'user2@gmail.com');
      acc.lastQuota = makeMockQuota(0.0, 1.0, 1.0, 1.0); // 0% Gemini weekly, 100% Claude

      expect(isAccountExhaustedForModel(acc, 'claude-sonnet-4-6')).toBe(false);
      expect(isAccountExhaustedForModel(acc, 'gemini-2.5-pro')).toBe(true);
    });

    it('respects model-specific cooldowns independently', () => {
      const acc = makeMockAccount('acc-3', 'user3@gmail.com');
      acc.lastQuota = makeMockQuota(1.0, 1.0, 1.0, 1.0);
      acc.modelCooldowns = { claude: Date.now() + 60_000 };

      expect(isAccountExhaustedForModel(acc, 'claude-sonnet-4-6')).toBe(true);
      expect(isAccountExhaustedForModel(acc, 'gemini-2.5-pro')).toBe(false);
    });

    it('returns model-specific remaining quota fraction for candidate sorting', () => {
      const acc = makeMockAccount('acc-4', 'user4@gmail.com');
      acc.lastQuota = makeMockQuota(0.9, 0.8, 0.4, 0.3);

      expect(getAccountQuotaForModel(acc, 'claude-sonnet-4-6')).toBeCloseTo(0.3, 2);
      expect(getAccountQuotaForModel(acc, 'gemini-2.5-pro')).toBeCloseTo(0.8, 2);
    });
  });
});
