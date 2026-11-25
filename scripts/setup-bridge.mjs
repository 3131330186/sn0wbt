// 桥接环境安装器：vendor/ 里的打补丁桥接 → bridges/ 运行目录 + Python venv
//
// 用法：npm run setup:bridge
//   1. bridges/ 缺失或脚本不全 → 从 vendor/ 完整复制（vendor 已含全部修复：
//      桌面互斥锁 / 主窗口判别 / 断线即停；重装不会丢补丁）
//   2. .venv 缺失 → python -m venv + pip install -r requirements.txt
//   3. bridge-config.json 缺失 → 从 example 复制（账号信息用户自己填/走控制台接入）
// 网络仅在 pip 阶段需要（venv 建好即离线）；git clone 已不需要 —— vendor 入库。
import { installBridgeFiles } from './lib/bridge-files.mjs';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const VENDOR = path.join(ROOT, 'vendor', 'qq-onebotv11-uia-bridge');
const TARGET = path.join(ROOT, 'bridges', 'qq-onebotv11-uia-bridge');

const say = (msg) => console.log(`[setup:bridge] ${msg}`);

function run(cmd, args, { cwd = ROOT } = {}) {
  const r = spawnSync(cmd, args, { cwd, stdio: 'inherit', shell: false });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} 退出码 ${r.status}`);
}

installBridgeFiles(VENDOR, TARGET);
say('桥接脚本已就位（含全部修复补丁）');

// 2) venv + 依赖
const venvPython = path.join(TARGET, '.venv', 'Scripts', 'python.exe');
if (!fs.existsSync(venvPython)) {
  say('创建 Python venv…');
  run('python', ['-m', 'venv', '.venv'], { cwd: TARGET });
} else {
  say('.venv 已存在，跳过创建');
}
say('安装依赖（uiautomation / pyperclip / websockets）…');
run(venvPython, ['-m', 'pip', 'install', '-q', '-r', 'requirements.txt'], { cwd: TARGET });

say('完成 ✅  现在可在驾驶舱「添加链接」接入 QQ');
