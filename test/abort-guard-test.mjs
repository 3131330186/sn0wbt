/**
 * 会话中止守卫的密闭测试（review 修复回归）。
 *
 * 修的问题：用户点「中止」只拦 LLM 轮次边界 —— 一个"发 5 条消息 + 点 10 下
 * 屏幕"的回合，中止后剩余动作会全部做完才停。现在：
 *   · sender.sendTextBatch 支持 shouldAbort —— 批次内逐条检查，剩余分条跳过
 *   · executeTool 统一入口拦截 —— 中止后非只读工具直接拒绝执行
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-abort-test-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

// ⚠️ 本机 node（v24.20.0）对 .mjs 里的解构 `as` 重命名解析损坏（详见 AGENTS.md
// 坑列表）—— 这里不能用 `import { x as y }`，用整对象接收 + 属性访问绕开。
const toolsMod = await import('../src/tools.js');
const registryMod = await import('../src/tool-registry.js');
const { buildToolDefs, executeTool } = toolsMod;
const { getTool, getToolAvailability, listTools } = registryMod;
const { SendQueue } = await import('../src/sender.js');
const { updateConfig } = await import('../src/config.js');

updateConfig({ tools: { speechVoice: true, deviceControl: true } });
buildToolDefs();
const allDefs = listTools();
// 统一走 executeTool —— 与 orchestrator 相同的分发路径（守卫就在这一层）
const callTool = (ctx, name, args) => executeTool(allDefs, ctx, name, JSON.stringify(args ?? {}));

// 模拟"用户已点中止"的 ctx：abortSignal 已 aborted
const abortCtrl = new AbortController();
abortCtrl.abort(new Error('会话已被用户中止'));
const abortedCtx = {
  chatKey: 'group:1',
  session: { id: 's1', sent: [] },
  emit() {},
  abortSignal: abortCtrl.signal
};
const liveCtx = {
  chatKey: 'group:1',
  session: { id: 's2', sent: [] },
  emit() {},
  abortSignal: new AbortController().signal
};

let bad = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  [ok] ${label}`); }
  catch (e) { bad++; console.log(`  [FAIL] ${label} -- ${e.message}`); }
};
const checkAsync = async (label, fn) => {
  try { await fn(); console.log(`  [ok] ${label}`); }
  catch (e) { bad++; console.log(`  [FAIL] ${label} -- ${e.message}`); }
};

console.log('\n== executeTool 统一中止拦截 ==');

await checkAsync('中止后：send_message 直接拒绝（未执行）', async () => {
  const r = await callTool(abortedCtx, 'send_message', { messages: '你好' });
  assert.ok(r.isError);
  assert.match(r.content, /已被用户中止/);
});

await checkAsync('中止后：send_voice / device_tap / device_app 全部拒绝', async () => {
  for (const [id, args] of [
    ['send_voice', { text: 'hi' }],
    ['device_tap', { x: 1, y: 1 }],
    ['device_app', { packageName: 'tv.danmaku.bili' }]
  ]) {
    const r = await callTool(abortedCtx, id, args);
    assert.ok(r.isError, `${id} 应被拒`);
    assert.match(r.content, /已被用户中止/, `${id} 拒绝文案`);
  }
});

await checkAsync('中止后：只读工具（device_status）仍放行（模型能收尾）', async () => {
  const r = await callTool(abortedCtx, 'device_status', {});
  assert.ok(!r.isError || !/已被用户中止/.test(r.content), '只读工具不应被中止拦截');
});

console.log('\n== sendTextBatch 批次内中止 ==');

await checkAsync('中止后剩余分条跳过：5 条只发第 1 条，skipped=4', async () => {
  const sentTexts = [];
  const fakeOnebot = { sendText: async (kind, id, text) => { sentTexts.push(text); return { message_id: sentTexts.length }; } };
  const q = new SendQueue({ onebot: fakeOnebot, store: { appendSelf() {} } });
  let calls = 0;
  const r = await q.sendTextBatch('group:2', ['一', '二', '三', '四', '五'], {
    shouldAbort: () => ++calls > 1   // 第 1 条放行，之后视为已中止
  });
  assert.equal(sentTexts.length, 1, `只应发出 1 条（实际 ${sentTexts.length}）`);
  assert.equal(r.sent.length, 1);
  assert.equal(r.skipped.length, 4);
  assert.deepEqual(r.skipped, ['二', '三', '四', '五']);
});

await checkAsync('未中止：shouldAbort 缺省时 5 条全发（原行为不回归）', async () => {
  const sentTexts = [];
  const fakeOnebot = { sendText: async (kind, id, text) => { sentTexts.push(text); return { message_id: 1 }; } };
  const q = new SendQueue({ onebot: fakeOnebot, store: { appendSelf() {} } });
  const r = await q.sendTextBatch('group:3', ['一', '二', '三', '四', '五']);
  assert.equal(sentTexts.length, 5);
  assert.equal(r.skipped.length, 0);
});

console.log(bad ? `\n${bad} 项失败\n` : '\n全部通过\n');
process.exit(bad ? 1 : 0);
