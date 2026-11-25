// ── mail 通道工具集：发邮件 / 查收件暴露给 LLM ──────────────────────────
// 与 browser/tools.js 同款模式：getChannel 由 app.js 闭包注入，执行时取用。
import { registerConsoleTool } from '../../tool-registry.js';
import { ChannelError } from '../types.js';

function ok(data) {
  return { content: typeof data === 'string' ? data : JSON.stringify(data), isError: false };
}
function err(message) {
  return { content: `错误：${message}`, isError: true };
}

export function registerMailTools({ getChannel }) {
  function requireChannel() {
    const channel = getChannel?.();
    if (!channel) throw new Error('邮件通道不可用');
    return channel;
  }

  registerConsoleTool('mail', {
    id: 'mail_send',
    name: '发送邮件',
    description: '通过 SMTP 发送一封纯文本邮件。收件人必须是完整邮箱地址。发送失败会明确报错。',
    category: 'system',
    icon: '📧',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: '收件人邮箱地址' },
        subject: { type: 'string', description: '邮件主题' },
        text: { type: 'string', description: '正文（纯文本）' }
      },
      required: ['to', 'subject', 'text']
    },
    async execute(_ctx, args) {
      try {
        if (!args?.to || !args?.subject || args?.text === undefined) return err('需要 to/subject/text 三个参数');
        const channel = requireChannel();
        const result = await channel.sendText(String(args.to), args.text, { subject: String(args.subject) });
        return ok(`已发送至 ${args.to}（messageId: ${result.messageId || '无'}）。不要输出"已发送"类汇报。`);
      } catch (error) {
        const message = error instanceof ChannelError ? error.message : (error?.message ?? String(error));
        return err(message);
      }
    }
  });

  registerConsoleTool('mail', {
    id: 'mail_check',
    name: '检查新邮件',
    description: '立即检查一次邮箱有没有新邮件，返回新邮件数量与连接状态。邮件通道启用后可用。',
    category: 'system',
    icon: '📧',
    parameters: { type: 'object', properties: {} },
    async execute() {
      try {
        const channel = requireChannel();
        return ok(await channel.checkNow());
      } catch (error) {
        const message = error instanceof ChannelError ? error.message : (error?.message ?? String(error));
        return err(message);
      }
    }
  });

  return 2;   // 注册的工具数（测试用）
}
