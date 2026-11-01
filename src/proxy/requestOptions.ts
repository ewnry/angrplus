import type { CustomModel } from '../proxy';
import type { ApiFormat } from '../providers';

export interface GeminiBody {
  contents?: { role?: string; parts?: { functionResponse?: unknown; [key: string]: unknown }[] }[];
  generationConfig?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Conservative estimate, not a tokenizer. Drop whole oldest turns, never half a tool exchange. */
export function trimContext(body: GeminiBody, contextWindow?: number, maxOutputTokens = 0): GeminiBody {
  if (!contextWindow) return body;
  const budget = contextWindow - maxOutputTokens;
  const estimate = (value: unknown) => Math.ceil(Buffer.byteLength(JSON.stringify(value), 'utf8') / 3);
  const groups: NonNullable<GeminiBody['contents']>[] = [];
  for (const content of body.contents || []) {
    const startsTurn = content.role !== 'model' && !content.parts?.some((part) => part.functionResponse);
    if (!groups.length || startsTurn) groups.push([]);
    groups[groups.length - 1].push(content);
  }
  const result = { ...body, contents: groups.flat() };
  while (estimate(result) > budget && groups.length > 1) {
    groups.shift();
    result.contents = groups.flat();
  }
  if (estimate(result) > budget)
    throw new Error('The latest turn, system instructions and tools exceed the configured contextWindow.');
  return result;
}

export function applyRequestOptions(
  payload: Record<string, unknown>,
  model: CustomModel,
  format: ApiFormat,
  stream: boolean,
): Record<string, unknown> {
  const result = { ...payload };
  const reserved = new Set(['model', 'messages', 'contents', 'system', 'systemInstruction', 'tools', 'stream']);
  for (const [key, value] of Object.entries(model.extraBody || {})) {
    if (reserved.has(key)) throw new Error(`extraBody cannot override ${key}`);
    result[key] = value;
  }
  if (format === 'google') {
    delete result.stream;
    const generation = { ...((result.generationConfig as Record<string, unknown>) || {}) };
    if (model.maxOutputTokens !== undefined) generation.maxOutputTokens = model.maxOutputTokens;
    if (model.thinkingBudget !== undefined) generation.thinkingConfig = { thinkingBudget: model.thinkingBudget };
    result.generationConfig = generation;
  } else {
    result.stream = stream;
    if (model.maxOutputTokens !== undefined) {
      if (format === 'openai' && result.max_completion_tokens !== undefined)
        result.max_completion_tokens = model.maxOutputTokens;
      else result.max_tokens = model.maxOutputTokens;
    }
    if (format === 'openai' && model.reasoningEffort !== undefined) result.reasoning_effort = model.reasoningEffort;
    if (format === 'anthropic' && model.thinkingBudget !== undefined) {
      if (model.thinkingBudget === 0) result.thinking = { type: 'disabled' };
      else {
        if (model.thinkingBudget < 1024 || model.thinkingBudget >= Number(result.max_tokens)) {
          throw new Error('Anthropic thinkingBudget must be at least 1024 and smaller than maxOutputTokens.');
        }
        result.thinking = { type: 'enabled', budget_tokens: model.thinkingBudget };
        delete result.temperature;
      }
    }
  }
  return result;
}

export function parseRetryAfter(value: string | string[] | undefined, now = Date.now()): number {
  const raw = (Array.isArray(value) ? value[0] : value)?.trim();
  if (!raw) return 0;
  const delay = /^\d+(\.\d+)?$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw) - now;
  return Number.isFinite(delay) ? Math.max(0, Math.min(delay, 30_000)) : 0;
}
