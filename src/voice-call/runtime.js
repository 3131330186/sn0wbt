// 语音通话 · 服务端运行时（会话单例 + 最近轮次环形缓冲）。
//
// 会话住在服务进程里（server.js / electron 主进程），控制台路由通过
// getVoiceCallSession() 拿同一个实例。配置（loopbackDevice 等）改动后
// 调 resetVoiceCallSession() 重建，下次 start() 用新配置。
// recentTurns 供状态轮询展示最近对话（cap 20，含耗时），不落盘。

import { VoiceCallSession } from './session.js';
import { makeToneWav, startWavPlayback } from './bridge.js';
import { listPlaybackDevices } from './audio-devices.js';
import { createAutoAnswerWatcher, calluiProbe } from './auto-answer.js';
import { loadConfig } from '../config.js';

const recentTurns = [];
let session = null;
let watcher = null;

export function getVoiceCallSession() {
  if (!session) {
    const cfg = loadConfig();
    session = new VoiceCallSession({ cfg: { ...(cfg.voiceCall || {}) } });
    session.on('turn', (t) => {
      recentTurns.push({ ...t, at: Date.now() });
      if (recentTurns.length > 20) recentTurns.shift();
    });
    ensureAutoAnswerWatcher();
  }
  return session;
}

/** 自动接听听门狗（会话单例创建时启动；每 tick 现读配置，开关即时生效）。 */
function ensureAutoAnswerWatcher() {
  if (watcher) return;
  watcher = createAutoAnswerWatcher({
    probe: () => calluiProbe('detect'),
    answer: () => calluiProbe('answer'),
    getConfig: () => loadConfig(),
    getSession: () => session,
    log: (msg) => { try { console.log(msg); } catch { /* ignore */ } }
  });
  watcher.start(2000);
}

/**
 * 控制台自检：向发送通道 A（CABLE Input）播 2 秒 440Hz 测试音。
 * 通话里点了它、手机听到"嘟——"= 通道 A 全链路正常。
 * 独立于会话（通话没开始也能测）。
 */
export async function playCallTestTone() {
  const cfg = loadConfig();
  const match = String(cfg.voiceCall?.sendDeviceMatch || 'CABLE Input');
  const devices = await listPlaybackDevices();
  const hit = devices.find((d) => d.name.startsWith(match) && !/16ch/i.test(d.name));
  if (!hit) return { ok: false, error: `未找到发送设备（${match}）——确认 VB-Cable 已安装` };
  const pr = await startWavPlayback({ wav: makeToneWav({ seconds: 2, freq: 440, rate: 24000, amp: 0.3 }), deviceId: hit.index }).done;
  return pr.ok ? { ok: true, device: hit.name } : { ok: false, error: `播放失败：${pr.reason}` };
}

export function recentVoiceTurns() {
  return recentTurns.slice();
}

export function resetVoiceCallSession() {
  const old = session;
  session = null;
  try { old?.stop('配置变更'); } catch { /* ignore */ }
  recentTurns.length = 0;
  // watcher 保留（getConfig 每 tick 现读，配置变更自然生效）
}
