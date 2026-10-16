import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { readPuActivities } from '../sources/pu/read-session.mjs';
import { toPuInformation } from '../sources/pu/normalize.mjs';
import { projectRoot, readFeed, writeFeed } from './feed-files.mjs';
import { secureDirectory } from './local-secrets.mjs';

const { values } = parseArgs({ options: { 'max-pages': { type: 'string', default: '20' } } });
const maxPages = Number(values['max-pages']);
if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 50) throw new Error('max-pages 必须在 1–50 之间');
const previous = await readFeed('pu.json');
const previousSource = previous?.sources?.[0];
const listingRoot = resolve(projectRoot, '.sites-runtime/collectors/pu');
await secureDirectory(listingRoot);
let previousItems = previous?.items || [];
try { previousItems = JSON.parse(await readFile(resolve(listingRoot, 'details.json'), 'utf8')).items; }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const attemptedAt = new Date().toISOString();
const result = await readPuActivities(resolve(projectRoot, '.sites-runtime/pu/browser-profile'), maxPages, previousItems);
const byId = new Map(previousItems.map(item => [item.id, item]));
const currentIds = new Set();
for (const activity of result.activities || []) {
  const old = byId.get(`pu-${activity.id}`);
  if (activity.archived) continue;
  if (activity.reusePrevious && old) { byId.set(old.id, { ...old, sourceAvailable: true }); currentIds.add(old.id); continue; }
  const item = toPuInformation(activity, attemptedAt, old);
  if (!activity.detailRead && old?.detailRead) {
    byId.set(item.id, { ...old, sourceAvailable: true });
  } else byId.set(item.id, item);
  currentIds.add(item.id);
}
if (result.complete && result.state === 'ok') {
  const listedIds = new Set((result.activities || []).map(activity => `pu-${activity.id}`));
  for (const [id, item] of byId) if (!listedIds.has(id)) byId.set(id, { ...item, sourceAvailable: false });
}
await mkdir(listingRoot, { recursive: true });
if (result.activities?.length) await writeFile(resolve(listingRoot, 'listing.json'), JSON.stringify({ fetchedAt: attemptedAt, complete: result.complete, activities: result.activities }, null, 2));
await writeFile(resolve(listingRoot, 'details.json'), JSON.stringify({ items: [...byId.values()] }, null, 2));
const successful = result.state !== 'failed';
const freshmanItems = [...byId.values()].filter(item => item.freshmanAllowed !== 'excluded');
const feed = { schemaVersion: 1, generatedAt: attemptedAt, items: freshmanItems,
  sources: [{ id: 'sju-pu', name: 'PU口袋校园 · 三江学院', url: 'https://class.pocketuni.net/activity', sourceType: 'pu',
    state: result.state, count: freshmanItems.length, collectedCount: byId.size, lastAttemptAt: attemptedAt,
    lastSuccessAt: successful ? attemptedAt : previousSource?.lastSuccessAt || null,
    error: result.reason || result.errors?.join('；') || null,
    note: `本次发现 ${result.activities?.length ?? 0} 条账号可见活动，只展示面向 2026 级或资格待确认的内容；已截止活动默认隐藏。名额以 PU 为准。`,
    observedTotal: result.expectedCount ?? previousSource?.observedTotal ?? null,
    pagesRead: result.pagesRead || 0, complete: result.complete || false,
    archivedCount: result.activities?.filter(activity => activity.archived).length || 0,
  }] };
await writeFeed('pu.json', feed);
console.log(`PU：${result.state}，本次发现 ${result.activities?.length ?? 0} 条，已保存详情 ${byId.size} 条，新生页面保留 ${freshmanItems.length} 条。`);
if (!successful) process.exitCode = 1;
