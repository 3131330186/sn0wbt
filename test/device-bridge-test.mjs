/**
 * 设备控制（ADB 桥）的密闭测试 —— 全程用假 adb，不碰真机。
 *
 * 为什么必须这套测试：device_* 工具操作的是用户的真手机（物理敏感），
 * 安全围栏（黑名单/预算/互斥/坐标校验）一旦失效，后果是"模型真的在
 * 支付宝里乱点"，而不是一条报错。这类失败不报错、不可见，只有断言能拦。
 *
 * 覆盖：
 *   1. 可用性层：deviceControl 关 → 整组工具不可见；vision 关 → device_look 不可见
 *   2. 无设备 / unauthorized 设备的错误文案（用户能照着做）
 *   3. 截屏返回 image_url 部件 + 拿锁
 *   4. 互斥锁：B 会话在 A 手里拿不到设备
 *   5. 动作/截屏预算封顶
 *   6. 应用黑名单：前台受限应用拒绝动作；device_app 拒开受限应用
 *   7. 坐标越界 / 非法包名 / 中文输入限制
 *   8. 正常动作落到底层命令（tap/swipe/monkey 原样透传）
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 必须在 import src/ 之前设置：DATA_DIR 是 config.js 的 import 时常量
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-device-test-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-fakeadb-'));
process.env.FAKE_ADB_STATE = stateDir;

const fakeAdb = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')), 'fake-adb', 'adb.cmd');

// 预置配置（loadConfig 会与 DEFAULT_CONFIG 深合并，只写关心的字段即可）
fs.mkdirSync(path.join(dataDir, 'messages'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  tools: { deviceControl: true },
  device: { adbPath: fakeAdb, maxActionsPerRun: 3, maxLooksPerRun: 2 }
}), 'utf8');

const { buildToolDefs } = await import('../src/tools.js');
const { deviceManager } = await import('../src/device/manager.js');
const { getToolAvailability, getTool: getToolDef } = await import('../src/tool-registry.js');
const { updateConfig } = await import('../src/config.js');

buildToolDefs();   // 与 app.js 启动时一样注册全部内置工具

const ctxA = { chatKey: 'group:999', session: { id: 's-a' }, emit() {} };
const ctxB = { chatKey: 'group:888', session: { id: 's-b' }, emit() {} };

// 从注册表拿工具定义（buildToolDefs 之后一定在）
const getTool = (id) => {
  const t = getToolDef(id);
  if (!t) throw new Error(`工具未注册：${id}`);
  return t;
};

const cmdLog = () => {
  try { return fs.readFileSync(path.join(stateDir, 'cmdlog.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); }
  catch { return []; }
};
const setState = (file, content) => fs.writeFileSync(path.join(stateDir, file), content, 'utf8');

let bad = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  [ok] ${label}`); }
  catch (e) { bad++; console.log(`  [FAIL] ${label} -- ${e.message}`); }
};
const checkAsync = async (label, fn) => {
  try { await fn(); console.log(`  [ok] ${label}`); }
  catch (e) { bad++; console.log(`  [FAIL] ${label} -- ${e.message}`); }
};

console.log('\n== 设备控制：可用性层 ==');

check('deviceControl=false 时整组 device 工具不可见', () => {
  updateConfig({ tools: { deviceControl: false } });
  const av = getToolAvailability('device_look', { toolsCfg: updateConfig({}).tools, visionEnabled: true });
  assert.equal(av.enabled, false);
  assert.match(av.reason, /设备控制未开启/);
});

check('requiresVision：模型不支持图片时 device_look 自动禁用（其它设备工具不受影响）', () => {
  updateConfig({ tools: { deviceControl: true } });
  const cfg = updateConfig({}).tools;
  const look = getToolAvailability('device_look', { toolsCfg: cfg, visionEnabled: false });
  assert.equal(look.enabled, false);
  assert.match(look.reason, /视觉|图片|vision/i);
  const tap = getToolAvailability('device_tap', { toolsCfg: cfg, visionEnabled: false });
  assert.equal(tap.enabled, true, '点击不依赖看图，纯文字模式也要能用');
});

console.log('\n== 设备控制：设备发现与错误文案 ==');

await checkAsync('无设备：错误文案告诉用户怎么接（不抛裸异常）', async () => {
  setState('devices.txt', '');
  const r = await getTool('device_status').execute(ctxA, {});
  assert.ok(!r.isError);
  const parsed = JSON.parse(r.content);
  assert.deepEqual(parsed.devices, []);
  const r2 = await getTool('device_look').execute(ctxA, {});
  assert.ok(r2.isError);
  assert.match(r2.content, /USB 调试|没有已连接/);
});

await checkAsync('unauthorized 设备：提示去手机上点授权弹窗', async () => {
  setState('devices.txt', 'TAB9 unauthorized device:x model:T9');
  const r = await getTool('device_look').execute(ctxA, {});
  assert.ok(r.isError);
  assert.match(r.content, /允许 USB 调试/);
});

console.log('\n== 设备控制：截屏 / 拿锁 / 互斥 ==');

await checkAsync('有设备：device_look 返回 image_url 部件 + 拿到锁', async () => {
  setState('devices.txt', 'TAB123 device product:tab model:TAB_MODEL');
  setState('awake.txt', 'Awake');
  setState('focus.txt', 'tv.danmaku.bili');
  const r = await getTool('device_look').execute(ctxA, {});
  assert.ok(!r.isError, r.content);
  assert.equal(r.content[0].type, 'text');
  assert.match(r.content[1].image_url.url, /^data:image\//);
  assert.equal(deviceManager.lock?.chatKey, 'group:999', '截屏应自动拿锁');
});

await checkAsync('互斥锁：B 会话动作被拒，文案指向占用者', async () => {
  const r = await getTool('device_tap').execute(ctxB, { x: 100, y: 200 });
  assert.ok(r.isError);
  assert.match(r.content, /正被另一个会话使用.*group:999/s);
});

console.log('\n== 设备控制：预算 ==');

await checkAsync('截屏预算封顶（maxLooksPerRun=2：之前已用 1 次，再用 1 次到顶，第 3 次拒绝）', async () => {
  const r1 = await getTool('device_look').execute(ctxA, {});   // 第 2 次（预算内）
  assert.ok(!r1.isError, r1.content);
  const r2 = await getTool('device_look').execute(ctxA, {});   // 第 3 次 → 拒绝
  assert.ok(r2.isError);
  assert.match(r2.content, /截屏预算用完/);
});

await checkAsync('动作预算封顶：新会话 maxActionsPerRun=3，第 4 次拒绝', async () => {
  deviceManager.release('group:999');   // 换会话 → 新预算
  for (let i = 0; i < 3; i++) {
    const r = await getTool('device_tap').execute(ctxB, { x: 100, y: 100 });
    assert.ok(!r.isError, `第 ${i + 1} 次点击不应失败：${r.content}`);
  }
  const r4 = await getTool('device_tap').execute(ctxB, { x: 100, y: 100 });
  assert.ok(r4.isError);
  assert.match(r4.content, /动作预算用完/);
});

console.log('\n== 设备控制：安全围栏 ==');

await checkAsync('前台是受限应用（支付宝）→ 动作拒绝', async () => {
  deviceManager.release('group:888');
  setState('focus.txt', 'com.eg.android.AlipayGphone');
  const r = await getTool('device_tap').execute(ctxA, { x: 100, y: 100 });
  assert.ok(r.isError);
  assert.match(r.content, /受限应用/);
});

await checkAsync('review 回归：受限应用前台的截屏也被拒（画面不进视觉模型）', async () => {
  deviceManager.release('group:999');
  setState('focus.txt', 'com.tencent.mm');   // 微信前台
  const before = cmdLog().filter((e) => e.args.includes('screencap')).length;
  const r = await getTool('device_look').execute(ctxA, {});
  assert.ok(r.isError, '受限前台必须拒绝截屏');
  assert.match(r.content, /拒绝截屏/);
  const after = cmdLog().filter((e) => e.args.includes('screencap')).length;
  assert.equal(after, before, '被拒时绝不能真的执行截屏');
  setState('focus.txt', 'tv.danmaku.bili');
});

await checkAsync('内置黑名单可被用户移除：移除后放行、勾回恢复、无效包名无影响', async () => {
  // 默认：前台微信被拦
  setState('focus.txt', 'com.tencent.mm');
  deviceManager.release('group:999');
  const r1 = await getTool('device_tap').execute(ctxA, { x: 100, y: 100 });
  assert.ok(r1.isError, '默认（未移除）时前台微信应被拦截');
  // 外联页取消勾选 → blocklistDisabled 里出现微信 → 放行
  updateConfig({ device: { blocklistDisabled: ['com.tencent.mm'] } });
  deviceManager.release('group:999');
  const r2 = await getTool('device_tap').execute(ctxA, { x: 100, y: 100 });
  assert.ok(!r2.isError, `移除保护后应放行：${r2.content}`);
  // disabled 里塞一个不在内置表的包名 → 不影响微信仍被拦
  updateConfig({ device: { blocklistDisabled: ['com.not.builtin'] } });
  deviceManager.release('group:999');
  const r3 = await getTool('device_tap').execute(ctxA, { x: 100, y: 100 });
  assert.ok(r3.isError, '无效的移除项不影响拦截');
  // 勾回（恢复默认保护）
  updateConfig({ device: { blocklistDisabled: [] } });
  setState('focus.txt', 'tv.danmaku.bili');
});

await checkAsync('device_app 拒绝打开受限应用（打不开微信/支付宝/系统设置）', async () => {
  for (const pkg of ['com.eg.android.AlipayGphone', 'com.tencent.mm', 'com.android.settings']) {
    const r = await getTool('device_app').execute(ctxA, { packageName: pkg });
    assert.ok(r.isError, `${pkg} 应被拒`);
    assert.match(r.content, /受限名单|不允许打开/);
  }
});

await checkAsync('坐标越界拒绝（屏幕 1080x2340）', async () => {
  setState('focus.txt', 'tv.danmaku.bili');
  const r = await getTool('device_tap').execute(ctxA, { x: 5000, y: 0 });
  assert.ok(r.isError);
  assert.match(r.content, /超出屏幕范围/);
});

await checkAsync('中文输入拒绝（v1 仅 ASCII），空格输入不炸', async () => {
  const r1 = await getTool('device_input_text').execute(ctxA, { text: '你好世界' });
  assert.ok(r1.isError);
  assert.match(r1.content, /英文|中文/);
  const r2 = await getTool('device_input_text').execute(ctxA, { text: 'hello world' });
  assert.ok(!r2.isError, r2.content);
});

console.log('\n== 设备控制：命令透传 ==');

await checkAsync('tap/swipe 落成正确的 adb 命令', async () => {
  deviceManager.release('group:999');
  await getTool('device_tap').execute(ctxA, { x: 540, y: 1200 });
  await getTool('device_swipe').execute(ctxA, { x1: 540, y1: 1800, x2: 540, y2: 600, durationMs: 300 });
  const cmds = cmdLog().map((e) => e.args.join(' '));
  assert.ok(cmds.some((c) => c.includes('-s TAB123 shell input tap 540 1200')), cmds.join('\n'));
  assert.ok(cmds.some((c) => c.includes('input swipe 540 1800 540 600 300')), cmds.join('\n'));
});

await checkAsync('device_app 正常包名走 monkey 拉起；未知包名给出可读错误', async () => {
  deviceManager.release('group:999');
  const ok1 = await getTool('device_app').execute(ctxA, { packageName: 'tv.danmaku.bili' });
  assert.ok(!ok1.isError, ok1.content);
  assert.ok(cmdLog().some((e) => e.args.join(' ').includes('monkey -p tv.danmaku.bili')));
  setState('monkey_fail.txt', '1');
  const bad1 = await getTool('device_app').execute(ctxA, { packageName: 'com.not.exist.app' });
  assert.ok(bad1.isError);
  assert.match(bad1.content, /打开应用失败/);
  setState('monkey_fail.txt', '');
});

await checkAsync('device_status listApps 返回包名列表（黑名单应用照样列出，但会提醒）', async () => {
  deviceManager.release('group:999');
  const r = await getTool('device_status').execute(ctxA, { listApps: true });
  const parsed = JSON.parse(r.content);
  assert.ok(parsed.installedApps.includes('tv.danmaku.bili'));
  assert.ok(parsed.blockedNote);
});

await checkAsync('锁释放后其它会话可用', async () => {
  deviceManager.release('group:999');
  const r = await getTool('device_tap').execute(ctxB, { x: 1, y: 1 });
  assert.ok(!r.isError, r.content);
  deviceManager.release('group:888');
});

console.log(bad ? `\n${bad} 项失败\n` : '\n全部通过\n');
process.exit(bad ? 1 : 0);
