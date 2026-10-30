export type Category = "PU活动" | "竞赛" | "学校通知" | "讲座" | "志愿活动" | "校园资讯";
export type Eligibility = "allowed" | "excluded" | "unknown";
export type Reward = { kind: "PU积分" | "素质学分" | "学时" | "志愿时长"; value: number; unit: string };
export type Information = {
  id: string;
  title: string;
  category: Category;
  summary: string;
  source: string;
  sourceType: "school" | "pu" | "wechat" | "competition" | "exam";
  sourcePortal: string;
  publishedAt: string;
  firstSeenAt?: string;
  description?: string;
  registrationStart?: string;
  registrationDeadline?: string;
  eventStart?: string;
  eventEnd?: string;
  location?: string;
  freshmanAllowed: Eligibility;
  colleges: string[];
  reward?: Reward;
  rewardNote: string;
  importance: "high" | "normal" | "secondary";
  registrationMethod: string;
  registrationNote?: string;
  verification: "示例学校通知" | "示例PU活动" | "示例公众号内容" | "示例待核验信息" | "学校官方原文" | "PU官方活动" | "公众号原文" | "竞赛官方原文" | "考试官方原文";
  demo: boolean;
  fetchedAt?: string;
  manuallyVerified?: boolean;
  eligibilityEvidence?: string | null;
  dateEvidence?: string[];
  attachments?: { title: string; url: string }[];
  eligibleYears?: string[];
  activityType?: string;
  capacity?: number;
  registeredCount?: number;
  remainingSlots?: number;
  officialStatus?: string;
  detailRead?: boolean;
  sourceAvailable?: boolean;
};

export type SchoolFeed = {
  schemaVersion: 1;
  generatedAt: string;
  items: Information[];
  sources: { id: string; name: string; url: string; state: "ok" | "partial" | "failed" | "pending"; count: number; lastSuccessAt: string | null; lastAttemptAt?: string | null; note?: string; error?: string | null; sourceType?: Information["sourceType"] }[];
};

export const DEMO_NOW = new Date("2026-10-08T10:00:00+08:00");
export const CATEGORIES: Category[] = ["PU活动", "竞赛", "学校通知", "讲座", "志愿活动", "校园资讯"];
export const COLLEGES = ["暂不选择", "建筑学院", "计算机科学与工程学院", "土木工程学院", "文化产业与旅游管理学院", "外国语学院", "电子信息工程学院", "文学与新闻传播学院", "法商学院", "国际教育学院", "机械与电气工程学院", "艺术学院（演艺学院）", "高等职业技术学院", "其他学院"];

export const chinaDateKey = (date: Date) => date.toLocaleDateString("en-CA", { timeZone: "Asia/Shanghai" });

export function isExamInformation(item: Information): boolean {
  return item.sourceType === "exam" || item.activityType === "考务" || item.category !== "竞赛" && /普通话.*(?:测试|考试|报名|成绩|证书|领证)|四[、，]?六级|计算机等级|准考证/.test(item.title);
}

export function deadlineTime(value: string): number {
  return Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T23:59:59+08:00` : value);
}

export function deadlineLabel(deadline?: string, now = new Date()): string {
  if (!deadline) return "截止时间未明确";
  const target = new Date(deadlineTime(deadline));
  if (target.getTime() <= now.getTime()) return "报名已截止";
  const today = chinaDateKey(now);
  const targetDay = chinaDateKey(target);
  if (targetDay === today) return "今天截止";
  const days = Math.round((Date.parse(targetDay) - Date.parse(today)) / 86400000);
  return days <= 1 ? "明天截止" : `还有 ${days} 天截止`;
}

export function isOpen(item: Information, now = new Date()): boolean {
  if (item.sourceAvailable === false || item.eventEnd && deadlineTime(item.eventEnd) <= now.getTime()) return false;
  return !item.registrationDeadline || deadlineTime(item.registrationDeadline) > now.getTime();
}

export function informationTime(item: Information): string {
  return item.publishedAt || item.firstSeenAt || item.fetchedAt || "";
}

export function registrationStatus(item: Information, now = new Date()): "upcoming" | "closed" | "open" | "unknown" {
  if (item.registrationDeadline && deadlineTime(item.registrationDeadline) <= now.getTime()) return "closed";
  if (item.registrationStart && Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(item.registrationStart) ? `${item.registrationStart}T00:00:00+08:00` : item.registrationStart) > now.getTime()) return "upcoming";
  if (item.registrationStart) return "open";
  return "unknown";
}

export function matchesCollege(item: Information, college: string): boolean {
  return college === "暂不选择" || item.colleges.length === 0 || item.colleges.includes(college);
}

export function formatDate(value?: string): string {
  if (!value) return "未明确，请查看原通知";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "long", day: "numeric" }).format(new Date(`${value}T00:00:00+08:00`));
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
}

export function rewardLabel(reward?: Reward): string {
  return reward ? `${reward.value}${reward.unit && reward.unit !== reward.kind ? ` ${reward.unit}` : ""} ${reward.kind}` : "奖励未明确";
}

export function eligibilityLabel(value: Eligibility): string {
  return value === "allowed" ? "大一可参加" : value === "excluded" ? "不面向大一" : "资格待确认";
}
