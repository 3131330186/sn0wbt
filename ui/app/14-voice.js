// 〔语音页签〕—— TTS 说 / ASR 听（与外联并列的独立区）+ 实时语音通话
// 自包含页面（同 SnowLuma/外联页模式）：自己拉状态、显式保存。
// 后端：GET /api/speech/status、POST /api/speech/config、POST /api/speech/preview（试听）。
//       通话：GET /api/voice-call/status|devices、POST /api/voice-call/start|stop|config。
'use strict';

const CALL_STATE_TEXT = { idle: '待机', listening: '聆听中', thinking: '思考中', speaking: '说话中', ending: '挂断中', error: '异常' };

/** 通话状态卡（轮询只替换这个节点，绝不动语音表单区）。 */
function renderCallStatusCard(call) {
  const st = call?.state || 'idle';
  const inCall = st !== 'idle' && st !== 'error';
  const dot = st === 'error' ? 'dot-off' : (inCall ? 'dot-on' : '');
  const dur = inCall && call.startedAt ? Math.round((Date.now() - call.startedAt) / 1000) : 0;
  const durText = dur > 0 ? ` · 已通话 ${Math.floor(dur / 60)}分${dur % 60}秒` : '';
  const stats = call?.stats || {};
  const turns = Array.isArray(call?.turns) ? call.turns.slice(-4) : [];
  const turnLines = turns.map((t) => {
    const time = new Date(t.at || Date.now()).toTimeString().slice(0, 8);
    if (t.kind === 'user') return `<div class="muted" style="font-size:12px">${time} 👂 你：${esc(String(t.text).slice(0, 60))}</div>`;
    if (t.kind === 'reply') return `<div class="muted" style="font-size:12px">${time} 💭 它：${esc(String(t.text).slice(0, 60))}</div>`;
    if (t.kind === 'error') return `<div class="muted" style="font-size:12px;color:#c0392b">${time} ✗ ${esc(String(t.message).slice(0, 60))}</div>`;
    if (t.kind === 'asr_failed') return `<div class="muted" style="font-size:12px">${time} [!] 没听清（${esc(t.reason)}）</div>`;
    if (t.kind === 'dropped') return `<div class="muted" style="font-size:12px">${time} [i] 它说话时你开口了（半双工等它说完）</div>`;
    return '';
  }).filter(Boolean).join('');
  return `
    <div class="card" id="call-status-card" style="margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
        <span class="dot ${dot}"></span><b>实时语音通话</b>
        <span class="muted">${CALL_STATE_TEXT[st] || st}${durText}</span>
        ${call?.callId ? `<span class="muted" style="font-size:11px">${esc(call.callId)}</span>` : ''}
        <span style="flex:1"></span>
        <button class="btn btn-small" id="call-start-btn" ${inCall ? 'disabled' : ''}>开始对话</button>
        <button class="btn btn-small btn-danger" id="call-stop-btn" ${inCall ? '' : 'disabled'}>挂断</button>
        <button class="btn btn-small" id="call-tone-btn">测试音</button>
      </div>
      <div class="muted" style="font-size:12px;margin-top:6px">
        接收B：${esc(call?.loopbackDevice || '未配置')} ｜ 发送A：${esc(call?.sendDevice?.name || '开始时自动解析')} ｜ 本通轮次 ${stats.turns || 0}（丢弃 ${stats.dropped || 0} / 听不清 ${stats.asrFail || 0} / 打断 ${stats.bargeIns || 0}）
      </div>
      ${turnLines ? `<div style="margin-top:6px;border-top:1px solid rgba(128,128,128,.2);padding-top:6px">${turnLines}</div>` : ''}
      <div id="call-hint" class="muted" style="font-size:12px;margin-top:4px"></div>
    </div>`;
}

/** 解析 providerId 输入（下拉选 id）。 */
function voiceProviders(cfg) {
  const list = Array.isArray(cfg.providers) ? cfg.providers : [];
  return list.filter((p) => String(p.baseURL || '').trim());
}

function renderVoiceStatusCard(status) {
  // 状态卡独立渲染：轮询只更新这块（纯展示，无输入控件），
  // 绝不重建下面的表单 —— 否则用户选到一半的文件会被清空（真实踩过）。
  const info = status.voiceInfo || null;
  const engine = info ? info.name : '（引擎未知）';
  const caps = info?.capabilities || {};
  const ttsState = `<span class="dot ${status.providerName ? 'dot-on' : 'dot-off'}"></span>` +
    (status.providerName
      ? ` 就绪 · 引擎：<b>${esc(engine)}</b>${info?.capabilitiesText ? `（${esc(info.capabilitiesText)}）` : ''} · 服务商：${esc(status.providerName)}`
      : ` <span style="color:var(--danger,#c0392b)">未找到带 Key 的服务商 —— 先去 设置 → 模型API 配置</span>`);
  const asrState = caps.asr === false
    ? `<span class="dot dot-off"></span> 当前引擎（${esc(engine)}）不支持转写 —— 把「ASR 服务商」指到别的服务商即可`
    : (status.asrEnabled
        ? `<span class="dot dot-on"></span> 开 · 走 ${esc(engine)}（核心适配器）${status.asrPluginReady ? ' · 插件 mimo-asr 兜底在' : ''}`
        : `<span class="dot dot-off"></span> 关`);
  const currentVoice = status.voice || '茉莉';
  const modeText = status.mode === 'clone'
    ? `克隆音色（参考音频：${status.cloneRefFile ? `✅ ${esc(status.cloneRefFile)}` : '⚠ 未上传'}）`
    : `预置音色`;
  // 本地歌声链（SVC）：enabled + ACE-Step 在线才有"能唱"的底气
  const singState = status.singing?.enabled
    ? (status.singing.online
        ? `<span class="dot dot-on"></span> 本地歌声链开 · ACE-Step 在线 —— <b>唱歌=克隆音色（唱说一致）</b>`
        : `<span class="dot dot-off"></span> 本地歌声链已开，但 <b>ACE-Step 服务没开</b> —— 起 start-voice-stack.bat`)
    : `<span class="dot dot-off"></span> 关（（唱歌）退回当前引擎原生能力）`;
  const needNote = (info?.needs || []).length
    ? ` <span style="color:var(--warning,#b7791f)">（需填 ${(info.needs).join(' / ')}）</span>` : '';
  return `
    <div class="scard" id="voice-status-card" style="margin-bottom:14px">
      <h4>状态</h4>
      <div class="sc-row"><div class="sc-k">TTS（说）</div><div>${ttsState}${needNote}</div></div>
      <div class="sc-row"><div class="sc-k">ASR（听）</div><div>${asrState}</div></div>
      <div class="sc-row"><div class="sc-k">歌声链（唱）</div><div>${singState}</div></div>
      <div class="sc-row"><div class="sc-k">当前音色</div><div><b>${esc(currentVoice)}</b> · ${esc(modeText)}</div></div>
    </div>`;
}

function renderVoicePage(status, cfg, call) {
  const box = $('#voice-page');
  if (!box) return;
  const on = status.enabled === true;
  const voices = Array.isArray(status.voices) && status.voices.length ? status.voices : ['mimo_default', '冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean'];
  const provs = voiceProviders(cfg);
  const currentVoice = status.voice || '茉莉';
  // 能力矩阵（voiceInfo 缺失时按 mimo 语义兜底 —— 向后兼容旧后端）
  const info = status.voiceInfo || null;
  const caps = info?.capabilities || {};
  const canClone = caps.clone !== false;
  const chainSing = status.singing?.enabled === true;   // 本地歌声链：唱歌与引擎能力解耦
  const canSing = caps.singing !== false || chainSing;
  const canAsr = caps.asr !== false;
  const engineName = info?.name || '小米 MiMo';
  const defaultVoice = info?.defaultVoice || '茉莉';
  // 当前音色不在本引擎音色表 → 前置一个"将自动回退"的选项（合成时后端回落默认）
  const voiceExtra = currentVoice && !voices.includes(currentVoice)
    ? `<option value="${esc(currentVoice)}" selected>${esc(currentVoice)}（当前引擎不支持，合成时自动回退）</option>` : '';

  box.innerHTML = `
    <h3>语音 · 让它开口说话（还能听）</h3>
    <div class="hint" style="margin-bottom:12px">
      「说」：模型在合适的时机（讲笑话/念台词/唱歌）主动发语音气泡 —— 用 send_voice 工具，总开关在下面。<br />
      「听」：群友发的语音自动转成文字进存档（核心适配器优先，mimo-asr 插件兜底），转写失败时静默回退占位符，不耽误消息处理。<br />
      <b>多引擎</b>：语音引擎可切换（MiMo / OpenAI / MiniMax / GPT-SoVITS）——音色、克隆、唱歌、转写按各引擎能力自动显隐。
    </div>

    ${renderVoiceStatusCard(status)}

    <h4 style="margin:18px 0 8px">实时语音通话（QQ 私聊 · 虚拟声卡桥接）</h4>
    <div class="hint" style="margin-bottom:8px">
      前置：手机拨给 bot QQ → PC 点「接听」→ 通话里麦克风选 <b>CABLE Output</b>、扬声器选 <b>Realtek 扬声器</b>。
      然后点「开始对话」，直接说话即可。v1 半双工：它说话时你插话要等它说完。
    </div>
    ${renderCallStatusCard(call)}

    <div class="field" style="margin-top:10px"><label>接收设备（回环捕获的播放端点；选闲置的 Realtek 扬声器）</label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <select id="cfg-call-device" style="flex:1;min-width:260px"><option value="">加载中…</option></select>
        <button class="btn btn-small" id="cfg-call-device-save">保存接收设备</button>
      </div>
      <div id="cfg-call-hint" class="muted" style="font-size:12px;margin-top:4px"></div>
    </div>

    <div class="checkbox-row" style="margin-top:8px">
      <input type="checkbox" id="cfg-call-autoanswer" ${call?.autoAnswer ? 'checked' : ''} />
      <label for="cfg-call-autoanswer"><b>自动接听</b>（仅下面白名单里的来电自动接 + 自动开始对话；<b>白名单为空 = 谁都不自动接</b>。按窗口显示的昵称匹配，昵称可被伪造，勿录陌生人）</label>
    </div>
    <div class="field">
      <label>自动接听白名单（每行一个昵称，与通话窗口显示一致）</label>
      <textarea id="cfg-call-whitelist" rows="3" style="width:100%" placeholder="例如：小诺世界第一（每行一个）">${esc((call?.whitelist || []).join('\n'))}</textarea>
      <button class="btn btn-small" id="cfg-call-autoanswer-save" style="margin-top:6px">保存自动接听设置</button>
      <div id="cfg-call-autoanswer-hint" class="muted" style="font-size:12px;margin-top:4px"></div>
    </div>

    <div class="checkbox-row" style="margin-bottom:10px">
      <input type="checkbox" id="cfg-voice-enabled" ${on ? 'checked' : ''} />
      <label for="cfg-voice-enabled"><b>启用语音回复</b>（开启后模型可用 send_voice 发语音气泡；默认关——每条都用语音会烦死群友）</label>
    </div>

    <div class="field"><label>服务商（提供 baseUrl + Key；留空 = 自动用第一个带 Key 的）</label>
      <select id="cfg-voice-provider">
        <option value="" ${!status.providerId ? 'selected' : ''}>自动（第一个带 Key 的服务商）</option>
        ${provs.map((p) => `<option value="${esc(p.id)}" ${status.providerId === p.id ? 'selected' : ''}>${esc(p.name || p.id)}（${esc(p.baseURL)}）</option>`).join('')}
      </select></div>

    <div class="field-row">
      <div class="field"><label>语音引擎（用哪家的嗓音；auto = 按服务商地址识别）</label>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <select id="cfg-voice-format" style="flex:1;min-width:200px">
            <option value="auto" ${status.format === 'auto' ? 'selected' : ''}>自动识别</option>
            ${(status.formats || []).map((f) => `<option value="${esc(f.id)}" ${status.format === f.id ? 'selected' : ''}>${esc(f.name)}</option>`).join('')}
          </select>
          ${info ? `<span class="muted" style="font-size:12px">当前 → ${esc(info.name)}</span>` : ''}
        </div>
        <div class="muted" style="font-size:12px;margin-top:4px">换引擎后音色表跟着换（不识别的音色自动回退该引擎默认）；<b>保存后生效</b>。</div>
      </div>
      <div class="field"><label>ASR 服务商（语音转文字；留空 = 跟随 TTS 服务商）</label>
        <select id="cfg-voice-asr-provider">
          <option value="" ${!status.asrProviderId ? 'selected' : ''}>跟随 TTS 服务商</option>
          ${provs.map((p) => `<option value="${esc(p.id)}" ${status.asrProviderId === p.id ? 'selected' : ''}>${esc(p.name || p.id)}（${esc(p.baseURL)}）</option>`).join('')}
        </select></div>
    </div>

    <div class="field-row">
      <div class="field"><label>音色模式</label>
        <select id="cfg-voice-mode">
          <option value="preset" ${status.mode !== 'clone' || !canClone ? 'selected' : ''}>预置音色（引擎音色表内选）</option>
          <option value="clone" ${status.mode === 'clone' && canClone ? 'selected' : ''} ${canClone ? '' : 'disabled'}>克隆音色${canClone ? '（用参考音频的声音说话）' : '（当前引擎不支持）'}</option>
        </select></div>
      <div class="field"><label>音色（预置模式下生效）</label>
        <select id="cfg-voice-name" ${status.mode === 'clone' && canClone ? 'disabled' : ''}>
          ${voiceExtra}
          ${voices.map((v) => `<option value="${esc(v)}" ${v === currentVoice && !voiceExtra ? 'selected' : ''}>${esc(v)}${v === defaultVoice ? '（默认）' : ''}</option>`).join('')}
        </select></div>
      <div class="field"><label>发语音冷却（分钟，0 = 不限）</label>
        <input type="number" id="cfg-voice-cooldown" min="0" value="${Number(status.cooldownMin) || 0}" /></div>
      <div class="field"><label>单条语音字数上限</label>
        <input type="number" id="cfg-voice-maxchars" min="20" max="2000" value="${Number(status.maxChars) || 200}" /></div>
    </div>
    ${canClone ? '' : `<div class="muted" style="font-size:12px;margin-top:-4px;margin-bottom:8px">当前引擎（${esc(engineName)}）不支持音色克隆${canSing ? '' : '，也不支持唱歌'}—— ${canSing ? '唱歌走本地歌声链、不受引擎限制；要克隆请切回「小米 MiMo」。' : '用克隆/唱歌功能请切回「小米 MiMo」。'}</div>`}
    ${info?.cloneOnly ? `<div class="muted" style="font-size:12px;margin-top:-4px;margin-bottom:8px">📌 <b>${esc(engineName)} 是克隆专用引擎</b>：上传参考音频后它永远用那个声音说话（音色下拉无意义）；首次合成会自动转写参考音频做提示文本并缓存（相似度更高）。</div>` : ''}

    <div class="field" id="voice-clone-block" style="${status.mode === 'clone' && canClone ? '' : 'display:none'}">
      <label>克隆参考音频（3~10 秒清晰人声；无需训练，传完即用。⚠ 请只克隆你有权使用的声音）</label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="file" id="cfg-voice-clone-file" accept="audio/wav,audio/mpeg,audio/ogg,audio/mp4,audio/aac,.wav,.mp3,.ogg,.m4a,.aac" style="flex:1;min-width:220px" />
        <button class="btn btn-small" id="cfg-voice-clone-upload">上传参考音频</button>
        <button class="btn btn-small btn-danger" id="cfg-voice-clone-del" ${status.cloneRefReady ? '' : 'disabled'}>删除</button>
      </div>
      <div id="cfg-voice-clone-hint" class="muted" style="font-size:12px;margin-top:4px">
        ${status.cloneRefReady ? '✅ 参考音频已就绪（克隆模式用它说话）' : '还没上传参考音频'}
      </div>
      <audio id="cfg-voice-clone-audio" controls style="display:none;width:100%;margin-top:8px"></audio>
    </div>

    <div class="checkbox-row" style="margin:6px 0 10px">
      <input type="checkbox" id="cfg-voice-asr" ${status.asrEnabled ? 'checked' : ''} ${canAsr ? '' : 'disabled'} />
      <label for="cfg-voice-asr">听懂语音：群友发的语音自动转文字给模型（${canAsr ? `走 ${esc(engineName)}，插件兜底` : '当前引擎不支持转写，请换 ASR 服务商'}）</label>
    </div>

    <div class="field"><label>试听（生成一段直接播放，不用保存也不用开开关；可带语气口吻）</label>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
        <input type="text" id="cfg-voice-preview-text" value="嗨，我是尼斯湖王子！" style="flex:1;min-width:200px" />
        <input type="text" id="cfg-voice-preview-style" placeholder="语气（可选）：如 害羞小声地 / 深情地唱" style="width:230px" />
        <button class="btn btn-small" id="cfg-voice-preview-btn">🔊 试听</button>
        <span id="cfg-voice-preview-hint" class="muted" style="font-size:12px"></span>
      </div>
      <audio id="cfg-voice-preview-audio" controls style="display:none;width:100%;margin-top:8px"></audio>
    </div>

    <details style="margin-top:10px">
      <summary style="cursor:pointer" class="muted">高级：模型名 / 引擎专属参数（一般不用动，留空用默认）</summary>
      <div class="field-row" style="margin-top:8px">
        <div class="field"><label>TTS 模型</label>
          <input type="text" id="cfg-voice-model-tts" value="${esc(status.models?.tts || '')}" placeholder="${esc(info?.defaults?.tts || '引擎默认')}" /></div>
        <div class="field"><label>TTS 克隆模型</label>
          <input type="text" id="cfg-voice-model-ttsclone" value="${esc(status.models?.ttsClone || '')}" placeholder="${esc(info?.defaults?.ttsClone || '引擎默认')}" /></div>
        <div class="field"><label>ASR 模型</label>
          <input type="text" id="cfg-voice-model-asr" value="${esc(status.models?.asr || '')}" placeholder="${esc(info?.defaults?.asr || '引擎默认')}" /></div>
      </div>
      <div class="field-row">
        <div class="field"><label>MiniMax GroupId（可选——只填 Key 也能用；填错会 1004）</label>
          <input type="text" id="cfg-voice-groupid" value="${esc(status.groupId || '')}" placeholder="MiniMax 控制台获取" /></div>
      </div>
    </details>

    <div style="display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap">
      <button class="btn" id="voice-save-btn">保存语音设置</button>
      <button class="btn btn-small" id="voice-refresh-btn">刷新状态</button>
      <span id="voice-save-hint" class="muted" style="font-size:12px"></span>
    </div>

    <div class="muted" style="font-size:11px;margin-top:14px">
      说明：语音气泡走 OneBot record 段，协议端负责把 WAV 转成 QQ 语音格式；若协议端不支持会报错给模型。<br />
      唱歌${chainSing ? '：模型在文本开头加（唱歌）标签即可（歌词建议中文）——<b>走本地歌声链：唱出来就是克隆音色（唱说一致）</b>，约 1~2 分钟一首，ACE-Step 服务要开着。'
        : canSing ? '：模型在文本开头加（唱歌）标签即可（歌词建议中文）；<b>克隆音色不支持唱歌</b>——克隆模式下想唱会自动改用预置音色。'
        : `：<b>当前引擎（${esc(engineName)}）不支持唱歌</b>——（唱歌）标签会直接报错，想唱请切回「小米 MiMo」。`}<br />
      语气口吻：文本内自然语言指令 + 动作标签（（大笑）（叹气）（吸气）等），开放式写法${caps.style === false ? '（当前引擎不支持语气参数，将被忽略）' : ''}。
    </div>
  `;

  // ── 模式切换联动：克隆块显隐 + 预置音色下拉可用性（受引擎能力门控）──
  const modeSel = box.querySelector('#cfg-voice-mode');
  modeSel?.addEventListener('change', () => {
    const isClone = modeSel.value === 'clone' && canClone;
    const cloneBlock = box.querySelector('#voice-clone-block');
    if (cloneBlock) cloneBlock.style.display = isClone ? '' : 'none';
    const nameSel = box.querySelector('#cfg-voice-name');
    if (nameSel) nameSel.disabled = isClone;
  });

  // ── 参考音频上传 / 删除 ──
  // 格式按**扩展名**自行标注 —— 浏览器对 .m4a/.aac 常给 application/octet-stream，
  // 直接 readAsDataURL 会把错误 MIME 传给后端导致被拒（真实踩过）。
  const VOICE_MIME = { wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', m4a: 'audio/mp4', aac: 'audio/aac' };
  function bufToB64(arrayBuf) {
    const bytes = new Uint8Array(arrayBuf);
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    }
    return btoa(bin);
  }
  box.querySelector('#cfg-voice-clone-upload')?.addEventListener('click', async () => {
    const fileInput = box.querySelector('#cfg-voice-clone-file');
    const hint = box.querySelector('#cfg-voice-clone-hint');
    const f = fileInput?.files?.[0];
    if (!f) { if (hint) hint.textContent = '先选一个音频文件'; return; }
    const ext = (f.name.split('.').pop() || '').toLowerCase();
    const mime = VOICE_MIME[ext];
    if (!mime) { if (hint) hint.textContent = '只支持 wav / mp3 / ogg / m4a / aac'; return; }
    if (f.size > 8 * 1024 * 1024) { if (hint) hint.textContent = '文件超过 8MB，截一段 3~10 秒的'; return; }
    const btn = box.querySelector('#cfg-voice-clone-upload');
    if (btn) btn.disabled = true;
    if (hint) hint.textContent = '上传中…';
    try {
      const buf = await f.arrayBuffer();
      const dataUrl = `data:${mime};base64,${bufToB64(buf)}`;
      const r = await api('/api/speech/clone-ref', { method: 'POST', body: JSON.stringify({ audioDataUrl: dataUrl }) });
      if (r?.ok) {
        // 本地预览上传的样本
        const audio = box.querySelector('#cfg-voice-clone-audio');
        if (audio) { audio.src = URL.createObjectURL(f); audio.style.display = ''; }
        if (hint) hint.textContent = `✅ 已上传并保存到服务器（${Math.round(f.size / 1024)}KB）—— 点「保存语音设置」后克隆模式即用该声音`;
        loadVoicePageInner({ quiet: true, statusOnly: true });   // 状态卡即时变绿（不动表单）
      } else {
        if (hint) hint.textContent = `上传失败：${r?.error || '未知'}`;
      }
    } catch (e) {
      if (hint) hint.textContent = `上传失败：${e?.message || e}`;
    } finally {
      const b2 = box.querySelector('#cfg-voice-clone-upload');
      if (b2) b2.disabled = false;
    }
  });

  box.querySelector('#cfg-voice-clone-del')?.addEventListener('click', async () => {
    try {
      await api('/api/speech/clone-ref', { method: 'DELETE' });
      await loadVoicePage({ quiet: true });
    } catch (e) {
      const hint = box.querySelector('#cfg-voice-clone-hint');
      if (hint) hint.textContent = `删除失败：${e?.message || e}`;
    }
  });

  // ── 试听 ──
  box.querySelector('#cfg-voice-preview-btn')?.addEventListener('click', async () => {
    const btn = box.querySelector('#cfg-voice-preview-btn');
    const hint = box.querySelector('#cfg-voice-preview-hint');
    const audio = box.querySelector('#cfg-voice-preview-audio');
    const text = box.querySelector('#cfg-voice-preview-text').value.trim();
    if (!text) { if (hint) hint.textContent = '先输入要听的话'; return; }
    if (btn) btn.disabled = true;
    if (hint) hint.textContent = '生成中…';
    try {
      const style = box.querySelector('#cfg-voice-preview-style').value.trim();
      const r = await api('/api/speech/preview', {
        method: 'POST',
        body: JSON.stringify({ text, style: style || null })
      });
      if (r?.ok && r.audioDataUrl) {
        audio.src = r.audioDataUrl;
        audio.style.display = '';
        try { await audio.play(); } catch { /* 自动播放被拦就让用户手点 */ }
        if (hint) hint.textContent = `${r.voice} · ${(r.bytes / 1024).toFixed(0)}KB`;
      } else {
        if (hint) hint.textContent = `失败：${r?.error || '未知'}`;
      }
    } catch (e) {
      if (hint) hint.textContent = `失败：${e?.message || e}`;
    } finally {
      const b2 = box.querySelector('#cfg-voice-preview-btn');
      if (b2) b2.disabled = false;
    }
  });

  // ── 保存 ──
  box.querySelector('#voice-save-btn')?.addEventListener('click', async () => {
    const hint = box.querySelector('#voice-save-hint');
    const btn = box.querySelector('#voice-save-btn');
    if (btn) btn.disabled = true;
    if (hint) hint.textContent = '保存中…';
    try {
      const body = {
        enabled: box.querySelector('#cfg-voice-enabled').checked,
        providerId: box.querySelector('#cfg-voice-provider').value,
        voice: box.querySelector('#cfg-voice-name').value,
        mode: box.querySelector('#cfg-voice-mode').value,
        cooldownMin: Number(box.querySelector('#cfg-voice-cooldown').value) || 0,
        maxChars: Number(box.querySelector('#cfg-voice-maxchars').value) || 200,
        asrEnabled: box.querySelector('#cfg-voice-asr').checked,
        // 多引擎（Phase A）
        format: box.querySelector('#cfg-voice-format')?.value || 'auto',
        asrProviderId: box.querySelector('#cfg-voice-asr-provider')?.value || '',
        groupId: box.querySelector('#cfg-voice-groupid')?.value || '',
        models: {
          tts: box.querySelector('#cfg-voice-model-tts')?.value || '',
          ttsClone: box.querySelector('#cfg-voice-model-ttsclone')?.value || '',
          asr: box.querySelector('#cfg-voice-model-asr')?.value || ''
        }
      };
      const r = await api('/api/speech/config', { method: 'POST', body: JSON.stringify(body) });
      if (hint) hint.textContent = r?.ok ? '已保存，立即生效' : '保存失败';
      // 保存后只刷状态卡 —— 不全量重建（文件选择框在浏览器安全模型下
      // 重建后必然显示为空，用户会误以为"又消失了"；表单内容原样保留）
      await loadVoicePageInner({ quiet: true, statusOnly: true });
      // 再把表单字段的【值】同步成服务端最新（不重建 DOM，文件选择不动）——
      // 否则表单里留着保存前的旧值，下次点保存会把别处改过的配置覆盖回去
      // （真实踩过：语音页保存把控制台 API 改好的 asr.providerId 清了回去）
      if (r?.ok) syncVoiceFormFromStatus();
    } catch (e) {
      if (hint) hint.textContent = `保存失败：${e?.message || e}`;
    } finally {
      const b2 = box.querySelector('#voice-save-btn');
      if (b2) b2.disabled = false;
    }
  });

  // ── 通话区：事件委托绑一次（状态卡被轮询替换后监听器仍在 box 上活着）──
  if (!box.dataset.callWired) {
    box.dataset.callWired = '1';
    box.addEventListener('click', async (e) => {
      const id = e.target?.id;
      if (id === 'call-tone-btn') {
        const hint = box.querySelector('#call-hint');
        try {
          if (hint) hint.textContent = '播放测试音中…（通话中点它 = 手机应听到"嘟——"）';
          const r = await api('/api/voice-call/tone', { method: 'POST', body: '{}' });
          if (hint) hint.textContent = r?.ok ? `✅ 测试音已播到 [${r.device}]——手机听到了就说明通道 A 正常` : `✗ ${r?.error || '播放失败'}`;
        } catch (err) {
          if (hint) hint.textContent = `失败：${err?.message || err}`;
        }
        return;
      }
      if (id === 'call-start-btn' || id === 'call-stop-btn') {
        const hint = box.querySelector('#call-hint');
        try {
          if (id === 'call-start-btn') {
            if (hint) hint.textContent = '连接中…';
            const r = await api('/api/voice-call/start', { method: 'POST', body: '{}' });
            if (hint) hint.textContent = r?.ok ? '通话开始 —— 对手机说话吧' : `开始失败：${r?.error || '未知'}`;
          } else {
            const r = await api('/api/voice-call/stop', { method: 'POST', body: '{}' });
            if (hint) hint.textContent = r?.ok ? '已挂断' : `挂断失败：${r?.error || '未知'}`;
          }
        } catch (err) {
          if (hint) hint.textContent = `操作失败：${err?.message || err}`;
        }
        await refreshCallCard();
      } else if (id === 'cfg-call-device-save') {
        const sel = box.querySelector('#cfg-call-device');
        const hint = box.querySelector('#cfg-call-hint');
        try {
          const r = await api('/api/voice-call/config', { method: 'POST', body: JSON.stringify({ loopbackDevice: sel?.value || '' }) });
          if (hint) hint.textContent = r?.ok ? '已保存（下次开始对话生效）' : `保存失败：${r?.error || '未知'}`;
          await refreshCallCard();
        } catch (err) {
          if (hint) hint.textContent = `保存失败：${err?.message || err}`;
        }
      } else if (id === 'cfg-call-autoanswer-save') {
        const hint = box.querySelector('#cfg-call-autoanswer-hint');
        try {
          const body = {
            autoAnswer: box.querySelector('#cfg-call-autoanswer').checked,
            whitelist: (box.querySelector('#cfg-call-whitelist').value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
          };
          const r = await api('/api/voice-call/config', { method: 'POST', body: JSON.stringify(body) });
          if (hint) {
            hint.textContent = !r?.ok ? `保存失败：${r?.error || '未知'}`
              : (body.autoAnswer && !body.whitelist.length)
                ? '⚠ 已保存，但白名单为空 —— 谁都不会被自动接（fail-closed）'
                : '已保存（看门狗 2 秒内生效）';
          }
          await refreshCallCard();
        } catch (err) {
          if (hint) hint.textContent = `保存失败：${err?.message || err}`;
        }
      }
    });
  }
  // 接收设备下拉（异步填充，不阻塞渲染）
  api('/api/voice-call/devices').then((r) => {
    const sel = box.querySelector('#cfg-call-device');
    if (!sel) return;
    const eps = Array.isArray(r?.endpoints) ? r.endpoints : [];
    sel.innerHTML = eps.map((d) => `<option value="${esc(d.name)}" ${d.name === call?.loopbackDevice ? 'selected' : ''}>${esc(d.name)}</option>`).join('')
      || '<option value="">（枚举失败）</option>';
  }).catch(() => { /* 下拉保持加载中 */ });

  // ── 刷新状态按钮：只更新状态卡，不重建表单（保护文件选择/输入中内容）──
  box.querySelector('#voice-refresh-btn')?.addEventListener('click', () => loadVoicePageInner({ quiet: true, statusOnly: true }));
}

async function refreshCallCard() {
  const box = $('#voice-page');
  if (!box) return;
  try {
    const call = await api('/api/voice-call/status');
    const card = box.querySelector('#call-status-card');
    if (card) card.outerHTML = renderCallStatusCard(call);
  } catch { /* 轮询失败不打扰 */ }
}

// 保存成功后把表单字段的值刷成服务端最新 —— 只改 value/checked，不重建节点：
// 文件选择框、输入中的内容原样保留；select 的 value 若不在选项表里会被浏览器忽略（安全）。
function syncVoiceFormFromStatus() {
  const box = $('#voice-page');
  if (!box) return;
  api('/api/speech/status').then((status) => {
    if (!status) return;
    const set = (id, v) => { const el = box.querySelector('#' + id); if (el && v !== undefined && v !== null) el.value = String(v); };
    const chk = (id, v) => { const el = box.querySelector('#' + id); if (el) el.checked = !!v; };
    chk('cfg-voice-enabled', status.enabled === true);
    set('cfg-voice-provider', status.providerId || '');
    set('cfg-voice-format', status.format || 'auto');
    set('cfg-voice-asr-provider', status.asrProviderId || '');
    set('cfg-voice-mode', status.mode === 'clone' ? 'clone' : 'preset');
    set('cfg-voice-name', status.voice || '');
    const cd = box.querySelector('#cfg-voice-cooldown'); if (cd) cd.value = Number(status.cooldownMin) || 0;
    const mc = box.querySelector('#cfg-voice-maxchars'); if (mc) mc.value = Number(status.maxChars) || 200;
    set('cfg-voice-groupid', status.groupId || '');
    chk('cfg-voice-asr', status.asrEnabled);
    set('cfg-voice-model-tts', status.models?.tts ?? '');
    set('cfg-voice-model-ttsclone', status.models?.ttsClone ?? '');
    set('cfg-voice-model-asr', status.models?.asr ?? '');
  }).catch(() => { /* 同步失败不阻塞保存流程 */ });
}

async function loadVoicePageInner({ quiet = false, statusOnly = false } = {}) {
  const box = $('#voice-page');
  if (!box) return;
  try {
    if (statusOnly) {
      // 轮询/刷新状态：只更新状态卡，绝不重建表单区 —— 用户选到一半的文件、
      // 正在输入的字段都不许被吹掉（真实故障：轮询重建把选好的文件清空）。
      const status = await api('/api/speech/status');
      const card = box.querySelector('#voice-status-card');
      if (card) card.outerHTML = renderVoiceStatusCard(status);
      await refreshCallCard();
      return;
    }
    const [status, config, call] = await Promise.all([
      api('/api/speech/status'),
      api('/api/config'),
      api('/api/voice-call/status')
    ]);
    if (config) state.config = config;
    renderVoicePage(status, config || {}, call || {});
    if (!quiet && typeof uiEnter === 'function') uiEnter(box);
  } catch (e) {
    if (!quiet) box.innerHTML = `<div class="empty-hint">语音页加载失败：${esc(e?.message || e)}</div>`;
  }
}

function loadVoicePage(opts = {}) {
  ensureVoicePoll();   // 首次进入本页时启动轻量轮询
  ensureCallPoll();    // 通话卡快轮询（通话中 2.5s 能看到状态/字幕）
  return loadVoicePageInner(opts);
}

// 停留在本页时轻量轮询（15s）：只刷状态卡（插拔/服务商变化能看到），
// 表单区不动 —— 文件选择、输入中的内容永远安全。
let voicePollTimer = null;
function ensureVoicePoll() {
  if (voicePollTimer) return;
  voicePollTimer = setInterval(() => {
    if (state.tab === 'voice' && document.visibilityState === 'visible') {
      loadVoicePageInner({ quiet: true, statusOnly: true });
    }
  }, 15000);
}

// 通话卡快轮询（2.5s，仅通话卡节点，接口零副作用）。语音表单区仍走 15s 慢轮询。
let callPollTimer = null;
function ensureCallPoll() {
  if (callPollTimer) return;
  callPollTimer = setInterval(() => {
    if (state.tab === 'voice' && document.visibilityState === 'visible') {
      refreshCallCard();
    }
  }, 2500);
}
