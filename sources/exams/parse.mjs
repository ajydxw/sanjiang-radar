import { load } from 'cheerio';
import { compact, fingerprint } from '../sanjiang-web/parse.mjs';
import { formatDate } from '../../src/lib/information.ts';

export function examUrl(value, base) {
  try {
    const url = new URL(value, base);
    if (url.hostname !== 'www.jseea.cn' || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) return null;
    if (!url.pathname.startsWith('/webfile/') && url.pathname !== '/content/redirect.do') return null;
    url.pathname = url.pathname.replace(/;jsessionid=[^/]+/gi, '');
    url.protocol = 'https:'; url.hash = '';
    const id = url.searchParams.get('id');
    url.search = '';
    if (url.pathname === '/content/redirect.do') {
      if (!/^\d+$/.test(id || '')) return null;
      url.searchParams.set('id', id);
    }
    return url.href;
  } catch { return null; }
}

export function parseExamList(html, source) {
  const $ = load(html), entries = new Map();
  $('li a[href]').each((_, node) => {
    const anchor = $(node), row = compact(anchor.closest('li').text());
    const publishedAt = row.match(/20\d{2}-\d{2}-\d{2}/)?.[0];
    const title = compact(anchor.attr('title') || anchor.text()).replace(/\s*20\d{2}-\d{2}-\d{2}\s*$/, '');
    const url = examUrl(anchor.attr('href'), source.url);
    if (!url || !publishedAt || !/报名|考前|准考证|成绩.*查询|证书.*(?:领取|发放)/.test(title)) return;
    const id = `exam-${fingerprint(url).slice(0, 16)}`;
    entries.set(id, { id, title, url, publishedAt });
  });
  // shortcut: each official column's two latest actionable notices, expand if publication volume grows.
  return [...entries.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)).slice(0, 2);
}

const dateToken = '(?:(20\\d{2})年\\s*)?(\\d{1,2})月\\s*(\\d{1,2})日(?:\\s*(\\d{1,2})(?:[:：](\\d{2})|时(?:(\\d{1,2})分)?))?';
function calendarDate(match, year) {
  const y = Number(match[1] || year), month = Number(match[2]), day = Number(match[3]);
  const date = new Date(Date.UTC(y, month - 1, day));
  if (!y || date.getUTCFullYear() !== y || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return undefined;
  if (match[4] === undefined) return date.toISOString().slice(0, 10);
  const hour = Number(match[4]), minute = Number(match[5] || match[6] || 0);
  if (hour > 24 || minute > 59 || hour === 24 && minute !== 0) return undefined;
  if (hour === 24) date.setUTCDate(date.getUTCDate() + 1);
  return `${date.toISOString().slice(0, 10)}T${String(hour % 24).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00+08:00`;
}

function dateWindow(line, year, requireRange = false) {
  const matches = [...line.matchAll(new RegExp(dateToken, 'g'))];
  const start = matches[0] && calendarDate(matches[0], year);
  const sharedDay = matches.length === 1 && line.slice(matches[0].index + matches[0][0].length).match(/^\s*(?:至|—|–|-|到)\s*(\d{1,2})日/);
  const end = matches[1] ? calendarDate(matches[1], matches[0][1] || year) : sharedDay ? calendarDate([null, matches[0][1], matches[0][2], sharedDay[1]], year) : requireRange ? undefined : start;
  if (start && end && Date.parse(end) < Date.parse(start)) return {};
  return start ? { start, end } : {};
}

export function parseExamArticle(html, entry, source, fetchedAt) {
  const url = examUrl(entry.url);
  if (!url) throw new Error('通知原文入口不在考试院来源内');
  const $ = load(html), content = $('#content');
  if (!content.length) throw new Error('未识别到考试通知正文');
  content.find('script,style,iframe,noscript').remove();
  content.find('br').replaceWith('\n'); content.find('p,div,li,tr').append('\n');
  const body = content.text().split('\n').map(compact).filter(Boolean).join('\n');
  if (body.length < 100) throw new Error('考试通知正文未完整读取');
  const year = entry.title.match(/(20\d{2})年/)?.[1] || body.slice(0, 200).match(/(20\d{2})年/)?.[1];
  const lines = body.split('\n');
  const registration = lines.find(line => /报名时间/.test(line) && /\d{1,2}月\s*\d{1,2}日/.test(line));
  const signup = registration ? dateWindow(registration, year === entry.publishedAt.slice(0, 4) ? year : undefined, true) : {};
  const exams = lines.filter(line => /(?:考试|口试|笔试)(?:时间[为：:]|将于)/.test(line)).map(line => dateWindow(line, year)).filter(value => value.start);
  const eventStart = exams.map(value => value.start).sort().at(0);
  const eventEnd = exams.map(value => value.end).filter(Boolean).sort().at(-1);
  const base = {
    id: entry.id, title: entry.title, category: '学校通知',
    summary: '查看本期考试及办理安排；报名资格、考点与学校要求请核对官方通知。',
    source: source.name, sourceType: 'exam', sourcePortal: url, publishedAt: entry.publishedAt, fetchedAt,
    freshmanAllowed: 'unknown', colleges: [], eligibilityEvidence: null,
    rewardNote: '校内学分或奖励未核实，请查看学校认定要求。',
    importance: 'normal', registrationMethod: '按官方通知办理，报名资格与考点要求需同时核对三江学院通知。',
    registrationNote: '这是省级考试安排；三江学院本期的大一报名资格和校内安排尚未核实。',
    verification: '考试官方原文', demo: false, manuallyVerified: false, detailRead: true,
    registrationStart: signup.start, registrationDeadline: signup.end, eventStart, eventEnd,
  };
  const items = [base];
  const printing = lines.find(line => /打印准考证/.test(line) && /\d{1,2}月\s*\d{1,2}日/.test(line));
  if (printing && eventEnd) {
    const printingDates = [...printing.matchAll(new RegExp(dateToken, 'g'))].map(match => ({
      date: calendarDate(match, year),
      type: printing.slice(Math.max(0, match.index - 12), match.index).match(/(口试|笔试)[^，。；]{0,10}$/)?.[1] || '准考证',
    })).filter(value => value.date);
    const dates = printingDates.map(value => value.date);
    if (dates.length) {
      const tickets = { ...base, id: `${entry.id}-tickets`,
      title: `${entry.title.replace(/报名(?:通告|公告|工作.*通知|通知)$/, '')}：准考证与考试安排`,
      summary: '已报名考生请查看准考证打印日期及考试安排；考试地点以本人准考证为准。', activityType: '考务',
      registrationStart: undefined, registrationDeadline: undefined, eventStart: dates.sort().at(0),
      registrationMethod: '仅已报名并完成缴费的考生办理；在官方报名系统打印准考证，核对本人考试时间和地点。',
      registrationNote: `${printingDates.map(value => `${value.type}：${formatDate(value.date)}起打印`).join('；')}。仅供已报名并完成缴费的考生办理。`,
      };
      if (base.registrationStart || base.registrationDeadline) items.push(tickets);
      else items[0] = { ...tickets, id: entry.id, title: entry.title, eventStart: base.eventStart };
    }
  }
  return { items, contentHash: fingerprint(`${entry.title}\n${body}`) };
}
