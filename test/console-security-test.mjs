import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import { authorizeConsoleRequest, isLocalConsoleRequest } from '../src/console-access.js';
import { ConsoleApprovals, isLocalWebChatTurn } from '../src/console-approvals.js';
import { setRuntimeConfig } from '../src/config.js';
import { registerMailTools } from '../src/channels/mail/tools.js';
import { registerBrowserTools } from '../src/channels/browser/tools.js';
import { getTool, getToolAvailability } from '../src/tool-registry.js';

test('免令牌仅限本机 TCP 对端和本机控制台地址', () => {
  const request = { headers: { host: 'localhost:3210' }, socket: {}, url: '/' };
  for (const address of ['::1', '127.0.0.1', '::ffff:127.0.0.1']) {
    request.socket.remoteAddress = address;
    assert.equal(authorizeConsoleRequest(request, 'configured'), true);
  }
  for (const address of [undefined, '192.0.2.1']) {
    request.socket.remoteAddress = address;
    assert.equal(isLocalConsoleRequest(request), false);
    assert.equal(authorizeConsoleRequest(request, 'configured'), false);
    assert.equal(authorizeConsoleRequest(request, ''), false);
  }
  request.headers['x-console-token'] = 'configured';
  assert.equal(authorizeConsoleRequest(request, 'configured'), true);
  assert.equal(isLocalConsoleRequest(request), false);
});

test('旧消息、混合批次、QQ 私聊/群聊以及主动轮次无本机操作权限', () => {
  const local = [{localConsole: true}];
  assert.equal(isLocalWebChatTurn('private:web', local, false), true);
  for (const entries of [[], [{}], [...local, {}], [{localConsole: false}]]) {
    assert.equal(isLocalWebChatTurn('private:web', entries, false), false);
  }
  for (const key of ['private:1', 'group:1']) assert.equal(isLocalWebChatTurn(key, local, false), false);
  assert.equal(isLocalWebChatTurn('private:web', local, true), false);
});

test('通道工具同时检查展示和执行权限，本机一次确认只执行一个动作', async () => {
  let count = 0;
  const cfg = {channels: {mail: {enabled: true}, browser: {enabled: true}}};
  setRuntimeConfig(cfg);
  const getChannel = () => ({ sendText: async () => ({messageId: ++count}) });
  registerBrowserTools({ getChannel });
  registerMailTools({ getChannel });
  const approvals = new ConsoleApprovals();
  const local = {chatKey: 'private:web', localConsole: true, consoleApprovals: approvals};
  const qq = {chatKey: 'group:1', localConsole: false, consoleApprovals: approvals};
  const remote = {...local, localConsole: false};
  const args = {to: 'test@example.invalid', subject: '测试', text: '正文'};
  for (const id of ['mail_send','mail_check','browser_read','browser_tabs','browser_navigate','browser_eval','browser_click','browser_fill']) {
    for (const ctx of [qq, remote]) {
      assert.equal(getToolAvailability(id, {runtimeContext: ctx}).enabled, false);
      assert.equal((await getTool(id).execute(ctx, args)).isError, true);
    }
    assert.equal(getToolAvailability(id, {runtimeContext: local}).enabled, true);
  }
  assert.deepEqual(approvals.list(), []);
  const send = () => getTool('mail_send').execute(local, args);
  const first = send();
  const [pending] = approvals.list();
  assert.deepEqual(pending.args, args);
  assert.equal(count, 0);
  assert.equal(approvals.decide(pending.id, false), true);
  assert.equal((await first).isError, true);
  const second = send();
  assert.equal(approvals.decide(pending.id, true), false);
  approvals.decide(approvals.list()[0].id, true);
  assert.equal((await second).isError, false);
  assert.equal(count, 1);
  const third = send();
  cfg.channels.mail.enabled = false;
  approvals.decide(approvals.list()[0].id, true);
  assert.equal((await third).isError, true);
  assert.equal(count, 1);
});

test('中止会话取消尚未处理的确认', async () => {
  const approvals = new ConsoleApprovals();
  const controller = new AbortController();
  const result = approvals.request('操作', {}, controller.signal);
  const [item] = approvals.list();
  controller.abort();
  assert.equal(await result, false);
  assert.equal(approvals.decide(item.id, true), false);
  assert.equal(await approvals.request('操作', {}, controller.signal), false);
});

test('网页对话显示完整参数并提交对应的一次决定', async () => {
  const dom = new JSDOM('<div id="webchat-approvals"></div>', { runScripts: 'outside-only' });
  const win = dom.window;
  try {
    win.$ = selector => win.document.querySelector(selector);
    win.esc = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
    const sent = [];
    win.api = async (path, options) => sent.push([path, JSON.parse(options.body)]);
    const script = await readFile(new URL('../ui/app/15-webchat.js', import.meta.url), 'utf8');
    win.eval(script + '\nwindow.showApprovals = renderWebchatApprovals;');
    const item = { id: 'action-1', tool: '发送邮件', args: { to: 'a@example.invalid', text: '<正文>' } };
    win.showApprovals([item]);
    assert.deepEqual(JSON.parse(win.document.querySelector('pre').textContent), item.args);
    const button = win.document.querySelector('[data-allow="no"]');
    button.click();
    assert.deepEqual(sent, [['/api/webchat/approval', { id: 'action-1', allow: false }]]);
    win.showApprovals([]);
    assert.equal(win.document.querySelector('button'), null);
    await Promise.resolve();
  } finally {
    win.close();
  }
});
