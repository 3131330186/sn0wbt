// 雪花图标生成器（零依赖）：SDF 线段反走样 → PNG（node:zlib）→ 多尺寸 ICO
//
// 用法：node scripts/make-icon.mjs
// 产出：assets/icon.png（256px，托盘/窗口用）+ assets/icon.ico（16-256 七档，安装包用）
//
// 设计：六重对称雪花——6 根主辐条，每根两对向前张开 60° 的侧枝，中心六角环。
// 冰蓝径向渐变（内白外冰蓝），透明底，深浅任务栏都清晰。
import { deflateSync } from 'node:zlib';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ASSETS = path.resolve(__dirname, '..', 'assets');

// ── 几何：线段集（单位坐标，R=1 后按画布缩放）────────────────────────────
function buildSegments() {
  const segs = [];
  const R = 1.0;
  const addSeg = (x1, y1, x2, y2) => segs.push([x1, y1, x2, y2]);
  for (let i = 0; i < 6; i++) {
    const a = -Math.PI / 2 + (i * Math.PI) / 3;       // 尖头朝上起步
    const dx = Math.cos(a), dy = Math.sin(a);
    const px = -dy, py = dx;                          // 垂直方向
    // 主辐条（中心留空给六角环）
    addSeg(0.16 * dx, 0.16 * dy, R * dx, R * dy);
    // 两对侧枝：位于辐条 45% / 72% 处，向前张开 ±60°
    for (const [t, len] of [[0.44, 0.30], [0.70, 0.20]]) {
      const bx = t * dx, by = t * dy;
      for (const s of [1, -1]) {
        const ta = a + s * (Math.PI / 3);
        addSeg(bx, by, bx + len * Math.cos(ta), by + len * Math.sin(ta));
      }
    }
    // 辐条尖端小帽：垂直短横
    const tipx = R * dx, tipy = R * dy;
    addSeg(tipx - 0.10 * px, tipy - 0.10 * py, tipx + 0.10 * px, tipy + 0.10 * py);
  }
  return segs;
}

// 点到线段距离
function distToSeg(px, py, [x1, y1, x2, y2]) {
  const vx = x2 - x1, vy = y2 - y1;
  const wx = px - x1, wy = py - y1;
  const L2 = vx * vx + vy * vy;
  const t = L2 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / L2)) : 0;
  const dx = px - (x1 + t * vx), dy = py - (y1 + t * vy);
  return Math.hypot(dx, dy);
}

const SEGS = buildSegments();

/** 渲染一帧 RGBA。size：画布边长。 */
function renderFrame(size) {
  const R = size * 0.42;                    // 雪花外接半径
  const cx = size / 2, cy = size / 2 + size * 0.005;
  const w = Math.max(1.1, R * 0.058);       // 线半宽（像素）
  const aa = Math.max(1.0, size / 256 * 1.25);
  const ringR = R * 0.13, ringW = Math.max(1.0, R * 0.045);
  const rgba = Buffer.alloc(size * size * 4);

  // 冰蓝径向渐变：内白 → 外冰蓝
  const lerp = (a, b, t) => a + (b - a) * t;
  const inner = [242, 251, 255], mid = [168, 216, 255], outer = [94, 178, 255];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5 - cx) / R, v = (y + 0.5 - cy) / R;
      const r = Math.hypot(u, v);
      if (r > 1.35) continue;
      // 线段是单位坐标：先在单位空间求距离，再乘 R 换算成像素
      let d = Infinity;
      for (const s of SEGS) d = Math.min(d, distToSeg(u, v, s));
      const dRing = Math.abs(r - 0.13);                          // 六角环（圆环近似，单位半径）
      d = Math.min(d, dRing) * R;

      const cov = Math.max(0, Math.min(1, (w - d) / aa + 0.5));
      if (cov <= 0) continue;
      const t = Math.max(0, Math.min(1, r / 1.05));
      const c = t < 0.5
        ? inner.map((v0, i) => lerp(v0, mid[i], t / 0.5))
        : mid.map((v0, i) => lerp(v0, outer[i], (t - 0.5) / 0.5));
      const o = (y * size + x) * 4;
      rgba[o] = Math.round(c[0]); rgba[o + 1] = Math.round(c[1]); rgba[o + 2] = Math.round(c[2]);
      rgba[o + 3] = Math.round(cov * 255);
    }
  }
  return rgba;
}

// ── 最小 PNG 编码（真彩 + alpha，无过滤）────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c;
  }
  return t;
})();
const crc32 = (buf) => {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
};
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};
function encodePNG(rgba, size) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0;   // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

// ── ICO 打包（PNG 内嵌条目，Vista+ 标准）─────────────────────────────────
function buildIco(pngBySize) {
  const sizes = [...pngBySize.keys()];
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(sizes.length, 4);
  const entries = [];
  let offset = 6 + sizes.length * 16;
  for (const s of sizes) {
    const png = pngBySize.get(s);
    const e = Buffer.alloc(16);
    e[0] = s >= 256 ? 0 : s; e[1] = s >= 256 ? 0 : s;
    e[2] = 0; e[3] = 0;
    e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
    e.writeUInt32LE(png.length, 8); e.writeUInt32LE(offset, 12);
    entries.push(e);
    offset += png.length;
  }
  return Buffer.concat([header, ...entries, ...sizes.map((s) => pngBySize.get(s))]);
}

// ── 产出 ────────────────────────────────────────────────────────────────
const PNG_SIZES = [16, 24, 32, 48, 64, 128, 256];
const bySize = new Map(PNG_SIZES.map((s) => [s, encodePNG(renderFrame(s), s)]));
fs.mkdirSync(ASSETS, { recursive: true });
fs.writeFileSync(path.join(ASSETS, 'icon.png'), bySize.get(256));
fs.writeFileSync(path.join(ASSETS, 'icon.ico'), buildIco(bySize));
for (const s of PNG_SIZES) {
  const p = path.join(ASSETS, `icon-${s}.png`);
  fs.writeFileSync(p, bySize.get(s));   // 小尺寸 png 备用（总是覆盖，防旧档残留）
}
console.log(`icon.png(256) + icon.ico(${PNG_SIZES.join('/')}) 已生成`);
