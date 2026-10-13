/**
 * client-smoke — 客户端半的离线冒烟测试。
 *
 * 目标：不装进 DSH 也能验证 client.js 的几件事
 *   1) 通过 window.__ModuleLoader__.load 注册，且只 require('react')（不碰任何 @deepseek-ai/* 包）
 *   2) 把胶囊注册到 slot `conversation.composer.dock`、面板注册到 `settings.models.footer`
 *   3) 面板能渲染：加载态 → 从 /api/provider-quote/summary 取数 → 呈现余额/单价；也覆盖错误态与刷新
 *   4) 底部胶囊：收起态余额 → 点击展开浮层 → 点提供商行展开模型单价 → 刷新走 ?refresh=1 → 再点收起
 *
 * 用一个迷你 React（createElement + useState/useEffect/useCallback/useRef）驱动组件。
 * 注意：迷你 React 的 useEffect 只在挂载时跑一次（不按 deps 重跑），所以
 * 「点击外部 / ESC 关闭」在真实 React 里生效，这里不做断言。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`      ${error && error.message ? error.message : error}`);
  }
}

/* ------------------------------------------------------------------ *
 * 迷你 React
 * ------------------------------------------------------------------ */

function createRuntime() {
  const values = [];
  let dirty = false;
  let index = 0;
  const useState = (initial) => {
    const slot = `s${index++}`;
    if (!(slot in values)) values[slot] = typeof initial === 'function' ? initial() : initial;
    const set = (next) => {
      const value = typeof next === 'function' ? next(values[slot]) : next;
      if (value !== values[slot]) {
        values[slot] = value;
        dirty = true;
      }
    };
    return [values[slot], set];
  };
  const sameDeps = (a, b) => {
    if (a === undefined || b === undefined) return true;
    if (a.length !== b.length) return false;
    return a.every((value, index) => Object.is(value, b[index]));
  };
  /** 依赖数组与 React 同语义：[] 只跑一次，[x] 变了才重跑，省略 deps 也按只跑一次处理。 */
  const useEffect = (fn, deps) => {
    const slot = `e${index++}`;
    const previous = values[slot];
    if (previous !== undefined && sameDeps(previous.deps, deps)) return;
    if (typeof previous?.cleanup === 'function') previous.cleanup();
    values[slot] = { deps, cleanup: fn() };
  };
  const useCallback = (fn) => {
    index += 1;
    return fn;
  };
  const useRef = (initial) => {
    const slot = `r${index++}`;
    if (!(slot in values)) values[slot] = { current: initial };
    return values[slot];
  };
  const createElement = (type, props, ...children) => {
    const flat = [];
    for (const child of children) {
      if (Array.isArray(child)) flat.push(...child);
      else if (child !== null && child !== undefined && child !== false) flat.push(child);
    }
    return { type, props: { ...(props ?? {}), ...(flat.length === 1 ? { children: flat[0] } : flat.length > 0 ? { children: flat } : {}) } };
  };
  return {
    React: { createElement, useState, useEffect, useCallback, useRef },
    beginRender() {
      index = 0;
      dirty = false;
    },
    get dirty() {
      return dirty;
    },
  };
}

/** 深度遍历元素树，收集所有字符串文本。 */
function textsOf(node, out = []) {
  if (node === null || node === undefined || node === false) return out;
  if (typeof node === 'string' || typeof node === 'number') {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) textsOf(child, out);
    return out;
  }
  if (typeof node.type === 'function') {
    textsOf(node.type(node.props ?? {}), out);
    return out;
  }
  if (node.props !== undefined) textsOf(node.props.children, out);
  return out;
}

/** 在树里找第一个 type === 目标组件名的元素。 */
function findElement(node, name) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findElement(child, name);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (typeof node.type === 'function' && node.type.name === name) return node;
  if (node.props !== undefined) return findElement(node.props.children, name);
  return undefined;
}

/** 收集所有带指定 prop 的元素（宿主元素用，例如 data-provider-quote-pill）。 */
function findByProps(node, key, value, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const child of node) findByProps(child, key, value, out);
    return out;
  }
  if (node.props !== undefined) {
    if (node.props[key] !== undefined && (value === undefined || node.props[key] === value)) out.push(node);
    findByProps(node.props.children, key, value, out);
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 装载 client.js
 * ------------------------------------------------------------------ */

const source = readFileSync(join(root, 'client.js'), 'utf8');
const runtime = createRuntime();
let definition;

globalThis.window = {
  __ModuleLoader__: {
    load(spec) {
      definition = spec;
    },
  },
};

// 客户端组件在打开浮层时会挂 document 级监听（点击外部 / ESC 关闭）；测试里给个空壳。
globalThis.document = {
  addEventListener() {},
  removeEventListener() {},
};

// 执行 client.js：它是浏览器风格的 script，靠 window.__ModuleLoader__ 注册。
// eslint-disable-next-line no-new-func
new Function('window', `${source}\n`)(globalThis.window);

/**
 * 每个用例挂载一份全新的插件实例：迷你 React 的 hook 状态是按运行时实例存的，
 * 复用同一个 runtime 会让第二次渲染跳过 useEffect（拿不到新的 fetch）。
 */
function mount(options = {}) {
  const localRuntime = createRuntime();
  const required = [];
  const requireStub = (name) => {
    required.push(name);
    if (name === 'react') return localRuntime.React;
    throw new Error(`client.js 不该 require "${name}"（只允许 react）`);
  };
  const plugin = definition.factory(requireStub);
  const registered = [];
  plugin.apply({
    // 可选服务的形状探测：只有 modelDirectories 存在时才返回对象
    get(name) {
      return name === 'modelDirectories' ? options.modelDirectories : undefined;
    },
    slots: {
      inject(ownerKey, callback) {
        registered.push({ ownerKey });
        callback();
      },
      register(target, component) {
        registered.push({ target, component });
      },
    },
  });
  const host = registered.find((entry) => entry.target?.name === 'settings.models.footer');
  const dock = registered.find((entry) => entry.target?.name === 'conversation.composer.dock');
  return { Panel: host.component, Dock: dock.component, runtime: localRuntime, required, registered };
}

/** 假模型目录：只实现胶囊用到的 store.getSnapshot / store.subscribe。 */
function fakeDirectory(provider, model = 'deepseek-flash') {
  const listeners = new Set();
  const current = { provider, model, reasoningEffort: 'max' };
  const store = {
    getSnapshot: () => ({ current, groups: [], status: 'ready', pending: null, error: null }),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
  return {
    directories: { directoryFor: () => ({ store }) },
    switchTo(next) {
      current.provider = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

const SUMMARY = {
  generatedAt: '2026-10-20T09:30:00.000Z',
  active: { provider: 'relay-a', model: 'deepseek-flash' },
  catalog: { ok: true, source: 'https://openrouter.ai/api/v1/models', fetchedAt: Date.now(), modelCount: 458 },
  providers: [
    {
      id: 'relay-a',
      name: 'Relay A',
      baseURL: 'https://relay-a.example.com',
      host: 'relay-a.example.com',
      apiKeyEnv: 'RELAY_A_API_KEY',
      hasApiKey: true,
      active: true,
      balance: { ok: true, remaining: 53.21, unit: 'USD', isValid: true, source: 'script https://relay-a.example.com/user/balance', adapter: 'script:relay-a.example.com', attempts: [] },
      modelCount: 2,
      models: [
        { id: 'deepseek-flash', price: { input: 0.32, output: 0.89 }, matchedId: 'deepseek/deepseek-chat', matchedBy: 'override', active: true },
        { id: 'deepseek-v4-pro', price: { input: 0.2088, output: 0.4176, cacheRead: 0.0174 }, matchedBy: 'slug', active: false },
      ],
    },
    {
      id: 'relay-b',
      name: 'Relay B',
      baseURL: 'https://relay-b.example.com/v1',
      host: 'relay-b.example.com',
      apiKeyEnv: 'RELAY_B_API_KEY',
      hasApiKey: true,
      active: false,
      balance: { ok: false, reason: '所有余额适配器均未命中', attempts: [{ url: 'https://relay-b.example.com/user/balance', status: 404 }], adapter: null },
      modelCount: 10,
      models: [{ id: 'glm-5.3', price: { input: 0.039, output: 4.8 }, matchedBy: 'id', active: false }],
    },
    {
      id: 'unmatched',
      name: '未定价供应商',
      baseURL: 'https://unpriced.example/v1',
      host: 'unpriced.example',
      hasApiKey: true,
      active: false,
      balance: { ok: false, reason: '所有余额适配器均未命中', attempts: [], adapter: null },
      modelCount: 1,
      models: [{ id: 'deepseek-flash', price: null, suggestions: ['deepseek/deepseek-v4-flash', 'deepseek/deepseek-v4.1-flash'], active: false }],
    },
    {
      id: 'relay-c',
      name: 'Relay C',
      baseURL: 'https://relay-c.example.com',
      host: 'relay-c.example.com',
      apiKeyEnv: 'RELAY_C_API_KEY',
      hasApiKey: true,
      active: false,
      balance: { ok: true, remaining: 12.5, unit: 'CNY', isValid: true, source: 'GET /user/balance', adapter: 'relay-user-balance', attempts: [] },
      modelCount: 1,
      models: [{ id: 'deepseek-v4-flash', price: { input: 0.018, output: 1.28 }, matchedBy: 'bare-id', active: false }],
    },
  ],
};

async function main() {
  console.log('client-smoke');

  await test('通过 __ModuleLoader__ 注册为 @local/dsh-provider-quote', () => {
    assert.ok(definition !== undefined, 'window.__ModuleLoader__.load 未被调用');
    assert.equal(definition.id, '@local/dsh-provider-quote');
    assert.equal(typeof definition.factory, 'function');
  });

  await test('只 require("react")', () => {
    const { required } = mount();
    assert.deepEqual([...new Set(required)], ['react']);
  });

  await test('插件声明 inject: ["slots"] 并把胶囊/面板注册到两个 slot', () => {
    const first = definition.factory((name) => {
      if (name === 'react') return runtime.React;
      throw new Error(`unexpected require ${name}`);
    });
    assert.deepEqual(first.inject, ['slots']);
    const { registered } = mount();
    const injections = registered.filter((entry) => entry.ownerKey !== undefined).map((entry) => entry.ownerKey);
    assert.deepEqual(injections, ['conversation.composer.dock', 'settings.models.footer'], 'slot owner 键不对');

    const dock = registered.find((entry) => entry.target?.name === 'conversation.composer.dock');
    assert.equal(dock?.target?.id, 'provider-quote-dock');
    assert.equal(dock?.target?.order, 20);
    assert.equal(typeof dock?.component, 'function');

    const panel = registered.find((entry) => entry.target?.name === 'settings.models.footer');
    assert.equal(panel?.target?.id, 'provider-quote');
    assert.equal(panel?.target?.order, 20);
    assert.equal(typeof panel?.component, 'function');
  });

  await test('加载态 → 取数成功后呈现余额与单价', async () => {
    const { Panel, runtime } = mount();

    const calls = [];
    globalThis.fetch = async (url, options) => {
      calls.push({ url, options });
      return { ok: true, status: 200, json: async () => SUMMARY };
    };

    runtime.beginRender();
    let tree = Panel({});
    let texts = textsOf(tree).join(' | ');
    assert.match(texts, /提供商询价/, '标题缺失');
    assert.match(texts, /正在查询余额与单价/, '首次渲染应为加载态');

    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls.length, 1, '面板应只请求一次');
    assert.equal(calls[0].url, '/api/provider-quote/summary', '必须用同源相对路径');
    assert.equal(calls[0].options.headers.accept, 'application/json');
    assert.equal(runtime.dirty, true, '取数成功后应标记重渲染');

    runtime.beginRender();
    tree = Panel({});
    texts = textsOf(tree).join(' | ');
    assert.match(texts, /Relay A/, '活动提供商名缺失');
    assert.match(texts, /53\.21 USD/, '余额缺失');
    assert.match(texts, /deepseek-flash：入 \$0\.32 · 出 \$0\.89/, '单价行缺失');
    assert.match(texts, /额度没查到/, '失败提供商应显示「额度没查到」');
    assert.match(texts, /试了 1 个接口/, '失败原因应带上探测次数');
    assert.match(texts, /458 个模型/, '目录模型数缺失');
    assert.match(texts, /目录中未匹配到价格（候选：deepseek\/deepseek-v4-flash/, '未定价模型应给出目录候选');
    assert.match(texts, /数据时间 2026-10-20 09:30:00 UTC/, '时间戳缺失');
    assert.ok(findElement(tree, 'RefreshButton') !== undefined, '刷新按钮缺失');
    assert.ok(!texts.includes('正在查询余额与单价'), '取数后不应还是加载态');
  });

  await test('点击刷新走 ?refresh=1', async () => {
    const { Panel, runtime } = mount();

    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => SUMMARY };
    };

    runtime.beginRender();
    Panel({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.beginRender();
    const button = findElement(Panel({}), 'RefreshButton');
    const element = button.type(button.props);
    element.props.onClick();
    assert.equal(calls.length, 2, '点击后应再请求一次');
    assert.equal(calls[1], '/api/provider-quote/summary?refresh=1');
  });

  await test('路由不可达时给出可读错误，而不是崩掉', async () => {
    const { Panel, runtime } = mount();

    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
    runtime.beginRender();
    Panel({});
    await new Promise((resolve) => setTimeout(resolve, 0));
    runtime.beginRender();
    const texts = textsOf(Panel({})).join(' | ');
    assert.match(texts, /询价面板取数失败：HTTP 500/, '错误提示缺失');
    assert.match(texts, /\/api\/provider-quote\/summary/, '错误提示应点明宿主路由');
  });

  await test('底部胶囊：只显示当前提供商的余额', async () => {
    const { Dock, runtime } = mount();
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => SUMMARY });

    runtime.beginRender();
    let tree = Dock({});
    assert.match(textsOf(tree).join(' | '), /余额查询中…/, '首次渲染应为查询中');

    await tick();
    runtime.beginRender();
    tree = Dock({});
    const texts = textsOf(tree).join(' | ');
    assert.match(texts, /余额 53\.21 USD/, '余额缺失');
    assert.equal(texts.includes('入 $0.32'), false, '胶囊不该再显示单价');
    assert.equal(texts.includes('relay-a'), false, '胶囊不该再显示提供商名');
    assert.equal(findByProps(tree, 'data-provider-quote-pill').length, 1, '胶囊元素缺失');
    assert.equal(findByProps(tree, 'data-provider-quote-popover').length, 0, '不该再渲染浮层');

    const pill = findByProps(tree, 'data-provider-quote-pill')[0];
    assert.match(
      String(pill.props.title),
      /relay-a 余额 53\.21 USD · 全局默认（本会话未选过模型） · 来源 script https:\/\/relay-a\.example\.com\/user\/balance · 点击刷新/,
      '悬停详情应带上提供商、来源与「点击刷新」',
    );
  });

  await test('底部胶囊：点一下重新询价（?refresh=1），不展开任何东西', async () => {
    const { Dock, runtime } = mount();
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => SUMMARY };
    };

    runtime.beginRender();
    Dock({});
    await tick();
    runtime.beginRender();
    const tree = Dock({});
    findByProps(tree, 'data-provider-quote-pill')[0].props.onClick({});
    await tick();

    assert.equal(calls.length, 2, '点击应再请求一次');
    assert.equal(calls[1], '/api/provider-quote/summary?refresh=1', '点击应跳过宿主缓存');
    runtime.beginRender();
    const texts = textsOf(Dock({})).join(' | ');
    assert.equal(texts.includes('刷新询价'), false, '胶囊不该展开浮层');
    assert.equal(texts.includes('提供商询价'), false, '胶囊不该展开浮层');
  });

  await test('底部胶囊：路由不可达时显示「余额没查到」，原因放在 title', async () => {
    const { Dock, runtime } = mount();
    globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });

    runtime.beginRender();
    Dock({});
    await tick();
    runtime.beginRender();
    const tree = Dock({});
    const texts = textsOf(tree).join(' | ');
    assert.match(texts, /余额没查到/, '失败态文案缺失');
    assert.equal(texts.includes('HTTP 500'), false, '失败原因不该挤进胶囊');

    const pill = findByProps(tree, 'data-provider-quote-pill')[0];
    assert.match(String(pill.props.title), /询价失败：HTTP 500（点击重试）/, '悬停详情应带上失败原因');
  });

  await test('底部胶囊：跟随会话选中的提供商（换选择即换余额，且不重新询价）', async () => {
    const directory = fakeDirectory('relay-c');
    const { Dock, runtime } = mount({ modelDirectories: directory.directories });
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => SUMMARY };
    };

    runtime.beginRender();
    Dock({ sessionId: 'session-switch' });
    await tick();
    runtime.beginRender();
    let tree = Dock({ sessionId: 'session-switch' });
    assert.match(textsOf(tree).join(' | '), /余额 12\.5 CNY/, '应显示选中提供商的余额');
    assert.match(
      String(findByProps(tree, 'data-provider-quote-pill')[0].props.title),
      /^relay-c 余额 12\.5 CNY/,
      'title 应以选中的提供商开头',
    );
    assert.equal(calls.length, 1, '报价里已含所有提供商，切换不该再请求');

    directory.switchTo('relay-a');
    assert.equal(runtime.dirty, true, '目录变化应触发重渲染');
    runtime.beginRender();
    tree = Dock({ sessionId: 'session-switch' });
    assert.match(textsOf(tree).join(' | '), /余额 53\.21 USD/, '换回后应显示新选中的余额');
    assert.equal(calls.length, 1, '跟随选择仍然只查一次');
  });

  await test('底部胶囊：选中的提供商不在报价里 → 提示未知并自动重查一次', async () => {
    const directory = fakeDirectory('brand-new');
    const { Dock, runtime } = mount({ modelDirectories: directory.directories });
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => SUMMARY };
    };

    runtime.beginRender();
    Dock({ sessionId: 'session-unknown' });
    await tick();
    runtime.beginRender();
    Dock({ sessionId: 'session-unknown' });
    await tick();
    assert.equal(calls.length, 2, '未收录的提供商应触发一次重查');
    assert.equal(
      calls[1],
      '/api/provider-quote/summary?refresh=1&scope=session&sessionId=session-unknown&provider=brand-new&model=deepseek-flash',
      '重查应跳过宿主缓存，并带上本会话的选择',
    );

    runtime.beginRender();
    const tree = Dock({ sessionId: 'session-unknown' });
    assert.match(textsOf(tree).join(' | '), /余额未知/, '未收录时应提示未知');
    assert.match(
      String(findByProps(tree, 'data-provider-quote-pill')[0].props.title),
      /brand-new 不在询价列表/,
      'title 应说明为什么查不到',
    );

    await tick();
    runtime.beginRender();
    Dock({ sessionId: 'session-unknown' });
    assert.equal(calls.length, 2, '重查仍无结果时不该反复请求');
  });

  await test('底部胶囊：本会话投影优先于全局默认（别的会话改选择也不受影响）', async () => {
    const { Dock, runtime } = mount();
    // 官方投影 modelSelection：取值口径 next ?? lastUsed，另一会话选了 next=relay-a 也白搭
    const picked = {
      next: { provider: 'relay-c', model: 'deepseek-flash' },
      lastUsed: { provider: 'relay-a', model: 'deepseek-chat' },
    };
    const useProjection = (key) => (key === 'modelSelection' ? picked : undefined);
    globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => SUMMARY });

    runtime.beginRender();
    Dock({ sessionId: 'session-proj', useProjection });
    await tick();
    runtime.beginRender();
    const tree = Dock({ sessionId: 'session-proj', useProjection });
    assert.match(textsOf(tree).join(' | '), /余额 12\.5 CNY/, '应按本会话的选择（next）显示余额');
    assert.match(
      String(findByProps(tree, 'data-provider-quote-pill')[0].props.title),
      /^relay-c 余额 12\.5 CNY · 本会话选择/,
      'title 应点明来源是本会话选择',
    );
  });

  await test('底部胶囊：点击刷新带上本会话（scope=session + sessionId + provider）', async () => {
    const { Dock, runtime } = mount();
    const picked = { next: { provider: 'relay-c', model: 'deepseek-flash' }, lastUsed: null };
    const useProjection = (key) => (key === 'modelSelection' ? picked : undefined);
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => SUMMARY };
    };

    runtime.beginRender();
    Dock({ sessionId: 'session-refresh', useProjection });
    await tick();
    runtime.beginRender();
    findByProps(Dock({ sessionId: 'session-refresh', useProjection }), 'data-provider-quote-pill')[0].props.onClick({});
    await tick();

    assert.equal(calls.length, 2, '点击应再请求一次');
    assert.equal(
      calls[1],
      '/api/provider-quote/summary?refresh=1&scope=session&sessionId=session-refresh&provider=relay-c&model=deepseek-flash',
      '刷新必须把本会话的选择带给宿主',
    );
  });

  await test('底部胶囊：会话没选过模型 → 按全局默认询价并如实标注', async () => {
    const { Dock, runtime } = mount();
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => SUMMARY };
    };

    runtime.beginRender();
    Dock({ sessionId: 'session-fresh' });
    await tick();
    runtime.beginRender();
    const tree = Dock({ sessionId: 'session-fresh' });
    assert.match(textsOf(tree).join(' | '), /余额 53\.21 USD/, '应按宿主报价的全局默认提供商显示');
    assert.match(
      String(findByProps(tree, 'data-provider-quote-pill')[0].props.title),
      /全局默认（本会话未选过模型）/,
      'title 应说明来源是全局默认',
    );

    findByProps(tree, 'data-provider-quote-pill')[0].props.onClick({});
    await tick();
    assert.equal(
      calls[1],
      '/api/provider-quote/summary?refresh=1&scope=default&sessionId=session-fresh',
      '没选过模型时也要告诉宿主是哪个会话在问',
    );
  });

  await test('底部胶囊：同一窗口切换会话 → 显示跟随新会话，刷新也按新会话', async () => {
    const { Dock, runtime } = mount();
    let picked = { next: { provider: 'relay-c', model: 'deepseek-flash' }, lastUsed: null };
    const useProjection = (key) => (key === 'modelSelection' ? picked : undefined);
    const calls = [];
    globalThis.fetch = async (url) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => SUMMARY };
    };

    runtime.beginRender();
    Dock({ sessionId: 'session-a', useProjection });
    await tick();
    runtime.beginRender();
    assert.match(textsOf(Dock({ sessionId: 'session-a', useProjection })).join(' | '), /余额 12\.5 CNY/);

    picked = { next: { provider: 'relay-a', model: 'deepseek-chat' }, lastUsed: null };
    runtime.beginRender();
    const tree = Dock({ sessionId: 'session-b', useProjection });
    assert.match(textsOf(tree).join(' | '), /余额 53\.21 USD/, '切换会话后应显示新会话选中的提供商');
    assert.match(
      String(findByProps(tree, 'data-provider-quote-pill')[0].props.title),
      /^relay-a 余额 53\.21 USD · 本会话选择/,
      'title 应跟着新会话走',
    );
    assert.equal(calls.length, 1, '报价里已含所有提供商，切换会话不该再请求');

    findByProps(tree, 'data-provider-quote-pill')[0].props.onClick({});
    await tick();
    assert.equal(
      calls[1],
      '/api/provider-quote/summary?refresh=1&scope=session&sessionId=session-b&provider=relay-a&model=deepseek-chat',
      '切换会话后的刷新应按新会话的选择询价',
    );
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exitCode = 1;
}

await main();
