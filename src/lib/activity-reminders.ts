import type { Information } from "./information";
import { safeExternalUrl } from "../../sources/public-feed.mjs";

export const REMINDER_STORAGE_KEY = "sanjiang-radar-reminders-v1";
export type ReminderOptions = { start: boolean; deadline: boolean };
export type ReminderPreferences = Record<string, ReminderOptions>;
export type ReminderEvent = {
  key: string;
  itemId: string;
  kind: "start" | "deadline";
  at: string;
  dateOnly: boolean;
  title: string;
  sourcePortal: string;
  description: string;
  alarmTimes: string[];
};

const unsafeKeys = new Set(["__proto__", "prototype", "constructor"]);
const validId = (id: string) => id.length > 0 && id.length <= 200 && !unsafeKeys.has(id) && !/[\u0000-\u001f\u007f]/.test(id);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function readReminderPreferences(raw: string | null): ReminderPreferences {
  const result: ReminderPreferences = Object.create(null);
  if (!raw || raw.length > 256000) return result;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value) || value.version !== 1 || !record(value.items)) return result;
    let count = 0;
    for (const [id, options] of Object.entries(value.items)) {
      if (!validId(id) || !record(options) || typeof options.start !== "boolean" || typeof options.deadline !== "boolean") continue;
      result[id] = { start: options.start, deadline: options.deadline };
      if (++count >= 1000) break;
    }
  } catch { /* A damaged local preference must not hide valid activities. */ }
  return result;
}

export function getReminderOptions(prefs: ReminderPreferences, id: string): ReminderOptions {
  const options = validId(id) && Object.hasOwn(prefs, id) ? prefs[id] : undefined;
  return { start: typeof options?.start === "boolean" ? options.start : true, deadline: typeof options?.deadline === "boolean" ? options.deadline : true };
}

function validDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return year > 0 && month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}

function nextDay(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
}

function parseTime(value: unknown): { time: number; dateOnly: boolean } | null {
  if (typeof value !== "string" || value.length > 40) return null;
  if (validDay(value)) {
    // Date-only deadlines last through the stated day in the school's timezone.
    const following = nextDay(value);
    return validDay(following) ? { time: Date.parse(`${following}T00:00:00+08:00`), dateOnly: true } : null;
  }
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match || !validDay(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4] || 0) > 59) return null;
  const zone = match[6];
  if (zone !== "Z" && (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4)) > 59)) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? { time, dateOnly: false } : null;
}

function officialUrl(value: unknown): string {
  if (!safeExternalUrl(value) || typeof value !== "string" || value.length > 2048) return "";
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  // Official source links use public hostnames; local addresses never enter exports.
  if (!host.includes(".") || host.startsWith("[") || /(?:^|\.)(?:localhost|local|internal|lan|home)$/.test(host)) return "";
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split(".").map(Number);
    if ([0, 10, 127].includes(a) || a >= 224 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 168 || a === 100 && b >= 64 && b <= 127 || a === 198 && [18, 19].includes(b)) return "";
  }
  if ([...url.searchParams.keys()].some(key => /token|password|authorization|session|secret|credential|csrf/i.test(key)) || /(?:token|password|authorization|session|secret|credential|csrf)[^=]*=/i.test(url.hash)) return "";
  return url.href;
}

export function buildReminderEvents(items: Information[], prefs: ReminderPreferences, now: Date): ReminderEvent[] {
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) return [];
  const events: ReminderEvent[] = [];
  const keys = new Set<string>();
  for (const item of items) {
    if (!validId(item.id) || item.demo || item.freshmanAllowed === "excluded" || item.sourceAvailable === false || item.remainingSlots === 0) continue;
    if (/^(?:已取消|活动已取消|活动取消|取消举办|取消|已终止|已撤销|不可报名|禁止报名|停止报名|报名已关闭|已关闭报名|报名已结束|报名已截止|报名截止|已截止|活动已结束|已结束|已满员|报名已满|名额已满|cancelled|canceled)$/i.test(item.officialStatus?.trim() || "")) continue;
    const end = parseTime(item.eventEnd);
    const deadline = parseTime(item.registrationDeadline);
    if (end && end.time <= nowTime || deadline && deadline.time <= nowTime) continue;
    const options = getReminderOptions(prefs, item.id);
    for (const kind of ["start", "deadline"] as const) {
      if (!options[kind]) continue;
      const at = kind === "start" ? item.registrationStart : item.registrationDeadline;
      const parsed = parseTime(at);
      if (!at || !parsed || parsed.time <= nowTime || kind === "start" && parsed.dateOnly) continue;
      const key = `${item.id}:${kind}:${at}`;
      if (keys.has(key)) continue;
      keys.add(key);
      const sourcePortal = officialUrl(item.sourcePortal);
      const alarmTimes = parsed.dateOnly
        ? [Date.parse(`${at}T09:00:00+08:00`) - 86400000, Date.parse(`${at}T09:00:00+08:00`)]
        : kind === "start" ? [parsed.time - 600000, parsed.time] : [parsed.time - 86400000, parsed.time - 3600000, parsed.time];
      const description = [
        `来源：${item.source}`,
        item.freshmanAllowed === "unknown" ? "参与资格未知，请先核对官方要求。" : "参与资格及学院等限制请再次核对官方原文。",
        "奖励不保证，以官方条件和最终认定为准。",
        "名额为同步时的快照，非实时状态；导入后日历不会自动同步变更，请再次查看官方原文。",
        item.capacity !== undefined ? `名额快照：容量 ${item.capacity} 人，剩余 ${item.remainingSlots ?? "未明确"} 个。` : "",
        item.fetchedAt ? `同步时间：${item.fetchedAt}` : "",
        item.location ? `活动地点：${item.location}` : "",
        `官方原文：${sourcePortal || "链接不可用，请前往官方渠道核对。"}`,
        parsed.dateOnly ? "原文仅公布截止日期，具体时刻未公布，以原文为准。本事件为全天日期标记；北京时间09:00仅为检查提醒，不代表截止时刻。" : `原文报名${kind === "start" ? "开始" : "截止"}时间：${at}`,
      ].filter(Boolean).join("\n");
      events.push({ key, itemId: item.id, kind, at, dateOnly: parsed.dateOnly, title: `${kind === "start" ? "报名开始" : "报名截止"}${parsed.dateOnly ? "（具体时刻未公布）" : ""}：${item.title}`, sourcePortal, description, alarmTimes: alarmTimes.filter(time => time > nowTime).map(time => new Date(time).toISOString()) });
    }
  }
  const calendarStart = (event: ReminderEvent) => event.dateOnly ? Date.parse(`${event.at}T00:00:00+08:00`) : parseTime(event.at)!.time;
  return events.sort((a, b) => calendarStart(a) - calendarStart(b) || a.key.localeCompare(b.key));
}

const utc = (time: number) => new Date(time).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const calendarText = (value: string) => value.replace(/\r\n|\r|\n/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/;/g, "\\;").replace(/,/g, "\\,");

function foldLine(line: string): string {
  const encoder = new TextEncoder();
  let folded = "";
  let length = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (length + size > 75) { folded += "\r\n "; length = 1; }
    folded += character;
    length += size;
  }
  return folded;
}

function uid(key: string): string {
  let first = 2166136261;
  let second = 5381;
  for (const character of key) {
    const code = character.codePointAt(0)!;
    first = Math.imul(first ^ code, 16777619);
    second = Math.imul(second, 33) ^ code;
  }
  // The source id, kind and unchanged source time form a stable calendar identity.
  return `${(first >>> 0).toString(16).padStart(8, "0")}${(second >>> 0).toString(16).padStart(8, "0")}@sanjiang-radar`;
}

export function createReminderCalendar(events: ReminderEvent[], now: Date): string {
  const nowTime = now.getTime();
  if (!Number.isFinite(nowTime)) throw new Error("日历生成时间无效");
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Sanjiang Radar//Activity Reminders//ZH-CN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH"];
  const seen = new Set<string>();
  for (const event of events) {
    const parsed = parseTime(event.at);
    if (!parsed || parsed.dateOnly !== event.dateOnly || parsed.time <= nowTime || !validId(event.itemId) || !["start", "deadline"].includes(event.kind) || event.dateOnly && event.kind !== "deadline") continue;
    const identity = `${event.itemId}:${event.kind}:${event.at}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    lines.push("BEGIN:VEVENT", `UID:${uid(identity)}`, `DTSTAMP:${utc(nowTime)}`);
    if (event.dateOnly) lines.push(`DTSTART;VALUE=DATE:${event.at.replace(/-/g, "")}`, `DTEND;VALUE=DATE:${nextDay(event.at).replace(/-/g, "")}`);
    else lines.push(`DTSTART:${utc(parsed.time)}`, `DTEND:${utc(parsed.time + 300000)}`);
    lines.push(`SUMMARY:${calendarText(event.title)}`, `DESCRIPTION:${calendarText(event.description)}`);
    const url = officialUrl(event.sourcePortal);
    if (url) lines.push(`URL:${url}`);
    for (const alarm of [...new Set(event.alarmTimes)]) {
      const alarmTime = parseTime(alarm);
      if (!alarmTime || alarmTime.dateOnly || alarmTime.time <= nowTime) continue;
      lines.push("BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${calendarText(event.title)}`, `TRIGGER;VALUE=DATE-TIME:${utc(alarmTime.time)}`, "END:VALARM");
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
