import assert from 'node:assert/strict';
import test from 'node:test';
import { newInformationIds, parseVisitHistory, recordVisit, VISIT_GAP } from './visit-history.ts';

const start = new Date('2026-10-11T00:00:00Z');
const later = offset => new Date(start.getTime() + offset);

test('首次访问不把历史记录算作新增，刷新保留本次新增，下次访问更新基线', () => {
  const first = recordVisit(null, { school: ['old'], pu: ['activity'] }, start);
  assert.deepEqual([...newInformationIds(first.seen, first)], []);
  const refreshed = recordVisit(first, { school: ['old', 'new'], pu: ['activity'] }, later(1000));
  assert.deepEqual([...newInformationIds(refreshed.seen, refreshed)], ['new']);
  const reloaded = recordVisit(parseVisitHistory(JSON.parse(JSON.stringify(refreshed))), refreshed.seen, later(2000));
  assert.deepEqual([...newInformationIds(reloaded.seen, reloaded)], ['new']);
  const returned = recordVisit(reloaded, { school: ['old', 'new', 'newer'], pu: ['activity'] }, later(VISIT_GAP + 2000));
  assert.equal(returned.previousVisitAt, reloaded.activeAt);
  assert.deepEqual([...newInformationIds(returned.seen, returned)], ['newer']);
});

test('来源读取失败、暂时移除及重新接入不会把旧信息误标为新增', () => {
  const first = recordVisit(null, { school: ['old', 'temporarily-gone'], pu: ['activity'] }, start);
  const partial = recordVisit(first, { school: ['old'] }, later(VISIT_GAP));
  assert.deepEqual(partial.seen.pu, ['activity']);
  assert.deepEqual(partial.seen.school, ['old', 'temporarily-gone']);
  const recovered = recordVisit(partial, { school: ['old', 'temporarily-gone', 'new'], pu: ['activity'], wechat: ['historical-post'] }, later(VISIT_GAP + 1000));
  assert.deepEqual([...newInformationIds(recovered.seen, recovered)], ['new']);
  assert.deepEqual([...newInformationIds({ school: ['old'], unreadable: ['unknown'] }, first)], []);
});

test('编号决定新增，重新同步和重复来源不产生重复计数', () => {
  const first = recordVisit(null, { school: ['old'], pu: [] }, start);
  assert.deepEqual([...newInformationIds({ school: ['old'], pu: [] }, first)], []);
  assert.deepEqual([...newInformationIds({ school: ['old', 'new', 'new'], pu: ['old', 'new'] }, first)], ['new']);
});

test('损坏或旧格式的浏览记录安全降级为首次访问', () => {
  for (const value of [null, [], {}, { version: 1, activeAt: 'not-a-date' }, { version: 1, activeAt: start.toISOString(), previousVisitAt: null, baseline: { school: [1] }, seen: {} }]) {
    assert.equal(parseVisitHistory(value), null);
  }
  assert.ok(parseVisitHistory(recordVisit(null, {}, start)));
});
