import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { PUBLIC_FEEDS, assertPublicFeed, safeExternalUrl } from './public-feed.mjs';
import { writeFeed } from '../scripts/feed-files.mjs';

const fixture = () => ({
  schemaVersion: 1, generatedAt: '2026-10-16T00:00:00.000Z', sources: [],
  items: [{
    id: 'test-notice', title: '虚构测试通知', category: '学校通知', summary: '仅供安全测试。',
    source: '测试来源', sourceType: 'school', sourcePortal: 'https://example.edu/notice',
    publishedAt: '', rewardNote: '', registrationMethod: '', verification: '虚构夹具',
    freshmanAllowed: 'unknown', importance: 'normal', colleges: [], demo: true,
  }],
});

test('公开链接拒绝脚本、嵌入凭证和私有会话参数', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,<script>x</script>', 'file:///C:/private', '//example.com', 'https://u:p@example.com/', 'https://example.com/?token=secret', 'https://example.com/\n']) assert.equal(safeExternalUrl(url), false);
  assert.equal(safeExternalUrl('https://mp.weixin.qq.com/s/example?__biz=public&sn=public'), true);
  assert.equal(safeExternalUrl('http://www.sju.edu.cn/notice.html'), true);
});

test('五份公开模板与虚构记录可通过，敏感字段和异常数据被拒绝', async () => {
  for (const name of PUBLIC_FEEDS) {
    const feed = JSON.parse(await readFile(new URL(`../examples/feeds/${name}`, import.meta.url), 'utf8'));
    assert.doesNotThrow(() => assertPublicFeed(feed));
  }
  const feed = fixture();
  assert.doesNotThrow(() => assertPublicFeed(feed));
  for (const corrupt of [value => { value.token = 'fake'; }, value => { value.items[0].userId = 'fake'; }, value => { value.items[0].sourcePortal = 'javascript:alert(1)'; }, value => { value.items[0].eventStart = 'invalid'; }, value => { value.items[0].colleges = {}; }, value => { value.items[0].attachments = [{ title: '附件', url: 'https://u:p@example.com/' }]; }]) {
    const broken = structuredClone(feed); corrupt(broken);
    assert.throws(() => assertPublicFeed(broken), /已停止发布/);
  }
});

test('实际写入入口在碰到敏感字段或越界文件名时停止发布', async () => {
  const feed = fixture();
  feed.items[0].token = 'test-only-private-value';
  await assert.rejects(writeFeed('pu.json', feed), /已停止发布/);
  await assert.rejects(writeFeed('../private.json', feed), /未知公开数据文件/);
});
