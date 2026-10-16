import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { PUBLIC_FEEDS, assertPublicFeed } from '../sources/public-feed.mjs';
export const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export async function readFeed(name) {
  try { return JSON.parse(await readFile(resolve(projectRoot, 'public/data', name), 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
}
export async function writeFeed(name, feed) {
  if (!PUBLIC_FEEDS.includes(name)) throw new Error('未知公开数据文件');
  assertPublicFeed(feed);
  const serialized = JSON.stringify(feed, null, 2) + '\n';
  if (Buffer.byteLength(serialized) > 5 * 1024 * 1024) throw new Error('公开数据超过大小限制');
  const target = resolve(projectRoot, 'public/data', name);
  const suffix = `.${randomUUID()}.tmp`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target + suffix, serialized, 'utf8');
  await rename(target + suffix, target);
  try {
    await readFile(resolve(projectRoot, 'out/index.html'));
    await mkdir(resolve(projectRoot, 'out/data'), { recursive: true });
    const preview = resolve(projectRoot, 'out/data', name);
    await writeFile(preview + suffix, serialized, 'utf8');
    await rename(preview + suffix, preview);
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
