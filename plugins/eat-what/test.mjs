import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-agent-eat-what-test-'));
process.env.QQ_AGENT_DATA_DIR = temp;
try {
  const mod = await import('./index.js');
  const { getConfig, updateConfig } = await import('../../src/config.js');
  const { skillManager } = await import('../../src/skills/manager.js');
  const { normalizeManifest } = await import('../../src/skills/manifest.js');
  const { registerTool } = await import('../../src/tool-registry.js');
  const { getSkillConfig } = await import('../../src/skills/config.js');
  const { resolveContextTier } = await import('../../src/prompt.js');
  const manifest = normalizeManifest(JSON.parse(fs.readFileSync(new URL('./plugin.json', import.meta.url), 'utf8'))).manifest;
  let tool;
  mod.setup({ config: () => getSkillConfig('eat-what', manifest.settings), registerTool: (def) => {
    tool = { ...def, id: `eat-what__${def.id}`, skillId: 'eat-what' };
    registerTool(tool);
    return tool.id;
  } });
  skillManager.register({ manifest, kind: 'plugin', source: 'plugin', dir: path.dirname(fileURLToPath(import.meta.url)),
    providers: mod.providers, hooks: mod.hooks, toolIds: [tool.id], promptSections: mod.promptSections });
  assert.equal(skillManager.isActive('eat-what').active, true);
  const defaultDoc = mod.readDocument();
  const defaults = mod.parseMeals(defaultDoc.text);
  assert.equal(defaults.lunch.length, 14);
  assert.equal(defaults.dinner.length, 14);
  assert(defaults.lunch.includes('煎饼果子'));
  assert(defaults.dinner.includes('铁锅炖'));
  for (const [time, expected] of [
    ['2026-10-07T15:59:59+08:00', 'lunch'], ['2026-10-07T16:00:00+08:00', 'dinner'],
    ['2026-10-07T00:00:00+08:00', 'lunch'], ['2026-10-07T23:59:59+08:00', 'dinner'],
    ['2026-10-07T16:30:00+09:00', 'lunch']
  ]) assert.equal(mod.mealAt(Date.parse(time)), expected, time);

  const parsed = (r) => { assert(!r.isError, r.content); return JSON.parse(r.content); };
  const ctxFor = (id, entries) => {
    mod.hooks['before-context']({ sessionId: id, chatKey: 'group:123', kind: 'group', triggerEntries: entries });
    return { session: { id, trigger: entries }, chatKey: 'group:123' };
  };
  const question = ctxFor('question', [{ id: 1, text: '晚饭吃什么？', self: false }]);
  const choices = parsed(tool.execute(question, { action: 'recommend', meal: 'lunch' }));
  assert.deepEqual(choices.meals, ['dinner']);
  assert.equal(choices.options.dinner.length, 3);
  assert.equal(new Set(choices.options.dinner).size, 3);
  assert(choices.options.dinner.every((x) => defaults.dinner.includes(x)));

  const adding = ctxFor('adding', [{ id: 2, text: '把寿司、沙县小吃加入午餐', self: false }]);
  let added = parsed(tool.execute(adding, { action: 'add', items: ['寿司', '沙县小吃'], sourceId: '2', meal: 'auto' }));
  assert.deepEqual(added.added.lunch, ['寿司', '沙县小吃']);
  assert.deepEqual(parsed(tool.execute(adding, { action: 'add', items: ['寿司'], sourceId: '2', meal: 'lunch' })).added.lunch, []);
  assert(!mod.parseMeals(mod.readDocument().text).dinner.includes('寿司'));
  assert(tool.execute(adding, { action: 'add', items: ['寿司'], sourceId: '2', meal: 'dinner' }).isError);
  assert(tool.execute(adding, { action: 'add', items: ['编造餐馆'], sourceId: '2' }).isError);
  assert(tool.execute(adding, { action: 'add', items: ['寿司'], sourceId: '99' }).isError);
  const ordinary = ctxFor('ordinary', [{ id: 3, text: '今天吃了寿司', self: false }]);
  assert(tool.execute(ordinary, { action: 'add', items: ['寿司'], sourceId: '3' }).isError);
  assert.equal(mod.detect([{ text: '不要添加晚餐寿司' }]).length, 0);
  assert.equal(mod.detect([{ text: '不要把寿司加入午餐' }]).length, 0);
  const negative = ctxFor('negative', [{ id: 30, text: '不要把寿司加入午餐', self: false }]);
  assert(tool.execute(negative, { action: 'add', items: ['寿司'], sourceId: '30' }).isError);
  const both = ctxFor('both', [{ id: 4, text: '午餐和晚餐都添加乌冬面', self: false }]);
  added = parsed(tool.execute(both, { action: 'add', items: ['乌冬面'], sourceId: '4', meal: 'both' }));
  assert.deepEqual(added.added, { lunch: ['乌冬面'], dinner: ['乌冬面'] });
  const auto = ctxFor('auto', [{ id: 5, text: '把盖浇饭加入吃什么备选', self: false }]);
  const before = mod.mealAt();
  added = parsed(tool.execute(auto, { action: 'add', items: ['盖浇饭'], sourceId: '5', meal: 'auto' }));
  assert.deepEqual(added.meals, [before]);
  assert(tool.execute(auto, { action: 'add', items: ['盖浇饭'], sourceId: '5', meal: 'both' }).isError);

  assert.throws(() => mod.writeDocument(defaultDoc.text, defaultDoc.revision), /已被/);
  const recent = mod.readDocument();
  assert.throws(() => mod.writeDocument('[午餐]\n火锅', recent.revision), /同时包含/);
  assert.equal(mod.readDocument().revision, recent.revision);
  mod.writeDocument('[午餐]\n\n[晚餐]\n火锅\n火锅\n', recent.revision);
  const small = parsed(tool.execute({}, { action: 'recommend', meal: 'both' }));
  assert.deepEqual(small.options.lunch, []);
  assert.deepEqual(small.options.dinner, ['火锅']);
  mod.setup({ config: () => getSkillConfig('eat-what', manifest.settings), registerTool: () => tool.id });
  assert.deepEqual(mod.parseMeals(mod.readDocument().text).lunch, []); // 重载不恢复默认内容

  const judge = (text) => resolveContextTier({ chatKey: 'group:123', cfg: { contextTier: 1, historyCount: 20 },
    triggerEntries: [{ id: 10, text, self: false, atMe: false }], roll: 100 });
  assert.equal(judge('吃什么？').shouldRespond, true);
  assert.equal(judge('把寿司加入午餐').shouldRespond, true);
  assert.equal(judge('普通聊天').shouldRespond, false);
  updateConfig({ skills: { 'eat-what': { triggerWords: '' } } });
  assert.equal(judge('吃什么？').shouldRespond, false);
  assert.equal(judge('把寿司加入午餐').shouldRespond, true);
  updateConfig({ skills: { 'eat-what': { learnFromChat: false } } });
  assert.equal(judge('把寿司加入午餐').shouldRespond, false);
  assert(tool.execute(adding, { action: 'add', items: ['寿司'], sourceId: '2' }).isError);
  updateConfig({ skills: { 'eat-what': { triggerWords: '吃什么', learnFromChat: true, enabled: false } } });
  assert.equal(judge('吃什么？').shouldRespond, false);
  updateConfig({ skills: { 'eat-what': { enabled: true } }, tools: { overrides: { [tool.id]: false } } });
  assert.equal(judge('吃什么？').shouldRespond, false);
  updateConfig({ tools: { overrides: { [tool.id]: true } } });

  const { createRoutes } = await import('../../src/routes.js');
  const routes = createRoutes({ readBody: async (req) => req.body, emit: () => {}, sanitizeConfig: (c) => c });
  const getRoute = routes.find((r) => r.method === 'GET' && r.pattern instanceof RegExp && r.pattern.test('/api/skills/eat-what/text-document'));
  const postRoute = routes.find((r) => r.method === 'POST' && r.pattern instanceof RegExp && r.pattern.test('/api/skills/eat-what'));
  const json = (_res, status, payload) => ({ status, payload });
  const got = await getRoute.handler({ match: getRoute.pattern.exec('/api/skills/eat-what/text-document'), json });
  assert.equal(got.status, 200);
  const invoke = (body) => postRoute.handler({ req: { body }, match: postRoute.pattern.exec('/api/skills/eat-what'), json });
  const saved = await invoke({ settings: { triggerWords: '', optionCount: 4 }, textDocument: { text: '[午餐]\n猪脚饭\n[晚餐]\n火锅', revision: got.payload.document.revision } });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.settings.triggerWords, '');
  assert.deepEqual(mod.parseMeals(saved.payload.document.text), { lunch: ['猪脚饭'], dinner: ['火锅'] });
  const conflict = await invoke({ settings: { optionCount: 9 }, textDocument: { text: '[午餐]\n肯德基\n[晚餐]\n麦当劳', revision: got.payload.document.revision } });
  assert.equal(conflict.status, 409);
  assert.equal(getConfig().skills['eat-what'].optionCount, 4);

  const uiFile = new URL('../../ui/app/06-settings-render.js', import.meta.url);
  const scope = vm.createContext({ state: {}, esc: (s) => String(s ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;') });
  vm.runInContext(fs.readFileSync(uiFile, 'utf8'), scope);
  scope.skill = { ...manifest, settings: saved.payload.settings, textDocument: saved.payload.document };
  const html = vm.runInContext('renderSkillSettingsModal(skill).html', scope);
  assert.match(html, /skset-meal-text/);
  assert.match(html, /\[午餐\]/);
  assert.match(html, /北京时间/);
  assert.match(html, /<textarea[^>]+data-key="triggerWords"/);
  assert(!html.includes('以下设置不在这里改'));
  console.log('吃什么离线验证通过：默认列表、北京时间、指定餐别、推荐去重、真实消息学习、拒绝伪造、并发编辑、空列表、开关与关键词、设置接口、表单渲染。未调用AI或向QQ发消息。');
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
