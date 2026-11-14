// 语音通话 · 音频桥（Phase 0 探针）。
//
// 收发两路，拓扑见 doc（Phase 1 后补）：
//   接收通道 B：QQ 扬声器 → 虚拟播放端点 B → 对应录音端点 B → 这里收音。
//     实现：ffmpeg dshow 采集 → 16k/mono/s16le PCM 流（ASR 直接可用的口径）。
//   发送通道 A：这里播放 → 虚拟播放端点 A → QQ 麦克风。
//     实现：winmm waveOut 指定设备播放 WAV（native/waveout.cs）。
//
// 设计要点（评审提示词采纳项）：
//   · 设备掉线 → ffmpeg 非零退出 / 无数据退出，Receiver 报 'error'，绝不静默切换
//   · stop() 幂等，重复调用安全；杀进程留 stderr 尾巴作为原因
//   · spawnFn 可注入 —— 密闭测试全走假进程，不碰真音频设备
//
// ⚠️ 待验证（Phase 1 实测）：QQ 通话设置能否分别选择这两路设备；
// 虚拟声卡下 waveOut 播放是否真的进入 QQ 麦克风。

import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NATIVE_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'native');
const WAVEOUT_PS1 = path.join(NATIVE_DIR, 'waveout.ps1');
const POWERSHELL = 'powershell.exe';

const DEFAULT_FFMPEG = 'ffmpeg';
const ERR_NO_DATA = '收音通道无数据（设备未打开或不匹配）';

/**
 * 流式 s16le 重采样器（线性插值，跨 chunk 保持相位连续）。
 * push(s16le mono @fromRate) → s16le mono @toRate。
 */
export class S16Resampler {
  constructor({ fromRate, toRate = 16000 } = {}) {
    this.fromRate = fromRate;
    this.toRate = toRate;
    this.#pending = [];
    this.#pos = 0;
  }

  push(buf) {
    if (this.fromRate === this.toRate) return buf;          // 同率直通
    const nIn = Math.floor(buf.length / 2);
    for (let i = 0; i < nIn; i++) this.#pending.push(buf.readInt16LE(i * 2));
    const out = [];
    while (this.#pos + 1 < this.#pending.length) {
      const i0 = Math.floor(this.#pos);
      const frac = this.#pos - i0;
      const s = this.#pending[i0] * (1 - frac) + this.#pending[i0 + 1] * frac;
      out.push(Math.max(-32768, Math.min(32767, Math.round(s))));
      this.#pos += this.fromRate / this.toRate;
    }
    const consumed = Math.floor(this.#pos);
    if (consumed > 0) {
      this.#pending.splice(0, consumed);
      this.#pos -= consumed;
    }
    const res = Buffer.allocUnsafe(out.length * 2);
    for (let i = 0; i < out.length; i++) res.writeInt16LE(out[i], i * 2);
    return res;
  }

  #pending; #pos;
}

/**
 * 接收通道：对指定音源持续采集 PCM，统一产出 16k mono s16le。
 * mode='dshow'（默认）：ffmpeg dshow 采集录音设备（虚拟电缆的录音端）。
 * mode='loopback'：waveout.ps1 WASAPI 回环捕获一个播放端点（如 QQ 通话扬声器
 *   指到的闲置 Realtek），stderr 首行 #loopback rate=… 自动重采样到 16k。
 * 事件：
 *   'level' (info) —— 每 ~120ms 一次 { rms, db, windowBytes }
 *   'chunk' (buf)  —— PCM（s16le mono 16k）
 *   'error' ({ reason }) —— 设备失败/掉线（stderr 尾巴作为原因）
 *   'exit'  ({ code })   —— 进程退出（正常 stop 后也发，reason 为空）
 */
export class Receiver extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.deviceName = String(opts.deviceName || '').trim();
    this.mode = opts.mode === 'loopback' ? 'loopback' : 'dshow';
    this.ffmpegCmd = opts.ffmpegCmd || DEFAULT_FFMPEG;
    this.powershell = opts.powershell || POWERSHELL;
    this.sampleRate = opts.sampleRate || 16000;
    // 无数据看门狗只适用 dshow（麦克风静音也持续出包；无包=真坏了）。
    // loopback 端点完全空闲时 WASAPI 一个包都不吐——那是"没人说话"，不是故障
    // （真故障时 C# 辅助会带错误码退出，走 close→error 路径），默认禁用。
    this.noDataMs = opts.noDataMs ?? (this.mode === 'loopback' ? 0 : 3000);
    this.spawnFn = opts.spawnFn || spawn;          // 测试注入点
    this.onChunk = opts.onChunk || null;
    this.startedAt = 0;
    this.bytes = 0;
    this.#winSum = 0; this.#winN = 0; this.#winBytes = 0;
    this.#stderrTail = [];
    this.#stopping = false;
    this.#stopped = false;
    this.#child = null;
    this.#timer = null;
  }

  get running() { return !!this.#child && this.#child.exitCode === null; }
  /** 实际输入采样率（loopback 模式从 stderr 头解析，dshow 恒为 sampleRate）。 */
  get inRate() { return this.#inRate; }

  start() {
    if (!this.deviceName) throw new Error('未指定录音设备');
    if (this.running) return;
    this.#stopped = false;
    this.#stopping = false;
    this.bytes = 0;
    this.startedAt = Date.now();
    this.#stderrTail = [];
    this.#winSum = 0; this.#winN = 0; this.#winBytes = 0;
    this.#inRate = this.sampleRate;
    this.#rs = new S16Resampler({ fromRate: this.sampleRate, toRate: this.sampleRate });  // 同率直通占位，读到真实率后重建
    let program, args;
    if (this.mode === 'loopback') {
      program = this.powershell;
      args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', WAVEOUT_PS1, '-Action', 'loop', '-Device', this.deviceName];
    } else {
      program = this.ffmpegCmd;
      args = [
        '-hide_banner', '-loglevel', 'info',
        '-f', 'dshow', '-i', `audio=${this.deviceName}`,
        '-ac', '1', '-ar', String(this.sampleRate),
        '-f', 's16le', 'pipe:1'
      ];
    }
    this.#child = this.spawnFn(program, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    this.#child.stdout?.on('data', (buf) => this.#onPcm(buf));
    this.#child.stderr?.on('data', (d) => this.#onErr(d));
    this.#child.on('error', (e) => this.#fail(`无法启动采集程序（${program}）：${e.message}`));
    this.#child.on('close', (code, signal) => this.#onClose(code, signal));
    // 无 PCM 兜底：仅 dshow 启用（loopback 空闲=正常静音，见构造函数注释）。
    // 注意先报错误再 stop —— stop 会置 #stopped，吞掉 #fail（真实踩过）。
    if (this.noDataMs > 0) {
      this.#noDataTimer = setTimeout(() => {
        if (this.bytes === 0 && this.running) {
          this.#fail(ERR_NO_DATA);
          this.stop();
        }
      }, this.noDataMs);
    }
    // 电平窗口 ~120ms
    this.#timer = setInterval(() => {
      if (this.#winN > 0) {
        const rms = Math.sqrt(this.#winSum / this.#winN);
        const db = Math.max(-120, 20 * Math.log10(rms / 32768 || 1e-10));
        this.emit('level', { rms, db: Math.round(db * 10) / 10, windowBytes: this.#winBytes });
        this.#winSum = 0; this.#winN = 0; this.#winBytes = 0;
      }
    }, 120);
  }

  /** 停止采集；幂等。返回 { bytes, durationMs }。 */
  stop() {
    const stats = { bytes: this.bytes, durationMs: this.startedAt ? Date.now() - this.startedAt : 0 };
    this.#stopping = true;
    clearTimeout(this.#noDataTimer); this.#noDataTimer = null;
    clearInterval(this.#timer); this.#timer = null;
    if (this.#child) {
      try { this.#child.kill(); } catch { /* ignore */ }
      this.#child = null;
    }
    this.#stopped = true;
    return stats;
  }

  // ---- 内部 ----
  #child = null; #timer = null; #noDataTimer = null;
  #winSum = 0; #winN = 0; #winBytes = 0;
  #inRate = 16000; #rs = null;
  #stderrTail = []; #stopping = false; #stopped = false; #lastFailReason = '';

  #onErr(d) {
    // loopback 模式：从 stderr 首行解析真实采样率（#loopback rate=48000 ch=2 bits=32）
    const m = /#loopback rate=(\d+)/.exec(String(d));
    if (m) {
      const rate = Number(m[1]);
      if (rate > 0 && rate !== this.#inRate) {
        this.#inRate = rate;
        this.#rs = new S16Resampler({ fromRate: rate, toRate: this.sampleRate });
      }
    }
    this.#pushErr(d);
  }

  #onPcm(buf) {
    if (!buf?.length) return;
    if (this.mode === 'loopback') buf = this.#rs.push(buf);   // 任意率 → 16k
    if (!buf.length) return;
    this.bytes += buf.length;
    this.#winBytes += buf.length;
    // s16le → 每 2 字节一个样本；RMS 分母按样本数（跨 chunk 的奇数尾巴丢弃到下个窗口）
    const samples = Math.floor(buf.length / 2);
    if (samples > 0) {
      for (let i = 0; i < samples * 2; i += 2) {
        const v = buf.readInt16LE(i);
        this.#winSum += v * v;
        this.#winN++;
      }
    }
    this.emit('chunk', buf);
    try { this.onChunk?.(buf); } catch { /* 消费方异常不影响采集 */ }
  }

  #pushErr(d) {
    this.#stderrTail.push(String(d).trim());
    if (this.#stderrTail.length > 20) this.#stderrTail.shift();
  }

  #onClose(code, signal) {
    clearInterval(this.#timer); this.#timer = null;
    clearTimeout(this.#noDataTimer); this.#noDataTimer = null;
    this.#child = null;
    if (this.#stopped || this.#stopping) {
      this.emit('exit', { code, reason: '' });
      return;
    }
    // 非人为停止：设备失败/掉线
    const tail = this.#stderrTail.filter((l) => l).slice(-3).join(' | ');
    const reason = this.bytes === 0 ? ERR_NO_DATA : `收音中断（exit ${code}${signal ? `, ${signal}` : ''}）：${tail || '无 ffmpeg 输出'}`;
    this.emit('error', { reason });
    this.emit('exit', { code, reason });
  }

  #fail(reason) {
    if (this.#stopped) return;
    this.#lastFailReason = reason;
    this.emit('error', { reason });
  }
}

/** 生成测试音 WAV（正弦波，16bit 单声道）。 */
export function makeToneWav({ seconds = 2, freq = 440, rate = 24000, amp = 0.3 } = {}) {
  const n = Math.floor(rate * seconds);
  const pcm = Buffer.alloc(n * 2);
  const amp16 = Math.max(0, Math.min(1, amp)) * 32767;
  for (let i = 0; i < n; i++) {
    // 短淡入淡出，避免爆音
    const fade = Math.min(1, i / (rate * 0.02), (n - i) / (rate * 0.02));
    const v = Math.round(Math.sin(2 * Math.PI * freq * i / rate) * amp16 * fade);
    pcm.writeInt16LE(v, i * 2);
  }
  return pcmToWav(pcm, rate, 1);
}

/** 裸 PCM（s16le）包上 WAV 头。 */
export function pcmToWav(pcm, rate = 16000, channels = 1) {
  const bitsPerSample = 16;
  const blockAlign = channels * bitsPerSample / 8;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);                       // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * blockAlign, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

/** 计算 PCM 的 RMS 电平（探针/测试共用）。返回 { rms, db }。 */
export function pcmRms(buf) {
  const samples = Math.floor(buf.length / 2);
  if (!samples) return { rms: 0, db: -120 };
  let sum = 0;
  for (let i = 0; i < samples * 2; i += 2) {
    const v = buf.readInt16LE(i);
    sum += v * v;
  }
  const rms = Math.sqrt(sum / samples);
  const db = Math.max(-120, 20 * Math.log10(rms / 32768 || 1e-10));
  return { rms, db: Math.round(db * 10) / 10 };
}

/**
 * 向指定 waveOut 设备播放一个 WAV 文件（阻塞到播完或失败）。
 * deviceId=-1 表示系统默认（WAVE_MAPPER）。
 */
export function playWavToDevice({ wavPath, deviceId = -1, psScript = WAVEOUT_PS1, powershell = 'powershell.exe', spawnFn = null, timeoutMs = 180000 } = {}) {
  const doSpawn = spawnFn || spawn;
  return new Promise((resolve, reject) => {
    let err = '', out = '', child;
    try {
      child = doSpawn(powershell, [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript,
        '-Action', 'play', '-WavPath', wavPath, '-DeviceId', String(deviceId)
      ], { windowsHide: true });
    } catch (e) {
      reject(new Error(`无法启动播放辅助（${powershell}）：${e.message}`));
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* ignore */ }
      reject(new Error('播放超时（辅助进程未按时退出）'));
    }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); reject(new Error(`播放辅助启动失败：${e.message}`)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve({ out });
      else reject(new Error(`播放失败（exit ${code}）：${(err || out).trim().slice(0, 300)}`));
    });
  });
}

export const AUDIO_BRIDGE_VERSION = '0.2.0-phase2';

/**
 * 可中断的 WAV 播放（通话专用）：返回 { done, abort }。
 * done → { ok, reason }；abort() 杀辅助进程并清理临时文件（挂断/打断用）。
 * 临时 WAV 写 os.tmpdir()，播完/被杀后删除，不落任何持久目录。
 */
export function startWavPlayback({ wav, deviceId = -1, psScript = WAVEOUT_PS1, powershell = 'powershell.exe', spawnFn = null } = {}) {
  const doSpawn = spawnFn || spawn;
  const tmp = path.join(os.tmpdir(), `qqa-call-play-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`);
  const cleanup = () => { try { fs.unlinkSync(tmp); } catch { /* ignore */ } };
  let child;
  try {
    fs.writeFileSync(tmp, wav);
    child = doSpawn(powershell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript,
      '-Action', 'play', '-WavPath', tmp, '-DeviceId', String(deviceId)
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    cleanup();
    return { done: Promise.resolve({ ok: false, reason: `播放启动失败：${e?.message ?? e}` }), abort() { } };
  }
  const done = new Promise((resolve) => {
    child.on('error', (e) => { cleanup(); resolve({ ok: false, reason: `播放进程错误：${e.message}` }); });
    child.on('close', (code) => { cleanup(); resolve({ ok: code === 0, reason: code === 0 ? '' : `exit ${code}` }); });
  });
  return { done, abort: () => { try { child.kill(); } catch { /* ignore */ } } };
}
