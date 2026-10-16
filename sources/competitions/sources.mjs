export const competitionSources = [
  {
    id: 'competition-math', name: '中国数学会 · 大学生数学竞赛',
    url: 'https://www.cms.org.cn/index.php/Home/comp/comp/cid/16.html',
    selector: 'a[href*="comp_details"], a[href$=".pdf"]', contentSelector: 'body',
    seeds: [{ url: 'https://www.cms.org.cn/Home/comp/comp_details/id/1449.html', title: '关于举办第十八届全国大学生数学竞赛的通知' }],
    method: '通过所在赛区及学校组织报名；全国报名要求不能代替三江学院的校内截止，请先向学校赛事负责老师确认。',
  },
  {
    id: 'competition-ccsp', name: '中国计算机学会 · CCSP',
    url: 'https://www.ccf.org.cn/ccsp/tzgg/', selector: 'a[href*="/ccsp/"][href$=".shtml"]', contentSelector: '.detailbox',
    seeds: [{ url: 'https://www.ccf.org.cn/ccsp/Bulletin/2026-09-09/931089.shtml', title: '2026 CCF CCSP竞赛报名通知' }],
    method: '通过 CCF 官方系统报名；须满足通知规定的 CSP 成绩门槛并通过审核，可选择个人或学校团体报名。',
  },
  {
    id: 'competition-lanqiao', name: '蓝桥杯 · 软件电子个人赛',
    url: 'https://dasai.lanqiao.cn/pages/v7/dasai/competition/individual_competition.html',
    title: '蓝桥杯软件、电子与鸿蒙个人赛', contentSelector: '.individual',
    method: '在蓝桥杯官方系统选择本校、科目和组别，由学校配备指导老师并按官方流程缴费。校内组织时间可能早于全国系统截止。',
  },
  {
    id: 'competition-design', name: '蓝桥杯 · 视觉艺术设计赛', url: 'https://design.lanqiao.cn/',
    title: '蓝桥杯视觉艺术设计赛', contentSelector: '.main-container', render: true, marker: '参赛对象',
    method: '按官网作品要求组队，在蓝桥杯官方报名入口提交；同校 1–3 人组队，不允许跨校。具体报名截止需查看当届通知。',
  },
  {
    id: 'competition-english', name: '大学生英语竞赛 · 官方合作报名页', url: 'https://neccs.saikr.com/',
    title: '全国大学生英语竞赛（NECCS）', contentSelector: 'body', render: true, marker: '报名时间',
    method: '按专业选择 B、C 或 D 类，确认三江学院是否开通网上报名；没有本校入口时向学校负责老师咨询，不可跨校报名。',
  },
  {
    id: 'competition-sanchuang', name: '全国大学生电子商务三创赛', url: 'https://www.3chuang.net/',
    title: '全国大学生电子商务三创赛', contentSelector: 'body', render: true, marker: '赛事流程',
    method: '在三创赛官网选择赛道注册团队，通过学校组织参加校赛；各赛道条件及校内安排需另行确认。',
  },
];
