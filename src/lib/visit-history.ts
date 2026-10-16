export const VISIT_STORAGE_KEY = "sanjiang-radar-visits-v1";
export const VISIT_GAP = 30 * 60 * 1000;
type SourceIds = Record<string, string[]>;
export type VisitHistory = { version: 1; activeAt: string; previousVisitAt: string | null; baseline: SourceIds; seen: SourceIds };

export function parseVisitHistory(value: unknown): VisitHistory | null {
  if (!value || typeof value !== "object") return null;
  const history = value as Partial<VisitHistory>;
  const validDate = (date: unknown) => typeof date === "string" && Number.isFinite(Date.parse(date));
  const validIds = (ids: unknown) => ids && typeof ids === "object" && !Array.isArray(ids) && Object.values(ids).every(values => Array.isArray(values) && values.every(id => typeof id === "string"));
  return history.version === 1 && validDate(history.activeAt) && (history.previousVisitAt === null || validDate(history.previousVisitAt)) && validIds(history.baseline) && validIds(history.seen) ? history as VisitHistory : null;
}

export function recordVisit(history: VisitHistory | null, sources: SourceIds, now = new Date()): VisitHistory {
  const startsVisit = history && now.getTime() - Date.parse(history.activeAt) >= VISIT_GAP;
  const baseline = { ...(startsVisit ? history.seen : history?.baseline) };
  const seen = { ...history?.seen };
  for (const [source, ids] of Object.entries(sources)) {
    // A newly connected or previously unreadable source needs its own first-visit baseline.
    if (!baseline[source]) baseline[source] = ids;
    seen[source] = [...new Set([...(seen[source] ?? []), ...ids])];
  }
  return { version: 1, activeAt: now.toISOString(), previousVisitAt: startsVisit ? history.activeAt : history?.previousVisitAt ?? null, baseline, seen };
}

export function newInformationIds(sources: SourceIds, history: VisitHistory | null): Set<string> {
  if (!history) return new Set();
  const previous = new Set(Object.values(history.baseline).flat());
  return new Set(Object.entries(sources).flatMap(([source, ids]) => history.baseline[source] ? ids.filter(id => !previous.has(id)) : []));
}
