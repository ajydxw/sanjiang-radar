import { chromium } from 'playwright-core';
import { resolve } from 'node:path';
import { projectRoot } from './feed-files.mjs';
import { secureDirectory } from './local-secrets.mjs';
await secureDirectory(resolve(projectRoot, '.sites-runtime/pu'));
const context = await chromium.launchPersistentContext(resolve(projectRoot, '.sites-runtime/pu/browser-profile'), {
  channel: 'msedge', headless: false, acceptDownloads: false, args: ['--no-proxy-server'],
});
const page = context.pages()[0] || await context.newPage();
try { await page.goto('https://pc.pocketuni.net/login', { waitUntil: 'domcontentloaded', timeout: 30000 }); }
catch { console.log('PU 官方窗口已打开，请在窗口中完成登录。'); }
console.log('在 PU 官方窗口选择三江学院并登录；完成后关闭此专用窗口，再运行同步。密码仅在官方页面填写。');
await new Promise(done => context.once('close', done));
