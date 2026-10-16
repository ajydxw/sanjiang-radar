import assert from 'node:assert/strict';
import test from 'node:test';
import { publishReviewedBatch } from './assistant-queue.mjs';

test('owner-only 发布要求实际指定模型、五项复核和现有问题，不向访客提供发布入口', async () => {
  const published = [];
  const store = { listPending: async () => [{ id: 'test-id' }], publish: async (id, answer) => { published.push({ id, answer }); } };
  const item = { id: 'test-id', status: 'answered', answer: '先与室友约定安静时间。', sources: [], model: 'gpt-6.1-sol', reasoningEffort: 'high', review: { scope: true, facts: true, timing: true, fields: true, privacy: true } };
  for (const invalid of [[], [item, item], [{ ...item, id: 'unknown' }], [{ ...item, model: 'gpt-6-luna' }], [{ ...item, reasoningEffort: 'low' }], [{ ...item, review: { ...item.review, facts: false } }], [{ ...item, sources: [{ title: '伪来源', url: 'javascript:alert(1)' }] }]]) {
    await assert.rejects(publishReviewedBatch(store, invalid));
  }
  assert.equal(published.length, 0);
  assert.deepEqual(await publishReviewedBatch(store, [item]), { published: ['test-id'] });
  assert.equal(published[0].answer.model, 'gpt-6.1-sol');
  assert.equal(published[0].answer.review, undefined, '复核记录不展示给访客');
});

test('草稿处理只暂存已复核答复，不直接发布给提问者', async () => {
  const staged = [];
  const store = { listPending: async () => [{ id: 'draft-id' }], stageDraft: async (id, answer) => staged.push({ id, answer }), publish: async () => assert.fail('未授权公开发布') };
  const item = { id: 'draft-id', status: 'answered', answer: '普通学习建议。', sources: [], model: 'gpt-6.1-sol', reasoningEffort: 'high', review: { scope: true, facts: true, timing: true, fields: true, privacy: true } };
  assert.deepEqual(await publishReviewedBatch(store, [item], 'draft'), { drafted: ['draft-id'] });
  assert.equal(staged.length, 1);
  await assert.rejects(publishReviewedBatch(store, [item], 'unknown'));
});

test('全批次先复用存储校验，坏来源或Unicode不会造成前一条先发布', async () => {
  const published = [];
  const store = { listPending: async () => [{ id: 'one' }, { id: 'two' }], publish: async id => { published.push(id); } };
  const first = { id: 'one', status: 'answered', answer: '一般建议。', sources: [], model: 'gpt-6.1-sol', reasoningEffort: 'high', review: { scope: true, facts: true, timing: true, fields: true, privacy: true } };
  for (const bad of [
    { id: 'two', sources: [{ title: '来源', url: ' https://www.sju.edu.cn/' }] },
    { id: 'two', sources: [{ title: '来源', url: 'https://www.sju.edu.cn/', extra: '不应发布' }] },
    { id: 'two', answer: '\uD800' },
    { id: 'two', answer: '😀'.repeat(801) },
  ]) await assert.rejects(publishReviewedBatch(store, [first, { ...first, ...bad }]));
  assert.deepEqual(published, []);
});
