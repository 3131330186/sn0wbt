// 语音通话 · 音频设备枚举（Phase 0 探针）。
//
// 三个来源，各有分工：
//   · 录音设备（capture）—— ffmpeg dshow 列举。这是收音链路实际用的通道口径，
//     收音直接走 dshow（见 bridge.js），所以枚举也用同一口径，避免"列得出、用不了"。
//   · 播放设备（playback）—— winmm waveOut 列举（native/waveout.cs，经 PowerShell）。
//     dshow 只列 capture，播放端点得走 waveOut；这也是播放测试音实际用的 API。
//   · 系统音频端点状态 —— Get-PnpDevice -Class AudioEndpoint，只用来展示
//     设备在/掉线（Error 状态），不用于选择设备。
//
// ⚠️ 待验证（Phase 1 实测）：waveOut 设备名与 dshow 设备名、QQ 设置页里的
// 设备名是否对得上；虚拟声卡装好后三边枚举是否都可见。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const NATIVE_DIR = path.dirname(fileURLToPath(import.meta.url)) ; // src/voice-call
const WAVEOUT_PS1 = path.join(NATIVE_DIR, 'native', 'waveout.ps1');

function runCapture(cmd, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '', err = '';
    let child;
    try {
      child = spawn(cmd, args, { windowsHide: true, shell: /(\.cmd|\.bat)$/i.test(cmd) });
    } catch (e) {
      resolve({ code: -1, stdout: '', stderr: String(e?.message ?? e) });
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { err += d; });
    child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, stdout: out, stderr: `${err}\n${e.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout: out, stderr: err }); });
  });
}

/**
 * 列举可用的录音设备（ffmpeg dshow 口径）。
 * 返回 [{ name }]；失败抛错（错误文案可读）。
 */
export async function listCaptureDevices({ ffmpegCmd = 'ffmpeg' } = {}) {
  const r = await runCapture(ffmpegCmd, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], 15000);
  if (!r.stderr && !r.stdout) throw new Error(`无法运行 ffmpeg（${ffmpegCmd}）：确认已安装并在 PATH 中`);
  const devices = parseDshowDevices(r.stderr + r.stdout);
  return devices;
}

/** 解析 ffmpeg -list_devices 的 stderr：`[in#x @ ..] "设备名" (audio)` 行。 */
export function parseDshowDevices(text) {
  const devices = [];
  const re = /\[in#\d+ @ [^\]]+\] "([^"]+)" \(audio\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1].trim();
    if (name && !devices.some((d) => d.name === name)) devices.push({ name });
  }
  return devices;
}

/**
 * 列举播放设备（winmm waveOut 口径）。
 * 返回 [{ index, name }]；index 直接用于播放（WAVE_MAPPER=-1 为系统默认）。
 */
export async function listPlaybackDevices({ psScript = WAVEOUT_PS1, powershell = 'powershell.exe' } = {}) {
  const r = await runCapture(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript, '-Action', 'list'], 20000);
  if (r.code !== 0) throw new Error(`waveOut 枚举失败（exit ${r.code}）：${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  return parseWaveOutList(r.stdout);
}

/** 解析 waveout.ps1 的 `index|name` 行。 */
export function parseWaveOutList(text) {
  const devices = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = /^(\d+)\|(.+)$/.exec(line.trim());
    if (m) devices.push({ index: Number(m[1]), name: m[2].trim() });
  }
  return devices;
}

/**
 * 列举活跃的播放端点（MMDevice 口径，全名不截断）——
 * 这是回环捕获（loopback）的目标列表，名字与 QQ 通话设置里显示的一致。
 */
export async function listRenderEndpoints({ psScript = WAVEOUT_PS1, powershell = 'powershell.exe' } = {}) {
  const r = await runCapture(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript, '-Action', 'endpoints'], 20000);
  if (r.code !== 0) throw new Error(`播放端点枚举失败（exit ${r.code}）：${(r.stderr || r.stdout || '').trim().slice(0, 300)}`);
  return parseRenderEndpoints(r.stdout);
}

/** 解析 waveout.ps1 endpoints 的逐行端点名。 */
export function parseRenderEndpoints(text) {
  return String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((name) => ({ name }));
}

/**
 * 系统音频端点连接状态（只展示用）。
 * 返回 [{ name, status }]，status: OK / Error / Unknown。
 */
export async function listEndpointStatus({ powershell = 'powershell.exe' } = {}) {
  const r = await runCapture(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    // PS5.1 管道输出默认走 OEM 码页（zh-CN 是 GBK），不设 UTF8 中文名会乱码
    '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; ' +
    'Get-PnpDevice -Class AudioEndpoint | Select-Object Status,FriendlyName | ConvertTo-Json -Compress'
  ], 20000);
  if (r.code !== 0 || !r.stdout.trim()) return [];
  return parseEndpointStatus(r.stdout);
}

/** 解析 Get-PnpDevice 的 JSON（单个对象时补齐为数组）。 */
export function parseEndpointStatus(jsonText) {
  let j;
  try { j = JSON.parse(jsonText); } catch { return []; }
  if (!Array.isArray(j)) j = j ? [j] : [];
  return j
    .filter((x) => x && x.FriendlyName)
    .map((x) => ({ name: String(x.FriendlyName), status: String(x.Status || 'Unknown') }));
}
