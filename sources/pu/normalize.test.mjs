import test from 'node:test';
import assert from 'node:assert/strict';
import { puDate, puEligibility, toPuInformation } from './normalize.mjs';

test('PU dates use China time and reject impossible dates', () => {
  assert.equal(puDate('2026-10-14 12:00:35'), '2026-10-14T12:00:35+08:00');
  assert.equal(puDate('2026-02-30 12:00:00'), undefined);
  assert.equal(puDate(''), undefined);
});
test('explicit cohort restrictions exclude other years without treating missing years as permission', () => {
  assert.equal(puEligibility(['23'], 1).value, 'excluded');
  assert.equal(puEligibility(['24', '25', '26'], 1).value, 'allowed');
  assert.equal(puEligibility([], 1).value, 'unknown');
  assert.equal(puEligibility(['26'], 2).value, 'unknown');
  assert.equal(puEligibility(['其他'], 1).value, 'unknown');
});
test('registration deadline is distinct from event end; capacity is a snapshot', () => {
  const activity = { id: '123', base: { name: '活动', joinEndTime: '2026-10-09 12:00:00', endTime: '2026-10-09 15:00:00', allowUserCount: 3, joinUserCount: 3 }, allowedYears: [], detailRead: true };
  const item = toPuInformation(activity, '2026-10-09T04:00:00Z');
  assert.equal(item.registrationDeadline, '2026-10-09T12:00:00+08:00');
  assert.equal(item.eventEnd, '2026-10-09T15:00:00+08:00');
  assert.equal(item.remainingSlots, 0);
});
test('missing publication time stays unknown and repeated collection preserves first discovery', () => {
  const activity = { id: '123', base: { name: '活动', aTime: 0 }, allowedYears: [], detailRead: true };
  const item = toPuInformation(activity, '2026-10-09T05:00:00Z', { firstSeenAt: '2026-10-08T05:00:00Z' });
  assert.equal(item.publishedAt, '');
  assert.equal(item.firstSeenAt, '2026-10-08T05:00:00Z');
  assert.equal(item.reward, undefined);
});
test('2026 units follow the official notice, not the legacy credit field name', () => {
  const activity = { id: '123', base: { name: '活动', credit: 1, puType: 0, isZyfwActivity: 1, maxMinutes: 720 }, creditTipContent: '从2024级学生用户开始，分值单位变更为积分，劳动教育变更为学时。', allowedYears: [], detailRead: true };
  const item = toPuInformation(activity, '2026-10-09T05:00:00Z');
  assert.equal(item.reward.kind, 'PU积分');
  assert.equal(item.reward.value, 1);
  assert(!item.rewardNote.includes('720'));
  assert(!item.rewardNote.includes('12小时'));
});
test('account fields and unsafe markup do not enter the public record', () => {
  const activity = { id: '123', base: { name: '活动', description: '<p>活动介绍</p><script>privateMarker()</script>', creatorUID: 'PRIVATE_SENTINEL' }, userStatus: { hasJoin: 'PRIVATE_SENTINEL' }, allowedYears: [], detailRead: true };
  const result = JSON.stringify(toPuInformation(activity, '2026-10-09T05:00:00Z'));
  assert(!result.includes('PRIVATE_SENTINEL'));
  assert(!result.includes('privateMarker'));
});
