// 语音通话 · CLI 跑通器（Phase 2 真机验证入口，不走 OneBot/SnowLuma）。
//
// 用法：npm run call
//   前置（人工）：手机拨给 bot QQ → PC 点「接听」→ 通话里
//     麦克风 = CABLE Output (VB-Audio Virtual Cable)
//     扬声器 = 闲置的 Realtek 扬声器（别勾电缆，防回声）
//   然后这里按 s 开始对话，对手机说话即可；x 挂断；q 退出。
//
// 接收设备解析链：config.voiceCall.loopbackDevice → probe.json 的选择 →
// 自动匹配含 Realtek 的播放端点 → 都没有则报错指导。
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DATA_DIR, loadConfig } from '../src/config.js';
import { listRenderEndpoints } from '../src/voice-call/audio-devices.js';
import { VoiceCallSession } from '../src/voice-call/session.js';

const probeCfgFile = path.join(DATA_DIR, 'voice-call', 'probe.json');
const readProbeCfg = () => { try { return JSON.parse(fs.readFileSync(probeCfgFile, 'utf8')); } catch { return {}; } };

async function resolveLoopbackDevice(cfg) {
  const explicit = String(cfg.voiceCall?.loopbackDevice || '').trim();
  if (explicit) return explicit;
  const probed = String(readProbeCfg().loopbackDevice || '').trim();
  if (probed) return probed;
  const eps = await listRenderEndpoints();
  const guess = eps.find((e) => /Realtek/i.test(e.name) && !/CABLE/i.test(e.name));
  return guess ? guess.name : '';
}

const cfg = loadConfig();
const loopbackDevice = await resolveLoopbackDevice(cfg);
console.log('════ QQ Agent 语音通话 · CLI 跑通器 ════');
console.log(`接收B(loopback): ${loopbackDevice || '✗ 未找到——去探针里 bl 选一次或写 config.voiceCall.loopbackDevice'}`);
if (!loopbackDevice) process.exit(1);

const session = new VoiceCallSession({
  cfg: { ...cfg.voiceCall, loopbackDevice }
});

const fmtMs = (ms) => (ms == null ? '-' : `${ms}ms`);
session.on('state', (s, d) => {
  const extra = d?.reason ? `（${d.reason}）` : '';
  console.log(`\n[状态] ${s}${extra}`);
});
session.on('turn', (t) => {
  if (t.kind === 'user') console.log(`\n👂 你（断句 ${t.durationMs}ms，ASR ${fmtMs(t.timings?.asrMs)}）：${t.text}`);
  else if (t.kind === 'reply') console.log(`💭 尼斯湖王子（LLM ${fmtMs(t.timings?.llmMs)}）：${t.text}`);
  else if (t.kind === 'done') console.log(`🔊 已播出（TTS ${fmtMs(t.timings?.ttsMs)}）${t.playbackOk ? '' : ' ⚠ 播放异常: ' + t.playbackReason}`);
  else if (t.kind === 'asr_failed') console.log(`[!] 这段没识别出来（${t.reason}），继续说就行`);
  else if (t.kind === 'dropped') console.log(`[i] 机器人说话期间你开口了——v1 半双工会等它说完（丢弃 ${t.durationMs}ms）`);
  else if (t.kind === 'error') console.log(`[✗] 这轮失败：${t.message}`);
});
session.on('device_error', ({ reason }) => console.log(`\n[✗] 设备异常：${reason}\n    通话已停止。检查设备后按 s 重新开始。`));

const AUTO = process.argv.includes('--auto');

let rl = null;
if (!AUTO) {
  rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.setPrompt('call> ');
  rl.on('line', (line) => {
    const c = line.trim().toLowerCase();
    (async () => {
      if (c === 's') {
        try { const r = await session.start(); console.log(`[✓] 通话开始（callId=${r.callId}，发送A=[${r.sendDevice.index}] ${r.sendDevice.name}）——对手机说话吧`); }
        catch (e) { console.log(`[✗] 开始失败：${e.message}`); }
      } else if (c === 'x') {
        await session.stop('手动挂断');
        console.log('[✓] 已挂断');
      } else if (c === 'q') {
        await session.stop('退出');
        rl.close();
        return;
      } else if (c === 'help') {
        console.log('命令：s=开始/重开对话  x=挂断  q=退出');
      } else if (c) {
        console.log('[?] s / x / q');
      }
      rl.prompt();
    })().catch((e) => { console.log(`[✗] ${e.message}`); rl.prompt(); });
  });
  rl.on('close', () => { console.log('退出。'); process.exit(0); });
}

// 进程被杀（Ctrl-C / 任务管理器结束）也必须干净收尾——不留残余采集/播放进程
async function gracefulExit(signal) {
  console.log(`\n收到 ${signal}，挂断并清理…`);
  try { await session.stop(signal); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', () => gracefulExit('SIGINT'));
process.on('SIGTERM', () => gracefulExit('SIGTERM'));

if (AUTO) {
  console.log('（--auto 模式：自动开始，Ctrl-C / kill 挂断退出）');
  session.on('state', (s) => {
    if (s === 'error') setTimeout(() => process.exit(2), 200);   // 让日志先落盘
  });
  (async () => {
    try {
      const r = await session.start();
      console.log(`[✓] 自动开始（callId=${r.callId}，发送A=[${r.sendDevice.index}] ${r.sendDevice.name}）——对手机说话吧`);
    } catch (e) {
      console.log(`[✗] 自动开始失败：${e.message}`);
      process.exit(1);
    }
  })();
} else {
  console.log('命令：s=开始  x=挂断  q=退出（先拨电话并手动接听！）');
  rl.prompt();
}
