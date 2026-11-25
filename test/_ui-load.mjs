// 测试按页面声明的 defer 顺序加载控制台脚本，ESM 桥由各测试注入。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const html = fs.readFileSync(path.join(ROOT, 'ui', 'index.html'), 'utf8');
export const APP_PARTS = Array.from(
  html.matchAll(/<script\b[^>]*\ssrc=["']\/app\/([\w-]+\.js)(?:[?#][^"']*)?["'][^>]*>/gi),
  match => match[1]
);
if (!APP_PARTS.length) throw new Error('未找到控制台脚本');

/** 读单段。 */
export function readAppPart(name) {
  return fs.readFileSync(path.join(ROOT, 'ui', 'app', name), 'utf8');
}

/**
 * 按序拼接为一份完整代码（段与段之间空行分隔）。
 * 返回 { code, files }：files 供诊断输出"实际加载了哪些段"。
 */
export function loadUiAppCode() {
  const files = [];
  const chunks = [];
  for (const name of APP_PARTS) {
    files.push(name);
    chunks.push(readAppPart(name));
  }
  return { code: chunks.join('\n\n'), files };
}
