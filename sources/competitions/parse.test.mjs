import test from 'node:test';
import assert from 'node:assert/strict';
import { isOpen, deadlineLabel, registrationStatus } from '../../src/lib/information.ts';
import { competitionSources } from './sources.mjs';
import { competitionUrl, competitionEligibility, competitionDates, parseCompetitionList, parseCompetition } from './parse.mjs';

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
