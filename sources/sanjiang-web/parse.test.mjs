import test from 'node:test';
import assert from 'node:assert/strict';
import { classify, officialUrl, parseList, parseArticle, toInformation, listOnlyArticle } from './parse.mjs';

const source = { id: 'school', name: '学校通知', url: 'https://www.sju.edu.cn/scxy/tzgg/list.psp', selector: '.wicket-list a' };
const entry = { id: 'sju-100', url: 'https://www.sju.edu.cn/scxy/a100/page.htm', title: '关于报名的通知', publishedAt: '2026-09-08' };

test('官网正文不可读取时仅展示已确认的列表字段，不补造截止、奖励或资格', () => {
  const article = listOnlyArticle(entry, '2026-10-09T04:00:00Z');
  const information = toInformation(article, source);
  assert.equal(information.title, entry.title);
  assert.equal(information.publishedAt, entry.publishedAt);
  assert.equal(information.detailRead, false);
  assert.equal(information.registrationDeadline, undefined);
  assert.equal(information.reward, undefined);
  assert.equal(information.freshmanAllowed, 'unknown');
  assert(information.summary.includes('正文暂不可读取'));
});

test('列表使用完整标题和发布日期，同一文章不同查询链接只保留一条', () => {
  const html = `<div class="wicket-list"><a href="/scxy/a100/page.htm" title="关于大学生竞赛报名的通知">关于大学生...</a><span>2026-09-08</span></div><div class="wicket-list"><a href="/scxy/a100/page.htm?utm=1" title="关于大学生竞赛报名的通知">关于大学生...</a><span>2026-09-08</span></div>`;
  const records = parseList(html, source);
  assert.equal(records.length, 1);
  assert.equal(records[0].title, '关于大学生竞赛报名的通知');
  assert.equal(records[0].publishedAt, '2026-09-08');
});

test('外部、脚本和带认证信息的链接不会变为官方原文', () => {
  assert.equal(officialUrl('javascript:alert(1)', source.url), null);
  assert.equal(officialUrl('https://www.sju.edu.cn.evil.example/page.htm', source.url), null);
  assert.equal(officialUrl('https://user:secret@www.sju.edu.cn/page.htm', source.url), null);
});

test('只有月份日期的截止说明保留原文，不补年份、时间和学分', () => {
  const article = parseArticle('<div class="wp_articlecontent"><p>请于9月21日前报名。</p><p>可申请课程加分。</p></div>', entry);
  const information = toInformation({ ...article, fetchedAt: '2026-10-08T11:00:00Z' }, source);
  assert.deepEqual(information.dateEvidence, ['请于9月21日前报名。']);
  assert.equal(information.registrationDeadline, undefined);
  assert.equal(information.reward, undefined);
  assert.equal(information.freshmanAllowed, 'unknown');
  assert.equal(information.demo, false);
});

test('针对往届学生的明确限制不会被标为大一可参加', () => {
  const article = parseArticle('<div class="wp_articlecontent"><p>适用于2022级建筑学专业以及2023级学生。</p></div>', entry);
  assert.equal(article.eligibility.status, 'excluded');
  assert.match(article.eligibility.evidence, /2023级/);
});

test('活动回顾和比赛获奖新闻不会进入机会主信息流', () => {
  assert.equal(classify('讲座回顾丨双创系列讲座第96讲').visibility, 'hidden');
  assert.equal(classify('我校学子在全国大学生竞赛中荣获佳绩').visibility, 'hidden');
  assert.equal(classify('关于组织学生参加大学生竞赛的通知').category, '竞赛');
});

test('上课对象中的多个共享级字的年份仍是明确年级限制', () => {
  const article = parseArticle('<div class="wp_articlecontent"><p>上课对象：报名成功的2022、2023级学生（详见附件1）。</p></div>', entry);
  assert.equal(article.eligibility.status, 'excluded');
  const freshman = parseArticle('<div class="wp_articlecontent"><p>面向我校2026级学生。</p></div>', entry);
  assert.equal(freshman.eligibility.status, 'allowed');
});

test('图片通知保留原图提示，结构失效不能当成成功的空通知', () => {
  const article = parseArticle('<div class="wp_articlecontent"><img src="/_upload/poster.jpg"></div>', entry);
  assert.equal(article.images.length, 1);
  assert.match(toInformation(article, source).summary, /图片/);
  assert.throws(() => parseArticle('<h1>新版页面</h1>', entry), /网页结构/);
});

test('不同栏目转载相同正文可用内容指纹去重，正文变化会产生新指纹', () => {
  const html = '<div class="wp_articlecontent"><p>关于报名的说明。</p></div>';
  const first = parseArticle(html, entry);
  const copied = parseArticle(html, { ...entry, url: 'https://www.sju.edu.cn/another/a101/page.htm' });
  const revised = parseArticle(html.replace('说明', '新说明'), entry);
  assert.equal(first.contentHash, copied.contentHash);
  assert.notEqual(first.contentHash, revised.contentHash);
});
