/**
 * 语音功能（TTS 说 / ASR 听）的密闭测试 —— 假服务器 + 假 OneBot，不碰真 Key。
 *
 * 覆盖：
 *   1. synthesize：正常合成 / assistant+audio.voice 请求体 / 空文本与超长拒绝 /
 *      HTTP 错误透出 / 无服务商的可读报错
 *   2. send_voice 工具：开关门控（关闭=工具不可见）/ 冷却记账 / 正常发送链
 *   3. sender.sendVoice：record 段带 file:// 的 WAV（协议端视角）、留档、去重
 *   4. mimo-asr 插件：get_record→WAV→转写全链、开关关闭、get_record 失败回退
 *
 * 为什么必须这套测试：语音链路跨 4 层（TTS 客户端 → 工具 → 发送管道 → ASR 插件），
 * 每层都有"静默回退/静默拒绝"的设计（这是特性不是 bug），但正因为静默，
 * 只有测试能证明"回退发生在该回退的地方、没发生在不该发生的地方"。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

// ── 最小 WAV（RIFF 头 + 一点数据），TTS 假响应和 get_record 共用 ──
function makeWav() {
  const data = Buffer.alloc(4096, 7);   // 4KB 数据 ≈ 真实短语音的量级（readCloneRef 阈值 1KB）
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);   // PCM
  header.writeUInt16LE(1, 22);   // mono
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const WAV = makeWav();

// ── 假服务器：/v1/chat/completions 兼容 TTS 与 ASR 两种形态 ──
const state = { lastBody: null, lastUrl: null, ttsCalls: 0, asrCalls: 0 };
const server = http.createServer((req, res) => {
  state.lastUrl = req.url;
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    try {
      const j = JSON.parse(body || '{}');
      state.lastBody = j;
      if (j.model === 'mimo-v2.5-asr') {
        state.asrCalls++;
        // ASR 合同：单个 input_audio 部件、不能有 text 部件（网关注入提示词）
        const parts = j.messages?.[0]?.content || [];
        if (parts.length !== 1 || parts[0]?.type !== 'input_audio') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: { message: 'ASR requires exactly one input_audio part' } }));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ choices: [{ message: { content: '转写结果文本', role: 'assistant' } }] }));
      }
      // TTS 合同：assistant 角色 + audio.voice
      state.ttsCalls++;
      const msg = j.messages?.[0];
      if (msg?.role !== 'assistant') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'messages must contain an assistant role for TTS model' } }));
      }
      if (j.forbidden_voice || /不存在/.test(j.audio?.voice || '')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: { message: 'Unknown voice: default. Available voices: [mimo_default, 茉莉]' } }));
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: '', role: 'assistant', audio: { data: WAV.toString('base64') } } }] }));
    } catch (e) {
      res.writeHead(500); res.end(String(e));
    }
  });
});

await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

// ── 隔离环境：临时数据目录 + 指向假服务器的配置 ──
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-speech-test-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  tools: { speechVoice: true },
  speech: {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    providerId: '',
    tts: { voice: '茉莉', maxChars: 50, cooldownMin: 0 },
    asr: { enabled: true }
  },
  providers: [{ id: 'fake', name: '假服务商', baseURL: `http://127.0.0.1:${port}/v1` }],
  dshProviderKeys: { fake: 'test-key' }
}), 'utf8');

const { synthesize, TTS_VOICES, readCloneRef, sniffAudioExt, hasFfmpeg, convertRefToWav } = await import('../src/speech/tts.js');
const { updateConfig, getConfig } = await import('../src/config.js');
const { buildToolDefs } = await import('../src/tools.js');
const { getTool, getToolAvailability } = await import('../src/tool-registry.js');
const { SendQueue } = await import('../src/sender.js');

buildToolDefs();

let bad = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  [ok] ${label}`); }
  catch (e) { bad++; console.log(`  [FAIL] ${label} -- ${e.message}`); }
};
const checkAsync = async (label, fn) => {
  try { await fn(); console.log(`  [ok] ${label}`); }
  catch (e) { bad++; console.log(`  [FAIL] ${label} -- ${e.message}`); }
};

console.log('\n== TTS synthesize ==');

await checkAsync('正常合成：返回 WAV，请求体是 assistant 角色 + audio.voice', async () => {
  const { wav, voice } = await synthesize({ text: '你好呀' });
  assert.ok(Buffer.isBuffer(wav) && wav.length > 100);
  assert.equal(voice, '茉莉');
  assert.equal(state.lastBody.messages[0].role, 'assistant');
  assert.equal(state.lastBody.audio.voice, '茉莉');
  assert.ok(wav.slice(0, 4).toString('ascii') === 'RIFF');
  // 回归保护（真实故障）：服务商 baseURL 自带 /v1 时，不得拼出 /v1/v1/...
  assert.equal(state.lastUrl, '/v1/chat/completions', `URL 拼接错误：${state.lastUrl}`);
});

await checkAsync('空文本拒绝 / 超长拒绝（上限来自 config）', async () => {
  await assert.rejects(() => synthesize({ text: '  ' }), /为空/);
  await assert.rejects(() => synthesize({ text: '啊'.repeat(51) }), /太长了/);
});

await checkAsync('HTTP 400 时错误透出（含服务端提示）', async () => {
  await assert.rejects(
    () => synthesize({ text: 'hi', voice: '不存在的音色' }),
    /TTS 失败|Unknown voice/
  );
});

check('内置音色表包含茉莉（用户钦定默认）', () => {
  assert.ok(TTS_VOICES.includes('茉莉'));
});

console.log('\n== send_voice 工具 ==');

const sentBySender = [];
const fakeSender = {
  sendVoice: async (chatKey, { wav, note }) => { sentBySender.push({ chatKey, wav, note }); return { message_id: 42 }; }
};
const mkCtx = (chatKey) => ({ chatKey, session: { id: 's1', sent: [] }, emit() {}, sender: fakeSender });

check('开关关闭时工具不可见（availability 层拦）', () => {
  updateConfig({ tools: { speechVoice: false } });
  const av = getToolAvailability('send_voice', { toolsCfg: updateConfig({}).tools, visionEnabled: true });
  assert.equal(av.enabled, false);
  assert.match(av.reason, /语音回复未开启/);
  updateConfig({ tools: { speechVoice: true } });
});

await checkAsync('正常发送：synthesize → sender.sendVoice → 留档 session.sent', async () => {
  const ctx = mkCtx('group:100');
  const r = await getTool('send_voice').execute(ctx, { text: '讲个笑话' });
  assert.ok(!r.isError, r.content);
  assert.equal(sentBySender.length, 1);
  assert.equal(sentBySender[0].chatKey, 'group:100');
  assert.equal(ctx.session.sent[0].type, 'voice');
});

await checkAsync('冷却：cooldownMin=1 后立刻第二次被拒（文案带等待提示）', async () => {
  updateConfig({ speech: { tts: { cooldownMin: 1 } } });
  const ctx = mkCtx('group:100');
  const r = await getTool('send_voice').execute(ctx, { text: '再来一条' });
  assert.ok(r.isError);
  assert.match(r.content, /语音冷却中/);
  updateConfig({ speech: { tts: { cooldownMin: 0 } } });
});

console.log('\n== sender.sendVoice 管道 ==');

await checkAsync('record 段指向的 WAV 真实存在且 RIFF 头正确（协议端视角）', async () => {
  let capturedBytes = null;   // 协议端在 send 调用内同步读文件（真实时序）
  const fakeOnebot = {
    sendSegments: async (kind, id, segs) => {
      assert.equal(segs[0].type, 'record');
      const fileUri = segs[0].data.file;
      assert.ok(fileUri.startsWith('file:///'));
      capturedBytes = fs.readFileSync(decodeURIComponent(fileUri.slice('file:///'.length)));
      return { message_id: 7 };
    }
  };
  const store = { appendSelf: (k, entry) => { store.lastEntry = { k, entry }; } };
  const q = new SendQueue({ onebot: fakeOnebot, store });
  await q.sendVoice('group:200', { wav: WAV, note: '测试语音' });
  assert.ok(capturedBytes && capturedBytes.length > 100, '协议端应能读到文件内容');
  assert.equal(capturedBytes.slice(0, 4).toString('ascii'), 'RIFF');
  // 留档：self 记录带 [语音] 前缀
  assert.equal(store.lastEntry.k, 'group:200');
  assert.match(store.lastEntry.entry.text, /^\[语音\]/);
});

await checkAsync('去重：同一 note 短窗口内第二条被跳过', async () => {
  const fakeOnebot = { sendSegments: async () => ({ message_id: 8 }) };
  const q = new SendQueue({ onebot: fakeOnebot, store: { appendSelf() {} } });
  await q.sendVoice('group:300', { wav: WAV, note: '重复测试' });
  const r2 = await q.sendVoice('group:300', { wav: WAV, note: '重复测试' });
  assert.equal(r2.deduped, true);
});

console.log('\n== mimo-asr 插件（media.transcribe）==');

// 真插件 + 假 OneBot（get_record 返回临时 WAV 文件路径）
const wavPath = path.join(dataDir, 'fake-record.wav');
fs.writeFileSync(wavPath, WAV);
const fakeOnebotAsr = {
  call: async (action, params) => {
    assert.equal(action, 'get_record');
    return { file: wavPath };   // SnowLuma 形态：data.file 本地路径
  }
};
const asrMod = await import('../plugins/mimo-asr/index.js');
asrMod.setup({ config: () => getConfig(), log() {} });

await checkAsync('全链：get_record → WAV → 假 ASR → 转写文本', async () => {
  const r = await asrMod.providers['media.transcribe']({ record: { file: 'rec-1' }, onebot: fakeOnebotAsr });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.text, '转写结果文本');
  assert.equal(state.asrCalls, 1);
  // ASR 合同：不带 text 部件（网关注入）
  assert.equal(state.lastBody.messages[0].content.length, 1);
  assert.equal(state.lastBody.messages[0].content[0].type, 'input_audio');
});

await checkAsync('ASR 开关关闭 → 静默回退（ok:false, disabled）', async () => {
  updateConfig({ speech: { asr: { enabled: false } } });
  const r = await asrMod.providers['media.transcribe']({ record: { file: 'rec-1' }, onebot: fakeOnebotAsr });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'disabled');
  updateConfig({ speech: { asr: { enabled: true } } });
});

await checkAsync('get_record 失败 → 静默回退（不抛异常、不打断消息入库）', async () => {
  const badOnebot = { call: async () => { throw new Error('协议端拒绝'); } };
  const r = await asrMod.providers['media.transcribe']({ record: { file: 'rec-2' }, onebot: badOnebot });
  assert.equal(r.ok, false);
});

console.log('\n== 音色克隆 / 语气口吻（v1.5）==');

await checkAsync('style 语气指令：拼接为（style）text 前缀进 assistant content', async () => {
  await synthesize({ text: '你好呀', style: '害羞小声地' });
  assert.equal(state.lastBody.messages[0].content, '（害羞小声地）你好呀');
});

await checkAsync('clone 模式：model=voiceclone，audio.voice=参考音频 DataURL', async () => {
  // 准备参考音频文件（data/speech/clone-ref.wav）
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const cloneDir = pathMod.join(dataDir, 'speech');
  fsMod.mkdirSync(cloneDir, { recursive: true });
  fsMod.writeFileSync(pathMod.join(cloneDir, 'clone-ref.wav'), WAV);
  updateConfig({ speech: { tts: { mode: 'clone', cloneRefFile: 'clone-ref.wav' } } });
  const { wav, mode, model } = await synthesize({ text: '克隆测试' });
  assert.equal(state.lastBody.model, 'mimo-v2.5-tts-voiceclone');
  assert.ok(state.lastBody.audio.voice.startsWith('data:audio/wav;base64,'), 'voice 应是参考音频 DataURL（wav → audio/wav）');
  assert.equal(mode, 'clone');
  assert.ok(Buffer.isBuffer(wav) && wav.length > 100);
  updateConfig({ speech: { tts: { mode: 'preset' } } });
});

await checkAsync('clone 参考音频是 mp3 扩展时，MIME 标注跟随实际格式（audio/mpeg）', async () => {
  const fsMod = await import('node:fs');
  const pathMod = await import('node:path');
  const cloneDir = pathMod.join(dataDir, 'speech');
  fsMod.writeFileSync(pathMod.join(cloneDir, 'clone-ref.mp3'), WAV);   // 内容无所谓，按扩展名标 MIME
  updateConfig({ speech: { tts: { mode: 'clone', cloneRefFile: 'clone-ref.mp3' } } });
  await synthesize({ text: 'mp3 克隆测试' });
  assert.ok(state.lastBody.audio.voice.startsWith('data:audio/mpeg;base64,'),
    `MIME 应为 audio/mpeg，实际：${state.lastBody.audio.voice.slice(0, 40)}`);
  updateConfig({ speech: { tts: { mode: 'preset' } } });
});

await checkAsync('clone 模式但参考音频缺失 → 自动回落预置音色（不挂）', async () => {
  updateConfig({ speech: { tts: { mode: 'clone', cloneRefFile: '不存在.wav' } } });
  const { mode } = await synthesize({ text: '回落测试' });
  assert.equal(mode, 'preset');
  assert.equal(state.lastBody.model, 'mimo-v2.5-tts');
  updateConfig({ speech: { tts: { mode: 'preset' } } });
});

check('readCloneRef：路径穿越（../、子目录）一律拒绝', () => {
  updateConfig({ speech: { tts: { cloneRefFile: '../evil.wav' } } });
  assert.equal(readCloneRef(), null);
  updateConfig({ speech: { tts: { cloneRefFile: 'sub/evil.wav' } } });
  assert.equal(readCloneRef(), null);
  updateConfig({ speech: { tts: { cloneRefFile: '' } } });
  assert.equal(readCloneRef(), null);
});

check('sniffAudioExt：魔数嗅探（wav/mp3/ogg/m4a/aac），浏览器标错 MIME 也不怕', () => {
  // WAV：RIFF....WAVE
  const wav = Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.alloc(4), Buffer.from('WAVE', 'ascii'), Buffer.alloc(8)]);
  assert.equal(sniffAudioExt(wav), 'wav');
  // MP3：ID3 头
  assert.equal(sniffAudioExt(Buffer.from('ID3\x03\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00', 'ascii')), 'mp3');
  // MP3：帧同步 FF Ex（补长到 12+ 字节 —— 嗅探函数要求最少 12 字节）
  assert.equal(sniffAudioExt(Buffer.from([0xFF, 0xFB, 0x90, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'mp3');
  // AAC：ADTS 同步 FF F1 / FF F9
  assert.equal(sniffAudioExt(Buffer.from([0xFF, 0xF1, 0x50, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'aac');
  assert.equal(sniffAudioExt(Buffer.from([0xFF, 0xF9, 0x50, 0x80, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), 'aac');
  // OGG：OggS
  assert.equal(sniffAudioExt(Buffer.from('OggS\x00\x02\x00\x00\x00\x00\x00\x00\x00\x00', 'ascii')), 'ogg');
  // M4A：ftyp 盒（偏移 4）
  const m4a = Buffer.concat([Buffer.alloc(4), Buffer.from('ftypM4A ', 'ascii'), Buffer.alloc(8)]);
  assert.equal(sniffAudioExt(m4a), 'm4a');
  // 未知 → null
  assert.equal(sniffAudioExt(Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0A, 0x0B])), null);
  assert.equal(sniffAudioExt(Buffer.alloc(4)), null);
});

check('convertRefToWav：有 ffmpeg 时 m4a/ogg 字节转成 PCM WAV（无损参考，克隆更保真）', () => {
  if (!hasFfmpeg()) { console.log('      （本机无 ffmpeg，跳过转码用例）'); return; }
  // 生成一段真实可解码的 m4a：先用 ffmpeg 从 WAV 转出 m4a，再转回 WAV，验证链路
  const srcWav = path.join(dataDir, 'conv-src.wav');
  const srcM4a = path.join(dataDir, 'conv-src.m4a');
  fs.writeFileSync(srcWav, WAV);
  const r = spawnSync('ffmpeg', ['-y', '-i', srcWav, '-ar', '16000', '-ac', '1', '-c:a', 'aac', srcM4a],
    { timeout: 30000, windowsHide: true, stdio: 'ignore' });
  if (r.status !== 0) { console.log('      （ffmpeg 生成 m4a 失败，跳过）'); return; }
  const wav = convertRefToWav(fs.readFileSync(srcM4a));
  assert.ok(wav && wav.length > 1000, '转码产物应为有效 WAV');
  assert.equal(sniffAudioExt(wav), 'wav', '转码产物魔数应为 wav');
  assert.equal(wav.slice(0, 4).toString('ascii'), 'RIFF');
});

await checkAsync('唱歌语法：text 带（唱歌）+ style 含"唱" → 克隆模式自动回落预置音色', async () => {
  // 准备参考音频并切到 clone 模式
  const cloneDir = path.join(dataDir, 'speech');
  fs.writeFileSync(path.join(cloneDir, 'clone-ref.wav'), WAV);
  updateConfig({ speech: { tts: { mode: 'clone', cloneRefFile: 'clone-ref.wav' } } });
  const { singing, forcedPreset, model } = await synthesize({ text: '（唱歌）两只老虎两只老虎跑得快', style: '深情地唱' });
  assert.equal(singing, true, '应判定为唱歌');
  assert.equal(forcedPreset, true, '克隆模式下唱歌应强制回落预置音色');
  assert.equal(model, 'mimo-v2.5-tts');
  assert.equal(state.lastBody.model, 'mimo-v2.5-tts');
  assert.equal(state.lastBody.audio.voice, '茉莉', '回落用默认预置音色');
  // （唱歌）标签要保留在文本里（引擎靠它触发唱歌）
  assert.match(state.lastBody.messages[0].content, /（唱歌）|（深情地唱）/);
  updateConfig({ speech: { tts: { mode: 'preset' } } });
});

await checkAsync('非唱歌场景不受影响：纯 style 不含"唱"时 clone 模式照常走克隆', async () => {
  const cloneDir = path.join(dataDir, 'speech');
  fs.writeFileSync(path.join(cloneDir, 'clone-ref.wav'), WAV);
  updateConfig({ speech: { tts: { mode: 'clone', cloneRefFile: 'clone-ref.wav' } } });
  const { singing, forcedPreset, model } = await synthesize({ text: '正常说话', style: '害羞小声地' });
  assert.equal(singing, false);
  assert.equal(forcedPreset, false);
  assert.equal(model, 'mimo-v2.5-tts-voiceclone');
  updateConfig({ speech: { tts: { mode: 'preset' } } });
});

server.close();
console.log(bad ? `\n${bad} 项失败\n` : '\n全部通过\n');
process.exit(bad ? 1 : 0);
