// 〔对话页签〕—— 网页对话（虚拟会话 private:web，走 agent 私聊管道）
// 后端：POST /api/webchat/send（appendIncoming + orchestrator.onIncoming，
//       与 QQ 私聊完全同一管道：记忆/人设/技能/存档 100% 继承）；
//       GET /api/webchat/messages（存档快照）、GET /api/webchat/status。
// 实时性：SSE（02-sse-sessions.js 里注册的 webchat-* 钩子 → 本文件函数）。
// 骨架只建一次；消息区整体重绘（存档页同款，量级 ~500 条以内无压力）。
'use strict';

let webchatSkeletonBuilt = false;
let webchatMsgs = [];            // 存档消息（最近 N 条）
let webchatRunning = false;      // agent 正在处理（对方正在思考）
let webchatPaused = false;
let webchatModel = '';
let webchatStatusTimer = null;   // 本页停留时的状态轮询（与外联页同款模式）
let webchatReloadTimer = null;   // chat-update 合批（SSE 一秒能来好几发）
let webchatSending = false;      // 防重复提交（Enter 连按）

function webchatStatusText() {
  const parts = [];
  if (webchatModel) parts.push(`模型：${webchatModel}`);
  if (webchatRunning) parts.push('处理中…');
  else if (webchatPaused) parts.push('已暂停（消息会入库，恢复后统一处理）');
  return parts.join(' · ') || '待命中';
}

function renderWebchatMsgRow(m) {
  // 网页用户的发言在右侧（.u），机器人的回复在左侧（.a）。
  // self=true 一定是机器人（appendSelf）；senderId==='web' 一定是网页用户。
  const mine = m.senderId === 'web';
  // 存档里 self 条目的 senderName 恒为「我」（存档页主人视角）——
  // 对话页是聊天视角，机器人一侧要用机器人自己的名字。
  const name = mine
    ? (state.config?.webChat?.senderName || '网页用户')
    : (state.config?.persona?.botName || '机器人');
  const av = mine ? '网' : '机';
  const time = fmtClock(m.ts);
  return `
    <div class="msg ${mine ? 'u' : 'a'}" data-mid="${Number(m.id) || 0}">
      <div class="av">${esc(av)}</div>
      <div class="bub">
        <div class="who">${esc(name)} · ${esc(time)}</div>
        ${esc(m.text)}
      </div>
    </div>`;
}

function renderWebchatMsgs({ keepScroll = true } = {}) {
  const box = $('#webchat-msgs');
  if (!box) return;
  const nearBottom = keepScroll && (box.scrollHeight - box.scrollTop - box.clientHeight < 120);
  box.innerHTML = webchatMsgs.length
    ? webchatMsgs.map(renderWebchatMsgRow).join('')
    : '<div class="empty-hint">还没有对话。发一句话开始 —— 记忆、人设、技能与 QQ 私聊完全一致。</div>';
  // 贴底优先；只有"用户明显往上翻了"时才不打断阅读位置
  if (!keepScroll || nearBottom) box.scrollTop = box.scrollHeight;
}

function renderWebchatStatus() {
  const el = $('#webchat-status');
  if (el) el.textContent = webchatStatusText();
  const typing = $('#webchat-typing');
  if (typing) {
    typing.hidden = !webchatRunning;
    if (webchatRunning) typing.innerHTML = '<span class="dot dot-on"></span>正在处理（触发→聚批→回复与 QQ 私聊同节奏，通常几秒到十几秒）…';
  }
}

/** 建骨架（仅一次）。 */
function buildWebchatSkeleton() {
  const box = $('#webchat-page');
  if (!box || webchatSkeletonBuilt) return;
  box.classList.remove('usage-pane');   // 聊天页要整页单栏，不吃 usage-pane 的内边距
  box.classList.add('webchat-pane');
  box.innerHTML = `
    <div class="webchat-head">
      <h3>对话</h3>
      <span class="muted" style="font-size:12px" id="webchat-status">加载中…</span>
      <span class="nav-spacer"></span>
      <button class="btn btn-small" id="webchat-clear-btn" title="清空网页对话存档（不影响 QQ 会话与记忆文件本体）">清空对话</button>
    </div>
    <div class="webchat-msgs" id="webchat-msgs"></div>
    <div class="webchat-typing" id="webchat-typing" hidden></div>
    <div class="webchat-composer">
      <textarea id="webchat-input" placeholder="发消息给机器人…（Enter 发送，Shift+Enter 换行）" rows="2"></textarea>
      <button class="btn" id="webchat-send">发送</button>
    </div>
    <div class="webchat-hint">这条对话是机器人眼里的一个私聊会话：看到的记忆、人设、技能、会话页记录与 QQ 私聊完全相同，全部内容进存档。</div>
  `;

  const input = box.querySelector('#webchat-input');
  const send = async () => {
    const text = String(input?.value || '').trim();
    if (!text || webchatSending) return;
    webchatSending = true;
    try {
      input.value = '';
      input.style.height = 'auto';
      // 乐观上屏：立刻看到自己的话；SSE chat-update 会带来带 id 的正式版本，
      // 重绘时按内容去重由"重拉全量"天然覆盖，这里只做即时反馈。
      webchatMsgs.push({ id: -Date.now(), ts: Date.now(), senderId: 'web', senderName: '', text });
      renderWebchatMsgs();
      await api('/api/webchat/send', { method: 'POST', body: JSON.stringify({ text }) });
      scheduleWebchatReload(300);
    } catch (e) {
      showAppAlert(`发送失败：${e?.message || e}`);
      // 发送失败：把乐观消息撤下来（按刚 push 的内容匹配）
      webchatMsgs = webchatMsgs.filter((m) => !(m.id < 0 && m.text === text));
      renderWebchatMsgs();
    } finally {
      webchatSending = false;
    }
  };
  box.querySelector('#webchat-send')?.addEventListener('click', send);
  input?.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      send();
    }
  });
  // 输入框自适应高度（与普通 textarea 不同，聊天框随内容长高）
  input?.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(170, input.scrollHeight) + 'px';
  });
  box.querySelector('#webchat-clear-btn')?.addEventListener('click', async () => {
    if (!(await uiConfirm('清空「网页对话」的全部消息？\n（QQ 会话与记忆文件不受影响）'))) return;
    try {
      await api('/api/chats/private_web/clear', { method: 'POST', body: '{}' });
      webchatMsgs = [];
      renderWebchatMsgs({ keepScroll: false });
    } catch (e) {
      showAppAlert(`清空失败：${e?.message || e}`);
    }
  });

  webchatSkeletonBuilt = true;
}

/** 拉存档 + 状态。 */
async function loadWebChatInner({ quiet = false } = {}) {
  const box = $('#webchat-page');
  if (!box) return;
  try {
    const [msgData, status] = await Promise.all([
      api('/api/webchat/messages?limit=300'),
      api('/api/webchat/status')
    ]);
    webchatMsgs = Array.isArray(msgData.messages) ? msgData.messages : [];
    webchatRunning = !!status.running;
    webchatPaused = !!status.paused;
    webchatModel = String(status.model || '');
    if (!webchatSkeletonBuilt) buildWebchatSkeleton();
    renderWebchatMsgs({ keepScroll: quiet });
    renderWebchatStatus();
  } catch (e) {
    if (!quiet && box) box.innerHTML = `<div class="empty-hint">对话页加载失败：${esc(e?.message || e)}</div>`;
  }
}

/** chat-update 合批：SSE 一秒能来多发，统一 300ms 窗口后拉一次。 */
function scheduleWebchatReload(delay = 300) {
  if (webchatReloadTimer) return;
  webchatReloadTimer = setTimeout(() => {
    webchatReloadTimer = null;
    if (state.tab === 'webchat') loadWebChatInner({ quiet: true });
  }, delay);
}

function loadWebChat() {
  buildWebchatSkeleton();
  loadWebChatInner();
  ensureWebchatStatusPoll();
}

// 停留在本页时的轻量状态轮询：SSE 没连上/事件丢了也能自愈（处理中指示灯不假死）。
function ensureWebchatStatusPoll() {
  if (webchatStatusTimer) return;
  webchatStatusTimer = setInterval(async () => {
    if (state.tab !== 'webchat' || document.visibilityState !== 'visible') return;
    try {
      const status = await api('/api/webchat/status');
      const changed = (!!status.running) !== webchatRunning || (!!status.paused) !== webchatPaused;
      webchatRunning = !!status.running;
      webchatPaused = !!status.paused;
      webchatModel = String(status.model || '');
      if (changed) renderWebchatStatus();
    } catch { /* 瞬时错误忽略 */ }
  }, 5000);
}

// ── SSE 钩子（由 02-sse-sessions.js 的 connectSSE 调用）────────────────
function webchatSSEChatUpdate(chatKey) {
  if (chatKey && chatKey !== 'private:web') return;
  scheduleWebchatReload();
}
function webchatSSESessionEvent(data) {
  if (!data || data.chatKey !== 'private:web') return;
  if (data.status === 'running') webchatRunning = true;
  if (['done', 'error', 'aborted', 'noreply', 'discarded'].includes(data.status)) {
    webchatRunning = false;
    // 收尾兜底重拉：发送后的 chat-update 理论上已带最新消息，
    // 但 SSE 丢一发就"少了最后一条回复"——会话结束再补一次，读档幂等。
    scheduleWebchatReload(500);
  }
  renderWebchatStatus();
}
