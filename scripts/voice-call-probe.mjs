// 语音通话 · 音频探针（交互式 CLI）。
//
// 目的：在接模型之前，先用人耳+真电话验证两路音频链路：
//   发送 A：本探针播放测试音 → CABLE Input → QQ 麦克风(=CABLE Output) → 手机听到
//           【Phase 1a 已真机验证 ✓】
//   接收 B：手机说话 → QQ 扬声器(=闲置 Realtek) → WASAPI 回环捕获 → 电平/存盘 → ASR
//
// 用法：npm run probe
//   list        列出录音设备(dshow) / 播放设备(waveOut) / 播放端点(回环用)
//   a <序号>     选发送设备（waveOut 序号，存 probe.json）
//   b <序号>     选接收=电缆录音设备（dshow 口径）
//   bl <序号>    选接收=回环捕获的播放端点（推荐：闲置的 Realtek 扬声器）
//   tone        向发送设备 A 播 2 秒测试音
//   rec         开始/停止接收采集（实时电平；停止后存 WAV 到 probe-captures/）
//   asr         把最近一段录音送 MiMo ASR，打印转写文本（全链路冒烟）
//   stop        一键停止当前录音/播放
//   status      设备连接状态（PnP 端点）+ 采集状态
//   q           退出
//
// 设备丢失时本探针停止并报告原因，绝不静默切到别的设备。
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { DATA_DIR, loadConfig } from '../src/config.js';
import { resolveSpeechEndpoint } from '../src/speech/tts.js';
import { listCaptureDevices, listPlaybackDevices, listEndpointStatus, listRenderEndpoints } from '../src/voice-call/audio-devices.js';
import { Receiver, makeToneWav, pcmToWav, playWavToDevice } from '../src/voice-call/bridge.js';

const probeDir = path.join(DATA_DIR, 'voice-call');
const cfgFile = path.join(probeDir, 'probe.json');
const captureDir = path.join(probeDir, 'probe-captures');
fs.mkdirSync(captureDir, { recursive: true });

const loadCfg = () => { try { return JSON.parse(fs.readFileSync(cfgFile, 'utf8')); } catch { return {}; } };
const saveCfg = (c) => { fs.mkdirSync(probeDir, { recursive: true }); fs.writeFileSync(cfgFile, JSON.stringify(c, null, 2), 'utf8'); };

const state = {
  cfg: loadCfg(),                    // { captureDevice, loopbackDevice, playbackIndex, playbackName, receiveMode }
  captureDevices: [],
  playbackDevices: [],
  renderEndpoints: [],
  lastCaptureFile: null,
  receiver: null,
  recording: false,
  recPcm: [],
  recStart: 0,
  lastLevelLine: ''
};

const receiveMode = () => state.cfg.receiveMode === 'dshow' ? 'dshow' : 'loopback';   // 缺省回环（通道 B 正解）
const receiveTarget = () => receiveMode() === 'dshow' ? state.cfg.captureDevice : state.cfg.loopbackDevice;

const log = (...a) => { clearLevel(); console.log(...a); };
function clearLevel() {
  if (state.lastLevelLine) { process.stdout.write('\r' + ' '.repeat(state.lastLevelLine.length) + '\r'); state.lastLevelLine = ''; }
}

function levelBar(db) {
  const clamped = Math.max(-60, Math.min(0, db));
  const filled = Math.round(((clamped + 60) / 60) * 24);
  return '█'.repeat(filled) + '░'.repeat(24 - filled);
}

async function refreshDevices() {
  try { state.captureDevices = await listCaptureDevices(); }
  catch (e) { log(`[!] 录音设备枚举失败：${e.message}`); state.captureDevices = []; }
  try { state.playbackDevices = await listPlaybackDevices(); }
  catch (e) { log(`[!] 播放设备枚举失败：${e.message}`); state.playbackDevices = []; }
  try { state.renderEndpoints = await listRenderEndpoints(); }
  catch (e) { log(`[!] 播放端点枚举失败：${e.message}`); state.renderEndpoints = []; }
}

function printDevices() {
  console.log('\n── 播放设备（waveOut 口径，发送通道 A 用）──');
  state.playbackDevices.forEach((d) => {
    const mark = d.index === state.cfg.playbackIndex ? '  ← 当前A' : '';
    console.log(`  [${d.index}] ${d.name}${mark}`);
  });
  if (!state.playbackDevices.length) console.log('  （空）');
  console.log('── 播放端点（回环捕获用，接收通道 B 推荐）──');
  state.renderEndpoints.forEach((d, i) => {
    const mark = receiveMode() === 'loopback' && d.name === state.cfg.loopbackDevice ? '  ← 当前B' : '';
    console.log(`  [${i}] ${d.name}${mark}`);
  });
  if (!state.renderEndpoints.length) console.log('  （空）');
  console.log('── 录音设备（dshow 口径，电缆录音端）──');
  state.captureDevices.forEach((d, i) => {
    const mark = receiveMode() === 'dshow' && d.name === state.cfg.captureDevice ? '  ← 当前B' : '';
    console.log(`  [${i}] ${d.name}${mark}`);
  });
  if (!state.captureDevices.length) console.log('  （空）');
}

function startRec() {
  const target = receiveTarget();
  if (!target) { log(`[!] 先用 ${receiveMode() === 'dshow' ? 'b' : 'bl'} <序号> 选接收目标`); return; }
  if (state.recording) { log('[!] 已在录音'); return; }
  state.recPcm = [];
  state.recStart = Date.now();
  const r = new Receiver({
    mode: receiveMode(),
    deviceName: target,
    onChunk: (buf) => { if (state.recording) state.recPcm.push(buf); }
  });
  r.on('level', ({ db }) => {
    if (!state.recording) return;
    const line = `[REC] ${String(db).padStart(6)} dB  ${levelBar(db)}`;
    process.stdout.write(`\r${line}`);
    state.lastLevelLine = line;
  });
  // 设备丢失：立即停止并报告原因，绝不静默切换（评审纪律）
  r.on('error', ({ reason }) => {
    if (!state.recording) return;
    state.recording = false;
    clearLevel();
    log(`\n[✗] 接收通道失败：${reason}`);
    log('    （已停止，未自动切换设备。检查设备后重新 rec）');
  });
  r.on('exit', ({ reason }) => {
    if (state.recording && reason) { state.recording = false; clearLevel(); log(`\n[✗] 接收通道退出：${reason}`); }
  });
  try {
    r.start();
    state.receiver = r;
    state.recording = true;
    log(`[●] 开始采集「${state.cfg.captureDevice}」—— 现在用手机说话，观察电平。再按 rec 停止并存盘。`);
  } catch (e) {
    log(`[✗] 采集启动失败：${e.message}`);
  }
}

function stopRec() {
  if (!state.recording || !state.receiver) { log('[!] 当前没有在录音'); return; }
  const r = state.receiver;
  state.recording = false;
  const stats = r.stop();
  clearLevel();
  const dur = ((Date.now() - state.recStart) / 1000).toFixed(1);
  if (state.recPcm.length === 0) {
    log(`[!] 本次未收到任何 PCM（${dur}s）—— 设备没通。`);
    return;
  }
  const pcm = Buffer.concat(state.recPcm);
  state.recPcm = [];
  const file = path.join(captureDir, `capture-${new Date().toISOString().replace(/[:.]/g, '-')}.wav`);
  fs.writeFileSync(file, pcmToWav(pcm, 16000, 1));
  state.lastCaptureFile = file;
  log(`[■] 采集结束：${dur}s / ${(stats.bytes / 1024).toFixed(0)}KB → ${file}`);
  log('    （探针显式录制才保存；默认不保存任何录音。asr 命令可直接转写最近一段）');
}

/** 把最近一段录音送 MiMo ASR（通道 B 全链路冒烟：说话 → 回环捕获 → 文本）。 */
async function asrLast() {
  if (!state.lastCaptureFile || !fs.existsSync(state.lastCaptureFile)) { log('[!] 没有可转写的录音，先 rec 一段'); return; }
  const cfg = loadConfig();
  const ep = resolveSpeechEndpoint(cfg);
  if (!ep) { log('[!] 没有可用的语音服务商端点（检查外联/语音页配置）'); return; }
  const b64 = fs.readFileSync(state.lastCaptureFile).toString('base64');
  log(`[⏳] ASR 识别中：${path.basename(state.lastCaptureFile)}`);
  try {
    const r = await fetch(ep.baseUrl.replace(/\/+$/, '') + '/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${ep.apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: 'mimo-v2.5-asr',
        messages: [{ role: 'user', content: [{ type: 'input_audio', input_audio: { data: b64, format: 'wav' } }] }]
      }),
      signal: AbortSignal.timeout(60000)
    });
    if (!r.ok) { log(`[✗] ASR HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`); return; }
    const j = await r.json();
    log(`[📝] ${String(j?.choices?.[0]?.message?.content ?? '').trim() || '（空结果）'}`);
  } catch (e) {
    log(`[✗] ASR 失败：${e.message}`);
  }
}

async function playTone() {
  const idx = Number.isInteger(state.cfg.playbackIndex) ? state.cfg.playbackIndex : -1;
  const name = state.cfg.playbackName || '系统默认';
  const wav = makeToneWav({ seconds: 2, freq: 440, rate: 24000, amp: 0.3 });
  const file = path.join(probeDir, 'tone-440.wav');
  fs.writeFileSync(file, wav);
  log(`[♪] 向播放设备[${idx}]「${name}」播 2 秒 440Hz…（如果这是虚拟端点A+QQ在通话中，手机端应能听到）`);
  try {
    await playWavToDevice({ wavPath: file, deviceId: idx });
    log('[♪] 播放完成');
  } catch (e) {
    log(`[✗] ${e.message}`);
  }
}

async function showStatus() {
  const eps = await listEndpointStatus();
  console.log('\n── 音频端点状态（PnP）──');
  for (const e of eps) console.log(`  [${e.status}] ${e.name}`);
  console.log(`\n  接收B(${receiveMode()}): ${receiveTarget() || '未选'}   发送A: ${state.cfg.playbackName || '系统默认'}`);
  console.log(`  采集: ${state.recording ? '进行中' : '停止'}`);
  assert.ok(true);
}

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
rl.setPrompt('probe> ');
rl.on('line', (line) => {
  const cmd = line.trim();
  (async () => {
    if (!cmd) { /* ignore */ }
    else if (cmd === 'list') { await refreshDevices(); printDevices(); }
    else if (/^b\s+\d+$/i.test(cmd)) {
      const i = Number(cmd.split(/\s+/)[1]);
      const d = state.captureDevices[i];
      if (!d) { log('[!] 序号无效，先 list'); }
      else { state.cfg.receiveMode = 'dshow'; state.cfg.captureDevice = d.name; saveCfg(state.cfg); log(`[✓] 接收B(dshow) = 「${d.name}」`); }
    }
    else if (/^bl\s+\d+$/i.test(cmd)) {
      const i = Number(cmd.split(/\s+/)[1]);
      const d = state.renderEndpoints[i];
      if (!d) { log('[!] 序号无效，先 list'); }
      else { state.cfg.receiveMode = 'loopback'; state.cfg.loopbackDevice = d.name; saveCfg(state.cfg); log(`[✓] 接收B(loopback) = 「${d.name}」`); }
    }
    else if (/^a\s+\d+$/i.test(cmd)) {
      const i = Number(cmd.split(/\s+/)[1]);
      const d = state.playbackDevices.find((x) => x.index === i);
      if (!d) { log('[!] 序号无效，先 list'); }
      else { state.cfg.playbackIndex = d.index; state.cfg.playbackName = d.name; saveCfg(state.cfg); log(`[✓] 发送A = [${d.index}]「${d.name}」`); }
    }
    else if (cmd === 'tone') await playTone();
    else if (cmd === 'rec') { state.recording ? stopRec() : startRec(); }
    else if (cmd === 'asr') await asrLast();
    else if (cmd === 'stop') { if (state.recording) stopRec(); else log('[!] 当前没有在录音'); }
    else if (cmd === 'status') await showStatus();
    else if (cmd === 'q' || cmd === 'quit' || cmd === 'exit') {
      if (state.recording) { state.recording = false; state.receiver?.stop(); }
      rl.close();
      return;
    }
    else if (cmd === 'help') console.log('命令：list / a <n> / b <n> / bl <n> / tone / rec / asr / stop / status / q');
    else log('[?] 未知命令，help 查看命令');
    rl.prompt();
  })().catch((e) => { log(`[✗] ${e.message}`); rl.prompt(); });
});
rl.on('close', () => { console.log('\n探针退出。'); process.exit(0); });

// ---- 启动 ----
console.log('════ QQ Agent 语音通话 · 音频探针 ════');
console.log('已验证：发送A 全链路（1a）；待验证：接收B 回环捕获 + ASR。');
if (receiveTarget() || Number.isInteger(state.cfg.playbackIndex)) {
  console.log(`已记住：A=${state.cfg.playbackName || '系统默认'}  B(${receiveMode()})=「${receiveTarget() || '未选'}」`);
}
console.log('命令：list / a <n> / b <n> / bl <n> / tone / rec / asr / stop / status / q\n');
await refreshDevices();
printDevices();
rl.prompt();
