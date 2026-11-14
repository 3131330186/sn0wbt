// 语音通话 · VAD 断句（能量阈值法，零依赖）。
//
// 为什么不用 ML VAD：探针实测本机底噪极低（数字静音 -120dB / 模拟底噪 ≤-60dB），
// 说话峰值 -17dB，中间隔了 30dB+ —— 能量法足够稳，且可解释、可调参、可测试。
// 将来换 silero 只需替换这一个类，session 不感知。
//
// 设计（评审提示词采纳项）：
//   · 前置缓冲 preBufferMs —— 说话开始前的音频也保留，不吃第一个字
//   · 静音断句 silenceMs —— 连续静音判定说完
//   · 最长段 maxSegmentMs —— 强制切段（防止背景音撑爆 ASR）
//   · 最短段 minSpeechMs —— 咳嗽/碰麦这种碎屑直接丢弃（返回 null）
//   · reset() —— 通话重开时清状态

import { pcmRms } from './bridge.js';

export class VAD {
  constructor(opts = {}) {
    this.speechDb = Number(opts.speechDb ?? -45);        // 超过视为语音帧
    this.silenceMs = Number(opts.silenceMs ?? 700);      // 连续静音这么久 → 说完了
    this.preBufferMs = Number(opts.preBufferMs ?? 250);  // 语音起始前保留量
    this.minSpeechMs = Number(opts.minSpeechMs ?? 300);  // 短于这个的段丢弃
    this.maxSegmentMs = Number(opts.maxSegmentMs ?? 15000);
    this.frameMs = Number(opts.frameMs ?? 30);
    this.sampleRate = Number(opts.sampleRate ?? 16000);
    this.onDebug = opts.onDebug || null;                 // (info) => void，探针/调试用
    this.reset();
  }

  reset() {
    this.#pending = Buffer.alloc(0);
    this.#prebuf = [];                    // 帧 Buffer 数组（语音开始前）
    this.#prebufFrames = 0;
    this.#state = 'idle';                 // idle | speech
    this.#segment = [];
    this.#segmentMs = 0;
    this.#silentMs = 0;
    this.#speechMs = 0;
  }

  #pending; #prebuf; #prebufFrames; #state; #segment; #segmentMs; #silentMs; #speechMs;

  get frameBytes() { return Math.floor(this.sampleRate * this.frameMs / 1000) * 2; }
  get prebufCapacity() { return Math.max(1, Math.round(this.preBufferMs / this.frameMs)); }

  /** 喂 16k mono s16le PCM；断句完成时返回 { pcm, reason: 'silence'|'maxlen' }，否则 null。 */
  push(buf) {
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, buf]) : buf;
    const fb = this.frameBytes;
    let result = null;
    while (this.#pending.length >= fb) {
      const frame = this.#pending.subarray(0, fb);
      this.#pending = this.#pending.subarray(fb);
      result = this.#frame(frame) || result;
    }
    return result;
  }

  #frame(frame) {
    const { db } = pcmRms(frame);
    const isSpeech = db > this.speechDb;
    this.onDebug?.({ db, isSpeech, state: this.#state });

    if (this.#state === 'idle') {
      this.#prebuf.push(frame);
      this.#prebufFrames++;
      if (this.#prebufFrames > this.prebufCapacity) {
        this.#prebuf.shift();
        this.#prebufFrames--;
      }
      if (isSpeech) {
        this.#state = 'speech';
        this.#segment = [...this.#prebuf, frame];
        this.#segmentMs = this.#segment.length * this.frameMs;
        this.#speechMs = this.frameMs;
        this.#silentMs = 0;
      }
      return null;
    }

    // state === 'speech'
    this.#segment.push(frame);
    this.#segmentMs += this.frameMs;
    if (isSpeech) {
      this.#speechMs += this.frameMs;
      this.#silentMs = 0;
    } else {
      this.#silentMs += this.frameMs;
    }

    // 最长段强制切（不修剪尾部静音，尽量保留刚说的内容）
    if (this.#segmentMs >= this.maxSegmentMs) {
      return this.#emit('maxlen');
    }
    // 静音断句：修剪掉尾部静音（留 120ms 自然收尾）
    if (this.#silentMs >= this.silenceMs) {
      const trimFrames = Math.max(0, Math.round(this.silenceMs / this.frameMs) - Math.round(120 / this.frameMs));
      if (trimFrames > 0) this.#segment.splice(this.#segment.length - trimFrames, trimFrames);
      return this.#emit('silence');
    }
    return null;
  }

  #emit(reason) {
    const pcm = Buffer.concat(this.#segment);
    const durationMs = Math.round(pcm.length / 2 / this.sampleRate * 1000);
    const speechMs = this.#speechMs;
    this.#state = 'idle';
    this.#segment = [];
    this.#segmentMs = 0;
    this.#speechMs = 0;
    this.#silentMs = 0;
    // 碎屑判定按【实际有声时长】，不按段总时长——总时长会被前置缓冲和
    // 尾部静音撑大（150ms 噪声 + 60ms 预缓冲 + 120ms 静音 ≈ 330ms，曾因此漏放）
    if (speechMs < this.minSpeechMs) return null;
    return { pcm, reason, durationMs, speechMs };
  }
}

/**
 * 起音检测器（打断用）：只回答一个布尔——"对方确实开口了"。
 * 连续 minMs 毫秒超阈值才触发（单帧噪声/碰麦不算），触发一次后自动重置。
 * 打断的回声问题在本拓扑里被架构性排除（TTS 不经过接收通道），
 * 这里的持续时长要求防的是 QQ 提示音/环境噪声的瞬时尖峰。
 */
export class SpeechOnset {
  constructor(opts = {}) {
    this.speechDb = Number(opts.speechDb ?? -45);
    this.minMs = Number(opts.minMs ?? 250);
    this.frameMs = Number(opts.frameMs ?? 30);
    this.sampleRate = Number(opts.sampleRate ?? 16000);
    this.#runMs = 0;
    this.#pending = Buffer.alloc(0);
  }

  #runMs; #pending;

  reset() { this.#runMs = 0; this.#pending = Buffer.alloc(0); }

  /** 喂 PCM；检测到持续语音返回 true（此后自动归零，可再次触发）。 */
  push(buf) {
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, buf]) : buf;
    const fb = Math.floor(this.sampleRate * this.frameMs / 1000) * 2;
    let hit = false;
    while (this.#pending.length >= fb) {
      const frame = this.#pending.subarray(0, fb);
      this.#pending = this.#pending.subarray(fb);
      const { db } = pcmRms(frame);
      if (db > this.speechDb) {
        this.#runMs += this.frameMs;
        if (this.#runMs >= this.minMs) { hit = true; this.#runMs = 0; }
      } else {
        this.#runMs = 0;   // 连续性被打断就归零（要求"持续"开口）
      }
    }
    return hit;
  }
}
