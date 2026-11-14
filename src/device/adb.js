// ADB 命令层：通过 adb.exe 驱动 USB 连接的安卓设备。
//
// 设计原则（与仓库其它协议层一致）：
//   - 零 npm 依赖：直接 child_process.spawn 调 adb，不做 SDK 封装
//   - 只做"执行 + 解析"，不包含任何策略 —— 安全围栏（黑名单/预算/互斥）全在 manager.js
//   - exec-out 传二进制：`adb shell screencap -p` 在 Windows 会把 \n 改写成 \r\n
//     毁掉 PNG，`exec-out` 才是字节安全的（这是官方已知行为，不是 bug）
//
// adb.exe 的查找顺序：
//   1. config.device.adbPath（显式指定，setup:adb 装到 runtime/platform-tools 后写进来）
//   2. runtime/platform-tools/adb.exe（setup:adb 的默认落点）
//   3. %LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe（Android Studio 用户）
//   4. PATH 里的 adb
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, getConfig } from '../config.js';

let cachedPath = null;

/** 找 adb.exe：配置 > runtime/platform-tools > Android SDK > PATH。找不到返回 null。 */
export function resolveAdbPath() {
  const configured = String(getConfig().device?.adbPath || '').trim();
  if (configured) return fs.existsSync(configured) ? configured : null;
  const candidates = [
    path.join(ROOT, 'runtime', 'platform-tools', 'adb.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
    path.join(ROOT, 'runtime', 'platform-tools', 'adb'),
    '/usr/bin/adb', '/usr/local/bin/adb'
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return 'adb';   // 赌 PATH；真正执行时 spawn 会报错，上层翻译成"没装 adb"
}

/** adb 路径变了（用户改配置/装了 adb）就重找。 */
export function invalidateAdbCache() { cachedPath = null; }

function adbPath() {
  if (!cachedPath) cachedPath = resolveAdbPath();
  return cachedPath;
}

/**
 * 执行一条 adb 命令。
 * @param {string[]} args adb 参数（如 ['-s', serial, 'shell', 'wm', 'size']）
 * @returns {Promise<{code: number, stdout: Buffer, stderr: string, timedOut: boolean}>}
 */
export function adbRun(args, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    const exe = adbPath();
    const chunks = [];
    let stderr = '';
    let timedOut = false;
    // .cmd/.bat（测试用的假 adb）在 Node ≥18.20 必须带 shell，否则直接 EINVAL
    const needShell = /\.(cmd|bat)$/i.test(exe);
    let child;
    try {
      child = spawn(exe, args, { windowsHide: true, shell: needShell });
    } catch (e) {
      return finish({ code: -1, stdout: Buffer.alloc(0), stderr: `无法启动 adb（${exe}）：${e?.message ?? e}`, timedOut: false });
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout.on('data', (d) => chunks.push(d));
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('error', (e) => {
      clearTimeout(timer);
      finish({ code: -1, stdout: Buffer.alloc(0), stderr: `adb 执行失败：${e?.message ?? e}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      finish({ code: code ?? -1, stdout: Buffer.concat(chunks), stderr: stderr.trim(), timedOut });
    });
  });
}

/** adb shell 子命令：数组形式传参，绕开引号转义地狱。 */
export function adbShell(serial, cmdArgs, opts = {}) {
  return adbRun(['-s', String(serial), 'shell', ...[].concat(cmdArgs)], opts);
}

/**
 * 列出已连接设备。
 * @returns {Promise<Array<{serial: string, state: string, model: string}>>} state==='device' 才算可用
 */
export async function listDevices() {
  const r = await adbRun(['devices', '-l']);
  if (r.code !== 0) throw new Error(r.stderr || 'adb devices 执行失败');
  const out = [];
  for (const line of r.stdout.toString('utf8').split(/\r?\n/)) {
    const m = /^(\S+)\s+(\S+)(?:\s+.*)?device:.*$/.exec(line.trim());
    // `adb devices -l` 设备行形如：SERIAL device product:x model:y device:z
    const simple = /^(\S+)\s+device\b/.exec(line.trim());
    if (simple) {
      const model = /model:(\S+)/.exec(line)?.[1] || '';
      out.push({ serial: m ? m[1] : simple[1], state: 'device', model });
    } else if (/^(\S+)\s+(unauthorized|offline|recovery)\b/.test(line.trim())) {
      const mm = /^(\S+)\s+(\S+)/.exec(line.trim());
      out.push({ serial: mm[1], state: mm[2], model: /model:(\S+)/.exec(line)?.[1] || '' });
    }
  }
  return out;
}

/** 解析 `wm size` 输出 → { width, height }（Override 优先，其次 Physical）。 */
export function parseWmSize(text) {
  if (!text) return null;
  const override = /Override size:\s*(\d+)x(\d+)/.exec(text);
  const physical = /Physical size:\s*(\d+)x(\d+)/.exec(text);
  const m = override || physical;
  if (!m) return null;
  return { width: Number(m[1]), height: Number(m[2]) };
}

/**
 * 从 `dumpsys window` 输出解析前台应用包名。
 *
 * 行形如：`mCurrentFocus=Window{7a4c9d8 u0 com.android.systemui/com.android.systemui.Keyguard}`
 * 花括号里是 "hash user pkg/activity" 混排，不能按位置取 —— 不同 Android 版本
 * 字段数不一样。这里按"含点号、形如包名"的令牌识别（u0/哈希都不是包名），
 * mCurrentFocus 优先（最准），mFocusedWindow / mFocusedApp 兜底。
 */
export function parseForegroundPkg(text) {
  if (!text) return null;
  const looksLikePkg = (s) => /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]+)+$/.test(s);
  const pkgFromBraces = (line) => {
    const m = /\{([^}]+)\}/.exec(line);
    if (!m) return null;
    for (const tok of m[1].split(/\s+/)) {
      const pkg = tok.split('/')[0];
      if (looksLikePkg(pkg)) return pkg;
    }
    return null;
  };
  for (const key of ['mCurrentFocus=', 'mFocusedWindow=', 'mFocusedApp=']) {
    const i = text.indexOf(key);
    if (i < 0) continue;
    const nl = text.indexOf('\n', i);
    const line = text.slice(i, nl === -1 ? undefined : nl);
    const pkg = pkgFromBraces(line);
    if (pkg) return pkg;
  }
  return null;
}

/** 解析 `dumpsys power` 的亮屏状态（mWakefulness=Awake/Asleep）。 */
export function parseAwake(text) {
  const m = /mWakefulness=(Awake|Asleep)/.exec(text || '');
  return m ? m[1] === 'Awake' : null;   // null = 读不出来（旧机型字段不同）
}
