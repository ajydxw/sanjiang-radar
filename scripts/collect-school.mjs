import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { writeFeed } from './feed-files.mjs';
import { schoolSources } from '../sources/sanjiang-web/sources.mjs';
import { parseList, parseArticle, toInformation, classify, inferEligibility, listOnlyArticle } from '../sources/sanjiang-web/parse.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: { limit: { type: 'string', default: '14' }, source: { type: 'string' }, force: { type: 'boolean', default: false } } });
const limit = Number(values.limit);
if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('limit 必须在 1–50 之间');
const selectedSources = schoolSources.filter(source => !values.source || source.id === values.source);
if (!selectedSources.length) throw new Error('未知信息源');
const dataRoot = resolve(root, '.sites-runtime/collectors/sanjiang-web');
const statePath = resolve(dataRoot, 'state.json');
const feedPath = resolve(root, 'public/data/sanjiang-web.json');
await mkdir(resolve(dataRoot, 'articles'), { recursive: true });
await mkdir(dirname(feedPath), { recursive: true });
let state;
try { state = JSON.parse(await readFile(statePath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; state = { articles: {}, sources: {} }; }

let lastRequestAt = 0;
async function getHtml(url, etag) {
  const wait = Math.max(0, 500 - (Date.now() - lastRequestAt));
  if (wait) await new Promise(done => setTimeout(done, wait));
  lastRequestAt = Date.now();
  const response = await fetch(url, {
    signal: AbortSignal.timeout(15000), redirect: 'error',
    headers: { 'User-Agent': 'SanjiangRadar/0.2 (student information reader)', Accept: 'text/html', ...(etag ? { 'If-None-Match': etag } : {}) },
  });
  if (response.status === 304) return { unchanged: true };
  if (!response.ok) throw new Error(`官网返回 HTTP ${response.status}`);
  if (!response.headers.get('content-type')?.includes('text/html')) throw new Error('返回内容不是通知网页');
  const html = await response.text();
  if (html.length > 3_000_000) throw new Error('通知页面超过预期大小');
  return { html, etag: response.headers.get('etag') };
}

async function writeJson(path, value) {
  await writeFile(`${path}.tmp`, JSON.stringify(value, null, 2) + '\n', 'utf8');
  await rename(`${path}.tmp`, path);
}

const counts = { new: 0, updated: 0, unchanged: 0, failed: 0 };
for (const source of selectedSources) {
  const previous = state.sources[source.id] ?? {};
  const startedAt = new Date().toISOString();
  try {
    const { html } = await getHtml(source.url);
    const entries = parseList(html, source).slice(0, limit);
    if (!entries.length) throw new Error('没有识别到通知列表，需要检查栏目结构');
    const ids = [];
    const errors = [];
    for (const entry of entries) {
      const cached = state.articles[entry.id];
      try {
        let article = cached;
        if (values.force || !cached || cached.listOnly || Date.now() - Date.parse(cached.fetchedAt) > 6 * 60 * 60 * 1000) {
          const result = await getHtml(entry.url, values.force ? undefined : cached?.etag);
          if (result.unchanged && cached) article = { ...cached, fetchedAt: new Date().toISOString() };
          else {
            const parsed = parseArticle(result.html, entry);
            const fetchedAt = new Date().toISOString();
            article = { ...parsed, etag: result.etag, fetchedAt, firstSeenAt: cached?.firstSeenAt ?? fetchedAt, lastChangedAt: cached?.contentHash === parsed.contentHash ? cached.lastChangedAt : fetchedAt };
            await writeFile(resolve(dataRoot, 'articles', `${entry.id}-${parsed.contentHash.slice(0, 12)}.html`), result.html, 'utf8');
          }
          counts[cached ? cached.contentHash === article.contentHash ? 'unchanged' : 'updated' : 'new']++;
        } else counts.unchanged++;
        // Re-evaluate cached text when classification rules are improved.
        article = { ...article, classification: classify(article.title), eligibility: inferEligibility(article.body) };
        article.sourceIds = [...new Set([...(cached?.sourceIds ?? []), source.id])];
        article.lastSeenAt = startedAt;
        state.articles[entry.id] = article;
        await writeJson(resolve(dataRoot, 'articles', `${entry.id}.json`), article);
        ids.push(entry.id);
      } catch (error) {
        counts.failed++;
        errors.push({ id: entry.id, reason: error.message });
        if (cached) ids.push(entry.id);
        else if (entry.publishedAt) {
          const listArticle = { ...listOnlyArticle(entry, new Date().toISOString()), sourceIds: [source.id] };
          state.articles[entry.id] = listArticle;
          await writeJson(resolve(dataRoot, 'articles', `${entry.id}.json`), listArticle);
          ids.push(entry.id);
        }
      }
    }
    const listOnlyCount = ids.filter(id => state.articles[id]?.listOnly).length;
    state.sources[source.id] = { ...source, state: errors.length === entries.length && !ids.length ? 'failed' : errors.length || listOnlyCount ? 'partial' : 'ok', lastAttemptAt: startedAt, lastSuccessAt: ids.length ? new Date().toISOString() : previous.lastSuccessAt ?? null, articleIds: ids, error: errors.length ? `${errors.length} 条通知正文读取失败` : null, listOnlyCount, errors };
    console.log(`${source.name}：发现 ${entries.length} 条，读取 ${ids.length} 条${errors.length ? `，失败 ${errors.length} 条` : ''}`);
  } catch (error) {
    counts.failed++;
    state.sources[source.id] = { ...previous, ...source, state: 'failed', lastAttemptAt: startedAt, lastSuccessAt: previous.lastSuccessAt ?? null, articleIds: previous.articleIds ?? [], error: error.message };
    console.log(`${source.name}：暂未同步（${error.message}）`);
  }
  await writeJson(statePath, state);
}

const visible = new Map();
let hiddenCount = 0;
let duplicateCount = 0;
const activeIds = new Set(Object.values(state.sources).flatMap(source => source.articleIds ?? []));
for (const id of activeIds) {
  const article = state.articles[id];
  if (!article) continue;
  if (article.classification.visibility === 'hidden' || article.eligibility.status === 'excluded' || !article.publishedAt) { hiddenCount++; continue; }
  if (visible.has(article.contentHash)) { duplicateCount++; continue; }
  const source = schoolSources.find(source => source.id === article.sourceIds[0]);
  if (source) visible.set(article.contentHash, toInformation(article, source));
}
const feed = {
  schemaVersion: 1, generatedAt: new Date().toISOString(),
  items: [...visible.values()].sort((a, b) => b.publishedAt.localeCompare(a.publishedAt)),
  sources: schoolSources.map(source => { const result = state.sources[source.id]; return { ...source, sourceType: 'school', state: result?.state ?? 'pending', lastAttemptAt: result?.lastAttemptAt ?? null, lastSuccessAt: result?.lastSuccessAt ?? null, count: result?.articleIds?.length ?? 0, error: result?.error ?? null, note: result?.listOnlyCount ? `${result.listOnlyCount} 条仅有官网列表标题与日期，正文暂未读取，请查看原文。` : source.note }; }),
  statistics: { ...counts, totalCollected: activeIds.size, visible: visible.size, hidden: hiddenCount, duplicates: duplicateCount },
};
await writeFeed('sanjiang-web.json', feed);
console.log(`完成：${feed.items.length} 条可展示，${hiddenCount} 条留后台，${duplicateCount} 条重复。来源异常不会清除已有记录。`);
if (feed.sources.every(source => source.state === 'failed' || source.state === 'pending')) process.exitCode = 1;
