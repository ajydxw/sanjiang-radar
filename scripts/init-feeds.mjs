import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { projectRoot } from './feed-files.mjs';
import { PUBLIC_FEEDS, assertPublicFeed } from '../sources/public-feed.mjs';

await mkdir(resolve(projectRoot, 'public/data'), { recursive: true });
for (const name of PUBLIC_FEEDS) {
  const template = await readFile(resolve(projectRoot, 'examples/feeds', name), 'utf8');
  assertPublicFeed(JSON.parse(template));
  try { await writeFile(resolve(projectRoot, 'public/data', name), template, { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
console.log('公开数据目录已准备；保留已有数据。');
