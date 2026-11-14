// 假 adb：给 device-bridge-test 用。
// 用法：test/fake-adb/adb.cmd（Windows 批处理壳）→ 本脚本。
// 环境变量 FAKE_ADB_STATE 指向状态目录：
//   devices.txt   设备行（每行一条，格式同 adb devices -l 的设备行）；空 = 无设备
//   focus.txt     前台应用包名（dumpsys window 的 mCurrentFocus）
//   awake.txt     Awake / Asleep（dumpsys power 的 mWakefulness）
//   monkey_fail.txt  存在且非空 = monkey 启动失败
//   cmdlog.jsonl  每条命令一行 JSON 记录（测试断言用）
const fs = require('node:fs');
const path = require('node:path');

const STATE = process.env.FAKE_ADB_STATE || '.';
const args = process.argv.slice(2);

const appendLog = (obj) => {
  try { fs.appendFileSync(path.join(STATE, 'cmdlog.jsonl'), JSON.stringify(obj) + '\n'); } catch { /* ignore */ }
};
const read = (f, d = '') => {
  try { return fs.readFileSync(path.join(STATE, f), 'utf8').trim(); } catch { return d; }
};

appendLog({ args });

// ── devices ──
if (args[0] === 'devices' || args[0] === '-l') {
  let out = 'List of devices attached\r\n';
  for (const line of read('devices.txt').split(/\r?\n/)) {
    if (line.trim()) out += `\t${line.trim()}\r\n`;
  }
  process.stdout.write(out);
  process.exit(0);
}

// ── exec-out screencap -p：回一张 1x1 PNG ──
const iExecOut = args.indexOf('exec-out');
if (iExecOut >= 0 && args[iExecOut + 1] === 'screencap') {
  const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PzWvWQAAAABJRU5ErkJggg==',
    'base64'
  );
  process.stdout.write(PNG_1X1);
  process.exit(0);
}

// ── shell 子命令 ──
const iShell = args.indexOf('shell');
if (iShell >= 0) {
  const sub = args.slice(iShell + 1);
  const join = sub.join(' ');
  if (join.startsWith('wm size')) {
    process.stdout.write('Physical size: 1080x2340\r\nOverride size: 1080x2340\r\n');
    process.exit(0);
  }
  if (join.startsWith('dumpsys power')) {
    process.stdout.write(`  mWakefulness=${read('awake.txt', 'Awake')}\r\n`);
    process.exit(0);
  }
  if (join.startsWith('dumpsys window')) {
    process.stdout.write(`  mCurrentFocus=Window{1a2b3c u0 ${read('focus.txt', 'com.example.launcher')}/com.example.ui}\r\n`);
    process.exit(0);
  }
  if (join.startsWith('pm list packages')) {
    process.stdout.write('package:tv.danmaku.bili\r\npackage:com.ss.android.ugc.aweme\r\npackage:com.smile.gifmaker\r\n');
    process.exit(0);
  }
  if (join.startsWith('monkey')) {
    const pkg = /-p\s+(\S+)/.exec(join)?.[1] || '';
    if (read('monkey_fail.txt')) {
      process.stderr.write(`[monkey] Cannot find package: ${pkg}\r\n`);
      process.exit(1);
    }
    process.stdout.write('Events injected: 1\r\n');
    process.exit(0);
  }
  if (join.startsWith('input ')) {
    // input tap/swipe/keyevent/text —— 假设备只记录不执行
    process.exit(0);
  }
  process.exit(0);   // 未知 shell 命令静默成功
}

process.exit(0);
