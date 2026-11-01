"use client";

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronLeft, UserRound } from 'lucide-react';
import { identityEntryUrl, personalizedGreeting, welcomeGreeting } from '@/lib/welcome';
import IdentityConfirmation, { type useIdentity } from './identity-confirmation';

const privateEntry = process.env.NEXT_PUBLIC_IDENTITY_ENABLED === '1' ? null : identityEntryUrl(process.env.NEXT_PUBLIC_IDENTITY_URL);
const entryIsTest = process.env.NEXT_PUBLIC_IDENTITY_ENTRY_MODE !== 'real';
const chinaDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' });
const chinaStamp = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });

export type WelcomeSummary = { relevant: number; soon: number; freshman: number; updatedAt: string; partial: boolean };

/** Counts up once when the real number arrives; reduced motion shows it at once. */
function Metric({ value, label }: { value: number | null; label: string }) {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (value === null) return;
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) { setShown(value); return; }
    let frame = 0;
    const start = performance.now();
    const step = (now: number) => {
      const progress = Math.min(1, (now - start) / 720);
      setShown(Math.round(value * (1 - (1 - progress) ** 3)));
      if (progress < 1) frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [value]);
  return <div className="welcome-metric"><dt>{label}</dt><dd>{value === null ? '—' : shown}</dd></div>;
}

// Confirmed names come only from the private server session, never local input.
export default function WelcomeScreen({ onContinue, identitySession, summary }: { onContinue: () => void; identitySession: ReturnType<typeof useIdentity>; summary: WelcomeSummary | null }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [identity, setIdentity] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const greeting = welcomeGreeting(now);
  const updated = summary?.updatedAt ? Date.parse(summary.updatedAt) : NaN;
  const status = !summary ? '正在同步校园信息…' : `${summary.partial ? '部分来源待补齐' : '数据已同步'}${Number.isNaN(updated) ? '' : ` · 更新于 ${chinaStamp.format(updated)}`}`;

  useEffect(() => {
    const node = dialog.current;
    const previousOverflow = document.body.style.overflow;
    node?.showModal();
    // Land on the main action so Enter continues; no ring until the visitor uses the keyboard.
    node?.querySelector<HTMLButtonElement>('.welcome-primary')?.focus({ preventScroll: true, focusVisible: false } as FocusOptions);
    document.body.style.overflow = 'hidden';
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => { window.clearInterval(timer); node?.close(); document.body.style.overflow = previousOverflow; };
  }, []);

  return <dialog ref={dialog} className="welcome-screen" data-period={greeting.period} aria-labelledby="welcome-title" aria-describedby="welcome-description" onCancel={event => { event.preventDefault(); onContinue(); }}>
    <div className="welcome-frame">
      <div className="welcome-atmosphere" aria-hidden="true"><span className="welcome-glow glow-one" /><span className="welcome-glow glow-two" /><span className="welcome-grid" /></div>
      <div className="welcome-top">
        <span className="welcome-brand"><span className="welcome-mark" aria-hidden="true"><i /><i /><b /></span><span>三江雷达<small>SANJIANG RADAR</small></span></span>
        <button type="button" onClick={onContinue}>跳过开屏 <ArrowRight size={14} /></button>
      </div>
      <div className={identity ? 'welcome-center identity-open' : 'welcome-center'}>
        <div className="welcome-visual" aria-hidden="true">
          {/* Each blip stands for a real relevant record, up to three. */}
          <div className="welcome-radar"><span className="welcome-ticks" /><span className="welcome-ring ring-one" /><span className="welcome-ring ring-two" /><span className="welcome-ring ring-three" /><span className="welcome-cross cross-one" /><span className="welcome-cross cross-two" /><span className="welcome-sweep" />{['blip-one', 'blip-two', 'blip-three'].slice(0, Math.min(3, summary?.relevant ?? 0)).map(name => <i key={name} className={`welcome-blip ${name}`} />)}<span className="welcome-core" /></div>
        </div>
        <div className="welcome-content">
          <p className="welcome-status" role="status"><span className={`welcome-status-dot${summary ? summary.partial ? ' is-partial' : ' is-live' : ''}`} />{status}</p>
          <div className="welcome-copy">
            <div className="welcome-hello"><span className="welcome-date">{chinaDate.format(now)} · {greeting.weekday}</span><p className="welcome-greeting">{personalizedGreeting(greeting.text, identitySession.confirmed ? identitySession.name ?? undefined : undefined)}</p></div>
            <h1 id="welcome-title">三江雷达<span>.</span></h1>
            <p id="welcome-description">面向三江学院新生的校园信息雷达。通知、活动、竞赛与考试，一处看全，不再错过截止。</p>
          </div>
          <dl className="welcome-metrics">
            <Metric value={summary?.relevant ?? null} label="相关信息" />
            <Metric value={summary?.soon ?? null} label="7 天内截止" />
            <Metric value={summary?.freshman ?? null} label="大一可参加" />
          </dl>
          <div className="welcome-entry">
            {identity ? <section className="welcome-identity" aria-labelledby="identity-title">
              <IdentityConfirmation identity={identitySession} onContinue={onContinue} />
              <button className="welcome-back" type="button" onClick={() => setIdentity(false)}><ChevronLeft size={14} /> 返回入口</button>
            </section> : <><button className="welcome-primary" type="button" onClick={onContinue}><span>直接浏览</span><ArrowRight size={18} /></button>{privateEntry ? <><a className="welcome-secondary" href={privateEntry} referrerPolicy="no-referrer"><UserRound size={16} />{entryIsTest ? '进入身份测试' : '姓名＋学号确认'}<small>{entryIsTest ? '合成账号' : '可选'}</small></a><small className="welcome-note">{entryIsTest ? '仅用于测试，不收集真实姓名或学号。' : '将在身份服务中继续浏览并保留称呼，本站收藏与设置不会同步过去。'}站长电脑离线时入口不可用。</small></> : <button className="welcome-secondary" type="button" onClick={() => setIdentity(true)}><UserRound size={16} /> 姓名＋学号确认 <small>{identitySession.testMode ? '测试账号' : identitySession.confirmed ? '已确认' : identitySession.enabled ? '可选' : '暂未开放'}</small></button>}</>}
          </div>
        </div>
      </div>
      <div className="welcome-bottom"><span>数据来源：学校官网 · PU · 竞赛官网 · 省考试院</span><span>独立学生项目</span></div>
    </div>
  </dialog>;
}
