// ── QQ 实例探测/唤起（启动器的"已登录优先"机制）──────────────────────────
//
// 需求（2026-11-15）：点驾驶舱 QQ 卡片不该盲目 spawn 新实例——QQNT 允许多开，
// 重复点就重复开号。改为：先探测本机已登录的 QQ 实例（账号名 + 窗口句柄），
// 有则唤起对应窗口，没有才新开。
//
// 实现分层（对齐 DESIGN.md §5.1"sidecar 只做执行器，决策在核心"）：
//   · 账号级探测必须读 UIA（窗口左栏昵称）——Node 无 UIA 绑定，交给
//     bridges/qq-onebotv11-uia-bridge/scripts/list-instances.py（venv 现成，
//     复用桥接的 qq_uia 模块，与桥接 window_account 同源）
//   · 本模块只负责：解析配置 → spawn 探针 → 校验/整形输出 → 注入 runner 可密闭测试
//   · 探针/venv 缺失时返回空列表 → 上层落回"直接 spawn"旧行为（降级不破坏）
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const BRIDGE_ROOT = path.join(REPO_ROOT, 'bridges', 'qq-onebotv11-uia-bridge');

// 探针脚本入库（scripts/qq-instance-probe.py，自家产物）；执行器用桥接 venv 的
// Python（bridges/ 不入库，venv 由安装环节建立；缺失 → 探针不可用，启动器降级）
export const PROBE_SCRIPT = path.join(REPO_ROOT, 'scripts', 'qq-instance-probe.py');

const DEFAULT_PROBE_TIMEOUT_MS = 15000;

/** 解析探针用的 Python 解释器：config.channels.qq.probePython 覆盖 > 桥接 venv > 无 */
export function resolveProbePython(config, { exists = (p) => fs.existsSync(p) } = {}) {
  const custom = config?.channels?.qq?.probePython;
  if (custom && exists(custom)) return custom;
  const venv = path.join(BRIDGE_ROOT, '.venv', 'Scripts', 'python.exe');
  if (exists(venv) && exists(PROBE_SCRIPT)) return venv;
  return '';
}

function defaultRunner(exe, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, {
      env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
      windowsHide: true
    });
    let stdout = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* 已退出即目标态 */ }
      reject(new Error(`实例探针超时（${timeoutMs}ms）`));
    }, timeoutMs);
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`实例探针退出码 ${code}`));
      resolve({ stdout });
    });
  });
}

/**
 * 枚举本机已登录的 QQ 实例。
 * @returns {Promise<Array<{hwnd:number, account:string, minimized:boolean, title:string}>>}
 *   探针不可用/失败 → 空数组（降级，不抛错——启动器要的是"尽力而为"）
 */
export async function listQQInstances(config, { runner = null, exists, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const py = resolveProbePython(config, { exists });
  if (!py) return [];
  try {
    const run = runner ?? defaultRunner;
    const { stdout } = await run(py, [PROBE_SCRIPT, 'list'], timeoutMs);
    const parsed = JSON.parse(String(stdout));
    const rows = Array.isArray(parsed?.instances) ? parsed.instances : [];
    return rows
      .filter((r) => r && Number(r.hwnd) > 0 && Number.isFinite(Number(r.hwnd)) && typeof r.account === 'string' && r.account)
      .map((r) => ({ hwnd: Number(r.hwnd), account: String(r.account), minimized: Boolean(r.minimized), title: String(r.title ?? 'QQ') }));
  } catch {
    return [];
  }
}

/**
 * 唤起指定 QQ 窗口（最小化还原 + 抢前台）。
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
export async function focusQQInstance(hwnd, config, { runner = null, exists, timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  const py = resolveProbePython(config, { exists });
  if (!py) return { ok: false, error: '实例探针不可用（未找到桥接 venv）' };
  try {
    const run = runner ?? defaultRunner;
    const { stdout } = await run(py, [PROBE_SCRIPT, 'focus', String(Number(hwnd))], timeoutMs);
    const parsed = JSON.parse(String(stdout));
    return parsed?.ok ? { ok: true } : { ok: false, error: String(parsed?.error ?? '唤起失败') };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}
