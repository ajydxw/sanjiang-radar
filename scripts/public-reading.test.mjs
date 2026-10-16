import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { createRadarServer } from './serve-radar.mjs';

const item = {
  id: 'reading-test', title: '校园报名通知 <script>alert(1)</script>', category: '学校通知',
  summary: '请核对本期报名事项。', source: '学校官方', sourceType: 'school',
  sourcePortal: 'https://www.sju.edu.cn/notice?a=1&b=2', publishedAt: '2026-10-14',
  registrationDeadline: '2026-10-20', freshmanAllowed: 'unknown', colleges: [],
  rewardNote: '学分尚未核实', importance: 'normal', registrationMethod: '查看官方通知',
  verification: '学校官方原文', demo: false, detailRead: false,
};

async function fixture(t, withFeed = true) {
  const folder = await mkdtemp(join(tmpdir(), 'radar-reading-'));
  const root = join(folder, 'out');
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<html><body>fixture</body></html>');
  if (withFeed) await writeFile(join(root, 'data', 'sanjiang-web.json'), JSON.stringify({
    schemaVersion: 1, generatedAt: '2026-10-14T14:00:00Z', sources: [], items: [item,
      { ...item, id: 'excluded', title: '高年级专属活动', freshmanAllowed: 'excluded' },
      { ...item, id: 'demo', title: '演示活动', demo: true }],
  }));
  const server = await createRadarServer({ root, assistantStore: {}, adminAuth: {}, likesStore: {}, log() {} });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    assert.equal(dirname(folder), resolve(tmpdir()));
    assert.ok(basename(folder).startsWith('radar-reading-'));
    await rm(folder, { recursive: true, force: true });
  });
  return { url: `http://127.0.0.1:${server.address().port}/read`, root };
}

test('reading page exposes current public notices without scripts and preserves eligibility uncertainty', async t => {
  const { url } = await fixture(t);
  const response = await fetch(url);
  const html = await response.text();
  assert.equal(response.status, 200);
  assert.match(html, /校园报名通知 &lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.ok(!html.includes('<script') && !html.includes('高年级专属活动') && !html.includes('演示活动'));
  assert.match(html, /大一资格：未核实/);
  assert.match(html, /2026-10-20/);
  assert.match(html, /a=1&amp;b=2/);
  assert.match(html, /公开快照暂不可读取/);
  assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const head = await fetch(url, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal((await fetch(url, { method: 'POST' })).status, 405);
});

test('missing or non-public data fails closed without returning private fields or paths', async t => {
  const { url, root } = await fixture(t, false);
  await writeFile(join(root, 'data', 'pu.json'), JSON.stringify({
    schemaVersion: 1, generatedAt: '2026-10-14T14:00:00Z', sources: [],
    items: [{ ...item, password: 'private-test-marker' }],
  }));
  const response = await fetch(url);
  const html = await response.text();
  assert.equal(response.status, 503);
  assert.match(html, /所有公开来源目前均不可读取/);
  assert.ok(!html.includes('private-test-marker') && !html.includes(root));
});
