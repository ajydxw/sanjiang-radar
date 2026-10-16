"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, LogOut, RefreshCw, ShieldCheck, Trash2 } from "lucide-react";
import { filterAdminQuestions, parseAdminQuestion, parseAdminQuestions, parseAdminSession, safeAdminLoginLocation, safeAdminSourceUrl, type AdminFilter, type AdminQuestion, type AdminSession } from "@/lib/admin-console";
import type { Information } from "@/lib/information";

const labels = { pending: "待回复", answered: "已回复", declined: "超出问答范围", "needs-info": "需要补充信息", unconfirmed: "暂无法确认" };
const filters: { value: AdminFilter; label: string }[] = [{ value: "all", label: "全部" }, { value: "pending", label: "待回复" }, { value: "ready", label: "待审核" }, { value: "processed", label: "已处理" }];
const time = (value: string) => new Date(value).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Shanghai" });
class RequestError extends Error { constructor(public status: number) { super("管理服务请求失败"); } }
async function request(path: string, options: RequestInit = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(path, { ...options, credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal });
    if (!response.ok) throw new RequestError(response.status);
    if (response.status === 204) return null;
    try { return await response.json() as unknown; } catch { throw new Error("无法读取管理服务数据"); }
  } finally { clearTimeout(timer); }
}
function Sources({ sources }: { sources: AdminQuestion["sources"] }) {
  return sources.length ? <ul className="admin-sources">{sources.map((source, index) => <li key={`${source.url}-${index}`}><a href={source.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{source.title}</a></li>)}</ul> : <p>没有可核实的公开来源。</p>;
}

export default function AdminConsole({ onBack, information = [] }: { onBack: () => void; information?: Information[] }) {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [items, setItems] = useState<AdminQuestion[]>([]);
  const [filter, setFilter] = useState<AdminFilter>("all");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [secureLogin, setSecureLogin] = useState(false);
  const [busy, setBusy] = useState(true);
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const lock = useRef(false);
  const mounted = useRef(false);
  const csrf = useRef<string | null>(null);
  const passwordInput = useRef<HTMLInputElement>(null);
  const deleteConfirmButton = useRef<HTMLButtonElement>(null);
  const deleteOrigin = useRef<HTMLButtonElement | null>(null);

  function acceptSession(next: AdminSession) {
    if (!mounted.current) return;
    csrf.current = next.csrfToken;
    setSession(next);
    if (!next.authenticated) { setItems([]); setLoaded(false); setConfirmDelete(null); }
  }
  function showError(error: unknown) {
    if (!mounted.current) return;
    const status = error instanceof RequestError ? error.status : 0;
    if (status === 401) {
      csrf.current = null; setSession({ configured: true, authenticated: false, username: null, csrfToken: null }); setItems([]); setLoaded(false); setConfirmDelete(null);
      setNotice("登录未成功或已过期，请重新输入管理密码。");
      setTimeout(() => passwordInput.current?.focus(), 0);
    } else if (status === 404) setNotice("这个地址没有管理后台，请使用电脑提供的公网地址。");
    else if (status === 429) setNotice("操作较频繁，请稍后再试。");
    else if (status === 403) setNotice("登录状态需要更新，请退出后重新登录。");
    else setNotice("连接暂不可用，操作未能确认；已保留之前读取的问题。请稍后刷新核对。");
  }
  async function loadQuestions() {
    const parsed = parseAdminQuestions(await request("/api/admin/questions"));
    if (!parsed) throw new Error("问题数据格式异常");
    if (!mounted.current) return;
    if (parsed.invalid) {
      setNotice("部分问题数据异常，已保留之前读取的有效列表。请稍后刷新。");
      return false;
    }
    setItems(parsed.items); setLoaded(true);
    setConfirmDelete(null);
    return true;
  }
  async function run(action: () => Promise<void>) {
    if (lock.current) return;
    lock.current = true; setBusy(true);
    try { await action(); } catch (error) { showError(error); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  }
  useEffect(() => {
    mounted.current = true;
    setSecureLogin(safeAdminLoginLocation(window.location.href));
    void run(async () => {
      const next = parseAdminSession(await request("/api/admin/session"));
      if (!next) throw new Error("登录数据格式异常");
      acceptSession(next);
      if (next.authenticated) await loadQuestions();
    });
    return () => { mounted.current = false; csrf.current = null; };
    // The initial session check owns the request lock, including Strict Mode's second effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { if (confirmDelete) deleteConfirmButton.current?.focus(); }, [confirmDelete]);

  async function login(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (lock.current || !username.trim() || !password) return;
    if (!safeAdminLoginLocation(window.location.href)) { setPassword(""); setNotice("请使用 HTTPS 公网地址登录，当前地址不能安全传送密码。"); return; }
    const submittedPassword = password;
    setPassword(""); setNotice("");
    await run(async () => {
      const next = parseAdminSession(await request("/api/admin/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: username.trim(), password: submittedPassword }) }));
      if (!next?.authenticated) throw new Error("登录数据格式异常");
      acceptSession(next);
      await loadQuestions();
    });
  }
  async function refresh() {
    setNotice("");
    await run(async () => {
      const next = parseAdminSession(await request("/api/admin/session"));
      if (!next) throw new Error("登录数据格式异常");
      acceptSession(next);
      if (next.authenticated) await loadQuestions();
    });
  }
  function mutationOptions(method: string, body?: unknown): RequestInit {
    if (!csrf.current) throw new RequestError(401);
    return { method, headers: { "Content-Type": "application/json", "X-CSRF-Token": csrf.current }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
  }
  async function logout() {
    await run(async () => {
      await request("/api/admin/logout", mutationOptions("POST", {}));
      acceptSession({ configured: true, authenticated: false, username: null, csrfToken: null }); setNotice("已退出管理账号。");
    });
  }
  async function remove(item: AdminQuestion) {
    await run(async () => {
      await request(`/api/admin/questions/${encodeURIComponent(item.id)}`, mutationOptions("DELETE"));
      if (!mounted.current) return;
      setItems(previous => previous.filter(entry => entry.id !== item.id)); setConfirmDelete(null); setNotice("问题已删除。");
    });
  }
  async function publish(item: AdminQuestion) {
    if (!item.draft) return;
    await run(async () => {
      try {
        const updated = parseAdminQuestion(await request(`/api/admin/questions/${encodeURIComponent(item.id)}/publish`, mutationOptions("POST", { draftId: item.draft!.draftId })));
        if (!updated || updated.id !== item.id || updated.status === "pending" || updated.draft) throw new Error("发布结果格式异常");
        if (!mounted.current) return;
        setItems(previous => previous.map(entry => entry.id === item.id ? updated : entry)); setNotice("你已确认并发布这条答复。");
      } catch (error) {
        if (error instanceof RequestError && error.status === 409) {
          const refreshed = await loadQuestions();
          if (mounted.current && refreshed) setNotice("草稿已变化，已刷新最新内容。请重新核对后发布。");
        } else throw error;
      }
    });
  }
  function cancelDelete() { setConfirmDelete(null); setTimeout(() => deleteOrigin.current?.focus(), 0); }
  const shown = filterAdminQuestions(items, filter);
  const counts = { pending: filterAdminQuestions(items, "pending").length, ready: filterAdminQuestions(items, "ready").length, processed: filterAdminQuestions(items, "processed").length };

  return <section className="admin-console" aria-busy={busy}>
    <div className="admin-topbar"><button type="button" className="admin-button" onClick={onBack}><ArrowLeft size={18} aria-hidden="true" />返回雷达</button></div>
    <header className="admin-header"><ShieldCheck size={28} aria-hidden="true" /><div><h1>问答管理</h1><p>仅供站长管理生活助手的问题与答复。</p></div></header>
    {notice && <p className="admin-notice" role="status" aria-live="polite">{notice}</p>}
    {!session && <section className="admin-panel"><p>{busy ? "正在检查登录状态…" : "暂时无法读取登录状态。"}</p><button type="button" className="admin-button" disabled={busy} onClick={() => void refresh()}>重试</button></section>}
    {session && !session.configured && <section className="admin-panel"><h2>先设置管理密码</h2><p>先在这台电脑设置管理密码，再用手机登录。</p><p>在电脑本机设置页设置管理密码，并保持电脑和网站服务运行；手机打开电脑提供的 HTTPS 公网地址。</p><button type="button" className="admin-button" disabled={busy} onClick={() => void refresh()}>检查是否已设置</button></section>}
    {session?.configured && !session.authenticated && <form className="admin-panel admin-login" onSubmit={event => void login(event)}>
      <h2>站长登录</h2>
      <label className="admin-field">账号<input name="username" value={username} onChange={event => setUsername(event.target.value)} autoComplete="username" required maxLength={40} disabled={busy || !secureLogin} /></label>
      <label className="admin-field">管理密码<input ref={passwordInput} name="password" type="password" autoComplete="current-password" value={password} onChange={event => setPassword(event.target.value)} required disabled={busy || !secureLogin} /></label>
      <button className="admin-button admin-button-primary" type="submit" disabled={busy || !secureLogin || !username.trim() || !password}>{busy ? "正在登录…" : "登录"}</button>
      {!secureLogin && <p className="admin-notice" role="status">请使用 HTTPS 公网地址登录，当前地址不能安全传送密码。</p>}
      <p>仅限站长本人使用。密码提交后会从输入框清除。</p>
    </form>}
    {session?.authenticated && <>
      <section className="admin-panel"><div className="admin-actions"><span>站长 · {session.username}</span><button className="admin-button" type="button" disabled={busy} onClick={() => void refresh()}><RefreshCw size={16} aria-hidden="true" />{busy ? "处理中…" : "刷新"}</button><button className="admin-button" type="button" disabled={busy} onClick={() => void logout()}><LogOut size={16} aria-hidden="true" />退出</button></div><div className="admin-stats" aria-label="问题统计">{(["pending", "ready", "processed"] as const).map(key => <div className="admin-stat" key={key}><strong>{loaded ? counts[key] : "—"}</strong><span>{key === "pending" ? "待回复" : key === "ready" ? "待审核" : "已处理"}</span></div>)}</div><p>当前由主聊天触发整理，定时处理尚未启用。</p></section>
      <aside className="admin-panel admin-help"><p>需要新草稿时，在电脑的 Codex 主聊天说：“处理生活助手的待回复问题，先生成草稿”。保持电脑、Codex 和网站服务运行；生成后，在这里刷新、核对来源，再确认发布。</p><p>网页不会自动生成答复。模型复核不等于学校确认。</p></aside>
      <div className="admin-filters" role="group" aria-label="筛选问题">{filters.map(entry => <button type="button" className="admin-button admin-filter" aria-pressed={filter === entry.value} key={entry.value} onClick={() => setFilter(entry.value)}>{entry.label}</button>)}</div>
      <section className="admin-list" aria-label="问题列表">{!shown.length && <p className="admin-panel admin-empty">{!loaded ? "问题列表尚未读取，请刷新。" : busy ? "正在刷新问题…" : "这个分类下还没有问题。"}</p>}{shown.map(item => <article className="admin-panel admin-question" key={item.id}>
        <div className="admin-question-meta"><span>{item.draft ? "待审核" : labels[item.status]}</span><time dateTime={item.createdAt}>{time(item.createdAt)}</time></div><h2>{item.question}</h2>
        {item.contextId && <p className="admin-question-meta">{(() => { const related = information.find(entry => entry.id === item.contextId); const url = related && safeAdminSourceUrl(related.sourcePortal); return related ? <><span>关于：{related.title}</span>{url && <a href={url} target="_blank" rel="noopener noreferrer">查看通知原文</a>}</> : "关联通知暂不在当前信息列表中"; })()}</p>}
        {item.answer && <section className="admin-answer"><h3>已发布答复 · {labels[item.status]}</h3><p>{item.answer}</p><Sources sources={item.sources} />{item.answeredAt && <p className="admin-question-meta">发布于 {time(item.answeredAt)}</p>}</section>}
        {item.draft && <section className="admin-draft"><h3>待审核答复 · {labels[item.draft.status]}</h3><p>GPT 6.1 Sol 高思考已整理，模型复核不等于学校确认。</p><p>{item.draft.answer}</p><Sources sources={item.draft.sources} /><p className="admin-question-meta">草稿复核于 {time(item.draft.reviewedAt)}</p><p>核对答复与来源后，点击下方按钮代表站长确认，并向提问者发布。</p><button className="admin-button admin-button-primary" type="button" disabled={busy} onClick={() => void publish(item)}>我已核对，确认发布</button></section>}
        {confirmDelete === item.id ? <div className="admin-confirm" onKeyDown={event => { if (event.key === "Escape" && !busy) cancelDelete(); }}><p>删除这条问题及其答复？删除后不可撤回。</p><div className="admin-actions"><button ref={deleteConfirmButton} type="button" className="admin-button admin-button-danger" disabled={busy} onClick={() => void remove(item)}>确认永久删除</button><button type="button" className="admin-button" disabled={busy} onClick={cancelDelete}>取消</button></div></div> : <button type="button" className="admin-button" aria-label={`删除问题：${item.question}`} disabled={busy} onClick={event => { deleteOrigin.current = event.currentTarget; setConfirmDelete(item.id); }}><Trash2 size={16} aria-hidden="true" />删除问题</button>}
      </article>)}</section>
    </>}
  </section>;
}

