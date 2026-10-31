"use client";

import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { ArrowRight, Check, ChevronRight, CircleHelp, Clock3, Compass, ExternalLink, GraduationCap, Heart, HeartHandshake, Radar, Search, SlidersHorizontal, Sparkles, UserRound, X } from "lucide-react";
import { CATEGORIES, COLLEGES, chinaDateKey, deadlineLabel, deadlineTime, eligibilityLabel, formatDate, informationTime, isExamInformation, isOpen, matchesCollege, registrationStatus, rewardLabel, type Category, type Information, type SchoolFeed } from "@/lib/information";
import { assertPublicFeed } from '../../sources/public-feed.mjs';
import { useVisitHistory } from './use-visit-history';
import ActivityReminders, { ReminderSettings } from './activity-reminders';
import LikeButton from './like-button';
import MajorSelect from './major-select';
import WelcomeScreen from './welcome-screen';
import { useIdentity } from './identity-confirmation';
import { WELCOME_STORAGE_KEY, shouldShowWelcome } from '@/lib/welcome';
import { changeProfileCollege } from '@/lib/college-majors';
import { REMINDER_STORAGE_KEY, readReminderPreferences, getReminderOptions, buildReminderEvents, createReminderCalendar, type ReminderPreferences, type ReminderOptions } from '@/lib/activity-reminders';

type Tab = "radar" | "discover" | "saved" | "profile";
type Profile = { college: string; major: string; interests: Category[] };
type Filters = { freshman: boolean; reward: boolean; soon: boolean; college: boolean; available: boolean; exam: boolean; new: boolean };
type SavedState = { favorites: string[]; profile: Profile };
const DEFAULT_PROFILE: Profile = { college: "暂不选择", major: "", interests: [] };
const STORAGE_KEY = "sanjiang-radar-demo-v1";
const FEED_PATHS = ["/data/sanjiang-web.json", "/data/pu.json", "/data/wechat.json", "/data/competitions.json", "/data/exams.json"];
const TABS = [
  { key: "radar" as Tab, label: "今日雷达", icon: Radar },
  { key: "discover" as Tab, label: "发现", icon: Compass },
  { key: "saved" as Tab, label: "收藏", icon: Heart },
  { key: "profile" as Tab, label: "我的", icon: UserRound },
];

function CategoryIcon({ category, size = 20 }: { category: Category; size?: number }) {
  const Icon = category === "竞赛" ? Sparkles : category === "志愿活动" ? HeartHandshake : category === "学校通知" ? GraduationCap : category === "校园资讯" ? Compass : Radar;
  return <Icon size={size} aria-hidden="true" />;
}

const prefersReducedMotion = () => typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/** A light tick: vibration where supported, the iOS 18+ switch-control tick elsewhere (technique from tijnjh/ios-haptics). */
function haptic() {
  try {
    if (typeof navigator.vibrate === "function") { navigator.vibrate(8); return; }
    const label = document.createElement("label");
    label.ariaHidden = "true";
    label.style.display = "none";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.setAttribute("switch", "");
    label.appendChild(input);
    document.head.appendChild(label);
    label.click();
    label.remove();
  } catch { /* feedback is a nicety, never a requirement */ }
}

/** Jelly release: squash, overshoot, settle — wider than tall, then taller than wide, with roughly kept volume. */
function jelly(element: HTMLElement) {
  if (prefersReducedMotion() || typeof element.animate !== "function") return;
  element.animate([
    { scale: "1.1 0.86" }, { scale: "0.93 1.08", offset: .28 }, { scale: "1.04 0.97", offset: .5 },
    { scale: "0.985 1.012", offset: .72 }, { scale: "1 1" },
  ], { duration: 560, easing: "cubic-bezier(.25,.7,.35,1)" });
}

function MobileNav({ tab, count, onNavigate, onPreview, onRelease }: { tab: Tab; count: number; onNavigate: (tab: Tab) => void; onPreview: (tab: Tab, offset: number) => void; onRelease: (tab: Tab | null, dragged: boolean) => void }) {
  const [dragPosition, setDragPosition] = useState<number | null>(null);
  const gesture = useRef<{ id: number; button: HTMLButtonElement; x: number; y: number; index: number; width: number; position: number; moved: boolean; cancelled: boolean; preview: number; lastX: number; lastT: number; touch: boolean } | null>(null);
  const nav = useRef<HTMLElement>(null);
  const settle = useRef(0);
  const suppressClick = useRef(false);
  const activeIndex = TABS.findIndex(item => item.key === tab);
  const position = dragPosition ?? Math.max(0, activeIndex);
  const preview = dragPosition === null ? activeIndex : Math.round(position);

  // The droplet stretches with finger speed and relaxes once the finger slows.
  function stretch(value: number) {
    nav.current?.style.setProperty("--nav-stretch", value.toFixed(3));
    window.clearTimeout(settle.current);
    if (value !== 1) settle.current = window.setTimeout(() => nav.current?.style.setProperty("--nav-stretch", "1"), 110);
  }

  function beginGesture(event: ReactPointerEvent<HTMLElement>) {
    if (!event.isPrimary || event.button !== 0 || gesture.current) return;
    const button = (event.target as Element).closest("button");
    const buttons = Array.from(event.currentTarget.querySelectorAll("button"));
    const index = button ? buttons.indexOf(button) : -1;
    const width = buttons[0]?.getBoundingClientRect().width;
    if (!button || index < 0 || !width) return;
    suppressClick.current = false;
    button.setPointerCapture(event.pointerId);
    gesture.current = { id: event.pointerId, button, x: event.clientX, y: event.clientY, index, width, position: index, moved: false, cancelled: false, preview: index, lastX: event.clientX, lastT: event.timeStamp, touch: event.pointerType !== "mouse" };
    stretch(1);
    setDragPosition(index);
  }

  function moveGesture(event: ReactPointerEvent<HTMLElement>) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId || current.cancelled) return;
    const dx = event.clientX - current.x;
    const dy = event.clientY - current.y;
    if (!current.moved && Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) {
      current.cancelled = true;
      setDragPosition(null);
      return;
    }
    if (!current.moved && Math.abs(dx) < 6) return;
    current.moved = true;
    current.position = Math.max(0, Math.min(TABS.length - 1, current.index + dx / current.width));
    const elapsed = Math.max(8, event.timeStamp - current.lastT);
    const speed = Math.abs(event.clientX - current.lastX) / elapsed; // px per ms
    current.lastX = event.clientX; current.lastT = event.timeStamp;
    stretch(Math.min(1.32, 1 + speed * .16));
    const next = Math.round(current.position);
    if (next !== current.preview) {
      current.preview = next;
      if (current.touch) haptic();
    }
    // The page above follows: the nearest tab is shown, nudged by the finger's remaining offset.
    onPreview(TABS[next].key, current.position - next);
    setDragPosition(current.position);
  }

  function finishGesture(event: ReactPointerEvent<HTMLElement>, commit: boolean) {
    const current = gesture.current;
    if (!current || current.id !== event.pointerId) return;
    gesture.current = null;
    stretch(1);
    setDragPosition(null);
    const bounds = event.currentTarget.getBoundingClientRect();
    const inside = event.clientY >= bounds.top - 20 && event.clientY <= bounds.bottom + 20;
    // Confirm on release; compatibility clicks may be delayed or omitted after a swipe.
    suppressClick.current = true;
    if (current.button.hasPointerCapture(event.pointerId)) current.button.releasePointerCapture(event.pointerId);
    onRelease(commit && inside && !current.cancelled ? TABS[Math.round(current.position)].key : null, current.moved && !current.cancelled);
  }

  return <nav ref={nav} className={`mobile-nav${dragPosition !== null ? " is-pressed" : ""}${gesture.current?.moved && !gesture.current.cancelled ? " is-dragging" : ""}`} aria-label="手机主导航"
    onPointerDown={beginGesture} onPointerMove={moveGesture} onPointerUp={event => finishGesture(event, true)}
    onPointerCancel={event => finishGesture(event, false)} onLostPointerCapture={event => finishGesture(event, false)}
    onContextMenu={event => event.preventDefault()}
    onClickCapture={event => { if (suppressClick.current && event.detail !== 0) { event.preventDefault(); event.stopPropagation(); } suppressClick.current = false; }}>
    <span className="mobile-nav-indicator" aria-hidden="true" style={{ translate: `${position * 100}% 0`, opacity: preview < 0 ? 0 : 1 }} />
    {TABS.map(({ key, label, icon: Icon }, index) => <button type="button" key={key} className={preview === index ? "nav-active" : ""} aria-current={tab === key ? "page" : undefined} onClick={() => onNavigate(key)}><Icon size={21} strokeWidth={preview === index ? 2.2 : 1.7} /><span>{label}</span>{key === "saved" && count > 0 && <i>{count}</i>}</button>)}
  </nav>;
}

function DetailDialog({ item, saved, disabled, now, reminderOptions, onReminderChange, onExport, onClose, onSave }: { item: Information; saved: boolean; disabled: boolean; now: Date; reminderOptions: ReminderOptions; onReminderChange: (options: ReminderOptions) => void; onExport: () => void; onClose: () => void; onSave: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    document.body.style.overflow = "hidden";
    return () => { document.body.style.overflow = ""; node?.close(); };
  }, []);
  const facts = [
    ["谁可以参加", item.colleges.length ? `${item.colleges.join("、")}；${eligibilityLabel(item.freshmanAllowed)}` : `适用学院尚未核验；${eligibilityLabel(item.freshmanAllowed)}`],
    ...(item.eligibleYears?.length ? [["活动年级", item.eligibleYears.map(year => `${year}级`).join("、")]] : []),
    ...(item.activityType === "考务" ? [] : [["报名开始", formatDate(item.registrationStart)], ["报名 / 办理截止", formatDate(item.registrationDeadline)]]),
    ...(item.registrationNote ? [[item.sourceType === "exam" ? "办理提示" : "报名提示", item.registrationNote]] : []),
    [item.sourceType === "exam" ? "考试 / 办理时间" : "活动时间", `${formatDate(item.eventStart)}${item.eventEnd && item.eventEnd !== item.eventStart ? ` 至 ${formatDate(item.eventEnd)}` : ""}`],
    [item.sourceType === "exam" ? "考试地点" : "活动地点", item.location ?? "未明确，请查看原通知"],
    ["奖励与认定", item.rewardNote],
    [item.sourceType === "exam" ? "如何办理" : "怎么报名", item.registrationMethod],
    ...(item.capacity !== undefined ? [["活动名额", `容量 ${item.capacity} 人 · 已报名 ${item.registeredCount ?? "未明确"} 人 · 剩余 ${item.remainingSlots ?? "未明确"} 个（同步时）`]] : []),
  ];
  return <dialog ref={dialog} className="detail-dialog" aria-labelledby="detail-title" onCancel={onClose} onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
    <div className="detail-top"><span><CategoryIcon category={item.category} /> {item.category}</span><button className="icon-button" autoFocus aria-label="关闭详情" onClick={onClose}><X size={22} /></button></div>
    <div className="detail-content">
      <span className="eyebrow">信息详情 / {item.demo ? "示例内容" : item.verification}</span><h2 id="detail-title">{item.title}</h2>
      <div className="detail-badges"><span className="tag">{eligibilityLabel(item.freshmanAllowed)}</span>{item.reward && <span className="tag reward">{rewardLabel(item.reward)}</span>}</div>
      <p className="detail-summary">{item.description || item.summary}</p>
      <div className="facts">{facts.map(([label, value]) => <div className="fact" key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</div>
      {item.eligibilityEvidence && <div className="evidence-block"><strong>资格判断的原文依据</strong><p>{item.eligibilityEvidence}</p></div>}
      {!!item.dateEvidence?.length && <div className="evidence-block"><strong>原文中的时间说明 · 尚待核验</strong>{item.dateEvidence.map((line, index) => <p key={index}>{line}</p>)}</div>}
      {!!item.attachments?.length && <div className="evidence-block"><strong>官方附件</strong>{item.attachments.map(attachment => <p key={attachment.url}><a href={attachment.url} target="_blank" rel="noopener noreferrer">{attachment.title || "查看附件"} <ExternalLink size={13} /></a></p>)}</div>}
      <div className="source-note"><CircleHelp size={19} /><p><strong>{item.demo ? "这是一条用于体验的模拟信息" : item.sourceType === "pu" ? item.detailRead ? "已同步 PU 官方活动详情" : "已同步活动列表，详情暂未读取" : item.detailRead === false ? "已发现官网通知，正文暂不可读取" : "已收集原文，关键条件尚待核验"}</strong><br />{item.demo ? "来源名称、日期与奖励均用于展示，不是实际通知。" : item.sourceType === "pu" ? "年级、学院限制按 PU 活动详情展示；名额可能变化，报名与最终奖励认定以 PU 为准。" : item.sourceType === "exam" ? "省级考试安排按官方原文整理；三江学院本期的大一资格和校内要求仍需核对学校通知。" : "摘要为原文节选。截止日期、奖励和资格以官方通知为准；未明确的条件保留为未知。"}</p></div>
      <p className="detail-provenance">{item.verification} · {item.publishedAt ? `发布时间：${formatDate(item.publishedAt)}` : `首次收集：${formatDate(item.firstSeenAt)}`}{item.fetchedAt && <> · 同步时间：{formatDate(item.fetchedAt)}</>}</p>
      <ReminderSettings item={item} saved={saved} now={now} options={reminderOptions} onChange={onReminderChange} onSave={onSave} onExport={onExport} disabled={disabled} />
    </div>
    <div className="detail-actions"><LikeButton title={item.title} saved={saved} disabled={disabled} onToggle={onSave} /><a className="primary-button" href={item.sourcePortal} target="_blank" rel="noopener noreferrer">{item.sourceType === "pu" ? "前往 PU 查看" : "查看官方原文"} <ExternalLink size={16} /></a></div>
  </dialog>;
}

export default function RadarApp() {
  const [feed, setFeed] = useState<SchoolFeed | null>(null);
  const [feedError, setFeedError] = useState(false);
  const feedChunks = useRef<Record<string, SchoolFeed>>({});
  const visits = useVisitHistory(feedChunks.current);
  const [now, setNow] = useState(new Date());
  const information = (feed?.items ?? []).filter(item => item.freshmanAllowed !== "excluded");
  const [tab, setTab] = useState<Tab>("radar");
  // While the phone nav is dragged, the page shows the tab under the finger; the address changes on release.
  const [previewTab, setPreviewTab] = useState<Tab | null>(null);
  const view = previewTab ?? tab;
  const mainShell = useRef<HTMLElement>(null);
  const previewing = useRef<{ shown: Tab; scroll: number } | null>(null);
  const pendingScroll = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingScroll.current === null) return;
    window.scrollTo({ top: pendingScroll.current, behavior: "instant" });
    pendingScroll.current = null;
  }, [view]);
  const [profile, setProfile] = useState<Profile>(DEFAULT_PROFILE);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [reminderPreferences, setReminderPreferences] = useState<ReminderPreferences>({});
  const [loaded, setLoaded] = useState(false);
  const [storageError, setStorageError] = useState(false);
  const [category, setCategory] = useState<Category | "全部">("全部");
  const [filters, setFilters] = useState<Filters>({ freshman: false, reward: false, soon: false, college: true, available: true, exam: false, new: false });
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState("latest");
  const [selected, setSelected] = useState<Information | null>(null);
  const [toast, setToast] = useState("");
  const [welcomeOpen, setWelcomeOpen] = useState(false);
  const identitySession = useIdentity();
  useEffect(() => {
    let seen = false;
    try { seen = sessionStorage.getItem(WELCOME_STORAGE_KEY) === 'seen'; } catch { /* Entry still works with storage disabled. */ }
    setWelcomeOpen(shouldShowWelcome(window.location.hash, seen));
  }, []);
  function continueFromWelcome() {
    try { sessionStorage.setItem(WELCOME_STORAGE_KEY, 'seen'); } catch { /* No storage is required for visitor access. */ }
    setWelcomeOpen(false);
  }

  useEffect(() => {
    let active = true;
    const update = async () => {
      try {
        const results = await Promise.allSettled(FEED_PATHS.map(async path => {
          const response = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH || ''}${path}`, { cache: 'no-store' });
          if (!response.ok) throw new Error('来源数据未准备好');
          const next: unknown = await response.json();
          assertPublicFeed(next);
          return { path, next };
        }));
        if (!active) return;
        const nextChunks = { ...feedChunks.current };
        for (const result of results) if (result.status === "fulfilled") nextChunks[result.value.path] = result.value.next;
        feedChunks.current = nextChunks;
        const chunks = Object.values(feedChunks.current);
        if (chunks.length) setFeed({ schemaVersion: 1,
          generatedAt: chunks.map(chunk => chunk.generatedAt).sort().at(-1) || "",
          items: [...new Map(chunks.flatMap(chunk => chunk.items).map(item => [item.id, item])).values()],
          sources: chunks.flatMap(chunk => chunk.sources),
        });
        setFeedError(results.some(result => result.status === "rejected"));
      } catch { if (active) setFeedError(true); }
    };
    void update();
    const timer = window.setInterval(() => { setNow(new Date()); void update(); }, 5 * 60 * 1000);
    const clock = window.setInterval(() => setNow(new Date()), 60 * 1000);
    const resume = () => { if (document.visibilityState === "visible") { setNow(new Date()); void update(); } };
    document.addEventListener("visibilitychange", resume);
    return () => { active = false; window.clearInterval(timer); window.clearInterval(clock); document.removeEventListener("visibilitychange", resume); };
  }, []);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const saved = JSON.parse(raw) as Partial<SavedState>;
        if (Array.isArray(saved.favorites)) setFavorites(saved.favorites.filter((id): id is string => typeof id === "string"));
        if (saved.profile) setProfile({ college: typeof saved.profile.college === "string" && saved.profile.college.trim() ? saved.profile.college.trim().slice(0, 80) : "暂不选择", major: typeof saved.profile.major === "string" ? saved.profile.major.slice(0, 80) : "", interests: Array.isArray(saved.profile.interests) ? saved.profile.interests.filter(c => CATEGORIES.includes(c)) : [] });
      }
    } catch { setStorageError(true); }
    try { setReminderPreferences(readReminderPreferences(localStorage.getItem(REMINDER_STORAGE_KEY))); } catch { setStorageError(true); }
    setLoaded(true);
  }, []);
  useEffect(() => {
    if (loaded) { try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ favorites, profile })); } catch { setStorageError(true); } }
  }, [favorites, profile, loaded]);
  useEffect(() => {
    if (loaded) { try { localStorage.setItem(REMINDER_STORAGE_KEY, JSON.stringify({ version: 1, items: reminderPreferences })); } catch { setStorageError(true); } }
  }, [reminderPreferences, loaded]);
  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 2400);
    return () => window.clearTimeout(timeout);
  }, [toast]);
  useEffect(() => {
    const fromHash = () => {
      const value = window.location.hash.slice(1);
      if (TABS.some(t => t.key === value)) setTab(value as Tab);
    };
    fromHash(); window.addEventListener("hashchange", fromHash);
    return () => window.removeEventListener("hashchange", fromHash);
  }, []);

  function navigate(next: Tab) { setTab(next); window.location.hash = next; window.scrollTo({ top: 0, behavior: "smooth" }); }
  function slidePage(from: Tab, to: Tab) {
    const main = mainShell.current;
    const step = TABS.findIndex(item => item.key === to) - TABS.findIndex(item => item.key === from);
    if (!main || !step || prefersReducedMotion() || typeof main.animate !== "function") return;
    main.animate([{ opacity: .3, transform: `translateX(${Math.sign(step) * 30}px)` }, { opacity: 1, transform: "none" }], { duration: 300, easing: "cubic-bezier(.2,.8,.2,1)" });
  }
  function previewFromNav(next: Tab, offset: number) {
    const main = mainShell.current;
    const current = previewing.current ?? (previewing.current = { shown: tab, scroll: window.scrollY });
    if (main && !prefersReducedMotion()) main.style.translate = `${(-offset * 26).toFixed(1)}px 0`;
    if (next === current.shown) return;
    slidePage(current.shown, next);
    current.shown = next;
    setPreviewTab(next === tab ? null : next);
    pendingScroll.current = next === tab ? current.scroll : 0;
  }
  function releaseNav(target: Tab | null, dragged: boolean) {
    const main = mainShell.current;
    const current = previewing.current;
    previewing.current = null;
    if (main?.style.translate) {
      const from = main.style.translate;
      main.style.translate = "";
      if (!prefersReducedMotion() && typeof main.animate === "function") main.animate([{ translate: from }, { translate: "0 0" }], { duration: 420, easing: "cubic-bezier(.3,1.45,.45,1)" });
    }
    setPreviewTab(null);
    if (target && !(dragged && target === tab)) { navigate(target); return; }
    // Cancelled, or dragged back home: return to the page and spot the visitor left.
    if (current && current.shown !== tab) { slidePage(current.shown, tab); pendingScroll.current = current.scroll; }
  }
  function toggleFavorite(id: string) {
    if (!loaded) return;
    const saved = !favorites.includes(id);
    setFavorites(previous => saved ? [...new Set([...previous, id])] : previous.filter(value => value !== id));
    setToast(saved ? "已加入本机收藏，可在收藏页导出日历提醒" : "已取消收藏；已导入的手机日历提醒需另行删除");
  }
  function updateReminder(id: string, options: ReminderOptions) {
    setReminderPreferences(previous => ({ ...previous, [id]: options }));
    setToast("提醒选项已更新，手机日历需重新导入");
  }
  function exportReminders(items: Information[]) {
    const events = buildReminderEvents(items, reminderPreferences, new Date());
    if (!events.length) { setToast("暂无可导入的未来提醒，请核对报名时间"); return; }
    try {
      const calendar = createReminderCalendar(events, new Date());
      const url = URL.createObjectURL(new Blob([calendar], { type: "text/calendar;charset=utf-8" }));
      const link = document.createElement("a");
      link.href = url; link.download = "三江雷达-报名提醒.ics";
      document.body.appendChild(link); link.click(); link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      setToast("日历文件已生成，请导入手机日历并检查提醒");
    } catch { setToast("日历文件暂时无法生成，请稍后重试"); }
  }
  function discoverWith(next: Partial<Filters>, nextCategory: Category | "全部" = "全部") {
    setQuery(""); setCategory(nextCategory); setFilters({ freshman: false, reward: false, soon: false, college: true, available: true, exam: false, new: false, ...next }); setSort(next.soon ? "deadline" : "latest"); navigate("discover");
  }

  const relevant = information.filter(item => (new Date(informationTime(item)).getTime() >= now.getTime() - 90 * 86400000 || item.sourceType === "competition" && (item.registrationDeadline && deadlineTime(item.registrationDeadline) > now.getTime() || item.eventStart && Date.parse(item.eventStart) > now.getTime())) && item.freshmanAllowed !== "excluded" && matchesCollege(item, profile.college) && isOpen(item, now) && (profile.interests.length === 0 || profile.interests.includes(item.category) || item.importance === "high"));
  const today = relevant.filter(item => chinaDateKey(new Date(informationTime(item))) === chinaDateKey(now) && item.importance !== "secondary");
  const newItems = information.filter(item => visits.newIds.has(item.id) && item.importance !== "secondary" && matchesCollege(item, profile.college));
  const visitNote = visits.history?.previousVisitAt ? `上次访问：${formatDate(visits.history.previousVisitAt)}。新收集不等于新发布，请核对原文日期。` : "首次访问会记住现有信息，之后新收集的通知会显示在这里。";
  const soon = relevant.filter(item => item.registrationDeadline && deadlineTime(item.registrationDeadline) - now.getTime() <= 7 * 86400000).sort((a, b) => (a.registrationDeadline ?? "").localeCompare(b.registrationDeadline ?? ""));
  const rewarded = relevant.filter(item => item.reward);
  const creditCount = rewarded.filter(item => item.reward?.kind === "PU积分" || item.reward?.kind === "素质学分").length;
  const featured = relevant.filter(item => item.importance !== "secondary" && !isExamInformation(item)).sort((a, b) => Number(b.freshmanAllowed === "allowed") - Number(a.freshmanAllowed === "allowed") || Number(b.importance === "high") - Number(a.importance === "high") || informationTime(b).localeCompare(informationTime(a))).slice(0, 4);
  const exams = relevant.filter(isExamInformation).sort((a, b) => informationTime(b).localeCompare(informationTime(a)));
  const competitions = relevant.filter(item => item.category === "竞赛").sort((a, b) => Number(b.freshmanAllowed === "allowed") - Number(a.freshmanAllowed === "allowed") || informationTime(b).localeCompare(informationTime(a)));
  const puActivities = relevant.filter(item => item.sourceType === "pu");
  const guides = relevant.filter(item => item.category === "校园资讯");
  const puCount = information.filter(item => item.sourceType === "pu").length;
  const favoriteItems = information.filter(item => favorites.includes(item.id));
  const openFavorites = favoriteItems.filter(item => isOpen(item, now)).sort((a, b) => informationTime(b).localeCompare(informationTime(a)));
  const reminderEvents = buildReminderEvents(favoriteItems, reminderPreferences, now);
  const listed = information.filter(item => {
    if (view === "saved") return favorites.includes(item.id);
    if (category !== "全部" && item.category !== category) return false;
    if (filters.new && (!visits.newIds.has(item.id) || item.importance === "secondary")) return false;
    if (filters.exam && !isExamInformation(item)) return false;
    if (filters.freshman && item.freshmanAllowed !== "allowed") return false;
    if (filters.reward && !item.reward) return false;
    if (filters.available && !isOpen(item, now)) return false;
    if (filters.college && !matchesCollege(item, profile.college)) return false;
    if (filters.soon && (!item.registrationDeadline || !isOpen(item, now) || deadlineTime(item.registrationDeadline) - now.getTime() > 7 * 86400000)) return false;
    return `${item.title} ${item.summary} ${item.source}`.toLowerCase().includes(query.trim().toLowerCase());
  }).sort((a, b) => sort === "deadline" ? (a.registrationDeadline ?? "9999").localeCompare(b.registrationDeadline ?? "9999") : informationTime(b).localeCompare(informationTime(a)));

  function card(item: Information, compact = false) {
    const saved = favorites.includes(item.id);
    const urgent = item.registrationDeadline && isOpen(item, now) && deadlineTime(item.registrationDeadline) - now.getTime() <= 2 * 86400000;
    return <article className={`event-card ${compact ? "compact" : ""}`} key={item.id}>
      <div className="card-top"><span className={`category-mark category-${item.sourceType}`}><CategoryIcon category={item.category} size={16} />{item.category}</span><LikeButton title={item.title} saved={saved} disabled={!loaded} onToggle={() => toggleFavorite(item.id)} /></div>
      <button className="card-main" onClick={() => setSelected(item)}><h3>{item.title}</h3>{!compact && <p>{item.summary}</p>}</button>
      <p className="card-published">{item.publishedAt ? "发布于" : "首次收集于"} {formatDate(informationTime(item))}{new Date(informationTime(item)).getTime() < now.getTime() - 90 * 86400000 && " · 较早的信息，请核对是否仍有效"}</p>
      <div className="card-tags">{visits.newIds.has(item.id) && <span className="tag new-information">新收集</span>}<span className={`tag ${item.freshmanAllowed === "unknown" ? "unknown" : ""}`}>{eligibilityLabel(item.freshmanAllowed)}</span>{registrationStatus(item, now) === "upcoming" && <span className="tag upcoming">报名尚未开始</span>}{item.colleges.length > 0 && <span className="tag">学院有限制</span>}{item.reward && <span className="tag reward">{rewardLabel(item.reward)}</span>}{item.capacity !== undefined && item.capacity <= 30 && <span className="tag limited-slots">限 {item.capacity} 人</span>}{item.remainingSlots === 0 ? <span className="tag">名额已满（同步时）</span> : item.remainingSlots !== undefined && <span className="tag limited-slots">剩 {item.remainingSlots} 个（同步时）</span>}{item.sourceAvailable === false && <span className="tag unknown">PU 列表已变更，请核对</span>}</div>
      <div className="card-footer"><span className={urgent ? "deadline urgent" : "deadline"}><Clock3 size={14} />{item.sourceType === "exam" && !item.registrationDeadline ? !isOpen(item, now) ? "本期考试已结束" : item.activityType === "考务" ? "准考证与考试安排" : "查看考试安排" : deadlineLabel(item.registrationDeadline, now)}</span><span className="source-label">{item.source}</span><button className="card-arrow" aria-label={`查看详情：${item.title}`} onClick={() => setSelected(item)}><ArrowRight size={17} /></button></div>
    </article>;
  }

  function sectionHeading(title: string, subtitle: string, action: () => void) { return <div className="section-heading"><div><h2>{title}</h2><p>{subtitle}</p></div><button className="text-button" onClick={action}>查看全部 <ArrowRight size={15} /></button></div>; }

  return <>
    {welcomeOpen && <WelcomeScreen onContinue={continueFromWelcome} identitySession={identitySession} />}
    <header className="site-header"><div className="header-inner"><button className="brand" onClick={() => navigate("radar")} aria-label="三江雷达首页"><span className="brand-icon"><Radar size={25} strokeWidth={1.7} /></span><span>三江雷达<small>SANJIANG RADAR</small></span></button>
      <nav className="desktop-nav" aria-label="主导航">{TABS.map(({ key, label, icon: Icon }) => <button key={key} className={tab === key ? "nav-active" : ""} aria-current={tab === key ? "page" : undefined} onClick={() => navigate(key)}><Icon size={17} />{label}{key === "saved" && favorites.length > 0 && <span className="nav-count">{favorites.length}</span>}</button>)}</nav>
      <div className="header-actions"><span className="demo-pill"><span />校园信息试用版</span><button className="avatar-button" aria-label="设置我的学院" onClick={() => navigate("profile")}><UserRound size={20} /></button></div>
    </div></header>
    <main className="main-shell" ref={mainShell}>
      <div className="demo-notice" role="status"><CircleHelp size={15} /><span>{feed ? `最近发布快照：${formatDate(feed.generatedAt)}${feed.sources.some(source => source.state !== "ok") ? " · 部分来源待补齐" : ""}` : feedError ? "校园信息暂时无法读取，请稍后刷新。" : "正在读取校园信息…"}{feed && feedError && " 部分数据暂时无法读取，保留上次成功的数据。"}</span>{feed && <button className="text-button" onClick={() => navigate("profile")}>查看来源 <ChevronRight size={14} /></button>}</div>
      {(storageError || visits.storageError) && <p className="storage-warning" role="status">浏览器暂时无法完整保存记录，收藏、提醒选项、资料或新增标记可能仅在本次浏览中有效。</p>}
      {view === "radar" && <>
        <section className="hero">
          <div className="hero-copy"><div className="eyebrow"><span className="live-dot" />三江学院 · 2026 级新生</div><h1>今天，先看<span>这几件事。</span></h1><p>报名、考试、校园活动，与你有关的先看。</p><div className="hero-summary"><span>今日新增 <strong>{feed ? today.length : "—"}</strong></span><span>7 天内截止 <strong>{feed ? soon.length : "—"}</strong></span><span>有积分学分 <strong>{feed ? creditCount : "—"}</strong></span></div></div>
          <div className="radar-art" aria-hidden="true"><div className="radar-grid"><div className="radar-circle circle-one" /><div className="radar-circle circle-two" /><div className="radar-circle circle-three" /><div className="radar-cross horizontal" /><div className="radar-cross vertical" /><div className="radar-sweep" /><div className="radar-center" /><span className="radar-pin pin-one" /><span className="radar-pin pin-two" /><span className="radar-pin pin-three" /></div><span className="radar-label label-one"><Sparkles size={14} />新的机会</span><span className="radar-label label-two"><Clock3 size={14} />及时关注</span><span className="radar-coordinate">32° N / SANJIANG</span></div>
        </section>
        <section className="visit-panel" aria-label="上次来看之后新增"><div><h2>上次来看之后新增 <strong>{visits.history ? newItems.length : "—"}</strong></h2><p>{visitNote}</p><small>当前浏览器记录 · 离开 30 分钟后算一次新访问，短时间刷新保留标记</small></div><button className="text-button" onClick={() => discoverWith({ new: true, available: false })}>查看新增 <ArrowRight size={15} /></button></section>
        <ActivityReminders compact events={reminderEvents} items={favoriteItems} now={now} onOpen={setSelected} onExport={() => exportReminders(favoriteItems)} onManage={() => navigate("saved")} />
        <section className="community-likes" aria-label="我的未截止收藏"><div className="section-heading"><div><h2><Heart size={19} /> 我的收藏</h2><p>这里展示尚未截止的个人收藏 · 仅保存在当前浏览器</p></div><button className="text-button" onClick={() => navigate("saved")}>查看全部 <ArrowRight size={15} /></button></div>{openFavorites.length ? <div className="cards-grid">{openFavorites.slice(0, 2).map(item => card(item))}</div> : <p className="community-likes-empty">还没有未截止的收藏，点击卡片上的爱心收藏感兴趣的信息。</p>}</section>
        <section className="stats-grid" aria-label="校园快捷入口">
          <button onClick={() => discoverWith({ exam: true })}><span className="stat-icon blue"><GraduationCap size={21} /></span><span><strong>考试办事</strong><em>报名与准考证</em></span><ChevronRight size={16} /></button>
          <button onClick={() => discoverWith({ college: false }, "PU活动")}><span className="stat-icon green"><Radar size={20} /></span><span><strong>PU 活动</strong><em>活动与积分</em></span><ChevronRight size={16} /></button>
          <button onClick={() => discoverWith({}, "竞赛")}><span className="stat-icon orange"><Sparkles size={20} /></span><span><strong>竞赛比赛</strong><em>寻找新机会</em></span><ChevronRight size={16} /></button>
          <button onClick={() => discoverWith({ college: false }, "校园资讯")}><span className="stat-icon blue"><Compass size={20} /></span><span><strong>校园生活</strong><em>服务与攻略</em></span><ChevronRight size={16} /></button>
        </section>
        <section className="deadline-panel focus-panel" aria-label="近期截止事项"><div className="panel-title"><span className="orange"><Clock3 size={19} /></span><h2>近期截止，先别错过</h2><span className="small-badge">7 天内</span></div><div className="deadline-list">{soon.slice(0, 2).map(item => <button key={item.id} onClick={() => setSelected(item)}><span className="timeline-dot" /><span><small>{deadlineLabel(item.registrationDeadline, now)}</small><strong>{item.title}</strong><em>{eligibilityLabel(item.freshmanAllowed)} · {formatDate(item.registrationDeadline)}</em></span><ChevronRight size={15} /></button>)}{feed && soon.length === 0 && <p className="quiet-text">暂无明确的近期截止事项，考试安排与校园活动可以继续查看。</p>}{!feed && <p className="quiet-text">{feedError ? "暂时无法读取，请稍后刷新。" : "正在整理近期截止事项…"}</p>}</div><button className="panel-more" onClick={() => discoverWith({ soon: true })}>查看全部近期截止 <ArrowRight size={15} /></button></section>
        <div className="dashboard-grid"><div className="feed-column">
          <section className="exam-section">{sectionHeading("考试与办理", "报名、准考证与考试安排；大一资格以校内通知为准", () => discoverWith({ exam: true }))}<div className="cards-grid">{exams.slice(0, 2).map(item => card(item))}</div>{feed && exams.length === 0 && <div className="empty-state">暂未收集到符合条件的考试通知，普通话等当期安排仍需补齐。</div>}</section>
          <section className="section-gap">{sectionHeading("值得留意的校园信息", "优先显示已明确面向大一的信息，未知资格保留标注", () => discoverWith({}))}<div className="cards-grid">{featured.map(item => card(item))}</div>{feed && featured.length === 0 && <div className="empty-state">暂时没有匹配的信息，试试修改学院或关注类别。</div>}</section>
          <section className="section-gap">{sectionHeading("PU 校园活动", `已收集 ${puCount} 条 · 优先展示与你相关的活动`, () => discoverWith({ college: false }, "PU活动"))}<div className="cards-grid">{puActivities.slice(0, 4).map(item => card(item))}</div>{puActivities.length === 0 && <div className="empty-state"><Radar size={28} /><h3>暂时没有符合当前条件的 PU 活动</h3><p>年级、学院或报名时间可能有限制，可以前往发现页查看全部活动。</p><button className="text-button" onClick={() => discoverWith({ college: false }, "PU活动")}>查看全部 PU 活动 <ArrowRight size={16} /></button></div>}</section>
          {guides.length > 0 && <section className="section-gap">{sectionHeading("校园生活指南", "校园服务与实用攻略，随用随查", () => discoverWith({ college: false }, "校园资讯"))}<div className="cards-grid">{guides.slice(0, 4).map(item => card(item))}</div></section>}
          <section className="section-gap">{sectionHeading("大一可以关注的竞赛", "学校通知与赛事官方信息，报名门槛和校内安排请查看详情", () => discoverWith({}, "竞赛"))}<div className="cards-grid">{competitions.slice(0, 4).map(item => card(item))}</div>{competitions.length === 0 && <div className="empty-state"><Sparkles size={28} /><h3>暂时没有匹配的竞赛</h3><p>你可以在发现页关闭学院筛选，了解更多比赛。</p><button className="text-button" onClick={() => discoverWith({ college: false }, "竞赛")}>看看全部竞赛 <ArrowRight size={16} /></button></div>}</section>
        </div><aside className="side-column">
          <section className="reward-panel"><div className="panel-title"><span className="green"><GraduationCap size={20} /></span><h2>参与，也有收获</h2></div><p className="panel-subtitle">积分、学分、志愿时长分别看</p>{rewarded.slice(0, 3).map(item => <button className="reward-row" key={item.id} onClick={() => setSelected(item)}><span className="reward-number">{item.reward?.value}<small>{item.reward?.kind}</small></span><strong>{item.title}</strong><ChevronRight size={15} /></button>)}<button className="panel-more" onClick={() => discoverWith({ reward: true })}>查看有奖励的活动 <ArrowRight size={15} /></button></section>
          <section className="profile-tip"><span className="profile-tip-icon"><SlidersHorizontal size={21} /></span><h3>让雷达更懂你</h3><p>{profile.college === "暂不选择" ? "选择学院和关注类别，让与你相关的信息先出现。" : `已按${profile.college}筛选。你可以随时调整关注类别。`}</p><button className="text-button" onClick={() => navigate("profile")}>调整我的资料 <ArrowRight size={15} /></button></section>
        </aside></div>
      </>}
      {(view === "discover" || view === "saved") && <>
        <div className="page-heading"><span className="eyebrow">{view === "saved" ? "MY FAVORITES" : "EXPLORE CAMPUS"}</span><h1>{view === "saved" ? "把感兴趣的信息，留给自己。" : "找到你的下一个机会。"}</h1><p>{view === "saved" ? "收藏仅保存在当前浏览器，刷新后仍会保留；不同浏览器和设备之间互不共享。已截止的信息也会保留在这里。" : "按类别、资格和截止时间筛选，少一点翻找，多一点收获。"}</p></div>
        {view === "saved" && <ActivityReminders events={reminderEvents} items={favoriteItems} now={now} onOpen={setSelected} onExport={() => exportReminders(favoriteItems)} onManage={() => navigate("saved")} />}
        {view === "discover" && <div className="discovery-controls"><label className="search-field"><Search size={19} /><input type="search" aria-label="搜索校园信息" placeholder="搜索活动、竞赛或通知…" value={query} onChange={e => setQuery(e.target.value)} />{query && <button aria-label="清空搜索" onClick={() => setQuery("")}><X size={17} /></button>}</label>
          <div className="category-tabs" aria-label="信息分类">{["全部", ...CATEGORIES].map(value => <button key={value} className={category === value ? "selected" : ""} aria-pressed={category === value} onClick={event => { jelly(event.currentTarget); setCategory(value as Category | "全部"); }}>{value}</button>)}</div>
          <div className="filter-bar"><span className="filter-label"><SlidersHorizontal size={15} />筛选</span>{([{ key: "new", label: "上次来看之后新增" }, { key: "available", label: "仅未截止" }, { key: "exam", label: "考试办事" }, { key: "freshman", label: "大一可参加" }, { key: "reward", label: "有积分 / 学分 / 时长" }, { key: "soon", label: "7 天内截止" }, { key: "college", label: "与我的学院相关" }] as const).map(({ key, label }) => <button key={key} aria-pressed={filters[key]} className={`filter-chip ${filters[key] ? "active" : ""}`} onClick={event => { jelly(event.currentTarget); setFilters(previous => ({ ...previous, [key]: !previous[key] })); }}>{filters[key] && <Check size={13} />}{label}</button>)}</div></div>}
        {view === "discover" && filters.new && <p className="visit-filter-note">{visitNote} 记录保存在当前浏览器，短时间刷新保留标记。</p>}
        <div className="results-header"><p>找到 <strong>{listed.length}</strong> 条{view === "saved" ? "个人收藏" : "校园信息"}{view === "discover" && profile.college !== "暂不选择" && filters.college && <span> · {profile.college}</span>}</p><label className="sort-field"><span>排序</span><select aria-label="信息排序" value={sort} onChange={e => setSort(e.target.value)}><option value="latest">最新信息</option><option value="deadline">最早截止</option></select></label></div>
        <div className="results-grid">{listed.map(item => card(item))}</div>{listed.length === 0 && <div className="empty-state large"><Heart size={36} /><h2>{view === "saved" ? "还没有收藏，先去发现看看" : "暂时没有匹配的信息"}</h2><p>{view === "saved" ? "点击卡片右上角的爱心，把感兴趣的信息加入本机收藏。" : "试试更换关键词，或减少筛选条件。"}</p><button className="primary-button" onClick={() => discoverWith({ freshman: false, college: false })}>{view === "saved" ? "去发现" : "清除筛选"}<ArrowRight size={17} /></button></div>}
      </>}
      {view === "profile" && <>
        <div className="page-heading"><span className="eyebrow">MY RADAR</span><h1>你的校园，你的关注。</h1><p>完善简单资料，让首页优先展示与你相关的机会。</p></div>
        <div className="profile-layout"><section className="settings-panel"><div className="panel-title"><UserRound size={20} /><h2>我的资料</h2><span className="small-badge">2026 级</span></div><label className="form-field">学院<select aria-label="学院" value={profile.college} onChange={e => setProfile(previous => changeProfileCollege(previous, e.target.value))}>{!COLLEGES.includes(profile.college) && <option value={profile.college}>{profile.college}（原资料）</option>}{COLLEGES.map(college => <option key={college}>{college}</option>)}</select></label><MajorSelect key={profile.college} college={profile.college} major={profile.major} onChange={major => setProfile(previous => ({ ...previous, major }))} /><div className="form-field">关注类别 <span>不选择时展示全部相关类别</span><div className="interest-options">{CATEGORIES.map(value => <button key={value} aria-pressed={profile.interests.includes(value)} className={profile.interests.includes(value) ? "selected" : ""} onClick={() => setProfile(previous => ({ ...previous, interests: previous.interests.includes(value) ? previous.interests.filter(c => c !== value) : [...previous.interests, value] }))}><CategoryIcon category={value} size={16} />{value}{profile.interests.includes(value) && <Check size={14} />}</button>)}</div></div><p className="settings-note"><Check size={15} />{storageError ? "本次浏览有效，暂时无法持久保存" : "设置自动保存 · 重要通知仍会优先展示"}</p><button className="primary-button" onClick={() => navigate("radar")}>看看我的雷达 <ArrowRight size={17} /></button><button className="welcome-profile-entry" type="button" onClick={() => setWelcomeOpen(true)}><Radar size={15} /> 欢迎页与身份确认入口</button></section>
          <div className="profile-side"><section className="source-panel"><div className="panel-title"><Radar size={20} /><h2>信息来源</h2></div><p>以下为最近发布快照中的来源状态；站长采集并上传后，页面数据才会更新。</p>{feed?.sources.map(source => <div className={`source-row state-${source.state}`} key={source.id}><span><a href={source.url} target="_blank" rel="noopener noreferrer">{source.name}</a>{source.lastSuccessAt && <small className="source-time">最近成功：{formatDate(source.lastSuccessAt)}</small>}{source.lastAttemptAt && source.lastAttemptAt !== source.lastSuccessAt && <small className="source-time">最近尝试：{formatDate(source.lastAttemptAt)}</small>}{source.error && <small className="source-time">{source.error}</small>}{source.note && <small className="source-time">{source.note}</small>}</span><small>{source.state === "ok" ? `已同步 ${source.count} 条` : source.state === "partial" ? `${source.count} 条 · 部分同步` : source.state === "failed" && source.count ? `${source.count} 条 · 更新失败` : source.state === "pending" ? "待配置" : "暂未同步"}</small></div>)}{[{ name: "竞赛聚合平台", stage: "后续补充" }, { name: "易班", stage: "待安排" }].map(source => <div className="source-row state-planned" key={source.name}><span>{source.name}</span><small>{source.stage}</small></div>)}</section><section className="notification-note"><Clock3 size={20} /><h3>更新与提醒</h3><p>本站展示最近发布的信息快照。站长采集并上传后更新，静态页面不会自行采集官网或 PU 数据；页面每 5 分钟检查是否有已上传的新快照。收藏仅保存在当前浏览器，可导出日历、导入手机并检查提醒，关闭网页后由日历提示。日历是一次性快照，改期或取消需手动更新；名额不保证实时。</p></section></div>
        </div>
      </>}
      <footer className="site-footer"><span><Radar size={15} /> 三江雷达 <span className="footer-dot">·</span> 让有用的信息，及时被看见</span><small>独立学生项目 · 校园信息试用版</small></footer>
    </main>
    <MobileNav tab={tab} count={favorites.length} onNavigate={next => { slidePage(tab, next); navigate(next); }} onPreview={previewFromNav} onRelease={releaseNav} />
    {selected && <DetailDialog item={information.find(item => item.id === selected.id) ?? selected} saved={favorites.includes(selected.id)} disabled={!loaded} now={now} reminderOptions={getReminderOptions(reminderPreferences, selected.id)} onReminderChange={options => updateReminder(selected.id, options)} onExport={() => exportReminders([information.find(item => item.id === selected.id) ?? selected])} onClose={() => setSelected(null)} onSave={() => toggleFavorite(selected.id)} />}
    {toast && <div className="toast" role="status"><Check size={17} />{toast}</div>}
  </>;
}


