import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { projectRoot, readFeed, writeFeed } from './feed-files.mjs';
import { examSources } from '../sources/exams/sources.mjs';
import { examUrl, parseExamList, parseExamArticle } from '../sources/exams/parse.mjs';

const { values } = parseArgs({ options: { force: { type: 'boolean', default: false } } });
const previous = await readFeed('exams.json');
const runtime = resolve(projectRoot, '.sites-runtime/collectors/exams');
await mkdir(runtime, { recursive: true });
const statePath = resolve(runtime, 'state.json');
let cache;
try { cache = JSON.parse(await readFile(statePath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; cache = {}; }
let lastRequestAt = 0;
async function getHtml(value) {
  let url = examUrl(value);
  if (!url) throw new Error('不是已配置的考试院公开入口');
  for (let redirects = 0; redirects <= 3; redirects++) {
    const wait = Math.max(0, 500 - (Date.now() - lastRequestAt));
    if (wait) await new Promise(done => setTimeout(done, wait));
    lastRequestAt = Date.now();
    const response = await fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'manual' });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      url = location && examUrl(location, url);
      if (!url) throw new Error('考试通知跳转到了未配置的来源');
      continue;
    }
    if (!response.ok) throw new Error(`考试院返回 HTTP ${response.status}`);
    if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('返回的不是通知网页');
    const html = await response.text();
    if (html.length > 3_000_000) throw new Error('考试通知页面超过预期大小');
    return { html, url };
  }
  throw new Error('考试通知跳转次数过多');
}

const items = [], sources = [];
for (const source of examSources) {
  const last = previous?.sources.find(value => value.id === source.id);
  const saved = previous?.items.filter(item => item.source === source.name) ?? [];
  const lastAttemptAt = new Date().toISOString();
  try {
    const entries = parseExamList((await getHtml(source.url)).html, source);
    if (!entries.length) throw new Error('未识别到考试通知列表');
    const collected = [], errors = [];
    for (const entry of entries) {
      try {
        let article = cache[entry.id];
        if (values.force || !article || Date.now() - Date.parse(article.fetchedAt) > 6 * 3600000) {
          article = { ...await getHtml(entry.url), fetchedAt: new Date().toISOString() };
        }
        const parsed = parseExamArticle(article.html, { ...entry, url: article.url }, source, article.fetchedAt);
        cache[entry.id] = article;
        collected.push(...parsed.items);
      } catch (error) {
        errors.push(error.message);
        collected.push(...saved.filter(item => item.id === entry.id || item.id === `${entry.id}-tickets`));
      }
    }
    if (errors.length === entries.length) throw new Error(errors[0]);
    items.push(...collected);
    sources.push({ ...source, sourceType: 'exam', state: errors.length ? 'partial' : 'ok', count: collected.length,
      lastAttemptAt, lastSuccessAt: new Date().toISOString(), error: errors[0] || null,
      note: '省级安排，校内资格需核对三江通知；每小时检查两个最新办理通知，正文缓存6小时。已截止报名与后续考务分开展示。' });
    console.log(`${source.name}：${collected.length} 条${errors.length ? '，部分正文未读取' : ''}`);
  } catch (error) {
    items.push(...saved);
    sources.push({ ...source, sourceType: 'exam', state: 'failed', count: saved.length, lastAttemptAt,
      lastSuccessAt: last?.lastSuccessAt || null, error: error.message, note: '更新失败时保留上次通知；校内资格仍需核对。' });
    console.log(`${source.name}：暂未同步（${error.message}）`);
  }
}
await writeFile(`${statePath}.tmp`, JSON.stringify(cache), 'utf8');
await rename(`${statePath}.tmp`, statePath);
await writeFeed('exams.json', { schemaVersion: 1, generatedAt: new Date().toISOString(), items, sources });
if (sources.every(source => source.state === 'failed')) process.exitCode = 1;
