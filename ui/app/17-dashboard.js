// 〔驾驶舱页签〕—— sn0wbot 默认首页：全局状态一览（v0.8 UI 重设计）
// 后端：GET /api/channels（通道元数据）+ GET /api/status（QQ/用量/编排状态）
//       + GET /api/sessions（最近会话摘要）。
// 纪律：骨架只建一次；轮询/刷新只替换数据节点（#dash-channels /
//       #dash-usage / #dash-recent），绝不整页 innerHTML 重建（AGENTS.md）。
'use strict';

let dashSkeletonBuilt = false;
let dashTimer = null;          // 本页停留时的轮询（与通道页同款）
let dashLastStatus = null;     // /api/status 缓存（SSE 会话更新时可复用）
let dashQQInstances = [];      // 已登录 QQ 实例（账号分卡；探针不可用时为空 → 落回单卡）
let dashBridgedAccount = '';   // 桥接正在驱动的账号昵称

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

/** QQ 账号卡：一个已登录实例一张卡（多开互不混淆）。点击 = 唤起该账号的窗口。 */
function renderDashQQAccountCard(inst) {
  const bridged = dashBridgedAccount && inst.account === dashBridgedAccount;
  const light = bridged ? 'on' : (inst.minimized ? 'warn' : 'off');
  const detail = bridged ? '桥接驱动中 · 点击唤起窗口'
    : (inst.minimized ? '已最小化 · 点击唤起' : '未接桥接 · 点击唤起窗口');
  return `
    <div class="dash-card dash-card-acct" data-channel-id="qq" data-hwnd="${Number(inst.hwnd)}"
         data-tab-jump="snowluma" style="--ch-color: var(--ch-qq)">
      <div class="dash-card-head">
        <span class="dash-ic-chip">👤</span>
        <b>${esc(inst.account)}</b>
        <span class="status-light ${light}"></span>
        <span class="dash-manage" data-manage="snowluma" title="QQ 通道管理">⚙</span>
      </div>
      <div class="dash-card-body">${esc(detail)}</div>
      <div class="dash-caps"><span class="tag">QQ 登录实例</span></div>
      <div class="dash-launch-hint">点击唤起</div>
    </div>`;
}

function renderDashChannels(channels) {
  const node = document.getElementById('dash-channels');
  if (!node) return;
  if (!(channels ?? []).length) {
    node.innerHTML = '<div class="dash-empty">没有已注册的通道。</div>';
    return;
  }
  // QQ 特殊化：通道已接入且桥接在线时，探测到几个登录实例就每账号一张卡
  // （点谁唤起谁）；未接入/探针不可用 → 落回通用通道卡（未接入态）。
  const parts = [];
  for (const ch of channels) {
    if (ch.id === 'qq' && ch.status === 'started' && ch.lastStatus?.connected && dashQQInstances.length) {
      parts.push(...dashQQInstances.map(renderDashQQAccountCard));
    } else {
      parts.push(renderDashChannelCard(ch));
    }
  }
  parts.push(renderDashAddCard());
  node.innerHTML = parts.join('');
}

/** [+] 添加链接卡：常驻最后一格，点开接入向导。 */
function renderDashAddCard() {
  return `
    <div class="dash-card dash-card-add" data-add="1">
      <div class="dash-add-plus">＋</div>
      <div class="dash-add-t1">添加链接</div>
      <div class="dash-add-t2">接入浏览器 / 邮箱 / 更多软件</div>
    </div>`;
}

/** 接入向导弹窗：目录项 → 迷你表单 → 建立链接（成功后驾驶舱自动出新卡）。 */
async function openChannelConnectModal() {
  let catalog = [];
  try {
    catalog = (await api('/api/channels/catalog')).catalog ?? [];
  } catch (error) {
    showAppAlert(`通道目录加载失败：${error?.message ?? error}`);
    return;
  }
  const rowsHtml = catalog.map((item) => `
    <div class="connect-row" data-channel="${esc(item.id)}">
      <span class="cr-icon">${esc(item.icon)}</span>
      <div class="cr-main">
        <div class="cr-name">${esc(item.label)}
          ${item.enabled ? '<span class="tag ok">已接入</span>' : ''}
        </div>
        <div class="cr-desc">${esc(item.desc)}</div>
        <div class="cr-form" hidden>
          ${(item.form ?? []).map((f) => `
            <label><span>${esc(f.label)}</span>
              <input type="${esc(f.type ?? 'text')}" data-path="${esc(f.path)}"
                     placeholder="${esc(f.placeholder ?? '')}" autocomplete="off">
            </label>`).join('')}
          ${item.hint ? `<div class="connect-hint">ℹ️ ${esc(item.hint)}</div>` : ''}
          <div class="connect-err" data-err></div>
          <div class="connect-foot">
            <button class="btn primary" data-connect="${esc(item.id)}">${item.enabled ? '更新并重启通道' : '建立链接'}</button>
          </div>
        </div>
      </div>
      <button class="btn" data-toggle="${esc(item.id)}">${item.enabled ? '管理' : '接入'}</button>
    </div>`).join('');

  const overlay = modelModalShell({
    head: '添加链接',
    body: `<div class="connect-list">${rowsHtml}</div>`,
    foot: '<span class="muted" style="font-size:11.5px">接入的通道只在链接成功后出现在驾驶舱</span>'
  });

  // 展开/收起表单
  overlay.addEventListener('click', async (e) => {
    const toggle = e.target.closest('[data-toggle]');
    if (toggle) {
      const row = toggle.closest('.connect-row');
      const form = row?.querySelector('.cr-form');
      if (form) form.hidden = !form.hidden;
      return;
    }
    const btn = e.target.closest('[data-connect]');
    if (!btn) return;
    const row = btn.closest('.connect-row');
    const chId = btn.getAttribute('data-connect');
    const errNode = row.querySelector('[data-err]');
    const values = {};
    row.querySelectorAll('.cr-form input[data-path]').forEach((input) => {
      values[input.dataset.path] = input.value.trim();
    });
    btn.disabled = true;
    errNode.textContent = '';
    try {
      const result = await api(`/api/channels/${encodeURIComponent(chId)}/enable`, {
        method: 'POST',
        body: JSON.stringify({ enabled: true, config: values })
      });
      closeModelModal(overlay);
      showAppAlert(`${chId === 'mail' ? '邮箱' : chId === 'browser' ? '浏览器' : chId} 链接成功${result.status === 'error' ? '，但通道启动异常，请到通道页查看' : ''} ✓`);
      refreshDashboard({ quiet: true });
    } catch (error) {
      errNode.textContent = `建立链接失败：${error?.message ?? error}`;
    } finally {
      btn.disabled = false;
    }
  });
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
    <div class="u-cell"><div class="u-num">${Math.round(cache)}%</div><div class="u-lb">缓存命中</div></div>
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
    const [chRes, stRes, seRes, inRes] = await Promise.all([
      api('/api/channels').catch(() => null),
      api('/api/status').catch(() => null),
      api('/api/sessions?limit=8').catch(() => null),
      // 实例快照有 15s 服务端缓存 + UIA 枚举成本，失败静默（落回通用卡）
      api('/api/channels/qq/instances').catch(() => null)
    ]);
    if (inRes) {
      dashQQInstances = Array.isArray(inRes.instances) ? inRes.instances : [];
      dashBridgedAccount = String(inRes.bridgedAccount ?? '');
    }
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
  // 通道卡点击 = 启动器：POST launch 拉起对应软件（QQ 账号卡带 hwnd → 唤起指定窗口）；
  // ⚙ 角标 = 跳管理页。事件委托绑一次，数据节点轮询替换不丢绑定。
  document.getElementById('dash-channels')?.addEventListener('click', async (e) => {
    const card = e.target.closest('.dash-card');
    if (!card) return;
    if (card.dataset.add) { openChannelConnectModal(); return; }   // [+] 接入向导
    if (e.target.closest('.dash-manage')) { switchTab(card.dataset.tabJump ?? 'channels'); return; }
    const chId = card.dataset.channelId;
    if (!chId) return;
    const hwnd = Number(card.dataset.hwnd) || 0;
    try {
      const result = await api(`/api/channels/${encodeURIComponent(chId)}/launch`, {
        method: 'POST',
        ...(hwnd ? { body: JSON.stringify({ hwnd }) } : {})
      });
      const body = card.querySelector('.dash-card-body');
      if (body && !body.dataset.launchFlash) {
        body.dataset.launchFlash = '1';
        body.dataset.old = body.textContent;
        body.textContent = result.action === 'focused'
          ? `已唤起 ✓（${result.account ?? ''}）`
          : '已启动 ✓';
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
