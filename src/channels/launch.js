// ── 通道启动器：卡片点击 → 拉起对应的软件 ────────────────────────────────
//
// 设计：卡片点击 = openApp(resolveLaunchCommand(channel, config))。
//   · exe 直启：spawn(exe, [], detached) —— QQ 单实例自会聚焦已有窗口
//   · 协议/别名：cmd /c start "" <target> —— 走系统默认处理（msedge / mail: 等）
// 权限边界：launch 只由**本机控制台点击**触发（POST /api/channels/:id/launch）；
//   外部消息（QQ/邮件）永远无法触发启动——它们是外部输入，不是指令（AGENTS.md）。
import { spawn } from 'node:child_process';
import fs from 'node:fs';

/** QQ NT 客户端的常见安装位（按序探测）。 */
const QQ_PATHS = [
  'C:\\Program Files\\Tencent\\QQNT\\QQ.exe',
  'C:\\Program Files (x86)\\Tencent\\QQNT\\QQ.exe'
];

/**
 * 解析某通道的启动命令。
 * @returns {{ kind: 'exe'|'shell', target: string }} exe=直接 spawn；shell=经 cmd start
 */
export function resolveLaunchCommand(channelId, config, { exists = (p) => fs.existsSync(p) } = {}) {
  const slice = config?.channels?.[channelId] ?? {};
  if (slice.launchCommand) return { kind: 'shell', target: slice.launchCommand };

  if (channelId === 'qq') {
    const found = QQ_PATHS.find((p) => exists(p));
    if (found) return { kind: 'exe', target: found };
    return { kind: 'shell', target: 'qq://' };   // 兜底：QQ 协议链接
  }
  if (channelId === 'browser') return { kind: 'shell', target: 'msedge' };   // Windows 必有 Edge
  if (channelId === 'mail') return { kind: 'shell', target: 'mail:' };       // 系统默认邮件处理
  return null;
}

/**
 * 拉起软件。注入 runner 可密闭测试；生产走真实 spawn。
 * @returns {{ launched: true, via: string, pid?: number }}
 */
export function openApp(resolved, { runner = null } = {}) {
  const run = runner ?? ((cmd, args) => {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref?.();
    return child;
  });
  if (resolved.kind === 'exe') {
    const child = run(resolved.target, []);
    return { launched: true, via: resolved.target, pid: child?.pid };
  }
  // shell 目标经 start：空标题占位兼容带引号路径
  run('cmd.exe', ['/c', 'start', '', resolved.target]);
  return { launched: true, via: resolved.target };
}
