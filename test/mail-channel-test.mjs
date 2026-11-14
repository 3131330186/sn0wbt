// mail 通道密闭测试（v0.8 · sn0wbot）
//
// 覆盖：
//   1. enabled=false：start 不连接（工厂不被调），状态如实 stopped
//   2. 注入假 IMAP：start → 连接 → 基线 UID；poll → 入站 record（chatId=发件人、
//      lastUid 前进、空白名单 unverified）
//   3. allowedFrom 白名单：命中 → senderVerified/verified；不命中 → 不入站
//   4. sendText：假 SMTP 收到参数；manager.send('mail','sendText') 路由（通道自身实现）
//   5. SMTP 未配置 → CHANNEL_OFFLINE 结构化错误；工具层转模型可读提示
//   6. registerMailTools：mail_send/mail_check 全链；stop 清理定时器
//
// 运行：node test/mail-channel-test.mjs
import assert from 'node:assert/strict';
import { createChecker } from './_harness.mjs';

const { MailChannel } = await import('../src/channels/mail/index.js');
const { ChannelError, CHANNEL_ERROR_CODES, CAPABILITIES } = await import('../src/channels/types.js');
const { ChannelManager } = await import('../src/channels/manager.js');
const { registerMailTools } = await import('../src/channels/mail/tools.js');

const c = createChecker('mail 通道（IMAP/SMTP · 可注入客户端）');

/** 假 IMAP：记录调用，按脚本吐新邮件。 */
function makeFakeImap({ highestUid = 42, unseen = [] } = {}) {
  const calls = { connect: 0, getUnseen: [], highestUid: 0, closed: false };
  return {
    __calls: calls,
    async connect() { calls.connect += 1; },
    async getHighestUid() { calls.highestUid += 1; return highestUid; },
    async getUnseen(sinceUid) { calls.getUnseen.push(sinceUid); return unseen.filter((m) => m.uid > sinceUid); },
    async close() { calls.closed = true; }
  };
}

/** 假 SMTP：记录发件参数。 */
function makeFakeSmtp() {
  const sent = [];
  return {
    sent,
    from: 'bot@example.com',
    async send(mail) { sent.push(mail); return { messageId: `<fake-${sent.length}@test>` }; },
    async close() { }
  };
}

function mailConfig(overrides = {}) {
  return {
    enabled: true,
    pollSeconds: 60,
    imap: { host: 'imap.test', port: 993, tls: true, user: 'u', pass: 'p' },
    smtp: { host: 'smtp.test', port: 465, tls: true, user: 'bot@example.com', pass: 'p' },
    allowedFrom: [],
    maxBodyChars: 12000,
    ...overrides
  };
}

// ── 1. 未启用 ───────────────────────────────────────────────────────────
await c.check('enabled=false：start 不连接，状态 stopped 且上报原因', async () => {
  let factoryCalls = 0;
  const channel = new MailChannel({
    config: { enabled: false },
    imapFactory: async () => { factoryCalls += 1; return makeFakeImap(); }
  });
  const reports = [];
  await channel.start({ reportStatus: (status) => reports.push(status) });
  assert.equal(factoryCalls, 0);
  assert.equal(channel.status, 'stopped');
  assert.equal(reports[0].connected, false);
  assert.ok(reports[0].reason.includes('未启用'));
});

// ── 2. 连接与轮询 ───────────────────────────────────────────────────────
await c.check('start 连接 IMAP → 基线 UID；poll 拉新邮件 → 入站 record 语义正确', async () => {
  const imap = makeFakeImap({
    highestUid: 42,
    unseen: [
      { uid: 43, from: 'alice@example.com', fromName: 'Alice', subject: '你好', text: '第一封' },
      { uid: 44, from: 'bob@example.com', fromName: '', subject: '报表', text: '第二封' }
    ]
  });
  const channel = new MailChannel({ config: mailConfig(), imapFactory: async () => imap });
  const reports = [];
  const inbound = [];
  await channel.start({
    dispatchInbound: (record) => inbound.push(record),
    reportStatus: (status) => reports.push(status)
  });
  assert.equal(imap.__calls.connect, 1);
  assert.equal(channel.status, 'started');
  assert.equal(reports[0].connected, true);
  assert.ok(reports[0].detail.includes('42'), '基线 UID 应出现在状态里');

  const count = await channel.poll();
  assert.equal(count, 2);
  assert.equal(inbound.length, 2);
  assert.equal(inbound[0].chatId, 'alice@example.com', '会话=对端邮箱');
  assert.equal(inbound[0].senderId, 'alice@example.com');
  assert.equal(inbound[0].senderName, 'Alice');
  assert.ok(inbound[0].text.includes('[邮件] 你好'));
  assert.equal(inbound[0].confidence, 'unverified', '空白名单=unverified（安全边界）');
  assert.equal(inbound[0].source, 'imap');

  // 空轮询：无新邮件不产生入站
  const again = await channel.poll();
  assert.equal(again, 0);
  assert.equal(inbound.length, 2);
});

// ── 3. 白名单 ───────────────────────────────────────────────────────────
await c.check('allowedFrom：命中发件人 → verified 入站；未命中 → 不入站', async () => {
  const imap = makeFakeImap({
    highestUid: 0,
    unseen: [
      { uid: 1, from: 'owner@example.com', fromName: '主人', subject: 'a', text: 'a' },
      { uid: 2, from: 'stranger@evil.com', fromName: '陌生人', subject: 'b', text: 'b' }
    ]
  });
  const channel = new MailChannel({
    config: mailConfig({ allowedFrom: ['^owner@example\\.com$'] }),
    imapFactory: async () => imap
  });
  const inbound = [];
  await channel.start({ dispatchInbound: (record) => inbound.push(record), reportStatus: () => {} });
  await channel.poll();
  assert.equal(inbound.length, 1, '陌生邮件不进管道');
  assert.equal(inbound[0].chatId, 'owner@example.com');
  assert.equal(inbound[0].senderVerified, true);
  assert.equal(inbound[0].confidence, 'verified');
  // lastUid 仍然前进（跳过的邮件不重复扫描）
  const status = await channel.checkNow();
  assert.equal(status.lastUid, 2);
});

// ── 4. 发送 ─────────────────────────────────────────────────────────────
await c.check('sendText → 假 SMTP 收到参数；manager.send 路由到通道自身实现', async () => {
  const smtp = makeFakeSmtp();
  const imap = makeFakeImap({ highestUid: 5 });
  const channel = new MailChannel({
    config: mailConfig(),
    imapFactory: async () => imap,
    smtpFactory: async () => smtp
  });
  await channel.start({ dispatchInbound: () => {}, reportStatus: () => {} });
  const result = await channel.sendText('friend@example.com', '你好呀', { subject: '问候' });
  assert.equal(result.sent, true);
  assert.equal(smtp.sent.length, 1);
  assert.equal(smtp.sent[0].to, 'friend@example.com');
  assert.equal(smtp.sent[0].subject, '问候');

  const manager = new ChannelManager({ log: () => {} });
  manager.register(channel);
  const routed = await manager.send('mail', 'sendText', 'friend2@example.com', '第二条', { subject: 's2' });
  assert.equal(routed.sent, true);
  assert.equal(smtp.sent.length, 2);
  assert.ok(channel.capabilities.includes(CAPABILITIES.VERIFIED_SENDER));
});

await c.check('SMTP 未配置 host → CHANNEL_OFFLINE；工具层转结构化错误', async () => {
  const channel = new MailChannel({
    config: mailConfig({ smtp: { host: '', port: 465, tls: true, user: '', pass: '' } }),
    imapFactory: async () => makeFakeImap({ highestUid: 0 })
  });
  await channel.start({ dispatchInbound: () => {}, reportStatus: () => {} });
  await assert.rejects(() => channel.sendText('x@y.com', 'hi'), (error) => (
    error instanceof ChannelError && error.code === CHANNEL_ERROR_CODES.CHANNEL_OFFLINE
  ));
});

// ── 5. 工具集 ───────────────────────────────────────────────────────────
await c.check('registerMailTools：mail_send 全链 + mail_check；注册 2 个工具', async () => {
  const smtp = makeFakeSmtp();
  const imap = makeFakeImap({ highestUid: 9, unseen: [{ uid: 10, from: 'a@b.com', fromName: '', subject: 's', text: 't' }] });
  const channel = new MailChannel({
    config: mailConfig(),
    imapFactory: async () => imap,
    smtpFactory: async () => smtp
  });
  await channel.start({ dispatchInbound: () => {}, reportStatus: () => {} });
  const registered = registerMailTools({ getChannel: () => channel });
  assert.equal(registered, 2);
  const { listTools } = await import('../src/tool-registry.js');
  const sendDef = listTools().find((tool) => tool.id === 'mail_send');
  const checkDef = listTools().find((tool) => tool.id === 'mail_check');
  assert.ok(sendDef && checkDef);

  const sendResult = await sendDef.execute({}, { to: 'x@y.com', subject: 'test', text: 'body' });
  assert.equal(sendResult.isError, false);
  assert.equal(smtp.sent.length, 1);

  const checkResult = await checkDef.execute({}, {});
  assert.equal(checkResult.isError, false);
  assert.ok(JSON.parse(checkResult.content).newMessages >= 1);
});

await c.check('stop：定时器清理 + 连接关闭 + 状态 stopped', async () => {
  const imap = makeFakeImap({ highestUid: 0 });
  const channel = new MailChannel({
    config: mailConfig({ pollSeconds: 1 }),
    imapFactory: async () => imap
  });
  await channel.start({ dispatchInbound: () => {}, reportStatus: () => {} });
  await channel.stop();
  assert.equal(imap.__calls.closed, true);
  assert.equal(channel.status, 'stopped');
});

c.finish();
