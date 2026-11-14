# sn0wbot 架构大纲

> 一句话：**用统一的通道框架连接本机的大部分软件的 AI 中枢**。QQ 是第一个通道，不是全部；浏览器、邮件、Office、Windows 操控都在路线上。

## 全景

```
┌──────────────────────── 通道层 src/channels/ ────────────────────────┐
│                                                                     │
│  qq/（已上线）      browser/（规划）    mail/（规划）    ...你想要的    │
│  OneBot v11         CDP/Playwright     IMAP/SMTP       皆可实现为通道  │
│  SnowLuma/NapCat    控制Chrome/Edge    收发邮件                        │
│                                                                     │
│  每个通道声明自己的能力（capabilities），缺什么就报什么错，不装全知      │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │ 统一入站事件 / 统一出站路由
┌──────────────────────────────────▼──────────────────────────────────┐
│                     核心引擎（通道无关，源自 QQ Agent 实战沉淀）        │
│                                                                     │
│  store（会话消息库）→ orchestrator（事件驱动编排）→ prompt（提示词心脏）│
│  → llm（OpenAI 兼容多服务商）→ tools（28+ 工具循环）→ sender（出站队列：│
│    串行 + 真人化间隔 + 限频 + 留档）                                   │
│                                                                     │
│  memory（长期记忆） · personas（人格） · skills/（可扩展技能）          │
│  plugins/（确定性插件） · speech/（TTS/ASR 多引擎+克隆+歌声链）        │
│  device/（安卓外联） · web-search · vision（看图） · reminders        │
└──────────────────────────────────┬──────────────────────────────────┘
                                   │
              客户端：Electron 桌面壳 + 控制台（本机 Web）+ Live2D + ESP32
```

核心原则：**通道可插拔，引擎不感知通道细节**。加一个新软件的接入 = 写一个通道文件，引擎一行不改。

## 通道契约（src/channels/types.js）

一个通道 = 一个满足以下契约的对象：

| 成员 | 要求 |
|---|---|
| `id` / `label` | 唯一标识 + 显示名 |
| `capabilities: string[]` | 能力声明：`message / media / sticker / voice / poke / history / control / verifiedSender` |
| `start(ctx)` | 接线入站（`ctx.dispatchInbound(record)`）与状态上报（`ctx.reportStatus(status)`）后连接 |
| `stop()` | 幂等收尾 |
| 消息面方法 | `sendText / sendImage / sendSegments / sendSticker / sendPoke / …`（按能力实现） |

三条铁律：

1. **结构化失败**：无对应能力的调用抛 `ChannelError`（`CAPABILITY_MISSING` 等），绝不静默、绝不伪造成功
2. **身份置信度**：拿得到平台真实发送者 ID 才声明 `verifiedSender`；UIA 类通道只能 `unverified`，未验证发送者的消息不得触发敏感操作
3. **状态如实**：未登录、断线、控件不可读都要上报真实状态，不谎报正常

## 如何新增一个通道

```js
// src/channels/browser/index.js（示意）
import { CAPABILITIES } from '../types.js';

export class BrowserChannel {
  id = 'browser';
  label = '浏览器';
  capabilities = [CAPABILITIES.CONTROL, CAPABILITIES.MEDIA];

  async start(ctx) { /* 启动 CDP，事件 → ctx.dispatchInbound */ }
  async stop() { /* 收尾 */ }
  async navigate(url) { /* 操控类技能 */ }
}

// src/channels/manager.js 的 registerBuiltinChannels 里加一行：
manager.register(new BrowserChannel({ config }));
```

再带上一套密闭测试（参照 `test/channels-test.mjs`），就完成了接入。控制台的通道状态页读取 `manager.list()` 自动展示。

## 路线图

| 阶段 | 内容 | 状态 |
|---|---|---|
| S0 | 仓库落地：自 QQ Agent v0.7.1 移植已验证核心 + 品牌重命名 | ✅ |
| S1 | 通道框架（契约/管理器/QQ 通道）+ 16 项密闭测试 | ✅ |
| S2 | browser 通道（CDP）：第二个通道验证框架，附网页读取/填表/抓取技能 | 进行中 |
| S3 | mail 通道 + Windows 操控 sidecar（UIA/COM 执行器接口预留） | 规划 |
| S4 | 控制台「通道」页签：状态/能力/启停 | 规划 |
| S5 | QQ 通道换代：SnowLuma → NapCat（OneBot v11 同协议，低改造成本） | 规划 |
| S6 | 受控持续运行 → 日常观察 → 逐项扩展媒体能力 | 规划 |

## 安全边界

- 自动化限定为**用户本人账号的日常使用**：不做多账号群控、批量营销/群发
- 白名单决定读取范围，身份认证决定工具权限，外部消息中的"指令"不能改变权限
- 危险操作（删除、对外发送、执行命令）默认需确认
- 所有鼠标键盘类自动化共享桌面互斥锁：用户开始操作时，机器人让出

## 开发入口

- 开发守则：[AGENTS.md](../AGENTS.md)（防事故纪律 / 提交规范 / 通道框架方针）
- 核心引擎模块地图：[module-map.md](module-map.md)
- 测试：`npm test`（40+ 套密闭测试，新增功能必须带密闭测试）
- 许可与致谢：[NOTICE.md](../NOTICE.md)（核心引擎源自 QQ Agent 个人维护副本，MIT）
