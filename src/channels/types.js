// ── sn0wbot 通道契约（v1）───────────────────────────────────────────────
//
// 通道（Channel）= sn0wbot 与任一外部软件之间的统一抽象。QQ 是第一个通道，
// 以后浏览器、邮件、Office、Windows 操控 sidecar 都是通道 —— 核心引擎
// （store→orchestrator→prompt→llm→tools→sender）不感知通道细节。
//
// 契约要点：
//   · 入站：通道把外部事件交给 manager 分发的 dispatchInbound(record)；
//     record 结构与 onebot.js 产出的现有事件对象对齐（chatId/chatType/text/…），
//     manager 自动补 record.channelId。
//   · 出站：通道实现消息面方法（sendText/sendImage/…），出站仍统一走
//     sender.js 队列（限频/串行/留档），队列再落到通道方法上。
//   · 能力：通道声明 capabilities，无对应能力的调用抛 ChannelError
//     （CAPABILITY_MISSING）—— 结构化失败，绝不静默、绝不伪造成功。
//   · 状态：start() 时收到 reportStatus；连接层状态变化必须如实上报，
//     未登录/断线/控件不可读都要让上层看到真实状态。
//   · 身份置信度：能拿到平台真实发送者 ID 的通道声明 'verifiedSender'；
//     UIA 类通道只能给 'unverified' —— 未验证发送者的群消息不得写入主人
//     私人长期记忆，也不得触发电脑操作（安全边界，见 AGENTS.md）。
//
// ⚠️ 本机 node v24 解析器坑：.mjs/.js(ESM) 里不要写解构 `as` 重命名。

/** 通道能力常量。通道按需声明子集；manager 按它做路由与门控。 */
export const CAPABILITIES = {
  MESSAGE: 'message',             // 可收发文本消息
  MEDIA: 'media',                 // 可收发图片/文件等媒体
  STICKER: 'sticker',             // 可发表情包
  VOICE: 'voice',                 // 可发语音气泡
  POKE: 'poke',                   // 可拍一拍
  HISTORY: 'history',             // 可按 ID 查历史消息/成员信息
  CONTROL: 'control',             // 可操控宿主软件（浏览器/Office 类）
  VERIFIED_SENDER: 'verifiedSender'  // 入站事件携带可验证的平台发送者身份
};

/** 出站发送状态：非幂等发送失败后进入 uncertain 的不得自动重试（见 AGENTS.md）。 */
export const SEND_STATUS = {
  SENT: 'sent',              // 协议端/宿主确认已投递
  FAILED: 'failed',          // 明确失败（可重试由调用方决定）
  UNCERTAIN: 'uncertain'     // 超时/结果不明 —— 先核对再决定，不盲目重试
};

/** manager.send(action) 需要的能力映射：新增出站动作在这里登记。 */
export const METHOD_CAPABILITY = {
  sendText: CAPABILITIES.MESSAGE,
  sendImage: CAPABILITIES.MEDIA,
  sendSegments: CAPABILITIES.MEDIA,
  sendSticker: CAPABILITIES.STICKER,
  sendVoice: CAPABILITIES.VOICE,
  sendPoke: CAPABILITIES.POKE,
  getMsg: CAPABILITIES.HISTORY,
  getGroupMemberInfo: CAPABILITIES.HISTORY
};

/** 通道层结构化错误：code 可编程判断，message 给人看。 */
export class ChannelError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ChannelError';
    this.code = code;
  }
}

export const CHANNEL_ERROR_CODES = {
  CHANNEL_NOT_FOUND: 'CHANNEL_NOT_FOUND',
  CHANNEL_DUPLICATE: 'CHANNEL_DUPLICATE',
  CAPABILITY_MISSING: 'CAPABILITY_MISSING',
  INVALID_CHANNEL: 'INVALID_CHANNEL',
  CHANNEL_OFFLINE: 'CHANNEL_OFFLINE'
};

/**
 * 注册时快速失败：结构不合法的通道宁可当场报错，也不要运行期才炸。
 * 注意 start(ctx) 里 ctx = { dispatchInbound, reportStatus, autoConnect }。
 */
export function validateChannel(channel) {
  const problems = [];
  if (!channel || typeof channel !== 'object') problems.push('通道必须是对象');
  if (typeof channel?.id !== 'string' || !channel.id) problems.push('缺 id（唯一字符串）');
  if (typeof channel?.label !== 'string' || !channel.label) problems.push('缺 label（显示名）');
  if (!Array.isArray(channel?.capabilities)) problems.push('缺 capabilities 数组（可为空数组）');
  if (typeof channel?.start !== 'function') problems.push('缺 start(ctx)');
  if (typeof channel?.stop !== 'function') problems.push('缺 stop()');
  if (problems.length) {
    throw new ChannelError(
      CHANNEL_ERROR_CODES.INVALID_CHANNEL,
      `通道结构不合法（${channel?.id ?? '未命名'}）：${problems.join('；')}`
    );
  }
  return channel;
}
