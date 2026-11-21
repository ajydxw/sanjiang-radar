import test from 'node:test';
import assert from 'node:assert/strict';
import { isOpen, deadlineLabel, registrationStatus } from '../../src/lib/information.ts';
import { competitionSources } from './sources.mjs';
import { competitionUrl, competitionEligibility, competitionDates, parseCompetitionList, parseCompetition } from './parse.mjs';
import { collectTianchi, tianchiInformation } from './tianchi.mjs';
import { aiDaxueInformation, modelScopeInformation } from './project-contests.mjs';

test('only same-host HTTPS official links are accepted', () => {
  const base = 'https://www.cms.org.cn/';
  assert.equal(competitionUrl('/notice.pdf', base), base + 'notice.pdf');
  for (const url of ['https://elsewhere.example/a', 'javascript:alert(1)', 'http://www.cms.org.cn/a', 'https://user:pass@www.cms.org.cn/a']) assert.equal(competitionUrl(url, base), null);
});

test('discovery skips results, reports and external links', () => {
  const source = { ...competitionSources[0], seeds: [] };
  const html = '<li><a href="/Home/comp/comp_details/id/1.html">关于举办全国大学生数学竞赛的通知</a>2026-10-08</li><li><a href="/Home/comp/comp_details/id/2.html">全国大学生数学竞赛获奖名单</a></li><a href="https://elsewhere.example/a.pdf">全国大学生数学竞赛报名</a>';
  const entries = parseCompetitionList(html, source);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].publishedAt, '2026-10-08');
});

test('freshman eligibility stays conservative and retains additional conditions', () => {
  assert.equal(competitionEligibility('1、竞赛对象：面向 全国在校 大学生。').status, 'allowed');
  assert.equal(competitionEligibility('1、参赛对象：\n所有全日制在校大学生。').status, 'allowed');
  const qualified = competitionEligibility('七、参赛资格：面向全国高校在校生，须取得 CSP 成绩200分及以上。');
  assert.equal(qualified.status, 'allowed');
  assert.match(qualified.evidence, /200分/);
  assert.equal(competitionEligibility('仅限大二、大三学生报名。').status, 'excluded');
  assert.equal(competitionEligibility('不接受大一学生报名。').status, 'excluded');
  assert.equal(competitionEligibility('参赛对象：面向2025级学生。').status, 'excluded');
  assert.equal(competitionEligibility('大学生报名，请咨询老师。').status, 'unknown');
});

test('registration ranges retain exact times and inherit a year only from their range', () => {
  const timed = competitionDates('报名时间：2026年10月8日10:00—2026年12月18日14:00。');
  assert.equal(timed.registrationStart, '2026-10-08T10:00:00+08:00');
  assert.equal(timed.registrationDeadline, '2026-12-18T14:00:00+08:00');
  assert.equal(competitionDates('报名时间为2026年9月9日-10月11日。').registrationDeadline, '2026-10-11');
  assert.equal(competitionDates('报名时间：2026年12月1日至1月20日。').registrationDeadline, '2027-01-20');
  assert.equal(competitionDates('报名时间：2026年2月30日至3月1日。').registrationDeadline, undefined);
  assert.equal(competitionDates('初赛于2026年11月14日举行。').registrationDeadline, undefined);
  const before = competitionDates('报名办法：2026年10月19日前，按所在赛区要求报名。');
  assert.equal(before.registrationDeadline, undefined);
  assert.match(before.evidence, /10月19日前/);
});

test('all matching sections are read without inventing an exact deadline from months', () => {
  const source = competitionSources.find(source => source.id === 'competition-design');
  const html = '<div class="main-container">通知公告，十八届赛事已启动，学校同学请关注相关参赛要求和赛事安排。</div><div class="main-container">参赛对象：具有正式全日制学籍并且符合相关报名要求的研究生、本科生和高职高专学生。18届赛事日程：2026年10月—2027年4月。每队由1–3人组成，不允许跨学校组队，作品须按照官网规格和要求提交。</div>';
  const item = parseCompetition(html, { url: source.url }, source);
  assert.equal(item.freshmanAllowed, 'allowed');
  assert.equal(item.registrationDeadline, undefined);
  assert.equal(item.publishedAt, '');
  assert.equal(item.demo, false);
});

test('the same annual competition at different official URLs has one stable identity', () => {
  const source = competitionSources.find(source => source.id === 'competition-ccsp');
  const html = '<div class="detailbox">2026-09-09 参赛资格：面向全国高校在校生，以 CSP 成绩200分及以上作为审核条件。报名时间：2026年9月9日-10月11日。选手可以按官方要求自行报名或者通过学校团体报名，缴费后等待资格审核，并核对官方比赛安排。</div>';
  const a = parseCompetition(html, { url: source.seeds[0].url, title: '2026 CCF CCSP报名通知' }, source);
  const b = parseCompetition(html, { url: 'https://www.ccf.org.cn/ccsp/tzgg/2026-09-09/931080.shtml', title: '2026 CCF CCSP开启报名' }, source);
  assert.equal(a.id, b.id);
});

test('calendar-only deadlines remain valid through the stated China date', () => {
  const item = { registrationStart: '2026-10-08', registrationDeadline: '2026-10-11' };
  const lastAfternoon = new Date('2026-10-11T15:00:00+08:00');
  assert.equal(isOpen(item, lastAfternoon), true);
  assert.equal(deadlineLabel(item.registrationDeadline, lastAfternoon), '今天截止');
  assert.equal(registrationStatus(item, lastAfternoon), 'open');
  assert.equal(isOpen(item, new Date('2026-10-12T00:00:00+08:00')), false);
  assert.equal(registrationStatus(item, new Date('2026-10-08T00:01:00+08:00')), 'open');
  assert.equal(isOpen({ registrationDeadline: '2026-12-18T14:00:00+08:00' }, new Date('2026-12-18T14:01:00+08:00')), false);
});

test('Tianchi uses signup dates and checks conflicts against the official rules', () => {
  const now = Date.parse('2026-11-21T10:00:00+08:00');
  const listing = { raceId: 532536, name: 'Qoder 高校创造力大赛', raceListStatus: 0, visualTab: 1,
    signupStartTime: '2026-10-29 00:00:00', signupEndTime: '2026-11-30 18:00:00', raceEndTime: '2026-12-15 18:00:00',
    introduction: '在线提交学生项目。' };
  const race = { ...listing, introduction: '参赛对象：全国在校大学生，不限专业。\n| 发布作品 | 11 月 30 日 18:00 截止 | 在天池发布 |' };
  const item = tianchiInformation(listing, { race }, now);
  assert.equal(item.registrationDeadline, '2026-11-30T18:00:00+08:00');
  assert.equal(item.eventEnd, '2026-12-15T18:00:00+08:00');
  assert.equal(item.freshmanAllowed, 'allowed');
  assert.equal(item.activityType, 'AI大模型赛');
  assert.match(item.registrationNote, /作品提交.*11 月 30 日 18:00/);
  assert.equal(tianchiInformation(listing, { race, raceTimeline: [{ name: '报名与资格赛', endTime: '2026-10-21 14:00:00' }] }, now), null);
  assert.equal(tianchiInformation(listing, { race: { ...race, introduction: '报名组队与实名认证（2026年7月30日—2026年10月21日）' } }, now), null);
  assert.equal(tianchiInformation(listing, { race: { ...race, needInviteCode: true } }, now), null);
  assert.equal(tianchiInformation(listing, { race: { ...race, signupEndTime: '2026-11-31 18:00:00' } }, now), null);
});

test('Tianchi uses page totals when its hasNextPage flag is false', async () => {
  const calls = [];
  const { items, errors } = await collectTianchi(path => {
    const page = Number(new URL(path).searchParams.get('pageNum'));
    calls.push(page);
    return Buffer.from(JSON.stringify({ success: true, data: {
      pageNum: page, pageSize: 1, total: 2, hasNextPage: false,
      list: [{ raceId: page, name: '系列赛事', isSeries: 1 }],
    } }));
  });
  assert.deepEqual(calls, [1, 2]);
  assert.deepEqual(items, []);
  assert.deepEqual(errors, []);
});

test('ModelScope keeps project registration and submission deadlines distinct', () => {
  const now = Date.parse('2026-11-21T10:00:00+08:00');
  const event = {
    Id: 394, Title: 'AI造游戏，人人都是游戏制作人｜AI+∞开发者创作大赛第三期',
    EventType: 'competition', Category: 'application', PublishStatus: 1, Status: 1,
    RegistrationDeadline: Date.parse('2026-12-01T18:00:00+08:00') / 1000,
    Content: JSON.stringify([{ content: ['p', {}, '创作原创游戏，发布到魔搭创空间。'] }]),
  };
  const item = modelScopeInformation(event, now);
  assert.equal(item.activityType, 'AI项目赛');
  assert.equal(item.registrationDeadline, '2026-12-01T12:00:00+08:00');
  assert.equal(item.submissionDeadline, '2026-12-01T18:00:00+08:00');
  assert.equal(modelScopeInformation(event, Date.parse('2026-12-01T12:01:00+08:00')), null);
  assert.throws(() => modelScopeInformation({ ...event, RegistrationDeadline: event.RegistrationDeadline + 86400 }, now), /需重新核对/);
  const restricted = { ...event, Id: 123, Content: JSON.stringify([{ content: ['p', {}, '原创应用全程线上，提交作品。仅限本校学生。'] }]) };
  assert.equal(modelScopeInformation(restricted, now), null);
});

test('AI 大学堂保留相冲突的阶段说明，不将创作展示时间当成提交截止', () => {
  const text = '面向全国高校生的 AStudio应用创作赛\n立即报名参赛\n作品创作及展示\n10月15日-12月15日\n至12月31日结束，报名和交作品在整个活动期内都开放';
  const item = aiDaxueInformation(text, Date.parse('2026-11-21T12:00:00+08:00'));
  assert.equal(item.freshmanAllowed, 'allowed');
  assert.equal(item.registrationDeadline, undefined);
  assert.equal(item.submissionDeadline, undefined);
  assert.match(item.registrationNote, /12 月 15 日.*12月31日/);
  assert.equal(aiDaxueInformation(text, Date.parse('2026-12-16T09:00:00+08:00')), null);
});
