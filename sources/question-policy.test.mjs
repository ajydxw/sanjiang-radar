import assert from 'node:assert/strict';
import test from 'node:test';
import { QUESTION_MAX_CHARS, ANSWER_MAX_CHARS, CONTEXT_MAX_CHARS, politicalTopicReason } from './question-policy.mjs';

test('问答与业务上下文限额共享常量', () => {
  assert.deepEqual([QUESTION_MAX_CHARS, ANSWER_MAX_CHARS, CONTEXT_MAX_CHARS], [500, 800, 6000]);
});

test('当代政治人物、评价、争议与动员采取相同范围初筛', () => {
  for (const question of ['你如何评价美国总统？', '怎么看共和党执政？', '评价中国共产党的执政表现', '英国政府是否腐败？', '民主和独裁制度哪个更好，比较优劣', '俄乌战争谁对谁错？', '巴以冲突该支持谁？', '南海主权争议是什么？', '苏格兰独立应该支持吗？', '组织反政府示威应该怎么做？', '替政党竞选拉票该怎么动员？', 'What do you think of the president?', 'Ｐｒｅｓｉｄｅｎｔ 的表现如何？']) {
    assert.equal(politicalTopicReason(question), 'politics', question);
  }
});

test('普通知识、古代历史、公共服务、专业复习不因单词误拒', () => {
  for (const question of ['什么是二分查找算法？', '大学活动怎么报名？', '古代罗马共和国如何建立？', '古代罗马政治制度有哪些特点？', '如何申请政府奖学金？', '政府提供的就业补助怎么申请？', '政治学专业怎么安排复习？', '地理中的国界线是什么？', '皮肤敏感怎么护理？', '学生会选举怎么报名？', '政党这个政治学术语是什么意思？', '共产党宣言在十九世纪历史中的背景是什么？']) {
    assert.equal(politicalTopicReason(question), null, question);
  }
  assert.equal(politicalTopicReason(null), null);
});
