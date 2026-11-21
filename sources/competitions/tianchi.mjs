import { load } from 'cheerio';
import { competitionEligibility } from './parse.mjs';

const origin = 'https://tianchi.aliyun.com';
const api = `${origin}/v3/proxy/competition/api/race`;
const types = { 1: 'AI大模型赛', 2: '数据算法赛', 3: '工程开发赛' };
export const tianchiSource = { id: 'competition-tianchi', name: '阿里云天池', url: `${origin}/competition/` };

function chinaTime(value) {
  if (typeof value !== 'string' || !/^20\d{2}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return undefined;
  const iso = value.replace(' ', 'T') + '+08:00';
  const time = Date.parse(iso);
  return Number.isFinite(time) && new Date(time + 8 * 3600000).toISOString().slice(0, 19) === iso.slice(0, 19) ? iso : undefined;
}

function text(value) {
  if (typeof value !== 'string') return '';
  const $ = load(value);
  $('script,style,img').remove();
  return $('body').text().replace(/\*\*/g, '').trim();
}

function openRace(race, now) {
  return Number.isSafeInteger(race?.raceId) && race.raceId > 0 && race.isSeries !== 1 &&
    race.raceListStatus === 0 && Object.hasOwn(types, race.visualTab) &&
    typeof race.name === 'string' && !/赛后|往届|^【(?:打榜赛|天池经典打榜赛)】/.test(race.name) &&
    Date.parse(chinaTime(race.signupEndTime)) > now;
}

export function tianchiInformation(listing, detail, now) {
  const race = detail?.race;
  if (race?.raceId !== listing.raceId) throw new Error('天池赛事编号不一致');
  if (!openRace(race, now) || race.needInviteCode) return null;
  const registrationDeadline = chinaTime(race.signupEndTime);
  const registrationStart = chinaTime(race.signupStartTime);
  if (registrationStart && Date.parse(registrationStart) >= Date.parse(registrationDeadline)) return null;
  const rules = text(race.introduction);
  if (!rules) throw new Error('赛事规则暂不可读');
  const lines = rules.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
  const earlierTimeline = detail.raceTimeline?.some(phase => /^报名(?:与资格赛|与组队)?$/.test(phase.name) &&
    Date.parse(chinaTime(phase.endTime)) < Date.parse(registrationDeadline));
  const conflictingRule = lines.some(line => {
    if (!/报名(?:时间|截止|组队与实名认证)|报名[与及]组队/.test(line)) return false;
    // Only a dated cutoff or a complete date range can override the list.
    const dates = [...line.matchAll(/(20\d{2})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/g)];
    if (dates.length < 2 && (!/报名截止(?:时间)?/.test(line) || /(?:UTC|协调世界时)/i.test(line))) return false;
    const end = dates.at(-1);
    if (!end) return false;
    const day = `${end[1]}-${end[2].padStart(2, '0')}-${end[3].padStart(2, '0')}`;
    return chinaTime(`${day} 00:00:00`) && day !== registrationDeadline.slice(0, 10);
  });
  if (earlierTimeline || conflictingRule) return null;

  const eligibilityLine = lines.find(line => /^参赛对象\s*[:：]/.test(line));
  const eligibility = competitionEligibility(eligibilityLine || text(listing.introduction));
  if (eligibility.status === 'excluded') return null;
  const undergraduate = eligibilityLine?.match(/(?:面向)?全国在校大学生[^。]{0,85}/)?.[0] ||
    lines.find(line => /^赛事面向全社会开放[，,]包括高校学生/.test(line))?.slice(0, 120);
  const submissionTime = lines.find(line => /^\|\s*(?:发布作品|提交作品|作品提交)\s*\|/.test(line))?.split('|')[2]?.trim();
  return {
    id: `competition-tianchi-${race.raceId}`,
    title: race.name.trim().slice(0, 180),
    category: '竞赛',
    activityType: types[race.visualTab],
    summary: text(listing.introduction).replace(/\s+/g, ' ').slice(0, 300) || '查看官方赛题和参赛规则。',
    source: tianchiSource.name,
    sourceType: 'competition',
    sourcePortal: `${origin}/competition/entrance/${race.raceId}/introduction`,
    publishedAt: '',
    registrationStart,
    registrationDeadline,
    eventStart: chinaTime(race.raceStartTime),
    eventEnd: chinaTime(race.raceEndTime),
    registrationNote: submissionTime ? `官方赛程中的作品提交时间为 ${submissionTime}。` : '作品发布或交卷时间请查看官方赛程。',
    registrationMethod: '打开天池官方赛题页，选择报名并查看组队、提交和实名认证要求。',
    freshmanAllowed: undergraduate ? 'allowed' : eligibility.status,
    eligibilityEvidence: undergraduate || eligibility.evidence,
    colleges: [],
    rewardNote: '奖项与费用按官方规则执行，三江学分、积分认定待核验。',
    importance: 'normal',
    verification: '竞赛官方原文',
    demo: false,
    detailRead: true,
  };
}

export async function collectTianchi(getResponse, now = Date.now()) {
  const getData = async path => {
    const result = JSON.parse((await getResponse(api + path)).toString('utf8'));
    if (result.success !== true || !result.data) throw new Error('天池暂未返回赛事数据');
    return result.data;
  };
  const races = new Map();
  const errors = [];
  for (let page = 1; page <= 5; page++) {
    const data = await getData(`/page?visualTab=&raceName=&pageNum=${page}&isActive=1`);
    if (data.pageNum !== page || !Array.isArray(data.list) || !Number.isSafeInteger(data.total) || data.total < 0 ||
        !Number.isSafeInteger(data.pageSize) || data.pageSize < 1 || data.list.length !== Math.min(data.pageSize, Math.max(0, data.total - (page - 1) * data.pageSize))) {
      throw new Error('天池列表分页数据不完整');
    }
    if (data.list.some(race => !Number.isSafeInteger(race?.raceId) || typeof race.name !== 'string')) throw new Error('天池赛事列表格式已变更');
    for (const race of data.list) if (openRace(race, now)) races.set(race.raceId, race);
    if (page * data.pageSize >= data.total) break;
    if (page === 5) errors.push('仅检查报名列表的前五页');
  }
  const items = [];
  let checked = 0;
  for (const [id, listing] of races) {
    try {
      const item = tianchiInformation(listing, await getData(`/getDetail?raceId=${id}`), now);
      checked++;
      if (item) items.push(item);
    } catch { errors.push(`赛事 ${id} 的详情暂不可读`); }
  }
  if (races.size && !checked) throw new Error('天池参赛规则暂不可读');
  return { items, errors };
}
