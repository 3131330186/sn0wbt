// ── 桥接进程管理：接入/断开/开机自启共用的执行器 ─────────────────────────
// fire-and-forget：ps1 自己负责互斥体与看门狗 hold，这里不等待。
// bridges/ 缺失（未装桥接环境）时如实降级返回说明文字，不报错。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const BRIDGE_DIR = path.resolve(__dirname, '..', '..', '..', 'bridges', 'qq-onebotv11-uia-bridge');

export function bridgeInstalled() {
  return fs.existsSync(path.join(BRIDGE_DIR, 'scripts', 'start-bridge.ps1'));
}

/** @returns {'已拉起'|'已停止'|string} 便于上层直接把结果透出给用户 */
export function spawnBridgeProcess(script) {
  const ps1 = path.join(BRIDGE_DIR, 'scripts', script);
  if (!fs.existsSync(ps1)) return '桥接环境未安装（在项目目录运行 npm run setup:bridge）';
  try {
    const child = spawn('powershell.exe',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1],
      { cwd: BRIDGE_DIR, windowsHide: true, stdio: 'ignore' });
    child.unref?.();
    return script === 'start-bridge.ps1' ? '已拉起' : '已停止';
  } catch (error) {
    return `失败：${error?.message ?? error}`;
  }
}
