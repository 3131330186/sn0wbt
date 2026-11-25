// ── browser 通道工具集：把浏览器操控暴露成 LLM 可调用的工具 ─────────────
//
// 注册模式：registerBrowserTools({ getChannel }) —— getChannel 由 app.js 闭包
// 注入（返回当前 createApp 实例的通道管理器里的 browser 通道），工具执行时
// 才取用，天然支持同进程多轮 createApp（测试/Electron 重启核心）。
// 未启用/未连接一律结构化报错（转成模型可读的中文提示），绝不伪造成功。
import { registerConsoleTool } from '../../tool-registry.js';
import { ChannelError, CHANNEL_ERROR_CODES } from '../types.js';

function ok(data) {
  return { content: typeof data === 'string' ? data : JSON.stringify(data), isError: false };
}
function err(message) {
  return { content: `错误：${message}`, isError: true };
}

/** 把通道层异常翻译成给模型的可读提示（其他异常原样透传）。 */
function toReadableError(error) {
  if (error instanceof ChannelError) return error.message;
  return error?.message ?? String(error);
}

export function registerBrowserTools({ getChannel }) {
  /** 取 browser 通道实例（未注册/未启用在这里统一判定）。 */
  function requireChannel() {
    const channel = getChannel?.();
    if (!channel) throw new Error('浏览器通道不可用');
    return channel;
  }

  registerConsoleTool('browser', {
    id: 'browser_read',
    name: '读取网页',
    description: '读取浏览器当前活动标签页的内容（URL/标题/可见文本）。浏览器通道启用后可用。',
    category: 'system',
    icon: '🌐',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        const channel = requireChannel();
        const page = await channel.readPage();
        return ok(`【${page.title}】(${page.url})\n${page.text}`);
      } catch (error) {
        return err(toReadableError(error));
      }
    }
  });

  registerConsoleTool('browser', {
    id: 'browser_navigate',
    name: '打开网页',
    description: '在浏览器活动标签页打开一个 URL，返回最终 URL 和页面标题（重定向后会跟踪到最终地址）。',
    category: 'system',
    icon: '🌐',
    parameters: {
      type: 'object',
      properties: { url: { type: 'string', description: '要打开的完整 URL（含 https://）' } },
      required: ['url']
    },
    async execute(_ctx, args) {
      try {
        if (!args?.url) return err('缺少 url 参数');
        const channel = requireChannel();
        const result = await channel.navigate(String(args.url));
        return ok(`已打开：${result.title}（${result.url}）`);
      } catch (error) {
        return err(toReadableError(error));
      }
    }
  });

  registerConsoleTool('browser', {
    id: 'browser_click',
    name: '点击网页元素',
    description: '点击页面上匹配 CSS 选择器的元素。选择器不确定时先用 browser_read 看内容，必要时用 browser_eval 查询。',
    category: 'system',
    icon: '🌐',
    parameters: {
      type: 'object',
      properties: { selector: { type: 'string', description: 'CSS 选择器，如 #submit 或 .item:nth-child(2)' } },
      required: ['selector']
    },
    async execute(_ctx, args) {
      try {
        if (!args?.selector) return err('缺少 selector 参数');
        const channel = requireChannel();
        return ok(await channel.click(String(args.selector)));
      } catch (error) {
        return err(toReadableError(error));
      }
    }
  });

  registerConsoleTool('browser', {
    id: 'browser_fill',
    name: '填写输入框',
    description: '向页面输入框填充文本（先清空原内容再填）。适合表单、搜索框。',
    category: 'system',
    icon: '🌐',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: '输入框的 CSS 选择器' },
        text: { type: 'string', description: '要填入的文本' }
      },
      required: ['selector', 'text']
    },
    async execute(_ctx, args) {
      try {
        if (!args?.selector) return err('缺少 selector 参数');
        if (args.text === undefined) return err('缺少 text 参数');
        const channel = requireChannel();
        return ok(await channel.fill(String(args.selector), args.text));
      } catch (error) {
        return err(toReadableError(error));
      }
    }
  });

  registerConsoleTool('browser', {
    id: 'browser_eval',
    name: '执行页面脚本',
    description: '在当前页面上下文执行一段 JavaScript 并返回 JSON 结果。用于 read/read 不到的结构化数据提取（表格、列表）。只读用途优先；会改页面状态的脚本慎用。',
    category: 'system',
    icon: '🌐',
    parameters: {
      type: 'object',
      properties: { expression: { type: 'string', description: 'JS 表达式/函数体，返回值会被 JSON 化' } },
      required: ['expression']
    },
    async execute(_ctx, args) {
      try {
        if (!args?.expression) return err('缺少 expression 参数');
        const channel = requireChannel();
        return ok(await channel.evaluate(args.expression));
      } catch (error) {
        return err(toReadableError(error));
      }
    }
  });

  registerConsoleTool('browser', {
    id: 'browser_tabs',
    name: '列出标签页',
    description: '列出浏览器当前打开的所有标签页（标题+URL），用于确认活动页或找目标页。',
    category: 'system',
    icon: '🌐',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        const channel = requireChannel();
        return ok(await channel.listTabs());
      } catch (error) {
        return err(toReadableError(error));
      }
    }
  });

  return 6;   // 注册的工具数（测试用）
}
