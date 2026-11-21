import { load } from 'cheerio';
import { compact } from '../sanjiang-web/parse.mjs';
import { competitionEligibility } from './parse.mjs';

const modelscope = 'https://modelscope.cn';
export const modelScopeSource = {
  id: 'competition-modelscope', name: '魔搭社区', url: `${modelscope}/events`,
  note: '检查赛事首页和已收录的在报项目，读取官方参赛规则。',
};
export const aiDaxueSource = {
  id: 'competition-aidaxue', name: '讯飞 AI 大学堂', url: 'https://www.aidaxue.com/activity/cyber-maker',
  note: '定时核对校园 AI 微应用挑战赛的官方活动页。',
};

// shortcut: the linked guides set the two editions' separate deadlines; recheck if their platform schedule changes.
const reviewedRules = {
  394: {
    title: 'AI造游戏，人人都是游戏制作人｜AI+∞开发者创作大赛第三期',
    listedDeadline: '2026-12-01T10:00:00.000Z',
    registrationDeadline: '2026-12-01T12:00:00+08:00',
    submissionDeadline: '2026-12-01T18:00:00+08:00',
    summary: '用 AI 做一款原创、可试玩的游戏，或做游戏开发工具与智能体。作品部署到魔搭创空间，并附创作手记和演示视频。',
    method: '先按赛事专题发布公开参赛构想并提交帖子链接。完成后从同一专题提交作品与创作手记。',
    guide: 'https://modelscope.cn/active/AIstudio',
  },
  421: {
    title: '知乎黑客松S3 |湾区共创季',
    listedDeadline: '2026-12-04T15:59:00.000Z',
    registrationDeadline: '2026-12-04T23:59:00+08:00',
    submissionDeadline: '2026-12-07T10:00:00+08:00',
    summary: '面向全球青年开发者，个人或 1–5 人组队。围绕知识探索、陪伴交互或出海，在线提交可运行 Demo 和产品说明。',
    method: '从魔搭赛事页进入知乎官方报名。开发和作品提交在线完成，入围也支持云路演。',
    guide: 'https://hackathon-s3.event.zhihu.com/',
  },
};

function secondsDate(seconds) {
  if (Number.isSafeInteger(seconds) && seconds > 946684800 && seconds < 4102444800) return new Date(seconds * 1000).toISOString();
}

function contentText(node) {
  if (typeof node === 'string') return node;
  if (!Array.isArray(node)) return '';
  const [tag, , ...children] = node;
  return children.map(contentText).join('') + (/^(?:h[1-6]|p|div|li|br|tr|root)$/.test(tag) ? '\n' : '');
}

function projectRecord(source, id, fields) {
  return {
    id, category: '竞赛', source: source.name, sourceType: 'competition', activityType: 'AI项目赛',
    location: '线上提交', colleges: [], importance: 'high', demo: false, detailRead: true,
    verification: '竞赛官方原文', rewardNote: '奖项、费用及校内认定请核对官方规则。',
    ...fields,
  };
}

export function modelScopeInformation(event, now = Date.now()) {
  if (event?.EventType !== 'competition' || !['application', 'hackathon'].includes(event.Category) ||
      event.PublishStatus !== 1 || event.Status !== 1 || !Number.isSafeInteger(event.Id) || !event.Title?.trim()) return null;
  const listedDeadline = secondsDate(event.RegistrationDeadline);
  const registrationStart = secondsDate(event.SignUpStart);
  if (!listedDeadline || Date.parse(listedDeadline) <= now || Date.parse(registrationStart) > now) return null;
  const rules = JSON.parse(event.Content || '[]').map(tab => contentText(tab.content)).join('\n');
  const text = compact(rules);
  const reviewed = reviewedRules[event.Id];
  if (!reviewed && (!/全程线上|全程支持云参赛|线上提交|在线提交|(?:发布|部署)到魔搭创空间/.test(text) ||
      !/提交作品|作品提交|原创游戏|可运行.{0,10}Demo|原创.{0,12}(?:应用|智能体)/i.test(text))) return null;
  const eligibility = competitionEligibility(text);
  if (eligibility.status === 'excluded' || /(?:仅限|只限).{0,20}(?:本校|本院|职工|研究生)|必须.{0,12}线下(?:参赛|提交)|全程线下/.test(text)) return null;
  const open = text.match(/面向全球开放线上报名|面向全国高校(?:学生|生)|(?:不限专业|不限学校)[^。；]{0,35}/)?.[0];
  if (!reviewed && eligibility.status !== 'allowed' && !open) return null;
  if (reviewed && (event.Title !== reviewed.title ||
      (listedDeadline !== reviewed.listedDeadline && Date.parse(listedDeadline) !== Date.parse(reviewed.registrationDeadline)))) {
    throw new Error('官网赛程已变更，需重新核对报名和作品截止');
  }
  const registrationDeadline = reviewed?.registrationDeadline ?? listedDeadline;
  if (Date.parse(registrationDeadline) <= now) return null;
  return projectRecord(modelScopeSource, `competition-modelscope-${event.Id}`, {
    title: event.Title,
    sourcePortal: `${modelscope}/events/${event.Id}`,
    publishedAt: Number.isFinite(Date.parse(event.PublishTime)) ? event.PublishTime : '',
    summary: reviewed?.summary || compact(event.Brief || '').slice(0, 160) || '完成项目后按赛事页要求在线提交。',
    registrationStart, registrationDeadline, submissionDeadline: reviewed?.submissionDeadline,
    freshmanAllowed: open ? 'allowed' : eligibility.status,
    eligibilityEvidence: open || eligibility.evidence,
    registrationMethod: reviewed?.method || '从魔搭官方赛事页查看报名和线上作品提交要求。',
    attachments: reviewed ? [{ title: '主办方赛程与参赛指南', url: reviewed.guide }] : [],
  });
}

export async function collectModelScope(getResponse, now = Date.now(), previous = []) {
  const $ = load((await getResponse(modelScopeSource.url)).toString('utf8'));
  const ids = new Set($('a[href^="/events/"]').map((_, a) => {
    const match = $(a).attr('href')?.match(/^\/events\/(\d+)(?:\/|\?|$)/);
    return match ? Number(match[1]) : null;
  }).get());
  if (!ids.size) throw new Error('魔搭赛事列表暂不可读');
  // The public homepage rotates cards. Keep checking previously listed opportunities until their deadline.
  for (const item of previous) {
    const id = item.id.match(/^competition-modelscope-(\d+)$/)?.[1];
    if (id && Date.parse(item.registrationDeadline) > now) ids.add(Number(id));
  }
  const items = [], errors = [];
  let checked = 0;
  for (const id of ids) {
    try {
      const result = JSON.parse((await getResponse(`${modelscope}/api/v1/competitions/${id}/detail`)).toString('utf8'));
      if (result.Success !== true || result.Data?.Id !== id) throw new Error('赛事详情暂不可读');
      const item = modelScopeInformation(result.Data, now);
      checked++;
      if (item) items.push(item);
    } catch { errors.push(`赛事 ${id} 的规则未能核对`); }
  }
  if (!checked) throw new Error('魔搭赛事规则暂不可读');
  return { items, errors };
}

function editionDay(month, day) {
  const date = `2026-${month.padStart(2, '0')}-${day.padStart(2, '0')}`;
  const time = Date.parse(date);
  return Number.isFinite(time) && new Date(time).toISOString().slice(0, 10) === date ? date : undefined;
}

export function aiDaxueInformation(text, now = Date.now()) {
  if (!/面向全国高校生的\s*AStudio应用创作赛/.test(text) || !/报名和交作品在整个活动期内都开放/.test(text)) {
    throw new Error('校园微应用挑战赛规则已变更');
  }
  const phase = text.match(/作品创作及展示\s*(\d{1,2})月(\d{1,2})日[-–—至]+(\d{1,2})月(\d{1,2})日/);
  if (!phase) throw new Error('校园微应用创作安排未读到');
  const creationStart = editionDay(phase[1], phase[2]), creationEnd = editionDay(phase[3], phase[4]);
  if (!creationStart || !creationEnd || creationStart > creationEnd) throw new Error('校园微应用日期格式已变更');
  if (now < Date.parse(`${creationStart}T00:00:00+08:00`) || now >= Date.parse(`${creationEnd}T23:59:59+08:00`) ||
      !text.includes('立即报名参赛')) return null;
  const faq = text.match(/至(\d{1,2}月\d{1,2}日)结束，报名和交作品在整个活动期内都开放/);
  if (!faq) throw new Error('校园微应用报名规则未读到');
  return projectRecord(aiDaxueSource, 'competition-aidaxue-cyber-maker-2026', {
    title: '赛博制作人计划 · 校园 AI 微应用挑战赛',
    sourcePortal: aiDaxueSource.url, publishedAt: '',
    summary: '面向全国高校生，用讯飞 AStudio 做网页、微应用或小游戏，在活动页提交可访问的作品分享链接。',
    freshmanAllowed: 'allowed', eligibilityEvidence: '官方活动页明确面向全国高校生。',
    registrationMethod: '在讯飞 AI 大学堂活动页报名，使用 AStudio 客户端创作并发布作品。',
    registrationNote: `官网时间轴列创作展示至 ${phase[3]} 月 ${phase[4]} 日，之后进入评审。FAQ 列活动报名与交作品开放至 ${faq[1]}。用于评审的最终提交时间请核对官方页。`,
  });
}
