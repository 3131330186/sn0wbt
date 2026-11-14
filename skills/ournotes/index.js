// Our Notes 查询（LLM 型 Skill）。
//
// 三个工具：查曲、查卡、数据状态。对应上游 ournotes-qq-bot 的 /查曲 /查卡 /查缩写 与 `数据状态`。
// 上游另外两条命令在本移植里的处理：
//   · /查活动 /查卡池 /ycx —— 上游自己也没实现（只回"暂未上线"），这里不注册工具，
//     改在提示词里说明，省掉两个永远不会被有效调用的工具；
//   · /查谱面 —— 上游的谱面站点 assets.bdon.moe/chart-site 实测全 404，暂不做。
//
// 与上游的分工差异：出站一律走 ctx.sender.sendMedia（由核心负责串行、限频、去重、留档），
// 不自己控频；回复语言交给模型，所以上游那份 i18n.py（5.7 KB）整个不需要。
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ⚠️ 子模块必须用「入口自己的查询串」动态导入，不能用静态 import。
//
// 加载器的热重载是 `import(`${entryUrl}?t=${Date.now()}`)` —— 时间戳只加在**入口**上，
// 入口里的静态 import（`import './lib/query.js'`）不带它，于是 Node 的 ESM 缓存会一直
// 返回第一次加载时的那份旧模块。后果：改完子模块热重载会读到旧代码，报
// `does not provide an export named 'xxx'`，而且加载器那条分支不打日志，很难查。
//
// 把入口的查询串传给子模块，它们就会跟着一起失效 —— 改任何文件都能正确热重载。
const CACHE_BUST = new URL(import.meta.url).search;

const { OurNotesStore } = await import(`./lib/sync.js${CACHE_BUST}`);
const {
  searchSongs, searchCards, searchCharts, searchEvents, searchGachas,
  resolvePoolEntry, summarizePool, dataStatus,
  jacketUrl, cardArtUrl, assetKeyUrl, resolveAlias,
} = await import(`./lib/query.js${CACHE_BUST}`);

const HERE = path.dirname(fileURLToPath(import.meta.url));

let api = null;
let store = null;
let cacheDirCache = null;

/** 缓存目录：设置优先 → QQ Agent 的 DATA_DIR → 插件目录下的 data/。 */
async function cacheDir() {
  if (cacheDirCache) return cacheDirCache;
  const configured = String(api?.config()?.cacheDir ?? '').trim();
  if (configured) {
    cacheDirCache = configured;
    return cacheDirCache;
  }
  try {
    const mod = await import('../../src/config.js');
    if (mod.DATA_DIR) {
      cacheDirCache = path.join(mod.DATA_DIR, 'ournotes');
      return cacheDirCache;
    }
  } catch { /* 脱离 QQ Agent 单跑时走插件目录 */ }
  cacheDirCache = path.join(HERE, 'data');
  return cacheDirCache;
}

function settings() {
  return api?.config() ?? {};
}

function ok(text) {
  return { content: text };
}

function err(text) {
  return { content: text, isError: true };
}

async function ensureData({ force = false } = {}) {
  const dir = await cacheDir();
  if (!store) store = new OurNotesStore(api, settings(), (message) => api?.log?.(message));
  // 设置随时可能被面板改掉，每次取用前同步一次
  store.settings = settings();
  const result = await store.ensure(dir, { force });
  return result;
}

/** 判断一段文字属于哪种书写系统。含假名优先判为日文（日文里也有汉字）。 */
function scriptOf(text) {
  if (/[\u3040-\u30ff]/.test(text)) return 'kana';
  if (/[\uac00-\ud7af]/.test(text)) return 'hangul';
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(text)) return 'han';
  if (/[a-z]/i.test(text)) return 'latin';
  return 'other';
}

/**
 * 把多语言字段压成一行短标签。
 *
 * 上游有些字段本身是合并串（角色名是 `Oblivionis / 丰川祥子`），
 * 五种语言原样拼开会有十来个词，既撑上下文又难读。这里按书写系统去重，
 * 每种只保留第一次出现的那个，既短又不丢语种。
 */
function multilingual(value, limit = 3) {
  if (!value) return '';
  const picked = [];
  const seenScript = new Set();
  const seenText = new Set();
  for (const raw of Object.values(value)) {
    for (const part of String(raw).split(/\s*\/\s*/)) {
      const text = part.trim();
      if (!text || seenText.has(text)) continue;
      seenText.add(text);
      const script = scriptOf(text);
      if (script === 'other' || seenScript.has(script)) continue;
      seenScript.add(script);
      picked.push(text);
    }
  }
  // 全是重复书写系统时（例如只有汉字）退回按出现顺序取
  if (!picked.length) {
    for (const raw of Object.values(value)) {
      const text = String(raw).trim();
      if (text) picked.push(text);
      if (picked.length >= limit) break;
    }
  }
  return picked.slice(0, limit).join(' / ');
}

function formatCharts(charts) {
  const order = ['EASY', 'NORMAL', 'HARD', 'EXPERT'];
  const byDifficulty = new Map(charts.map((chart) => [chart.difficulty, chart]));
  return order
    .map((difficulty) => byDifficulty.get(difficulty))
    .filter(Boolean)
    .map((chart) => `${chart.difficulty} ${chart.displayLevel}`)
    .join(' / ');
}

function formatSong(song) {
  const lines = [`id=${song.id} | ${multilingual(song.title)}${song.band ? ` | band=${multilingual(song.band)}` : ''}`];
  if (song.charts.length) lines.push(`  ${formatCharts(song.charts)}`);
  return lines.join('\n');
}

/** 谱面行：每个难度一行，给等级与物量（`_fullComboCount`，与上游口径一致）。 */
function formatChartRow(song) {
  const lines = [`id=${song.id} | ${multilingual(song.title)}${song.band ? ` | band=${multilingual(song.band)}` : ''}`];
  if (!song.charts.length) {
    lines.push('  （该难度没有谱面）');
    return lines.join('\n');
  }
  for (const chart of song.charts) {
    lines.push(`  ${chart.difficulty.padEnd(6)} 等级 ${String(chart.displayLevel).padStart(4)}   物量 ${chart.notes}`);
  }
  return lines.join('\n');
}

function formatCard(card) {
  const sub = multilingual(card.subtitle);
  const skill = multilingual(card.skill);
  return `id=${card.id} | ${multilingual(card.character)} | ${card.rarityLabel}` +
    `${sub ? ` | sub=${sub}` : ''} | power=${card.power.total} (${card.power.performance}/${card.power.technic}/${card.power.visual})` +
    `${skill ? ` | skill=${skill}` : ''}`;
}

/** 活动按需求保持精简：名字 + 时间。时间串原样给，不猜时区。 */
function formatEvent(event) {
  const lines = [`id=${event.id} | ${multilingual(event.name)}`];
  lines.push(`  ${event.startAt || '(无开始时间)'} ~ ${event.endAt || '(无结束时间)'}`);
  if (event.displayEndAt) lines.push(`  展示至 ${event.displayEndAt}`);
  return lines.join('\n');
}

/** 关联角色与乐队 —— 让「梦限大的卡池」这类查询在结果里看得见命中理由。 */
function formatFeatured(gacha) {
  const bands = (gacha.featured?.bands || []).map((band) => multilingual(band.name, 2));
  const characters = (gacha.featured?.characters || []).map((character) => multilingual(character.name, 2));
  if (!bands.length && !characters.length) return '';
  const shown = characters.slice(0, 5);
  const more = characters.length > shown.length ? ` 等 ${characters.length} 位` : '';
  const parts = [];
  if (bands.length) parts.push(bands.join(' / '));
  if (shown.length) parts.push(`${shown.join('、')}${more}`);
  return `\n  关联：${parts.join(' ｜ ')}`;
}

/** 万分比 → 百分比文本。上游的 _weight 与 _pickUpFixedRate 都是万分比。 */
function percent(bp) {
  if (!Number.isFinite(bp)) return '—';
  return `${(bp / 100).toFixed(2)}%`;
}

function formatGachaLine(gacha) {
  const window = `${gacha.startAt || '(无开始时间)'} ~ ${gacha.endAt || '(无结束时间)'}`;
  const rateUp = gacha.rateUpCount
    ? `rate-up ${gacha.rateUpCount} 张，主推合计 ${percent(gacha.rateUpTotalBp)}；`
    : '';
  return `id=${gacha.id} | ${multilingual(gacha.name)}${gacha.isLimited ? ' | 限定' : ''}\n`
    + `  ${window}\n`
    + `  ${rateUp}收录 ${gacha.poolCount} 项（${summarizePool(gacha.pool)}）`
    + formatFeatured(gacha);
}

/** 只查到一个卡池时展开 rate-up 明细（含单抽出率），列多个时只给概览，免得刷屏。 */
function formatGachaDetail(gacha, data) {
  const lines = [formatGachaLine(gacha)];
  const entries = gacha.pool.filter((entry) => entry.rateUp).map((entry) => resolvePoolEntry(entry, data));
  for (const entry of entries) {
    const kind = entry.kind === 'support' ? '支援卡' : '成员卡';
    lines.push(`  [rate-up] ${kind} ${multilingual(entry.character)}「${multilingual(entry.subtitle)}」`
      + `${entry.rarityLabel}　单抽 ${percent(entry.rateBp)}`);
  }
  return lines.join('\n');
}

/**
 * 把图片作为独立气泡发出。数量由 maxImages 限制，避免一页封面把群刷屏。
 * 失败不影响查询结果 —— 图文里文字部分仍然有效。
 */
async function sendImages(ctx, urls, dedupeKey) {
  const list = urls.filter(Boolean);
  if (!list.length) return { sent: 0, error: null };
  if (!ctx?.sender?.sendMedia || !ctx?.chatKey) return { sent: 0, error: '当前会话不支持发图' };
  const segments = list.map((url) => ({ type: 'image', data: { file: url } }));
  try {
    await ctx.sender.sendMedia(ctx.chatKey, segments, { label: '[图片]', dedupeKey });
    return { sent: list.length, error: null };
  } catch (error) {
    return { sent: 0, error: error?.message ?? String(error) };
  }
}

/** 供测试与排障：直接看当前缓存目录。 */
export async function resolveCacheDir() {
  return cacheDir();
}

export function available() {
  return { ok: true };
}

/**
 * 每次调用现读设置。面板改设置**不会**触发 Skill 重载（routes.js 只写 config，
 * 不调 reloadSkills），所以在 setup 时读成常量会导致"改了没反应"。
 */
function runtimeSettings() {
  const config = settings();
  return {
    pageSize: Number(config.pageSize) > 0 ? Number(config.pageSize) : 8,
    language: String(config.assetLanguage || 'zh-Hans'),
    imageMode: config.cardImage === 'full' ? 'member_full' : 'member_thumbnail',
    wantImages: config.sendImages !== false,
    maxImages: Number(config.maxImages) > 0 ? Number(config.maxImages) : 3,
  };
}

export function setup(skillApi) {
  api = skillApi;

  api.registerTool({
    id: 'song_search',
    name: '查曲',
    description: '查询《BanG Dream! Our Notes》的曲目：按歌名（中文/繁体/日文/英文/假名读音均可）或曲目 ID 查，'
      + '也可按谱面等级筛选。返回曲目 ID、乐队与四个难度的等级。'
      + '整数等级 27 会包含显示为 27.5 的谱面；写 27.5 才是精确匹配该显示等级。',
    category: 'query',
    icon: '🎵',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '歌名或曲目 ID；中日英文与假名读音都能匹配' },
        level: { type: 'string', description: '可选，谱面等级筛选，如 27、lv27、27.5' },
        page: { type: 'integer', description: '可选，页码，默认第 1 页' },
      },
      required: ['query'],
    },
    async execute(ctx, args) {
      let prepared;
      try {
        prepared = await ensureData();
      } catch (error) {
        return err(`数据不可用：${error?.message ?? error}`);
      }
      const rt = runtimeSettings();
      const result = searchSongs(store.data, {
        query: args?.query,
        level: args?.level,
        page: args?.page,
        pageSize: rt.pageSize,
      });
      if (result.error) return err(result.error);
      if (!result.total) {
        const scope = result.level
          ? `没有等级 ${args?.level} 的曲目命中「${args?.query}」`
          : `没有找到匹配「${args?.query}」的曲目`;
        return ok(`${scope}。可以换用中日英文名、假名读音或曲目 ID 再试。`);
      }

      const header = `第 ${result.page}/${result.pages} 页，共 ${result.total} 首：`;
      const body = result.items.map(formatSong).join('\n');
      const footer = result.hasMore ? `\n（还有下一页，page=${result.page + 1}）` : '';

      let imageNote = '';
      if (rt.wantImages) {
        const urls = result.items.slice(0, rt.maxImages)
          .map((song) => jacketUrl(rt.language, song.jacket));
        const sent = await sendImages(ctx, urls, `ournotes:song:${result.items.map((s) => s.id).join(',')}`);
        imageNote = sent.sent
          ? `\n（已发出 ${sent.sent} 张封面图，回答时不要再贴图片链接）`
          : (sent.error ? `\n（封面图发送失败：${sent.error}）` : '');
      }

      const stale = prepared.stale ? '\n（注意：上游暂时不可达，以下为本地缓存数据）' : '';
      return ok(`${header}\n${body}${footer}${imageNote}${stale}`);
    },
  });

  api.registerTool({
    id: 'card_search',
    name: '查卡',
    description: '查询《BanG Dream! Our Notes》的卡牌：按角色名、角色缩写（如 skk=祥子、tmr=灯、mtm=睦）、'
      + '乐队名（如「梦限大」）或卡牌 ID 查。返回卡牌 ID、角色、稀有度、卡面副标题、综合力与技能名。',
    category: 'query',
    icon: '🃏',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '角色名、角色缩写或卡牌 ID' },
        page: { type: 'integer', description: '可选，页码，默认第 1 页' },
      },
      required: ['query'],
    },
    async execute(ctx, args) {
      let prepared;
      try {
        prepared = await ensureData();
      } catch (error) {
        return err(`数据不可用：${error?.message ?? error}`);
      }
      const rt = runtimeSettings();
      const result = searchCards(store.data, {
        query: args?.query,
        page: args?.page,
        pageSize: rt.pageSize,
      });
      if (result.error) return err(result.error);
      if (!result.total) {
        const alias = resolveAlias(args?.query);
        if (alias) {
          return ok(`缩写「${args.query}」对应 ${alias.display}（${alias.official.join('、')}），但这个角色暂时没有卡牌数据。`);
        }
        return ok(`没有找到匹配「${args?.query}」的卡牌。可以用角色名、缩写（skk/tmr/mtm 等）或卡牌 ID 再试。`);
      }

      const aliasNote = result.alias
        ? `（「${args.query}」→ ${result.alias.display} / ${result.alias.official.join('、')}）\n`
        : '';
      const header = `${aliasNote}第 ${result.page}/${result.pages} 页，共 ${result.total} 张：`;
      const body = result.items.map(formatCard).join('\n');
      const footer = result.hasMore ? `\n（还有下一页，page=${result.page + 1}）` : '';

      let imageNote = '';
      if (rt.wantImages) {
        const urls = result.items.slice(0, rt.maxImages)
          .map((card) => cardArtUrl(rt.language, card.assetId, rt.imageMode));
        const sent = await sendImages(ctx, urls, `ournotes:card:${result.items.map((c) => c.id).join(',')}`);
        imageNote = sent.sent
          ? `\n（已发出 ${sent.sent} 张卡面图，回答时不要再贴图片链接）`
          : (sent.error ? `\n（卡面图发送失败：${sent.error}）` : '');
      }

      const stale = prepared.stale ? '\n（注意：上游暂时不可达，以下为本地缓存数据）' : '';
      return ok(`${header}\n${body}${footer}${imageNote}${stale}`);
    },
  });

  api.registerTool({
    id: 'chart_info',
    name: '查谱面',
    description: '查询某首歌的谱面资料：各难度的等级与物量（音符数）。'
      + 'query 给歌名或曲目 ID —— 数字一律按曲目 ID 处理，并支持「100001 写成 1」的简写。'
      + '可用 difficulty 只看一个难度（EASY / NORMAL / HARD / EXPERT）。'
      + '想按等级筛选曲目请用 ournotes__song_search，不要用这个工具。',
    category: 'query',
    icon: '🎼',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '歌名或曲目 ID；数字按 ID 处理，可用 1 代表 100001' },
        difficulty: { type: 'string', description: '可选，只看某个难度：EASY / NORMAL / HARD / EXPERT' },
        page: { type: 'integer', description: '可选，页码，默认第 1 页' },
      },
      required: ['query'],
    },
    async execute(ctx, args) {
      let prepared;
      try {
        prepared = await ensureData();
      } catch (error) {
        return err(`数据不可用：${error?.message ?? error}`);
      }
      const rt = runtimeSettings();
      const result = searchCharts(store.data, {
        query: args?.query,
        difficulty: args?.difficulty,
        page: args?.page,
        pageSize: rt.pageSize,
      });
      if (result.error) return err(result.error);
      if (!result.total) {
        return ok(`没有找到匹配「${args?.query}」的曲目。数字会按曲目 ID 处理（100001 可写成 1），也可以换歌名再试。`);
      }
      const header = `第 ${result.page}/${result.pages} 页，共 ${result.total} 首：`;
      const body = result.items.map(formatChartRow).join('\n');
      const stale = prepared.stale ? '\n（注意：上游暂时不可达，以下为本地缓存数据）' : '';
      return ok(`${header}\n${body}${stale}`);
    },
  });

  api.registerTool({
    id: 'gacha_info',
    name: '查卡池',
    description: '查询《BanG Dream! Our Notes》的卡池（招募）：卡池名、开放时间、是否限定，'
      + '以及收录了哪些卡、哪些是 rate-up（主打）和它们的单抽出现概率。'
      + 'query 也能填角色名、角色缩写或乐队名（如「梦限大」「由乃」「yuno」），'
      + '会关联到主打这些角色或乐队的卡池 —— 卡池名里可能完全不含这些词。'
      + '不传 query 时列出全部卡池。'
      + '出率由主数据的万分比权重算出（桶权重 _weight 合计精确等于 10000，'
      + '主推单卡直接用 _pickUpFixedRate），是**单抽**概率；'
      + '十连保底写在 MasterGachaProduct 里，工具不反映保底之后的实际分布。'
      + '被问到概率时直接转述工具给的数字，不要自己再推算、加总或换算。',
    category: 'query',
    icon: '🎴',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '卡池名或卡池 ID；留空列出全部卡池' },
        page: { type: 'integer', description: '可选，页码，默认第 1 页' },
      },
    },
    async execute(ctx, args) {
      let prepared;
      try {
        prepared = await ensureData();
      } catch (error) {
        return err(`数据不可用：${error?.message ?? error}`);
      }
      const rt = runtimeSettings();
      const result = searchGachas(store.data, {
        query: args?.query,
        page: args?.page,
        pageSize: rt.pageSize,
      });
      if (!result.total) {
        return ok(args?.query
          ? `没有找到匹配「${args.query}」的卡池。可以换用卡池名或卡池 ID。`
          : '主数据里目前没有卡池数据（可能是上游还没放出，或本地缓存待刷新，用 ournotes__data_status 看版本与缓存时间）。');
      }

      const header = `第 ${result.page}/${result.pages} 页，共 ${result.total} 个卡池：`;
      // 只命中一个时展开 rate-up 明细；列多个时只给概览，免得一次刷出上百行
      const body = result.total === 1 && result.items.length === 1
        ? formatGachaDetail(result.items[0], store.data)
        : result.items.map(formatGachaLine).join('\n');
      const footer = result.hasMore ? `\n（还有下一页，page=${result.page + 1}）` : '';

      let imageNote = '';
      if (rt.wantImages) {
        const urls = result.items.slice(0, rt.maxImages)
          .map((gacha) => assetKeyUrl(rt.language, gacha.banner));
        const sent = await sendImages(ctx, urls, `ournotes:gacha:${result.items.map((g) => g.id).join(',')}`);
        imageNote = sent.sent
          ? `\n（已发出 ${sent.sent} 张卡池图，回答时不要再贴图片链接）`
          : (sent.error ? `\n（卡池图发送失败：${sent.error}）` : '');
      }

      const stale = prepared.stale ? '\n（注意：上游暂时不可达，以下为本地缓存数据）' : '';
      return ok(`${header}\n${body}${footer}${imageNote}${stale}`);
    },
  });

  api.registerTool({
    id: 'event_info',
    name: '查活动',
    description: '查询《BanG Dream! Our Notes》的活动：活动名与起止时间。'
      + '用户问「现在有什么活动」「活动什么时候结束」时使用。'
      + '返回的时间串是上游原样给出的、不带时区，不要自行换算时区。',
    category: 'query',
    icon: '🎪',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '活动名或活动 ID；留空列出全部活动' },
        page: { type: 'integer', description: '可选，页码，默认第 1 页' },
      },
    },
    async execute(ctx, args) {
      let prepared;
      try {
        prepared = await ensureData();
      } catch (error) {
        return err(`数据不可用：${error?.message ?? error}`);
      }
      const rt = runtimeSettings();
      const result = searchEvents(store.data, {
        query: args?.query,
        page: args?.page,
        pageSize: rt.pageSize,
      });
      if (!result.total) {
        return ok(args?.query
          ? `没有找到匹配「${args.query}」的活动。可以留空 query 列出全部活动。`
          : '主数据里目前没有活动。');
      }
      const header = `第 ${result.page}/${result.pages} 页，共 ${result.total} 个活动：`;
      const body = result.items.map(formatEvent).join('\n');
      // 活动素材（banner/logo/top）在上游素材服务里全是 404，所以这里不发图
      const stale = prepared.stale ? '\n（注意：上游暂时不可达，以下为本地缓存数据）' : '';
      return ok(`${header}\n${body}${stale}`);
    },
  });

  api.registerTool({
    id: 'data_status',
    name: '数据状态',
    description: '查看《BanG Dream! Our Notes》主数据的版本、曲目与卡牌数量，以及本地缓存时间。'
      + '用户问"数据什么时候更新的""有多少首歌"时使用。',
    category: 'query',
    icon: '📊',
    parameters: { type: 'object', properties: {} },
    async execute(ctx, args) {
      let prepared;
      try {
        prepared = await ensureData({ force: args?.refresh === true });
      } catch (error) {
        return err(`数据不可用：${error?.message ?? error}`);
      }
      const status = dataStatus(store, {
        cacheSource: prepared.source,
        stale: prepared.stale === true,
        lastError: prepared.error ?? null,
      });
      return ok([
        `region=${status.region}`,
        `dataVersion=${status.dataVersion ?? '未知'}`,
        `resourceVersion=${status.resourceVersion ?? '未知'}`,
        `upstreamFetchedAt=${status.upstreamFetchedAt ?? '未知'}`,
        `cachedAt=${status.cachedAt ?? '未知'}`,
        `songs=${status.songCount}`,
        `cards=${status.cardCount}`,
        `characters=${status.characterCount}`,
        status.stale ? `stale=true（上游不可达，沿用旧缓存：${status.lastError}）` : 'stale=false',
      ].join('\n'));
    },
  });
}

/** 测试用：把 store 注入进来，避免走网络。 */
export function __setStore(injected) {
  store = injected;
}
