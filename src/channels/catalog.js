// ── 可建立链接的通道目录（驾驶舱 [+] 接入向导的数据源）────────────────────
//
// 设计：一种"能链接的软件"在这里登记一条（id/文案/表单模板），驾驶舱的
// [+] 弹窗自动多一个选项；新通道落地时只需要 ① registerBuiltinChannels 注册
// ② 在这里加目录项 —— UI 不用改。
//
// form 字段按 dot-path（如 imap.host）声明，前端据此渲染迷你表单，
// 保存时打平成嵌套对象进 config.channels.<id>。密码类字段 type=password。
// 表单之外的切片字段（pollSeconds/tls 等）保持 config 默认值即可，不强制收集。
export const CHANNEL_CATALOG = [
  {
    id: 'qq',
    label: 'QQ',
    icon: '💬',
    desc: 'UIA 桥接驱动正常登录的官方 QQ 客户端（不注入不 Hook，风控暴露最小）。接入后只响应白名单会话。',
    hint: '需要桥接环境（bridges/ venv，已装则自动）；接入 = 开闸让桥接驱动你登录的 QQ，断开 = 立即撒手',
    form: []
  },
  {
    id: 'browser',
    label: '浏览器',
    icon: '🌐',
    desc: 'CDP 连接本机浏览器：导航 / 填表 / 读页面 / 截图。仅本机控制台可操控。',
    hint: '浏览器需以远程调试模式启动：msedge --remote-debugging-port=9222',
    form: [
      { path: 'cdpUrl', label: 'CDP 地址', type: 'text', placeholder: 'http://127.0.0.1:9222' }
    ]
  },
  {
    id: 'mail',
    label: '邮箱',
    icon: '📧',
    desc: 'IMAP 收信 + SMTP 发信。白名单命中才进管道，且视为可信身份。',
    hint: '发件密码多为"授权码"；allowedFrom 为发件人白名单（正则，逗号分隔，留空照收但不可信）',
    form: [
      { path: 'imap.host', label: 'IMAP 服务器', type: 'text', placeholder: 'imap.qq.com' },
      { path: 'imap.user', label: 'IMAP 账号', type: 'text', placeholder: 'you@example.com' },
      { path: 'imap.pass', label: 'IMAP 授权码', type: 'password', placeholder: '' },
      { path: 'smtp.host', label: 'SMTP 服务器', type: 'text', placeholder: 'smtp.qq.com' },
      { path: 'smtp.user', label: 'SMTP 账号', type: 'text', placeholder: 'you@example.com' },
      { path: 'smtp.pass', label: 'SMTP 授权码', type: 'password', placeholder: '' },
      { path: 'allowedFromText', label: '发件白名单', type: 'text', placeholder: '逗号分隔，如 boss@corp.com, ^team@' }
    ]
  }
];

/** dot-path 写入嵌套对象（'imap.host' → { imap: { host: v } }），不打平已有键。 */
export function setByPath(obj, dottedPath, value) {
  const keys = String(dottedPath).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (typeof cur[keys[i]] !== 'object' || cur[keys[i]] === null) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

/**
 * 把向导表单的扁平输入（{ 'imap.host': 'x', allowedFromText: 'a, b' }）转成
 * config.channels.<id> 的切片 patch。allowedFromText 是表单专用伪字段 ——
 * 拆成 allowedFrom 数组（trim + 丢空）。
 */
export function formValuesToChannelPatch(formValues) {
  const patch = {};
  for (const [key, raw] of Object.entries(formValues ?? {})) {
    if (key === 'allowedFromText') {
      patch.allowedFrom = String(raw ?? '')
        .split(',').map((s) => s.trim()).filter(Boolean);
      continue;
    }
    if (raw === '' || raw == null) continue;   // 空值不动 config 默认
    setByPath(patch, key, raw);
  }
  return patch;
}
