# comfyui-image —— 让 QQ Agent 自己画图

调用本机 **ComfyUI** 按描述生成图片，直接发到当前会话。
支持两个模型、三个档位；**中文自动翻译**；**联网查角色卡**；**参考图**。

参考图有三种来源：**群友在聊天里直接发的图**（最准）、按角色名取该角色的外观参考图、按关键词取通用构图参考图。

参考图**默认「只取外观」** —— 从图里提取发型/发色/瞳色/配饰/服装写进提示词后走纯文生图，
**构图完全由描述决定，不受参考图影响**（见第六章）。要照抄构图可切 `composition` 模式。

## 两个工具

| 工具 | 干什么 |
|---|---|
| `comfyui-image__find_character_tags` | 联网查角色的标准 danbooru 标签 + 「角色卡」（该角色高频共现的标签） |
| `comfyui-image__draw` | 出图并发到会话（中文会自动翻译）。传 `ref_message_id` / `ref_character` / `ref_keyword` 则先取一张参考图当底图重绘 |

## 三个档位（设置里「用哪个模型」切换）

| 档位 | 模型 | 步数/CFG | 实测速度 | 适合 |
|---|---|---|---|---|
| `anima-turbo` **（默认）** | Anima Base v1.0 + 官方 Turbo LoRA | 8 步 / CFG 1 | **约 14~22 秒** | 群聊日常，最快最好看 |
| `anima` | Anima Base v1.0 画质模式 | 30 步 / CFG 4 | 约 90~100 秒 | 认真出一张、要细节 |
| `illustrious` | 光辉 WAI-illustrious v14（SDXL 单文件） | 28 步 / CFG 5 | 约 45~57 秒 | 想要光辉那种标签风格 |

> Anima 是 **ComfyUI 官方（Comfy Org）共同开发**的新一代动漫模型，用阿里 Qwen3 系的
> CLIP + VAE 取代 SDXL 那套。档位参数全部取自 ComfyUI 官方模板 `image_anima_base_v1.json`。

## 一、中文自动翻译

群友直接用中文说就行。技能会把中文翻成该档位需要的英文提示词：

- **光辉档** → `1girl, silver_hair, blue_eyes, under_cherry_blossom_tree, sailor_uniform`
- **Anima 档** → `a silver-haired girl with blue eyes standing under cherry blossom trees, wearing a navy sailor uniform`

实测翻译一次 1~2 秒、**23 个输出 token**。

### 为什么不是"退回让模型改写"

退回需要多跑一轮工具调用，而且模型改写质量不稳定。技能自己调一次 LLM 更直接、更一致。

### 用哪个 LLM

**复用 QQ Agent 自己配的那个**（读 `data/config.json` 的 `api.baseUrl` / `api.apiKey` / `api.model`）。
好处是不用再复制一遍 Key，也不会出现"技能里的 Key 和应用里的不一致"。
要用别的模型，填设置里的 `llmBaseUrl` / `llmModel`（Key 仍走配置文件）。

### 关掉思考（关键优化）

本机配的 `deepseek-flash` 是**推理模型**——翻译"银发蓝眼的女孩"它也会先写一长串 reasoning。
实测同样内容：

| | 输出 token | 结果 |
|---|---|---|
| 开思考 | 362（其中 340 是思考） | 正确 |
| **关思考**（`thinking: {type:'disabled'}`） | **23** | **完全一样** |

所以技能默认带 `thinking: {type:'disabled'}`；某些端点不认这个参数时会收到 4xx，
技能会自动退回不带参数的写法重试，不影响可用性。

> 顺带修掉一个真实故障：开思考时思考链偶尔会吃光 token 预算，导致 `content` 返回空，
> 表现为"翻译失败：LLM 返回空内容"。现在关了思考 + 空内容自动重试一次，实测 10/10 通过。

## 二、联网查角色卡

群友点名要画某个角色时，模型先调 `find_character_tags`，拿到的是**真实数据**而不是凭记忆猜：

```
角色「初音未来」→ 标准标签：hatsune_miku（角色，标签库有 112033 张图）

角色卡（统计了 60 张该角色的图，数字是出现比例）：
  外观（优先用）：twintails 78%, long_hair 73%, aqua_hair 70%, very_long_hair 50%,
                  aqua_eyes 38%, hair_between_eyes 33%, hair_ornament 28%
  其他常见：vocaloid 95%, shirt 60%, necktie 45%, detached_sleeves 43%, skirt 43%
```

### 角色卡是怎么算出来的

抓该角色的 N 张样本图（dapi 的 post 接口每条都带完整 `tags` 字段），统计标签出现频率。
得到的正是"画师们默认会给这个角色加哪些标签"——比百科更贴近实际出图需要。

实测几个：

| 角色 | 角色卡（外观部分） |
|---|---|
| 初音未来 | twintails 78%, long_hair 73%, aqua_hair 70%, aqua_eyes 38% |
| 雷姆 | blue_hair 83%, short_hair 78%, hair_ornament 68%, blue_eyes 63%, hair_over_one_eye 52% |
| 阿尔托莉雅 | blonde_hair 88%, ahoge 73%, green_eyes 65%, braid 50%, hair_bun 50% |

### 标签库为什么用 safebooru

本机实测：`danbooru.donmai.us` / `gelbooru.com` / `wikipedia` **全部超时不通**，
`safebooru.org` 通，而且**是同一套 danbooru 标签体系**（标签名完全通用）。
换镜像改设置里的「标签库地址」即可。

### 查标签的顺序有讲究

**先精确，再前缀，最后子串**。因为 dapi 的模糊查询**不排序且会被 limit 截断**：
实测 `%miku%` 取 1000 条都捞不到 `hatsune_miku`（被 `miku_append` 这些挤掉了），
而前缀查 `hatsune%` 只有 168 条，排第一的就是它（112033 张）。这个坑踩过才知道。

### 自动补外观标签

`draw` 还带一层兜底：提示词里出现能认出来的角色标签时（`hatsune_miku`），
自动联网查它的角色卡，把**外观类**标签补进去。

**只补外观（发色/发型/瞳色/兽耳/光环…），不补服装**——用户可能明确要"穿和服"，
这时硬塞 `necktie, detached_sleeves` 会打架；而补发色瞳色几乎不会有冲突，
那本来就是"认出这个角色"的关键。

实测效果：提示词只给 `hatsune_miku, drinking bubble tea, sitting in a cozy cafe, warm lighting`，
自动补上 `twintails, long_hair, aqua_hair, very_long_hair, aqua_eyes, hair_between_eyes`，
画出来是标准初音——青色双马尾、青瞳、手臂「02」、分离袖、领带、耳机全中。

### 查不到怎么办

返回一段明确的说明，让模型**用自己的 `web_search`** 搜「<角色名> danbooru tags」。
技能不去做网页抓取和解析——那是 Agent 自带工具的强项，不重复造。

## 三、找参考图重绘（img2img）

群友说「照着这张画」「要那种构图」「同款姿势」时，光靠文字描述是画不准的。
`draw` 现在支持传 `ref_keyword`：技能自己去**找一张真实图片当底图**，再按设定的重绘幅度重画。

### 这座桥原来是不通的

v3 之前，能力其实两头都有，就是没接上：

| | 状态 |
|---|---|
| 找图侧 | `smart-image` 早就暴露了能力 `image.search`，返回**已下载校验过的本地文件路径 + 实测宽高** |
| 消费侧 | 只有 `qzone-post` 在用它（发空间配图） |
| 出图侧 | `comfyui-image` 完全没用它 —— 只有 `find_character_tags`（返回**文字标签**）和纯文生图 |

于是 `image.search` 的返回值正好是 `LoadImage` 需要的输入，却没人去接。v4 就是接这根线。

### 工作流怎么变的

原来是纯 `EmptyLatentImage`（纯噪声起步）；用参考图时换成：

```
20 LoadImage → 21 ImageScale（等比缩放到出图尺寸）→ 22 VAEEncode → KSampler(latent_image=22)
```

节点号**故意跳开 1~10** —— Anima 的 turbo LoRA 已经占了 `10`，撞号会让节点图错乱。

`KSampler` 的 `denoise` 原来是硬编码 `1.0`（完全重绘 = 纯文生图），现在参数化：
**只有带参考图时才允许 < 1**（没参考图还用低 denoise 是没意义的，latent 是纯噪声，只会画出糊图）。

### 重绘幅度怎么理解

| denoise | 效果 |
|---|---|
| 0.3 左右 | 几乎照抄构图，只换画风 |
| **0.6（默认）** | 保留大致布局，自由发挥 |
| 0.8 以上 | 只借个大概意思 |
| 1.0 | 等于不用参考图 |

模型可以按群友的语气传 `ref_denoise`：「就要这张的感觉」→ 0.35~0.5；「参考一下但换个场景」→ 0.65~0.8。

### 尺寸为什么不能直接用默认值

img2img 如果硬拿 1024×1024 去套一张 3:4 的竖图，`ImageScale` 会把它**压扁**（crop 只能裁不能补），
画出来的人比例就歪了。所以用参考图的实际宽高比等比缩放。

**缩放基准是设置里的"默认尺寸"，不是 `maxWidth`/`maxHeight`。**
后者是"6GB 显存的安全边界"，是保险丝不是目标值 —— 第一版写错过，一张 1600×1600 的参考图
被顶到 1536×1536，等于每次出图都拿默认配置去撞显存红线。实测：

```
默认 1024x1024 + 参考图 848x1200  → 704x1024   （竖图，比例 0.827 vs 参考 0.707，对齐 64 后）
默认 1024x1024 + 参考图 4000x3000 → 1024x768
默认 1024x1024 + 参考图 3840x2160 → 1024x576   （16:9 比例 1.778 精确保住）
```

### ⚠️ 选图必须 pixiv 优先（踩出来的）

第一版按**面积取最大**挑参考图。实测搜「樱花树下少女」时日志显示
`pixiv 命中 8 条`，但它放着 pixiv 插画不选，挑了一张更大的百度原图 ——
**那是一张带字幕的 AI 生成图**，上面印着「樱花舞动，美人如梦」「搞笑配音」。

后果不是"图不好看"这么轻：img2img 会把印在图上的字**当成构图的一部分忠实复现**，
输出画面上真的出现了 `MŁCOL SS WE`、`©NOGOAN`、`GON!` 这些乱码字母，整张图废掉。

两处修复：

1. **选图排序改成 pixiv 优先**，其次才比分辨率。
   ACG 关键词下 smart-image 会同时给 pixiv 插画和搜索引擎"原图"，前者是真人画的、没有水印层。
   非 ACG 关键词本来就没 pixiv 结果，自然退回按面积挑。
2. **用参考图时自动补一组文字类负面词**（`text, watermark, signature, letters, caption, subtitles, logo...`）。
   Anima 两个档的官方负面词里**一个文字类词都没有**（只有光辉档有 `watermark/signature/text`），
   所以单独兜底。只在使用参考图时加，不影响原有纯文生图。

修完复测：参考图换成了 pixiv 的 848×1200 插画，构图（左上蓝蝴蝶、右侧蝴蝶、右下花束、角色发色瞳色）
全部继承，服装/背景按 prompt 改成水手服 + 樱花；
参考图左下角的 `@Ki Ahenco` 水印签名**没有被复现成文字**。

### 为什么不用 IPAdapter / ControlNet

那两个是自定义节点，**本机 ComfyUI 没装**（只有核心节点）。
img2img 是核心节点就能做的，零额外依赖，先把路走通；以后装了 IPAdapter 再在 `buildWorkflow` 加分支。

### 失败一律降级，不中断出图

找图能力没装、找图超时、上传失败、参考图路径不存在 —— 任何一种情况都**不报错中断**，
而是退回纯文生图，并把原因写进返回值让模型知道（模型会转告群友）。
这跟本文件开头"软依赖"的取舍一致：可选增强不该让主功能不可用。

## 四、找特定角色的外观参考图

群友说「画个初音未来在教室里喝奶茶」时，光靠文字标签容易画成「像但不是」。
`draw` 支持传 `ref_character = 角色名`：技能去标签库找一张**确实是这个角色**的图当底图重绘。

### 为什么角色参考要单独走 booru，而不是复用 image.search

`image.search` 是**关键词搜索** —— 搜「初音未来」可能搜到同人图、CP 图、甚至只是配色像的图。
booru 的**标签本身就是保证**：打了 `hatsune_miku` 标签的图，就是初音未来。
而 safebooru 的 dapi 我们本来就在用（`find_character_tags` 统计角色卡），加个作品查询是顺手的事。

### ⚠️ 分级过滤必须用 `rating:safe`（踩出来的，安全相关）

这是本次最要紧的一个发现。实测 safebooru 的 dapi：

```
tags=hatsune_miku                    → 40 条，分级分布 {"q":39,"s":1}
tags=hatsune_miku rating:general     → 40 条，分级分布 {"q":40}    ← 等于没过滤
tags=hatsune_miku rating:safe        → 40 条，分级分布 {"s":40}    ← ✅ 唯一正确的写法
tags=hatsune_miku rating:explicit    → 0 条                       ← safebooru 没有 explicit
```

**默认返回流被 questionable 淹没了**（前 40 张里 39 张是 q）。
群里的机器人不做过滤随便挑一张，很可能直接发出不当内容。
所以用 gelbooru 系的 `rating:safe`，并且做成默认强制的设置项（`refRatingSafe`）。

好消息是 safe 级作品很充足（`hatsune_miku` 有 38 张可选），不是"过滤完就没图了"。
若某个角色的 safe 级作品太少导致找不到，技能会**降级成纯文字画图**并说明原因 ——
**不会偷偷用 q 级的来凑**。

### ⚠️ 下载要用 `file_url` 而不是 `sample_url`（踩出来的）

实测 `sample_url` 有时是**裁剪版**：原图 `850x1755`，sample 只有 `850x364`。
拿它当外观参考会把角色裁得只剩一半。所以优先 `file_url`（原图），
只有拿不到时才退回 sample，并按 `sample_width/sample_height` 取尺寸。
下载后会**校验魔数**（PNG/JPEG/GIF/WebP），避免把 403/HTML 错误页当图片存下来。

### 挑图策略

查询优先带 `solo`（单角色图，外观最干净），没有再放宽。排序按：
**短边够大** → **比例像人物立绘**（宽高比 0.5~1.6，排除极窄条幅）→ 面积大。
同一角色结果**缓存 10 分钟**，群友连着让画同一个角色不会重复下载。

### 和标签互补，不是二选一

`ref_character` 解析出的角色标准标签会被**注入 prompt**，紧接着触发既有的
「自动补角色外观标签」——所以最终 prompt 长这样：

```
hatsune_miku, a person drinking milk tea in a classroom,
twintails, long_hair, aqua_hair, very_long_hair, blue_eyes
```

**参考图保证长得像，标签再钉一遍外观**，两边互相加固。

### 实测效果

参考图取到 `hatsune_miku` 的 safe 级作品（1175x2048），出图 576x1024：

| 特征 | 参考图 | 产物 |
|---|---|---|
| 青绿双马尾 / 蓝绿瞳 | ✓ | ✓ |
| 红粉方形发饰 / 带麦耳机 | ✓ | ✓ |
| 黑色分离袖 + 青绿滚边 | ✓ | ✓ |
| 白无袖衫 + 青绿荷叶领 + 领带 | ✓ | ✓ |
| 黑百褶裙 + 过膝袜 | ✓ | ✓ |
| 喝珍珠奶茶 | — | ✓（prompt 驱动的新动作） |

角色的辨识度完整保留，动作由 prompt 改写 —— 这正是 img2img 期望的行为。

> ⚠️ 一个残留小瑕疵：参考图胸前的 `VOCALOID` 徽章，在小字区域仍被复现成了**伪文字**（`PIASTIND` 之类）。
> 负面词里的文字抑制对**大字**（整行字幕）有效，但对这种小徽章不够。
> 介意的话把 `refDenoise` 调高（0.7~0.8）会明显改善。

### 怎么选 ref_character / ref_keyword

| 群友的话 | 该传 |
|---|---|
| 「画个初音未来在教室里喝奶茶」 | `ref_character: "初音未来"` |
| 「照着樱花树下那种感觉画」 | `ref_keyword: "樱花树下少女"` |
| 「画个初音未来，同款樱花构图」 | 两个都传（**角色优先**，命中后不再走关键词搜索） |

优先级：`ref_file`（确切路径）> `ref_character` > `ref_keyword`。

## 五、用聊天里的图片当参考

群友直接发了张图、或**引用着**某张图说「照着这个画」—— 那是三种参考来源里**最准的**，
就是本人给的那张，比任何搜索、任何文字描述都准。

| 参数 | 用途 |
|---|---|
| `ref_message_id` | 那条带图消息的 #数字（聊天记录里每条前的号，可为负） |
| `ref_recent_image` | `true` = 用会话里最近一张群友发的图（拿不准 id 时用） |

### 图片从哪来

核心早就把入站图片存进会话存档了（`store` 的 `media` 字段：`{ kind, url, file, ... }`），
而工具执行时的 `ctx` 带着 `store` 和 `onebot`（见 `orchestrator.js` 里 `executeTool(toolDefs, ctx, ...)`
用的是同一个 ctx）—— 所以技能不需要任何新能力就能拿到。

取字节的顺序**照抄 `sticker-manager` 的实战结论**：

```
① OneBot get_image(file)  →  协议端本地缓存，**不依赖 url 时效**
② 直链下载 url            →  新消息 url 没过期时有效
```

为什么缓存优先：消息里的直链过一阵就 403 了，而协议端缓存通常还在，且 `get_image` 只认 file id、
不受 url 过期影响。测试里专门放了一个**故意写坏的直链** + 一个有效的缓存路径，
断言技能走缓存、不去碰那个坏链。

### ⚠️ 聊天图没有宽高，得自己读（这是必须解决的一环）

`media` 条目只有 `url`/`file`，**没有宽高**。而 img2img 的出图尺寸是按参考图比例算的
（第三章的 `fitSizeInto`）—— 拿不到宽高就只能回到默认方形，竖图会被压扁。

拉一个图片库只为读两个数字太重，所以写了个纯 JS 的 `readImageSize`，按格式解析文件头，
零依赖，支持 PNG / JPEG / GIF / WebP：

| 格式 | 读法 |
|---|---|
| PNG | IHDR 的宽高在偏移 16 / 20（大端 u32） |
| JPEG | 逐段找 SOF 标记（C0~CF，排除 C4/C8/CC），高在 +5、宽在 +7 |
| GIF | 小端 u16 @6 / @8 |
| WebP | 按 VP8X / VP8 / VP8L 子类型分别取 |

**它被 ffprobe 独立验证过**：测试里对 5 个真实文件（3 个 PNG + 2 个 JPEG，含 3200x4000 的大图）
同时跑 `readImageSize` 和 `ffprobe`，断言两者完全一致 —— 不是自己验自己。

### 优先级

`ref_file`（确切路径）> **`ref_message_id`/`ref_recent_image`** > `ref_character` > `ref_keyword`。

为什么聊天图排在角色参考前面：那是群友**本人指定**的那张，是这次要画的直接依据；搜索来的只是替代品。

但 `ref_character` 的**标准标签仍会注入 prompt** —— 实现上把"解析角色标签"和"下载角色参考图"
拆成了两步（`resolveCharacterName` / `findCharacterReference`），所以
「用群友发的图 + 同时点名角色」这个组合是有效的：**底图用群友的，外观标签照样补**，
而且不会白下一张用不上的角色图。

### 失败一律降级

消息 id 不存在、那条消息里没有图、协议端缓存过期且直链失效、图片格式不认识 ——
全部**不中断出图**，退回纯文字画图并把原因回给模型转告群友。

## 六、参考图怎么用：只取外观 vs 照抄构图

第三章到第五章讲的都是**怎么把参考图送进 img2img**。但 img2img 有个绕不过去的性质：

> **它必然带走参考图的构图。** 那不是 denoise 没调好 —— latent 是由参考图 VAE 编码而来的，
> 实测 denoise 0.6 时参考图的枝条位置、机位、人物姿势都会保留。

所以「用这张图的外观，画一个她坐着看书的场景」这种要求，img2img 是**做不到**的：
姿势会被参考图带跑。

### 解法：不把图送进采样器

把**图**换成**外观标签**：

```
参考图 → 视觉模型读图 → 外观标签（发色/发型/瞳色/配饰/服装）
                        → 写进 prompt → 纯文生图（EmptyLatentImage）
```

构图 100% 由 prompt 决定，与参考图无关。这也是现在的**默认模式**（`refMode = appearance`）。

### 为什么零新依赖

本来准备装 IPAdapter（Anima 确实有社区实现），但探路时发现两件事：

1. Wenaka2004 的 README 指向的 `circlestone-labs/comfyui-anima-ipadapter` **404 不存在**；
2. 更重要的是 —— **QQ Agent 自己配的那个模型就能读图**（实测 HTTP 200）。

于是：不用装自定义节点、不用下模型、不用管 6GB 显存够不够。
`llmChat` 这套现成的「关思考 + 4xx 回退 + 空内容重试」直接复用。

### 实测记录（都是这轮踩出来的）

| 条件 | 结果 |
|---|---|
| 384px + 关思考 | 可用，但**返回里混进了** `eating` / `upper_body` / `looking_at_viewer` / `simple_background` |
| **768px + 关思考** | ✅ 1.2 秒，**只返回外观** |
| 原图 4.21MB（请求体 5.61MB） | ✅ HTTP 200、2.7 秒、1077 prompt token，也只返回外观 → **不需要缩放，绕开 ffmpeg 依赖** |
| 开思考 | `reasoning` 吃光 token 预算，`content` 返回空（本文件开头记录过的老坑） |

结论：**必须关思考**（`llmChat` 默认就关）；分辨率越高模型越听话；**但不能指望它每次都听话**。

### 硬过滤兜底

上面那次 384px 的输出里混着姿势和背景标签。如果直接写进 prompt，构图照样会被污染。
所以提取完还有一层**无条件剔除**：构图/姿势/表情/道具/背景/人数类标签一律不许进 prompt。

**这里我自己踩过一个坑**：正则有 `phone`（想挡"手机"这个道具），结果**误伤了 `headphones`** ——
而耳机恰恰是初音的标志性配饰。同理 `bed` 误伤 `bedhead`（发型）。
修复是加边界锚定 `(^|_)phone(_|$)`，并补了回归用例锁住。
已知的小代价：`hair_flower`、`star_hair_ornament` 这类含 flower/star 的配饰仍会被误挡。

### 提取失败时：绝不退回 img2img

消息 id 不存在、图片超上限、视觉模型读图失败 —— 任何一种情况都**降级成"这次不用参考图"**，
构图完全由 prompt 决定，并在返回值里说明原因。

**故意不退回 img2img** —— 那会违背「不影响构图」这个承诺。宁可少用一次参考图，
也不能在群友没要求的情况下偷偷把参考图的构图带进来。

### 另一个我自己造成又修掉的回归

「只取外观」模式下角色参考**不下图**（外观标签由角色卡给出，下回来也用不上）。
但这一省，把**标签验证**一起省掉了 —— 测试拿一个不存在的角色名 `zzznotarealcharacterzzz` 复现了：
LLM 猜的垃圾标签被当成标准标签**注入了 prompt**。

修复：即使不下图，也走一次 `findCharacterReference(..., { noDownload: true })` 做**标签验证**
（查该标签有没有 safe 级作品）。没通过验证的标签一律不注入。

### 怎么选

| 群友的话 | 该传 |
|---|---|
| 「画成这样的」「这个角色的感觉」 | 默认（`appearance`）就行 |
| 「照这张的**姿势**画」「同款机位」「就按这个构图，人物换掉」 | `ref_mode: "composition"` |

`ref_denoise`（重绘幅度）**只在 composition 模式生效**。

## 七、提示词标签库

**25 个类目 / 1105 个概念 / 3096 个主标签**，让模型**按用户要求现查准确写法**，而不是靠记忆猜。
工具是 `comfyui-image__prompt_tags`。

覆盖：质量词、构图、视角镜头、表情、姿势、身体特征、发型、发色、眼睛、各类服装（校服/传统/日常/礼服/泳装）、
配饰、场景地点、天气时间、光线、画风、特效、情绪、物件道具、动物、负面词。

每个概念给**两种产出**，按档位抄对应的那个：

```
【雨天】  weather_time · 天气与时间
  标签（写进光耀/Illustrious 档的 prompt）：rain✓, raining✓, umbrella✓, wet✓
  自然语言（写进 Anima 档的 prompt）：walking in the rain with an umbrella
```

（`✓` = 该标签已核对过标签库，写法可靠）

### 为什么要核对写法

模型（以及负责翻译的 LLM）凭记忆写 danbooru 标签**经常写错写法**，而写法错了模型就不认识，
等于白写。实测被纠正的例子：`hair_between_the_eyes` → 正确写法是 `hair_between_eyes`。

所以构建流程是：**起草概念表 → 逐个向标签库核对存在性 → 只留真实存在的**。

### ⚠️ 最大的一个坑：booru 不是万能的裁判

第一版我用「标签库里存在吗」当唯一裁判，结果报告 `worst_quality`、`rim_light`、
`volumetric_lighting`、`detailed_eyes` 全「不存在」，quality 类目掉 9 个、quality_extra 掉 32 个、
negative 掉 29 个 —— 而这三块恰恰是提示词库最该有的东西。

深查后明白了原因：

| safebooru 认（**描述性标注**） | safebooru 不认（**提示词约定**） |
|---|---|
| `1girl` 375万、`long_hair` 306万 | `worst_quality`、`worst_detail` |
| `absurdres` 127万、`blurry` 14.6万 | `score_1` / `score_2` / `score_3` |
| `watermark` 11.5万、`lowres` 7.9万 | `newest`、`amazing_quality` |
| `bad_anatomy` 2319、`backlighting` 24921 | `rim_light`、`volumetric_lighting`、`god_rays` |

**画师上传图时不会给图打 `worst_quality`** —— 那是 Stable Diffusion 的提示词工程约定，
不属于描述性标注。拿 booru 检验它等于拿错了裁判。

所以库分两个**语义域**，构建和查询都区别对待：

- **descriptive**（22 个类目）—— booru 是有效裁判，主标签**100% 经过存在性核对**
- **convention**（quality / quality_extra / negative）—— booru 没裁判资格，
  改由**模型官方推荐词表**兜底（取自本技能 `PROFILES` 里记录的模型作者推荐值）

没通过核对的候选不会直接丢，会降级进 `alt` 字段并标注「标签库里查不到，仍可能有效，谨慎使用」。
查询结果里会带出语义域信息，**不会把 convention 类当成"验过"的**。

### 另一个坑：构建脚本自己的静默失败

核对脚本第一版报了「存在 0 / 不存在 1652」—— 一查是正则捕获组写错：
`matchAll(/<tag\b[^>]*?\/?>/g)` 没有捕获组，却用了 `m[1]`，于是 `exec(undefined)` 拿字符串
`"undefined"` 去匹配，**每个标签都被判"不存在"**，跑完还一声不响地写出了一个空词库。

修好之后加了一道**前置自检**：先核对几个「已知一定存在」的标签（`sailor_uniform`、
`masterpiece`、`silver_hair`…），任何一个被判"不存在"就直接中止、不产出词库。
并且区分两种失败 —— `missing` 是逻辑错（必须中止），网络抖动则重试，不该因此中止整次构建。

### 自动补标签（默认关）

设置 `promptLibraryAuto` 打开后：提示词里出现了库收录的中文概念，就自动补上准确写法 ——
**光辉档补标签，Anima 档补自然语言**（形态按档位选，加错了反而有害）。

为什么默认**关**：这是**确定性的字符串匹配**（用户原话里出现「雨天」就命中），
不做语义理解、也不区分否定句（「不要雨天」同样会命中），而且它会改写提示词。
所以默认让模型**按需调用**工具，想每次自动兜底再打开开关。

### 用户可自定义

技能目录里的 `prompt-library.json` 是随技能发布的版本；
把同名文件放到 `data/` 目录下会**优先使用**（可以自己加概念、改标签，不会被升级覆盖）。

### 怎么重建库

草稿与构建脚本在 `E:\ComfyUI\qq-agent-prompt-lib-src\`：

| 文件 | 作用 |
|---|---|
| `01`~`07-*.json` | 各类目的概念草稿（想加概念就改这里） |
| `build-library.mjs` | 逐个核对标签写法 → 产出词库 + 报告 |
| `_tagcache.json` | 标签查询缓存（重跑时快得多；怀疑结果不对就删掉重查） |
| `_verification-report.md` | 每次构建的报告：哪些标签被判无效、哪些降级进 alt |

```powershell
node "E:\ComfyUI\qq-agent-prompt-lib-src\build-library.mjs"
```

脚本会先自检几个已知存在的标签，任何逻辑性失败都会**中止而不产出词库**（见上面那个静默失败的教训）。

## 其他关键设计取舍

| 决定 | 原因 |
|---|---|
| 走 HTTP（`/prompt` + `/history` + `/view`）而不是读 ComfyUI 的 output 目录 | 技能不需要知道 ComfyUI 装在哪。换盘、换端口、挪到局域网另一台机器，只改一个 `baseUrl` |
| 出图串行排队 + 每会话冷却 | 只有一块显卡。并发会直接把 6GB 显存挤爆，连点还会刷屏 |
| 自动拉起 ComfyUI 用 python 而不是跑 `启动ComfyUI.bat` | 那个 bat 带 `--windows-standalone-build` 会**弹浏览器**——群里说句话桌面上蹦出浏览器太惊悚 |
| 子进程输出写日志文件而非 `stdio:'ignore'` | 照抄 voice 技能：否则"起不来"就是个没有原因的谜 |
| 发图用**本地路径**（`{ file }`）而不是 base64 | 见 `src/sender.js`：协议端自己读盘，body 从 MB 级降到百字节，避开 15 秒超时窗口 |

## 配置项（QQ Agent → 技能 → AI 画图）

常改的：

- **用哪个模型** — `anima-turbo` / `anima` / `illustrious`
- **ComfyUI 地址** — 默认 `http://127.0.0.1:8188`
- **中文自动翻译成英文** — 默认开
- **自动补角色外观标签** — 默认开
- **允许用参考图** — 默认开（依赖「智能配图」技能提供找图能力）
- **参考图怎么用** — 默认 `appearance`（**只取外观，不影响构图**）；要照抄构图切 `composition`（见第六章）
- **角色参考图只取 safe 级** — 默认开，**强烈建议保持开启**（见第四章）
- **参考图重绘幅度** — 默认 `0.6`，越小越贴参考图；**只在 `composition` 模式生效**
- **自动从提示词库补标签** — 默认**关**；开着会按中文概念字符串匹配自动补准确写法（见第七章）
- **自动补标签的上限** — 默认 `8`
- **采样步数 / CFG** — 默认 `0` = 跟随档位官方推荐
- **负面词** — 留空 = 用档位官方推荐

调优用的：`characterCardSample`（取样张数，默认 60）、`characterCardTop`（返回标签数，默认 16）、
`tagApiUrl`（标签库地址）、`llmBaseUrl` / `llmModel`（翻译用别的模型）、
`refSearchCount`（参考图候选张数，默认 6）、`refMinShortSide`（参考图最小短边，默认 512）、
`refSearchTimeoutSec`（找图超时，默认 40）、`refAppearanceTags`（外观标签最多几个，默认 12）、
`refVisionMaxMB`（外观提取的图片大小上限，默认 8MB）。

提示词库本身不用配：`data/prompt-library.json` 存在就用它，否则用技能目录里随包发布的那份。

## 测试

`dsh-test-comfyui-refimg.mjs`（在 QQ Agent 根目录）覆盖 **143 项断言**，跑真机 ComfyUI：

```powershell
node "D:\Program Files (x86)\QQ Agent\dsh-test-comfyui-refimg.mjs"
```

分层验证：

1. `fitSizeInto` 纯函数单测（16:9 比例保持、不越显存上限、坏输入）
2. `readImageSize` 对 **ffprobe 独立基准**（真实 PNG/JPEG，含 3200x4000）
3. `isAppearanceTag` 硬过滤：用**实测拿到的真实模型输出**当用例（18 个应放行含 headphones/bedhead，24 个应挡掉）
4. 纯文字对照（graph 里必须是 EmptyLatentImage、denoise=1、无文字负面词）
5. img2img 主路径（`ref_mode=composition`）—— 把 ComfyUI 实际收到的 graph 拉回来断言：
   有没有 LoadImage/ImageScale/VAEEncode、KSampler 的 denoise 和 latent 来源、负面词里有没有文字抑制
6. 能力缺失降级 / pixiv 选图优先级
7. 角色参考图：标签解析与 booru 验证、`rating=s` 强制生效、标签确实进了正面提示词；
   不存在角色时**垃圾标签不会进提示词**
8. **聊天图**：消息 → 字节 → 宽高（与 ffprobe 一致）→ 比例适配整条链；协议端缓存优先（放一个故意写坏的直链）；
   `ref_recent_image` 取最近那条；消息不存在 / 消息里没图 都安静降级
9. **只取外观模式**：graph 里必须是 `EmptyLatentImage`、**没有 LoadImage/ImageScale/VAEEncode**、`denoise=1`、
   外观标签确实进了正面提示词、出图尺寸不受参考图比例影响
10. **提取失败必须降级成不用参考图** —— 断言 graph 里没有 LoadImage（不能偷偷走 img2img）
11. **提示词库结构**：类目/概念/标签规模、语义域标注、**描述性类目主标签 100% 经库验证**、
    约定类目首条是模型官方词表、每个概念都有 `en`、标签写法规范、抽查典型映射
12. **`prompt_tags` 工具**：不传参数列类目、按概念查、按类目查、按标签名反查、
    约定类目标注、查不到时列可用类目而不抛错
13. **自动补标签**：默认关时不动提示词；打开后命中概念、按档位选形态、日志与返回值都说明

> 测试用技能日志里的 `prompt_id` **精确取回本次的 graph**。
> 早先版本用"历史里新增的那条"，结果在本机（QQ Agent 正在跑、可能同时也在画图）抓到别人的 prompt，
> 导致"应该走 img2img"的断言假失败 —— 测并发应用的测试必须能区分"我的任务"和"别人的任务"。

## 依赖与前提

- skill.json 声明了 `permissions: ["web_fetch"]`（拿 `api.fetch` 的凭据，必须声明）
- 翻译需要 `data/config.json` 里有 `api.baseUrl` + `api.apiKey`（QQ Agent 本来就有）
- 需要 ComfyUI 装在 `comfyuiDir`（默认 `E:\ComfyUI`），里面有 `venv\` 和 `ComfyUI\`
- 自动拉起需要 `E:\ComfyUI\git\cmd\git.exe`（ComfyUI-Manager 需要 git，否则启动即崩）

## ⚠️ 注意：应用更新可能覆盖本技能

本技能装在 `resources/app/skills/comfyui-image/`，属于**应用安装目录**。
QQ Agent 若走 electron-updater 自动更新，`resources/app` 会被整体替换，本技能会消失。

备份在 `E:\ComfyUI\qq-agent-skill-comfyui-image\`，更新后复制回去再重启即可。

同目录下还有 v4 改造前的原版（`index.js.v3.0.0.bak` / `skill.json.v3.0.0.bak` / `README.md.v3.0.0.bak`），
要回滚直接去掉 `.v3.0.0.bak` 后缀覆盖回安装目录即可。

## 版本变更

| 版本 | 变更 |
|---|---|
| **4.4.0** | **提示词标签库**：新增 `prompt_tags` 工具（25 类目 / 1105 概念 / 3096 标签，逐个核对过写法）；按语义域区分 `descriptive`（booru 验证）与 `convention`（模型官方词表兜底）；新增 `promptLibraryAuto` / `promptLibraryMaxTags` 设置（默认关）；库可被 `data/` 下的同名文件覆盖以自定义 |
| 4.3.0 | **参考图默认改为「只取外观」**：新增 `refMode`（`appearance` 默认 / `composition`）—— appearance 模式下用 QQ Agent 自己的视觉模型从参考图提取外观标签，走**纯文生图**，**构图不受参考图影响**；提取结果经**硬过滤**剔除构图/姿势/表情/道具/背景类标签；提取失败**降级成不用参考图，绝不退回 img2img**；角色参考在该模式下只验证标签、不下图 |
| 4.2.0 | **用聊天里的图片当参考**：`draw` 新增 `ref_message_id` / `ref_recent_image` —— 从会话存档取群友发的图（协议端缓存优先），纯 JS 解析图片头拿真实宽高（经 ffprobe 独立验证）；角色标签解析与角色图下载拆成两步，使「群友的图 + 点名角色」组合生效 |
| 4.1.0 | **角色外观参考图**：`draw` 新增 `ref_character` —— 角色名 → booru 标准标签 → 该角色的作品（**默认强制 `rating:safe`**）→ 当 img2img 底图；角色标签自动注入 prompt 并触发外观标签补全；同角色结果缓存 10 分钟 |
| 4.0.0 | **参考图重绘（img2img）**：接上 `smart-image` 的 `image.search` 能力 —— `draw` 新增 `ref_keyword` / `ref_denoise` / `ref_file`；工作流加 LoadImage→ImageScale→VAEEncode 分支；`denoise` 参数化；按参考图比例算尺寸；选图 pixiv 优先；用参考图时自动补文字类负面词 |
| 3.0.0 | 中文提示词自动翻译；联网查角色卡（`find_character_tags`）；自动补角色外观标签 |
| 2.x | 光辉 / Anima 三档位；出图串行排队 + 会话冷却；ComfyUI 自动拉起 |
