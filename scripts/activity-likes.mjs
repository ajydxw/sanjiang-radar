import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { secureDirectory } from './local-secrets.mjs';
import { PUBLIC_FEEDS, assertPublicFeed } from '../sources/public-feed.mjs';

const runtime = fileURLToPath(new URL('../.sites-runtime/', import.meta.url));
const COOKIE = 'radar_likes';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const HASH = /^[a-f0-9]{64}$/;
const fail = (statusCode, message) => Object.assign(new Error(message), { statusCode });
const unavailable = () => fail(503, '点赞存储暂不可用，请稍后重试。');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const keysAre = (value, keys) => object(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
const validId = value => typeof value === 'string' && value.length > 0 && value.length <= 200
  && !/[\/\\\x00-\x20\x7f?#]/u.test(value) && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(value);
const hashToken = token => createHash('sha256').update(token).digest('hex');
const validToken = token => typeof token === 'string' && TOKEN.test(token);
const inside = (root, path) => {
  const part = relative(root, path);
  return part && !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
};

async function publicIds() {
  const ids = new Set();
  for (const name of PUBLIC_FEEDS) {
    const feed = JSON.parse(await readFile(new URL(`../public/data/${name}`, import.meta.url), 'utf8'));
    assertPublicFeed(feed);
    for (const item of feed.items) if (!item.demo && item.freshmanAllowed !== 'excluded') ids.add(item.id);
  }
  return ids;
}

export async function createLikeStore({ directory = resolve(runtime, 'activity-likes'), getAllowedIds = publicIds, limits = {} } = {}) {
  directory = resolve(directory);
  if (!inside(runtime, directory) || directory.split(/[\\/]/).some(part => /^(out|public)$/i.test(part))) {
    throw new Error('点赞数据必须保存在本项目私有运行目录。');
  }
  const budget = { writesPerMinute: 300, writesPerVisitorPerMinute: 30, maxVisitors: 10000, maxLikes: 100000,
    maxLikesPerVisitor: 5000, maxAllowedIds: 25000, maxBytes: 16 * 1024 * 1024, maxPending: 64, lockWaitMs: 2000, ...limits };
  if (Object.values(budget).some(value => !Number.isSafeInteger(value) || value <= 0) || typeof getAllowedIds !== 'function') {
    throw new Error('Invalid likes limit');
  }
  for (let path = directory; ; path = resolve(path, '..')) {
    try { if ((await lstat(path)).isSymbolicLink()) throw unavailable(); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (relative(runtime, path) === '') break;
  }
  if (process.platform === 'win32') await secureDirectory(directory);
  else { await mkdir(directory, { recursive: true, mode: 0o700 }); await chmod(directory, 0o700); }
  if (!inside(await realpath(runtime), await realpath(directory))) throw unavailable();
  const file = resolve(directory, 'likes.json');
  const lock = resolve(directory, '.write-lock');
  let queue = Promise.resolve();
  let pending = 0;

  async function allowedIds() {
    try {
      const ids = new Set(await getAllowedIds());
      if (ids.size > budget.maxAllowedIds || [...ids].some(id => !validId(id))) throw unavailable();
      return ids;
    } catch { throw unavailable(); }
  }

  function validate(state) {
    if (!keysAre(state, ['version', 'visitors', 'rate']) || state.version !== 1 || !object(state.visitors)
      || !keysAre(state.rate, ['since', 'total', 'visitors']) || !object(state.rate.visitors)
      || !Number.isSafeInteger(state.rate.since) || state.rate.since < 0
      || !Number.isSafeInteger(state.rate.total) || state.rate.total < 0) throw unavailable();
    const visitors = Object.entries(state.visitors);
    if (visitors.length > budget.maxVisitors) throw unavailable();
    let total = 0;
    for (const [hash, ids] of visitors) {
      if (!HASH.test(hash) || !Array.isArray(ids) || !ids.length || ids.length > budget.maxLikesPerVisitor
        || ids.some(id => !validId(id)) || new Set(ids).size !== ids.length) throw unavailable();
      total += ids.length;
    }
    const rates = Object.entries(state.rate.visitors);
    if (total > budget.maxLikes || rates.length > budget.writesPerMinute || state.rate.total > budget.writesPerMinute
      || rates.some(([hash, count]) => !HASH.test(hash) || !Number.isSafeInteger(count) || count <= 0 || count > budget.writesPerVisitorPerMinute)
      || rates.reduce((sum, [, count]) => sum + count, 0) !== state.rate.total) throw unavailable();
    return state;
  }

  async function read() {
    let handle;
    try {
      const entry = await lstat(file);
      if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1) throw unavailable();
      handle = await open(file, 'r');
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > budget.maxBytes) throw unavailable();
      const bytes = Buffer.alloc(Math.min(stat.size + 1, budget.maxBytes + 1));
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead !== stat.size) throw unavailable();
      return validate(JSON.parse(bytes.subarray(0, bytesRead).toString('utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return { version: 1, visitors: {}, rate: { since: 0, total: 0, visitors: {} } };
      throw unavailable();
    } finally { await handle?.close(); }
  }

  function summary(state, allowed, token) {
    const counts = Object.fromEntries([...allowed].map(id => [id, 0]));
    for (const ids of Object.values(state.visitors)) for (const id of ids) if (allowed.has(id)) counts[id] += 1;
    return { counts, likedIds: validToken(token) ? (state.visitors[hashToken(token)] ?? []).filter(id => allowed.has(id)) : [] };
  }

  async function write(state) {
    validate(state);
    const body = JSON.stringify(state);
    if (Buffer.byteLength(body) > budget.maxBytes) throw fail(503, '点赞存储已满，请稍后重试。');
    const temporary = resolve(directory, `.likes-${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }

  async function locked(action) {
    const deadline = performance.now() + budget.lockWaitMs;
    while (true) {
      try { await mkdir(lock, { mode: 0o700 }); break; }
      catch (error) {
        // Windows may report a just-removed directory as EACCES/EPERM until its handles close.
        if (!['EEXIST', 'EACCES', 'EPERM'].includes(error.code) || performance.now() >= deadline) throw unavailable();
        // A crashed writer's lock fails closed; the owner can inspect and remove it while the server is stopped.
        await delay(20);
      }
    }
    try { return await action(); }
    finally { await rmdir(lock); }
  }

  return {
    async summary(visitorToken) {
      const [state, allowed] = await Promise.all([read(), allowedIds()]);
      return summary(state, allowed, visitorToken);
    },
    async set(id, visitorToken, liked) {
      if (!validId(id) || !validToken(visitorToken) || typeof liked !== 'boolean') throw fail(400, '点赞请求格式不正确。');
      if (pending >= budget.maxPending) throw unavailable();
      pending += 1;
      const operation = queue.then(() => locked(async () => {
        const allowed = await allowedIds();
        if (!allowed.has(id)) throw fail(404, '活动不存在或暂不可点赞。');
        const state = await read();
        const hash = hashToken(visitorToken);
        const now = Date.now();
        if (now - state.rate.since >= 60000) state.rate = { since: now, total: 0, visitors: {} };
        if (state.rate.total >= budget.writesPerMinute || (state.rate.visitors[hash] ?? 0) >= budget.writesPerVisitorPerMinute) {
          throw fail(429, '操作太频繁，请稍后再试。');
        }
        const ids = new Set(state.visitors[hash] ?? []);
        if (liked) ids.add(id); else ids.delete(id);
        if (ids.size) state.visitors[hash] = [...ids]; else delete state.visitors[hash];
        if (Object.keys(state.visitors).length > budget.maxVisitors || ids.size > budget.maxLikesPerVisitor
          || Object.values(state.visitors).reduce((sum, entries) => sum + entries.length, 0) > budget.maxLikes) {
          throw fail(503, '点赞存储已满，请稍后重试。');
        }
        state.rate.total += 1;
        state.rate.visitors[hash] = (state.rate.visitors[hash] ?? 0) + 1;
        await write(state);
        return summary(state, allowed, visitorToken);
      }));
      queue = operation.catch(() => {});
      try { return await operation; }
      catch (error) { if (error.statusCode) throw error; throw unavailable(); }
      finally { pending -= 1; }
    },
  };
}

function requestHost(req) {
  const host = req.headers.host;
  if (req.rawHeaders && req.rawHeaders.filter((value, index) => index % 2 === 0 && value.toLowerCase() === 'host').length !== 1) return null;
  if (typeof host !== 'string' || /[\s/@\\?#]/u.test(host)) return null;
  try {
    const url = new URL(`https://${host}`);
    return url.host === host && !url.username && !url.password ? url : null;
  } catch { return null; }
}

function exactOrigin(req) {
  const host = requestHost(req);
  const origin = req.headers.origin;
  if (!host || typeof origin !== 'string') return false;
  try {
    const url = new URL(origin);
    return url.origin === origin && origin === `${url.protocol}//${req.headers.host}`
      && (url.protocol === 'https:' || url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname));
  } catch { return false; }
}

function cookieToken(req) {
  const cookies = (req.headers.cookie ?? '').split(';').map(value => value.trim()).filter(value => value.startsWith(`${COOKIE}=`));
  const token = cookies.length === 1 ? cookies[0].slice(COOKIE.length + 1) : '';
  return TOKEN.test(token) ? token : null;
}

async function readJson(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(req.headers['content-type'] ?? '')) throw fail(415, '请提交 JSON 格式。');
  if (Number(req.headers['content-length']) > 2048) throw fail(413, '提交内容过长。');
  const bytes = await new Promise((done, reject) => {
    const chunks = [];
    let length = 0, exceeded = false;
    req.on('data', chunk => {
      length += chunk.length;
      if (length > 2048) { if (!exceeded) { exceeded = true; reject(fail(413, '提交内容过长。')); } }
      else if (!exceeded) chunks.push(chunk);
    });
    req.once('end', () => { if (!exceeded) done(Buffer.concat(chunks)); });
    req.once('error', () => reject(fail(400, '提交未完成。')));
    req.once('aborted', () => reject(fail(400, '提交未完成。')));
  });
  let input;
  try { input = JSON.parse(bytes.toString('utf8')); } catch { throw fail(400, 'JSON 格式不正确。'); }
  if (!keysAre(input, ['liked']) || typeof input.liked !== 'boolean') throw fail(400, '仅接受 liked 布尔值。');
  return input;
}

export async function handleLikesRequest(req, res, store) {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/api/likes' && !path.startsWith('/api/likes/')) return false;
  const send = (status, body) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Vary', 'Cookie');
  try {
    const host = requestHost(req);
    if (!host) throw fail(400, '请求主机不正确。');
    if (path === '/api/likes' && req.method === 'GET') {
      if (Number(req.headers['content-length'] ?? 0) > 0 || req.headers['transfer-encoding'] !== undefined) throw fail(400, '此请求不接受正文。');
      let token = cookieToken(req);
      if (!token) {
        token = randomBytes(32).toString('base64url');
        const secure = !['127.0.0.1', 'localhost'].includes(host.hostname) || req.socket.encrypted === true || req.headers.origin?.startsWith('https://');
        res.setHeader('Set-Cookie', `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/api/likes; Max-Age=2592000${secure ? '; Secure' : ''}`);
      }
      send(200, await store.summary(token));
    } else if (path.startsWith('/api/likes/') && req.method === 'PUT') {
      if (!exactOrigin(req)) throw fail(403, '仅允许本站安全提交。');
      const token = cookieToken(req);
      if (!token) throw fail(428, '请先读取点赞状态。');
      let id;
      try { id = decodeURIComponent(path.slice('/api/likes/'.length)); } catch { throw fail(400, '活动编号不正确。'); }
      if (!validId(id)) throw fail(400, '活动编号不正确。');
      const { liked } = await readJson(req);
      send(200, await store.set(id, token, liked));
    } else {
      res.setHeader('Allow', path === '/api/likes' ? 'GET' : 'PUT');
      throw fail(405, '不支持此操作。');
    }
  } catch (error) {
    if (error.statusCode === 429) res.setHeader('Retry-After', '60');
    res.setHeader('Connection', 'close');
    send(error.statusCode ?? 503, { error: error.statusCode ? error.message : '点赞服务暂不可用。' });
  }
  return true;
}
