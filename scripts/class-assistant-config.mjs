import { readFile } from 'node:fs/promises';

export const MEMBER_COUNT = 35;
export const TOTAL_BUDGET_MICROS = 75_000_000;
export const MEMBER_BUDGET_MICROS = 2_142_857;
export const UNALLOCATED_MICROS = 5;
export const MAX_INPUT_TOKENS = 8000;
export const SESSION_MS = 30 * 24 * 60 * 60 * 1000;
export const MODEL_CATALOG = Object.freeze([
  { key: 'astra', label: 'GPT-6 Astra', apiModel: 'gpt-6-astra', inputPerMillion: 10, cachedInputPerMillion: 1, outputPerMillion: 50 },
  { key: 'sol', label: 'GPT-6.1 Sol', apiModel: 'gpt-6.1-sol', inputPerMillion: 2, cachedInputPerMillion: 0.1, outputPerMillion: 10 },
  { key: 'terra', label: 'GPT-6.1 Terra', apiModel: 'gpt-6.1-terra', inputPerMillion: 1, cachedInputPerMillion: 0.05, outputPerMillion: 5 },
  { key: 'luna', label: 'GPT-6 Luna', apiModel: 'gpt-6-luna', inputPerMillion: 0.1, cachedInputPerMillion: 0.01, outputPerMillion: 0.5 },
].map(Object.freeze));

export const defaultConfig = () => ({
  enabled: false,
  provider: 'openai-responses',
  baseUrl: 'https://api.openai.com/v1',
  apiKeyEnv: 'CLASS_ASSISTANT_OPENAI_API_KEY',
  pricingConfirmed: false,
  pricingVerifiedAt: '2026-11-07',
  models: MODEL_CATALOG.map(model => ({ ...model, enabled: true, maxOutputTokens: 1024 })),
});

export function exactObject(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}

export function validateConfig(value) {
  const fail = () => { throw new Error('班级助手配置无效；付费功能已关闭。'); };
  if (!exactObject(value, ['enabled', 'provider', 'baseUrl', 'apiKeyEnv', 'pricingConfirmed', 'pricingVerifiedAt', 'models'])
    || typeof value.enabled !== 'boolean' || typeof value.pricingConfirmed !== 'boolean'
    || value.provider !== 'openai-responses' || value.baseUrl !== 'https://api.openai.com/v1'
    || typeof value.apiKeyEnv !== 'string' || !/^[A-Z][A-Z0-9_]{5,100}$/.test(value.apiKeyEnv)
    || value.pricingVerifiedAt !== '2026-11-07' || !Array.isArray(value.models) || value.models.length !== 4) fail();
  const models = MODEL_CATALOG.map(canonical => {
    const model = value.models.find(item => item?.key === canonical.key);
    if (!exactObject(model, [...Object.keys(canonical), 'enabled', 'maxOutputTokens'])
      || Object.keys(canonical).some(key => model[key] !== canonical[key])
      || typeof model.enabled !== 'boolean' || !Number.isSafeInteger(model.maxOutputTokens)
      || model.maxOutputTokens < 1 || model.maxOutputTokens > 4096) fail();
    // Frozen, owner-confirmed Standard prices; updates require a new reviewed price catalog.
    return Object.freeze({ ...model, prices: Object.freeze({
      input: Math.round(model.inputPerMillion * 1_000_000),
      cached: Math.round(model.cachedInputPerMillion * 1_000_000),
      output: Math.round(model.outputPerMillion * 1_000_000),
    }) });
  });
  return Object.freeze({ ...value, models: Object.freeze(models) });
}

export async function loadConfig(path) {
  if (!path) return validateConfig(defaultConfig());
  return validateConfig(JSON.parse(await readFile(path, 'utf8')));
}

export function costMicros(prices, inputTokens, cachedTokens, outputTokens) {
  if (!prices || Object.values(prices).length !== 3
    || ['input', 'cached', 'output'].some(key => !Number.isSafeInteger(prices[key]) || prices[key] <= 0 || prices[key] > 1_000_000_000)
    || prices.cached > prices.input
    || [inputTokens, cachedTokens, outputTokens].some(value => !Number.isSafeInteger(value) || value < 0 || value > 1_000_000)
    || cachedTokens > inputTokens) throw new Error('Invalid billing quantities');
  const numerator = BigInt(inputTokens - cachedTokens) * BigInt(prices.input)
    + BigInt(cachedTokens) * BigInt(prices.cached) + BigInt(outputTokens) * BigInt(prices.output);
  const result = (numerator + 999_999n) / 1_000_000n;
  if (result > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Billing overflow');
  return Number(result);
}

export function assistantError(status, code, message) {
  return Object.assign(new Error(message), { status, code });
}
