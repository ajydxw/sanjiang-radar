"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight, BookOpen, Check, ChevronDown, Coffee, MessageCircle, NotebookPen, RefreshCw, ShieldCheck, Trash2, Wallet, X } from "lucide-react";
import type { Information } from "@/lib/information";
import { POLITICAL_TOPIC_MESSAGE, politicalTopicReason } from '../../sources/question-policy.mjs';
import { appendAssistantQuestion, ASSISTANT_STORAGE_KEY, HISTORY_LIMIT, normalizeQuestion, parseAssistantHistory, parseAssistantResponse, parseAssistantStatus, parseAssistantSubmission, QUESTION_LIMIT, questionLength, safeAssistantSourceUrl, serializeAssistantHistory, type AssistantQuestion, type AssistantResponse } from "@/lib/life-assistant";

const guides = [
  { title: "把一周安排得从容一点", topic: "学习安排", icon: BookOpen, question: "刚上大一，怎样安排每周学习和休息？", text: "先把课程和已确认的截止时间放进日历，再给复习、吃饭和休息留出固定时段。每天挑一两件最重要的事，周末用十分钟调整下一周；计划留一点空余，比排满更容易坚持。" },
  { title: "和室友聊清楚小习惯", topic: "宿舍沟通", icon: Coffee, question: "室友作息不同，可以怎样沟通？", text: "找大家都不赶时间的时候，具体说清自己的困扰和希望，比如晚上戴耳机、开灯前问一句。一起约定安静时段、卫生分工和公共物品用法；分歧持续时，可向辅导员或宿舍管理人员咨询。" },
  { title: "给日常开销留一点余地", topic: "日常预算", icon: Wallet, question: "大一生活费怎么做简单预算？", text: "先记录一周实际开销，再把每月预算分为必要支出、灵活支出和应急余量。必要支出先安排，灵活支出设一个自己能做到的上限。预算按个人情况调整，不需要和同学比较，也不用在这里填写账户信息。" },
  { title: "先分清积分、学分和时长", topic: "PU 积分", icon: ShieldCheck, question: "PU积分、素质学分和志愿时长有什么区别？", text: "PU 积分、素质学分、学时和志愿时长是不同的记录项目，不能默认互相替代。活动是否计入、如何认定或换算，要看本校当期规则和活动原文；页面没写清楚时，向发布单位确认，不用往年标准推算。" },
];

type Props = { context: Information | null; information: Information[]; onBack: () => void; onClearContext: () => void };

function sourceUrl(item: Information): string | undefined {
  return safeAssistantSourceUrl(item.sourcePortal) ?? undefined;
}

async function assistantRequest(path: string, options: RequestInit = {}, timeout = 6000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, { ...options, credentials: "same-origin", cache: "no-store", redirect: "error", signal: controller.signal });
    let data: unknown = null;
    try { data = await response.json(); } catch { /* A response without readable JSON cannot grant access or publish an answer. */ }
    return { ok: response.ok, status: response.status, data };
  } finally { clearTimeout(timer); }
}

const responseLabels: Record<AssistantResponse["status"], string> = { pending: "等待整理回复", answered: "已整理回复", declined: "超出问答范围", "needs-info": "需要补充信息", unconfirmed: "暂无法确认" };

export default function LifeAssistant({ context, information, onBack, onClearContext }: Props) {
  const [questions, setQuestions] = useState<AssistantQuestion[]>([]);
  const [input, setInput] = useState("");
  const [ready, setReady] = useState(false);
  const [notice, setNotice] = useState("");
  const [storageWarning, setStorageWarning] = useState("");
  const [acceptsQuestions, setAcceptsQuestions] = useState<boolean | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [responses, setResponses] = useState<Record<string, AssistantResponse>>({});
  const [recordErrors, setRecordErrors] = useState<Record<string, string>>({});
  const historyRef = useRef<AssistantQuestion[]>([]);
  const submittingRef = useRef(false);
  const refreshingRef = useRef(false);
  const mountedRef = useRef(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const currentContext = context ? information.find(item => item.id === context.id) ?? null : null;
  const length = questionLength(input.trim());

  useEffect(() => {
    mountedRef.current = true;
    let loadedQuestions: AssistantQuestion[] = [];
    try {
      const loaded = parseAssistantHistory(localStorage.getItem(ASSISTANT_STORAGE_KEY));
      loadedQuestions = loaded.questions;
      historyRef.current = loaded.questions;
      setQuestions(loaded.questions);
      if (loaded.invalid) setStorageWarning("部分本机记录格式异常，已跳过无效内容。有效记录仍可使用。");
    } catch {
      setStorageWarning("浏览器暂时无法读取本机记录。你仍可提问，但刷新可能丢失已提交问题的读取权限。");
    }
    setReady(true);
    void refreshAnswers(loadedQuestions, false);
    return () => { mountedRef.current = false; };
  }, []);

  async function refreshAnswers(records = historyRef.current, showNotice = true) {
    if (refreshingRef.current) return;
    refreshingRef.current = true;
    setRefreshing(true);
    try {
      const [available, results] = await Promise.all([
        assistantRequest("/api/assistant/status").then(result => result.ok && parseAssistantStatus(result.data)).catch(() => false),
        Promise.all(records.filter(entry => entry.accessToken).map(async entry => {
          try {
            const result = await assistantRequest(`/api/assistant/questions/${encodeURIComponent(entry.id)}`, { headers: { Authorization: `Bearer ${entry.accessToken}` } });
            const response = result.ok ? parseAssistantResponse(result.data) : null;
            if (!response || response.id !== entry.id || response.question !== entry.question || response.contextId !== entry.contextId) {
              return { id: entry.id, error: result.status === 401 || result.status === 404 ? "暂时无法读取这条问题，读取权限可能已失效。" : "这条答复暂未能读取，请稍后刷新。" };
            }
            return { id: entry.id, response };
          } catch { return { id: entry.id, error: "连接暂不可用，答复状态未更新。请稍后刷新。" }; }
        })),
      ]);
      if (!mountedRef.current) return;
      setAcceptsQuestions(available);
      setResponses(previous => {
        const next = { ...previous };
        for (const result of results) if (result.response) next[result.id] = result.response;
        return next;
      });
      setRecordErrors(Object.fromEntries(results.filter(result => result.error).map(result => [result.id, result.error!])));
      if (showNotice) setNotice(results.some(result => result.error) ? "部分问题未能刷新，已保留之前读取的答复。" : records.some(entry => entry.accessToken) ? "已刷新你的问题；未回复的问题仍需等待站长整理。" : available ? "提交服务可用，可以提交普通问题。" : "提交服务暂不可用，新问题会先保存在本机。");
    } finally {
      refreshingRef.current = false;
      if (mountedRef.current) setRefreshing(false);
    }
  }

  function persistQuestions(next: AssistantQuestion[]) {
    historyRef.current = next;
    setQuestions(next);
    try {
      localStorage.setItem(ASSISTANT_STORAGE_KEY, serializeAssistantHistory(next));
      setStorageWarning("");
    } catch {
      setStorageWarning("浏览器无法保存记录。草稿仅在本次页面保留；已提交问题的私有读取凭据也无法保存，离开或刷新可能丢失答复读取权限。");
    }
  }

  async function saveQuestion(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready || acceptsQuestions === null || submittingRef.current) return;
    const question = normalizeQuestion(input);
    if (!question || historyRef.current.length >= HISTORY_LIMIT) {
      setNotice(historyRef.current.length >= HISTORY_LIMIT ? "已达到 20 条记录，请清空本机记录后再提交。" : "请输入 1–500 字的普通问题。");
      return;
    }
    if (politicalTopicReason(question)) { setNotice(POLITICAL_TOPIC_MESSAGE); return; }
    submittingRef.current = true;
    setSubmitting(true);
    setNotice("");
    const contextId = currentContext?.id ?? null;
    try {
      let deliveryUnknown = false;
      let message = "提交服务暂不可用，问题仅保存为本机草稿，未送达站长或 AI。";
      if (acceptsQuestions) {
        try {
          const result = await assistantRequest("/api/assistant/questions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ question, contextId }) }, 10000);
          if (result.status === 422) { setNotice(POLITICAL_TOPIC_MESSAGE); return; }
          const submitted = result.status === 201 ? parseAssistantSubmission(result.data) : null;
          if (submitted && submitted.question.question === question && submitted.question.contextId === contextId) {
            persistQuestions([submitted.question, ...historyRef.current]);
            setResponses(previous => ({ ...previous, [submitted.question.id]: submitted.response }));
            setInput("");
            setNotice("问题已送达，等待整理回复。稍后可在这里刷新答复。");
            return;
          }
          deliveryUnknown = result.status === 201 || result.status >= 500 || result.ok;
          message = deliveryUnknown ? "无法确认问题是否送达，已保存为本机草稿。请勿立即重复提交，以免产生重复问题。" : result.status === 429 ? "提交太频繁，问题先保存为本机草稿，尚未送达。请稍后再试。" : "提交未成功，问题先保存为本机草稿，尚未送达。请稍后检查服务再提问。";
        } catch {
          deliveryUnknown = true;
          message = "连接中断或等待超时，无法确认问题是否送达。已保存本机草稿，请勿立即重复提交。";
        }
      }
      const id = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const next = appendAssistantQuestion(historyRef.current, question, contextId, id, new Date());
      if (next) {
        if (deliveryUnknown) next[0].delivery = "unconfirmed";
        persistQuestions(next);
        setInput("");
      }
      setNotice(message);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
      inputRef.current?.focus();
    }
  }

  function clearQuestions() {
    if (submittingRef.current || refreshingRef.current) return;
    historyRef.current = [];
    setQuestions([]);
    setResponses({});
    setRecordErrors({});
    try {
      localStorage.removeItem(ASSISTANT_STORAGE_KEY);
      setStorageWarning("");
      setNotice("本机记录已清空。服务器上的问题不会删除；本机私有读取凭据已移除，无法再从这里读取之前的答复。");
    } catch {
      setStorageWarning("本次页面记录已清空，但浏览器未能删除存储；刷新后旧记录可能再次出现。");
      setNotice("");
    }
  }

  return <section className="assistant-page" aria-labelledby="assistant-title">
    <header className="assistant-header">
      <button type="button" className="assistant-back" onClick={onBack}><ArrowLeft size={18} aria-hidden="true" />返回雷达</button>
      <span className="assistant-local"><ShieldCheck size={14} aria-hidden="true" />私有问题记录</span>
    </header>
    <div className="assistant-hero">
      <div className="assistant-hero-icon"><MessageCircle size={30} aria-hidden="true" /></div>
      <span className="assistant-eyebrow">给三江大一的日常小帮手</span>
      <h1 id="assistant-title">生活助手</h1>
      <p>学习、科学、技术概念，随手记下你的疑问。</p>
      <span className="assistant-offline">{acceptsQuestions === null ? "正在检查提交服务" : acceptsQuestions ? "非实时 · 由站长整理" : "提交暂不可用 · 可保存本机草稿"}</span>
      <p className="assistant-service-note">普通知识不限校园话题，答复经 AI 整理和检查后发布。这里不提供即时回复。</p>
    </div>
    {context && <aside className="assistant-context" aria-label="关于这条通知">
      <div><span className="assistant-eyebrow">关于这条通知</span><h2>{currentContext?.title ?? "这条通知暂不在当前信息列表中"}</h2>{currentContext && <p>{currentContext.summary}</p>}<p className="assistant-context-note">仅作为问题背景；截止时间、参加资格请核对当期官方原文。</p>{currentContext && sourceUrl(currentContext) && <a href={sourceUrl(currentContext)} target="_blank" rel="noopener noreferrer">查看通知原文 <ArrowUpRight size={14} aria-hidden="true" /></a>}</div>
      <button type="button" className="assistant-icon-button" onClick={onClearContext} aria-label="移除通知背景"><X size={18} aria-hidden="true" /></button>
    </aside>}
    <form className="assistant-composer" onSubmit={saveQuestion}>
      <label htmlFor="assistant-question">你想了解什么？</label>
      <p className="assistant-scope">支持普通知识、学习、技术概念和生活问答。本站暂不受理当代政治话题，也不承接写代码、代写作业或代办任务。请勿填写密码、验证码等私人信息。</p>
      <div className="assistant-prompts" aria-label="常见问题">{guides.map(guide => <button type="button" key={guide.topic} disabled={submitting} onClick={() => { setInput(guide.question); setNotice(""); inputRef.current?.focus(); }}>{guide.topic}<ArrowUpRight size={13} aria-hidden="true" /></button>)}</div>
      <textarea ref={inputRef} id="assistant-question" value={input} onChange={event => setInput(event.target.value)} maxLength={QUESTION_LIMIT * 2} disabled={submitting} rows={4} placeholder="例如：刚上大一，怎样安排每周学习和休息？" aria-describedby="assistant-privacy assistant-count" />
      <div className="assistant-composer-footer"><span id="assistant-count" className={length > QUESTION_LIMIT ? "assistant-count assistant-count-invalid" : "assistant-count"}>{length} / {QUESTION_LIMIT} 字</span><button type="submit" className="assistant-save" disabled={!ready || acceptsQuestions === null || submitting || !input.trim() || length > QUESTION_LIMIT || questions.length >= HISTORY_LIMIT}><NotebookPen size={16} aria-hidden="true" />{submitting ? "正在提交" : "提交问题"}</button></div>
      <p className="assistant-privacy" id="assistant-privacy"><ShieldCheck size={14} aria-hidden="true" />提交后问题会发送至本站，供站长借助 AI 整理回复；私有读取凭据仅保存在当前浏览器。服务不可用时先保存本机草稿，不会自动重试。</p>
      <div className="assistant-feedback" role="status" aria-live="polite">{notice && <p><Check size={15} aria-hidden="true" />{notice}</p>}{storageWarning && <p className="assistant-storage-warning">{storageWarning}</p>}</div>
    </form>
    <section className="assistant-guides" aria-labelledby="assistant-guides-title">
      <div className="assistant-section-heading"><h2 id="assistant-guides-title">先看看这些日常建议</h2><span>已整理建议 · 通用参考</span></div>
      <div className="assistant-guide-grid">{guides.map(({ title, topic, icon: Icon, text }) => <details className="assistant-guide" key={topic}>
        <summary><Icon size={20} aria-hidden="true" /><span><small>{topic}</small><strong>{title}</strong></span><ChevronDown size={16} className="assistant-guide-chevron" aria-hidden="true" /></summary><p>{text}</p>
      </details>)}</div>
      <p className="assistant-guide-note">这些是预先整理的常见建议，不是对你提问的 AI 回答，也不代表学校当期政策。</p>
    </section>
    <section className="assistant-history" aria-labelledby="assistant-history-title">
      <div className="assistant-section-heading"><h2 id="assistant-history-title">我的问题记录 <span>{questions.length} / {HISTORY_LIMIT}</span></h2><div className="assistant-history-actions"><button type="button" className="assistant-refresh" onClick={() => void refreshAnswers()} disabled={!ready || refreshing || submitting}><RefreshCw size={14} aria-hidden="true" />{refreshing ? "正在刷新" : "刷新答复"}</button><button type="button" className="assistant-clear" onClick={clearQuestions} disabled={!ready || submitting || refreshing || !questions.length}><Trash2 size={14} aria-hidden="true" />清空本机记录</button></div></div>
      <p className="assistant-history-note">仅在当前浏览器读取自己的问题。清空只移除本机记录和读取凭据，不删除服务器问题，清空后将无法从这里读取旧答复。</p>
      {questions.length ? <ol className="assistant-history-list">{questions.map(entry => {
        const related = entry.contextId ? information.find(item => item.id === entry.contextId) : null;
        const response = responses[entry.id];
        return <li className="assistant-record" key={entry.id}>
          <div className="assistant-record-heading"><span>{entry.accessToken ? response ? responseLabels[response.status] : "已提交 · 答复未读取" : entry.delivery === "unconfirmed" ? "本机草稿 · 送达未确认" : "本机草稿 · 未送达"}</span><time dateTime={entry.createdAt}>{new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(entry.createdAt))}</time></div>
          <p className="assistant-record-question">{entry.question}</p>
          {related ? <div className="assistant-record-context"><span>关于：{related.title}</span>{sourceUrl(related) && <a href={sourceUrl(related)} target="_blank" rel="noopener noreferrer">通知原文<ArrowUpRight size={13} aria-hidden="true" /></a>}</div> : entry.contextId ? <p className="assistant-context-note">关联通知暂不在当前列表中，请返回雷达查找。</p> : null}
          {recordErrors[entry.id] && <p className="assistant-record-error">{recordErrors[entry.id]}</p>}
          {response?.status === "pending" && <p className="assistant-pending">问题已送达。非实时，由站长整理；这里不会自动生成回答。</p>}
          {response?.answer && <div className="assistant-answer"><div className="assistant-answer-heading"><strong>{responseLabels[response.status]}</strong><span>AI 辅助整理 · 模型已复核</span></div><p className="assistant-answer-text">{response.answer}</p>{response.sources.length > 0 && <ul className="assistant-answer-sources" aria-label="答复来源">{response.sources.map((source, index) => <li key={`${source.url}-${index}`}><a href={source.url} target="_blank" rel="noopener noreferrer">{source.title}<ArrowUpRight size={13} aria-hidden="true" /></a></li>)}</ul>}{response.answeredAt && <time dateTime={response.answeredAt}>{new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(response.answeredAt))} 发布</time>}</div>}
          {!entry.accessToken && <p className="assistant-pending">{entry.delivery === "unconfirmed" ? "送达情况未确认；这条草稿不会自动提交，请勿立即重复提问。" : "仅保存在当前浏览器，未发送给站长或 AI；这条草稿不会自动提交。"}</p>}
        </li>;
      })}</ol> : <div className="assistant-empty"><NotebookPen size={26} aria-hidden="true" /><h3>把想问的小事记下来</h3><p>这里还没有问题记录。提交后可在当前浏览器刷新、回看答复。</p></div>}
      {questions.length >= HISTORY_LIMIT && <p className="assistant-history-limit">已达到 20 条上限，请清空本机记录后再提交。清空将移除旧问题的本机读取凭据。</p>}
    </section>
  </section>;
}
