// ── mail 通道：sn0wbot 的第三个通道（IMAP 收 / SMTP 发）──────────────────
//
// 设计要点：
//   · imapFactory / smtpFactory 可注入 —— 密闭测试注入假客户端，不依赖真实邮箱
//   · enabled=false（默认）不连接；enabled=true 后：连 IMAP → 记录当前最高 UID
//     作基线（不重放历史邮件）→ 定时轮询新邮件 → dispatchInbound
//   · 入站 record：chatId=发件人地址（会话=对端邮箱）、senderVerified 由
//     allowedFrom 白名单判定 —— 空白名单=照收但 unverified（安全边界见 AGENTS.md）
//   · v0.8 范围：连通性 + 收（进 manager 分发）+ 发（sendText）；邮件消息
//     接入 AI 自动回复管道属后续路线（需要 chatKey 语义设计，见 DESIGN.md）
//   · 隐私：邮件正文不进日志，日志只记 UID/发件人域/结果
import { CAPABILITIES, ChannelError, CHANNEL_ERROR_CODES } from '../types.js';
import { getConfig } from '../../config.js';

export const MAIL_CHANNEL_ID = 'mail';

/** 默认 IMAP 客户端工厂（imapflow）。接口：connect()/getUnseen(sinceUid)/close()。 */
async function defaultImapFactory(config) {
  let ImapFlow;
  try {
    ({ ImapFlow } = await import('imapflow'));
  } catch (error) {
    throw new ChannelError(CHANNEL_ERROR_CODES.CHANNEL_OFFLINE, 'imapflow 未安装（npm i imapflow）');
  }
  const client = new ImapFlow({
    host: config.imap?.host,
    port: Number(config.imap?.port) || 993,
    secure: config.imap?.tls !== false,
    auth: { user: config.imap?.user, pass: config.imap?.pass },
    logger: false
  });
  let box = null;
  return {
    async connect() {
      await client.connect();
      box = null;   // INBOX 的 MailboxLock 在每次 getUnseen 时打开，连接保持长连
    },
    async getUnseen(sinceUid) {
      const lock = await client.getMailboxLock('INBOX');
      const out = [];
      try {
        // UID >= sinceUid+1 的新邮件；body 只取 text 部分
        for await (const msg of client.fetch({ uid: `>${sinceUid}` }, {
          uid: true, envelope: true, bodyParts: ['text']
        })) {
          out.push({
            uid: msg.uid,
            from: msg.envelope?.from?.[0]?.address ?? '',
            fromName: msg.envelope?.from?.[0]?.name ?? '',
            subject: msg.envelope?.subject ?? '',
            text: msg.bodyParts?.get?.('text') ?? msg.bodyParts?.text ?? ''
          });
        }
      } finally {
        lock.release();
      }
      return out;
    },
    async close() { try { await client.logout(); } catch { try { client.close(); } catch { /* ignore */ } } }
  };
}

/** 默认 SMTP 发送工厂（nodemailer）。接口：createTransport/send/close。 */
async function defaultSmtpFactory(config) {
  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch (error) {
    throw new ChannelError(CHANNEL_ERROR_CODES.CHANNEL_OFFLINE, 'nodemailer 未安装（npm i nodemailer）');
  }
  const transporter = nodemailer.createTransport({
    host: config.smtp?.host,
    port: Number(config.smtp?.port) || 465,
    secure: config.smtp?.tls !== false,
    auth: { user: config.smtp?.user, pass: config.smtp?.pass }
  });
  return {
    from: config.smtp?.user ?? '',
    async send({ to, subject, text }) {
      const info = await transporter.sendMail({ from: config.smtp?.user, to, subject, text });
      return { messageId: info?.messageId ?? '' };
    },
    async close() { transporter.close(); }
  };
}

export class MailChannel {
  id = MAIL_CHANNEL_ID;
  label = '邮件';
  // 邮件地址是可验证身份 → verifiedSender；媒体=附件（v0.8 仅文本，预留声明）
  capabilities = [CAPABILITIES.MESSAGE, CAPABILITIES.MEDIA, CAPABILITIES.VERIFIED_SENDER];
  status = 'stopped';
  lastStatus = null;

  #config = null;
  #imapFactory = null;
  #smtpFactory = null;
  #imap = null;
  #smtp = null;
  #timer = null;
  #dispatch = null;
  #report = null;
  #lastUid = 0;
  #polling = false;

  constructor({ config, imapFactory, smtpFactory } = {}) {
    this.#config = config ?? {};
    this.#imapFactory = imapFactory ?? null;
    this.#smtpFactory = smtpFactory ?? null;
  }

  get enabled() { return getConfig()?.channels?.mail?.enabled === true; }

  async start(ctx) {
    const { dispatchInbound, reportStatus } = ctx ?? {};
    this.#dispatch = dispatchInbound ?? (() => {});
    this.#report = reportStatus ?? (() => {});
    if (!this.enabled) {
      this.status = 'stopped';
      this.#report({ connected: false, reason: '未启用（channels.mail.enabled）' });
      return undefined;
    }
    this.status = 'starting';
    try {
      this.#imap = await (this.#imapFactory ?? defaultImapFactory)(this.#config);
      await this.#imap.connect();
      this.#lastUid = await this.#baselineUid();
      this.status = 'started';
      this.#report({ connected: true, detail: `IMAP 已连接 ${this.#config.imap?.host}（基线 UID ${this.#lastUid}）` });
      this.#startPolling();
      return this.#imap;
    } catch (error) {
      this.status = 'error';
      this.lastError = String(error?.message ?? error);
      this.#report({ connected: false, error: this.lastError });
      // 不向上抛：邮箱配置没填/密码错是常态，工具层给结构化提示
      return undefined;
    }
  }

  async stop() {
    if (this.#timer) { clearInterval(this.#timer); this.#timer = null; }
    try { await this.#imap?.close?.(); } catch { /* ignore */ }
    try { await this.#smtp?.close?.(); } catch { /* ignore */ }
    this.#imap = null;
    this.#smtp = null;
    this.status = 'stopped';
  }

  /** 基线 UID：连上后先摸清"现在的最后位置"，历史邮件不重放。 */
  async #baselineUid() {
    // 假客户端可能只实现 getUnseen —— 没有 baseline 接口就从 0 开始
    // （空 allowedFrom 时 unverified 戳兜底，不会误触发敏感动作）
    if (typeof this.#imap?.getHighestUid === 'function') {
      return Number(await this.#imap.getHighestUid()) || 0;
    }
    return 0;
  }

  #startPolling() {
    const seconds = Number(this.#config.pollSeconds) || 60;
    this.#timer = setInterval(() => { this.poll().catch(() => {}); }, seconds * 1000);
    this.#timer.unref?.();
  }

  /** 轮询一次新邮件（可由工具手动触发）。返回本次入站的条数。 */
  async poll() {
    if (!this.#imap || this.#polling) return 0;
    this.#polling = true;
    try {
      const messages = await this.#imap.getUnseen(this.#lastUid);
      let count = 0;
      for (const message of messages ?? []) {
        if (Number(message.uid) > this.#lastUid) this.#lastUid = Number(message.uid);
        const record = this.#toRecord(message);
        if (!record) continue;   // 白名单拦截：不命中 allowedFrom 的邮件不入站
        count += 1;
        this.#dispatch(record);
      }
      if (count) this.#report({ connected: true, detail: `新邮件 ${count} 封` });
      return count;
    } catch (error) {
      this.#report({ connected: false, error: String(error?.message ?? error) });
      return 0;
    } finally {
      this.#polling = false;
    }
  }

  #toRecord(message) {
    const from = String(message.from ?? '');
    const verified = this.#matchesAllowedFrom(from);
    // 白名单非空时：未命中 → null（调用方跳过 dispatch）。空白名单 = 照收但
    // unverified（保守标记，下游据此禁止敏感动作）—— 不做静默丢弃。
    const patterns = Array.isArray(this.#config.allowedFrom) ? this.#config.allowedFrom : [];
    if (patterns.length && !verified) return null;
    const maxChars = Number(this.#config.maxBodyChars) || 12000;
    const body = String(message.text ?? '').slice(0, maxChars);
    return {
      // 通道无关的会话语义：一封邮件的会话 = 对端邮箱地址
      chatType: 'private',
      chatId: from,
      senderId: from || null,
      senderName: String(message.fromName ?? '') || from,
      senderVerified: verified,
      text: `[邮件] ${message.subject ?? ''}\n${body}`,
      messageId: message.uid ?? null,
      observedAt: Date.now(),
      source: 'imap',
      // 未配白名单时保守标记 unverified —— 下游据此禁止敏感动作
      confidence: verified ? 'verified' : 'unverified'
    };
  }

  /** 发件人是否命中 allowedFrom（正则字符串数组；空 = 一律 unverified）。 */
  #matchesAllowedFrom(address) {
    const patterns = Array.isArray(this.#config.allowedFrom) ? this.#config.allowedFrom : [];
    if (!patterns.length) return false;
    return patterns.some((pattern) => {
      try { return new RegExp(pattern).test(address); } catch { return false; }
    });
  }

  /** 惰性 SMTP：第一次发送时才建连接（收件不要求 SMTP 可用）。 */
  async #requireSmtp() {
    if (this.#smtp) return this.#smtp;
    if (!this.#config?.smtp?.host) {
      throw new ChannelError(CHANNEL_ERROR_CODES.CHANNEL_OFFLINE, 'SMTP 未配置（channels.mail.smtp.host 为空）');
    }
    this.#smtp = await (this.#smtpFactory ?? defaultSmtpFactory)(this.#config);
    return this.#smtp;
  }

  /**
   * 发送邮件（出站统一走此方法；manager.send('mail','sendText',...) 命中）。
   * @returns {{sent: true, messageId: string}} 失败抛错（结构化，调用方转 err）
   */
  async sendText(target, text, opts = {}) {
    if (!target) throw new ChannelError(CHANNEL_ERROR_CODES.CAPABILITY_MISSING, '缺少收件人地址');
    const smtp = await this.#requireSmtp();
    const result = await smtp.send({
      to: String(target),
      subject: String(opts.subject ?? '(无主题)'),
      text: String(text ?? '')
    });
    return { sent: true, messageId: result?.messageId ?? '' };
  }

  /** 手动触发一次轮询并返回摘要（工具用）。 */
  async checkNow() {
    const count = await this.poll();
    return { newMessages: count, lastUid: this.#lastUid, connected: Boolean(this.#imap) };
  }
}
