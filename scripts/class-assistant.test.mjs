import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { DatabaseSync } from 'node:sqlite';
import { Readable } from 'node:stream';
import { defaultConfig, validateConfig, costMicros, ASTRA_MEMBER_BUDGET_MICROS, MEMBER_BUDGET_MICROS, MODEL_CATALOG, SESSION_MS } from './class-assistant-config.mjs';
import { acquireClassAssistantLock, createClassAssistantStore, PRIVATE_ROOT, privatePath, validateRoster, digest } from './class-assistant-store.mjs';
import { createClassAssistantProvider, questionPayload, validatedUsage } from './class-assistant-provider.mjs';
import { createClassAssistantHandler, validatePublicOrigin } from './class-assistant.mjs';
import { createRadarServer } from './serve-radar.mjs';

const rows = () => Array.from({ length: 35 }, (_, i) => ({ name: `合成成员${i + 1}`, memberKey: `synthetic-${i + 1}` }));
const config = (enabled = true) => validateConfig({ ...defaultConfig(), enabled, pricingConfirmed: enabled });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
function response(overrides = {}) {
  return { id: 'resp_mock', object: 'response', model: 'gpt-6.1-sol', service_tier: 'default', status: 'completed',
    output: [{ type: 'reasoning', summary: [] }, { type: 'message', content: [{ type: 'output_text', text: '你好，这是独立问题的答复。' }] }],
    usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 200 }, output_tokens: 100, output_tokens_details: { reasoning_tokens: 40 }, total_tokens: 1100 }, ...overrides };
}
function upstream({ generate = () => json(response()), count = 1000, countFails = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ url, options, body });
    if (url.includes('/models/')) return json({ object: 'model', id: decodeURIComponent(url.split('/').at(-1)) });
    if (url.endsWith('/input_tokens')) return countFails ? new Response('unavailable', { status: 503 }) : json({ object: 'response.input_tokens', input_tokens: count });
    return generate(body);
  };
  return { fetchImpl, calls, paid: () => calls.filter(call => call.url.endsWith('/responses')).length };
}
async function fixture(t, options = {}) {
  await mkdir(PRIVATE_ROOT, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(resolve(PRIVATE_ROOT, 'test-'));
  let store = await createClassAssistantStore({ directory });
  if (options.initialized !== false) await store.initialize(rows());
  const credentials = options.initialized === false ? [] : JSON.parse(await readFile(resolve(directory, 'private-claim-codes.json'), 'utf8')).members;
  let handler;
  const server = http.createServer((req, res) => handler(req, res));
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const mock = options.mock || upstream();
  handler = createClassAssistantHandler({ store, config: options.config || config(), publicOrigin: origin, apiKey: options.apiKey ?? 'mock-key-never-networked', fetchImpl: mock.fetchImpl });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(done => server.close(done));
    store.close();
    const target = privatePath(directory);
    assert.ok(target.startsWith(resolve(PRIVATE_ROOT, 'test-')));
    await rm(target, { recursive: true, force: true });
  });
  async function request(endpoint, body, cookie, headers = {}) {
    const result = await fetch(`${origin}/api/class-assistant/${endpoint}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body === undefined ? {} : { origin, 'content-type': 'application/json' }), ...(cookie ? { cookie } : {}), ...headers },
      ...(body === undefined ? {} : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    return { status: result.status, body: await result.json(), headers: result.headers, cookie: result.headers.get('set-cookie')?.split(';')[0] };
  }
  const login = async (index = 0) => request('login', { accessCode: credentials[index].accessCode });
  return { get store() { return store; }, directory, server, origin, handler, request, login, mock, credentials,
    async restart() {
      store.close();
      const lock = await acquireClassAssistantLock(directory);
      try { store = await createClassAssistantStore({ directory, recoverPending: true, lock }); }
      finally { await lock.release(); }
      handler = createClassAssistantHandler({ store, config: options.config || config(), publicOrigin: origin, apiKey: options.apiKey ?? 'mock-key-never-networked', fetchImpl: mock.fetchImpl });
    } };
}
const question = (requestId = randomUUID(), message = '为什么天空是蓝色？') => ({ modelKey: 'sol', message, requestId });
function reserve(store, memberId, reservation, requestId = randomUUID()) {
  const model = config().models[1];
  return store.reserve({ memberId, requestId, fingerprint: digest(requestId), model, inputTokens: 1000, reservation }).request;
}

test('35固定成员、终身预算、仅保存码哈希；禁止重导入、扩容及越界私有路径', async t => {
  const f = await fixture(t);
  const audit = f.store.audit();
  assert.equal(audit.members, 35);
  assert.equal(audit.allocatedMicros, 74_999_995);
  assert.equal(audit.unallocatedMicros, 5);
  await assert.rejects(f.store.initialize(rows()), /初始化/);
  assert.throws(() => validateRoster(rows().slice(1)), /35/);
  assert.throws(() => validateRoster([...rows(), rows()[0]]), /35/);
  const duplicate = rows(); duplicate[1].memberKey = duplicate[0].memberKey;
  assert.throws(() => validateRoster(duplicate), /唯一/);
  assert.throws(() => privatePath(resolve(PRIVATE_ROOT, '..', 'public-roster.json')), /私有/);
  const database = new DatabaseSync(resolve(f.directory, 'ledger.sqlite'));
  const member = database.prepare('SELECT code_hash,budget FROM members LIMIT 1').get();
  assert.equal(member.code_hash.length, 64);
  assert.equal(member.budget, MEMBER_BUDGET_MICROS);
  assert.throws(() => database.prepare('INSERT INTO members VALUES(?,?,?,?,0,0)').run('extra', '多余', 'extra', MEMBER_BUDGET_MICROS));
  const saved = Buffer.from(await readFile(resolve(f.directory, 'ledger.sqlite'))).toString('utf8');
  assert.ok(!saved.includes(f.credentials[0].accessCode));
  database.close();
});

test('价格、模型、预算和地址均由服务端固定；BigInt逐请求向上微美元而非按token取整', () => {
  const cfg = config();
  assert.equal(costMicros(cfg.models[3].prices, 1, 0, 1), 1);
  assert.equal(costMicros(cfg.models[3].prices, 1000, 0, 500), 350);
  assert.equal(costMicros(cfg.models[1].prices, 1000, 200, 100), 2620);
  for (const field of ['inputPerMillion', 'cachedInputPerMillion', 'outputPerMillion']) {
    for (const value of [-1, 0, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
      const bad = defaultConfig(); bad.models[0][field] = value;
      assert.throws(() => validateConfig(bad));
    }
  }
  assert.throws(() => validateConfig({ ...defaultConfig(), memberBudgetMicros: 10_000_000 }));
  assert.throws(() => validateConfig({ ...defaultConfig(), baseUrl: 'https://attacker.example/v1' }));
  assert.throws(() => validatePublicOrigin('http://public.example'));
  assert.throws(() => validatePublicOrigin('https://public.example/'));
  assert.equal(validatePublicOrigin('https://public.example').protocol, 'https:');
  assert.throws(() => costMicros(cfg.models[0].prices, Number.MAX_SAFE_INTEGER, 0, 1));
});

test('无key/默认关闭可以登录看本人额度；未知访客无姓名、无名单、弱身份cookie无效', async t => {
  const f = await fixture(t, { apiKey: '', config: config(false) });
  const anonymous = await f.request('session');
  assert.equal(anonymous.body.configured, true);
  assert.equal(anonymous.body.authenticated, false);
  assert.equal(anonymous.body.enabled, false);
  assert.ok(!('member' in anonymous.body));
  assert.ok(!JSON.stringify(anonymous.body).includes('合成成员'));
  const weak = await f.request('chat', question(), 'sanjiang_identity=pretend');
  assert.equal(weak.status, 401);
  const logged = await f.login();
  assert.equal(logged.body.member.name, '合成成员1');
  assert.equal(logged.body.member.remainingMicros, MEMBER_BUDGET_MICROS);
  assert.equal(logged.body.models.length, 4);
  assert.equal(logged.body.models[3].estimatedMessages, Math.floor(MEMBER_BUDGET_MICROS / 350));
  assert.equal(logged.body.enabled, false);
  assert.match(logged.headers.get('set-cookie'), /HttpOnly; SameSite=Strict; Max-Age=2592000/);
  assert.equal((await f.request('chat', question(), logged.cookie)).status, 503);
  assert.equal(f.mock.calls.length, 0);
  assert.equal(logged.headers.get('cache-control'), 'no-store');
  assert.ok(!JSON.stringify(logged.body).includes('CLASS_ASSISTANT_OPENAI_API_KEY'));
});

test('严格Origin/Host/JSON/长度、无CORS；统一错误及持久登录限流', async t => {
  const f = await fixture(t);
  assert.equal((await f.request('login', { accessCode: 'invalid' }, null, { origin: 'https://evil.example' })).status, 403);
  const wrongHost = await new Promise((done, fail) => {
    http.get(`${f.origin}/api/class-assistant/session`, { headers: { host: 'evil.example' } }, response => { response.resume(); response.on('end', () => done(response.statusCode)); }).on('error', fail);
  });
  assert.equal(wrongHost, 403);
  const missingOrigin = await fetch(`${f.origin}/api/class-assistant/login`, { method: 'POST', body: '{}' });
  assert.equal(missingOrigin.status, 403);
  assert.equal(missingOrigin.headers.get('access-control-allow-origin'), null);
  assert.equal((await f.request('login', '{}', null, { 'content-type': 'text/plain' })).status, 415);
  const one = await f.request('login', { accessCode: 'not-valid' });
  const two = await f.request('login', { name: '合成成员1', memberKey: 'synthetic-1' });
  assert.deepEqual(one.body, two.body);
  assert.equal((await f.request('login', 'x'.repeat(9000))).status, 415);
  assert.equal((await f.request('members')).status, 404);
  assert.equal((await f.request('session?all=1')).status, 404);
  for (let i = 0; i < 6; i++) await f.request('login', { accessCode: 'invalid' });
  await f.restart();
  assert.equal((await f.request('login', { accessCode: 'invalid' })).status, 429);
});

test('完整请求先计数再预占；cached input和reasoning分类准确；重复提交不二次付费', async t => {
  const f = await fixture(t);
  const logged = await f.login();
  const input = question();
  const first = await f.request('chat', input, logged.cookie);
  assert.equal(first.status, 200);
  assert.equal(first.body.chargedMicros, 2620);
  assert.equal(first.body.member.spentMicros, 2620);
  assert.equal(first.body.member.reservedMicros, 0);
  assert.equal(f.mock.paid(), 1);
  const countBody = f.mock.calls.find(call => call.url.endsWith('/input_tokens')).body;
  const paidBody = f.mock.calls.find(call => call.url.endsWith('/responses')).body;
  assert.equal(countBody.model, paidBody.model);
  assert.deepEqual(countBody.input, paidBody.input);
  assert.equal(countBody.instructions, paidBody.instructions);
  assert.equal(paidBody.service_tier, 'default');
  assert.equal(paidBody.max_output_tokens, 1024);
  assert.equal(paidBody.store, false);
  assert.equal(paidBody.background, false);
  assert.deepEqual(paidBody.reasoning, { effort: 'low' });
  assert.deepEqual(countBody.reasoning, paidBody.reasoning);
  assert.deepEqual(paidBody.prompt_cache_options, { mode: 'explicit' });
  assert.ok(!JSON.stringify(paidBody.input).includes('prompt_cache_breakpoint'));
  assert.deepEqual(paidBody.tools, []);
  assert.ok(!('conversation' in paidBody));
  assert.ok(!('previous_response_id' in paidBody));
  assert.ok(!JSON.stringify(paidBody).includes('合成成员'));
  assert.ok(!JSON.stringify(paidBody).includes(logged.cookie.split('=')[1]));
  assert.ok(!JSON.stringify(paidBody).includes(f.credentials[0].accessCode));
  const replay = await f.request('chat', input, logged.cookie);
  assert.equal(replay.body.answer, first.body.answer);
  assert.equal(replay.body.chargedMicros, 2620);
  assert.equal(f.mock.paid(), 1);
  assert.equal((await f.request('chat', { ...input, message: '另一道问题' }, logged.cookie)).status, 409);
  assert.equal((await f.request('chat', { ...question(), model: 'attacker' }, logged.cookie)).status, 400);
  assert.equal((await f.request('chat', question(randomUUID(), '😀'.repeat(500)), logged.cookie)).status, 200);
  assert.equal((await f.request('chat', question(randomUUID(), '😀'.repeat(501)), logged.cookie)).status, 400);
  await f.restart();
  const afterRestart = await f.request('chat', input, logged.cookie);
  assert.equal(afterRestart.body.chargedMicros, 2620);
  assert.equal(f.mock.paid(), 2);
});

test('并发相同请求仅一次付费；同人不同请求冻结期间阻止，跨人保持独立', async t => {
  let finishPaid, paidStarted;
  const started = new Promise(done => { paidStarted = done; });
  const mock = upstream({ generate: async () => { paidStarted(); await new Promise(done => { finishPaid = done; }); return json(response()); } });
  const f = await fixture(t, { mock });
  const logged = await f.login();
  const input = question();
  const first = f.request('chat', input, logged.cookie);
  await started;
  assert.equal(f.store.audit().reservedMicros, 12240);
  const duplicate = await f.request('chat', input, logged.cookie);
  assert.equal(duplicate.status, 409);
  assert.equal((await f.request('chat', question(), logged.cookie)).status, 423);
  assert.equal(mock.paid(), 1);
  finishPaid();
  assert.equal((await first).status, 200);
  assert.equal(f.store.audit().reservedMicros, 0);
});

test('SQLite事务与全班35份额度严格限制；低余额在付费前拒绝', async t => {
  const f = await fixture(t);
  const logged = await f.login();
  const token = logged.cookie.split('=')[1];
  const id = f.store.authenticate(token);
  const large = reserve(f.store, id, MEMBER_BUDGET_MICROS - 100);
  f.store.settle(large.id, { chargedMicros: MEMBER_BUDGET_MICROS - 100, answer: '合成已结算', usage: {}, providerId: 'resp_local' });
  assert.equal((await f.request('chat', question(), logged.cookie)).status, 402);
  assert.equal(f.mock.paid(), 0);
  assert.equal(f.store.member(id).remainingMicros, 100);
  const r = reserve(f.store, id, 100);
  assert.throws(() => reserve(f.store, id, 1), error => error.code === 'account_held');
  f.store.settle(r.id, { chargedMicros: 100, answer: '合成已结算', usage: {}, providerId: 'resp_local2' });
  assert.throws(() => reserve(f.store, id, 1), error => error.code === 'insufficient_balance');
  const snapshot = f.store.audit();
  assert.equal(snapshot.spentMicros, MEMBER_BUDGET_MICROS);
  await f.restart();
  assert.equal(f.store.audit().spentMicros, MEMBER_BUDGET_MICROS);
  assert.equal(f.store.audit().allocatedMicros, 74_999_995);
});

test('仅Astra新增终身子额度，初始四模型估算30/306/612/6122且总余额不变', async t => {
  const f = await fixture(t);
  const anonymous = await f.request('session');
  assert.equal(anonymous.body.models[0].budgetMicros, ASTRA_MEMBER_BUDGET_MICROS);
  assert.ok(anonymous.body.models.every(model => model.remainingMicros === null));
  const logged = await f.login();
  assert.equal(logged.body.member.budgetMicros, MEMBER_BUDGET_MICROS);
  assert.equal(logged.body.member.remainingMicros, MEMBER_BUDGET_MICROS);
  assert.deepEqual(logged.body.models.map(model => model.estimatedMessages), [30, 306, 612, 6122]);
  assert.deepEqual(logged.body.models.map(model => model.budgetMicros), [ASTRA_MEMBER_BUDGET_MICROS, null, null, null]);
  assert.deepEqual(logged.body.models.map(model => model.remainingMicros), [ASTRA_MEMBER_BUDGET_MICROS, MEMBER_BUDGET_MICROS, MEMBER_BUDGET_MICROS, MEMBER_BUDGET_MICROS]);
});

test('Astra子额度按已结算实际费与未决预占扣除，重启/核对/重放不绕限；耗尽后Sol仍可使用总余额', async t => {
  const f = await fixture(t);
  const logged = await f.login();
  const memberId = f.store.authenticate(logged.cookie.split('=')[1]);
  const astra = config().models[0];
  const reserveAstra = (reservation, requestId = randomUUID()) => f.store.reserve({ memberId, requestId, fingerprint: digest(requestId), model: astra, inputTokens: 1000, reservation });
  const first = reserveAstra(600000).request;
  f.store.settle(first.id, { chargedMicros: 500000, answer: '合成Astra结算', usage: {}, providerId: 'resp_astra_first' });
  assert.equal(f.store.modelQuota(memberId, 'astra').remainingMicros, ASTRA_MEMBER_BUDGET_MICROS - 500000);
  const held = reserveAstra(200000).request;
  const beforeRestart = ASTRA_MEMBER_BUDGET_MICROS - 700000;
  assert.equal(f.store.modelQuota(memberId, 'astra').remainingMicros, beforeRestart);
  assert.equal(reserveAstra(200000, held.id).created, false);
  assert.equal(f.store.modelQuota(memberId, 'astra').remainingMicros, beforeRestart);
  await f.restart();
  assert.equal(f.store.modelQuota(memberId, 'astra').remainingMicros, beforeRestart);
  assert.throws(() => reserveAstra(1), error => error.code === 'account_held');
  f.store.reconcile(held.id, 100000, '站长已人工核对合成Astra上游账单，该冻结请求实际费用为十万微美元。');
  const remaining = ASTRA_MEMBER_BUDGET_MICROS - 600000;
  assert.equal(f.store.modelQuota(memberId, 'astra').remainingMicros, remaining);
  assert.throws(() => reserveAstra(remaining + 1), error => error.code === 'model_quota_exceeded');
  const last = reserveAstra(remaining).request;
  f.store.settle(last.id, { chargedMicros: remaining, answer: '合成Astra额度耗尽', usage: {}, providerId: 'resp_astra_last' });
  await f.restart();
  const session = await f.request('session', undefined, logged.cookie);
  assert.equal(session.body.models[0].remainingMicros, 0);
  assert.equal(session.body.models[0].estimatedMessages, 0);
  assert.equal(session.body.models[0].available, false);
  assert.equal(session.body.models[1].available, true);
  assert.equal(session.body.models[1].remainingMicros, MEMBER_BUDGET_MICROS - ASTRA_MEMBER_BUDGET_MICROS);
  const denied = await f.request('chat', { ...question(), modelKey: 'astra' }, logged.cookie);
  assert.equal(denied.status, 402);
  assert.equal(denied.body.code, 'model_quota_exceeded');
  assert.equal(f.mock.paid(), 0);
  const sol = await f.request('chat', question(), logged.cookie);
  assert.equal(sol.status, 200);
  assert.equal(sol.body.chargedMicros, 2620);
  assert.equal(sol.body.models[0].remainingMicros, 0);
  assert.equal(sol.body.member.remainingMicros, MEMBER_BUDGET_MICROS - ASTRA_MEMBER_BUDGET_MICROS - 2620);
});

test('既有账本的旧Astra费用纳入新子额度，超出新限额按零可用处理；总余额仍是所有模型共同上限', async t => {
  const f = await fixture(t);
  const { memberId } = f.store.login(f.credentials[0].accessCode);
  const previousCharge = ASTRA_MEMBER_BUDGET_MICROS + 1;
  const legacy = reserve(f.store, memberId, previousCharge);
  f.store.settle(legacy.id, { chargedMicros: previousCharge, answer: '模拟旧版已结算请求', usage: {}, providerId: 'resp_legacy' });
  // Simulate a pre-subcap Astra ledger entry without migrating or changing any member balance.
  const database = new DatabaseSync(resolve(f.directory, 'ledger.sqlite'));
  database.prepare("UPDATE requests SET model_key='astra',model_id='gpt-6-astra' WHERE id=?").run(legacy.id);
  database.close();
  await f.restart();
  assert.equal(f.store.modelQuota(memberId, 'astra').remainingMicros, 0);
  assert.equal(f.store.modelQuota(memberId, 'sol').remainingMicros, MEMBER_BUDGET_MICROS - previousCharge);
  const other = f.store.login(f.credentials[1].accessCode).memberId;
  const solCharge = 1500000;
  const sol = reserve(f.store, other, solCharge);
  f.store.settle(sol.id, { chargedMicros: solCharge, answer: '合成Sol费用', usage: {}, providerId: 'resp_sol' });
  assert.equal(f.store.modelQuota(other, 'astra').remainingMicros, MEMBER_BUDGET_MICROS - solCharge);
});

test('模型/count不确认或输入>8000时不做付费请求，不预占；筛选也不计费', async t => {
  const f = await fixture(t, { mock: upstream({ countFails: true }) });
  const logged = await f.login();
  assert.equal((await f.request('chat', question(), logged.cookie)).status, 503);
  assert.equal(f.mock.paid(), 0);
  assert.equal(f.store.audit().reservedMicros, 0);
  const filtered = await f.request('chat', question(randomUUID(), '评价现任总统'), logged.cookie);
  assert.equal(filtered.body.status, 'filtered');
  assert.equal(filtered.body.chargedMicros, 0);
  const model = config().models[1];
  const unavailable = createClassAssistantProvider({ config: config(), apiKey: 'fake', fetchImpl: async () => json({ id: 'wrong', object: 'model' }) });
  await assert.rejects(unavailable.count(model, questionPayload('测试', randomUUID()).modelInput), error => error.code === 'token_count_unavailable');
  const tooMany = createClassAssistantProvider({ config: config(), apiKey: 'fake', fetchImpl: upstream({ count: 8001 }).fetchImpl });
  await assert.rejects(tooMany.count(model, questionPayload('测试', randomUUID()).modelInput), error => error.code === 'input_limit');
});

test('超时、缺usage、模型或service_tier异常保留预占并阻止再消费，重启不释放；仅站长CLI可核对', async t => {
  for (const generate of [() => { throw new DOMException('timed out', 'TimeoutError'); }, () => json(response({ usage: null })), () => json(response({ model: 'gpt-other' })), () => json(response({ service_tier: 'priority' }))]) {
    const f = await fixture(t, { mock: upstream({ generate }) });
    const logged = await f.login();
    const input = question();
    assert.equal((await f.request('chat', input, logged.cookie)).status, 423);
    assert.equal(f.mock.paid(), 1);
    const reserved = f.store.audit().reservedMicros;
    assert.equal(reserved, 12240);
    await f.restart();
    assert.equal(f.store.audit().reservedMicros, reserved);
    assert.equal((await f.request('chat', input, logged.cookie)).status, 423);
    assert.equal((await f.request('chat', question(), logged.cookie)).status, 423);
    assert.equal(f.mock.paid(), 1);
    assert.throws(() => f.store.reconcile(input.requestId, 0, '不足证据'));
    f.store.reconcile(input.requestId, 25, '站长已人工核对官方上游账单，本请求实际确认费用为二十五微美元。');
    assert.equal(f.store.audit().reservedMicros, 0);
    assert.equal(f.store.audit().spentMicros, 25);
  }
});

test('进程重启把已预占但结果未写入的请求持久冻结；会话固定过期，logout即时失效', async t => {
  const f = await fixture(t);
  const logged = await f.login();
  const token = logged.cookie.split('=')[1];
  const id = f.store.authenticate(token);
  reserve(f.store, id, 12000);
  await f.restart();
  assert.equal(f.store.audit().held[0].status, 'held');
  assert.equal(f.store.audit().held[0].note, 'process_restarted');
  assert.equal(f.store.audit().reservedMicros, 12000);
  assert.equal((await f.request('session', undefined, logged.cookie)).body.authenticated, true);
  const database = new DatabaseSync(resolve(f.directory, 'ledger.sqlite'));
  const expiry = database.prepare('SELECT expires FROM sessions WHERE hash=?').get(digest(token)).expires;
  assert.ok(expiry <= Date.now() + SESSION_MS);
  database.prepare('UPDATE sessions SET expires=? WHERE hash=?').run(Date.now() - 1, digest(token));
  database.close();
  assert.equal((await f.request('session', undefined, logged.cookie)).body.authenticated, false);
  const newLogin = await f.login();
  assert.equal((await f.request('logout', {}, newLogin.cookie)).status, 200);
  assert.equal((await f.request('session', undefined, newLogin.cookie)).body.authenticated, false);
});

test('实际费用超过预占时记录真实费用并全局持久停机，不截断、不退款、不自动重试', async t => {
  const oversized = response({ usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2000, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 3000 } });
  const f = await fixture(t, { mock: upstream({ generate: () => json(oversized) }) });
  const first = await f.login();
  const input = question();
  assert.equal((await f.request('chat', input, first.cookie)).status, 423);
  let audit = f.store.audit();
  assert.equal(audit.halted, true);
  assert.equal(audit.held[0].observedActualMicros, 22000);
  assert.equal(audit.reservedMicros, 12240);
  assert.throws(() => f.store.reconcile(input.requestId, 100, '站长核对试图缩小账单但不能抹除已经观察到的真实超额费用。'));
  await f.restart();
  const second = await f.login(1);
  assert.equal(second.body.enabled, false);
  assert.equal((await f.request('chat', question(), second.cookie)).status, 503);
  audit = f.store.audit();
  assert.equal(audit.held[0].observedActualMicros, 22000);
  assert.equal(f.mock.paid(), 1);
});

test('等待免费count期间出现全局停机，另一成员也不能在事务中新增预占或发送付费请求', async t => {
  let countStarted, releaseCount;
  const counting = new Promise(done => { countStarted = done; });
  const countWait = new Promise(done => { releaseCount = done; });
  let paid = 0;
  const mock = { fetchImpl: async (url, options) => {
    if (url.includes('/models/')) return json({ object: 'model', id: 'gpt-6.1-sol' });
    const body = JSON.parse(options.body);
    if (url.endsWith('/input_tokens')) {
      if (JSON.stringify(body.input).includes('延迟计数')) { countStarted(); await countWait; }
      return json({ object: 'response.input_tokens', input_tokens: 1000 });
    }
    paid++;
    return json(response({ usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 0 }, output_tokens: 2000, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 3000 } }));
  } };
  const f = await fixture(t, { mock });
  const a = await f.login();
  const b = await f.login(1);
  const waiting = f.request('chat', question(randomUUID(), '延迟计数的问题'), b.cookie);
  await counting;
  assert.equal((await f.request('chat', question(), a.cookie)).status, 423);
  assert.equal(f.store.halted(), true);
  releaseCount();
  assert.equal((await waiting).status, 503);
  assert.equal(paid, 1);
  assert.equal(f.store.audit().held.length, 1);
});

test('服务独占锁拒绝第二服务/核对；audit只读不把正常在途请求变held，锁只能显式释放', async t => {
  const f = await fixture(t);
  const logged = f.store.login(f.credentials[0].accessCode);
  reserve(f.store, logged.memberId, 12345);
  const lock = await acquireClassAssistantLock(f.directory);
  try {
    await assert.rejects(acquireClassAssistantLock(f.directory), /锁定/);
    await assert.rejects(createClassAssistantStore({ directory: f.directory, recoverPending: true }), /独占/);
    const audit = await createClassAssistantStore({ directory: f.directory, readOnly: true });
    try {
      assert.equal(audit.audit().held[0].status, 'reserved');
      assert.equal(f.store.audit().held[0].status, 'reserved');
      assert.throws(() => audit.hold(f.store.audit().held[0].requestId, 'not_allowed'));
    } finally { audit.close(); }
  } finally { await lock.release(); }
  await f.restart();
  assert.equal(f.store.audit().held[0].status, 'held');
  assert.equal(f.store.audit().reservedMicros, 12345);
});

test('所有35人预占及结算都不能超过74999995微美元分配总额，保留5微美元', async t => {
  const f = await fixture(t);
  const requests = [];
  for (const credential of f.credentials) {
    const { memberId } = f.store.login(credential.accessCode);
    requests.push(reserve(f.store, memberId, MEMBER_BUDGET_MICROS));
    assert.throws(() => reserve(f.store, memberId, 1), error => error.code === 'account_held');
  }
  assert.equal(f.store.audit().reservedMicros, 74_999_995);
  for (const row of requests) f.store.settle(row.id, { chargedMicros: MEMBER_BUDGET_MICROS, answer: '合成结算', usage: {}, providerId: 'resp_synthetic' });
  assert.equal(f.store.audit().spentMicros, 74_999_995);
  assert.equal(f.store.audit().reservedMicros, 0);
  assert.equal(f.store.audit().unallocatedMicros, 5);
});

test('禁用cache写入后任何非零或无效cache_write用量都全局冻结，实际费未知不捏造', async t => {
  for (const extra of [{ cache_write_tokens: 10 }, { cache_write_tokens: -1 }, { cache_write_tokens: '0' }, { cache_write_tokens_details: { ttl_30m: 1 } }, { cache_write_tokens_details: null }]) {
    const generated = response();
    Object.assign(generated.usage.input_tokens_details, extra);
    const f = await fixture(t, { mock: upstream({ generate: () => json(generated) }) });
    const logged = await f.login();
    assert.equal((await f.request('chat', question(), logged.cookie)).status, 423);
    const audit = f.store.audit();
    assert.equal(audit.halted, true);
    assert.equal(audit.held[0].note, 'unexpected_cache_write');
    assert.equal(audit.held[0].observedActualMicros, null);
    assert.equal(audit.spentMicros, 0);
    assert.equal(audit.reservedMicros, 12240);
    assert.equal(f.mock.paid(), 1);
  }
  const zero = response();
  Object.assign(zero.usage.input_tokens_details, { cache_write_tokens: 0, cache_write_tokens_details: { ttl_30m: 0, ttl_12h: 0 } });
  assert.equal(validatedUsage(zero).inputTokens, 1000);
});

test('公网origin登录cookie强制Secure且固定到期，既有弱身份不参与付费认证', async t => {
  const f = await fixture(t, { config: config(false) });
  const handler = createClassAssistantHandler({ store: f.store, config: config(false), apiKey: '', publicOrigin: 'https://class.example' });
  const body = JSON.stringify({ accessCode: f.credentials[0].accessCode });
  const req = Readable.from([Buffer.from(body)]);
  req.url = '/api/class-assistant/login';
  req.method = 'POST';
  req.headers = { host: 'class.example', origin: 'https://class.example', 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
  req.socket = { remoteAddress: '127.0.0.1' };
  const headers = new Map();
  let status;
  const res = { setHeader(key, value) { headers.set(key, value); }, writeHead(value) { status = value; }, end() {} };
  assert.equal(await handler(req, res), true);
  assert.equal(status, 200);
  assert.match(headers.get('Set-Cookie'), /; Secure$/);
  assert.match(headers.get('Set-Cookie'), /HttpOnly; SameSite=Strict/);
});

test('客户端断开后付费请求仍由drain等待并结算，停止服务不提前释放余额', async t => {
  let paidStarted, finishPaid;
  const started = new Promise(done => { paidStarted = done; });
  const wait = new Promise(done => { finishPaid = done; });
  const mock = upstream({ generate: async () => { paidStarted(); await wait; return json(response()); } });
  const f = await fixture(t, { mock });
  const logged = await f.login();
  const controller = new AbortController();
  const request = fetch(`${f.origin}/api/class-assistant/chat`, { method: 'POST', signal: controller.signal,
    headers: { origin: f.origin, 'content-type': 'application/json', cookie: logged.cookie }, body: JSON.stringify(question()) }).catch(error => error);
  await started;
  controller.abort();
  await request;
  f.handler.stop();
  let drained = false;
  const draining = f.handler.drain().then(() => { drained = true; });
  await new Promise(done => setImmediate(done));
  assert.equal(drained, false);
  assert.equal(f.store.audit().reservedMicros, 12240);
  finishPaid();
  await draining;
  assert.equal(f.store.audit().reservedMicros, 0);
  assert.equal(f.store.audit().spentMicros, 2620);
  assert.equal(mock.paid(), 1);
  assert.equal((await f.request('chat', question(), logged.cookie)).status, 503);
});

test('停服发生在免费count等待时，drain等计数结束且拒绝新增付费传输', async t => {
  let countStarted, releaseCount;
  const started = new Promise(done => { countStarted = done; });
  const wait = new Promise(done => { releaseCount = done; });
  let paid = 0;
  const mock = { fetchImpl: async url => {
    if (url.includes('/models/')) return json({ object: 'model', id: 'gpt-6.1-sol' });
    if (url.endsWith('/input_tokens')) { countStarted(); await wait; return json({ object: 'response.input_tokens', input_tokens: 1000 }); }
    paid++; return json(response());
  } };
  const f = await fixture(t, { mock });
  const logged = await f.login();
  const request = f.request('chat', question(), logged.cookie);
  await started;
  const draining = f.handler.drain();
  releaseCount();
  assert.equal((await request).status, 503);
  await draining;
  assert.equal(paid, 0);
  assert.equal(f.store.audit().reservedMicros, 0);
});

test('上游中文UTF8跨chunk保持原文；reasoning不重复计费；输出不机械截断', async () => {
  const answer = '你好'.repeat(450);
  const original = response({ output: [{ type: 'message', content: [{ type: 'output_text', text: answer }] }] });
  const bytes = Buffer.from(JSON.stringify(original));
  const position = bytes.indexOf(Buffer.from('你')) + 1;
  const provider = createClassAssistantProvider({ config: config(), apiKey: 'fake', fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(bytes.subarray(0, position)); controller.enqueue(bytes.subarray(position)); controller.close(); },
  }), { headers: { 'content-type': 'application/json' } }) });
  const result = await provider.respond(config().models[1], questionPayload('测试', randomUUID()).modelInput);
  const settled = provider.settlement(result, config().models[1], 1000);
  assert.equal(settled.answer, answer);
  assert.equal(settled.chargedMicros, 2620);
  assert.deepEqual(validatedUsage(result), { inputTokens: 1000, cachedInputTokens: 200, outputTokens: 100, reasoningTokens: 40 });
  assert.throws(() => validatedUsage(response({ usage: {} })));
});

test('集成静态server只开放class API，旧identity/admin/assistant/likes均关闭且保留原服务默认', async t => {
  const f = await fixture(t, { config: config(false) });
  const root = resolve(f.directory, 'static');
  await mkdir(root);
  await mkdir(resolve(root, 'assistant'));
  await writeFile(resolve(root, 'index.html'), '<!doctype html><title>mock</title>');
  await writeFile(resolve(root, 'assistant/index.html'), '<!doctype html><title>assistant</title>');
  const server = await createRadarServer({ root, identityOnly: true, classAssistantHandler: f.handler, log: () => {} });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(done => server.close(done)); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(`${origin}/assistant/`)).status, 200);
  for (const path of ['/api/identity/session', '/api/admin/session', '/api/assistant/questions', '/api/activity-likes']) assert.equal((await fetch(`${origin}${path}`)).status, 404);
  assert.equal(server.timeout, 15000);
});
