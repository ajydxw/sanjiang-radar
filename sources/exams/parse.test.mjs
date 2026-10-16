import test from 'node:test';
import assert from 'node:assert/strict';
import { examUrl, parseExamList, parseExamArticle } from './parse.mjs';
import { isOpen } from '../../src/lib/information.ts';

const source = { id: 'js-cet', name: '考试院', url: 'https://www.jseea.cn/webfile/certificateexamination_cet/cet_information/' };
const entry = { id: 'exam-1', title: '2026年下半年全国大学英语四、六级考试报名通告', url: 'https://www.jseea.cn/webfile/index/index_zkxx/2026-09-14/1.html', publishedAt: '2026-09-14' };
const html = '<div id="content"><p>2026年下半年大学英语四六级考试有关事项如下，请考生认真核对学校报名资格，省级通知不保证三江学院大一学生可以报名。</p><p>口试考试时间为11月21日至22日。</p><p>笔试考试时间为12月12日。</p><p>江苏省报名时间为9月16日12:00至9月22日17:00止。</p><p>考生应在规定时间内（口试11月17日起，笔试12月1日起）打印准考证。</p><p>考生须及时完成缴费，考场及具体科目以本人准考证为准。</p></div>';

test('已截止报名与仍有效的准考证办理分开，不推断大一资格', () => {
  const [signup, tickets] = parseExamArticle(html, { ...entry, url: `${entry.url};jsessionid=private` }, source, '2026-10-10T00:00:00Z').items;
  const now = new Date('2026-10-10T12:00:00+08:00');
  assert.equal(signup.registrationDeadline, '2026-09-22T17:00:00+08:00');
  assert.equal(signup.eventEnd, '2026-12-12');
  assert.equal(signup.sourcePortal, entry.url);
  assert.equal(isOpen(signup, now), false);
  assert.equal(tickets.registrationDeadline, undefined);
  assert.equal(tickets.eventStart, '2026-11-17');
  assert.match(tickets.registrationNote, /口试：2026年11月17日/);
  assert.match(tickets.registrationNote, /笔试：2026年12月1日/);
  assert.equal(isOpen(tickets, now), true);
  assert.equal(isOpen(tickets, new Date('2026-12-13T00:00:00+08:00')), false);
  assert.equal(tickets.freshmanAllowed, 'unknown');
  const reminderHtml = '<div id="content"><p>2026年9月全国计算机等级考试将于9月19日至21日举行，请已经报名并完成缴费的考生认真准备本人身份证与准考证，核对姓名与证件号码。</p><p>9月7日9:00起打印准考证，仔细核对个人信息，准确掌握考试时间、考点地址等信息。</p></div>';
  const reminder = parseExamArticle(reminderHtml, { ...entry, title: '2026年9月全国计算机等级考试考前提醒' }, source, '2026-10-10T00:00:00Z').items;
  assert.equal(reminder.length, 1);
  assert.equal(reminder[0].eventStart, '2026-09-19');
  assert.equal(isOpen(reminder[0], now), false);
});

test('24时归入次日，缺失和无效的截止日期保持未知', () => {
  const parse = line => parseExamArticle(html.replace('9月16日12:00至9月22日17:00止', line), entry, source, '2026-10-10T00:00:00Z').items[0];
  assert.equal(parse('6月25日9时至7月15日24时').registrationDeadline, '2026-07-16T00:00:00+08:00');
  assert.equal(parse('9月16日12:00起').registrationDeadline, undefined);
  assert.equal(parse('2月1日9时至2月30日17时').registrationDeadline, undefined);
});

test('只接收考试院通知入口，拒绝缺失正文和非办理新闻', () => {
  assert.equal(examUrl('https://example.com/webfile/article.html'), null);
  assert.equal(examUrl('https://user:pass@www.jseea.cn/webfile/article.html'), null);
  assert.equal(examUrl('https://www.jseea.cn/content/redirect.do'), null);
  assert.equal(examUrl('https://www.jseea.cn/content/redirect.do?id=123&token=secret'), 'https://www.jseea.cn/content/redirect.do?id=123');
  const list = '<ul><li><a href="/content/redirect.do?id=123">2026年四六级报名通告<i>2026-09-14</i></a></li><li><a href="/content/redirect.do?id=456">考试顺利举行<i>2026-09-15</i></a></li></ul>';
  assert.equal(parseExamList(list, source).length, 1);
  assert.throws(() => parseExamArticle('<h1>请验证</h1>', entry, source, '2026-10-10T00:00:00Z'), /正文/);
});
