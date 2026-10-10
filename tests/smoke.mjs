/**
 * Standalone smoke test for the provider-quote engine.
 * Run:  node tests/smoke.mjs            (live network: needs targets + credentials, see below)
 *       node tests/smoke.mjs --offline   (no network: pure-function checks + fetch stubs)
 *
 * The offline section is machine-independent and always runs.  The live section only runs
 * when you point it at your own endpoints, so the repository contains no real host, key
 * name or account:
 *
 *   DSH_QUOTE_LIVE='[{"id":"openrouter","name":"OpenRouter",
 *                     "baseURL":"https://openrouter.ai/api",
 *                     "apiKeyEnv":"OPENROUTER_API_KEY",
 *                     "models":["deepseek/deepseek-chat"],
 *                     "expectBalance":true}]' \
 *   DSH_CREDENTIALS=/path/to/.credentials.yaml node tests/smoke.mjs
 *
 * Optional per-target fields: `usageScript` (a cc-switch script, applied to that host),
 * `priceOverrides`, `expectBalance`, `expectModels`.  Credential values are read from the
 * DSH credential store and never printed.  Without DSH_QUOTE_LIVE the live section is skipped.
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import {
  buildQuote,
  fetchPriceCatalog,
  hostOf,
  matchCatalogModel,
  buildCatalogIndex,
  parseCatalog,
  queryBalance,
  renderQuoteText,
  resolveCatalog,
  suggestCatalogModels,
  runUsageScript,
} from '../lib/pricing.js';

const CREDENTIALS = process.env.DSH_CREDENTIALS
  ?? `${homedir().replace(/\\/g, '/')}/.dsh/.credentials.yaml`;
const offline = process.argv.includes('--offline');
const results = [];
const check = (name, ok, note = '') => {
  results.push({ name, ok, note });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${note ? `  — ${note}` : ''}`);
};
const finish = (label) => {
  const failed = results.filter((row) => !row.ok);
  const suffix = label === '' ? '' : ` (${label})`;
  console.log(`\n${results.length - failed.length}/${results.length} checks passed${suffix}`);
  process.exit(failed.length === 0 ? 0 : 1);
};

async function readRefs() {
  const text = await readFile(CREDENTIALS, 'utf8');
  const refs = {};
  let inRefs = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(line)) { inRefs = true; continue; }
    if (/^\S/.test(line) && line.trim() !== '') inRefs = line.startsWith('refs:');
    if (!inRefs) continue;
    const match = /^\s+([A-Za-z0-9_]+):\s*(\S+)\s*$/.exec(line);
    if (match !== null) refs[match[1]] = match[2].replace(/^["']|["']$/g, '');
  }
  return refs;
}

function keyOf(refs, name) {
  const value = refs[name];
  return typeof value === 'string' && value.length > 8 ? value : undefined;
}

/* ---- pure functions (always run) ---- */
{
  const catalog = parseCatalog({ data: [{ id: 'deepseek/deepseek-chat', name: 'x', context_length: 64000, pricing: { prompt: '0.00000028', completion: '0.00000042', input_cache_read: '0.000000028' } }] });
  check('parseCatalog 把 USD/token 换算成 USD/1M', catalog[0]?.price?.input === 0.28 && catalog[0]?.price?.output === 0.42 && catalog[0]?.price?.cacheRead === 0.028, JSON.stringify(catalog[0]?.price));
  const index = buildCatalogIndex(catalog);
  check('matchCatalogModel 命中完整 id', matchCatalogModel('deepseek/deepseek-chat', index)?.matchedBy === 'id');
  check('matchCatalogModel 命中裸模型名', matchCatalogModel('deepseek-chat', index)?.matchedBy === 'bare-id');
  check('matchCatalogModel 命中 slug', matchCatalogModel('whatever', index, { slug: 'deepseek/deepseek-chat' })?.matchedBy === 'slug');
}

/* ---- cc-switch usage script compatibility ---- */
{
  const script = `({
  request: {
    url: "{{baseUrl}}/user/balance",
    method: "GET",
    headers: { "Authorization": "Bearer {{apiKey}}", "User-Agent": "cc-switch/1.0" }
  },
  extractor: function(response) { return { isValid: response.is_active || true, remaining: response.balance, unit: "USD" }; }
})`;
  const spec = new Function(`return (${script.replace('{{baseUrl}}', 'https://example.test').replace('{{apiKey}}', 'k')});`)();
  check('cc-switch usage_script 可被解析为 {request, extractor}', spec.request.url === 'https://example.test/user/balance' && typeof spec.extractor === 'function' && spec.extractor({ balance: 7, is_active: true }).remaining === 7);
}

/* ---- price suggestions for unmatched models ---- */
{
  const index = buildCatalogIndex(parseCatalog({ data: [
    { id: 'deepseek/deepseek-v4-flash', pricing: { prompt: '0.0000001' } },
    { id: 'deepseek/deepseek-v4.1-flash', pricing: { prompt: '0.0000001' } },
    { id: '~deepseek/deepseek-flash-latest', pricing: { prompt: '0.0000001' } },
    { id: 'qwen/qwen3.8-27b', pricing: { prompt: '0.0000001' } },
    { id: 'qwen/qwen3.5-27b', pricing: { prompt: '0.0000001' } },
  ] }));
  const flash = suggestCatalogModels('deepseek-flash', index);
  check('未匹配价格时给出目录候选（最接近的排第一）', flash[0] === 'deepseek/deepseek-v4-flash' && flash.length <= 3, JSON.stringify(flash));
  const versioned = suggestCatalogModels('qwen3.8-27b', index);
  check('候选按版本号前缀优先，不会串到别的版本', versioned[0] === 'qwen/qwen3.8-27b', JSON.stringify(versioned));
  check('完全无关的模型不给候选', suggestCatalogModels('intern-s2', index).length === 0);
}

/* ---- price-catalog cache policy (offline: injected fetch, no network) ---- */
const respond = (status, body) => async () => ({ ok: status >= 200 && status < 300, status, text: async () => body });
const goodBody = JSON.stringify({ data: [{ id: 'deepseek/deepseek-v4-pro', pricing: { prompt: '0.0000006', completion: '0.0000018' } }] });
const good = await fetchPriceCatalog({ timeoutMs: 100, fetchImpl: respond(200, goodBody) });
check('目录下载：正常 JSON 解析出模型', good.ok === true && good.models.length === 1, good.models.map((m) => m.id).join(','));
const challenge = await fetchPriceCatalog({ timeoutMs: 100, fetchImpl: respond(200, '<html>challenge</html>') });
check('目录下载：HTTP 200 但非 JSON 记为失败', challenge.ok === false && challenge.models.length === 0, challenge.error);
const emptyCatalog = await fetchPriceCatalog({ timeoutMs: 100, fetchImpl: respond(200, JSON.stringify({ data: [] })) });
check('目录下载：HTTP 200 但 0 个模型记为失败', emptyCatalog.ok === false && emptyCatalog.error === '目录返回 0 个模型');
let reloads = 0;
const reused = await resolveCatalog({
  previous: good,
  ttlMs: 60_000,
  now: good.fetchedAt + 10,
  load: async () => { reloads += 1; return emptyCatalog; },
});
check('目录缓存：未过期时直接复用且不重取', reused === good && reloads === 0);
const kept = await resolveCatalog({ previous: good, ttlMs: 0, load: async () => emptyCatalog });
check('目录缓存：重取失败时沿用上次成功获取（回归）', kept.models.length === 1 && kept.stale === true && kept.error === emptyCatalog.error);
const stillKept = await resolveCatalog({ previous: good, ttlMs: 0, load: async () => challenge });
check('目录缓存：只有新的可用目录才替换旧的', stillKept.models.length === 1 && stillKept.stale === true);
const noPrevious = await resolveCatalog({ previous: null, ttlMs: 0, load: async () => emptyCatalog });
check('目录缓存：没有可用旧目录时返回失败态', noPrevious.ok === false && noPrevious.models.length === 0);
const cachedQuote = await buildQuote({
  providers: [{ id: 'probe', name: 'probe', baseURL: 'https://probe.invalid/v1', apiKey: 'k', models: ['deepseek-v4-pro'] }],
  active: { provider: 'probe', model: 'deepseek-v4-pro' },
  catalog: good,
  fetchCatalog: false,
  timeoutMs: 200,
  fetchImpl: respond(404, 'nope'),
});
const cachedModel = cachedQuote.providers[0].models[0];
check(
  '复用缓存目录时仍能定价（回归：目录曾退化成 0 个模型导致全部未定价）',
  cachedQuote.catalog.modelCount === 1 && cachedModel.price !== null && cachedModel.price.input === 0.6,
  JSON.stringify(cachedModel.price),
);

if (offline) finish('offline');

/* ---- live：端点全部来自 DSH_QUOTE_LIVE（仓库里不含任何真实地址） ---- */
const liveSpec = (() => {
  const raw = process.env.DSH_QUOTE_LIVE;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch (error) {
    console.log(`\nDSH_QUOTE_LIVE 不是合法 JSON：${error.message}`);
    return null;
  }
})();

if (liveSpec === null) {
  console.log('\n跳过 live 段：未设置 DSH_QUOTE_LIVE（示例见文件头注释）。');
  finish('offline only');
}

let refs = null;
try {
  refs = await readRefs();
} catch (error) {
  console.log(`\n跳过 live 段：读不到凭据库 ${CREDENTIALS}（${error.code ?? error.message}）`);
  finish('offline only');
}
check('凭据库读取到 refs', Object.keys(refs).length > 0, Object.keys(refs).join(','));

const providers = liveSpec.map((row) => ({
  id: row.id,
  name: row.name ?? row.id,
  baseURL: row.baseURL,
  apiKey: keyOf(refs, row.apiKeyEnv ?? ''),
  models: row.models,
}));
const active = providers[0];

const scripts = {};
for (const row of liveSpec) {
  if (typeof row.usageScript === 'string' && row.usageScript !== '') scripts[hostOf(row.baseURL)] = row.usageScript;
}

const quote = await buildQuote({
  providers,
  active: { provider: active.id, model: active.models?.[0] ?? 'unknown-model' },
  scripts,
  priceOverrides: liveSpec[0].priceOverrides ?? {},
  fetchQuote: true,
});

const byId = Object.fromEntries(quote.providers.map((row) => [row.id, row]));

check(
  '每个目标都给出了余额结论（成功或可解释的失败）',
  quote.providers.every((row) => row.balance !== undefined && (row.balance.ok === true || (row.balance.attempts ?? []).length > 0)),
  quote.providers
    .map((row) => `${row.id}:${row.balance.ok === true ? `${row.balance.remaining} ${row.balance.unit} (${row.balance.adapter})` : `FAIL ${(row.balance.attempts ?? []).length} 个接口`}`)
    .join(' · '),
);
check('目录抓取与模型总数', quote.catalog?.modelCount > 100, `${quote.catalog?.modelCount} models`);
check(
  '至少一个模型匹配到目录单价',
  quote.providers.some((row) => row.models.some((model) => model.price !== null)),
  quote.providers.map((row) => `${row.id}:${row.models.filter((m) => m.price !== null).length}/${row.models.length}`).join(' · '),
);

for (const row of liveSpec) {
  const target = byId[row.id];
  if (row.expectBalance === true) {
    check(`[${row.id}] 余额查询成功`, target?.balance?.ok === true, `${target?.balance?.adapter ?? '-'} → ${target?.balance?.remaining} ${target?.balance?.unit}`);
  }
  if (row.expectModels === true) {
    check(`[${row.id}] 模型列表非空`, (target?.models ?? []).length > 0, `${(target?.models ?? []).length} 个模型，${(target?.models ?? []).filter((m) => m.price !== null).length} 个已定价`);
  }
  if (row.expectFailure === true) {
    check(`[${row.id}] 无余额接口时返回可解释失败`, target?.balance?.ok === false && (target?.balance?.attempts ?? []).length > 0, `${target?.balance?.reason}，尝试 ${(target?.balance?.attempts ?? []).length} 个 URL`);
  }
}

console.log('\n----- rendered quote (first 40 lines) -----');
console.log(renderQuoteText(quote).split('\n').slice(0, 40).join('\n'));

finish('');
