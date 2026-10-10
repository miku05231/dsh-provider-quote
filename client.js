/**
 * provider-quote — Client half.
 *
 * 两个挂载点：
 *   1) conversation.composer.dock —— 对话输入框下方的常驻胶囊：只显示「当前会话选中的提供商」的余额，
 *      点一下立即重新询价；跟随模型选择器切换提供商（无需重新询价，报价里含所有提供商）。
 *   2) settings.models.footer —— 「设置 → 模型」页底部的完整询价面板。
 *
 * 数据来自宿主路由 GET /api/provider-quote/summary（同源相对路径，?refresh=1 强制重查）。
 * 只 require('react')；样式只用主题 token（带浅色兜底）。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-provider-quote',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useEffect, useState } = React;

    const SUMMARY_URL = '/api/provider-quote/summary';

    const color = {
      primary: 'var(--dsw-alias-label-primary, #1f2329)',
      secondary: 'var(--dsw-alias-label-secondary, #646a73)',
      dimmed: 'var(--dsw-alias-label-dimmed, #8f959e)',
      brand: 'var(--dsw-alias-brand-primary, #4d6bfe)',
      warn: 'var(--dsw-alias-state-warn-label, #d97706)',
      ok: 'var(--dsw-alias-state-success-label, #22a06b)',
      borderL1: 'var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.08))',
      borderL2: 'var(--dsw-alias-border-l2, rgba(0, 0, 0, 0.14))',
      layer1: 'var(--dsw-alias-bg-layer-1, #ffffff)',
      layer2: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.02))',
      layer3: 'var(--dsw-alias-bg-layer-3, rgba(0, 0, 0, 0.04))',
    };

    const number = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : undefined);

    function money(value, unit) {
      const amount = number(value);
      if (amount === undefined) return '—';
      const text = Math.abs(amount) >= 1 ? amount.toFixed(4) : amount.toFixed(6);
      return `${text.replace(/0+$/, '').replace(/\.$/, '')}${unit ? ` ${unit}` : ''}`;
    }

    function priceText(price) {
      if (price === null || price === undefined) return undefined;
      const parts = [];
      if (number(price.input) !== undefined) parts.push(`入 $${price.input}`);
      if (number(price.output) !== undefined) parts.push(`出 $${price.output}`);
      if (number(price.cacheRead) !== undefined) parts.push(`缓存读 $${price.cacheRead}`);
      if (number(price.cacheWrite) !== undefined) parts.push(`缓存写 $${price.cacheWrite}`);
      return parts.length === 0 ? undefined : parts.join(' · ');
    }

    function timeText(iso) {
      if (typeof iso !== 'string') return '';
      return iso.replace('T', ' ').replace(/\.\d+Z$/, ' UTC').slice(0, 23);
    }

    /** Balance badge for one provider. */
    function balanceView(balance) {
      if (balance === null || balance === undefined) {
        return { text: '未查询', detail: '', warn: false, dim: true };
      }
      if (balance.ok !== true) {
        const tried = Array.isArray(balance.attempts) ? balance.attempts.length : 0;
        return { text: '额度没查到', detail: `${balance.reason ?? '未知原因'}${tried > 0 ? `（试了 ${tried} 个接口）` : ''}`, warn: true, dim: false };
      }
      const detail = balance.detail ?? {};
      const notes = [];
      if (number(detail.total) !== undefined && number(detail.usage) !== undefined) {
        notes.push(`总额 ${money(detail.total, balance.unit)} / 已用 ${money(detail.usage, balance.unit)}`);
      }
      if (detail.note !== undefined) notes.push(String(detail.note));
      if (balance.isValid === false) {
        return { text: money(balance.remaining, balance.unit), detail: `${notes.join('；') || '账户已不可用'}`, warn: true, dim: false };
      }
      notes.push(`来源 ${balance.source ?? '未知接口'}`);
      return { text: money(balance.remaining, balance.unit), detail: notes.join('；'), warn: false, dim: false };
    }

    function activeModelOf(provider) {
      const models = Array.isArray(provider.models) ? provider.models : [];
      return models.find((model) => model.active === true);
    }

    function priceLine(provider) {
      const models = Array.isArray(provider.models) ? provider.models : [];
      const model = activeModelOf(provider)
        ?? models.find((row) => row.price !== null)
        ?? models[0];
      if (model === undefined) return undefined;
      const text = priceText(model.price);
      if (text === undefined) {
        const hints = Array.isArray(model.suggestions) ? model.suggestions : [];
        const suffix = hints.length > 0 ? `（候选：${hints.slice(0, 2).join('、')}）` : '';
        return { model: model.id, text: `目录中未匹配到价格${suffix}` };
      }
      return { model: model.id, text };
    }

    const catalogNote = (catalog) => {
      if (catalog === null || catalog === undefined) return '余额按 baseURL 自动匹配接口';
      const stale = catalog.stale === true ? ' · 沿用缓存' : '';
      const bad = catalog.ok === false ? ` · 不可用（${catalog.error ?? ''}）` : '';
      return `价格目录 OpenRouter · ${catalog.modelCount ?? 0} 个模型${stale}${bad}`;
    };

    /* ------------------------------------------------------------------ *
     * 共享取数：底部胶囊与设置页面板共用一份数据，避免重复请求
     * ------------------------------------------------------------------ */

    const store = {
      data: null,
      error: null,
      busy: false,
      fetchedAt: 0,
      inflight: null,
      listeners: new Set(),
    };

    function notify() {
      for (const listener of [...store.listeners]) listener();
    }

    function loadQuote(refresh) {
      if (refresh !== true && store.inflight !== null) return store.inflight;
      store.busy = true;
      notify();
      const url = refresh === true ? `${SUMMARY_URL}?refresh=1` : SUMMARY_URL;
      const task = fetch(url, { headers: { accept: 'application/json' } })
        .then((response) => (response.ok ? response.json() : Promise.reject(new Error(`HTTP ${response.status}`))))
        .then((data) => {
          store.data = data;
          store.error = null;
          store.fetchedAt = Date.now();
        })
        .catch((error) => {
          store.error = String(error?.message ?? error);
        })
        .then(() => {
          store.busy = false;
          store.inflight = null;
          notify();
        });
      store.inflight = task;
      return task;
    }

    function useQuote() {
      const [, force] = useState(0);
      useEffect(() => {
        const listener = () => force((value) => value + 1);
        store.listeners.add(listener);
        if (store.data === null && store.inflight === null && store.busy === false) loadQuote(false);
        return () => {
          store.listeners.delete(listener);
        };
      }, []);
      return store;
    }

    /** 每 5 分钟静默刷新一次（宿主侧另有 30 秒缓存）。 */
    function useAutoRefresh() {
      useEffect(() => {
        const timer = globalThis.setInterval?.(() => loadQuote(false), 300000);
        timer?.unref?.();
        return () => {
          globalThis.clearInterval?.(timer);
        };
      }, []);
    }

    /* ------------------------------------------------------------------ *
     * 设置页面板（settings.models.footer）
     * ------------------------------------------------------------------ */

    function ProviderRow(props) {
      const { provider, muted } = props;
      const balance = balanceView(provider.balance);
      const price = priceLine(provider);
      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: '10px 12px',
          borderRadius: 10,
          border: `1px solid ${provider.active ? color.brand : color.borderL1}`,
          background: provider.active ? color.layer2 : 'transparent',
          opacity: muted ? 0.75 : 1,
        },
      }, [
        h('div', { key: 'head', style: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' } }, [
          h('span', { key: 'name', style: { color: color.primary, fontWeight: 600, fontSize: 13 } }, provider.name ?? provider.id),
          provider.active === true
            ? h('span', { key: 'active', style: { color: color.brand, fontSize: 12 } }, '★ 使用中')
            : h('span', { key: 'id', style: { color: color.dimmed, fontSize: 11 } }, provider.id),
          h('span', { key: 'spacer', style: { flex: 1 } }),
          h('span', { key: 'balance', style: { color: balance.warn ? color.warn : color.primary, fontSize: 13, fontVariantNumeric: 'tabular-nums' } }, balance.text),
          h('span', { key: 'unit', style: { color: color.dimmed, fontSize: 11 } }, '余额'),
        ]),
        h('div', { key: 'base', style: { color: color.dimmed, fontSize: 11, wordBreak: 'break-all' } }, provider.baseURL ?? 'baseURL 未知（未在配置里发现，可在插件 config.providers 里补）'),
        balance.detail !== ''
          ? h('div', { key: 'detail', style: { color: balance.warn ? color.warn : color.secondary, fontSize: 11 } }, balance.detail)
          : null,
        price !== undefined
          ? h('div', { key: 'price', style: { color: color.secondary, fontSize: 12 } }, `${price.model}：${price.text}`)
          : null,
        provider.modelCount > 0
          ? h('div', { key: 'count', style: { color: color.dimmed, fontSize: 11 } }, `模型 ${provider.modelCount} 个 · 单价单位为 USD / 1M tokens`)
          : null,
      ]);
    }

    function RefreshButton(props) {
      const { busy, onClick } = props;
      return h('button', {
        type: 'button',
        onClick,
        disabled: busy,
        style: {
          padding: '4px 12px',
          borderRadius: 8,
          border: `1px solid ${color.borderL2}`,
          background: color.layer3,
          color: color.primary,
          fontSize: 12,
          cursor: busy ? 'default' : 'pointer',
        },
      }, busy ? '查询中…' : '刷新询价');
    }

    function ProviderQuotePanel() {
      const state = useQuote();
      const data = state.data;
      const providers = Array.isArray(data?.providers) ? data.providers : [];
      const activeProvider = providers.find((provider) => provider.active === true);
      const others = providers.filter((provider) => provider !== activeProvider);
      const catalog = data?.catalog;
      const loading = data === null && state.error === null;

      const children = [];
      children.push(h('div', { key: 'head', style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' } }, [
        h('span', { key: 'title', style: { color: color.primary, fontSize: 14, fontWeight: 600 } }, '提供商询价'),
        h('span', { key: 'sub', style: { color: color.dimmed, fontSize: 11 } }, catalogNote(catalog)),
        h('span', { key: 'spacer', style: { flex: 1 } }),
        h(RefreshButton, { key: 'refresh', busy: state.busy, onClick: () => loadQuote(true) }),
      ]));

      if (loading) {
        children.push(h('div', { key: 'loading', style: { color: color.secondary, fontSize: 12, padding: '8px 0' } }, '正在查询余额与单价…'));
      } else if (data === null) {
        children.push(h('div', { key: 'error', style: { color: color.warn, fontSize: 12, padding: '8px 0' } },
          `询价面板取数失败：${state.error ?? '未知错误'}（宿主路由 ${SUMMARY_URL} 不可达）`));
      } else if (providers.length === 0) {
        children.push(h('div', { key: 'empty', style: { color: color.secondary, fontSize: 12, padding: '8px 0' } },
          '没有发现任何提供商配置。请在插件配置的 providers 里填写 baseURL（例如 my-relay: { baseURL: https://relay.example.com/v1, apiKeyEnv: MY_RELAY_API_KEY }）。'));
      } else {
        if (activeProvider !== undefined) children.push(h(ProviderRow, { key: 'active', provider: activeProvider }));
        for (const provider of others) children.push(h(ProviderRow, { key: provider.id, provider, muted: true }));
        const stamp = timeText(data?.generatedAt);
        if (stamp !== '') {
          children.push(h('div', { key: 'stamp', style: { color: color.dimmed, fontSize: 11 } }, `数据时间 ${stamp} · 余额来自厂商接口，单价为目录参考价`));
        }
      }
      if (state.error !== null && data !== null) {
        children.push(h('div', { key: 'warn', style: { color: color.warn, fontSize: 11 } }, `最近一次刷新失败：${state.error}`));
      }

      return h('div', {
        style: {
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          marginTop: 12,
          padding: 12,
          borderRadius: 12,
          border: `1px solid ${color.borderL1}`,
          background: color.layer2,
        },
      }, children);
    }

    /* ------------------------------------------------------------------ *
     * 对话输入框下方的余额胶囊（conversation.composer.dock）
     *   只显示「当前会话选中的提供商」的余额，点一下重新询价；各提供商与
     *   模型单价的详细视图在「设置 → 模型」页底部的面板里。
     *   选中项取自官方 modelDirectories 服务（取不到时退化为 host 的 active 标记）。
     * ------------------------------------------------------------------ */

    /** 官方模型目录服务（形状探测，与服务是否安装解耦；缺失时本插件照常工作）。 */
    let modelDirectories;

    function asModelDirectories(value) {
      if (value === null || typeof value !== 'object') return undefined;
      return typeof value.directoryFor === 'function' ? value : undefined;
    }

    const directories = new Map();

    function directoryStore(sessionId) {
      if (modelDirectories === undefined || typeof sessionId !== 'string' || sessionId === '') return undefined;
      if (directories.has(sessionId)) return directories.get(sessionId);
      let store;
      try {
        store = modelDirectories.directoryFor(sessionId)?.store;
      } catch {
        store = undefined;
      }
      directories.set(sessionId, store);
      return store;
    }

    function readSelectedProvider(store) {
      if (store === undefined) return null;
      try {
        const snapshot = typeof store.getSnapshot === 'function' ? store.getSnapshot() : undefined;
        const provider = snapshot?.pending?.provider ?? snapshot?.current?.provider;
        return typeof provider === 'string' && provider !== '' ? provider : null;
      } catch {
        return null;
      }
    }

    /** 跟随本会话的模型选择：目录一变就重渲染；报价本身含所有提供商的余额，故无需重新询价。 */
    function useSelectedProvider(store) {
      const [selected, setSelected] = useState(() => readSelectedProvider(store));
      useEffect(() => {
        if (store === undefined || typeof store.subscribe !== 'function') return undefined;
        const sync = () => {
          setSelected(readSelectedProvider(store));
        };
        sync();
        try {
          const off = store.subscribe(sync);
          return typeof off === 'function' ? off : undefined;
        } catch {
          return undefined;
        }
      }, [store]);
      return selected;
    }

    function ProviderQuoteDock(props) {
      const state = useQuote();
      useAutoRefresh();

      const selectedId = useSelectedProvider(directoryStore(props?.sessionId));
      const providers = Array.isArray(state.data?.providers) ? state.data.providers : [];
      const active = selectedId === null
        ? providers.find((provider) => provider.active === true) ?? providers[0]
        : providers.find((provider) => provider.id === selectedId);
      const missing = selectedId !== null && state.data !== null && active === undefined;

      useEffect(() => {
        // 更换到的提供商还没进报价（例如刚写进配置）→ 立刻重查一次
        if (missing) void loadQuote(true);
      }, [missing, selectedId]);

      const view = balanceView(active?.balance);
      const loading = state.data === null && state.error === null;
      const failed = state.data === null && state.error !== null;
      const dot = failed || (state.data !== null && view.warn)
        ? color.warn
        : state.data === null || active === undefined
          ? color.dimmed
          : color.ok;

      const unavailable = active !== undefined && view.dim !== true && active.balance?.ok !== true;
      const text = failed || unavailable
        ? '余额没查到'
        : loading
          ? '余额查询中…'
          : active === undefined || view.dim === true
            ? '余额未知'
            : `余额 ${view.text}`;

      const title = failed
        ? `询价失败：${state.error ?? ''}（点击重试）`
        : loading
          ? '正在查询余额…'
          : active === undefined
            ? providers.length === 0
              ? '没有发现已配置的提供商'
              : `${selectedId ?? '当前提供商'} 不在询价列表（未配置 baseURL 或未纳入报价）· 点击刷新`
            : [
              `${active.id} 余额 ${view.text}`,
              view.detail === '' ? null : view.detail,
              '点击刷新',
            ].filter(Boolean).join(' · ');

      return h('button', {
        type: 'button',
        onClick: () => {
          void loadQuote(true);
        },
        title,
        'data-provider-quote-pill': '1',
        style: {
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 10px',
          borderRadius: 999,
          border: `1px solid ${color.borderL1}`,
          background: 'transparent',
          color: color.secondary,
          fontSize: 12,
          lineHeight: '18px',
          cursor: 'pointer',
          whiteSpace: 'nowrap',
        },
      }, [
        h('span', { key: 'dot', style: { width: 7, height: 7, borderRadius: '50%', background: dot, flex: '0 0 auto' } }),
        h('span', {
          key: 'main',
          style: { color: view.warn && state.data !== null ? color.warn : color.primary, fontVariantNumeric: 'tabular-nums' },
        }, text),
      ]);
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        // 可选服务：Cordis 会把 inject 里缺失的服务整条 fiber 挂起，故只能用 ctx.get 探测
        modelDirectories = asModelDirectories(typeof ctx.get === 'function' ? ctx.get('modelDirectories') : undefined);
        directories.clear();
        ctx.slots.inject('conversation.composer.dock', () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'provider-quote-dock',
          order: 20,
        }, ProviderQuoteDock));
        ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
          name: 'settings.models.footer',
          id: 'provider-quote',
          order: 20,
        }, ProviderQuotePanel));
      },
    };
  },
});
