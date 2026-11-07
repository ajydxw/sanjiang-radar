import assert from 'node:assert/strict';
import test from 'node:test';
import http from 'node:http';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { chromium } from 'playwright-core';
import { MODEL_CATALOG, ASTRA_MEMBER_BUDGET_MICROS, costMicros } from './class-assistant-config.mjs';

test('班级助手的登录、额度、提问和异常状态', async t => {
  const root = resolve(process.env.CLASS_ASSISTANT_UI_ROOT || 'out');
  const mime = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml' };
  const server = http.createServer(async (req, res) => {
    try {
      const pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
      let file = resolve(root, `.${pathname}`);
      if (file !== root && !file.startsWith(`${root}${sep}`)) throw new Error('invalid path');
      if ((await stat(file)).isDirectory()) file = resolve(file, 'index.html');
      res.writeHead(200, { 'Content-Type': mime[extname(file)] || 'application/octet-stream' });
      res.end(await readFile(file));
    } catch { res.writeHead(404); res.end('Not found'); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
  t.after(async () => { await browser.close(); server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  let authenticated = false, enabled = false, chats = 0, networkFailure = false;
  const remainingMicros = 2141857;
  const models = () => MODEL_CATALOG.map(model => {
    const prices = { input: Math.round(model.inputPerMillion * 1_000_000), cached: Math.round(model.cachedInputPerMillion * 1_000_000), output: Math.round(model.outputPerMillion * 1_000_000) };
    const modelRemaining = model.key === 'astra' ? Math.min(remainingMicros, ASTRA_MEMBER_BUDGET_MICROS) : remainingMicros;
    return { ...model, available: enabled, reason: enabled ? undefined : '付费发送暂未开放', maxOutputTokens: 1024, budgetMicros: authenticated && model.key === 'astra' ? ASTRA_MEMBER_BUDGET_MICROS : null, remainingMicros: authenticated ? modelRemaining : null, estimatedMessages: authenticated ? Math.floor(modelRemaining / costMicros(prices, 1000, 0, 500)) : null };
  });
  const session = () => ({ configured: true, authenticated, enabled, reason: enabled ? undefined : '付费发送暂未开放', member: authenticated ? { name: '测试同学', budgetMicros: 2142857, spentMicros: 1000, reservedMicros: 0, remainingMicros } : undefined, models: models(), estimatedInputTokens: 1000, estimatedOutputTokens: 500 });
  await page.route('**/api/class-assistant/**', async route => {
    const name = new URL(route.request().url()).pathname.split('/').at(-1);
    if (name === 'login') {
      assert.deepEqual(route.request().postDataJSON(), { accessCode: '00000000001' });
      authenticated = true;
      await route.fulfill({ json: { ok: true } });
    } else if (name === 'logout') {
      authenticated = false;
      await route.fulfill({ json: { ok: true } });
    } else if (name === 'session') {
      await route.fulfill({ json: session() });
    } else if (name === 'chat') {
      chats++;
      const body = route.request().postDataJSON();
      assert.match(body.requestId, /^[0-9a-f-]{36}$/i);
      assert.equal(body.modelKey, 'sol');
      if (networkFailure) await route.abort('failed');
      else await route.fulfill({ json: { answer: '这是一条合成测试回答。', status: 'completed', chargedMicros: 1234 } });
    } else await route.fulfill({ status: 404, json: { error: 'unknown mock', code: 'unknown' } });
  });
  await page.goto(`http://127.0.0.1:${server.address().port}/assistant/`);
  await page.getByLabel('学号').fill('00000000001');
  await page.getByRole('button', { name: '进入助手' }).click();
  await page.getByRole('heading', { name: '你好，测试同学' }).waitFor();
  assert.equal(await page.locator('.ca-model').count(), 4);
  assert.deepEqual(await page.locator('.ca-model strong').allTextContents(), ['GPT-6 Luna', 'GPT-6.1 Terra', 'GPT-6.1 Sol', 'GPT-6 Astra']);
  await page.getByText('日常问答推荐').waitFor();
  await page.getByText('日常问题先用 Luna，更省额度').waitFor();
  for (const count of [10, 305, 611, 6119]) await page.getByText(`约 ${count} 次 · 按当前余额估算`).waitFor();
  assert.equal(await page.getByText('暂不可用', { exact: true }).count(), 4);
  await page.getByText('专属上限 $0.350000 · 可用 $0.350000（包含在总额度内）').waitFor();
  await page.getByText('$2.142857').waitFor();
  await page.locator('.ca-chat').getByText('付费发送暂未开放').waitFor();
  assert.equal(await page.getByRole('button', { name: '发送问题' }).isDisabled(), true);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), 'mobile page must not overflow horizontally');
  await mkdir('artifacts', { recursive: true });
  await page.screenshot({ path: 'artifacts/class-assistant-preview.png', fullPage: true });
  enabled = true;
  await page.getByRole('button', { name: '刷新余额' }).click();
  const luna = page.locator('.ca-model').filter({ hasText: 'GPT-6 Luna' });
  const sol = page.locator('.ca-model').filter({ hasText: 'GPT-6.1 Sol' });
  await luna.waitFor({ state: 'visible' });
  await page.waitForFunction(() => [...document.querySelectorAll('.ca-model')].some(el => el.textContent.includes('GPT-6 Luna') && el.getAttribute('aria-pressed') === 'true'));
  await sol.click();
  assert.equal(await sol.getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: '刷新余额' }).click();
  await page.waitForFunction(() => [...document.querySelectorAll('.ca-model')].some(el => el.textContent.includes('GPT-6.1 Sol') && el.getAttribute('aria-pressed') === 'true'));
  assert.equal(await sol.getAttribute('aria-pressed'), 'true');
  await page.getByLabel('你的问题').fill('合成测试问题');
  await page.getByRole('button', { name: '发送问题' }).click();
  await page.getByText('这是一条合成测试回答。').waitFor();
  await page.getByText('生活助手 · 本次费用 $0.001234').waitFor();
  assert.equal(chats, 1);
  await page.getByRole('button', { name: '刷新余额' }).click();
  await page.getByText('$2.142857').waitFor();
  assert.equal(chats, 1, 'refresh must not submit a chat');
  networkFailure = true;
  await page.getByLabel('你的问题').fill('合成网络异常问题');
  await page.getByRole('button', { name: '发送问题' }).click();
  await page.getByText(/本次请求结果未确认，可能已产生费用/).waitFor();
  assert.equal(chats, 2, 'network failure must not retry automatically');
  assert.equal(await page.getByRole('button', { name: '发送问题' }).isDisabled(), true);
  await page.getByRole('button', { name: '刷新余额' }).click();
  assert.equal(chats, 2);
  await page.getByRole('button', { name: '退出', exact: true }).click();
  await page.getByLabel('学号').waitFor();
  assert.equal(await page.getByText('这是一条合成测试回答。').count(), 0);
  const storage = await page.evaluate(() => JSON.stringify({ local: { ...localStorage }, session: { ...sessionStorage } }));
  assert.ok(!storage.includes('00000000001') && !storage.includes('合成测试回答'));
});
