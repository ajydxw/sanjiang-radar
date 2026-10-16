import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify, parseArgs } from 'node:util';
import { load } from 'cheerio';
import { chromium } from 'playwright-core';
import { projectRoot, readFeed, writeFeed } from './feed-files.mjs';
import { competitionSources } from '../sources/competitions/sources.mjs';
import { competitionUrl, parseCompetitionList, parseCompetition } from '../sources/competitions/parse.mjs';
import { fingerprint } from '../sources/sanjiang-web/parse.mjs';
import { deadlineTime } from '../src/lib/information.ts';

const { values } = parseArgs({ options: { force: { type: 'boolean', default: false } } });
const runtimeDir = resolve(projectRoot, '.sites-runtime/collectors/competitions');
await mkdir(runtimeDir, { recursive: true });
const previous = await readFeed('competitions.json');
const previousItems = new Map(previous?.items.map(item => [item.id, item]) ?? []);
const items = new Map();
const statuses = [];
let browser;
let lastRequest = 0;
const runFile = promisify(execFile);
const currentYear = Number(new Intl.DateTimeFormat('en', { year: 'numeric', timeZone: 'Asia/Shanghai' }).format(new Date()));

async function getResponse(url) {
  const wait = Math.max(0, 500 - (Date.now() - lastRequest));
  if (wait) await new Promise(done => setTimeout(done, wait));
  lastRequest = Date.now();
  const response = await fetch(url, { signal: AbortSignal.timeout(20000), redirect: 'error', headers: { 'User-Agent': 'SanjiangRadar/0.2 (student information reader)' } });
  if (!response.ok) throw new Error(`赛事官网返回 HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 4_000_000) throw new Error('赛事页面或附件超过大小限制');
  return bytes;
}

async function getDocument(entry, source) {
  const cachePath = resolve(runtimeDir, fingerprint(entry.url) + '.json');
  let cached;
  try { cached = JSON.parse(await readFile(cachePath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!values.force && cached && Date.now() - Date.parse(cached.fetchedAt) < 3600000) return cached;
  let html = '', pdfText = '';
  if (source.render) {
    browser ??= await chromium.launch({ channel: 'msedge', headless: true, args: ['--no-proxy-server'] });
    const page = await browser.newPage();
    try {
      const response = await page.goto(entry.url, { waitUntil: 'domcontentloaded', timeout: 25000 });
      if (!response?.ok()) throw new Error(`赛事网页返回 HTTP ${response?.status()}`);
      await page.waitForFunction(marker => document.body.innerText.includes(marker) && /20\d{2}[年.-]\d{1,2}[月.-]\d{1,2}/.test(document.body.innerText), source.marker, { timeout: 15000 });
      html = await page.content();
    } finally { await page.close(); }
  } else if (!new URL(entry.url).pathname.toLowerCase().endsWith('.pdf')) {
    html = (await getResponse(entry.url)).toString('utf8');
  }
  const $ = load(html);
  const pdfUrl = new URL(entry.url).pathname.toLowerCase().endsWith('.pdf') ? entry.url
    : source.id === 'competition-math' ? competitionUrl($('a[href$=".pdf"]').first().attr('href'), entry.url) : null;
  if (pdfUrl) {
    const pdfPath = resolve(runtimeDir, fingerprint(pdfUrl) + '.pdf');
    const bytes = await getResponse(pdfUrl);
    if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new Error('官方附件不是 PDF');
    await writeFile(pdfPath, bytes);
    const python = process.env.RADAR_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    pdfText = (await runFile(python, [resolve(projectRoot, 'sources/competitions/read-pdf.py'), pdfPath], { timeout: 15000, maxBuffer: 500000, env: { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' } })).stdout;
  }
  const result = { html, pdfText, fetchedAt: new Date().toISOString() };
  await writeFile(cachePath, JSON.stringify(result), 'utf8');
  return result;
}

try {
  for (const source of competitionSources) {
    const previousStatus = previous?.sources.find(status => status.id === source.id);
    const sourceItems = new Map();
    const excludedIds = new Set();
    let successfulReads = 0;
    const errors = [];
    try {
      let entries = [{ url: source.url, title: source.title }];
      if (source.selector) {
        try { entries = parseCompetitionList((await getResponse(source.url)).toString('utf8'), source); }
        catch (error) { entries = source.seeds; errors.push('栏目暂不可读，仅检查已知通知：' + error.message); }
        if (!entries?.length) throw new Error('没有识别到赛事报名通知');
      }
      for (const entry of entries) {
        try {
          const document = await getDocument(entry, source);
          const information = parseCompetition(document.html, entry, source, document.pdfText);
          successfulReads++;
          if (information.freshmanAllowed === 'excluded') { excludedIds.add(information.id); continue; }
          if (information.publishedAt && Number(information.publishedAt.slice(0, 4)) < currentYear
              && !(information.registrationDeadline && deadlineTime(information.registrationDeadline) > Date.now())
              && !(information.eventStart && Date.parse(information.eventStart) > Date.now())) continue;
          const { contentHash, ...item } = information;
          item.fetchedAt = document.fetchedAt;
          item.firstSeenAt = previousItems.get(item.id)?.firstSeenAt || document.fetchedAt;
          const existing = sourceItems.get(item.id);
          if (!existing || item.publishedAt > existing.publishedAt) sourceItems.set(item.id, item);
        } catch (error) { errors.push(error.message); }
      }
      const savedItems = previous?.items.filter(item => item.source === source.name && item.freshmanAllowed !== 'excluded') ?? [];
      if (errors.length) for (const item of savedItems) if (!excludedIds.has(item.id) && !sourceItems.has(item.id)) sourceItems.set(item.id, item);
      for (const item of sourceItems.values()) items.set(item.id, item);
      statuses.push({ id: source.id, name: source.name, url: source.url, sourceType: 'competition',
        state: errors.length ? successfulReads ? 'partial' : 'failed' : 'ok', count: sourceItems.size,
        lastSuccessAt: successfulReads ? new Date().toISOString() : previousStatus?.lastSuccessAt || null,
        note: sourceItems.size ? '含已截止历史记录；首页优先展示近期机会，校内安排另行核验。' : '当前没有可展示的报名通知。', error: errors.length ? errors.join('；').slice(0, 220) : null });
    } catch (error) {
      const saved = previous?.items.filter(item => item.source === source.name && item.freshmanAllowed !== 'excluded') ?? [];
      for (const item of saved) items.set(item.id, item);
      statuses.push({ id: source.id, name: source.name, url: source.url, sourceType: 'competition', state: 'failed', count: saved.length, lastSuccessAt: previousStatus?.lastSuccessAt || null, error: error.message, note: '更新失败时保留上次成功的数据。' });
    }
    const status = statuses.at(-1);
    console.log(`${source.name}：${status.count} 条 · ${status.state}${status.error ? `（${status.error}）` : ''}`);
  }
  await writeFeed('competitions.json', { schemaVersion: 1, generatedAt: new Date().toISOString(), items: [...items.values()], sources: statuses });
  console.log(`竞赛同步完成：${items.size} 条；已截止记录不会进入首页机会列表。`);
  if (statuses.every(source => source.state === 'failed')) process.exitCode = 1;
} finally { await browser?.close(); }
