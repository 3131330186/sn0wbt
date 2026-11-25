// ── QQ 通道：sn0wbot 的第一个通道，包装移植自 qq-agent 的 OneBotClient ────
//
// 职责边界：
//   · 本文件只做"通道化包装"——连接参数取自配置、入站事件交给 manager 分发、
//     状态上报给 manager；所有协议细节仍在 ../onebot.js（含 40+ 套既有测试
//     的行为锚点），**不要在这里复制协议逻辑**。
//   · 出站面（sendText/sendImage/sendSticker/sendSegments/sendPoke/call/…）
//     全部经 this.client 原样暴露 —— sender.js 等子系统现阶段直接持有
//     client 引用（app.js 的 `onebot` 变量即本通道的 client），迁移到
//     manager.send() 是第二步。
//   · 后端现状：SnowLuma（协议端 hook）。NapCat 说同一门 OneBot v11，
//     换后端 = 换 wsUrl/httpUrl/token —— 本通道与 onebot.js 不感知差异，
//     具体差异核对见 DESIGN.md P1。
import { OneBotClient } from '../../onebot.js';
import { OneBotReverseServer } from './reverse_server.js';
import { CAPABILITIES } from '../types.js';
import { getConfig } from '../../config.js';

export const QQ_CHANNEL_ID = 'qq';

export class QQChannel {
  id = QQ_CHANNEL_ID;
  label = 'QQ';
  // OneBot v11 提供真实消息 ID 与发送者 QQ 号 → 可验证发送者。
  // ⚠️ UIA 后端下发送者身份与消息 ID 由桥接尽力而为，confidence 口径收紧。
  capabilities = [
    CAPABILITIES.MESSAGE,
    CAPABILITIES.MEDIA,
    CAPABILITIES.STICKER,
    CAPABILITIES.VOICE,
    CAPABILITIES.POKE,
    CAPABILITIES.HISTORY,
    CAPABILITIES.VERIFIED_SENDER
  ];

  status = 'stopped';
  lastStatus = null;
  /** 'uia'（反向 WS 服务端，桥接连入，默认）| 'napcat'（协议端，可选） */
  backend = 'uia';

  /** 协议面：UIA=OneBotReverseServer / napcat=OneBotClient。app.js 的 `onebot` 变量即此引用。 */
  client = null;

  #dispatchInbound = null;
  #offStatus = null;

  /**
   * @param {object} opts
   * @param {object} opts.config QQ 通道配置切片（backend/uiaWsPort/selfId 或 snowluma.* 连接参数）
   */
  constructor({ config } = {}) {
    const s = config ?? {};
    this.backend = s.backend === 'napcat' ? 'napcat' : 'uia';
    // 客户端必须构造期就绪：app.js 在通道 start()（连接期）之前就要把
    // client 引用注入 sender/stickers/orchestrator 等子系统。
    if (this.backend === 'uia') {
      // UIA 桥接后端：核心起反向 WS 服务端，桥接（驱动正常登录的官方 QQ 客户端）
      // 以 OneBot v11 客户端身份连入。风控暴露最小（2026-11-15 起的默认路线）。
      this.client = new OneBotReverseServer({
        port: s.uiaWsPort,
        host: s.uiaHost,
        selfIdHint: s.selfId,
        onEvent: (event) => this.#dispatchInbound?.(event)
      });
    } else {
      // NapCat/SnowLuma 协议端后端（可选路线）
      this.client = new OneBotClient({
        wsUrl: s.wsUrl,
        httpUrl: s.httpUrl,
        accessToken: s.accessToken,
        httpToken: s.httpAccessToken || s.accessToken,
        // start() 之前事件无处可去（也不该有：还没 connect）；start 后经 manager 分发
        onEvent: (event) => this.#dispatchInbound?.(event)
      });
    }
  }

  /**
   * 启动通道：接线入站/状态回调并启动后端。
   * @param {object} ctx { dispatchInbound, reportStatus, autoConnect=true }
   * @returns {Promise} 连接/监听就绪的承诺
   */
  async start(ctx) {
    const { dispatchInbound, reportStatus, autoConnect = true } = ctx ?? {};
    this.#dispatchInbound = dispatchInbound;
    this.#offStatus?.();
    this.#offStatus = this.client.onStatus((status) => reportStatus?.(status));
    // 接入向导语义：enabled=true 才开闸。未接入时反向 WS 服务端不监听，
    // 桥接连不上、绝不触碰用户自己登录的 QQ（读活配置 —— enable 端点
    // 改完配置再 startChannel，构造期缓存的切片会拿到旧值）。
    if (getConfig()?.channels?.qq?.enabled !== true) {
      this.status = 'stopped';
      reportStatus?.({ connected: false, reason: '未接入（在「添加链接」中接入后可用）' });
      return undefined;
    }
    if (autoConnect) return this.client.connect();
    return undefined;
  }

  async stop() {
    if (this.#offStatus) { this.#offStatus(); this.#offStatus = null; }
    this.#dispatchInbound = null;
    // close() 幂等：core 已在 app.stop 直调过它的情况下不会双关出问题
    try { await this.client?.close?.(); } catch { /* 已关闭即目标态 */ }
  }

  /** 通道级主动重连（管理接口/未来 UI 用；语义见各后端实现）。 */
  reconnect() { return this.client?.reconnect?.(); }
}
