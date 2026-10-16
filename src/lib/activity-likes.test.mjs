import assert from 'node:assert/strict';
import test from 'node:test';
import { readLikeSummary } from './activity-likes.ts';

test('点赞汇总只保留计数和自己的点赞，不信任其他公开身份或坏数量', () => {
  assert.deepEqual(readLikeSummary({ counts: { one: 2, two: 0 }, likedIds: ['one', 'one'], voterToken: 'not copied' }), { counts: { one: 2, two: 0 }, likedIds: ['one'] });
  for (const value of [null, [], {}, { counts: [], likedIds: [] }, { counts: { one: -1 }, likedIds: [] }, { counts: { one: 0.5 }, likedIds: [] }, { counts: {}, likedIds: ['missing'] }, { counts: { one: 0 }, likedIds: ['one'] }, JSON.parse('{"counts":{"__proto__":1},"likedIds":[]}')]) assert.throws(() => readLikeSummary(value));
});
