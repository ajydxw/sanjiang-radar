import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, writeFile } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createAssistantStore, handleAssistantRequest } from './assistant-questions.mjs';
import { POLITICAL_TOPIC_MESSAGE } from '../sources/question-policy.mjs';

const runtime = fileURLToPath(new URL('../.sites-runtime/', import.meta.url));
const answer = { status: 'answered', answer: '先阅读当期学校通知，再按官方入口办理。',
  sources: [{ title: '学校通知', url: 'https://www.sju.edu.cn/' }], model: 'gpt-6.1-sol', reasoningEffort: 'high' };

async function fixture(t, maxRecords = 200) {
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(resolve(runtime, 'assistant-questions-test-'));
  const store = await createAssistantStore({ directory, maxRecords });
  const server = http.createServer(async (req, res) => {
    if (!await handleAssistantRequest(req, res, store)) { res.writeHead(404); res.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await new Promise(done => server.close(done));
    const path = relative(runtime, directory);
    assert.ok(path.startsWith('assistant-questions-test-') && !path.includes(sep));
    await rm(directory, { recursive: true, force: true });
  });
  const request = async (path, { method = 'GET', input, token, origin = base, headers = {} } = {}) => {
    const result = await fetch(`${base}${path}`, { method, headers: {
      ...(method === 'POST' || method === 'DELETE' ? { Origin: origin } : {}),
      ...(input !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers,
    }, ...(input !== undefined ? { body: JSON.stringify(input) } : {}) });
    const body = await result.text();
    return { status: result.status, headers: result.headers, body: body ? JSON.parse(body) : null };
  };
  return { directory, store, server, base, request };
}

test('private HTTP lifecycle: submit, authorize, owner publish, reload and delete', async t => {
  const { directory, store, request } = await fixture(t);
  const status = await request('/api/assistant/status');
  assert.equal(status.status, 200);
  assert.deepEqual(status.body, { acceptsQuestions: true, automaticAnswers: false });
  assert.equal(status.headers.get('access-control-allow-origin'), null);
  const submitted = await request('/api/assistant/questions', { method: 'POST', input: { question: '普通话什么时候报名？', contextId: 'notice-1' } });
  assert.equal(submitted.status, 201);
  const record = submitted.body;
  assert.match(record.id, /^[0-9a-f-]{36}$/);
  assert.match(record.accessToken, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(record.status, 'pending');
  assert.equal(record.answer, null);
  assert.deepEqual(record.sources, []);
  const path = `/api/assistant/questions/${record.id}`;
  assert.equal((await request(path)).status, 404);
  assert.equal((await request(path, { token: 'a'.repeat(43) })).status, 404);
  assert.equal((await request('/api/assistant/questions/00000000-0000-4000-8000-000000000000', { token: record.accessToken })).status, 404);
  assert.equal((await request(path, { headers: { Authorization: 'bearer invalid' } })).status, 404);
  const visible = await request(path, { token: record.accessToken });
  assert.equal(visible.status, 200);
  assert.equal(visible.body.accessToken, undefined);
  assert.equal(visible.body.tokenHash, undefined);
  assert.equal(visible.body.version, undefined);
  const disk = JSON.parse(await readFile(resolve(directory, `${record.id}.json`), 'utf8'));
  assert.equal(disk.accessToken, undefined);
  assert.equal(JSON.stringify(disk).includes(record.accessToken), false);
  assert.match(disk.tokenHash, /^[a-f0-9]{64}$/);
  const pending = await store.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].tokenHash, undefined);
  assert.equal(pending[0].accessToken, undefined);
  const published = await store.publish(record.id, answer);
  assert.equal(published.model, 'gpt-6.1-sol');
  assert.equal(published.reasoningEffort, 'high');
  assert.equal(published.status, 'answered');
  await assert.rejects(store.publish(record.id, { ...answer, answer: '重复答复' }), { statusCode: 409 });
  assert.equal((await store.listPending()).length, 0);
  assert.deepEqual((await request(path, { token: record.accessToken })).body, published);
  const restored = await createAssistantStore({ directory });
  assert.deepEqual(await restored.get(record.id, record.accessToken), published);
  assert.equal((await request(path, { method: 'DELETE', token: record.accessToken, origin: 'https://evil.example' })).status, 403);
  assert.equal((await request(path, { method: 'DELETE', token: record.accessToken, input: { ignored: true } })).status, 400);
  assert.equal((await request(path, { method: 'DELETE', token: 'b'.repeat(43) })).status, 404);
  assert.equal((await request(path, { method: 'DELETE', token: record.accessToken })).status, 204);
  assert.equal((await request(path, { token: record.accessToken })).status, 404);
  assert.deepEqual(await readdir(directory), []);
});

test('HTTP input boundaries, exact origins and no owner endpoints', async t => {
  const { request, base, store } = await fixture(t);
  const post = (input, options = {}) => request('/api/assistant/questions', { method: 'POST', input, ...options });
  for (const input of [null, [], {}, { question: '' }, { question: '   ' }, { question: 'a'.repeat(501) },
    { question: '\ud800' }, { question: '你好', contextId: 1 }, { question: '你好', contextId: 'a'.repeat(201) },
    { question: '你好', status: 'answered' }, { question: '你好', answer: 'hack' }, { question: '你好', tokenHash: 'hack' }]) {
    assert.equal((await post(input)).status, 400);
  }
  assert.equal((await post({ question: 'q' }, { origin: '' })).status, 403);
  assert.equal((await post({ question: 'q' }, { origin: 'null' })).status, 403);
  assert.equal((await post({ question: 'q' }, { origin: `${base}/` })).status, 403);
  assert.equal((await post({ question: 'q' }, { origin: 'http://evil.example', headers: { 'X-Forwarded-Host': 'evil.example' } })).status, 403);
  assert.equal((await post({ question: 'q' }, { origin: `${base}.evil.example` })).status, 403);
  assert.equal((await post({ question: 'q' }, { headers: { 'Content-Type': 'text/plain' } })).status, 415);
  assert.equal((await post({ question: 'x'.repeat(9000) })).status, 413);
  const chunkedStatus = await new Promise((done, reject) => {
    const req = http.request(`${base}/api/assistant/questions`, { method: 'POST', headers: {
      Origin: base, 'Content-Type': 'application/json', 'Transfer-Encoding': 'chunked',
    } }, res => { res.resume(); res.on('end', () => done(res.statusCode)); });
    req.on('error', reject);
    req.write('{"question":"');
    req.write('x'.repeat(9000));
    req.end('"}');
  });
  assert.equal(chunkedStatus, 413);
  const unicode = await post({ question: '😀'.repeat(500) }, { origin: base.replace('http:', 'https:') });
  assert.equal(unicode.status, 201);
  assert.equal([...unicode.body.question].length, 500);
  const task = await post({ question: '帮我写代码' });
  assert.equal(task.status, 201);
  assert.equal(task.body.status, 'pending');
  assert.equal(task.body.contextId, null);
  assert.equal((await store.listPending()).length, 2);
  for (const path of ['/api/assistant', '/api/assistant/unknown', '/api/assistant/questions', '/api/assistant/questions/pending', '/api/assistant/questions/../secret']) {
    assert.equal((await request(path)).status, 404);
  }
  assert.equal((await request(`/api/assistant/questions/${task.body.id}`, { method: 'POST', input: answer })).status, 404);
  assert.equal((await request('/api/assistant/status', { method: 'DELETE' })).status, 404);
  const invalidJson = await fetch(`${base}/api/assistant/questions`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(invalidJson.status, 400);
  await invalidJson.text();
});

test('political scope applies on the server without saving questions or narrowing ordinary knowledge', async t => {
  const { directory, store, request } = await fixture(t);
  for (const question of ['你如何评价美国总统？', '英国政府是否腐败？', '俄乌战争谁对谁错？']) {
    const rejected = await request('/api/assistant/questions', { method: 'POST', input: { question } });
    assert.equal(rejected.status, 422);
    assert.equal(rejected.body.error, POLITICAL_TOPIC_MESSAGE);
  }
  assert.deepEqual(await readdir(directory), []);
  for (const question of ['为什么天空是蓝色的？', '古代罗马政治制度有哪些特点？', '如何申请政府奖学金？']) {
    const accepted = await request('/api/assistant/questions', { method: 'POST', input: { question } });
    assert.equal(accepted.status, 201);
  }
  assert.equal((await store.listPending()).length, 3);
});

test('new answers and drafts are limited to 800 codepoints while old answers remain readable', async t => {
  const { directory, store } = await fixture(t);
  const record = await store.create({ question: '普通知识' });
  const oversized = { ...answer, answer: '😀'.repeat(801) };
  await assert.rejects(store.stageDraft(record.id, oversized), { statusCode: 400 });
  await assert.rejects(store.publish(record.id, oversized), { statusCode: 400 });
  const draft = await store.stageDraft(record.id, { ...answer, answer: '😀'.repeat(800) });
  const path = resolve(directory, `${record.id}.json`);
  const legacyDraft = JSON.parse(await readFile(path, 'utf8'));
  legacyDraft.draft.answer = oversized.answer;
  await writeFile(path, JSON.stringify(legacyDraft));
  await assert.rejects(store.publishDraft(record.id, draft.draft.draftId), { statusCode: 400 });
  await store.publish(record.id, { ...answer, answer: '😀'.repeat(800) });
  const legacyAnswer = JSON.parse(await readFile(path, 'utf8'));
  legacyAnswer.answer = oversized.answer;
  await writeFile(path, JSON.stringify(legacyAnswer));
  const restored = await createAssistantStore({ directory });
  assert.equal((await restored.get(record.id, record.accessToken)).answer, oversized.answer);
});

test('political questions from an old queue only accept a scope decline', async t => {
  const { directory, store } = await fixture(t);
  const record = await store.create({ question: '旧问题' });
  const path = resolve(directory, `${record.id}.json`);
  const legacy = JSON.parse(await readFile(path, 'utf8'));
  legacy.question = '你如何评价美国总统？';
  await writeFile(path, JSON.stringify(legacy));
  await assert.rejects(store.publish(record.id, answer), { statusCode: 422 });
  await assert.rejects(store.stageDraft(record.id, answer), { statusCode: 422 });
  const draft = await store.stageDraft(record.id, { ...answer, status: 'declined', answer: POLITICAL_TOPIC_MESSAGE, sources: [] });
  assert.equal((await store.publishDraft(record.id, draft.draft.draftId)).status, 'declined');
});

test('sources, publish statuses, record size and strict ids are validated locally', async t => {
  const { store, directory } = await fixture(t);
  const record = await store.create({ question: '了解通知' });
  for (const url of ['javascript:alert(1)', 'file:///secret', 'https://name:password@example.com/', 'https://name@example.com/', 'not a url', ' https://example.com/', 'https://example.com/\n']) {
    await assert.rejects(store.publish(record.id, { ...answer, sources: [{ title: '来源', url }] }), { statusCode: 400 });
  }
  for (const publication of [{ ...answer, status: 'pending' }, { ...answer, model: 'other' }, { ...answer, reasoningEffort: 'low' },
    { ...answer, extra: true }, { ...answer, sources: [{ title: '', url: 'https://example.com' }] },
    { ...answer, answer: 'a'.repeat(10001) }, { ...answer, sources: Array(11).fill(answer.sources[0]) }]) {
    await assert.rejects(store.publish(record.id, publication), { statusCode: 400 });
  }
  for (const status of ['answered', 'declined', 'needs-info', 'unconfirmed']) {
    const next = await store.create({ question: `测试${status}` });
    assert.equal((await store.publish(next.id, { ...answer, status })).status, status);
  }
  await assert.rejects(store.get('../secret', record.accessToken), { statusCode: 404 });
  await assert.rejects(store.publish('../secret', answer), { statusCode: 404 });
  await writeFile(resolve(directory, `${record.id}.json`), 'x'.repeat(65537));
  await assert.rejects(store.get(record.id, record.accessToken), { statusCode: 503 });
});

test('concurrent submissions stay within capacity and tokens are distinct', async t => {
  const { store, directory, request } = await fixture(t, 3);
  const concurrent = await Promise.allSettled(Array.from({ length: 8 }, (_, i) => store.create({ question: `问题${i}` })));
  const successful = concurrent.filter(result => result.status === 'fulfilled').map(result => result.value);
  const rejected = concurrent.filter(result => result.status === 'rejected');
  assert.equal(successful.length, 3);
  assert.equal(rejected.length, 5);
  assert.ok(rejected.every(result => result.reason.statusCode === 503));
  assert.equal(new Set(successful.map(record => record.id)).size, 3);
  assert.equal(new Set(successful.map(record => record.accessToken)).size, 3);
  assert.equal((await readdir(directory)).length, 3);
  const lock = resolve(directory, '.write-lock');
  await mkdir(lock);
  await assert.rejects(store.delete(successful[0].id, successful[0].accessToken), { statusCode: 503 });
  await rmdir(lock);
  assert.equal((await store.get(successful[0].id, successful[0].accessToken)).status, 'pending');
  assert.equal((await request('/api/assistant/questions', { method: 'POST', input: { question: '满队列' } })).status, 503);
  await store.delete(successful[0].id, successful[0].accessToken);
  assert.equal((await store.create({ question: '空位' })).status, 'pending');
  await assert.rejects(createAssistantStore({ directory, maxRecords: 201 }), { statusCode: 400 });
  await assert.rejects(createAssistantStore({ directory: resolve(directory, 'public') }), { statusCode: 400 });
});

test('question writes use a global burst budget and return a retry interval', async t => {
  const { request, store } = await fixture(t);
  for (let i = 0; i < 5; i++) assert.equal((await store.create({ question: `试用问题${i}` })).status, 'pending');
  const limited = await request('/api/assistant/questions', { method: 'POST', input: { question: '暂缓提交' } });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await store.listPending()).length, 5);
  assert.equal((await request('/api/assistant/status')).status, 200);
});

test('private drafts require matching current review and cannot revive deleted records', async t => {
  const { store, directory } = await fixture(t);
  const record = await store.create({ question: '请核对考试通知' });
  const first = await store.stageDraft(record.id, answer);
  assert.equal((await store.get(record.id, record.accessToken)).draft, undefined);
  assert.equal((await store.listPending())[0].draft, undefined);
  const listing = await store.adminList();
  assert.equal(listing[0].draft.draftId, first.draft.draftId);
  assert.equal(listing[0].accessToken, undefined);
  assert.equal(listing[0].tokenHash, undefined);
  const newer = await store.stageDraft(record.id, { ...answer, answer: '复核后的答案' });
  await assert.rejects(store.publishDraft(record.id, first.draft.draftId), { statusCode: 409 });
  const restored = await createAssistantStore({ directory });
  const published = await restored.publishDraft(record.id, newer.draft.draftId);
  assert.equal(published.answer, '复核后的答案');
  assert.equal(published.draft, undefined);
  assert.equal(JSON.parse(await readFile(resolve(directory, `${record.id}.json`), 'utf8')).draft, undefined);
  await assert.rejects(store.stageDraft(record.id, answer), { statusCode: 409 });
  await assert.rejects(store.publishDraft(record.id, newer.draft.draftId), { statusCode: 409 });
  const second = await store.create({ question: '待删除' });
  const draft = await store.stageDraft(second.id, answer);
  const simultaneous = await Promise.allSettled([
    store.adminDelete(second.id), store.publishDraft(second.id, draft.draft.draftId),
  ]);
  assert.equal(simultaneous[0].status, 'fulfilled');
  assert.equal(simultaneous[1].status, 'rejected');
  assert.equal(simultaneous[1].reason.statusCode, 404);
  await assert.rejects(readFile(resolve(directory, `${second.id}.json`)), { code: 'ENOENT' });
  await assert.rejects(store.stageDraft(second.id, answer), { statusCode: 404 });
  const third = await store.create({ question: '验证坏草稿' });
  await store.stageDraft(third.id, answer);
  const path = resolve(directory, `${third.id}.json`);
  const invalid = JSON.parse(await readFile(path, 'utf8'));
  invalid.draft.model = 'unreviewed'; await writeFile(path, JSON.stringify(invalid));
  await assert.rejects(store.adminList(), { statusCode: 503 });
});
