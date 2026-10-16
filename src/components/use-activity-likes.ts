"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { readLikeSummary, type LikeSummary } from "@/lib/activity-likes";

export function useActivityLikes() {
  const [summary, setSummary] = useState<LikeSummary>({ counts: {}, likedIds: [] });
  const [ready, setReady] = useState(false);
  const [available, setAvailable] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const latest = useRef(summary);
  const busy = useRef(false);
  const enabled = useRef(false);
  const mounted = useRef(false);
  const sequence = useRef(0);
  const update = (value: LikeSummary) => { latest.current = value; setSummary(value); };

  const refresh = useCallback(async () => {
    if (busy.current) return;
    const current = ++sequence.current;
    try {
      const response = await fetch("/api/likes", { cache: "no-store", credentials: "same-origin", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      const next = readLikeSummary(await response.json());
      if (!mounted.current || current !== sequence.current) return;
      latest.current = next; setSummary(next); setReady(true); setAvailable(true); enabled.current = true; setMessage("");
    } catch {
      if (!mounted.current || current !== sequence.current) return;
      enabled.current = false; setAvailable(false); setMessage("点赞服务暂不可用，请刷新后再试。当前数字可能不是最新。");
    }
  }, []);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 15000);
    const resume = () => { if (document.visibilityState === "visible") void refresh(); };
    document.addEventListener("visibilitychange", resume);
    return () => { mounted.current = false; sequence.current++; window.clearInterval(timer); document.removeEventListener("visibilitychange", resume); };
  }, [refresh]);

  async function setLiked(id: string, liked: boolean): Promise<boolean> {
    if (busy.current || !enabled.current) return false;
    const before = latest.current;
    const wasLiked = before.likedIds.includes(id);
    if (wasLiked === liked) return true;
    busy.current = true; sequence.current++; setPendingId(id); setMessage("");
    update({ counts: { ...before.counts, [id]: Math.max(0, (before.counts[id] ?? 0) + (liked ? 1 : -1)) }, likedIds: liked ? [...before.likedIds, id] : before.likedIds.filter(value => value !== id) });
    try {
      const response = await fetch(`/api/likes/${encodeURIComponent(id)}`, { method: "PUT", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ liked }), signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error();
      const next = readLikeSummary(await response.json());
      if (next.likedIds.includes(id) !== liked) throw new Error();
      if (!mounted.current) return false;
      update(next); setAvailable(true); enabled.current = true;
      return true;
    } catch {
      if (mounted.current) {
        update(before); setAvailable(false); enabled.current = false;
        setMessage("这次点赞状态未确认，请刷新后核对。未确认的结果不会显示为已完成。");
      }
      return false;
    } finally { busy.current = false; if (mounted.current) setPendingId(null); }
  }
  return { ...summary, ready, available, pendingId, message, refresh, setLiked };
}
