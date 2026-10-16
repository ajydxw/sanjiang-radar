import { load } from 'cheerio';
import { compact, fingerprint, classify, inferEligibility } from '../sanjiang-web/parse.mjs';

export function wechatUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.hostname !== 'mp.weixin.qq.com' || url.username || url.password || !/^\/s(?:\/[^/]+)?$/.test(url.pathname)) throw new Error('仅支持微信官方公众号文章链接');
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) if (!['__biz', 'mid', 'idx', 'sn'].includes(key)) url.searchParams.delete(key);
  return url.href;
}

export function wechatDate(value) {
  const match = String(value || '').match(/(20\d{2})年(\d{1,2})月(\d{1,2})日\s*(\d{1,2}):(\d{2})/);
  if (!match) return '';
  const iso = `${match[1]}-${match[2].padStart(2, '0')}-${match[3].padStart(2, '0')}T${match[4].padStart(2, '0')}:${match[5]}:00+08:00`;
  const stamp = Date.parse(iso);
  return Number.isFinite(stamp) && new Date(stamp + 8 * 3600000).toISOString().slice(0, 19) === iso.slice(0, 19) ? iso : '';
}

export function parseWechatArticle(html, sourceUrl, fetchedAt, previous) {
  const url = wechatUrl(sourceUrl);
  const $ = load(html);
  const title = compact($('#activity-name').text());
  const publisher = compact($('#js_name').text());
  const content = $('#js_content');
  if (!title || !publisher || !content.length) throw new Error('微信返回验证页或正文未准备好');
  if (publisher !== '三江学院') throw new Error('发布者不是三江学院官方公众号，停止导入');
  content.find('script,style,iframe,noscript').remove();
  const body = compact(content.text());
  if (!body) throw new Error('公众号正文为空');
  const classification = classify(title);
  const eligibility = inferEligibility(body);
  const publishedAt = wechatDate(compact($('#publish_time').text()));
  return { classification, contentHash: fingerprint(`${title}\n${body}`),
    item: { id: `wechat-${fingerprint(url).slice(0, 16)}`, title,
      category: classification.category, summary: body.slice(0, 160),
      source: '三江学院官方公众号', sourceType: 'wechat', sourcePortal: url,
      publishedAt, firstSeenAt: previous?.firstSeenAt || fetchedAt, fetchedAt,
      freshmanAllowed: eligibility.status, eligibilityEvidence: eligibility.evidence,
      colleges: [], rewardNote: '奖励或认定未核验，请查看公众号原文。',
      importance: classification.visibility === 'secondary' ? 'secondary' : 'normal',
      registrationMethod: '按公众号原文说明办理，报名仍前往官方渠道。',
      verification: '公众号原文', demo: false, manuallyVerified: false,
    } };
}
