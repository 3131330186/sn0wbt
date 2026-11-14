/**
 * ChatStore 落盘批量化 + LRU 的单元测试。
 *
 * 为什么要这套测试：store.js 从"每条消息全量写盘"改成"脏标记 + 500ms 防抖合并 +
 * LRU 淘汰冷会话"。这是「行为变了但没报错」的典型改造 —— 如果防抖写丢了数据、
 * 淘汰时忘了把脏数据冲盘，表现为"消息存档悄悄少了几条/机器人失忆"，
 * 不会崩溃也不会报错，只有测试能拦住。
 *
 * 断言核心不变式：
 *   1. 内存态永远是最新的（模型/UI 读内存，内容零变化）
 *   2. flushAll() 之后磁盘 = 内存（stop()/退出兜底的正确性）
 *   3. LRU 淘汰会话时，脏数据先落盘 —— 淘汰 = 安全的
 *   4. 防抖到期后（哪怕 timer 被 unref）数据最终写盘
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// ⚠️ 必须在 import src/ 之前设置：DATA_DIR 是 config.js 的 import 时常量
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-store-test-'));
process.env.QQ_AGENT_DATA_DIR = dataDir;

const { ChatStore } = await import('../src/store.js');
const { sleep } = await import('../src/util.js');

const msgFile = (key) => {
  const safe = String(key).replace(/[^a-z0-9_]/gi, '_');
  return path.join(dataDir, 'messages', `${safe}.json`);
};
const readRaw = (key) => { try { return fs.readFileSync(msgFile(key), 'utf8'); } catch { return null; } };
const readCount = (key) => {
  const raw = readRaw(key);
  if (!raw) return -1;
  try { return JSON.parse(raw).messages.length; } catch { return -1; }
};

let bad = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  [ok] ${label}`); }
  catch (e) { bad++; console.log(`  [FAIL] ${label} -- ${e.message}`); }
};
const checkAsync = async (label, fn) => {
  try { await fn(); console.log(`  [ok] ${label}`); }
  catch (e) { bad++; console.log(`  [FAIL] ${label} -- ${e.message}`); }
};

console.log('\n== store 落盘批量化 ==');

check('内存态即时可见（防抖不影响模型/UI 读到的内容）', () => {
  const store = new ChatStore();
  for (let i = 1; i <= 5; i++) store.appendIncoming('group:111', { text: `msg${i}`, ts: 1000 + i });
  const recent = store.recent('group:111', { limit: 10 });
  assert.equal(recent.length, 5);
  assert.equal(recent[4].text, 'msg5');
});

check('未到防抖期：磁盘还没写（这正是省 I/O 的点）', () => {
  const store = new ChatStore();
  for (let i = 1; i <= 5; i++) store.appendIncoming('group:222', { text: `m${i}`, ts: 1000 + i });
  // 内存里有 5 条
  assert.equal(store.recent('group:222', { limit: 10 }).length, 5);
  // 磁盘上还没有（防抖窗口内）
  assert.equal(readCount('group_222'), -1, '防抖窗口内不应有磁盘文件');
});

await checkAsync('flushAll() 后磁盘 = 内存，且 JSON 是紧凑格式', async () => {
  const store = new ChatStore();
  for (let i = 1; i <= 5; i++) store.appendIncoming('group:333', { text: `m${i}`, ts: 1000 + i });
  const n = store.flushAll();
  assert.equal(n, 1, 'flushAll 应写 1 个脏会话');
  assert.equal(readCount('group_333'), 5);
  const raw = readRaw('group_333');
  assert.ok(!raw.includes('\n'), '存档应为紧凑序列化（旧版带缩进）');
  const parsed = JSON.parse(raw);
  assert.equal(parsed.chatKey, 'group:333');
  assert.equal(parsed.nextLocalId, 6);
});

await checkAsync('防抖到期后自动写盘（unref 的 timer 也要能触发）', async () => {
  const store = new ChatStore();
  store.appendIncoming('group:444', { text: 'before', ts: 1 });
  store.flushAll();
  assert.equal(readCount('group_444'), 1);
  store.appendIncoming('group:444', { text: 'after', ts: 2 });   // 只标脏，不写盘
  assert.equal(readCount('group_444'), 1, '防抖期内磁盘还是旧内容');
  await sleep(700);   // > FLUSH_DEBOUNCE_MS(500)
  assert.equal(readCount('group_444'), 2, '防抖到期应自动落盘');
  store.flushAll();
});

check('空跑 flushAll 返回 0，不产生任何磁盘文件', () => {
  const store = new ChatStore();
  assert.equal(store.flushAll(), 0);
  assert.ok(!fs.existsSync(path.join(dataDir, 'messages', 'group_555.json')));
});

check('删除/清空类操作立即落盘（不等防抖）', () => {
  const store = new ChatStore();
  store.appendIncoming('group:666', { text: 'a', ts: 1 });
  store.appendIncoming('group:666', { text: 'b', ts: 2 });
  store.flushAll();
  const st = store.recent('group:666', { limit: 10 });
  const removed = store.removeByLocalIds('group:666', [st[0].id]);
  assert.equal(removed, 1);
  assert.equal(readCount('group_666'), 1, 'removeByLocalIds 应立即写盘');
  store.clearChat('group:666');
  assert.equal(readCount('group_666'), 0, 'clearChat 应立即写盘');
});

console.log('\n== store 冷会话 LRU ==');

check('LRU：常驻内存数封顶，超出的被踢出内存', () => {
  const store = new ChatStore(0, 5);
  for (let i = 1; i <= 8; i++) {
    const key = `group:${900 + i}`;
    store.appendIncoming(key, { text: `c${i}`, ts: i });
  }
  assert.equal(store.loadedCount(), 5, `内存应只驻留 5 个会话（实际 ${store.loadedCount()}）`);
  store.flushAll();
});

check('被淘汰的会话数据不丢（淘汰前先落盘，重读完整）', () => {
  const store = new ChatStore(0, 5);
  const first = 'group:801';
  store.appendIncoming(first, { text: '老群的第一条', ts: 1 });
  store.appendIncoming(first, { text: '老群的第二条', ts: 2 });
  for (let i = 1; i <= 6; i++) store.appendIncoming(`group:${810 + i}`, { text: `x${i}`, ts: i });
  // first 已被挤出内存；重读它 → 从磁盘加载，数据完整
  const reloaded = store.recent(first, { limit: 10 });
  assert.equal(reloaded.length, 2, `淘汰会话重读应有 2 条（实际 ${reloaded.length}）`);
  assert.equal(reloaded[1].text, '老群的第二条');
  store.flushAll();
});

check('淘汰时脏数据先冲盘（不走 flushAll 也不丢）', () => {
  const store = new ChatStore(0, 3);
  store.appendIncoming('group:701', { text: '脏数据', ts: 1 });   // 只标脏，没写盘
  assert.equal(readCount('group_701'), -1, '写盘前磁盘上不该有文件');
  for (let i = 1; i <= 4; i++) store.appendIncoming(`group:${710 + i}`, { text: `y${i}`, ts: i });
  // group:701 被 LRU 挤出 → flush(701) 必须先执行
  assert.equal(readCount('group_701'), 1, '淘汰时必须把脏数据落盘');
  store.flushAll();
});

check('listChats 不把磁盘上的群全部加载进内存（懒加载）', () => {
  const store = new ChatStore(0, 5);
  store.flushAll();
  // 前面的用例已在磁盘上留下 >5 个群文件
  const keys = store.listChats();
  assert.ok(keys.length >= 5, `磁盘上至少 5 个群（实际 ${keys.length}）`);
  assert.equal(store.loadedCount(), 0, `listChats 不应强制加载（实际驻留 ${store.loadedCount()}）`);
  // 按需 getChatMeta 仍然正常工作
  const meta = store.getChatMeta(keys[0]);
  assert.equal(meta.chatKey, keys[0]);
});

console.log('\n== review 修复回归：写盘失败保留脏标记 / 损坏存档备份 ==');

check('写盘失败：flush 抛错但脏标记保留，恢复后 flushAll 能重试成功', () => {
  const store = new ChatStore();
  store.appendIncoming('group:888', { text: '不能丢的数据', ts: 1 });
  // 拦截 writeFileSync：对本存档文件第一次写入抛错（模拟磁盘满/杀软锁文件）
  const realWrite = fs.writeFileSync;
  let failed = false;
  fs.writeFileSync = function patched(file, ...rest) {
    if (String(file).includes('group_888') && !failed) { failed = true; throw new Error('EPERM: 模拟磁盘故障'); }
    return realWrite.call(fs, file, ...rest);
  };
  let threw = false;
  try { store.flush('group:888'); } catch { threw = true; }
  fs.writeFileSync = realWrite;
  assert.ok(threw, '写盘失败应向上抛错');
  // 修复点：脏标记必须还在 —— flushAll 重试能写成功
  assert.equal(store.flushAll(), 1, '失败后脏标记应保留，flushAll 重试成功');
  assert.equal(readCount('group_888'), 1, '重试后数据完整落盘');
});

check('损坏存档：解析失败 → 备份为 .corrupt-<时间戳>，绝不静默用空历史覆盖', () => {
  const key = 'group:999';
  const file = msgFile(key);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '{这不是合法 JSON {{{', 'utf8');
  const store = new ChatStore();
  const recent = store.recent(key, { limit: 10 });
  assert.equal(recent.length, 0, '损坏存档按空会话打开');
  const backups = fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('group_999.json.corrupt-'));
  assert.equal(backups.length, 1, `损坏文件必须备份（实际：${backups.join(',')}）`);
  // 后续保存正常写入，且备份文件不被覆盖删除
  store.appendIncoming(key, { text: '新会话第一条', ts: 1 });
  store.flushAll();
  assert.equal(readCount(key), 1);
  assert.equal(fs.readdirSync(path.dirname(file)).filter((f) => f.startsWith('group_999.json.corrupt-')).length, 1, '备份仍在');
});

console.log(bad ? `\n${bad} 项失败\n` : '\n全部通过\n');
process.exit(bad ? 1 : 0);
