// B 站视频搜索（给"帮我找个攻略视频"这类需求用）。
//
// 为什么不用 wbi 签名接口：实测（2026-10-04）`/x/web-interface/wbi/search/type`
// 匿名请求会被风控，返回 data.v_voucher（人机验证挑战）而不是结果；
// 老的 `/x/web-interface/search/type` 带 UA + Referer 反而能拿到结果。
// 所以这里以老接口为主，失败时换 cookie 再试一次，最后给出可点的搜索页兜底。
//
// 只做只读搜索：不登录、不带用户 cookie、不下载视频。

const SEARCH_API = 'https://api.bilibili.com/x/web-interface/search/type';

// 不带 UA / Referer 会被 B 站直接拒（412 风控）
const BASE_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  referer: 'https://www.bilibili.com/',
  accept: 'application/json, text/plain, */*'
};

const ORDER_MAP = {
  综合: 'totalrank',
  最多播放: 'click',
  最新: 'pubdate',
  弹幕最多: 'dm',
  收藏最多: 'stow'
};

export const ORDER_CHOICES = Object.keys(ORDER_MAP);

function stripTags(text) {
  return String(text ?? '')
    .replace(/<[^>]+>/g, '')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** 播放量/弹幕数转成"1.8万"这种中文习惯写法。 */
export function formatCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)}亿`;
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return String(Math.round(n));
}

/** 时长：接口给的是 "8:49" 或 "831:38" 这种，原样保留就好。 */
function formatDuration(value) {
  return String(value ?? '').replace(/[^\d:]/g, '') || '未知';
}

function formatDate(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  const d = new Date(n * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** 兜底：给一个人能点开的搜索页。 */
export function biliSearchUrl(keyword) {
  return `https://search.bilibili.com/all?keyword=${encodeURIComponent(String(keyword ?? ''))}`;
}

async function callSearch(fetchFn, url, headers, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(url, { method: 'GET', headers, signal: controller.signal });
    if (!res || typeof res.text !== 'function') throw new Error('联网通道返回了异常对象');
    if (!res.ok) throw new Error(`B 站接口返回 HTTP ${res.status}`);
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error('B 站接口返回的不是合法 JSON');
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 搜索 B 站视频。
 * @returns {Promise<{items: Array, keyword: string, order: string, fallbackUrl: string, note?: string}>}
 */
export async function biliSearch(fetchFn, keyword, { limit = 5, order = '综合', timeoutMs = 12000 } = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) throw new Error('搜索关键词为空');
  if (typeof fetchFn !== 'function') throw new Error('没有可用的联网通道');

  const size = Math.max(1, Math.min(10, Number(limit) || 5));
  const ord = ORDER_MAP[String(order ?? '').trim()] || ORDER_MAP['综合'];
  const params = new URLSearchParams({
    search_type: 'video',
    keyword: kw,
    page: '1',
    page_size: String(size),
    order: ord
  });
  const url = `${SEARCH_API}?${params.toString()}`;

  let lastError = '';
  const attempts = [
    ['直接请求', BASE_HEADERS],
    ['带 buvid3 cookie', { ...BASE_HEADERS, cookie: `buvid3=${Math.random().toString(36).slice(2, 12).toUpperCase()}-infoc` }]
  ];

  for (const [label, headers] of attempts) {
    try {
      const data = await callSearch(fetchFn, url, headers, timeoutMs);
      const code = Number(data?.code);
      const list = Array.isArray(data?.data?.result) ? data.data.result : [];
      if (code === 0 && list.length) {
        return {
          keyword: kw,
          order: order,
          fallbackUrl: biliSearchUrl(kw),
          items: list.map((v) => ({
            title: stripTags(v?.title),
            author: stripTags(v?.author),
            play: formatCount(v?.play),
            danmaku: formatCount(v?.video_review),
            duration: formatDuration(v?.duration),
            date: formatDate(v?.pubdate),
            bvid: stripTags(v?.bvid),
            url: v?.bvid ? `https://www.bilibili.com/video/${stripTags(v.bvid)}` : stripTags(v?.arcurl)
          }))
        };
      }
      lastError = code === 0
        ? 'B 站返回了 0 条结果'
        : `B 站接口 code=${code}${data?.message ? `（${data.message}）` : ''}${data?.data?.v_voucher ? '，触发了人机验证' : ''}`;
    } catch (error) {
      lastError = error?.name === 'AbortError' ? '请求 B 站超时' : (error?.message ?? String(error));
    }
  }

  return { keyword: kw, order, fallbackUrl: biliSearchUrl(kw), items: [], note: lastError || '没有拿到结果' };
}
