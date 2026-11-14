/**
 * visionModel 跨服务商路由的单元测试。
 *
 * 背景：设备控制（device_look）把截图塞进主调用，请求需要切到看图模型发。
 * 但用户的主模型（deepseek）和看图模型（MiMo VL）往往不在同一家 ——
 * 所以 visionModel 支持 "服务商ID/模型名" 写法，端点一起换。
 * 这个路由错了的表现是"看图请求发到 deepseek 被 400"，不炸不报，只有测试能拦。
 */
import assert from 'node:assert/strict';
import { specializedModelFor } from '../src/llm.js';

const CFG = {
  api: { model: 'deepseek-flash', visionModel: 'mimo-v2.6-flash', videoModel: '' },
  providers: [{ id: 'custom_xiaomi', baseURL: 'https://api.xiaomimimo.com/v1' }]
};
const imgPart = (url = 'data:image/png;base64,AAA') => ({ role: 'user', content: [{ type: 'text', text: '看' }, { type: 'image_url', image_url: { url } }] });
const txtMsg = { role: 'user', content: '纯文字' };

let bad = 0;
const check = (label, fn) => {
  try { fn(); console.log(`  [ok] ${label}`); }
  catch (e) { bad++; console.log(`  [FAIL] ${label} -- ${e.message}`); }
};

console.log('\n== visionModel 路由 ==');

check('纯文本消息 → null（不换模型）', () => {
  assert.equal(specializedModelFor([txtMsg], CFG), null);
});

check('带图片 + 纯模型名 → 只换模型，provider=null（同一网关）', () => {
  const r = specializedModelFor([imgPart()], CFG);
  assert.deepEqual(r, { model: 'mimo-v2.6-flash', provider: null });
});

check('带图片 + "服务商ID/模型名" → 端点一起换', () => {
  const cfg = { ...CFG, api: { ...CFG.api, visionModel: 'custom_xiaomi/mimo-v2.6-flash' } };
  const r = specializedModelFor([imgPart()], cfg);
  assert.deepEqual(r, { model: 'mimo-v2.6-flash', provider: 'custom_xiaomi' });
});

check('模型名自带斜杠但前缀不是已配置服务商 → 不误拆', () => {
  const cfg = { ...CFG, api: { ...CFG.api, visionModel: 'deepseek-ai/DeepSeek-VL2' } };
  const r = specializedModelFor([imgPart()], cfg);
  assert.deepEqual(r, { model: 'deepseek-ai/DeepSeek-VL2', provider: null });
});

check('videoModel 优先于 visionModel（视频优先原则保持）', () => {
  const cfg = { ...CFG, api: { ...CFG.api, visionModel: 'mimo-v2.6-flash', videoModel: 'custom_xiaomi/mimo-video' } };
  const vidPart = { role: 'user', content: [{ type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAA' } }] };
  const r = specializedModelFor([vidPart], cfg);
  assert.deepEqual(r, { model: 'mimo-video', provider: 'custom_xiaomi' });
});

check('videoModel 留空时视频也回落到 visionModel（原有兜底保持）', () => {
  const r = specializedModelFor([{ role: 'user', content: [{ type: 'video_url', video_url: { url: 'data:video/mp4;base64,AAA' } }] }], CFG);
  assert.deepEqual(r, { model: 'mimo-v2.6-flash', provider: null });
});

check('visionModel 留空 → null（老配置不受影响）', () => {
  const cfg = { ...CFG, api: { ...CFG.api, visionModel: '' } };
  assert.equal(specializedModelFor([imgPart()], cfg), null);
});

check('非数组 messages → null（防御）', () => {
  assert.equal(specializedModelFor('oops', CFG), null);
});

console.log(bad ? `\n${bad} 项失败\n` : '\n全部通过\n');
process.exit(bad ? 1 : 0);
