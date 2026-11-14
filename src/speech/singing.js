// 本地歌声链（SVC 方案 · 用户验收 2026-11-05）：
//   （唱歌）歌词 → 出歌引擎（适配器，默认 ace-step，见下方注册表）
//   → demucs 人声分离 → RVC 转成目标音色（公共层 src/speech/rvc.js，
//   说话变声也走它 = 唱说同声线）→ ffmpeg 出成品 WAV
//   成品默认【清唱】（accompaniment:false，伴奏会把人声盖住听不清，用户定版
//   2026-11-06）；配置 accompaniment:true 则人声 +1.5dB 混回原伴奏。
//
// 人声体检（2026-11-06 实踩）：提示词没点名"人声"时，ACE-Step 经常出纯器乐
// take（7 个候选 6 个干声峰值 ≤-33dB，demucs 分出来是哑的，RVC 白转，成品
// 几乎听不见）。修法三层：提示词明写"人声演唱"+ 歌词自动垫 [verse] 结构
// 标签 + 出歌后量干声峰值，太哑自动重抽一次（换种子）。
//
// 歌词遵循度（同日实踩）：inference_steps=8（turbo 蒸馏）出的是 "na na na" 式
// 虚词哼唱，人声峰值体检还骗得过 —— ASR 实证同一歌词 8 步转写="啊"、27 步
// 完整唱出歌词原文。故默认 27 步（可配 speech.singing.inferenceSteps）。
//
// 为什么是这条链：TTS 引擎的"唱歌"要么不支持、要么音色和说话不一致
// （实踩：MiniMax 音乐 API 410 拒新用户；ACE-Step 风格迁移只"勉强过关"）。
// 本链用 RVC 音色转换把歌声对齐到 GPT-SoVITS 的说话音色 —— 唱说一致的终解。
//
// 依赖（本机部署，路径见 config.speech.singing；换机改配置）：
//   · ACE-Step API   127.0.0.1:8001（便携包 D:\ACE-Step-portable，start_api_server.bat）
//   · demucs         {toolkitDir}/venv/Scripts/demucs.exe（py310 独立环境）
//   · Applio (RVC)   {toolkitDir}/Applio（env/ 内嵌 Python，logs/<model>/ 下训练产物）
//   · ffmpeg         {toolkitDir}/Applio/ffmpeg.exe（便携包自带）
//
// 契约（全部真机钉死，非凭记忆）：
//   POST {base}/release_task  JSON {prompt, lyrics, vocal_language, inference_steps, audio_duration}
//     → {data:{task_id}}（注意：JSON 模式禁绝对路径——参考音频只能 multipart，
//        本链不用参考音频；thinking/use_cot_caption 默认值即为验收过的组合）
//   POST {base}/query_result  {task_id_list:[id]} → data[0].status：
//     0=排队/运行中（progress_text 有进度） 1=成功（result 为 JSON 字符串）
//     2=失败（progress_text 是原因）—— STATUS_MAP 反直觉，实踩
//   GET  {base}{data[0].file}  → mp3 字节（file 形如 /v1/audio?path=...）
//   demucs --two-stems=vocals -n htdemucs -o <dir> <song> → <dir>/htdemucs/<名>/vocals.wav + no_vocals.wav
//   Applio: env/python.exe core.py infer ...（export-format 必须大写 WAV，小写报错——实踩）
//
// 音色一致性参数（验收通过的原样组合，别凭感觉改）：
//   RVC: f0-method rmvpe / pitch 0 / index-rate 0.75 / protect 0.33
//   出口: 44100Hz 立体声；混伴奏时人声 volume=1.15 + amix（仅 accompaniment:true）
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { rvcConvert, pickModelPth, wavPeak, withGpuLock } from './rvc.js';

// ── 可注入依赖（测试换假件；生产用默认）────────────────────────────
function defaultRun(cmd, args, { cwd, timeoutMs = 300000, env } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { cwd, timeout: timeoutMs, windowsHide: true, maxBuffer: 32 * 1024 * 1024, env },
      (err, stdout, stderr) => resolve({
        ok: !err,
        code: err ? (err.code ?? 1) : 0,
        enoent: err?.code === 'ENOENT',
        stdout: String(stdout || ''),
        stderr: String(stderr || '')
      }));
  });
}

export const singingDeps = {
  run: defaultRun,
  fetch: (...a) => globalThis.fetch(...a),
  sleep: (ms) => new Promise((r) => setTimeout(r, ms))
};

// 人声干声峰值分界（0~1）。实测 2026-11-06：纯器乐 take 的 demucs 干声峰值
// ≤0.03（-30dB），正常人声 take ≈0.2（-14dB）——0.05 在两者中间留足余量
const VOCAL_PEAK_MIN = 0.05;

/** （唱歌）/（sing）前缀剥离 → 歌词；没标签时全文即歌词（style 含"唱"触发的场景）。 */
export function parseLyrics(text) {
  const s = String(text ?? '');
  const m = s.match(/^\s*[(（]\s*(唱歌|sing|singing)\s*[)）]\s*/i);
  const lyrics = (m ? s.slice(m[0].length) : s).trim();
  if (!lyrics) throw new Error('（唱歌）标签后面没有歌词——把要唱的词跟在标签后面');
  return lyrics;
}

/** 歌词没有结构标签时垫一个 [verse]：裸歌词容易诱导 ACE-Step 出纯器乐 take
 *  （实测 2026-11-06：结构标签 + 人声提示词才稳定出人声）。已有标签不碰。 */
export function tagLyrics(lyrics) {
  const s = String(lyrics || '').trim();
  if (!s) return s;
  return /\[(verse|chorus|bridge|intro|outro|inst|pre-chorus)\]/i.test(s) ? s : `[verse]\n${s}`;
}

/** style（语气）+ 配置默认 → ACE-Step 风格描述；动作标签先剥掉。
 *  默认文案必须点名"人声演唱"——实测不点名模型就给你出纯器乐。 */
export function buildPrompt(style, cfg) {
  const base = String(cfg?.speech?.singing?.defaultPrompt || '中文流行歌曲，人声演唱，人声清晰，旋律清晰，节奏明快').trim();
  const clean = String(style || '').replace(/[(（][^)）]*[)）]/g, '').replace(/[，,、。\s]+$/, '').trim();
  return clean ? `${clean}，${base}` : base;
}

/** 从训练产物里挑最高轮次的模型（文件名形如 <model>_<epoch>e_<steps>s.pth）。 */
function requireFile(p, hint) {
  if (!fs.existsSync(p)) throw new Error(`歌声链未就绪：缺少 ${p}${hint ? `（${hint}）` : ''}`);
  return p;
}

/** 空闲显存（MB）；拿不到（无 nvidia-smi/非 N 卡）返回 null → 预检自动跳过。 */
async function readFreeVramMb() {
  const r = await singingDeps.run('nvidia-smi',
    ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { timeoutMs: 5000 });
  if (!r.ok) return null;
  const mb = Number(String(r.stdout).trim().split(/\r?\n/)[0]);
  return Number.isFinite(mb) && mb > 0 ? mb : null;
}

/**
 * 全自动唱歌（串行队列版）：跨会话并发时 demucs/RVC/ACE-Step 会抢同一块
 * 12GB 显存（实测 ACE-Step 常驻 ~8GB + RVC ~4GB，叠加必 OOM），所以整条链
 * 一次只跑一个 —— 后来者排队等，ACE-Step 服务端本来也是 pipeline 锁串行。
 * @param {{ text: string, style?: string, cfg: object }} opts
 * @returns {Promise<{ wav: Buffer, voice: string, model: string, mode: string, singing: boolean, forcedPreset: boolean }>}
 */
export function singSong(opts) {
  // 整条链（出歌+分离+RVC）过 rvc.js 的 GPU 互斥锁 —— 和说话变声共用一把锁，
  // 12G 卡上任何两条 GPU 任务并发都会 OOM（实踩 2026-11-06）
  return withGpuLock(() => _singSongInner(opts));
}

// ── 出歌引擎适配器（换唱歌方案 = 在注册表加一个 engine，链路其余不动）────
// 契约：{
//   probe(cfg)                → { online: boolean, base: string }   状态卡用
//   generate({prompt, lyrics, scfg}) → Buffer(mp3)                   出一首歌
// }
// generate 内部自带本引擎的健康检查/参数/超时，失败抛可读 Error。
const POLL_INTERVAL_MS = 5000;
const POLL_DEADLINE_MS = 300000;   // 出歌冷启动都算上，5 分钟余量

const aceStepEngine = {
  id: 'ace-step',
  probe(cfg) {
    const base = String(cfg?.speech?.singing?.acestepBase || 'http://127.0.0.1:8001').replace(/\/+$/, '');
    return singingDeps.fetch(`${base}/health`, { signal: AbortSignal.timeout(800) })
      .then((r) => ({ online: r.ok, base }))
      .catch(() => ({ online: false, base }));
  },
  async generate({ prompt, lyrics, scfg }) {
    const base = String(scfg.acestepBase || 'http://127.0.0.1:8001').replace(/\/+$/, '');
    const audioDuration = Number(scfg.audioDuration) || 45;
    const vocalLanguage = String(scfg.vocalLanguage || 'zh');
    // ⚠ 8 步（turbo 蒸馏默认）不唱词！出的是 "na na na" 式虚词哼唱 —— ASR 实证
    // （2026-11-06：同一歌词 8 步转写="啊"，27 步完整唱出歌词原文）。出歌时长
    // 多花 ~40s，但这是"唱不唱词"的分界线。声音哑/不唱词时先看这里。
    const inferenceSteps = Number(scfg.inferenceSteps) || 27;

    let health = false;
    try {
      const r = await singingDeps.fetch(`${base}/health`, { signal: AbortSignal.timeout(2000) });
      health = r.ok;
    } catch { health = false; }
    if (!health) {
      throw new Error(`歌声链未就绪：ACE-Step 服务没开（${base}）——运行 D:\\ACE-Step-portable\\start_api_server.bat，或双击安装目录 scripts\\start-voice-services.bat 一键起全部语音服务`);
    }

    const create = await singingDeps.fetch(`${base}/release_task`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
      prompt,
      lyrics,
      vocal_language: vocalLanguage,
      inference_steps: inferenceSteps,
      audio_duration: audioDuration,
      batch_size: 1    // 服务端默认 2 个候选，我们只取 entries[0] —— 少一半显存和
                       // 出歌时间（实踩 2026-11-06：batch=2 在 12G 卡上把 diffusion
                       // 挤进系统内存，每步 77s，5 分钟轮询必超时）
    }),
    signal: AbortSignal.timeout(15000)
  }).then((r) => r.json()).catch((e) => { throw new Error(`ACE-Step 建任务失败：${e?.message || e}`); });
  const taskId = create?.data?.task_id;
  if (!taskId) throw new Error(`ACE-Step 建任务失败：${JSON.stringify(create).slice(0, 200)}`);

  const t0 = Date.now();
  let entry = null;
  for (;;) {
    if (Date.now() - t0 > POLL_DEADLINE_MS) throw new Error(`ACE-Step 出歌超时（>${POLL_DEADLINE_MS / 1000}s，任务 ${taskId}）—— 常见原因是显存被占满：ACE-Step 需要约 8GB 空闲显存，不够时会掉进系统内存、慢 20 倍（实踩 2026-11-06，每步 77s）。关掉占显存的程序（游戏/多开的带画面应用），或重启 ACE-Step（start-voice-services.bat）再试`);
    await singingDeps.sleep(POLL_INTERVAL_MS);
    const q = await singingDeps.fetch(`${base}/query_result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task_id_list: [taskId] }),
      signal: AbortSignal.timeout(10000)
    }).then((r) => r.json()).catch(() => null);
    const item = q?.data?.[0];
    if (!item) continue;
    if (item.status === 1) {
      let entries;
      try { entries = JSON.parse(item.result); } catch { entries = null; }
      entry = Array.isArray(entries) ? entries[0] : null;
      if (!entry?.file) throw new Error(`ACE-Step 成功但结果里没有音频：${String(item.result).slice(0, 200)}`);
      break;
    }
    if (item.status === 2) throw new Error(`ACE-Step 出歌失败：${item.progress_text || '未知原因'}`);
    // status 0 = 排队/运行中，继续等
  }

  const songRes = await singingDeps.fetch(base + entry.file, { signal: AbortSignal.timeout(60000) });
  const songBuf = Buffer.from(await songRes.arrayBuffer());
  if (songBuf.length < 1000 || songBuf.slice(0, 1).toString('utf8') === '{') {
    throw new Error(`ACE-Step 音频下载异常（${songBuf.length} 字节）：${songBuf.slice(0, 150).toString('utf8')}`);
  }
  return songBuf;
  },
};

export const SINGING_ENGINES = { 'ace-step': aceStepEngine };

/** 取出歌引擎；未知/未配置回落 ace-step（配置键 speech.singing.engine）。 */
export function getSingingEngine(cfg) {
  const id = String(cfg?.speech?.singing?.engine || 'ace-step').trim().toLowerCase();
  return SINGING_ENGINES[id] || aceStepEngine;
}

async function _singSongInner({ text, style = '', cfg }) {
  const scfg = cfg?.speech?.singing || {};
  const toolkitDir = String(scfg.toolkitDir || 'D:/SVC-toolkit');
  const model = String(scfg.model || 'lochness-voice');

  // ① 本地件预检（同步、免费，最先做——新用户最可能缺的是这些）
  const applioDir = path.join(toolkitDir, 'Applio');
  const demucsExe = path.join(toolkitDir, 'venv', 'Scripts', 'demucs.exe');
  const ffmpegExe = path.join(applioDir, 'ffmpeg.exe');
  const applioPy = path.join(applioDir, 'env', 'python.exe');
  const logDir = path.join(applioDir, 'logs', model);
  requireFile(demucsExe, 'demucs 环境未装（见自测清单「歌声链」章节）');
  requireFile(ffmpegExe, 'Applio 未装全');
  requireFile(applioPy, 'Applio 未装全');
  requireFile(logDir, `RVC 模型 ${model} 未训练（见自测清单）`);
  const pthPath = pickModelPth(logDir, model);
  if (!pthPath) throw new Error(`歌声链未就绪：${logDir} 里没有 ${model}_<轮次>e_*.pth 训练产物`);
  const indexPath = requireFile(path.join(logDir, `${model}.index`), '索引缺失，重跑 Applio index 步骤');

  // ②' 显存预检（实踩 2026-11-06：显存被桌面程序挤爆 → diffusion 掉进系统
  // 内存慢 20 倍 → 5 分钟超时，用户只看到"卡住"；宁可秒级报错先腾显存。
  // 配套：start-voice-services.bat 已设 ACESTEP_OFFLOAD_DIT_TO_CPU=true，
  // 出完歌 DiT 卸回内存，稳态显存不再贴满）
  const freeMb = await readFreeVramMb();
  const minFree = Number(scfg.minFreeVramMb) || 2500;
  if (freeMb !== null && freeMb < minFree) {
    throw new Error(`显存不足（空闲 ${freeMb}MB < 最低 ${minFree}MB）：出歌会被拖慢 20 倍甚至失败——关掉占显存的程序（游戏/多开的画面应用）再试；还不行就重启 ACE-Step（start-voice-services.bat，已在跑的会跳过，先手动关掉黑窗口）`);
  }

  const lyrics = tagLyrics(parseLyrics(text));
  const prompt = buildPrompt(style, cfg);
  const accompaniment = scfg.accompaniment === true;   // 默认清唱
  const engine = getSingingEngine(cfg);

  // ③④ 出歌 + 人声体检 + 分离（最多两抽）：出歌 → demucs 分离 → 量干声峰值。
  //     纯器乐 take（太哑）自动换种子重抽一次，两抽都哑才报错 —— 不然 RVC 对着
  //     哑干声白转一圈，成品几乎听不见（实踩 2026-11-06：6/7 候选是纯器乐）
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'singing-'));
  try {
    let vocalsPath = null, accompPath = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const songBuf = await engine.generate({ prompt, lyrics, scfg });
      const songPath = path.join(tmp, `song${attempt}.mp3`);
      fs.writeFileSync(songPath, songBuf);

      // demucs 人声分离（权重首次经 hf-mirror 下载——直连 huggingface 会被墙，
      // 实踩：超时重试吃满预算；huggingface_hub 认 HF_ENDPOINT，镜像后进 HF 缓存复用）
      const sep = await singingDeps.run(demucsExe,
        ['--two-stems=vocals', '-n', 'htdemucs', '-o', tmp, songPath],
        { cwd: tmp, timeoutMs: 180000, env: { ...process.env, HF_ENDPOINT: 'https://hf-mirror.com' } });
      if (!sep.ok) throw new Error(`demucs 人声分离失败：${(sep.stderr || sep.stdout).slice(-300)}`);
      const v = path.join(tmp, 'htdemucs', `song${attempt}`, 'vocals.wav');
      const a = path.join(tmp, 'htdemucs', `song${attempt}`, 'no_vocals.wav');
      requireFile(v, 'demucs 输出结构变了');
      requireFile(a, 'demucs 输出结构变了');

      const peak = wavPeak(fs.readFileSync(v));
      const tooQuiet = peak !== null && peak < VOCAL_PEAK_MIN;
      if (tooQuiet && attempt < 2) continue;   // 哑 take，重抽（服务端每次随机种子）
      if (tooQuiet) {
        throw new Error(`连抽两首都是纯器乐（人声干声峰值约 ${Math.round(20 * Math.log10(peak))}dB）——ACE-Step 没开口唱。确认 speech.singing.defaultPrompt 里有"人声演唱"字样（配置默认已带），重启 ACE-Step 后再试`);
      }
      vocalsPath = v;
      accompPath = a;
      break;
    }

    // RVC 音色转换（说话/唱歌共用层，见 rvc.js；验收参数内聚在那里）。
    // normalize=false：伴奏路径保持原生增益，amix 1.15 的验收平衡不变；
    // 清唱 normalize=true（-3dB 峰值归一 + afftdn 降噪，用户 A/B 裁决）。
    const converted = await rvcConvert({ inputPath: vocalsPath, model, toolkitDir, normalize: !accompaniment });

    // 出成品：清唱 = rvcConvert 产物直接用；带伴奏 = 人声 +1.5dB 混回原伴奏
    let wav;
    if (accompaniment) {
      const convertedPath = path.join(tmp, 'converted.wav');
      fs.writeFileSync(convertedPath, converted);
      const finalPath = path.join(tmp, 'final.wav');
      const mix = await singingDeps.run(ffmpegExe, [
        '-y', '-i', convertedPath, '-i', accompPath,
        '-filter_complex', '[0:a]volume=1.15[v];[v][1:a]amix=inputs=2:duration=longest:dropout_transition=2[aout]',
        '-map', '[aout]', '-ar', '44100', '-ac', '2', finalPath
      ], { cwd: tmp, timeoutMs: 60000 });
      if (!mix.ok || !fs.existsSync(finalPath)) {
        throw new Error(`ffmpeg 混音失败：${(mix.stderr || mix.stdout).slice(-300)}`);
      }
      wav = fs.readFileSync(finalPath);
    } else {
      wav = converted;
    }
    if (wav.length < 1000 || wav.slice(0, 4).toString('ascii') !== 'RIFF') {
      throw new Error('歌声链输出不是合法 WAV');
    }
    return {
      wav,
      voice: '克隆歌声',                       // RVC 转写后的克隆说话音色
      model: `ace-step+rvc:${model}`,
      mode: 'clone',                           // 唱的就是克隆音色（本链的存在意义）
      singing: true,
      forcedPreset: false                      // 不再是"预置音色凑合唱"
    };
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 清不掉不致命 */ }
  }
}

/** 歌声链是否启用（tts.js 路由 / UI 能力显示共用一个判据）。 */
export function singingEnabled(cfg) {
  return cfg?.speech?.singing?.enabled === true;
}
