// 语音通话 · 自动接听看门狗（Phase 3b）。
//
// 原理：轮询 QQ 通话窗口的 UIA 树（native/callui.ps1）判定阶段：
//   ring    —— 有「邀请你语音通话」+ 接听按钮（窗口 Text 第二行 = 来电人昵称）
//   in-call —— 有「退出通话」按钮（含通话计时器）
//   none    —— 无通话窗口
// 规则（评审提示词第 6 节）：
//   · 自动接听默认关；仅白名单来电自动接；**白名单为空 = 谁都不自动接**（fail-closed）
//   · 身份按窗口显示的来电人文本匹配（v1 按昵称；昵称可伪造，个人使用可接受，
//     严谨防伪需接好友表做昵称→QQ 映射，已在文档标注为后续项）
//   · 只处理一通电话；重复 ring 事件不重复接（answer 后以 in-call 树为准）
//   · 按钮消失不作为接通依据 —— 接后复检 in-call 树确认
//   · 通话结束（窗口消失/无退出按钮）→ 会话 stop
//   · 用户手动接听也会自动开会话（窗口 in-call 且会话 idle → start）
//
// 依赖全部可注入（密闭测试不碰真窗口/真进程）：probe/answer/config/session。

import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CALLUI_PS1 = path.join(path.dirname(fileURLToPath(import.meta.url)), 'native', 'callui.ps1');

/**
 * 解析 callui.ps1 -Action detect 的输出 → { phase, caller }。
 * phase: 'none' | 'ring' | 'in-call'
 */
export function parseCallProbe(output) {
  const lines = String(output || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (!lines.length || lines[0] === 'NO-QQ-PROCESS' || lines[0] === 'NO-CALL-WINDOW') return { phase: 'none', caller: null };
  if (!/^CALL-WINDOW /.test(lines[0])) return { phase: 'none', caller: null };
  const buttons = [];
  const texts = [];
  for (const line of lines.slice(1)) {
    const m = /^ControlType\.(\w+)\|(.+)$/.exec(line);
    if (!m) continue;
    if (m[1] === 'Button') buttons.push(m[2]);
    else if (m[1] === 'Text') texts.push(m[2]);
  }
  if (buttons.some((b) => /^(退出通话)$/.test(b)) || texts.some((t) => /^\d{1,2}:\d{2}$/.test(t))) {
    return { phase: 'in-call', caller: null };
  }
  if (buttons.some((b) => /^(接听|接受)$/.test(b))) {
    // 来电人昵称 = Text 列表里第一个不是「邀请你语音通话」的
    const caller = texts.find((t) => t !== '邀请你语音通话') || null;
    return { phase: 'ring', caller };
  }
  return { phase: 'unknown', caller: null };
}

/**
 * 看门狗工厂。deps:
 *   probe()      → string（callui detect 输出）
 *   answer()     → string（callui answer 输出）
 *   getConfig()  → 配置（读 voiceCall.autoAnswer/whitelist，每次 tick 现读）
 *   getSession() → VoiceCallSession（inCall/state/callId/stop）
 *   log(msg)     → 日志
 */
export function createAutoAnswerWatcher(deps = {}) {
  const probe = deps.probe || (() => Promise.resolve('NO-QQ-PROCESS'));
  const answer = deps.answer || (() => Promise.resolve('notfound'));
  const getConfig = deps.getConfig || (() => ({}));
  const getSession = deps.getSession || (() => null);
  const log = deps.log || (() => { });

  let timer = null;
  let busy = false;
  let lastPhase = 'none';
  let ringHandled = false;   // 本轮响铃已点过接听——复检失败也不连点，直到回合结束

  async function tick() {
    if (busy) return;
    busy = true;
    try {
      const cfg = (getConfig().voiceCall || {});
      const session = getSession();
      const out = await probe();
      const { phase, caller } = parseCallProbe(out);

      // 通话结束检测：之前在通话，现在窗口没了 → 停会话
      if (phase === 'none' && session?.inCall) {
        await session.stop('通话结束（窗口消失）');
        log('[自动接听] 通话已结束，会话停止');
      }

      // 会话在通话中 / 窗口 in-call：同步状态即可
      if (phase === 'in-call') {
        ringHandled = false;   // 新的接通 = 新的回合
        if (session && !session.inCall && session.canStart) {
          // 用户手动接听了电话 → 自动开始对话循环
          try { await session.start(); log('[自动接听] 检测到手动接通，会话已开始'); }
          catch (e) { log(`[自动接听] 会话启动失败：${e?.message ?? e}`); }
        }
        return;
      }

      if (phase !== 'ring') {
        if (phase === 'none') ringHandled = false;   // 响铃回合结束（超时/取消）
        lastPhase = phase;
        return;
      }

      // ring：白名单校验（空白名单 = 谁都不自动接，fail-closed）
      if (!cfg.autoAnswer) { lastPhase = 'ring'; return; }
      const wl = Array.isArray(cfg.whitelist) ? cfg.whitelist.map((x) => String(x).trim()).filter(Boolean) : [];
      if (!wl.length) {
        if (lastPhase !== 'ring') log('[自动接听] 已开启但白名单为空 —— 谁都不会被自动接（fail-closed）');
        lastPhase = 'ring';
        return;
      }
      if (!caller || !wl.includes(caller)) {
        if (lastPhase !== 'ring') log(`[自动接听] 来电「${caller || '未知'}」不在白名单，保留手动接听`);
        lastPhase = 'ring';
        return;
      }
      if (session && !session.canStart) { lastPhase = 'ring'; return; }   // 通话中/异常态不重复接
      if (ringHandled) { lastPhase = 'ring'; return; }                     // 本回合已点过，复检失败也不连点

      // 接听 → 复检 in-call → 开会话
      log(`[自动接听] 白名单来电「${caller}」，自动接听…`);
      const r = await answer();
      if (!/^clicked/.test(String(r))) {
        log(`[自动接听] 接听点击未生效：${r}`);
        return;
      }
      ringHandled = true;   // 从点击这一刻起本回合不再点（不管复检结果如何）
      // 复检：按钮消失不能单独当接通（评审纪律）——重新探测确认 in-call
      await new Promise((res) => setTimeout(res, 1200));
      const check = parseCallProbe(await probe());
      if (check.phase !== 'in-call') {
        log('[自动接听] 点击后未见接通态（对方可能已取消），不开会话');
        return;
      }
      if (session) {
        try { await session.start(); log(`[自动接听] 已接通并开始对话（来电：${caller}）`); }
        catch (e) { log(`[自动接听] 接通但会话启动失败：${e?.message ?? e}`); }
      }
    } catch (e) {
      log(`[自动接听] 看门狗异常：${e?.message ?? e}`);
    } finally {
      busy = false;
    }
  }

  return {
    tick,
    start(intervalMs = 2000) {
      if (timer) return;
      timer = setInterval(() => { tick().catch(() => { }); }, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) { clearInterval(timer); timer = null; }
    },
    get running() { return !!timer; }
  };
}

/** 真实 probe/answer 实现（callui.ps1）。 */
export function calluiProbe(action = 'detect', { powershell = 'powershell.exe', psScript = CALLUI_PS1, timeoutMs = 15000 } = {}) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psScript, '-Action', action], { windowsHide: true });
    } catch (e) {
      resolve(`PROBE-ERROR ${e?.message ?? e}`);
      return;
    }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', () => { /* 忽略 PS 噪音 */ });
    child.on('error', (e) => { clearTimeout(timer); resolve(`PROBE-ERROR ${e.message}`); });
    child.on('close', () => { clearTimeout(timer); resolve(out); });
  });
}
