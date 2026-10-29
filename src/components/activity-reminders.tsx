"use client";

import { Bell, CalendarArrowDown, ChevronRight } from "lucide-react";
import { formatDate, type Information } from "@/lib/information";
import { buildReminderEvents, type ReminderEvent, type ReminderOptions } from "@/lib/activity-reminders";

export function ReminderSettings({ item, saved, options, now, onChange, onSave, onExport, disabled = false }: {
  item: Information; saved: boolean; options: ReminderOptions; now: Date; disabled?: boolean;
  onChange: (options: ReminderOptions) => void; onSave: () => void; onExport: () => void;
}) {
  const candidates = buildReminderEvents([item], {}, now);
  const start = candidates.find(event => event.kind === "start");
  const deadline = candidates.find(event => event.kind === "deadline");
  const enabled = candidates.some(event => options[event.kind]);
  return <section className="reminder-settings" aria-label="这条信息的活动提醒">
    <div className="reminder-heading"><Bell size={18} /><h3>活动提醒</h3><span>免费日历提醒</span></div>
    {!saved && <p>先收藏关注，再把报名提醒导入手机日历。</p>}
    <label><input type="checkbox" checked={saved && !!start && options.start} disabled={!saved || !start} onChange={event => onChange({ ...options, start: event.target.checked })} />
      <span>报名开始前 10 分钟及开始时<small>{start ? formatDate(start.at) : "没有可用的未来报名时刻，请核对原通知"}</small></span></label>
    <label><input type="checkbox" checked={saved && !!deadline && options.deadline} disabled={!saved || !deadline} onChange={event => onChange({ ...options, deadline: event.target.checked })} />
      <span>{deadline?.dateOnly ? "截止日期：前一天及当天 9:00" : "报名截止前 1 天、1 小时及截止时"}<small>{deadline ? `${formatDate(deadline.at)}${deadline.dateOnly ? " · 具体截止时刻未公布" : ""}${!deadline.alarmTimes.length ? " · 预定提醒时刻已过，仅导入日期标记" : ""}` : "没有可用的未来截止时间，请核对原通知"}</small></span></label>
    <button className="secondary-button" disabled={saved ? !enabled : disabled} onClick={saved ? onExport : onSave}><CalendarArrowDown size={17} />{saved ? "下载这条信息的日历提醒" : "收藏并设置提醒"}</button>
    <p className="reminder-caution">下载后需导入日历，并检查提醒是否保留。取消收藏或修改选项不会删除手机日历里的旧提醒。</p>
  </section>;
}

export default function ActivityReminders({ events, items, now, compact = false, onOpen, onExport, onManage }: {
  events: ReminderEvent[]; items: Information[]; now: Date; compact?: boolean;
  onOpen: (item: Information) => void; onExport: () => void; onManage: () => void;
}) {
  const shown = compact ? events.slice(0, 3) : events;
  const itemById = new Map(items.map(item => [item.id, item]));
  return <section className={`activity-reminders${compact ? " compact" : ""}`} aria-label="我收藏的活动提醒">
    <div className="reminder-panel-top"><div><span className="reminder-icon"><Bell size={20} /></span><div><h2>收藏活动，提前提醒</h2><p>{items.length ? `${items.length} 条本机收藏 · ${events.length} 个可导入的报名提醒` : "给感兴趣的活动点一颗爱心，提前关注报名时间。"}</p></div></div>
      <button className="secondary-button" disabled={!events.length} onClick={onExport}><CalendarArrowDown size={17} />导出日历提醒</button></div>
    {shown.length > 0 && <div className="reminder-list">{shown.map(event => {
      const item = itemById.get(event.itemId);
      if (!item) return null;
      const urgent = !event.dateOnly && Date.parse(event.at) - now.getTime() <= 3600000;
      return <button className={`reminder-row${urgent ? " urgent" : ""}`} key={event.key} onClick={() => onOpen(item)}>
        <span className={`reminder-kind ${event.kind}`}>{event.kind === "start" ? "开始报名" : "报名截止"}</span>
        <span className="reminder-row-copy"><strong>{item.title}</strong><small>{formatDate(event.at)}{event.dateOnly && " · 仅公布日期"}{!event.alarmTimes.length && " · 提醒时刻已过，仅日期标记"}{urgent && " · 时间紧，建议立即前往官方渠道"}{item.capacity !== undefined && ` · ${item.capacity} 人名额`}{item.remainingSlots !== undefined && ` · 同步时剩 ${item.remainingSlots} 个`}</small></span><ChevronRight size={17} />
      </button>;
    })}</div>}
    {!events.length && items.length > 0 && <p className="reminder-empty">暂无可导入的未来提醒。信息可能已截止、已满员、时间未明确，或你已关闭提醒；可打开活动详情核对。</p>}
    {compact ? <button className="text-button reminder-manage" onClick={onManage}>管理收藏与提醒 <ChevronRight size={15} /></button> : <>
      <p className="reminder-caution">收藏后默认关注报名开始与截止，打开活动详情可调整。网页提醒随发布快照更新；名额是同步时的快照，先到先得活动建议提前查看 PU。</p>
      <details className="calendar-help"><summary>怎样让手机在关闭网站后提醒我？</summary>
        <ol><li>点击“导出日历提醒”，下载 .ics 日历文件。</li><li>在手机上打开文件，选择支持导入的日历；也可在日历的“导入”功能中选择该文件。</li><li>检查报名开始、截止事件和提醒时间，允许日历发送通知。部分日历会忽略文件内的提醒，需要手动补上。</li></ol>
        <p>导入成功后由手机日历提醒，无需一直打开网页。小米自带日历能否直接导入需在你的手机上确认；无法导入时，可使用支持 ICS 的日历客户端。可以参考 <a href="https://github.com/bitfireAT/icsx5" target="_blank" rel="noopener noreferrer">开源 ICSx⁵</a>。</p>
        <p>这是一次性导入。活动改期、取消或名额变化不会自动更新手机日历；重新核对并删除旧事件，再导入新版。文件只包含所选活动的公开信息。</p>
      </details>
    </>}
  </section>;
}
