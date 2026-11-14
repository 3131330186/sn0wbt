// 群聊日报：按天筛选当前会话的消息存档，整理成时间线 + 统计交给模型写日报。
// 本技能只做"如实取数"，不起草正文 —— 日报的口吻和取舍由模型按人设发挥。
// 只读：不调用任何 QQ 写接口，数据全部来自 ctx.store（工具绑定当前会话，天然拿不到别的群）。

let cfg = () => ({});

export function setup(api) {
  cfg = api.config;
  api.registerTool({
    id: 'digest',
    name: '群聊日报取数',
    description:
      '取当前会话（群/私聊）某一天的消息时间线与统计，用于写群聊日报。' +
      '当群友让你「总结一下今天的群聊」「来份日报」「昨天都聊了啥」「捋一捋刚才的争论」时调用。' +
      '返回按时间排序的原始消息与统计（条数/人数/活跃榜），你再用自己的人设口吻写成日报；' +
      '它不会替你写正文，也别在没取数的情况下编日报。',
    category: 'query',
    icon: '📰',
    defaultEnabled: true,
    parameters: {
      type: 'object',
      properties: {
        scope: {
          type: 'string',
          enum: ['today', 'yesterday'],
          description: '统计哪一天：today=今天（默认），yesterday=昨天'
        },
        focus: {
          type: 'string',
          description: '可选。群友想重点看的主题（如「关于晚饭的讨论」），原样传给日报写作参考'
        }
      },
      required: []
    },
    async execute(ctx, args) {
      try {
        args = args || {};
        const scope = args.scope === 'yesterday' ? 'yesterday' : 'today';
        const focus = typeof args.focus === 'string' ? args.focus.trim().slice(0, 200) : '';

        // 读取上限：执行时读配置（不快照），夹在 100~2000
        const rawMax = Number(cfg().maxMessages);
        const maxMessages = Number.isFinite(rawMax) ? Math.min(2000, Math.max(100, Math.round(rawMax))) : 600;

        // 按本地时区算天的边界
        const now = new Date();
        const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        let start, end;
        if (scope === 'yesterday') {
          start = todayStart - 24 * 3600 * 1000;
          end = todayStart;
        } else {
          start = todayStart;
          end = now.getTime() + 1000; // 含"刚刚"
        }

        const chatKey = ctx.session && ctx.session.chatKey;
        if (!chatKey) {
          return { content: '取不到当前会话（chatKey 缺失），无法生成日报。', isError: true };
        }

        // 从最近的往回取一窗，再按天筛选（存档按时间递增，recent 的窗口足够覆盖当天即可）
        let msgs = [];
        try {
          msgs = ctx.store.recent(chatKey, { limit: maxMessages }) || [];
        } catch (e) {
          return { content: '读取消息存档失败：' + (e && e.message ? e.message : String(e)), isError: true };
        }

        const inRange = msgs.filter((m) => {
          const ts = Number(m && m.ts);
          if (!Number.isFinite(ts)) return false;
          return ts >= start && ts < end;
        });

        const dayLabel = new Date(start).toLocaleDateString('zh-CN');
        if (inRange.length === 0) {
          return {
            content: `【${dayLabel}】这个会话在所选时间范围内没有存档消息（读取窗口：最近 ${msgs.length} 条）。` +
              '如实告诉群友今天还没人说话即可，不要编造日报。'
          };
        }

        // 统计：参与人数、活跃榜、按小时分布
        const bySender = new Map();
        const byHour = new Array(24).fill(0);
        let selfCount = 0;
        for (const m of inRange) {
          const name = (m.self ? '我(bot)' : String(m.senderName || m.senderId || '未知'));
          bySender.set(name, (bySender.get(name) || 0) + 1);
          byHour[new Date(m.ts).getHours()] += 1;
          if (m.self) selfCount += 1;
        }
        const topTalkers = [...bySender.entries()]
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5)
          .map(([name, n]) => `${name}(${n}条)`)
          .join('、');
        const busiest = byHour
          .map((n, h) => ({ h, n }))
          .sort((a, b) => b.n - a.n)[0];
        const participants = bySender.size;

        // 时间线：旧 → 新；控制单条长度，长消息截断（给模型的是素材，不是全文存档）
        const hhmm = (ts) => {
          const d = new Date(ts);
          return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
        };
        const oneLine = (s) => String(s || '').replace(/\s+/g, ' ').trim();
        const clip = (s, n) => (s.length > n ? s.slice(0, n) + '…' : s);
        const timeline = inRange.map((m) => {
          const who = m.self ? '我(bot)' : oneLine(m.senderName || String(m.senderId || '未知'));
          let text = clip(oneLine(m.text), 160) || '（无文本，如图片/表情）';
          if (m.reply && m.reply.text) text = `〔回复 ${oneLine(m.reply.sender)}：${clip(oneLine(m.reply.text), 60)}〕` + text;
          return `${hhmm(m.ts)} ${who}: ${text}`;
        });

        const head =
          `【${dayLabel} ${scope === 'yesterday' ? '昨日' : '今日'}群聊数据】\n` +
          `消息 ${inRange.length} 条（其中我(bot)自己发的 ${selfCount} 条），参与 ${participants} 人\n` +
          `最活跃：${topTalkers || '无'}\n` +
          `最热闹的时段：${String(busiest.h).padStart(2, '0')} 点（${busiest.n} 条）\n` +
          (focus ? `群友指定重点主题：${focus}（写日报时优先覆盖它）\n` : '') +
          `\n时间线（旧 → 新）：\n` +
          timeline.join('\n');

        return { content: head };
      } catch (e) {
        return { content: '生成日报素材失败：' + (e && e.message ? e.message : String(e)), isError: true };
      }
    }
  });
}
