// 〔驾驶舱页签〕—— sn0wbot 默认首页：全局状态一览（v0.8 UI 重设计）
// 后端：GET /api/channels（通道元数据）+ GET /api/status（QQ/用量/编排状态）
//       + GET /api/sessions（最近会话摘要）。
// 纪律：骨架只建一次；轮询/刷新只替换数据节点（#dash-channels /
//       #dash-usage / #dash-recent），绝不整页 innerHTML 重建（AGENTS.md）。
'use strict';

let dashSkeletonBuilt = false;
let dashTimer = null;          // 本页停留时的轮询（与通道页同款）
let dashLastStatus = null;     // /api/status 缓存（SSE 会话更新时可复用）

function dashTime(ts) {
  if (!ts) return '';
  try { return fmtClock(Number(ts)); } catch { return ''; }
}

/** 通道卡：状态灯 + 名称 + 能力徽标 + 详情一行。点击跳通道页。 */
function renderDashChannelCard(ch) {
  const last = ch.lastStatus ?? {};
  let light = 'off', detail = '';
  if (ch.status === 'started' && last.connected) { light = 'on'; detail = last.detail ?? '运行中'; }
  else if (ch.status === 'started' && last.connected === false && last.error) { light = 'err'; detail = String(last.error).slice(0, 90); }
  else if (ch.status === 'started' && last.connected === false) { light = 'warn'; detail = last.reason ?? '未连接'; }
  else if (ch.status === 'error') { light = 'err'; detail = ch.lastError ?? '异常'; }
  else if (ch.status === 'starting') { light = 'warn'; detail = '启动中…'; }
  else { light = 'off'; detail = last.reason ?? '已停止'; }

  const channelColor = { qq: 'var(--ch-qq)', browser: 'var(--ch-browser)', mail: 'var(--ch-mail)' }[ch.id] ?? 'var(--tx3)';
  const channelIcon = { qq: '💬', browser: '🌐', mail: '📧' }[ch.id] ?? '🔌';
  // 卡片链接式：每个通道直达自己的管理页（有专属页的直达，没有的进通道总览）
  const jumpTarget = { qq: 'snowluma', browser: 'channels', mail: 'channels' }[ch.id] ?? 'channels';
  const caps = (ch.capabilities ?? []).slice(0, 4);
  const capNames = { message: '消息', media: '媒体', sticker: '表情', voice: '语音', poke: '互动', history: '历史', control: '操控', verifiedSender: '可信身份' };

  return `
    <div class="dash-card" data-channel-id="${esc(ch.id)}" data-tab-jump="${jumpTarget}" style="--ch-color: ${channelColor}">
      <div class="dash-card-head">
        <span class="dash-ic-chip">${channelIcon}</span>
        <b>${esc(ch.label)}</b>
        <span class="status-light ${light}"></span>
        <span class="dash-manage" data-manage="${jumpTarget}" title="管理设置">⚙</span>
      </div>
      <div class="dash-card-body">${esc(detail || '—')}</div>
      <div class="dash-caps">${caps.map((cap) => `<span class="tag">${esc(capNames[cap] ?? cap)}</span>`).join('')}</div>
      <div class="dash-launch-hint">点击启动</div>
    </div>`;
}

function renderDashChannels(channels) {
  const node = document.getElementById('dash-channels');
  if (!node) return;
  node.innerHTML = (channels ?? []).length
    ? (channels ?? []).map(renderDashChannelCard).join('')
    : '<div class="dash-empty">没有已注册的通道。</div>';
  // 卡片可点 → 跳通道页（事件委托一次绑定在容器上）
}

function renderDashUsage(st) {
  const node = document.getElementById('dash-usage');
  if (!node || !st) return;
  const cost = Number(st.cost) || 0;
  const tokens = Number(st.usage?.totalTokens) || 0;
  const runs = Number(st.usage?.runs) || 0;
  const cache = Number(st.cacheHitRate) || 0;
  const searches = Number(st.webSearchCount) || 0;
  node.innerHTML = `
    <div class="u-cell"><div class="u-num">¥${cost.toFixed(2)}</div><div class="u-lb">今日成本</div></div>
    <div class="u-cell"><div class="u-num">${runs}</div><div class="u-lb">今日对话</div></div>
    <div class="u-cell"><div class="u-num">${tokens.toLocaleString()}</div><div class="u-lb">今日 tokens</div></div>
    <div class="u-cell"><div class="u-num">${cache}%</div><div class="u-lb">缓存命中</div></div>
    <div class="u-cell"><div class="u-num">${searches}</div><div class="u-lb">网页搜索</div></div>`;
}

function renderDashRecent(sessions) {
  const node = document.getElementById('dash-recent');
  if (!node) return;
  const rows = (sessions ?? []).slice(0, 6);
  if (!rows.length) {
    node.innerHTML = '<div class="dash-empty">还没有会话记录 —— 在 QQ 里 @ 它，或在「对话」页和它聊一句。</div>';
    return;
  }
  node.innerHTML = rows.map((s) => {
    const title = esc(String(s.title || s.chatKey || s.id || '会话').slice(0, 42));
    const when = dashTime(s.updatedAt ?? s.lastAt ?? s.ts);
    const n = Number(s.messageCount ?? s.count ?? 0);
    return `<div class="r-row"><b>${title}</b><span>${n ? n + ' 条' : ''}</span><span class="r-time">${esc(when)}</span></div>`;
  }).join('');
}

function renderDashHello(st) {
  const node = document.getElementById('dash-hello-state');
  if (!node || !st) return;
  const running = !st.paused;
  const self = st.onebot?.self;
  const qqName = self ? `${self.nickname}（${self.userId}）` : '未登录';
  const stateText = running
    ? '<span class="dot dot-on"></span>运行中'
    : '<span class="dot dot-warn"></span>已暂停' + (st.pauseReason ? ` · ${esc(String(st.pauseReason))}` : '');
  node.innerHTML = `${stateText}<span class="sep"></span>QQ：${esc(qqName)}`;
}

async function refreshDashboard({ quiet = false } = {}) {
  try {
    const [chRes, stRes, seRes] = await Promise.all([
      api('/api/channels').catch(() => null),
      api('/api/status').catch(() => null),
      api('/api/sessions?limit=8').catch(() => null)
    ]);
    if (chRes) renderDashChannels(chRes.channels ?? []);
    if (stRes) {
      dashLastStatus = stRes;
      renderDashHello(stRes);
      renderDashUsage(stRes);
    }
    if (seRes) renderDashRecent(seRes.sessions ?? []);
  } catch (error) {
    if (!quiet) showAppAlert(`驾驶舱数据加载失败：${error?.message ?? error}`);
  }
}

function buildDashSkeleton() {
  if (dashSkeletonBuilt) return;
  dashSkeletonBuilt = true;
  const page = document.getElementById('dashboard-page');
  if (!page) return;
  page.innerHTML = `
    <div class="dash-wrap">
      <div class="dash-hello">
        <h2>驾驶舱</h2>
        <span class="dash-state" id="dash-hello-state"><span class="dot"></span>加载中…</span>
      </div>
      <div class="dash-grid" id="dash-channels"><div class="dash-empty">加载中…</div></div>
      <div class="dash-usage" id="dash-usage"></div>
      <div class="dash-section">
        <div class="dash-sec-head">
          <h3>最近会话</h3>
          <button class="link-btn" id="dash-more-sessions" type="button">查看全部 →</button>
        </div>
        <div class="dash-recent" id="dash-recent"></div>
      </div>
    </div>`;
  // 通道卡点击 = 启动器：POST launch 拉起对应软件；⚙ 角标 = 跳管理页。
  // 事件委托绑一次，数据节点轮询替换不丢绑定。
  document.getElementById('dash-channels')?.addEventListener('click', async (e) => {
    const card = e.target.closest('.dash-card');
    if (!card) return;
    if (e.target.closest('.dash-manage')) { switchTab(card.dataset.tabJump ?? 'channels'); return; }
    const chId = card.dataset.channelId;
    if (!chId) return;
    try {
      await api(`/api/channels/${encodeURIComponent(chId)}/launch`, { method: 'POST' });
      const body = card.querySelector('.dash-card-body');
      if (body && !body.dataset.launchFlash) {
        body.dataset.launchFlash = '1';
        body.dataset.old = body.textContent;
        body.textContent = '已启动 ✓';
        setTimeout(() => { body.textContent = body.dataset.old ?? ''; delete body.dataset.launchFlash; }, 1600);
      }
    } catch (error) {
      showAppAlert(`启动 ${chId} 失败：${error?.message ?? error}`);
    }
  });
  document.getElementById('dash-more-sessions')?.addEventListener('click', () => switchTab('sessions'));
}

function loadDashboard() {
  buildDashSkeleton();
  refreshDashboard({ quiet: true });
  if (dashTimer) clearInterval(dashTimer);
  dashTimer = setInterval(() => refreshDashboard({ quiet: true }), 8000);
}
