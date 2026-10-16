import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { wechatUrl, parseWechatArticle } from '../sources/wechat/parse.mjs';
import { readWechatArticle } from '../sources/wechat/read-article.mjs';
import { projectRoot, readFeed, writeFeed } from './feed-files.mjs';

const { values } = parseArgs({ options: { url: { type: 'string' }, 'html-file': { type: 'string' }, force: { type: 'boolean', default: false } } });
const dataRoot = resolve(projectRoot, '.sites-runtime/wechat');
const configPath = resolve(dataRoot, 'article-links.json');
const previous = await readFeed('wechat.json');
await mkdir(resolve(dataRoot, 'articles'), { recursive: true });
let urls = [];
try { urls = JSON.parse(await readFile(configPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
if (values.url) urls = [...new Set([...urls, wechatUrl(values.url)])];
if (values['html-file'] && !values.url) throw new Error('从本机已读取的正文导入时，需要同时指定原文链接');
const items = new Map((previous?.items || []).map(item => [item.sourcePortal, item]));
let successful = 0;
let failures = 0;
let hidden = 0;
const attemptedAt = new Date().toISOString();
for (const url of urls.slice(0, 25)) {
  const cached = items.get(url);
  if (!values.force && cached && Date.now() - Date.parse(cached.fetchedAt) < 6 * 3600000) { successful++; continue; }
  try {
    const useCapturedHtml = values['html-file'] && url === wechatUrl(values.url);
    const html = useCapturedHtml ? await readFile(resolve(projectRoot, values['html-file']), 'utf8')
      : await readWechatArticle(url, resolve(dataRoot, 'browser-profile'));
    const fetchedAt = useCapturedHtml ? (await stat(resolve(projectRoot, values['html-file']))).mtime.toISOString() : new Date().toISOString();
    const parsed = parseWechatArticle(html, url, fetchedAt, cached);
    const rawPath = resolve(dataRoot, 'articles', `${parsed.item.id}.html`);
    await writeFile(rawPath, html, 'utf8');
    if (parsed.classification.visibility === 'hidden' || parsed.item.freshmanAllowed === 'excluded') { items.delete(url); hidden++; }
    else items.set(url, parsed.item);
    successful++;
  } catch { failures++; }
}
await writeFile(configPath, JSON.stringify(urls, null, 2), 'utf8');
const state = !urls.length ? 'pending' : failures ? successful ? 'partial' : 'failed' : 'ok';
const feed = { schemaVersion: 1, generatedAt: attemptedAt, items: [...items.values()],
  sources: [{ id: 'sju-wechat', name: '三江学院官方公众号', sourceType: 'wechat',
    url: urls[0] || 'https://mp.weixin.qq.com/', state, count: items.size,
    lastSuccessAt: successful ? [...items.values()].map(item => item.fetchedAt).sort().at(-1) || previous?.sources?.[0]?.lastSuccessAt || null : previous?.sources?.[0]?.lastSuccessAt || null,
    note: '文章链接导入已接通；仅保留有用的信息摘要与原文链接。自动发现新推文尚未配置。',
    error: failures ? `${failures} 篇文章暂不可读取，保留已有信息` : null,
    discoveryMode: 'article-links',
  }] };
await writeFeed('wechat.json', feed);
console.log(`公众号：${state}，已展示 ${items.size} 篇，过滤 ${hidden} 篇，暂不可读取 ${failures} 篇。`);
if (state === 'failed') process.exitCode = 1;
