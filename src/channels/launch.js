// ── 通道启动器：卡片点击 → 拉起对应的软件 ────────────────────────────────
//
// 设计（2026-11-15 改造）：QQ 通道不再盲目 spawn——QQNT 允许多开，已登录时
// 重复 spawn 会重复开号。smartLaunch 先探测已登录实例（账号级，经 Python 探针
// src/channels/qq/instances.js），有则唤起对应账号的窗口，没有才新开。
//   · 有实例：focus 窗口（最小化还原+抢前台）→ { action:'focused' }
//   · 无实例/探针不可用/唤起失败：落回旧行为 → { action:'spawned' }
//   · 其它通道（browser/mail）维持直接启动
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

/**
 * 智能启动：QQ 已有登录实例就唤起（不重复开号），否则新开。
 * @param {object} deps 注入点（密闭测试）：
 *   listInstances(config) → [{hwnd, account, ...}]；focusWindow(hwnd, config) → {ok}
 *   bridgedAccount  桥接正在驱动的账号昵称——同账号窗口优先（点卡片=去看机器人本体）
 *   preferredHwnd   账号卡指定的窗口句柄（多开时每张卡各指各的）
 * @returns {{launched:true, action:'focused'|'spawned', account?, hwnd?, via?, pid?} | null}
 */
export async function smartLaunch(channelId, config, {
  listInstances, focusWindow,
  bridgedAccount = '', preferredHwnd = 0,
  resolve = resolveLaunchCommand, open = openApp, exists
} = {}) {
  if (channelId === 'qq' && typeof listInstances === 'function') {
    let instances = [];
    try { instances = (await listInstances(config)) ?? []; } catch { instances = []; }
    if (instances.length) {
      // 选窗优先级：账号卡指定的 hwnd > 桥接在驱动的账号 > 第一个实例
      const target =
        (preferredHwnd && instances.find((i) => i.hwnd === preferredHwnd)) ||
        (bridgedAccount && instances.find((i) => i.account === bridgedAccount)) ||
        instances[0];
      if (target) {
        let focused = { ok: false };
        try { focused = (await focusWindow?.(target.hwnd, config)) ?? { ok: false }; } catch { /* 落回 spawn */ }
        if (focused?.ok) {
          return { launched: true, action: 'focused', account: target.account, hwnd: target.hwnd };
        }
        // 唤起失败（窗口已关/前台被拒）→ 落回 spawn 旧行为
      }
    }
  }
  const resolved = resolve(channelId, config, { exists });
  if (!resolved) return null;
  const result = open(resolved);
  return { launched: true, action: 'spawned', via: result.via, pid: result.pid };
}
