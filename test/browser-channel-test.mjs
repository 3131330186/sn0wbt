// browser 通道密闭测试（v0.8 · sn0wbot）
//
// 覆盖：
//   1. enabled=false：start 不发起连接（connectFn 不被调），状态如实 stopped
//   2. 注入假 CDP：start → started，navigate/readPage/click/fill/evaluate/tabs/screenshot 全链
//   3. 未连接时操控 → ChannelError(CHANNEL_OFFLINE)，经工具转成模型可读提示
//   4. registerBrowserTools：6 个工具注册；browser_read 正常返回；未启用时结构化错误
//   5. manager 集成：手动注册 + startAll 启动注入连接的 browser 通道
//
// 运行：node test/browser-channel-test.mjs
import assert from 'node:assert/strict';
import { createChecker } from './_harness.mjs';

const { BrowserChannel } = await import('../src/channels/browser/index.js');
const { ChannelError, CHANNEL_ERROR_CODES, CAPABILITIES } = await import('../src/channels/types.js');
const { ChannelManager } = await import('../src/channels/manager.js');
const { registerBrowserTools } = await import('../src/channels/browser/tools.js');

const { setRuntimeConfig } = await import('../src/config.js');
function makeChannel(options) {
  setRuntimeConfig({ channels: { browser: options.config } });
  return new BrowserChannel(options);
}
const localToolContext = {
  chatKey: 'private:web', localConsole: true, consoleApprovals: { request: async () => true }
};

const c = createChecker('browser 通道（CDP · 可注入连接）');

/** 假 CDP + 假页面：覆盖 BrowserChannel 用到的全部接口面。 */
function makeFakeCdp() {
  const ops = [];
  const state = { url: 'about:blank', title: '空白页', bodyText: '页面正文内容', evalResult: { n: 1 } };
  const page = {
    url: () => state.url,
    title: async () => state.title,
    goto: async (url) => { ops.push(['goto', url]); state.url = url; state.title = `标题:${url}`; },
    evaluate: async (fnOrStr) => {
      ops.push(['evaluate', typeof fnOrStr === 'string' ? 'str' : 'fn']);
      if (typeof fnOrStr === 'string') return state.evalResult;
      return state.bodyText;   // readPage 的 () => innerText 形态
    },
    click: async (selector) => { ops.push(['click', selector]); },
    fill: async (selector, text) => { ops.push(['fill', selector, text]); },
    screenshot: async () => Buffer.from('fake-png-bytes')
  };
  const context = { pages: () => [page], newPage: async () => page };
  return { cdp: { contexts: () => [context] }, ops, state, page };
}

// ── 1. 未启用 ───────────────────────────────────────────────────────────
await c.check('enabled=false：start 不发起连接，状态 stopped 且上报原因', async () => {
  let connectCalls = 0;
  const channel = makeChannel({
    config: { enabled: false },
    connectFn: async () => { connectCalls += 1; return {}; }
  });
  const reports = [];
  await channel.start({ reportStatus: (status) => reports.push(status) });
  assert.equal(connectCalls, 0, '未启用不应调用连接器');
  assert.equal(channel.status, 'stopped');
  assert.equal(reports[0].connected, false);
  assert.ok(reports[0].reason.includes('未启用'));
});

// ── 2. 注入假 CDP 全链 ──────────────────────────────────────────────────
await c.check('start 连接成功 → started；navigate/readPage/click/fill/evaluate/tabs/screenshot 全链可用', async () => {
  const fake = makeFakeCdp();
  const channel = makeChannel({
    config: { enabled: true, cdpUrl: 'http://127.0.0.1:9222', readLimit: 100 },
    connectFn: async () => fake.cdp
  });
  const reports = [];
  await channel.start({ reportStatus: (status) => reports.push(status) });
  assert.equal(channel.status, 'started');
  assert.equal(reports[0].connected, true);

  const nav = await channel.navigate('https://example.com/a');
  assert.equal(nav.url, 'https://example.com/a');
  assert.equal(nav.title, '标题:https://example.com/a');

  const read = await channel.readPage();
  assert.equal(read.title, '标题:https://example.com/a');
  assert.ok(read.text.startsWith('页面正文内容'));

  await channel.click('#btn');
  await channel.fill('#input', '你好');
  const evaluated = await channel.evaluate('1+1');
  assert.deepEqual(evaluated.result, { n: 1 });
  const tabs = await channel.listTabs();
  assert.equal(tabs.tabs.length, 1);
  const shot = await channel.screenshot();
  assert.ok(Buffer.isBuffer(shot.png));

  assert.deepEqual(fake.ops[0], ['goto', 'https://example.com/a']);
  assert.deepEqual(fake.ops.find((op) => op[0] === 'click'), ['click', '#btn']);
  assert.deepEqual(fake.ops.find((op) => op[0] === 'fill'), ['fill', '#input', '你好']);
});

// ── 3. 未连接时操控 ─────────────────────────────────────────────────────
await c.check('未连接操控 → ChannelError(CHANNEL_OFFLINE)，启用与否提示不同', async () => {
  const disabled = makeChannel({ config: { enabled: false } });
  await disabled.start({});
  await assert.rejects(() => disabled.readPage(), (error) => (
    error instanceof ChannelError
    && error.code === CHANNEL_ERROR_CODES.CHANNEL_OFFLINE
    && error.message.includes('未启用')
  ));

  const enabledButOffline = makeChannel({
    config: { enabled: true },
    connectFn: async () => { throw new Error('ECONNREFUSED'); }
  });
  await enabledButOffline.start({});
  assert.equal(enabledButOffline.status, 'error', '连接失败不向上抛，状态如实 error');
  await assert.rejects(() => enabledButOffline.navigate('https://x'), (error) => (
    error.code === CHANNEL_ERROR_CODES.CHANNEL_OFFLINE && error.message.includes('未连接')
  ));
});

// ── 4. 工具集 ───────────────────────────────────────────────────────────
await c.check('registerBrowserTools：注册 6 个工具，browser_read 正常返回内容', async () => {
  const fake = makeFakeCdp();
  const channel = makeChannel({
    config: { enabled: true, cdpUrl: 'http://127.0.0.1:9222' },
    connectFn: async () => fake.cdp
  });
  await channel.start({});
  const registered = registerBrowserTools({ getChannel: () => channel });
  assert.equal(registered, 6);
  // 直接从注册表取定义执行（模拟 orchestrator 调 executeTool 的路径）
  const { listTools } = await import('../src/tool-registry.js');
  const def = listTools().find((tool) => tool.id === 'browser_read');
  assert.ok(def, 'browser_read 应已注册');
  const result = await def.execute(localToolContext, {});
  assert.equal(result.isError, false);
  assert.ok(result.content.includes('页面正文内容'));
});

await c.check('工具层：未启用时 browser_navigate 返回结构化错误（不伪造成功）', async () => {
  const channel = makeChannel({ config: { enabled: false } });
  await channel.start({});
  registerBrowserTools({ getChannel: () => channel });
  const { listTools } = await import('../src/tool-registry.js');
  const def = listTools().find((tool) => tool.id === 'browser_navigate');
  const result = await def.execute(localToolContext, { url: 'https://example.com' });
  assert.equal(result.isError, true);
  assert.ok(result.content.includes('未启用'));
});

// ── 5. manager 集成 ─────────────────────────────────────────────────────
await c.check('manager 集成：browser 通道注册 → startAll → send 路由到通道自身方法', async () => {
  const fake = makeFakeCdp();
  const manager = new ChannelManager({ log: () => {} });
  manager.register(makeChannel({
    config: { enabled: true },
    connectFn: async () => fake.cdp
  }));
  await manager.startAll();
  assert.equal(manager.get('browser').status, 'started');
  // navigate 挂在通道自身 → manager.send"通道自身实现优先"路径生效
  const result = await manager.send('browser', 'navigate', 'https://example.com/mgr');
  assert.equal(result.url, 'https://example.com/mgr');
  // 未声明 message 能力：sendText 应被能力门控拒绝
  assert.throws(() => manager.send('browser', 'sendText', 't', '1', 'hi'), (error) => (
    error.code === CHANNEL_ERROR_CODES.CAPABILITY_MISSING
  ));
  assert.ok(manager.get('browser').capabilities.includes(CAPABILITIES.CONTROL));
  await manager.stopAll();
  assert.equal(manager.get('browser').status, 'stopped');
});

c.finish();
