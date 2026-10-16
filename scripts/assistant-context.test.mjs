import assert from 'node:assert/strict';
import test from 'node:test';
import { buildQuestionContext } from './assistant-context.mjs';
import { CONTEXT_MAX_CHARS } from '../sources/question-policy.mjs';

const record = { id: 'question-1', question: '大一能报名吗？', accessToken: 'private-token', tokenHash: 'private-token-hash', profile: { studentId: 'private-id' }, otherQuestions: ['private-other-question'] };
const information = { title: '官方活动', sourcePortal: 'https://www.sju.edu.cn/notice', summary: '活动摘要', description: '通知正文', publishedAt: '2026-10-12', registrationDeadline: null, freshmanAllowed: 'unknown', eligibilityEvidence: null, dateEvidence: [], eligibleYears: undefined, privateHash: 'private-extra-field' };
const evidence = { title: '已读取官方原文', url: 'https://www.sju.edu.cn/original', excerpt: '正文资格未明确', checkedAt: '2026-10-12', accessToken: 'private-evidence-token' };

test('仅组装当前问题及公开白名单，保留原文日期和未知资格', () => {
  const result = buildQuestionContext(record, information, [evidence]);
  assert.equal(result.truncated, false);
  assert.equal(result.serialized, JSON.stringify(result.payload));
  assert.deepEqual(Object.keys(result.payload), ['id', 'question', 'matchedInformation', 'verifiedSources', 'truncated']);
  for (const secret of ['accessToken', 'tokenHash', 'profile', 'studentId', 'otherQuestions', 'privateHash', 'private-token', 'private-other-question']) assert.equal(result.serialized.includes(secret), false, secret);
  assert.equal(result.payload.matchedInformation.publishedAt, information.publishedAt);
  assert.equal(result.payload.matchedInformation.registrationDeadline, null);
  assert.equal(result.payload.matchedInformation.freshmanAllowed, 'unknown');
  assert.equal(result.payload.matchedInformation.eligibilityEvidence, null);
  assert.deepEqual(result.payload.matchedInformation.dateEvidence, []);
  assert.equal('eligibleYears' in result.payload.matchedInformation, false);
  assert.equal('registrationStart' in result.payload.matchedInformation, false);
  assert.equal('truncated' in information, false);
});

test('多行 emoji 以真实 Unicode 字符计数，原题不被悄悄截断', () => {
  const question = ('🙂\n').repeat(250);
  assert.equal(Array.from(question).length, 500);
  assert.equal(buildQuestionContext({ id: 'q', question }).payload.question, question);
  assert.throws(() => buildQuestionContext({ id: 'q', question: question + '🙂' }), /500/);
  assert.throws(() => buildQuestionContext({ id: 'q', question: '🙂'.repeat(501) }), /500/);
});

test('通知正文、来源引用和标题按字符限额截断，并明确材料不完整', () => {
  const result = buildQuestionContext(record, { ...information, title: '🙂'.repeat(121), description: '🙂'.repeat(1501) }, [{ ...evidence, excerpt: '🙂'.repeat(1001) }]);
  assert.equal(Array.from(result.payload.matchedInformation.title).length, 120);
  assert.equal(Array.from(result.payload.matchedInformation.description).length, 1500);
  assert.equal(Array.from(result.payload.verifiedSources[0].excerpt).length, 1000);
  assert.equal(result.payload.matchedInformation.truncated, true);
  assert.equal(result.payload.verifiedSources[0].truncated, true);
  assert.equal(result.truncated, true);
});

test('最多两份已核验官方证据，未读取内容不会自动补全', () => {
  const result = buildQuestionContext(record, null, [evidence, { ...evidence, title: '证据二' }, { ...evidence, title: '证据三' }]);
  assert.equal(result.payload.verifiedSources.length, 2);
  assert.equal(result.truncated, true);
  assert.equal(result.serialized.includes('证据三'), false);
  const empty = buildQuestionContext(record);
  assert.equal(empty.payload.matchedInformation, null);
  assert.deepEqual(empty.payload.verifiedSources, []);
});

test('恶意、过长、凭证链接整个忽略并标记不完整', () => {
  for (const url of ['javascript:alert(1)', 'https://u:p@example.com/', 'https://example.com/?token=secret', 'https://example.com/?accessToken=secret', 'https://example.com/?api_key=secret', 'https://example.com/?privateHash=secret', 'https://example.com/?session=secret', 'https://example.com/' + 'a'.repeat(10000)]) {
    const result = buildQuestionContext(record, { ...information, sourcePortal: url }, [{ ...evidence, url }]);
    assert.equal(result.payload.matchedInformation, null, url.slice(0, 50));
    assert.deepEqual(result.payload.verifiedSources, []);
    assert.equal(result.truncated, true);
  }
  const source = { ...evidence, url: 'https://example.com/' + 'a'.repeat(480) };
  assert.equal(Array.from(source.url).length, 500);
  assert.equal(buildQuestionContext(record, null, [source]).payload.verifiedSources.length, 1);
});

test('serialized 包含 JSON 转义后的实际字符仍硬限制 6000，超长元数据不变成假日期', () => {
  const question = '\u0001'.repeat(500);
  const originalDate = '未明确'.repeat(10000);
  const result = buildQuestionContext({ id: 'q', question }, { ...information, description: '\u0002'.repeat(1500), registrationDeadline: originalDate, dateEvidence: ['🙂'.repeat(10000)], colleges: ['a'.repeat(10000)] }, [{ ...evidence, excerpt: '\u0003'.repeat(1000), checkedAt: 'x'.repeat(10000) }, { ...evidence, excerpt: '🙂'.repeat(1000) }]);
  assert.ok(Array.from(result.serialized).length <= CONTEXT_MAX_CHARS);
  assert.equal(result.payload.question, question);
  assert.equal(result.truncated, true);
  assert.ok(result.payload.matchedInformation.registrationDeadline === undefined || result.payload.matchedInformation.registrationDeadline === originalDate);
  if (result.payload.matchedInformation) assert.equal(result.payload.matchedInformation.truncated, true);
});
