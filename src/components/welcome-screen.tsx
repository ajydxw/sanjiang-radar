"use client";

import { useEffect, useRef, useState } from 'react';
import { ArrowRight, ChevronLeft, Radar, UserRound } from 'lucide-react';
import { personalizedGreeting, welcomeGreeting } from '@/lib/welcome';

// verifiedDisplayName is reserved for a future server-validated session, never local input.
export default function WelcomeScreen({ onContinue, verifiedDisplayName }: { onContinue: () => void; verifiedDisplayName?: string }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [identity, setIdentity] = useState(false);
  const [now, setNow] = useState(() => new Date());
  const greeting = welcomeGreeting(now);

  useEffect(() => {
    const node = dialog.current;
    const previousOverflow = document.body.style.overflow;
    node?.showModal();
    document.body.style.overflow = 'hidden';
    const timer = window.setInterval(() => setNow(new Date()), 60_000);
    return () => { window.clearInterval(timer); node?.close(); document.body.style.overflow = previousOverflow; };
  }, []);

  return <dialog ref={dialog} className="welcome-screen" aria-labelledby="welcome-title" aria-describedby="welcome-description" onCancel={event => { event.preventDefault(); onContinue(); }}>
    <div className="welcome-frame">
      <div className="welcome-top"><span><Radar size={17} strokeWidth={1.4} /> SANJIANG RADAR</span><button type="button" onClick={onContinue}>跳过开屏 <ArrowRight size={14} /></button></div>
      <div className="welcome-center">
        <div className="welcome-radar" aria-hidden="true"><span className="welcome-ring ring-one" /><span className="welcome-ring ring-two" /><span className="welcome-ring ring-three" /><span className="welcome-cross cross-one" /><span className="welcome-cross cross-two" /><span className="welcome-sweep" /><i className="welcome-blip blip-one" /><i className="welcome-blip blip-two" /><span className="welcome-core" /></div>
        <div className="welcome-copy"><p className="welcome-kicker">在三江，发现下一种可能</p><h1 id="welcome-title">三江雷达<span>.</span></h1><p id="welcome-description">让有用的信息，及时被看见。</p></div>
        <div className="welcome-entry">
          <p className="welcome-greeting">{personalizedGreeting(greeting.text, verifiedDisplayName)}</p>
          {identity ? <section className="welcome-identity" aria-labelledby="identity-title">
            <h2 id="identity-title">班级身份确认</h2><p>姓名＋学号确认暂未开放。私有验证服务准备好后再启用，当前不会收集你的姓名或学号。</p>
            <button className="welcome-primary" type="button" autoFocus onClick={onContinue}>先直接浏览 <ArrowRight size={17} /></button>
            <button className="welcome-back" type="button" onClick={() => setIdentity(false)}><ChevronLeft size={14} /> 返回入口</button>
          </section> : <><button className="welcome-primary" type="button" onClick={onContinue}>直接浏览 <ArrowRight size={18} /></button><button className="welcome-secondary" type="button" onClick={() => setIdentity(true)}><UserRound size={16} /> 姓名＋学号确认 <small>暂未开放</small></button></>}
        </div>
      </div>
      <div className="welcome-bottom"><span>校园通知 · 活动 · 竞赛</span><span>独立学生项目</span></div>
    </div>
  </dialog>;
}
