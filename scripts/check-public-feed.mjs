import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectRoot } from './feed-files.mjs';
import { PUBLIC_FEEDS, assertPublicFeed } from '../sources/public-feed.mjs';

for (const name of PUBLIC_FEEDS) {
  const raw = await readFile(resolve(projectRoot, 'public/data', name), 'utf8');
  if (Buffer.byteLength(raw) > 5 * 1024 * 1024) throw new Error('公开数据超过大小限制');
  assertPublicFeed(JSON.parse(raw));
}
console.log(`公开数据检查通过：${PUBLIC_FEEDS.length} 个来源，无额外账号字段或危险链接。`);
