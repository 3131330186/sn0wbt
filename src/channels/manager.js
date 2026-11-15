// ── 通道管理器：所有通道的注册/启停/入站分发/出站路由唯一入口 ────────────
//
// 为什么不是全局单例：createApp 支持同进程重建（Electron 重启核心、测试串行
// 多轮，见 app.js 头部递归护栏注释），全局单例会让上一轮的通道泄漏进下一轮。
// manager 实例由 createApp 持有，经 app.channelManager 暴露给需要它的模块。
//
// 数据路径（v0.8）：
//   入站：通道实现 → dispatchInbound(record) → manager 打 channelId 戳 →
//         onInbound 订阅者（app.js → handleOneBotEvent，现有管道不动）
//   出站：manager.send(channelId, action, ...args) 按能力表路由并门控；
//         现阶段 sender.js 等子系统仍直持 qq 通道的底层 client（迁移分步走，
//         第二个通道落地时统一切 manager.send）
import { ChannelError, CHANNEL_ERROR_CODES, METHOD_CAPABILITY, validateChannel } from './types.js';
import { QQChannel } from './qq/index.js';
import { BrowserChannel } from './browser/index.js';
import { MailChannel } from './mail/index.js';

export class ChannelManager {
  #channels = new Map();       // id → channel
  #inboundListeners = new Set();
  #statusListeners = new Set();
  #log = null;

  constructor({ log } = {}) {
    this.#log = typeof log === 'function' ? log : (() => {});
  }

  /** 注册通道。重复 id / 结构不合法 → ChannelError（快速失败）。 */
  register(channel) {
    validateChannel(channel);
    if (this.#channels.has(channel.id)) {
      throw new ChannelError(CHANNEL_ERROR_CODES.CHANNEL_DUPLICATE, `通道 id 重复: ${channel.id}`);
    }
    this.#channels.set(channel.id, channel);
    this.#log(`[channels] 已注册通道 ${channel.id}（${channel.label}，能力: ${channel.capabilities.join(', ') || '无'}）`);
    return channel;
  }

  /** 取通道；未知 id 抛 ChannelError（结构化失败优于返回 null 静默扩散）。 */
  get(id) {
    const channel = this.#channels.get(String(id));
    if (!channel) throw new ChannelError(CHANNEL_ERROR_CODES.CHANNEL_NOT_FOUND, `未知通道: ${id}`);
    return channel;
  }

  has(id) { return this.#channels.has(String(id)); }

  /** 通道元数据快照（给控制台「通道」页 / 诊断用），不暴露内部引用。 */
  list() {
    return [...this.#channels.values()].map((channel) => ({
      id: channel.id,
      label: channel.label,
      capabilities: [...channel.capabilities],
      status: channel.status || 'stopped',
      lastStatus: channel.lastStatus ?? null
    }));
  }

  /** 入站事件订阅。cb(record, { channelId })；返回解绑函数。 */
  onInbound(cb) {
    this.#inboundListeners.add(cb);
    return () => this.#inboundListeners.delete(cb);
  }

  /** 通道状态订阅。cb({ channelId, status })；返回解绑函数。 */
  onStatus(cb) {
    this.#statusListeners.add(cb);
    return () => this.#statusListeners.delete(cb);
  }

  /** 启动全部通道。通道 start() 抛错不拖垮其他通道 —— 状态如实记 error。 */
  async startAll(ctx = {}) {
    for (const channel of this.#channels.values()) {
      await this.startChannel(channel.id, ctx);
    }
  }

  /** 启动单个通道（接入向导用：enable 后只拉起这一个，不惊动其他通道/桥接连线）。 */
  async startChannel(channelId, ctx = {}) {
    const channel = this.get(channelId);
    if (!channel) throw new ChannelError(CHANNEL_ERROR_CODES.CHANNEL_OFFLINE, `通道 ${channelId} 未注册`);
    channel.status = 'starting';
    try {
      await channel.start({
        dispatchInbound: (record) => this.#dispatch(channel.id, record),
        reportStatus: (status) => this.#report(channel.id, status),
        ...ctx
      });
      channel.status = 'started';
      this.#log(`[channels] 通道 ${channel.id} 已启动`);
    } catch (error) {
      channel.status = 'error';
      channel.lastError = String(error?.message ?? error);
      this.#log(`[channels] 通道 ${channel.id} 启动失败: ${channel.lastError}`);
    }
  }

  /** 停止全部通道。单个 stop 失败不影响其余通道收尾。 */
  async stopAll() {
    for (const channel of this.#channels.values()) {
      await this.stopChannel(channel.id);
    }
  }

  /** 停止单个通道（接入向导的"断开链接"）。未注册/已停止都是幂等目标态。 */
  async stopChannel(channelId) {
    if (!this.has(channelId)) return;      // get() 对未知 id 会抛，这里要幂等
    const channel = this.get(channelId);
    try {
      await channel.stop();
      channel.status = 'stopped';
    } catch (error) {
      channel.status = 'error';
      this.#log(`[channels] 通道 ${channel.id} 停止失败: ${String(error?.message ?? error)}`);
    }
  }

  /**
   * 出站路由：按能力表门控后转发到通道实现。
   * 目标对象优先取 channel.client（消息类通道把出站 API 放在底层客户端上），
   * 通道自身实现了同名方法则优先通道 —— 两种形态都支持。
   */
  send(channelId, action, ...args) {
    const channel = this.get(channelId);
    const needed = METHOD_CAPABILITY[action];
    if (needed && !channel.capabilities.includes(needed)) {
      throw new ChannelError(
        CHANNEL_ERROR_CODES.CAPABILITY_MISSING,
        `通道 ${channelId} 未声明能力 ${needed}，拒绝执行 ${action}`
      );
    }
    const target = (typeof channel[action] === 'function') ? channel : channel.client;
    if (!target || typeof target[action] !== 'function') {
      throw new ChannelError(
        CHANNEL_ERROR_CODES.CAPABILITY_MISSING,
        `通道 ${channelId} 未实现 ${action}`
      );
    }
    return target[action](...args);
  }

  #dispatch(channelId, record) {
    // record 必须是对象；基本类型直接丢弃（事件结构损坏不该污染下游）。
    if (!record || typeof record !== 'object') {
      this.#log(`[channels] 通道 ${channelId} 上报了非对象事件，已丢弃`);
      return;
    }
    if (!record.channelId) record.channelId = channelId;   // 打通道来源戳
    for (const cb of this.#inboundListeners) {
      try { cb(record, { channelId }); } catch (error) {
        // 单个订阅者失败不阻断其他订阅者（现状：app.js 的 ingest 自己兜错）
        this.#log(`[channels] 入站订阅者处理出错: ${String(error?.message ?? error)}`);
      }
    }
  }

  #report(channelId, status) {
    const normalized = (status && typeof status === 'object')
      ? status
      : { connected: Boolean(status) };
    const channel = this.#channels.get(channelId);
    if (channel) channel.lastStatus = normalized;
    for (const cb of this.#statusListeners) {
      try { cb({ channelId, status: normalized }); } catch { /* ignore */ }
    }
  }
}

/** 内置通道注册表：新通道在此追加一行（配置切片自 config.channels.<id> 取）。 */
export function registerBuiltinChannels(manager, { config } = {}) {
  // QQ 通道配置 = 自身切片（backend/uiaWsPort/selfId）+ 旧 SnowLuma 连接参数（napcat 后端用）
  manager.register(new QQChannel({ config: { ...(config?.snowluma ?? {}), ...(config?.channels?.qq ?? {}) } }));
  manager.register(new BrowserChannel({ config: config?.channels?.browser }));
  manager.register(new MailChannel({ config: config?.channels?.mail }));
  return manager;
}
