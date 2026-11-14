// 语音适配器注册表 —— 与大脑（多服务商 LLM）同款模式的"语音区多引擎"底座。
//
// 设计（2026-11-04 Phase A）：
//   · 每个适配器声明能力矩阵（tts/clone/singing/asr/style）+ 音色表 + 默认模型，
//     UI 按矩阵渲染（不支持的克隆/唱歌自动隐藏）——与工具可用性门控同一套思路
//   · 引擎解析：config.speech.format 显式指定 > 按服务商 baseURL 自动识别 > 兜底 mimo
//     （兜底 mimo = 向后兼容：所有存量配置行为不变）
//   · TTS 与 ASR 可用不同服务商（speech.providerId / speech.asr.providerId）
//
// 已接入：mimo（原样抽取，回归钉死）/ openai（公开稳定契约）/
//         minimax（✅已真机联调：GroupId 可选）
// Phase B 预留：dashscope（文档页不可达，不猜）、volcengine 豆包（凭证结构复杂）、
//               minimax 克隆（files/upload + voice_clone 两步流）

import mimo from './mimo.js';
import openai from './openai.js';
import minimax from './minimax.js';
import gptSovits from './gpt-sovits.js';

export const ADAPTERS = [mimo, openai, minimax, gptSovits];
export const FORMAT_IDS = ['auto', ...ADAPTERS.map((a) => a.id)];

/** 按 id 取适配器；未知 id → null。 */
export function getAdapter(id) {
  return ADAPTERS.find((a) => a.id === id) || null;
}

/**
 * 按 baseURL 猜引擎（format=auto 时用）。猜不出 → mimo（历史默认行为）。
 * 只做保守匹配：域名特征明显才换，避免把中转网关误判。
 */
export function inferAdapterId(baseUrl) {
  const u = String(baseUrl || '').toLowerCase();
  if (!u) return 'mimo';
  if (u.includes('xiaomimimo')) return 'mimo';
  if (u.includes('minimax')) return 'minimax';
  if (u.includes('openai')) return 'openai';
  if (u.includes('sovits') || u.includes(':9880')) return 'gpt-sovits';   // 本地默认端口
  return 'mimo';
}

/**
 * 解析当前应使用的适配器。
 * @param cfg 全量配置
 * @param baseUrl 服务商 baseURL（auto 识别用；可空）
 */
export function resolveAdapter(cfg, baseUrl) {
  const fmt = String(cfg?.speech?.format || 'auto').trim() || 'auto';
  if (fmt !== 'auto') {
    const byId = getAdapter(fmt);
    if (byId) return byId;
    // 手改配置写了无效 id → 兜底 mimo（不炸）
    return mimo;
  }
  return getAdapter(inferAdapterId(baseUrl)) || mimo;
}

/** 能力矩阵的简短文案（状态卡/提示用）。 */
export function capabilitiesText(adapter) {
  const c = adapter.capabilities;
  const y = (b) => (b ? '✓' : '✗');
  return `说话${y(c.tts)} 克隆${y(c.clone)} 唱歌${y(c.singing)} 转写${y(c.asr)}`;
}
