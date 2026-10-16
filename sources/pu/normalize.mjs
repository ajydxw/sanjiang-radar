import { load } from 'cheerio';

export function puDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(value)) return undefined;
  const iso = `${value.replace(' ', 'T')}+08:00`;
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime()) || new Date(date.getTime() + 8 * 3600000).toISOString().slice(0, 19) !== value.replace(' ', 'T')) return undefined;
  return iso;
}

function text(value) {
  if (typeof value !== 'string') return '';
  const $ = load(value); $('script,style,iframe').remove();
  return $.text().replace(/\s+/g, ' ').trim();
}

export function puEligibility(years, scope) {
  // The official UI only uses college/year restrictions for scope 1.
  if (Number(scope) !== 1 || !Array.isArray(years) || !years.length) return { value: 'unknown', years: [], evidence: null };
  const labels = years.map(String);
  const parsed = labels.map(label => /^(?:20)?\d{2}(?:级)?$/.test(label.trim()) ? String(2000 + Number(label.replace('级', '').slice(-2))) : null);
  if (parsed.some(year => year === null)) return { value: 'unknown', years: labels, evidence: `PU 活动年级原文：${labels.join('、')}` };
  return { value: parsed.includes('2026') ? 'allowed' : 'excluded', years: [...new Set(parsed)], evidence: `PU 活动年级限制：${[...new Set(parsed)].join('、')}级` };
}

export function toPuInformation(activity, fetchedAt, previous) {
  const base = activity.base;
  const eligibility = puEligibility(activity.allowedYears, base.allowUserType);
  const credit = base.credit !== null && base.credit !== undefined && base.credit !== '' ? Number(base.credit) : NaN;
  const newUnits = activity.creditTipContent?.includes('2024') && activity.creditTipContent.includes('积分');
  const puType = base.puType !== null && base.puType !== undefined ? Number(base.puType) : NaN;
  const reward = Number.isFinite(credit) && credit > 0 && newUnits && [0, 1].includes(puType)
    ? { kind: puType === 1 ? '学时' : 'PU积分', value: credit, unit: puType === 1 ? '' : '分' } : undefined;
  const description = text(base.description).slice(0, 6000);
  const capacity = Number(base.allowUserCount);
  const registered = Number(base.joinUserCount);
  const knownCapacity = Number.isInteger(capacity) && capacity > 0 && Number.isInteger(registered) && registered >= 0;
  const rewardNote = [
    reward ? `PU 活动标示：${reward.value} ${reward.unit}${reward.kind}。` : Number.isFinite(credit) && credit === 0 ? 'PU 活动显示分值为 0。' : Number.isFinite(credit) && credit > 0 ? `PU 显示分值为 ${credit}，奖励类型尚待确认。` : '奖励未明确。',
    activity.creditTipContent || '',
    Number(base.isZyfwActivity) === 1 ? '此活动属于志愿服务，实际志愿时长以 PU 最终认定为准。' : '',
  ].filter(Boolean).join(' ');
  return {
    id: `pu-${activity.id}`, title: text(base.name), category: 'PU活动',
    summary: description.slice(0, 180) || '查看 PU 官方活动详情，核对参与要求及报名安排。',
    description, source: 'PU口袋校园 · 三江学院', sourceType: 'pu',
    sourcePortal: `https://class.pocketuni.net/activity/detail?id=${encodeURIComponent(activity.id)}`,
    publishedAt: '', firstSeenAt: previous?.firstSeenAt || fetchedAt, fetchedAt,
    registrationStart: puDate(base.joinStartTime), registrationDeadline: puDate(base.joinEndTime),
    eventStart: puDate(base.startTime), eventEnd: puDate(base.endTime),
    location: text(base.address) || undefined,
    freshmanAllowed: eligibility.value, eligibleYears: eligibility.years,
    colleges: Number(base.allowUserType) === 1 ? (activity.allowedColleges || []).map(text).filter(Boolean) : [],
    eligibilityEvidence: eligibility.evidence,
    reward, rewardNote, activityType: text(base.categoryName),
    capacity: knownCapacity ? capacity : undefined, registeredCount: knownCapacity ? registered : undefined,
    remainingSlots: knownCapacity ? Math.max(0, capacity - registered) : undefined,
    officialStatus: text(base.statusName) || undefined,
    importance: 'normal', registrationMethod: '前往 PU 官方网页或最新版 PU 应用核对资格并报名。',
    verification: 'PU官方活动', demo: false, manuallyVerified: false,
    detailRead: activity.detailRead, sourceAvailable: true,
  };
}
