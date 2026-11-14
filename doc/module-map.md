# QQ Agent 模块地图（架构导览）

> 由续更维护时整理，基于 v0.4.0（Nakie-zjm/qq-agent-maintained）源码。
> 本仓库版本 **v0.7.0**：在上游基础上新增设备控制（外联）、语音（TTS 说 / ASR 听 +
> 音色克隆 + 唱歌）、**实时语音通话 v1（QQ 私聊经虚拟声卡桥接：VAD 断句 → ASR →
> 人设 LLM → TTS → 通话播放；UIA 自动接听 + 白名单；打断 barge-in；回复消毒）**、
> 跨服务商看图、存档落盘批量化 + 冷会话 LRU、会话按天清理、群聊日报技能等；
> v0.6.1 补外部评审四项修复；上游无这些改动。
> 目标：改代码之前先看这张图，知道"这个东西在哪、动了它会影响谁"。

## 〇、一分钟全景

```
QQ 客户端（便携版 runtime/qq-portable，独立 --user-data-dir）
   ↕ SnowLuma 注入/协议实现（snowluma/，第三方，OneBot v11：WS 3001 收事件 / HTTP 3000 发送）
   ↓
src/onebot.js        事件进 → 存档
   ↓
src/store.js         每会话一个 JSON 消息库（唯一数据源）
   ↓
src/orchestrator.js  事件驱动引擎：防抖聚批 → 新开会话 → drain 循环 → 会话弃置
   ↓
src/prompt.js        组装提示词（静态系统提示 + 角色设定 + 已读信息 + 记忆 + 未读信息）
   ↓
src/llm.js           OpenAI 兼容 API（thinking.js 负责思考参数方言与降级）
   ↓
src/tools.js         工具循环（28+ 原生工具 + skills/ 注册的工具，全部经 tool-registry）
   ↓
src/sender.js        发送队列：串行 + 真人化间隔 + 限频 + CQ 转义 + Markdown 转纯文本
   ↓
回 QQ；会话记录进 src/sessions.js，HTTP/SSE 全貌走 src/routes.js → ui/
```

## 一、分层模块表

### 1. 桌面壳（electron/）
| 文件 | 行数 | 职责 |
|---|---|---|
| main.js | ~200 | 启动核心（同进程）、单实例锁、托盘常驻、关窗不退出、开机自启；**data/ 落位逻辑**（`resolveDataDir()`：env > 项目内 data/ > 安装目录旁） |
| preload.cjs | ~30 | 只暴露一个 `refocus()`（修 Electron alert 抢焦点 bug） |

### 2. 总装与运行时（src/）
| 文件 | 行数 | 职责 |
|---|---|---|
| app.js | 2072 | **总装**：OneBot 事件 → store → orchestrator；HTTP + SSE；便携 QQ 启停/进程管理 |
| instance-lock.js | 71 | 数据目录级单实例锁（qq-agent.lock = PID），防双核心双份回复 |
| config.js | 747 | data/config.json 的读写与默认值；DATA_DIR 常量出口 |
| profile.js | 18 | QQ_AGENT_PROFILE 多实例（data-N 后缀 + 端口偏移 N*100） |

### 3. 协议与发送（src/）
| 文件 | 行数 | 职责 |
|---|---|---|
| onebot.js | 524 | OneBot v11 客户端：WS 只收事件，HTTP 发送/查询（直连 SnowLuma，无 SDK 依赖） |
| sender.js | 372 | **全部出站唯一入口**：每会话串行、随机真人化间隔、分钟/小时限频、硬长度切分、CQ 转义；发出的消息回写 store（self=true） |
| speech/tts.js | ~250 | 语音合成多引擎入口（本仓库新增）：引擎无关决策（文本校验、唱歌/克隆判定、模型与音色选择、WAV 归一）→ 请求构造下沉 adapters/；预置音色/克隆（参考音频 DataURL，仅 mimo）/唱歌（引擎能力不支持则**报错不静默**）；配 sender.sendVoice（record 段走完整管道） |
| speech/asr.js | ~150 | 语音转文字多引擎分发：transcribeWav（纯 WAV→文本）+ transcribeRecord（群语音 record→WAV→转写）；ASR 可指独立服务商（speech.asr.providerId）；引擎无 ASR 能力 → adapter-no-asr |
| speech/adapters/ | ~700 | **语音区多服务商底座**（与大脑同款模式）：mimo（原样抽取，契约回归钉死）/ openai（公开契约，未联调）/ minimax（✅已真机联调：GroupId 可选——新版接口只用 Key 也能鉴权，填错反而 1004）/ **gpt-sovits**（本地克隆，cloneOnly：契约来自官方 api_v2.py 源码，ref_audio_path 同机绝对路径 + prompt_text 缓存/自动转写（缓存首行=源文件字节数防重传脏缓存）+ prompt_lang 按转写文本自动推断（假名→ja）+ 主服务商无转写能力时自动借用 ASR 服务商 + 采样参数固化，✅已真机联调；api_v2 硬约束参考音频 3~10 秒——适配器本地把关：过短可读报错、超长纯 JS 裁到 9.5 秒副本）；azure 已按用户决定移除（git 历史可找回）；各引擎声明能力矩阵（tts/clone/singing/asr/style）+ 音色表 + 默认模型；resolveAdapter：format 显式 > baseURL 推断 > 兜底 mimo |
| speech/singing.js | ~230 | **本地歌声链（SVC · 唱说音色一致的终解，用户验收 2026-11-05）**：（唱歌）标签 → ACE-Step(8001) 出歌 → demucs 分离人声/伴奏 → Applio RVC 把人声转写成克隆说话音色 → ffmpeg 混回伴奏；与 TTS 引擎完全解耦（tts.js 在 ep 解析**之前**路由，没配服务商也能唱）；`speech.singing.enabled` 开关（分发默认关），run/fetch/sleep 依赖注入可密闭测试；契约全真机钉死（query_result status 0/1/2 反直觉、export-format 必须大写 WAV、JSON 模式禁绝对路径）；RVC 验收参数 rmvpe/pitch0/index-rate0.75/protect0.33 别凭感觉改 |
| safe-fetch.js | 463 | SSRF 防护层：禁内网、DNS 全解析校验 + IP 固定、逐跳重定向校验、响应限量 |

### 4. 编排核心（成本模型的实现）
| 文件 | 行数 | 职责 |
|---|---|---|
| orchestrator.js | 1626 | 无状态运行引擎：防抖聚批(wakeDelayMs) → 已读/未读驱动 → drain 循环 → 同会话互斥、跨会话并行(maxConcurrentRuns) |
| prompt.js | 822 | **提示词组装（心脏）**：静态系统提示（身份/安全/工具协议/反AI味）+ 动态用户消息（时间/角色设定/已读/记忆/未读/表情包）——**不带对话历史** |
| tier-slider.js | 52 | 响应档位换算（0-100 → 1仅@/2关键词/3概率/4全响应）；刻意零依赖防循环引用 |
| thinking.js | 257 | 思考参数方言检测/构造/提取/降级建议（重试动作在 llm.js） |

### 5. 大脑接口（src/）
| 文件 | 行数 | 职责 |
|---|---|---|
| llm.js | 649 | OpenAI 兼容 Chat Completions（非流式）：工具调用、usage 统计、重试预算 |
| providers.js | 395 | 多提供商模型目录（OpenAI 兼容统一调用；中转站 baseURL 自补 /v1） |
| vision-scan.js | 147 | 1×1 测试图探测模型是否支持看图 → 门控看图工具 |
| web-search.js | 568 | Bing 中文搜索（免 key）；正文抓取走 safe-fetch |
| model-prices.js | 640 | 内置 140 模型价格表 + 峰谷/缓存/图片计费口径 |

### 6. 数据层（src/）
| 文件 | 行数 | 职责 |
|---|---|---|
| store.js | 281→360 | 每会话一个 JSON 消息库（data/messages/）：id/mid/ts/senderId/text/self/read/reply；**写盘防抖合并（500ms）+ 紧凑序列化 + LRU 常驻 20 会话**（内存即时最新，模型/UI 读内存；stop()/exit 兜底 flushAll） |
| sessions.js | 533→590 | 运行留档（data/sessions/<id>.json）：提示词/思考/工具调用/发送/用量全留；**keepSessionDays 按天滚动清理（默认 35 天，启动+每 6h 各一次）** |
| memory.js | 537 | 群友印象（data/memory/group_<群号>/<QQ>.json）：追加/查询/整理(冷却) |
| stickers.js | 233 | 表情知识库：QQ 收藏为源、本地库为 AI 认知层 |
| reminders.js | 79 | 提醒落盘（data/reminders.json），重启不丢 |

### 7. 工具与扩展系统（src/）
| 文件 | 行数 | 职责 |
|---|---|---|
| tools.js | 1189 | 原生工具集（send_message/poke、memory、query、web、sticker…），**每个工具绑定会话 chatKey —— 物理上无法发到别的群** |
| tool-registry.js | 183 | 工具注册表：registerTool() 即插即用，设置页卡片式开关 |
| plugin-loader.js | 454 | 扫描 plugins/（确定性型：providers+hooks，必执行不经 LLM）与 skills/（LLM 型：registerTool+提示词片段，模型决定用不用）；热重载；config.skills[id].enabled 单一开关 |
| plugins/mimo-asr | ~180 | 语音转文字**兜底**（本仓库新增）：提供 media.transcribe 能力 —— onebot.js 现在**核心适配器优先、此插件次之**（群语音跟随多引擎切换）；插件自包含不 import 仓库模块，保留作核心失败时的回退；任何失败静默回退 [语音] 占位 |

### 8. UI 与 API（src/ + ui/）
| 文件 | 行数 | 职责 |
|---|---|---|
| routes.js | 1456 | 声明式 API 路由表（method+pattern+handler，deps 闭包注入），SSE 实时推送 |
| ui/app.js | ~9000 | 零框架控制台（会话/存档/记忆/用量/技能/插件/设置），明暗双主题 |

## 二、必须知道的设计决策

1. **无状态会话 = 成本恒定**：LLM 零历史。每次运行 = 系统提示 + 存档摘要(已读) + 新消息(未读)，用完即弃。改任何"上下文带什么"都去 prompt.js。
2. **store.js 是唯一事实源**：模型的"记忆"就是 JSON 存档 + memory/ 印象。改存档格式要同步 prompt.js 的渲染和 ui 的展示。
3. **sender.js 是唯一出口**：绕过它直连 OneBot 发消息 = 绕过限频/去重/留档，测试会拦（"发送纪律"检查）。
4. **工具绑定 chatKey**：安全模型的地基，别给工具加"任意目标"参数。
5. **扩展两型判据**：规则能写死 → plugins/（必执行）；要理解人话 → skills/（模型决定）。选错类型会静默失效（不报错不崩就是没反应）。
6. **skills/ 与 plugins/ 出厂为空**：热重载开着，放进去就生效。
7. **store.js 写盘是合并的**：内存永远最新，磁盘 ≤500ms 延迟；改 store 读写逻辑时别在业务代码里直接读存档文件——读内存（store.recent 等），要落盘用 flush/flushAll，别自己 writeFileSync。
8. **语音链路三合同（实测钉死，别凭记忆改）**：TTS=assistant 消息进/base64 WAV 出；克隆 voice=参考音频 DataURL（MIME 按扩展名）；唱歌=文本开头（唱歌）标签（克隆不支持，自动回落预置音色）。URL 与主模型同口径拼接（baseURL 已含 /v1，重复补会 404）。
9. **带表单的独立页（外联/语音）轮询只刷状态卡**：整页重建会吹掉用户选到一半的文件和输入中内容 —— 新页面照此模式（renderXxxStatusCard 独立渲染）。
10. **语音多引擎的三条分层纪律**：①音色回落只在 tts.js 一处做（配置音色不在表内→回落该引擎默认，**返回值=实发值**；显式传参原样交服务端，错误照出不吞）；②引擎能力（克隆/唱歌/转写）不支持时**必须报错/显隐，绝不静默**——（唱歌）标签会被普通引擎当台词念出来；③format 决定"怎么发"、providerId/asr.providerId 决定"发给谁"，两者正交。加新引擎 = 加一个 adapters/xxx.js + 注册表登记，tts.js/asr.js/UI 不动。

## 三、改代码从哪下手（速查）

| 你想… | 去哪 |
|---|---|
| 加一个模型可调用的功能 | `skills/<id>/`（skill.json + index.js registerTool）；脚手架 `npm run new:skill` |
| 加一条"满足条件必执行"的规则 | `plugins/<id>/`（plugin.json + providers/hooks） |
| 加/改原生工具 | `src/tool-registry.js` 注册 + `src/tools.js` 实现 |
| 改提示词/上下文结构 | `src/prompt.js`（注意 tier-slider 判定也在链上） |
| 改发送行为（间隔/限频/格式） | `src/sender.js` |
| 加控制台接口 | `src/routes.js`（加路由）+ `ui/app.js`（加页面调用） |
| 改启动/托盘/数据目录 | `electron/main.js` |
| 改完之后 | `npm test`（25 套全绿再提交） |

## 四、外部组件边界

- **SnowLuma**（snowluma/）：第三方 OneBot v11 协议端，独立 EULA，**不随仓库分发**（`npm run setup` 下载，版本 pin v1.14.19）。`hookAutoLoad: true` 会自动挂钩运行中的 QQ —— **机器人运行时不要同时登录日常 QQ**。
- **便携 QQ**（runtime/qq-portable/）：从本机腾讯 QQ 复制的副本，`--user-data-dir` 隔离；腾讯版权，不再分发。
- **安装包白名单纪律（v0.7.1 起）**：安装包不带 snowluma/、runtime/、test/、doc/、**plugins/、skills/**（后两个 = 维护者的个人插件/技能，出厂为空）；NSIS 安装器会备份并还原收包人自己加的插件/技能（升级与卸载都保护，实踩：测试者插件被升级挤没）。构建：`npm run dist`。
- 原作者服务器（kondius.cn）相关模块已全部移除：市场、社区金句、价格远程拉取、更新检查均不联网。
