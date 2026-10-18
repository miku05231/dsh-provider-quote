/**
 * provider-quote engine — vendor-agnostic "询价" core.
 *
 * Pure ESM, no DSH imports: the host plugin and the standalone smoke test use the
 * same code, so adapter behaviour is verifiable outside the harness.
 *
 * Two questions are answered for a provider:
 *   1. 余额   — how much credit is left (adapter dispatched by baseURL host).
 *   2. 单价   — price per 1M tokens for its models (OpenRouter目录 + 本地覆盖).
 *
 * @module engine
 */

export const DEFAULT_TIMEOUT_MS = 12000;
export const OPENROUTER_CATALOG_URL = 'https://openrouter.ai/api/v1/models';

/**
 * New API / one-api 的 `hard_limit_usd` 在「无限额度」时被硬编码成这个值
 * （`controller/billing.go`：`if token.UnlimitedQuota { amount = 100000000 }`）。
 * 它是个占位哨兵，不是钱：直接当余额显示会得到 9.9999 亿。
 */
export const UNLIMITED_QUOTA_SENTINEL = 100000000;

/** New API 默认 1 USD = 500000 quota；站点可在 /api/status 的 quota_per_unit 改掉。 */
export const DEFAULT_QUOTA_PER_UNIT = 500000;

/** POST/GET a URL and decode JSON, never throwing. */
export async function fetchJson(url, options = {}) {
  const {
    headers = {},
    method = 'GET',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    body,
    fetchImpl = globalThis.fetch,
  } = options;
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (typeof fetchImpl !== 'function') return { ok: false, status: 0, ms: 0, error: 'fetch-unavailable' };
    const response = await fetchImpl(url, {
      method,
      headers,
      body,
      signal: controller.signal,
      redirect: 'follow',
    });
    const text = await response.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { ok: response.ok, status: response.status, ms: Date.now() - started, json, text: text.slice(0, 400) };
  } catch (error) {
    const name = error && typeof error === 'object' ? error.name : '';
    return {
      ok: false,
      status: 0,
      ms: Date.now() - started,
      error: name === 'AbortError' ? `timeout after ${timeoutMs}ms` : String((error && error.message) || error),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** `https://host/v1/` -> `https://host/v1`; keeps path, drops trailing slashes. */
export function normalizeBase(baseURL) {
  const raw = String(baseURL || '').trim();
  if (raw === '') return undefined;
  return raw.replace(/\/+$/, '');
}

/** Candidate absolute URLs for a path: on the configured base, then on its origin. */
export function urlVariants(baseURL, path) {
  const base = normalizeBase(baseURL);
  if (base === undefined) return [];
  const out = [];
  try {
    const origin = new URL(base).origin;
    for (const prefix of [base, origin]) {
      const candidate = prefix + path;
      if (!out.includes(candidate)) out.push(candidate);
    }
  } catch {
    if (!out.includes(base + path)) out.push(base + path);
  }
  return out;
}

export function hostOf(baseURL) {
  try {
    return new URL(normalizeBase(baseURL)).host;
  } catch {
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * 1. balance adapters
 * ------------------------------------------------------------------ */

function firstNumber(source, keys) {
  if (source === null || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value);
  }
  return undefined;
}

function firstBoolean(source, keys) {
  if (source === null || typeof source !== 'object') return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') return value;
    if (value === 1 || value === 0) return value === 1;
  }
  return undefined;
}

function pickUnit(source, fallback = 'USD') {
  if (source === null || typeof source !== 'object') return fallback;
  for (const key of ['unit', 'currency', 'unit_name']) {
    const value = source[key];
    if (typeof value === 'string' && /^[A-Za-z$¥€]{1,8}$/.test(value.trim())) return value.trim().toUpperCase();
  }
  return fallback;
}

/**
 * A balance adapter queries one vendor family.
 * `match` decides eligibility from the baseURL host; `query` returns either
 *   { ok: true, remaining, unit, isValid, source, detail } or
 *   { ok: false, reason } and may attach `attempts`.
 */
export const BALANCE_ADAPTERS = [
  {
    id: 'openrouter',
    label: 'OpenRouter',
    match: ({ host }) => /(^|\.)openrouter\.ai$/i.test(host),
    paths: ['/api/v1/credits'],
    async query({ baseURL, apiKey, timeoutMs, fetchImpl }) {
      const headers = { accept: 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const attempts = [];
      for (const url of urlVariants(baseURL, '/api/v1/credits')) {
        const credits = await fetchJson(url, { headers, timeoutMs, fetchImpl });
        attempts.push({ url, status: credits.status, error: credits.error });
        if (!credits.ok || credits.json === undefined) continue;
        const data = credits.json?.data ?? credits.json;
        const total = firstNumber(data, ['total_credits', 'totalCredits']);
        const usage = firstNumber(data, ['total_usage', 'totalUsage']) ?? 0;
        if (total === undefined) continue;
        const detail = { total, usage };
        const keyUrl = urlVariants(baseURL, '/api/v1/key')[0];
        if (keyUrl !== undefined) {
          const key = await fetchJson(keyUrl, { headers, timeoutMs, fetchImpl });
          if (key.ok && key.json !== undefined) {
            const kd = key.json?.data ?? key.json;
            detail.key = {
              label: kd?.label,
              limit: firstNumber(kd, ['limit']),
              limitRemaining: firstNumber(kd, ['limit_remaining']),
              usage: firstNumber(kd, ['usage']),
              usageDaily: firstNumber(kd, ['usage_daily']),
              usageWeekly: firstNumber(kd, ['usage_weekly']),
              usageMonthly: firstNumber(kd, ['usage_monthly']),
              isFreeTier: firstBoolean(kd, ['is_free_tier']),
              rateLimit: kd?.rate_limit,
            };
          }
        }
        return {
          ok: true,
          remaining: total - usage,
          unit: 'USD',
          isValid: true,
          source: 'GET /api/v1/credits',
          detail,
        };
      }
      return { ok: false, reason: 'credits endpoint unreachable', attempts };
    },
  },
  {
    id: 'deepseek-official',
    label: 'DeepSeek 官方',
    match: ({ host }) => /(^|\.)api\.deepseek\.com$/i.test(host),
    paths: ['/user/balance'],
    async query({ baseURL, apiKey, timeoutMs, fetchImpl }) {
      const headers = { accept: 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const attempts = [];
      for (const url of urlVariants(baseURL, '/user/balance')) {
        const response = await fetchJson(url, { headers, timeoutMs, fetchImpl });
        attempts.push({ url, status: response.status, error: response.error });
        if (!response.ok || response.json === undefined) continue;
        const infos = Array.isArray(response.json.balance_infos) ? response.json.balance_infos : [];
        const preferred = infos.find((info) => String(info?.currency).toUpperCase() === 'USD') ?? infos[0];
        const remaining = firstNumber(preferred, ['total_balance', 'remaining', 'balance']);
        return {
          ok: true,
          remaining,
          unit: pickUnit(preferred, 'CNY'),
          isValid: response.json.is_available !== false,
          source: 'GET /user/balance',
          detail: { balanceInfos: infos },
        };
      }
      return { ok: false, reason: 'balance endpoint unreachable', attempts };
    },
  },
  {
    id: 'relay-user-balance',
    label: '中转站 /user/balance',
    match: () => true,
    paths: ['/user/balance'],
    async query({ baseURL, apiKey, timeoutMs, fetchImpl }) {
      const headers = { accept: 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const attempts = [];
      for (const url of urlVariants(baseURL, '/user/balance')) {
        const response = await fetchJson(url, { headers, timeoutMs, fetchImpl });
        attempts.push({ url, status: response.status, error: response.error });
        if (!response.ok || response.json === undefined) continue;
        const body = response.json;
        const nested = body?.data !== null && typeof body?.data === 'object' ? body.data : body;
        const remaining = firstNumber(nested, ['remaining', 'balance', 'quota', 'credit', 'credits', 'available', 'balance_remaining']);
        if (remaining === undefined) continue;
        return {
          ok: true,
          remaining,
          unit: pickUnit(nested),
          isValid: firstBoolean(nested, ['is_active', 'isActive', 'isValid', 'is_valid', 'is_available']) ?? true,
          source: 'GET /user/balance',
          detail: { raw: body },
        };
      }
      return { ok: false, reason: 'no /user/balance payload', attempts };
    },
  },
  {
    id: 'new-api',
    label: 'New API（访问令牌）',
    match: ({ accessToken }) => typeof accessToken === 'string' && accessToken !== '',
    paths: ['/api/user/self'],
    /**
     * New API 的 `/api/user/self` 只认 dashboard 会话或 PAT 访问令牌
     * （`middleware/auth.go` 的 `UserAuth()` → `service.ParseDashboardAccessToken`），
     * `sk-` 形式的 API key 在这里必然 401 —— 所以这条路径只在配了访问令牌时启用。
     */
    async query({ baseURL, accessToken, userId, quotaPerUnit, timeoutMs, fetchImpl }) {
      if (typeof accessToken !== 'string' || accessToken === '') {
        return { ok: false, skip: true, reason: '未配置访问令牌（accessToken / accessTokenEnv）' };
      }
      const headers = { accept: 'application/json', authorization: `Bearer ${accessToken}` };
      if (userId !== undefined && String(userId) !== '') headers['New-Api-User'] = String(userId);
      const attempts = [];
      let perUnit = typeof quotaPerUnit === 'number' && quotaPerUnit > 0 ? quotaPerUnit : DEFAULT_QUOTA_PER_UNIT;
      // /api/status 是公开端点：读站点自己的换算比例（很多站把 QuotaPerUnit 改过）
      let displayInCurrency;
      let usdExchangeRate;
      for (const url of urlVariants(baseURL, '/api/status')) {
        const status = await fetchJson(url, { headers: { accept: 'application/json' }, timeoutMs, fetchImpl });
        attempts.push({ url, status: status.status, error: status.error });
        if (!status.ok || status.json === undefined) continue;
        const data = status.json?.data ?? status.json;
        const unit = firstNumber(data, ['quota_per_unit', 'quotaPerUnit']);
        if (unit !== undefined && unit > 0) perUnit = unit;
        displayInCurrency = firstBoolean(data, ['display_in_currency', 'displayInCurrency']);
        usdExchangeRate = firstNumber(data, ['usd_exchange_rate', 'usdExchangeRate']);
        break;
      }
      for (const url of urlVariants(baseURL, '/api/user/self')) {
        const response = await fetchJson(url, { headers, timeoutMs, fetchImpl });
        attempts.push({ url, status: response.status, error: response.error });
        if (!response.ok || response.json === undefined) continue;
        const body = response.json;
        const data = body?.data;
        if (body?.success === false || data === null || typeof data !== 'object') continue;
        const quota = firstNumber(data, ['quota', 'remain_quota', 'remaining_quota']);
        if (quota === undefined) continue;
        const usedQuota = firstNumber(data, ['used_quota', 'usedQuota']) ?? 0;
        const remaining = quota / perUnit;
        const usage = usedQuota / perUnit;
        return {
          ok: true,
          remaining,
          unit: 'USD',
          // New API 用户 status：1 正常 / 2 禁用 / 3 封禁
          isValid: data.status === undefined || data.status === 1,
          source: 'GET /api/user/self',
          detail: {
            quota,
            usedQuota,
            total: remaining + usage,
            usage,
            quotaPerUnit: perUnit,
            usdExchangeRate,
            displayInCurrency,
          },
          attempts,
        };
      }
      return {
        ok: false,
        reason: '访问令牌无效或缺少 profile:read 权限（New API 的 GET /api/user/self 需要该 scope）',
        attempts,
      };
    },
  },
  {
    id: 'one-api',
    label: 'one-api / New API（API key）',
    match: () => true,
    paths: ['/api/user/self'],
    async query({ baseURL, apiKey, quotaPerUnit, timeoutMs, fetchImpl }) {
      const headers = { accept: 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const perUnit = typeof quotaPerUnit === 'number' && quotaPerUnit > 0 ? quotaPerUnit : DEFAULT_QUOTA_PER_UNIT;
      const attempts = [];
      for (const url of urlVariants(baseURL, '/api/user/self')) {
        const response = await fetchJson(url, { headers, timeoutMs, fetchImpl });
        attempts.push({ url, status: response.status, error: response.error });
        if (!response.ok || response.json === undefined) continue;
        const body = response.json;
        const data = body?.data;
        if (body?.success === false || data === null || typeof data !== 'object') continue;
        const quota = firstNumber(data, ['quota', 'remain_quota', 'remaining_quota']);
        if (quota === undefined) continue;
        const used = firstNumber(data, ['used_quota', 'usedQuota']) ?? 0;
        return {
          ok: true,
          // one-api 默认 1 USD = 500000 quota；New API 的 sk- key 到不了这里（401），
          // 能命中的是允许 key 直读 /api/user/self 的分支版本。
          remaining: quota / perUnit,
          unit: 'USD',
          isValid: true,
          source: 'GET /api/user/self',
          detail: {
            quota,
            usedQuota: used,
            usage: used / perUnit,
            total: (quota + used) / perUnit,
            quotaPerUnit: perUnit,
            note: `quota ÷ ${perUnit}（one-api 默认汇率）`,
          },
        };
      }
      return { ok: false, reason: 'no one-api payload', attempts };
    },
  },
  {
    id: 'openai-billing',
    label: 'OpenAI 计费接口',
    match: () => true,
    paths: ['/dashboard/billing/subscription'],
    async query({ baseURL, apiKey, timeoutMs, fetchImpl }) {
      const headers = { accept: 'application/json' };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
      const attempts = [];
      for (const url of urlVariants(baseURL, '/dashboard/billing/subscription')) {
        const subscription = await fetchJson(url, { headers, timeoutMs, fetchImpl });
        attempts.push({ url, status: subscription.status, error: subscription.error });
        if (!subscription.ok || subscription.json === undefined) continue;
        const hardLimit = firstNumber(subscription.json, ['hard_limit_usd', 'system_hard_limit_usd']);
        if (hardLimit === undefined) continue;
        let used = 0;
        let usedKnown = false;
        // {base}/dashboard/billing/usage 与 {origin}/dashboard/billing/usage 都要试：
        // 有的中转站只挂 origin 那一份，只试第一个会拿不到已用
        for (const usageUrl of urlVariants(baseURL, '/dashboard/billing/usage')) {
          const usage = await fetchJson(usageUrl, { headers, timeoutMs, fetchImpl });
          attempts.push({ url: usageUrl, status: usage.status, error: usage.error });
          if (!usage.ok || usage.json === undefined) continue;
          // New API 的 GetUsage 返回美分（TotalUsage: amount * 100），除以 100 得美元
          const total = firstNumber(usage.json, ['total_usage']);
          if (total === undefined) continue;
          used = total / 100;
          usedKnown = true;
          break;
        }
        if (hardLimit >= UNLIMITED_QUOTA_SENTINEL) {
          // New API 在 token.UnlimitedQuota 时直接返回 1e8：这是「无限额度」占位值，
          // 不是余额。报出来就是 9.9999 亿 —— 只保留真实可用的「已用」。
          return {
            ok: false,
            reason: `额度上限返回 ${hardLimit}（New API 的「无限额度」占位值，不是真实余额）`,
            usageOnly: usedKnown ? { usage: used, unit: 'USD', source: 'GET /dashboard/billing/usage' } : undefined,
            attempts,
          };
        }
        return {
          ok: true,
          remaining: hardLimit - used,
          unit: 'USD',
          isValid: true,
          source: 'GET /dashboard/billing/subscription',
          detail: { hardLimit, used, usage: used, total: hardLimit },
          attempts,
        };
      }
      return { ok: false, reason: 'no billing payload', attempts };
    },
  },
];

export function matchAdapters(baseURL, adapterIds, context = {}) {
  const host = hostOf(baseURL);
  const wanted = Array.isArray(adapterIds) && adapterIds.length > 0
    ? BALANCE_ADAPTERS.filter((adapter) => adapterIds.includes(adapter.id))
    : BALANCE_ADAPTERS;
  const matched = wanted.filter((adapter) => adapter.match({ baseURL, host, ...context }));
  const rest = wanted.filter((adapter) => !matched.includes(adapter));
  return [...matched, ...rest];
}

/* ------------------------------------------------------------------ *
 * 2. custom usage scripts (cc-switch compatible)
 * ------------------------------------------------------------------ */

function globToRegExp(pattern) {
  const escaped = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, 'i');
}

export function scriptMatches(pattern, baseURL) {
  const host = hostOf(baseURL);
  const needle = String(pattern);
  if (needle.includes('*') || needle.includes('?')) return globToRegExp(needle).test(host) || globToRegExp(needle).test(normalizeBase(baseURL) ?? '');
  return host.includes(needle) || (normalizeBase(baseURL) ?? '').includes(needle);
}

/** Find the first configured script whose host pattern matches this baseURL. */
export function findScript(scripts, baseURL) {
  if (scripts === null || typeof scripts !== 'object') return undefined;
  for (const [pattern, code] of Object.entries(scripts)) {
    if (typeof code === 'string' && code.trim() !== '' && scriptMatches(pattern, baseURL)) return { pattern, code };
  }
  return undefined;
}

/**
 * Run a cc-switch style usage script. Both shapes are accepted:
 *   ({ request: { url, method, headers }, extractor: function (response) { … } })
 *   function (ctx) { return { request, extractor } }
 * Template variables {{baseUrl}} and {{apiKey}} are substituted first.
 */
export async function runUsageScript({ code, baseURL, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl }) {
  const base = normalizeBase(baseURL) ?? '';
  const source = String(code)
    .split('{{baseUrl}}').join(base)
    .split('{{baseURL}}').join(base)
    .split('{{apiKey}}').join(apiKey ?? '')
    .split('{{api_key}}').join(apiKey ?? '');
  let spec;
  try {
    spec = new Function(`return (${source});`)();
  } catch (error) {
    return { ok: false, reason: `script 语法错误: ${String((error && error.message) || error)}` };
  }
  if (typeof spec === 'function') {
    try {
      spec = spec({ baseUrl: base, apiKey });
    } catch (error) {
      return { ok: false, reason: `script 执行失败: ${String((error && error.message) || error)}` };
    }
  }
  if (spec === null || typeof spec !== 'object' || typeof spec.request !== 'object' || spec.request === null) {
    return { ok: false, reason: 'script 未返回 { request, extractor }' };
  }
  const request = spec.request;
  const url = String(request.url ?? '');
  if (!/^https?:/i.test(url)) return { ok: false, reason: `script 未提供有效 URL: ${url || '(空)'}` };
  const method = String(request.method ?? 'GET').toUpperCase();
  const headers = request.headers !== null && typeof request.headers === 'object' ? { ...request.headers } : {};
  if (apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === 'authorization')) {
    headers.authorization = `Bearer ${apiKey}`;
  }
  const body = method === 'GET' || method === 'HEAD'
    ? undefined
    : request.body === undefined || typeof request.body === 'string'
      ? request.body
      : JSON.stringify(request.body);
  const response = await fetchJson(url, { method, headers, body, timeoutMs, fetchImpl });
  const attempts = [{ url, status: response.status, error: response.error }];
  if (!response.ok) return { ok: false, reason: `script 请求失败 (HTTP ${response.status || 0})`, attempts };
  const payload = response.json ?? response.text;
  if (typeof spec.extractor !== 'function') {
    const nested = payload?.data !== null && typeof payload?.data === 'object' ? payload.data : payload;
    return {
      ok: true,
      remaining: firstNumber(nested, ['remaining', 'balance', 'quota', 'credits']),
      unit: pickUnit(nested),
      isValid: true,
      source: `script ${url}`,
      detail: { raw: payload },
    };
  }
  let extracted;
  try {
    extracted = spec.extractor(payload);
  } catch (error) {
    return { ok: false, reason: `extractor 抛错: ${String((error && error.message) || error)}`, attempts };
  }
  if (extracted === null || typeof extracted !== 'object') {
    return { ok: false, reason: 'extractor 未返回对象', attempts };
  }
  return {
    ok: true,
    remaining: firstNumber(extracted, ['remaining', 'balance', 'total', 'credits']),
    unit: pickUnit(extracted),
    isValid: firstBoolean(extracted, ['isValid', 'is_valid', 'isActive']) ?? true,
    source: `script ${url}`,
    detail: { extracted, raw: payload },
  };
}

/* ------------------------------------------------------------------ *
 * 3. balance orchestration
 * ------------------------------------------------------------------ */

/**
 * @param {{ baseURL?: string, apiKey?: string, accessToken?: string, userId?: string|number,
 *   quotaPerUnit?: number, adapters?: string[]|'auto', scripts?: Record<string,string>,
 *   timeoutMs?: number, fetchImpl?: Function }} input
 *
 * `accessToken` 是 New API 的 dashboard 访问令牌（PAT）：中转站的 sk- key 读不到账户余额，
 * 只有访问令牌能打 `/api/user/self`。没配就跳过那条适配器，绝不拿 key 去猜。
 */
export async function queryBalance(input) {
  const {
    baseURL,
    apiKey,
    accessToken,
    userId,
    quotaPerUnit,
    adapters = 'auto',
    scripts,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl,
  } = input;
  if (normalizeBase(baseURL) === undefined) {
    return { ok: false, reason: 'baseURL 未知（无法定位余额接口）', attempts: [], adapter: null };
  }
  const script = findScript(scripts, baseURL);
  const attempts = [];
  if (script !== undefined) {
    const result = await runUsageScript({ code: script.code, baseURL, apiKey, timeoutMs, fetchImpl });
    attempts.push(...(result.attempts ?? []));
    if (result.ok) return { ...result, adapter: `script:${script.pattern}` };
    attempts.push({ url: `script:${script.pattern}`, status: 0, error: result.reason });
    if (Array.isArray(adapters)) return { ok: false, reason: result.reason, attempts, adapter: `script:${script.pattern}` };
  }
  const candidates = matchAdapters(baseURL, adapters === 'auto' ? undefined : adapters, { accessToken });
  const reasons = [];
  let usageOnly;
  for (const adapter of candidates) {
    let result;
    try {
      result = await adapter.query({ baseURL, apiKey, accessToken, userId, quotaPerUnit, timeoutMs, fetchImpl });
    } catch (error) {
      result = { ok: false, reason: String((error && error.message) || error) };
    }
    attempts.push(...(result.attempts ?? []));
    if (result.ok) return { ...result, adapter: adapter.id, adapterLabel: adapter.label, attempts };
    // skip = 这条适配器在当前配置下不适用（例如没配访问令牌），不算一次失败尝试
    if (result.skip === true) {
      if (!Array.isArray(adapters)) continue;
      // 写死了适配器列表却又不满足前提：把原因报出来，不要静默跳过
      reasons.push(result.reason ?? 'adapters 里的适配器在当前配置下不适用');
      break;
    }
    if (typeof result.reason === 'string' && result.reason !== '') reasons.push(result.reason);
    if (usageOnly === undefined && result.usageOnly !== undefined) usageOnly = result.usageOnly;
    if (Array.isArray(adapters)) break;
  }
  const unique = [...new Set(reasons)];
  // 「no xxx payload」「xxx unreachable」是适配器没认出来的废话；有具体原因（占位值 / 401）时只报具体原因
  const strong = unique.filter((reason) => !/^(no .+payload|.+unreachable)$/i.test(reason));
  const picked = (strong.length > 0 ? strong : unique).slice(0, 3);
  return {
    ok: false,
    reason: `${picked.length > 0 ? picked.join('；') : '所有余额适配器均未命中'}${accessTokenHint(attempts, accessToken)}`,
    usageOnly,
    attempts,
    adapter: null,
  };
}

/** 401 on `/api/user/self` = 这个中转站只认访问令牌，把「怎么修」直接写进原因里。 */
function accessTokenHint(attempts, accessToken) {
  if (typeof accessToken === 'string' && accessToken !== '') return '';
  const hit = attempts.some((attempt) => (
    typeof attempt.url === 'string'
    && attempt.url.includes('/api/user/self')
    && (attempt.status === 401 || attempt.status === 403)
  ));
  return hit ? '。该中转站需在「个人设置 → 访问令牌」创建 PAT，并填到 config.providers.<id>.accessToken' : '';
}

/* ------------------------------------------------------------------ *
 * 4. price catalog
 * ------------------------------------------------------------------ */

/** OpenRouter放的是 USD/token 字符串，×1e6 得 USD/1M tokens。 */
export function perMillion(value) {
  const number = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(number)) return undefined;
  return Number((number * 1e6).toPrecision(6));
}

export function parseCatalog(payload) {
  const rows = Array.isArray(payload?.data) ? payload.data : [];
  const models = [];
  for (const row of rows) {
    const id = typeof row?.id === 'string' ? row.id : undefined;
    if (id === undefined) continue;
    const pricing = row.pricing ?? {};
    const price = {
      input: perMillion(pricing.prompt),
      output: perMillion(pricing.completion),
      cacheRead: perMillion(pricing.input_cache_read),
      cacheWrite: perMillion(pricing.input_cache_write),
      webSearch: perMillion(pricing.web_search),
    };
    models.push({
      id,
      name: typeof row.name === 'string' ? row.name : id,
      contextLength: typeof row.context_length === 'number' ? row.context_length : undefined,
      price,
    });
  }
  return models;
}

export function normalizeModelKey(id) {
  return String(id || '').toLowerCase().replace(/^[a-z0-9_.-]+\//, '').replace(/[^a-z0-9]/g, '');
}

/**
 * Match a provider model id against the OpenRouter目录.
 * Preference: explicit override → openrouter slug → exact id → bare id → normalized key.
 */
export function matchCatalogModel(modelId, catalogIndex, options = {}) {
  const { slug, override } = options;
  if (override !== undefined) {
    const hit = catalogIndex.byId.get(String(override).toLowerCase());
    if (hit !== undefined) return { model: hit, matchedBy: 'override' };
  }
  if (slug !== undefined && slug !== null) {
    const hit = catalogIndex.byId.get(String(slug).toLowerCase());
    if (hit !== undefined) return { model: hit, matchedBy: 'slug' };
  }
  const lower = String(modelId || '').toLowerCase();
  const exact = catalogIndex.byId.get(lower);
  if (exact !== undefined) return { model: exact, matchedBy: 'id' };
  const bare = catalogIndex.byBare.get(lower);
  if (bare !== undefined && bare.length === 1) return { model: bare[0], matchedBy: 'bare-id' };
  const normalized = catalogIndex.byNormalized.get(normalizeModelKey(lower));
  if (normalized !== undefined && normalized.length === 1) return { model: normalized[0], matchedBy: 'normalized' };
  return undefined;
}

export function buildCatalogIndex(models) {
  const byId = new Map();
  const byBare = new Map();
  const byNormalized = new Map();
  for (const model of models) {
    const id = model.id.toLowerCase();
    byId.set(id, model);
    const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
    if (!byBare.has(bare)) byBare.set(bare, []);
    byBare.get(bare).push(model);
    const normalized = normalizeModelKey(id);
    if (!byNormalized.has(normalized)) byNormalized.set(normalized, []);
    byNormalized.get(normalized).push(model);
  }
  return { byId, byBare, byNormalized };
}

/**
 * 价格目录的候选模型（用于「未匹配到价格」时给出可解释的提示）。
 * 规则：目录模型 id 的 token 必须 **完整包含** 查询模型 id 的 token；额外 token 越少越靠前，
 * 目录里的 `~` 前缀别名行降权。只做提示，绝不据此自动定价（避免给出错误的单价）。
 */
export function suggestCatalogModels(modelId, catalogIndex, options = {}) {
  const { limit = 3 } = options;
  const queryTokens = tokenizeModelId(modelId).filter(meaningfulToken);
  if (queryTokens.length === 0) return [];
  const queryKey = queryTokens.join('');
  const scored = [];
  for (const model of catalogIndex.byId.values()) {
    const id = model.id;
    const tokens = tokenizeModelId(id);
    if (!queryTokens.every((token) => tokens.includes(token))) continue;
    const extra = tokens.length - queryTokens.length;
    const bare = id.includes('/') ? id.slice(id.lastIndexOf('/') + 1) : id;
    scored.push({
      id,
      score: extra + (String(id).startsWith('~') ? 2 : 0),
      prefix: commonPrefixLength(queryKey, tokenizeModelId(bare).filter(meaningfulToken).join('')),
    });
  }
  scored.sort((a, b) => a.score - b.score
    || b.prefix - a.prefix
    || a.id.length - b.id.length
    || a.id.localeCompare(b.id));
  return scored.slice(0, limit).map((row) => row.id);
}

/** 单字符 token 只有是数字时才有意义（版本号 5.3 / 27b 里的 8）。 */
function meaningfulToken(token) {
  return token.length > 1 || /^[0-9]$/.test(token);
}

function commonPrefixLength(a, b) {
  const max = Math.min(a.length, b.length);
  let index = 0;
  while (index < max && a[index] === b[index]) index += 1;
  return index;
}

function tokenizeModelId(id) {
  return String(id || '').toLowerCase().split(/[^a-z0-9]+/).filter((token) => token !== '');
}

/* ------------------------------------------------------------------ *
 * 5. provider model list
 * ------------------------------------------------------------------ */

const MODEL_LIST_PATHS = ['/models', '/v1/models'];

/** GET the provider's OpenAI-style model list; returns rows including any extra metadata. */
export async function fetchProviderModels({ baseURL, apiKey, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl }) {
  const headers = { accept: 'application/json' };
  if (apiKey) headers.authorization = `Bearer ${apiKey}`;
  const attempts = [];
  for (const path of MODEL_LIST_PATHS) {
    for (const url of urlVariants(baseURL, path)) {
      const response = await fetchJson(url, { headers, timeoutMs, fetchImpl });
      attempts.push({ url, status: response.status, error: response.error });
      const rows = Array.isArray(response.json?.data) ? response.json.data : undefined;
      if (response.ok && rows !== undefined && rows.length > 0) {
        return {
          ok: true,
          url,
          models: rows.map((row) => ({
            id: String(row?.id ?? ''),
            raw: row,
            slug: row?.openrouter?.slug ?? row?.slug,
            contextLength: row?.context_window ?? row?.context_length ?? row?.input_modalities?.[0]?.supported_inputs?.max_context_length,
          })).filter((row) => row.id !== ''),
          attempts,
        };
      }
    }
  }
  return { ok: false, models: [], attempts, reason: '未取到模型列表' };
}

/**
 * Download the public price catalog once. Never throws; `ok` is only true when
 * the response decoded into at least one priced row (a 200 with an unparsable
 * or empty body must not look like a healthy empty catalog).
 */
export async function fetchPriceCatalog(input = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl, url = OPENROUTER_CATALOG_URL } = input;
  const response = await fetchJson(url, { timeoutMs, fetchImpl });
  const models = response.ok ? parseCatalog(response.json) : [];
  const ok = response.ok && models.length > 0;
  let error;
  if (!response.ok) error = response.error ?? 'HTTP ' + response.status;
  else if (models.length === 0) error = response.json === undefined ? '目录响应不是 JSON' : '目录返回 0 个模型';
  return { fetchedAt: Date.now(), source: url, ok, error, models };
}

/**
 * Cached catalog policy: reuse a fresh catalog, otherwise reload, and on a bad
 * reload keep the last known good catalog instead of dropping every price for
 * the whole TTL. Returns `stale: true` plus `error` when the reload failed.
 */
export async function resolveCatalog(input = {}) {
  const { previous = null, ttlMs = 0, now = Date.now(), load } = input;
  const usable = previous !== null && Array.isArray(previous.models) && previous.models.length > 0;
  if (usable && now - previous.fetchedAt < ttlMs) return previous;
  if (typeof load !== 'function') {
    return usable
      ? previous
      : { fetchedAt: now, source: OPENROUTER_CATALOG_URL, ok: false, error: '没有目录加载器', models: [] };
  }
  const next = await load();
  const good = next !== null && next !== undefined && next.ok === true && Array.isArray(next.models) && next.models.length > 0;
  if (good) return next;
  const error = next?.error ?? '目录不可用';
  if (usable) return { ...previous, stale: true, error };
  return next ?? { fetchedAt: now, source: OPENROUTER_CATALOG_URL, ok: false, error, models: [] };
}

/* ------------------------------------------------------------------ *
 * 6. quote assembly
 * ------------------------------------------------------------------ */

/**
 * @param {{
 *   providers: Array<{ id: string, name?: string, baseURL?: string, apiKey?: string, apiKeyEnv?: string, models?: string[], active?: boolean, adapters?: string[], priceMap?: Record<string,string> }>,
 *   active?: { provider?: string, model?: string },
 *   scripts?: Record<string,string>,
 *   priceOverrides?: Record<string, { input?: number, output?: number, cacheRead?: number, cacheWrite?: number }>,
 *   catalog?: { models: Array<object>, fetchedAt: number, source: string } | null,
 *   timeoutMs?: number,
 *   fetchImpl?: Function,
 *   fetchCatalog?: boolean,
 * }} input
 */
export async function buildQuote(input) {
  const {
    providers = [],
    active = {},
    scripts,
    priceOverrides = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    fetchImpl,
    fetchCatalog = true,
  } = input;
  let catalog = input.catalog ?? null;
  if (fetchCatalog && catalog === null) {
    catalog = await fetchPriceCatalog({ timeoutMs, fetchImpl });
  }
  const index = buildCatalogIndex(catalog?.models ?? []);

  const quotes = await Promise.all(providers.map(async (provider) => {
    const baseURL = normalizeBase(provider.baseURL);
    const [balance, listing] = await Promise.all([
      queryBalance({
        baseURL,
        apiKey: provider.apiKey,
        accessToken: provider.accessToken,
        userId: provider.userId,
        quotaPerUnit: provider.quotaPerUnit,
        adapters: provider.adapters ?? 'auto',
        scripts,
        timeoutMs,
        fetchImpl,
      }),
      baseURL === undefined || provider.skipModels === true
        ? Promise.resolve({ ok: false, models: [], attempts: [] })
        : fetchProviderModels({ baseURL, apiKey: provider.apiKey, timeoutMs, fetchImpl }),
    ]);

    const modelIds = new Set(provider.models ?? []);
    for (const model of listing.models) modelIds.add(model.id);
    const slugById = new Map(listing.models.map((model) => [model.id, model.slug]));

    const models = [...modelIds].map((id) => {
      const override = priceOverrides[id] ?? priceOverrides[`${provider.id}/${id}`];
      const hit = matchCatalogModel(id, index, { slug: slugById.get(id), override: override?.openrouterId });
      const numeric = override === undefined ? undefined : {
        ...(typeof override.input === 'number' ? { input: override.input } : {}),
        ...(typeof override.output === 'number' ? { output: override.output } : {}),
        ...(typeof override.cacheRead === 'number' ? { cacheRead: override.cacheRead } : {}),
        ...(typeof override.cacheWrite === 'number' ? { cacheWrite: override.cacheWrite } : {}),
      };
      const merged = hit === undefined
        ? numeric
        : { ...(hit.model.price ?? {}), ...(numeric ?? {}) };
      const price = merged !== undefined && Object.keys(merged).length > 0 ? merged : undefined;
      const suggestions = price === undefined ? suggestCatalogModels(id, index, { limit: 3 }) : [];
      return {
        id,
        contextLength: listing.models.find((model) => model.id === id)?.contextLength,
        price: price ?? null,
        matchedId: hit?.model.id,
        matchedBy: hit === undefined ? undefined : override?.openrouterId !== undefined ? 'override' : hit.matchedBy,
        suggestions: suggestions.length > 0 ? suggestions : undefined,
        active: active.provider === provider.id && active.model === id,
      };
    }).sort((a, b) => Number(b.active) - Number(a.active) || a.id.localeCompare(b.id));

    return {
      id: provider.id,
      name: provider.name ?? provider.id,
      baseURL,
      host: hostOf(baseURL),
      apiKeyEnv: provider.apiKeyEnv,
      hasApiKey: typeof provider.apiKey === 'string' && provider.apiKey !== '',
      active: active.provider === provider.id || provider.active === true,
      balance,
      modelCount: models.length,
      models: models.slice(0, 200),
    };
  }));

  return {
    generatedAt: new Date().toISOString(),
    active: {
      provider: active.provider,
      model: active.model,
      // 'session'        = 某个会话自己的模型选择（GUI 带着本会话选择来询价）
      // 'global-default' = 新会话的默认选择（agentDefaultModel.currentSelection()）
      // 'explicit'       = 调用方点名要的提供商（工具参数 / 查询串里给了 provider 但没给会话）
      source: active.source,
      sessionId: active.sessionId,
    },
    catalog: catalog === null
      ? null
      : {
        ok: catalog.ok !== false,
        source: catalog.source,
        fetchedAt: catalog.fetchedAt,
        modelCount: (catalog.models ?? []).length,
        error: catalog.error,
        stale: catalog.stale === true ? true : undefined,
      },
    providers: quotes,
  };
}

/* ------------------------------------------------------------------ *
 * 7. rendering
 * ------------------------------------------------------------------ */

export function formatMoney(value, unit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  const text = Math.abs(value) >= 1 ? value.toFixed(4) : value.toFixed(6);
  return `${text.replace(/0+$/, '').replace(/\.$/, '')} ${unit ?? ''}`.trim();
}

export function formatPrice(price) {
  if (price === null || price === undefined) return '—';
  const parts = [];
  if (typeof price.input === 'number') parts.push(`入 $${price.input}`);
  if (typeof price.output === 'number') parts.push(`出 $${price.output}`);
  if (typeof price.cacheRead === 'number') parts.push(`缓存读 $${price.cacheRead}`);
  if (typeof price.cacheWrite === 'number') parts.push(`缓存写 $${price.cacheWrite}`);
  return parts.length === 0 ? '—' : `${parts.join(' / ')}（USD / 1M tokens）`;
}

export function renderQuoteText(quote, options = {}) {
  const { models = true, maxModels = 24 } = options;
  const lines = [];
  const active = quote.active ?? {};
  lines.push(`# 提供商询价  ${quote.generatedAt}`);
  const sourceLabel = active.source === 'session'
    ? '（本会话选择）'
    : active.source === 'global-default'
      ? '（全局默认）'
      : active.source === 'explicit' ? '（指定）' : '';
  lines.push(`当前使用：${active.provider ?? '(未知)'}${active.model ? ` · ${active.model}` : ''}${sourceLabel}`);
  if (quote.catalog !== null) {
    const cat = quote.catalog;
    const note = cat.ok
      ? (cat.stale === true ? `，沿用上次成功获取（重取失败: ${cat.error ?? ''}）` : '')
      : `，不可用: ${cat.error ?? ''}`;
    lines.push(`价格目录：${cat.source}（${cat.modelCount} 个模型${note}）`);
  }
  for (const provider of quote.providers) {
    const flag = provider.active ? '★ 使用中' : '';
    lines.push('');
    lines.push(`## ${provider.name} ${flag}`.trim());
    lines.push(`- baseURL: ${provider.baseURL ?? '(未知 — 未在配置中找到，请在插件 config.providers 里补上)'}`);
    if (provider.balance?.ok) {
      const detail = provider.balance.detail ?? {};
      const extra = typeof detail.total === 'number' ? `（总额 ${formatMoney(detail.total, provider.balance.unit)}，已用 ${formatMoney(detail.usage, provider.balance.unit)}）` : '';
      const parts = [`- 余额: ${formatMoney(provider.balance.remaining, provider.balance.unit)}`];
      if (extra !== '') parts.push(extra.replace(/^（|）$/g, ''));
      parts.push(provider.balance.isValid === false ? '账户不可用' : '账户有效');
      parts.push(`来源 ${provider.balance.source}`);
      lines.push(parts.join(' · '));
    } else {
      const usageOnly = provider.balance?.usageOnly;
      const usedText = usageOnly !== undefined && typeof usageOnly.usage === 'number'
        ? ` · 已用 ${formatMoney(usageOnly.usage, usageOnly.unit)}（${usageOnly.source ?? '用量接口'}）`
        : '';
      lines.push(`- 余额: 查询失败（${provider.balance?.reason ?? '未知原因'}）${usedText}`);
      const attempts = (provider.balance?.attempts ?? []).slice(0, 6);
      for (const attempt of attempts) {
        lines.push(`  - ${attempt.url} → ${attempt.status ? `HTTP ${attempt.status}` : (attempt.error ?? 'no response')}`);
      }
    }
    const priced = provider.models.filter((model) => model.price !== null);
    const unpriced = provider.models.filter((model) => model.price === null);
    if (models === false) continue;
    if (priced.length === 0) {
      lines.push(`- 单价: 未匹配到价格（模型 ${provider.modelCount} 个）`);
    } else {
      lines.push(`- 单价（USD / 1M tokens，${priced.length}/${provider.modelCount} 个模型已定价）:`);
      for (const model of priced.slice(0, maxModels)) {
        lines.push(`  - ${model.active ? '★ ' : ''}${model.id}: ${formatPrice(model.price)}${model.matchedId ? `  ←目录 ${model.matchedId}${model.matchedBy === 'normalized' ? '(模糊匹配)' : ''}` : ''}`);
      }
    }
    if (unpriced.length > 0) {
      lines.push(`- 未匹配价格（${unpriced.length}/${provider.modelCount} 个，可用配置 priceOverrides 手工定价）:`);
      for (const model of unpriced.slice(0, maxModels)) {
        const hint = (model.suggestions ?? []).length > 0 ? `  候选: ${model.suggestions.join(', ')}` : '';
        lines.push(`  - ${model.active ? '★ ' : ''}${model.id}${hint}`);
      }
    }
  }
  return lines.join('\n');
}
