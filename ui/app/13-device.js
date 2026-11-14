// 〔外联页签〕—— USB 连接的安卓设备（设备控制）
// 自包含页面（与 SnowLuma 页同款模式）：自己拉状态、自己保存，
// 不进设置页的守卫/防抖机器 —— 设备设置就几项，显式"保存"比防抖更直观。
// 后端：GET /api/device/status（只读状态）、POST /api/device/config（白名单字段保存）。
'use strict';

/** 解析 serial 输入框：支持逗号/空格/换行分隔，去空去重。 */
function parseSerialList(text) {
  return [...new Set(String(text || '').split(/[\s,;，；]+/).map((s) => s.trim()).filter(Boolean))];
}

function deviceRow(label, valueHtml, subHtml) {
  // .sc-k 有 flex:1，右侧值区不套类名也能对齐（.sc-row 是 flex 行）
  return `<div class="sc-row"><div class="sc-k">${label}${subHtml ? `<small>${subHtml}</small>` : ''}</div><div>${valueHtml}</div></div>`;
}

/** 状态卡独立渲染：轮询/刷新只更新这块（纯展示），绝不重建表单区 ——
 *  否则用户正在填的 serial/黑名单会被清空（语音页真实踩过同款坑）。 */
function renderDeviceStatusCard(status) {
  const usable = Array.isArray(status.devices) ? status.devices : [];
  const others = Array.isArray(status.others) ? status.others : [];
  const lock = status.lock || null;

  let devState;
  if (usable.length) {
    const u = usable[0];
    devState = `<span class="dot dot-on"></span> 已连接 <b>${esc(u.serial)}</b>${u.model ? `（${esc(u.model)}）` : ''}` +
      (usable.length > 1 ? ` <span class="muted">另有 ${usable.length - 1} 台</span>` : '');
  } else if (others.length) {
    const u = others[0];
    devState = `<span class="dot dot-off"></span> ${esc(u.serial)} 状态 ${esc(u.state)}` +
      (u.state === 'unauthorized' ? ' —— <b>在平板上点「允许 USB 调试」授权弹窗</b>' : '');
  } else {
    devState = `<span class="dot dot-off"></span> 未连接（USB 线 + 平板开 USB 调试）`;
  }
  const adbState = status.adbError
    ? `<span style="color:var(--danger, #c0392b)">adb 不可用：${esc(status.adbError)}</span>`
    : `<span class="muted">${esc(status.adbConfigured || 'runtime/platform-tools（自动探测）')}</span>`;
  const eye = String(status.visionModel || '').trim();
  const eyeState = eye
    ? `<span class="muted">${esc(eye)}</span>`
    : `<span class="muted">未配置（device_look 看图工具将不可用；填法见下方说明）</span>`;

  return `
    <div class="scard" id="device-status-card" style="margin-bottom:14px">
      <h4>设备状态</h4>
      ${deviceRow('设备', devState)}
      ${deviceRow('adb', adbState, '找不到时把 platform-tools 的 adb.exe 路径填到下面')}
      ${deviceRow('设备锁', lock ? `<span style="color:var(--danger,#c0392b)">被会话 ${esc(lock.chatKey)} 占用（约 ${lock.minutesLeft} 分钟后空闲）</span>` : '<span class="muted">空闲</span>', '同一时间只允许一个会话控制设备')}
      ${deviceRow('动作 / 截屏预算', `<span class="muted">每次会话 ${status.caps?.maxActionsPerRun ?? 30} 个动作 / ${status.caps?.maxLooksPerRun ?? 12} 次截屏</span>`)}
      ${deviceRow('看图模型（眼睛）', eyeState, '截图用哪家模型看：设置 → 模型 API → 图片输入专用模型，可填「服务商ID/模型名」跨服务商')}
    </div>`;
}

function renderDevicePage(status, cfg) {
  const box = $('#device-page');
  if (!box) return;
  const on = cfg.tools?.deviceControl === true;
  const dev = cfg.device || {};
  const usable = Array.isArray(status.devices) ? status.devices : [];
  const others = Array.isArray(status.others) ? status.others : [];

  // ── 控件默认值 ──
  const serialsText = (Array.isArray(dev.allowedSerials) ? dev.allowedSerials : []).join('\n');
  const blockText = (Array.isArray(dev.blocklistPackages) ? dev.blocklistPackages : []).join('\n');
  const blDisabled = new Set(Array.isArray(status.blocklistDisabled) ? status.blocklistDisabled : []);

  box.innerHTML = `
    <h3>外联 · 安卓设备</h3>
    <div class="hint" style="margin-bottom:12px">
      允许机器人操作 USB 连接的安卓手机/平板：看屏幕、点、滑、开应用（刷B站/抖音这类）。
      需要设备开启「USB 调试」。安全底线由代码强制：支付/社交/系统设置类应用一律拒绝。
    </div>

    ${renderDeviceStatusCard(status)}

    <div class="checkbox-row" style="margin-bottom:10px">
      <input type="checkbox" id="cfg-device-control" ${on ? 'checked' : ''} />
      <label for="cfg-device-control"><b>启用设备控制</b>（关 = 模型连设备工具都看不见，和没装一样）</label>
    </div>

    <div class="field"><label>adb 路径（留空 = 依次找 runtime/platform-tools、Android SDK、PATH）</label>
      <input type="text" id="cfg-device-adbpath" value="${esc(dev.adbPath || '')}" placeholder="例如 D:\\qq-agent-maintained\\runtime\\platform-tools\\adb.exe" /></div>

    <div class="field"><label>设备白名单 serial（每行一个；留空 = 允许任何在线设备。多台设备轮插建议填上防误连）</label>
      <textarea id="cfg-device-serials" rows="2" placeholder="206f8303">${esc(serialsText)}</textarea>
      <div style="margin-top:6px"><button class="btn btn-small" id="device-fill-serial-btn" ${usable.length ? '' : 'disabled'}>把当前连接的设备填进来（${usable.length ? esc(usable[0].serial) : '无设备'}）</button></div></div>

    <div class="field-row">
      <div class="field"><label>单会话动作上限（点/滑/按键/输入合计）</label><input type="number" id="cfg-device-maxactions" min="3" value="${Number(dev.maxActionsPerRun) || 30}" /></div>
      <div class="field"><label>单会话截屏上限</label><input type="number" id="cfg-device-maxlooks" min="2" value="${Number(dev.maxLooksPerRun) || 12}" /></div>
      <div class="field"><label>设备锁占用时长（分钟）</label><input type="number" id="cfg-device-lockmin" min="1" value="${Number(dev.lockMinutes) || 10}" /></div>
    </div>

    <div class="field"><label>应用黑名单（勾选 = 禁止机器人操作这个应用；默认全部勾上）</label>
      <div style="display:flex;flex-direction:column;gap:2px;margin:4px 0 2px">
        ${(status.builtinBlocklist || []).map((b) => {
          const checked = !blDisabled.has(b.pkg);
          // 移除保护的行：红底高亮 + ⚠ 前缀，警示语紧跟在包名后的括弧里
          return `<label class="checkbox-row" style="${checked ? '' : 'background:rgba(217,83,79,.12);border-radius:6px;padding:4px 6px;'}">
            <input type="checkbox" data-bl-pkg="${esc(b.pkg)}" ${checked ? 'checked' : ''} />
            <span style="font-size:12.5px"><code>${esc(b.pkg)}</code>（${esc(b.name)} · ${checked ? '' : '<b style="color:var(--danger,#c0392b)">⚠ 已移出保护！</b>'}${esc(b.warn)}）</span>
          </label>`;
        }).join('')}
      </div>
      <div class="muted" style="font-size:11px;margin:6px 0 4px">去掉勾选 = 移除保护（红底 ⚠ 行），机器人就能操作那个应用了 —— 请只在你清楚后果时这么做。还要拦别的应用往下面加（每行一个包名）：</div>
      <textarea id="cfg-device-blocklist" rows="2" placeholder="com.example.someapp">${esc(blockText)}</textarea></div>

    <div style="display:flex;gap:8px;align-items:center;margin-top:12px;flex-wrap:wrap">
      <button class="btn" id="device-save-btn">保存外联设置</button>
      <button class="btn btn-small" id="device-refresh-btn">刷新状态</button>
      <span id="device-save-hint" class="muted" style="font-size:12px"></span>
    </div>
  `;

  // ── 事件 ──
  box.querySelector('#device-fill-serial-btn')?.addEventListener('click', () => {
    const ta = box.querySelector('#cfg-device-serials');
    if (!ta || !usable.length) return;
    const cur = parseSerialList(ta.value);
    if (!cur.includes(usable[0].serial)) cur.push(usable[0].serial);
    ta.value = cur.join('\n');
  });

  // ── 刷新状态按钮：只更新状态卡，不重建表单（保护正在填的输入）──
  box.querySelector('#device-refresh-btn')?.addEventListener('click', () => loadDevicePageInner({ quiet: true, statusOnly: true }));

  box.querySelector('#device-save-btn')?.addEventListener('click', async () => {
    const hint = box.querySelector('#device-save-hint');
    const btn = box.querySelector('#device-save-btn');
    if (btn) btn.disabled = true;
    if (hint) hint.textContent = '保存中…';
    try {
      const body = {
        deviceControl: box.querySelector('#cfg-device-control').checked,
        device: {
          adbPath: box.querySelector('#cfg-device-adbpath').value.trim(),
          allowedSerials: parseSerialList(box.querySelector('#cfg-device-serials').value),
          maxActionsPerRun: Number(box.querySelector('#cfg-device-maxactions').value) || 30,
          maxLooksPerRun: Number(box.querySelector('#cfg-device-maxlooks').value) || 12,
          lockMinutes: Number(box.querySelector('#cfg-device-lockmin').value) || 10,
          blocklistPackages: parseSerialList(box.querySelector('#cfg-device-blocklist').value),
          // 被用户取消勾选的内置项（= 移除保护）。只收集内置表里有的包名，
          // 后端还会再按内置表过滤一遍 —— 防手滑/防篡改。
          blocklistDisabled: (status.builtinBlocklist || [])
            .filter((b) => !box.querySelector(`input[data-bl-pkg="${b.pkg}"]`)?.checked)
            .map((b) => b.pkg)
        }
      };
      const r = await api('/api/device/config', { method: 'POST', body: JSON.stringify(body) });
      if (hint) hint.textContent = r?.ok ? '已保存，立即生效' : '保存失败';
      await loadDevicePage({ quiet: true });
    } catch (e) {
      if (hint) hint.textContent = `保存失败：${e?.message || e}`;
    } finally {
      const b2 = box.querySelector('#device-save-btn');
      if (b2) b2.disabled = false;
    }
  });
}

async function loadDevicePageInner({ quiet = false, statusOnly = false } = {}) {
  const box = $('#device-page');
  if (!box) return;
  try {
    if (statusOnly) {
      // 轮询/刷新状态：只更新状态卡，绝不重建表单区 —— 正在填的 serial、
      // 黑名单等输入内容不允许被吹掉（语音页真实踩过同款坑）。
      const status = await api('/api/device/status');
      const card = box.querySelector('#device-status-card');
      if (card) card.outerHTML = renderDeviceStatusCard(status);
      return;
    }
    const [status, config] = await Promise.all([
      api('/api/device/status'),
      api('/api/config')
    ]);
    if (config) state.config = config;   // 与设置页共用同一份配置快照
    renderDevicePage(status, config || {});
    if (!quiet && typeof uiEnter === 'function') uiEnter(box);
  } catch (e) {
    if (!quiet) box.innerHTML = `<div class="empty-hint">外联页加载失败：${esc(e?.message || e)}</div>`;
  }
}

function loadDevicePage(opts = {}) {
  ensureDevicePoll();   // 首次进入本页时启动轻量轮询
  return loadDevicePageInner(opts);
}

// 停留在本页时轻量轮询：插拔设备 / 锁占用变化能看到，不用手动点刷新。
// 页面不可见时跳过请求。
let devicePollTimer = null;
function ensureDevicePoll() {
  if (devicePollTimer) return;
  devicePollTimer = setInterval(() => {
    if (state.tab === 'device' && document.visibilityState === 'visible') {
      loadDevicePageInner({ quiet: true, statusOnly: true });
    }
  }, 15000);
}
