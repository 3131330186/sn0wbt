// 远程监听（server.listenHost=0.0.0.0 + token）安全矩阵测试。
//
// bootApp 起一个真实监听 0.0.0.0、配置了令牌的实例，用原生 http 请求伪造
// Host/Origin 头，验证 app.js 的防线与口径：
//   1. 本机（回环 Host）免令牌 —— 开关远程/设令牌永远不影响本机（浏览器/桌面端）
//   2. 远程（IP 字面量 Host）必须带令牌，错令牌 401
//   3. **域名 Host → 403**（DNS rebinding 的载体是域名，防线不因远程而拆）
//   4. IP Host + 跨源 Origin → 403
//   5. 热开关：保存设置即时重绑（关→403 / 开→200），本机全程无感知，无需重启
// 并验证远程场景下网页对话全链路可用（远程发消息 → 机器人回复落存档）。
//
// 运行：node test/webchat-remote-test.mjs（bootApp 每进程只能一次，与
// webchat-test.mjs 分文件）
import assert from 'node:assert/strict';
import { bootApp, createChecker, freePort, waitFor } from './_harness.mjs';

const c = createChecker('远程监听（0.0.0.0 + token）安全矩阵');

const TOKEN = 'remotetest-token-1';
const ctx = await bootApp({
  config: {
    // 浅合并会整体替换 server 对象 —— 端口必须自带
    server: { port: await freePort(), token: TOKEN, listenHost: '0.0.0.0' }
  },
  script: [{ toolCalls: [{ name: 'send_message', args: { messages: ['远程回复测试内容'] } }] }]
});
const { rawRequest, app, teardown, port, waitSessionDone } = ctx;
const H = (host) => ({ host });
const AUTH = { 'x-console-token': TOKEN };

await c.check('无令牌（回环 Host）→ 200：本机永远免令牌，开关远程/设令牌都不影响本机', async () => {
  const r = await rawRequest('GET', '/api/status', H(`127.0.0.1:${port}`));
  assert.equal(r.status, 200, `${r.status} ${r.text}`);
});

await c.check('无令牌 + IP 字面量 Host → 401（远程必须带令牌）', async () => {
  const r = await rawRequest('GET', '/api/status', H(`192.0.2.55:${port}`));
  assert.equal(r.status, 401, `${r.status} ${r.text}`);
});

await c.check('错误令牌 + IP 字面量 Host → 401（不是 403，鉴权在来源校验之前）', async () => {
  const r = await rawRequest('GET', '/api/status', { ...H(`192.0.2.55:${port}`), 'x-console-token': 'wrong-token-999' });
  assert.equal(r.status, 401);
});

await c.check('回环 Host + 令牌 → 200（本机控制台照常）', async () => {
  const r = await rawRequest('GET', '/api/status', { ...H(`127.0.0.1:${port}`), ...AUTH });
  assert.equal(r.status, 200, `${r.status} ${r.text}`);
});

await c.check('IP 字面量 Host + 令牌 → 200（局域网直连放行）', async () => {
  const r = await rawRequest('GET', '/api/status', { ...H(`192.0.2.55:${port}`), ...AUTH });
  assert.equal(r.status, 200, `${r.status} ${r.text}`);
});

await c.check('IP Host + 同源 Origin → 200', async () => {
  const r = await rawRequest('GET', '/api/status', {
    ...H(`192.0.2.55:${port}`), ...AUTH, origin: `http://192.0.2.55:${port}`
  });
  assert.equal(r.status, 200, `${r.status} ${r.text}`);
});

await c.check('域名 Host → 403（DNS rebinding 防线：远程也不放行域名）', async () => {
  const r = await rawRequest('GET', '/api/status', { ...H(`evil.example.com:${port}`), ...AUTH });
  assert.equal(r.status, 403, `${r.status} ${r.text}`);
});

await c.check('IP Host + 跨源 Origin → 403', async () => {
  const r = await rawRequest('GET', '/api/status', {
    ...H(`192.0.2.55:${port}`), ...AUTH, origin: `http://evil.example.com:${port}`
  });
  assert.equal(r.status, 403, `${r.status} ${r.text}`);
});

await c.check('域名 Host + 跨源 Origin → 403（双重不合法仍稳定拒绝）', async () => {
  const r = await rawRequest('GET', '/api/status', {
    ...H(`evil.example.com:${port}`), ...AUTH, origin: `http://evil.example.com:${port}`
  });
  assert.equal(r.status, 403, `${r.status} ${r.text}`);
});

await c.check('?token= 查询参数同样被认（EventSource 无法带头的退路）', async () => {
  const r = await rawRequest('GET', `/api/status?token=${encodeURIComponent(TOKEN)}`, H(`192.0.2.55:${port}`));
  assert.equal(r.status, 200, `${r.status} ${r.text}`);
});

await c.check('远程场景网页对话全链路：发消息 → 回复落存档', async () => {
  const { request } = ctx;
  // 令牌已生效：request() 默认不带令牌头，必须显式带（等于"远程浏览器已带 token"）
  const r = await request('POST', '/api/webchat/send', {
    body: { text: '远程测试你好' },
    headers: { 'x-console-token': TOKEN }
  });
  assert.equal(r.status, 200, `${r.status} ${r.text}`);
  const session = await waitSessionDone('远程测试你好');
  assert.equal(session.status, 'done', `远程会话应正常完成，实际 ${session.status}`);
  const msgs = await request('GET', '/api/webchat/messages', { headers: { 'x-console-token': TOKEN } });
  assert.ok(msgs.data.messages.some((m) => m.self && m.text === '远程回复测试内容'), '远程触发的回复应落存档');
  assert.equal(app.onebot.connected, true);
});

// ── 热开关：保存设置即时重绑，无需重启；本机全程无感知 ────────────────────
// （重绑在响应后 100ms 执行，断言用轮询等待切换落地，不赌时序）
await c.check('热关闭远程：保存即生效，IP Host 变 403、本机照常 200', async () => {
  const { request } = ctx;
  // 本机发出（不带令牌头）——本机免令牌：即使令牌已配置，本机也永远能改设置
  const r = await request('POST', '/api/config', { body: { server: { listenHost: '127.0.0.1' } } });
  assert.equal(r.status, 200, `${r.status} ${r.text}`);
  assert.equal(r.data.listen?.remote, false, `应报远程将关：${JSON.stringify(r.data.listen)}`);
  await waitFor(async () => {
    const hit = await rawRequest('GET', '/api/status', { ...H(`192.0.2.55:${port}`), ...AUTH });
    return hit.status === 403 ? true : null;
  }, 5000, 'IP Host 变 403（远程已关）');
  const localHit = await rawRequest('GET', '/api/status', H(`127.0.0.1:${port}`));
  assert.equal(localHit.status, 200, '本机（无令牌）应照常 200');
});

await c.check('热开启远程：不用重启，IP Host + 令牌恢复 200', async () => {
  const { request } = ctx;
  const r = await request('POST', '/api/config', { body: { server: { listenHost: '0.0.0.0' } } });
  assert.equal(r.status, 200, `${r.status} ${r.text}`);
  assert.equal(r.data.listen?.remote, true, `应报远程将开：${JSON.stringify(r.data.listen)}`);
  await waitFor(async () => {
    const hit = await rawRequest('GET', '/api/status', { ...H(`192.0.2.55:${port}`), ...AUTH });
    return hit.status === 200 ? true : null;
  }, 5000, 'IP Host 恢复 200（远程已开）');
  const localHit = await rawRequest('GET', '/api/status', H(`127.0.0.1:${port}`));
  assert.equal(localHit.status, 200, '开关往返后本机仍照常');
});

await teardown();
c.finish();
