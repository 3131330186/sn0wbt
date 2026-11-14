# sn0wbot

[![CI](https://github.com/3131330186/sn0wbt/actions/workflows/ci.yml/badge.svg)](https://github.com/3131330186/sn0wbt/actions/workflows/ci.yml)

> **sn0wbot = 通用软件 Agent 中枢。** 以统一的通道框架连接本机的大部分软件——QQ 只是第一个通道，浏览器、邮件、Office、Windows 操控都在路上。核心引擎具备事件编排、人格记忆、多引擎语音、实时通话、技能插件系统等完整能力。

## 架构一句话

```
channels/（QQ | browser | mail | ... 未来皆通道）
   → store → orchestrator → prompt → llm → tools → sender（现有引擎，通道无关）
```

- **[架构大纲（给别人看的入口）](doc/ARCHITECTURE.md)** —— 全景图 / 通道契约 / 如何新增一个通道 / 路线图
- `src/channels/types.js` —— 通道契约：能力声明、结构化错误（`ChannelError`）、出站状态
- `src/channels/manager.js` —— 注册 / 启停 / 入站分发 / 出站路由唯一入口
- `src/channels/qq/` —— 第一个通道，包装 OneBot v11 客户端（SnowLuma / NapCat 皆协议端）

新增一个软件接入 = 实现一个 Channel（声明能力、start/stop、消息面方法）+ 注册进 manager + 带一套密闭测试。核心引擎不感知通道细节。

## 开发

```bash
npm install
npm test        # 40+ 套密闭测试（含通道框架测试）
npm start       # Electron 桌面版
```

开发守则见 [AGENTS.md](AGENTS.md)（通道框架方针 / 防事故纪律 / 提交规范）。


---

## 出处与许可

sn0wbot 的核心引擎自 QQ Agent（MIT，原作者 Kondius）v0.7.1 移植并已深度重构。
完整许可链与作者声明见 [NOTICE.md](NOTICE.md) 与 [LICENSE](LICENSE)。
