// 查询层：名称归一化、角色别名、等级语义、分页、图片 URL。
//
// 三条「怪规矩」来自上游 commands.py，必须逐条对齐，否则会静默答错：
//   1. 整数等级 27 要包含显示为 27.5 的谱面 —— 落在 _musicScoreLevel 整数桶上；
//   2. 纯数字若恰好是曲目 ID，优先按 ID 查；否则当名字查；
//   3. 只有「查谱面」允许 100001 简写成 1，查曲不允许 —— 所以这里不做任何补零/截断。
import { ASSET_BASE } from './sync.js';

/**
 * 角色别名表，逐条移植自上游 data.py 的 CHARACTER_GROUPS。
 * 上游说明：名单依 bang-dream-on.bushimo.jp；拉丁短名含用户习惯昵称与官方名的无歧义缩写；
 * Ave Mujica 成员同时收录本名与艺名，否则查卡会漏。
 */
export const CHARACTER_GROUPS = [
  ['灯', ['高松燈'], ['tmr', 'tomori', '灯', '燈']],
  ['爱音', ['千早愛音'], ['anon', '爱音', '愛音']],
  ['乐奈', ['要楽奈'], ['rana', '乐奈', '楽奈']],
  ['素世', ['長崎そよ'], ['soyo', '素世', 'そよ']],
  ['立希', ['椎名立希'], ['rikki', 'rkk', 'taki', '立希']],
  ['初华', ['三角初華', 'ドロリス'], ['uika', 'uik', 'doloris', 'dls', '初华', '初華']],
  ['睦', ['若葉睦', 'モーティス'], ['mtm', 'mutsumi', 'mortis', '睦', '若叶睦', '若葉睦']],
  ['海铃', ['八幡海鈴', 'ティモリス'], ['umiri', 'umr', 'timoris', '海铃', '海鈴']],
  ['喵梦', ['祐天寺にゃむ', 'アモーリス'], ['nyamu', 'nym', 'amoris', 'にゃむ', '喵梦']],
  ['祥子', ['豊川祥子', 'オブリビオニス'], ['skk', 'saki', 'sakiko', 'oblivionis', '祥子']],
  ['阿拉蕾', ['仲町あられ'], ['arl', 'arale', '阿拉蕾', 'あられ']],
  ['野乃花', ['宮永ののか'], ['nnk', 'nonoka', '野乃花', 'ののか']],
  ['峰月律', ['峰月律'], ['rts', 'ritsu', '峰月律']],
  ['藤都子', ['藤都子'], ['myk', 'miyako', '藤都子']],
  ['千石由乃', ['千石ユノ'], ['yuno', '千石由乃', '千石ユノ']],
  ['汐见萤', ['汐見蛍'], ['htr', 'hotaru', '汐见萤', '汐見蛍']],
  ['伊泽夏目', ['伊沢なつめ'], ['ntsm', 'natsume', '伊泽夏目', '伊沢なつめ']],
  ['琴平凪', ['琴平凪'], ['nagi', '琴平凪']],
  ['滨崎真幌', ['浜崎まほろ'], ['mhr', 'mahoro', '滨崎真幌', '浜崎まほろ']],
  ['和泉朋花', ['和泉朋花'], ['hka', 'houka', '和泉朋花']],
  ['须贺蕾叶', ['須賀蕾叶'], ['raika', 'rka', '须贺蕾叶', '須賀蕾叶']],
  ['马桥心玖', ['馬橋心玖'], ['miku', 'mku', '马桥心玖', '馬橋心玖']],
  ['矢仓蓬咲', ['矢倉蓬咲'], ['ymg', 'yomogi', '矢仓蓬咲', '矢倉蓬咲']],
  ['梅里千绘里', ['梅里ちえり'], ['chr', 'chieri', '梅里千绘里', '梅里ちえり']],
  ['四宫宁月', ['四宮寧月'], ['szk', 'shizuku', '四宫宁月', '四宮寧月']],
];

/** 全角转半角、大小写、空白一并归一，与上游 normalize 语义一致。 */
export function normalize(text) {
  return String(text ?? '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '');
}

const ALIAS_INDEX = new Map();
for (const [display, official, terms] of CHARACTER_GROUPS) {
  const entry = { display, official, terms };
  for (const term of [display, ...official, ...terms]) {
    const key = normalize(term);
    if (key) ALIAS_INDEX.set(key, entry);
  }
}

/** 解析角色缩写/别名；查不到返回 null。 */
export function resolveAlias(query) {
  const key = normalize(query);
  if (!key) return null;
  return ALIAS_INDEX.get(key) || null;
}

/**
 * 解析等级写法：`27`、`lv27`、`Lv.27`、`27.5`、`lv27.5` 都认。
 * 返回 { kind: 'int' | 'decimal', value }，非法写法返回 null。
 */
export function parseLevel(raw) {
  const text = String(raw ?? '')
    .normalize('NFKC')
    .trim()
    .toLowerCase()
    .replace(/^lv\.?/, '')
    .replace(/\s+/g, '');
  if (!text) return null;
  if (!/^\d{1,2}(\.\d)?$/.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  return { kind: Number.isInteger(value) ? 'int' : 'decimal', value };
}

/** 单个谱面是否命中等级条件。整数等级用整数桶，因此 display 27.5 会被 27 命中。 */
export function chartMatchesLevel(chart, level) {
  if (!level) return true;
  if (level.kind === 'int') return chart.level === level.value;
  return chart.displayLevel === level.value;
}

function valuesOf(localizedObject) {
  if (!localizedObject) return [];
  return Object.values(localizedObject).filter((value) => typeof value === 'string' && value);
}

const CJK_PATTERN = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af]/;

/** 按非字母数字切词，用于 ASCII 的整词匹配。 */
function tokenize(raw) {
  return String(raw ?? '')
    .split(/[^\p{L}\p{N}]+/u)
    .map((part) => normalize(part))
    .filter(Boolean);
}

/**
 * 词，以及「若干连续词的拼接」。
 *
 * 拼接这一层是必需的：上游很多名字中间带空格（`开服纪念！Ave Mujica Pick Up招募`），
 * 而查询在归一化时已经把空格去掉，于是 `Ave Mujica` 变成 `avemujica`，
 * 跟任何一个单词都对不上 —— 只有把相邻词拼起来才命中。
 *
 * 它同时**不会退化成子串匹配**：`Soyo Nagasaki` 的词是 soyo / nagasaki，
 * 拼接是 soyonagasaki，所以别名 `saki` 依然不会误命中它。
 */
function tokenGrams(raw, maxGram = 3) {
  const tokens = tokenize(raw);
  const grams = new Set(tokens);
  for (let size = 2; size <= maxGram; size += 1) {
    for (let index = 0; index + size <= tokens.length; index += 1) {
      grams.add(tokens.slice(index, index + size).join(''));
    }
  }
  return grams;
}

/**
 * 命中打分；0 表示不命中。分数越高越精确。
 *
 * ASCII 与 CJK 用两套规则，这是踩过坑的：
 *   · ASCII 只认「整词 / 连续词拼接 / 词首前缀」——否则别名 saki 会子串命中
 *     Soyo Naga**saki** 与 Mahoro Hama**saki**，把别人的卡查出来；
 *   · CJK 没有词边界，「祥子」本来就该在「丰川祥子」里命中，所以允许子串。
 */
function score(candidates, query) {
  if (!query) return 0;
  const cjk = CJK_PATTERN.test(query);
  let best = 0;
  for (const raw of candidates) {
    const value = normalize(raw);
    if (!value) continue;
    if (value === query) return 100;
    if (value.startsWith(query)) best = Math.max(best, 80);
    for (const gram of tokenGrams(raw)) {
      if (gram === query) return 100;
      if (gram.startsWith(query)) best = Math.max(best, 80);
    }
    if (cjk) {
      if (value.includes(query)) best = Math.max(best, 60);
      else if (query.includes(value)) best = Math.max(best, 40);
    }
  }
  return best;
}

function songSearchValues(song) {
  // 刻意不放曲目 ID：否则「查 1」会因为 ID 前缀匹配到一大片曲子。
  // ID 精确命中有独立分支，不走名称打分。
  const values = [...valuesOf(song.title), ...valuesOf(song.phonetic)];
  if (song.ruby) values.push(song.ruby);
  // 乐队名也参与匹配 —— 上游的 `/查曲 mygo 27` 就是这个语义（乐队 + 等级）
  values.push(...valuesOf(song.band));
  return values;
}

function paginate(items, page, pageSize) {
  const size = Math.max(1, Number(pageSize) || 8);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / size));
  const current = Math.min(Math.max(1, Number(page) || 1), pages);
  const start = (current - 1) * size;
  return {
    total,
    page: current,
    pages,
    pageSize: size,
    items: items.slice(start, start + size),
    hasMore: current < pages,
  };
}

/**
 * 查曲。解析顺序与上游一致：
 *   1. 名称后面跟等级（`mygo 27`、`mygo lv27`）—— 拆成名称 + 等级；
 *   2. 纯数字若恰好是曲目 ID，**优先按 ID**；
 *   3. 否则纯数字当等级（`/查曲 27` 等价于 `/查曲 lv27`）；
 *   4. 其余按名称模糊匹配（中/繁/日/英/韩 + 假名读音）。
 * 注意：这里**不做** 100001 → 1 的简写，那是「查谱面」独有的行为。
 */
export function searchSongs(data, { query, level, page, pageSize } = {}) {
  const raw = String(query ?? '').trim();
  let namePart = raw;
  let levelSpec = level;

  // 1. 名称与等级写在一起时拆开
  if (!levelSpec && raw) {
    const trailing = raw.match(/^(.*?)[\s·]+(lv\.?\s*\d{1,2}(?:\.\d)?)$/i)
      || raw.match(/^(.*?)[\s·]+(\d{1,2}(?:\.\d)?)$/);
    if (trailing && trailing[1].trim()) {
      namePart = trailing[1].trim();
      levelSpec = trailing[2];
    }
  }

  let parsedLevel = parseLevel(levelSpec);
  if (levelSpec && !parsedLevel) {
    return { error: `看不懂等级「${levelSpec}」，请写成 27、lv27 或 27.5 这样的形式` };
  }

  let matched = null;

  // 2. 纯数字优先按曲目 ID
  if (/^\d+$/.test(namePart)) {
    const byId = data.songs.find((song) => String(song.id) === namePart);
    if (byId) matched = [{ song: byId, score: 100 }];
    else if (!parsedLevel) {
      // 3. 不是 ID 就当成等级
      const asLevel = parseLevel(namePart);
      if (asLevel) {
        parsedLevel = asLevel;
        namePart = '';
      }
    }
  }

  if (!matched) {
    if (!namePart) {
      if (!parsedLevel) return { error: '请给出歌名、曲目 ID 或等级' };
      matched = data.songs.map((song) => ({ song, score: 0 }));
    } else {
      const key = normalize(namePart);
      matched = data.songs
        .map((song) => ({ song, score: score(songSearchValues(song), key) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.song.id - b.song.id);
    }
  }

  if (parsedLevel) {
    matched = matched.filter((entry) => entry.song.charts.some((chart) => chartMatchesLevel(chart, parsedLevel)));
  }

  const songs = matched.map((entry) => entry.song);
  return { ...paginate(songs, page, pageSize), level: parsedLevel };
}

/**
 * 查卡。顺序：纯数字优先按卡牌 ID 精确命中；否则先尝试角色别名（含缩写），
 * 再按角色名、卡面副标题模糊匹配。别名命中时把该角色的全部卡牌列出来。
 */
export function searchCards(data, { query, page, pageSize } = {}) {
  const raw = String(query ?? '').trim();
  if (!raw) return { error: '请给出角色名、缩写或卡牌 ID' };

  if (/^\d+$/.test(raw)) {
    const byId = data.cards.find((card) => String(card.id) === raw);
    if (byId) return { ...paginate([byId], page, pageSize), byId: true };
  }

  const key = normalize(raw);
  const alias = resolveAlias(raw);
  const keys = new Set([key]);
  if (alias) {
    for (const term of [alias.display, ...alias.official, ...alias.terms]) {
      const normalized = normalize(term);
      if (normalized) keys.add(normalized);
    }
  }

  let best = 0;
  const scored = [];
  for (const card of data.cards) {
    const characterValues = [...valuesOf(card.character)];
    const subtitleValues = [...valuesOf(card.subtitle)];
    // 乐队名也参与匹配（「梦限大的卡」），权重略低于角色名本身
    const bandValues = [...valuesOf(card.band)];
    let value = 0;
    for (const candidate of keys) {
      value = Math.max(value, score(characterValues, candidate));
      value = Math.max(value, Math.round(score(bandValues, candidate) * 0.8));
      // 副标题只作次级命中，避免把整张卡面文案都变成搜索词
      value = Math.max(value, Math.round(score(subtitleValues, candidate) * 0.6));
    }
    if (value > 0) {
      scored.push({ card, score: value });
      best = Math.max(best, value);
    }
  }

  scored.sort((a, b) => b.score - a.score || a.card.id - b.card.id);
  const result = paginate(scored.map((entry) => entry.card), page, pageSize);
  return { ...result, alias: alias ? { display: alias.display, official: alias.official } : null };
}

/**
 * 查活动。按需求保持精简：只回名字与时间，不做「是否进行中」的判断。
 *
 * 时间串是 `2026/09/30 18:00:00` 这种格式，**不带时区**，上游也没说明是哪个时区，
 * 所以这里不换算、不比较，原样交给模型 —— 猜时区会算错一小时，而"现在开没开"
 * 差一小时就是错的。排序按开始时间倒序，最近的排前面。
 */
export function searchEvents(data, { query, page, pageSize } = {}) {
  const events = data.events || [];
  const raw = String(query ?? '').trim();

  let matched;
  if (!raw) {
    matched = [...events];
  } else {
    const key = normalize(raw);
    matched = /^\d+$/.test(raw)
      ? events.filter((event) => String(event.id) === raw)
      : [];
    // 不是 ID（或是 ID 但没命中）就按名字打分；都不中就是空结果，不能退回全量
    if (!matched.length) {
      matched = events
        .map((event) => ({ event, value: score(valuesOf(event.name), key) }))
        .filter((entry) => entry.value > 0)
        .sort((a, b) => b.value - a.value || a.event.id - b.event.id)
        .map((entry) => entry.event);
    }
  }

  matched.sort((a, b) => String(b.startAt || '').localeCompare(String(a.startAt || '')) || a.id - b.id);
  return paginate(matched, page, pageSize);
}

const RARITY_ORDER = ['BD', 'SSR', 'SR', 'R'];

const DIFFICULTY_ALIASES = new Map(Object.entries({
  easy: 'EASY', normal: 'NORMAL', hard: 'HARD', expert: 'EXPERT',
  exp: 'EXPERT', ex: 'EXPERT',
  简单: 'EASY', 普通: 'NORMAL', 困难: 'HARD', 专家: 'EXPERT', 高级: 'HARD', 高手: 'EXPERT',
}));

/** 解析难度写法；认不出返回 null。 */
export function parseDifficulty(raw) {
  const key = normalize(raw);
  if (!key) return null;
  return DIFFICULTY_ALIASES.get(key) || null;
}

/**
 * 查谱面（只出信息，不取谱面 JSON、不画图）。
 *
 * 全部字段都在主数据里，所以**零新增网络请求**：
 *   `_musicScoreDisplayLevel` 显示等级、`_fullComboCount` 物量、`_musicScoreTextFileName` 谱面文件。
 * 物量用 `_fullComboCount` 是**跟随上游口径** —— data.py 里就是
 * `notes=int(score.get("fullComboCount", 0))`，visuals.py 再把它写成 `{chart.notes} Notes`。
 * 注意它和谱面 JSON 里的音符条目数不是一个口径（实测 0001_00 是 342 vs 73），
 * 要精确物量得另拉谱面 JSON 数节点。
 *
 * 数字查询一律当曲目 ID，并支持上游那条**只有查谱面才有**的简写：
 * `100001` 可以写成 `1`。等级筛选请用 song_search。
 */
export function searchCharts(data, { query, difficulty, page, pageSize } = {}) {
  const wanted = parseDifficulty(difficulty);
  if (difficulty && !wanted) {
    return { error: `看不懂难度「${difficulty}」，请写成 EASY、NORMAL、HARD 或 EXPERT` };
  }

  const raw = String(query ?? '').trim();
  if (!raw) return { error: '请给出歌名或曲目 ID' };

  // 上游：只有「查谱面」允许把 100001 简写成 1（补成 100000 + n）
  let resolved = raw;
  if (/^\d{1,4}$/.test(raw)) {
    const expanded = String(100000 + Number(raw));
    if (data.songs.some((song) => String(song.id) === expanded)) resolved = expanded;
  }

  const found = searchSongs(data, { query: resolved, page, pageSize });
  if (found.error) return found;

  const items = found.items.map((song) => ({
    id: song.id,
    title: song.title,
    band: song.band,
    charts: song.charts.filter((chart) => !wanted || chart.difficulty === wanted),
  }));

  return { ...found, items, difficulty: wanted };
}

/** 池内按稀有度汇总，例如 `SSR×8 / SR×12`。 */
export function summarizePool(pool) {
  const counts = new Map();
  for (const entry of pool) {
    const label = entry.rarityLabel || '?';
    counts.set(label, (counts.get(label) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => {
      const ai = RARITY_ORDER.indexOf(a[0]);
      const bi = RARITY_ORDER.indexOf(b[0]);
      return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
    })
    .map(([label, count]) => `${label}×${count}`)
    .join(' / ');
}

/** 卡池的关联检索值：rate-up 卡涉及的角色名与乐队名。 */
function gachaFeaturedValues(gacha) {
  const values = [];
  for (const character of gacha.featured?.characters || []) {
    values.push(...valuesOf(character.name));
  }
  for (const band of gacha.featured?.bands || []) {
    values.push(...valuesOf(band.name));
  }
  return values;
}

/**
 * 查卡池。不传 query 时列出全部卡池（按优先级）。
 *
 * 除了卡池名，**也按关联角色与乐队匹配** —— 那才是用户实际的问法：
 * 「梦限大相关的卡池」「由乃的卡池」。卡池名本身不含这些词
 * （例如「由我主演的赛博之夜招募」既没有「梦限大」也没有「由乃」），
 * 只能靠 rate-up 卡关联到的角色与乐队来接。
 * 名字命中优先于关联命中（关联打 0.7 折），免得常用词把无关池排到前面。
 *
 * ⚠️ 刻意不产出任何抽卡概率：上游没有稀有度出率表，`_weight` 只是 lot 组内的
 * 相对权重，换算成百分比会是编造。这里只回答"收录了哪些卡、哪些是 rate-up"。
 */
export function searchGachas(data, { query, page, pageSize } = {}) {
  const gachas = data.gachas || [];
  const raw = String(query ?? '').trim();

  let matched;
  if (!raw) {
    matched = [...gachas];
    matched.sort((a, b) => (b.priority - a.priority) || (a.id - b.id));
  } else {
    // 角色缩写/别名也认（yuno / skk / tmr…）
    const keys = new Set([normalize(raw)]);
    const alias = resolveAlias(raw);
    if (alias) {
      for (const term of [alias.display, ...alias.official, ...alias.terms]) {
        const normalized = normalize(term);
        if (normalized) keys.add(normalized);
      }
    }

    matched = /^\d+$/.test(raw)
      ? gachas.filter((gacha) => String(gacha.id) === raw)
      : [];

    // 同 searchEvents：没命中就是空结果，不能退回全量
    if (!matched.length) {
      matched = gachas
        .map((gacha) => {
          const featuredValues = gachaFeaturedValues(gacha);
          let value = 0;
          for (const key of keys) {
            value = Math.max(value, score(valuesOf(gacha.name), key));
            value = Math.max(value, Math.round(score(featuredValues, key) * 0.7));
          }
          return { gacha, value };
        })
        .filter((entry) => entry.value > 0)
        .sort((a, b) => b.value - a.value || a.gacha.id - b.gacha.id)
        .map((entry) => entry.gacha);
    }
  }

  return paginate(matched, page, pageSize);
}

/** 把池内条目解析成可读对象（卡牌或支援卡）。rateBp 是单抽概率（万分比），随条目带出。 */
export function resolvePoolEntry(entry, data) {
  if (entry.kind === 'card') {
    const card = (data.cards || []).find((item) => item.id === entry.resourceId);
    if (card) {
      return {
        kind: 'card',
        id: card.id,
        assetId: card.assetId,
        character: card.character,
        subtitle: card.subtitle,
        rarityLabel: card.rarityLabel,
        power: card.power.total,
        rateUp: entry.rateUp,
        rateBp: entry.rateBp,
      };
    }
  }
  if (entry.kind === 'support') {
    const support = (data.supports || []).find((item) => item.id === entry.resourceId);
    if (support) {
      return {
        kind: 'support',
        id: support.id,
        assetId: support.assetId,
        character: support.characters?.[0] ?? null,
        subtitle: support.name,
        rarityLabel: support.rarityLabel,
        power: support.power.total,
        rateUp: entry.rateUp,
        rateBp: entry.rateBp,
      };
    }
  }
  return {
    kind: entry.kind,
    id: entry.resourceId,
    character: null,
    subtitle: null,
    rarityLabel: entry.rarityLabel,
    power: null,
    rateUp: entry.rateUp,
    rateBp: entry.rateBp,
  };
}

/** 数据状态。 */
export function dataStatus(store, extra = {}) {
  return {
    region: store.region,
    dataVersion: store.meta?.dataVersion ?? null,
    resourceVersion: store.meta?.resourceVersion ?? null,
    upstreamFetchedAt: store.meta?.upstreamFetchedAt ?? null,
    cachedAt: store.meta?.cachedAt ?? null,
    songCount: store.data?.songs?.length ?? 0,
    cardCount: store.data?.cards?.length ?? 0,
    characterCount: store.data?.characters?.length ?? 0,
    eventCount: store.data?.events?.length ?? 0,
    gachaCount: store.data?.gachas?.length ?? 0,
    ...extra,
  };
}

/**
 * 按路径直接构造素材 URL。上游已废弃素材清单（images.json 404），
 * 现在是 `{api}/{语言}/{key}/{label}.{ext}`，默认区域 tw 可省略区域段。
 */
export function jacketUrl(language, jacketAssetName, extension = 'webp', assetBase = ASSET_BASE) {
  if (!jacketAssetName) return null;
  const key = `Image/Jacket/${jacketAssetName}`;
  return `${assetBase}/${language}/${key}/${jacketAssetName}.${extension}`;
}

const CARD_ART_KINDS = new Set(['member_full', 'member_thumbnail', 'member_character']);

export function cardArtUrl(language, assetId, kind = 'member_thumbnail', extension = 'webp', assetBase = ASSET_BASE) {
  const label = CARD_ART_KINDS.has(kind) ? kind : 'member_thumbnail';
  return `${assetBase}/${language}/MemberCard/${assetId}/${label}/${label}.${extension}`;
}

/**
 * 通用素材 URL：`{api}/{语言}/{key}/{basename}.{ext}`（见上游 docs/release-assets.md）。
 *
 * 卡池的 `_bannerAssetName` / `_logoAssetName` **本身就是完整 key**
 * （例如 `Gacha/Banner/gacha_banner_00001`），label 取 key 的 basename ——
 * 所以不能再补一层目录前缀。
 */
export function assetKeyUrl(language, key, extension = 'webp', assetBase = ASSET_BASE) {
  if (!key) return null;
  const clean = String(key).replace(/\/+$/, '');
  if (!clean) return null;
  const base = clean.split('/').pop();
  return `${assetBase}/${language}/${clean}/${base}.${extension}`;
}

export { valuesOf, paginate, score };
