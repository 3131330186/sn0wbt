// 通道启动器密闭测试（驾驶舱卡片 = 启动器）
//
// 覆盖：
//   1. resolveLaunchCommand：QQ 自动探测（QQNT 路径存在 → exe 直启 / 不存在 → qq:// 兜底）
//   2. 配置覆盖：channels.<id>.launchCommand 优先
//   3. browser → start msedge；mail → start mail:
//   4. openApp：exe 直启（传目标+空参）；shell 经 cmd start（空标题占位）
// 运行：node test/launch-test.mjs
import assert from 'node:assert/strict';
import { createChecker } from './_harness.mjs';

const { resolveLaunchCommand, openApp } = await import('../src/channels/launch.js');

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

c.finish();
process.exit(0);
