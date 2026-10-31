"use client";

import { useEffect, useRef, useState, type FormEvent } from 'react';

const configured = process.env.NEXT_PUBLIC_IDENTITY_ENABLED === '1';
type Session = { enabled: boolean; confirmed: boolean; name: string | null; testMode?: boolean };
const unavailable: Session = { enabled: false, confirmed: false, name: null };

async function requestIdentity(action: string, body?: object): Promise<Session> {
  const response = await fetch(`/api/identity/${action}`, {
    method: body ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
    ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error(response.status === 401 ? '姓名或学号不匹配，请检查后重试。'
    : response.status === 429 ? '尝试较频繁，请稍后再试。' : '身份服务暂不可用，你仍可直接浏览。');
  if (response.status === 204) return { enabled: true, confirmed: false, name: null };
  const data = await response.json();
  if (typeof data?.enabled !== 'boolean' || typeof data?.confirmed !== 'boolean'
    || (data.confirmed && (!data.enabled || typeof data.name !== 'string' || !data.name.trim() || data.name.length > 80))) {
    throw new Error('身份服务暂不可用，你仍可直接浏览。');
  }
  return { enabled: data.enabled, confirmed: data.confirmed, name: data.confirmed ? data.name : null, testMode: data.testMode === true };
}

// Only the private same-origin server can supply a confirmed name. No browser storage.
export function useIdentity() {
  const [session, setSession] = useState<Session>(unavailable);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(false);
  const submitting = useRef(false);
  const version = useRef(0);
  useEffect(() => {
    active.current = true;
    if (!configured) return () => { active.current = false; };
    const refresh = async () => {
      if (submitting.current) return;
      const current = ++version.current;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const next = await requestIdentity('session');
          if (active.current && current === version.current) setSession(next);
          return;
        } catch {
          if (!active.current || current !== version.current || submitting.current) return;
          if (attempt === 1) setSession(unavailable);
        }
      }
    };
    void refresh();
    window.addEventListener('focus', refresh);
    return () => { active.current = false; version.current++; window.removeEventListener('focus', refresh); };
  }, []);
  async function submit(action: 'confirm' | 'logout', body: object) {
    if (!configured || !session.enabled || submitting.current) return;
    submitting.current = true;
    const current = ++version.current;
    setBusy(true); setError('');
    try {
      const next = await requestIdentity(action, body);
      if (active.current && current === version.current) setSession(action === 'logout' ? { ...next, testMode: session.testMode } : next);
    } catch (cause) {
      if (active.current && current === version.current) setError(cause instanceof Error && cause.name !== 'TimeoutError' && cause.name !== 'TypeError'
        ? cause.message : '身份服务暂不可用，你仍可直接浏览。');
    } finally { submitting.current = false; if (active.current) setBusy(false); }
  }
  return { ...session, busy, error, confirm: (name: string, studentId: string) => submit('confirm', { name, studentId }), logout: () => submit('logout', {}) };
}

export default function IdentityConfirmation({ identity, onContinue }: { identity: ReturnType<typeof useIdentity>; onContinue: () => void }) {
  const [name, setName] = useState('');
  const [studentId, setStudentId] = useState('');
  async function confirm(event: FormEvent) {
    event.preventDefault();
    await identity.confirm(name.trim(), studentId.trim());
    setName(''); setStudentId('');
  }
  return <>
    <h2 id="identity-title">{identity.testMode ? '测试账号确认' : '班级身份确认'}</h2>
    {identity.testMode && <p role="note">当前仅开放合成测试账号：测试同学／000000001。请勿输入真实姓名或学号；这不是正式班级确认。</p>}
    {!identity.enabled ? <p>姓名＋学号确认暂未开放。私有验证服务准备好后再启用，当前不会收集你的姓名或学号。</p>
      : identity.confirmed ? <><p role="status">{identity.testMode ? '仅测试账号确认成功，不代表真实班级身份。' : '已匹配班级名单。此确认仅用于称呼，不是强本人认证。'}</p><button className="welcome-secondary" type="button" disabled={identity.busy} onClick={() => void identity.logout()}>退出身份确认</button></>
      : <form onSubmit={confirm} className="identity-form" autoComplete="off">
        <p>可选：仅用于在问候中显示你的名字，正常使用时自动保持确认。</p>
        <details className="identity-details"><summary>了解更多</summary><p>姓名与完整学号须同时匹配班级名单。确认只保留在当前设备和浏览器，正常使用时自动续期；长期不访问、退出、清除 Cookie 或站长撤销后需重新确认。直接浏览也可使用相同功能；名单匹配不能证明操作者本人。</p></details>
        <label htmlFor="identity-name">姓名<input id="identity-name" value={name} onChange={event => setName(event.target.value)} maxLength={80} required disabled={identity.busy} autoComplete="off" /></label>
        <label htmlFor="identity-student-id">完整学号<input id="identity-student-id" value={studentId} onChange={event => setStudentId(event.target.value)} inputMode="numeric" pattern="[0-9]+" maxLength={32} required disabled={identity.busy} autoComplete="off" /></label>
        <button className="welcome-primary" type="submit" disabled={identity.busy}>{identity.busy ? '正在确认…' : '确认班级身份'}</button>
      </form>}
    {identity.error && <p role="alert">{identity.error}</p>}
    <button className="welcome-primary identity-browse" type="button" onClick={onContinue}>{identity.confirmed ? '继续浏览' : '先直接浏览'}</button>
  </>;
}
