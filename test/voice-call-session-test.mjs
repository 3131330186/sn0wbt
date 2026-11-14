/**
 * 语音通话 Phase 2（会话状态机 + VAD）的密闭测试 —— 假件跑全流程。
 *
 * 不碰真音频/真网络。覆盖评审提示词第 4/5 节的验收点：
 *   VAD：正常断句（首字不被吃）/ 碎屑丢弃 / 超长强制切 / reset
 *   会话：完整一轮（ASR→LLM→TTS→播放）/ 挂断后迟到结果丢弃 / speaking 期间
 *         语音丢弃 / 设备掉线取消在播轮次 / 单轮失败不拆通话 / stop 幂等
 */
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

const vadMod = await import('../src/voice-call/vad.js');
const sessionMod = await import('../src/voice-call/session.js');
const { VAD, SpeechOnset } = vadMod;
const { VoiceCallSession, CALL_STATES, sanitizeCallReply } = sessionMod;

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
async function waitFor(fn, timeoutMs = 3000, step = 20) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor 超时');
    await sleep(step);
  }
}

// ---- PCM 造料（16k mono s16le）----
const tone = (ms, freq = 440, amp = 8000) => {
  const n = Math.floor(16000 * ms / 1000);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin(2 * Math.PI * freq * i / 16000) * amp), i * 2);
  return b;
};
const silence = (ms) => Buffer.alloc(Math.floor(16000 * ms / 1000) * 2);

console.log('\n== VAD 断句 ==');

const fastVad = () => new VAD({ silenceMs: 120, preBufferMs: 60, minSpeechMs: 90, maxSegmentMs: 5000, speechDb: -50 });

check('正常断句：静音→语音→静音 出一段；首字不吃（段长 ≥ 语音时长）', () => {
  const v = fastVad();
  let seg = null;
  // 120ms 静音 + 300ms 语音 + 300ms 静音，按 90ms 块喂（块与帧不对齐，验证累积切帧）
  for (const buf of [silence(120), tone(300), silence(300)]) {
    for (let i = 0; i < buf.length; i += 90 * 32) {
      const r = v.push(buf.subarray(i, Math.min(i + 90 * 32, buf.length)));
      if (r) seg = r;
    }
  }
  assert.ok(seg, '应产出一个段');
  assert.equal(seg.reason, 'silence');
  assert.ok(seg.durationMs >= 300, `段长应 ≥ 语音时长 300ms，实际 ${seg.durationMs}`);
  assert.ok(seg.durationMs <= 560, `段长不应把尾部静音全带上，实际 ${seg.durationMs}`);
});

check('碎屑丢弃：30ms 噪声（< minSpeechMs 90ms，考虑帧量化余量）→ 无段', () => {
  const v = fastVad();
  let seg = null;
  for (const buf of [silence(100), tone(30), silence(400)]) {
    const r = v.push(buf);
    if (r) seg = r;
  }
  assert.equal(seg, null, '有声时长短于 minSpeechMs 应丢弃');
});

check('碎屑丢弃②：150ms 噪声在 minSpeechMs=300 下也丢（总时长被预缓冲+静音撑大不算数）', () => {
  const v = new VAD({ silenceMs: 120, preBufferMs: 250, minSpeechMs: 300, maxSegmentMs: 5000, speechDb: -50 });
  let seg = null;
  for (const buf of [silence(100), tone(150), silence(400)]) {
    const r = v.push(buf);
    if (r) seg = r;
  }
  assert.equal(seg, null, '总时长 500ms+ 但有声仅 150ms → 应按 speechMs 丢弃');
});

check('超长强制切：maxSegmentMs 到点出段（reason=maxlen）', () => {
  const v = new VAD({ silenceMs: 10000, minSpeechMs: 50, maxSegmentMs: 600, speechDb: -50 });
  let seg = null;
  for (let i = 0; i < 30 && !seg; i++) seg = v.push(tone(100));   // 3 秒连续语音
  assert.ok(seg, '应被强制切出');
  assert.equal(seg.reason, 'maxlen');
  assert.ok(seg.durationMs >= 600);
});

check('reset：清空后旧状态不泄漏', () => {
  const v = fastVad();
  v.push(tone(120));                    // 进入 speech 态，未断句
  v.reset();
  let seg = null;
  for (const buf of [silence(500), tone(300), silence(300)]) seg = v.push(buf) || seg;
  assert.ok(seg, 'reset 后应能正常重新断句');
});

check('起音检测：单帧尖峰不触发；持续 300ms 触发一次；触发后需再次持续', () => {
  const o = new SpeechOnset({ speechDb: -50, minMs: 250 });
  assert.equal(o.push(silence(200)), false, '纯静音不触发');
  assert.equal(o.push(tone(30)), false, '单帧尖峰不触发');
  assert.equal(o.push(silence(200)), false, '静音归零连续性');
  assert.equal(o.push(tone(300)), true, '持续 300ms 应触发');
  assert.equal(o.push(tone(60)), false, '触发后自动归零，短音不再触发');
  assert.equal(o.push(tone(300)), true, '再次持续应再触发');
});

check('回复消毒：剥元格式残留；正文不动；剥完为空可判空', () => {
  // 实测首通的泄漏形态
  assert.equal(sanitizeCallReply('[user]\n[assistant]\nno reply needed'), '');
  // 混合：标记行剥掉，正文保留
  assert.equal(sanitizeCallReply('[user]\n打呼噜算不算'), '打呼噜算不算');
  // 正文里的普通内容不受影响（只剥整行标记）
  assert.equal(sanitizeCallReply('你看[表情]了吗'), '你看[表情]了吗');
  // 长句子里夹 "no reply needed" 不在行首 → 保留（避免误伤正文）
  assert.equal(sanitizeCallReply('我说的是 no reply needed 这句话啊'), '我说的是 no reply needed 这句话啊');
});

console.log('\n== 通话会话（假件全流程）==');

class FakeReceiver extends EventEmitter {
  constructor(opts) { super(); this.opts = opts; this.started = false; FakeReceiver.last = this; }
  start() { this.started = true; }
  stop() { this.stopped = true; }
  feed(buf) { this.opts.onChunk?.(buf); }
}

function makeSession(overrides = {}) {
  const rec = { log: { playback: [], llmCalls: [], ttsCalls: [], asrCalls: [] }, gates: {}, abortedCount: 0 };
  const startPlayback = ({ wav, deviceId }) => {
    rec.log.playback.push({ wavBytes: wav.length, deviceId });
    let release;
    const done = new Promise((res) => { release = res; });
    rec.gates[rec.log.playback.length - 1] = () => release({ ok: true, reason: '' });
    return { done, abort: () => { rec.abortedCount++; release({ ok: false, reason: 'aborted' }); } };
  };
  const session = new VoiceCallSession({
    createReceiver: (opts) => new FakeReceiver(opts),
    asr: overrides.asr || (async (wav) => { rec.log.asrCalls.push(wav); return { ok: true, text: '你好呀' }; }),
    llm: overrides.llm || (async (messages) => { rec.log.llmCalls.push(messages); return '嗨，我在呢。'; }),
    tts: overrides.tts || (async (text) => { rec.log.ttsCalls.push(text); return { wav: Buffer.alloc(4800) }; }),
    startPlayback,
    resolveSendDevice: async () => ({ index: 4, name: 'CABLE Input (VB-Audio Virtual Cable)' }),
    buildSystemPrompt: () => 'SYS-PROMPT',
    vadClass: VAD,
    cfg: { loopbackDevice: '扬声器 (Realtek)', sendDeviceMatch: 'CABLE Input', vad: { silenceMs: 120, preBufferMs: 60, minSpeechMs: 90, maxSegmentMs: 5000, speechDb: -50 }, ...(overrides.cfg || {}) }
  });
  return { session, rec };
}

const speakTo = (script = [silence(120), tone(300), silence(300)]) => {
  const r = FakeReceiver.last;
  for (const buf of script) r.feed(buf);
};

await checkAsync('完整一轮：语音→ASR→LLM(带人设+历史)→TTS→播放→回到 listening', async () => {
  const { session, rec } = makeSession();
  const events = [];
  session.on('turn', (t) => events.push(t));
  await session.start();
  assert.equal(session.state, 'listening');
  assert.ok(session.callId, 'start 后应有 callId');
  speakTo();
  await waitFor(() => session.state === 'speaking' && rec.log.playback.length === 1);
  rec.gates[0]();   // 放行播放完成
  await waitFor(() => session.state === 'listening');
  assert.equal(events.filter((e) => e.kind === 'user').length, 1);
  assert.equal(events.filter((e) => e.kind === 'reply').length, 1);
  assert.equal(rec.log.playback[0].deviceId, 4, '播放应发到发送设备');
  assert.equal(rec.log.asrCalls[0].toString('ascii', 0, 4), 'RIFF', 'asr 契约：必须收到 WAV（裸 PCM 应在 session 包头）');
  assert.equal(rec.log.ttsCalls[0], '嗨，我在呢。');
  assert.equal(rec.log.llmCalls[0][0].role, 'system');
  assert.equal(rec.log.llmCalls[0][0].content, 'SYS-PROMPT');
  assert.equal(rec.log.llmCalls[0][rec.log.llmCalls[0].length - 1].content, '你好呀');
  assert.equal(session.history.length, 2, 'user+assistant 各一条');
  assert.equal(session.stats.turns, 1);
  await session.stop('用例结束');
});

await checkAsync('挂断后迟到结果丢弃：thinking 中 stop → LLM 迟到也不播、不进历史', async () => {
  let releaseLlm;
  const { session, rec } = makeSession({
    llm: () => new Promise((res) => { releaseLlm = res; })
  });
  await session.start();
  speakTo();
  await waitFor(() => session.state === 'thinking');
  await session.stop('挂断测试');
  assert.equal(session.state, 'idle');
  releaseLlm('迟到回复');
  await sleep(120);
  assert.equal(rec.log.playback.length, 0, '迟到结果不得播放');
  assert.equal(session.history.length, 0, '迟到结果不得进历史');
  assert.equal(session.callId, null);
});

await checkAsync('打断（barge-in）：speaking 中持续开口 → 停播 + 未播回复撤出历史 + 回 listening', async () => {
  const { session, rec } = makeSession();
  const events = [];
  session.on('turn', (t) => events.push(t));
  await session.start();
  speakTo();
  await waitFor(() => session.state === 'speaking');
  assert.equal(session.history.length, 2, '回复已生成（user+assistant）');
  FakeReceiver.last.feed(tone(300));   // 持续开口 300ms ≥ 250ms 触发线
  await waitFor(() => session.state === 'listening');
  assert.equal(rec.abortedCount, 1, '正在播放必须被 abort');
  assert.ok(events.some((e) => e.kind === 'barge_in'), '应有 barge_in 事件');
  assert.equal(session.history.length, 1, '未播出的回复应撤出历史（user 保留）');
  assert.equal(session.history[0].role, 'user');
  assert.equal(session.stats.bargeIns, 1);
  // 打断后立刻能接新一轮
  speakTo();
  await waitFor(() => session.state === 'speaking' && rec.log.playback.length === 2);
  rec.gates[1]();
  await waitFor(() => session.state === 'listening');
  await session.stop('用例结束');
});

await checkAsync('打断关闭（bargeIn=false）：speaking 中说话走丢弃（v1 半双工语义）', async () => {
  const { session, rec } = makeSession({ cfg: { bargeIn: false } });
  const events = [];
  session.on('turn', (t) => events.push(t));
  await session.start();
  speakTo();
  await waitFor(() => session.state === 'speaking');
  speakTo();          // 机器人说话时开口 → 丢弃（不触发打断）
  await waitFor(() => session.stats.dropped >= 1);
  assert.ok(events.some((e) => e.kind === 'dropped'));
  assert.ok(!events.some((e) => e.kind === 'barge_in'), 'bargeIn=false 不应有打断');
  rec.gates[0]();     // 放行播放
  await waitFor(() => session.state === 'listening');
  assert.equal(rec.log.playback.length, 1, '丢弃段不得触发第二轮');
  await session.stop('用例结束');
});

await checkAsync('设备掉线：取消在播轮次（abort 被调）+ state=error + 可立即重开', async () => {
  const { session, rec } = makeSession();
  await session.start();
  speakTo();
  await waitFor(() => session.state === 'speaking');
  FakeReceiver.last.emit('error', { reason: '收音中断（模拟拔线）' });
  await waitFor(() => session.state === 'error');
  assert.equal(rec.abortedCount, 1, '正在播放的轮次应被 abort');
  assert.ok(session.stats.errors.some((s) => /模拟拔线/.test(s)));
  // error 态可立即重开
  await session.start();
  assert.equal(session.state, 'listening');
  assert.notEqual(session.callId, null);
  await session.stop('用例结束');
});

await checkAsync('模型输出元格式残留 → 消毒后为空 → 不 TTS 不污染历史，回 listening', async () => {
  const { session, rec } = makeSession({ llm: async () => '[user]\n[assistant]\nno reply needed' });
  const events = [];
  session.on('turn', (t) => events.push(t));
  await session.start();
  speakTo();
  await waitFor(() => session.state === 'listening' && events.some((e) => e.kind === 'no_reply'));
  assert.equal(rec.log.ttsCalls.length, 0, '元残留不得 TTS');
  assert.equal(rec.log.playback.length, 0);
  assert.deepEqual(session.history.map((h) => h.role), ['user'], '只留 user，assistant 噪音不入历史');
  await session.stop('用例结束');
});

await checkAsync('单轮失败（ASR 失败）不拆通话：回到 listening 继续', async () => {
  const { session } = makeSession({ asr: async () => ({ ok: false, reason: 'http-502' }) });
  const events = [];
  session.on('turn', (t) => events.push(t));
  await session.start();
  speakTo();
  await waitFor(() => session.state === 'listening' && events.some((e) => e.kind === 'asr_failed'));
  assert.equal(session.stats.asrFail, 1);
  assert.equal(session.history.length, 0, '失败轮不得污染历史');
  await session.stop('用例结束');
});

await checkAsync('stop 幂等：未开始就停 / 连续多次停都不炸', async () => {
  const { session } = makeSession();
  await session.stop('未开始就停');   // idle → no-op
  await session.start();
  await session.stop('一次');
  await session.stop('二次');          // 幂等
  assert.equal(session.state, 'idle');
  await session.start();
  await session.stop('三次');
});

check('CALL_STATES 完整性', () => {
  assert.deepEqual([...CALL_STATES].sort(), ['ending', 'error', 'idle', 'listening', 'speaking', 'thinking'].sort());
});

console.log(bad ? `\n${bad} 项失败\n` : '\n全部通过\n');
process.exit(bad ? 1 : 0);
