/**
 * SessionRegistry 按天清理（keepSessionDays）的单元测试。
 *
 * 为什么需要：keepSessionFiles=0（不限个数）时 data/sessions/ 只涨不跌，
 * 实测几天就 1600+ 文件 150+MB。keepSessionDays 按 mtime 滚动清理老会话，
 * 而成本看板最长看 30 天 —— 默认 35 天保证看板数据不被误删。
 *
 * 断言核心：
 *   1. 老于 keepDays 的文件被删，新文件保留
 *   2. 运行中/等待中的会话文件永不删除（UI 还指着它）
 *   3. setKeepDays(0) = 关闭清理，一个不删
 *   4. 索引同步粗筛：被删文件的条目从列表里消失
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 必须在 import src/ 之前设置：DATA_DIR 是 config.js 的 import 时常量
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-sessions-test-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const { SessionRegistry } = await import('../src/sessions.js');
const SESSIONS_DIR = path.join(dataDir, 'sessions');

let bad = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  [ok] ${label}`); }
  catch (e) { bad++; console.log(`  [FAIL] ${label} -- ${e.message}`); }
};

const DAY = 86400 * 1000;
const writeSession = (id, startedAt, status = 'finished') => {
  const body = {
    id, chatKey: 'group:1', startedAt, endedAt: startedAt + 5000, status, outcome: 'ok',
    usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, cachedTokens: 0, calls: 0 },
    messages: []
  };
  fs.writeFileSync(path.join(SESSIONS_DIR, `${id}.json`), JSON.stringify(body), 'utf8');
};
const exists = (id) => fs.existsSync(path.join(SESSIONS_DIR, `${id}.json`));
const ageFile = (id, days) => {
  const p = path.join(SESSIONS_DIR, `${id}.json`);
  const old = new Date(Date.now() - days * DAY);
  fs.utimesSync(p, old, old);
};

fs.mkdirSync(SESSIONS_DIR, { recursive: true });

console.log('\n== sessions 按天清理 ==');

check('构造时按 keepDays 清理：老文件删除、新文件保留、索引同步', () => {
  writeSession('old1', Date.now() - 40 * DAY);
  writeSession('mid1', Date.now() - 10 * DAY);
  writeSession('new1', Date.now() - 1 * DAY);
  ageFile('old1', 40);
  ageFile('mid1', 10);
  ageFile('new1', 1);

  const reg = new SessionRegistry(0, 35);
  assert.equal(exists('old1'), false, '40 天前的文件应被删');
  assert.equal(exists('mid1'), true, '10 天前的文件应保留');
  assert.equal(exists('new1'), true, '1 天前的文件应保留');
  const ids = reg.index.map((e) => e.id);
  assert.ok(!ids.includes('old1'), '被删文件的索引条目应消失');
  assert.ok(ids.includes('mid1') && ids.includes('new1'), '保留文件的索引条目应在');
});

check('运行中/等待中的会话文件永不删除', () => {
  // mtime 是 40 天前，但状态是 waiting → 不删
  writeSession('wait1', Date.now() - 40 * DAY, 'waiting');
  ageFile('wait1', 40);
  // 先以 0（不清理）构造、登记运行中，再触发 setKeepDays —— 保证清理跑的时候 wait1 已在册
  const reg = new SessionRegistry(0, 0);
  reg.current.set('wait1', { id: 'wait1', status: 'waiting' });
  reg.setKeepDays(35);
  assert.equal(exists('wait1'), true, '运行中的文件不能删（UI 详情会 404）');
  reg.current.delete('wait1');
});

check('keepSessionDays=0 关闭清理（一个不删）', () => {
  writeSession('keepme', Date.now() - 400 * DAY);
  ageFile('keepme', 400);
  const reg = new SessionRegistry(0, 0);
  assert.equal(exists('keepme'), true, '0 = 不限，不应删除');
});

check('运行时 setKeepDays 从 0 改成 35 立即生效', () => {
  const reg = new SessionRegistry(0, 0);
  writeSession('later1', Date.now() - 40 * DAY);
  ageFile('later1', 40);
  assert.equal(exists('later1'), true, '构造时 0 = 不删');
  reg.setKeepDays(35);
  assert.equal(exists('later1'), false, '改配置后应立即清理');
});

console.log(bad ? `\n${bad} 项失败\n` : '\n全部通过\n');
process.exit(bad ? 1 : 0);
