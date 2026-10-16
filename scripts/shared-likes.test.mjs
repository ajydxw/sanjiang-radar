import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { createRadarServer } from './serve-radar.mjs';
import { createLikeStore } from './activity-likes.mjs';
import { createAssistantStore } from './assistant-questions.mjs';
import { createAdminAuth } from './admin-auth.mjs';

const items = ['shared-first', 'shared-second'].map((id, index) => ({
  id, title: `隔离点赞活动 ${index + 1}`, category: 'PU活动', summary: '仅用于隔离浏览器测试。',
  source: '隔离来源', sourceType: 'pu', sourcePortal: 'https://www.sju.edu.cn/',
  publishedAt: new Date().toISOString(), fetchedAt: new Date().toISOString(),
  freshmanAllowed: 'allowed', colleges: [], importance: 'high', detailRead: true,
  rewardNote: '奖励以官方认定为准', registrationMethod: '前往 PU 报名',
  registrationDeadline: '2099-12-20T17:00:00+08:00', verification: 'PU官方活动', demo: false,
}));
const card = (page, index = 0) => page.locator('.results-grid .event-card').filter({ has: page.getByRole('heading', { name: items[index].title, exact: true }) });
const button = (page, index = 0) => card(page, index).locator('.like-button');
const nav = (page, name) => page.getByRole('navigation', { name: '手机主导航' }).getByRole('button', { name: new RegExp(`^${name}`) }).click();
const summary = page => page.evaluate(() => fetch('/api/likes').then(response => response.json()));
async function settled(page) { await page.waitForFunction(() => !document.querySelector('.like-button[aria-busy="true"]')); }
async function state(page, count, liked, index = 0) {
  await page.waitForFunction(({ title, count, liked }) => [...document.querySelectorAll('.results-grid .like-button')].some(el =>
    el.getAttribute('aria-label') === `${liked ? '取消点赞' : '点赞'}：${title}，${count} 个赞` && el.getAttribute('aria-pressed') === String(liked)), { title: items[index].title, count, liked });
}
async function refresh(page) { await page.locator('.liked-view-controls').getByRole('button', { name: '刷新点赞', exact: true }).click(); }

async function fixture(t) {
  const runtime = resolve('.sites-runtime');
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(resolve(runtime, 'shared-likes-browser-test-'));
  let server, browser;
  const errors = [];
  t.after(async () => {
    await browser?.close();
    if (server?.listening) { server.closeAllConnections(); await new Promise(done => server.close(done)); }
    const part = relative(runtime, directory);
    assert.ok(part.startsWith('shared-likes-browser-test-') && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`));
    await rm(directory, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  });
  const likesStore = await createLikeStore({ directory: resolve(directory, 'likes'), getAllowedIds: async () => new Set(items.map(item => item.id)) });
  const assistantStore = await createAssistantStore({ directory: resolve(directory, 'questions') });
  const adminAuth = await createAdminAuth({ directory: resolve(directory, 'auth') });
  server = await createRadarServer({ likesStore, assistantStore, adminAuth, log: () => {} });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  async function visitor(hash = 'discover', options = {}, init) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ...options });
    await context.route('**/data/*.json', route => route.fulfill({ json: { schemaVersion: 1, generatedAt: new Date().toISOString(),
      items: new URL(route.request().url()).pathname.endsWith('/sanjiang-web.json') ? items : [],
      sources: [{ id: 'isolated', name: '隔离来源', url: 'https://www.sju.edu.cn/', state: 'ok', count: items.length, lastSuccessAt: new Date().toISOString() }] } }));
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/#${hash}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(() => document.querySelector('.likes-service-warning') === null && document.querySelector('.like-button')?.disabled === false || !!document.querySelector('.liked-view-controls'));
    return { page, context };
  }
  return { visitor };
}

test('两个独立浏览器共享真实赞数，匿名身份独立、幂等、跨页保留及最后一赞取消', async t => {
  const { visitor } = await fixture(t);
  const { page: a, context: ca } = await visitor();
  const { page: b, context: cb } = await visitor('saved');
  await b.clock.install();
  await b.reload({ waitUntil: 'networkidle' });
  assert.equal(await b.getByRole('button', { name: '大家点赞', exact: true }).getAttribute('aria-pressed'), 'true');
  assert.equal(await b.locator('.results-grid .event-card').count(), 0);
  await button(a).focus(); await a.keyboard.press('Enter'); await state(a, 1, true);
  await refresh(b); await state(b, 1, false);
  await b.getByRole('button', { name: '我的点赞', exact: true }).click();
  assert.equal(await b.locator('.results-grid .event-card').count(), 0);
  await b.getByRole('button', { name: '大家点赞', exact: true }).click();
  await button(b).focus(); await b.keyboard.press('Space'); await state(b, 2, true);
  await a.reload({ waitUntil: 'networkidle' }); await state(a, 2, true);
  const firstCookie = (await ca.cookies()).find(cookie => cookie.name === 'radar_likes');
  const secondCookie = (await cb.cookies()).find(cookie => cookie.name === 'radar_likes');
  assert.ok(firstCookie?.httpOnly && secondCookie?.httpOnly);
  assert.notEqual(firstCookie.value, secondCookie.value);
  assert.equal(await a.evaluate(() => document.cookie.includes('radar_likes')), false);
  const repeat = await a.evaluate(id => fetch(`/api/likes/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ liked: true }) }).then(response => response.json()), items[0].id);
  assert.equal(repeat.counts[items[0].id], 2, '重复保存 desired state 不重复计数');
  await nav(a, '点赞'); await state(a, 2, true);
  await nav(a, '我的'); await nav(a, '发现'); await state(a, 2, true);
  await button(a).click(); await state(a, 1, false);
  await b.clock.fastForward(15000); await state(b, 1, true);
  await Promise.all([b.waitForResponse(response => response.request().method() === 'PUT' && response.url().endsWith(`/api/likes/${items[0].id}`)), button(b).click()]);
  await settled(b);
  await b.waitForFunction(() => !document.querySelector('.results-grid .event-card'));
  await nav(a, '点赞'); await refresh(a);
  await a.waitForFunction(() => !document.querySelector('.results-grid .event-card'));
  assert.equal((await summary(a)).counts[items[0].id], 0);
  assert.deepEqual((await summary(a)).likedIds, []);
});

test('全站 pending 阻止重复提交，网络及服务错误回滚，禁用后刷新恢复', async t => {
  const { visitor } = await fixture(t);
  const { page, context } = await visitor();
  let release, writes = 0;
  const gate = new Promise(done => { release = done; });
  const slow = async route => { if (route.request().method() !== 'PUT') return route.continue(); writes++; await gate; return route.continue(); };
  await context.route('**/api/likes/*', slow);
  try {
    await button(page).click();
    await page.waitForFunction(() => !!document.querySelector('.like-button[aria-busy="true"]'));
    assert.ok(await page.locator('.like-button').evaluateAll(buttons => buttons.every(button => button.disabled)));
    await page.keyboard.press('Enter'); await page.keyboard.press('Space');
    await button(page, 1).evaluate(el => el.click());
    await nav(page, '点赞');
    await card(page).locator('.card-main').click();
    assert.equal(await page.getByRole('dialog').locator('.like-button').isDisabled(), true);
    await page.getByRole('button', { name: '关闭详情', exact: true }).click();
    assert.equal(writes, 1);
  } finally { release(); }
  await state(page, 1, true); await context.unroute('**/api/likes/*', slow);
  await nav(page, '发现');
  for (const failure of ['network', 'server']) {
    const fail = route => failure === 'network' ? route.abort('failed') : route.fulfill({ status: 500, json: { error: 'isolated failure' } });
    await context.route('**/api/likes/*', fail);
    await button(page, 1).click();
    await page.locator('.likes-service-warning').waitFor();
    await state(page, 0, false, 1);
    assert.equal((await summary(page)).counts[items[1].id], 0, '失败不产生真实点赞');
    assert.ok(await page.locator('.like-button').evaluateAll(buttons => buttons.every(button => button.disabled)));
    await context.unroute('**/api/likes/*', fail);
    await page.locator('.likes-service-warning').getByRole('button', { name: '刷新点赞', exact: true }).click();
    await page.waitForFunction(() => !document.querySelector('.likes-service-warning') && [...document.querySelectorAll('.like-button')].every(button => !button.disabled));
    await state(page, 1, true);
  }
  await button(page, 1).click(); await state(page, 1, true, 1);
  await page.reload({ waitUntil: 'networkidle' }); await state(page, 1, true, 1);
});

test('真实爱心动画 600ms、彩色径向粒子、左侧数字向上滚动及减少动态效果', async t => {
  const { visitor } = await fixture(t);
  const { page } = await visitor('discover', {}, () => {
    const freeze = () => document.querySelectorAll('.like-button').forEach(el => el.getAnimations({ subtree: true }).forEach(animation => {
      if (animation.animationName?.startsWith('like-') && animation.playState !== 'paused') { animation.pause(); animation.currentTime = 0; }
    }));
    new MutationObserver(freeze).observe(document, { childList: true, subtree: true, attributes: true });
  });
  await button(page).click(); await state(page, 1, true);
  await button(page).locator('.like-count-track').waitFor();
  const animation = await button(page).evaluate(el => {
    const heart = el.querySelector('.like-heart');
    const pop = heart.getAnimations().find(animation => animation.animationName === 'like-pop');
    const particles = [...el.querySelectorAll('.like-particle')];
    const roll = el.querySelector('.like-count-track').getAnimations()[0];
    const particleData = particles.map(particle => {
      const anim = particle.getAnimations()[0]; anim.pause(); anim.currentTime = 600;
      const css = getComputedStyle(particle);
      const matrix = new DOMMatrix(css.transform);
      return { duration: anim.effect.getTiming().duration, color: css.backgroundColor, opacity: css.opacity,
        x: Number.parseFloat(css.getPropertyValue('--like-x')), y: Number.parseFloat(css.getPropertyValue('--like-y')), tx: matrix.e, ty: matrix.f };
    });
    const sample = time => { pop.currentTime = time; return new DOMMatrix(getComputedStyle(heart).transform).a; };
    roll.currentTime = 600;
    return { duration: pop.effect.getTiming().duration, keyframes: pop.effect.getKeyframes().map(frame => frame.transform),
      scales: [sample(0), sample(252), sample(600)], particleData, rollDuration: roll.effect.getTiming().duration,
      rollY: new DOMMatrix(getComputedStyle(el.querySelector('.like-count-track')).transform).f,
      countLeft: el.querySelector('.like-count').getBoundingClientRect().right <= heart.getBoundingClientRect().left,
      fill: getComputedStyle(heart).fill, color: getComputedStyle(heart).color };
  });
  assert.equal(animation.duration, 600); assert.equal(animation.rollDuration, 600);
  assert.ok(animation.keyframes.some(value => value.includes('0.8')) && animation.keyframes.some(value => value.includes('1.2')));
  for (const [index, expected] of [0.8, 1.2, 1].entries()) assert.ok(Math.abs(animation.scales[index] - expected) < 0.005);
  assert.equal(animation.particleData.length, 8);
  assert.equal(new Set(animation.particleData.map(particle => particle.color)).size, 8);
  assert.equal(new Set(animation.particleData.map(particle => Math.atan2(particle.y, particle.x))).size, 8);
  assert.ok(animation.particleData.every(particle => particle.duration === 600 && particle.opacity === '0' && Math.hypot(particle.x, particle.y) >= 23));
  assert.ok(animation.particleData.every(particle => Math.abs(particle.tx - particle.x) < 0.01 && Math.abs(particle.ty - particle.y) < 0.01));
  assert.equal(animation.rollY, -20); assert.equal(animation.countLeft, true); assert.equal(animation.fill, animation.color);
  for (const width of [320, 390, 768, 1366]) {
    await page.setViewportSize({ width, height: 844 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}px 无横向溢出`);
    assert.deepEqual(await page.getByRole('navigation', { name: '手机主导航', includeHidden: true }).locator('button > span').allTextContents(), ['今日雷达', '发现', '点赞', '我的']);
  }
  const { page: reduced } = await visitor('discover', { reducedMotion: 'reduce' });
  await state(reduced, 1, false); await button(reduced).click(); await state(reduced, 2, true);
  await reduced.waitForFunction(() => {
    const counter = document.querySelector('.results-grid .like-button .like-count');
    if (!counter) return false;
    const bounds = counter.getBoundingClientRect();
    return [...counter.querySelectorAll('.like-count-value')].some(row => row.textContent === '2' && row.getBoundingClientRect().top >= bounds.top && row.getBoundingClientRect().bottom <= bounds.bottom);
  });
  const final = await button(reduced).evaluate(el => ({
    animations: el.querySelector('.like-heart').getAnimations().length,
    particlesHidden: [...el.querySelectorAll('.like-particle')].every(particle => getComputedStyle(particle).display === 'none'),
    fill: getComputedStyle(el.querySelector('.like-heart')).fill, color: getComputedStyle(el).color,
  }));
  assert.equal(final.animations, 0); assert.equal(final.particlesHidden, true); assert.equal(final.fill, final.color);
});
