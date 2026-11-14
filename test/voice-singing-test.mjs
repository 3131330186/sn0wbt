/**
 * 本地歌声链（SVC）密闭测试 —— 假 ACE-Step 服务 + 假二进制，不碰真模型。
 *
 * 覆盖：
 *   1. 歌词解析：（唱歌）前缀剥离 / 无标签全文即歌词 / 空歌词报错
 *   2. 风格描述：style 动作标签剥除 + 配置默认拼接
 *   3. 全链路：health → release_task → 轮询(0→1) → 下载 → demucs → RVC → ffmpeg
 *      （run/fetch/sleep 全注入假件；断言 RVC 选了最高轮次模型、请求体形状）
 *   4. 失败面：服务没开 / 出歌失败(status=2) / 结果无音频
 *   5. tts.js 路由：singing.enabled=true 时（唱歌）走链 —— **没配 TTS 服务商也能唱**
 *      （链在 ep 解析之前，这是接线的关键行为）
 *
 * 回归面：singing.enabled=false（分发默认）时走旧路径，由 speech-test / speech-adapters-test 钉。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';

// ── 隔离数据目录（必须在 import config 之前设）──
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-singing-test-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.mkdirSync(path.join(dataDir, 'messages'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({ speech: {} }), 'utf8');

// ── 假工具箱目录（满足 singSong 的同步预检）──
const toolkit = fs.mkdtempSync(path.join(os.tmpdir(), 'singing-toolkit-'));
const mk = (p) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); };
mk(path.join(toolkit, 'venv', 'Scripts', 'demucs.exe'));
mk(path.join(toolkit, 'Applio', 'ffmpeg.exe'));
mk(path.join(toolkit, 'Applio', 'env', 'python.exe'));
const logDir = path.join(toolkit, 'Applio', 'logs', 'testmodel');
mk(path.join(logDir, 'testmodel_100e_5500s.pth'));
mk(path.join(logDir, 'testmodel_300e_16500s.pth'));   // 最高轮次应被选中
mk(path.join(logDir, 'testmodel.index'));

// ── 假 ACE-Step 服务 ──
const srvState = { releaseBodies: [], pollCount: 0, mode: 'ok' };
const srv = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (d) => chunks.push(d));
  req.on('end', () => {
    if (req.url === '/health') { res.writeHead(200); return res.end('{"data":{"status":"ok"}}'); }
    if (req.url === '/release_task') {
      srvState.releaseBodies.push(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ data: { task_id: 't-1', status: 'queued' } }));
    }
    if (req.url === '/query_result') {
      srvState.pollCount++;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (srvState.mode === 'fail') {
        return res.end(JSON.stringify({ data: [{ task_id: 't-1', status: 2, progress_text: 'GPU 爆了' }] }));
      }
      if (srvState.mode === 'no-audio') {
        return res.end(JSON.stringify({ data: [{ task_id: 't-1', status: 1, result: '[]' }] }));
      }
      // 首轮 running（status 0），次轮成功（status 1）—— 钉死 STATUS_MAP 语义
      if (srvState.pollCount === 1) {
        return res.end(JSON.stringify({ data: [{ task_id: 't-1', status: 0, progress_text: 'Generating…' }] }));
      }
      return res.end(JSON.stringify({
        data: [{ task_id: 't-1', status: 1, result: JSON.stringify([{ file: '/v1/audio?path=x.mp3' }]) }]
      }));
    }
    if (req.url === '/v1/audio?path=x.mp3') {
      res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
      return res.end(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(4096, 7)]));   // >1000 字节、非 JSON
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${srv.address().port}`;

// ── 注入依赖 ──
const { singingDeps, parseLyrics, tagLyrics, buildPrompt, singSong, getSingingEngine, SINGING_ENGINES } = await import('../src/speech/singing.js');
const { rvcDeps } = await import('../src/speech/rvc.js');
const runCalls = [];
let demucsCalls = 0;
let demucsAmpFn = null;   // (callNo) => 0~1 干声幅度；null=恒 0.5（人声合格）
// 最小合法 16-bit PCM 单声道 WAV，所有采样值 = amp —— 供人声体检用
function makeWav(amp) {
  const n = 4410;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(44100, 24); buf.writeUInt32LE(88200, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  const s = Math.round(amp * 32767);
  for (let i = 0; i < n; i++) buf.writeInt16LE(s, 44 + i * 2);
  return buf;
}
const realRun = singingDeps.run;
const realFetch = singingDeps.fetch;
const realSleep = singingDeps.sleep;
singingDeps.sleep = () => Promise.resolve();
singingDeps.fetch = (url, opts) => realFetch(url, opts);   // 直连本地假服（不经代理）
singingDeps.run = async (cmd, args, opts = {}) => {
  runCalls.push({ cmd, args, opts });
  const joined = args.join(' ');
  if (cmd.includes('nvidia-smi')) {
    return { ok: true, code: 0, stdout: '9000\n', stderr: '' };   // 空闲 9GB：预检放行
  }
  if (cmd.includes('demucs')) {
    // demucs: -o <tmp> <tmp>/song<N>.mp3 → <tmp>/htdemucs/song<N>/{vocals,no_vocals}.wav
    demucsCalls++;
    const oIdx = args.indexOf('-o');
    const outDir = args[oIdx + 1];
    const stem = path.basename(args[args.length - 1], '.mp3');
    const sub = path.join(outDir, 'htdemucs', stem);
    fs.mkdirSync(sub, { recursive: true });
    fs.writeFileSync(path.join(sub, 'vocals.wav'), makeWav(demucsAmpFn ? demucsAmpFn(demucsCalls) : 0.5));
    fs.writeFileSync(path.join(sub, 'no_vocals.wav'), makeWav(0.5));
    return { ok: true, code: 0, stdout: '', stderr: '' };
  }
  if (joined.includes('core.py') && joined.includes('infer')) {
    const out = args[args.indexOf('--output-path') + 1];
    fs.writeFileSync(out, makeWav(0.5));   // 峰值 0.5 → 清唱应补 ~2.9dB 归一
    return { ok: true, code: 0, stdout: '', stderr: '' };
  }
  if (cmd.includes('ffmpeg')) {
    fs.writeFileSync(args[args.length - 1], Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4000, 4)]));
    return { ok: true, code: 0, stdout: '', stderr: '' };
  }
  return { ok: false, code: 127, stdout: '', stderr: 'unexpected cmd: ' + cmd };
};
rvcDeps.run = singingDeps.run;   // RVC 层与歌声链共用同一套假件

const { updateConfig, getConfig } = await import('../src/config.js');
function useSinging(over = {}) {
  updateConfig({
    providers: [],              // 故意不配 TTS 服务商（顶层键）—— 验证歌声链不依赖它
    dshProviderKeys: {},
    speech: {
      providerId: '',
      singing: {
        enabled: true, acestepBase: base, toolkitDir: toolkit,
        model: 'testmodel', defaultPrompt: '中文流行歌曲', audioDuration: 45, vocalLanguage: 'zh',
        ...over
      }
    }
  });
}

let bad = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  [ok] ${label}`); }
  catch (e) { bad++; console.log(`  [FAIL] ${label} -- ${e.message}`); }
};
const checkAsync = async (label, fn) => {
  try { await fn(); console.log(`  [ok] ${label}`); }
  catch (e) { bad++; console.log(`  [FAIL] ${label} -- ${e.message}`); }
};

console.log('\n== 歌词/风格解析 ==');

check('（唱歌）前缀剥离 → 歌词', () => {
  assert.equal(parseLyrics('（唱歌）两只老虎跑得快'), '两只老虎跑得快');
  assert.equal(parseLyrics('(sing) hello world'), 'hello world');
});
check('无标签 → 全文即歌词（style 含"唱"触发的场景）', () => {
  assert.equal(parseLyrics('床前明月光'), '床前明月光');
});
check('空歌词 → 可读报错', () => {
  assert.throws(() => parseLyrics('（唱歌）   '), /没有歌词/);
});
check('buildPrompt：style 剥动作标签拼默认；空 style 用默认（默认必须点名人声）', () => {
  const cfg = { speech: { singing: { defaultPrompt: '流行歌曲' } } };
  assert.equal(buildPrompt('深情地（唱）', cfg), '深情地，流行歌曲');
  assert.equal(buildPrompt('', cfg), '流行歌曲');
  assert.equal(buildPrompt(null, {}), '中文流行歌曲，人声演唱，人声清晰，旋律清晰，节奏明快');
});
check('tagLyrics：裸歌词垫 [verse]；已有结构标签不碰', () => {
  assert.equal(tagLyrics('两只老虎跑得快'), '[verse]\n两只老虎跑得快');
  assert.equal(tagLyrics('[chorus]\n两只老虎跑得快'), '[chorus]\n两只老虎跑得快');
  assert.equal(tagLyrics(''), '');
});
check('引擎适配器：默认/未知引擎回落 ace-step（换方案 = 注册表加键 + config.engine）', () => {
  assert.equal(getSingingEngine({}), SINGING_ENGINES['ace-step']);
  assert.equal(getSingingEngine({ speech: { singing: { engine: 'nope' } } }), SINGING_ENGINES['ace-step']);
  assert.equal(typeof SINGING_ENGINES['ace-step'].generate, 'function');
  assert.equal(typeof SINGING_ENGINES['ace-step'].probe, 'function');
});

console.log('\n== 全链路（假服务 + 假二进制）==');

await checkAsync('端到端：出歌→分离→转写→混音，返回形状正确', async () => {
  useSinging();
  srvState.mode = 'ok'; srvState.pollCount = 0; srvState.releaseBodies = []; runCalls.length = 0;
  demucsCalls = 0; demucsAmpFn = null;
  const r = await singSong({ text: '（唱歌）湖边清晨微风吹', style: '深情地', cfg: getConfig() });
  assert.ok(Buffer.isBuffer(r.wav) && r.wav.slice(0, 4).toString('ascii') === 'RIFF', '输出 RIFF');
  assert.equal(r.singing, true);
  assert.equal(r.forcedPreset, false, '歌声链用克隆音色，不是预置兜底');
  assert.equal(r.mode, 'clone');
  assert.equal(r.voice, '克隆歌声');
  // 请求体形状（真机契约）
  const body = srvState.releaseBodies[0];
  assert.equal(body.lyrics, '[verse]\n湖边清晨微风吹', '裸歌词应被垫上 [verse] 结构标签');
  assert.equal(body.prompt, '深情地，中文流行歌曲');
  assert.equal(body.vocal_language, 'zh');
  assert.equal(body.audio_duration, 45);
  assert.equal(body.inference_steps, 27, '8 步 turbo 不唱词（ASR 实证），默认必须 27');
  assert.equal(body.batch_size, 1, '只生成 1 个候选（我们只取第一个，双倍显存纯浪费）');
  // 轮询走了两轮（0 → 1）
  assert.equal(srvState.pollCount, 2, '首询 running、次询成功');
  // RVC 选了最高轮次模型（300e > 100e）
  const rvc = runCalls.find((c) => c.args.join(' ').includes('core.py'));
  assert.ok(rvc, '应调用 Applio infer');
  assert.ok(rvc.args[rvc.args.indexOf('--pth-path') + 1].endsWith('testmodel_300e_16500s.pth'),
    '应选最高轮次 300e，实际 ' + rvc.args[rvc.args.indexOf('--pth-path') + 1]);
  assert.equal(rvc.args[rvc.args.indexOf('--export-format') + 1], 'WAV', 'export-format 必须大写（实踩）');
  assert.equal(rvc.opts.cwd.includes('Applio'), true, 'RVC 要在 Applio 目录跑');
  // ffmpeg 出口：默认清唱 —— 峰值归一 + 重采样 44100，但不准混伴奏（amix）
  const ffm = runCalls.find((c) => c.cmd.includes('ffmpeg'));
  assert.ok(ffm, '应调用 ffmpeg 出成品');
  assert.ok(!ffm.args.join(' ').includes('amix'), '默认清唱不得混伴奏');
  assert.equal(ffm.args[ffm.args.indexOf('-ar') + 1], '44100', '出口重采样 44100');
  const af = ffm.args[ffm.args.indexOf('-af') + 1] || '';
  assert.ok(af.includes('afftdn=nr=12:nf=-25') && af.includes('volume=2.9dB'),
    '清唱应 FFT 降噪 + 峰值归一（电流音根治，用户裁决 D 版），实际 -af: ' + af);
});

await checkAsync('accompaniment:true → ffmpeg 走 amix 混回伴奏', async () => {
  useSinging({ accompaniment: true });
  srvState.mode = 'ok'; srvState.pollCount = 0; runCalls.length = 0;
  demucsCalls = 0; demucsAmpFn = null;
  await singSong({ text: '（唱歌）湖边清晨微风吹', style: '', cfg: getConfig() });
  // 第一个 ffmpeg 是 rvcConvert 的出口（降噪归一），混音的是第二个
  const mixCall = runCalls.find((c) => c.cmd.includes('ffmpeg') && c.args.join(' ').includes('amix'));
  assert.ok(mixCall, '开伴奏才混音（amix）');
});

await checkAsync('显存不足 → 秒级报错，不建任务不白等 5 分钟', async () => {
  useSinging();
  srvState.mode = 'ok'; srvState.pollCount = 0; srvState.releaseBodies = []; runCalls.length = 0;
  demucsCalls = 0; demucsAmpFn = null;
  const real = singingDeps.run;
  singingDeps.run = async (cmd, args, opts) => cmd.includes('nvidia-smi')
    ? { ok: true, code: 0, stdout: '390\n', stderr: '' }   // 复刻实踩：只剩 390MB
    : real(cmd, args, opts);
  try {
    await assert.rejects(() => singSong({ text: '（唱歌）词', cfg: getConfig() }), /显存不足/);
    assert.equal(srvState.releaseBodies.length, 0, '预检挡下，不应建出歌任务');
  } finally { singingDeps.run = real; }
});

await checkAsync('纯器乐 take → 自动重抽一次拿到人声', async () => {
  useSinging();
  srvState.mode = 'ok'; srvState.pollCount = 0; srvState.releaseBodies = []; runCalls.length = 0;
  demucsCalls = 0; demucsAmpFn = (n) => (n === 1 ? 0.01 : 0.5);   // 第一抽哑、第二抽好
  const r = await singSong({ text: '（唱歌）湖边清晨微风吹', style: '', cfg: getConfig() });
  assert.ok(Buffer.isBuffer(r.wav) && r.wav.slice(0, 4).toString('ascii') === 'RIFF');
  assert.equal(srvState.releaseBodies.length, 2, '应建两次出歌任务');
});

await checkAsync('两抽都纯器乐 → 可读报错（共两次任务，不多抽）', async () => {
  useSinging();
  srvState.mode = 'ok'; srvState.pollCount = 0; srvState.releaseBodies = []; runCalls.length = 0;
  demucsCalls = 0; demucsAmpFn = () => 0.01;
  await assert.rejects(() => singSong({ text: '（唱歌）词', cfg: getConfig() }), /纯器乐/);
  assert.equal(srvState.releaseBodies.length, 2, '恰好重抽一次');
});

await checkAsync('tts.js 路由：没配 TTS 服务商也能（唱歌）→ 走链', async () => {
  useSinging();
  srvState.mode = 'ok'; srvState.pollCount = 0;
  demucsCalls = 0; demucsAmpFn = null;
  const { synthesize } = await import('../src/speech/tts.js');
  const r = await synthesize({ text: '（唱歌）床前明月光' });   // config 无 provider → 旧路径会在此前报错
  assert.equal(r.singing, true);
  assert.equal(r.mode, 'clone');
});

await checkAsync('服务没开 → 可读报错（指名 start-voice-services）', async () => {
  useSinging({ acestepBase: 'http://127.0.0.1:1' });   // 必然连不上的端口
  const { synthesize } = await import('../src/speech/tts.js');
  await assert.rejects(() => synthesize({ text: '（唱歌）词' }), /ACE-Step 服务没开|start-voice-services/);
});

await checkAsync('出歌失败（status=2）→ 透出 progress_text', async () => {
  useSinging();
  srvState.mode = 'fail'; srvState.pollCount = 0;
  await assert.rejects(() => singSong({ text: '（唱歌）词', cfg: getConfig() }), /GPU 爆了/);
});

await checkAsync('成功但无音频（result 空）→ 报错不静默', async () => {
  useSinging();
  srvState.mode = 'no-audio'; srvState.pollCount = 0;
  await assert.rejects(() => singSong({ text: '（唱歌）词', cfg: getConfig() }), /没有音频/);
});

await checkAsync('singing.enabled=false（分发默认）→ tts 不走链（旧路径接管）', async () => {
  updateConfig({ speech: { singing: { enabled: false } } });
  const { synthesize } = await import('../src/speech/tts.js');
  // 无 TTS 服务商 → 旧路径在 ep 解析处报错（证明没走链）
  await assert.rejects(() => synthesize({ text: '（唱歌）词' }), /TTS 服务商/);
});

// ── 收尾 ──
srv.close();
singingDeps.run = realRun;
singingDeps.fetch = realFetch;
singingDeps.sleep = realSleep;
fs.rmSync(dataDir, { recursive: true, force: true });
fs.rmSync(toolkit, { recursive: true, force: true });

if (bad) { console.log(`\n${bad} 项失败`); process.exit(1); }
console.log('\n全部通过');
