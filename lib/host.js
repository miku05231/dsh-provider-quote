/**
 * provider-quote — Host half.
 *
 * 对「正在使用的模型提供商」询价：账户余额 + 模型单价（USD / 1M tokens）。
 * 余额按 baseURL 分派厂商适配器（OpenRouter / DeepSeek 官方 / 中转站 /user/balance /
 * one-api / OpenAI billing），也支持直接粘贴 cc-switch 的 usage_script。
 * 单价来自 OpenRouter 公开价格目录，支持按模型 id、裸名或 slug 匹配，并可本地覆盖。
 *
 * 对外能力：
 *   · 工具 provider_quote        —— agent 可调用的询价入口
 *   · 路由 /api/provider-quote/* —— GUI 面板（client.js）取数
 *
 * 无第三方依赖：只用 Node 内置能力与 DSH 注入的服务。
 */
import { buildQuote, fetchPriceCatalog, hostOf, normalizeBase, renderQuoteText, resolveCatalog } from './pricing.js';

export const name = 'dsh-provider-quote';
export const inject = ['tools'];

const ROUTE_PREFIX = '/api/provider-quote';
const VERSION = '0.3.1';
const QUOTE_TTL_MS = 30_000;
const DEFAULT_CONFIG = {
  enabled: true,
  timeoutMs: 12_000,
  catalogTtlMs: 6 * 60 * 60 * 1000,
  adapters: 'auto',
  scripts: {},
  priceOverrides: {},
  providers: {},
  autoRefreshMinutes: 0,
  maxModelsInText: 24,
};

/* ---------------------------------------------------------------- utils */

function log(ctx, level, message) {
  try {
    const logger = ctx?.logger;
    if (logger !== undefined && typeof logger[level] === 'function') logger[level](`[provider-quote] ${message}`);
  } catch {
    /* logging must never break the plugin */
  }
}

function writeJson(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'referrer-policy': 'no-referrer',
  });
  res.end(JSON.stringify(body));
}

/** webServer 的 handler 只收到 `(req, res)`：查询串必须自己从 `req.url` 解析。 */
function requestUrl(req) {
  try {
    return new URL(typeof req?.url === 'string' && req.url !== '' ? req.url : '/', 'http://localhost');
  } catch {
    return new URL('http://localhost/');
  }
}

function toNumber(value) {
  const number = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(number) ? number : undefined;
}

function mergeDeep(base, patch) {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch;
  const out = { ...(base !== null && typeof base === 'object' && !Array.isArray(base) ? base : {}) };
  for (const [key, value] of Object.entries(patch)) {
    out[key] = key in out ? mergeDeep(out[key], value) : value;
  }
  return out;
}

/* ------------------------------------------------- provider discovery */

function providerIdsOf(def) {
  if (!Array.isArray(def?.models)) return [];
  return def.models
    .map((model) => (typeof model === 'string' ? model : model?.id))
    .filter((id) => typeof id === 'string' && id !== '');
}

/**
 * 内置路由：不在插件配置里写 baseURL 的官方提供商 → 官方端点 + 凭据名。
 * `deepseek-official` 是 @deepseek-ai/dsh-llm-deepseek-api-key 里的 provider 常量
 * （DeepSeek 官方账号，走 https://api.deepseek.com）；它的余额接口 `/user/balance`
 * 已由引擎里的 `deepseek-official` 适配器支持，凭据通常就是 DEEPSEEK_API_KEY。
 */
const BUILTIN_PROVIDERS = {
  'deepseek-official': { baseURL: 'https://api.deepseek.com', apiKeyEnv: 'DEEPSEEK_API_KEY' },
};

function readProviderDef(id, def) {
  const baseURL = normalizeBase(def.baseURL ?? def.baseUrl ?? def.base_url ?? def.apiBase ?? def.endpoint);
  return {
    id,
    name: typeof def.name === 'string' && def.name !== '' ? def.name : id,
    baseURL,
    apiKeyEnv: typeof def.apiKeyEnv === 'string' && def.apiKeyEnv !== ''
      ? def.apiKeyEnv
      : typeof def.apiKeyRef === 'string' && def.apiKeyRef !== '' ? def.apiKeyRef : undefined,
    models: providerIdsOf(def),
    adapters: Array.isArray(def.adapters) ? def.adapters : undefined,
    skipModels: def.skipModels === true,
  };
}

/**
 * Walk an arbitrary config graph collecting `{ <providerId>: { baseURL, apiKeyEnv, models } }`.
 * Handles the `llm-pi-ai` shape `{ providers: { id: { baseURL, apiKeyEnv, models: [...] } } }`
 * wherever it appears in a plugin row's resolved config.
 */
function collectProviderDefs(node, out = new Map(), depth = 0) {
  if (node === null || typeof node !== 'object' || depth > 6) return out;
  if (Array.isArray(node)) {
    for (const item of node) collectProviderDefs(item, out, depth + 1);
    return out;
  }
  for (const [key, value] of Object.entries(node)) {
    if (value === null || typeof value !== 'object') continue;
    if (key === 'providers' && !Array.isArray(value)) {
      for (const [id, def] of Object.entries(value)) {
        if (def === null || typeof def !== 'object' || Array.isArray(def)) continue;
        const looksLikeProvider = ['baseURL', 'baseUrl', 'base_url', 'apiBase', 'endpoint', 'apiKeyEnv', 'apiKeyRef', 'models', 'api']
          .some((field) => field in def);
        if (!looksLikeProvider) continue;
        const previous = out.get(id) ?? {};
        const ids = providerIdsOf(def);
        out.set(id, { ...previous, ...def, ...(ids.length > 0 ? { models: def.models } : {}) });
      }
      continue;
    }
    collectProviderDefs(value, out, depth + 1);
  }
  return out;
}

/**
 * 取服务：`ctx.get(name)` 不需要预先 inject，服务缺失时返回 undefined，
 * 插件因此可以在没有 configEditor / llm / credentials 的环境里降级运行。
 */
function service(ctx, name) {
  try {
    if (typeof ctx?.get === 'function') {
      const found = ctx.get(name);
      if (found !== undefined && found !== null) return found;
    }
  } catch {
    /* 服务未注册 */
  }
  return ctx?.[name];
}

/** Read every configured provider definition from the live plugin rows + own config. */
function discoverProviders(ctx, config) {
  const found = new Map();
  try {
    const rows = service(ctx, 'configEditor')?.configuration?.() ?? [];
    for (const row of rows) {
      collectProviderDefs(mergeDeep(row?.inherited ?? {}, row?.override ?? {}), found);
    }
  } catch (error) {
    log(ctx, 'warn', `configEditor 读取失败: ${String(error?.message ?? error)}`);
  }

  const declared = new Map();
  try {
    for (const provider of service(ctx, 'llm')?.listProviders?.() ?? []) {
      if (provider !== null && typeof provider === 'object' && typeof provider.id === 'string') declared.set(provider.id, provider);
    }
  } catch {
    /* llm service is optional */
  }

  const ids = new Set([...found.keys(), ...Object.keys(config.providers ?? {}), ...declared.keys()]);
  const explicit = config.providers ?? {};
  const selected = currentSelection(ctx).provider;
  const providers = [];
  for (const id of ids) {
    const overrides = explicit[id] ?? {};
    const def = { ...(BUILTIN_PROVIDERS[id] ?? {}), ...(found.get(id) ?? {}), ...overrides };
    def.name = overrides.name ?? declared.get(id)?.name ?? found.get(id)?.name;
    const provider = readProviderDef(id, def);
    if (provider.baseURL === undefined) {
      // 其它插件行里扫出的同名字段（如 deepseek-official / deepseek-account）既没有 baseURL
      // 也没有模型和凭据，只会污染结果 —— 只有用户显式声明过、或它就是当前选中的提供商时才保留。
      if (!(id in explicit) && id !== selected) {
        log(ctx, 'debug', `跳过无法解析 baseURL 的提供商: ${id}`);
        continue;
      }
      provider.unresolved = true;
    }
    providers.push(provider);
  }
  return providers;
}

function liveProviders(ctx, config) {
  const providers = discoverProviders(ctx, config);
  for (const provider of providers) {
    if (provider.adapters === undefined && config.adapters !== 'auto') provider.adapters = config.adapters;
  }
  return providers;
}

function selectProviders(providers, selection, args = {}) {
  if (args.all === true) return providers;
  const needle = typeof args.provider === 'string' && args.provider.trim() !== '' ? args.provider.trim().toLowerCase() : undefined;
  if (needle === undefined) {
    const active = providers.filter((provider) => provider.id === selection.provider);
    return active.length > 0 ? active : providers;
  }
  return providers.filter((provider) => (
    provider.id.toLowerCase() === needle
    || provider.id.toLowerCase().includes(needle)
    || String(provider.name).toLowerCase().includes(needle)
  ));
}

/* --------------------------------------------------------- credentials */

/**
 * 取 API key：`ctx.credentials.resolve()` 的 ref 在运行时就是那个名字字符串
 * （`credentialRef()` 只做编译期 brand），所以这里直接传字符串 —— 插件因此
 * 不需要 import 任何 @deepseek-ai/* 包，链接式安装下也能加载。
 */
async function resolveApiKey(ctx, refName) {
  if (typeof refName !== 'string' || refName === '') return undefined;
  const credentials = service(ctx, 'credentials');
  if (credentials === undefined || typeof credentials.resolve !== 'function') return undefined;
  try {
    const resolved = await credentials.resolve(refName);
    const value = typeof resolved === 'string' ? resolved : resolved?.value;
    if (typeof value === 'string' && value !== '') return value;
  } catch {
    /* 未配置或名字非法：当成没有 key，由调用方报告 */
  }
  return undefined;
}

/* ----------------------------------------------------------- quote runner */

function currentSelection(ctx) {
  try {
    const selection = service(ctx, 'agentDefaultModel')?.currentSelection?.();
    if (selection !== null && typeof selection === 'object') {
      return { provider: selection.provider, model: selection.model, source: 'global-default' };
    }
  } catch {
    /* optional service */
  }
  return { source: 'global-default' };
}

/**
 * 解析「本次要询价谁」。
 *
 * GUI 的余额胶囊跟着**它所在会话**的模型选择走（client.js 读 slot 标准属性
 * `useProjection("modelSelection")`，读不到时退回官方 modelDirectories），并在请求里
 * 带上 `scope=session&sessionId=…&provider=…&model=…`。于是报价里的「使用中」就是那个
 * 会话的提供商，而不是新会话默认值 —— 切换会话不会再让另一会话的刷新查错对象。
 *
 * @param searchParams - 请求查询串（`URLSearchParams` 形状；缺失视为没点名）。
 * @param fallback - 没点名时的选择，通常是 `agentDefaultModel.currentSelection()`。
 * @returns `{ provider?, model?, source, sessionId? }`，`source` 取值：
 *   `session`（某会话自己的选择）| `global-default`（新会话默认）| `explicit`（点名）。
 */
export function readQuoteTarget(searchParams, fallback = {}) {
  const read = (key) => {
    try {
      const value = searchParams?.get?.(key);
      return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const sessionId = read('sessionId');
  const provider = read('provider');
  if (provider === undefined) {
    return { ...fallback, source: fallback.source ?? 'global-default', sessionId };
  }
  const scope = read('scope');
  const source = scope === 'session' ? 'session' : scope === 'default' ? 'global-default' : 'explicit';
  return { provider, model: read('model'), source, sessionId };
}

/** 工具调用里的选择：点名了提供商且只匹配到一个 → 就把它当「使用中」。 */
function toolSelection(args, providers, fallback) {
  const needle = typeof args?.provider === 'string' ? args.provider.trim() : '';
  if (needle === '' || providers.length !== 1) return fallback;
  return { provider: providers[0].id, source: 'explicit' };
}

function createRunner(ctx, config, state) {
  return async function runQuote(request = {}) {
    const selection = request.selection ?? currentSelection(ctx);
    const providers = request.providers ?? liveProviders(ctx, config);
    if (providers.length === 0) return null;
    const key = `${providers.map((provider) => `${provider.id}@${provider.baseURL ?? '-'}`).join('|')}|${selection.provider ?? '-'}|${selection.source ?? '-'}`;
    const fresh = state.quote !== null && state.quoteKey === key && Date.now() - state.quoteAt < QUOTE_TTL_MS;
    if (request.refresh !== true && fresh) return state.quote;
    if (state.inflight !== null && state.inflight.key === key) return state.inflight.promise;

    const promise = (async () => {
      const withKeys = [];
      for (const provider of providers) {
        withKeys.push({ ...provider, apiKey: await resolveApiKey(ctx, provider.apiKeyEnv) });
      }
      // The cache holds the FULL catalog (models included): a replay of the
      // summary object alone would price nothing.
      const catalog = await resolveCatalog({
        previous: state.catalog,
        ttlMs: config.catalogTtlMs,
        load: () => fetchPriceCatalog({ timeoutMs: config.timeoutMs }),
      });
      state.catalog = catalog;
      const quote = await buildQuote({
        providers: withKeys,
        active: { provider: selection.provider, model: selection.model },
        scripts: config.scripts,
        priceOverrides: config.priceOverrides,
        timeoutMs: config.timeoutMs,
        catalog,
        fetchCatalog: false,
      });
      state.quote = quote;
      state.quoteKey = key;
      state.quoteAt = Date.now();
      return quote;
    })();

    state.inflight = { key, promise };
    try {
      return await promise;
    } finally {
      if (state.inflight !== null && state.inflight.promise === promise) state.inflight = null;
    }
  };
}

/* ------------------------------------------------------------------ apply */

export function apply(ctx, rawConfig = {}) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) };
  if (config.enabled === false) {
    log(ctx, 'info', '已禁用（config.enabled = false）');
    return;
  }
  const state = { catalog: null, quote: null, quoteKey: '', quoteAt: 0, inflight: null };
  const runQuote = createRunner(ctx, config, state);

  ctx.inject(['tools'], (scoped) => {
    // 直接给 JSON Schema（wire 层形态），不 import defineTool：
    // 链接式安装的包位于 profile 之外，parse 不到 asar 里的 @deepseek-ai/* 依赖。
    scoped.tools.register({
      name: 'provider_quote',
      description:
        '查询模型提供商（中转站 / 官方 API）的账户余额与模型单价（USD / 1M tokens）。'
        + '默认以新会话的默认模型（全局默认）为「当前使用」，点名 provider 时以它为准；'
        + 'GUI 的余额胶囊按它所在会话的模型选择询价（走 HTTP 路由，见 README）。'
        + '余额按 baseURL 自动匹配厂商适配器，单价来自 OpenRouter 公开价格目录（含缓存读写价）。',
      parameters: {
        type: 'object',
        properties: {
          provider: { type: 'string', description: '提供商 id 或名称片段（默认：全局默认模型所用的提供商）' },
          all: { type: 'boolean', description: '查询所有已配置的提供商，而不是仅当前使用的' },
          refresh: { type: 'boolean', description: '跳过缓存，强制重新查询' },
          models: { type: 'boolean', description: '是否列出模型单价明细（默认 true）' },
        },
      },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      timeoutMs: 60_000,
      async execute(args) {
        const providers = selectProviders(liveProviders(ctx, config), currentSelection(ctx), args ?? {});
        if (providers.length === 0) {
          return '没有找到匹配的提供商：请在插件配置 providers 里补上 baseURL，或确认 llm 适配器已配置提供商。';
        }
        const selection = toolSelection(args, providers, currentSelection(ctx));
        const quote = await runQuote({ providers, selection, refresh: args?.refresh === true });
        if (quote === null) return '询价失败：没有可查询的提供商。';
        return renderQuoteText(quote, { models: args?.models !== false, maxModels: config.maxModelsInText });
      },
    });
  });

  ctx.inject(['webServer'], (scoped) => {
    scoped.effect(() => {
      const handler = async (req, res) => {
        try {
          const url = requestUrl(req);
          const refresh = url.searchParams.get('refresh') === '1' || url.pathname.endsWith('/refresh');
          const providers = liveProviders(ctx, config);
          // 浏览器端会带上它所在会话的模型选择（scope=session&sessionId=…&provider=…），
          // 于是「使用中」就是那个会话的选择；没带就按新会话的默认模型（全局默认）。
          const selection = readQuoteTarget(url.searchParams, currentSelection(ctx));
          const quote = await runQuote({ providers, selection, refresh });
          writeJson(res, 200, quote ?? {
            generatedAt: new Date().toISOString(),
            providers: [],
            active: selection,
            catalog: null,
            note: '没有发现已配置的提供商：请在插件配置 providers 里补上 baseURL。',
          });
        } catch (error) {
          writeJson(res, 500, { error: String(error?.message ?? error) });
        }
      };
      const disposers = [
        scoped.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/summary`, handler }),
        scoped.webServer.register({ kind: 'exact', path: `${ROUTE_PREFIX}/refresh`, handler }),
        scoped.webServer.register({
          kind: 'exact',
          path: `${ROUTE_PREFIX}/ping`,
          handler: async (req, res) => {
            writeJson(res, 200, {
              ok: true,
              version: VERSION,
              entry: 'lib/host.js',
              moduleUrl: import.meta.url,
              catalogModels: state.catalog?.models?.length ?? 0,
              catalogStale: state.catalog?.stale === true,
              adapters: config.adapters,
              providers: liveProviders(ctx, config).map((provider) => provider.id),
            });
          },
        }),
      ];
      return () => {
        for (const dispose of disposers) {
          try {
            dispose();
          } catch {
            /* already disposed */
          }
        }
      };
    }, 'provider-quote: /api/provider-quote 路由');
  });

  const minutes = toNumber(config.autoRefreshMinutes) ?? 0;
  if (minutes > 0) {
    ctx.inject(['timer'], (scoped) => {
      scoped.effect(() => {
        const dispose = scoped.timer.interval(() => {
          runQuote({ refresh: true }).catch((error) => log(ctx, 'warn', `定时询价失败: ${String(error?.message ?? error)}`));
        }, minutes * 60 * 1000);
        return () => {
          if (typeof dispose === 'function') dispose();
        };
      }, 'provider-quote: 定时询价');
    });
  }

  log(ctx, 'info', `就绪 · ${hostOf('https://openrouter.ai/api/v1/models')} 价格目录 · 适配器 ${JSON.stringify(config.adapters)}`);
}
