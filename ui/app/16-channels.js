// 〔通道页签〕—— sn0wbot 通道框架状态总览（v0.8）
// 后端：GET /api/channels（channelManager.list() 元数据快照，只读）。
// 纪律：骨架只建一次；轮询/刷新只替换状态卡节点（renderChannelsCard），
// 绝不整页 innerHTML 重建（AGENTS.md 防事故条款）。
'use strict';

let channelsSkeletonBuilt = false;
let channelsTimer = null;      // 本页停留时的轮询（离开即停）

function channelsStatusMeta(ch) {
  const status = String(ch.status ?? 'stopped');
  const map = {
    started: ['运行中', 'ok'],
    starting: ['启动中', 'warn'],
    stopped: ['已停止', 'muted'],
    error: ['异常', 'bad']
  };
  const meta = map[status] ?? [status, 'muted'];
  let detail = '';
  const last = ch.lastStatus ?? {};
  if (last.error) detail = String(last.error).slice(0, 160);
  else if (last.reason) detail = String(last.reason).slice(0, 160);
  else if (last.detail) detail = String(last.detail).slice(0, 160);
  return { label: meta[0], cls: meta[1], detail };
}

/** 能力徽标行（中文展示名）。 */
function channelsCapabilityBadges(ch) {
  const names = {
    message: '消息', media: '媒体', sticker: '表情', voice: '语音',
    poke: '互动', history: '历史', control: '操控', verifiedSender: '可信身份'
  };
  return (ch.capabilities ?? [])
    .map((cap) => `<span class="tag">${esc(names[cap] ?? cap)}</span>`)
    .join(' ') || '<span class="tag muted">无</span>';
}

/** 状态卡渲染：只更新这一块节点，页签骨架与页头不动。 */
function renderChannelsCard(channels) {
  const card = document.getElementById('channels-card');
  if (!card) return;
  if (!Array.isArray(channels) || !channels.length) {
    card.innerHTML = '<div class="muted">通道管理器还没有注册任何通道。</div>';
    return;
  }
  const rows = channels.map((ch) => {
    const meta = channelsStatusMeta(ch);
    return `
      <div class="channel-row" data-channel="${esc(ch.id)}">
        <div class="channel-head">
          <b>${esc(ch.label)}</b>
          <span class="muted">(${esc(ch.id)})</span>
          <span class="tag ${meta.cls}">${esc(meta.label)}</span>
        </div>
        <div class="channel-caps">${channelsCapabilityBadges(ch)}</div>
        ${meta.detail ? `<div class="muted channel-detail">${esc(meta.detail)}</div>` : ''}
      </div>`;
  }).join('');
  card.innerHTML = rows;
}

async function refreshChannels({ quiet = false } = {}) {
  try {
    const data = await api('/api/channels');
    renderChannelsCard(data.channels ?? []);
  } catch (error) {
    if (!quiet) showAppAlert(`读取通道状态失败：${error?.message ?? error}`);
  }
}

function buildChannelsSkeleton() {
  if (channelsSkeletonBuilt) return;
  channelsSkeletonBuilt = true;
  const page = document.getElementById('channels-page');
  if (!page) return;
  page.innerHTML = `
    <div class="usage-pane-inner">
      <h2>通道</h2>
      <p class="muted">sn0wbot 用统一的通道框架连接各个软件：每个通道声明自己的能力，核心引擎不感知通道细节。
      大纲见仓库 <b>doc/ARCHITECTURE.md</b>。</p>
      <div class="card">
        <div class="card-head">
          <b>已注册通道</b>
          <button class="btn" id="channels-refresh" type="button">刷新</button>
        </div>
        <div id="channels-card" class="card-body"><div class="muted">加载中…</div></div>
      </div>
    </div>`;
  document.getElementById('channels-refresh')?.addEventListener('click', () => refreshChannels());
}

function loadChannelsPage() {
  buildChannelsSkeleton();
  refreshChannels({ quiet: true });
  // 本页停留时轻轮询（与外联页同款：离开即停）
  if (channelsTimer) clearInterval(channelsTimer);
  channelsTimer = setInterval(() => refreshChannels({ quiet: true }), 8000);
  channelsTimer.unref?.?.();
}
