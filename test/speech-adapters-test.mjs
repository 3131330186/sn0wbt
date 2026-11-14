/**
 * 语音多引擎适配器（Phase A）的密闭测试 —— 四家假服务器，不碰真 Key。
 *
 * 覆盖：
 *   1. 引擎识别：infer/format 显式指定优先/无效 id 兜底 mimo
 *   2. OpenAI：/audio/speech 契约（wav、instructions 仅 gpt-4o*、音色回落/显式透传）、
 *      /audio/transcriptions multipart 契约
 *   3. MiniMax：/v1/t2a_v2?GroupId= 契约（hex→RIFF、缺 GroupId 报错、错误码透出、
 *      别家音色回落默认）、asr 能力为 false
 *   5. 能力门控：openai 唱歌报错、克隆回落、非 WAV → ffmpeg 归一
 *   6. ASR 独立服务商：speech.asr.providerId 指到另一台服务器
 *
 * 回归面：mimo 的逐字节契约由 test/speech-test.mjs 钉死（本文件不重复）。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

// ── 最小 WAV（seconds 可指定时长，供 GPT-SoVITS 的 3~10 秒约束用例造长短参考音频）──
function makeWav(seconds = 0.128) {
  const data = Buffer.alloc(Math.max(2, Math.round(16000 * seconds)) * 2, 7);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}
const WAV = makeWav();
const REF3 = makeWav(3.2);   // 3.2 秒合规参考音频（api_v2 硬约束 3~10 秒）

// ── 四台假服务器：各自记录 last 请求，按引擎契约应答 ──
function makeServer(handler) {
  const state = { hits: [], last: null };
  const srv = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      state.hits.push(req.url);
      state.last = { url: req.url, headers: req.headers, raw, bodyText: raw.toString('utf8') };
      try { handler(req, res, raw, state.last); } catch (e) { res.writeHead(500); res.end(String(e)); }
    });
  });
  return { srv, state };
}

// OpenAI 形态：/audio/speech 出 WAV；/audio/transcriptions 收 multipart 出 {text}
const oai = makeServer((req, res, raw, last) => {
  if (req.url.includes('/audio/transcriptions')) {
    last.kind = 'asr';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ text: '转写ok' }));
  }
  last.json = JSON.parse(last.bodyText || '{}');
  // mimo 形态的 ASR（chat/completions + input_audio）—— 借用转写测试用
  if (last.json?.messages?.[0]?.content?.[0]?.type === 'input_audio') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ choices: [{ message: { content: '转写ok', role: 'assistant' } }] }));
  }
  last.kind = 'tts';
  res.writeHead(200, { 'Content-Type': 'audio/wav' });
  res.end(WAV);
});
// MiniMax 形态：/v1/t2a_v2 出 hex 音频（可注入错误码）
const mmx = { mode: 'ok' };
const mmxSrv = makeServer((req, res, raw, last) => {
  last.json = JSON.parse(last.bodyText || '{}');
  if (mmx.mode === 'err') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ base_resp: { status_code: 1, status_msg: 'voice not found' } }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ base_resp: { status_code: 0, status_msg: 'success' }, data: { audio: WAV.toString('hex') } }));
});
// 第二台 mimo 形态（ASR 独立服务商验证用）
const mimoB = makeServer((req, res, raw, last) => {
  last.json = JSON.parse(last.bodyText || '{}');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ choices: [{ message: { content: 'B端转写', role: 'assistant' } }] }));
});
// GPT-SoVITS 形态：POST /tts → 200 裸 WAV；错误模式 400 {message}
const sovits = { mode: 'ok' };
const sovitsSrv = makeServer((req, res, raw, last) => {
  last.json = JSON.parse(last.bodyText || '{}');
  if (sovits.mode === 'err') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: 'ref_audio_path is required' }));
  }
  if (sovits.mode === 'err-ex') {   // 真机实踩形态：message 是幌子，Exception 才是真实原因
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ message: 'tts failed', Exception: '参考音频在3~10秒范围外，请更换！' }));
  }
  res.writeHead(200, { 'Content-Type': 'audio/wav' });
  res.end(WAV);
});

await new Promise((r) => oai.srv.listen(0, '127.0.0.1', r));
await new Promise((r) => mmxSrv.srv.listen(0, '127.0.0.1', r));
await new Promise((r) => mimoB.srv.listen(0, '127.0.0.1', r));
await new Promise((r) => sovitsSrv.srv.listen(0, '127.0.0.1', r));
const pOai = oai.srv.address().port;
const pMmx = mmxSrv.srv.address().port;
const pMb = mimoB.srv.address().port;
const pSovits = sovitsSrv.srv.address().port;

// ── 隔离环境 ──
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-adapters-test-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;
fs.mkdirSync(path.join(dataDir, 'messages'), { recursive: true });
fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
  speech: { baseUrl: '' },   // 关键：不启用 baseUrl 覆盖（覆盖会把所有请求打到同一台）
  providers: [
    { id: 'p-oai', name: 'OpenAI假', baseURL: `http://127.0.0.1:${pOai}/v1` },
    { id: 'p-mmx', name: 'MiniMax假', baseURL: `http://127.0.0.1:${pMmx}` },
    { id: 'p-mb', name: 'mimoB假', baseURL: `http://127.0.0.1:${pMb}/v1` },
    { id: 'p-sovits', name: 'GPT-SoVITS假', baseURL: `http://127.0.0.1:${pSovits}` }
  ],
  dshProviderKeys: { 'p-oai': 'k-oai', 'p-mmx': 'k-mmx', 'p-mb': 'k-mb', 'p-sovits': 'local' }
}), 'utf8');

const ttsMod = await import('../src/speech/tts.js');
const asrMod = await import('../src/speech/asr.js');
const regMod = await import('../src/speech/adapters/index.js');
const { updateConfig, getConfig } = await import('../src/config.js');
const { synthesize, hasFfmpeg } = ttsMod;
const { transcribeWav } = asrMod;
const { inferAdapterId, resolveAdapter, getAdapter, capabilitiesText, ADAPTERS, FORMAT_IDS } = regMod;

/** 重置 speech 配置到指定引擎状态。 */
function useEngine(over = {}) {
  updateConfig({
    speech: {
      baseUrl: '',
      providerId: over.providerId || '',
      format: over.format || 'auto',
      groupId: over.groupId || '',
      region: over.region || '',
      models: over.models || { tts: '', ttsClone: '', asr: '' },
      tts: { voice: over.voice || '茉莉', mode: over.mode || 'preset', cloneRefFile: over.cloneRefFile || '', maxChars: 200, cooldownMin: 0 },
      asr: { enabled: true, providerId: over.asrProviderId || '', language: over.language || 'zh-CN' }
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

console.log('\n== 引擎识别 ==');

check('inferAdapterId：五家特征 + 未知兜底 mimo', () => {
  assert.equal(inferAdapterId('https://api.xiaomimimo.com/v1'), 'mimo');
  assert.equal(inferAdapterId('https://api.openai.com/v1'), 'openai');
  assert.equal(inferAdapterId('https://api.minimax.chat'), 'minimax');
  assert.equal(inferAdapterId('http://127.0.0.1:9880'), 'gpt-sovits', '本地默认端口');
  assert.equal(inferAdapterId('http://192.168.1.5:9880/'), 'gpt-sovits');
  assert.equal(inferAdapterId('https://some-gateway.example.com/v1'), 'mimo');
  assert.equal(inferAdapterId(''), 'mimo');
});

check('resolveAdapter：format 显式指定 > auto 推断；无效 id 兜底 mimo', () => {
  assert.equal(resolveAdapter({ speech: { format: 'openai' } }, 'https://api.xiaomimimo.com/v1').id, 'openai', '显式压过推断');
  assert.equal(resolveAdapter({ speech: { format: 'auto' } }, 'https://api.openai.com/v1').id, 'openai');
  assert.equal(resolveAdapter({ speech: { format: '不存在的' } }, '').id, 'mimo');
  assert.equal(resolveAdapter({}, '').id, 'mimo');
  assert.ok(ADAPTERS.length >= 4 && FORMAT_IDS.includes('gpt-sovits'));
  assert.match(capabilitiesText(getAdapter('openai')), /克隆✗.*唱歌✗/s);
});

check('routes.js 的 adapters import 完整（漏 import 是运行时 ReferenceError，语法检查抓不到——实踩过）', () => {
  const src = fs.readFileSync(new URL('../src/routes.js', import.meta.url), 'utf8');
  for (const sym of ['resolveAdapter', 'ADAPTERS', 'FORMAT_IDS', 'capabilitiesText']) {
    assert.match(src, new RegExp(`import \\{[^}]*\\b${sym}\\b[^}]*\\} from '\\./speech/adapters/index\\.js'`), `${sym} 必须从 adapters/index.js import`);
  }
});

console.log('\n== OpenAI 引擎 ==');

await checkAsync('TTS：/audio/speech 契约（path/auth/wav/instructions 仅 gpt-4o*）+ 配置音色回落', async () => {
  useEngine({ providerId: 'p-oai', format: 'openai' });
  oai.state.last = null;
  const r = await synthesize({ text: '你好呀', style: '开心一点' });
  assert.ok(r.wav.slice(0, 4).toString('ascii') === 'RIFF');
  assert.equal(r.voice, 'alloy', '配置音色茉莉不在表 → 回落 alloy');
  const last = oai.state.last;
  assert.ok(last.url.includes('/audio/speech'), last.url);
  assert.equal(last.headers.authorization, 'Bearer k-oai');
  assert.equal(last.json.model, 'gpt-4o-mini-tts');
  assert.equal(last.json.voice, 'alloy');
  assert.equal(last.json.response_format, 'wav');
  assert.equal(last.json.instructions, '开心一点', 'gpt-4o 模型应带 instructions');
  // 老模型（tts-1）不带 instructions，显式音色透传
  useEngine({ providerId: 'p-oai', format: 'openai', models: { tts: 'tts-1' }, voice: 'nova' });
  await synthesize({ text: 'hi', style: '开心' });
  assert.equal(oai.state.last.json.model, 'tts-1');
  assert.equal(oai.state.last.json.instructions, undefined, 'tts-1 不应带 instructions');
  assert.equal(oai.state.last.json.voice, 'nova', '显式/表内音色原样透传');
});

await checkAsync('ASR：multipart 契约（file+model+response_format）', async () => {
  useEngine({ providerId: 'p-oai', format: 'openai' });
  oai.state.last = null;
  const r = await transcribeWav(WAV);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.text, '转写ok');
  const last = oai.state.last;
  assert.ok(last.url.includes('/audio/transcriptions'), last.url);
  assert.match(last.headers['content-type'] || '', /multipart\/form-data/);
  assert.match(last.bodyText, /name="model"/);
  assert.match(last.bodyText, /whisper-1/);
  assert.match(last.bodyText, /name="file"/);
});

await checkAsync('能力门控：（唱歌）在 openai 上直接报错，不静默播出台词', async () => {
  useEngine({ providerId: 'p-oai', format: 'openai' });
  await assert.rejects(() => synthesize({ text: '（唱歌）两只老虎' }), /不支持唱歌/);
});

await checkAsync('能力门控：mode=clone 在 openai 上回落 preset（不谎报克隆）', async () => {
  // 放一份参考音频，确认 cap.clone=false 时完全不走克隆路径
  const dir = path.join(dataDir, 'speech');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ref.wav'), WAV);
  useEngine({ providerId: 'p-oai', format: 'openai', mode: 'clone', cloneRefFile: 'ref.wav' });
  const r = await synthesize({ text: '克隆回落' });
  assert.equal(r.mode, 'preset');
  assert.equal(r.voice, 'alloy');
  useEngine({ providerId: 'p-oai', format: 'openai' });
});

console.log('\n== MiniMax 引擎（⚠ 契约待真机联调，本测只锁我们发出的形状）==');

await checkAsync('TTS：/v1/t2a_v2?GroupId= + voice/audio_setting + hex→RIFF + 别家音色回落', async () => {
  useEngine({ providerId: 'p-mmx', format: 'minimax', groupId: 'G123' });
  mmx.mode = 'ok';
  mmxSrv.state.last = null;
  const r = await synthesize({ text: '你好呀', style: '开心' });
  assert.ok(r.wav.slice(0, 4).toString('ascii') === 'RIFF', 'hex 解码应为 WAV');
  const last = mmxSrv.state.last;
  assert.ok(/^\/v1\/t2a_v2\?GroupId=G123$/.test(last.url), last.url);
  assert.equal(last.headers.authorization, 'Bearer k-mmx');
  assert.equal(last.json.model, 'speech-02-turbo');
  assert.equal(last.json.voice_setting.voice_id, 'female-shaonv', '茉莉不在表 → 回落默认');
  assert.equal(last.json.voice_setting.emotion, 'happy', 'style 开心 → emotion 映射');
  assert.equal(last.json.audio_setting.format, 'wav');
  assert.equal(last.json.stream, false);
});

await checkAsync('GroupId 可选（真机实测：新版接口免 GroupId）；错误码透出 status_msg', async () => {
  useEngine({ providerId: 'p-mmx', format: 'minimax', groupId: '' });
  mmxSrv.state.last = null;
  await synthesize({ text: 'hi' });
  assert.ok(!mmxSrv.state.last.url.includes('GroupId='), '空 GroupId 不应拼进 URL');
  useEngine({ providerId: 'p-mmx', format: 'minimax', groupId: 'G123' });
  mmxSrv.state.last = null;
  await synthesize({ text: 'hi' });
  assert.ok(mmxSrv.state.last.url.includes('GroupId=G123'), '填了 GroupId 就带上');
  mmx.mode = 'err';
  await assert.rejects(() => synthesize({ text: 'hi' }), /voice not found/);
  mmx.mode = 'ok';
});

await checkAsync('MiniMax 不支持转写 → adapter-no-asr（UI 据此显隐）', async () => {
  useEngine({ providerId: 'p-mmx', format: 'minimax', groupId: 'G123' });
  const r = await transcribeWav(WAV);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'adapter-no-asr');
  assert.equal(getAdapter('minimax').capabilities.asr, false);
});

console.log('\n== GPT-SoVITS 引擎（本地克隆，契约来自官方 api_v2.py 源码）==');

await checkAsync('TTS：POST /tts 契约（必填四字段/无鉴权/裸 WAV 回）+ cloneOnly 强制克隆', async () => {
  // 参考音频（3.2s 过硬约束）+ 有缓存（触发缓存命中路径）
  const dir = path.join(dataDir, 'speech');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'local-ref.wav'), REF3);
  fs.writeFileSync(path.join(dir, 'local-ref.wav.prompt.txt'), `${REF3.length}\n我是参考音频里说的话`);
  useEngine({ providerId: 'p-sovits', format: 'gpt-sovits', mode: 'preset', cloneRefFile: 'local-ref.wav' });
  sovits.mode = 'ok';
  sovitsSrv.state.last = null;
  const r = await synthesize({ text: '你好呀' });
  assert.ok(r.wav.slice(0, 4).toString('ascii') === 'RIFF');
  assert.equal(r.mode, 'clone', 'cloneOnly 引擎无视 mode 开关强制克隆');
  const last = sovitsSrv.state.last;
  assert.ok(last.url.endsWith('/tts'), last.url);
  assert.equal(last.headers.authorization, undefined, '本地服务不发鉴权头');
  assert.equal(last.json.text, '你好呀');
  assert.equal(last.json.text_lang, 'zh');
  assert.equal(last.json.prompt_lang, 'zh');
  assert.equal(last.json.media_type, 'wav');
  assert.equal(last.json.streaming_mode, false);
  assert.equal(last.json.temperature, 0.6, '抗电流音采样参数固化（真机调优）');
  assert.equal(last.json.top_k, 15);
  assert.equal(last.json.top_p, 0.8);
  assert.equal(last.json.prompt_text, '我是参考音频里说的话', '应命中 prompt 缓存');
  assert.ok(path.isAbsolute(last.json.ref_audio_path), 'ref_audio_path 必须是绝对路径');
  assert.ok(last.json.ref_audio_path.endsWith('local-ref.wav'), last.json.ref_audio_path);
  assert.equal(getAdapter('gpt-sovits').cloneOnly, true);
  assert.equal(getAdapter('gpt-sovits').capabilities.asr, false);
});

await checkAsync('无参考音频 → 可读报错（不静默、不瞎猜）', async () => {
  useEngine({ providerId: 'p-sovits', format: 'gpt-sovits', cloneRefFile: '' });
  await assert.rejects(() => synthesize({ text: 'hi' }), /参考音频/);
});

await checkAsync('prompt 缺失 → 自动用 ASR 引擎转写一次并缓存（第二次不再打 ASR）', async () => {
  const cache = path.join(dataDir, 'speech', 'local-ref.wav.prompt.txt');
  fs.rmSync(cache, { force: true });
  // ASR 指到 mimoB 假服（format=gpt-sovits 但 transcribeWav 内部按 auto+ASR地址推断）
  useEngine({ providerId: 'p-sovits', format: 'gpt-sovits', asrProviderId: 'p-mb', cloneRefFile: 'local-ref.wav' });
  sovitsSrv.state.last = null;
  mimoB.state.hits = [];
  const r1 = await synthesize({ text: '第一遍' });
  assert.ok(r1.wav.length > 100);
  assert.equal(sovitsSrv.state.last.json.prompt_text, 'B端转写', '自动转写结果应进 prompt_text');
  assert.equal(fs.readFileSync(cache, 'utf8'), `${REF3.length}\nB端转写`, '转写结果应落盘缓存（首行=源文件字节数，防同名重传脏缓存）');
  const asrHits = mimoB.state.hits.length;
  assert.ok(asrHits >= 1, '第一遍应打过 ASR');
  // 第二遍：缓存命中，不再打 ASR
  await synthesize({ text: '第二遍' });
  assert.equal(mimoB.state.hits.length, asrHits, '缓存命中后不应再打 ASR');
  useEngine({ providerId: 'p-sovits', format: 'gpt-sovits' });
});

await checkAsync('服务端 400 → message 透出（官方错误格式 {"message"}）', async () => {
  const dir = path.join(dataDir, 'speech');
  fs.writeFileSync(path.join(dir, 'local-ref.wav'), REF3);
  useEngine({ providerId: 'p-sovits', format: 'gpt-sovits', cloneRefFile: 'local-ref.wav' });
  sovits.mode = 'err';
  await assert.rejects(() => synthesize({ text: 'hi' }), /ref_audio_path is required/);
  sovits.mode = 'ok';
});

await checkAsync('服务端 400 的 Exception 字段也透出（真机实踩：message 只有 tts failed）', async () => {
  useEngine({ providerId: 'p-sovits', format: 'gpt-sovits', cloneRefFile: 'local-ref.wav' });
  sovits.mode = 'err-ex';
  await assert.rejects(() => synthesize({ text: 'hi' }), /参考音频在3~10秒范围外/);
  sovits.mode = 'ok';
});

await checkAsync('主服务商无转写能力（asr.providerId 留空）→ 自动借用第一个有 ASR 的服务商', async () => {
  // 真机踩的坑：用户把主服务商切成 GPT-SoVITS 后，prompt 自动转写跟着断粮（静默空 prompt）
  const cache = path.join(dataDir, 'speech', 'local-ref.wav.prompt.txt');
  fs.rmSync(cache, { force: true });
  useEngine({ providerId: 'p-sovits', format: 'gpt-sovits', cloneRefFile: 'local-ref.wav', asrProviderId: '' });
  sovitsSrv.state.last = null;
  const r = await synthesize({ text: '借用转写' });
  assert.ok(r.wav.length > 100);
  assert.equal(sovitsSrv.state.last.json.prompt_text, '转写ok', '应借用 p-oai（列表第一个有 ASR 能力的服务商）');
  useEngine({ providerId: 'p-sovits', format: 'gpt-sovits' });
});

await checkAsync('日语参考音频（转写含假名）→ prompt_lang 自动标 ja，text_lang 不受影响', async () => {
  // 真机实踩：用户的参考音频是日语台词，标 zh 会跑腔
  const cache = path.join(dataDir, 'speech', 'local-ref.wav.prompt.txt');
  fs.writeFileSync(cache, `${REF3.length}\n恐い颜。でも好きよ。`);
  useEngine({ providerId: 'p-sovits', format: 'gpt-sovits', cloneRefFile: 'local-ref.wav' });
  sovitsSrv.state.last = null;
  await synthesize({ text: '你好呀' });
  assert.equal(sovitsSrv.state.last.json.prompt_lang, 'ja', '假名 → prompt_lang=ja');
  assert.equal(sovitsSrv.state.last.json.text_lang, 'zh', '要说的话语言不受影响');
  useEngine({ providerId: 'p-sovits', format: 'gpt-sovits' });
});

await checkAsync('参考音频超长（>10s）→ 自动裁到 9.5 秒副本，ref_audio_path 指向副本（真机实踩：10.03s 被 400 拒）', async () => {
  const dir = path.join(dataDir, 'speech');
  fs.writeFileSync(path.join(dir, 'local-ref-long.wav'), makeWav(11));
  useEngine({ providerId: 'p-sovits', format: 'gpt-sovits', asrProviderId: 'p-mb', cloneRefFile: 'local-ref-long.wav' });
  sovitsSrv.state.last = null;
  const r = await synthesize({ text: '裁剪测试' });
  assert.ok(r.wav.length > 100);
  const last = sovitsSrv.state.last;
  assert.ok(last.json.ref_audio_path.endsWith('local-ref-long.wav.sovits-trim.wav'), last.json.ref_audio_path);
  // 副本 ≤ 9.5 秒（16kHz mono 16bit → 每秒 32000 字节）；标准 44 字节头，data 大小在偏移 40
  const t = fs.readFileSync(last.json.ref_audio_path);
  const dataSize = t.readUInt32LE(40);
  assert.ok(dataSize <= 9.5 * 32000 && dataSize > 0, `副本 data 块 ${dataSize} 字节应 ≤ 304000`);
  assert.equal(t.slice(0, 4).toString('ascii'), 'RIFF', '副本仍是合法 WAV');
  // prompt 缓存键跟着副本走（自动转写打到了 mimoB）
  const raw = fs.readFileSync(path.join(dir, 'local-ref-long.wav.sovits-trim.wav.prompt.txt'), 'utf8');
  assert.ok(raw.endsWith('\nB端转写'), raw);
  useEngine({ providerId: 'p-sovits', format: 'gpt-sovits' });
});

await checkAsync('参考音频过短（<3s）→ 本地可读报错，不发请求', async () => {
  const dir = path.join(dataDir, 'speech');
  fs.writeFileSync(path.join(dir, 'local-ref-short.wav'), makeWav(1));
  useEngine({ providerId: 'p-sovits', format: 'gpt-sovits', cloneRefFile: 'local-ref-short.wav' });
  sovitsSrv.state.last = null;
  await assert.rejects(() => synthesize({ text: 'hi' }), /3~10 秒/);
  assert.equal(sovitsSrv.state.last, null, '过短应本地拦截，请求不该发出去');
  useEngine({ providerId: 'p-sovits', format: 'gpt-sovits' });
});

console.log('\n== WAV 归一 / ASR 独立服务商 ==');

await checkAsync('引擎返回非 WAV → ffmpeg 归一为 RIFF（无 ffmpeg/编码器则跳过）', async () => {
  if (!hasFfmpeg()) { console.log('      （本机无 ffmpeg，跳过）'); return; }
  // 造真实可解码的 mp3（纯垃圾字节 ffmpeg 解不出 → 会被当失败）
  const srcWav = path.join(dataDir, 'mp3-src.wav');
  const srcMp3 = path.join(dataDir, 'mp3-src.mp3');
  fs.writeFileSync(srcWav, WAV);
  const enc = spawnSync('ffmpeg', ['-y', '-i', srcWav, '-codec:a', 'libmp3lame', '-q:a', '4', srcMp3],
    { timeout: 30000, windowsHide: true, stdio: 'ignore' });
  if (enc.status !== 0 || !fs.existsSync(srcMp3)) { console.log('      （ffmpeg mp3 编码不可用，跳过）'); return; }
  const mp3 = fs.readFileSync(srcMp3);
  const mp3Srv = http.createServer((req, res) => {
    req.on('data', () => {});
    req.on('end', () => { res.writeHead(200, { 'Content-Type': 'audio/mpeg' }); res.end(mp3); });
  });
  await new Promise((r) => mp3Srv.listen(0, '127.0.0.1', r));
  const pMp3 = mp3Srv.address().port;
  // providers 数组是整体替换语义 —— 必须追加而不是覆盖（否则冲掉后面用的假服）
  const cur = getConfig();
  updateConfig({
    providers: [...(cur.providers || []), { id: 'p-mp3', name: 'mp3假', baseURL: `http://127.0.0.1:${pMp3}/v1` }],
    dshProviderKeys: { ...(cur.dshProviderKeys || {}), 'p-mp3': 'k' }
  });
  useEngine({ providerId: 'p-mp3', format: 'openai' });
  const r = await synthesize({ text: 'mp3引擎' });
  assert.ok(r.wav.slice(0, 4).toString('ascii') === 'RIFF', 'mp3 应被转成 WAV');
  mp3Srv.close();
});

await checkAsync('ASR 独立服务商：transcribeWav 走 asr.providerId，与 TTS 分离', async () => {
  // TTS=OpenAI 假服；ASR=mimoB 假服（格式都得指定对）——
  // 引擎格式是全局的（format 决定"怎么发"），asr.providerId 决定"发给谁"。
  useEngine({ providerId: 'p-oai', format: 'mimo', asrProviderId: 'p-mb' });
  oai.state.last = null;
  mimoB.state.last = null;
  const r = await transcribeWav(WAV);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.text, 'B端转写');
  assert.ok(mimoB.state.last.url.includes('/chat/completions'), 'ASR 应打到 asr.providerId 的服务器');
  assert.equal(mimoB.state.last.json.model, 'mimo-v2.5-asr');
  assert.equal(oai.state.last, null, 'TTS 服务商不应被 ASR 触碰');
  // TTS 照常打 p-oai
  useEngine({ providerId: 'p-oai', format: 'openai' });
  await synthesize({ text: 'tts分离验证' });
  assert.ok(oai.state.last, 'TTS 应打 providerId 的服务器');
});

// 清场
oai.srv.close(); mmxSrv.srv.close(); mimoB.srv.close(); sovitsSrv.srv.close();
console.log(bad ? `\n${bad} 项失败\n` : '\n全部通过\n');
process.exit(bad ? 1 : 0);
