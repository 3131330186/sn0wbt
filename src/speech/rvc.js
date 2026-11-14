// RVC 音色转换层（说话/唱歌共用的"变声"一层）
//
// 为什么独立成模块（2026-11-06）：虚拟歌手声线的需求要求"说话和唱歌同一个
// 音色" —— 做法 = 两条路都汇到同一个 RVC 模型上：
//   唱歌：ACE-Step 出歌 → demucs 分离 → rvcConvert(虚拟歌手模型)
//   说话：任意 TTS 引擎出语音 → rvcConvert(同一个模型)
// 下游一致性由模型保证，源引擎随便换。
//
// 契约：
//   rvcConvert({ inputPath | wav, model, toolkitDir, normalize }) → Buffer
//     Applio infer（验收参数 rmvpe/pitch0/index0.75/protect0.33，见 singing.js
//     头注）→ afftdn 降噪 → normalize=true 时峰值归一 -3dB → 44100Hz wav
//   rvcConvertLocked(opts) = withGpuLock(() => rvcConvert(opts))
//     说话路径用这个（自带 GPU 互斥）；唱歌链在 withGpuLock 内部调裸版，
//     不要嵌套加锁（同一个 promise 链会死等）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';

function defaultRun(cmd, args, { cwd, timeoutMs = 300000 } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        code: err ? (err.code ?? 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || '')
      }));
  });
}

export const rvcDeps = {
  run: defaultRun,
};

// ── GPU 互斥锁：所有 Applio 推理（唱歌链/说话转换）串行过同一块显存 ──
// （实踩 2026-11-06：12G 卡 ACE-Step + RVC 并发必 OOM，唱歌链为此整链串行；
//   说话转换加入后统一走这把锁）
let _gpuQueue = Promise.resolve();
export function withGpuLock(fn) {
  const job = _gpuQueue.then(fn, fn);   // 前一个失败不堵后面
  _gpuQueue = job.then(() => undefined, () => undefined);
  return job;
}

/** 从训练产物里挑最高轮次的模型（文件名形如 <model>_<epoch>e_<steps>s.pth）。 */
export function pickModelPth(logDir, model) {
  const esc = model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${esc}_(\\d+)e_\\d+s\\.pth$`);
  let best = null, bestEpoch = -1;
  for (const f of fs.readdirSync(logDir)) {
    const m = f.match(re);
    if (m && Number(m[1]) > bestEpoch) { bestEpoch = Number(m[1]); best = f; }
  }
  return best ? path.join(logDir, best) : null;
}

/** WAV 峰值（0~1）；解析不了返回 null（调用方跳过归一，宁可不拦不误杀）。 */
export function wavPeak(buf) {
  if (!buf || buf.length < 44 || buf.slice(0, 4).toString('ascii') !== 'RIFF') return null;
  let off = 12, fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.slice(off, off + 4).toString('ascii');
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && size >= 16) {
      fmt = { tag: buf.readUInt16LE(off + 8), channels: buf.readUInt16LE(off + 10), bits: buf.readUInt16LE(off + 22) };
    } else if (id === 'data' && fmt) {
      const bytes = fmt.bits / 8;
      const frames = Math.floor(Math.min(size, buf.length - off - 8) / (bytes * fmt.channels));
      let peak = 0;
      for (let i = 0; i < frames; i++) {
        const o = off + 8 + i * bytes * fmt.channels;
        for (let c = 0; c < fmt.channels; c++) {
          let v;
          if (fmt.bits === 16 && fmt.tag === 1) v = Math.abs(buf.readInt16LE(o + c * 2)) / 32768;
          else if (fmt.bits === 32 && fmt.tag === 3) v = Math.abs(buf.readFloatLE(o + c * 4));
          else return null;
          if (v > peak) peak = v;
        }
      }
      return peak;
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

/**
 * RVC 音色转换（裸版，不加锁 —— 嵌套锁会死等，见头注）。
 * @param {object} opts
 * @param {string} [opts.inputPath] 输入 wav 路径（与 wav 二选一）
 * @param {Buffer} [opts.wav]      输入 wav 内容
 * @param {string} opts.model      RVC 模型名（logs/<model>/ 下训练产物）
 * @param {string} [opts.toolkitDir] D:/SVC-toolkit
 * @param {boolean} [opts.normalize] true=峰值归一 -3dB（清唱/说话）；false=保持原生
 *                                   增益（伴奏混音路径保持验收平衡）
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<Buffer>} 44100Hz wav（已降噪；normalize 时已归一）
 */
export async function rvcConvert({ inputPath = null, wav = null, model, toolkitDir = 'D:/SVC-toolkit', normalize = true, timeoutMs = 300000 }) {
  const applioDir = path.join(toolkitDir, 'Applio');
  const applioPy = path.join(applioDir, 'env', 'python.exe');
  const ffmpegExe = path.join(applioDir, 'ffmpeg.exe');
  const logDir = path.join(applioDir, 'logs', model);
  if (!fs.existsSync(applioPy)) throw new Error(`RVC 未就绪：缺 ${applioPy}（Applio 未装全）`);
  if (!fs.existsSync(ffmpegExe)) throw new Error(`RVC 未就绪：缺 ${ffmpegExe}（Applio 未装全）`);
  if (!fs.existsSync(logDir)) throw new Error(`RVC 未就绪：模型 ${model} 不存在（${logDir}）`);
  const pthPath = pickModelPth(logDir, model);
  if (!pthPath) throw new Error(`RVC 未就绪：${logDir} 里没有 ${model}_<轮次>e_*.pth 训练产物`);
  const indexPath = path.join(logDir, `${model}.index`);
  if (!fs.existsSync(indexPath)) throw new Error(`RVC 未就绪：索引缺失（${indexPath}），重跑 Applio index 步骤`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rvc-'));
  try {
    const inPath = inputPath || path.join(tmp, 'input.wav');
    if (!inputPath) fs.writeFileSync(inPath, wav);

    // Applio 推理（参数为验收组合，别凭感觉改；export-format 必须大写——实踩）
    const conv = await rvcDeps.run(applioPy, [
      'core.py', 'infer',
      '--input-path', inPath,
      '--output-path', path.join(tmp, 'converted.wav'),
      '--pth-path', pthPath,
      '--index-path', indexPath,
      '--f0-method', 'rmvpe',
      '--pitch', '0',
      '--index-rate', '0.75',
      '--protect', '0.33',
      '--export-format', 'WAV'
    ], { cwd: applioDir, timeoutMs });
    const convertedPath = path.join(tmp, 'converted.wav');
    if (conv.code !== 0 || !fs.existsSync(convertedPath)) {
      throw new Error(`RVC 音色转换失败（${model}）：${(conv.stderr || conv.stdout).slice(-300)}`);
    }

    // 出口：afftdn 降噪（电流音根治，用户 A/B 裁决）+ 可选峰值归一（-3dB，
    // 上限 +12dB 防止放大底噪）→ 44100Hz
    const peak = wavPeak(fs.readFileSync(convertedPath));
    const gainDb = normalize && peak && peak > 0
      ? Math.min(12, Math.max(0, 20 * Math.log10(0.7 / peak)))
      : 0;
    const outPath = path.join(tmp, 'final.wav');
    const post = await rvcDeps.run(ffmpegExe, [
      '-y', '-i', convertedPath,
      '-af', gainDb > 0.1 ? `afftdn=nr=12:nf=-25,volume=${gainDb.toFixed(1)}dB` : 'afftdn=nr=12:nf=-25',
      '-ar', '44100', outPath
    ], { cwd: tmp, timeoutMs: 60000 });
    if (post.code !== 0 || !fs.existsSync(outPath)) {
      throw new Error(`RVC 出口处理失败：${(post.stderr || post.stdout).slice(-200)}`);
    }
    const out = fs.readFileSync(outPath);
    if (out.length < 1000 || out.slice(0, 4).toString('ascii') !== 'RIFF') {
      throw new Error('RVC 输出不是合法 WAV');
    }
    return out;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉不致命 */ }
  }
}

/** 加锁版：说话路径（TTS 后变声）用这个，和唱歌链共用一把 GPU 锁。 */
export function rvcConvertLocked(opts) {
  return withGpuLock(() => rvcConvert(opts));
}
