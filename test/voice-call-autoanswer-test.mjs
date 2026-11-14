/**
 * 语音通话 Phase 3b（自动接听）的密闭测试。
 *
 * parseCallProbe 用的是【真实 callui.ps1 输出样本】（2026-11-04 实测钉死的
 * 响铃/接通两态树）；watcher 用假件跑全流程，不碰真窗口。
 *
 * 覆盖（评审提示词第 6 节）：
 *   解析：响铃态（来电人昵称）/ 接通态（计时器+退出通话）/ 无窗口 / 异常输出
 *   看门狗：白名单来电自动接 + 复检接通 + 开会话；非白名单保留手动；空白名单
 *   fail-closed；重复 ring 不重复接；点击未接通不开会话；手动接通自动开会话；
 *   通话结束自动 stop；autoAnswer=false 完全不动
 */
import assert from 'node:assert/strict';

const mod = await import('../src/voice-call/auto-answer.js');
const { parseCallProbe, createAutoAnswerWatcher } = mod;

let bad = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  [ok] ${label}`); }
  catch (e) { bad++; console.log(`  [FAIL] ${label} -- ${e.message}`); }
};
const checkAsync = async (label, fn) => {
  try { await fn(); console.log(`  [ok] ${label}`); }
  catch (e) { bad++; console.log(`  [FAIL] ${label} -- ${e.message}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 真实探测输出样本（2026-11-04 实测）──
const SAMPLE_RING = [
  'CALL-WINDOW pid=25232 title=语音通话 wakeHits=0',
  'ControlType.Pane|语音通话',
  'ControlType.Group|邀请你语音通话',
  'ControlType.Text|小诺世界第一',
  'ControlType.Text|邀请你语音通话',
  'ControlType.Button|接听',
  'ControlType.Text|接听',
  'ControlType.Button|挂断',
  'ControlType.Text|挂断'
].join('\n');

const SAMPLE_INCALL = [
  'CALL-WINDOW pid=25232 title=语音通话 wakeHits=0',
  'ControlType.Pane|语音通话',
  'ControlType.Group|邀请你语音通话',
  'ControlType.Text|小诺世界第一',
  'ControlType.Button|关闭麦克风',
  'ControlType.Text|关闭麦克风',
  'ControlType.Button|开启视频',
  'ControlType.Text|开启视频',
  'ControlType.Button|屏幕共享',
  'ControlType.Text|屏幕共享',
  'ControlType.Button|退出通话',
  'ControlType.Text|退出通话',
  'ControlType.Text|00:03',
  'ControlType.Text|视频已关闭'
].join('\n');

console.log('\n== parseCallProbe（真实样本）==');

check('响铃态：phase=ring + 来电人昵称', () => {
  const r = parseCallProbe(SAMPLE_RING);
  assert.equal(r.phase, 'ring');
  assert.equal(r.caller, '小诺世界第一');
});

check('接通态：phase=in-call（退出通话按钮 + 计时器双信号）', () => {
  const r = parseCallProbe(SAMPLE_INCALL);
  assert.equal(r.phase, 'in-call');
  assert.equal(r.caller, null);
});

check('无窗口 / 无 QQ / 乱输出 → none', () => {
  assert.equal(parseCallProbe('NO-CALL-WINDOW qqPids=1,2').phase, 'none');
  assert.equal(parseCallProbe('NO-QQ-PROCESS').phase, 'none');
  assert.equal(parseCallProbe('').phase, 'none');
  assert.equal(parseCallProbe('乱七八糟输出').phase, 'none');
});

check('未知窗口态（ neither 接听 nor 退出通话）→ unknown，不会误接', () => {
  const weird = 'CALL-WINDOW pid=1 title=语音通话\nControlType.Pane|语音通话\nControlType.Text|加载中';
  const r = parseCallProbe(weird);
  assert.equal(r.phase, 'unknown');
});

console.log('\n== 看门狗（假件全流程）==');

await checkAsync('白名单来电：接听 → 复检接通 → 开会话；窗口消失 → stop', async () => {
  let step = 0;              // 0=响铃中 → 点击后世界变为 1=接通 → 之后 2=窗口消失
  let calls = 0, started = 0, stopped = 0, inCall = false;
  const logs = [];
  const sess = {
    get inCall() { return inCall; },
    get canStart() { return !inCall; },
    get state() { return inCall ? 'listening' : 'idle'; },
    async start() { inCall = true; started++; },
    async stop(reason) { inCall = false; stopped++; }
  };
  const w = createAutoAnswerWatcher({
    probe: async () => (step === 0 ? SAMPLE_RING : step === 1 ? SAMPLE_INCALL : 'NO-CALL-WINDOW'),
    answer: async () => { calls++; step = 1; return 'clicked:接听'; },   // 点击即接通（下一步复检看到 in-call）
    getConfig: () => ({ voiceCall: { autoAnswer: true, whitelist: ['小诺世界第一'] } }),
    getSession: () => sess,
    log: (m) => logs.push(m)
  });
  await w.tick();   // 一次 tick 内完成：ring → answer → sleep1.2s → 复检 in-call → start
  assert.equal(calls, 1, '应恰好点一次接听');
  assert.equal(started, 1, '复检接通后应开会话');
  assert.ok(logs.some((l) => /已接通并开始对话/.test(l)));
  step = 2;         // 通话结束：窗口消失
  await w.tick();
  assert.equal(stopped, 1, '窗口消失后应 stop 会话');
  assert.equal(inCall, false);
});

await checkAsync('非白名单来电：不接，保留手动', async () => {
  const logs = [];
  let calls = 0;
  const w2 = createAutoAnswerWatcher({
    probe: async () => SAMPLE_RING,
    answer: async () => { calls++; return 'clicked:接听'; },
    getConfig: () => ({ voiceCall: { autoAnswer: true, whitelist: ['别人'] } }),
    getSession: () => ({ get inCall() { return false; }, get canStart() { return true; }, async start() { }, async stop() { } }),
    log: (m) => logs.push(m)
  });
  await w2.tick();
  assert.equal(calls, 0, '非白名单不得接听');
  assert.ok(logs.some((l) => /不在白名单/.test(l)));
});

await checkAsync('空白名单 fail-closed：开自动接也谁都不接', async () => {
  let calls = 0;
  const w = createAutoAnswerWatcher({
    probe: async () => SAMPLE_RING,
    answer: async () => { calls++; return 'clicked:接听'; },
    getConfig: () => ({ voiceCall: { autoAnswer: true, whitelist: [] } }),
    getSession: () => ({ get inCall() { return false; }, get canStart() { return true; }, async start() { }, async stop() { } }),
    log: () => { }
  });
  await w.tick();
  assert.equal(calls, 0, '空白名单谁都不自动接');
});

await checkAsync('重复 ring 不重复接：点击过一次后，即使复检失败也不连点', async () => {
  let calls = 0;
  let probeCount = 0;
  const w = createAutoAnswerWatcher({
    probe: async () => { probeCount++; return SAMPLE_RING; },   // 永远响铃（复检也 ring）
    answer: async () => { calls++; return 'clicked:接听'; },
    getConfig: () => ({ voiceCall: { autoAnswer: true, whitelist: ['小诺世界第一'] } }),
    getSession: () => ({ get inCall() { return false; }, get canStart() { return true; }, async start() { }, async stop() { } }),
    log: () => { }
  });
  await w.tick();
  await sleep(1300);
  await w.tick();
  assert.equal(calls, 1, `只应点一次（实际 ${calls}）`);
});

await checkAsync('点击未生效（复检仍响铃）不开会话', async () => {
  let started = 0;
  let calls = 0;
  const w = createAutoAnswerWatcher({
    probe: async () => SAMPLE_RING,   // 点击后复检仍是响铃 → 视为未接通
    answer: async () => { calls++; return 'clicked:接听'; },
    getConfig: () => ({ voiceCall: { autoAnswer: true, whitelist: ['小诺世界第一'] } }),
    getSession: () => ({ get inCall() { return false; }, get canStart() { return true; }, async start() { started++; }, async stop() { } }),
    log: () => { }
  });
  await w.tick();
  await sleep(1300);
  assert.equal(calls, 1);
  assert.equal(started, 0, '未确认接通不得开会话');
});

await checkAsync('手动接通（窗口 in-call 而会话 idle）→ 自动开会话', async () => {
  let started = 0;
  let inCall = false;
  const sess = {
    get inCall() { return inCall; },
    get canStart() { return !inCall; },
    get state() { return inCall ? 'listening' : 'idle'; },
    async start() { inCall = true; started++; },
    async stop() { inCall = false; }
  };
  const w = createAutoAnswerWatcher({
    probe: async () => SAMPLE_INCALL,
    answer: async () => 'notfound',
    getConfig: () => ({ voiceCall: { autoAnswer: false, whitelist: [] } }),
    getSession: () => sess,
    log: () => { }
  });
  await w.tick();
  assert.equal(started, 1, '手动接通也应自动开始对话循环');
});

await checkAsync('autoAnswer=false：响铃完全不响应', async () => {
  let calls = 0;
  const w = createAutoAnswerWatcher({
    probe: async () => SAMPLE_RING,
    answer: async () => { calls++; return 'clicked:接听'; },
    getConfig: () => ({ voiceCall: { autoAnswer: false, whitelist: ['小诺世界第一'] } }),
    getSession: () => ({ get inCall() { return false; }, get canStart() { return true; }, async start() { }, async stop() { } }),
    log: () => { }
  });
  await w.tick();
  assert.equal(calls, 0);
});

console.log(bad ? `\n${bad} 项失败\n` : '\n全部通过\n');
process.exit(bad ? 1 : 0);
