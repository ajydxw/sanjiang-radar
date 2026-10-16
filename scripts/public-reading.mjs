import { open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { PUBLIC_FEEDS, assertPublicFeed } from '../sources/public-feed.mjs';

const labels = ['学校官网', 'PU口袋校园', '学校公众号', '竞赛信息', '考试与学生办理通知'];
const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[character]);

async function loadFeed(root, name) {
  const file = await realpath(resolve(root, 'data', name));
  const part = relative(root, file);
  if (!part || isAbsolute(part) || part.startsWith(`..${sep}`) || part.split(sep).some(value => value.startsWith('.'))) {
    throw new Error('Invalid public feed path');
  }
  const handle = await open(file);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 2 * 1024 * 1024) throw new Error('Invalid public feed size');
    const body = await handle.readFile();
    if (body.length > 2 * 1024 * 1024) throw new Error('Invalid public feed size');
    const feed = JSON.parse(body.toString('utf8'));
    assertPublicFeed(feed);
    return feed;
  } finally {
    await handle.close();
  }
}

function article(item) {
  const dates = [['发布时间', item.publishedAt], ['报名开始', item.registrationStart],
    ['报名截止', item.registrationDeadline], ['活动或办理开始', item.eventStart], ['最近采集', item.fetchedAt]];
  return `<article><h3>${escape(item.title)}</h3><p>${escape(item.summary.slice(0, 400))}</p>
<p>类别：${escape(item.category)} · 来源：${escape(item.source)}<br>
大一资格：${item.freshmanAllowed === 'allowed' ? '来源信息标记可参加，仍需核对个人条件' : '未核实，请核对原文'}<br>
原文正文：${item.detailRead ? '已采集' : '尚未读到完整正文'} · 状态：${escape(item.officialStatus || '请核对官方最新状态')}</p>
<dl>${dates.filter(([, value]) => value).map(([label, value]) => `<dt>${label}</dt><dd>${escape(value)}</dd>`).join('')}
<dt>学分或奖励</dt><dd>${escape(item.rewardNote)}</dd></dl>
<p><a href="${escape(item.sourcePortal)}" rel="noreferrer">查看官方原文</a></p></article>`;
}

export async function publicReadingPage(root) {
  const feeds = await Promise.allSettled(PUBLIC_FEEDS.map(name => loadFeed(root, name)));
  const available = feeds.filter(result => result.status === 'fulfilled').length;
  const sections = feeds.map((result, index) => {
    if (result.status === 'rejected') return `<section><h2>${labels[index]}</h2><p>这份公开快照暂不可读取，请稍后重试。</p></section>`;
    const feed = result.value;
    const items = feed.items.filter(item => !item.demo && item.freshmanAllowed !== 'excluded')
      .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || b.id.localeCompare(a.id)).slice(0, 10);
    return `<section><h2>${labels[index]}</h2><p>已收集 ${feed.items.filter(item => !item.demo).length} 条；本页展示最近 ${items.length} 条未明确排除大一的信息。
快照生成：${escape(feed.generatedAt)}。</p><p><a href="/data/${PUBLIC_FEEDS[index]}">查看这一来源的完整公开数据</a></p>
${items.length ? items.map(article).join('\n') : '<p>目前没有符合本页范围的信息。</p>'}</section>`;
  }).join('\n');
  const body = Buffer.from(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>三江雷达 · 文字阅读版</title><style>body{max-width:900px;margin:32px auto;padding:0 20px;font:16px/1.7 system-ui,sans-serif;color:#1c2433;background:#fafafa}a{color:#245ac0}article{padding:16px 0;border-bottom:1px solid #ddd}dt{font-weight:600}dd{margin:0 0 8px;overflow-wrap:anywhere}h2{margin-top:40px}</style></head>
<body><main><h1>三江雷达 · 文字阅读版</h1><p>面向三江学院2026级大一新生。无需运行网页脚本即可读取以下公开信息。</p>
<p><a href="/#radar">打开完整网站</a> · 页面读取时间：${escape(new Date().toISOString())}</p>
<p>以下是已采集的来源记录，可能包含已截止或已结束事项。请以官方最新通知为准；大一资格、学分和名额未核实时不视为已确认。只有日期而没有时刻的记录，不推定具体截止时刻。</p>
${available ? '' : '<p>所有公开来源目前均不可读取，请稍后重试。</p>'}${sections}</main></body></html>`, 'utf8');
  return { status: available ? 200 : 503, body };
}
