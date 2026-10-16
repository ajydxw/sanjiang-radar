import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import http from 'node:http';
import { relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAdminAuth, handleAdminRequest } from './admin-auth.mjs';
import { createAssistantStore, handleAssistantRequest } from './assistant-questions.mjs';
import { createAdminSetupServer } from './setup-admin.mjs';

const runtime = fileURLToPath(new URL('../.sites-runtime/', import.meta.url));
const publication = { status: 'answered', answer: '请按当期通知核对。', sources: [], model: 'gpt-6.1-sol', reasoningEffort: 'high' };
const password = () => randomBytes(24).toString('base64url');

async function rawStatus(base, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((done, reject) => {
    const req = http.request(base + path, { method, headers }, res => { res.resume(); res.once('end', () => done(res.statusCode)); });
    req.once('error', reject); req.end(body);
  });
}

async function fixture(t, options = {}) {
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(resolve(runtime, 'admin-auth-test-'));
  const adminDirectory = resolve(directory, 'admin');
  const auth = await createAdminAuth({ username: 'admin', directory: adminDirectory, ...options });
  const store = await createAssistantStore({ directory: resolve(directory, 'questions') });
  const server = http.createServer(async (req, res) => {
    if (!await handleAdminRequest(req, res, { auth, store }) && !await handleAssistantRequest(req, res, store)) { res.writeHead(404); res.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(done => server.close(done));
    const path = relative(runtime, directory);
    assert.ok(path.startsWith('admin-auth-test-') && !path.includes(sep));
    await rm(directory, { recursive: true, force: true });
  });
  const request = async (path, { method = 'GET', input, cookie, csrf, origin = base, headers = {} } = {}) => {
    const response = await fetch(base + path, { method, headers: {
      ...(['POST', 'DELETE'].includes(method) ? { Origin: origin } : {}),
      ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...headers,
    }, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) });
    const body = await response.text();
    return { status: response.status, headers: response.headers, body: body ? JSON.parse(body) : null };
  };
  const login = async (value, options = {}) => {
    const result = await request('/api/admin/login', { method: 'POST', input: { username: await auth.getUsername(), password: value }, ...options });
    return { ...result, cookie: result.headers.get('set-cookie')?.split(';')[0], csrf: result.body?.csrfToken };
  };
  return { auth, store, base, request, login, directory, adminDirectory };
}

test('owner login, CSRF-protected private drafts, publication, deletion and logout', async t => {
  const { auth, store, request, login, directory, base } = await fixture(t, { limits: { burst: 10 } });
  assert.deepEqual((await request('/api/admin/session')).body, { configured: false, authenticated: false, username: null, csrfToken: null });
  const record = await store.create({ question: '考试报名怎么办？' });
  const path = `/api/admin/questions/${record.id}`;
  assert.equal((await request('/api/admin/questions')).status, 401);
  assert.equal((await request(path, { method: 'DELETE' })).status, 401);
  assert.equal((await request(path + '/publish', { method: 'POST', input: {} })).status, 401);
  const secret = password(); await auth.setPassword(secret);
  assert.equal((await login(password())).status, 401);
  const owner = await login(secret);
  assert.equal(owner.status, 200);
  assert.match(owner.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Path=\/api\/admin;/);
  assert.equal(owner.headers.get('set-cookie').includes('Secure'), false);
  const disk = await readFile(resolve(directory, 'admin/credentials.json'), 'utf8');
  assert.equal(disk.includes(secret), false);
  assert.match(JSON.parse(disk).hash, /^[a-f0-9]{128}$/);
  assert.equal((await request('/api/admin/session', owner)).body.authenticated, true);
  const draft = await store.stageDraft(record.id, publication);
  const listing = await request('/api/admin/questions', owner);
  assert.equal(listing.status, 200);
  assert.equal(listing.body.stats.ready, 1);
  assert.equal(listing.body.stats.pending, 1);
  assert.equal(listing.body.items[0].draft.draftId, draft.draft.draftId);
  assert.equal(JSON.stringify(listing.body).includes('tokenHash'), false);
  assert.equal(JSON.stringify(listing.body).includes(record.accessToken), false);
  assert.equal(listing.headers.get('access-control-allow-origin'), null);
  assert.equal((await request(`/api/assistant/questions/${record.id}`, { headers: { Authorization: `Bearer ${record.accessToken}` } })).body.draft, undefined);
  assert.equal((await request(path, { method: 'DELETE', cookie: owner.cookie })).status, 403);
  assert.equal((await request(path, { method: 'DELETE', ...owner, csrf: 'a'.repeat(43) })).status, 403);
  assert.equal((await request(path, { method: 'DELETE', ...owner, origin: 'https://evil.example' })).status, 403);
  assert.equal((await request(path, { method: 'DELETE', ...owner, input: {} })).status, 400);
  assert.equal((await request(path + '/publish', { method: 'POST', ...owner, input: { draftId: '00000000-0000-4000-8000-000000000000' } })).status, 409);
  const published = await request(path + '/publish', { method: 'POST', ...owner, input: { draftId: draft.draft.draftId } });
  assert.equal(published.status, 200); assert.equal(published.body.draft, undefined); assert.equal(published.body.status, 'answered');
  assert.equal((await request(path, { method: 'DELETE', ...owner })).status, 204);
  assert.equal((await request(path, { method: 'DELETE', ...owner })).status, 404);
  assert.equal((await request('/api/admin/unknown')).status, 404);
  assert.equal((await request('/api/admin/questions?authtoken=anything', owner)).status, 400);
  const secure = await login(secret, { origin: base.replace('http:', 'https:') });
  assert.match(secure.headers.get('set-cookie'), /; Secure/);
  assert.equal((await request('/api/admin/logout', { method: 'POST', ...owner, input: { extra: true } })).status, 400);
  assert.equal((await request('/api/admin/logout', { method: 'POST', ...owner, input: {} })).status, 204);
  assert.equal((await request('/api/admin/questions', owner)).status, 401);
});

test('login is globally rate limited and rejects unsafe origins and oversized bodies', async t => {
  const { auth, request, login, base } = await fixture(t);
  const secret = password(); await auth.setPassword(secret);
  assert.equal((await login(secret, { origin: `${base}/` })).status, 403);
  assert.equal((await login(secret, { origin: 'http://public.example', headers: { Host: 'public.example', 'X-Forwarded-Proto': 'https' } })).status, 403);
  assert.equal((await login(secret, { origin: 'https://other.example', headers: { 'X-Forwarded-Host': 'other.example' } })).status, 403);
  assert.equal((await login(secret, { origin: '' })).status, 403);
  assert.equal(await rawStatus(base, '/api/admin/login', { method: 'POST', headers: {
    Host: 'public.example', Origin: 'http://public.example', 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https',
  }, body: JSON.stringify({ username: 'admin', password: secret }) }), 403);
  assert.equal(await rawStatus(base, '/api/admin/session', { headers: { 'Content-Length': '2' }, body: '{}' }), 400);
  assert.equal(await rawStatus(base, '/api/admin/login', { method: 'POST', headers: {
    Origin: base, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked',
  }, body: JSON.stringify({ username: 'admin', password: 'x'.repeat(5000) }) }), 413);
  assert.equal((await request('/api/admin/login', { method: 'POST', input: { username: 'admin', password: 'x'.repeat(5000) } })).status, 413);
  for (let i = 0; i < 5; i++) assert.equal((await login(password(), { headers: { 'X-Forwarded-For': `1.2.3.${i}` } })).status, 401);
  const limited = await login(secret);
  assert.equal(limited.status, 429); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await request('/api/admin/session')).body.authenticated, false);
});

test('sessions expire, cap at five, restart clears them and another process reset invalidates cookies', async t => {
  const { auth, login, request, adminDirectory } = await fixture(t, { sessionMs: 1500, limits: { burst: 20 } });
  const secret = password(); await auth.setPassword(secret);
  const owners = [];
  for (let i = 0; i < 6; i++) owners.push(await login(secret));
  assert.equal((await request('/api/admin/questions', owners[0])).status, 401);
  assert.equal((await request('/api/admin/questions', owners[5])).status, 200);
  const restarted = await createAdminAuth({ directory: adminDirectory });
  assert.equal((await restarted.session({ headers: { cookie: owners[5].cookie } })).authenticated, false);
  const newPassword = password();
  const moduleUrl = new URL('./admin-auth.mjs', import.meta.url).href;
  await new Promise((done, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', `import { createAdminAuth } from ${JSON.stringify(moduleUrl)};let input='';for await(const chunk of process.stdin)input+=chunk;const value=JSON.parse(input);await(await createAdminAuth({directory:value.directory})).setPassword(value.password);`], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    child.stderr.resume(); child.once('error', reject); child.once('close', code => code === 0 ? done() : reject(new Error('临时密码重设失败')));
    child.stdin.end(JSON.stringify({ directory: adminDirectory, password: newPassword }));
  });
  assert.equal((await request('/api/admin/questions', owners[5])).status, 401);
  assert.equal((await login(secret)).status, 401);
  const renewed = await login(newPassword); assert.equal(renewed.status, 200);
  await new Promise(done => setTimeout(done, 1550));
  assert.equal((await request('/api/admin/questions', renewed)).status, 401);
});

test('loopback setup page has CSP and requires exact local host, Origin, CSRF and matching passwords', async t => {
  const { auth, login } = await fixture(t);
  const server = createAdminSetupServer({ auth });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const base = `http://127.0.0.1:${server.address().port}`;
  const page = await fetch(base); const html = await page.text();
  assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy'), /script-src 'sha256-/);
  assert.match(html, /<strong>admin<\/strong>/);
  assert.equal(/on(click|submit)=/i.test(html), false);
  const csrf = html.match(/'X-CSRF-Token':"([A-Za-z0-9_-]{43})"/)[1];
  const secret = password();
  const setup = async (input, headers = {}) => {
    const result = await fetch(base + '/setup', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json', 'X-CSRF-Token': csrf, ...headers }, body: JSON.stringify(input) });
    await result.text(); return result.status;
  };
  assert.equal(await rawStatus(base, '/', { headers: { Host: 'evil.example' } }), 403);
  assert.equal(await setup({ password: secret, confirmPassword: secret }, { Origin: 'https://evil.example' }), 403);
  assert.equal(await setup({ password: secret, confirmPassword: secret }, { 'X-CSRF-Token': '' }), 403);
  assert.equal(await setup({ password: 'short', confirmPassword: 'short' }), 400);
  assert.equal(await setup({ password: secret, confirmPassword: password() }), 400);
  assert.equal(await setup({ password: secret, confirmPassword: secret }), 200);
  assert.equal((await login(secret)).status, 200);
});

test('configured usernames persist across password reset and eleven character passwords are accepted', async t => {
  const { auth, login, request, adminDirectory } = await fixture(t, { username: 'campusOwner03' });
  const shortPassword = randomBytes(8).toString('base64url');
  assert.equal(shortPassword.length, 11);
  await auth.setPassword(shortPassword);
  const owner = await login(shortPassword);
  assert.equal(owner.status, 200);
  assert.equal(owner.body.username, 'campusOwner03');
  assert.equal((await request('/api/admin/session', owner)).body.username, 'campusOwner03');
  assert.equal((await request('/api/admin/login', { method: 'POST', input: { username: 'admin', password: shortPassword } })).status, 401);
  const reset = await createAdminAuth({ directory: adminDirectory });
  assert.equal(await reset.getUsername(), 'campusOwner03');
  const renewedPassword = randomBytes(8).toString('base64url');
  await reset.setPassword(renewedPassword);
  assert.equal((await login(renewedPassword)).body.username, 'campusOwner03');
  assert.equal((await request('/api/admin/questions', owner)).status, 401);
  assert.equal(JSON.parse(await readFile(resolve(adminDirectory, 'credentials.json'), 'utf8')).username, 'campusOwner03');
  for (const username of ['', 'a', 'x'.repeat(41), '用户名', 'user name']) {
    await assert.rejects(createAdminAuth({ directory: adminDirectory, username }), { statusCode: 400 });
  }
  await assert.rejects(auth.setPassword('x'.repeat(9)), { statusCode: 400 });
});
