import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';
import { createRadarServer } from './serve-radar.mjs';
import { createAssistantStore } from './assistant-questions.mjs';
import { createAdminAuth } from './admin-auth.mjs';
import { publishReviewedBatch } from './assistant-queue.mjs';

test('手机管理登录、草稿审核、删除确认和退出，普通访客无法读取私有队列', async () => {
  const runtime = resolve('.sites-runtime');
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(resolve(runtime, 'admin-browser-test-'));
  const store = await createAssistantStore({ directory: resolve(directory, 'questions') });
  const auth = await createAdminAuth({ directory: resolve(directory, 'auth'), limits: { burst: 20 } });
  const password = randomBytes(18).toString('base64url');
  await auth.setPassword(password);
  const question = await store.create({ question: '大一怎样安排学习和休息？' });
  const answer = '先把课程和截止时间放入每周安排，每天挑两三件重要的事，留出休息和缓冲。';
  await publishReviewedBatch(store, [{ id: question.id, status: 'answered', answer, sources: [], model: 'gpt-6.1-sol', reasoningEffort: 'high', review: { scope: true, facts: true, timing: true, fields: true, privacy: true } }], 'draft');
  assert.equal((await store.get(question.id, question.accessToken)).answer, null);
  const server = await createRadarServer({ assistantStore: store, adminAuth: auth, log: () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${origin}/#admin`, { waitUntil: 'networkidle' });
    await page.getByRole('heading', { name: '问答管理', exact: true }).waitFor();
    assert.equal(await page.getByRole('heading', { name: question.question, exact: true }).count(), 0);
    assert.equal((await fetch(`${origin}/api/admin/questions`)).status, 401);
    await page.getByLabel('账号', { exact: true }).fill(await auth.getUsername());
    await page.getByLabel('管理密码', { exact: true }).fill(password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await page.getByRole('heading', { name: question.question, exact: true }).waitFor();
    assert.match(await page.locator('.admin-draft').innerText(), /待审核答复/);
    assert.equal(await page.evaluate(() => document.cookie), '', '管理Cookie不可被网页脚本读取');
    assert.equal(await page.evaluate(() => Object.values(localStorage).some(value => value.includes('csrfToken'))), false);
    const adminCookie = (await context.cookies()).find(cookie => cookie.name === 'sanjiang_admin');
    assert.ok(adminCookie.httpOnly && adminCookie.sameSite === 'Strict');
    await page.getByRole('button', { name: '我已核对，确认发布', exact: true }).click();
    await page.getByText('你已确认并发布这条答复。', { exact: true }).waitFor();
    assert.equal(await page.locator('.admin-draft').count(), 0);
    assert.equal((await store.get(question.id, question.accessToken)).answer, answer);
    for (const width of [320, 390, 768, 1366]) {
      await page.setViewportSize({ width, height: 844 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `管理页面 ${width} 无横向溢出`);
    }
    await page.getByRole('button', { name: '已处理', exact: true }).click();
    assert.equal(await page.locator('.admin-question').count(), 1);
    await page.getByRole('button', { name: /删除问题：/ }).click();
    await page.getByRole('button', { name: '取消', exact: true }).click();
    assert.equal((await store.adminList()).length, 1);
    await page.getByRole('button', { name: /删除问题：/ }).click();
    await page.getByRole('button', { name: '确认永久删除', exact: true }).click();
    await page.getByText('问题已删除。', { exact: true }).waitFor();
    await assert.rejects(store.get(question.id, question.accessToken), { statusCode: 404 });
    await page.getByRole('button', { name: '退出', exact: true }).click();
    await page.getByRole('button', { name: '登录', exact: true }).waitFor();
    assert.equal(await page.locator('.admin-question').count(), 0);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    const inside = relative(runtime, directory);
    assert.ok(inside.startsWith('admin-browser-test-') && !isAbsolute(inside) && !inside.startsWith(`..${sep}`));
    await rm(directory, { recursive: true, force: true });
  }
});
