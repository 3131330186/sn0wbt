// 通道框架密闭测试（v0.8 · sn0wbot）
//
// 覆盖：
//   1. register：合法注册 / 重复 id → CHANNEL_DUPLICATE / 结构不合法 → INVALID_CHANNEL
//   2. get：未知 id → CHANNEL_NOT_FOUND（结构化失败优于静默 null）
//   3. startAll：dispatchInbound / reportStatus 注入、状态迁移 stopped → started
//   4. 入站分发：channelId 自动打戳、多订阅者全收、非对象事件丢弃
//   5. 状态上报：{ channelId, status } 信封 + lastStatus 记录
//   6. send 路由：client 方法委托 / 能力门控 CAPABILITY_MISSING / 未知通道
//   7. stopAll：全部停止、状态 stopped
//   8. QQChannel：配置切片映射（wsUrl/httpUrl/token）、start 接线、autoConnect=false 不发起连接
//
// 运行：node test/channels-test.mjs
import assert from 'node:assert/strict';
import { createChecker } from './_harness.mjs';

const { ChannelManager, registerBuiltinChannels } = await import('../src/channels/manager.js');
const { ChannelError, CHANNEL_ERROR_CODES, CAPABILITIES, METHOD_CAPABILITY } = await import('../src/channels/types.js');
const { QQChannel } = await import('../src/channels/qq/index.js');
const { OneBotClient } = await import('../src/onebot.js');

const c = createChecker('通道框架（v0.8）');

/** 满足契约的最小假通道：记录收到的 ctx，出站方法挂在 client 上（同 OneBot 形态）。 */
function makeFakeChannel({ id = 'fake', capabilities = [CAPABILITIES.MESSAGE] } = {}) {
  const calls = { start: 0, stop: 0, inbound: [], status: [] };
  const channel = {
    id,
    label: `假通道-${id}`,
    capabilities,
    status: 'stopped',
    client: {
      sendText: (kind, target, text) => `sent:${kind}:${target}:${text}`
    },
    start(ctx) {
      calls.start += 1;
      calls.ctx = ctx;
      calls.inbound = ctx.dispatchInbound;      // 记下 manager 注入的分发函数
      calls.status = ctx.reportStatus;
      return Promise.resolve();
    },
    stop() { calls.stop += 1; return Promise.resolve(); },
    __calls: calls
  };
  return channel;
}

// ── 1. 注册 ─────────────────────────────────────────────────────────────
await c.check('register：合法通道注册成功且进入列表', () => {
  const m = new ChannelManager();
  const ch = makeFakeChannel();
  m.register(ch);
  const list = m.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'fake');
  assert.equal(list[0].status, 'stopped');
  assert.deepEqual(list[0].capabilities, [CAPABILITIES.MESSAGE]);
});

await c.check('register：重复 id → CHANNEL_DUPLICATE', () => {
  const m = new ChannelManager();
  m.register(makeFakeChannel());
  assert.throws(() => m.register(makeFakeChannel()), (error) => (
    error instanceof ChannelError && error.code === CHANNEL_ERROR_CODES.CHANNEL_DUPLICATE
  ));
});

await c.check('register：结构不合法 → INVALID_CHANNEL（缺 id/start 等）', () => {
  const m = new ChannelManager();
  assert.throws(() => m.register({ id: 'bad', label: '坏通道', capabilities: [], start: () => {} }), (error) => (
    error instanceof ChannelError && error.code === CHANNEL_ERROR_CODES.INVALID_CHANNEL
  ));
  assert.throws(() => m.register(null), (error) => error.code === CHANNEL_ERROR_CODES.INVALID_CHANNEL);
});

// ── 2. 取用 ─────────────────────────────────────────────────────────────
await c.check('get：未知 id → CHANNEL_NOT_FOUND', () => {
  const m = new ChannelManager();
  assert.throws(() => m.get('nope'), (error) => (
    error instanceof ChannelError && error.code === CHANNEL_ERROR_CODES.CHANNEL_NOT_FOUND
  ));
});

// ── 3. 启停与注入 ───────────────────────────────────────────────────────
await c.check('startAll：注入 dispatchInbound/reportStatus，状态迁移到 started', async () => {
  const m = new ChannelManager();
  const ch = makeFakeChannel();
  m.register(ch);
  await m.startAll();
  assert.equal(ch.__calls.start, 1);
  assert.equal(ch.status, 'started');
  assert.equal(typeof ch.__calls.ctx.dispatchInbound, 'function');
  assert.equal(typeof ch.__calls.ctx.reportStatus, 'function');
});

await c.check('stopAll：全部停止且状态回到 stopped', async () => {
  const m = new ChannelManager();
  const a = makeFakeChannel({ id: 'a' });
  const b = makeFakeChannel({ id: 'b' });
  m.register(a); m.register(b);
  await m.startAll();
  await m.stopAll();
  assert.equal(a.__calls.stop, 1);
  assert.equal(b.__calls.stop, 1);
  assert.equal(a.status, 'stopped');
  assert.equal(b.status, 'stopped');
});

// ── 3b. 单通道启停（接入向导：enable 后只动这一个，不惊动其他通道）────────
await c.check('startChannel：只启动目标通道，其余不受影响；未知 id 抛结构化错误', async () => {
  const m = new ChannelManager();
  const a = makeFakeChannel({ id: 'a' });
  const b = makeFakeChannel({ id: 'b' });
  m.register(a); m.register(b);
  await m.startChannel('b');
  assert.equal(b.__calls.start, 1);
  assert.equal(b.status, 'started');
  assert.equal(a.__calls.start, 0);          // a 完全没被动
  assert.equal(a.status, 'stopped');
  await assert.rejects(() => m.startChannel('ghost'),
    (e) => e instanceof ChannelError);
});

await c.check('stopChannel：只停目标通道；未注册 id 幂等返回', async () => {
  const m = new ChannelManager();
  const a = makeFakeChannel({ id: 'a' });
  const b = makeFakeChannel({ id: 'b' });
  m.register(a); m.register(b);
  await m.startAll();
  await m.stopChannel('a');
  assert.equal(a.__calls.stop, 1);
  assert.equal(a.status, 'stopped');
  assert.equal(b.__calls.stop, 0);           // b 没被停
  assert.equal(b.status, 'started');
  await m.stopChannel('ghost');              // 未注册 → 幂等，不抛
});

// ── 3c. 接入向导目录与表单转换 ─────────────────────────────────────────
const { CHANNEL_CATALOG, formValuesToChannelPatch, setByPath } = await import('../src/channels/catalog.js');

await c.check('目录：qq/browser/mail 都可建立链接（接入向导统一语义）', () => {
  const ids = CHANNEL_CATALOG.map((item) => item.id);
  assert.ok(ids.includes('browser') && ids.includes('mail'));
  // 2026-11-15 用户明确要求手动接入：qq 也走目录（默认 enabled=false，
  // 登录 QQ 不会被自动桥接），三通道语义一致
  assert.ok(ids.includes('qq'), 'qq 应出现在"可建立链接"目录');
  for (const item of CHANNEL_CATALOG) {
    assert.ok(item.label && item.desc && Array.isArray(item.form), `${item.id} 目录项不完整`);
    for (const f of item.form) assert.ok(f.path && f.label, `${item.id} 表单字段缺 path/label`);
  }
});

await c.check('formValuesToChannelPatch：dot-path 打平 + 空值跳过 + 白名单伪字段拆数组', () => {
  const patch = formValuesToChannelPatch({
    'imap.host': 'imap.qq.com',
    'imap.port': '993',
    'smtp.host': '',
    allowedFromText: ' boss@corp.com , ^team@ , '
  });
  assert.deepEqual(patch, {
    imap: { host: 'imap.qq.com', port: '993' },
    allowedFrom: ['boss@corp.com', '^team@']
  });
});

await c.check('setByPath：嵌套已有对象不覆盖兄弟键', () => {
  const o = { imap: { user: 'u' } };
  setByPath(o, 'imap.host', 'h');
  assert.deepEqual(o, { imap: { user: 'u', host: 'h' } });
});

await c.check('原型污染防护：__proto__/constructor/prototype 路径一律拒绝', () => {
  const o = {};
  setByPath(o, '__proto__.polluted', 'x');
  assert.equal({}.polluted, undefined, 'setByPath 不得写穿原型链');
  setByPath(o, 'constructor.prototype.p2', 'y');
  assert.equal({}.p2, undefined, 'constructor 路径同样拒绝');
});

// ── 4. 入站分发 ─────────────────────────────────────────────────────────
await c.check('入站分发：channelId 自动打戳 + 多订阅者全收', async () => {
  const m = new ChannelManager();
  const ch = makeFakeChannel({ id: 'fake' });
  m.register(ch);
  const seen = [];
  const off1 = m.onInbound((record) => seen.push(['s1', record.channelId]));
  m.onInbound((record) => seen.push(['s2', record.channelId]));
  await m.startAll();
  ch.__calls.inbound({ text: 'hello' });
  off1();
  ch.__calls.inbound({ text: 'second' });
  assert.deepEqual(seen, [['s1', 'fake'], ['s2', 'fake'], ['s2', 'fake']]);
});

await c.check('入站分发：非对象事件被丢弃，不污染下游', async () => {
  const m = new ChannelManager();
  const ch = makeFakeChannel();
  m.register(ch);
  let count = 0;
  m.onInbound(() => { count += 1; });
  await m.startAll();
  ch.__calls.inbound(null);
  ch.__calls.inbound('字符串事件');
  assert.equal(count, 0);
});

// ── 5. 状态上报 ─────────────────────────────────────────────────────────
await c.check('状态上报：{channelId,status} 信封 + lastStatus 记录', async () => {
  const m = new ChannelManager();
  const ch = makeFakeChannel();
  m.register(ch);
  const events = [];
  m.onStatus((st) => events.push(st));
  await m.startAll();
  ch.__calls.status({ connected: true, everConnected: true, error: '' });
  ch.__calls.status(true);   // 非 object 也接受：归一化为 { connected: true }
  assert.equal(events[0].channelId, 'fake');
  assert.deepEqual(events[0].status, { connected: true, everConnected: true, error: '' });
  assert.deepEqual(events[1].status, { connected: true });
  assert.equal(ch.lastStatus.connected, true);
});

// ── 6. 出站路由 ─────────────────────────────────────────────────────────
await c.check('send：路由到 client 方法并原样返回结果', async () => {
  const m = new ChannelManager();
  m.register(makeFakeChannel());
  const result = m.send('fake', 'sendText', 'group', '123', '你好');
  assert.equal(result, 'sent:group:123:你好');
});

await c.check('send：未声明能力 → CAPABILITY_MISSING（结构化失败）', () => {
  const m = new ChannelManager();
  // 假通道只有 message 能力：sendPoke 需要 poke 能力 → 拒绝
  m.register(makeFakeChannel({ capabilities: [CAPABILITIES.MESSAGE] }));
  assert.throws(() => m.send('fake', 'sendPoke', 'group', '123', 'u1'), (error) => (
    error instanceof ChannelError && error.code === CHANNEL_ERROR_CODES.CAPABILITY_MISSING
  ));
});

await c.check('send：未知通道 / 未实现动作 → 结构化错误', () => {
  const m = new ChannelManager();
  assert.throws(() => m.send('ghost', 'sendText', 'g', '1', 'x'), (error) => error.code === CHANNEL_ERROR_CODES.CHANNEL_NOT_FOUND);
  m.register(makeFakeChannel({ id: 'partial', capabilities: [CAPABILITIES.MESSAGE] }));
  // client 上没有该方法 → CAPABILITY_MISSING（不许静默伪造成功）
  assert.throws(() => m.send('partial', 'sendVoice', 'g', '1'), (error) => (
    error.code === CHANNEL_ERROR_CODES.CAPABILITY_MISSING
  ));
});

await c.check('METHOD_CAPABILITY：sendText/message 与 sendPoke/poke 的映射完整', () => {
  assert.equal(METHOD_CAPABILITY.sendText, CAPABILITIES.MESSAGE);
  assert.equal(METHOD_CAPABILITY.sendPoke, CAPABILITIES.POKE);
});

// ── 7. QQ 通道本体 ──────────────────────────────────────────────────────
await c.check('QQChannel：配置切片映射到 OneBotClient（wsUrl/httpUrl/token）', () => {
  const ch = new QQChannel({
    config: { backend: 'napcat', wsUrl: 'ws://127.0.0.1:39999', httpUrl: 'http://127.0.0.1:39998/', accessToken: 'tok-ws', httpAccessToken: 'tok-http' }
  });
  assert.equal(ch.id, 'qq');
  assert.ok(ch.capabilities.includes(CAPABILITIES.VERIFIED_SENDER));
  assert.ok(ch.client instanceof OneBotClient, "napcat 后端 = OneBotClient");
  assert.equal(ch.client.wsUrl, 'ws://127.0.0.1:39999');
  assert.equal(ch.client.httpUrl, 'http://127.0.0.1:39998');   // 尾斜杠被剥离
  assert.equal(ch.client.accessToken, 'tok-ws');
  assert.equal(ch.client.httpToken, 'tok-http');
});

await c.check('QQChannel：autoConnect=false 时 start 不发起连接，事件经 manager 分发', async () => {
  const m = new ChannelManager({ log: () => {} });
  m.register(new QQChannel({ config: { backend: 'napcat', wsUrl: 'ws://127.0.0.1:39999' } }));
  const seen = [];
  m.onInbound((record) => seen.push(record));
  await m.startAll({ autoConnect: false });   // 不连真实/不存在端口，纯密闭
  const qq = m.get('qq');
  assert.equal(qq.status, 'started');
  // 模拟协议端事件到达：通道 → manager 分发 → 订阅者，并自动打上 qq 来源戳
  qq.client.onEvent({ post_type: 'message', message_id: 1, text: 'x' });
  qq.client.onEvent({ post_type: 'message', text: 'hello' });
  assert.equal(seen.length, 2);
  assert.equal(seen[0].channelId, 'qq');
  assert.equal(seen[1].channelId, 'qq');
});

await c.check('registerBuiltinChannels：默认注册 qq 通道（uia 后端），snowluma 切片并入 napcat 模式', async () => {
  const m = new ChannelManager({ log: () => {} });
  registerBuiltinChannels(m, { config: { snowluma: { wsUrl: 'ws://127.0.0.1:39997' }, channels: { qq: { backend: 'napcat', uiaWsPort: 17399 } } } });
  const qq = m.get('qq');
  assert.equal(qq.backend, 'napcat');
  assert.equal(qq.client.wsUrl, 'ws://127.0.0.1:39997');
  const m2 = new ChannelManager({ log: () => {} });
  registerBuiltinChannels(m2, { config: { channels: { qq: { backend: 'uia' } } } });
  const { OneBotReverseServer } = await import('../src/channels/qq/reverse_server.js');
  assert.ok(m2.get('qq').client instanceof OneBotReverseServer);
});

c.finish();
