// 语音适配器 · MiniMax T2A v2（中文音质第一梯队，音色/情绪最丰富）。
//
// ⚠️ 契约按通行公开文档实现（2026-11-04），**待真机 Key 联调**——接入后
//    先用试听按钮验一遍，报错贴回来我修（沿用 MiMo 时代的错误驱动校准）。
// 契约要点：
//   TTS: POST {base}/v1/t2a_v2?GroupId={groupId}
//        Headers: Authorization: Bearer {key}
//        body { model, text, stream:false,
//               voice_setting:{ voice_id, speed, vol, pitch, emotion? },
//               audio_setting:{ sample_rate:24000, bitrate:128000, format:'wav', channel:1 } }
//        响应 { base_resp:{status_code,status_msg} | {code,msg}, data:{ audio: <hex> } }
//        —— audio 是 **hex 编码**（不是 base64），转 Buffer 后应为 RIFF WAV
//   必填 GroupId（MiniMax 控制台获取）→ config.speech.groupId
//   无 ASR、无克隆（v1；克隆需 files/upload + voice_clone 两步流，真机联调后加）
//   情绪：style 关键词 → emotion 枚举（开心→happy 等），映射不上就不传

const MINIMAX_VOICES = [
  'male-qn-qingse',      // 青涩青年
  'male-qn-jingying',    // 精英青年
  'male-qn-badao',       // 霸道青年
  'female-shaonv',       // 少女
  'female-chengshu',     // 成熟女性
  'female-yujie',        // 御姐
  'male-qn-daxuesheng',  // 大学生
  'female-tianmei',      // 甜妹
  'male-qn-dongbei',     // 东北老铁
  'male-qn-guangzhouhu'  // 广州话
];

// style 自然语言 → MiniMax emotion 枚举（只映射有把握的，宁缺毋滥）
const EMOTION_MAP = [
  [/开心|高兴|快乐|兴奋|happy/i, 'happy'],
  [/难过|伤心|悲伤|委屈|sad/i, 'sad'],
  [/生气|愤怒|气愤|angry/i, 'angry'],
  [/平静|冷静|沉稳|calm/i, 'calm'],
  [/惊讶|吃惊|意外|surprised/i, 'surprised'],
  [/害怕|恐惧|紧张|fearful/i, 'fearful']
];

function normalizeBase(ep) {
  let b = String(ep?.baseUrl || '').replace(/\/+$/, '');
  b = b.replace(/\/v1$/i, '');          // 用户带不带 /v1 都行
  return b + '/v1';
}

function mapEmotion(style) {
  const s = String(style || '');
  for (const [re, emotion] of EMOTION_MAP) if (re.test(s)) return emotion;
  return null;
}

export default {
  id: 'minimax',
  name: 'MiniMax（T2A v2）',
  match(baseUrl) {
    return /minimax/i.test(String(baseUrl || ''));
  },
  capabilities: { tts: true, clone: false, singing: false, asr: false, style: true },
  voices: MINIMAX_VOICES,
  defaultVoice: 'female-shaonv',
  defaults: { tts: 'speech-02-turbo', asr: '' },
  needs: [],

  async synthesize({ text, style, voice, model, ep, cfg, timeoutMs = 60000 }) {
    // GroupId 可选（2026-11-05 真机实测：新版接口只用 key 就能过鉴权；旧文档说的
    // 必填 GroupId 已不成立）。填了就带上 —— 填错会报 1004 "token not match group"，
    // 那说明 key 和 GroupId 不是同一个账号组，清空即可。
    const groupId = String(cfg?.speech?.groupId || '').trim();

    // 音色表内回落统一在 tts.js（配置音色路径）；这里只做空值兜底，
    // 显式传入的表外音色交给 MiniMax（voice not found 是有效反馈）
    const voiceId = String(voice || '').trim() || 'female-shaonv';
    const voiceSetting = { voice_id: voiceId, speed: 1.0, vol: 1.0, pitch: 0 };
    const emotion = mapEmotion(style);
    if (emotion) voiceSetting.emotion = emotion;

    const body = {
      model,
      text: String(text ?? '').trim(),
      stream: false,
      voice_setting: voiceSetting,
      audio_setting: { sample_rate: 24000, bitrate: 128000, format: 'wav', channel: 1 }
    };

    let r;
    try {
      const url = groupId
        ? `${normalizeBase(ep)}/t2a_v2?GroupId=${encodeURIComponent(groupId)}`
        : `${normalizeBase(ep)}/t2a_v2`;
      r = await fetch(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ep.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      throw new Error(`TTS 请求失败：${e?.cause?.code || e?.message || e}`);
    }
    if (!r.ok) {
      const detail = (await r.text().catch(() => '')).slice(0, 300);
      throw new Error(`TTS 失败（HTTP ${r.status}）：${detail || '无详情'}`);
    }
    const j = await r.json().catch(() => null);
    const code = j?.base_resp?.status_code ?? j?.code;
    if (code !== undefined && code !== 0) {
      throw new Error(`TTS 失败（MiniMax ${code}）：${j?.base_resp?.status_msg || j?.msg || '未知错误'}`);
    }
    const hex = j?.data?.audio;
    if (!hex || typeof hex !== 'string') {
      throw new Error(`TTS 响应里没有音频（data.audio 缺失）：${JSON.stringify(j).slice(0, 200)}`);
    }
    const wav = Buffer.from(hex, 'hex');
    if (wav.length < 100 || wav.slice(0, 4).toString('ascii') !== 'RIFF') {
      throw new Error('TTS 响应音频不是预期的 WAV（hex 解码后无 RIFF 头）——可能接口契约有变，请反馈');
    }
    return { wav };
  },

  // MiniMax 的 ASR 接口未验证 → v1 不提供（UI 会显示"转写✗"，ASR 可指到别的服务商）
  async transcribe() {
    return { ok: false, reason: 'adapter-no-asr' };
  }
};
