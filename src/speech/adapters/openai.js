// 语音适配器 · OpenAI（TTS + Whisper 转写）。
//
// 契约（公开稳定接口，2025 起长期可用）：
//   TTS: POST {baseURL 含 /v1}/audio/speech
//        body { model, input, voice, response_format: 'wav', instructions? }
//        响应 = 音频二进制（response_format=wav → 直接是 WAV）
//        instructions 仅 gpt-4o-mini-tts 等新模型支持（老 tts-1 传了可能 400，
//        所以只在 model 含 'gpt-4o' 时携带 —— style 语气口吻走这个参数）
//   ASR: POST {baseURL 含 /v1}/audio/transcriptions（multipart/form-data）
//        字段 file(Blob audio/wav)、model、response_format=json → { text }
//   无音色克隆、无唱歌（能力矩阵里关掉，UI 自动隐藏对应功能）
//
// baseURL 归一：用户填 https://api.openai.com 或 .../v1 都行。
// 注意：中转网关（one-api 等）聊天端点通 ≠ 音频端点通，接入时要实测。

const OPENAI_VOICES = ['alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];

function normalizeBase(ep) {
  let b = String(ep?.baseUrl || '').replace(/\/+$/, '');
  if (!/\/v1$/i.test(b)) b += '/v1';
  return b;
}

export default {
  id: 'openai',
  name: 'OpenAI（TTS/Whisper）',
  match(baseUrl) {
    return /openai/i.test(String(baseUrl || ''));
  },
  capabilities: { tts: true, clone: false, singing: false, asr: true, style: true },
  voices: OPENAI_VOICES,
  defaultVoice: 'alloy',
  defaults: { tts: 'gpt-4o-mini-tts', asr: 'whisper-1' },
  needs: [],

  async synthesize({ text, style, voice, model, ep, timeoutMs = 60000 }) {
    const body = {
      model,
      input: String(text ?? '').trim(),
      voice,
      response_format: 'wav'
    };
    const styleText = String(style ?? '').trim();
    if (styleText && /gpt-4o/i.test(model)) body.instructions = styleText;   // 老模型不认这个参数

    let r;
    try {
      r = await fetch(normalizeBase(ep) + '/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ep.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      throw new Error(`TTS 请求失败：${e?.cause?.code || e?.message || e}`);
    }
    if (!r.ok) {
      let detail = '';
      try {
        const j = await r.json();
        detail = j?.error?.message || JSON.stringify(j).slice(0, 300);
      } catch { detail = (await r.text().catch(() => '')).slice(0, 300); }
      throw new Error(`TTS 失败（HTTP ${r.status}）：${detail || '无详情'}`);
    }
    const wav = Buffer.from(await r.arrayBuffer());
    if (wav.length < 100) throw new Error('TTS 响应里没有音频（空响应体）');
    return { wav };
  },

  async transcribe({ wav, model, ep, timeoutMs = 60000 }) {
    let r;
    try {
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'speech.wav');
      form.append('model', model);
      form.append('response_format', 'json');
      r = await fetch(normalizeBase(ep) + '/audio/transcriptions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ep.apiKey}` },
        body: form,
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      return { ok: false, reason: `error:${e?.message ?? e}` };
    }
    if (!r.ok) return { ok: false, reason: `http-${r.status}` };
    const j = await r.json().catch(() => null);
    const text = String(j?.text ?? '').trim();
    if (!text) return { ok: false, reason: 'empty' };
    if (/^[（(][^)）]{0,6}[)）]$/.test(text)) return { ok: false, reason: 'blank' };
    return { ok: true, text };
  }
};
