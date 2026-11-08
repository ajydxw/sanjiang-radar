"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, ArrowRight, LockKeyhole, RefreshCw, Sparkles } from "lucide-react";
import "./class-assistant.css";
import { welcomeGreeting } from "@/lib/welcome";
import { HISTORY_MAX_TURNS, HISTORY_MAX_CHARS, HISTORY_ASSISTANT_MAX_CHARS, validateConversationHistory, type ConversationEntry } from "../../sources/class-assistant-conversation.mjs";

type Model = { key: string; label: string; available: boolean; reason?: string; inputPerMillion: number; cachedInputPerMillion: number; outputPerMillion: number; maxOutputTokens: number; budgetMicros: number | null; remainingMicros: number | null; estimatedMessages: number | null };
type Session = { contextOwner?: string; configured: boolean; authenticated: boolean; enabled: boolean; reason?: string; member?: { name: string; budgetMicros: number; spentMicros: number; reservedMicros: number; remainingMicros: number }; models: Model[]; estimatedInputTokens: number; estimatedOutputTokens: number };
type Message = { role: "user" | "assistant"; text: string; chargedMicros?: number };
class ApiError extends Error { constructor(message: string, public code: string) { super(message); } }
const enabled = process.env.NEXT_PUBLIC_CLASS_ASSISTANT_ENABLED === "1";
const base = process.env.NEXT_PUBLIC_BASE_PATH || "";
const externalUrl = (() => { try { const url = new URL(process.env.NEXT_PUBLIC_CLASS_ASSISTANT_URL || ""); return url.protocol === "https:" && !url.username && !url.password ? url.href : ""; } catch { return ""; } })();
const modelOrder = ["luna", "terra", "sol", "astra"];
const modelUses: Record<string, string> = {
  luna: "日常问答、概念解释、短文翻译和要点整理。例如：解释一个园林术语。",
  terra: "文字润色、表达改写和小段代码解释。例如：把一段说明改清楚。",
  sol: "多步骤解题、方案比较和代码问题分析。例如：比较两种设计思路。",
  astra: "较难推理和多约束分析。例如：分析预算、场地与维护的取舍。复杂问题再选，额度较少。",
};
const money = (micros: number) => `$${(micros / 1_000_000).toFixed(6)}`;

async function request<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(`/api/class-assistant/${path}`, { method: body ? "POST" : "GET", credentials: "same-origin", cache: "no-store", ...(body ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new ApiError(typeof data.error === "string" ? data.error : "服务暂时不可用，请稍后再试。", typeof data.code === "string" ? data.code : "");
  return data as T;
}

export default function ClassAssistant() {
  const [greeting, setGreeting] = useState("");
  const [session, setSession] = useState<Session | null>(null);
  const ownerRef = useRef<string | undefined>(undefined);
  const [loading, setLoading] = useState(enabled);
  const [busy, setBusy] = useState(false);
  const [accessCode, setAccessCode] = useState("");
  const [selected, setSelected] = useState("");
  const [question, setQuestion] = useState("");
  const [messages, setMessages] = useState<Message[]>([]);
  const [history, setHistory] = useState<ConversationEntry[]>([]);
  const [keepContext, setKeepContext] = useState(true);
  const [historyNotice, setHistoryNotice] = useState("");
  const [notice, setNotice] = useState("");
  const [originRejected, setOriginRejected] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const count = Array.from(question).length;

  async function refresh() {
    setLoading(true);
    try {
      const data = await request<Session>("session");
      setOriginRejected(false);
      const nextOwner = data.authenticated ? data.contextOwner : undefined;
      if (ownerRef.current && ownerRef.current !== nextOwner) {
        setMessages([]); setHistory([]); setQuestion(""); setHistoryNotice("");
        setNotice("账号已变化，请重新输入问题。");
      }
      ownerRef.current = nextOwner;
      setSession(data);
      setSelected(current => data.models?.some(model => model.key === current && model.available) ? current : modelOrder.find(key => data.models?.some(model => model.key === key && model.available)) || "");
      if (!data.authenticated) { setMessages([]); setHistory([]); setHistoryNotice(""); }
      setUncertain(false);
      return true;
    } catch (error) {
      const rejected = error instanceof ApiError && error.code === "origin_rejected";
      setOriginRejected(rejected);
      setNotice(rejected ? "当前地址无法访问助手服务，请从三江雷达正式网站进入生活助手。" : error instanceof ApiError ? error.message : "无法读取服务状态，请检查网络后刷新。");
      return false;
    }
    finally { setLoading(false); }
  }
  useEffect(() => { setGreeting(welcomeGreeting(new Date()).text); if (enabled) void refresh(); }, []);

  async function login(event: FormEvent) {
    event.preventDefault(); if (busy || !accessCode.trim()) return;
    setBusy(true); setNotice("");
    try { setHistory([]); setHistoryNotice(""); await request("login", { accessCode }); setAccessCode(""); await refresh(); }
    catch (error) { setNotice(error instanceof Error ? error.message : "登录失败，请稍后再试。"); }
    finally { setBusy(false); }
  }
  async function logout() {
    if (busy) return; setBusy(true); setNotice("");
    try { await request("logout", {}); ownerRef.current = undefined; setMessages([]); setHistory([]); setHistoryNotice(""); setQuestion(""); setAccessCode(""); setSelected(""); setSession(null); await refresh(); }
    catch { setNotice("退出状态未确认，请检查网络后重试。"); }
    finally { setBusy(false); }
  }
  async function send(event: FormEvent) {
    event.preventDefault();
    const message = question.trim();
    if (busy || uncertain || !session?.enabled || !message || count > 500 || !selected) return;
    const requestOwner = ownerRef.current;
    if (!requestOwner || requestOwner !== session.contextOwner) { setNotice("账号状态未确认，请刷新后重新输入。"); return; }
    if (!globalThis.crypto?.randomUUID) { setNotice("当前浏览器无法安全生成请求编号，请使用较新的浏览器。"); return; }
    setBusy(true); setNotice(""); setQuestion(""); setMessages(current => [...current, { role: "user", text: message }]);
    try {
      const result = await request<{ answer: string; status: string; chargedMicros: number; contextOwner?: string }>("chat", { modelKey: selected, message, requestId: crypto.randomUUID(), contextOwner: requestOwner, history: keepContext ? history : [] });
      if (result.contextOwner !== requestOwner || ownerRef.current !== requestOwner) {
        setMessages([]); setHistory([]); setQuestion(""); setHistoryNotice("");
        await refresh(); setNotice("账号已变化，请重新输入问题。"); return;
      }
      if (typeof result.answer === "string" && result.answer.trim() && result.status === "completed") {
        setMessages(current => [...current, { role: "assistant", text: result.answer, chargedMicros: result.chargedMicros }]);
        if (keepContext) {
          const pair: ConversationEntry[] = [{ role: "user", content: message }, { role: "assistant", content: result.answer }];
          const size = (entries: ConversationEntry[]) => entries.reduce((total, entry) => total + Array.from(entry.content).length, 0);
          let validPair = true;
          try { validateConversationHistory(pair); } catch { validPair = false; }
          if (!validPair || Array.from(result.answer).length > HISTORY_ASSISTANT_MAX_CHARS || size(pair) > HISTORY_MAX_CHARS) {
            setHistoryNotice("本轮内容超出上下文限制或含不支持的字符，未加入后续上下文；显示的回答不受影响。");
          } else {
            setHistory(current => {
              const next = [...current, ...pair];
              while (next.length > HISTORY_MAX_TURNS * 2 || size(next) > HISTORY_MAX_CHARS) next.splice(0, 2);
              return next;
            });
            setHistoryNotice("");
          }
        }
      }
      else setNotice("服务未返回回答，请刷新余额并检查服务状态。");
      await refresh();
    } catch (error) {
      if (error instanceof ApiError && error.code === "context_owner_changed") {
        setMessages([]); setHistory([]); setQuestion(""); setHistoryNotice("");
        await refresh(); setNotice("账号已变化，请重新输入问题。");
      } else if (error instanceof ApiError && !error.code.toLowerCase().includes("held")) {
        if (error.code === "authentication_required") { setHistory([]); setHistoryNotice(""); void refresh(); }
        setNotice(error.message);
      } else {
        setUncertain(true);
        setNotice(`${error instanceof ApiError ? `${error.message} 相关请求可能已产生费用。` : "本次请求结果未确认，可能已产生费用。"}不会自动重发；请先刷新余额，再决定是否发起新问题。`);
      }
    } finally { setBusy(false); }
  }

  return <main className="class-assistant">
    <div className="ca-wrap">
      <header className="ca-header"><a href={`${base}/`}><ArrowLeft size={17} /> 返回三江雷达</a><span><Sparkles size={16} /> CLASS ASSISTANT</span></header>
      <section className="ca-hero"><div><span className="ca-eyebrow">三江雷达 · 班级专属</span><h1>你的 AI 助手<span>，从一个问题开始。</span></h1><p>编程构建、写作、学习与方案分析，都可以从文字提问开始。</p></div><div className="ca-orbit" aria-hidden="true"><Sparkles size={32} /></div></section>
      {!enabled ? <section className="ca-card ca-empty"><LockKeyhole size={26} /><h2>{externalUrl ? "班级生活助手" : "班级生活助手准备中，等待 API 接入"}</h2><p>{externalUrl ? "班级助手正在小范围测试，仅已开放的账号可登录。" : "专属服务接入后，授权学生可使用学号登录。"}</p>{externalUrl && <a className="ca-primary" href={externalUrl}>进入生活助手 <ArrowRight size={16} /></a>}</section> : loading && !session ? <section className="ca-card ca-empty">正在读取服务状态…</section> : !session ? <section className="ca-card ca-empty"><p>{notice || "服务暂时无法连接。"}</p>{originRejected && <p><a href="https://ajydxw.github.io/sanjiang-radar/assistant/">进入三江雷达正式网站</a></p>}<button className="ca-secondary" onClick={() => void refresh()}>重新读取</button></section> : !session.configured ? <section className="ca-card ca-empty"><h2>班级生活助手暂不可用</h2><p>{session.reason || "服务正在准备中，请稍后再来。"}</p><button className="ca-secondary" onClick={() => void refresh()} disabled={loading}>刷新状态</button></section> : !session.authenticated || !session.member ? <section className="ca-card ca-login"><span className="ca-icon"><LockKeyhole size={21} /></span><h2>欢迎回来</h2><p>班级助手正在小范围测试，仅已开放的账号可登录。请输入 11 位学号。</p><p>登录时间、模型使用与费用会由班级管理员记录，用于额度管理。</p><form onSubmit={login}><label htmlFor="access-code">学号</label><input id="access-code" type="text" inputMode="numeric" pattern="[0-9]{11}" maxLength={11} autoComplete="off" value={accessCode} onChange={e => setAccessCode(e.target.value)} placeholder="请输入 11 位学号" required /><button className="ca-primary" disabled={busy}>{busy ? "正在登录…" : "进入助手"} <ArrowRight size={16} /></button></form>{notice && <p role="alert" className="ca-notice">{notice}</p>}</section> : <>
        <section className="ca-card ca-account"><div className="ca-account-head"><div><span className="ca-eyebrow">你的专属空间</span><h2>{greeting || "你好"}{session.member.name ? `，${session.member.name}` : ""}</h2><p className="ca-wish">愿你今天有所收获，也有片刻轻松。</p><p>四种模型共享同一份余额，最终按实际使用量计费。</p><p>登录时间、模型使用与费用会由班级管理员记录，用于额度管理。</p></div><div className="ca-actions"><button className="ca-secondary" onClick={() => { setNotice(""); void refresh(); }} disabled={loading || busy}><RefreshCw size={15} /> 刷新余额</button><button className="ca-link" onClick={() => void logout()} disabled={busy || loading}>退出</button></div></div><div className="ca-balance">{[["总额度", session.member.budgetMicros], ["已使用", session.member.spentMicros], ["预占中", session.member.reservedMicros], ["可用余额", session.member.remainingMicros]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{money(value as number)}</strong></div>)}</div><p className="ca-footnote">班级总额 75 USD / 35 人，约 2.142857 USD / 人；实际额度以账户显示为准。</p></section>
        <section className="ca-section ca-model-section" aria-labelledby="ca-model-title"><div className="ca-model-heading"><span className="ca-eyebrow">CHOOSE YOUR MODEL</span><h2 id="ca-model-title">选择适合你的模型</h2><p>当前仅支持文字问答。日常问题先用 Luna，更省额度。</p></div><div className="ca-models">{[...session.models].sort((a, b) => (modelOrder.indexOf(a.key) < 0 ? 99 : modelOrder.indexOf(a.key)) - (modelOrder.indexOf(b.key) < 0 ? 99 : modelOrder.indexOf(b.key))).map(model => <button key={model.key} type="button" disabled={!model.available || busy} aria-pressed={selected === model.key} className={`ca-model ${selected === model.key ? "is-selected" : ""}`} onClick={() => setSelected(model.key)}><span className="ca-model-banner" style={{ backgroundImage: `url("${base}/images/model-starfield.png")` }}><span className="ca-model-top"><span>{model.key === "luna" ? "日常问答推荐" : "文字问答"}</span><span>{model.available ? selected === model.key ? "已选择" : "可选择" : "暂不可用"}</span></span><strong>{model.label}</strong><span className="ca-model-use">{modelUses[model.key]}</span></span><span className="ca-model-body"><span className="ca-price-title">价格 <small>每百万 token</small></span><span className="ca-price-row"><span>输入</span><span>${model.inputPerMillion}</span></span><span className="ca-price-row"><span>缓存输入</span><span>${model.cachedInputPerMillion}</span></span><span className="ca-price-row"><span>输出</span><span>${model.outputPerMillion}</span></span><span className="ca-model-detail">{model.budgetMicros !== null && model.remainingMicros !== null && <span>专属上限 {money(model.budgetMicros)} · 可用 {money(model.remainingMicros)}（包含在总额度内）</span>}<span>{model.estimatedMessages === null ? "暂无余额估算" : `约 ${model.estimatedMessages} 次 · 按当前余额估算`}</span>{!model.available && <span>{model.reason || "暂不可用"}</span>}</span></span></button>)}</div><p className="ca-model-footnote">预计次数按每次 1,000 输入 token、500 输出 token 估算，不是固定条数；实际消耗取决于请求。 <a href="https://developers.openai.com/api/docs/guides/model-selection" target="_blank" rel="noopener noreferrer">官方模型说明</a></p></section>
        <section className="ca-card ca-chat"><div className="ca-heading"><div><span className="ca-eyebrow">ASK ANYTHING</span><h2>说说你的问题</h2></div><span className="ca-private">页面对话列表刷新后清空</span></div><div className="ca-context"><div className="ca-context-actions"><button type="button" className="ca-secondary" aria-pressed={keepContext} disabled={busy || uncertain} onClick={() => { setKeepContext(value => !value); setHistory([]); setHistoryNotice("已切换，上下文将从下一条开始积累。"); }}>保留上下文：{keepContext ? "开启" : "关闭"}</button><button type="button" className="ca-secondary" disabled={busy || uncertain} onClick={() => { setMessages([]); setHistory([]); setNotice(""); setHistoryNotice(""); }}>新对话</button></div><p>开启后会发送最近 6 轮（最多 6000 字符）的前文，增加额度消耗、可能变慢，也可能延续前文错误；刷新后清空。切换后从下一条开始积累上下文。</p>{historyNotice && <p role="status">{historyNotice}</p>}</div>{messages.length > 0 && <div className="ca-messages" aria-live="polite">{messages.map((message, index) => <div key={index} className={`ca-message ${message.role}`}><strong>{message.role === "user" ? "我" : "生活助手"}{message.role === "assistant" && typeof message.chargedMicros === "number" && ` · 本次费用 ${money(message.chargedMicros)}`}</strong><p>{message.text}</p></div>)}</div>}{!session.enabled && <p className="ca-notice" role="status">{session.reason || "付费发送暂未开放，你仍可查看余额和模型信息。"}</p>}<form onSubmit={send}><label htmlFor="question">你的问题</label><textarea id="question" value={question} onChange={e => setQuestion(e.target.value)} placeholder="比如：如何分析这段代码的问题，或规划一个小项目？" rows={4} /><div className="ca-compose"><span className={count > 500 ? "ca-error" : ""}>{count} / 500 字符</span><button className="ca-primary" disabled={busy || uncertain || !session.enabled || !selected || !question.trim() || count > 500}>{busy ? "正在处理…" : "发送问题"} <ArrowRight size={16} /></button></div></form>{notice && <p role="alert" className="ca-notice">{notice}</p>}{originRejected && <p><a href="https://ajydxw.github.io/sanjiang-radar/assistant/">进入三江雷达正式网站</a></p>}</section>
      </>}
    </div>
  </main>;
}
