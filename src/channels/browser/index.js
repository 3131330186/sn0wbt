// ── browser 通道：sn0wbot 的第二个通道，验证"框架不是纸面的" ─────────────
//
// 原理：CDP（Chrome DevTools Protocol）attach 到已开启远程调试端口的
// Chrome/Edge。**不自带浏览器**（playwright-core 无二进制、不下载内核），
// 用户浏览器怎么登、插件怎么装，通道就看到什么样 —— 和 QQ 通道驱动
// "正常登录的客户端"是同一个哲学。
//
// 启用方法：浏览器以远程调试模式启动后，配置 channels.browser.enabled=true
//   msedge.exe --remote-debugging-port=9222
//
// 设计要点：
//   · connectFn 可注入 —— 密闭测试注入假 CDP，不依赖真实浏览器
//   · enabled=false（默认）时 start() 不发起连接，状态如实 stopped
//   · 操控面（navigate/readPage/click/fill/evaluate/screenshot）挂在
//     通道自身（不是 client 上），manager.send 走"通道自身实现优先"路径
//   · 操控类无入站事件流：不 dispatchInbound（网页通知类入站属后续路线）
import { CAPABILITIES, ChannelError, CHANNEL_ERROR_CODES } from '../types.js';

export const BROWSER_CHANNEL_ID = 'browser';

/** 默认连接器：playwright-core connectOverCDP（依赖缺失/浏览器未开时抛错）。 */
async function defaultConnect(config) {
  let chromium;
  try {
    ({ chromium } = await import('playwright-core'));
  } catch (error) {
    throw new ChannelError(CHANNEL_ERROR_CODES.CHANNEL_OFFLINE,
      'playwright-core 未安装（npm i playwright-core）');
  }
  try {
    return await chromium.connectOverCDP(config.cdpUrl, {
      timeout: Number(config.connectTimeoutMs) || 8000
    });
  } catch (error) {
    throw new ChannelError(CHANNEL_ERROR_CODES.CHANNEL_OFFLINE,
      `CDP 连接失败（${config.cdpUrl}）：${error?.message ?? error}。`
      + '请确认浏览器已用 --remote-debugging-port 启动');
  }
}

export class BrowserChannel {
  id = BROWSER_CHANNEL_ID;
  label = '浏览器';
  capabilities = [CAPABILITIES.CONTROL, CAPABILITIES.MEDIA];
  status = 'stopped';
  lastStatus = null;

  #config = null;
  #connectFn = null;
  #cdp = null;              // playwright browser 实例（或测试注入的假对象）

  /**
   * @param {object} opts
   * @param {object} opts.config  channels.browser 配置切片
   * @param {Function} [opts.connectFn] 注入的连接函数（测试用），签名 (config) => cdp
   */
  constructor({ config, connectFn } = {}) {
    this.#config = config ?? {};
    this.#connectFn = connectFn ?? null;
  }

  get cdp() { return this.#cdp; }
  get enabled() { return this.#config?.enabled === true; }

  async start(ctx) {
    const { reportStatus } = ctx ?? {};
    if (!this.enabled) {
      this.status = 'stopped';
      reportStatus?.({ connected: false, reason: '未启用（channels.browser.enabled）' });
      return undefined;
    }
    this.status = 'starting';
    try {
      this.#cdp = await (this.#connectFn ?? defaultConnect)(this.#config);
      this.status = 'started';
      reportStatus?.({ connected: true, detail: `CDP 已连接 ${this.#config.cdpUrl}` });
      return this.#cdp;
    } catch (error) {
      this.status = 'error';
      this.lastError = String(error?.message ?? error);
      // 不向上抛：浏览器没开调试端口是常态，通道保持 error，工具层给结构化提示
      reportStatus?.({ connected: false, error: this.lastError });
      return undefined;
    }
  }

  async stop() {
    try { await this.#cdp?.close?.(); } catch { /* 已断开即目标态 */ }
    this.#cdp = null;
    this.status = 'stopped';
  }

  /** 通道未就绪时统一抛结构化错误（工具层捕获转成给模型的可读提示）。 */
  #requireReady() {
    if (!this.#cdp) {
      throw new ChannelError(
        CHANNEL_ERROR_CODES.CHANNEL_OFFLINE,
        this.enabled
          ? '浏览器通道未连接（CDP 未就绪，确认浏览器已带远程调试端口启动）'
          : '浏览器通道未启用（config.channels.browser.enabled = true 后重启生效）'
      );
    }
  }

  /** 取活动页：最后一个上下文的最后一个标签页；没有页面就开一个。 */
  #activePage() {
    const context = this.#cdp.contexts()?.[0];
    if (!context) throw new ChannelError(CHANNEL_ERROR_CODES.CHANNEL_OFFLINE, 'CDP 无可用上下文');
    const pages = context.pages();
    const page = pages[pages.length - 1] ?? null;
    if (page) return page;
    return context.newPage();
  }

  /** 打开 URL。返回 { url, title }。 */
  async navigate(url) {
    this.#requireReady();
    const page = this.#activePage();
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: Number(this.#config.navTimeoutMs) || 30000
    });
    return { url: page.url(), title: await page.title() };
  }

  /** 读当前页：标题 + URL + 可见文本（按 readLimit 截断，防 token 失控）。 */
  async readPage() {
    this.#requireReady();
    const page = this.#activePage();
    const limit = Number(this.#config.readLimit) || 8000;
    const text = await page.evaluate(() => {
      const el = document.body;
      return el ? String(el.innerText ?? '') : '';
    });
    const trimmed = text.slice(0, limit);
    const truncated = text.length > limit ? `\n…（已截断，原文 ${text.length} 字符）` : '';
    return {
      url: page.url(),
      title: await page.title(),
      text: `${trimmed}${truncated}`
    };
  }

  /** 点击 CSS 选择器。 */
  async click(selector) {
    this.#requireReady();
    await this.#activePage().click(selector, {
      timeout: Number(this.#config.actionTimeoutMs) || 10000
    });
    return { clicked: String(selector) };
  }

  /** 填充输入框（先清空再填）。 */
  async fill(selector, text) {
    this.#requireReady();
    await this.#activePage().fill(selector, String(text ?? ''), {
      timeout: Number(this.#config.actionTimeoutMs) || 10000
    });
    return { filled: String(selector), length: String(text ?? '').length };
  }

  /** 在页面里执行 JS 并返回 JSON 化结果。 */
  async evaluate(expression) {
    this.#requireReady();
    const result = await this.#activePage().evaluate(String(expression));
    return { result: safeJson(result) };
  }

  /** 截图（PNG Buffer）。 */
  async screenshot() {
    this.#requireReady();
    const buffer = await this.#activePage().screenshot({ type: 'png' });
    return { url: this.#activePage().url(), png: buffer };
  }

  /** 列出当前打开的标签页（标题 + URL）。 */
  async listTabs() {
    this.#requireReady();
    const pages = this.#cdp.contexts()?.flatMap((context) => context.pages()) ?? [];
    const tabs = [];
    for (const page of pages) {
      tabs.push({ url: page.url(), title: await page.title().catch(() => '') });
    }
    return { tabs };
  }
}

/** JSON 化任意 evaluate 结果（循环引用/undefined 兜底，绝不抛）。 */
function safeJson(value) {
  try {
    return JSON.parse(JSON.stringify(value ?? null));
  } catch {
    return String(value);
  }
}
