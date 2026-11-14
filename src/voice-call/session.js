// 语音通话 · 会话状态机（Phase 2 核心）。
//
// 一通电话 = 一个 callId；一轮对话 = 一个 turnId + AbortController。
// 中止纪律（沿用 v0.6.1 评审修复的口径，评审提示词第 5 节逐条落地）：
//   · 每个异步结果在使用前先过 #turnFresh —— callId 变了 / turnId 过期 / 已 abort
//     的结果一律丢弃（供应商接口不可取消时，也必须丢弃迟到结果）
//   · stop() / 设备掉线 → 取消当前轮（LLM signal + 播放 abort）→ 统一清理
//   · 清理幂等：stop 重复调用安全；结束后可立即再开一通
//
// v1 语义（诚实标注）：半双工顺序对话 —— 机器人说话期间用户开口会被丢弃
// （事件 'turn' kind=dropped 会上报）。打断（barge-in）是 Phase 3。
//
// 全部外部依赖可注入（测试用假件跑全流程，不碰真音频/真网络）：
//   createReceiver / asr / llm / tts / startPlayback / resolveSendDevice / buildSystemPrompt

import { EventEmitter } from 'node:events';
import { Receiver, startWavPlayback, pcmToWav } from './bridge.js';
import { VAD, SpeechOnset } from './vad.js';
import { transcribeWav } from '../speech/asr.js';
import { synthesize } from '../speech/tts.js';
import { chatCompletion } from '../llm.js';
import { listPlaybackDevices } from './audio-devices.js';
import { buildSystemPrompt } from '../prompt.js';

export const CALL_STATES = ['idle', 'listening', 'thinking', 'speaking', 'ending', 'error'];

const HISTORY_CAP = 24;   // 条数上限（user+assistant 合计）

const CALL_RULES = [
  '【当前是实时语音通话场景】',
  '- 你正在和人打电话：用自然口语、短句回答，一次不超过两三句（60 字以内），说完就停，把话头交回对方',
  '- 对方只能"听"到你：禁止 markdown、列表、代码块、emoji、颜文字和链接',
  '- 直接以角色身份开口说话。绝对不要输出 [user]、[assistant] 这类对话格式标记，也不要输出 "no reply needed" 之类的免打扰元指令——这里是电话，每一句都会被念出声',
  '- 没听清就自然地确认（例如「诶？没听清，再说一遍？」），不要假装听懂',
  '- 可以用（笑）（叹气）（吸气）这类语气标记，念出来更自然'
].join('\n');

/**
 * 通话回复消毒：剥掉模型偶发的元格式残留（[user]/[assistant]/no reply needed
 * 等"群聊免打扰"机制泄漏——实测 2026-11-04 首通就念出来过，来源不在本仓任何
 * 提示层，属模型侧残留，边界上加保险丝）。剥完为空 = 这轮不说话。
 * 只处理整行标记，不动正文里的正常内容。
 */
export function sanitizeCallReply(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const kept = lines.filter((line) => {
    const t = line.trim();
    if (!t) return true;
    if (/^\[(user|assistant|system|bot)[^\]]*\]$/i.test(t)) return false;   // 整行格式标记
    if (/^no reply needed\b/i.test(t) && t.length <= 40) return false;      // 免打扰元指令行
    return true;
  });
  return kept.join('\n').trim();
}

// ---- 默认实现（可被 deps 覆盖）----

async function defaultLlm(messages, { signal } = {}) {
  // chatCompletion 返回归一化结构 { message, finishReason, usage, ... }（非原始 choices）
  const j = await chatCompletion({ messages, signal });
  return String(j?.message?.content ?? '').trim();
}

async function defaultTts(text) {
  return synthesize({ text, timeoutMs: 30000 });
}

async function defaultResolveSendDevice({ match = 'CABLE Input' } = {}) {
  const devices = await listPlaybackDevices();
  const hit = devices.find((d) => d.name.startsWith(match) && !/16ch/i.test(d.name));
  return hit ? { index: hit.index, name: hit.name } : null;
}

export class VoiceCallSession extends EventEmitter {
  constructor(deps = {}) {
    super();
    this.deps = {
      createReceiver: deps.createReceiver || ((opts) => new Receiver(opts)),
      onsetClass: deps.onsetClass || SpeechOnset,
      asr: deps.asr || ((pcm) => transcribeWav(pcm)),
      llm: deps.llm || defaultLlm,
      tts: deps.tts || defaultTts,
      startPlayback: deps.startPlayback || (({ wav, deviceId }) => startWavPlayback({ wav, deviceId })),
      resolveSendDevice: deps.resolveSendDevice || defaultResolveSendDevice,
      buildSystemPrompt: deps.buildSystemPrompt || (() => buildSystemPrompt({ extraSections: [CALL_RULES] })),
      vadClass: deps.vadClass || VAD,
      cfg: deps.cfg || {}
    };
    this.state = 'idle';
    this.callId = null;
    this.history = [];          // [{ role, content }]，通话内独立上下文
    this.startedAt = 0;
    this.sendDevice = null;
    this.stats = { turns: 0, dropped: 0, asrFail: 0, bargeIns: 0, errors: [] };
    this.#receiver = null;
    this.#vad = null;
    this.#turn = null;          // { id, callId, controller, playback }
    this.#turnSeq = 0;
  }

  #receiver; #vad; #onset; #turn; #turnSeq;

  get canStart() { return this.state === 'idle' || this.state === 'error'; }
  get inCall() { return this.state !== 'idle' && this.state !== 'error'; }

  /** 开一通电话（接听后调用）。成功 → state='listening'。 */
  async start() {
    if (!this.canStart) throw new Error(`当前状态不可开始（${this.state}）——先结束当前通话`);
    const send = await this.deps.resolveSendDevice({ match: this.deps.cfg.sendDeviceMatch || 'CABLE Input' });
    if (!send) throw new Error('未找到发送设备（CABLE Input）——确认 VB-Cable 已安装且名称匹配');
    this.sendDevice = send;
    this.callId = `call-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
    this.history = [];
    this.startedAt = Date.now();
    this.stats = { turns: 0, dropped: 0, asrFail: 0, bargeIns: 0, errors: [] };

    const vc = this.deps.cfg;
    if (!String(vc.loopbackDevice || '').trim()) throw new Error('未配置接收设备（voiceCall.loopbackDevice）——先在探针里选好或写进配置');
    this.#vad = new this.deps.vadClass(vc.vad || {});
    // 打断检测（barge-in）：v1 拓扑下 TTS 不经过接收通道，串音被架构性排除；
    // 持续 250ms 开口才算（防 QQ 提示音/环境噪声瞬时尖峰）
    this.#onset = vc.bargeIn === false ? null : new this.deps.onsetClass({
      speechDb: (vc.vad && vc.vad.speechDb) ?? -45,
      minMs: 250
    });
    this.#receiver = this.deps.createReceiver({
      mode: 'loopback',
      deviceName: vc.loopbackDevice,
      onChunk: (buf) => this.#onPcm(buf)
    });
    this.#receiver.on('error', ({ reason }) => this.#onDeviceError(reason));
    this.#receiver.start();
    this.#setState('listening');
    return { callId: this.callId, sendDevice: send };
  }

  /** 挂断（用户点击/异常兜底）。幂等；结束后可立即再开。 */
  async stop(reason = '') {
    if (this.state === 'idle') return;
    this.#setState('ending', { reason });
    this.#cancelTurn('通话结束');
    this.#vad = null;
    if (this.#receiver) {
      const r = this.#receiver;
      this.#receiver = null;
      try { r.stop(); } catch { /* ignore */ }
    }
    this.callId = null;   // 所有在途异步结果的 callId 校验从此失效
    this.#setState('idle', { reason });
  }

  /** 通话内追加一条系统提示（如临时指令）；测试也用它注入脚本化对话。 */
  pushHistory(role, content) {
    this.history.push({ role, content });
    this.#capHistory();
  }

  // ---- 内部 ----

  #onPcm(buf) {
    if (!this.#vad) return;
    // 打断（barge-in）：speaking/thinking 期间确认对方开口 → 掐断当前轮回听。
    // 触发后同一块音频继续喂 VAD——起音前 250ms 的内容靠 VAD 前置缓冲语义接住，
    // 不吃用户第一个字。
    if ((this.state === 'speaking' || this.state === 'thinking') && this.#onset) {
      let onset = false;
      try { onset = this.#onset.push(buf); } catch { /* 检测失败不致断流 */ }
      if (onset) this.#bargeIn();
    }
    let seg = null;
    try { seg = this.#vad.push(buf); } catch { return; }
    if (!seg) return;
    if (this.state !== 'listening') {
      this.stats.dropped++;
      this.emit('turn', { kind: 'dropped', reason: this.state, durationMs: seg.durationMs });
      return;
    }
    this.#runTurn(seg).catch(() => { /* #runTurn 内部已兜底 */ });
  }

  /** 用户开口打断：停播、取消在途轮、修剪"没播出去的回复"、回到聆听。 */
  #bargeIn() {
    this.stats.bargeIns = (this.stats.bargeIns || 0) + 1;
    this.#cancelTurn('用户开口，打断当前轮');
    this.#vad?.reset();
    this.#setState('listening', { bargeIn: true });
    this.emit('turn', { kind: 'barge_in' });
  }

  async #runTurn(segment) {
    if (!this.inCall) return;
    const turnId = ++this.#turnSeq;
    const callIdAtStart = this.callId;
    const controller = new AbortController();
    this.#turn = { id: turnId, callId: callIdAtStart, controller, playback: null };
    const timings = {};
    this.#setState('thinking', { turnId });
    try {
      // 1) ASR（VAD 产出的是裸 PCM，包上 WAV 头再送识别——asr 的契约是 WAV Buffer）
      const t0 = Date.now();
      const asrRes = await this.deps.asr(pcmToWav(segment.pcm, 16000, 1));
      timings.asrMs = Date.now() - t0;
      if (!this.#turnFresh(turnId, callIdAtStart)) return;
      if (!asrRes.ok) {
        this.stats.asrFail++;
        this.emit('turn', { kind: 'asr_failed', turnId, reason: asrRes.reason, timings: { ...timings } });
        this.#turn = null;
        if (this.inCall) this.#setState('listening');
        return;
      }
      const userText = asrRes.text;
      this.emit('turn', { kind: 'user', turnId, text: userText, durationMs: segment.durationMs, timings: { ...timings } });

      // 2) LLM（带人设 + 通话历史 + signal 可取消）
      const messages = [
        { role: 'system', content: this.deps.buildSystemPrompt() },
        ...this.history,
        { role: 'user', content: userText }
      ];
      const t1 = Date.now();
      const reply = await this.deps.llm(messages, { signal: controller.signal });
      timings.llmMs = Date.now() - t1;
      if (!this.#turnFresh(turnId, callIdAtStart)) return;   // 迟到结果丢弃
      const clean = sanitizeCallReply(reply);
      if (!clean) {
        // 剥完元格式残留后为空 → 这轮不说话（不污染历史，不 TTS）
        this.emit('turn', { kind: 'no_reply', turnId, raw: String(reply).slice(0, 80), timings: { ...timings } });
        this.history.push({ role: 'user', content: userText });
        this.#capHistory();
        this.#turn = null;
        if (this.inCall) this.#setState('listening');
        return;
      }
      this.emit('turn', { kind: 'reply', turnId, text: clean, timings: { ...timings } });
      this.history.push({ role: 'user', content: userText }, { role: 'assistant', content: clean });
      this.#capHistory();
      if (this.#turn) this.#turn.repliedText = clean;   // 被打断时用于修剪"没播出去"的回复

      // 3) TTS → 4) 播放进通话
      this.#setState('speaking', { turnId });
      const t2 = Date.now();
      const ttsRes = await this.deps.tts(clean, { signal: controller.signal });
      timings.ttsMs = Date.now() - t2;
      if (!this.#turnFresh(turnId, callIdAtStart)) return;
      const play = this.deps.startPlayback({ wav: ttsRes.wav, deviceId: this.sendDevice.index });
      this.#turn.playback = play;
      const pr = await play.done;
      timings.playMs = 0;   // 播放时长≈音频时长，由 UI/日志按 wav 估算即可；这里记录成败
      if (!this.#turnFresh(turnId, callIdAtStart)) return;
      this.stats.turns++;
      this.emit('turn', { kind: 'done', turnId, timings: { ...timings }, playbackOk: pr.ok, playbackReason: pr.reason });
      this.#turn = null;
      if (this.inCall) this.#setState('listening');
    } catch (e) {
      if (!this.#turnFresh(turnId, callIdAtStart)) return;   // 已中止，静默
      this.stats.errors.push(String(e?.message ?? e));
      this.emit('turn', { kind: 'error', turnId, message: String(e?.message ?? e), timings: { ...timings } });
      this.#turn = null;
      if (this.inCall) this.#setState('listening');   // 单轮失败不拆通话
    }
  }

  #turnFresh(turnId, callId) {
    return this.callId === callId && this.#turn?.id === turnId && !this.#turn.controller.signal.aborted;
  }

  #cancelTurn(reason) {
    if (!this.#turn) return;
    // 打断场景：没播完（甚至没开播）的回复不能当作用户已经听过——从历史里
    // 撤掉，用户接下来说的话会得到全新回应（评审纪律：区分"生成了"和"播出了"）
    if (/打断/.test(reason) && this.#turn.repliedText) {
      const last = this.history[this.history.length - 1];
      if (last && last.role === 'assistant' && last.content === this.#turn.repliedText) this.history.pop();
    }
    try { this.#turn.controller.abort(new Error(reason)); } catch { /* ignore */ }
    try { this.#turn.playback?.abort?.(); } catch { /* ignore */ }
    this.#turn = null;
  }

  #onDeviceError(reason) {
    if (!this.inCall) return;
    this.stats.errors.push(`设备: ${reason}`);
    this.#cancelTurn('设备掉线');
    this.#vad = null;
    if (this.#receiver) {
      const r = this.#receiver;
      this.#receiver = null;
      try { r.stop(); } catch { /* ignore */ }
    }
    this.emit('device_error', { reason });
    this.#setState('error', { reason });
  }

  #capHistory() {
    while (this.history.length > HISTORY_CAP) this.history.shift();
  }

  #setState(s, detail) {
    this.state = s;
    this.emit('state', s, detail || {});
  }
}
