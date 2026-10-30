import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { readFile, stat, mkdir } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright-core';

const root = resolve('out');
const prefix = '/sanjiang-radar';
const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
const fixtureItems = [0, 1].map(index => ({
  id: `static-test-${index}`, title: `静态收藏测试 ${index}`, summary: '用于检验独立收藏和日期，不发布到网站。',
  category: 'PU活动', source: '测试来源', sourceType: 'pu', sourcePortal: 'https://www.sju.edu.cn/',
  publishedAt: '2026-10-29T08:00:00+08:00', registrationDeadline: '2026-10-30T18:00:00+08:00',
  ...(index === 1 ? { eventEnd: '2026-10-29' } : {}),
  freshmanAllowed: 'allowed', colleges: [], importance: 'high', rewardNote: '奖励未明确',
  registrationMethod: '查看官方原文', verification: '测试', demo: false,
}));

async function setup(t) {
  const errors = [], api = [], badResponses = [];
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      if (!pathname.startsWith(`${prefix}/`)) throw new Error();
      let file = resolve(root, `.${pathname.slice(prefix.length)}`);
      if (!file.startsWith(`${root}${sep}`) && file !== root) throw new Error();
      if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
      const data = await readFile(file);
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' }); res.end(data);
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  t.after(async () => {
    await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done));
    assert.deepEqual(errors, []); assert.deepEqual(api, []); assert.deepEqual(badResponses, []);
  });
  const origin = `http://127.0.0.1:${server.address().port}${prefix}/`;
  async function visitor({ fixture = false, blockedStorage = false, hash = 'radar', welcome = false, profile, time = '2026-10-29T12:00:00+08:00', reducedMotion = 'reduce' } = {}) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion, timezoneId: 'America/Los_Angeles', acceptDownloads: true,
      ...(profile ? { storageState: { cookies: [], origins: [{ origin: new URL(origin).origin, localStorage: [{ name: 'sanjiang-radar-demo-v1', value: JSON.stringify(profile) }] }] } } : {}),
    });
    if (fixture) await context.route('**/data/*.json', route => route.fulfill({ json: {
      schemaVersion: 1, generatedAt: '2026-10-29T08:00:00+08:00',
      items: route.request().url().endsWith('pu.json') ? fixtureItems : [], sources: [],
    } }));
    if (blockedStorage) await context.addInitScript(() => {
      Storage.prototype.getItem = Storage.prototype.setItem = () => { throw new DOMException('Storage blocked', 'SecurityError'); };
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', req => { if (new URL(req.url()).pathname.includes('/api/')) api.push(req.url()); });
    page.on('response', res => { if (res.status() >= 400) badResponses.push(`${res.status()} ${res.url()}`); });
    await page.clock.install({ time: new Date(time) });
    await page.goto(`${origin}#${hash}`, { waitUntil: 'networkidle' });
    if (!welcome && await page.getByRole('button', { name: '直接浏览', exact: true }).isVisible()) {
      await page.getByRole('button', { name: '直接浏览', exact: true }).click();
    }
    await page.waitForFunction(() => !document.querySelector('.feed-warning') && document.querySelector('.hero') || document.querySelector('.discovery-controls') || document.querySelector('.settings-panel') || document.querySelector('.results-header'));
    return page;
  }
  return { visitor };
}
const nav = (page, label) => page.getByRole('navigation', { name: '手机主导航' }).getByRole('button', { name: new RegExp(`^${label}`) }).click();

test('Pages 子路径读取真实快照、无后端请求、手机桌面布局', async t => {
  const { visitor } = await setup(t);
  const page = await visitor();
  await nav(page, '发现');
  await page.waitForFunction(() => document.querySelectorAll('.results-grid .event-card').length > 0);
  assert.equal(await page.getByText('生活助手', { exact: true }).count(), 0);
  assert.equal(await page.getByText('大家都在点赞', { exact: true }).count(), 0);
  for (const width of [320, 390, 768, 1366]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `宽度 ${width}`);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await nav(page, '今日雷达');
  await mkdir('.sites-runtime', { recursive: true });
  await page.screenshot({ path: '.sites-runtime/pages-mobile.png', fullPage: true });
});

test('搜索、收藏刷新持久化、浏览器隔离、日历与到期自动隐藏', async t => {
  const { visitor } = await setup(t);
  const a = await visitor({ fixture: true, hash: 'discover' });
  await a.getByRole('searchbox', { name: '搜索校园信息' }).fill('静态收藏测试 0');
  assert.equal(await a.locator('.results-grid .event-card').count(), 1);
  await a.getByRole('button', { name: `收藏：${fixtureItems[0].title}`, exact: true }).click();
  await a.getByRole('searchbox', { name: '搜索校园信息' }).fill('');
  await a.getByRole('button', { name: `收藏：${fixtureItems[1].title}`, exact: true }).click();
  await a.reload({ waitUntil: 'networkidle' });
  await nav(a, '收藏');
  assert.equal(await a.locator('.results-grid .event-card').count(), 2);
  const download = a.waitForEvent('download');
  await a.getByRole('button', { name: '导出日历提醒', exact: true }).click();
  const calendar = await readFile(await (await download).path(), 'utf8');
  assert.match(calendar, /BEGIN:VCALENDAR/); assert.match(calendar, /BEGIN:VALARM/);
  const b = await visitor({ fixture: true }); await nav(b, '收藏');
  assert.equal(await b.locator('.results-grid .event-card').count(), 0);
  await nav(a, '今日雷达');
  assert.equal(await a.locator('.community-likes .event-card').count(), 2);
  await a.clock.setSystemTime(new Date('2026-10-31T12:00:00+08:00'));
  await a.clock.fastForward(60000);
  await a.waitForFunction(() => document.querySelectorAll('.community-likes .event-card').length === 0);
  await nav(a, '收藏');
  assert.equal(await a.locator('.results-grid .event-card').count(), 2);
  await a.getByRole('button', { name: `取消收藏：${fixtureItems[0].title}`, exact: true }).click();
  assert.equal(await a.locator('.results-grid .event-card').count(), 1);
});

test('禁用浏览器存储时仍能浏览并提示收藏仅本次有效', async t => {
  const { visitor } = await setup(t);
  const page = await visitor({ fixture: true, blockedStorage: true, hash: 'discover' });
  await page.getByText(/浏览器暂时无法完整保存记录/).waitFor();
  await page.getByRole('button', { name: `收藏：${fixtureItems[0].title}`, exact: true }).click();
  await nav(page, '收藏');
  assert.equal(await page.locator('.results-grid .event-card').count(), 1);
});



test('手机专业随学院切换，旧手填资料和收藏在刷新后保留', async t => {
  const { visitor } = await setup(t);
  const page = await visitor({ hash: 'profile', profile: { favorites: ['old-item'], profile: { college: '建筑学院', major: '旧手填专业', interests: ['竞赛'] } } });
  const college = page.getByLabel('学院', { exact: true });
  const major = page.getByLabel('专业', { exact: true });
  assert.equal(await page.getByLabel('填写专业名称').inputValue(), '旧手填专业');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await page.getByLabel('填写专业名称').inputValue(), '旧手填专业');
  await major.selectOption({ label: '风景园林' });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('sanjiang-radar-demo-v1')).profile.major === '风景园林');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await major.inputValue(), '风景园林');
  await college.selectOption({ label: '计算机科学与工程学院' });
  assert.equal(await major.inputValue(), '');
  assert.equal(await major.locator('option', { hasText: '风景园林' }).count(), 0);
  assert.equal(await major.locator('option', { hasText: '软件工程' }).count(), 1);
  await major.selectOption({ label: '软件工程' });
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('sanjiang-radar-demo-v1')).profile.major === '软件工程');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await college.inputValue(), '计算机科学与工程学院');
  assert.equal(await major.inputValue(), '软件工程');
  assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('sanjiang-radar-demo-v1'))), {
    favorites: ['old-item'], profile: { college: '计算机科学与工程学院', major: '软件工程', interests: ['竞赛'] },
  });
});

test('旧未知学院和手填专业保留，主动切换学院后清空专业', async t => {
  const { visitor } = await setup(t);
  const page = await visitor({ hash: 'profile', profile: { favorites: [], profile: { college: '旧学院名称', major: '旧手填专业', interests: [] } } });
  const college = page.getByLabel('学院', { exact: true });
  const major = page.getByLabel('专业', { exact: true });
  assert.equal(await college.inputValue(), '旧学院名称');
  assert.equal(await page.getByLabel('填写专业名称').inputValue(), '旧手填专业');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await college.inputValue(), '旧学院名称');
  assert.equal(await page.getByLabel('填写专业名称').inputValue(), '旧手填专业');
  await college.selectOption({ label: '建筑学院' });
  assert.equal(await major.inputValue(), '');
  assert.equal(await page.getByLabel('填写专业名称').count(), 0);
  await page.waitForFunction(() => JSON.parse(localStorage.getItem('sanjiang-radar-demo-v1')).profile.college === '建筑学院');
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await college.inputValue(), '建筑学院');
  assert.equal(await major.inputValue(), '');
});

test('手机开屏展示标题与入口，身份未开放，返回和直接浏览可用', async t => {
  const { visitor } = await setup(t);
  const page = await visitor({ welcome: true, reducedMotion: 'no-preference' });
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  await page.locator('.welcome-entry').evaluate(el => Promise.all(el.getAnimations().map(animation => animation.finished)));
  assert.equal(await dialog.getByRole('heading', { name: '三江雷达.' }).count(), 1);
  assert.ok(await dialog.getByRole('button', { name: '直接浏览', exact: true }).isVisible());
  await dialog.getByRole('button', { name: /姓名＋学号确认/ }).click();
  assert.ok(await dialog.getByText(/姓名＋学号确认暂未开放/).isVisible());
  await mkdir('.sites-runtime', { recursive: true });
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    await page.screenshot({ path: `.sites-runtime/welcome-identity-${width}.png` });
  }
  assert.equal(await dialog.locator('input, form').count(), 0);
  await dialog.getByRole('button', { name: '返回入口' }).click();
  await dialog.getByRole('button', { name: '直接浏览', exact: true }).click();
  assert.equal(await dialog.count(), 0);
  await page.reload({ waitUntil: 'networkidle' });
  assert.equal(await dialog.count(), 0);
  await nav(page, '发现');
  await page.goBack({ waitUntil: 'networkidle' });
  assert.equal(await dialog.count(), 0);
});

test('跳过开屏、减少动态与深链直达', async t => {
  const { visitor } = await setup(t);
  const page = await visitor({ welcome: true });
  const dialog = page.getByRole('dialog');
  await dialog.waitFor({ state: 'visible' });
  assert.equal(await page.locator('.welcome-sweep').evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.ok(await dialog.getByRole('button', { name: '直接浏览', exact: true }).isVisible());
  await dialog.getByRole('button', { name: '跳过开屏' }).click();
  assert.equal(await dialog.count(), 0);
  for (const hash of ['profile', 'discover', 'saved']) {
    const deep = await visitor({ hash, welcome: true });
    assert.equal(await deep.getByRole('dialog').count(), 0, hash);
    assert.equal(new URL(deep.url()).hash, '#' + hash);
  }
});

test('开屏问候使用北京时间并按四周轮换', async t => {
  const { visitor } = await setup(t);
  const greetings = [];
  for (const date of ['2026-10-26', '2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23']) {
    const page = await visitor({ welcome: true, time: date + 'T00:00:00Z' });
    greetings.push(await page.locator('.welcome-greeting').innerText());
  }
  assert.equal(new Set(greetings.slice(0, 4)).size, 4);
  assert.equal(greetings[0], greetings[4]);
  assert.ok(greetings.every(text => text.startsWith('周一')));
  const evening = await visitor({ welcome: true, time: '2026-10-30T10:00:00Z' });
  assert.equal(await evening.locator('.welcome-greeting').innerText(), '月光下的对话');
});
