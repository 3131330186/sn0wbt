// 语音转文字 —— 多引擎分发（与 TTS 同款适配器模式）。
//
// 分工：
//   transcribeWav   —— 纯 WAV → 文本（语音通话 / 各引擎 ASR 都走这里）
//   transcribeRecord —— OneBot record 段 → 取文件 → 转 WAV → 转写（群语音消息入口）
//
// 与 plugins/mimo-asr 的关系：插件是刻意自包含的（插件目录可能被重定向出仓库），
// 保留作兜底；onebot.js 的转写链路现在【核心适配器优先、插件次之】——
// 这样群语音转写能跟随 speech.format/asr.providerId 切换引擎，不再锁死 MiMo。
//
// 服务商：speech.asr.providerId（留空 = 跟随 TTS 服务商 speech.providerId）。
// 引擎能力：适配器声明 asr:false（如 MiniMax v1）→ 返回 adapter-no-asr，
//          调用方按需回退（UI 显示"转写✗"）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveSpeechEndpoint } from './tts.js';
import { resolveAdapter } from './adapters/index.js';
import { getConfig } from '../config.js';

const MAX_WAV_BYTES = 10 * 1024 * 1024;   // 10MB 上限（16k 单声道约 5 分钟）

/**
 * 转写一段 WAV 音频（16k/24k mono 16bit 均可，各引擎自适配）。
 * 返回 { ok: true, text } | { ok: false, reason }（不抛异常，调用方决定怎么呈现）。
 */
export async function transcribeWav(wav, { timeoutMs = 60000, cfg = null } = {}) {
  try {
    const buf = Buffer.isBuffer(wav) ? wav : Buffer.from(wav);
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return { ok: false, reason: 'not-wav' };
    if (buf.length > MAX_WAV_BYTES) return { ok: false, reason: 'too-large' };
    const c = cfg || getConfig();
    const ep = resolveSpeechEndpoint(c, { role: 'asr' });
    const adapter = resolveAdapter(c, ep?.baseUrl || '');
    if (!adapter.capabilities.asr) return { ok: false, reason: 'adapter-no-asr' };
    if (!ep) return { ok: false, reason: 'no-endpoint' };
    const model = String(c.speech?.models?.asr || '').trim() || adapter.defaults.asr;
    const r = await adapter.transcribe({ wav: buf, model, ep, cfg: c, timeoutMs });
    if (r?.ok && r.text) return { ok: true, text: String(r.text).trim() };
    return { ok: false, reason: r?.reason || 'unknown' };
  } catch (e) {
    return { ok: false, reason: `error:${e?.message ?? e}` };
  }
}

// ── OneBot record 段 → WAV（自 plugins/mimo-asr 同款逻辑，核心化）────────

/** 任意音频字节 → WAV 字节（已是 WAV 原样返回；否则 ffmpeg 转 16k mono）。 */
function toWav(buf) {
  if (buf.length > 12 && buf.slice(0, 4).toString('ascii') === 'RIFF') return buf;
  const ff = detectFfmpeg();
  if (!ff) return null;
  const tmpIn = path.join(os.tmpdir(), `qqa-asr-in-${Date.now()}.bin`);
  const tmpOut = path.join(os.tmpdir(), `qqa-asr-out-${Date.now()}.wav`);
  try {
    fs.writeFileSync(tmpIn, buf);
    const r = spawnSync(ff, ['-y', '-i', tmpIn, '-ar', '16000', '-ac', '1', '-f', 'wav', tmpOut],
      { timeout: 20000, windowsHide: true, stdio: 'ignore' });
    if (r.status !== 0 || !fs.existsSync(tmpOut)) return null;
    return fs.readFileSync(tmpOut);
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}

let _ffmpeg = null;
let _ffmpegChecked = false;
function detectFfmpeg() {
  if (_ffmpegChecked) return _ffmpeg;
  _ffmpegChecked = true;
  for (const cmd of ['ffmpeg', 'ffmpeg.exe']) {
    try {
      if (spawnSync(cmd, ['-version'], { timeout: 5000, windowsHide: true }).status === 0) { _ffmpeg = cmd; break; }
    } catch { /* 下一个 */ }
  }
  return _ffmpeg;
}

/** 用 OneBot get_record 把语音段落到本地并读出字节（失败返回 null）。 */
async function fetchRecordBytes(record, onebot) {
  const fileId = String(record?.file ?? record?.file_id ?? record?.url ?? '').trim();
  if (!fileId) return null;
  const r = await onebot.call('get_record', { file: fileId, out_format: 'wav' }).catch(() => null);
  const p = String(r?.file ?? r?.data?.file ?? '').trim();
  if (p.startsWith('base64://')) return Buffer.from(p.slice('base64://'.length), 'base64');
  if (p) {
    const local = p.startsWith('file://')
      ? decodeURIComponent(p.slice('file://'.length)).replace(/\//g, path.sep)
      : p;
    try { return fs.readFileSync(local); } catch { /* 路径形态不认识 */ }
  }
  if (fileId.startsWith('base64://')) return Buffer.from(fileId.slice('base64://'.length), 'base64');
  if (/^https?:\/\//.test(fileId)) {
    try {
      const res = await fetch(fileId, { signal: AbortSignal.timeout(20000) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch { /* ignore */ }
  }
  return null;
}

/**
 * 群语音消息入口：record 段 → WAV → 当前 ASR 引擎转写。
 * 返回 { ok, text?, reason? }。链路任何一步失败都给 reason（不抛）。
 */
export async function transcribeRecord({ record, onebot, cfg = null } = {}) {
  try {
    const c = cfg || getConfig();
    if (c.speech?.asr?.enabled === false) return { ok: false, reason: 'disabled' };
    if (!onebot) return { ok: false, reason: 'no-onebot' };
    const raw = await fetchRecordBytes(record, onebot);
    if (!raw?.length) return { ok: false, reason: 'no-audio' };
    const wav = toWav(raw);
    if (!wav?.length) return { ok: false, reason: 'no-ffmpeg' };
    return await transcribeWav(wav, { cfg: c });
  } catch (e) {
    return { ok: false, reason: `error:${e?.message ?? e}` };
  }
}
