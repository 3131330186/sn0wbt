# QQ Agent（个人维护版）· 维护方针

本文件是给 AI 助手（ZCode 等）看的项目守则。**每次在这个项目里干活之前先读完。**

## 仓库方针（最高优先级）

- **只改本仓库**：`origin = https://github.com/3131330186/qqagent.git`（私有）。所有功能、修复、版本升级都在这里做。
- **不回馈上游**：不向 `Nakie-zjm/qq-agent-maintained` 提 PR / issue / 任何形式的贡献。这是用户明确决定的原则——做自己的版本，不做上游的搬运工。
- 上游仓库**只读参考**：可以 fetch 上游看作者做了什么、抄思路；要不要同步由用户逐次决定，AI 不得擅自 merge/rebase 上游。

## 提交与发布纪律

- 提交信息用中文，格式 `type(scope): 摘要`（feat/fix/perf/docs/chore）。
- 提交前 `npm test` 必须全绿；push 后用 `check_ci.ps1` 的思路确认 GitHub Actions 绿（token 走 git credential fill，**永不打印**）。
- 版本号只在用户发话时升；当前 **v0.7.0**（tag `v0.7.0`，= v0.6.1 + 实时语音通话 v1：QQ 私聊经虚拟声卡桥接，VAD 断句 → ASR → 人设 LLM → TTS → 通话播放，UIA 自动接听 + 白名单，打断 barge-in，通话回复消毒）。
- 回档锚点：tag `pre-device-control` = 设备功能加入前稳定态；`v0.6.1` = 评审修复定版；`v0.7.0` = 语音通话版。

## 运行纪律（防事故）

- 机器人运行时**绝不同时登录日常 QQ**：SnowLuma `hookAutoLoad: true` 会挂钩任何在跑的 QQ，双开 = 群里重复回复。跑 bot 前先完全退出日常 QQ。
- `data/` 目录（密钥/记忆/存档）**永不进 git**（已 gitignore，动配置前确认没把它带进去）。
- 用户要打游戏时避免重负载操作；改代码注意 `store.js` 落盘是防抖合并的（500ms），别在业务代码里绕过 store 直读写存档文件。
- **带表单的独立控制台页**（外联/语音模式）：轮询和"刷新状态"只允许替换状态卡节点（`renderXxxStatusCard`），**绝不整页 innerHTML 重建** —— 重建会把用户选到一半的文件、输入中的内容全部吹掉（v0.6.0 前真实踩过两次）。
- 浏览器对 `.m4a/.aac` 的 DataURL 常标 `application/octet-stream` —— 音频上传的格式判定一律用**魔数嗅探**（`sniffAudioExt`），不信任前端 MIME。
- ⚠️ **本机 node（v24.20.0，C:\Program Files\nodejs）解析器损坏**：`.mjs` 文件里的**解构 `as` 重命名**（`const { x as y } = ...`，含动态 import 解构）报 `Unexpected identifier 'as'`；静态 `import { x as y }` 和 **CJS** 不受影响。规避：`.mjs`/测试里用整对象接收 + 属性访问，别写解构 `as`；`node --input-type=module -e` 同样别用。

## 项目速查

- 架构导览：`doc/module-map.md`（改代码前先看）
- 设备控制：`src/device/`（安全策略全在 manager.js，改前想清楚）+ 控制台「外联」页（`ui/app/13-device.js`）
- 语音（TTS 说 / ASR 听）：**多引擎适配器架构**（`src/speech/adapters/`：mimo/openai/minimax/**gpt-sovits**（azure 已按用户决定移除），与大脑多服务商同款模式）+ `src/speech/tts.js`（引擎无关决策）+ `src/speech/asr.js`（转写分发 + record 入口）+ 控制台「语音」页（能力矩阵驱动 UI 显隐）。
  GPT-SoVITS = **cloneOnly 本地克隆**（契约来自官方 api_v2.py 源码，✅已真机联调）：ref_audio_path 传同机绝对路径、prompt_text 用缓存（首行=源文件字节数，防同名重传脏缓存）/自动 ASR 转写、无鉴权不发 Authorization；主服务商无转写能力（如整个就是 gpt-sovits）时自动**借用**第一个有 ASR 的服务商转写（否则 prompt 静默为空、相似度悄悄变差——实踩）；采样参数固化 temperature 0.6 / top_k 15 / top_p 0.8（真机调优，默认值有电流音碎屑）。
  **api_v2 硬约束参考音频 3~10 秒**（实踩）：适配器本地把关——过短可读报错不发请求、超长纯 JS 裁到 9.5 秒副本（`<ref>.sovits-trim.wav`，prompt 缓存键跟着副本走）；400 响应 `message` 是幌子（"tts failed"），`Exception` 字段才是真实原因，两个都要透出。
  引擎选择 = `speech.format`（auto 按 baseURL 猜，**兜底 mimo 向后兼容**）；TTS/ASR 可指不同服务商（`speech.asr.providerId`）；能力矩阵（克隆/唱歌/转写）不支持的**必须报错不许静默**。
  MiMo 网关格式实测钉死（TTS=assistant 消息出 WAV；克隆 voice=参考音频 DataURL；唱歌=（唱歌）标签，仅预置音色），URL 拼接与主模型同口径（baseURL 已含 /v1，**不得重复补**）；MiniMax ✅已真机联调（GroupId 可选——2026-11 实测新版接口只用 Key 也能鉴权，填错反而 1004 token not match group）；音色回落只在 tts.js 一处（配置路径回落，显式传参交服务端裁决，返回值=实发值）。
  ⚠️ `node --check` 抓不到**漏 import 的运行时 ReferenceError**（实踩：routes 漏 FORMAT_IDS）——改 routes 的 import 后必须跑 speech-adapters-test（含静态 import 守卫）。
- 实时语音通话（QQ 私聊）：`src/voice-call/`（session 状态机/vad 断句/bridge 音频桥）+ `src/speech/asr.js` + `src/voice-call/native/waveout.cs`（零依赖 C# 播放+回环捕获）+ 控制台「语音」页通话卡。
  **拓扑是实测钉死的**：bot 说→CABLE Input→QQ麦克风(=CABLE Output)；bot 听←QQ扬声器(=闲置 Realtek)→WASAPI 回环。设备一律**按名字匹配**（waveOut 序号会漂移，名称有 32 字符截断）。
  **WASAPI 回环空闲时一个包都不吐**（≠故障）；loopback 模式禁用 noData 看门狗。VAD 碎屑判定按**实际有声时长**非总时长。中止纪律同 v0.6.1：callId/turnId 过期结果一律丢弃。
- 本地歌声链（唱歌 · 唱说音色一致）：`src/speech/singing.js` ——（唱歌）标签 → ACE-Step(8001) 出歌 → demucs 分离 → Applio RVC 转写成克隆说话音色 → ffmpeg 混音。**与 TTS 引擎解耦**（tts.js 在 ep 解析之前路由，没配服务商也能唱）；开关 `speech.singing.enabled`（**分发默认关**——收包人没装 ACE-Step/Applio，开了只会撞"服务没开"）。依赖 run/fetch/sleep 注入可密闭测试（`test/voice-singing-test.mjs`）。契约实踩钉死：query_result 的 status **0=跑/1=成/2=败**（反直觉）、Applio `export-format` 必须大写 `WAV`、release_task JSON 模式禁绝对路径（参考音频只能 multipart）。RVC 验收参数（rmvpe / pitch 0 / index-rate 0.75 / protect 0.33）和混音 volume=1.15 是用户听感验收过的原样，别凭感觉改。服务用 `scripts/start-voice-services.bat` 一键起（GPT-SoVITS 9880 + ACE-Step 8001）。
- 看图模型：`api.visionModel` 支持「服务商ID/模型名」跨服务商写法（deepseek 主脑 + MiMo VL 眼睛）
- 测试：30+ 套，新增功能必须带密闭测试（假 adb 模式参考 `test/device-bridge-test.mjs`，假 TTS/ASR 服务器参考 `test/speech-test.mjs`）
