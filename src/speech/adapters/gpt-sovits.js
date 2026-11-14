// 语音适配器 · GPT-SoVITS（本地开源克隆，第 5 家）。
//
// 契约来自官方 api_v2.py 源码（2026-11-04 拉取 main 分支，非凭记忆）：
//   POST http://{base}/tts   JSON body
//   必填：text / text_lang / ref_audio_path / prompt_lang（缺 → 400 {"message"}）
//   可选：prompt_text（可空，但填了克隆相似度显著更高）、media_type、streaming_mode…
//   成功：200 直接返回 WAV 二进制（Content-Type: audio/wav）
//   失败：400 {"message": "tts failed", "Exception": "<真实原因>"} —— message 是幌子，
//         Exception 才是人话（真机联调实踩：两字段都要透出）
//   启动：python api_v2.py -a 127.0.0.1 -p 9880（整合包内）
//   服务端有 pipeline 锁 = 请求串行，本地推理短句 1~3s（4070Ti 实测 3s 出 344KB WAV）
//
// api_v2 硬约束（真机联调实踩）：参考音频必须 3~10 秒，超限直接 400。
//   所以本适配器本地解析 WAV 时长：过短 → 可读报错不发请求；超长 → 纯 JS 裁到
//   9.5 秒写缓存副本（<原路径>.sovits-trim.wav，下游 prompt 缓存键跟着副本走）。
//
// 语义（cloneOnly 引擎）：
//   · 没有预置音色 —— 它只会用参考音频克隆出的声音说话；tts.js 见 cloneOnly
//     会强制走克隆路径（无视 mode 开关），参考音频缺失时这里报可读错误
//   · ref_audio_path 传【本机绝对路径】（同机部署，无需上传协议）
//   · prompt_text = 参考音频说了什么：优先读缓存（<参考音频>.prompt.txt，首行是
//     源文件字节数——重传同名参考音频自动失效重转），没有则用当前 ASR 引擎自动
//     转写一次并缓存（失败留空，下次再试）。缓存文件可手动编辑改写转写错误。
//   · 无唱歌 / 无转写 / 无语气指令（能力矩阵里关掉，UI 自动显隐）
//
// ✅ 已真机联调（2026-11-05，整合包 v3lora-20250228 + 4070Ti）：首通 3.06s 出声。
import fs from 'node:fs';
import { convertRefToWav } from '../tts.js';
import { transcribeWav } from '../asr.js';
import { inferAdapterId, getAdapter } from './index.js';

// UI 音色下拉用的占位（本引擎音色 = 参考音频，下拉选项无实际选择意义）
const SOVITS_VOICES = ['参考音频克隆'];

// 采样参数（真机调优 2026-11-05：默认 temperature=1/top_p=1 时有电流音碎屑；
// 降到 0.6/0.8 + top_k=15 明显干净。固化为本引擎默认，不暴露配置项）
const SOVITS_SAMPLING = { temperature: 0.6, top_k: 15, top_p: 0.8 };

/** 找第一个有 ASR 能力的服务商 id（主服务商可能就是 GPT-SoVITS 自己，借别人的转写）。 */
function pickAsrProviderId(cfg) {
  const list = Array.isArray(cfg?.providers) ? cfg.providers : [];
  for (const p of list) {
    const a = getAdapter(inferAdapterId(p?.baseURL));
    if (a?.capabilities?.asr) return String(p?.id || '');
  }
  return '';
}

/** 语言码 → GPT-SoVITS 的 prompt_lang/text_lang 取值（它认 zh/en/ja… 短码）。 */
function shortLang(lang) {
  const s = String(lang || 'zh').toLowerCase();
  if (s.startsWith('en')) return 'en';
  if (s.startsWith('ja')) return 'ja';
  return 'zh';
}

/** 从转写文本猜参考音频语言：有假名 → ja（真机实踩：日语参考音频必须标 ja，
 *  标 zh 会显著跑腔）；纯拉丁 → en；汉字为主分不清 zh/ja，交给 text_lang 兜底。 */
function inferPromptLang(text) {
  const s = String(text || '');
  if (!s) return '';
  if (/[\u3040-\u30ff]/.test(s)) return 'ja';   // 平假名/片假名
  const cjk = (s.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (s.match(/[A-Za-z]/g) || []).length;
  if (cjk === 0 && latin > 0) return 'en';
  return '';
}

/** 解析 PCM WAV 头：{ sampleRate, channels, bits, dataOffset, dataSize }；解析不动返回 null。 */
function parseWav(buf) {
  if (!buf || buf.length < 44 || buf.slice(0, 4).toString('ascii') !== 'RIFF') return null;
  let off = 12;   // 跳过 RIFF 主头，逐块扫到 data
  let fmt = null;
  while (off + 8 <= buf.length) {
    const id = buf.slice(off, off + 4).toString('ascii');
    const size = buf.readUInt32LE(off + 4);
    if (id === 'fmt ' && size >= 16) {
      fmt = { channels: buf.readUInt16LE(off + 10), sampleRate: buf.readUInt32LE(off + 12), bits: buf.readUInt16LE(off + 22) };
    } else if (id === 'data') {
      if (!fmt) return null;
      return { ...fmt, dataOffset: off + 8, dataSize: Math.min(size, buf.length - off - 8) };
    }
    off += 8 + size + (size % 2);   // chunk 按 2 字节对齐
  }
  return null;
}

/** 把 PCM WAV 裁到 maxMs 以内（截 data 块 + 重写两处长度，纯 JS 无 ffmpeg）。不需要裁返回 null。 */
function trimWav(buf, maxMs) {
  const w = parseWav(buf);
  if (!w || !w.sampleRate || !w.channels || !w.bits) return null;
  const frameBytes = (w.bits / 8) * w.channels;
  if (!frameBytes) return null;
  const maxBytes = Math.floor((w.sampleRate * maxMs) / 1000) * frameBytes;
  if (w.dataSize <= maxBytes) return null;
  const out = Buffer.alloc(w.dataOffset + maxBytes);
  buf.copy(out, 0, 0, w.dataOffset + maxBytes);
  out.writeUInt32LE(out.length - 8, 4);            // RIFF 块大小 = 文件长 - 8
  out.writeUInt32LE(maxBytes, w.dataOffset - 4);   // data 块大小
  return out;
}

/** api_v2 硬约束 3~10 秒：本地解析时长，过短报错、超长裁剪出副本；解析不动原样交服务端。 */
function prepareRef(refAudioPath) {
  const raw = fs.readFileSync(refAudioPath);
  const isWav = raw.length > 44 && raw.slice(0, 4).toString('ascii') === 'RIFF';
  const wav = isWav ? raw : convertRefToWav(raw);
  if (!wav) return refAudioPath;
  const w = parseWav(wav);
  if (!w || !w.sampleRate || !w.channels || !w.bits) return refAudioPath;
  const seconds = w.dataSize / ((w.bits / 8) * w.channels) / w.sampleRate;
  if (seconds < 3) {
    throw new Error(`参考音频只有 ${seconds.toFixed(1)} 秒——GPT-SoVITS 要求 3~10 秒，请换一段更长的`);
  }
  if (seconds <= 10) return refAudioPath;   // 合规，原样交服务端
  const trimmed = trimWav(wav, 9500);
  if (!trimmed) return refAudioPath;
  const outPath = `${refAudioPath}.sovits-trim.wav`;
  try {
    fs.writeFileSync(outPath, trimmed);
    return outPath;
  } catch { return refAudioPath; }   // 副本写不了就交原文件，让服务端裁决
}

/** 读参考音频的 prompt 文本：缓存命中（且源文件没换过）→ 用；否则 ASR 转写一次并落盘缓存。 */
async function resolvePromptText(refAudioPath, cfg) {
  const cacheFile = `${refAudioPath}.prompt.txt`;
  let srcSize = -1;
  try { srcSize = fs.statSync(refAudioPath).size; } catch { return ''; }
  try {
    const raw = fs.readFileSync(cacheFile, 'utf8');
    const nl = raw.indexOf('\n');
    if (nl > 0 && Number.parseInt(raw.slice(0, nl), 10) === srcSize) {
      const cached = raw.slice(nl + 1).trim();
      if (cached) return cached;
    }
  } catch { /* 无缓存或格式旧 */ }
  // 自动转写：格式按 asr 服务商识别（本引擎 format=gpt-sovits 无 ASR 能力，
  // 必须临时切 auto 让 transcribeWav 按 ASR 服务商的地址推断引擎）
  try {
    const raw = fs.readFileSync(refAudioPath);
    const isWav = raw.length > 44 && raw.slice(0, 4).toString('ascii') === 'RIFF';
    const wav = isWav ? raw : convertRefToWav(raw);
    if (!wav) return '';
    const asrCfg = { ...cfg, speech: { ...cfg.speech, format: 'auto' } };
    // ASR 服务商留空时跟随主服务商 —— 主服务商就是本引擎（无转写）时，自动
    // 借用第一个有转写能力的服务商（否则 prompt_text 永远为空，克隆相似度悄悄变差）
    if (!String(cfg?.speech?.asr?.providerId || '').trim()) {
      const borrow = pickAsrProviderId(cfg);
      if (borrow) asrCfg.speech.asr = { ...cfg.speech.asr, providerId: borrow };
    }
    const r = await transcribeWav(wav, { cfg: asrCfg });
    const text = r.ok ? String(r.text || '').trim() : '';
    if (text) {
      try { fs.writeFileSync(cacheFile, `${srcSize}\n${text}`, 'utf8'); } catch { /* 缓存失败不影响本次 */ }
    }
    return text;
  } catch {
    return '';
  }
}

export default {
  id: 'gpt-sovits',
  name: 'GPT-SoVITS（本地克隆）',
  match(baseUrl) {
    return /sovits|:9880/i.test(String(baseUrl || ''));
  },
  cloneOnly: true,
  capabilities: { tts: true, clone: true, singing: false, asr: false, style: false },
  voices: SOVITS_VOICES,
  defaultVoice: '参考音频克隆',
  defaults: { tts: 'gpt-sovits', asr: '' },   // 仅作返回值标签（服务端不吃 model 字段）
  needs: [],

  async synthesize({ text, refAudioPath, ep, cfg, timeoutMs = 60000 }) {
    if (!refAudioPath) {
      throw new Error('GPT-SoVITS 是克隆专用引擎：先在语音页上传 3~10 秒参考音频，再试听');
    }
    if (!fs.existsSync(refAudioPath)) {
      throw new Error(`参考音频文件不存在：${refAudioPath}（可能被移动/删除，重新上传）`);
    }
    const lang = shortLang(cfg?.speech?.asr?.language);   // text_lang = 要说的话的语言
    const effRef = prepareRef(refAudioPath);   // 3~10s 硬约束的本地把关（超长自动裁）
    const promptText = await resolvePromptText(effRef, cfg);
    const promptLang = inferPromptLang(promptText) || lang;   // 参考音频的语言跟转写文本走

    const body = {
      text: String(text ?? '').trim(),
      text_lang: lang,
      ref_audio_path: effRef,                // 同机绝对路径，服务端直接读
      prompt_text: promptText,               // 可空；有缓存/转写结果则带上（相似度关键）
      prompt_lang: promptLang,               // v3/v4 非空强制（空了直接 400）；语言跟转写文本走
      media_type: 'wav',
      streaming_mode: false,                 // 整段 WAV（下游 waveOut/record 都要完整文件）
      ...SOVITS_SAMPLING                     // 抗电流音的稳定采样（真机调优固化）
      // 不传 model/voice/style：服务端按自己配置的权重出声，这些字段它不认
    };

    let r;
    try {
      r = await fetch(String(ep.baseUrl).replace(/\/+$/, '') + '/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },   // 本地服务无鉴权，不发 Authorization
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      throw new Error(`TTS 请求失败：连不上 GPT-SoVITS（${String(ep.baseUrl)}）——服务没启动？${e?.cause?.code || e?.message || e}`);
    }
    if (!r.ok) {
      let detail = '';
      try {
        const j = await r.json();
        // message 通常是幌子（"tts failed"），Exception 才是真实原因——两个都透出
        detail = [j?.message, j?.Exception].filter(Boolean).join(' —— ') || JSON.stringify(j).slice(0, 300);
      } catch { detail = (await r.text().catch(() => '')).slice(0, 300); }
      throw new Error(`TTS 失败（HTTP ${r.status}）：${detail || '无详情'}`);
    }
    const wav = Buffer.from(await r.arrayBuffer());
    if (wav.length < 100 || wav.slice(0, 4).toString('ascii') !== 'RIFF') {
      throw new Error('TTS 响应不是预期的 WAV（GPT-SoVITS 版本/参数可能有变，请反馈）');
    }
    return { wav };
  },

  async transcribe() {
    return { ok: false, reason: 'adapter-no-asr' };   // 它没有 ASR（转写走别的引擎）
  }
};
