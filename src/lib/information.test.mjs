import assert from 'node:assert/strict';
import test from 'node:test';
import { isExamInformation } from './information.ts';

test('考试入口同时识别学校办理通知和官方考试来源', () => {
  for (const title of ['普通话水平测试报名通知', '大学英语四、六级准考证打印', '计算机等级成绩查询']) {
    assert.equal(isExamInformation({ title, sourceType: 'school' }), true);
  }
  assert.equal(isExamInformation({ title: '本期考试安排', sourceType: 'exam' }), true);
  assert.equal(isExamInformation({ title: '办理安排', sourceType: 'school', activityType: '考务' }), true);
  assert.equal(isExamInformation({ title: '图书馆开放时间', sourceType: 'wechat' }), false);
  assert.equal(isExamInformation({ title: '普通话推广周活动', sourceType: 'school' }), false);
  assert.equal(isExamInformation({ title: '普通话朗诵比赛报名', sourceType: 'school', category: '竞赛' }), false);
  assert.equal(isExamInformation({ title: '创新创业比赛报名', sourceType: 'competition' }), false);
});
