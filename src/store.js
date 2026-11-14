// 每个会话（group:xxx / private:xxx）一个不断增长的 JSON 消息存储。
// 这是新架构的核心数据结构：模型不携带对话历史，每次运行都从这里拼接"已读信息"。
//
// 条目格式：
// {
//   id:        本地递增序号（自 1 起，同群唯一，用于 UI 定位）
//   mid:       QQ 消息 id（可为负数；自己主动发送的本地记录可能没有）
//   ts:        时间戳毫秒
//   senderId:  QQ 号（自己发送的为 selfId）
//   senderName:群名片/昵称（自己发送的为 botName）
//   text:      解析后的纯文本（[图片] 等占位符已内联）
//   self:      是否是机器人自己发的
//   read:      已读状态（运行开始时批量置 true）
//   reply:     可选 { sender, text }：该消息引用/回复的对象摘要
//   media:     可选 [{ kind, url, file, faceId, summary }] 原始媒体定位信息
// }
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const MESSAGES_DIR = path.join(DATA_DIR, 'messages');

// ── 落盘策略（性能改造）──────────────────────────────────────────────
// 旧版：每条消息 append/mark 都全量 JSON.stringify + writeFileSync —— 群一活跃，
//       每条消息 1~2 次全文件写；存档不限条数后单群文件越滚越大，同步写还阻塞
//       事件循环（WS 收消息 / SSE 推送 / LLM 流全排在它后面）。
// 新版：内存即时更新（模型与 UI 读的都是内存，内容零变化），写盘走脏标记 +
//       500ms 防抖合并；app.stop() / 进程退出前 flushAll() 兜底，正常运行一条不丢。
//       代价：断电/强杀进程最多丢最后 500ms 的消息 —— sessions.js 的
//       #persistThrottled 用的是同款思路（作者注释原话："同步写盘阻塞 event loop"）。
const FLUSH_DEBOUNCE_MS = 500;
// 常驻内存的会话数上限（LRU）。冷会话踢出内存（脏数据先落盘），下次访问按需重读，
// 对模型 / UI 完全透明 —— 群再多内存也封顶，不再"磁盘上有多少群就常驻多少存档"。
const MAX_LOADED_CHATS = 20;

// 进程级兜底：无论从哪条路径退出（含 uncaughtException exit(1)），都把脏数据冲一次盘。
// 模块只加载一次 → 只注册一个监听器；多个实例时 flush 最后创建的那个（测试场景足够）。
let activeStore = null;
process.on('exit', () => { try { activeStore?.flushAll(); } catch { /* 退出期尽力而为 */ } });

function chatFile(chatKey) {
  // chatKey 形如 group:123 / private:456
  const safe = String(chatKey).replace(/[^a-z0-9_]/gi, '_');
  return path.join(MESSAGES_DIR, `${safe}.json`);
}

function loadChat(chatKey) {
  const file = chatFile(chatKey);
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const parsed = JSON.parse(text);
    if (parsed && Array.isArray(parsed.messages)) return parsed;
    throw new Error('存档结构不对（缺 messages 数组）');
  } catch (e) {
    // 损坏/读不出的旧存档**不能静默当新会话** —— 那样下一次保存就会用空历史
    // 覆盖整个文件，几个月的消息永久丢失。先改名备份（数据可手工抢救），
    // 再从空会话开始（与 config.js loadConfig 的坏文件处理同款套路）。
    // ENOENT = 真新会话，不是损坏，无需备份。
    try {
      if (fs.existsSync(file)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        fs.renameSync(file, `${file}.corrupt-${stamp}`);
        console.error(`[store] 存档解析失败（${e?.message ?? e}），已备份为 ${path.basename(file)}.corrupt-${stamp}，该会话从空开始。`);
      }
    } catch { /* 备份失败也不阻断消息入库 */ }
    return { chatKey, nextLocalId: 1, messages: [] };
  }
}

function saveChat(state) {
  fs.mkdirSync(MESSAGES_DIR, { recursive: true });
  const tmp = `${chatFile(state.chatKey)}.${process.pid}.tmp`;
  // 紧凑序列化（不带缩进）：同样内容文件小 ~30%，stringify 也更快。
  // 旧版的 `null, 1` 缩进纯粹是给人肉翻文件用的，读取端 JSON.parse 两种都认。
  fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
  fs.renameSync(tmp, chatFile(state.chatKey));
}

export class ChatStore {
  constructor(maxPerChat = 0, maxLoadedChats = MAX_LOADED_CHATS) {
    this.maxPerChat = Math.max(0, Number(maxPerChat) || 0);
    this.maxLoaded = Math.max(2, Number(maxLoadedChats) || MAX_LOADED_CHATS);
    this.chats = new Map();       // chatKey -> state（LRU：访问即置新，超上限踢最旧）
    this.dirty = new Set();       // 待落盘的 chatKey（防抖合并写）
    this.flushTimer = null;
    activeStore = this;
  }

  setMaxPerChat(cap) {
    this.maxPerChat = Math.max(0, Number(cap) || 0);
  }

  #state(chatKey) {
    if (this.chats.has(chatKey)) {
      // LRU touch：Map 按插入序，删了重插 = 置为最新访问
      const st = this.chats.get(chatKey);
      this.chats.delete(chatKey);
      this.chats.set(chatKey, st);
      return st;
    }
    const st = loadChat(chatKey);
    this.chats.set(chatKey, st);
    this.#evictIfNeeded();
    return st;
  }

  /** 内存里驻留的会话数超过上限时，踢掉最旧的（脏的先落盘，一条不丢）。 */
  #evictIfNeeded() {
    while (this.chats.size > this.maxLoaded) {
      const oldestKey = this.chats.keys().next().value;
      if (this.dirty.has(oldestKey)) this.flush(oldestKey);
      this.chats.delete(oldestKey);
    }
  }

  // ── 落盘调度 ─────────────────────────────────────────────────────────
  /** 标记脏 + 防抖合并落盘。内存态已是最新的，磁盘只延迟 ≤FLUSH_DEBOUNCE_MS。 */
  #scheduleFlush(chatKey) {
    this.dirty.add(chatKey);
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flushAll(); }, FLUSH_DEBOUNCE_MS);
      this.flushTimer.unref?.();   // 不让防抖定时器吊住进程退出
    }
  }

  /** 立即落盘一个会话（脏才写）。返回是否真的写了。
   *  ⚠️ 脏标记只在写盘**成功后**清除 —— 写盘失败（磁盘满/杀软锁文件）时保留，
   *  下一条消息或下次 flushAll 会重试这批数据（review 修复：先删后写会让
   *  失败批次静默丢持久化）。 */
  flush(chatKey) {
    if (!this.dirty.has(chatKey)) return false;
    const st = this.chats.get(chatKey);
    if (!st) { this.dirty.delete(chatKey); return false; }
    try {
      saveChat(st);
    } catch (e) {
      this.dirty.add(chatKey);   // 数据还在内存里，必须保住重试机会
      throw e;
    }
    this.dirty.delete(chatKey);
    return true;
  }

  /** 全部落盘（app.stop() / 进程退出兜底）。返回写掉的会话数。
   *  单个会话失败不阻断其他会话（失败者保留脏标记，内存数据不丢）。 */
  flushAll() {
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    let n = 0;
    for (const key of [...this.dirty]) {
      try { if (this.flush(key)) n++; }
      catch (e) {
        console.error(`[store] 落盘失败（${key}）—— 数据保留在内存，稍后重试：`, e?.message ?? e);
      }
    }
    return n;
  }

  /** 测试 / 监控用：当前内存里驻留的会话数。 */
  loadedCount() { return this.chats.size; }

  listChats() {
    // 只列 key，不强制加载全量存档 —— 旧版会把磁盘上每个群的存档都读进内存
    //（群一多内存跟着涨）；现在按需 #state() 加载，LRU 自动淘汰冷会话。
    const keys = new Set(this.chats.keys());
    try {
      for (const f of fs.readdirSync(MESSAGES_DIR)) {
        // web = 网页对话（private:web，虚拟会话，QQ 号都是纯数字不会撞名）
        const m = /^(group|private)_(\d+|web)\.json$/.exec(f);
        if (m) keys.add(`${m[1]}:${m[2]}`);
      }
    } catch { /* 目录不存在 */ }
    return [...keys];
  }

  getChatMeta(chatKey) {
    const st = this.#state(chatKey);
    // 未读只计他人消息（与 unreadCount / peekUnread 口径一致）——
    // 曾经用 !m.read 把 self 也算进去，机器人自己的发言会把角标顶大。
    const unread = st.messages.filter((m) => !m.read && !m.self).length;
    const last = st.messages[st.messages.length - 1] || null;
    return { chatKey, total: st.messages.length, unread, lastTs: last?.ts ?? 0, lastText: last?.text ?? '' };
  }

  /** 追加一条收到的消息（未读）。返回写入的条目。 */
  appendIncoming(chatKey, { mid, ts, senderId, senderName, text, reply = null, media = [], isPoke = false, atMe = null, atNames = [] }) {
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: String(senderId ?? ''),
      senderName: String(senderName ?? ''),
      text: String(text ?? ''),
      self: false,
      read: false,
      reply: reply || null,
      media: Array.isArray(media) ? media : [],
      // 拍一拍事件：可作触发批（resolveContextTier 按 1 档响应），但不进【已读信息】
      isPoke: Boolean(isPoke),
      // @ 判定标记（2026-09-26）：atMe 以 @ 段的 QQ 号为准 —— 文本包含匹配
      // 分不清"同名不同人"（群友 @ 的人与机器人重名时被误判为 @机器人）。
      // null = 老存档未标，判定层回落文本匹配。
      atMe: atMe === null || atMe === undefined ? null : Boolean(atMe),
      // 渲染进 text 的 @片段原文（含 @ 前缀）：关键词判定据此剔除，
      // 防"@ 别人的名字里带关键词"误触发。空数组 = 该消息没有 @ 段。
      atNames: (Array.isArray(atNames) ? atNames : []).map((n) => String(n ?? '')).filter(Boolean).slice(0, 20)
    };
    st.messages.push(entry);
    this.#trim(st);
    this.#scheduleFlush(chatKey);
    return entry;
  }

  /** 记录机器人自己发出的消息（已读）。 */
  appendSelf(chatKey, { text, ts, mid = null }) {
    const st = this.#state(chatKey);
    const entry = {
      id: st.nextLocalId++,
      mid: mid ?? null,
      ts: ts || Date.now(),
      senderId: 'self',
      senderName: '我',
      text: String(text ?? ''),
      self: true,
      read: true,
      reply: null,
      media: []
    };
    st.messages.push(entry);
    this.#trim(st);
    this.#scheduleFlush(chatKey);
    return entry;
  }

  /** 快照当前未读并全部置为已读（运行开始时调用）。 */
  drainUnread(chatKey) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read && !m.self);
    for (const m of st.messages) m.read = true;
    this.#scheduleFlush(chatKey);
    return unread;
  }

  /**
   * 只 drain「从某条消息起**之后**」的未读：取走触发批，之前的旧积压单独标已读。
   *
   * 为什么需要它（2026-09-25 触发链路重做的补丁）：磁盘上可能遗留旧进程/
   * 暂停期间攒下的积压未读。它们从未经过 onIncoming 的逐条判定，如果一次
   * 触发的 drain 把它们全部吃进触发批，模型会看到一大坨"未读信息"——用户
   * 看到的就是"积压消息被整批塞进唤醒"。正确语义：
   *   · 触发消息 X 之后的未读 = 本批的聚批对象（X 也在内）；
   *   · X 之前的旧未读 = 触发前就该已读的历史 → 标已读沉入【已读信息】。
   *
   * @param {string} chatKey
   * @param {number} fromTs 批的起点（触发消息的 ts，含）；早于它的未读标已读
   * @returns {{ batch: object[], archived: number }} batch = 触发批，archived = 被归档的旧未读条数
   */
  drainUnreadFrom(chatKey, fromTs) {
    const st = this.#state(chatKey);
    const unread = st.messages.filter((m) => !m.read && !m.self);
    const batch = [];
    let archived = 0;
    for (const m of unread) {
      if (m.ts >= fromTs) batch.push(m);
      else { m.read = true; archived++; }   // 触发点之前的旧积压：沉入历史
    }
    for (const m of st.messages) m.read = true;   // batch 里的也置已读（作为触发批取走）
    this.#scheduleFlush(chatKey);
    return { batch, archived };
  }

  /**
   * 把当前所有未读标记为已读，**但不取走它们**。
   *
   * 这是"档位控制是否响应"的关键：机器人判断"这次不回应"时调用它，
   * 消息就沉入历史（已读），不会产生会话、不消耗 token；
   * 但内容仍留在存档里，日后被艾特时还能作为"已读上下文"带进提示词。
   * 与 drainUnread 的区别：drainUnread 取走并作为触发批，这个只标记。
   *
   * @returns {number} 被标记为已读的条数
   */
  markAllRead(chatKey) {
    const st = this.#state(chatKey);
    let n = 0;
    for (const m of st.messages) {
      if (!m.read && !m.self) { m.read = true; n++; }
    }
    if (n) this.#scheduleFlush(chatKey);
    return n;
  }

  /**
   * 把**单条**消息标记为已读（不取走）。
   *
   * 逐条触发判定（onIncoming）用：该条不触发会话时当场标已读、沉入历史，
   * 不动其它未读 —— 那些是"倒计时窗口内追加的"或"上一批遗留的"，
   * 各有自己的归宿（前者等 drain，后者等兜底或下一次触发）。
   *
   * @param {string} chatKey
   * @param {number} id 消息条目的本地 id（appendIncoming 返回的 entry.id）
   * @returns {boolean} 是否真的标记了（false = 没找到/本来就是已读）
   */
  markEntryRead(chatKey, id) {
    const st = this.#state(chatKey);
    const m = st.messages.find((x) => x.id === id);
    if (!m || m.read || m.self) return false;
    m.read = true;
    this.#scheduleFlush(chatKey);
    return true;
  }

  /**
   * 把时间窗内的**已读**消息重新标记为未读（手动重试失败会话用）。
   *
   * 触发批当初被 drainUnread 置了已读；重试时按会话起止时间把它们翻回未读，
   * 唤醒流程就能重新取走它们。窗口向前放宽 5 分钟（容纳防抖聚批期），
   * 向后到会话结束 —— 窗口外的不动，避免误翻后来真正已读的历史。
   * @returns {number} 恢复为未读的条数
   */
  markUnreadInWindow(chatKey, startedAt, endedAt) {
    const st = this.#state(chatKey);
    const winStart = Number(startedAt) - 5 * 60 * 1000;
    const winEnd = Number(endedAt || startedAt) + 1000;
    let n = 0;
    for (const m of st.messages) {
      if (m.self) continue;
      if (m.read && m.ts >= winStart && m.ts <= winEnd) { m.read = false; n++; }
    }
    if (n) this.#scheduleFlush(chatKey);
    return n;
  }

  unreadCount(chatKey) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).length;
  }

  /** 查看当前未读消息（不置已读），用于“等待中”会话的触发摘要。 */
  peekUnread(chatKey, limit = 3) {
    const st = this.#state(chatKey);
    return st.messages.filter((m) => !m.read && !m.self).slice(0, Math.max(1, Number(limit) || 3));
  }

  recent(chatKey, { limit = 80, offset = 0, includeSelf = true } = {}) {
    const st = this.#state(chatKey);
    const all = includeSelf ? st.messages : st.messages.filter((m) => !m.self);
    // offset = 跳过最近 N 条（用于工具翻页）。只读，绝不能修改 st.messages！
    const start = Math.max(0, all.length - Math.max(0, Number(offset) || 0));
    return all.slice(0, start).slice(-Math.max(1, Number(limit) || 1));
  }

  findByMid(chatKey, mid) {
    const st = this.#state(chatKey);
    const target = String(mid);
    return st.messages.find((m) => String(m.mid) === target) || null;
  }

  /**
   * 标记一条消息已被用户撤回（按 QQ 消息 id）。
   * 撤回的消息后续不再发给大模型（buildPastState 会过滤 recalled）。
   * @returns {boolean} 是否找到并标记了
   */
  markRecalled(chatKey, mid) {
    const st = this.#state(chatKey);
    const target = String(mid);
    const m = st.messages.find((x) => String(x.mid) === target);
    if (!m) return false;
    m.recalled = true;
    m.read = true;   // 撤回的消息也算"已读"，不再触发回复
    this.#scheduleFlush(chatKey);
    return true;
  }

  /**
   * 按 QQ 消息 id 更新一条已存档消息（文本/补媒体），并落盘。
   * 用途：read_forward 工具把"合并转发占位符"永久升级成展开后的文本
   * —— 一次展开，以后谁（模型/存档页/金句）都直接读到内容。
   */
  updateByMid(chatKey, mid, { text, appendMedia = [] } = {}) {
    const st = this.#state(chatKey);
    const target = String(mid);
    const m = st.messages.find((x) => String(x.mid) === target);
    if (!m) return false;
    if (text != null) m.text = String(text);
    if (appendMedia.length) {
      m.media = Array.isArray(m.media) ? m.media : [];
      const seen = new Set(m.media.map((x) => x && x.url));
      for (const x of appendMedia) {
        if (x && x.url && !seen.has(x.url)) { m.media.push(x); seen.add(x.url); }
      }
    }
    this.#scheduleFlush(chatKey);
    return true;
  }

  findByLocalId(chatKey, localId) {
    const st = this.#state(chatKey);
    return st.messages.find((m) => m.id === Number(localId)) || null;
  }

  /**
   * 删除指定本地 id 的消息（部分清除）。返回删掉的条数。
   * @param {string} chatKey
   * @param {number[]} localIds 本地递增 id 数组
   */
  removeByLocalIds(chatKey, localIds = []) {
    const st = this.#state(chatKey);
    const ids = new Set((Array.isArray(localIds) ? localIds : [localIds]).map(Number));
    if (!ids.size) return 0;
    const before = st.messages.length;
    st.messages = st.messages.filter((m) => !ids.has(m.id));
    const removed = before - st.messages.length;
    if (removed) { this.#scheduleFlush(chatKey); this.flush(chatKey); }   // 删除类操作立即落盘
    return removed;
  }

  /**
   * 清空某会话的全部消息（整体清除）。返回删掉的条数。
   * 会话文件保留（空 messages），下次来消息继续往里写。
   */
  clearChat(chatKey) {
    const st = this.#state(chatKey);
    const removed = st.messages.length;
    if (removed) {
      st.messages = [];
      this.#scheduleFlush(chatKey);
      this.flush(chatKey);   // 清空类操作立即落盘
    }
    return removed;
  }

  /**
   * 仅屏蔽（不删除）：把某会话的全部未读标记为已读。
   * 与 markAllRead 相同语义，这里显式命名供"仅屏蔽、不再发送"场景调用。
   * 返回标记的条数。
   */
  muteUnread(chatKey) {
    return this.markAllRead(chatKey);
  }

  /** 最近 senderId 出现过的活跃成员（带最后发言时间）。 */
  activeMembers(chatKey, limit = 10) {
    const st = this.#state(chatKey);
    const map = new Map();
    for (const m of st.messages) {
      if (m.self) continue;
      const prev = map.get(m.senderId);
      if (!prev || prev.lastTs < m.ts) {
        map.set(m.senderId, { userId: m.senderId, name: m.senderName, lastTs: m.ts, count: (prev?.count || 0) + 1 });
      } else {
        prev.count += 1;
      }
    }
    return [...map.values()].sort((a, b) => b.lastTs - a.lastTs).slice(0, Math.max(1, limit));
  }

  #trim(st) {
    if (this.maxPerChat > 0 && st.messages.length > this.maxPerChat) {
      st.messages.splice(0, st.messages.length - this.maxPerChat);
    }
  }
}
