// 歌声链 · 训练语料批量生成（装机版，测试者一条命令跑）
//
// 用 GPT-SoVITS（说话用的那套克隆）把参考音色"念"出 220 句中文，
// 产出的 wav 文件夹就是 RVC 训练语料。与仓库内 build-corpus.mjs 同源，
// 这份做成通用版：不依赖开发机路径，从安装目录相对导入 + 读用户配置。
//
// 用法（在安装目录，如 C:\Users\xx\AppData\Local\Programs\QQ Agent\resources\app）：
//   方式一（装了 Node.js）：node scripts\build-singing-corpus.mjs
//   方式二（没装 Node）：
//     set ELECTRON_RUN_AS_NODE=1
//     "C:\...\QQ Agent.exe" resources\app\scripts\build-singing-corpus.mjs
// 可选参数：--out D:\SVC-toolkit\corpus  --count 220  --gptsovits http://127.0.0.1:9880
//
// 前置：GPT-SoVITS 服务在跑（9880）+ 语音页已上传参考音频（克隆音色）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ── 参数 ──
const args = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const COUNT = Number(argOf('--count', 220));
const OUT_DIR = path.resolve(argOf('--out', 'D:/SVC-toolkit/corpus'));
const GPT_BASE = String(argOf('--gptsovits', 'http://127.0.0.1:9880')).replace(/\/+$/, '');

// ── 相对导入安装目录里的语音模块（app 根 = scripts/ 的上一级）──
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { getConfig, DATA_DIR } = await import('file://' + path.join(appRoot, 'src', 'config.js').replace(/\\/g, '/'));
const { readCloneRef, CLONE_REF_DIR } = await import('file://' + path.join(appRoot, 'src', 'speech', 'tts.js').replace(/\\/g, '/'));
const { getAdapter } = await import('file://' + path.join(appRoot, 'src', 'speech', 'adapters', 'index.js').replace(/\\/g, '/'));

const cfg = getConfig();
const cloneRef = readCloneRef(cfg);
if (!cloneRef) {
  console.error('[X] 没找到克隆参考音频：先在控制台语音页上传参考音频（说话克隆用的那段），再跑本脚本');
  process.exit(1);
}
const refAudioPath = path.join(CLONE_REF_DIR, cloneRef.file);
console.log('参考音频:', refAudioPath);
console.log('GPT-SoVITS:', GPT_BASE, '| 语料目标:', COUNT, '句 →', OUT_DIR);

// 语料来源检查：句库与本脚本同目录（sentence 库独立成文件方便扩充）
const SENTENCES = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'singing-corpus-sentences.json'), 'utf8'));
if (!Array.isArray(SENTENCES) || SENTENCES.length < 50) {
  console.error('[X] 句库文件损坏（singing-corpus-sentences.json）');
  process.exit(1);
}

const mod = getAdapter('gpt-sovits');
const ep = { baseUrl: GPT_BASE, apiKey: '' };
fs.mkdirSync(OUT_DIR, { recursive: true });

let ok = 0, fail = 0;
const t0 = Date.now();
for (let i = 0; i < Math.min(COUNT, SENTENCES.length); i++) {
  const text = SENTENCES[i];
  try {
    const out = await mod.synthesize({ text, refAudioPath, ep, cfg, timeoutMs: 60000 });
    const idx = String(i + 1).padStart(4, '0');
    fs.writeFileSync(path.join(OUT_DIR, `clip-${idx}.wav`), out.wav);
    ok++;
    if (ok % 20 === 0) console.log(`进度 ${ok}/${Math.min(COUNT, SENTENCES.length)}（${Math.round((Date.now() - t0) / 1000)}s）`);
  } catch (e) {
    fail++;
    console.log(`clip-${i + 1} 失败: ${String(e?.message || e).slice(0, 80)}`);
    if (fail > 20) { console.error('[X] 失败超过 20 条——GPT-SoVITS 服务可能没开，先启动再重跑'); process.exit(1); }
  }
}
console.log(`语料生成完成：成功 ${ok} / 失败 ${fail}，输出 ${OUT_DIR}，耗时 ${Math.round((Date.now() - t0) / 1000)}s`);
if (ok < 100) {
  console.log('[!] 有效语料不足 100 句 —— 建议排查失败原因后重跑（RVC 训练需要足够素材）');
} else {
  console.log('下一步：按《歌声链安装指南》训练 RVC（preprocess → extract → train → index）');
}
