// 本机 ComfyUI 画图技能（光辉 Illustrious / Anima）+ 中文自动翻译 + 联网查角色卡
//
// 三个档位（profile 设置里选）：
//   illustrious  光辉 WAI-illustrious v14：SDXL 单文件 checkpoint，28 步 / CFG 5
//   anima        Anima Base v1.0 画质模式：三件套 + Qwen3 编码器，30 步 / CFG 4
//   anima-turbo  Anima + 官方 turbo LoRA：**8 步 / CFG 1**，约 18 秒一张，聊天首选
//
// ── v3 新增 ────────────────────────────────────────────────────
// 1. 中文提示词**自动翻译**：不再退回让模型改写，技能自己调 LLM 翻成英文提示词再画。
//    用的是 QQ Agent 自己配的那个 API（读 data/config.json），所以不用额外填 Key。
// 2. **联网查角色卡**：新工具 find_character_tags —— 给个角色名（中文也行），
//    先从 safebooru 的标签库里认准标准角色标签，再抓该角色的样本图统计**高频共现标签**，
//    得到"这个角色靠哪些标签才认得出来"。另外 draw 会自动补上角色的外观标签。
//
// 为什么走 HTTP 而不是读 ComfyUI 的 output 目录：
//   这样技能不需要知道 ComfyUI 装在哪（E:\ComfyUI 还是别的盘），只认一个 baseUrl。
//
// 为什么坚持英文提示词：
//   实测（控制变量）：
//     英文 turbo 8 步 → 樱花、水手服、公园小路全部命中；
//     同样参数换中文 → 场景全丢，退化成通用萌妹 + 毛绒熊；
//     中文 + 30 步 CFG 4 → 变成简笔 Q 版，还把「8K」当成文字画在图上。
//   所以中文现在不是"拒绝"，而是**自动翻成英文**再画。
//
// 依赖：只用到 api.fetch。需要 skill.json 声明 permissions: ["web_fetch"]。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// skills/comfyui-image/ -> skills/ -> app/
const APP_ROOT = path.resolve(HERE, '..', '..');

function resolveDataDir() {
  const fromEnv = String(process.env.QQ_AGENT_DATA_DIR || '').trim();
  if (fromEnv) return fromEnv;
  const a = path.join(APP_ROOT, 'data');
  if (fs.existsSync(a)) return a;
  const b = path.resolve(APP_ROOT, '..', '..', 'data');
  if (fs.existsSync(b)) return b;
  return a;
}

const DATA_DIR = resolveDataDir();

// ── 档位预设（官方推荐参数，见 ComfyUI 官方模板 image_anima_base_v1.json）────
const PROFILES = {
  illustrious: {
    label: '光辉 Illustrious（SDXL 单文件）',
    kind: 'checkpoint',
    steps: 28,
    cfg: 5,
    sampler: 'euler_ancestral',
    scheduler: 'normal',
    prependQuality: true,
    qualityPrefix: 'masterpiece, best quality, amazing quality, very aesthetic, absurdres, newest',
    negative:
      'bad quality, worst quality, worst detail, sketch, censor, jpeg artifacts, lowres, blurry, bad anatomy, bad hands, extra fingers, missing fingers, watermark, signature, text',
    promptStyle: '英文 danbooru 标签，逗号分隔（例如 1girl, solo, silver hair, blue eyes）',
    translateHint: '翻译成英文 danbooru 标签串：逗号分隔的短标签，小写，用下划线连接词组（如 silver_hair）。'
  },
  anima: {
    label: 'Anima Base v1.0 画质模式（30 步）',
    kind: 'anima',
    steps: 30,
    cfg: 4,
    sampler: 'euler',
    scheduler: 'simple',
    prependQuality: false,
    qualityPrefix: '',
    negative: 'worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts, sepia',
    promptStyle: '英文自然语言描述句，逗号分隔的短语（例如 a silver-haired girl standing under cherry blossom trees, soft daylight）',
    translateHint: '翻译成英文自然语言描述句：逗号分隔的短语，像在描述一张画，而不是标签堆（例如 a silver-haired girl standing under cherry blossom trees, soft daylight）。'
  },
  'anima-turbo': {
    label: 'Anima + 官方 Turbo LoRA 极速（8 步，约 18 秒）',
    kind: 'anima-turbo',
    steps: 8,
    cfg: 1,
    sampler: 'euler',
    scheduler: 'simple',
    prependQuality: false,
    qualityPrefix: '',
    negative: 'worst quality, low quality, score_1, score_2, score_3, blurry, jpeg artifacts, sepia',
    promptStyle: '英文自然语言描述句，逗号分隔的短语（例如 a silver-haired girl standing under cherry blossom trees, soft daylight）',
    translateHint: '翻译成英文自然语言描述句：逗号分隔的短语，像在描述一张画，而不是标签堆（例如 a silver-haired girl standing under cherry blossom trees, soft daylight）。'
  }
};

const DEFAULT_PROFILE = 'anima-turbo';

function profileOf(c) {
  const id = String(c?.profile ?? DEFAULT_PROFILE).trim();
  const key = PROFILES[id] ? id : DEFAULT_PROFILE;
  return { id: key, ...PROFILES[key] };
}

// ── 宿主注入的东西 ──────────────────────────────────────────────
let cfg = () => ({});
let log = () => {};
let warn = () => {};
let httpFetch = null;

// 软依赖：找参考图靠 smart-image 提供的 `image.search` 能力。
// 为什么用软依赖（api.capability）而不是 requires：
//   没装「智能配图」时，本技能应该照常能画（降级成纯文生图），
//   绝不该因为少一个可选增强就整个技能变成"依赖未就绪"。
let capability = () => undefined;
let hasCapability = () => false;
const IMAGE_SEARCH_CAP = 'image.search';

// ── 运行期状态 ─────────────────────────────────────────────────
const lastRunAt = new Map();       // 会话冷却
let queueTail = Promise.resolve(); // 出图串行
let startFailures = 0;             // 自动拉起 ComfyUI 的连续失败次数
let llmCache = { at: 0, conf: null };  // LLM 配置缓存（60 秒）

function enqueue(task) {
  const run = queueTail.then(task, task);
  queueTail = run.then(() => {}, () => {});
  return run;
}

// ── 小工具 ─────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 超时保护。
 *
 * 照抄 qzone-post 的同名工具：找参考图是**别人的能力**（smart-image 的多图源引擎），
 * 它慢起来可能是几十秒 —— 不能让它把一次画图的对话轮次拖死。
 */
function withTimeout(promise, ms, label) {
  if (!(ms > 0)) return promise;
  let timer = null;
  return Promise.race([
    Promise.resolve(promise).finally(() => { if (timer) clearTimeout(timer); }),
    new Promise((_, rej) => { timer = setTimeout(() => rej(new Error(`${label}（超过 ${Math.round(ms / 1000)} 秒）`)), ms); })
  ]);
}

function clampInt(value, lo, hi, fallback) {
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function numOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function align64(n) {
  return Math.max(64, Math.round(Number(n) / 64) * 64);
}

const HAS_CJK = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;

async function fetchWithTimeout(url, init = {}, timeoutMs = 20000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    return await httpFetch(url, { ...init, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(url, timeoutMs = 20000) {
  const resp = await fetchWithTimeout(url, { method: 'GET', headers: { Accept: 'application/json' } }, timeoutMs);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.json();
}

// ══════════════════════════════════════════════════════════════
//  一、LLM：中文自动翻译 + 角色名转标签
// ══════════════════════════════════════════════════════════════

/**
 * 读 QQ Agent 自己的 LLM 配置。
 *
 * 为什么不新加一堆"API 地址/Key"设置项：
 *   这台机器上 QQ Agent 本来就已经配好了一个 OpenAI 兼容端点（api.baseUrl/apiKey/model），
 *   技能直接复用就行 —— 少一处配置就少一处会填错的地方，用户也不用再去复制一遍 Key。
 *   要覆盖时用设置里的 llmBaseUrl / llmModel 即可（Key 仍走配置文件）。
 */
function readLlmConfig(c) {
  const now = Date.now();
  let file = {};
  if (!llmCache.conf || now - llmCache.at > 60000) {
    try {
      const raw = fs.readFileSync(path.join(DATA_DIR, 'config.json'), 'utf8');
      const j = JSON.parse(raw);
      file = {
        baseUrl: String(j?.api?.baseUrl || '').replace(/\/+$/, ''),
        apiKey: String(j?.api?.apiKey || ''),
        model: String(j?.api?.model || ''),
        // 视觉模型：外观提取要用它读参考图（api.vision=false 时视为不可用）
        visionModel: String(j?.api?.visionModel || '') || String(j?.api?.model || ''),
        vision: j?.api?.vision !== false
      };
    } catch (error) {
      warn(`读取 data/config.json 失败（翻译功能可能不可用）：${error?.message ?? error}`);
      file = { baseUrl: '', apiKey: '', model: '', visionModel: '', vision: true };
    }
    llmCache = { at: now, conf: file };
  } else {
    file = llmCache.conf;
  }

  const baseUrl = String(c?.llmBaseUrl || '').trim().replace(/\/+$/, '') || file.baseUrl;
  const model = String(c?.llmModel || '').trim() || file.model;
  return {
    baseUrl, apiKey: file.apiKey, model,
    visionModel: file.visionModel || model,
    vision: file.vision !== false,
    ok: Boolean(baseUrl && file.apiKey)
  };
}

/**
 * 打一次 chat/completions。
 *
 * 关键点一：**关掉思考**。
 *   本机配的是 deepseek-flash，是推理模型 —— 翻译"银发蓝眼的女孩"这种活儿它也会先
 *   写一长串 reasoning。实测同样内容：开思考 362 输出 token（其中 340 是思考），
 *   关掉思考只要 23 token，结果完全一样。省时间省钱，也避免思考链吃光 token 预算
 *   导致 content 返回空（之前真的踩到过，表现为"翻译失败：LLM 返回空内容"）。
 *   不同端点可能不认 thinking 参数，所以遇到 4xx 就记下来退回不带参数的写法。
 */
let thinkingSupported = null;   // null=还没试过 / true / false

async function llmChatOnce(conf, messages, opts) {
  const body = { model: opts.model || conf.model, messages, temperature: opts.temperature, max_tokens: opts.maxTokens };
  const wantDisable = thinkingSupported !== false;
  if (wantDisable) body.thinking = { type: 'disabled' };

  let resp;
  try {
    resp = await fetchWithTimeout(`${conf.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${conf.apiKey}` },
      body: JSON.stringify(body)
    }, opts.timeoutMs);
  } catch (error) {
    return { ok: false, reason: `LLM 调用失败：${error?.message ?? error}` };
  }

  if (!resp.ok) {
    const t = await resp.text().catch(() => '');
    if (wantDisable && resp.status >= 400 && resp.status < 500) {
      thinkingSupported = false;
      warn(`端点不接受 thinking 参数（HTTP ${resp.status}），改用不关思考的写法重试`);
      return { ok: false, retryWithoutThinking: true, reason: `HTTP ${resp.status}: ${t.slice(0, 150)}` };
    }
    return { ok: false, reason: `LLM HTTP ${resp.status}: ${t.slice(0, 200)}` };
  }

  const j = await resp.json().catch(() => null);
  const ch = j?.choices?.[0];
  const text = ch?.message?.content;
  if (!text || !String(text).trim()) {
    return { ok: false, empty: true, reason: `LLM 返回空内容（finish_reason=${ch?.finish_reason ?? '?'}）` };
  }
  return { ok: true, text: String(text).trim() };
}

/** 带重试的封装：空内容重试一次；thinking 不被支持就退回重试。 */
async function llmChat(messages, { maxTokens = 800, temperature = 0.2, timeoutMs = 60000, model = '' } = {}) {
  const conf = readLlmConfig(cfg() || {});
  if (!conf.ok) {
    return { ok: false, reason: '没有可用的 LLM 配置（data/config.json 里缺 api.baseUrl 或 api.apiKey）' };
  }
  let last = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const r = await llmChatOnce(conf, messages, { maxTokens, temperature, timeoutMs, model });
    if (r.ok) return { ok: true, text: r.text, model: model || conf.model };
    last = r;
    if (r.retryWithoutThinking) continue;      // 立刻换个写法重试
    if (r.empty && attempt < 2) { await sleep(500); continue; }   // 空内容多半是偶发，等一下重试
    break;
  }
  return { ok: false, reason: last?.reason || 'LLM 没给出内容' };
}

/** 去掉 LLM 爱加的解释和引号。 */
function cleanLlmText(text) {
  let s = String(text || '').trim();
  s = s.replace(/^```[a-z]*\s*/i, '').replace(/```\s*$/, '').trim();
  s = s.replace(/^["'「『]+/, '').replace(/["'」』]+$/, '').trim();
  // 有的模型会写「英文：xxx」这种前缀
  s = s.replace(/^(翻译|英文|提示词|prompt|English)\s*[:：]\s*/i, '').trim();
  // 折成一行
  s = s.replace(/\s*\n+\s*/g, ', ').replace(/,\s*,/g, ',').replace(/,\s*$/, '').trim();
  return s;
}

/** 中文（或混写）提示词 → 英文出图提示词。 */
async function translatePrompt(text, p) {
  const sys = '你是 Stable Diffusion 提示词工程师。把用户给的中文画面描述改写成英文出图提示词。' +
    '只输出提示词本身：不要解释、不要引号、不要 markdown、不要换行。' +
    '必须保留原意，不要自己添加画面里没有的人物或情节。' +
    p.translateHint;
  const res = await llmChat([
    { role: 'system', content: sys },
    { role: 'user', content: text }
  ], { maxTokens: 900, temperature: 0.2 });
  if (!res.ok) return res;
  const cleaned = cleanLlmText(res.text);
  if (!cleaned) return { ok: false, reason: 'LLM 翻译结果为空' };
  return { ok: true, text: cleaned, model: res.model };
}

/** 角色名 → danbooru 角色标签（如 初音未来 → hatsune_miku）。 */
async function nameToTag(name) {
  const sys = '你是 danbooru 标签专家。把用户给的角色名转成 danbooru 上的**角色标签**：' +
    '全小写英文，空格换下划线，同名角色要带作品名括号。' +
    '只输出标签本身，不要解释、不要引号、不要换行。' +
    '如果实在不知道这个角色，就输出最接近的英文拼写（同样小写+下划线）。';
  const res = await llmChat([
    { role: 'system', content: sys },
    { role: 'user', content: name }
  ], { maxTokens: 300, temperature: 0 });
  if (!res.ok) return res;
  const tag = cleanLlmText(res.text).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_():'\-]/g, '');
  if (!tag) return { ok: false, reason: 'LLM 没给出可用标签' };
  return { ok: true, text: tag };
}

// ══════════════════════════════════════════════════════════════
//  二、标签库 / 角色卡
// ══════════════════════════════════════════════════════════════

// safebooru 用的是 gelbooru 系 dapi，标签体系和 danbooru 一致。
// 为什么不用 danbooru 官方 API：本机实测 danbooru.donmai.us / gelbooru.com 全部超时不通，
// safebooru.org 通且是同一套标签。要是哪天换成别的镜像，改设置里的「标签库地址」即可。
const DEFAULT_TAG_API = 'https://safebooru.org/index.php';

async function tagApiGet(url, timeoutMs = 25000) {
  const resp = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { 'User-Agent': 'QQAgent/1.0', Accept: 'application/xml,text/xml,*/*' }
  }, timeoutMs);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp.text();
}

function parseTagXml(text) {
  return [...String(text).matchAll(/<tag\b([^>]*?)\/?>/g)].map((m) => ({
    name: /name="([^"]*)"/.exec(m[1])?.[1] || '',
    count: Number(/count="(\d+)"/.exec(m[1])?.[1] || 0),
    type: Number(/type="(\d+)"/.exec(m[1])?.[1] || 0),
    ambiguous: /ambiguous="true"/.test(m[1])
  })).filter((t) => t.name);
}

// danbooru 的 tag type 约定：0=普通 1=画师 3=作品 4=角色
const TYPE_LABEL = { 0: '普通', 1: '画师', 3: '作品', 4: '角色' };

/** 精确查一个标签。 */
async function tagExact(apiBase, name) {
  const url = `${apiBase}?page=dapi&s=tag&q=index&name=${encodeURIComponent(name)}`;
  const tags = parseTagXml(await tagApiGet(url));
  return tags.find((t) => t.name === name) || null;
}

/** 前缀/子串模糊查，按投稿数从多到少排序。 */
async function tagFuzzy(apiBase, term, { prefix = true, limit = 200 } = {}) {
  const pattern = prefix ? `${term}%` : `%${term}%`;
  const url = `${apiBase}?page=dapi&s=tag&q=index&name_pattern=${encodeURIComponent(pattern)}&limit=${limit}`;
  const tags = parseTagXml(await tagApiGet(url));
  return tags.sort((a, b) => b.count - a.count);
}

/**
 * 认准一个角色标签。
 * 顺序很重要：**先精确，再前缀，最后子串**。
 * 因为 dapi 的模糊查询不排序且会被 limit 截断 —— 实测 %miku% 取 1000 条都捞不到
 * hatsune_miku（被别的标签挤掉了），而 hatsune% 前缀查询只有 168 条，排第一的就是它。
 */
async function resolveCharacterTag(apiBase, guess) {
  const tried = [];
  const base = String(guess || '').trim().toLowerCase().replace(/\s+/g, '_');
  if (!base) return { ok: false, reason: '标签为空' };

  const exact = await tagExact(apiBase, base);
  tried.push(`精确 ${base}`);
  if (exact && exact.count > 0) return { ok: true, tag: exact, tried };

  const firstToken = base.split('_')[0];
  if (firstToken.length >= 3) {
    const pref = await tagFuzzy(apiBase, firstToken, { prefix: true, limit: 300 });
    tried.push(`前缀 ${firstToken}%`);
    const best = pref.filter((t) => t.type === 4 && t.count > 0)[0] || pref.filter((t) => t.count > 0)[0];
    if (best) {
      // 前缀查出来的第一名必须"像"目标，否则宁可算没找到（避免把 miku 认成 mikuma）
      const key = firstToken.replace(/[^a-z0-9]/g, '');
      const hit = best.name.replace(/[^a-z0-9]/g, '');
      if (hit.includes(key.slice(0, Math.max(3, key.length - 1)))) {
        return { ok: true, tag: best, tried, resolvedBy: `前缀 ${firstToken}%`, alternatives: pref.slice(0, 6) };
      }
    }
  }

  if (base.length >= 4) {
    const sub = await tagFuzzy(apiBase, base, { prefix: false, limit: 1000 });
    tried.push(`子串 %${base}%`);
    const best = sub.filter((t) => t.type === 4 && t.count > 0)[0];
    if (best) return { ok: true, tag: best, tried, resolvedBy: `子串 %${base}%`, alternatives: sub.slice(0, 6) };
  }

  return { ok: false, reason: `标签库里找不到「${guess}」`, tried };
}

// 统计角色卡时要滤掉的"元标签"：它们跟角色长相无关，会污染共现统计
const META_TAGS = new Set([
  'highres', 'absurdres', 'lowres', 'commentary', 'commentary_request', 'translated',
  'chinese_commentary', 'english_commentary', 'korean_commentary', 'bad_id', 'bad_pixiv_id',
  'bad_twitter_id', 'bad_deviantart_id', 'bad_link', 'bad_source', 'twitter_username',
  'pixiv_username', 'web_address', 'artist_name', 'artist_request', 'watermark', 'signature',
  'english_text', 'chinese_text', 'speech_bubble', '1girl', '2girls', '3girls', '1boy',
  '2boys', 'multiple_girls', 'multiple_boys', 'solo', 'solo_focus', 'safe', 'questionable',
  'explicit', 'general', 'sensitive', 'spoilers', 'variant_set', 'alternate_costume',
  'alternate_hairstyle', 'traditional_media', 'sketch', 'monochrome', 'greyscale',
  'greyscale_with_colored_background', 'from_behind', 'from_side', 'looking_at_viewer',
  'standing', 'sitting', 'smile', 'open_mouth', 'closed_mouth', 'blush', 'simple_background',
  'white_background', 'transparent_background', 'out_of_frame', 'crossover', 'meme',
  'reference', 'parody', 'third-party', 'bad_anatomy', 'bad_hands'
]);

// 只自动补"外观类"标签 —— 它们是"让人认出这个角色"的关键，且不会和用户要的服装/动作打架
const APPEARANCE_RE = /(hair|eyes|twintails|ponytail|braid|ahoge|bangs|sidelocks|heterochromia|freckles|skin|horns|animal_ears|halo|wings)/;

/**
 * 角色卡 = 该角色样本图里的高频共现标签。
 *
 * 为什么用"统计共现"而不是查百科：
 *   本机 wikipedia / danbooru wiki 都不通，而 dapi 的 post 接口每条都带完整 tags 字段。
 *   抓 N 张该角色的图统计一下，得到的正是"画师们默认会给这个角色加哪些标签" ——
 *   实测初音前十是 vocaloid / twintails / aqua_hair / aqua_eyes / necktie / detached_sleeves，
 *   比任何百科都贴近实际出图需要。
 */
async function buildCharacterCard(apiBase, tag, sample, topN) {
  const url = `${apiBase}?page=dapi&s=post&q=index&limit=${sample}&tags=${encodeURIComponent(tag)}`;
  const xml = await tagApiGet(url, 35000);
  const posts = [...xml.matchAll(/<post\b[^>]*\btags="([^"]*)"/g)].map((m) => m[1]);
  if (!posts.length) return { samples: 0, ranked: [] };

  const freq = new Map();
  for (const line of posts) {
    for (const t of line.trim().split(/\s+/)) {
      if (!t || t === tag || META_TAGS.has(t)) continue;
      freq.set(t, (freq.get(t) || 0) + 1);
    }
  }
  const ranked = [...freq.entries()]
    .map(([name, n]) => ({ name, n, ratio: n / posts.length }))
    .sort((a, b) => b.n - a.n)
    .slice(0, topN);
  return { samples: posts.length, ranked };
}

// ══════════════════════════════════════════════════════════════
//  三、ComfyUI 侧
// ══════════════════════════════════════════════════════════════

async function loaderOptions(base, node, field) {
  try {
    const info = await getJson(`${base}/object_info/${node}`, 25000);
    const list = info?.[node]?.input?.required?.[field]?.[0];
    return Array.isArray(list) ? list.map(String) : [];
  } catch {
    return null;
  }
}

function collectImages(historyEntry) {
  const out = [];
  for (const nodeOut of Object.values(historyEntry?.outputs || {})) {
    for (const img of nodeOut?.images || []) if (img && img.filename) out.push(img);
  }
  return out;
}

async function pingComfy(base, timeoutMs = 8000) {
  try {
    await getJson(`${base}/system_stats`, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

/**
 * 自动拉起本机 ComfyUI。
 * 为什么不去跑 启动ComfyUI.bat：那个 bat 带 --windows-standalone-build 会**弹浏览器**，
 * 群里说句话桌面上就蹦出个浏览器太惊悚。这里用 python 起，windowsHide 关窗口，
 * 输出写进 data/logs/comfyui.log（照抄 voice 技能：stdio 用 'ignore' 的话，
 * 「起不来」就变成一个没有原因的谜）。
 */
async function startComfyUI(c, base) {
  const dir = String(c.comfyuiDir || '').trim();
  if (!dir) {
    return { ok: false, reason: 'ComfyUI 没在运行，而且技能设置里没填「ComfyUI 安装目录」，无法自动拉起。请手动双击 E:\\ComfyUI\\启动ComfyUI.bat。' };
  }
  const py = path.join(dir, 'venv', 'Scripts', 'python.exe');
  const appDir = path.join(dir, 'ComfyUI');
  if (!fs.existsSync(py)) return { ok: false, reason: `找不到 Python：${py}。请检查技能设置里的「ComfyUI 安装目录」。` };
  if (!fs.existsSync(path.join(appDir, 'main.py'))) return { ok: false, reason: `找不到 ${path.join(appDir, 'main.py')}。请检查技能设置里的「ComfyUI 安装目录」。` };

  let host = '127.0.0.1';
  let port = '8188';
  try {
    const u = new URL(base);
    host = u.hostname || host;
    port = u.port || port;
  } catch { /* 用默认 */ }

  const gitCmd = path.join(dir, 'git', 'cmd');
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUNBUFFERED: '1' };
  if (fs.existsSync(path.join(gitCmd, 'git.exe'))) {
    env.PATH = `${gitCmd};${process.env.PATH || ''}`;
    env.GIT_PYTHON_GIT_EXECUTABLE = path.join(gitCmd, 'git.exe');
  }

  const logFile = path.join(DATA_DIR, 'logs', 'comfyui.log');
  let outFd = null;
  try {
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    outFd = fs.openSync(logFile, 'a');
  } catch { outFd = null; }

  const args = ['-s', 'main.py', '--listen', host, '--port', String(port),
    '--preview-method', 'auto', '--enable-manager', '--disable-auto-launch'];

  let child;
  try {
    child = spawn(py, args, {
      cwd: appDir, detached: false,
      stdio: outFd === null ? 'ignore' : ['ignore', outFd, outFd],
      windowsHide: true, env
    });
  } catch (error) {
    return { ok: false, reason: `启动 ComfyUI 失败：${error?.message ?? error}` };
  } finally {
    if (outFd !== null) { try { fs.closeSync(outFd); } catch { /* ignore */ } }
  }

  child.once('error', (e) => warn(`ComfyUI 子进程出错：${e?.message ?? e}`));
  child.unref?.();
  log(`已拉起 ComfyUI（pid ${child.pid}），日志：${logFile}`);

  const waitSec = Math.max(30, Number(c.startupTimeoutSec) || 180);
  const deadline = Date.now() + waitSec * 1000;
  while (Date.now() < deadline) {
    if (await pingComfy(base, 3000)) {
      await sleep(1500);   // /system_stats 先于节点表就绪，缓一下再查 /object_info
      return { ok: true };
    }
    if (child.exitCode !== null && child.exitCode !== undefined) {
      return { ok: false, reason: `ComfyUI 启动后立刻退出了（退出码 ${child.exitCode}）。原因看日志：${logFile}` };
    }
    await sleep(1500);
  }
  return { ok: false, reason: `等了 ${waitSec} 秒 ComfyUI 还是没起来。日志：${logFile}` };
}

async function resolveModels(base, p, c) {
  if (p.kind === 'checkpoint') {
    const available = await loaderOptions(base, 'CheckpointLoaderSimple', 'ckpt_name');
    if (available === null) {
      const fallback = String(c.checkpoint || '').trim();
      if (!fallback) return { ok: false, error: '读取 ComfyUI 模型列表失败，且技能设置里没填「光辉大模型文件名」。' };
      return { ok: true, files: { checkpoint: fallback } };
    }
    if (!available.length) return { ok: false, error: 'ComfyUI 里一个 checkpoint 都没有。请把大模型放进 E:\\ComfyUI\\ComfyUI\\models\\checkpoints\\ 后重启 ComfyUI。' };
    let checkpoint = String(c.checkpoint || '').trim();
    if (!checkpoint || !available.includes(checkpoint)) {
      if (c.autoPickCheckpoint === false && checkpoint) {
        return { ok: false, error: `ComfyUI 里找不到模型「${checkpoint}」。当前可用：${available.join('、')}。请在技能设置里改成其中之一。` };
      }
      const picked = available[0];
      if (checkpoint) warn(`模型「${checkpoint}」不在 ComfyUI 里，自动改用「${picked}」`);
      else log(`未配置模型，自动使用「${picked}」`);
      checkpoint = picked;
    }
    return { ok: true, files: { checkpoint } };
  }

  const [unets, clips, vaes, loras] = await Promise.all([
    loaderOptions(base, 'UNETLoader', 'unet_name'),
    loaderOptions(base, 'CLIPLoader', 'clip_name'),
    loaderOptions(base, 'VAELoader', 'vae_name'),
    p.kind === 'anima-turbo' ? loaderOptions(base, 'LoraLoaderModelOnly', 'lora_name') : Promise.resolve(null)
  ]);
  if (unets === null || clips === null || vaes === null) {
    return { ok: false, error: '读取 ComfyUI 节点信息失败，无法确认 Anima 需要的模型文件。请确认 ComfyUI 正在运行且版本支持 Anima。' };
  }

  const need = [
    ['扩散模型', 'animaUnet', 'anima-base-v1.0.safetensors', unets, 'diffusion_models', 'unet'],
    ['文本编码器', 'animaClip', 'qwen_3_06b_base.safetensors', clips, 'text_encoders', 'clip'],
    ['VAE', 'animaVae', 'qwen_image_vae.safetensors', vaes, 'vae', 'vae']
  ];
  const picked = {};
  for (const [label, settingKey, dflt, avail, folder, key] of need) {
    let want = String(c[settingKey] || dflt).trim();
    if (!avail.includes(want)) {
      if (!avail.length) return { ok: false, error: `ComfyUI 的 models\\${folder}\\ 里没有可用的${label}。请把 Anima 的模型文件放进去后重启 ComfyUI。` };
      if (String(c[settingKey] || '').trim()) warn(`${label}「${want}」不在 ComfyUI 里，自动改用「${avail[0]}」`);
      want = avail[0];
    }
    picked[key] = want;
  }

  if (p.kind === 'anima-turbo') {
    let lora = String(c.animaTurboLora || 'anima-turbo-lora-v0.2.safetensors').trim();
    if (loras === null || !loras.includes(lora)) {
      if (loras && loras.length) {
        warn(`Turbo LoRA「${lora}」不在 loras 目录里，自动改用「${loras[0]}」`);
        lora = loras[0];
      } else {
        return { ok: false, error: '极速模式需要 turbo LoRA，但 ComfyUI 的 models\\loras\\ 里没有。请放入 anima-turbo-lora-v0.2.safetensors，或把档位改成「Anima 画质模式」。' };
      }
    }
    picked.lora = lora;
  }
  return { ok: true, files: picked };
}

// ══════════════════════════════════════════════════════════════
//  参考图（v4）：找图 → 送进 ComfyUI → img2img
// ══════════════════════════════════════════════════════════════
//
// 为什么要有这一段：
//   在 v3 之前，本技能只能"凭文字画"。想画得准只能靠 find_character_tags 补**文字标签**
//   （角色的发色瞳色等）—— 但那是"描述"，不是"照着画"。
//   而 smart-image 早就提供了一个很合适的出口 `image.search`：它返回**已下载校验过的
//   本地文件路径 + 实测宽高**，正是 LoadImage 需要的东西。此前只有 qzone-post 在消费它。
//   这一段就是把这座桥接上：拿到参考图 → 上传给 ComfyUI → 走 img2img（denoise < 1）。
//
// 为什么不用 IPAdapter / ControlNet 做"风格参考"：
//   那两个是自定义节点，本机 ComfyUI 没装（只有核心节点）。img2img 是**核心节点就能做**的，
//   零额外依赖，先把这条路走通；以后装了 IPAdapter 再在 buildWorkflow 里加分支即可。

/**
 * 按参考图比例算出出图尺寸。
 *
 * 为什么要这一步：img2img 如果硬用 1024x1024 去套一张 3:4 的竖图，
 * ImageScale 会把它压扁（crop 只能裁不能补），画出来的人比例就歪了。
 * 所以用参考图的实际宽高比等比缩放。
 *
 * 缩放基准是**调用方配的默认尺寸**（targetW/targetH），不是 maxWidth/maxHeight：
 *   maxW/maxH 是"6GB 显存的安全边界"，是**保险丝**，不是目标值。
 *   曾经的写法直接往上限套 —— 一张 1600x1600 的参考图会被顶到 1536x1536，
 *   等于每次都拿用户的默认配置去撞显存红线。现在默认框是 1024，参考图再大也只到 1024。
 *   想要更大分辨率，由调用方显式传 size 决定。
 */
function fitSizeInto(srcW, srcH, targetW, targetH, maxW, maxH) {
  const w0 = Number(srcW) || 0;
  const h0 = Number(srcH) || 0;
  const tw = Number(targetW) > 0 ? Number(targetW) : 1024;
  const th = Number(targetH) > 0 ? Number(targetH) : 1024;
  if (!(w0 > 0 && h0 > 0)) return null;

  // ① 等比缩放进"默认尺寸"这个框，同时不越过显存上限
  let k = Math.min(tw / w0, th / h0, maxW / w0, maxH / h0);
  let w = w0 * k;
  let h = h0 * k;

  // ② 短边不足 512 时整体放大（等比，不变形）—— 太小的话 img2img 出不来细节
  const shortSide = Math.min(w, h);
  if (shortSide > 0 && shortSide < 512) {
    const k2 = 512 / shortSide;
    if (w * k2 <= maxW && h * k2 <= maxH) { w *= k2; h *= k2; }
  }

  // ③ 对齐到 64 并夹进上限。极端长宽比（如 4:1）在这步可能短边偏小，属可接受
  const align = (v, max) => Math.max(64, Math.min(max, Math.round(v / 64) * 64));
  return { width: align(w, maxW), height: align(h, maxH) };
}

/**
 * 找一张参考图 —— 走 smart-image 的 `image.search` 能力（只找不发）。
 *
 * 挑图策略：**在短边达标的前提下挑分辨率最高的那张**。
 *   img2img 里参考图太小会直接糊掉（denoise 再低也救不回细节），
 *   所以宁可缩小候选集也不能将就一张 200x150 的缩略图。
 *   短边一个都不达标时放宽（并回报 relaxed，让调用方知道是勉强用的）。
 */
async function findReferenceImage(keyword, c) {
  const count = clampInt(numOr(c.refSearchCount, 6), 1, 12, 6);
  const minShortSide = clampInt(numOr(c.refMinShortSide, 512), 0, 4096, 512);
  const timeoutSec = clampInt(numOr(c.refSearchTimeoutSec, 40), 5, 180, 40);

  let cap;
  try { cap = capability(IMAGE_SEARCH_CAP, { keyword, count, minShortSide }); }
  catch (error) { return { ok: false, reason: `找图能力调用失败：${error?.message ?? error}` }; }
  if (!cap) return { ok: false, reason: '没装/没开「智能配图」技能（找图能力 image.search 由它提供）' };

  let r;
  try { r = await withTimeout(Promise.resolve(cap), timeoutSec * 1000, '找参考图超时'); }
  catch (error) { return { ok: false, reason: error?.message ?? String(error) }; }
  if (!r || typeof r !== 'object') return { ok: false, reason: '找图能力返回了意外的结果' };
  if (!r.ok) return { ok: false, reason: r.error || (r.errors || []).join('；') || '图源没有可用结果' };

  const usable = (r.images || []).filter((im) => im?.file && fs.existsSync(im.file));
  if (!usable.length) return { ok: false, reason: '找图能力没有返回可用的本地文件' };

  const sized = usable.filter((im) => Math.min(Number(im.width) || 0, Number(im.height) || 0) >= minShortSide);
  const pool = (sized.length ? sized : usable).slice();

  // 排序：**pixiv 优先**，其次分辨率高的优先。
  //
  // 为什么 pixiv 要优先（这是实测踩出来的）：
  //   ACG 关键词下 smart-image 会同时给出 pixiv 插画和搜索引擎的"原图"，而后者经常是
  //   **带标题/字幕的 AI 生成图**。实测搜「樱花树下少女」时，纯按面积取最大挑到的百度原图
  //   上面印着「樱花舞动，美人如梦」「搞笑配音」两行字幕 —— 拿它当 img2img 底图，
  //   字幕会被**忠实复现成乱码字母**（画面上真的出现了 MŁCOL SS WE 这种东西），整张图就废了。
  //   pixiv 是真人画的插画，没有这种水印层。
  //   非 ACG 关键词本来就没有 pixiv 结果，自然退回按面积挑。
  const isPixiv = (im) => /pixiv/i.test(String(im.source || '')) || /pixiv/i.test(String(im.url || ''));
  pool.sort((a, b) => {
    const pa = isPixiv(a) ? 1 : 0;
    const pb = isPixiv(b) ? 1 : 0;
    if (pa !== pb) return pb - pa;
    return (Number(b.width) * Number(b.height)) - (Number(a.width) * Number(a.height));
  });
  const best = pool[0];
  return {
    ok: true,
    file: best.file,
    width: Number(best.width) || 0,
    height: Number(best.height) || 0,
    source: String(best.source || ''),
    url: String(best.url || ''),
    pixiv: isPixiv(best),
    candidates: usable.length,
    relaxed: sized.length === 0 && minShortSide > 0
  };
}

/**
 * 把参考图送进 ComfyUI，返回 LoadImage 节点要填的 image 名。
 *
 * 两条路，按顺序尝试：
 *   ① `POST /upload/image` —— **首选**。不依赖本技能知道 ComfyUI 装在哪，
 *      和本文件开头"为什么走 HTTP 而不是读 output 目录"是同一个理由：远端 ComfyUI 也能用。
 *   ② 直接复制到 `<comfyuiDir>\ComfyUI\input\` —— ① 失败时的退路。
 *      （某些 ComfyUI 版本/前置代理会把 multipart 上传挡掉。）
 */
async function sendReferenceToComfy(base, filePath, c) {
  let buf;
  try { buf = fs.readFileSync(filePath); }
  catch (error) { return { ok: false, reason: `读参考图失败：${error?.message ?? error}` }; }
  if (!buf.length) return { ok: false, reason: '参考图是空文件' };

  const ext = (path.extname(filePath) || '.png').toLowerCase();
  // ComfyUI 用 mimetypes 过滤 input 目录，这些都是它能认的图像类型
  const safeExt = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext) ? ext : '.png';
  const name = `qqref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}${safeExt}`;

  // ① 官方上传接口
  try {
    const form = new FormData();
    form.append('image', new Blob([buf]), name);
    form.append('overwrite', 'true');
    const resp = await fetchWithTimeout(`${base}/upload/image`, { method: 'POST', body: form }, 60000);
    if (resp.ok) {
      const j = await resp.json().catch(() => null);
      if (j && j.name) {
        const ref = j.subfolder ? `${j.subfolder}/${j.name}` : j.name;
        log(`参考图已上传到 ComfyUI：${ref}（${Math.round(buf.length / 1024)}KB）`);
        return { ok: true, ref, how: 'upload' };
      }
      warn('/upload/image 返回了 200 但没给文件名，改用复制到 input 目录');
    } else {
      const t = await resp.text().catch(() => '');
      warn(`/upload/image HTTP ${resp.status} ${String(t).slice(0, 120)}，改用复制到 input 目录`);
    }
  } catch (error) {
    warn(`/upload/image 失败（${error?.message ?? error}），改用复制到 input 目录`);
  }

  // ② 退路：复制进 input 目录
  const dir = String(c.comfyuiDir || '').trim();
  if (!dir) return { ok: false, reason: '上传参考图失败，且技能设置里没填「ComfyUI 安装目录」，无法退回复制方案。' };
  // 兼容两种布局：<dir>\ComfyUI\input 和 <dir>\input
  const candidates = [path.join(dir, 'ComfyUI', 'input'), path.join(dir, 'input')];
  const inputDir = candidates.find((p) => fs.existsSync(p));
  if (!inputDir) return { ok: false, reason: `上传参考图失败，且没找到 ComfyUI 的 input 目录（试过：${candidates.join('、')}）` };

  const dest = path.join(inputDir, name);
  try { fs.copyFileSync(filePath, dest); }
  catch (error) { return { ok: false, reason: `复制参考图到 input 目录失败：${error?.message ?? error}` }; }
  log(`参考图已复制到 input 目录：${dest}`);
  return { ok: true, ref: name, how: 'copy' };
}

// ── 角色外观参考图（v4.1）──────────────────────────────────────
//
// 和上面 `ref_keyword`（通用构图参考）的区别：
//   ref_keyword  给一个场景关键词，找"像那么回事"的构图
//   ref_character 给一个**角色名**，找"这个角色本人"的图当外观参考
//
// 为什么角色参考要单独走 booru 而不是复用 image.search：
//   image.search 是关键词搜索，搜「初音未来」可能搜到同人图、CP 图、甚至只是配色像的图。
//   booru 的**标签本身就是保证** —— 打了 `hatsune_miku` 标签的图，就是初音未来。
//   而 safebooru 的 dapi 我们本来就在用（角色卡统计），加个作品查询是顺手的事。
//
// ⚠️ 分级过滤必须用 `rating:safe`（gelbooru 写法）。
//   实测 safebooru 的 dapi **不认** `rating:general`（结果和不过滤几乎一样，全是 q），
//   而默认返回流被 questionable 淹没（实测 hatsune_miku 前 40 张里 39 张是 q）。
//   群里用的机器人随便挑一张就可能出事，所以默认强制 safe。

const CHAR_REF_CACHE = new Map();   // tag -> { at, file, width, height, ... }，避免同一角色反复下载
const CHAR_REF_TTL_MS = 10 * 60 * 1000;

/**
 * 从 booru 的 post XML 里抽出候选图。
 *
 * 优先用 `file_url`（原图，尺寸与 width/height 字段一致）。
 * `sample_url` 只作退路 —— 实测它有时是**裁剪版**（原图 850x1755，sample 只有 850x364），
 * 拿它当外观参考会把角色裁得只剩一半。用 sample 时尺寸要读 sample_width/sample_height。
 */
function parseBooruPosts(xml) {
  const out = [];
  for (const m of String(xml).matchAll(/<post\b[^>]*\/?>/g)) {
    const t = m[0];
    const g = (k) => new RegExp(`${k}="([^"]*)"`).exec(t)?.[1] || '';
    const fileUrl = g('file_url');
    const sampleUrl = g('sample_url');
    const url = fileUrl || sampleUrl;
    if (!url) continue;
    const w = Number(fileUrl ? g('width') : g('sample_width')) || 0;
    const h = Number(fileUrl ? g('height') : g('sample_height')) || 0;
    if (!(w > 0 && h > 0)) continue;
    out.push({ url, width: w, height: h, rating: g('rating'), tags: g('tags'), id: g('id'), viaSample: !fileUrl });
  }
  return out;
}

/**
 * 图片字节 → 落盘。**校验魔数**，避免把 403/HTML 错误页当图片存下来。
 * 返回 { file, ext, bytes }；格式不认识返回 null。
 */
function saveImageBuffer(buf, destDir, prefix) {
  if (!buf || !buf.length) return null;
  const magic = buf.subarray(0, 4).toString('hex').toUpperCase();
  let ext = null;
  if (magic.startsWith('89504E47')) ext = '.png';
  else if (magic.startsWith('47494638')) ext = '.gif';
  else if (magic.startsWith('52494646')) ext = '.webp';
  else if (magic.startsWith('FFD8FF')) ext = '.jpg';
  if (!ext) return null;

  fs.mkdirSync(destDir, { recursive: true });
  const file = path.join(destDir, `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}${ext}`);
  fs.writeFileSync(file, buf);
  return { file, ext, bytes: buf.length };
}

/** 下载一张图到本地（booru 直链用）。 */
async function downloadImage(url, destDir, prefix) {
  const resp = await fetchWithTimeout(url, { method: 'GET', headers: { 'User-Agent': 'QQAgent/1.0' } }, 45000);
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  const buf = Buffer.from(await resp.arrayBuffer());
  if (!buf.length) throw new Error('下载到的是空文件');
  const saved = saveImageBuffer(buf, destDir, prefix);
  if (!saved) throw new Error(`下载到的不是图片（魔数 ${buf.subarray(0, 4).toString('hex').toUpperCase()}，可能是错误页）`);
  return { file: saved.file, bytes: saved.bytes };
}

/** 下载成 Buffer 但不落盘（聊天图先要在内存里读宽高）。失败返回 null，不抛。 */
async function downloadBytes(url) {
  try {
    const resp = await fetchWithTimeout(url, { method: 'GET', headers: { 'User-Agent': 'QQAgent/1.0' } }, 45000);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const buf = Buffer.from(await resp.arrayBuffer());
    return buf.length ? buf : null;
  } catch (error) {
    warn(`下载图片失败（${String(url).slice(0, 80)}）：${error?.message ?? error}`);
    return null;
  }
}

/**
 * 从图片字节的**文件头**读出真实宽高。
 *
 * 为什么需要：聊天里的图片只给了 url/file，**没有宽高**；而 img2img 的尺寸是按参考图比例算的
 * （见 fitSizeInto）—— 拿不到宽高就只能回到默认方形，竖图会被压扁。
 * 拉一个图片库只为读两个数字太重，这里按格式解析头部即可，纯 JS、零依赖。
 * 支持 PNG / JPEG / GIF / WebP，都是本技能会接受的类型。
 */
function readImageSize(buf) {
  try {
    if (!buf || buf.length < 16) return null;
    const b = buf;

    // PNG：89 50 4E 47 0D 0A 1A 0A，IHDR 的宽高在偏移 16 / 20（大端 u32）
    if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    }

    // GIF：'GIF87a' / 'GIF89a'，宽高是小端 u16 @6 / @8
    const head6 = b.toString('ascii', 0, 6);
    if (head6 === 'GIF87a' || head6 === 'GIF89a') {
      return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
    }

    // WebP：'RIFF'....'WEBP'，再按子类型取
    if (b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') {
      const sub = b.toString('ascii', 12, 16);
      if (sub === 'VP8X') return { width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
      if (sub === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
      if (sub === 'VP8L') {
        const bits = b.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
      }
      return null;
    }

    // JPEG：逐段找 SOF（C0~CF，排除 C4/C8/CC），高在 +5、宽在 +7（大端 u16）
    if (b[0] === 0xff && b[1] === 0xd8) {
      let i = 2;
      while (i + 9 < b.length) {
        if (b[i] !== 0xff) { i++; continue; }
        const marker = b[i + 1];
        if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
        const len = b.readUInt16BE(i + 2);
        if (len < 2) return null;
        const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
        if (isSOF) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
        i += 2 + len;
      }
      return null;
    }

    return null;
  } catch { return null; }
}

/**
 * 角色名 → 标准 danbooru 标签（**只解析标签，不下载图**）。
 *
 * 单独拆出来是因为"画成这张图里的初音未来"这种场景：
 * 参考图用群友发的（更准），但**角色标签仍然要解析出来注入 prompt** ——
 * 如果和 findCharacterReference 绑在一起，就会白白多下一张用不上的图。
 */
async function resolveCharacterName(name, c) {
  const apiBase = String(c.tagApiUrl || '').trim() || DEFAULT_TAG_API;
  let guess = String(name).trim();
  let guessed = null;
  if (HAS_CJK.test(guess) || /[A-Z\s]/.test(guess)) {
    const g = await nameToTag(guess);
    if (g.ok) { guess = g.text; guessed = g.text; }
    else warn(`角色名转标签失败（用原名直接查）：${g.reason}`);
  }
  let tag = '';
  try {
    const resolved = await resolveCharacterTag(apiBase, guess);
    if (resolved.ok) tag = resolved.tag.name;
  } catch (error) {
    warn(`查角色标准标签失败（用猜的标签继续）：${error?.message ?? error}`);
  }
  if (!tag) tag = guess.replace(/\s+/g, '_').toLowerCase();
  return { tag, guessed };
}

/**
 * 找某个角色的外观参考图。
 *
 * 流程：角色名 →（中文/英文都行）转标准 danbooru 标签 → 查该标签的作品 → 挑一张 → 下载。
 * 挑图偏好：**短边够大** → **比例像人物立绘**（0.5~1.6）→ 面积大。
 * 查询优先带 `solo`（单角色图，外观最干净），没有再放宽。
 *
 * @param opts.tag 调用方已经解析好的标签（避免重复解析）
 */
async function findCharacterReference(name, c, opts = {}) {
  const apiBase = String(c.tagApiUrl || '').trim() || DEFAULT_TAG_API;
  const safeOnly = c.refRatingSafe !== false;
  const minSide = clampInt(numOr(c.refMinShortSide, 512), 0, 4096, 512);
  const ratingFilter = safeOnly ? ' rating:safe' : '';

  let tag = String(opts.tag || '').trim();
  let guessed = opts.guessed || null;
  if (!tag) {
    const r = await resolveCharacterName(name, c);
    tag = r.tag;
    guessed = r.guessed;
  }
  if (!tag) return { ok: false, reason: '拿不到角色的标准标签' };

  // ② 缓存命中就直接复用（同一角色短时间内反复画不用重复下载）
  const hit = CHAR_REF_CACHE.get(tag);
  if (hit && Date.now() - hit.at < CHAR_REF_TTL_MS && fs.existsSync(hit.file)) {
    log(`命中角色参考图缓存：${tag} → ${hit.file}`);
    return { ...hit, cached: true };
  }

  // ③ 查作品：先 solo（单角色），没有再放宽
  const queries = [`${tag} solo${ratingFilter}`, `${tag}${ratingFilter}`];
  let posts = [];
  let usedQuery = '';
  for (const q of queries) {
    try {
      const url = `${apiBase}?page=dapi&s=post&q=index&limit=40&tags=${encodeURIComponent(q)}`;
      posts = parseBooruPosts(await tagApiGet(url, 30000));
      if (posts.length) { usedQuery = q; break; }
    } catch (error) {
      warn(`查角色作品失败（${q}）：${error?.message ?? error}`);
    }
  }
  if (!posts.length) {
    return {
      ok: false,
      reason: `标签库里没有「${name}」（标签 ${tag}）${safeOnly ? '的 safe 级' : ''}作品`,
      tag
    };
  }

  // ④ 排序：短边达标 → 比例像人物立绘 → 面积大
  const sized = posts.filter((p) => Math.min(p.width, p.height) >= minSide);
  const pool = (sized.length ? sized : posts).slice();
  pool.sort((a, b) => {
    const good = (p) => (p.width / p.height >= 0.5 && p.width / p.height <= 1.6 ? 1 : 0);
    const d = good(b) - good(a);
    if (d !== 0) return d;
    return b.width * b.height - a.width * a.height;
  });

  // ⑤a 只要"验证标签 + 看候选"，不下载。
  //     「只取外观」模式用它：图不下（外观标签由角色卡给出），但**验证不能省** ——
  //     否则 LLM 猜错的标签会被当成标准标签注入 prompt，画出个不存在的东西。
  if (opts.noDownload) {
    const top = pool[0];
    return {
      ok: true,
      file: null,
      width: top.width,
      height: top.height,
      rating: top.rating,
      source: `safebooru/${tag}`,
      tag,
      guessed,
      candidates: pool.length,
      relaxed: sized.length === 0 && minSide > 0,
      query: usedQuery,
      noDownload: true
    };
  }

  // ⑤b 依次尝试下载，直到成功（booru 偶尔给死链）
  const dir = path.join(DATA_DIR, 'ref-images');
  const safeName = `char_${tag.replace(/[^a-z0-9_]/gi, '').slice(0, 40)}`;
  for (const p of pool.slice(0, 5)) {
    try {
      const dl = await downloadImage(p.url, dir, safeName);
      const info = {
        ok: true,
        file: dl.file,
        bytes: dl.bytes,
        width: p.width,
        height: p.height,
        rating: p.rating,
        source: `safebooru/${tag}`,
        tag,
        guessed,
        viaSample: p.viaSample,
        candidates: pool.length,
        relaxed: sized.length === 0 && minSide > 0,
        query: usedQuery
      };
      CHAR_REF_CACHE.set(tag, { at: Date.now(), ...info });
      log(`角色参考图 ${tag}：${p.width}x${p.height} rating=${p.rating}（候选 ${pool.length} 张）→ ${dl.file}`);
      return info;
    } catch (error) {
      warn(`下载候选图失败（${p.url}）：${error?.message ?? error}`);
    }
  }
  return { ok: false, reason: `「${name}」的候选图（${pool.length} 张）全部下载失败`, tag };
}

// ── 聊天里的图片当参考图（v4.2）────────────────────────────────
//
// 群友直接发了一张图、或引用着某张图说「照着这个画」—— 那是**最准的参考**，
// 比任何搜索都准（就是本人给的那张）。而核心早就把这些图存进会话存档了
// （`store` 的 `media` 字段），取字节的路子也是现成的
// （`sticker-manager` 的 get_image 三级回退，见其 #getImageBytes）。

/**
 * 从会话存档的一条媒体记录里取图片字节。
 *
 * 顺序照抄 sticker-manager 的取舍：**协议端缓存（get_image）优先**。
 * 因为消息里的直链有时效，过一阵就 403 了；而协议端本地缓存通常还在，
 * 且 get_image 只认 file id，不受 url 过期影响。
 */
async function getChatImageBytes(ctx, media) {
  if (media.file && ctx?.onebot && typeof ctx.onebot.call === 'function') {
    try {
      const ret = await ctx.onebot.call('get_image', { file: String(media.file) });
      const p = ret?.file && fs.existsSync(String(ret.file)) ? String(ret.file) : '';
      if (p) {
        const buf = fs.readFileSync(p);
        if (buf.length) return buf;
      }
      if (ret?.url) {                       // 有的实现只回可下载 url
        const buf = await downloadBytes(String(ret.url));
        if (buf) return buf;
      }
    } catch (error) {
      warn(`get_image 取聊天图失败（改走直链）：${error?.message ?? error}`);
    }
  }
  if (media.url) {
    const buf = await downloadBytes(String(media.url));
    if (buf) return buf;
  }
  return null;
}

/**
 * 找聊天里的一张图当参考。
 *
 * @param opts.messageId 指定消息 id（聊天记录里每条前的 #数字，可为负）
 * @param opts.recent    true = 用会话里最近一条带图的消息（不知道 id 时的兜底）
 */
async function findChatReference(ctx, c, opts = {}) {
  const store = ctx?.store;
  if (!store || typeof store.findByMid !== 'function') {
    return { ok: false, reason: '拿不到会话存档（ctx.store 不可用）' };
  }

  const wantId = (opts.messageId !== undefined && opts.messageId !== null && String(opts.messageId).trim() !== '')
    ? String(opts.messageId).trim() : '';
  let entry = null;

  if (wantId) {
    entry = store.findByMid(ctx.chatKey, wantId);
    if (!entry) return { ok: false, reason: `当前会话找不到消息 #${wantId}` };
  } else if (opts.recent) {
    const list = (typeof store.recent === 'function' ? store.recent(ctx.chatKey, { limit: 60 }) : []) || [];
    for (let i = list.length - 1; i >= 0; i--) {
      const m = list[i];
      if ((m.media || []).some((x) => x?.kind === 'image' && (x.url || x.file))) { entry = m; break; }
    }
    if (!entry) return { ok: false, reason: '当前会话里最近没有群友发过图片' };
  } else {
    return { ok: false, reason: '没有指定要用哪条消息里的图片' };
  }

  const medias = (entry.media || []).filter((m) => m?.kind === 'image' && (m.url || m.file));
  if (!medias.length) return { ok: false, reason: `消息 #${entry.mid ?? wantId} 里没有图片` };

  const dir = path.join(DATA_DIR, 'ref-images');
  const problems = [];
  for (const m of medias) {
    const buf = await getChatImageBytes(ctx, m);
    if (!buf) { problems.push('取字节失败（缓存过期且直链失效）'); continue; }
    const size = readImageSize(buf);
    const saved = saveImageBuffer(buf, dir, 'chat');
    if (!saved) { problems.push('图片格式不认识'); continue; }
    const who = entry.senderName ? ` ${entry.senderName}` : '';
    log(`聊天参考图取自消息 #${entry.mid ?? wantId}${who}：${size ? `${size.width}x${size.height}` : '尺寸未知'}（${Math.round(buf.length / 1024)}KB）→ ${saved.file}`);
    return {
      ok: true,
      file: saved.file,
      width: size?.width || 0,
      height: size?.height || 0,
      source: `聊天图片（#${entry.mid ?? wantId}${who}）`,
      candidates: medias.length
    };
  }
  return { ok: false, reason: `消息 #${entry.mid ?? wantId} 里的图片取不到：${problems.join('；')}` };
}

// ── 只取外观、不影响构图（v4.3）─────────────────────────────────
//
// 为什么必须有这个模式：**img2img 必然带走参考图的构图**。
// 那是它的工作原理（latent 由参考图 VAE 编码而来），不是 denoise 没调好 ——
// 实测 denoise 0.6 时参考图的枝条、机位、人物姿势都会保留。
// 想要"只取外观"，就得**不把图送进采样器**：改成从图里提取外观标签写进 prompt，
// 然后走**纯文生图**。这样构图 100% 由 prompt 决定，与参考图无关。
//
// 用什么提取：QQ Agent 自己配的那个模型（api.visionModel）**能读图**（实测 HTTP 200）。
// 所以这条路**零新依赖** —— 不用装 IPAdapter，也不用装自定义节点。
//
// 实测记录（同一张参考图，thinking 都关掉）：
//   384px → 返回里混进了 eating / upper_body / looking_at_viewer / simple_background
//   768px → 只返回外观（1.2 秒）
//   原图 4.21MB（请求体 5.61MB）→ HTTP 200、2.7 秒、1077 prompt token，也只返回外观
//   开思考 → reasoning 吃光 token 预算，content 返回空（本文件开头记录过的老坑）
// 结论：**必须关思考**（llmChat 默认就关），分辨率越高越听话；
// 另外下面还有一层**硬过滤**兜底 —— 不指望模型每次都听话。

/**
 * 构图 / 姿势 / 表情 / 道具 / 背景 / 画面元信息类标签 —— 一律不许进 prompt。
 *
 * 这是**硬保证**：就算视觉模型没听话、把姿势和背景也列出来了，也会被这里挡掉。
 * 宁可少几个外观标签（用户还能自己补），也不能让参考图的构图漏进新画面。
 * 已知的小代价：`hair_flower`、`star_hair_ornament` 这类含 flower/star 的配饰会被误挡。
 */
const POSE_COMPOSITION_RE = new RegExp([
  // 姿势 / 动作
  'pose', 'standing', 'sitting', 'lying', 'squat', 'kneel', 'crouch', 'walking', 'running',
  'jumping', 'leaning', 'reclining', 'straddl', 'spread_legs', 'crossed_legs', 'legs_up',
  'arms?_up', 'arms?_out', 'arms?_crossed', 'arms?_behind', 'hand_on', 'hand_up', 'hands?_up',
  'holding', 'grabbing', 'eating', 'drinking', 'feeding', 'sleeping', 'kiss', 'hugging',
  'carrying', 'talking', 'singing', 'dancing', 'waving', 'pointing', 'reaching', 'touching',
  'adjusting', 'removing', 'undressing', 'covering',
  // 表情（参考图的表情不该被带到新场景）
  'open_mouth', 'closed_mouth', 'closed_eyes', 'half-closed', 'blush', 'smile', 'grin',
  'frown', 'crying', 'tears', 'sweat', 'angry', 'surprised', 'embarrass', 'expression',
  // 机位 / 视角 / 构图
  'from_side', 'from_behind', 'from_above', 'from_below', 'from_between', 'from_outside',
  'from_front', 'looking', 'close-?up', 'closeup', 'upper_body', 'lower_body', 'full_body',
  'cowboy_shot', 'portrait', 'headshot', 'shot', 'angle', 'perspective', 'foreshortening',
  'zoom', 'focus', 'depth_of_field', 'blurry', 'bokeh', 'head_out_of_frame', 'cut_off',
  'off_shoulder', 'out_of_frame', 'cropped',
  // 背景 / 场景 / 道具
  'background', 'outdoors', 'indoors', 'scenery', 'sky', 'cloud', 'tree', 'petal', 'water',
  'window', 'wall', 'floor', 'room', 'street', 'city', 'landscape', 'starry', 'nature',
  'food', 'pastry', 'cake', 'cup', 'bottle', 'book', '(^|_)phone(_|$)', 'weapon', 'sword', 'gun',
  'sparkle', 'star', 'heart', 'flower', 'chair', 'table', '(^|_)bed(_|$)',
  // ↑ phone / bed 特意加了边界：tag 用下划线连接，裸 'phone' 会误伤 headphones，
  //   裸 'bed' 会误伤 bedhead。而耳机、发型都是**正经的外观配饰**，不该被挡。
  // 人数 / 画面元信息
  '1girl', '1boy', '2girls', '2boys', 'multiple', 'solo', 'no_humans',
  'anime_style', 'anime', 'realistic', 'photo', 'transparent', 'border', 'frame', 'collage',
  'censored', 'artist', 'signature', 'watermark', 'logo', 'text', 'username', 'patreon', 'twitter'
].join('|'), 'i');

/** 这个标签算不算"外观"（不属于构图/姿势/表情/道具/背景就放行）。 */
function isAppearanceTag(tag) {
  if (typeof tag !== 'string') return false;
  const t = tag.trim().toLowerCase().replace(/\s+/g, '_');
  if (t.length < 3 || t.length > 48) return false;
  // 模型偶尔会把"没有"写成这几个词（String(null) 也是 'null'），别当成标签用
  if (/^(null|undefined|none|n\/?a|unknown|nan|empty)$/.test(t)) return false;
  return !POSE_COMPOSITION_RE.test(t);
}

/**
 * 从参考图里提取**只含外观**的标签。
 *
 * 交给 QQ Agent 配置的视觉模型读图，然后**硬过滤**掉构图/姿势/表情/道具/背景类标签。
 * 失败一律返回 { ok:false, reason }，由调用方降级 —— 不会中断出图。
 */
async function extractAppearanceTags(imageFile, c) {
  const conf = readLlmConfig(c);
  if (!conf.ok) return { ok: false, reason: '没有可用的 LLM 配置（data/config.json 里缺 api.baseUrl 或 api.apiKey）' };
  if (!conf.vision) return { ok: false, reason: 'QQ Agent 的「视觉」功能是关着的（api.vision=false），无法读参考图' };

  let buf;
  try { buf = fs.readFileSync(imageFile); }
  catch (error) { return { ok: false, reason: `读参考图失败：${error?.message ?? error}` }; }
  if (!buf.length) return { ok: false, reason: '参考图是空文件' };

  // 太大的图先拦下：base64 会让请求体再涨 1/3。实测 4.2MB 原图是能过的，
  // 但十几 MB 的手机原图没必要硬发，直接说明原因跳过。
  const maxMB = clampInt(numOr(c.refVisionMaxMB, 8), 1, 50, 8);
  if (buf.length > maxMB * 1024 * 1024) {
    return { ok: false, reason: `参考图 ${(buf.length / 1024 / 1024).toFixed(1)}MB，超过外观提取上限 ${maxMB}MB` };
  }

  const magic = buf.subarray(0, 4).toString('hex').toUpperCase();
  let mime = null;
  if (magic.startsWith('89504E47')) mime = 'image/png';
  else if (magic.startsWith('FFD8FF')) mime = 'image/jpeg';
  else if (magic.startsWith('47494638')) mime = 'image/gif';
  else if (magic.startsWith('52494646')) mime = 'image/webp';
  if (!mime) return { ok: false, reason: '参考图格式不认识，无法交给视觉模型' };

  const want = clampInt(numOr(c.refAppearanceTags, 12), 3, 30, 12);
  const instruction = [
    '看这张图里的人物，只提取**外观**标签（用于 AI 绘图提示词）。',
    '允许描述：发色、发型、瞳色、脸型特征、显著配饰（发饰/耳机/眼镜）、服装与配色。',
    '禁止描述：姿势、动作、手在做什么、机位、视角、镜头远近、画面构图、背景、场景、道具、表情。',
    `输出一行英文 danbooru 风格标签，逗号分隔，小写，词组用下划线，最多 ${want} 个。`,
    '只输出标签本身，不要解释、不要编号、不要换行。'
  ].join('\n');

  const res = await llmChat(
    [{
      role: 'user',
      content: [
        { type: 'text', text: instruction },
        { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } }
      ]
    }],
    { maxTokens: 400, temperature: 0.2, timeoutMs: 60000, model: conf.visionModel }
  );
  if (!res.ok) return { ok: false, reason: `视觉模型读图失败：${res.reason}` };

  const raw = cleanLlmText(res.text);
  const all = raw.split(/[,\n]/)
    .map((s) => s.trim().toLowerCase().replace(/\s+/g, '_'))
    .filter(Boolean);
  const kept = [];
  const dropped = [];
  for (const t of all) {
    if (!/^[a-z0-9_()]+$/.test(t)) continue;
    if (isAppearanceTag(t)) { if (!kept.includes(t)) kept.push(t); }
    else dropped.push(t);
  }
  if (!kept.length) {
    return { ok: false, reason: `视觉模型只给出了构图/姿势类标签（${dropped.slice(0, 8).join(', ') || '无'}），没有可用的外观标签` };
  }
  return { ok: true, tags: kept.slice(0, want), dropped, model: res.model, raw };
}

function buildWorkflow(p, o) {
  const positive = o.prependQuality && p.qualityPrefix
    ? [p.qualityPrefix, o.prompt].filter(Boolean).join(', ')
    : o.prompt;

  // 用参考图时补一组**文字类负面词**。
  //
  // 为什么必须补：img2img 会把参考图上的一切都当成"要保留的构图"，包括**印在图上的字**。
  // 实测拿一张带字幕的底图（denoise 0.5）出图，字幕位置被忠实复现成了乱码字母
  // （画面上出现了 MŁCOL SS WE / ©NOGOAN 这种伪文字），整张图没法看。
  // 而 Anima 两个档位的官方负面词里**一个文字类词都没有**（只有光辉档有 watermark/signature/text），
  // 所以这里单独兜底。只在使用参考图时加，不影响原有纯文字出图的行为。
  const refNegative = o.refImage
    ? 'text, watermark, signature, letters, words, caption, subtitles, logo, title, chinese text'
    : '';
  const negative = [o.negativeExtra, refNegative, o.negativeProfile].filter(Boolean).join(', ');

  // denoise：有参考图才允许小于 1（走 img2img），否则必须 1.0。
  // 没有参考图却用 denoise<1 是没有意义的 —— latent 是纯噪声，低 denoise 只会画出糊图。
  const rawDenoise = Number(o.denoise);
  const denoise = o.refImage
    ? (Number.isFinite(rawDenoise) ? Math.min(1, Math.max(0.05, rawDenoise)) : 0.6)
    : 1.0;

  // img2img 用的三个节点。**编号故意跳开 1~10**：
  // Anima 的 turbo LoRA 已经占了 '10'，撞号会让 ComfyUI 报节点图错乱。
  // 20 LoadImage → 21 ImageScale → 22 VAEEncode
  const refChain = (vaeRef) => ({
    '20': { class_type: 'LoadImage', inputs: { image: o.refImage } },
    // 先等比缩放进出图尺寸，再编码 —— 直接 VAEEncode 原图会带着原图的分辨率进采样器
    '21': { class_type: 'ImageScale', inputs: { image: ['20', 0], upscale_method: 'lanczos', width: o.width, height: o.height, crop: 'disabled' } },
    '22': { class_type: 'VAEEncode', inputs: { pixels: ['21', 0], vae: vaeRef } }
  });

  if (p.kind === 'checkpoint') {
    const wf = {
      '3': { class_type: 'KSampler', inputs: { seed: o.seed, steps: o.steps, cfg: o.cfg, sampler_name: p.sampler, scheduler: p.scheduler, denoise, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: o.refImage ? ['22', 0] : ['5', 0] } },
      '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: o.model.checkpoint } },
      '6': { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['4', 1] } },
      '7': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['4', 1] } },
      '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
      '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'qq-agent', images: ['8', 0] } }
    };
    if (o.refImage) Object.assign(wf, refChain(['4', 2]));
    else wf['5'] = { class_type: 'EmptyLatentImage', inputs: { width: o.width, height: o.height, batch_size: 1 } };
    return wf;
  }

  const wf = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: o.model.unet, weight_dtype: 'default' } },
    '2': { class_type: 'CLIPLoader', inputs: { clip_name: o.model.clip, type: 'stable_diffusion', device: 'default' } },
    '3': { class_type: 'VAELoader', inputs: { vae_name: o.model.vae } },
    '4': { class_type: 'CLIPTextEncode', inputs: { text: positive, clip: ['2', 0] } },
    '5': { class_type: 'CLIPTextEncode', inputs: { text: negative, clip: ['2', 0] } },
    '8': { class_type: 'VAEDecode', inputs: { samples: ['7', 0], vae: ['3', 0] } },
    '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'qq-agent', images: ['8', 0] } }
  };
  let modelRef = ['1', 0];
  if (p.kind === 'anima-turbo') {
    wf['10'] = { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: o.model.lora, strength_model: 1.0 } };
    modelRef = ['10', 0];
  }
  if (o.refImage) Object.assign(wf, refChain(['3', 0]));
  else wf['6'] = { class_type: 'EmptyLatentImage', inputs: { width: o.width, height: o.height, batch_size: 1 } };
  wf['7'] = { class_type: 'KSampler', inputs: { seed: o.seed, steps: o.steps, cfg: o.cfg, sampler_name: p.sampler, scheduler: p.scheduler, denoise, model: modelRef, positive: ['4', 0], negative: ['5', 0], latent_image: o.refImage ? ['22', 0] : ['6', 0] } };
  return wf;
}

/**
 * 自动补角色外观标签。
 *
 * 只在提示词里已经出现**该角色的标准标签**（type=4 且有量）时才动手，
 * 而且只补"外观类"标签（发色/发型/瞳色/兽耳/光环…）。
 * 为什么不补服装类：用户可能明确要"穿和服"，这时候硬塞 necktie / detached_sleeves 会打架；
 * 而补发色瞳色几乎不会有冲突 —— 那本来就是"认出这个角色"的关键。
 */
async function autoCharacterAppearance(apiBase, promptText, c) {
  const maxCheck = 4;
  const tokens = [...new Set(
    String(promptText).split(/[,\n]/).map((s) => s.trim().toLowerCase().replace(/\s+/g, '_'))
      .filter((t) => t.length >= 5 && /^[a-z0-9_]+(\([a-z0-9_:.'\-]+\))?$/.test(t))
  )].slice(0, maxCheck);
  if (!tokens.length) return { added: [], character: null };

  for (const tok of tokens) {
    try {
      const t = await tagExact(apiBase, tok);
      if (!t || t.type !== 4 || t.count < 100) continue;
      const card = await buildCharacterCard(apiBase, t.name, Math.max(20, Number(c.characterCardSample) || 60), 40);
      if (!card.samples) continue;
      const already = new Set(String(promptText).toLowerCase().split(/[,\n]/).map((s) => s.trim().replace(/\s+/g, '_')));
      const added = card.ranked
        .filter((x) => x.ratio >= 0.3 && APPEARANCE_RE.test(x.name) && !already.has(x.name))
        .slice(0, 6)
        .map((x) => x.name);
      return { added, character: t.name, samples: card.samples };
    } catch (error) {
      warn(`查角色标签失败（${tok}）：${error?.message ?? error}`);
    }
  }
  return { added: [], character: null };
}

// ══════════════════════════════════════════════════════════════
//  提示词库（v4.4）
// ══════════════════════════════════════════════════════════════
//
// 为什么要有它：模型（以及负责翻译的那个 LLM）凭记忆写 danbooru 标签经常写错写法 ——
// 而写法错了模型就不认识，等于白写。所以维护一份**逐个向标签库核对过**的概念→标签表，
// 让模型按用户要求现查，而不是靠猜。
//
// ⚠️ 这个库有一个必须说清的限制（构建时踩出来的）：
//   标签库（safebooru，与 danbooru 同一套标签体系）里的标签是**描述性标注** ——
//   画师给图打的标签。它认 1girl / long_hair / watermark / lowres / backlighting，
//   但**不认** worst_quality / score_1 / rim_light / volumetric_lighting 这类。
//   因为后者是 **Stable Diffusion 的提示词约定**，不是描述性标注。
//   所以库里分两个语义域：
//     descriptive —— 已逐个过标签库验证，写法可靠
//     convention  —— 标签库没有裁判资格，改由**模型官方推荐词表**兜底
//   查询结果里会带上这个信息，别把 convention 类当成"验过"的。

const LIB_PATHS = [
  path.join(DATA_DIR, 'prompt-library.json'),   // 用户可自定义/扩展（优先）
  path.join(HERE, 'prompt-library.json')        // 随技能发布
];
let libCache = null;

function loadPromptLibrary() {
  if (libCache !== null) return libCache;
  for (const p of LIB_PATHS) {
    try {
      if (!fs.existsSync(p)) continue;
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!Array.isArray(j?.categories) || !j.categories.length) continue;
      const rows = [];
      for (const c of j.categories) {
        for (const k of c.concepts || []) {
          rows.push({
            cat: String(c.id), catName: String(c.name || c.id), domain: String(c.domain || 'descriptive'),
            zh: String(k.zh || ''), en: String(k.en || ''),
            tags: (k.tags || []).map(String), alt: (k.alt || []).map(String)
          });
        }
      }
      libCache = { path: p, meta: j, rows, verified: new Set(j.verifiedTags || []) };
      log(`提示词库已加载：${rows.length} 个概念 / ${j.categories.length} 个类目（${p}）`);
      return libCache;
    } catch (error) {
      warn(`读提示词库失败（${p}）：${error?.message ?? error}`);
    }
  }
  warn('提示词库没找到（缺 prompt-library.json），「查提示词标签库」不可用');
  libCache = { path: '', meta: null, rows: [], verified: new Set() };
  return libCache;
}

/** 在库里检索概念。query 会同时匹配中文说法、英文短语、主标签和备用标签。 */
function searchPromptLibrary({ query = '', category = '', limit = 12 } = {}) {
  const { rows, meta, verified } = loadPromptLibrary();
  if (!rows.length) return { ok: false, reason: '提示词库没加载成功（缺 prompt-library.json）' };
  const q = String(query).trim();
  const ql = q.toLowerCase();
  const cat = String(category).trim().toLowerCase();
  let hits = rows;
  if (cat) hits = hits.filter((r) => r.cat.toLowerCase() === cat || r.catName === category);
  if (q) {
    hits = hits.filter((r) =>
      r.zh.includes(q) ||                                   // 中文按原串匹配
      r.en.toLowerCase().includes(ql) ||
      r.tags.some((t) => t.includes(ql)) ||
      r.alt.some((t) => t.includes(ql))
    );
  }
  return {
    ok: true, total: hits.length,
    hits: hits.slice(0, clampInt(numOr(limit, 12), 1, 50, 12)),
    verified,
    categories: (meta?.categories || []).map((c) => ({ id: c.id, name: c.name, n: (c.concepts || []).length, domain: c.domain }))
  };
}

/** 把检索结果排成人/模型都好读的文本。 */
function formatLibraryHits(r, query, category) {
  if (!r.ok) return r.reason;
  const { hits, verified } = r;
  if (!hits.length) {
    const list = (r.categories || []).map((c) => `${c.id}（${c.name}）`).join('、');
    return `提示词库里没找到「${query || category}」。\n可用的类目有：${list}\n换关键词，或直接用 category 参数查某个类目。`;
  }
  const lines = [`提示词库里查到 ${r.total} 条${r.total > hits.length ? `（下面显示前 ${hits.length} 条）` : ''}：`, ''];
  for (const h of hits) {
    lines.push(`【${h.zh}】  ${h.cat} · ${h.catName}${h.domain === 'convention' ? '（提示词约定类）' : ''}`);
    if (h.tags.length) {
      const marked = h.tags.map((t) => (h.domain === 'convention' ? t : (verified.has(t) ? `${t}✓` : t)));
      lines.push(`  标签（写进光耀/Illustrious 档的 prompt）：${marked.join(', ')}`);
    } else {
      lines.push('  标签：无（本概念的候选写法都没通过标签库核对，见下）');
    }
    if (h.en) lines.push(`  自然语言（写进 Anima 档的 prompt）：${h.en}`);
    if (h.alt?.length) lines.push(`  备用写法（标签库里查不到，仍可能有效，谨慎使用）：${h.alt.join(', ')}`);
    lines.push('');
  }
  if (hits.some((h) => h.domain === 'descriptive')) lines.push('（✓ = 该标签已核对过标签库，写法可靠）');
  if (hits.some((h) => h.domain === 'convention')) lines.push('（提示词约定类：标签库不收录这类词，所以没有 ✓，但这是模型官方推荐的写法）');
  if (hits.some((h) => !h.tags.length)) lines.push('（有概念的标签为空：它的候选写法都没通过核对，此时请优先用上面的自然语言描述）');
  return lines.join('\n');
}

/**
 * 从中文提示词里**确定性地**捞出库中概念，返回它们的标签。
 *
 * 为什么要确定性匹配而不是让模型查：画图路径上加一次 LLM 往返会拖慢且不稳定；
 * 而"用户原话里出现了「雨天」"是个纯字符串判断，准确且免费。
 * 只匹配长度 ≥2 的中文词（单字太容易误命中，比如「白」会命中「白天」）。
 */
function enrichFromLibrary(promptText, c) {
  const empty = { tags: [], ens: [], matched: [] };
  if (c.promptLibraryAuto !== true) return empty;   // 默认关，避免污染用户自己的描述
  const { rows } = loadPromptLibrary();
  if (!rows.length) return empty;
  const text = String(promptText || '');
  const maxTags = clampInt(numOr(c.promptLibraryMaxTags, 8), 1, 30, 8);
  // 长词优先：先匹配「雨天」再考虑「雨」，避免短词把长词的机会抢走
  const sorted = rows.filter((r) => r.zh.length >= 2 && r.tags.length).sort((a, b) => b.zh.length - a.zh.length);
  const matched = [];
  const tags = [];
  const ens = [];
  const usedZh = new Set();
  for (const r of sorted) {
    if (usedZh.has(r.zh)) continue;
    if (!text.includes(r.zh)) continue;
    usedZh.add(r.zh);
    matched.push(r.zh);
    for (const t of r.tags) if (!tags.includes(t)) tags.push(t);
    if (r.en && !ens.includes(r.en)) ens.push(r.en);
    if (tags.length >= maxTags) break;
  }
  return { tags: tags.slice(0, maxTags), ens, matched };
}

// ══════════════════════════════════════════════════════════════
//  技能入口
// ══════════════════════════════════════════════════════════════

export function setup(api) {
  cfg = api.config || (() => ({}));
  log = api.log || (() => {});
  warn = api.warn || (() => {});
  httpFetch = typeof api.fetch === 'function' ? (...a) => api.fetch(...a) : null;
  capability = api.capability || (() => undefined);
  hasCapability = api.hasCapability || (() => false);

  // ── 工具一：查角色卡 ────────────────────────────────────────
  api.registerTool({
    id: 'find_character_tags',
    name: '查角色标签（角色卡）',
    description:
      '联网查一个动漫/游戏角色的**标准 danbooru 标签**和它的"角色卡"（画这个角色最常用的标签）。' +
      '适用：群友点名要画某个具体角色时（「画个初音未来」「来个雷姆」），**先调这个**再调 draw。' +
      '参数 name 可以是中文（初音未来）、日文或英文（hatsune miku / hatsune_miku）。' +
      '返回标准角色标签 + 该角色样本图里的高频共现标签（带出现比例），你照着挑几个和场景描述拼成最终 prompt 即可。',
    category: 'media',
    icon: '🔎',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '角色名，中文/日文/英文都行，例如「初音未来」「雷姆」「hatsune miku」' },
        sample: { type: 'number', description: '统计多少张样本图来算高频标签，默认用设置里的值（60），10~100' }
      },
      required: ['name']
    },
    async execute(ctx, args) {
      const c = cfg() || {};
      const name = String(args?.name ?? '').trim();
      if (!name) return { content: '缺少 name：告诉我角色名。', isError: true };
      if (!httpFetch) return { content: '本技能未拿到网络权限（需要 permissions: ["web_fetch"]）。', isError: true };

      const apiBase = String(c.tagApiUrl || '').trim() || DEFAULT_TAG_API;
      const sample = clampInt(numOr(args?.sample, c.characterCardSample), 10, 100, 60);
      const topN = clampInt(numOr(c.characterCardTop, 16), 5, 40, 16);

      // 中文名 → 英文标签（英文名也走一遍，能把 "hatsune miku" 规范成 hatsune_miku）
      let guess = name;
      let guessed = null;
      if (HAS_CJK.test(name) || /[A-Z\s]/.test(name)) {
        const g = await nameToTag(name);
        if (g.ok) { guess = g.text; guessed = g.text; }
        else warn(`角色名转标签失败（用原名直接查）：${g.reason}`);
      }

      let resolved;
      try {
        resolved = await resolveCharacterTag(apiBase, guess);
      } catch (error) {
        return { content: `查标签库失败：${error?.message ?? error}（标签库地址：${apiBase}）`, isError: true };
      }

      if (!resolved.ok) {
        // 原始中文名也可能本身就是标签（少数情况），再试一次
        return {
          content:
            `标签库里没找到「${name}」${guessed && guessed !== name ? `（我猜的英文标签是 ${guessed}）` : ''}。\n` +
            '可能是这个小众角色在标签库里没有，或者我猜的拼写不对。\n' +
            '建议：你用自己的 web_search 搜一下「<角色名> danbooru tags」或「<角色名> 角色卡 提示词」，' +
            '拿到确切标签后直接写进 draw 的 prompt（记得用英文）。'
        };
      }

      const tag = resolved.tag;
      let card = { samples: 0, ranked: [] };
      try {
        card = await buildCharacterCard(apiBase, tag.name, sample, topN);
      } catch (error) {
        warn(`统计角色卡失败：${error?.message ?? error}`);
      }

      const lines = [];
      lines.push(`角色「${name}」→ 标准标签：**${tag.name}**（${TYPE_LABEL[tag.type] || 'type' + tag.type}，标签库有 ${tag.count} 张图）`);
      if (guessed) lines.push(`（中文名转英文标签：${guessed}${resolved.resolvedBy ? `，通过${resolved.resolvedBy}确认` : ''}）`);
      if (tag.ambiguous) lines.push('⚠️ 这个标签在标签库里被标为 ambiguous（有歧义），如果画出来不对就换下面备选。');

      if (card.samples) {
        lines.push('');
        lines.push(`角色卡（统计了 ${card.samples} 张该角色的图，数字是出现比例）：`);
        const appearance = card.ranked.filter((x) => APPEARANCE_RE.test(x.name));
        const others = card.ranked.filter((x) => !APPEARANCE_RE.test(x.name));
        if (appearance.length) lines.push(`  外观（优先用）：${appearance.map((x) => `${x.name} ${Math.round(x.ratio * 100)}%`).join(', ')}`);
        if (others.length) lines.push(`  其他常见：${others.map((x) => `${x.name} ${Math.round(x.ratio * 100)}%`).join(', ')}`);
        lines.push('');
        lines.push('注意：上面"其他常见"里可能混进同作品的其他角色或常见搭配，按画面需要挑，不要全塞。');
      } else {
        lines.push('');
        lines.push('（没抓到样本图，只能给你标准标签本身）');
      }

      if (resolved.alternatives?.length) {
        const alts = resolved.alternatives.filter((t) => t.name !== tag.name).slice(0, 5);
        if (alts.length) lines.push(`\n备选标签：${alts.map((t) => `${t.name}(${t.count})`).join(', ')}`);
      }

      lines.push('\n接下来：把这些标签 + 群友要的场景拼成英文 prompt，再调用 comfyui-image__draw。');
      return { content: lines.join('\n') };
    }
  });

  // ── 工具二：查提示词标签库 ──────────────────────────────────
  const libInfo = loadPromptLibrary();
  const libCats = libInfo.meta?.categories || [];
  const catList = libCats.map((c) => `${c.id}（${c.name}）`).join('、');
  api.registerTool({
    id: 'prompt_tags',
    name: '查提示词标签库',
    description:
      `查一份**逐个核对过写法**的提示词标签库（${libInfo.rows.length} 个概念 / ${libCats.length} 个类目）。` +
      '用来把中文描述变成**准确的 danbooru 标签**或**自然语言短语** —— 凭记忆写标签经常写错写法，写法错了模型就不认识，等于白写。\n' +
      '**什么时候用**：群友的要求里有具体视觉概念时（天气、光线、场景、服装、姿势、表情、画风、道具、动物…），先查一下，再把结果拼进 draw 的 prompt。' +
      '不确定某个说法英文怎么写、或者不确定标签写法时，尤其该查。\n' +
      '**两种产出**：`标签` 给光辉/Illustrious 档用（标签串）；`自然语言` 给 Anima 档用（本机默认档位就是这个，直接抄那句英文描述）。\n' +
      '不传参数调用可以列出全部类目。\n' +
      `类目：${catList || '（库未加载）'}`,
    category: 'media',
    icon: '📚',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要查的概念，中文或英文都行，也可以直接查标签名（如「雨天」「rain」「umbrella」「银发」「回眸」）' },
        category: { type: 'string', description: '限定某个类目 id（可选）；不传则在全部类目里查' },
        limit: { type: 'number', description: '返回条数上限，默认 12' }
      }
    },
    async execute(ctx, args) {
      const lib = loadPromptLibrary();
      if (!lib.rows.length) {
        return { content: '提示词库没加载成功（缺 prompt-library.json）。请检查技能目录里是否有这个文件。', isError: true };
      }
      const query = String(args?.query ?? '').trim();
      const category = String(args?.category ?? '').trim();
      if (!query && !category) {
        const lines = [`提示词库：${lib.rows.length} 个概念 / ${lib.meta.categories.length} 个类目`, ''];
        for (const c of lib.meta.categories) {
          lines.push(`- ${c.id}（${c.name}）${c.domain === 'convention' ? '  ← 提示词约定类' : ''}：${(c.concepts || []).length} 个概念`);
        }
        lines.push('', '用 query 查具体概念（如 query="雨天"），或用 category 查某个类目（如 category="lighting"）。');
        return { content: lines.join('\n') };
      }
      const r = searchPromptLibrary({ query, category, limit: args?.limit });
      log(`查提示词库：query=「${query}」category=「${category}」→ ${r.total ?? 0} 条`);
      return { content: formatLibraryHits(r, query, category) };
    }
  });

  // ── 工具三：画图 ────────────────────────────────────────────
  api.registerTool({
    id: 'draw',
    name: 'AI 画图',
    description:
      '用本机 ComfyUI 按描述生成一张图并发送到当前会话。可选光辉 Illustrious（SDXL）或 Anima（ComfyUI 官方新模型，更快更细）。' +
      '适用：群友说「画一个…」「帮我画…」「生成一张…的图」。' +
      '**中文可以直接写进 prompt**，技能会自动翻译成英文再画（翻译要 1~2 秒）。' +
      '如果群友点名要画某个具体角色，先用 comfyui-image__find_character_tags 查标准标签，再把标签拼进 prompt。' +
      '**要角色长得像，还可以传 ref_character（角色名）**，技能会去标签库找一张确实是这个角色的图当底图重绘。' +
      '**群友自己发了图、或引用着某张图说「照着这个画」时，用 ref_message_id 传那条消息的 #数字**（拿不准 id 就用 ref_recent_image）——' +
      '那是**最准的参考**，就是群友本人给的那张。' +
      '**如果群友要求「照着一张…画」「同款构图」「按这个姿势」但没给图，用 ref_keyword 传关键词**，' +
      '技能会自己找一张真实图片当底图重绘（img2img），比纯文字画得准得多。' +
      '质量词由工具自动补，不用自己写。',
    category: 'media',
    icon: '🎨',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description:
            '画面描述。**中文或英文都行**（中文会被自动翻译）。' +
            '描述人物特征、服装、动作、场景、光线、镜头。' +
            '如果已经用 find_character_tags 查到了角色标签，把标签和场景拼在一起，例如：hatsune_miku, twintails, aqua_hair, aqua_eyes, drinking bubble tea, sitting in a cafe, warm lighting'
        },
        negative_prompt: { type: 'string', description: '额外要避免的内容（可选）。常规负面词已自动带上。' },
        ref_character: {
          type: 'string',
          description:
            '**角色外观参考图**（可选）。填一个角色名（中文/日文/英文都行：「初音未来」「雷姆」「frieren」），' +
            '技能会去标签库找一张**确实就是这个角色**的图当底图重绘，保证发色/瞳色/发型画对。' +
            '走的是 booru 标签（标签本身保证"就是这个角色"），比关键词搜索可靠。' +
            '**群友点名要画某个具体角色、又希望长得像的时候用这个**；只是想"照着某种构图/风格"则用 ref_keyword。' +
            '填了它技能还会自动把该角色的标准标签和外观标签补进 prompt，参考图和标签双重保证。'
        },
        ref_keyword: {
          type: 'string',
          description:
            '参考图关键词（可选）。填了就先用「智能配图」找一张真实图片当**底图重绘**（img2img），构图/姿势/机位会跟着参考图走，比纯文字准。' +
            '例如群友说「照着樱花树下那种感觉画」就填「樱花树下少女」；说「同款构图」就把参考物的关键词填进来。' +
            '**只在群友确实想要"照着某张图"时才填**，普通「画一个…」不要填（那会限制发挥）。' +
            '如果要画的是**具体角色**，优先用 ref_character 而不是这个。'
        },
        ref_mode: {
          type: 'string',
          enum: ['appearance', 'composition'],
          description:
            '参考图怎么用（可选，默认跟随技能设置，现为 appearance）。' +
            '**appearance = 只取外观**：从参考图里提取发型/发色/瞳色/配饰/服装写进 prompt，' +
            '构图/姿势/机位/背景**完全由你的描述决定，参考图不影响构图**。' +
            'composition = 按参考图重绘（img2img），构图和姿势会跟着参考图走。' +
            '群友说「画成这样的」但没要求照抄姿势构图 → 用默认的 appearance。'
        },
        ref_denoise: {
          type: 'number',
          description:
            '参考图重绘幅度 0.2~0.95（可选，默认跟随技能设置）。**只在 ref_mode=composition 时生效**。' +
            '**越低越像参考图**（0.3 几乎照抄构图只换画风），**越高越自由**（0.8 只借个大概布局）。' +
            '群友说「就要这张的感觉」用 0.35~0.5；说「参考一下但换个场景」用 0.6~0.75。'
        },
        ref_file: {
          type: 'string',
          description: '参考图的本地文件路径（可选，一般不用填）。只有在你有确切图片路径时才用；正常用 ref_keyword 让技能自己找。'
        },
        ref_message_id: {
          type: ['integer', 'string'],
          description:
            '**用聊天里某条消息的图片当参考图**（可选）。填那条消息的 id —— 就是聊天记录里每条消息前的 #数字（可能为负数）。' +
            '**这是最准的参考**：群友自己发的图就是他要的那张，比任何搜索都准。' +
            '适用：群友发了图/引用着图说「照着这个画」「画成这样的」「同款」。' +
            '注意 id 只能填聊天记录里真实出现过的 #数字，不要自己编。'
        },
        ref_recent_image: {
          type: 'boolean',
          description:
            '用当前会话里**最近一张**群友发的图片当参考（可选）。' +
            '当你拿不准该用哪条消息的 id 时用这个（配合 ref_message_id 二选一；ref_message_id 更精确）。'
        },
        size: {
          type: 'string',
          enum: ['1024x1024', '832x1216', '1216x832', '1152x896', '896x1152', '1344x768', '768x1344'],
          description: '画面尺寸（可选）。不填用默认；**用了参考图时不填会按参考图比例自动算**，填了则以你填的为准。竖图（人像全身）用 832x1216，横图（风景）用 1216x832。'
        },
        steps: { type: 'number', description: '采样步数（可选）。不填用该模型推荐值（Anima 极速 8、画质 30、光辉 28）。' },
        cfg: { type: 'number', description: 'CFG 强度（可选）。不填用推荐值（Anima 极速 1、画质 4、光辉 5）。' },
        seed: { type: 'number', description: '随机种子（可选）。不填 = 每次随机；固定数字可复现同一张图。' }
      },
      required: ['prompt']
    },

    async execute(ctx, args) {
      const c = cfg() || {};
      const p = profileOf(c);

      const inputPrompt = String(args?.prompt ?? '').trim();
      if (!inputPrompt) return { content: '缺少 prompt：请给我要画的画面描述。', isError: true };
      if (!httpFetch) return { content: '本技能未拿到网络权限（skill.json 需要 permissions: ["web_fetch"]）。', isError: true };
      if (!ctx?.sender || typeof ctx.sender.sendImage !== 'function') return { content: '当前上下文拿不到 sender，无法发图。', isError: true };

      // ── 冷却 ────────────────────────────────────────────────
      const chatKey = String(ctx.chatKey || '');
      const cooldownMs = Math.max(0, Number(c.cooldownSec) || 0) * 1000;
      if (cooldownMs > 0) {
        const last = lastRunAt.get(chatKey) || 0;
        const elapsed = Date.now() - last;
        if (last && elapsed < cooldownMs) {
          return { content: `这个会话刚画过图，还要等 ${Math.ceil((cooldownMs - elapsed) / 1000)} 秒。`, isError: true };
        }
      }

      // ── 尺寸 / 采样 ─────────────────────────────────────────
      const maxW = clampInt(c.maxWidth, 512, 4096, 1536);
      const maxH = clampInt(c.maxHeight, 512, 4096, 1536);
      let width = align64(clampInt(c.defaultWidth, 512, maxW, 1024));
      let height = align64(clampInt(c.defaultHeight, 512, maxH, 1024));
      // 调用方是否明确指定了尺寸。没指定且用了参考图时，尺寸要改成"按参考图比例算"。
      let sizeExplicit = false;
      const sizeArg = String(args?.size ?? '').trim();
      if (sizeArg) {
        const m = /^(\d{3,4})\s*[x×*]\s*(\d{3,4})$/i.exec(sizeArg);
        if (m) {
          width = align64(clampInt(m[1], 512, maxW, width));
          height = align64(clampInt(m[2], 512, maxH, height));
          sizeExplicit = true;
        }
      } else if (args?.width || args?.height) {
        width = align64(clampInt(args.width, 512, maxW, width));
        height = align64(clampInt(args.height, 512, maxH, height));
        sizeExplicit = true;
      }
      // 参考图重绘幅度：调用方传的优先，否则用设置里的默认值。
      // 下限 0.2（再低等于照抄原图，没必要走 AI），上限 0.95（1.0 就退化成纯文生图了）。
      const rawRefDenoise = Number(args?.ref_denoise);
      const refDenoise = Number.isFinite(rawRefDenoise)
        ? Math.min(0.95, Math.max(0.2, rawRefDenoise))
        : Math.min(0.95, Math.max(0.2, numOr(c.refDenoise, 0.6)));
      const steps = clampInt(numOr(args?.steps, numOr(c.steps, p.steps)), 1, 150, p.steps);
      const cfgScale = Math.min(20, Math.max(0, numOr(args?.cfg, numOr(c.cfg, p.cfg))));
      const seedArg = Number(args?.seed);
      const seed = Number.isFinite(seedArg) && seedArg >= 0 ? Math.floor(seedArg) : Math.floor(Math.random() * 2147483647);

      const base = String(c.baseUrl || 'http://127.0.0.1:8188').replace(/\/+$/, '');
      const apiBase = String(c.tagApiUrl || '').trim() || DEFAULT_TAG_API;

      return enqueue(async () => {
        try {
          // ── 1. 中文自动翻译 ──────────────────────────────────
          let promptText = inputPrompt;
          let translated = null;
          if (HAS_CJK.test(inputPrompt)) {
            if (c.autoTranslate === false) {
              return {
                content:
                  '提示词里有中文，但「中文自动翻译」被关掉了。本机两个模型都只认英文，' +
                  `请把画面改成${p.promptStyle}再调用。`,
                isError: true
              };
            }
            const tr = await translatePrompt(inputPrompt, p);
            if (!tr.ok) {
              return {
                content:
                  `提示词里有中文，自动翻译失败了（${tr.reason}）。` +
                  `请自己把它写成${p.promptStyle}再调用一次。`,
                isError: true
              };
            }
            translated = tr.text;
            promptText = tr.text;
            log(`中文自动翻译（${tr.model}）：${inputPrompt.slice(0, 40)}… → ${translated.slice(0, 80)}…`);
          }

          // ── 1.5 从提示词库补准确写法（可选，默认关）──────────
          // 用**确定性字符串匹配**而不是再问一次 LLM：用户原话里出现了「雨天」是纯判断，
          // 准确、免费、不增加一次往返。只匹配长度≥2 的中文词，单字太容易误命中。
          // 形态按档位选：光辉档吃标签串，Anima 档吃自然语言 —— 加错了反而有害。
          let libMatched = [];
          let libAdded = [];
          if (c.promptLibraryAuto === true) {
            const en = enrichFromLibrary(inputPrompt, c);
            if (en.matched.length) {
              const isTagProfile = p.kind === 'checkpoint';
              const add = isTagProfile ? en.tags : en.ens;
              if (add.length) {
                libMatched = en.matched;
                libAdded = add;
                promptText = `${promptText}, ${add.join(isTagProfile ? ', ' : '. ')}`;
                log(`提示词库命中 ${en.matched.length} 个概念（${en.matched.join('、')}），` +
                  `补上${isTagProfile ? '标签' : '自然语言'}：${add.join(' / ')}`);
              }
            }
          }

          // ── 2. 找参考图（img2img 底图）──────────────────────
          // 分两步做：找图在这里（不需要 ComfyUI），上传放在探活之后（step 4.5）。
          // 降级原则：任何一步失败都**不中断出图**，退回纯文生图，并把原因回给模型。
          //
          // 优先级：ref_file（确切路径）> **聊天里的图**（群友自己发的，最准）
          //         > ref_character（角色外观参考，booru 标签保证"就是这个角色"）> ref_keyword（关键词搜索）。
          // 为什么把"聊天里的图"排在角色参考前面：那是群友**本人指定**的那张，是这次要画的直接依据；
          // 搜索来的图只是它的替代品。
          // 为什么角色参考又排在关键词前面：角色参考走 booru 标签，
          // 「这张图就是这个角色」是**标签保证**的；关键词搜索只能保证"像"。
          let refInfo = null;   // 找到的参考图（本地路径 + 实测宽高）
          let refRef = null;    // 上传到 ComfyUI 后的 LoadImage image 名
          let refNote = '';     // 降级/说明，最后回给模型
          let refCharTag = '';  // 解析出的角色标准标签，稍后注入 prompt
          let refAppearanceTags = [];   // 从参考图里提出的**纯外观**标签（appearance 模式）
          const refKeyword = String(args?.ref_keyword ?? '').trim();
          const refFileArg = String(args?.ref_file ?? '').trim();
          const refCharacter = String(args?.ref_character ?? '').trim();
          const refMessageId = args?.ref_message_id;
          const refRecent = args?.ref_recent_image === true;
          const wantChatRef = (refMessageId !== undefined && refMessageId !== null && String(refMessageId).trim() !== '') || refRecent;
          const minSideCfg = clampInt(numOr(c.refMinShortSide, 512), 0, 4096, 512);
          // 参考图怎么用：
          //   appearance  = 只取外观（默认）—— 从图里提外观标签写进 prompt，走纯文生图，构图与参考图无关
          //   composition = 老行为 —— img2img 重绘，构图/姿势跟着参考图走
          const refMode = String(args?.ref_mode || c.refMode || 'appearance').trim() === 'composition'
            ? 'composition' : 'appearance';
          const appearanceOnly = refMode === 'appearance';

          if (c.refEnabled === false && (refKeyword || refFileArg || refCharacter || wantChatRef)) {
            refNote = '技能设置里关掉了「参考图」，这次按纯文字画。';
          } else if (refFileArg || wantChatRef || refCharacter || refKeyword) {
            // ⓪ 先把角色标签解析出来（**只查标签、不下图**）。
            //    即使参考图最终用的是群友发的那张，角色标准标签仍要注入 prompt ——
            //    所以这步不能和"下载角色参考图"绑在一起，否则会白下一张用不上的图。
            if (refCharacter) {
              try {
                const r = await resolveCharacterName(refCharacter, c);
                refCharTag = r.tag || '';
                if (refCharTag) log(`角色「${refCharacter}」→ 标准标签 ${refCharTag}`);
              } catch (error) {
                warn(`解析角色标准标签失败：${error?.message ?? error}`);
              }
            }

            // ① 调用方直接给了本地路径
            if (refFileArg) {
              if (fs.existsSync(refFileArg)) {
                refInfo = { file: refFileArg, width: 0, height: 0, source: 'local', candidates: 1, relaxed: false };
                log(`使用调用方指定的本地参考图：${refFileArg}`);
              } else {
                refNote = `指定的参考图路径不存在（${refFileArg}）。`;
                warn(refNote);
              }
            }

            // ② 聊天里的图片（群友自己发的 / 引用的那张）—— 最准的参考
            if (!refInfo && wantChatRef) {
              const found = await findChatReference(ctx, c, { messageId: refMessageId, recent: refRecent });
              if (found.ok) {
                refInfo = found;
                log(`聊天参考图就绪：${found.width}x${found.height}｜来源 ${found.source}｜该消息共 ${found.candidates} 张图`);
              } else {
                refNote = `${refNote ? refNote + ' ' : ''}${found.reason}。`;
                warn(refNote);
              }
            }

            // ③ 角色外观参考：走 booru 标签，标签本身保证"就是这个角色"。
            //    appearance 模式下**只验证标签、不下图** —— 外观标签由「角色卡」给出（step 2.5），
            //    下回来的图也用不上。但**验证这一步不能省**：LLM 猜错的标签会被当成标准标签
            //    注入 prompt（测试里拿一个不存在的角色名就复现了：垃圾标签直接进了提示词）。
            if (!refInfo && refCharacter) {
              const found = await findCharacterReference(refCharacter, c, { tag: refCharTag, noDownload: appearanceOnly });
              if (found.ok) {
                refCharTag = found.tag || refCharTag;
                if (appearanceOnly) {
                  log(`角色标签已验证：${found.tag}｜${found.candidates} 张候选｜rating=${found.rating} —— 只取外观，不下图`);
                } else {
                  refInfo = found;
                  log(`角色参考图就绪：「${refCharacter}」→ 标签 ${found.tag}｜${found.width}x${found.height}｜rating=${found.rating}${found.cached ? '｜(命中缓存)' : ''}`);
                  if (found.relaxed) warn(`「${refCharacter}」没有短边≥${minSideCfg} 的候选，放宽后用了这张 ${found.width}x${found.height} 的`);
                  if (found.viaSample) warn(`「${refCharacter}」用的是裁剪样本图（原图拿不到），构图可能不完整`);
                }
              } else {
                refCharTag = '';   // 没通过验证的标签绝不注入 prompt
                refNote = `找「${refCharacter}」的外观信息失败（${found.reason}）。`;
                warn(refNote);
              }
            }

            // ④ 通用构图参考：走 smart-image 的 image.search
            if (!refInfo && refKeyword) {
              if (!hasCapability(IMAGE_SEARCH_CAP)) {
                refNote = `${refNote ? refNote + ' ' : ''}没装/没开「智能配图」技能，拿不到参考图，这次按纯文字画。`;
                warn(refNote);
              } else {
                const found = await findReferenceImage(refKeyword, c);
                if (found.ok) {
                  refInfo = found;
                  log(`找到参考图 ${found.width}x${found.height}｜来源 ${found.source || '未知'}｜候选 ${found.candidates} 张｜${found.file}`);
                  if (found.relaxed) warn(`没有短边≥${minSideCfg} 的候选，放宽后用了这张 ${found.width}x${found.height} 的`);
                } else {
                  refNote = `${refNote ? refNote + ' ' : ''}找参考图失败（${found.reason}），这次按纯文字画。`;
                  warn(refNote);
                }
              }
            }

            // 只取外观：把**图**换成**外观标签**。
            // ⚠️ 提取失败时**故意不回退 img2img** —— 那会违背「不影响构图」的要求。
            //    宁可这次不用参考图（构图完全由 prompt 决定），也不能偷偷把参考图的构图带进来。
            if (appearanceOnly && refInfo) {
              log(`参考图模式=只取外观，正在从 ${path.basename(refInfo.file)} 提取外观标签…`);
              const ex = await extractAppearanceTags(refInfo.file, c);
              if (ex.ok) {
                refAppearanceTags = ex.tags;
                log(`外观标签提取成功（${ex.model}）：${ex.tags.join(', ')}`);
                if (ex.dropped.length) log(`已剔除 ${ex.dropped.length} 个构图/姿势/道具类标签：${ex.dropped.join(', ')}`);
              } else {
                refNote = `${refNote ? refNote + ' ' : ''}这次是「只取外观」模式，但外观提取失败（${ex.reason}）—— 为保证构图不受参考图影响，这次不用参考图。`;
                warn(refNote);
              }
              refInfo = null;   // 无论成败，都不把图送进采样器
            }

            // 尺寸：**只有 composition 模式**才按参考图比例算。
            // appearance 模式不把图送进采样器，出图尺寸与参考图毫无关系，套它的比例反而莫名其妙。
            if (!appearanceOnly && refInfo && !sizeExplicit && refInfo.width > 0 && refInfo.height > 0) {
              const fit = fitSizeInto(refInfo.width, refInfo.height, width, height, maxW, maxH);
              if (fit) {
                log(`按参考图比例定尺寸：默认 ${width}x${height} + 参考图 ${refInfo.width}x${refInfo.height} → ${fit.width}x${fit.height}`);
                width = fit.width;
                height = fit.height;
              }
            }
          }

          // ── 2.5 自动补角色外观标签（联网查角色卡）────────────
          // 刻意放在找参考图**之后**：ref_character 会把角色的标准标签注入 prompt，
          // 这一步就能顺着它把发色/瞳色这些外观标签也补上 ——
          // 于是"参考图保证长得像" + "标签再钉一遍外观"，两边互相加固。
          let addedTags = [];
          // 注入顺序：角色标准标签 → 参考图的外观标签 → 用户原本的 prompt。
          // prompt 里已经出现过的标签不重复加（参考图那张往往和角色标签重叠）。
          const injectTags = [];
          const alreadyHas = () => promptText.toLowerCase();
          if (refCharTag && !alreadyHas().includes(refCharTag.toLowerCase())) injectTags.push(refCharTag);
          for (const t of refAppearanceTags) {
            if (!alreadyHas().includes(t)) injectTags.push(t);
          }
          if (injectTags.length) {
            promptText = `${injectTags.join(', ')}, ${promptText}`;
            log(`已注入标签：${injectTags.join(', ')}` +
              (refAppearanceTags.length ? '（外观标签来自参考图，**不携带构图**）' : ''));
          }
          if (c.autoCharacterCard !== false) {
            try {
              const enrich = await autoCharacterAppearance(apiBase, promptText, c);
              if (enrich.added.length) {
                addedTags = enrich.added;
                promptText = `${promptText}, ${enrich.added.join(', ')}`;
                log(`识别到角色「${enrich.character}」（${enrich.samples} 张样本），自动补外观标签：${enrich.added.join(', ')}`);
              }
            } catch (error) {
              warn(`自动补角色标签失败（不影响出图）：${error?.message ?? error}`);
            }
          }

          // ── 3. 探活（不在就自动拉起）─────────────────────────
          if (!(await pingComfy(base))) {
            if (c.autoStartComfyUI === false) {
              return { content: `连不上本机 ComfyUI（${base}）。请先双击 E:\\ComfyUI\\启动ComfyUI.bat 把它跑起来，或者检查技能设置里的「ComfyUI 地址」。`, isError: true };
            }
            if (startFailures >= 2) {
              return { content: `ComfyUI（${base}）没在运行，而且自动拉起已经失败过 ${startFailures} 次，先不重试了。请手动双击 E:\\ComfyUI\\启动ComfyUI.bat 看它报什么错。`, isError: true };
            }
            log('ComfyUI 未运行，尝试自动拉起…');
            const started = await startComfyUI(c, base);
            if (!started.ok) { startFailures += 1; return { content: started.reason, isError: true }; }
            startFailures = 0;
            log('ComfyUI 已就绪');
          }

          // ── 4. 定模型 ────────────────────────────────────────
          const resolved = await resolveModels(base, p, c);
          if (!resolved.ok) return { content: resolved.error, isError: true };

          // ── 4.5 把参考图送进 ComfyUI（必须在探活之后）────────
          if (refInfo) {
            const sent = await sendReferenceToComfy(base, refInfo.file, c);
            if (sent.ok) {
              refRef = sent.ref;
            } else {
              refNote = `${sent.reason} 这次按纯文字画。`;
              warn(refNote);
              refInfo = null;   // 降级成纯文生图（buildWorkflow 会走 EmptyLatentImage 分支）
              refRef = null;
            }
          }

          // ── 5. 提交 ──────────────────────────────────────────
          const negativeProfile = String(c.negativePrefix || '').trim() || p.negative;
          const negativeExtra = [String(c.extraNegative || '').trim(), String(args?.negative_prompt || '').trim()].filter(Boolean).join(', ');
          const workflow = buildWorkflow(p, {
            prompt: promptText,
            negativeProfile,
            negativeExtra,
            prependQuality: c.prependQuality !== false && p.prependQuality,
            width, height, steps, cfg: cfgScale, seed,
            model: resolved.files,
            refImage: refRef,
            denoise: refDenoise
          });

          const submitResp = await fetchWithTimeout(`${base}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: workflow, client_id: 'qq-agent-comfyui-image' })
          }, 30000);
          if (!submitResp.ok) {
            const text = await submitResp.text().catch(() => '');
            return { content: `ComfyUI 拒绝了这个任务：HTTP ${submitResp.status} ${text.slice(0, 300)}`, isError: true };
          }
          const submitted = await submitResp.json().catch(() => null);
          const promptId = submitted?.prompt_id;
          if (!promptId) return { content: `ComfyUI 没有返回 prompt_id：${JSON.stringify(submitted).slice(0, 300)}`, isError: true };

          lastRunAt.set(chatKey, Date.now());
          const modelDesc = p.kind === 'checkpoint' ? resolved.files.checkpoint
            : `${resolved.files.unet} + Qwen3${p.kind === 'anima-turbo' ? ' + turbo LoRA' : ''}`;
          log(`已提交 ${promptId}｜${p.id}｜${width}x${height}｜${steps} 步｜cfg ${cfgScale}｜${modelDesc}` +
            (refRef ? `｜img2img denoise ${refDenoise}（参考图 ${path.basename(refInfo?.file || '')}）`
              : (refAppearanceTags.length ? '｜txt2img（参考图只提供外观标签）' : '｜txt2img')));
          const startedAt = Date.now();

          // ── 6. 轮询 ──────────────────────────────────────────
          const timeoutMs = Math.max(60, Number(c.timeoutSec) || 420) * 1000;
          let entry = null;
          while (true) {
            if (Date.now() - startedAt > timeoutMs) {
              return { content: `等出图超过 ${Math.round(timeoutMs / 1000)} 秒还没好。可能是显存不够或 ComfyUI 卡住了，去 ComfyUI 那个黑窗口看看报错。`, isError: true };
            }
            await sleep(2000);
            let hist = null;
            try { hist = await getJson(`${base}/history/${promptId}`, 20000); }
            catch (error) { warn(`查询历史失败（继续重试）：${error?.message ?? error}`); continue; }
            const hit = hist && hist[promptId];
            if (!hit) continue;
            const statusStr = hit?.status?.status_str;
            if (statusStr === 'error' || hit?.status?.completed === false) {
              const msgs = (hit?.status?.messages || []).map((m) => (Array.isArray(m) ? `${m[0]}: ${JSON.stringify(m[1]).slice(0, 200)}` : String(m))).join(' | ');
              return { content: `ComfyUI 出图失败：${msgs || '未知错误'}`, isError: true };
            }
            entry = hit;
            break;
          }

          const images = collectImages(entry);
          if (!images.length) return { content: 'ComfyUI 跑完了但没有产出图片。检查工作流里的 SaveImage 节点。', isError: true };

          // ── 7. 取图落盘 ──────────────────────────────────────
          const pick = images[0];
          const viewUrl = new URL(`${base}/view`);
          viewUrl.searchParams.set('filename', pick.filename);
          viewUrl.searchParams.set('subfolder', pick.subfolder || '');
          viewUrl.searchParams.set('type', pick.type || 'output');
          const imgResp = await fetchWithTimeout(viewUrl.toString(), { method: 'GET' }, 60000);
          if (!imgResp.ok) return { content: `取图失败：HTTP ${imgResp.status}`, isError: true };
          const buffer = Buffer.from(await imgResp.arrayBuffer());
          if (!buffer.length) return { content: '取回来的图片是空的。', isError: true };

          const dir = String(c.outputDir || '').trim() || path.join(DATA_DIR, 'comfyui-images');
          fs.mkdirSync(dir, { recursive: true });
          const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
          const localFile = path.join(dir, `comfyui_${stamp}_${Math.random().toString(36).slice(2, 8)}.png`);
          fs.writeFileSync(localFile, buffer);
          const seconds = Math.round((Date.now() - startedAt) / 1000);

          // ── 8. 发送 ──────────────────────────────────────────
          try {
            await ctx.sender.sendImage(ctx.chatKey, { file: localFile }, { note: `AI画图 ${width}x${height}` });
          } catch (error) {
            return { content: `图画好了（存在 ${localFile}），但发送失败：${error?.message ?? error}`, isError: true };
          }

          log(`出图完成 ${seconds}s｜${p.id}｜${width}x${height}｜${localFile}`);
          const notes = [];
          if (refRef) notes.push(`用参考图重绘（img2img，重绘幅度 ${refDenoise}${refInfo?.source ? `，参考图来源 ${refInfo.source}` : ''}）。`);
          if (refAppearanceTags.length) {
            notes.push(`参考图**只提供了外观**（${refAppearanceTags.length} 个标签：${refAppearanceTags.join(', ')}）—— 构图、姿势、机位完全由你的描述决定，不受参考图影响。`);
          }
          if (refNote) notes.push(refNote);
          if (translated) notes.push(`已把中文自动翻译成英文提示词：${translated.slice(0, 120)}`);
          if (addedTags.length) notes.push(`已自动补该角色的外观标签：${addedTags.join(', ')}`);
          if (libMatched.length) notes.push(`已从提示词库补上更准确的写法（命中概念 ${libMatched.join('、')}）：${libAdded.join(', ')}`);
          return {
            content:
              `已发送一张图（${width}x${height}，${p.label}，${steps} 步，` +
              `${refRef ? '参考图重绘' : (refAppearanceTags.length ? '文字生成 + 参考图外观' : '文字生成')}，用时约 ${seconds} 秒）。` +
              (notes.length ? '\n' + notes.join('\n') : '') +
              '\n不要再复述或描述图片内容，群友自己看得见。'
          };
        } catch (error) {
          if (error?.name === 'AbortError') return { content: '请求超时了，ComfyUI 可能正忙或者卡住了。', isError: true };
          return { content: `画图失败：${error?.message ?? error}`, isError: true };
        }
      });
    }
  });

  const p0 = profileOf(cfg() || {});
  const lc = readLlmConfig(cfg() || {});
  log(`已注册（档位 ${p0.id}，ComfyUI ${String(cfg()?.baseUrl || 'http://127.0.0.1:8188')}，` +
    `翻译 ${lc.ok ? `开（${lc.model}）` : '不可用（config.json 缺 api 配置）'}）`);
}

export function available() {
  return true;
}
