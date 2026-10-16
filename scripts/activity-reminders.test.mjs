import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { createRadarServer } from './serve-radar.mjs';
import { createAssistantStore } from './assistant-questions.mjs';
import { createAdminAuth } from './admin-auth.mjs';
import { createLikeStore } from './activity-likes.mjs';

const savedKey = 'sanjiang-radar-demo-v1';
const reminderKey = 'sanjiang-radar-reminders-v1';
const profile = { college: '建筑学院', major: '建筑学', interests: [] };
const title = '隔离测试：二十人工作坊';
const base = {
  category: 'PU活动', summary: '仅用于隔离浏览器回归，不是真实校园活动。',
  source: '隔离测试来源', sourceType: 'pu', sourcePortal: 'https://www.sju.edu.cn/',
  publishedAt: new Date().toISOString(), fetchedAt: '2026-10-13T10:00:00+08:00', freshmanAllowed: 'allowed', colleges: [],
  rewardNote: '奖励以官方认定为准', importance: 'high', registrationMethod: '前往 PU 报名',
  verification: 'PU官方活动', demo: false, detailRead: true,
};
const items = [
  { ...base, id: 'timed', title, location: '隔离测试教室 A-101', capacity: 20, registeredCount: 17, remainingSlots: 3,
    registrationStart: '2099-01-10T09:00:00+08:00', registrationDeadline: '2099-01-12T17:00:00+08:00' },
  { ...base, id: 'day', title: '隔离测试：仅公布截止日期', registrationDeadline: '2099-01-20' },
  { ...base, id: 'unknown', title: '隔离测试：报名时间未知' },
  { ...base, id: 'full', title: '隔离测试：名额已满', capacity: 20, registeredCount: 20, remainingSlots: 0,
    registrationStart: '2099-01-10T09:00:00+08:00', registrationDeadline: '2099-01-12T17:00:00+08:00' },
];

async function withBrowser(favorites, run) {
  const runtime = resolve('.sites-runtime');
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(resolve(runtime, 'radar-reminders-browser-test-'));
  let server;
  let browser;
  try {
    const assistantStore = await createAssistantStore({ directory: resolve(directory, 'questions') });
    const adminAuth = await createAdminAuth({ directory: resolve(directory, 'auth') });
    const likesStore = await createLikeStore({ directory: resolve(directory, 'likes'), getAllowedIds: async () => new Set(items.map(item => item.id)) });
    server = await createRadarServer({ assistantStore, adminAuth, likesStore, log: () => {} });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true,
      storageState: { cookies: [], origins: [{ origin, localStorage: [{ name: savedKey, value: JSON.stringify({ favorites, profile }) }] }] } });
    const feedRequests = new Set();
    await context.route('**/data/*.json', route => {
      const pathname = new URL(route.request().url()).pathname;
      feedRequests.add(pathname);
      return route.fulfill({ json: { schemaVersion: 1, generatedAt: new Date().toISOString(),
        items: pathname.endsWith('/sanjiang-web.json') ? items : [],
        sources: [{ id: pathname, name: '隔离测试来源', url: 'https://www.sju.edu.cn/', state: 'ok', count: pathname.endsWith('/sanjiang-web.json') ? items.length : 0, lastSuccessAt: new Date().toISOString() }] } });
    });
    const page = await context.newPage();
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => requests.push(request.url()));
    await page.goto(`${origin}/#saved`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '一颗爱心，好活动一起看。', exact: true }).waitFor();
    await run(page);
    const summary = await page.evaluate(() => fetch('/api/likes').then(response => response.json()));
    assert.equal(summary.counts['legacy-missing'], undefined, '不存在的旧关注不会公开');
    for (const id of favorites) assert.equal(summary.counts[id] ?? 0, 0, '未点击爱心的旧关注不会自动公开');
    assert.equal(feedRequests.size, 5, '五个公开数据源全部由隔离 fixture 响应');
    assert.deepEqual(errors, []);
    assert.ok(requests.every(url => new URL(url).origin === origin), '没有请求第三方服务');
    await context.close();
  } finally {
    await browser?.close();
    if (server?.listening) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    const inside = relative(runtime, directory);
    assert.ok(inside.startsWith('radar-reminders-browser-test-') && !isAbsolute(inside) && inside !== '..' && !inside.startsWith(`..${sep}`));
    await rm(directory, { recursive: true, force: true });
  }
}

async function calendar(page, button) {
  const [download] = await Promise.all([page.waitForEvent('download'), button.click()]);
  assert.match(download.suggestedFilename(), /\.ics$/);
  const contents = await readFile(await download.path(), 'utf8');
  assert.match(contents, /^BEGIN:VCALENDAR\r\n/);
  assert.match(contents, /\r\nEND:VCALENDAR\r\n$/);
  return contents.replace(/\r\n[ \t]/g, '');
}

async function storage(page, key) {
  return JSON.parse(await page.evaluate(key => localStorage.getItem(key), key));
}

async function widths(page) {
  for (const width of [320, 390, 768, 1366]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `宽度 ${width} 无横向溢出`);
    const nav = page.getByRole('navigation', { name: '手机主导航', includeHidden: true });
    assert.equal(await nav.locator('button').count(), 4);
    assert.deepEqual(await nav.locator('button > span').allTextContents(), ['今日雷达', '发现', '点赞', '我的']);
  }
  await page.setViewportSize({ width: 390, height: 844 });
}

test('点赞真实流程导出具体时间及 VALARM，独立提醒偏好不损坏原有关注和专业，刷新保留', async () => {
  await withBrowser(['legacy-missing'], async page => {
    await page.getByRole('navigation', { name: '手机主导航' }).getByRole('button', { name: '发现', exact: true }).click();
    const card = page.locator('.event-card').filter({ has: page.getByRole('heading', { name: title, exact: true }) });
    await page.waitForFunction(() => document.querySelector('.like-button')?.disabled === false);
    await card.getByRole('button', { name: `点赞：${title}，0 个赞`, exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.like-button[aria-busy="true"]') === null);
    await page.getByRole('navigation', { name: '手机主导航' }).getByRole('button', { name: /^点赞/ }).click();
    const panel = page.getByRole('region', { name: '我关注的活动提醒' });
    const exportButton = panel.getByRole('button', { name: '导出日历提醒', exact: true });
    assert.equal(await exportButton.isEnabled(), true);
    assert.match(await panel.innerText(), /20 人名额.*剩 3 个/s);
    assert.match(await panel.innerText(), /名额是同步时的快照/);
    const ics = await calendar(page, exportButton);
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 2);
    assert.equal((ics.match(/BEGIN:VALARM/g) || []).length, 5);
    for (const at of ['20990110T005000Z', '20990110T010000Z', '20990111T090000Z', '20990112T080000Z', '20990112T090000Z']) {
      assert.match(ics, new RegExp(`TRIGGER;VALUE=DATE-TIME:${at}`));
    }
    assert.match(ics, /DTSTART:20990110T010000Z/);
    assert.match(ics, /DTSTART:20990112T090000Z/);
    assert.match(ics, /快照.*非实时/);
    assert.match(ics, /隔离测试教室 A-101/);
    assert.match(ics, /20.*3/);
    assert.match(ics, /同步时间/);
    await widths(page);
    await page.locator('.results-grid .card-main').click();
    const dialog = page.getByRole('dialog');
    assert.match(await dialog.innerText(), /隔离测试教室 A-101/);
    assert.match(await dialog.innerText(), /容量 20 人.*剩余 3 个（同步时）/);
    const checkboxes = dialog.getByRole('checkbox');
    await checkboxes.nth(0).uncheck();
    const deadline = await calendar(page, dialog.getByRole('button', { name: '下载这条信息的日历提醒', exact: true }));
    assert.equal((deadline.match(/BEGIN:VEVENT/g) || []).length, 1);
    assert.match(deadline, /SUMMARY:报名截止/);
    await checkboxes.nth(1).uncheck();
    assert.equal(await dialog.getByRole('button', { name: '下载这条信息的日历提醒', exact: true }).isDisabled(), true);
    await dialog.getByRole('button', { name: '关闭详情', exact: true }).click();
    assert.equal(await exportButton.isDisabled(), true);
    await page.reload({ waitUntil: 'networkidle' });
    assert.equal(await exportButton.isDisabled(), true);
    assert.deepEqual(await storage(page, savedKey), { favorites: ['legacy-missing', 'timed'], profile });
    assert.deepEqual((await storage(page, reminderKey)).items.timed, { start: false, deadline: false });
    await page.locator('.results-grid .card-main').click();
    assert.equal(await checkboxes.nth(0).isChecked(), false);
    assert.equal(await checkboxes.nth(1).isChecked(), false);
    await checkboxes.nth(0).check();
    const start = await calendar(page, dialog.getByRole('button', { name: '下载这条信息的日历提醒', exact: true }));
    assert.equal((start.match(/BEGIN:VEVENT/g) || []).length, 1);
    assert.match(start, /SUMMARY:报名开始/);
    await dialog.getByRole('button', { name: '关闭详情', exact: true }).click();
    assert.equal(await exportButton.isEnabled(), true);
    assert.deepEqual(await storage(page, savedKey), { favorites: ['legacy-missing', 'timed'], profile });
  });
});

test('只公布截止日期导出全天标记和检查提醒，未知时间与满员收藏不伪造事件', async () => {
  await withBrowser(['day', 'unknown', 'full'], async page => {
    const panel = page.getByRole('region', { name: '我关注的活动提醒' });
    const ics = await calendar(page, panel.getByRole('button', { name: '导出日历提醒', exact: true }));
    assert.equal((ics.match(/BEGIN:VEVENT/g) || []).length, 1);
    assert.match(ics, /DTSTART;VALUE=DATE:20990120\r\nDTEND;VALUE=DATE:20990121/);
    assert.doesNotMatch(ics, /DTSTART:\d+T/);
    assert.equal((ics.match(/BEGIN:VALARM/g) || []).length, 2);
    assert.match(ics, /TRIGGER;VALUE=DATE-TIME:20990119T010000Z/);
    assert.match(ics, /TRIGGER;VALUE=DATE-TIME:20990120T010000Z/);
    assert.match(ics, /09:00仅为检查提醒，不代表截止时刻/);
    assert.doesNotMatch(ics, /报名时间未知|名额已满/);
    assert.match(await panel.innerText(), /仅公布日期/);
    assert.equal(await page.locator('.results-grid .event-card').count(), 0, '旧私人关注不进入公开点赞列表');
    await page.locator('.legacy-watchlist > summary').click();
    for (const item of items.filter(item => ['unknown', 'full'].includes(item.id))) {
      await page.locator('.legacy-watchlist .event-card').filter({ has: page.getByRole('heading', { name: item.title, exact: true }) }).locator('.card-main').click();
      const dialog = page.getByRole('dialog');
      assert.equal(await dialog.getByRole('checkbox').nth(0).isDisabled(), true);
      assert.equal(await dialog.getByRole('checkbox').nth(1).isDisabled(), true);
      assert.equal(await dialog.getByRole('button', { name: '下载这条信息的日历提醒', exact: true }).isDisabled(), true);
      await dialog.getByRole('button', { name: '关闭详情', exact: true }).click();
    }
    await widths(page);
    assert.deepEqual(await storage(page, savedKey), { favorites: ['day', 'unknown', 'full'], profile });
  });
});
