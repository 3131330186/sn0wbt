// Our Notes 主数据同步：拉表 → 派生紧凑结构 → 落盘缓存。
//
// 与上游 NeriWST/ournotes-qq-bot 的 data.py 有三处差异，都是上游改过的地方：
//   1. 版本清单是 /current_version.json（不再是 /version/latest.json），并按区域分组；
//   2. 表字段全部带 `_` 前缀（_jacketAssetName / _musicScoreTextFileName …）；
//   3. 素材清单 images.json 已废弃，图片改为按路径直接构造（见 lib/query.js 的 assetUrl）。
//
// 派生结构的目的是把 5.19 MB 的 MasterText 收敛成只被引用到的那些条目，
// 缓存因此只有几百 KB，也免得把整张文本表塞进模型的上下文。
import fs from 'node:fs/promises';
import path from 'node:path';

export const META_BASE = 'https://metadata.bdon.moe';
export const ASSET_BASE = 'https://assets.bdon.moe';

/**
 * 区域 → 主数据路径。取自 `/index.json` 里 `regions[r].path`。
 *
 * 不带区域段的 `{base}/master/` 只有主区域（hk-tw-mo）的数据，
 * 所以 `region` 设置必须靠这个前缀才真的生效 —— 上游的 Python 版本
 * 一直打平路径，等于把 region 设置废掉了。
 */
export const REGION_PATHS = {
  'hk-tw-mo': '/tw/master/',
  en: '/en/master/',
  kr: '/kr/master/',
  jp: '/jp/master/',
};

export function masterPathFor(region) {
  return REGION_PATHS[region] || REGION_PATHS['hk-tw-mo'];
}

const TABLES = [
  'MasterLiveMusic', 'MasterLiveMusicScore', 'MasterText', 'MasterBand',
  'MasterMemberCard', 'MasterCharacter', 'MasterLiveSkill', 'MasterSupportCard',
  'MasterEvent', 'MasterGacha', 'MasterGachaLot', 'MasterGachaPrize',
];

/**
 * 缓存结构版本。**加了新表、或改了派生结构的字段，都必须 +1。**
 *
 *   v1（插件 1.0.0）：songs / cards / characters / skills
 *   v2（插件 1.1.0）：加了 supports / events / gachas
 *   v3（插件 1.1.x）：gacha 增加 featured（关联角色与乐队）；card 增加 band
 *   v4（插件 1.3.0）：gacha 池条目与卡池增加出率（rateBp / rateUpTotalBp）
 *
 * 不校验版本的后果很隐蔽：新版本读到旧结构缓存时，新字段是 `undefined`，
 * 表现为「这个功能一条都抓不到」而不是报错 —— TTL 内（默认 6 小时）还会一直这样。
 * 实际踩过三次：v1 缓存被 v1.1 读走导致卡池永远为空；加了 featured 却没升版本
 * 导致关联查询静默失效；这次加出率同样必须升。
 */
export const CACHE_SCHEMA = 4;

/** 难度 → MasterLiveMusic 上指向该谱面 _id 的字段名。 */
const DIFFICULTIES = [
  ['EASY', '_easyID'],
  ['NORMAL', '_normalID'],
  ['HARD', '_hardID'],
  ['EXPERT', '_expertID'],
];

/** _rarity 枚举。实测分布 {2:25, 3:26, 4:12, 20:1}，20 是生日卡。 */
const RARITY_LABELS = { 2: 'R', 3: 'SR', 4: 'SSR', 20: 'BD' };

function rows(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload._allData)) return payload._allData;
  return [];
}

/** 取主数据里的文本条目；缺失返回 null 而不是抛错，缺表不该让整次查询失败。 */
function textAt(index, id) {
  if (!id) return null;
  return index.get(id) || null;
}

/**
 * 把一条 MasterText 压成多语言对象：丢掉空值，并丢掉与已保留值重复的语言。
 * 迷星叫 这种中日同名的条目会得到 { zh: '迷星叫', en: 'Mayoiuta' }，省下大量 token。
 */
function localized(entry) {
  if (!entry) return null;
  const out = {};
  const seen = new Set();
  const order = [
    ['zh', entry._simplifiedChinese],
    ['zhHant', entry._traditionalChinese],
    ['ja', entry._japanese],
    ['en', entry._english],
    ['ko', entry._korean],
  ];
  for (const [key, value] of order) {
    const text = String(value ?? '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out[key] = text;
  }
  return Object.keys(out).length ? out : null;
}

/** 去掉 <r=よみ>漢字</r> 这类注音标记，只留可搜索的汉字部分。 */
function stripRuby(text) {
  return String(text ?? '').replace(/<r=[^>]*>/g, '').replace(/<\/r>/g, '');
}

function deriveTexts(entries) {
  const out = {};
  for (const [key, value] of Object.entries(entries)) {
    if (value) out[key] = value;
  }
  return out;
}

function buildSongs(musicRows, textIndex, bandNameIndex) {
  const songs = [];
  for (const row of musicRows) {
    const titleEntry = textAt(textIndex, row._titleTextID);
    const phoneticEntry = textAt(textIndex, row._phoneticTextID);
    const rubyEntry = textAt(textIndex, row._rubyTitleTextID);
    const bandName = bandNameIndex.get(row._bandIDs?.[0]) || null;

    const charts = [];
    for (const [difficulty, field] of DIFFICULTIES) {
      const chartId = row[field];
      if (chartId) charts.push({ difficulty, chartId });
    }

    songs.push({
      id: row._id,
      title: localized(titleEntry) || { zh: `#${row._id}` },
      phonetic: localized(phoneticEntry),
      ruby: rubyEntry ? stripRuby(localized(rubyEntry)?.zh || '') : null,
      bandId: row._bandIDs?.[0] ?? null,
      band: bandName,
      jacket: row._jacketAssetName || null,
      startAt: row._startAt || null,
      chartIds: charts,
    });
  }
  return songs;
}

function attachScores(songs, scoreRows) {
  const byId = new Map();
  for (const row of scoreRows) byId.set(row._id, row);
  const byFileName = new Map();
  for (const row of scoreRows) byFileName.set(row._musicScoreTextFileName, row);

  for (const song of songs) {
    song.charts = [];
    for (const link of song.chartIds) {
      const row = byId.get(link.chartId);
      if (!row) continue;
      song.charts.push({
        difficulty: link.difficulty,
        chartId: link.chartId,
        // _musicScoreLevel 是整数桶（display 20.5 -> 20），整数等级查询靠它；
        // _musicScoreDisplayLevel 是显示值，小数等级精确匹配靠它。
        level: row._musicScoreLevel,
        displayLevel: row._musicScoreDisplayLevel,
        notes: row._fullComboCount,
        scoreFile: row._musicScoreTextFileName,
      });
    }
    delete song.chartIds;
  }
  return { byId, byFileName };
}

function buildCards(cardRows, textIndex, characterIndex, skillIndex) {
  const cards = [];
  for (const row of cardRows) {
    const character = characterIndex.get(row._characterID) || null;
    const skill = skillIndex.get(row._liveSkillID) || null;
    const performance = row._performancePowerMax || 0;
    const technic = row._technicPowerMax || 0;
    const visual = row._visualPowerMax || 0;
    cards.push({
      id: row._id,
      assetId: row._assetID ?? row._id,
      characterId: row._characterID,
      character: character ? character.name : (localized(textAt(textIndex, row._nameTextID)) || null),
      // 角色所属乐队，用于「梦限大的卡」这类按队伍查
      bandId: character?.bandId ?? null,
      band: character?.band ?? null,
      rarity: row._rarity,
      rarityLabel: RARITY_LABELS[row._rarity] || String(row._rarity),
      cardType: row._cardType,
      subtitle: localized(textAt(textIndex, row._subtitleTextID)),
      power: { performance, technic, visual, total: performance + technic + visual },
      skill: skill ? skill.name : null,
      startAt: row._startAt || null,
    });
  }
  return cards;
}

function buildCharacters(charRows, textIndex, bandNameIndex) {
  const characters = [];
  for (const row of charRows) {
    characters.push({
      id: row._id,
      name: localized(textAt(textIndex, row._nameTextID)),
      shortName: localized(textAt(textIndex, row._shortNameTextID)),
      enName: localized(textAt(textIndex, row._enDisplayNameTextId)),
      enShortName: localized(textAt(textIndex, row._enDisplayShortNameTextId)),
      bandId: row._bandID,
      // ⚠️ 乐队名在 MasterText 里，不能把 MasterBand 的整行喂给 localized()
      // —— 行里只有 _nameTextID，没有文本列，会静默得到 null。
      band: bandNameIndex.get(row._bandID) || null,
      part: row._bandPart || '',
      color: row._mainColorCode || null,
    });
  }
  return characters;
}

function buildSkills(skillRows, textIndex) {
  const skills = [];
  for (const row of skillRows) {
    skills.push({
      id: row._id,
      name: localized(textAt(textIndex, row._nameTextID)),
      description: localized(textAt(textIndex, row._descriptionTextFormatID)),
    });
  }
  return skills;
}

function buildSupports(supportRows, textIndex, characterIndex) {
  const supports = [];
  for (const row of supportRows) {
    const performance = row._performancePowerMax || 0;
    const technic = row._technicPowerMax || 0;
    const visual = row._visualPowerMax || 0;
    supports.push({
      id: row._id,
      assetId: row._assetID ?? row._id,
      // 注意大小写：这张表是 _nameTextID（大写 D），而 MasterGacha / MasterEvent 是小写 d。
      // 上游同一份数据里两种并存，统一处理会取到空。
      name: localized(textAt(textIndex, row._nameTextID)),
      characterIds: row._characterIDs || [],
      characters: (row._characterIDs || [])
        .map((id) => characterIndex.get(id)?.name ?? null)
        .filter(Boolean),
      rarity: row._rarity,
      rarityLabel: RARITY_LABELS[row._rarity] || String(row._rarity),
      cardType: row._cardType,
      power: { performance, technic, visual, total: performance + technic + visual },
    });
  }
  return supports;
}

/**
 * 活动。按需求保持精简：只出名字与时间。
 * 上游另外还有 pickup 卡（MasterEventPickUpCard）、加成卡（MasterEventEffect）、
 * 点数奖励（MasterEventAchievementReward），需要时再加。
 */
function buildEvents(eventRows, textIndex) {
  return eventRows.map((row) => ({
    id: row._id,
    // 小写 d
    name: localized(textAt(textIndex, row._nameTextId)),
    startAt: row._startAt || null,
    endAt: row._endAt || null,
    displayEndAt: row._displayEndAt || null,
  }));
}

/**
 * 卡池。收录卡通过三级关联取得：
 *   Gacha._lotGroupId -> GachaLot._lotGroupId -> GachaLot._prizeGroupId
 *                     -> GachaPrize._groupId -> _resourceId（卡牌 ID）
 *
 * 另外算出 `featured`（这个池的关联角色与乐队）。**只取 rate-up 卡**：
 * 池里收录的 120 张卡横跨所有角色，拿整个池去关联会让每个卡池都匹配到所有人。
 * rate-up 才是这个池的主打，也正是「梦限大的卡池」「由乃的卡池」该命中的东西。
 *
 * ⚠️ 这里**不含抽卡概率**：上游 244 张表里没有任何稀有度出率表，
 * `_weight` 只是 lot 组内的相对权重。所以只能回答"收录了哪些卡、哪些是 rate-up"，
 * 不能换算成百分比。
 */
function buildGachas(gachaRows, textIndex, lotRows, prizeRows, resolve) {
  const lotsByGroup = new Map();
  for (const row of lotRows) {
    const list = lotsByGroup.get(row._lotGroupId);
    if (list) list.push(row);
    else lotsByGroup.set(row._lotGroupId, [row]);
  }
  const prizesByGroup = new Map();
  for (const row of prizeRows) {
    const list = prizesByGroup.get(row._groupId);
    if (list) list.push(row);
    else prizesByGroup.set(row._groupId, [row]);
  }

  const gachas = [];
  for (const row of gachaRows) {
    // 用 Map 而不是数组：同一张卡可能出现在多个桶里，出率要相加
    const pool = new Map();
    for (const lot of lotsByGroup.get(row._lotGroupId) || []) {
      const group = prizesByGroup.get(lot._prizeGroupId) || [];
      if (!group.length) continue;

      // 桶内分法（万分比）：
      //   主推卡各自拿走它的 _pickUpFixedRate；余量由桶内其余卡均分。
      // 依据：每个 lotGroup 的 _weight 合计**精确等于 10000**，且 _pickUpFixedRate 与它同单位 ——
      // 卡池1 是 5 张主推 × 50 + 5 张非主推 × 10 = 300 = 桶权重。实测 11 个卡池全部自洽，
      // 算出的主推出率（SSR 各 0.50%、支援 SSR 各 1.00%、生日 BD 整桶 3.00%）也符合业界惯例。
      // 「桶内只有一张、fixedRate=0」的生日池会自然落到"均分整桶"。
      const fixed = group.filter((p) => (p._pickUpType ?? 0) >= 2 && (p._pickUpFixedRate ?? 0) > 0);
      const used = fixed.reduce((sum, p) => sum + (p._pickUpFixedRate ?? 0), 0);
      const free = group.filter((p) => !fixed.includes(p));
      const share = free.length ? (lot._weight - used) / free.length : 0;

      for (const prize of group) {
        const resourceType = prize._resourceType;
        const resourceId = prize._resourceId;
        const key = `${resourceType}:${resourceId}`;
        const kind = resourceType === 2 ? 'card' : (resourceType === 3 ? 'support' : 'other');
        const rateBp = fixed.includes(prize) ? (prize._pickUpFixedRate ?? 0) : share;
        const existing = pool.get(key);
        if (existing) {
          existing.rateBp += rateBp;
          continue;
        }
        pool.set(key, {
          kind,
          resourceId,
          rarityLabel: resolve.rarityOf(kind, resourceId),
          // pickUpType 2 = 本池主打。从数据推断的，上游没有文档说明。
          rateUp: (prize._pickUpType ?? 0) >= 2,
          /** 单抽出现概率，万分比。主推是 _pickUpFixedRate 直接给的值。 */
          rateBp,
        });
      }
    }
    const poolEntries = [...pool.values()];
    poolEntries.sort((a, b) => Number(b.rateUp) - Number(a.rateUp)
      || b.rateBp - a.rateBp
      || String(b.rarityLabel).localeCompare(String(a.rarityLabel))
      || a.resourceId - b.resourceId);

    const rateUpCount = poolEntries.filter((entry) => entry.rateUp).length;
    const rateUpTotalBp = poolEntries
      .filter((entry) => entry.rateUp)
      .reduce((sum, entry) => sum + entry.rateBp, 0);

    // 关联角色与乐队：只从 rate-up 条目取（成员卡看自身角色，支援卡看它挂的角色）
    const featuredCharacters = new Map();
    for (const entry of poolEntries) {
      if (!entry.rateUp) continue;
      for (const character of resolve.charactersOf(entry.kind, entry.resourceId)) {
        featuredCharacters.set(character.id, character);
      }
    }
    const featuredBands = new Map();
    for (const character of featuredCharacters.values()) {
      if (character.bandId) featuredBands.set(character.bandId, character.band || null);
    }

    gachas.push({
      id: row._id,
      // 小写 d
      name: localized(textAt(textIndex, row._nameTextId)),
      startAt: row._startAt || null,
      endAt: row._endAt || null,
      isLimited: row._isLimited === true,
      priority: row._priority ?? 0,
      banner: row._bannerAssetName || null,
      logo: row._logoAssetName || null,
      pool: poolEntries,
      poolCount: poolEntries.length,
      rateUpCount,
      /** 主推合计出率，万分比（如 250 = 2.50%） */
      rateUpTotalBp,
      featured: {
        characters: [...featuredCharacters.values()].map((character) => ({
          id: character.id,
          name: character.name,
        })),
        bands: [...featuredBands.entries()].map(([id, name]) => ({ id, name })),
      },
    });
  }
  return gachas;
}

/** 把主数据表压成缓存结构。导出以便测试直接喂夹具。 */
export function derive(tables) {
  const textIndex = new Map();
  for (const row of rows(tables.MasterText)) textIndex.set(row._id, row);

  // 乐队名要先经 MasterText 解析，不能直接用 MasterBand 行
  const bandNameIndex = new Map();
  for (const row of rows(tables.MasterBand)) {
    bandNameIndex.set(row._id, localized(textAt(textIndex, row._nameTextID)));
  }

  const skillIndex = new Map();
  for (const row of rows(tables.MasterLiveSkill)) {
    skillIndex.set(row._id, {
      id: row._id,
      name: localized(textAt(textIndex, row._nameTextID)),
      description: localized(textAt(textIndex, row._descriptionTextFormatID)),
    });
  }

  const characters = buildCharacters(rows(tables.MasterCharacter), textIndex, bandNameIndex);
  const characterIndex = new Map();
  for (const character of characters) {
    characterIndex.set(character.id, character);
  }

  const songs = buildSongs(rows(tables.MasterLiveMusic), textIndex, bandNameIndex);
  attachScores(songs, rows(tables.MasterLiveMusicScore));
  const cards = buildCards(rows(tables.MasterMemberCard), textIndex, characterIndex, skillIndex);
  const supports = buildSupports(rows(tables.MasterSupportCard), textIndex, characterIndex);

  const cardRarity = new Map(cards.map((card) => [card.id, card.rarityLabel]));
  const supportRarity = new Map(supports.map((card) => [card.id, card.rarityLabel]));
  const cardById = new Map(cards.map((card) => [card.id, card]));
  const supportById = new Map(supports.map((card) => [card.id, card]));

  const resolve = {
    rarityOf: (kind, id) => (kind === 'card'
      ? (cardRarity.get(id) ?? null)
      : (kind === 'support' ? (supportRarity.get(id) ?? null) : null)),
    /** rate-up 条目涉及的角色：成员卡看它自己的角色，支援卡看它挂的角色列表。 */
    charactersOf: (kind, id) => {
      if (kind === 'card') {
        const character = characterIndex.get(cardById.get(id)?.characterId);
        return character ? [character] : [];
      }
      if (kind === 'support') {
        return (supportById.get(id)?.characterIds || [])
          .map((characterId) => characterIndex.get(characterId))
          .filter(Boolean);
      }
      return [];
    },
  };

  const events = buildEvents(rows(tables.MasterEvent), textIndex);
  const gachas = buildGachas(
    rows(tables.MasterGacha), textIndex,
    rows(tables.MasterGachaLot), rows(tables.MasterGachaPrize), resolve,
  );

  return {
    songs, cards, characters, supports, events, gachas,
    skills: buildSkills(rows(tables.MasterLiveSkill), textIndex),
  };
}

async function fetchJson(api, url, timeoutMs) {
  // 优先用宿主提供的 api.fetch（走 web_fetch 权限管控），没有就退回全局 fetch。
  // 没有这层回退的话，对方 QQ Agent 版本较旧、不提供 web_fetch 能力时，
  // 插件会以「api.fetch is not a function」整体不可用 —— 而它其实只需要一个能联网的 fetch。
  const doFetch = typeof api?.fetch === 'function' ? api.fetch.bind(api) : fetch;
  const response = await doFetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}`);
  return response.json();
}

/**
 * 数据仓库。缓存策略与上游一致：TTL 内直接用缓存；过期则刷新，
 * 刷新失败时**保留旧缓存继续服务**（"stale-but-working 优于 down"）。
 */
export class OurNotesStore {
  constructor(api, settings, logger) {
    this.api = api;
    this.settings = settings;
    this.log = logger || (() => {});
    this.data = null;
    this.meta = null;
  }

  get region() {
    return this.settings.region || 'hk-tw-mo';
  }

  cachePath(cacheDir) {
    return path.join(cacheDir, 'ournotes-cache.json');
  }

  async loadCache(cacheDir) {
    try {
      const raw = await fs.readFile(this.cachePath(cacheDir), 'utf8');
      const parsed = JSON.parse(raw);
      // 结构版本必须一致，否则新版本会拿着旧缓存跑，新字段全是 undefined
      if (parsed?.schemaVersion !== CACHE_SCHEMA) {
        this.log(`[ournotes] 缓存结构版本不符（读到 ${parsed?.schemaVersion ?? '无'}，需要 ${CACHE_SCHEMA}），重新同步`);
        return null;
      }
      const data = parsed.data;
      const usable = data?.songs?.length && data?.cards?.length
        && Array.isArray(data.characters) && Array.isArray(data.supports)
        && Array.isArray(data.events) && Array.isArray(data.gachas);
      return usable ? parsed : null;
    } catch { /* 没有缓存或缓存坏了，交给刷新 */ }
    return null;
  }

  async saveCache(cacheDir, payload) {
    await fs.mkdir(cacheDir, { recursive: true });
    const target = this.cachePath(cacheDir);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(payload), 'utf8');
    await fs.rename(temporary, target);
  }

  cacheFresh(cachedAt, ttlHours) {
    if (!cachedAt) return false;
    const age = Date.now() - Date.parse(cachedAt);
    return Number.isFinite(age) && age >= 0 && age < ttlHours * 3600_000;
  }

  async refresh(cacheDir, ttlHours) {
    const version = await fetchJson(this.api, `${META_BASE}/current_version.json`, 30000);
    const entry = version?.regions?.[this.region];
    if (!entry) {
      throw new Error(`上游版本清单里没有区域 ${this.region}`);
    }
    const tables = {};
    // 并发拉表：单张慢表不该拖住其余的。带上 ?v= 可以让 CDN 命中同一次快照。
    const versionTag = `?v=${encodeURIComponent(entry.version ?? '')}`;
    const base = `${META_BASE}${masterPathFor(this.region)}`;
    const results = await Promise.all(TABLES.map((name) => fetchJson(
      this.api, `${base}${name}.json${versionTag}`, 120000,
    ).catch((error) => ({ __error: error, name }))));
    TABLES.forEach((name, index) => {
      tables[name] = results[index];
    });
    const failed = Object.entries(tables).filter(([, value]) => value && value.__error);
    if (failed.length) {
      throw new Error(`主数据表拉取失败：${failed.map(([name]) => name).join('、')}`);
    }

    const data = derive(tables);
    if (!data.songs.length || !data.cards.length) {
      throw new Error('远端曲目或卡牌为空，拒绝覆盖缓存');
    }

    // 同版本条数回退保护：上游偶尔会返回不完整的快照。
    const previous = this.data;
    if (previous && this.meta?.dataVersion === entry.version
        && (data.songs.length < previous.songs.length || data.cards.length < previous.cards.length)) {
      throw new Error('同版本远端条数减少，保留现有缓存');
    }

    const payload = {
      schemaVersion: CACHE_SCHEMA,
      metadata: {
        region: this.region,
        dataVersion: entry.version ?? null,
        resourceVersion: entry.resource_version ?? null,
        upstreamFetchedAt: entry.verified_at ?? null,
        tableCount: entry.table_count ?? null,
        recordCount: entry.record_count ?? null,
        cachedAt: new Date().toISOString(),
        songCount: data.songs.length,
        cardCount: data.cards.length,
      },
      data,
    };
    await this.saveCache(cacheDir, payload);
    return payload;
  }

  /**
   * 保证有数据可用。force=true 时强制刷新（data_status 用）。
   * 返回 { source: 'cache' | 'fresh', stale: boolean }。
   */
  async ensure(cacheDir, { force = false } = {}) {
    const ttlHours = Number(this.settings.cacheTtlHours) > 0 ? Number(this.settings.cacheTtlHours) : 6;
    const cached = await this.loadCache(cacheDir);
    if (cached) {
      this.data = cached.data;
      this.meta = cached.metadata;
    }

    if (!force && cached && this.cacheFresh(cached.metadata?.cachedAt, ttlHours)) {
      return { source: 'cache', stale: false };
    }

    try {
      const payload = await this.refresh(cacheDir, ttlHours);
      this.data = payload.data;
      this.meta = payload.metadata;
      return { source: 'fresh', stale: false };
    } catch (error) {
      const message = error?.message ?? String(error);
      if (cached) {
        this.log(`[ournotes] 刷新失败，沿用旧缓存：${message}`);
        return { source: 'cache', stale: true, error: message };
      }
      throw new Error(`主数据不可用（${message}），且本地没有缓存`);
    }
  }
}

export { RARITY_LABELS, deriveTexts };
