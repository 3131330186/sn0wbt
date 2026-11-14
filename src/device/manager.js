// 设备管理器：把"一台手机/平板"包装成机器人可以安全使用的资源。
//
// ── 职责边界 ─────────────────────────────────────────────────────────────
//   adb.js    只管执行命令和解析输出（无策略）
//   manager.js 管全部策略：
//     · 设备互斥锁 —— 整台电脑只有一台真机，同时只允许一个会话控制
//     · 动作/截屏预算 —— 防止模型"玩上头"无限制烧 token 和耗电
//     · 应用黑名单 —— 前台在支付/社交/系统设置类应用时拒绝一切动作；
//       也不能主动打开它们。代码强制，不靠提示词自觉
//     · 设备白名单 —— config.device.allowedSerials 非空时只认列表里的设备
//
// ── 锁的生命周期 ─────────────────────────────────────────────────────────
// 会话结束时没有可靠的钩子（drain 循环结束即弃置），所以锁用 TTL：
// 拿到锁后 lockMinutes 内有效，任何动作续期；超时自动可被其它会话抢走。
// 简单、够用、不会死锁 —— 代价是 A 会话停手 N 分钟后 B 能接手，这正是想要的。
import { adbRun, adbShell, listDevices, parseWmSize, parseForegroundPkg, parseAwake } from './adb.js';
import { getConfig } from '../config.js';
import { compressImage } from '../image-compress.js';

// 内置黑名单：钱、社交私信、系统设置、通讯录/短信/拨号。
// 理由：机器人被群友撺掇着乱点支付/乱发私信是真实风险；系统设置里能关掉
// USB 调试或恢复出厂，同样必须拦。
// v1.1 起内置项**可被用户手动移除**（config.device.blocklistDisabled）——
// 但每项都带警示语（warn），外联页移除时会显式警告。格式见 ui 13-device.js。
export const BUILTIN_BLOCKLIST = [
  { pkg: 'com.eg.android.AlipayGphone', name: '支付宝', warn: '支付类：移除后机器人可进入支付/付款界面，资金风险自负' },
  { pkg: 'com.tencent.mm', name: '微信', warn: '社交+支付：移除后机器人可代收发私信、操作微信支付' },
  { pkg: 'com.unionpay', name: '云闪付', warn: '支付类：移除后可操作银联支付界面' },
  { pkg: 'com.android.settings', name: '系统设置', warn: '移除后机器人可改系统设置（含关闭 USB 调试、恢复出厂等危险项）' },
  { pkg: 'com.android.vending', name: '应用商店', warn: '移除后机器人可自行安装/更新应用' },
  { pkg: 'com.android.contacts', name: '通讯录', warn: '隐私类：移除后可查看/操作你的联系人' },
  { pkg: 'com.android.dialer', name: '拨号', warn: '移除后机器人可拨打电话（可能产生话费）' },
  { pkg: 'com.android.mms', name: '短信', warn: '隐私+资金类：移除后可读取/发送短信（验证码泄露风险）' },
  { pkg: 'com.android.email', name: '邮件', warn: '隐私类：移除后可读取/发送你的邮件' }
];

const KEY_EVENTS = {
  back: 'KEYCODE_BACK',
  home: 'KEYCODE_HOME',
  wake: 'KEYCODE_WAKEUP',
  enter: 'KEYCODE_ENTER',
  volume_up: 'KEYCODE_VOLUME_UP',
  volume_down: 'KEYCODE_VOLUME_DOWN'
};

class DeviceManager {
  lock = null;                 // { chatKey, sessionId, at } | null
  budgets = new Map();         // chatKey -> { actions, looks }

  cfg() { return getConfig().device || {}; }

  /** 总开关在 tools.deviceControl（与 send_to 同款：可用性层拦，模型看不见工具）。 */
  enabled() { return getConfig().tools?.deviceControl === true; }

  /** 被用户手动移除的内置项（config.device.blocklistDisabled，存包名）。 */
  blocklistDisabled() {
    return new Set(
      (Array.isArray(this.cfg().blocklistDisabled) ? this.cfg().blocklistDisabled : [])
        .map(String).filter(Boolean)
    );
  }

  /**
   * 生效黑名单 = 内置 − 用户手动移除的 + 用户追加的。
   * 用"减法"而不是"完整的加法列表"：以后版本新增内置项时，老用户自动获得保护，
   * 不需要重新保存配置。
   */
  effectiveBlocklist() {
    const disabled = this.blocklistDisabled();
    const extra = (Array.isArray(this.cfg().blocklistPackages) ? this.cfg().blocklistPackages : [])
      .map(String).filter(Boolean);
    return new Set([
      ...BUILTIN_BLOCKLIST.filter((b) => !disabled.has(b.pkg)).map((b) => b.pkg),
      ...extra
    ]);
  }

  isBlocked(pkg) { return this.effectiveBlocklist().has(String(pkg || '')); }

  caps() {
    const c = this.cfg();
    return {
      maxActions: Math.max(3, Number(c.maxActionsPerRun) || 30),
      maxLooks: Math.max(2, Number(c.maxLooksPerRun) || 12),
      lockMinutes: Math.max(1, Number(c.lockMinutes) || 10)
    };
  }

  // ── 设备发现 ───────────────────────────────────────────────────────────
  async pickDevice() {
    const devices = await listDevices();
    const online = devices.filter((d) => d.state === 'device');
    const others = devices.filter((d) => d.state !== 'device');
    const allowed = (Array.isArray(this.cfg().allowedSerials) ? this.cfg().allowedSerials : [])
      .map(String).filter(Boolean);
    const usable = allowed.length ? online.filter((d) => allowed.includes(d.serial)) : online;
    return { usable, others, allowedRestricted: allowed.length > 0 };
  }

  /** 取当前要操作的设备（没有就抛人类可读的错误）。 */
  async requireDevice() {
    const { usable, others, allowedRestricted } = await this.pickDevice();
    if (!usable.length) {
      if (allowedRestricted) throw new Error('在线设备都不在允许名单里（config.device.allowedSerials）');
      if (others.length) {
        const u = others[0];
        throw new Error(`设备 ${u.serial} 已连接但状态是 ${u.state}${u.state === 'unauthorized' ? '（请在手机上点「允许 USB 调试」授权弹窗）' : ''}`);
      }
      throw new Error('没有已连接的安卓设备（USB 插好、开启 USB 调试后重试）');
    }
    return usable[0];
  }

  // ── 互斥锁 + 预算 ──────────────────────────────────────────────────────
  #expireLock() {
    if (!this.lock) return;
    if (Date.now() - this.lock.at > this.caps().lockMinutes * 60 * 1000) this.lock = null;
  }

  /**
   * 为当前会话拿锁（look/动作入口内部自动调用，工具层无需关心）。已在手则续期。
   * @throws 被别的会话占用时抛人类可读错误
   */
  #acquire(chatKey) {
    this.#expireLock();
    if (this.lock && this.lock.chatKey !== chatKey) {
      const mins = Math.max(1, Math.ceil((this.caps().lockMinutes * 60 * 1000 - (Date.now() - this.lock.at)) / 60000));
      throw new Error(`设备正被另一个会话使用（${this.lock.chatKey}），约 ${mins} 分钟后空闲。别硬抢，稍后再试`);
    }
    if (!this.lock) {
      this.lock = { chatKey, at: Date.now() };
      this.budgets.set(chatKey, { actions: 0, looks: 0 });
    } else {
      this.lock.at = Date.now();   // 续期
    }
    if (!this.budgets.has(chatKey)) this.budgets.set(chatKey, { actions: 0, looks: 0 });
  }

  /** 会话显式撒手（device_status 里模型可以主动调用，或 TTL 到期自然释放）。 */
  release(chatKey) {
    if (this.lock?.chatKey === chatKey) this.lock = null;
    this.budgets.delete(chatKey);
  }

  #charge(chatKey, kind) {
    const b = this.budgets.get(chatKey) || { actions: 0, looks: 0 };
    const cap = kind === 'looks' ? this.caps().maxLooks : this.caps().maxActions;
    if (b[kind] >= cap) {
      throw new Error(`本会话的${kind === 'looks' ? '截屏' : '动作'}预算用完了（上限 ${cap} 次）。到此为止吧，把已看到的内容讲给群友，然后结束`);
    }
    b[kind] += 1;
    this.budgets.set(chatKey, b);
  }

  // ── 屏幕观察 ───────────────────────────────────────────────────────────
  /** 屏幕是否亮着。读不出返回 null（旧机型），不当作灭屏。 */
  async isAwake(serial) {
    const r = await adbShell(serial, ['dumpsys', 'power'], { timeoutMs: 10000 });
    return parseAwake(r.stdout.toString('utf8'));
  }

  async #wake(serial) {
    await adbShell(serial, ['input', 'keyevent', 'KEYCODE_WAKEUP'], { timeoutMs: 8000 });
    await new Promise((r) => setTimeout(r, 900));
  }

  async screenSize(serial) {
    const r = await adbShell(serial, ['wm', 'size'], { timeoutMs: 10000 });
    return parseWmSize(r.stdout.toString('utf8'));
  }

  async foregroundPkg(serial) {
    const r = await adbShell(serial, ['dumpsys', 'window'], { timeoutMs: 10000 });
    return parseForegroundPkg(r.stdout.toString('utf8'));
  }

  /**
   * 截屏并压缩成适合模型的 dataUrl。灭屏时先唤醒（截屏前必看屏）。
   * @returns {{ dataUrl: string, pkg: string|null, size: {width,height}|null, woken: boolean }}
   */
  async look(chatKey, serial) {
    this.#acquire(chatKey);
    this.#charge(chatKey, 'looks');
    // 隐私围栏（review 修复）：截屏**前**先查前台 —— 微信/短信等受限应用的
    // 画面连截都不能截，否则整屏内容就进了视觉模型。动作类工具的检查
    // 只拦"操作"，不管"看"，这条补上的正是看的口子。
    const pkgPre = await this.foregroundPkg(serial);
    if (pkgPre && this.isBlocked(pkgPre)) {
      throw new Error(`前台是「${pkgPre}」（受限应用，涉及支付/隐私/系统），已拒绝截屏——该应用的画面不会传给模型。不要尝试绕过`);
    }
    let woken = false;
    const awake = await this.isAwake(serial);
    if (awake === false) { await this.#wake(serial); woken = true; }
    const r = await adbRun(['-s', String(serial), 'exec-out', 'screencap', '-p'], { timeoutMs: 20000 });
    if (r.code !== 0 || !r.stdout.length) {
      throw new Error(`截屏失败：${r.stderr || `退出码 ${r.code}`}${r.timedOut ? '（超时）' : ''}`);
    }
    const size = await this.screenSize(serial);
    const compressed = await compressImage(r.stdout, { maxDim: 1280, maxBytes: 1.5 * 1024 * 1024, quality: 4 });
    return {
      dataUrl: `data:${compressed.mime};base64,${compressed.buffer.toString('base64')}`,
      pkg: pkgPre, size, woken
    };
  }

  // ── 动作（全部先过黑名单 + 预算）───────────────────────────────────────
  async #guardAndCharge(chatKey, serial, actionLabel) {
    this.#acquire(chatKey);
    this.#charge(chatKey, 'actions');
    const pkg = await this.foregroundPkg(serial);
    if (pkg && this.isBlocked(pkg)) {
      throw new Error(`前台是「${pkg}」（受限应用，涉及支付/隐私/系统），已拒绝这次${actionLabel}。不要尝试绕过`);
    }
    return pkg;
  }

  #checkCoords(size, x, y) {
    if (!size) return;   // 读不到屏幕尺寸就不校验（旧机型），动作照发
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error('坐标必须是数字');
    if (x < 0 || y < 0 || x > size.width || y > size.height) {
      throw new Error(`坐标 (${x}, ${y}) 超出屏幕范围 ${size.width}x${size.height}`);
    }
  }

  async tap(chatKey, serial, x, y) {
    this.#checkCoords(await this.screenSize(serial), Number(x), Number(y));
    await this.#guardAndCharge(chatKey, serial, '点击');
    const r = await adbShell(serial, ['input', 'tap', String(Math.round(Number(x))), String(Math.round(Number(y)))]);
    if (r.code !== 0) throw new Error(`点击失败：${r.stderr || r.code}`);
  }

  async swipe(chatKey, serial, x1, y1, x2, y2, durationMs = 300) {
    const size = await this.screenSize(serial);
    this.#checkCoords(size, Number(x1), Number(y1));
    this.#checkCoords(size, Number(x2), Number(y2));
    await this.#guardAndCharge(chatKey, serial, '滑动');
    const dur = Math.max(50, Math.min(3000, Math.round(Number(durationMs) || 300)));
    const r = await adbShell(serial, ['input', 'swipe',
      String(Math.round(Number(x1))), String(Math.round(Number(y1))),
      String(Math.round(Number(x2))), String(Math.round(Number(y2))), String(dur)]);
    if (r.code !== 0) throw new Error(`滑动失败：${r.stderr || r.code}`);
  }

  async key(chatKey, serial, name) {
    const code = KEY_EVENTS[String(name || '').toLowerCase()];
    if (!code) throw new Error(`不支持的按键：${name}（可选：${Object.keys(KEY_EVENTS).join('/')}）`);
    await this.#guardAndCharge(chatKey, serial, '按键');
    const r = await adbShell(serial, ['input', 'keyevent', code]);
    if (r.code !== 0) throw new Error(`按键失败：${r.stderr || r.code}`);
  }

  /**
   * 输入 ASCII 文本（v1 限制：adb input text 对中文/部分符号不可靠，
   * 中文输入要装 ADBKeyboard 输入法，放 v2）。空格转 %s 是 adb 的约定。
   */
  async inputText(chatKey, serial, text) {
    const s = String(text ?? '');
    if (!/^[\x20-\x7E]+$/.test(s)) {
      throw new Error('目前只能输入英文/数字/常用符号（中文输入将在后续版本支持）。请换英文内容');
    }
    if (!s.trim()) throw new Error('输入内容为空');
    await this.#guardAndCharge(chatKey, serial, '文字输入');
    const escaped = s.replace(/ /g, '%s').replace(/[$&;*|<>()`\\!"']/g, '');
    const r = await adbShell(serial, ['input', 'text', escaped]);
    if (r.code !== 0) throw new Error(`输入失败：${r.stderr || r.code}`);
  }

  /** 打开应用（monkey 拉起 LAUNCHER，不需要知道 activity 名）。 */
  async launchApp(chatKey, serial, packageName) {
    const pkg = String(packageName || '').trim();
    if (!/^[a-zA-Z][a-zA-Z0-9_.]+$/.test(pkg)) throw new Error(`包名格式不对：${pkg}（形如 tv.danmaku.bili）`);
    if (this.isBlocked(pkg)) {
      throw new Error(`「${pkg}」在受限名单里（支付/隐私/系统类），不允许打开。不要尝试绕过`);
    }
    await this.#guardAndCharge(chatKey, serial, '打开应用');
    const r = await adbShell(serial, ['monkey', '-p', pkg, '-c', 'android.intent.category.LAUNCHER', '1'], { timeoutMs: 15000 });
    if (r.code !== 0 || /Error/i.test(r.stdout.toString('utf8'))) {
      throw new Error(`打开应用失败（包名可能不存在）：${(r.stderr || r.stdout.toString('utf8')).slice(0, 200)}`);
    }
  }

  /** 列出第三方应用包名（device_status 的 listApps 参数用）。 */
  async listApps(serial) {
    const r = await adbShell(serial, ['pm', 'list', 'packages', '-3'], { timeoutMs: 20000 });
    return r.stdout.toString('utf8').split(/\r?\n/)
      .map((l) => /^package:(\S+)$/.exec(l.trim())?.[1])
      .filter(Boolean)
      .sort();
  }

  /** 汇总状态（device_status 工具用）。 */
  async status() {
    const base = {
      enabled: this.enabled(),
      lock: this.lock ? { chatKey: this.lock.chatKey, minutesLeft: Math.max(0, Math.ceil((this.caps().lockMinutes * 60 * 1000 - (Date.now() - this.lock.at)) / 60000)) } : null
    };
    if (!this.enabled()) return base;
    try {
      const { usable, others, allowedRestricted } = await this.pickDevice();
      return { ...base, devices: usable, others, allowedRestricted, adbFound: true };
    } catch (e) {
      return { ...base, devices: [], adbError: e?.message ?? String(e) };
    }
  }
}

export const deviceManager = new DeviceManager();
