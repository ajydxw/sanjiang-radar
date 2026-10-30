import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { createIdentityAuth, handleIdentityRequest } from './identity-auth.mjs';

// Requires a root-path build with NEXT_PUBLIC_IDENTITY_ENABLED=1; the default build must fail this test.
test('开启身份后的真实同源验证、会话、游客和退出', async t => {
  const root = resolve('out');
  const auth = await createIdentityAuth({ roster: [{ name: '测试同学', studentId: '000000001' }] });
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
  const server = http.createServer(async (req, res) => {
    if (await handleIdentityRequest(req, res, auth)) return;
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let file = resolve(root, `.${pathname}`);
      if (!file.startsWith(`${root}${sep}`) && file !== root) throw new Error();
      if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const contextOptions = { viewport: { width: 390, height: 844 }, reducedMotion: 'reduce', timezoneId: 'America/Los_Angeles' };
  async function newVisitor() {
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await page.clock.install({ time: new Date('2026-10-30T10:00:00Z') });
    await page.goto(`${origin}/#radar`, { waitUntil: 'networkidle' });
    await page.getByRole('dialog').waitFor();
    return page;
  }
  async function assertNoIdentityInStorage(page) {
    const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
    for (const value of ['测试同学', '错误姓名', '000000001', '000000002']) assert.ok(!storage.includes(value), '身份输入不能存入浏览器存储');
  }
  async function reopen(page) {
    await page.getByRole('navigation', { name: '手机主导航' }).getByRole('button', { name: /^我的/ }).click();
    await page.getByRole('button', { name: '欢迎页与身份确认入口' }).click();
  }
  const page = await newVisitor();
  const dialog = page.getByRole('dialog');
  const originalGreeting = await dialog.locator('.welcome-greeting').innerText();
  assert.equal(originalGreeting, '月光下的对话');
  await page.getByRole('button', { name: /姓名＋学号确认.*可选/ }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: /姓名＋学号确认/ }).click();
  const name = dialog.getByLabel('姓名', { exact: true });
  const id = dialog.getByLabel('完整学号');
  await name.fill('错误姓名'); await id.fill('000000001');
  await assertNoIdentityInStorage(page);
  await dialog.getByRole('button', { name: '确认班级身份' }).click();
  const firstError = await dialog.getByRole('alert').innerText();
  assert.equal(firstError, '姓名或学号不匹配，请检查后重试。');
  await name.fill('测试同学'); await id.fill('000000002');
  await dialog.getByRole('button', { name: '确认班级身份' }).click();
  await page.waitForFunction(() => !document.querySelector('.identity-form input')?.value);
  assert.equal(await dialog.getByRole('alert').innerText(), firstError);
  await name.fill('测试同学'); await id.fill('000000001');
  await assertNoIdentityInStorage(page);
  await dialog.getByRole('button', { name: '确认班级身份' }).click();
  await dialog.getByText('已匹配班级名单。此确认仅用于称呼，不是强本人认证。').waitFor();
  assert.equal(await dialog.locator('.welcome-greeting').innerText(), `${originalGreeting}，测试同学`);
  await assertNoIdentityInStorage(page);
  await dialog.getByRole('button', { name: '继续浏览' }).click();
  await page.reload({ waitUntil: 'networkidle' });
  await reopen(page);
  await page.waitForFunction(() => document.querySelector('.welcome-greeting')?.textContent?.includes('测试同学'));
  assert.equal(await dialog.locator('.welcome-greeting').innerText(), `${originalGreeting}，测试同学`);
  const guest = await newVisitor();
  assert.equal(await guest.locator('.welcome-greeting').innerText(), originalGreeting);
  await guest.getByRole('button', { name: '直接浏览', exact: true }).click();
  await guest.getByRole('navigation', { name: '手机主导航' }).getByRole('button', { name: /^发现/ }).click();
  await guest.getByRole('searchbox', { name: '搜索校园信息' }).waitFor();
  await guest.getByRole('navigation', { name: '手机主导航' }).getByRole('button', { name: /^我的/ }).click();
  await guest.getByLabel('学院', { exact: true }).waitFor();
  await dialog.getByRole('button', { name: /姓名＋学号确认/ }).click();
  await dialog.getByRole('button', { name: '退出身份确认' }).click();
  await dialog.getByLabel('姓名', { exact: true }).waitFor();
  assert.equal(await dialog.locator('.welcome-greeting').innerText(), originalGreeting);
  await assertNoIdentityInStorage(page);
  await page.reload({ waitUntil: 'networkidle' });
  await reopen(page);
  assert.equal(await dialog.locator('.welcome-greeting').innerText(), originalGreeting);
});
