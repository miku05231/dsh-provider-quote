/**
 * 演示：用 fetch 桩喂一份 OpenRouter 数据，跑真实的报价管线并打印文本输出。
 *
 *   node tests/demo-openrouter.mjs
 *
 * 不联网、不需要 API key —— 所有响应（credits / key / 价格目录 / 模型列表）
 * 都由下面的桩函数返回，余额与单价数字都是编的，只用来展示输出格式。
 */
import { buildQuote, renderQuoteText } from '../lib/pricing.js';

/** OpenRouter 公开价格目录的形状：pricing 是 USD/token 字符串，×1e6 = 每 1M token。 */
const CATALOG = {
  data: [
    {
      id: 'anthropic/claude-sonnet-4.5',
      name: 'Anthropic: Claude Sonnet 4.5',
      context_length: 200000,
      pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' },
    },
    {
      id: 'openai/gpt-5-mini',
      name: 'OpenAI: GPT-5 mini',
      context_length: 400000,
      pricing: { prompt: '0.00000025', completion: '0.000002', input_cache_read: '0.000000025' },
    },
    // 真实目录约 458 个模型，这里补齐条数只为让「N 个模型」这一行看起来真实。
    ...Array.from({ length: 456 }, (_, index) => ({
      id: `demo/filler-${index + 1}`,
      pricing: { prompt: '0.000001', completion: '0.000002' },
    })),
  ],
};

/** 该提供商自己的 GET /models（OpenAI 兼容）。 */
const LISTING = {
  data: [
    { id: 'anthropic/claude-sonnet-4.5', name: 'Anthropic: Claude Sonnet 4.5' },
    { id: 'openai/gpt-5-mini', name: 'OpenAI: GPT-5 mini' },
  ],
};

const fetchImpl = async (url) => {
  const path = new URL(url).pathname;
  const body = path.endsWith('/api/v1/credits')
    ? { data: { total_credits: 25, total_usage: 12.6 } }
    : path.endsWith('/api/v1/key')
      ? { data: { label: 'demo', usage: 12.6, usage_daily: 0.42, is_free_tier: false } }
      : path.endsWith('/api/v1/models')
        ? CATALOG
        : LISTING;
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
};

const quote = await buildQuote({
  providers: [
    {
      id: 'openrouter',
      name: 'OpenRouter',
      baseURL: 'https://openrouter.ai/api',
      apiKeyEnv: 'OPENROUTER_API_KEY',
      apiKey: 'sk-or-v1-••••••••',
      models: [],
    },
  ],
  active: { provider: 'openrouter', model: 'anthropic/claude-sonnet-4.5' },
  fetchImpl,
});

console.log(renderQuoteText(quote, { models: true }));
