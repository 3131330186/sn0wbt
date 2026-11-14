// RVC 真声重训 · 一键脚本（维护者/测试者通用）
//
// 背景：歌声链的 RVC 音色模型如果用合成语料（GPT-SoVITS 复读）训练，
// 天花板就是"像但不是人"——没有真人呼吸/气声/力度。补 10 分钟真人录音
// 重训是唯一能动这个根子的手段（实踩定论 2026-11-06）。
//
// 用法（装了 Node.js；没装用 ELECTRON_RUN_AS_NODE=1 + QQ Agent.exe 跑）：
//   node scripts/train-rvc-realvoice.mjs <录音文件或目录>... [--model 名字]
//       [--epochs 300] [--until qc|prep|preprocess|extract|train|index]
//       [--force] [--force-vram]
// 录音格式不限（wav/mp3/m4a 都吃，ffmpeg 自动转）。
//
// 步骤（每步有产物就跳过，断点续跑；--force 全部重做）：
//   qc         质检：时长/响度/削波（总量 <8 分钟直接拦下）
//   prep       备料：统一转 44.1k/16bit/单声道 wav 到 D:/SVC-toolkit/corpus-real/<model>/
//   preprocess Applio 切片+预处理（cut Automatic 自动切长录音）
//   extract    rmvpe 提取音高特征
//   train      训练（默认 300 轮，约 1.5~2 小时；显存预检 ≥11GB）
//   index      建检索索引
// 完成：data/config.json 的 speech.singing.model 改成 --model 的名字，重启生效。
import fs from 'node:fs';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

// ── 参数 ──
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  if (i < 0 || !args[i + 1]) return dflt;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const MODEL = String(argOf('--model', 'lochness-real'));
const EPOCHS = Number(argOf('--epochs', 300));
const UNTIL = String(argOf('--until', 'index'));
const FORCE = args.includes('--force');
const FORCE_VRAM = args.includes('--force-vram');
const inputs = args.filter((a) => !a.startsWith('--')).map((p) => path.resolve(p));
const TOOLKIT = path.resolve(String(argOf('--toolkit', 'D:/SVC-toolkit')));
const APPLIO = path.join(TOOLKIT, 'Applio');
const FFMPEG = process.env.FFMPEG_PATH || path.join(APPLIO, 'ffmpeg.exe');
const PY = path.join(APPLIO, 'env', 'python.exe');
const CORPUS = path.join(TOOLKIT, 'corpus-real', MODEL);
const MODEL_DIR = path.join(APPLIO, 'logs', MODEL);
const STEP_ORDER = ['qc', 'prep', 'preprocess', 'extract', 'train', 'index'];

const say = (m) => console.log(m);
const die = (m) => { console.error(`[X] ${m}`); process.exit(1); };
const run = (cmd, a, { cwd, inherit = false } = {}) => new Promise((resolve) => {
  const child = spawn(cmd, a, { cwd, windowsHide: !inherit, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
  let out = '', err = '';
  if (!inherit) {
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
  }
  child.on('close', (code) => resolve({ code, out, err }));
});

if (!inputs.length) die('用法：node scripts/train-rvc-realvoice.mjs <录音文件或目录>... [--model lochness-real]');
if (!fs.existsSync(FFMPEG)) die(`找不到 ffmpeg：${FFMPEG}`);
if (!fs.existsSync(PY)) die(`找不到 Applio：${PY}`);
if (!STEP_ORDER.includes(UNTIL)) die(`--until 只能是 ${STEP_ORDER.join('/')}`);
const wantStep = (s) => STEP_ORDER.indexOf(s) <= STEP_ORDER.indexOf(UNTIL);

// ── [1] qc 质检 ──
function collectFiles() {
  const files = [];
  for (const p of inputs) {
    const st = fs.statSync(p);
    if (st.isDirectory()) for (const f of fs.readdirSync(p)) files.push(path.join(p, f));
    else files.push(p);
  }
  const audio = files.filter((f) => /\.(wav|mp3|m4a|flac|ogg|aac)$/i.test(f));
  if (!audio.length) die('输入里没有音频文件（支持 wav/mp3/m4a/flac/ogg/aac）');
  return audio.sort();
}

async function qc() {
  const files = collectFiles();
  say(`\n== [1/6] 质检（${files.length} 个文件）==`);
  let totalSec = 0; const problems = [];
  for (const f of files) {
    const r = await run(FFMPEG, ['-hide_banner', '-i', f, '-af', 'volumedetect', '-f', 'null', '-']);
    const dur = /Duration: (\d+):(\d+):([\d.]+)/.exec(r.err);
    const mean = /mean_volume: ([-\d.]+) dB/.exec(r.err);
    const max = /max_volume: ([-\d.]+) dB/.exec(r.err);
    if (!dur) { problems.push(`${path.basename(f)}：读不出时长（损坏/非音频？）`); continue; }
    const sec = Number(dur[1]) * 3600 + Number(dur[2]) * 60 + Number(dur[3]);
    totalSec += sec;
    if (max && Number(max[1]) > -0.5) problems.push(`${path.basename(f)}：峰值 ${max[1]}dB，疑似削波，重录这段`);
    if (mean && Number(mean[1]) < -30) problems.push(`${path.basename(f)}：平均 ${mean[1]}dB 太轻，录得太远/太小声`);
    say(`  ${path.basename(f)}  ${Math.round(sec)}s  mean=${mean?.[1] ?? '?'}dB max=${max?.[1] ?? '?'}dB`);
  }
  say(`  合计 ${Math.round(totalSec)}s（${(totalSec / 60).toFixed(1)} 分钟）`);
  if (totalSec < 480) die(`真声语料不足 8 分钟（现在 ${(totalSec / 60).toFixed(1)} 分钟）——照《朗读稿-训练语料.txt》多录一点再跑`);
  for (const p of problems) say(`  [!] ${p}`);
  if (problems.length) say('  （上面 [!] 是提醒不是拦截；削波/太轻的段落建议重录）');
}

// ── [2] prep 备料 ──
async function prep() {
  say('\n== [2/6] 备料（统一 44.1k/16bit/单声道 wav）==');
  fs.mkdirSync(CORPUS, { recursive: true });
  const files = collectFiles();
  for (let i = 0; i < files.length; i++) {
    const out = path.join(CORPUS, `rec-${String(i + 1).padStart(3, '0')}.wav`);
    if (!FORCE && fs.existsSync(out)) { say(`  跳过（已存在）${path.basename(out)}`); continue; }
    // 备料同时 FFT 降噪：源录音的宽带底噪/电流声会被音色模型学进去
    // （实踩 2026-11-06，用户裁决 afftdn 有效），语料先洗再训
    const r = await run(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-i', files[i],
      '-af', 'afftdn=nr=12:nf=-25', '-ac', '1', '-ar', '44100', '-c:a', 'pcm_s16le', out]);
    if (r.code !== 0) die(`转码失败 ${path.basename(files[i])}：${r.err.slice(-200)}`);
    say(`  ${path.basename(files[i])} → ${path.basename(out)}`);
  }
  const n = fs.readdirSync(CORPUS).filter((f) => f.endsWith('.wav')).length;
  say(`  语料目录：${CORPUS}（${n} 个 wav）`);
}

const applioStep = (sub, a, inherit = false) => run(PY, ['core.py', sub, ...a], { cwd: APPLIO, inherit });
const modelDirHas = (re) => fs.existsSync(MODEL_DIR) && fs.readdirSync(MODEL_DIR).some((f) => re.test(f));
const subDirHas = (name) => { const d = path.join(MODEL_DIR, name); return fs.existsSync(d) && fs.readdirSync(d).length > 0; };

// ── [3] preprocess ──
async function preprocess() {
  // Applio 的切片产物在 logs/<model>/sliced_audios/，config.json 也是它写完才有
  if (!FORCE && subDirHas('sliced_audios') && fs.existsSync(path.join(MODEL_DIR, 'config.json'))) {
    say('\n== [3/6] preprocess：已切好片，跳过（--force 重做）=='); return;
  }
  say('\n== [3/6] Applio preprocess（自动切片）==');
  const r = await applioStep('preprocess', ['--model-name', MODEL, '--dataset-path', CORPUS,
    '--sample-rate', '40000', '--cut-preprocess', 'Automatic', '--cpu-cores', '12',
    '--normalization-mode', 'pre']);   // 真人录音响度不齐/有削波段，逐块归一压平
  if (r.code !== 0 || !subDirHas('sliced_audios')) {
    die(`preprocess 没有产出切片（退出码 ${r.code}）——Applio 失败也返回 0，以产物为准：${(r.err || r.out).slice(-300)}`);
  }
  say(r.out.trim().split('\n').slice(-3).join('\n'));
}

// ── [4] extract ──
async function extract() {
  // 特征产物在 logs/<model>/f0/ 子目录
  if (!FORCE && subDirHas('f0')) { say('\n== [4/6] extract：已提特征，跳过（--force 重做）=='); return; }
  say('\n== [4/6] Applio extract（rmvpe 提取音高特征）==');
  const r = await applioStep('extract', ['--model-name', MODEL, '--f0-method', 'rmvpe',
    '--cpu-cores', '12', '--gpu', '0', '--sample-rate', '40000']);
  if (r.code !== 0 || !subDirHas('f0')) {
    die(`extract 没有产出特征（退出码 ${r.code}），以产物为准：${(r.err || r.out).slice(-300)}`);
  }
  say(r.out.trim().split('\n').slice(-3).join('\n'));
}

// ── [5] train ──
async function freeVramMb() {
  const r = await run('nvidia-smi', ['--query-gpu=memory.free', '--format=csv,noheader,nounits']);
  if (r.code !== 0) return null;
  const v = Number(r.out.trim().split(/\r?\n/)[0]);
  return Number.isFinite(v) ? v : null;
}

async function train() {
  const pthRe = new RegExp(`^${MODEL}_\\d+e_\\d+s\\.pth$`);
  if (!FORCE && modelDirHas(pthRe)) {
    say('\n== [5/6] train：已有训练产物，跳过（--force 重训）==');
    return;
  }
  if (!fs.existsSync(path.join(MODEL_DIR, 'config.json'))) {
    die(`缺 ${path.join(MODEL_DIR, 'config.json')} —— preprocess/extract 没跑完整（多半是上次中断的残局）。删掉 ${MODEL_DIR} 整个目录重跑即可`);
  }
  say(`\n== [5/6] Applio train（${EPOCHS} 轮，约 1.5~2 小时，窗口保持开着）==`);
  const free = await freeVramMb();
  if (free !== null && free < 11000 && !FORCE_VRAM) {
    die(`空闲显存 ${free}MB < 训练需要的 ~11GB。先关掉 ACE-Step / GPT-SoVITS 的黑窗口\n` +
        '    （唱歌链的 start-voice-services.bat 训练完再双击起来），或加 --force-vram 硬闯');
  }
  const r = await applioStep('train', ['--model-name', MODEL, '--total-epoch', String(EPOCHS),
    '--sample-rate', '40000', '--batch-size', '8', '--gpu', '0', '--save-every-epoch', '50', '--pretrained'], true);
  // ⚠ Applio 失败也返回退出码 0（实踩 2026-11-06："Training failed" 后照样 exit 0）
  //   —— 成败只能看产物：logs/<model>/<model>_<N>e_<M>s.pth
  if (!modelDirHas(pthRe)) die(`train 没有产出 .pth（Applio 退出码 ${r.code}，它失败也返回 0，看上面输出找原因）`);
}

// ── [6] index ──
async function index() {
  const idx = path.join(MODEL_DIR, `${MODEL}.index`);
  if (!FORCE && fs.existsSync(idx)) {
    say('\n== [6/6] index：索引已存在，跳过（--force 重做）==');
  } else {
    say('\n== [6/6] Applio index（建检索索引）==');
    const r = await applioStep('index', ['--model-name', MODEL, '--index-algorithm', 'Auto']);
    if (!fs.existsSync(idx)) die(`index 没有产出 ${MODEL}.index（退出码 ${r.code}），以产物为准：${(r.err || r.out).slice(-300)}`);
  }
  say(`\n[OK] 模型 ${MODEL} 就绪：${MODEL_DIR}`);
  say('  下一步：data/config.json 的 speech.singing.model 改为 "' + MODEL + '"，重启 QQ Agent');
  say('  （让维护者操作也行；老模型 ' + 'lochness-voice' + ' 保留着，随时能切回去）');
}

for (const [name, fn] of [['qc', qc], ['prep', prep], ['preprocess', preprocess], ['extract', extract], ['train', train], ['index', index]]) {
  if (wantStep(name)) await fn();
}
if (!wantStep('index')) say(`\n（--until ${UNTIL}：跑到这里停）`);
