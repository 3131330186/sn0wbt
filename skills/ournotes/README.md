# Our Notes 查询（ournotes）

查询《BanG Dream! Our Notes》的曲目、卡牌、卡池、活动与主数据状态。数据来自社区主数据源
`metadata.bdon.moe`，图片直接引用 `assets.bdon.moe`，插件本身不分发任何游戏素材。

移植自 [NeriWST/ournotes-qq-bot](https://github.com/NeriWST/ournotes-qq-bot)（MIT，
Copyright © 2026 Adeliae / Bilibili @Adeliae），改成 QQ Agent 的 LLM 型 Skill。
**上游接口已经变过一轮**，移植时做了对应适配，详见文末。

> **分发时请把 `LICENSE` 一起放进 `ournotes/` 目录。** 上游是 MIT，许可要求
> 「在软件的所有副本中包含版权声明和许可声明」—— 只署个仓库名不算。

## 装到别的机器上

直接复制整个 `ournotes/` 目录到对方的 `resources/app/skills/` 下即可，不用改任何路径：

- 纯 JavaScript，**没有任何 npm 依赖** —— 只 import `node:` 内置模块
- **没有机器相关的硬编码路径**，设置项默认值里 `cacheDir` 是空的（空 = 自动选目录）
- 唯一的宿主耦合是 `import('../../src/config.js')` 取 `DATA_DIR`，而且**包在 try/catch 里**，
  取不到就退化到插件目录下的 `data/`，所以脱离 QQ Agent 也能单跑

三件容易踩的事：

1. **`enabledByDefault` 是 `false`** —— 对方放进去后不会自动生效，得去技能面板手动启用。
   这是最常见的「装了没反应」。
2. **打包层级必须是 `ournotes/index.js`。** 加载器只扫描 `skills/` 的**直接子目录**
   （`plugin-loader.js:465-477`）并找该层里的 `skill.json`。多套一层变成
   `skills/ournotes/ournotes/index.js` 就直接加载不到。解压后应当正好形成 `skills/ournotes/`。
3. **首次查询要联网**同步约 5.6 MB 主数据（5–17 秒），之后走本地缓存。
   对方机器需要能访问 `metadata.bdon.moe` 与 `assets.bdon.moe`。

顺带两点：目录名可以改（技能 `id` 来自 `skill.json`，不由目录名决定），
但**对方不能已经有一个 id 同为 `ournotes` 的技能**，否则会 id 冲突。
缓存不需要附带 —— 首次查询时自己建。`apiVersion: 1`，加载器 API 版本不同时可能不兼容。

## 工具

| 工具 | 作用 |
| --- | --- |
| `song_search` | 查曲。歌名（中／繁／日／英／假名读音）或曲目 ID，**也可按乐队名**（`mygo`、`梦限大`），可按谱面等级筛选 |
| `chart_info` | 查谱面**资料**：各难度的等级与物量。数字按曲目 ID 处理，支持 `100001` 写成 `1`；可按难度筛选。纯信息，不发图 |
| `card_search` | 查卡。角色名、角色缩写（skk／tmr／mtm…）或卡牌 ID |
| `gacha_info` | 查卡池。卡池名、时间、是否限定，以及收录了哪些卡、哪些是 rate-up。**也能按角色名、缩写或乐队名查**（如「梦限大」「由乃」「yuno」），会关联到主打这些角色或乐队的卡池 |
| `event_info` | 查活动。活动名与起止时间（保持精简） |
| `data_status` | 主数据版本、曲目／卡牌／卡池／活动数量、缓存时间 |

### 参数

- `song_search`：`query`（歌名或曲目 ID）、`level`（可选，`27`／`lv27`／`27.5`／`lv27.5`）、`page`
- `card_search`：`query`（角色名、缩写或卡牌 ID）、`page`
- `gacha_info`：`query`（卡池名或 ID，**留空列出全部卡池**）、`page`
- `event_info`：`query`（活动名或 ID，留空列出全部）、`page`

## 设置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `region` | `hk-tw-mo` | 主数据区域，另有 `en`／`kr`／`jp`（各自有独立路径与内容） |
| `assetLanguage` | `zh-Hans` | 图片语言，另有 `zh-Hant`／`ja`／`en`／`ko` |
| `cacheTtlHours` | `6` | 缓存有效期，与上游一致 |
| `pageSize` | `8` | 每页条数 |
| `sendImages` | `true` | 是否把封面／卡面／卡池图作为独立气泡发出 |
| `maxImages` | `3` | 单次最多几张图，防止一页封面刷屏 |
| `cardImage` | `thumbnail` | `thumbnail` 约 175 KB，`full` 约 880 KB |
| `cacheDir` | 空 | 留空用 `<DATA_DIR>\ournotes\` |

## 四条必须守住的规矩

前三条是上游 `commands.py` 的精华，漏一条就会静默答错；第四条是本移植的诚实底线。都测过。

1. **整数等级含小数谱面。** `27` 会命中显示为 27.5 的谱面 —— 落在 `_musicScoreLevel`
   整数桶上；写 `27.5` 才是精确匹配 `_musicScoreDisplayLevel`。
2. **纯数字优先按曲目 ID。** 是 ID 就按 ID 查；不是 ID 就当等级（`/查曲 27` 等价 `/查曲 lv27`），
   也支持名称与等级写在一起（`迷星叫 25`、`mygo 27`）。
3. **`100001` → `1` 的简写只有 `chart_info` 有。** 上游写明「仅此指令可将歌曲 100001 简写为 1」，
   所以查谱面里数字一律按曲目 ID 处理，而查曲里不做这个简写。
4. **活动时间串不带时区**，原样转述、不换算。

> **一条被推翻的旧规矩。** 早期版本写的是「卡池不给概率」，理由是「244 张表里没有出率表」。
> 那个理由**是错的** —— 出率没有独立的表，但它藏在 `MasterGachaLot._weight` 与
> `MasterGachaPrize._pickUpFixedRate` 里，而且可以直接算出来。详见下面「卡池出率」一节。
> 当时的提示词里写了「绝不要给出百分比概率」，现在改成了「直接转述工具算好的数字，不要自己再推算」。

### 卡池出率

**出率是可以算出来的**，藏在两张表里，而且单位是**万分比**：

| 表 | 字段 | 含义 |
| --- | --- | --- |
| `MasterGachaLot` | `_weight` | 桶权重（桶 = 稀有度 × 资源类型的组合） |
| `MasterGachaPrize` | `_pickUpFixedRate` | 主推单卡的出率，与 `_weight` 同单位 |

判据是**每个 lotGroup 的 `_weight` 合计精确等于 10000**：

```
lotGroup 1   合计 10000   SSR成员:w300, SR成员:w850, R成员:w3850, SSR支援:w600, SR支援:w1700, R支援:w2700
lotGroup 4   合计 10000   SSR成员:w10000
```

11 个卡池、每个 lotGroup 全部命中 10000，这不可能巧合 —— 所以 300 就是 3.00%。

**桶内分法：**

```
fixedCards = pickUpType ≥ 2 且 _pickUpFixedRate > 0 的卡 → 各自拿走 _pickUpFixedRate
freeCards  = 桶内其余卡                                 → 均分 (桶权重 − sum(fixedRate))
```

「桶内只有一张、`fixedRate=0`」的生日池会自然落到「均分整桶」= 3.00%。

算出来的值也符合业界惯例，属于交叉印证：

```
卡池 1「开服纪念！MyGO!!!!! Pick Up招募」  5 张主推 SSR，各 0.50%，合计 2.50%
卡池 2「开服纪念！Ave Mujica Pick Up招募」 5 张主推 SSR，各 0.50%，合计 2.50%
卡池10「由我主演的赛博之夜招募」           成员 SSR 各 0.50% + 支援 SSR 各 1.00%，合计 3.00%
卡池11「马桥心玖 HAPPY BIRTHDAY 26-27」    BD 卡吃下整桶 3.00%
```

**最强的回归测试是不变量**：每个卡池所有条目的 `rateBp` 之和必须精确等于 10000。
测试里有这一条，逐卡池断言。

**两个必须说清的边界：**

1. **这是单抽概率。** 十连有保底，`MasterGachaProduct` 里有
   `_ensuredType` / `_ensuredCount` / `_ensuredRarity`（例如 10 连保底 1 张 SR+），
   保底之后的实际分布不等于单抽率的简单叠加。工具**不反映保底**，回答时也要说明。
2. **桶内均分是推断的。** 主推那半边是直接字段（`_pickUpFixedRate`），很硬；
   非主推那半边（余量均分）是反推的 —— 依据是余量在所有桶里都能整除非主推张数
   （250/5、100/2、200/10、400/10、300/1）。广告池（lotGroup 9）的道具桶是 5000/3，
   出现 1666.67 这种除不尽的 bp，所以那一档的置信度低于主推。

### 乐队名也是一等检索词
上游 README 里的 `/查曲 mygo 27`（乐队 + 等级）是既有语义，所以乐队名在三个地方都能查：
`song_search`（含 `chart_info`，因为它复用同一套解析）、`card_search`、`gacha_info`。
实测 `mygo 27` 返回 3 首，等级筛选正确地把 EXPERT 27.5 也算了进来。

### 字符匹配分两套规则

这是踩过坑的：ASCII 只认「整词 / 连续词拼接 / 词首前缀」，CJK 才允许子串。

- 别名 `saki` **不能**子串命中 `Soyo Naga**saki**` 和 `Mahoro Hama**saki**`（会查出别人的卡）；
- 但 `开服纪念！Ave Mujica Pick Up招募` 这种带空格的名字，查询归一化后是连写的 `avemujica`，
  所以要把**相邻词拼起来**参与比较才能命中 —— 这层拼接不会退化成子串匹配；
- CJK 没有词边界，「祥子」本来就该在「丰川祥子」里命中。

测试里有对应的回归用例。

## 设计要点

- **出站一律走 `ctx.sender.sendMedia`**，由核心负责串行、限频、去重、留档，插件不自己控频。
- **缓存是派生结构，不是原样存上游。** 上游 12 张表约 5.6 MB，其中 `MasterText` 独占 5.19 MB；
  同步时只把被引用到的文本解析出来（丢掉空值、丢掉与其他语言重复的值），落盘只有约 120 KB。
- **多语言输出按书写系统去重**：汉／假名／拉丁／谚文各留一个。上游有些字段本身是合并串
  （角色名是 `Oblivionis / 丰川祥子`），五种语言原样拼开会有十来个词，既撑上下文又难读。
- **提示词与 i18n 的分工**：上游自带一套三语回复（`i18n.py`，5.7 KB），这里整个不要了 ——
  工具只返回结构化数据，回复由模型按用户那句提问的语言自己写。
- **刷新失败保留旧缓存**（stale-but-working 优于 down），并在返回值里注明「上游暂时不可达」。
- **同步不在 `setup()` 里做**，改成首次查询时惰性同步，实测 5 秒内完成。
- **设置每次调用现读**：面板改设置不会触发 Skill 重载（`routes.js` 只写 config，不调 `reloadSkills`），
  在 `setup` 时读成常量会导致「改了没反应」。
- **缓存带结构版本号（`CACHE_SCHEMA`）。** 加了新表、**或给派生结构加了字段**，都必须 +1，
  否则新版本会拿着旧结构的缓存跑：新字段是 `undefined`，表现为「这个功能一条都抓不到」
  或是「新加的关联静默失效」，而**不是报错**，并且 TTL 内（默认 6 小时）会一直这样。
  这个坑踩过两次：v1 缓存被 v1.1 读走导致卡池永远为空；给 gacha 加 `featured` 时忘了升版本。
  现在版本不符会打一行日志并自动重新同步。
- **乐队名必须经 `MasterText` 解析。** `MasterBand` 行里只有 `_nameTextID`，没有文本列，
  把整行喂给 `localized()` 会**静默得到 null**。这个 bug 从 v1.0.0 就在，
  因为输出层对空乐队会跳过，所以一直没露馅，直到按乐队关联卡池才暴露。

### ⚠️ 子模块必须用入口的查询串动态导入

加载器的热重载是 `import(\`${entryUrl}?t=${Date.now()}\`)` —— 时间戳**只加在入口上**。
入口里的静态 `import './lib/query.js'` 不带它，于是 Node 的 ESM 缓存会一直返回
**第一次加载时的那份旧模块**。后果：改完子模块热重载读到旧代码，报
`does not provide an export named 'xxx'`；更坑的是加载器「沿用旧版本」那条分支
**不打日志**，`❌` 一个字都没有，只能从 `/api/skills` 的 `lastError` 字段里看到。

所以 `index.js` 里子模块要这样导入：

```js
const CACHE_BUST = new URL(import.meta.url).search;
const { OurNotesStore } = await import(`./lib/sync.js${CACHE_BUST}`);
```

这样改任何文件都能正确热重载。如果哪天确实卡在旧代码上，`POST /api/skills/reload`
可以强制重扫（UI 的「刷新」按钮就是它）。

## 卡池的关联链

`MasterGacha._lotGroupId` → `MasterGachaLot._lotGroupId` → `MasterGachaLot._prizeGroupId`
→ `MasterGachaPrize._groupId` → `_resourceId`（卡牌 ID）→ `MasterMemberCard`。

`_pickUpType >= 2` 判为 rate-up（本池主打）。这是**从数据推断的**，上游没有文档说明 ——
实测两个开服池的 rate-up 正好互为镜像，与卡池名一致，所以这个判读可用。

### 关联角色与乐队：只取 rate-up

按「梦限大」「由乃」查卡池，靠的是 `featured` 字段：

```
rate-up 卡 → 角色 → 乐队      （成员卡看自身角色，支援卡看它挂的角色列表）
```

**不能拿整个池去关联**：一个池收录 120 多张卡，横跨全部 25 名角色，
那样每个卡池都会匹配到所有人。只有 rate-up 才是这个池的主打 ——
也正是「由我主演的赛博之夜招募」这种名字里完全不含角色名/乐队名的池能被命中的原因。

名字命中优先于关联命中（关联打 0.7 折），结果里会打印一行「关联：」说明命中理由。

## 安装

```
resources\app\skills\ournotes\      ← LLM 型放 skills/，不是 plugins/
  skill.json
  index.js
  lib/sync.js
  lib/query.js
  README.md
```

`test.mjs`、`_e2e_live.mjs`、`fixtures/` 是开发用的，不必复制进插件目录。

装好后到「工具与技能」面板里**打开开关**（`enabledByDefault` 为 false，默认不启用），
日志里应出现：

```
[skill] ✅ 加载成功：Our Notes 查询（ournotes v1.1.0，api v1）
```

## 自检与排障

```powershell
# 纯逻辑 + 真实数据夹具，不需要 QQ Agent，也不需要联网
node test.mjs

# 真实上游端到端：同步 + 五个工具 + region 切换
node _e2e_live.mjs
```

`test.mjs` 需要 `..\fixtures\` 下的 12 张表夹具（上游实测下载）。缺夹具时只跑纯函数用例。

常见问题：

- **日志里 `加载失败`**：多半是 `skill.json` 写坏了（BOM 或多余逗号）。
- **查询回「数据不可用」**：`permissions` 里少了 `web_fetch`；或上游不可达且本地还没有缓存。
- **只出文字没有图**：面板里 `sendImages` 关了，或 `maxImages` 是 0。
- **图片 404**：上游素材服务按 key 的快照导出，未导出的路径返回 404。
  **活动的 banner／logo／top 目前全部 404**，所以 `event_info` 不发图。
- **换了 `region` 数据没变**：TTL 内的缓存不会重取。等缓存过期，或临时把 `cacheTtlHours` 调小。

## 与上游的差异（实测记录）

对照 `ournotes-qq-bot` 的 `data.py` 与 `StarMoe-org/moenotes` 的当前配置，上游换过三代接口：

| 项 | 上游 Python 里的写法 | 现在的实际接口 |
| --- | --- | --- |
| 版本清单 | `/version/latest.json` | `/current_version.json`，按区域分组 |
| 表字段 | `jacketAssetName` | `_jacketAssetName`，**全部带 `_` 前缀** |
| 素材定位 | MoeNotes `images.json` 清单 | 清单已 404，改为按路径直接构造 |
| 图片地址 | `storage.bdon.moe/moenotes/...` | `assets.bdon.moe/{语言}/{key}/{label}.{ext}` |
| 区域维度 | 无（且路径写法失效） | `{base}{path}{Table}.json`，path 如 `/tw/master/` |

两个最容易踩的点：

- **字段前缀**：表结构仍是 `{"_allData": [...]}`，看起来没问题，但取曲名和封面会**静默拿到空值**。
- **字段大小写不一致**：`MasterEvent`／`MasterGacha` 是 `_nameTextId`（小写 d），
  而 `MasterMemberCard`／`MasterSupportCard`／`MasterCharacter` 是 `_nameTextID`（大写 D）。
  同一份数据里两种并存，统一处理会取到空。

### 上游说「没有数据」的两项

上游 README 写「活动和卡池目前上游没有可用数据，回复暂未上线」—— 那是**开服前的结论**。
游戏 2026/09/30 开服后这些表就有内容了：`MasterEvent` 1 行、`MasterGacha` 11 行（jp 区 10 行），
本移植已实现。仍然缺数据的只有**预测线（ycx）**。

### 谱面：资料已实现，音符图待做

**谱面 JSON 是能取到的**，地址在资产服务上（不在旧的 `storage.bdon.moe/moenotes/`）：

```
{assets}/{语言}/Live/MusicScore/{scoreFile}/{文件名}.json
  例：https://assets.bdon.moe/zh-Hans/Live/MusicScore/0001/0001_00/0001_00.json
      → 3476 bytes，meta.version=100，音符 73 个
```

`scoreFile` 就是 `MasterLiveMusicScore._musicScoreTextFileName`（如 `0001/0001_00`），
依据是 MoeNotes 的 `docs/chart-renderer.md`，已实测确认。

格式：

```
score.notes: {t, pos, size}                            点按
             {t, pos, size, crit:true}                 暴击
             {t, pos, size, type:"flick", dir}         滑键
             {type:"long", node:[{t,pos,size}, …]}     长条（节点连线）
score.events: bpm / sig / skill / fever / call
```

绘制规则在**上游 `visuals.py` 里是完整的**（`_draw_score`，实测可搬）：

- `pos` / `size` 是**宽 24 单位的判定区**坐标，分隔线在 6 / 12 / 18
- `t` 是 tick，**480 = 1 拍、1920 = 1 小节**（4/4）；网格线每 480 一条、1920 的加粗
- 切栏：一栏最多 1920×4 tick，最多 4 栏；`first = (min//1920-1)*1920`
- 长条先画底（节点间多边形 + 两侧描边），再画所有端点
- 颜色：点按 `#75C5E8`、滑键 `#68D99C`、暴击 `#F7D478`、长条底 `#31515D`、guide 底 `#274A42`
- 音符矩形高 ±4 px、圆角 3；`visible:false` 的节点跳过

**没做的是把音符画成图**：QQ Agent 只有 js-yaml/undici/ws，没有图像库，
需要手写 PNG 编码器（`node:zlib` deflate，约 120 行）+ 按上面规则绘制（约 150 行）。
音符就是矩形与多边形，**不需要字体光栅化** —— 这是唯一一次纯 JS 出图不卡在中文上
（栏目编号那种小字可以省略，标题/等级/物量放文字里说）。

### 物量的口径

`chart_info` 报的物量是 `_fullComboCount`，**跟随上游口径** —— `data.py` 里就是
`notes=int(score.get("fullComboCount", 0))`，`visuals.py` 再写成 `{chart.notes} Notes`。

注意它和谱面 JSON 里的音符条目数**不是一个口径**（实测 `0001_00` 是 342 vs 73，
且比值不固定）。要精确物量得拉谱面 JSON 数节点，那是画图那一步顺带能做的事。
