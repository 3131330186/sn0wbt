import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BrowserChannel } from '../src/channels/browser/index.js';
import { MailChannel } from '../src/channels/mail/index.js';
import { ChannelManager } from '../src/channels/manager.js';
import { setRuntimeConfig } from '../src/config.js';
import { installBridgeFiles } from '../scripts/lib/bridge-files.mjs';

test('浏览器接入、改地址和失败重试使用新配置，状态与连接结果一致', async (t) => {
  const manager = new ChannelManager();
  t.after(() => manager.stopAll());
  const attempts = [], closed = [];
  const initial = { enabled: false, cdpUrl: 'old' };
  setRuntimeConfig({ channels: { browser: initial } });
  manager.register(new BrowserChannel({
    config: initial,
    connectFn: async ({ cdpUrl }) => {
      attempts.push(cdpUrl);
      if (cdpUrl === 'unavailable') throw new Error('连接被拒绝');
      return { close: async () => closed.push(cdpUrl) };
    }
  }));
  await manager.startAll();
  assert.equal(manager.list()[0].status, 'stopped');
  for (const cdpUrl of ['first', 'unavailable', 'second']) {
    setRuntimeConfig({ channels: { browser: { enabled: true, cdpUrl } } });
    await manager.startChannel('browser');
    const state = manager.list()[0];
    const failed = cdpUrl === 'unavailable';
    assert.equal(state.status, failed ? 'error' : 'started');
    assert.equal(state.lastError, failed ? '连接被拒绝' : null);
    assert.equal(state.lastStatus.connected, !failed);
  }
  assert.deepEqual(attempts, ['first', 'unavailable', 'second']);
  assert.deepEqual(closed, ['first']);
});

test('切换邮箱释放收发连接，旧轮询返回时不会覆盖新邮箱的 UID 或派发邮件', async (t) => {
  let finishOldPoll;
  const closed = [], sent = [], inbound = [];
  const manager = new ChannelManager();
  t.after(() => manager.stopAll());
  manager.onInbound(record => inbound.push(record.chatId));
  const channel = manager.register(new MailChannel({
    config: { enabled: false },
    imapFactory: async ({ imap }) => ({
      connect() {},
      getHighestUid: () => imap.host === 'first' ? 100 : 20,
      getUnseen: uid => {
        if (imap.host === 'first') return new Promise(resolve => { finishOldPoll = resolve; });
        assert.equal(uid, 20);
        return [{ uid: 21, from: 'new@example.test' }];
      },
      close() { closed.push('imap:' + imap.host); }
    }),
    smtpFactory: async ({ smtp }) => ({
      send() { sent.push(smtp.host); return { messageId: smtp.host }; },
      close() { closed.push('smtp:' + smtp.host); }
    })
  }));
  async function switchAccount(host) {
    setRuntimeConfig({ channels: { mail: { enabled: true, imap: { host }, smtp: { host } } } });
    await manager.startChannel('mail');
    assert.equal(channel.status, 'started');
    await channel.sendText('recipient@example.test', 'test');
  }
  await switchAccount('first');
  const oldPoll = channel.poll();
  await switchAccount('second');
  assert.deepEqual(await channel.checkNow(), { newMessages: 1, lastUid: 21, connected: true });
  finishOldPoll([{ uid: 105, from: 'old@example.test' }]);
  assert.equal(await oldPoll, 0);
  assert.deepEqual(inbound, ['new@example.test']);
  assert.deepEqual(sent, ['first', 'second']);
  assert.deepEqual(closed, ['imap:first', 'smtp:first']);
});

test('桥接首次安装使用示例，重装更新程序并逐字节保留配置、日志和用户文件', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sn0wbot-bridge-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const vendor = path.join(root, 'vendor'), target = path.join(root, 'runtime');
  const source = path.join(vendor, 'scripts'), scripts = path.join(target, 'scripts');
  fs.mkdirSync(source, { recursive: true });
  for (const name of ['LICENSE', 'README.md', 'requirements.txt']) fs.writeFileSync(path.join(vendor, name), name);
  const config = path.join(scripts, 'bridge-config.json');
  const program = 'onebot_uia_bridge.py';
  fs.writeFileSync(path.join(source, program), 'v1');
  fs.writeFileSync(path.join(source, 'bridge-config.example.json'), '{"example":1}');
  fs.writeFileSync(path.join(source, 'bridge-config.json'), '{"vendor":1}');
  installBridgeFiles(vendor, target);
  assert.equal(fs.readFileSync(config, 'utf8'), '{"example":1}');
  const custom = Buffer.from('\uFEFF{ "account": "我的配置" }\r\n');
  fs.writeFileSync(config, custom);
  fs.writeFileSync(path.join(scripts, 'bridge.log'), 'history');
  fs.writeFileSync(path.join(scripts, 'local.py'), 'custom');
  fs.writeFileSync(path.join(source, program), 'v2');
  fs.writeFileSync(path.join(source, 'bridge-config.example.json'), '{"example":2}');
  installBridgeFiles(vendor, target);
  assert.equal(fs.readFileSync(path.join(scripts, program), 'utf8'), 'v2');
  assert.deepEqual(fs.readFileSync(config), custom);
  assert.equal(fs.readFileSync(path.join(scripts, 'bridge.log'), 'utf8'), 'history');
  assert.equal(fs.readFileSync(path.join(scripts, 'local.py'), 'utf8'), 'custom');
});
