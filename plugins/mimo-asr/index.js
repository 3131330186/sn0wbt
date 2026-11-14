// 语音转文字插件：提供 media.transcribe 能力（确定性型插件，不经 LLM）。
//
// 自包含设计：不 import 仓库 src/ 模块 —— 插件目录可能被 QQ_AGENT_PLUGINS_DIR
// 重定向到仓库之外，相对 import 会断。所有依赖（config、fetch、ffmpeg）都就地解决。
// 上游钩子（onebot.js segmentsToText 的 record 分支）约定：
//   fn({ record, onebot }) → { ok: true, text } | 其它 = 回退 [语音] 占位。
//
// 链路：record 段 → OneBot get_record 取音频文件 → 不是 WAV 就用 ffmpeg 转
// → POST {speech.baseUrl|服务商}/v1/chat/completions（mimo-v2.5-asr，
//    单个 input_audio 部件、**不带 text**——网关自动注入提示词，实测 2026-11-02）
// → choices[0].message.content = 转写文本。
//
// ASR 计费 ¥0.5/音频小时，一段几秒的语音不到一厘钱。
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

let apiRef = null;   // setup(api) 注入：api.config 读配置
export function setup(api) { apiRef = api; }

let ffmpegPath = null;
let ffmpegChecked = false;

function detectFfmpeg() {
  if (ffmpegChecked) return ffmpegPath;
  ffmpegChecked = true;
  for (const cmd of ['ffmpeg', 'ffmpeg.exe']) {
    try {
      const r = spawnSync(cmd, ['-version'], { timeout: 5000, windowsHide: true });
      if (r.status === 0) { ffmpegPath = cmd; break; }
    } catch { /* 下一个 */ }
  }
  return ffmpegPath;
}

/** 任意音频字节 → WAV 字节（已是 WAV 原样返回；否则 ffmpeg 转；无 ffmpeg 返回 null）。 */
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

/** 用 OneBot get_record 把语音段落到本地文件并读出字节。 */
async function fetchRecordBytes(record, onebot) {
  const fileId = String(record?.file ?? record?.file_id ?? record?.url ?? '').trim();
  if (!fileId) return null;
  const r = await onebot.call('get_record', { file: fileId, out_format: 'wav' }).catch(() => null);
  const p = String(r?.file ?? r?.data?.file ?? '').trim();
  if (p.startsWith('base64://')) {
    return Buffer.from(p.slice('base64://'.length), 'base64');
  }
  if (p) {
    const local = p.startsWith('file://')
      ? decodeURIComponent(p.slice('file://'.length)).replace(/\//g, path.sep)
      : p;
    try { return fs.readFileSync(local); } catch { /* 路径形态不认识 */ }
  }
  // get_record 失败：record 自带 base64 或 http 直链时兜底
  if (fileId.startsWith('base64://')) return Buffer.from(fileId.slice('base64://'.length), 'base64');
  if (/^https?:\/\//.test(fileId)) {
    try {
      const res = await fetch(fileId, { signal: AbortSignal.timeout(20000) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
    } catch { /* ignore */ }
  }
  return null;
}

/** 解析语音功能用的服务商端点（与 src/speech/tts.js 同口径，本地小实现）。 */
function resolveEndpoint(cfg) {
  const providers = Array.isArray(cfg.providers) ? cfg.providers : [];
  const keys = cfg.dshProviderKeys || {};
  const pick = (p) => {
    if (!p || !String(p.baseURL || '').trim()) return null;
    const key = String(keys[p.id] || p.apiKey || '').trim();
    return key && key !== '******' ? { baseUrl: String(p.baseURL).replace(/\/+$/, ''), apiKey: key } : null;
  };
  const pid = String(cfg.speech?.providerId || '').trim();
  if (pid) {
    const ep = pick(providers.find((x) => x.id === pid));
    if (ep) return ep;
  }
  for (const p of providers) {
    const ep = pick(p);
    if (ep) return ep;
  }
  return null;
}

export const providers = {
  'media.transcribe': async ({ record, onebot }) => {
    try {
      const cfg = apiRef?.config?.() ?? {};
      if (cfg.speech?.asr?.enabled === false) return { ok: false, reason: 'disabled' };
      if (!onebot) return { ok: false, reason: 'no-onebot' };
      const ep = resolveEndpoint(cfg);
      if (!ep) return { ok: false, reason: 'no-endpoint' };

      const raw = await fetchRecordBytes(record, onebot);
      if (!raw?.length) return { ok: false, reason: 'no-audio' };
      const wav = toWav(raw);
      if (!wav?.length) return { ok: false, reason: 'no-ffmpeg' };

      const baseUrl = String(cfg.speech?.baseUrl || ep.baseUrl || 'https://api.xiaomimimo.com').replace(/\/+$/, '');
      // 与主模型同一条拼 URL 约定：baseURL 已含 /v1，这里不重复补（/v1/v1 会 404）
      const r = await fetch(baseUrl + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ep.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: 'mimo-v2.5-asr',
          messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } }] }]
        }),
        signal: AbortSignal.timeout(60000)
      });
      if (!r.ok) return { ok: false, reason: `asr-http-${r.status}` };
      const j = await r.json().catch(() => null);
      const text = String(j?.choices?.[0]?.message?.content ?? '').trim();
      return text ? { ok: true, text } : { ok: false, reason: 'empty' };
    } catch (e) {
      try { apiRef?.log?.(`[mimo-asr] 转写失败：${e?.message ?? e}`); } catch { /* ignore */ }
      return { ok: false, reason: 'error' };
    }
  }
};
