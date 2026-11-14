// TTS：让尼斯湖王子开口说话。
//
// MiMo TTS 的调用方式（2026-11-02 实测敲定，靠服务端报错信息摸出来的）：
//   POST {baseUrl}/chat/completions        （baseURL 已含 /v1，不重复补 —— /v1/v1 会 404）
//   body: { model, audio?: { voice }, messages: [{ role: 'assistant', content: 要说的话 }] }
//   响应: choices[0].message.audio.data = base64 WAV（content 恒为空）
// 要说的话放 **assistant** 角色（用户角色会被 400 拒绝）。
//
// 两种模型（实测均通）：
//   · mimo-v2.5-tts            预置音色：audio.voice = '茉莉' 等 9 选 1（限时免费）
//   · mimo-v2.5-tts-voiceclone 克隆音色：audio.voice = **参考音频 DataURL**
//     （data:audio/wav;base64,...，3~10 秒样本；无需训练，单次调用直接出声）
//
// 语气口吻：段落级自然语言指令 —— 官方能力，content 里直接写
//   "（用害羞小声的语气）……" 即可生效（开放式，不限固定枚举）。
//   synthesize 的 style 参数就是干这个的：拼接为（style）text 前缀。
//
// 服务商：config.speech.providerId 指向 providers[]，复用 Key 体系；
// config.speech.baseUrl 可整体覆盖（测试注入）。
//
// 多引擎（Phase A，2026-11-04）：请求构造/响应解析下沉到 adapters/（与大脑的
// 多服务商同款模式），本文件只留引擎无关的决策：文本校验、唱歌/克隆判定、
// 模型与音色选择、WAV 归一。引擎选择 = config.speech.format（auto 按 baseURL 猜）。
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { getConfig, DATA_DIR } from '../config.js';
import { resolveProviderEndpoint } from '../llm.js';
import { resolveAdapter } from './adapters/index.js';
import { singSong, singingEnabled } from './singing.js';
import { rvcConvertLocked } from './rvc.js';

export const TTS_VOICES = ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'];
export const DEFAULT_VOICE = '茉莉';
export const DEFAULT_TTS_MODEL = 'mimo-v2.5-tts';
export const CLONE_MODEL = 'mimo-v2.5-tts-voiceclone';
export const CLONE_REF_DIR = path.join(DATA_DIR, 'speech');

// 参考音频扩展名 → DataURL MIME（克隆时 audio.voice 里的格式标注必须与实际一致）
export const CLONE_MIME = {
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  m4a: 'audio/mp4',
  aac: 'audio/aac'
};

/**
 * 按文件魔数嗅探音频格式（比 DataURL 里浏览器标的 MIME 可靠 —— 浏览器对
 * .m4a/.aac 常标成 application/octet-stream，后端不能信它）。
 * 返回 'wav' | 'mp3' | 'ogg' | 'm4a' | 'aac' | null。
 */
export function sniffAudioExt(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WAVE') return 'wav';
  if (buf.slice(0, 3).toString('ascii') === 'ID3') return 'mp3';
  if (buf[0] === 0xFF && (buf[1] & 0xE0) === 0xE0) {
    // MPEG 音频帧同步：ADTS 封装的 AAC 是 FF F1(MPEG-4)/FF F9(MPEG-2)，其余当 mp3
    if (buf[1] === 0xF1 || buf[1] === 0xF9) return 'aac';
    return 'mp3';
  }
  if (buf.slice(0, 4).toString('ascii') === 'OggS') return 'ogg';
  if (buf.slice(4, 8).toString('ascii') === 'ftyp') return 'm4a';
  return null;
}

// ── ffmpeg：m4a/aac/ogg 参考音频转 mp3 用 ──────────────────────────────
// MiMo voiceclone 只收 wav/mp3（HTTP 400 原话："Supported formats: [wav, mp3]"），
// 手机录音的 m4a 必须转一道。ffmpeg 探测结果缓存（与 image-compress 同款思路）。
let _ffmpeg = null;
let _ffmpegChecked = false;

export function hasFfmpeg() {
  if (!_ffmpegChecked) {
    _ffmpegChecked = true;
    for (const cmd of ['ffmpeg', 'ffmpeg.exe']) {
      try {
        if (spawnSync(cmd, ['-version'], { timeout: 5000, windowsHide: true }).status === 0) { _ffmpeg = cmd; break; }
      } catch { /* 下一个 */ }
    }
  }
  return Boolean(_ffmpeg);
}

/** 任意音频字节 → WAV 字节（PCM 16bit / 24kHz 单声道）。
 *  为什么是 WAV 而不是 mp3：参考音频的质量直接决定克隆上限 ——
 *  首版转 16kHz/64kbps mp3 时用户实测克隆音色"机器感明显"，
 *  低码率有损压缩先损失一轮、再进克隆模型，雪上加霜。PCM 无损进模型。 */
export function convertRefToWav(buf) {
  if (!hasFfmpeg()) return null;
  const tmpIn = path.join(CLONE_REF_DIR, `convert-in-${Date.now()}.bin`);
  const tmpOut = path.join(CLONE_REF_DIR, `convert-out-${Date.now()}.wav`);
  try {
    fs.mkdirSync(CLONE_REF_DIR, { recursive: true });
    fs.writeFileSync(tmpIn, buf);
    const r = spawnSync(_ffmpeg, ['-y', '-i', tmpIn, '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', '-f', 'wav', tmpOut],
      { timeout: 30000, windowsHide: true, stdio: 'ignore' });
    if (r.status !== 0 || !fs.existsSync(tmpOut)) return null;
    const out = fs.readFileSync(tmpOut);
    return out.length > 1000 ? out : null;
  } catch {
    return null;
  } finally {
    try { fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}

/**
 * 解析语音功能用的服务商端点。
 * role='tts'（默认）→ speech.providerId；role='asr' → speech.asr.providerId
 * （留空 = 跟随 TTS 服务商，历史行为不变）。都没有则用第一个带 Key 的服务商。
 */
export function resolveSpeechEndpoint(cfg = getConfig(), { role = 'tts' } = {}) {
  const override = String(cfg.speech?.baseUrl || '').trim();
  const pid = (role === 'asr'
    ? String(cfg.speech?.asr?.providerId || '')
    : String(cfg.speech?.providerId || '')
  ).trim() || String(cfg.speech?.providerId || '').trim();
  if (override) {
    const ep = resolveProviderEndpoint(pid);
    return { baseUrl: override.replace(/\/+$/, ''), apiKey: ep?.apiKey || '' };
  }
  if (pid) {
    const ep = resolveProviderEndpoint(pid);
    if (ep?.baseUrl && ep.apiKey) return ep;
    return null;
  }
  for (const p of (cfg.providers || [])) {
    const ep = resolveProviderEndpoint(p.id);
    if (ep?.baseUrl && ep.apiKey) return ep;
  }
  return null;
}

/** 读参考音频（clone 模式）。config 存文件名（在 data/speech/ 下）。返回 { buf, mime } 或 null。 */
export function readCloneRef(cfg = getConfig()) {
  const file = String(cfg.speech?.tts?.cloneRefFile || '').trim();
  if (!file || /[\\/]|\.\./.test(file)) return null;   // 只认 DATA_DIR/speech/ 下的一级文件名
  const ext = path.extname(file).slice(1).toLowerCase();
  const mime = CLONE_MIME[ext];
  if (!mime) return null;
  try {
    const buf = fs.readFileSync(path.join(CLONE_REF_DIR, file));
    return buf.length > 1000 ? { buf, mime, file } : null;
  } catch { return null; }
}

/**
 * 合成语音（多引擎入口：请求构造在 adapters/，这里做引擎无关决策）。
 * @param {{ text: string, voice?: string, style?: string, model?: string, timeoutMs?: number, convertTo?: string }} opts
 *   style：语气口吻（自然语言）—— mimo 拼（style）前缀 / openai 走 instructions /
 *          其余引擎按能力矩阵处理（不支持的忽略）
 *   mode/voice 不传时按 config 自动：mode=clone 且参考音频在且引擎支持 → 克隆；否则预置音色
 *   convertTo：说话变声 —— TTS 出语音后用该 RVC 模型转音色（虚拟歌手声线，
 *          和唱歌共用同一模型 = 唱说同声线）。仅语音条路径传；实时通话不传。
 * @returns {Promise<{ wav: Buffer, voice: string, model: string, mode: string, singing: boolean, forcedPreset: boolean }>}
 */
export async function synthesize({ text, voice = null, style = null, model = null, timeoutMs = 60000, convertTo = null } = {}) {
  const s = String(text ?? '').trim();
  if (!s) throw new Error('要合成的文本为空');
  const styleText = String(style ?? '').trim();

  // 唱歌判定（mimo 语法：文本开头（唱歌）/（sing）标签；style 含"唱/sing"也算想唱）。
  // 判定基于原文+style（前缀已下沉到适配器，这里不拼）。
  const wantsSinging = /[(（]\s*(唱歌|sing|singing)\s*[)）]/i.test(s) || /唱|sing/i.test(styleText);

  const cfg = getConfig();
  const maxChars = Math.max(20, Number(cfg.speech?.tts?.maxChars) || 200);
  if (s.length > maxChars) {
    throw new Error(`要说的话太长了（${s.length} 字，上限 ${maxChars}）。语音要短小精悍，长的内容用文字发`);
  }

  // 本地歌声链（speech.singing.enabled=true）：唱歌走 SVC 全自动链
  // （ACE-Step 出歌 → demucs 分离 → RVC 转写克隆音色 → 混音），与 TTS 引擎
  // 完全无关 —— 唱说音色一致的终解。放在 ep 解析之前：歌声链不依赖 TTS 服务商。
  // 链内自检服务/模型，失败抛可读错误（不静默、不回落到不一致的音色）。
  if (wantsSinging && singingEnabled(cfg)) {
    return await singSong({ text: s, style: styleText, cfg });
  }

  const ep = resolveSpeechEndpoint(cfg);
  if (!ep) throw new Error('没有可用的 TTS 服务商（先在 设置 → 模型API 配置一个带 API Key 的服务商）');

  const adapter = resolveAdapter(cfg, ep.baseUrl);

  // 唱歌是引擎能力：不支持就必须报错 —— （唱歌）标签会被普通引擎当正文念出来，
  // 绝不能静默吞（宁可 send_voice/试听报错，也不要手机里播出台词朗读）
  if (wantsSinging && !adapter.capabilities.singing) {
    throw new Error(`当前语音引擎（${adapter.name}）不支持唱歌；换回小米 MiMo 或去掉（唱歌）标签`);
  }

  // 模式判定：想唱歌 → 强制预置音色（mimo voiceclone 不支持唱歌）；
  // 否则 clone 模式 + 参考音频在 + 引擎支持克隆 → 克隆；都没命中 → 预置音色
  let usedModel;
  let voiceDesc;
  let forcedPreset = false;
  let presetVoice = null;
  let refDataUrl = null;
  const modeClone = (cfg.speech?.tts?.mode === 'clone') || model === CLONE_MODEL;
  // cloneOnly 引擎（GPT-SoVITS）：无视 mode 开关强制走克隆路径 —— 它没有预置音色
  const wantClone = !wantsSinging && (modeClone || adapter.cloneOnly === true) && adapter.capabilities.clone;
  const cloneRef = wantClone ? readCloneRef(cfg) : null;
  let refAudioPath = null;
  if (cloneRef) {
    usedModel = cfg.speech?.models?.ttsClone || adapter.defaults.ttsClone || CLONE_MODEL;
    // MIME 标注必须与参考音频实际格式一致（wav/mp3/m4a...，见 CLONE_MIME）
    refDataUrl = `data:${cloneRef.mime};base64,${cloneRef.buf.toString('base64')}`;
    refAudioPath = path.join(CLONE_REF_DIR, cloneRef.file);   // 本地引擎用（同机绝对路径）
    voiceDesc = '克隆音色';
  } else {
    usedModel = cfg.speech?.models?.tts || adapter.defaults.tts || DEFAULT_TTS_MODEL;
    forcedPreset = wantsSinging && (cfg.speech?.tts?.mode === 'clone');
    const explicit = String(voice ?? '').trim();
    if (explicit) {
      // 显式传音色 = 信任调用方：原样交给引擎，引擎报错（Unknown voice 等）照出不吞
      presetVoice = explicit;
    } else {
      // 配置里的音色要容忍引擎切换（茉莉→openai 时自动回落该引擎默认）
      const vCfg = String(cfg.speech?.tts?.voice || DEFAULT_VOICE).trim() || DEFAULT_VOICE;
      presetVoice = adapter.voices.includes(vCfg) ? vCfg : adapter.defaultVoice;
    }
    voiceDesc = presetVoice;
  }

  const result = await adapter.synthesize({
    text: s, style: styleText, voice: presetVoice, refDataUrl, refAudioPath,
    model: usedModel, ep, cfg, timeoutMs
  });
  let wav = result?.wav;
  if (!Buffer.isBuffer(wav) || wav.length < 100) {
    throw new Error('TTS 响应里没有音频（适配器返回空）');
  }
  // WAV 归一：下游（waveOut 播放 / QQ record / ASR）一律要 RIFF；非 WAV 引擎用 ffmpeg 转
  if (wav.slice(0, 4).toString('ascii') !== 'RIFF') {
    const conv = convertRefToWav(wav);
    if (!conv) throw new Error('引擎返回了非 WAV 音频，且本机无 ffmpeg 可转码');
    wav = conv;
  }
  // 说话变声（虚拟歌手声线）：TTS 出语音 → RVC 转成目标音色 —— 和唱歌共用
  // 同一个 RVC 模型 = 唱说同声线。仅 send_voice 传 convertTo；实时通话不传
  // （保延迟）。模型名来自 speech.rvc.speakModel。
  if (convertTo) {
    const cvt = await rvcConvertLocked({ wav, model: convertTo });
    return { wav: cvt, voice: `${voiceDesc}·RVC:${convertTo}`, model: `${usedModel}+rvc:${convertTo}`, mode: cloneRef ? 'clone' : 'preset', singing: wantsSinging, forcedPreset };
  }
  return { wav, voice: voiceDesc, model: usedModel, mode: cloneRef ? 'clone' : 'preset', singing: wantsSinging, forcedPreset };
}
