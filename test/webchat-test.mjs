// 网页对话（private:web）密闭测试 —— mock OneBot/LLM + 真实全链路。
//
// 覆盖：
//   1. 发送 → agent 私聊管道（appendIncoming + onIncoming）→ 会话运行 →
//      机器人回复经 sender web 分支落存档 —— 全程 **不经 OneBot**（QQ 零副作用）
//   2. GET /api/webchat/messages、/api/webchat/status、/api/chats 显示名
//   3. 清空（复用 /api/chats/private_web/clear，正则已扩展到 web）
//   4. 非 web 会话（真实 QQ 私聊）不受影响 —— web 分支只认 `:web` 后缀
//   5. 非文本发送降级：sendVoice/sendSticker 在网页会话落文字占位、不碰协议端
//   6. 重启持久：private_web.json 被 listChats 的 (group|private)_(\d+|web) 认回
//   7. 远程监听配置闸：开 0.0.0.0 无令牌 → 400；带令牌 → 200（收尾还原）
//
// 运行：node test/webchat-test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { bootApp, createChecker, waitFor, sleep } from './_harness.mjs';

const c = createChecker('网页对话（private:web）');

const ctx = await bootApp({
  // 模型必须用 send_message 工具发言（纯 content 是"不发言"的正常选项）——
  // 与 coverage-e2e 同款口径
  script: [{ toolCalls: [{ name: 'send_message', args: { messages: ['网页回复测试内容'] } }] }]
});
const { request, app, onebotHttp, waitSessionDone, teardown } = ctx;

// ── 1) 发送 → 管道 → 回复落存档 ─────────────────────────────────────────
await c.check('POST /api/webchat/send：消息入库并触发唤醒', async () => {
  const r = await request('POST', '/api/webchat/send', { body: { text: '网页测试你好' } });
  assert.equal(r.status, 200, `状态码：${r.status} ${r.text}`);
  assert.equal(r.data.ok, true);
  assert.ok(r.data.entry?.id > 0, '应返回入库条目');
  const msgs = await request('GET', '/api/webchat/messages');
  const mine = msgs.data.messages.find((m) => m.senderId === 'web' && m.text === '网页测试你好');
  assert.ok(mine, '发送的消息应在存档里（senderId=web）');
  assert.equal(mine.self, false, '网页用户消息不是机器人自言');
});

// mock sends 条目形状：{ action, body: { message: [segments] }, at } —— 文本在 message 段里
const sendTexts = () => (onebotHttp.state.sends || [])
  .flatMap((s) => (Array.isArray(s.body?.message) ? s.body.message : []))
  .filter((seg) => seg?.type === 'text')
  .map((seg) => String(seg?.data?.text || ''));

await c.check('全管道回复：机器人回复落存档，且全程不经 OneBot', async () => {
  await waitSessionDone('网页测试你好');
  const msgs = await request('GET', '/api/webchat/messages');
  const reply = msgs.data.messages.find((m) => m.self && m.text === '网页回复测试内容');
  assert.ok(reply, '脚本回复应经 sender web 分支落存档（self=true）');
  assert.equal(app.onebot.connected, true, 'OneBot 连接本身正常（排除假阴性）');
  assert.ok(!sendTexts().some((t) => t.includes('网页回复测试内容')),
    '网页回复绝不能发到 QQ（mock OneBot 不应收到 send_private_msg）');
});

await c.check('GET /api/webchat/status：形状正确', async () => {
  const r = await request('GET', '/api/webchat/status');
  assert.equal(r.status, 200);
  assert.equal(r.data.chatKey, 'private:web');
  assert.equal(typeof r.data.running, 'boolean');
  assert.equal(typeof r.data.paused, 'boolean');
  assert.equal(r.data.model, 'test-model-a');
});

await c.check('GET /api/chats：private:web 有显示名「网页对话」', async () => {
  const r = await request('GET', '/api/chats');
  const wc = r.data.chats.find((x) => x.key === 'private:web');
  assert.ok(wc, 'private:web 应出现在存档列表');
  assert.equal(wc.chatName, '网页对话');
});

await c.check('空消息 / 超长消息 → 400 可读报错', async () => {
  const empty = await request('POST', '/api/webchat/send', { body: { text: '   ' } });
  assert.equal(empty.status, 400);
  const long = await request('POST', '/api/webchat/send', { body: { text: 'x'.repeat(8001) } });
  assert.equal(long.status, 400);
});

// ── 2) 非 web 会话不受影响 ───────────────────────────────────────────────
await c.check('真实 QQ 私聊（private:777）仍走 OneBot：web 分支不误伤', async () => {
  const r = await request('POST', '/api/chats/private_777/test-send', { body: { text: '真实私聊测试' } });
  assert.equal(r.status, 200, `白名单含 777，应发送成功：${r.status} ${r.text}`);
  assert.ok(sendTexts().some((t) => t.includes('真实私聊测试')), 'QQ 私聊应真实发出 1 条');
});

// ── 3) 非文本发送降级（sender web 分支，直接驱动 app.sender）─────────────
await c.check('sendVoice/sendSticker 在网页会话落文字占位、不碰协议端', async () => {
  const before = (onebotHttp.state.calls || []).length;
  const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(500, 1)]);
  await app.sender.sendVoice('private:web', { wav, note: '讲笑话' });
  await app.sender.sendSticker('private:web', { id: 's1', desc: '微笑猫' });
  const msgs = (await request('GET', '/api/webchat/messages')).data.messages;
  assert.ok(msgs.some((m) => m.self && m.text === '[语音]讲笑话'), '语音应降级为文字占位');
  assert.ok(msgs.some((m) => m.self && m.text === '[表情包:微笑猫]'), '表情应降级为文字占位');
  assert.equal((onebotHttp.state.calls || []).length, before, '降级路径不应产生任何 OneBot 调用');
});

await c.check('真实 QQ 私聊 sendVoice 仍走协议端（降级不外溢）', async () => {
  let hit = false;
  const original = app.onebot.sendSegments;
  app.onebot.sendSegments = async (...a) => { hit = true; return original.apply(app.onebot, a); };
  try {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(500, 1)]);
    await app.sender.sendVoice('private:777', { wav, note: '真声道' });
  } catch { /* 协议端 mock 对 record 段的反应不关心，只看它被调了 */ }
  finally { app.onebot.sendSegments = original; }
  assert.equal(hit, true, 'QQ 私聊语音应真实调 OneBot sendSegments');
});

// ── 4) 重启持久 + 清空 ───────────────────────────────────────────────────
await c.check('清空 private:web 存档（正则扩展到 web）', async () => {
  const r = await request('POST', '/api/chats/private_web/clear', { body: '{}' });
  assert.equal(r.status, 200, `${r.status} ${r.text}`);
  assert.ok(r.data.removed > 0, `应清掉若干条，实际 ${r.data.removed}`);
  const msgs = (await request('GET', '/api/webchat/messages')).data.messages;
  assert.equal(msgs.length, 0, '清空后消息应为 0');
});

await c.check('重启持久：新 ChatStore 从磁盘认回 private_web.json', async () => {
  // 重新来一条（清空过了），flush 后用新 store 实例模拟重启。
  // ⚠️ 存档落盘走 500ms 防抖 —— 会话结束不代表已写盘，先等磁盘文件到位再读。
  await request('POST', '/api/webchat/send', { body: { text: '重启前的最后一条' } });
  await waitFor(async () => {
    const s = app.sessions.listSummaries(10).find((x) => (x.trigger || '').includes('重启前'));
    return s && s.status !== 'running' && s.status !== 'waiting';
  });
  const { DATA_DIR } = await import('../src/config.js');
  const file = path.join(DATA_DIR, 'messages', 'private_web.json');
  await waitFor(() => fs.readFileSync(file, 'utf8').includes('重启前的最后一条'), 5000, '存档落盘');
  const { ChatStore } = await import('../src/store.js');
  const fresh = new ChatStore();
  try {
    const keys = fresh.listChats();
    assert.ok(keys.includes('private:web'), `listChats 应认回 private:web（正则含 web），实际 ${keys.join(',')}`);
    assert.ok(fresh.recent('private:web', { limit: 5 }).some((m) => m.text === '重启前的最后一条'), '重启后消息应还在');
  } finally { fresh.flushAll(); }
});

// ── 5) 远程监听配置闸（放最后：成功路径会把 token 写进配置，影响后续请求）──
await c.check('开 0.0.0.0 无令牌 → 400（先拦下，不让裸奔配置落盘）', async () => {
  const r = await request('POST', '/api/config', { body: { server: { listenHost: '0.0.0.0' } } });
  assert.equal(r.status, 400, `${r.status} ${r.text}`);
  assert.ok(/令牌/.test(r.data.error || ''), `报错应提到令牌：${r.data.error}`);
  assert.equal(app.getConfig().server.listenHost, '127.0.0.1', '配置未被改写');
});

await c.check('带有效令牌 → 200（并热切到远程再切回，全程无需重启）', async () => {
  const r = await request('POST', '/api/config', { body: { server: { listenHost: '0.0.0.0', token: 'goodtoken123' } } });
  assert.equal(r.status, 200, `${r.status} ${r.text}`);
  assert.equal(r.data.config.server.hasToken, true, '脱敏视图应带 hasToken 标记');
  assert.equal(r.data.config.server.token, undefined, '脱敏视图绝不能回传明文令牌');
  assert.equal(r.data.listen?.remote, true, '保存即热切：应报远程已开');
  assert.equal(r.data.config.server.listenHost, '0.0.0.0');
  // 还原：回环 + 清空令牌（本机免令牌，还原请求不需要带头；patch 同时带 token 让闸门放行回环）
  const back = await request('POST', '/api/config', { body: { server: { listenHost: '127.0.0.1', token: '' } } });
  assert.equal(back.status, 200, `还原失败：${back.status} ${back.text}`);
  assert.equal(back.data.listen?.remote, false, '应报远程已关');
  assert.equal(app.getConfig().server.listenHost, '127.0.0.1');
  assert.equal(String(app.getConfig().server.token || ''), '', '令牌应被清空');
  await sleep(50);
});

await teardown();
c.finish();
