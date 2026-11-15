// 通道启动器密闭测试（驾驶舱卡片 = 启动器）
//
// 覆盖：
//   1. resolveLaunchCommand：QQ 自动探测（QQNT 路径存在 → exe 直启 / 不存在 → qq:// 兜底）
//   2. 配置覆盖：channels.<id>.launchCommand 优先
//   3. browser → start msedge；mail → start mail:
//   4. openApp：exe 直启（传目标+空参）；shell 经 cmd start（空标题占位）
//   5. 实例探测：探针输出整形/过滤、探针缺失降级
//   6. smartLaunch：已登录实例 → 唤起（桥接账号优先/hwnd 指定），无实例/唤起失败 → 落回新开
// 运行：node test/launch-test.mjs
import assert from 'node:assert/strict';
import { createChecker } from './_harness.mjs';

const { resolveLaunchCommand, openApp, smartLaunch } = await import('../src/channels/launch.js');
const { listQQInstances, focusQQInstance, resolveProbePython } = await import('../src/channels/qq/instances.js');

const c = createChecker('通道启动器（卡片 = 启动器）');

await c.check('resolveLaunchCommand：QQNT 路径存在 → exe 直启', () => {
  const resolved = resolveLaunchCommand('qq', { channels: { qq: {} } }, {
    exists: (p) => p === 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe'
  });
  assert.deepEqual(resolved, { kind: 'exe', target: 'C:\\Program Files\\Tencent\\QQNT\\QQ.exe' });
});

await c.check('resolveLaunchCommand：路径全不存在 → qq:// 协议兜底', () => {
  const resolved = resolveLaunchCommand('qq', { channels: { qq: {} } }, { exists: () => false });
  assert.deepEqual(resolved, { kind: 'shell', target: 'qq://' });
});

await c.check('resolveLaunchCommand：launchCommand 配置优先于自动探测', () => {
  const resolved = resolveLaunchCommand('qq', { channels: { qq: { launchCommand: 'D:\\自定义\\QQ.exe' } } }, { exists: () => true });
  assert.deepEqual(resolved, { kind: 'shell', target: 'D:\\自定义\\QQ.exe' });
});

await c.check('browser → start msedge；mail → start mail:', () => {
  assert.deepEqual(resolveLaunchCommand('browser', { channels: {} }), { kind: 'shell', target: 'msedge' });
  assert.deepEqual(resolveLaunchCommand('mail', { channels: {} }), { kind: 'shell', target: 'mail:' });
});

await c.check('openApp：exe 走直接 spawn；shell 走 cmd start（空标题占位）', () => {
  const exeRuns = [];
  openApp({ kind: 'exe', target: 'C:\\x\\QQ.exe' }, { runner: (cmd, args) => { exeRuns.push([cmd, args]); return { pid: 42 }; } });
  assert.deepEqual(exeRuns, [['C:\\x\\QQ.exe', []]]);

  const shellRuns = [];
  openApp({ kind: 'shell', target: 'msedge' }, { runner: (cmd, args) => { shellRuns.push([cmd, args]); return { pid: 43 }; } });
  assert.deepEqual(shellRuns, [['cmd.exe', ['/c', 'start', '', 'msedge']]]);
});

await c.check('openApp：返回 launched + pid', () => {
  const result = openApp({ kind: 'exe', target: 'C:\\x\\QQ.exe' }, { runner: () => ({ pid: 99 }) });
  assert.equal(result.launched, true);
  assert.equal(result.pid, 99);
});

// ── 实例探测（2026-11-15：已登录优先 + 账号分卡）─────────────────────────

const okRunner = (payload) => async () => ({ stdout: JSON.stringify(payload) });

await c.check('listQQInstances：整形探针输出 + 过滤无账号/坏句柄行', async () => {
  const rows = await listQQInstances({}, {
    runner: okRunner({ instances: [
      { hwnd: 7014922, account: '尼斯湖王子', minimized: false, title: 'QQ' },
      { hwnd: 0, account: '坏句柄' },
      { hwnd: 'abc', account: '非数字句柄' },
      { hwnd: 42, account: '' },
      { hwnd: 43, account: '小号乙', minimized: true }
    ] }),
    exists: () => true
  });
  assert.deepEqual(rows, [
    { hwnd: 7014922, account: '尼斯湖王子', minimized: false, title: 'QQ' },
    { hwnd: 43, account: '小号乙', minimized: true, title: 'QQ' }
  ]);
});

await c.check('listQQInstances：探针失败/解析炸 → 空数组降级（不抛错）', async () => {
  assert.deepEqual(await listQQInstances({}, { runner: async () => ({ stdout: 'not-json' }), exists: () => true }), []);
  assert.deepEqual(await listQQInstances({}, { runner: async () => { throw new Error('boom'); }, exists: () => true }), []);
});

await c.check('resolveProbePython：配置覆盖优先；venv 缺失 → 空', () => {
  const py = resolveProbePython({ channels: { qq: { probePython: 'D:\\py\\python.exe' } } }, {
    exists: (p) => p === 'D:\\py\\python.exe'
  });
  assert.equal(py, 'D:\\py\\python.exe');
  assert.equal(resolveProbePython({}, { exists: () => false }), '');
});

await c.check('smartLaunch：有实例 → 唤起桥接在驱动的账号（不 spawn）', async () => {
  const calls = { focus: [], open: [] };
  const result = await smartLaunch('qq', {}, {
    listInstances: async () => [
      { hwnd: 111, account: '小号乙' },
      { hwnd: 222, account: '尼斯湖王子' }
    ],
    focusWindow: async (hwnd) => { calls.focus.push(hwnd); return { ok: true }; },
    open: (resolved) => { calls.open.push(resolved); return { launched: true, via: resolved.target }; },
    bridgedAccount: '尼斯湖王子'
  });
  assert.deepEqual(calls.focus, [222]);
  assert.deepEqual(calls.open, []);
  assert.deepEqual(result, { launched: true, action: 'focused', account: '尼斯湖王子', hwnd: 222 });
});

await c.check('smartLaunch：账号卡 hwnd 指定优先于桥接账号匹配', async () => {
  const calls = { focus: [] };
  await smartLaunch('qq', {}, {
    listInstances: async () => [{ hwnd: 111, account: '甲' }, { hwnd: 222, account: '乙' }],
    focusWindow: async (hwnd) => { calls.focus.push(hwnd); return { ok: true }; },
    open: () => { throw new Error('不应 spawn'); },
    bridgedAccount: '乙',
    preferredHwnd: 111
  });
  assert.deepEqual(calls.focus, [111]);
});

await c.check('smartLaunch：无实例 → 落回新开（旧行为）', async () => {
  const calls = { focus: [], open: [] };
  const result = await smartLaunch('qq', { channels: { qq: {} } }, {
    listInstances: async () => [],
    focusWindow: async () => { calls.focus.push(1); return { ok: true }; },
    open: (resolved) => { calls.open.push(resolved.kind); return { launched: true, via: 'qq://' }; },
    exists: () => false
  });
  assert.deepEqual(calls.focus, []);
  assert.deepEqual(calls.open, ['shell']);
  assert.equal(result.action, 'spawned');
});

await c.check('smartLaunch：唤起失败（窗口没了/前台被拒）→ 落回新开', async () => {
  const calls = { open: [] };
  const result = await smartLaunch('qq', {}, {
    listInstances: async () => [{ hwnd: 111, account: '甲' }],
    focusWindow: async () => ({ ok: false, error: 'window not found' }),
    open: (resolved) => { calls.open.push(resolved.kind); return { launched: true, via: 'qq://' }; },
    exists: () => false
  });
  assert.deepEqual(calls.open, ['shell']);
  assert.equal(result.action, 'spawned');
});

await c.check('smartLaunch：非 QQ 通道不探测直接启动（browser → msedge）', async () => {
  const calls = { open: [] };
  const result = await smartLaunch('browser', {}, {
    listInstances: async () => { throw new Error('不应探测'); },
    focusWindow: async () => ({ ok: true }),
    open: (resolved) => { calls.open.push(resolved.target); return { launched: true }; }
  });
  assert.deepEqual(calls.open, ['msedge']);
  assert.equal(result.action, 'spawned');
});

await c.check('focusQQInstance：透传 ok/error', async () => {
  const ok = await focusQQInstance(123, {}, { runner: okRunner({ ok: true }), exists: () => true });
  assert.deepEqual(ok, { ok: true });
  const bad = await focusQQInstance(456, {}, { runner: okRunner({ ok: false, error: 'window not found' }), exists: () => true });
  assert.equal(bad.ok, false);
  assert.equal(bad.error, 'window not found');
});

c.finish();
process.exit(0);
