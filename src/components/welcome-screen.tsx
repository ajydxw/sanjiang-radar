"use client";

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronLeft, Radar, UserRound } from 'lucide-react';
import { identityEntryUrl, personalizedGreeting, welcomeGreeting } from '@/lib/welcome';
import IdentityConfirmation, { type useIdentity } from './identity-confirmation';

const privateEntry = process.env.NEXT_PUBLIC_IDENTITY_ENABLED === '1' ? null : identityEntryUrl(process.env.NEXT_PUBLIC_IDENTITY_URL);
const entryIsTest = process.env.NEXT_PUBLIC_IDENTITY_ENTRY_MODE !== 'real';
const chinaDate = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', month: 'long', day: 'numeric' });

// Confirmed names come only from the private server session, never local input.
export default function WelcomeScreen({ onContinue, identitySession }: { onContinue: () => void; identitySession: ReturnType<typeof useIdentity> }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [identity, setIdentity] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const greeting = welcomeGreeting(now);

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
      <div className="welcome-atmosphere" aria-hidden="true"><span className="welcome-glow glow-one" /><span className="welcome-glow glow-two" /><span className="welcome-dots" /></div>
      <div className="welcome-top"><span className="welcome-brand"><Radar size={17} strokeWidth={1.6} /> SANJIANG RADAR</span><button type="button" onClick={onContinue}>跳过开屏 <ArrowRight size={14} /></button></div>
      <div className="welcome-center">
        <div className="welcome-radar" aria-hidden="true"><span className="welcome-ticks" /><span className="welcome-ring ring-one" /><span className="welcome-ring ring-two" /><span className="welcome-ring ring-three" /><span className="welcome-cross cross-one" /><span className="welcome-cross cross-two" /><span className="welcome-sweep" /><i className="welcome-blip blip-one" /><i className="welcome-blip blip-two" /><i className="welcome-blip blip-three" /><span className="welcome-ping" /><span className="welcome-core" /></div>
        <div className="welcome-copy"><p className="welcome-kicker">在三江，发现下一种可能</p><h1 id="welcome-title">三江雷达<span>.</span></h1><p id="welcome-description">让有用的信息，及时被看见。</p></div>
        <div className="welcome-entry">
          <p className="welcome-date"><span>{chinaDate.format(now)}</span>{!greeting.text.startsWith(greeting.weekday) && <span>{greeting.weekday}</span>}</p>
          <p className="welcome-greeting">{personalizedGreeting(greeting.text, identitySession.confirmed ? identitySession.name ?? undefined : undefined)}</p>
          {identity ? <section className="welcome-identity" aria-labelledby="identity-title">
            <IdentityConfirmation identity={identitySession} onContinue={onContinue} />
            <button className="welcome-back" type="button" onClick={() => setIdentity(false)}><ChevronLeft size={14} /> 返回入口</button>
          </section> : <><button className="welcome-primary" type="button" onClick={onContinue}><span>直接浏览</span><ArrowRight size={18} /></button>{privateEntry ? <><a className="welcome-secondary" href={privateEntry} referrerPolicy="no-referrer"><UserRound size={16} />{entryIsTest ? '进入身份测试' : '姓名＋学号确认'}<small>{entryIsTest ? '合成账号' : '可选'}</small></a><small className="welcome-note">{entryIsTest ? '仅用于测试，不收集真实姓名或学号。' : '将在身份服务中继续浏览并保留称呼。原网站的收藏和设置会保留，但不会自动同步到这里。'}站长电脑离线时入口不可用。</small></> : <button className="welcome-secondary" type="button" onClick={() => setIdentity(true)}><UserRound size={16} /> 姓名＋学号确认 <small>{identitySession.testMode ? '测试账号' : identitySession.confirmed ? '已确认' : identitySession.enabled ? '可选' : '暂未开放'}</small></button>}</>}
        </div>
      </div>
      <div className="welcome-bottom"><span>校园通知 · 活动 · 竞赛</span><span>独立学生项目</span></div>
    </div>
  </dialog>;
}
