import test from 'node:test';
import assert from 'node:assert/strict';
import { wechatUrl, parseWechatArticle } from './parse.mjs';
const article = '<h1 id="activity-name">收藏！三江学院图书馆全攻略</h1><a id="js_name">三江学院</a><time id="publish_time">2026年10月9日 11:00</time><div id="js_content">图书馆借阅服务与开放安排。</div>';
test('official article import preserves source, publication time and unknown deadlines', () => {
  const result = parseWechatArticle(article, 'https://mp.weixin.qq.com/s/example', '2026-10-09T04:00:00Z');
  assert.equal(result.item.publishedAt, '2026-10-09T11:00:00+08:00');
  assert.equal(result.item.sourceType, 'wechat');
  assert.equal(result.item.category, '校园资讯');
  assert.equal(result.item.registrationDeadline, undefined);
  assert.equal(result.item.freshmanAllowed, 'unknown');
});
test('verification pages and other publishers cannot become school articles', () => {
  assert.throws(() => parseWechatArticle('<p>环境异常</p>', 'https://mp.weixin.qq.com/s/example', '2026-10-09T04:00:00Z'));
  assert.throws(() => parseWechatArticle(article.replace('id="js_name">三江学院', 'id="js_name">其他机构'), 'https://mp.weixin.qq.com/s/example', '2026-10-09T04:00:00Z'));
});
test('article links restrict origin and remove login credentials and tracking parameters', () => {
  assert.throws(() => wechatUrl('https://mp.weixin.qq.com.attacker.test/s/example'));
  assert.equal(wechatUrl('https://mp.weixin.qq.com/s?__biz=public&mid=1&idx=1&sn=public&key=PRIVATE&pass_ticket=PRIVATE#redirect'), 'https://mp.weixin.qq.com/s?__biz=public&mid=1&idx=1&sn=public');
});
