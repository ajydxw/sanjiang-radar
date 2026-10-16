import { chromium } from 'playwright-core';
import { wechatUrl } from './parse.mjs';

export async function readWechatArticle(url, profilePath) {
  const safeUrl = wechatUrl(url);
  let context;
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      channel: 'msedge', headless: true, acceptDownloads: false, args: ['--no-proxy-server'],
    });
    const page = context.pages()[0] || await context.newPage();
    await page.goto(safeUrl, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForFunction(() => document.querySelector('#js_content')?.textContent?.trim().length > 0, null, { timeout: 10000 });
    return await page.content();
  } catch { throw new Error('微信正文暂不可读取，可能需要在本机官方文章页面完成验证'); }
  finally { await context?.close(); }
}
