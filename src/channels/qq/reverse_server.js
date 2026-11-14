// ── OneBot v11 反向 WebSocket 服务端（QQ 通道 · UIA 桥接后端）─────────────
//
// 背景（2026-11-15 风控事件）：小号经 NapCat 协议端登录触发腾讯风控，协议端
// 路线对用户关闭。切换到低风控暴露的 UIA 桥接：桥接驱动**正常登录的官方 QQ
// 客户端**（像人一样读写界面，不注入不 Hook），以 OneBot v11 反向 WebSocket
// **客户端**身份连入本服务端（bridge: seasonQAQ111/qq-onebotv11-uia-bridge）。
//
// 协议（桥接实测行为）：
//   · 桥接连入 ws://127.0.0.1:<port>/ws 后推 lifecycle/heartbeat/消息事件
//   · 核心下发 {action, params, echo} → 桥接回 {status, retcode, data, echo}
//   · echo 关联请求与响应（本文件的核心职责）
//
// 公开面与 OneBotClient 对齐（sendSegments/sendText/.../call/selfId/onStatus），
// app.js 的 `onebot` 引用与全部子系统零改动即可切换后端。
// 取舍（UIA 通道固有，见 DESIGN.md）：无原始消息 ID 保证、发送者身份常不可
// 验证、仅白名单会话、窗口最小化/遮挡时有巡检延迟 —— 事件 record 的
// confidence 由上层按此口径标记。
import { WebSocketServer } from 'ws';
import { escapeCqText } from '../../util.js';

const CALL_TIMEOUT_MS = 15000;
const SEND_TIMEOUT_MS = 90000;   // 发送类：桥接要驱动真实界面（切换会话/粘贴/校验），远慢于协议端
const SLOW_ACTION = /^(send_(group|private)|upload_|_send)/i;

function replyAtSegments({ replyToMessageId = null, atUserId = null } = {}) {
  const segments = [];
  if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
    const rid = String(replyToMessageId).trim();
    if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
    segments.push({ type: 'reply', data: { id: rid } });
  }
  if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
    const at = String(atUserId).trim();
    if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
    segments.push({ type: 'at', data: { qq: at } });
  }
  return segments;
}

export class OneBotReverseServer {
  accessToken = '';          // 与 OneBotClient 字段面兼容（app.js 令牌同步代码会写）
  httpToken = '';
  tokenCandidates = [];
  selfInfo = null;
  connected = false;
  everConnected = false;
  lastConnectError = '';
  status = 'stopped';

  #wss = null;
  #bridge = null;            // 当前桥接 socket（只认最新一个）
  #pending = new Map();      // echo → { resolve, reject, timer }
  #echoSeq = 0;
  #onEventFn = null;
  #statusListeners = new Set();
  #log = null;
  #host = '127.0.0.1';
  #port = 11229;
  #selfIdHint = '';

  /**
   * @param {object} opts
   * @param {number} [opts.port]       反向 WS 监听端口（默认 11229，对齐桥接示例配置）
   * @param {string} [opts.host]
   * @param {string} [opts.selfIdHint] 桥接配置里的小号 QQ 号（get_login_info 兜底用）
   * @param {Function} [opts.onEvent]  桥接事件出口（start 时也可经 dispatchInbound 注入）
   * @param {Function} [opts.log]
   */
  constructor({ port, host, selfIdHint, onEvent, log } = {}) {
    this.#port = Number(port) || 11229;
    this.#host = String(host || '127.0.0.1');
    this.#selfIdHint = String(selfIdHint || '');
    this.#onEventFn = onEvent ?? null;
    this.#log = typeof log === 'function' ? log : (() => {});
  }

  onStatus(fn) {
    this.#statusListeners.add(fn);
    return () => this.#statusListeners.delete(fn);
  }

  #setStatus(connected) {
    this.connected = connected;
    if (connected) this.everConnected = true;
    for (const fn of this.#statusListeners) {
      try { fn({ connected, everConnected: this.everConnected, error: this.lastConnectError }); } catch { /* ignore */ }
    }
  }

  /** 与 OneBotClient.connect 语义对齐：启动监听并保持常驻。 */
  async connect() {
    if (this.#wss) return undefined;   // 幂等：已在监听
    this.lastConnectError = '';
    await new Promise((resolve, reject) => {
      this.#wss = new WebSocketServer({ host: this.#host, port: this.#port }, resolve);
      this.#wss.on('error', reject);
    });
    this.#wss.on('error', (error) => { this.#log(`[uia] WS 服务端错误: ${error?.message ?? error}`); });
    this.#wss.on('connection', (socket, req) => this.#acceptBridge(socket, req));
    this.status = 'started';
    this.#log(`[uia] 反向 WS 服务端已监听 ws://${this.#host}:${this.#port}（等待桥接连入）`);
    // 桥接未连入不报错：它是独立进程，随时可启；状态如实保持"监听中"
    return undefined;
  }

  async close() {
    try { this.#bridge?.close(); } catch { /* ignore */ }
    this.#bridge = null;
    for (const p of this.#pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error('通道已关闭'));
    }
    this.#pending.clear();
    try { await new Promise((r) => this.#wss?.close(r)); } catch { /* ignore */ }
    this.#wss = null;
    this.connected = false;
    this.status = 'stopped';
    this.#setStatus(false);
  }

  /** 服务端常驻，"重连"= 确保监听（桥接侧自带 5 秒重连循环）。 */
  async reconnect() { return this.connect(); }

  #acceptBridge(socket, req) {
    // 只认最新连入的桥接：旧连接直接让位（桥接重启会重连，新连接取代旧连接）
    if (this.#bridge) { try { this.#bridge.close(); } catch { /* ignore */ } }
    this.#bridge = socket;
    const peer = req?.socket?.remoteAddress ?? '?';
    this.#log(`[uia] 桥接已连入（${peer}）`);
    this.lastConnectError = '';
    this.#setStatus(true);

    socket.on('message', (data) => {
      if (this.#bridge !== socket) return;
      let obj = null;
      try { obj = JSON.parse(String(data)); } catch { return; }
      if (!obj || typeof obj !== 'object') return;
      // ① action 响应（带 echo）→ 关联请求
      this.#log(`[uia][recv] echo=${obj.echo ?? '-'} status=${obj.status ?? '-'} post=${obj.post_type ?? '-'}`);
      if (obj.echo != null && this.#pending.has(obj.echo)) {
        const p = this.#pending.get(obj.echo);
        this.#pending.delete(obj.echo);
        clearTimeout(p.timer);
        if (obj.status === 'ok' || obj.retcode === 0) p.resolve(obj.data ?? {});
        else p.reject(new Error(`UIA ${p.action ?? '调用'} 失败: retcode=${obj.retcode ?? obj.status} ${obj.wording ?? ''}`));
        return;
      }
      // ② 事件（post_type）→ 与 OneBotClient.onEvent 同一出口
      if (obj.post_type) {
        try { this.#onEventFn?.(obj); } catch (error) { console.error('[uia] 事件处理出错:', error); }
      }
    });
    socket.on('close', () => {
      if (this.#bridge !== socket) return;
      this.#bridge = null;
      this.#setStatus(false);
      this.#log('[uia] 桥接断开（桥接侧每 5 秒自动重连）');
    });
    socket.on('error', () => { /* close 事件会跟上 */ });

    // 桥接连入即补账号信息。⚠️ 延迟 250ms：桥接客户端 open 后才挂消息监听器，
    // 立即下发 get_login_info 会掉进空窗丢失（实测），丢失则 selfInfo 拿不到昵称。
    setTimeout(() => {
    this.call('get_login_info').then((info) => {
      if (info && (info.user_id != null || info.nickname)) {
        this.selfInfo = { user_id: info.user_id ?? this.#selfIdHint, nickname: info.nickname ?? '' };
        this.#setStatus(true);
        this.#log(`[uia] 账号信息：${this.selfInfo.nickname}（${this.selfInfo.user_id}）`);
      } else if (this.#selfIdHint) {
        this.selfInfo = { user_id: this.#selfIdHint, nickname: '' };
      }
    }).catch(() => { /* 桥接未就绪就等下一轮重连 */ });
    }, 250);
  }

  /** OneBot action（经 WS 下发给桥接，echo 关联响应）。 */
  async call(action, params = {}, timeoutMs = null) {
    if (!this.#bridge) {
      throw new Error(`UIA ${action} 失败：桥接未连入（请确认 QQ 已正常登录、桥接进程已启动）`);
    }
    const limit = timeoutMs ?? (SLOW_ACTION.test(action) ? SEND_TIMEOUT_MS : CALL_TIMEOUT_MS);
    const echo = `sn0wbot-${Date.now()}-${++this.#echoSeq}`;
    const result = await new Promise((resolve, reject) => {
      this.#pending.set(echo, { resolve, reject, action, timer: setTimeout(() => {
        this.#pending.delete(echo);
        reject(new Error(`UIA ${action} 超时（${Math.round(limit / 1000)} 秒未完成）——桥接可能在驱动真实界面，稍后重试或检查 QQ 窗口状态`));
      }, limit) });
      this.#log(`[uia][send] ${action} echo=${echo}`);
      this.#bridge.send(JSON.stringify({ action, params, echo }));
    });
    return result;
  }

  get selfId() {
    return this.selfInfo?.user_id != null ? String(this.selfInfo.user_id) : String(this.#selfIdHint || '');
  }

  get selfNickname() {
    return this.selfInfo?.nickname ? String(this.selfInfo.nickname) : '';
  }

  /** 发送消息段。返回 OneBot 响应 data（桥接尽力回填 message_id，UIA 下可能为占位）。 */
  async sendSegments(kind, id, segments) {
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private'
      ? { user_id: Number(id), message: segments }
      : { group_id: Number(id), message: segments };
    return this.call(action, params);
  }

  async sendText(kind, id, text, { replyToMessageId = null, atUserId = null } = {}) {
    const segments = replyAtSegments({ replyToMessageId, atUserId });
    segments.push({ type: 'text', data: { text: escapeCqText(String(text ?? '')) } });
    return this.sendSegments(kind, id, segments);
  }

  async sendSticker(kind, id, imageUrl, { replyToMessageId = null, atUserId = null } = {}) {
    const segments = replyAtSegments({ replyToMessageId, atUserId });
    segments.push({ type: 'image', data: { file: String(imageUrl) } });
    return this.sendSegments(kind, id, segments);
  }

  async sendImage(kind, id, fileRef, { replyToMessageId = null, atUserId = null } = {}) {
    const ref = String(fileRef ?? '').trim();
    if (!ref) throw new Error('图片内容为空');
    const segments = replyAtSegments({ replyToMessageId, atUserId });
    segments.push({ type: 'image', data: { file: ref } });
    return this.sendSegments(kind, id, segments);
  }

  async sendPoke(kind, id, targetUserId) {
    if (kind === 'private') {
      return this.call('friend_poke', { user_id: Number(id) }).catch(() =>
        this.call('send_poke', { user_id: Number(id) }));
    }
    return this.call('group_poke', { group_id: Number(id), user_id: Number(targetUserId || id) }).catch(() =>
      this.call('send_poke', { group_id: Number(id), user_id: Number(targetUserId || id) }));
  }

  async getMsg(messageId) {
    return this.call('get_msg', { message_id: Number(messageId) });
  }

  async getGroupInfo(groupId) {
    return this.call('get_group_info', { group_id: Number(groupId) });
  }

  async getGroupMemberInfo(groupId, userId) {
    return this.call('get_group_member_info', { group_id: Number(groupId), user_id: Number(userId) });
  }
}
