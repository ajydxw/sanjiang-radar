import { createHash } from 'node:crypto';
import { load } from 'cheerio';

export const compact = value => String(value ?? '').replace(/\s+/g, ' ').trim();
export const fingerprint = value => createHash('sha256').update(value).digest('hex');

export function officialUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (url.hostname !== 'www.sju.edu.cn' || !['https:', 'http:'].includes(url.protocol) || url.username || url.password) return null;
    url.protocol = 'https:';
    url.hash = '';
    url.search = '';
    return url.href;
  } catch { return null; }
}

export function articleId(url) {
  const article = new URL(url).pathname.match(/a(\d+)\/page\.(?:htm|html|psp)$/i);
  return article ? `sju-${article[1]}` : `sju-${fingerprint(url).slice(0, 16)}`;
}

export function parseList(html, source) {
  const $ = load(html);
  const found = new Map();
  $(source.selector).each((_, node) => {
    const anchor = $(node);
    const url = officialUrl(anchor.attr('href'), source.url);
    const title = compact(anchor.attr('title') || anchor.find('.news_title,.news-title').text() || anchor.text());
    if (!url || !/\/page\.(?:htm|html|psp)$/i.test(new URL(url).pathname) || !title) return;
    const row = anchor.closest('.wicket-list,li,tr');
    const publishedAt = compact(row.text()).match(/\b(20\d{2}-\d{2}-\d{2})\b/)?.[1] ?? null;
    found.set(articleId(url), { id: articleId(url), url, title, publishedAt });
  });
  return [...found.values()];
}

export function classify(title) {
  if (/回顾|荣获|喜报|获奖|新闻网上线|招标|招聘|拟入驻.*名单|立项.*结果|结果公示|评审结果|验收工作|学术报告|科研沙龙/.test(title))
    return { visibility: 'hidden', category: '校园资讯', reason: '结果报道、宣传或非学生行动信息，暂留后台' };
  if (/竞赛|大赛|赛项|赛道/.test(title)) return { visibility: 'main', category: '竞赛', reason: '参赛机会' };
  if (/讲座|科普|活动预告/.test(title)) return { visibility: 'main', category: '讲座', reason: '活动预告' };
  if (/志愿/.test(title)) return { visibility: 'main', category: '志愿活动', reason: '志愿活动' };
  if (/报名|申报|申请|考试|普通话(?:水平)?测试|普通话培训|四(?:[、，,.．·]?六)?级|六级|CET[-－]?[46]|NCRE|准考证|缴费|成绩查询|领证|证书领取|选课|课程|奖学金|助学|转专业|补考|重修|新生|学生|放假|入驻/i.test(title))
    return { visibility: 'main', category: '学校通知', reason: '学生可采取行动的通知' };
  return { visibility: 'secondary', category: '校园资讯', reason: '校园通知，相关性需进一步确认' };
}

export function inferEligibility(body) {
  const cohorts = body.match(/(?:适用于|仅限|限于|面向|上课对象[：:]?|参赛对象[：:]?|申请对象[：:]?|适用年级[：:]?|年级要求[：:]?)[^。\n]{0,100}/g) ?? [];
  for (const evidence of cohorts) {
    const lists = [...evidence.matchAll(/20\d{2}(?:\s*[、，,／/—–-]\s*20\d{2})*\s*级/g)].map(match => match[0]);
    const years = lists.flatMap(list => list.match(/20\d{2}/g) ?? []);
    if (years.length && !years.includes('2026')) return { status: 'excluded', evidence: compact(evidence) };
  }
  const explicit = body.match(/(?:面向|适用于|欢迎|参赛对象[：:]?)[^。\n]{0,60}(?:2026级|大一|全体在校本科生|全体在校学生)[^。\n]{0,60}/);
  return explicit ? { status: 'allowed', evidence: compact(explicit[0]) } : { status: 'unknown', evidence: null };
}

export function parseArticle(html, entry) {
  const $ = load(html);
  const content = $('.wp_articlecontent').first();
  if (!content.length) throw new Error('未识别到通知正文，需要检查网页结构');
  const images = content.find('img[src]').map((_, image) => officialUrl($(image).attr('src'), entry.url)).get().filter(Boolean);
  const attachments = content.find('a[href]').map((_, anchor) => ({ title: compact($(anchor).text()), url: officialUrl($(anchor).attr('href'), entry.url) })).get().filter(link => link.url && /\.(?:pdf|docx?|xlsx?|zip)(?:$|\?)/i.test(link.url));
  content.find('script,style,iframe,noscript').remove();
  content.find('br').replaceWith('\n');
  content.find('p,div,tr,h1,h2,h3,h4,li').append('\n');
  const body = content.text().split('\n').map(compact).filter(Boolean).join('\n');
  if (!body && !images.length) throw new Error('通知正文为空，需要人工检查');
  const heading = compact($('.arti_title,.article-title,.article_title,.wicket-article-title').first().text());
  const title = heading || entry.title;
  const publishedAt = compact($('.arti_metas,.article-meta,.wicket-article-info').text()).match(/20\d{2}-\d{2}-\d{2}/)?.[0] || entry.publishedAt;
  const classification = classify(title);
  return {
    ...entry, title, publishedAt, body, attachments, images,
    contentHash: fingerprint(`${title}\n${body}\n${JSON.stringify(attachments)}\n${JSON.stringify(images)}`),
    classification,
    eligibility: inferEligibility(body),
    // Date excerpts are evidence for review, not confirmed signup deadlines.
    dateEvidence: body.split('\n').filter(line => /报名|截止|报送|提交|时间|日期|缴费|准考证|成绩|领证|领取/.test(line) && /\d{1,2}月|\d{4}-\d{2}-\d{2}/.test(line)).map(line => line.slice(0, 220)).slice(0, 8),
  };
}

export function toInformation(article, source) {
  return {
    id: article.id, title: article.title, category: article.classification.category,
    summary: compact(article.body).slice(0, 125) || (article.listOnly ? '已从官网通知列表发现此信息，正文暂不可读取，请查看官方原文核对要求。' : '通知正文为图片，请查看官方原文。'),
    source: source.name, sourceType: 'school', sourcePortal: article.url,
    publishedAt: article.publishedAt, fetchedAt: article.fetchedAt,
    freshmanAllowed: article.eligibility.status,
    eligibilityEvidence: article.eligibility.evidence,
    colleges: [], rewardNote: '学分、积分或时长尚未核验，请查看官方原文。',
    importance: article.classification.visibility === 'secondary' ? 'secondary' : 'normal',
    registrationMethod: '按官方原文中的流程办理；此处不提供站内报名。',
    verification: '学校官方原文', manuallyVerified: false, demo: false,
    dateEvidence: article.dateEvidence, attachments: article.attachments,
    detailRead: !article.listOnly,
  };
}

export function listOnlyArticle(entry, fetchedAt) {
  return { ...entry, body: '', images: [], attachments: [], dateEvidence: [],
    listOnly: true, fetchedAt, firstSeenAt: fetchedAt, lastChangedAt: fetchedAt,
    contentHash: fingerprint(`${entry.title}\n${entry.url}\n${entry.publishedAt}`),
    classification: classify(entry.title), eligibility: { status: 'unknown', evidence: null },
  };
}
