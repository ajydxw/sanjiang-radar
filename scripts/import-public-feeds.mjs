import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { PUBLIC_FEEDS, assertPublicFeed } from '../sources/public-feed.mjs';
import { projectRoot } from './feed-files.mjs';

const input = process.argv[2];
if (!input) throw new Error('请提供采集项目 public/data 目录的路径。');
// Validate all five snapshots before replacing any published feed.
const feeds = await Promise.all(PUBLIC_FEEDS.map(async name => {
  const raw = await readFile(resolve(input, name), 'utf8');
  if (Buffer.byteLength(raw) > 5 * 1024 * 1024) throw new Error('公开数据超过大小限制');
  assertPublicFeed(JSON.parse(raw));
  return { name, raw };
}));
for (const { name, raw } of feeds) await writeFile(resolve(projectRoot, 'public/data', name), raw);
console.log('已导入五份公开信息快照。提交并推送 main 后，GitHub Pages 会自动发布。');
