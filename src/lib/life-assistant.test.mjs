import assert from 'node:assert/strict';
import test from 'node:test';
import { appendAssistantQuestion, HISTORY_LIMIT, normalizeQuestion, parseAssistantHistory, parseAssistantResponse, parseAssistantStatus, parseAssistantSubmission, questionLength, safeAssistantSourceUrl, serializeAssistantHistory } from './life-assistant.ts';

const now = new Date('2026-10-12T10:00:00+08:00');
const entry = (id = 'question-1', overrides = {}) => ({ id, question: '大一怎样安排复习？', createdAt: now.toISOString(), contextId: null, ...overrides });
const raw = questions => JSON.stringify({ version: 1, questions });

test('损坏、旧格式及非对象存储安全降级；缺少存储是正常空记录', () => {
  assert.deepEqual(parseAssistantHistory(null), { questions: [], invalid: false });
  for (const value of ['broken', 'null', '[]', '{}', JSON.stringify({ version: 3, questions: [] }), JSON.stringify({ version: 1, questions: {} })]) {
    assert.deepEqual(parseAssistantHistory(value), { questions: [], invalid: true });
  }
});

const remoteId = '33dc8436-91b2-4c1d-a5d8-8e105f1269d3';
const token = 'a'.repeat(43);
const pending = overrides => ({ ...entry(remoteId), status: 'pending', answer: null, sources: [], model: null, reasoningEffort: null, answeredAt: null, ...overrides });
const answered = overrides => pending({ status: 'answered', answer: '可以先固定复习时间。', sources: [{ title: '公开通知', url: 'https://www.sju.edu.cn/notice' }], model: 'gpt-6.1-sol', reasoningEffort: 'high', answeredAt: now.toISOString(), ...overrides });

test('提交回执要求UUID与合法私有token；待处理状态不能假带模型回答', () => {
  const receipt = parseAssistantSubmission(pending({ accessToken: token }));
  assert.equal(receipt.question.accessToken, token);
  assert.equal(receipt.response.status, 'pending');
  assert.equal('accessToken' in receipt.response, false);
  const { model, reasoningEffort, answeredAt, ...omittedPendingFields } = pending({ accessToken: token });
  const omittedReceipt = parseAssistantSubmission(omittedPendingFields);
  assert.equal(omittedReceipt.response.model, null);
  assert.equal(omittedReceipt.response.reasoningEffort, null);
  assert.equal(omittedReceipt.response.answeredAt, null);
  for (const value of [null, {}, pending(), pending({ accessToken: 'short' }), pending({ accessToken: 'x'.repeat(257) }), pending({ accessToken: 'javascript:alert(1)' }), pending({ accessToken: token, id: '../someone-else' }), answered({ accessToken: token })]) {
    assert.equal(parseAssistantSubmission(value), null);
  }
  for (const value of [pending({ model: 'gpt-6.1-sol' }), pending({ answer: '伪造回答' }), pending({ answeredAt: now.toISOString() }), pending({ sources: [{ title: '链接', url: 'https://example.org' }] })]) {
    assert.equal(parseAssistantResponse(value), null);
  }
});

test('远端答复仅接受约定状态、真实模型字段、有效日期及纯文本；不信任本机缓存答复', () => {
  for (const status of ['answered', 'declined', 'needs-info', 'unconfirmed']) {
    const parsed = parseAssistantResponse(answered({ status, answer: '<script>globalThis.executed=true</script>\n普通文本' }));
    assert.equal(parsed.status, status);
    assert.equal(parsed.answer, '<script>globalThis.executed=true</script>\n普通文本');
    assert.equal(globalThis.executed, undefined);
  }
  for (const value of [answered({ model: 'other-model' }), answered({ reasoningEffort: 'low' }), answered({ status: 'thinking' }), answered({ answer: '' }), answered({ answer: '<b>x</b>'.repeat(3000) }), answered({ answeredAt: 'bad-date' }), answered({ question: '问'.repeat(501) }), answered({ contextId: 'x'.repeat(201) })]) {
    assert.equal(parseAssistantResponse(value), null);
  }
  const stored = { ...entry(remoteId), accessToken: token, response: answered(), answer: '本机伪造', sources: [{ title: '假的', url: 'https://evil.example' }] };
  const loaded = parseAssistantHistory(JSON.stringify({ version: 2, questions: [stored] }));
  assert.deepEqual(loaded.questions, [{ ...entry(remoteId), accessToken: token }]);
  const serialized = JSON.parse(serializeAssistantHistory([stored]));
  assert.equal(serialized.version, 2);
  assert.deepEqual(serialized.questions, [{ ...entry(remoteId), accessToken: token }]);
});

test('答复来源只接受不含凭据的HTTP(S)，拒绝脚本、相对URL与外来字段', () => {
  assert.equal(safeAssistantSourceUrl('https://www.sju.edu.cn/news'), 'https://www.sju.edu.cn/news');
  assert.equal(safeAssistantSourceUrl('http://www.sju.edu.cn/news'), 'http://www.sju.edu.cn/news');
  for (const url of ['javascript:alert(1)', 'data:text/html,x', '//evil.example/path', '/relative', 'https://user:password@example.org', 'https://user@example.org', 'file:///private', 'https://example.org/' + 'x'.repeat(2100), null]) {
    assert.equal(safeAssistantSourceUrl(url), null);
    assert.equal(parseAssistantResponse(answered({ sources: [{ title: '来源', url }] })), null);
  }
  assert.equal(parseAssistantResponse(answered({ sources: [{ title: '', url: 'https://example.org' }] })), null);
  assert.equal(parseAssistantResponse(answered({ sources: Array.from({ length: 21 }, () => ({ title: '来源', url: 'https://example.org' })) })), null);
});

test('版本2私有记录保留token与送达未确认状态，版本1忽略任何注入凭据', () => {
  const submitted = { ...entry(remoteId), accessToken: token };
  const unknown = entry('draft', { delivery: 'unconfirmed' });
  assert.deepEqual(parseAssistantHistory(serializeAssistantHistory([submitted, unknown])).questions, [submitted, unknown]);
  assert.deepEqual(parseAssistantHistory(raw([submitted])).questions, [entry(remoteId)]);
  const invalid = parseAssistantHistory(JSON.stringify({ version: 2, questions: [
    { ...submitted, accessToken: 'bad' },
    { ...submitted, id: '../foreign-id' },
    { ...submitted, delivery: 'unconfirmed' },
    entry('bad-delivery', { delivery: 'submitted' }),
    entry('good-draft'),
  ] }));
  assert.equal(invalid.invalid, true);
  assert.deepEqual(invalid.questions, [entry('good-draft')]);
});

test('状态接口仅明确接受提问且非自动回答时启用此整理流程', () => {
  assert.equal(parseAssistantStatus({ acceptsQuestions: true, automaticAnswers: false }), true);
  for (const value of [null, {}, { acceptsQuestions: false, automaticAnswers: false }, { acceptsQuestions: true }, { acceptsQuestions: true, automaticAnswers: true }, { acceptsQuestions: 'true', automaticAnswers: false }]) {
    assert.equal(parseAssistantStatus(value), false);
  }
});

test('问题去除首尾空白，按字符限制500，保留多行与完整unicode字符', () => {
  assert.equal(normalizeQuestion(' \n学习\n安排 \t'), '学习\n安排');
  assert.equal(normalizeQuestion(' \n '), null);
  assert.equal(normalizeQuestion(123), null);
  assert.equal(normalizeQuestion('问'.repeat(500)), '问'.repeat(500));
  assert.equal(normalizeQuestion('问'.repeat(501)), null);
  assert.equal(questionLength('😀'.repeat(500)), 500);
  assert.equal(normalizeQuestion('😀'.repeat(500)), '😀'.repeat(500));
});

test('非法记录被跳过，保留有效条目；不会保存外来来源URL或字段', () => {
  const result = parseAssistantHistory(raw([
    entry('good', { question: '  保留这条  ', sourcePortal: 'javascript:alert(1)', title: '伪造通知' }),
    entry('large', { question: '问'.repeat(501) }),
    entry('empty', { question: ' ' }),
    entry('bad-date', { createdAt: 'not-a-date' }),
    entry('bad-context', { contextId: { url: 'https://evil.example' } }),
    entry('bad-context-blank', { contextId: ' ' }),
    entry('bad-context-control', { contextId: 'notice\n' }),
    entry('bad-id', { id: 123 }),
    null,
    'not-a-record',
  ]));
  assert.equal(result.invalid, true);
  assert.deepEqual(result.questions, [entry('good', { question: '保留这条' })]);
});

test('上下文仅保留ID，不存通知标题、链接；无上下文保持null', () => {
  const questions = appendAssistantQuestion([], ' 普通问题 ', '学校通知-2026-10', 'context-question', now);
  assert.deepEqual(questions, [entry('context-question', { question: '普通问题', contextId: '学校通知-2026-10' })]);
  assert.deepEqual(parseAssistantHistory(serializeAssistantHistory(questions)).questions, questions);
  assert.equal(appendAssistantQuestion([], '问题', 'x'.repeat(201), 'q', now), null);
  assert.equal(appendAssistantQuestion([], '问题', null, 'q', now)[0].contextId, null);
});

test('最多20条：第20条可保存，第21条拒绝且不覆盖历史；读入过量仅保留前20条', () => {
  let questions = [];
  for (let i = 0; i < HISTORY_LIMIT; i++) {
    questions = appendAssistantQuestion(questions, `问题${i}`, null, `q-${i}`, now);
    assert.ok(questions);
  }
  const snapshot = JSON.stringify(questions);
  assert.equal(appendAssistantQuestion(questions, '第21条', null, 'q-extra', now), null);
  assert.equal(JSON.stringify(questions), snapshot);
  assert.equal(questions[0].question, '问题19');
  const loaded = parseAssistantHistory(raw([...questions, entry('overflow')]));
  assert.equal(loaded.invalid, true);
  assert.deepEqual(loaded.questions, questions);
});

test('重复ID、空白及非法提交不写入；XSS内容按原始文本保留', () => {
  const text = '<img src=x onerror=alert(1)>\n<script>globalThis.executed=true</script>';
  const questions = appendAssistantQuestion([], text, null, 'safe-text', now);
  assert.equal(questions[0].question, text);
  assert.equal(parseAssistantHistory(serializeAssistantHistory(questions)).questions[0].question, text);
  assert.equal(globalThis.executed, undefined);
  assert.equal(appendAssistantQuestion(questions, '问题', null, 'safe-text', now), null);
  assert.equal(appendAssistantQuestion([], ' ', null, 'q', now), null);
  assert.equal(appendAssistantQuestion([], '问'.repeat(501), null, 'q', now), null);
  assert.equal(appendAssistantQuestion([], '问题', null, 'q', new Date('invalid')), null);
  assert.equal(parseAssistantHistory(raw([entry('same'), entry('same')])).questions.length, 1);
});
