import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { createRadarServer } from './serve-radar.mjs';
import { createLikeStore } from './activity-likes.mjs';
import { createAssistantStore } from './assistant-questions.mjs';
import { createAdminAuth } from './admin-auth.mjs';
import { VISIT_GAP, VISIT_STORAGE_KEY } from '../src/lib/visit-history.ts';

test('首页和发现页显示上次访问之后新收集的信息，刷新、私人关注及学院筛选正常', async () => {
  const runtime = resolve('.sites-runtime');
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(resolve(runtime, 'radar-visit-browser-test-'));
  let server;
  let browser;
  try {
    const likesStore = await createLikeStore({ directory: resolve(directory, 'likes'), getAllowedIds: async () => new Set(['old', 'new', 'secondary', 'senior', 'other-college']) });
    const assistantStore = await createAssistantStore({ directory: resolve(directory, 'questions') });
    const adminAuth = await createAdminAuth({ directory: resolve(directory, 'auth') });
    server = await createRadarServer({ likesStore, assistantStore, adminAuth, log: () => {} });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const template = JSON.parse(await readFile('public/data/sanjiang-web.json', 'utf8')).items[0];
    const item = (id, changes = {}) => ({ ...template, id, title: `测试通知 ${id}`, publishedAt: '2020-01-01', registrationDeadline: undefined, eventEnd: undefined, sourceAvailable: true, freshmanAllowed: 'allowed', importance: 'normal', colleges: [], ...changes });
    let schoolItems = [item('old')];
    let puItems = [];
    const emptyFeed = { schemaVersion: 1, generatedAt: new Date().toISOString(), items: [], sources: [{ id: 'test', name: '隔离测试来源', url: 'https://www.sju.edu.cn/', state: 'ok', count: 0, lastSuccessAt: new Date().toISOString() }] };
    const configure = async context => {
      await context.route('**/data/*.json', route => {
        const path = new URL(route.request().url()).pathname;
        const items = path.endsWith('/sanjiang-web.json') ? schoolItems : path.endsWith('/pu.json') ? puItems : [];
        return route.fulfill({ json: { ...emptyFeed, items } });
      });
    };
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
    const firstContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    await configure(firstContext);
    const firstPage = await firstContext.newPage();
    await firstPage.goto(origin, { waitUntil: 'networkidle' });
    await firstPage.waitForFunction(key => JSON.parse(localStorage.getItem(key) ?? 'null')?.seen['/data/sanjiang-web.json']?.includes('old'), VISIT_STORAGE_KEY);
    assert.match(await firstPage.getByRole('region', { name: '上次来看之后新增' }).innerText(), /新增 0/);
    assert.match(await firstPage.getByRole('region', { name: '上次来看之后新增' }).innerText(), /首次访问/);
    const history = JSON.parse(await firstPage.evaluate(key => localStorage.getItem(key), VISIT_STORAGE_KEY));
    history.activeAt = new Date(Date.now() - VISIT_GAP - 60000).toISOString();
    await firstContext.close();

    schoolItems = [item('old'), item('new', { registrationDeadline: '2020-01-02' }), item('secondary', { importance: 'secondary' }), item('senior', { freshmanAllowed: 'excluded' })];
    puItems = [item('other-college', { sourceType: 'pu', category: 'PU活动', colleges: ['计算机科学与工程学院'] })];
    const profile = { favorites: ['old'], profile: { college: '建筑学院', major: '建筑学', interests: [] } };
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true,
      storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: VISIT_STORAGE_KEY, value: JSON.stringify(history) }, { name: 'sanjiang-radar-demo-v1', value: JSON.stringify(profile) }] }] } });
    await configure(context);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin, { waitUntil: 'networkidle' });
    const panel = page.getByRole('region', { name: '上次来看之后新增' });
    await page.waitForFunction(() => document.querySelector('.visit-panel strong')?.textContent === '1');
    assert.match(await panel.innerText(), /上次访问/);
    await panel.getByRole('button', { name: '查看新增' }).click();
    const newFilter = page.getByRole('button', { name: '上次来看之后新增', exact: true });
    assert.equal(await newFilter.getAttribute('aria-pressed'), 'true');
    assert.equal(await page.getByRole('button', { name: '仅未截止', exact: true }).getAttribute('aria-pressed'), 'false', '新增入口包含已过截止的补收信息，避免隐藏遗漏');
    assert.equal(await page.locator('.results-grid .event-card').count(), 1);
    assert.match(await page.locator('.results-grid').innerText(), /测试通知 new/);
    assert.match(await page.locator('.results-grid').innerText(), /新收集/);
    assert.match(await page.locator('.results-grid').innerText(), /2020/);
    await page.getByRole('button', { name: '与我的学院相关', exact: true }).click();
    assert.equal(await page.locator('.results-grid .event-card').count(), 2);
    assert.doesNotMatch(await page.locator('.results-grid').innerText(), /测试通知 senior|测试通知 secondary/);
    assert.deepEqual(JSON.parse(await page.evaluate(() => localStorage.getItem('sanjiang-radar-demo-v1'))), profile, '新增记录不覆盖原有收藏和资料');

    await page.reload({ waitUntil: 'networkidle' });
    await page.getByRole('button', { name: '三江雷达首页', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.visit-panel strong')?.textContent === '1');
    await page.getByRole('navigation', { name: '手机主导航' }).getByRole('button', { name: '点赞' }).click();
    await page.getByRole('heading', { name: '一颗爱心，好活动一起看。', exact: true }).waitFor();
    assert.equal(await page.locator('.results-grid .event-card').count(), 0, '原私人关注不会自动成为公开点赞');
    await page.locator('.legacy-watchlist > summary').click();
    assert.match(await page.locator('.legacy-watchlist').innerText(), /测试通知 old/);
    const summary = await page.evaluate(() => fetch('/api/likes').then(response => response.json()));
    assert.equal(summary.counts.old, 0);
    assert.deepEqual(summary.likedIds, []);

    await page.getByRole('button', { name: '三江雷达首页', exact: true }).click();
    for (const width of [320, 390, 768, 1366]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `宽度 ${width} 无横向溢出`);
    }
    assert.deepEqual(errors, []);
    await context.close();

    const blockedContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    await configure(blockedContext);
    await blockedContext.addInitScript(() => { Storage.prototype.setItem = () => { throw new DOMException('blocked', 'SecurityError'); }; });
    const blockedPage = await blockedContext.newPage();
    await blockedPage.goto(origin, { waitUntil: 'networkidle' });
    await blockedPage.locator('.storage-warning').waitFor();
    assert.match(await blockedPage.getByRole('region', { name: '上次来看之后新增' }).innerText(), /新增 0/);
    await blockedContext.close();
  } finally {
    await browser?.close();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    const inside = relative(runtime, directory);
    assert.ok(inside.startsWith('radar-visit-browser-test-') && !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`));
    await rm(directory, { recursive: true, force: true });
  }
});
