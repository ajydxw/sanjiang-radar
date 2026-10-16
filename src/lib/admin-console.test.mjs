import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAdminSession, parseAdminQuestion, parseAdminQuestions, safeAdminSourceUrl, safeAdminLoginLocation, filterAdminQuestions } from './admin-console.ts';
const id = '33dc8436-91b2-4c1d-a5d8-8e105f1269d3';
const now = '2026-10-12T02:00:00.000Z';
const pending = (extra = {}) => ({ id, question: '如何安排复习？', contextId: null, createdAt: now, status: 'pending', answer: null, sources: [], ...extra });
const draft = (extra = {}) => ({ draftId: 'c71820c6-f6dd-4471-adbc-36809b778833', status: 'answered', answer: '先确定复习时间。', sources: [{ title: '公开通知', url: 'https://example.edu/notice?year=2026' }], model: 'gpt-6.1-sol', reasoningEffort: 'high', reviewedAt: now, ...extra });
const answered = (extra = {}) => pending({ status: 'answered', answer: '<script>plain text</script>', model: 'gpt-6.1-sol', reasoningEffort: 'high', answeredAt: now, ...extra });
const envelope = items => ({ items, stats: { total: items.length, pending: items.filter(i => i.status === 'pending').length, ready: items.filter(i => i.draft).length, answered: items.filter(i => i.status === 'answered').length, declined: 0, needsInfo: 0, unconfirmed: 0 }, processing: { mode: 'owner-triggered', automaticAnswers: false, model: 'gpt-6.1-sol', reasoningEffort: 'high' } });
test('会话只允许配置后的admin以及有效防护值', () => {
  const good = { configured: true, authenticated: true, username: 'admin', csrfToken: 'a'.repeat(43) };
  assert.ok(parseAdminSession(good));
  assert.ok(parseAdminSession({ configured: false, authenticated: false, username: null, csrfToken: null }));
  for (const value of [null, {}, { ...good, configured: false }, { ...good, username: 'bad username' }, { ...good, csrfToken: 'short' }]) assert.equal(parseAdminSession(value), null);
});
test('严格校验问题、草稿的模型、UUID、日期和字段边界', () => {
  assert.ok(parseAdminQuestion(pending({ draft: draft() })));
  assert.equal(parseAdminQuestion(answered()).answer, '<script>plain text</script>');
  assert.equal('accessToken' in parseAdminQuestion(pending({ accessToken: 'private' })), false);
  for (const value of [pending({ id: '../private' }), pending({ createdAt: 'yesterday' }), pending({ createdAt: '2026-02-30T00:00:00Z' }), pending({ question: '问'.repeat(501) }), pending({ model: 'gpt-6.1-sol' }), answered({ model: 'other' }), answered({ reasoningEffort: 'low' }), answered({ answeredAt: 'invalid' }), pending({ draft: draft({ model: 'other' }) }), pending({ draft: draft({ reasoningEffort: 'low' }) }), pending({ draft: draft({ reviewedAt: 'invalid' }) }), pending({ draft: draft({ draftId: 'bad' }) })]) assert.equal(parseAdminQuestion(value), null);
});
test('来源允许普通查询，拒绝脚本、账号口令和私有读取链接', () => {
  assert.equal(safeAdminSourceUrl('https://example.edu/notice?year=2026'), 'https://example.edu/notice?year=2026');
  for (const value of ['javascript:alert(1)', 'file:///private', 'https://user:password@example.edu/', 'https://example.edu/?accessToken=private', 'https://example.edu/#csrfToken=private', 'https://example.edu/?password=private', 'https://example.edu/api/assistant/questions/' + id]) assert.equal(safeAdminSourceUrl(value), null);
  assert.equal(parseAdminQuestion(pending({ draft: draft({ sources: [{ title: '私有地址', url: 'https://example.edu/?token=private' }] }) })), null);
});
test('部分损坏数据标记invalid，统计与处理配置异常拒绝整包', () => {
  const good = pending();
  assert.equal(parseAdminQuestions(envelope([good])).invalid, false);
  const partial = parseAdminQuestions(envelope([good, pending({ id: 'bad' })]));
  assert.equal(partial.invalid, true);
  assert.equal(partial.items.length, 1);
  const badProcessing = envelope([good]); badProcessing.processing.model = 'other';
  assert.equal(parseAdminQuestions(badProcessing), null);
  const badStats = envelope([good]); badStats.stats.ready = -1;
  assert.equal(parseAdminQuestions(badStats), null);
  const mismatched = envelope([good]); mismatched.stats.pending = 0; mismatched.stats.answered = 1;
  assert.equal(parseAdminQuestions(mismatched), null);
});
test('待回复、待审核、已处理分类互斥', () => {
  const items = [parseAdminQuestion(pending()), parseAdminQuestion(pending({ id: '933ea5ee-990e-4db7-8988-b20e3191a848', draft: draft() })), parseAdminQuestion(answered({ id: 'be83134a-1089-4d57-995e-b43fe79a5a0b' }))];
  assert.equal(filterAdminQuestions(items, 'all').length, 3);
  for (const filter of ['pending', 'ready', 'processed']) assert.equal(filterAdminQuestions(items, filter).length, 1);
});

test('HTTPS或本机HTTP才允许输入和提交管理密码', () => {
  for (const url of ['https://radar.example/#admin', 'http://localhost:4398/#admin', 'http://127.0.0.1:4398/#admin', 'http://[::1]:4398/#admin']) assert.equal(safeAdminLoginLocation(url), true);
  for (const url of ['http://radar.example/#admin', 'http://192.168.1.2:4398/#admin', 'http://localhost.example/#admin', 'file:///admin', 'bad']) assert.equal(safeAdminLoginLocation(url), false);
});

test('会话用户名支持合法ASCII账号，拒绝空白、中文和越界', () => {
  const session = { configured: true, authenticated: true, username: 'owner_01', csrfToken: 'a'.repeat(43) };
  assert.equal(parseAdminSession(session).username, 'owner_01');
  for (const username of ['', 'a', '用户', 'bad name', 'a'.repeat(41)]) assert.equal(parseAdminSession({ ...session, username }), null);
});
