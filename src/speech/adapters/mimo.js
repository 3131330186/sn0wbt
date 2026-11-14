// 语音适配器 · 小米 MiMo（默认引擎，行为 = v0.7 及以前的原样抽取）。
//
// 契约（2026-11-02 实测敲定，靠服务端报错摸出来的）：
//   TTS: POST {baseURL 已含 /v1}/chat/completions
//        body { model, audio?: { voice }, messages:[{role:'assistant', content}] }
//        响应 choices[0].message.audio.data = base64 WAV（content 恒空）
//        要说的话必须放 assistant 角色（user 角色会被 400 拒）
//   ASR: 同端点，model=mimo-v2.5-asr，单个 input_audio 部件、不带 text
//        （网关自动注入提示词），choices[0].message.content = 转写文本
//   语气：段落级自然语言指令（style）拼为（style）text 前缀 —— 官方能力
//   唱歌：文本开头（唱歌）标签；克隆音色不支持唱歌（由 tts.js 决策回落）

const MIMO_VOICES = ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'];

export default {
  id: 'mimo',
  name: '小米 MiMo',
  match(baseUrl) {
    return /xiaomimimo/i.test(String(baseUrl || ''));
  },
  capabilities: { tts: true, clone: true, singing: true, asr: true, style: true },
  voices: MIMO_VOICES,
  defaultVoice: '茉莉',
  defaults: { tts: 'mimo-v2.5-tts', ttsClone: 'mimo-v2.5-tts-voiceclone', asr: 'mimo-v2.5-asr' },
  needs: [],

  async synthesize({ text, style, voice, model, refDataUrl, ep, timeoutMs = 60000 }) {
    // 语气前缀（保持与历史行为逐字节一致：先拼前缀再发）
    let s = String(text ?? '').trim();
    const styleText = String(style ?? '').trim();
    if (styleText) s = `（${styleText}）${s}`;

    const body = { model, messages: [{ role: 'assistant', content: s }] };
    body.audio = { voice: refDataUrl || voice };

    // URL 拼接与主模型同口径：baseURL 已含 /v1，只补 /chat/completions（/v1/v1 会 404）
    let r;
    try {
      r = await fetch(ep.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
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
    const b64 = j?.choices?.[0]?.message?.audio?.data;
    if (!b64) throw new Error(`TTS 响应里没有音频（audio.data 缺失）：${JSON.stringify(j).slice(0, 200)}`);
    return { wav: Buffer.from(b64, 'base64') };
  },

  async transcribe({ wav, model, ep, timeoutMs = 60000 }) {
    let r;
    try {
      r = await fetch(ep.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${ep.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: wav.toString('base64'), format: 'wav' } }] }]
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      return { ok: false, reason: `error:${e?.message ?? e}` };
    }
    if (!r.ok) return { ok: false, reason: `http-${r.status}` };
    const j = await r.json().catch(() => null);
    const text = String(j?.choices?.[0]?.message?.content ?? '').trim();
    if (!text) return { ok: false, reason: 'empty' };
    // 过滤纯拟声/空白占位（供应商偶尔给「（空白）」之类）
    if (/^[（(][^)）]{0,6}[)）]$/.test(text)) return { ok: false, reason: 'blank' };
    return { ok: true, text };
  }
};
