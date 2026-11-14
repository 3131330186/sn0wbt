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
import { CAPABILITIES } from '../types.js';

export const QQ_CHANNEL_ID = 'qq';

export class QQChannel {
  id = QQ_CHANNEL_ID;
  label = 'QQ';
  // OneBot v11 协议端提供真实消息 ID 与发送者 QQ 号 → 可验证发送者
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

  /** OneBotClient（协议面）。app.js 的 `onebot` 变量即此引用。 */
  client = null;

  #dispatchInbound = null;
  #offStatus = null;

  /**
   * @param {object} opts
   * @param {object} opts.config SnowLuma/NapCat 配置切片（wsUrl/httpUrl/accessToken/httpAccessToken）
   */
  constructor({ config } = {}) {
    const s = config ?? {};
    // 客户端必须构造期就绪：app.js 在通道 start()（连接期）之前就要把
    // client 引用注入 sender/stickers/orchestrator 等子系统。
    this.client = new OneBotClient({
      wsUrl: s.wsUrl,
      httpUrl: s.httpUrl,
      accessToken: s.accessToken,
      httpToken: s.httpAccessToken || s.accessToken,
      // start() 之前事件无处可去（也不该有：还没 connect）；start 后经 manager 分发
      onEvent: (event) => this.#dispatchInbound?.(event)
    });
  }

  /**
   * 启动通道：接线入站/状态回调并连接协议端。
   * @param {object} ctx { dispatchInbound, reportStatus, autoConnect=true }
   * @returns {Promise} connect() 的承诺（connect 内部自带退避重连循环）
   */
  async start(ctx) {
    const { dispatchInbound, reportStatus, autoConnect = true } = ctx ?? {};
    this.#dispatchInbound = dispatchInbound;
    this.#offStatus = this.client.onStatus((status) => reportStatus(status));
    if (autoConnect) return this.client.connect();
    return undefined;
  }

  async stop() {
    if (this.#offStatus) { this.#offStatus(); this.#offStatus = null; }
    this.#dispatchInbound = null;
    // close() 幂等：core 已在 app.stop 直调过它的情况下不会双关出问题
    try { this.client?.close(); } catch { /* 已关闭即目标态 */ }
  }

  /** 通道级主动重连（管理接口/未来 UI 用；退避清零语义见 onebot.js reconnect）。 */
  reconnect() { return this.client?.reconnect(); }
}
