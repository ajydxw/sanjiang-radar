"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { SchoolFeed } from "@/lib/information";
import { newInformationIds, parseVisitHistory, recordVisit, VISIT_STORAGE_KEY, type VisitHistory } from "@/lib/visit-history";

export function useVisitHistory(chunks: Record<string, SchoolFeed>) {
  const current = useRef<VisitHistory | null>(null);
  const initialized = useRef(false);
  const [history, setHistory] = useState<VisitHistory | null>(null);
  const [storageError, setStorageError] = useState(false);
  const sources = useMemo(() => Object.fromEntries(Object.entries(chunks)
    .filter(([, chunk]) => chunk.items.length > 0 || chunk.sources.some(source => source.state === "ok" || source.state === "partial"))
    .map(([path, chunk]) => [path, chunk.items.map(item => item.id)])), [chunks]);

  useEffect(() => {
    if (Object.keys(sources).length === 0) return;
    const update = () => {
      if (!initialized.current) {
        try { current.current = parseVisitHistory(JSON.parse(localStorage.getItem(VISIT_STORAGE_KEY) ?? "null")); }
        catch { setStorageError(true); }
        initialized.current = true;
      }
      const next = recordVisit(current.current, sources);
      current.current = next;
      setHistory(next);
      // shortcut: visit history belongs to this browser; use accounts for cross-device sync.
      try { localStorage.setItem(VISIT_STORAGE_KEY, JSON.stringify(next)); }
      catch { setStorageError(true); }
    };
    if (document.visibilityState === "visible") update();
    document.addEventListener("visibilitychange", update);
    return () => document.removeEventListener("visibilitychange", update);
  }, [sources]);

  return { history, newIds: newInformationIds(sources, history), storageError };
}
