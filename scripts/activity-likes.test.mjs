import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, rm, rmdir, symlink, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createLikeStore, handleLikesRequest } from './activity-likes.mjs';
import { PUBLIC_FEEDS, assertPublicFeed } from '../sources/public-feed.mjs';

const runtime = fileURLToPath(new URL('../.sites-runtime/', import.meta.url));
const token = () => randomBytes(32).toString('base64url');
const ids = ['pu-activity', 'school-activity'];
const unavailable = error => error.statusCode === 503;

async function fixture(t, { limits = {}, getAllowedIds = async () => ids, httpServer = true } = {}) {
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(resolve(runtime, 'activity-likes-test-'));
  let server;
  t.after(async () => {
    if (server) await new Promise(done => server.close(done));
    const part = relative(runtime, directory);
    assert.ok(part.startsWith('activity-likes-test-') && !part.includes(sep));
    await rm(directory, { recursive: true, force: true });
  });
  const store = await createLikeStore({ directory, getAllowedIds, limits });
  const baseOptions = { directory, getAllowedIds, limits };
  if (!httpServer) return { directory, store, baseOptions };
  server = http.createServer(async (req, res) => {
    if (!await handleLikesRequest(req, res, store)) { res.writeHead(404); res.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path = '/api/likes', { method = 'GET', input, raw, cookie, origin = base, headers = {} } = {}) {
    return new Promise((done, reject) => {
      const payload = raw ?? (input === undefined ? undefined : JSON.stringify(input));
      const req = http.request({ hostname: '127.0.0.1', port: server.address().port, path, method, headers: {
        ...(method === 'PUT' ? { Origin: origin } : {}),
        ...(payload !== undefined ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...(cookie ? { Cookie: cookie } : {}), ...headers,
      } }, res => {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.once('end', () => {
          const content = Buffer.concat(chunks).toString();
          const headers = new Headers();
          for (const [key, value] of Object.entries(res.headers)) if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(', ') : value);
          done({ status: res.statusCode, headers, body: content ? JSON.parse(content) : null });
        });
      });
      req.once('error', reject); req.end(payload);
    });
  }
  async function visitor(headers = {}) {
    const result = await request('/api/likes', { headers });
    assert.equal(result.status, 200);
    return { ...result, cookie: result.headers.get('set-cookie').split(';')[0] };
  }
  const put = (cookie, id = ids[0], liked = true, options = {}) => request(`/api/likes/${encodeURIComponent(id)}`, {
    cookie, method: 'PUT', input: { liked }, ...options,
  });
  return { directory, store, server, base, baseOptions, request, visitor, put };
}

test('two anonymous browsers share totals, keep their own likedIds, and PUT desired state is idempotent', async t => {
  const { visitor, request, put, store, directory, baseOptions } = await fixture(t);
  const first = await visitor();
  const second = await visitor();
  assert.notEqual(first.cookie, second.cookie);
  assert.deepEqual(first.body, { counts: { [ids[0]]: 0, [ids[1]]: 0 }, likedIds: [] });
  assert.equal((await put(first.cookie)).body.counts[ids[0]], 1);
  assert.equal((await put(first.cookie)).body.counts[ids[0]], 1);
  const secondView = await request('/api/likes', { cookie: second.cookie });
  assert.equal(secondView.body.counts[ids[0]], 1);
  assert.deepEqual(secondView.body.likedIds, []);
  assert.equal(secondView.headers.get('set-cookie'), null);
  assert.equal((await put(second.cookie)).body.counts[ids[0]], 2);
  await put(first.cookie, ids[1]);
  const own = await request('/api/likes', { cookie: first.cookie });
  assert.deepEqual(own.body.likedIds, ids);
  const restarted = await createLikeStore(baseOptions);
  assert.deepEqual(await restarted.summary(first.cookie.split('=')[1]), own.body);
  const cancelled = await put(first.cookie, ids[0], false);
  assert.equal(cancelled.body.counts[ids[0]], 1);
  assert.equal((await put(first.cookie, ids[0], false)).body.counts[ids[0]], 1);
  assert.equal((await put(second.cookie, ids[0], false)).body.counts[ids[0]], 0);
  assert.equal((await put(second.cookie, ids[0], false)).body.counts[ids[0]], 0);
  const saved = await readFile(resolve(directory, 'likes.json'), 'utf8');
  assert.ok(!saved.includes(first.cookie.split('=')[1]));
  assert.ok(!saved.includes(second.cookie.split('=')[1]));
  const hash = createHash('sha256').update(first.cookie.split('=')[1]).digest('hex');
  assert.ok(saved.includes(hash));
  assert.ok(!JSON.stringify(await store.summary()).includes(hash));
  assert.deepEqual((await request(`/api/likes?token=${first.cookie.split('=')[1]}&hash=${hash}`, { cookie: second.cookie })).body.likedIds, []);
});

test('cookie is HttpOnly, host-only, narrow scope and secure for public hosts', async t => {
  const { visitor, request, put } = await fixture(t);
  const first = await visitor();
  const cookie = first.headers.get('set-cookie');
  assert.match(cookie, /^radar_likes=[A-Za-z0-9_-]{43};/);
  assert.match(cookie, /; HttpOnly;/);
  assert.match(cookie, /; SameSite=Strict;/);
  assert.match(cookie, /; Path=\/api\/likes;/);
  assert.match(cookie, /; Max-Age=2592000/);
  assert.ok(!cookie.includes('Domain='));
  assert.ok(!cookie.includes('Secure'));
  assert.match((await visitor({ Host: 'radar.example' })).headers.get('set-cookie'), /; Secure$/);
  assert.equal((await put(null)).status, 428);
  assert.equal((await put('radar_likes=bad')).status, 428);
  assert.equal((await put(`${first.cookie}; ${first.cookie}`)).status, 428);
  assert.match((await request('/api/likes', { cookie: 'radar_likes=bad' })).headers.get('set-cookie'), /^radar_likes=/);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.headers.get('vary'), 'Cookie');
  assert.equal(first.headers.get('access-control-allow-origin'), null);
});

test('PUT requires an exact secure Origin and ignores forwarded identity and host headers', async t => {
  const { visitor, put, request, base } = await fixture(t);
  const { cookie } = await visitor();
  for (const origin of ['', 'null', 'https://evil.example', `${base}/`, `${base}.evil.example`, `${base}/path`, 'ftp://127.0.0.1']) {
    assert.equal((await put(cookie, ids[0], true, { origin })).status, 403, origin);
  }
  assert.equal((await put(cookie, ids[0], true, { origin: 'https://evil.example', headers: { 'X-Forwarded-Host': 'evil.example' } })).status, 403);
  assert.equal((await put(cookie, ids[0], true, { origin: 'http://radar.example', headers: { Host: 'radar.example', 'X-Forwarded-Proto': 'https' } })).status, 403);
  assert.equal((await put(cookie, ids[0], true, { origin: 'https://radar.example', headers: { Host: 'radar.example' } })).status, 200);
  assert.equal((await put(cookie, ids[0], false, { headers: { Host: '127.0.0.1@evil.example' } })).status, 400);
  assert.equal((await put(cookie, ids[0], false, { headers: { 'X-Forwarded-For': 'spoofed' } })).status, 200);
  assert.equal((await request('/api/likes', { method: 'POST' })).status, 405);
});

test('strict body, bounded ID and allowlist reject imports, counts and unknown activities', async t => {
  const { visitor, put, request } = await fixture(t);
  const { cookie } = await visitor();
  for (const input of [{}, [], null, true, { liked: 1 }, { liked: 'true' }, { liked: true, counts: { [ids[0]]: 99 } }, { liked: true, token: token() }, { liked: true, import: ids }]) {
    assert.equal((await put(cookie, ids[0], true, { input })).status, 400, JSON.stringify(input));
  }
  assert.equal((await put(cookie, ids[0], true, { raw: '{' })).status, 400);
  assert.equal((await put(cookie, ids[0], true, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await put(cookie, ids[0], true, { raw: JSON.stringify({ liked: true, extra: 'x'.repeat(2048) }) })).status, 413);
  assert.equal((await put(cookie, 'unknown-id')).status, 404);
  for (const id of ['', 'a'.repeat(201), '../private', 'a/b', 'a\\b', 'bad\n', '.', '..', '__proto__', 'constructor', 'prototype']) {
    assert.equal((await put(cookie, id)).status, 400, JSON.stringify(id));
  }
  assert.equal((await request('/api/likes/%GG', { cookie, method: 'PUT', input: { liked: true } })).status, 400);
  assert.deepEqual((await request('/api/likes', { cookie })).body.counts, { [ids[0]]: 0, [ids[1]]: 0 });
});

test('chunked oversized body and GET bodies are rejected', async t => {
  const { visitor, base } = await fixture(t);
  const { cookie } = await visitor();
  const raw = (path, method, headers, body) => new Promise((done, reject) => {
    const req = http.request(`${base}${path}`, { method, headers }, res => {
      res.resume(); res.once('end', () => done(res.statusCode));
    });
    req.once('error', reject); req.end(body);
  });
  assert.equal(await raw(`/api/likes/${ids[0]}`, 'PUT', { Origin: base, Cookie: cookie, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked' }, `{"liked":true,"x":"${'a'.repeat(3000)}"}`), 413);
  assert.equal(await raw('/api/likes', 'GET', { 'Content-Length': '2' }, '{}'), 400);
  assert.equal(await raw('/api/likes', 'GET', ['Host', new URL(base).host, 'Host', 'evil.example'], undefined), 400);
});

test('same-process concurrent writes across independent stores lose no likes', async t => {
  const { store, baseOptions } = await fixture(t, { httpServer: false });
  const other = await createLikeStore(baseOptions);
  const visitors = Array.from({ length: 20 }, token);
  await Promise.all(visitors.map((value, i) => (i % 2 ? store : other).set(ids[0], value, true)));
  assert.equal((await store.summary()).counts[ids[0]], 20);
  await Promise.all(visitors.map((value, i) => (i % 2 ? store : other).set(ids[0], value, false)));
  assert.equal((await store.summary()).counts[ids[0]], 0);
});

test('separate writer processes serialize using the private directory lock', async t => {
  const { store, directory } = await fixture(t, { httpServer: false });
  const module = new URL('./activity-likes.mjs', import.meta.url).href;
  const script = `const {createLikeStore}=await import(process.argv[1]); const store=await createLikeStore({directory:process.argv[2],getAllowedIds:async()=>['pu-activity']}); await store.set('pu-activity',process.argv[3],true); await store.set('pu-activity',process.argv[3],true);`;
  const run = value => new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script, module, directory, value], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
    let errors = '';
    child.stderr.setEncoding('utf8'); child.stderr.on('data', value => { errors += value; });
    child.once('error', reject);
    child.once('close', code => code === 0 ? done() : reject(new Error(errors)));
  });
  await Promise.all([run(token()), run(token())]);
  assert.equal((await store.summary()).counts[ids[0]], 2);
});

test('global and per-browser limits are persisted and do not trust forwarded IP', async t => {
  const { visitor, put, baseOptions } = await fixture(t, { limits: { writesPerMinute: 3, writesPerVisitorPerMinute: 2 } });
  const first = await visitor();
  const second = await visitor();
  const third = await visitor();
  await put(first.cookie);
  await put(first.cookie, ids[0], true);
  const throttled = await put(first.cookie, ids[0], false, { headers: { 'X-Forwarded-For': '1.2.3.4' } });
  assert.equal(throttled.status, 429);
  assert.equal(throttled.headers.get('retry-after'), '60');
  assert.equal((await put(second.cookie)).status, 200);
  assert.equal((await put(third.cookie)).status, 429);
  const restarted = await createLikeStore(baseOptions);
  await assert.rejects(restarted.set(ids[0], token(), true), error => error.statusCode === 429);
  assert.equal((await restarted.summary()).counts[ids[0]], 2);
});

test('public allowlist refresh hides withdrawn IDs and rejects new writes without deleting stored history', async t => {
  let allowed = [...ids];
  const { store, directory } = await fixture(t, { httpServer: false, getAllowedIds: async () => allowed });
  const visitor = token();
  await store.set(ids[0], visitor, true);
  const saved = await readFile(resolve(directory, 'likes.json'), 'utf8');
  allowed = [ids[1]];
  assert.deepEqual(await store.summary(visitor), { counts: { [ids[1]]: 0 }, likedIds: [] });
  await assert.rejects(store.set(ids[0], visitor, false), error => error.statusCode === 404);
  assert.equal(await readFile(resolve(directory, 'likes.json'), 'utf8'), saved);
  allowed = [...ids];
  assert.equal((await store.summary(visitor)).counts[ids[0]], 1);
});

test('default allowlist reads validated five public feeds and excludes demos and ineligible activities', async t => {
  const { directory } = await fixture(t, { httpServer: false });
  const expected = new Set();
  for (const name of PUBLIC_FEEDS) {
    const feed = JSON.parse(await readFile(new URL(`../public/data/${name}`, import.meta.url), 'utf8'));
    assertPublicFeed(feed);
    feed.items.filter(item => !item.demo && item.freshmanAllowed !== 'excluded').forEach(item => expected.add(item.id));
  }
  const store = await createLikeStore({ directory });
  assert.deepEqual(new Set(Object.keys((await store.summary()).counts)), expected);
});

test('invalid persisted data fails with 503 and is never silently reset', async t => {
  const { store, directory, visitor, request } = await fixture(t);
  const first = await visitor();
  const file = resolve(directory, 'likes.json');
  await store.set(ids[0], first.cookie.split('=')[1], true);
  const original = JSON.parse(await readFile(file, 'utf8'));
  const malformed = [
    '{broken',
    JSON.stringify({ ...original, counts: { [ids[0]]: 123 } }),
    JSON.stringify({ ...original, visitors: { [token()]: [ids[0]] } }),
    JSON.stringify({ ...original, visitors: { [Object.keys(original.visitors)[0]]: [ids[0], ids[0]] } }),
  ];
  for (const body of malformed) {
    await writeFile(file, body);
    await assert.rejects(store.summary(), unavailable);
    await assert.rejects(store.set(ids[0], token(), true), unavailable);
    assert.equal((await request('/api/likes', { cookie: first.cookie })).status, 503);
    assert.equal(await readFile(file, 'utf8'), body);
  }
});

test('storage paths, symlinks, stale locks and capacity fail closed', async t => {
  await assert.rejects(createLikeStore({ directory: resolve(runtime, '..', 'public', 'likes') }));
  await assert.rejects(createLikeStore({ directory: resolve(runtime, '..', 'out', 'likes') }));
  await assert.rejects(createLikeStore({ directory: runtime }));
  const { store, directory, baseOptions } = await fixture(t, { httpServer: false, limits: { maxVisitors: 1, maxLikes: 1, lockWaitMs: 40 } });
  const first = token();
  await store.set(ids[0], first, true);
  await assert.rejects(store.set(ids[0], token(), true), unavailable);
  assert.equal((await store.summary()).counts[ids[0]], 1);
  const lock = resolve(directory, '.write-lock');
  await mkdir(lock);
  await assert.rejects(store.set(ids[0], first, false), unavailable);
  await rmdir(lock);
  await store.set(ids[0], first, false);
  assert.equal((await store.summary()).counts[ids[0]], 0);
  const linked = resolve(directory, 'linked');
  await symlink(directory, linked, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(createLikeStore({ ...baseOptions, directory: linked }), unavailable);
  await rmdir(linked);
});

test('file size, allowlist failures and per-browser activity capacity are bounded', async t => {
  const { directory } = await fixture(t, { httpServer: false });
  const options = { directory, getAllowedIds: async () => ids };
  const small = await createLikeStore({ ...options, limits: { maxBytes: 100 } });
  await assert.rejects(small.set(ids[0], token(), true), unavailable);
  assert.equal((await small.summary()).counts[ids[0]], 0);
  const one = await createLikeStore({ ...options, limits: { maxLikesPerVisitor: 1 } });
  const visitor = token();
  await one.set(ids[0], visitor, true);
  await assert.rejects(one.set(ids[1], visitor, true), unavailable);
  const unavailableFeed = await createLikeStore({ directory, getAllowedIds: async () => { throw new Error('private feed error'); } });
  await assert.rejects(unavailableFeed.summary(), unavailable);
  const tooMany = await createLikeStore({ ...options, limits: { maxAllowedIds: 1 } });
  await assert.rejects(tooMany.summary(), unavailable);
  await writeFile(resolve(directory, 'likes.json'), 'a'.repeat(2049));
  const size = await createLikeStore({ ...options, limits: { maxBytes: 2048 } });
  await assert.rejects(size.summary(), unavailable);
});
