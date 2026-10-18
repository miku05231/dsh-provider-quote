# provider-quote · 对正在使用的模型提供商询价

参考 cc-switch 的「服务商询价」，把同一件事做进 DSH：**当前在用哪个提供商，就查它的余额与单价**。

| 问的问题 | 数据来源 |
| --- | --- |
| 我还有多少钱？ | 按 `baseURL` 自动分派厂商余额适配器（见下表），也可直接粘贴 cc-switch 的 `usage_script` |
| 这个模型多少钱？ | OpenRouter 公开价格目录 `https://openrouter.ai/api/v1/models`（输入 / 输出 / 缓存读写，USD per 1M tokens），可本地覆盖 |
| 我能用哪些模型？ | 提供商自己的 `GET /models`（OpenAI 兼容） |

## 装什么

一个 bundle，两半：

* **宿主**
  * `index.js` —— 包根转发（`export * from './lib/host.js'`）
  * `lib/host.js` —— 宿主实现；`lib/pricing.js` —— 与 DSH 无关的纯询价引擎（适配器、价格目录、报价与文本渲染）
  * 工具 `provider_quote` —— agent 直接问价：`provider_quote()` / `provider_quote({ all: true })` / `provider_quote({ provider: 'openrouter' })` / `provider_quote({ models: true })`
  * 路由
    * `GET /api/provider-quote/summary`（`?refresh=1` 跳过 30s 报价缓存）
    * `GET /api/provider-quote/refresh`（同上，路径别名）
    * `GET /api/provider-quote/ping` —— 自检：版本、当前加载的模块 URL、目录缓存里的模型数
    * 可选查询参数（浏览器端就是这么问的）：`scope=session|default`、`sessionId=<会话 id>`、`provider=<提供商 id>`、`model=<模型 id>`。带着 `scope=session&provider=…` 时，报价里的「使用中」就是**那个会话自己的模型选择**；只带 `sessionId`（会话还没选过模型）或什么都不带时，按**新会话的默认模型**（全局默认）处理 —— 见下面「本会话 vs 全局默认」。
  * 可选的定时预热（`autoRefreshMinutes`）
* **客户端（`client.js`）** —— 两个挂载点：
  * 对话输入框下方的常驻胶囊（slot `conversation.composer.dock`，与自带的 `stats` 同一行）：`● 余额 12.4 USD` —— **只显示本会话选中的提供商的余额**；在输入框的模型选择器里换提供商，胶囊立刻跟着换（报价本身含所有提供商的余额，不需要重新询价）；点一下立即重新询价（走 `?refresh=1`，跳过宿主的 30s 缓存，并带上本会话的选择），查询中是「余额查询中…」，失败是「余额没查到」，选中的提供商没被收录时是「余额未知」并自动重查一次；悬停可见提供商、来源（本会话选择 / 全局默认）与失败原因；每 5 分钟静默刷新一次。要看各提供商余额、模型单价与目录候选，用下面的设置页面板。
  * 「设置 → 模型」页底部的询价面板（slot `settings.models.footer`）：当前提供商的余额、当前模型的单价、其余提供商的概览，带「刷新询价」按钮（设置页没有会话上下文，固定按全局默认问）。
  * 两个组件共用同一份取数（模块内 store），不会重复请求宿主。

## 本会话 vs 全局默认

DSH 里有**两套**「当前用哪个提供商」，插件必须分清楚，否则会出现「胶囊显示 A、点刷新却查了 B」：

| | 是什么 | 谁在用 | 插件怎么读 |
| --- | --- | --- | --- |
| **本会话选择** | 每个会话自己的模型选择（`modelSelection` 投影，`next ?? lastUsed`） | 输入框下方的模型选择器 | 胶囊所在 slot 的标准属性 `useProjection('modelSelection')`；读不到时退回官方 `modelDirectories` 里该会话的目录快照 |
| **全局默认** | `agentDefaultModel.currentSelection()`，**只决定新会话**用什么 | 设置页面板、`provider_quote` 工具、没选过模型的会话 | 宿主侧读 `agentDefaultModel` 服务 |

于是：**显示**永远按本会话的选择（同一个窗口里切换会话，胶囊立刻跟着新会话走）；**点刷新**会把 `scope=session&sessionId=…&provider=…&model=…` 一起带给宿主，宿主按这个会话解析「使用中」，不会因为别的会话刚改过选择而查错对象。会话还没选过模型时就按全局默认走，并如实标注来源；读不到会话信息时也不会静默顶替成别的会话的选择。

## 安装

```bash
# 在会话里用 plugin_manager 指定工作区目录（不要在 profile 目录里手写 package.json / 跑 pnpm）
plugin_manager action=install_bundle target=<本插件的绝对路径，如 ~/dev/dsh-provider-quote>
```

装完看返回的 `application` 与 `warnings`：`applied` 即生效；宿主代码改动后需要重启 DSH 才会加载新代码（见文末「注意」）。

## 余额适配器

`adapters: auto`（默认）时按 `baseURL` 的 host 优先、其余适配器兜底依次尝试；每次查询会记录试过的 URL 与 HTTP 状态，失败也给出可解释的原因。

| id | 接口 | 适用 |
| --- | --- | --- |
| `openrouter` | `GET {origin}/api/v1/credits`（+ `/api/v1/key`） | OpenRouter 官方：余额 = total_credits − total_usage |
| `deepseek-official` | `GET {origin}/user/balance` | DeepSeek 官方：`balance_infos[]`（CNY/USD），`is_available` |
| `relay-user-balance` | `GET {base}/user/balance`、`{origin}/user/balance` | 多数中转站的通用布局：`balance` / `remaining` / `is_active` / `unit` |
| `one-api` | `GET {base}/api/user/self`（API key） | one-api / New API 布局：`quota`（÷`quota_per_unit` 估算 USD，仅参考）；New API 会对 API key 回 401，需改用下面的 `new-api` |
| `new-api` | `GET {base}/api/status` + `GET {base}/api/user/self`（访问令牌） | New API 面板的**准确**余额：`quota` / `used_quota` ÷ 面板自己的 `quota_per_unit`；需在配置里给访问令牌 |
| `openai-billing` | `GET {base}/dashboard/billing/subscription` + `/usage` | 旧版 OpenAI 计费接口；返回 `100000000` 视为 New API 的「无限额度」占位值，不当作余额，只报已用 |
| `script:<host>` | 你配置的 `scripts` | 任意厂商：直接粘贴 cc-switch 的 usage_script |

自定义脚本与 cc-switch 完全兼容，模板变量 `{{baseUrl}}` / `{{apiKey}}` 会被替换：

```yaml
scripts:
  relay.example.com: >-
    ({ request: { url: "{{baseUrl}}/user/balance", method: "GET",
                  headers: { "Authorization": "Bearer {{apiKey}}", "User-Agent": "cc-switch/1.0" } },
       extractor: function (response) { return { isValid: response.is_active || true, remaining: response.balance, unit: "USD" }; } })
```

以上这条就是从 cc-switch 的 `cc-switch.db` → `providers.meta.usage_script` 里原样抄来的：把你在 cc-switch 里给某个供应商配好的脚本粘到 `scripts.<host>`，行为与 cc-switch 一致（插件不直接读 cc-switch 的数据库，只认这个格式）。

## 中转站与其他网关

「中转站」指第三方把各家官方 API 转卖或聚合出来的一个 OpenAI 兼容端点（常见 one-api、New API 面板，也有自研网关）。在 DSH 里它就是一个 `baseURL` 不同的普通提供商，但有几个特点值得知道：

* **余额接口各家不同**，没有统一标准：`GET {base}/user/balance`（多数中转站，字段 `balance` / `remaining` / `is_active` / `unit`）、one-api 系的 `GET {base}/api/user/self`（`quota`，÷500000 估算 USD）、旧版 OpenAI 的 `/dashboard/billing/*`；也有部分网关（只转发、不做结算的那种）根本没有公开余额接口。插件按 `baseURL` 的 host 优先匹配、其余适配器兜底逐个试，**查不到也会列出试过的 URL 与 HTTP 状态**，而不是留白。
* **有倍率**：中转站通常按自己的倍率计费（cc-switch 里叫 `cost_multiplier`）。插件显示的单价来自 OpenRouter 公开目录，是**参考价**；对不上就把实付价写进 `priceOverrides`（可直接给 `input` / `output` / `cacheRead` / `cacheWrite`）。
* **模型会重名**：同一个 id（例如 `deepseek-flash`）在不同站可能是不同后端，所以插件**不猜价** —— 匹配不到就写「未匹配到价格」并给出目录候选，由你确认后再 `priceOverrides` 锚定。
* **key 走凭据名**：配置里写 `apiKeyEnv: MY_RELAY_API_KEY` 这类名字，插件用 `ctx.credentials` 按需解析（改 key 立即生效），从不落盘、不打印明文。
* **同一站可以配多个条目**：比如同一个中转站分成「按月套餐」和「按量付费」两个 key，写两个 provider id 即可分别看余额与单价。

### New API 面板：为什么余额会显示「99999998 USD」

如果你用的中转站是 [New API](https://github.com/Calcium-Ion/new-api) 搭的（`GET /api/status` 能返回 `quota_per_unit` / `display_in_currency`），用**只有 API key** 的配置去查余额，过去会看到九位数的假余额，或者干脆查不到：

* 新版 OpenAI 计费接口 `GET /dashboard/billing/subscription` 在「无限额度」账户上返回 `hard_limit_usd: 100000000` —— 这是 New API 源码里的**占位哨兵值**（`controller/billing.go`：`if token.UnlimitedQuota { amount = 100000000 }`），不是钱。旧版插件拿它减 `total_usage` 得到 9.9999 亿。
* `GET /api/user/self`（真正能读到 `quota` / `used_quota` 的接口）只认 **dashboard 会话或访问令牌（PAT）**，用 `sk-` 开头的 API key 打过去恒为 `401 {"code":"AUTH_UNAUTHORIZED"}`。New API 没有「仅用 API key 取账户余额」的端点，所以这一步绕不过去。

插件的处理（v0.4.0 起）：

1. 识别到 `100000000` 就**不当余额**，只报真实「已用」并说明原因，不再显示九位数；
2. 想要**准确余额**，在面板「个人设置 → 安全 → 访问令牌」新建一个令牌（新版按路由 scope 校验，读账户信息需要 `profile:read`），把令牌写进配置即可 —— 插件会先读 `/api/status` 拿到站点自己的 `quota_per_unit`，再用令牌读 `/api/user/self`，换算成 USD：

```yaml
providers:
  xianapi-ds:
    baseURL: https://www.xianapi.cloud/v1
    accessTokenEnv: XIANAPI_DS_ACCESS_TOKEN   # 凭据名，和 apiKeyEnv 一样走 ctx.credentials
    # 或者直接写 accessToken: pat-xxxx（不推荐：会进配置文件）
    # 令牌绑在非默认用户上时再加 userId: 2   → 会带 New-Api-User 头
```

没给访问令牌也能用：胶囊会显示「已用 $X.XX」而不是假余额。配置里 `quotaPerUnit` 可覆盖自动读取的 `quota_per_unit`（面板改过换算比例时才需要）。

## 单价匹配

模型 id 依次按 `priceOverrides.<model>.openrouterId` → 提供商返回的 `openrouter.slug` → 完整 id → 裸模型名 → 归一化名（去厂商前缀与符号）匹配目录；**匹配不到就如实写「未匹配到价格」，不猜价**，并在括注里给出目录中的候选（`suggestions`，最多 3 条）：

```
deepseek-flash 未定价（候选：deepseek/deepseek-v4-flash、deepseek/deepseek-v4.1-flash、deepseek/deepseek-v4-flash-0731）
```

看到候选就说明「大概是哪个型号」，确认后写进 `priceOverrides` 即可（两形态都支持）：

```yaml
priceOverrides:
  deepseek-flash: { openrouterId: deepseek/deepseek-chat }   # 指向目录里的对应条目
  my-local-model: { input: 0.3, output: 0.9, cacheRead: 0.03, cacheWrite: 0.4 }
```

## 价格目录缓存

目录一次抓 458 个模型，默认缓存 6 小时（`catalogTtlMs`）：

* 缓存里存的是**整个目录**（不是摘要），重放缓存时仍能正常定价；
* 抓取失败（超时 / 非 JSON / 返回 0 个模型）时**保留上一次成功的目录**并标记 `stale`，面板显示「· 沿用缓存」，文本输出写「沿用上次成功获取（重取失败: …）」；
* 完全没有可用目录时才显示「价格目录不可用」。

## 提供商从哪来

1. 自动发现：读取 profile 里各插件行的生效配置（`configEditor`），凡出现 `providers: { id: { baseURL, apiKeyEnv, models } }` 形状即登记 —— 例如官方 `llm-pi-ai` 适配器里配的中转站条目。解析不出 `baseURL` 的条目（如凭据型 provider 的占位行）会被跳过，只有你在 `config.providers` 里显式写了才保留。
2. API key：`apiKeyEnv` 指向的凭据名经 `ctx.credentials` 解析（每次查询重新解析，改 key 立即生效），插件从不读写、也不打印明文。
3. 兜底：插件自己的 `config.providers` 可覆盖或补全（`baseURL` / `apiKeyEnv` / `adapters` / `skipModels`）。
4. 内置路由：像 `deepseek-official`（DeepSeek 官方账号，凭据型 provider，配置里不写 `baseURL`）这类官方提供商由插件内置映射到官方端点 —— `deepseek-official` → `https://api.deepseek.com` + 凭据 `DEEPSEEK_API_KEY`，因此切到它也能查到余额（`GET /user/balance`，CNY）。

## 配置（`cordis.patch.yml` 中该行的 `config`）

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 关掉整行 |
| `adapters` | `auto` | `'auto'` 或适配器 id 数组（写死集合） |
| `timeoutMs` | `12000` | 单个 HTTP 请求超时 |
| `catalogTtlMs` | `21600000` | 价格目录缓存（6h） |
| `autoRefreshMinutes` | `0` | 后台预热间隔，0 = 关闭 |
| `scripts` | `{}` | host/glob → cc-switch usage_script |
| `priceOverrides` | `{}` | 模型 → 目录 id 或直给单价 |
| `providers` | `{}` | provider id → `{ baseURL, apiKeyEnv, accessToken, accessTokenEnv, userId, quotaPerUnit, adapters, skipModels }` |

## 演示（模拟数据）

下面这段是 `node tests/demo-openrouter.mjs` 的输出：以 OpenRouter 为例，用 fetch 桩喂进 `credits` / `key` / 价格目录 / 模型列表，跑**真实的报价管线**（适配器分派、目录解析、单价匹配、文本渲染都是真的），**余额与单价数字是编的**：

```
$ node tests/demo-openrouter.mjs
# 提供商询价  2026-10-10T03:41:55.634Z
当前使用：openrouter · anthropic/claude-sonnet-4.5
价格目录：https://openrouter.ai/api/v1/models（458 个模型）

## OpenRouter ★ 使用中
- baseURL: https://openrouter.ai/api
- 余额: 12.4 USD · 总额 25 USD，已用 12.6 USD · 账户有效 · 来源 GET /api/v1/credits
- 单价（USD / 1M tokens，2/2 个模型已定价）:
  - ★ anthropic/claude-sonnet-4.5: 入 $3 / 出 $15 / 缓存读 $0.3（USD / 1M tokens）  ←目录 anthropic/claude-sonnet-4.5
  - openai/gpt-5-mini: 入 $0.25 / 出 $2 / 缓存读 $0.025（USD / 1M tokens）  ←目录 openai/gpt-5-mini
```

在 DSH 里等价的取数方式（换成你自己的提供商会返回真实数字）：

```bash
curl -s "http://127.0.0.1:<DSH 端口>/api/provider-quote/summary"    # 加 ?refresh=1 跳过 30s 缓存
curl -s "http://127.0.0.1:<DSH 端口>/api/provider-quote/ping"       # 自检：版本、模块 URL、目录缓存模型数
```

```
$ curl -s "http://127.0.0.1:<DSH 端口>/api/provider-quote/ping"
{
  "ok":true,"version":"0.3.1","entry":"lib/host.js","catalogModels":458,
  "adapters":"auto","providers":["openrouter","deepseek-official"]
}
```

agent 侧则直接用工具：`provider_quote()` / `provider_quote({ models: true })` / `provider_quote({ provider: 'openrouter' })`。

## 自测

```bash
node tests/demo-openrouter.mjs  # 演示：fetch 桩喂 OpenRouter 数据跑真实报价管线（不联网、不需要 key）
node tests/smoke.mjs --offline  # 31 项：纯函数、询价目标解析与缓存逻辑、余额适配器（含 New API 访问令牌/占位值，全用 fetch 桩，不联网）—— 任何机器都能直接跑
node tests/client-smoke.mjs     # 15 项：客户端 bundle 的模块工厂 + 两个 slot 注册 + 面板渲染 + 余额胶囊（显示/点击刷新/失败态/跟随本会话选择/切换会话/刷新带会话）
```

联网的那一段（真实余额 / 模型列表 / 价格目录）**仓库里不含任何真实端点**，要自己用环境变量把目标传进去 —— 目标清单是你自己的，不会进版本库：

```bash
DSH_QUOTE_LIVE='[{"id":"openrouter","name":"OpenRouter","baseURL":"https://openrouter.ai/api",
                  "apiKeyEnv":"OPENROUTER_API_KEY","models":["deepseek/deepseek-chat"],
                  "expectBalance":true,"expectModels":true}]' \
DSH_CREDENTIALS=~/.dsh/.credentials.yaml node tests/smoke.mjs
```

每条目标支持 `usageScript`（cc-switch 脚本，按该 host 生效）、`priceOverrides`、`expectBalance` / `expectModels` / `expectFailure`；凭据只从 `DSH_CREDENTIALS`（默认 `~/.dsh/.credentials.yaml`）读取，从不打印明文，不设 `DSH_QUOTE_LIVE` 就跳过该段。

`lib/pricing.js` 不 import 任何 DSH 模块，所以适配器可以在 DSH 之外独立验证 —— 这也是上面脚本能直接跑的原因。

## 注意与已知边界

* **改宿主代码后必须重启 DSH**：loader 按「解析后的模块 URL」缓存模块，换文件名（新 URL）或 `plugin_manager set_bundle` 关/开可以在运行中切到新代码代，同一 URL 的旧模块实例换不掉。**客户端半（`client.js`）不受影响**：保存后 `set_bundle` 关/开即会在页面上重新挂载（无需重启）。
* 价格是 **OpenRouter 目录参考价**；中转站常有自己的倍率，差额需用 `priceOverrides` 校正。
* 部分网关（只转发不结算的那种）没有公开余额接口，面板会明确显示「额度没查到」并列出试过的接口，与 cc-switch 的表现一致。
* **New API 面板只认访问令牌**：`GET /api/user/self` 对 `sk-` API key 恒回 401（只接受 dashboard 会话或 PAT），所以「准确余额」必须显式配 `accessToken` / `accessTokenEnv`；不配也不会再显示九位数的假余额，而是如实报「已用 $X」。
* 面板不会写配置：`scripts` / `priceOverrides` / `providers` 目前手写在 `cordis.patch.yml` 的 config 里（改完重启 DSH 生效）。
* 插件只读不写：查询余额会带上你的 API key 去对应厂商自己的接口，插件不发往任何第三方；`client.js` 也只在本地渲染，不上报任何数据。

## 开源协议

[MIT](./LICENSE) © 2026 miku05231

你可以自由使用、修改、分发（保留版权与许可声明即可）。插件不自带任何依赖、不收集数据；查询余额时会把凭据发往**你自己配置的提供商端点**，这是该功能本身必需的。
