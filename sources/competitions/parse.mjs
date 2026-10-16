import { load } from 'cheerio';
import { compact, fingerprint, inferEligibility } from '../sanjiang-web/parse.mjs';
import { deadlineTime } from '../../src/lib/information.ts';

export function competitionUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (url.hostname !== new URL(base).hostname || url.protocol !== 'https:' || url.username || url.password) return null;
    url.hash = '';
    return url.href;
  } catch { return null; }
}

export function parseCompetitionList(html, source) {
  const $ = load(html);
  const entries = new Map((source.seeds ?? []).map(entry => [entry.url, entry]));
  $(source.selector).each((_, node) => {
    const anchor = $(node);
    const title = compact(anchor.attr('title') || anchor.text().trim().split('\n')[0]);
    const url = competitionUrl(anchor.attr('href'), source.url);
    if (!url || !/大学生数学竞赛|CCSP/i.test(title) || !/举办|报名|启动|延期|延长/.test(title) || /获奖|名单|回顾|总结|培训|夏令营/.test(title)) return;
    const rowText = compact(anchor.closest('li,tr,.item,.row').text() || anchor.text());
    entries.set(url, { url, title, publishedAt: rowText.match(/20\d{2}-\d{2}-\d{2}/)?.[0] || '' });
  });
  return [...entries.values()].slice(0, 6);
}

export function competitionEligibility(body) {
  const restricted = body.match(/(?:仅限|只限|不接受|不包括)[^。；\n]{0,90}/g) ?? [];
  const excluded = restricted.find(line => /不(?:接受|包括)大一|(?:仅限|只限).*大[二三四]/.test(line) && !/大一|一年级|2026级/.test(line.replace(/不(?:接受|包括)大一/, '')));
  if (excluded) return { status: 'excluded', evidence: compact(excluded) };
  const school = inferEligibility(body);
  if (school.status !== 'unknown') return school;
  const text = compact(body).replace(/(?<=\p{Script=Han})\s+(?=\p{Script=Han})/gu, '');
  const evidence = text.match(/面向全国(?:在校大学生|高校在校生)[^。；]{0,180}/)?.[0]
    || text.match(/(?:所有|全体)(?:全日制)?在校(?:大学生|本科生|学生)[^。；]{0,35}/)?.[0]
    || text.match(/具有(?:正式)?[^。；]{0,30}全日制[^。；]{0,50}本科[^。；]{0,70}学生[^。；]{0,30}/)?.[0]
    || text.match(/全国各高校[^。；]{0,45}所有年级学生[^。；]{0,30}/)?.[0];
  return evidence ? { status: 'allowed', evidence: compact(evidence) } : { status: 'unknown', evidence: null };
}

const dateToken = '(?:(20\\d{2})[年./-]\\s*)?(\\d{1,2})[月./-]\\s*(\\d{1,2})日?(?:\\s*(\\d{1,2})[:：](\\d{2}))?';
const datePattern = new RegExp(dateToken, 'g');
function normalizedDate(match, fallbackYear) {
  const year = Number(match[1] || fallbackYear), month = Number(match[2]), day = Number(match[3]);
  if (!year || month < 1 || month > 12) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const calendar = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  if (match[4] === undefined) return calendar;
  if (Number(match[4]) > 23 || Number(match[5]) > 59) return null;
  return `${calendar}T${String(match[4]).padStart(2, '0')}:${match[5]}:00+08:00`;
}

export function competitionDates(body) {
  const text = compact(body);
  const ranges = [...text.matchAll(new RegExp(`(${dateToken})\\s*(?:—|–|-|至|到|~|～)\\s*(${dateToken})`, 'g'))];
  for (const range of ranges) {
    const context = text.slice(Math.max(0, range.index - 25), range.index + range[0].length + 12);
    if (!/报名/.test(context) || /模拟/.test(context)) continue;
    const dates = [...range[0].matchAll(datePattern)];
    if (dates.length !== 2 || !dates[0][1]) continue;
    const year = Number(dates[0][1]) + (!dates[1][1] && Number(dates[1][2]) < Number(dates[0][2]) ? 1 : 0);
    const registrationStart = normalizedDate(dates[0]);
    const registrationDeadline = normalizedDate(dates[1], year);
    if (registrationStart && registrationDeadline) return { registrationStart, registrationDeadline, evidence: compact(context) };
  }
  // "日前" does not give a verified signup instant; show the requirement as a note.
  const before = text.match(/20\d{2}年\s*\d{1,2}月\s*\d{1,2}日前[^。；]{0,70}报名/);
  return { evidence: before ? compact(before[0]) : null };
}

export function parseCompetition(html, entry, source, pdfText = '') {
  const $ = load(html);
  const content = $(source.contentSelector).clone();
  if (!content.length && !pdfText) throw new Error('没有识别到赛事正文');
  content.find('script,style,nav,footer,noscript,iframe').remove();
  content.find('br').replaceWith('\n');
  content.find('p,div,tr,li,section,h1,h2,h3,h4').append('\n');
  const body = (pdfText || content.text()).split('\n').map(compact).filter(Boolean).join('\n');
  if (compact(body).length < 100 || /Please enable JavaScript/.test(body) && !/报名时间/.test(body)) throw new Error('赛事正文未加载完成');
  const title = source.title ? source.id === 'competition-english' ? $('title').text().trim() || source.title : source.title : entry.title;
  const dates = competitionDates(body);
  const eligibility = competitionEligibility(body);
  const publishedAt = entry.publishedAt || (!source.title ? compact($(source.contentSelector).text()).match(/(?:发布时间[:：]?\s*)?(20\d{2}-\d{2}-\d{2})/)?.[1] : '') || '';
  const edition = source.id === 'competition-math' ? title.match(/第([一二三四五六七八九十百零〇\d]+)届/)?.[1]
    : body.match(/(\d{1,2})届赛事日程/)?.[1] || title.match(/20\d{2}/)?.[0] || dates.registrationStart?.slice(0, 4);
  const event = compact(body).match(/(?:初赛(?:定于|时间[:：]?)|(?:比赛|竞赛)时间[:：]?)\s*(20\d{2}[年./-]\s*\d{1,2}[月./-]\s*\d{1,2}日?)/);
  const eventDate = event ? normalizedDate([...event[1].matchAll(datePattern)][0]) : null;
  const closed = dates.registrationDeadline && deadlineTime(dates.registrationDeadline) < Date.now();
  const notes = [
    source.id === 'competition-ccsp' && /200\s*分/.test(body) ? '须满足通知中的 CSP 200 分及以上等条件，通过审核后参赛。' : '',
    source.id === 'competition-design' ? '官网日程为月份范围，具体报名截止未明确；同校 1–3 人组队。' : '',
    /学校|校赛|赛区/.test(source.method) ? '三江校内安排与资格需另行确认，可能早于全国系统截止。' : '',
    dates.evidence && !dates.registrationDeadline ? `全国报名要求：${dates.evidence.match(/20\d{2}年\s*\d{1,2}月\s*\d{1,2}日前/)?.[0] || dates.evidence}；三江校内截止尚未核实。` : '',
  ].filter(Boolean);
  const id = `competition-${fingerprint(`${source.id}|${edition || entry.url}`).slice(0, 16)}`;
  return {
    id, title, category: '竞赛', source: source.name, sourceType: 'competition', sourcePortal: entry.url,
    publishedAt, freshmanAllowed: eligibility.status, eligibilityEvidence: eligibility.evidence,
    registrationStart: dates.registrationStart, registrationDeadline: dates.registrationDeadline,
    eventStart: eventDate || undefined, eventEnd: eventDate || undefined,
    summary: closed ? '本届报名已截止，保留历史通知用于查阅；新一届以官网更新为准。' : notes.join(' ') || '查看赛事官网的参赛规则、报名方式和时间；年级之外的要求仍需核对。',
    registrationNote: notes.join(' '), registrationMethod: source.method,
    colleges: [], rewardNote: '赛事证书、奖项及费用以官方规则为准；三江学分、积分认定尚未核验。',
    importance: 'normal', verification: '竞赛官方原文', manuallyVerified: false, demo: false, detailRead: true,
    dateEvidence: dates.evidence ? [dates.evidence] : [],
    attachments: $('a[href$=".pdf"]').map((_, a) => ({ title: compact($(a).text()), url: competitionUrl($(a).attr('href'), entry.url) })).get().filter(link => link.url).slice(0, 3),
    contentHash: fingerprint(compact(body)),
  };
}
