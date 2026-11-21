import assert from 'node:assert/strict';
import test from 'node:test';
import { competitionClosingSoon, isAiCompetition, isCompetitionOpportunity, isExamInformation } from './information.ts';

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

test('竞赛专区保留尚能关注的真实通知，并拒绝陈旧、已截止或赛后记录', () => {
  const now = new Date('2026-11-21T09:00:00+08:00');
  const contest = { category: '竞赛', title: '校内 AI 创新大赛报名通知', publishedAt: '2026-11-01', freshmanAllowed: 'unknown' };
  assert.equal(isCompetitionOpportunity(contest, now), true);
  assert.equal(isCompetitionOpportunity({ ...contest, publishedAt: '2026-05-01', registrationDeadline: '2026-11-21' }, now), true);
  assert.equal(isCompetitionOpportunity({ ...contest, publishedAt: '2026-05-01', firstSeenAt: '2026-11-21' }, now), false);
  for (const excluded of [
    { title: 'AI 创新大赛获奖名单' },
    { title: '讲座预告丨AI 创新大赛备赛分享' },
    { registrationDeadline: '2026-11-20' },
    { eventEnd: '2026-11-20' },
    { freshmanAllowed: 'excluded' },
    { demo: true },
  ]) assert.equal(isCompetitionOpportunity({ ...contest, ...excluded }, now), false);
  assert.equal(isAiCompetition({ title: 'Qoder 高校创造力大赛', activityType: 'AI大模型赛' }), true);
  assert.equal(isAiCompetition({ title: '工程开发挑战', activityType: '工程开发赛' }), true);
  assert.equal(isAiCompetition({ title: '校内人工智能笔试' }), false);
  assert.equal(competitionClosingSoon(contest, now), false);
  assert.equal(competitionClosingSoon({ registrationDeadline: '2026-11-21' }, now), true);
  assert.equal(competitionClosingSoon({ registrationDeadline: '2026-11-28T09:00:00+08:00' }, now), true);
  assert.equal(competitionClosingSoon({ registrationDeadline: '2026-11-28T09:00:01+08:00' }, now), false);
});
