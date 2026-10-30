import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createIdentityAuth, handleIdentityRequest } from './identity-auth.mjs';
import { createRadarServer } from './serve-radar.mjs';
import { readSecret, saveSecret } from './local-secrets.mjs';

const roster = [{ name: '测试甲', studentId: '001234567890' }, { name: '测试乙', studentId: '009876543210' }];
const openLimits = { globalPerMinute: 1000, globalBurst: 1000, ipPerMinute: 1000, ipBurst: 1000 };
const fakeRequest = (address = '127.0.0.1', headers = {}) => ({ headers, socket: { remoteAddress: address } });

async function fixture(t, options = { roster, limits: openLimits }) {
  const auth = await createIdentityAuth(options);
  const server = http.createServer(async (req, res) => {
    if (!await handleIdentityRequest(req, res, auth)) { res.writeHead(404); res.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path = '/api/identity/session', { method = 'GET', input, headers = {}, raw } = {}) {
    return new Promise((done, fail) => {
      const req = http.request(base + path, { method, headers: { ...(method === 'POST' ? { Origin: base, 'Content-Type': 'application/json' } : {}), ...headers } }, response => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', value => { text += value; });
        response.once('end', () => {
          const responseHeaders = new Headers();
          for (let index = 0; index < response.rawHeaders.length; index += 2) responseHeaders.append(response.rawHeaders[index], response.rawHeaders[index + 1]);
          done({ status: response.statusCode, headers: responseHeaders, text, body: text ? JSON.parse(text) : null });
        });
      });
      req.once('error', fail);
      req.end(raw ?? (input === undefined ? undefined : JSON.stringify(input)));
    });
  }
  const confirm = (input = roster[0], options = {}) => request('/api/identity/confirm', { method: 'POST', input, ...options });
  return { auth, request, confirm, base };
}

test('default and invalid public storage paths stay disabled without collecting a pair', async t => {
  const { request, confirm } = await fixture(t, {});
  assert.deepEqual((await request()).body, { enabled: false, confirmed: false, name: null });
  const failed = await confirm();
  assert.equal(failed.status, 503);
  assert.equal(failed.headers.get('set-cookie'), null);
  for (const rosterPath of ['public/data/roster.dpapi', 'out/roster.dpapi', '../roster.dpapi']) {
    const auth = await createIdentityAuth({ rosterPath });
    assert.equal((await auth.session(fakeRequest())).enabled, false);
  }
});

test('only a complete matching pair confirms; failure never distinguishes which field exists', async t => {
  const { request, confirm } = await fixture(t);
  let failure;
  for (const input of [
    { name: roster[0].name, studentId: roster[1].studentId },
    { name: '不存在', studentId: roster[0].studentId },
    { name: roster[0].name, studentId: '1234567890' },
    { name: roster[0].name, studentId: 1234567890 },
    { name: { trim: 1 }, studentId: roster[0].studentId },
    { name: roster[0].name, studentId: roster[0].studentId, extra: true },
    {}, null,
  ]) {
    const result = await confirm(input);
    assert.equal(result.status, 401);
    failure ??= result.text;
    assert.equal(result.text, failure);
    assert.equal(result.headers.get('set-cookie'), null);
    assert.equal((await request()).body.confirmed, false);
  }
  const result = await confirm({ name: ` ${roster[0].name} `, studentId: ` ${roster[0].studentId} ` });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { enabled: true, confirmed: true, name: roster[0].name });
  assert.doesNotMatch(result.text, /studentId|001234567890|009876543210/);
  assert.match(result.headers.get('set-cookie'), /^sanjiang_identity=[A-Za-z0-9_-]{43}; HttpOnly; SameSite=Strict; Path=\/api\/identity; Max-Age=/);
  assert.match(result.headers.get('set-cookie'), /Max-Age=2592000$/);
  assert.equal(result.headers.get('cache-control'), 'no-store');
  const cookie = result.headers.get('set-cookie').split(';')[0];
  assert.deepEqual((await request(undefined, { headers: { Cookie: cookie } })).body, result.body);
  assert.equal((await request()).body.confirmed, false);
  assert.equal((await request(undefined, { headers: { Cookie: `${cookie}; ${cookie}` } })).body.confirmed, false);
  for (const path of ['/api/identity', '/api/identity/roster', '/api/identity/list', '/api/identity/unknown']) {
    const denied = await request(path);
    assert.equal(denied.status, 404);
    assert.doesNotMatch(denied.text, /测试甲|测试乙|studentId/);
  }
});

test('same-origin JSON, body boundaries and query rejection protect personal submissions', async t => {
  const { request, confirm, auth } = await fixture(t);
  assert.equal((await confirm(roster[0], { headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await confirm(roster[0], { headers: { Origin: '' } })).status, 403);
  assert.equal((await confirm(roster[0], { headers: { Origin: 'http://public.example', Host: 'public.example' } })).status, 403);
  assert.equal((await confirm(roster[0], { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await confirm(undefined, { raw: '{broken' })).status, 400);
  assert.equal((await confirm(undefined, { raw: 'x'.repeat(4097) })).status, 413);
  const query = await request('/api/identity/session?studentId=private-value');
  assert.equal(query.status, 400);
  assert.doesNotMatch(query.text, /private-value/);
  const secure = await confirm(roster[0], { headers: { Origin: 'https://radar.example', Host: 'radar.example' } });
  assert.equal(secure.status, 200);
  assert.match(secure.headers.get('set-cookie'), /; Secure$/);
  assert.match(auth.cookie('', true, true), /Max-Age=0; Secure$/);
});

test('TLS-terminating loopback proxy preserves exact public Origin and Secure cookies without trusting forwarded headers', async t => {
  const { request, confirm } = await fixture(t);
  const host = 'identity-probe.example-tailnet.ts.net';
  const origin = `https://${host}`;
  const result = await confirm(roster[0], { headers: { Host: host, Origin: origin, 'X-Forwarded-Proto': 'http', 'X-Forwarded-Host': 'untrusted.example' } });
  assert.equal(result.status, 200);
  const cookie = result.headers.get('set-cookie').split(';')[0];
  assert.match(result.headers.get('set-cookie'), /; Secure$/);
  const restored = await request(undefined, { headers: { Host: host, Cookie: cookie, 'X-Forwarded-Proto': 'http' } });
  assert.equal(restored.body.confirmed, true);
  assert.match(restored.headers.get('set-cookie'), /; Secure$/);
  const spoofed = await confirm(roster[0], { headers: { Host: '127.0.0.1', Origin: origin, 'X-Forwarded-Host': host, 'X-Forwarded-Proto': 'https' } });
  assert.equal(spoofed.status, 403);
  const logout = await request('/api/identity/logout', { method: 'POST', input: {}, headers: { Host: host, Origin: origin, Cookie: cookie } });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0; Secure$/);
});

test('IP and global budgets ignore every forged proxy identity', async t => {
  const { confirm } = await fixture(t, { roster, limits: { globalBurst: 20, globalPerMinute: 1, ipBurst: 1, ipPerMinute: 1 } });
  assert.equal((await confirm()).status, 200);
  const blocked = await confirm(roster[1], { headers: { 'X-Forwarded-For': '198.51.100.17', 'X-Real-IP': '198.51.100.18', Forwarded: 'for=198.51.100.19' } });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  const auth = await createIdentityAuth({ roster, limits: { globalBurst: 2, globalPerMinute: 1, ipBurst: 10, ipPerMinute: 10 } });
  auth.attempt(fakeRequest('192.0.2.1'));
  auth.attempt(fakeRequest('192.0.2.2'));
  assert.throws(() => auth.attempt(fakeRequest('192.0.2.3')), { statusCode: 429 });
});

test('confirmation rotates its session; logout and expiry invalidate cookies; synthetic memory-only sessions are isolated', async t => {
  const { request, confirm } = await fixture(t);
  const first = await confirm();
  const cookie = first.headers.get('set-cookie').split(';')[0];
  const second = await confirm(roster[1], { headers: { Cookie: cookie } });
  assert.equal((await request(undefined, { headers: { Cookie: cookie } })).body.confirmed, false);
  const nextCookie = second.headers.get('set-cookie').split(';')[0];
  const restarted = await createIdentityAuth({ roster });
  assert.equal((await restarted.session(fakeRequest('127.0.0.1', { cookie: nextCookie }))).confirmed, false);
  const foreignLogout = await request('/api/identity/logout', { method: 'POST', input: {}, headers: { Origin: 'https://attacker.example', Cookie: nextCookie } });
  assert.equal(foreignLogout.status, 403);
  assert.equal((await request(undefined, { headers: { Cookie: nextCookie } })).body.confirmed, true);
  const logout = await request('/api/identity/logout', { method: 'POST', input: {}, headers: { Cookie: nextCookie } });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal((await request(undefined, { headers: { Cookie: nextCookie } })).body.confirmed, false);
  const expiring = await createIdentityAuth({ roster, sessionMs: 15 });
  const result = await expiring.confirm(roster[0], fakeRequest());
  await new Promise(done => setTimeout(done, 25));
  assert.equal((await expiring.session(fakeRequest('127.0.0.1', { cookie: expiring.cookie(result.token) }))).confirmed, false);
});

test('active sessions roll after the half-life threshold and GET cookies retain public Secure without Origin', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  const day = 24 * 60 * 60 * 1000;
  const { auth, request, confirm } = await fixture(t);
  const first = await confirm();
  const cookie = first.headers.get('set-cookie').split(';')[0];
  t.mock.timers.tick(14 * day);
  const beforeThreshold = await request(undefined, { headers: { Cookie: cookie } });
  assert.equal(beforeThreshold.body.confirmed, true);
  assert.match(beforeThreshold.headers.get('set-cookie'), /Max-Age=1382400$/);
  t.mock.timers.tick(2 * day);
  const renewed = await request(undefined, { headers: { Cookie: cookie, Host: 'radar.example' } });
  assert.equal(renewed.body.confirmed, true);
  assert.match(renewed.headers.get('set-cookie'), /Max-Age=2592000; Secure$/);
  t.mock.timers.tick(16 * day);
  assert.equal((await request(undefined, { headers: { Cookie: cookie } })).body.confirmed, true, 'an active session survives the original expiry');
  t.mock.timers.tick(31 * day);
  const expired = await request(undefined, { headers: { Cookie: cookie } });
  assert.equal(expired.body.confirmed, false);
  assert.equal(expired.headers.get('set-cookie'), null, 'expired tokens cannot be renewed');

  const next = await confirm();
  const req = fakeRequest('127.0.0.1', { cookie: next.headers.get('set-cookie').split(';')[0] });
  t.mock.timers.tick(16 * day);
  const reading = auth.session(req);
  await auth.revokeAll();
  assert.equal((await reading).confirmed, false, 'revocation between read and renewal cannot recreate a memory session');
  assert.equal((await auth.session(req)).confirmed, false);
});

test('DPAPI identity sessions survive restart but not logout, expiry, revocation, roster changes or corrupted storage', { skip: process.platform !== 'win32' }, async t => {
  const privateRoot = fileURLToPath(new URL('../.sites-runtime/identity/', import.meta.url));
  await mkdir(privateRoot, { recursive: true });
  const directory = await mkdtemp(join(privateRoot, 'session-test-'));
  t.after(async () => {
    assert.equal(dirname(directory), resolve(privateRoot));
    assert.ok(basename(directory).startsWith('session-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  const sessionDirectory = join(directory, 'sessions');
  const rosterPath = join(directory, 'roster.dpapi');
  await saveSecret(rosterPath, JSON.stringify(roster));
  const options = { rosterPath, sessionDirectory };
  let auth = await createIdentityAuth(options);
  let result = await auth.confirm(roster[0], fakeRequest());
  let req = fakeRequest('127.0.0.1', { cookie: auth.cookie(result.token).split(';')[0] });
  let names = await readdir(sessionDirectory);
  assert.equal(names.length, 1);
  assert.match(names[0], /^[a-f0-9]{64}\.dpapi$/);
  const encrypted = await readFile(join(sessionDirectory, names[0]), 'utf8');
  for (const value of [result.token, roster[0].name, roster[0].studentId]) assert.ok(!encrypted.includes(value));
  const stored = JSON.parse(await readSecret(join(sessionDirectory, names[0])));
  assert.deepEqual(Object.keys(stored).sort(), ['expiresAt', 'name', 'revision']);
  assert.ok(stored.expiresAt > Date.now() + 29 * 24 * 60 * 60 * 1000);
  auth = await createIdentityAuth(options);
  assert.equal((await auth.session(req)).name, roster[0].name);
  assert.equal((await auth.session(fakeRequest('127.0.0.1', { cookie: `sanjiang_identity=${'a'.repeat(43)}` }))).confirmed, false);

  const path = join(sessionDirectory, names[0]);
  const halfLife = { ...stored, expiresAt: Date.now() + 14 * 24 * 60 * 60 * 1000 };
  await saveSecret(path, JSON.stringify(halfLife));
  let cookieExpiry;
  assert.equal((await auth.session(req, (_token, expiresAt) => { cookieExpiry = expiresAt; })).confirmed, true);
  const refreshed = JSON.parse(await readSecret(path));
  assert.ok(refreshed.expiresAt > Date.now() + 29 * 24 * 60 * 60 * 1000);
  assert.equal(cookieExpiry, refreshed.expiresAt);
  assert.equal((await (await createIdentityAuth(options)).session(req)).confirmed, true);
  const stableCiphertext = await readFile(path, 'utf8');
  await auth.session(req);
  assert.equal(await readFile(path, 'utf8'), stableCiphertext, 'fresh sessions must not be rewritten on every read');

  await saveSecret(path, JSON.stringify(halfLife));
  const owner = await createIdentityAuth(options);
  const outcomes = await Promise.allSettled([auth.session(req), owner.revokeAll()]);
  assert.equal(outcomes[1].status, 'fulfilled');
  assert.equal((await auth.session(req)).confirmed, false, 'concurrent owner revocation and renewal cannot leave a resurrected session');
  result = await auth.confirm(roster[0], fakeRequest());
  req = fakeRequest('127.0.0.1', { cookie: auth.cookie(result.token).split(';')[0] });

  await auth.logout(req);
  assert.equal((await (await createIdentityAuth(options)).session(req)).confirmed, false);
  result = await auth.confirm(roster[0], fakeRequest());
  req = fakeRequest('127.0.0.1', { cookie: auth.cookie(result.token).split(';')[0] });
  await (await createIdentityAuth(options)).revokeAll();
  assert.equal((await auth.session(req)).confirmed, false, 'a running server must observe owner revocation');

  result = await auth.confirm(roster[0], fakeRequest());
  req = fakeRequest('127.0.0.1', { cookie: auth.cookie(result.token).split(';')[0] });
  names = await readdir(sessionDirectory);
  const expiredPath = join(sessionDirectory, names[0]);
  const expired = JSON.parse(await readSecret(expiredPath));
  await saveSecret(expiredPath, JSON.stringify({ ...expired, expiresAt: Date.now() - 1 }));
  assert.equal((await (await createIdentityAuth(options)).session(req)).confirmed, false);

  result = await auth.confirm(roster[0], fakeRequest());
  req = fakeRequest('127.0.0.1', { cookie: auth.cookie(result.token).split(';')[0] });
  const changed = await createIdentityAuth({ roster: [roster[1]], sessionDirectory });
  assert.equal((await changed.session(req)).confirmed, false, 'a changed roster invalidates old sessions');
  result = await auth.confirm(roster[0], fakeRequest());
  req = fakeRequest('127.0.0.1', { cookie: auth.cookie(result.token).split(';')[0] });
  names = await readdir(sessionDirectory);
  await writeFile(join(sessionDirectory, names[0]), 'sju-dpapi-v1:corrupt-test-only');
  await assert.rejects(auth.session(req), /凭证保护失败/);

  const service = await fixture(t, options);
  assert.equal(dirname(sessionDirectory), directory);
  await rm(sessionDirectory, { recursive: true, force: true });
  const failedSave = await service.confirm();
  assert.equal(failedSave.status, 503);
  assert.equal(failedSave.headers.get('set-cookie'), null, 'a failed durable write must never issue a login cookie');
  assert.doesNotMatch(failedSave.text, /测试甲|001234567890|dpapi/);

  for (const invalid of ['public/sessions', privateRoot]) {
    const disabled = await createIdentityAuth({ roster, sessionDirectory: invalid });
    assert.equal((await disabled.session(fakeRequest())).enabled, false);
  }
});

test('bad injected rosters and configuration fail closed', async () => {
  for (const rows of [[], [...roster, roster[0]], [{ name: '测试', studentId: 123 }], [{ name: '测试\n', studentId: '001' }]]) {
    await assert.rejects(createIdentityAuth({ roster: rows }));
  }
  await assert.rejects(createIdentityAuth({ roster, rosterPath: 'public/roster.dpapi' }));
  await assert.rejects(createIdentityAuth({ limits: { ipBurst: 0 } }));
  await assert.rejects(createIdentityAuth({ sessionMs: 31 * 24 * 60 * 60 * 1000 }));
  await assert.rejects(createIdentityAuth({ testMode: true, rosterPath: 'not-read.dpapi' }));
});

test('existing radar server mounts a disabled identity endpoint and accepts explicit private-process injection', async t => {
  const root = await mkdtemp(join(tmpdir(), 'radar-identity-test-'));
  await writeFile(join(root, 'index.html'), '<html><body>public fixture</body></html>');
  t.after(async () => {
    assert.equal(dirname(root), resolve(tmpdir()));
    assert.ok(basename(root).startsWith('radar-identity-test-'));
    await rm(root, { recursive: true, force: true });
  });
  for (const identityAuth of [undefined, await createIdentityAuth({ roster })]) {
    const server = await createRadarServer({ root, assistantStore: {}, adminAuth: {}, likesStore: {}, identityAuth, log: () => {} });
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    try {
      const base = `http://127.0.0.1:${server.address().port}`;
      const session = await (await fetch(base + '/api/identity/session')).json();
      assert.deepEqual(session, { enabled: Boolean(identityAuth), confirmed: false, name: null });
      const result = await fetch(base + '/api/identity/confirm', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(roster[0]) });
      assert.equal(result.status, identityAuth ? 200 : 503);
      assert.equal((await fetch(base)).status, 200);
    } finally { await new Promise(done => server.close(done)); }
  }
});
