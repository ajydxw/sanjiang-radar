/** Official college pages checked on this date; not a guarantee of current admission eligibility. */
export const MAJOR_CATALOG_VERIFIED_AT = "2026-10-30";
export const CUSTOM_MAJOR = "__custom_major__";
export type CollegeMajorCatalog = { majors: string[]; sources: string[]; note?: string };
export const COLLEGE_MAJOR_CATALOG: Record<string, CollegeMajorCatalog> = {
  "建筑学院": {
    "majors": [
      "建筑学",
      "风景园林",
      "人居设计"
    ],
    "sources": [
      "https://www.sju.edu.cn/jzx/b7/0e/c2288a112398/page.htm"
    ]
  },
  "计算机科学与工程学院": {
    "majors": [
      "计算机科学与技术",
      "软件工程",
      "网络工程",
      "网络空间安全",
      "智能科学与技术"
    ],
    "sources": [
      "https://www.sju.edu.cn/jsjkx/1713/list.htm"
    ]
  },
  "土木工程学院": {
    "majors": [
      "土木工程",
      "工程管理",
      "智能建造与智慧交通"
    ],
    "sources": [
      "https://www.sju.edu.cn/tmgc/2340/list.htm"
    ]
  },
  "文化产业与旅游管理学院": {
    "majors": [
      "旅游管理",
      "广告学",
      "文化产业管理",
      "非物质文化遗产保护"
    ],
    "sources": [
      "https://www.sju.edu.cn/whcy/1314/list.htm",
      "https://www.sju.edu.cn/dwxcb/bc/86/c5916a113798/pagem.htm"
    ],
    "note": "包含学院介绍中的在校生专业及 2026 年新增专业。"
  },
  "外国语学院": {
    "majors": [
      "英语",
      "日语",
      "跨境电子商务"
    ],
    "sources": [
      "https://www.sju.edu.cn/wgyxy/1495/list.htm"
    ]
  },
  "电子信息工程学院": {
    "majors": [
      "电子信息工程",
      "通信工程",
      "电子科学与技术",
      "集成电路设计与集成系统",
      "人工智能"
    ],
    "sources": [
      "https://www.sju.edu.cn/_upload/article/files/2f/b4/9b54552f450da028958e4416555d/20fbb956-f728-4292-8dd0-e98f77b8ea36.pdf"
    ]
  },
  "文学与新闻传播学院": {
    "majors": [
      "汉语言文学",
      "新闻学",
      "时尚传播",
      "数字出版",
      "网络与新媒体",
      "广播电视编导",
      "汉语国际教育"
    ],
    "sources": [
      "https://www.sju.edu.cn/wxyxw/6408/list.htm",
      "https://www.sju.edu.cn/wxyxw/_t425/rcpy/list.htm"
    ],
    "note": "汉语国际教育见学院介绍，最新专业目录未单列；不代表当年招生。"
  },
  "法商学院": {
    "majors": [
      "国际经济与贸易",
      "投资学",
      "金融科技",
      "财务管理",
      "会计学",
      "市场营销",
      "电子商务及法律",
      "物流管理",
      "知识产权",
      "供应链管理"
    ],
    "sources": [
      "https://www.sju.edu.cn/sxy/2889/list.htm"
    ]
  },
  "机械与电气工程学院": {
    "majors": [
      "机械设计制造及其自动化",
      "机械电子工程",
      "电气工程及其自动化",
      "自动化",
      "机器人工程",
      "智能制造工程",
      "智能车辆工程"
    ],
    "sources": [
      "https://www.sju.edu.cn/jxydqgc/7426/list.htm"
    ]
  },
  "艺术学院（演艺学院）": {
    "majors": [
      "视觉传达设计",
      "环境设计",
      "数字媒体艺术",
      "公共艺术",
      "动画",
      "摄影",
      "表演",
      "音乐表演"
    ],
    "sources": [
      "https://www.sju.edu.cn/ysxy/main.htm",
      "https://www.sju.edu.cn/ysxy/92/0c/c1225a102924/page.htm",
      "https://www.sju.edu.cn/_upload/article/files/15/a9/904c811e46cb9bab76e623fbbf73/c14e789c-9d75-4688-9bc4-5001a844a515.pdf"
    ],
    "note": "摄影、表演、音乐表演含官网保留的往届专业，不代表当年招生。"
  },
  "高等职业技术学院": {
    "majors": [
      "电气工程及其自动化",
      "机械设计制造及其自动化",
      "财务管理",
      "旅游管理",
      "市场营销",
      "土木工程",
      "英语",
      "软件工程"
    ],
    "sources": [
      "https://www.sju.edu.cn/zcy/_t37/jxgl/list.htm"
    ],
    "note": "依据官网专业介绍（含专转本，页面未标更新日期），不作为 2026 年招生名单。"
  }
};

export function getCollegeCatalog(college: string): CollegeMajorCatalog | undefined {
  return Object.hasOwn(COLLEGE_MAJOR_CATALOG, college) ? COLLEGE_MAJOR_CATALOG[college] : undefined;
}

/** Legacy/free-text values remain editable instead of being silently discarded. */
export function majorSelectValue(college: string, major: string, customMode = false): string {
  if (customMode) return CUSTOM_MAJOR;
  if (!major) return "";
  return getCollegeCatalog(college)?.majors.includes(major) ? major : CUSTOM_MAJOR;
}

/** Only an intentional college change clears a stale cross-college major. */
export function changeProfileCollege<T extends { college: string; major: string }>(profile: T, college: string): T {
  return profile.college === college ? profile : { ...profile, college, major: "" };
}
