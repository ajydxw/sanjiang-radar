import assert from 'node:assert/strict';
import test from 'node:test';
import { COLLEGE_MAJOR_CATALOG, getCollegeCatalog, CUSTOM_MAJOR, majorSelectValue, changeProfileCollege } from './college-majors.ts';

test('官方目录按学院隔离，建筑学院包含风景园林', () => {
  assert.ok(getCollegeCatalog('建筑学院').majors.includes('风景园林'));
  assert.ok(!getCollegeCatalog('计算机科学与工程学院').majors.includes('风景园林'));
  for (const entry of Object.values(COLLEGE_MAJOR_CATALOG)) {
    assert.equal(new Set(entry.majors).size, entry.majors.length);
    assert.ok(entry.majors.length > 0);
    assert.ok(entry.sources.length > 0);
    for (const url of entry.sources) assert.match(new URL(url).hostname, /(^|\.)sju\.edu\.cn$/);
  }
});
test('默认不替用户选择专业；选择值可还原', () => {
  assert.equal(majorSelectValue('建筑学院', ''), '');
  assert.equal(majorSelectValue('建筑学院', '风景园林'), '风景园林');
  assert.equal(majorSelectValue('建筑学院', '', true), CUSTOM_MAJOR);
});
test('已有手填专业和未知学院保留在手动输入模式', () => {
  assert.equal(majorSelectValue('建筑学院', '原来填写的专业'), CUSTOM_MAJOR);
  assert.equal(majorSelectValue('暂不选择', '旧专业'), CUSTOM_MAJOR);
  for (const name of ['其他学院', '暂不选择', '__proto__', 'constructor']) assert.equal(getCollegeCatalog(name), undefined);
});
test('切换学院清空旧专业，但保留其他设置，重复选择不丢值', () => {
  const profile = { college: '建筑学院', major: '风景园林', interests: ['竞赛'] };
  assert.equal(changeProfileCollege(profile, '建筑学院'), profile);
  assert.deepEqual(changeProfileCollege(profile, '计算机科学与工程学院'), { college: '计算机科学与工程学院', major: '', interests: ['竞赛'] });
  assert.equal(profile.major, '风景园林');
  assert.equal(changeProfileCollege(profile, '暂不选择').major, '');
});
