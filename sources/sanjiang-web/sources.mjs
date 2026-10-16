export const schoolSources = [
  { id: 'sju-notices', name: '三江学院信息公告', url: 'https://www.sju.edu.cn/', selector: '[frag="窗口31"] a[href*="/page."]' },
  { id: 'sju-innovation', name: '三江学院双创通知', url: 'https://www.sju.edu.cn/scxy/tzgg/list.psp', selector: '.wicket-list a[href*="/page."]' },
  { id: 'sju-lectures', name: '三江学院双创活动预告', url: 'https://www.sju.edu.cn/scxy/7578/list.htm', selector: '.wicket-list a[href*="/page."]' },
  { id: 'sju-academic', name: '三江学院教务处', url: 'https://www.sju.edu.cn/jwc/main.htm', selector: 'a[href*="/page."]', note: '重点收集普通话、四六级、计算机等级考试及选课通知；读取失败时，这些通知可能遗漏，不能视为没有新通知。' },
  { id: 'sju-exams', name: '三江学院考试信息', url: 'https://www.sju.edu.cn/jwc/671/list.htm', selector: 'a[href*="/page."]', note: '专门检查学校考试通知；目前读取失败，本校普通话报名及大一资格尚未核实。' },
];
