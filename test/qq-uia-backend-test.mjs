// QQ 通道 UIA 后端密闭测试（反向 WS 服务端 + 假桥接）
//
// 覆盖：
//   1. start → 反向 WS 服务端监听；假桥接连入即被下发 get_login_info，回响应后 selfInfo 落位
//   2. 假桥推消息事件 → 经 manager 入站分发（channelId 打戳）
//   3. sendText → 服务端下发 send_private_msg（含 reply/at 段构造）→ 假桥响应后拿到 data
//   4. sendSegments/sendPoke/getMsg 的下发参数正确
//   5. 假桥不回响应 → call 按档位超时拒绝（结构化错误，不挂死）
//   6. 桥接未连入时 sendText → 结构化错误（不伪造成功）
//   7. stopAll → 服务端关闭、状态 stopped
//
// ⚠️ 全程共享一个服务端实例（同端口不能重复绑定）；收尾显式关桥/停服。
// 运行：node test/qq-uia-backend-test.mjs
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { createChecker } from './_harness.mjs';

const { QQChannel } = await import('../src/channels/qq/index.js');
const { ChannelManager } = await import('../src/channels/manager.js');

const c = createChecker('QQ 通道 UIA 后端（反向 WS + 假桥接）');

const PORT = 17321;

/** 假桥接：真实 WS 客户端，记录收到的 action，按脚本回响应。 */
function makeFakeBridge(port) {
  const state = { actions: [], ws: null, script: {} };
  return {
    state,
    async connect() {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      state.ws = ws;
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
      ws.on('message', (buf) => {
        const obj = JSON.parse(String(buf));
        state.actions.push(obj);
        if (obj.action === 'get_login_info') {
          ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { user_id: 3567956169, nickname: '尼斯湖王子' }, echo: obj.echo }));
        } else if (state.script[obj.action]?.length) {
          const data = state.script[obj.action].shift();
          ws.send(JSON.stringify({ status: 'ok', retcode: 0, data, echo: obj.echo }));
        } else {
          ws.send(JSON.stringify({ status: 'ok', retcode: 0, data: { message_id: 777 }, echo: obj.echo }));
        }
      });
      ws.on('close', (code, reason) => process.stderr.write(`[bridge] ws关闭 code=${code} reason=${String(reason).slice(0, 60)}\n`));
      ws.on('error', (e) => process.stderr.write(`[bridge] ws错误: ${e.message}\n`));
      return ws;
    },
    push(event) { state.ws.send(JSON.stringify(event)); },
    mute() { state.ws.removeAllListeners('message'); },   // 变成"不回响应"的桥
    close() { state.ws?.close(); }
  };
}

// ── 公共设施：一个通道 + 一个管理器 + 一个假桥，全测试共享 ────────────────
const manager = new ChannelManager({ log: () => {} });
const channel = new QQChannel({ config: { backend: 'uia', uiaWsPort: PORT, selfId: '3567956169' } });
manager.register(channel);
const inbound = [];
manager.onInbound((record) => inbound.push(record));
const bridge = makeFakeBridge(PORT);

await c.check('start → 服务端监听；假桥接连入即被下发 get_login_info，回响应后 selfInfo 落位', async () => {
  const reports = [];
  await manager.startAll();
  assert.equal(channel.status, 'started');
  assert.equal(channel.backend, 'uia');
  await bridge.connect();
  await new Promise(r => setTimeout(r, 300));
  assert.equal(channel.client.selfId, '3567956169');
  assert.equal(channel.client.selfNickname, '尼斯湖王子');
  assert.equal(channel.lastStatus?.connected, true);
  void reports;
});

await c.check('假桥推消息事件 → 经 manager 入站分发并打 qq 戳', async () => {
  bridge.push({
    time: 1794700000, self_id: 3567956169, post_type: 'message',
    message_type: 'private', user_id: 3131330186, raw_message: '测试2',
    message: [{ type: 'text', data: { text: '测试2' } }]
  });
  await new Promise(r => setTimeout(r, 250));
  assert.equal(inbound.length, 1);
  assert.equal(inbound[0].channelId, 'qq');
  assert.equal(String(inbound[0].user_id), '3131330186');
});

await c.check('sendText → 下发 send_private_msg（reply/at/text 段序正确）→ 拿到 data', async () => {
  const result = await channel.client.sendText('private', '3131330186', '你好', { replyToMessageId: '-123', atUserId: '3131330186' });
  assert.deepEqual(result, { message_id: 777 });
  const sent = bridge.state.actions.find(a => a.action === 'send_private_msg');
  assert.ok(sent, 'send_private_msg 应下发到桥接');
  assert.deepEqual(sent.params.message[0], { type: 'reply', data: { id: '-123' } });
  assert.deepEqual(sent.params.message[1], { type: 'at', data: { qq: '3131330186' } });
  assert.deepEqual(sent.params.message[2], { type: 'text', data: { text: '你好' } });
  assert.equal(sent.params.user_id, 3131330186);
});

await c.check('sendSegments/sendPoke/getMsg 的下发参数正确', async () => {
  await channel.client.sendSegments('group', '456', [{ type: 'text', data: { text: '群消息' } }]);
  await channel.client.sendPoke('private', '3131330186');
  await channel.client.getMsg(-123);
  const actions = bridge.state.actions.map(a => a.action);
  assert.ok(actions.includes('send_group_msg'));
  assert.ok(actions.includes('friend_poke'));
  assert.ok(actions.includes('get_msg'));
  const groupMsg = bridge.state.actions.find(a => a.action === 'send_group_msg');
  assert.equal(groupMsg.params.group_id, 456);
});

await c.check('假桥不回响应 → call 超时拒绝（结构化错误，不挂死）', async () => {
  bridge.mute();
  await assert.rejects(() => channel.client.call('get_msg', { message_id: 1 }, 500), (error) => (
    /超时/.test(error.message)
  ));
  // 恢复响应能力（重连一条新桥连接，脚本继续生效）
  await bridge.close();
  await bridge.connect();
  await new Promise(r => setTimeout(r, 250));
});

await c.check('桥接断开 → 状态如实转未连接；桥接重连即恢复', async () => {
  await bridge.close();
  await new Promise(r => setTimeout(r, 250));
  assert.equal(channel.client.connected, false, '桥接断开后状态应如实转 false');
  await bridge.connect();
  await new Promise(r => setTimeout(r, 250));
  assert.equal(channel.client.connected, true, '桥接重连后状态恢复');
});

await c.check('桥接未连入的独立通道 sendText → 结构化错误（不伪造成功）', async () => {
  const lonely = new QQChannel({ config: { backend: 'uia', uiaWsPort: PORT + 1 } });
  await lonely.start({ dispatchInbound: () => {}, reportStatus: () => {} });
  await assert.rejects(() => lonely.client.sendText('private', '1', 'x'), (error) => (
    /桥接未连入/.test(error.message)
  ));
  await lonely.stop();
});

await c.check('stopAll → 服务端关闭、状态 stopped', async () => {
  await manager.stopAll();
  assert.equal(channel.status, 'stopped');
});

bridge.close();
c.finish();
process.exit(0);
