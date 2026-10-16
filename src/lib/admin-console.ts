export type AdminStatus = "pending" | "answered" | "declined" | "needs-info" | "unconfirmed";
export type AdminSource = { title: string; url: string };
export type AdminDraft = { draftId: string; status: Exclude<AdminStatus, "pending">; answer: string; sources: AdminSource[]; model: "gpt-6.1-sol"; reasoningEffort: "high"; reviewedAt: string };
export type AdminQuestion = { id: string; question: string; contextId: string | null; createdAt: string; status: AdminStatus; answer: string | null; sources: AdminSource[]; model: "gpt-6.1-sol" | null; reasoningEffort: "high" | null; answeredAt: string | null; draft?: AdminDraft };
export type AdminSession = { configured: boolean; authenticated: boolean; username: string | null; csrfToken: string | null };
export type AdminStats = { total: number; pending: number; ready: number; answered: number; declined: number; needsInfo: number; unconfirmed: number };
export type AdminFilter = "all" | "pending" | "ready" | "processed";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const statuses = ["pending", "answered", "declined", "needs-info", "unconfirmed"];
const object = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
function date(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 40 || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return month >= 1 && month <= 12 && day >= 1 && day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}
export function safeAdminSourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || /\/api\/(admin|assistant)(\/|$)/i.test(url.pathname)) return null;
    const privateKey = /token|password|secret|authorization|credential|session|csrf|^auth$|^key$/i;
    if ([...url.searchParams.keys(), ...new URLSearchParams(url.hash.slice(1)).keys()].some(key => privateKey.test(key))) return null;
    return url.href;
  } catch { return null; }
}
function sources(value: unknown): AdminSource[] | null {
  if (!Array.isArray(value) || value.length > 20) return null;
  const result: AdminSource[] = [];
  for (const entry of value) {
    const source = object(entry);
    const url = safeAdminSourceUrl(source?.url);
    if (!source || typeof source.title !== "string" || !source.title.trim() || source.title.length > 300 || !url) return null;
    result.push({ title: source.title.trim(), url });
  }
  return result;
}
export function parseAdminSession(value: unknown): AdminSession | null {
  const data = object(value);
  if (!data || typeof data.configured !== "boolean" || typeof data.authenticated !== "boolean") return null;
  if (data.authenticated ? !data.configured || typeof data.username !== "string" || !/^[A-Za-z0-9._-]{2,40}$/.test(data.username) || typeof data.csrfToken !== "string" || !/^[A-Za-z0-9_-]{32,256}$/.test(data.csrfToken) : data.username !== null || data.csrfToken !== null) return null;
  return { configured: data.configured, authenticated: data.authenticated, username: data.authenticated ? data.username as string : null, csrfToken: data.authenticated ? data.csrfToken as string : null };
}
export function safeAdminLoginLocation(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  } catch { return false; }
}
export function parseAdminQuestion(value: unknown): AdminQuestion | null {
  const data = object(value);
  if (!data || typeof data.id !== "string" || !UUID.test(data.id) || typeof data.question !== "string" || !data.question.trim() || Array.from(data.question).length > 500 || !date(data.createdAt) || !statuses.includes(String(data.status)) || (data.contextId !== null && (typeof data.contextId !== "string" || !data.contextId.trim() || data.contextId.length > 200 || /[\u0000-\u001f\u007f]/.test(data.contextId)))) return null;
  const parsedSources = sources(data.sources);
  const pending = data.status === "pending";
  if (!parsedSources || (pending ? data.answer !== null || parsedSources.length !== 0 || data.model != null || data.reasoningEffort != null || data.answeredAt != null : typeof data.answer !== "string" || !data.answer.trim() || data.answer.length > 20000 || data.model !== "gpt-6.1-sol" || data.reasoningEffort !== "high" || !date(data.answeredAt))) return null;
  let draft: AdminDraft | undefined;
  if (data.draft !== undefined) {
    const d = object(data.draft);
    const ds = sources(d?.sources);
    if (!d || typeof d.draftId !== "string" || !UUID.test(d.draftId) || !statuses.slice(1).includes(String(d.status)) || typeof d.answer !== "string" || !d.answer.trim() || d.answer.length > 20000 || !ds || d.model !== "gpt-6.1-sol" || d.reasoningEffort !== "high" || !date(d.reviewedAt)) return null;
    draft = { draftId: d.draftId, status: d.status as AdminDraft["status"], answer: d.answer, sources: ds, model: "gpt-6.1-sol", reasoningEffort: "high", reviewedAt: d.reviewedAt };
  }
  return { id: data.id, question: data.question.trim(), contextId: data.contextId as string | null, createdAt: data.createdAt, status: data.status as AdminStatus, answer: data.answer as string | null, sources: parsedSources, model: pending ? null : "gpt-6.1-sol", reasoningEffort: pending ? null : "high", answeredAt: pending ? null : data.answeredAt as string, ...(draft ? { draft } : {}) };
}
export function parseAdminQuestions(value: unknown): { items: AdminQuestion[]; stats: AdminStats; invalid: boolean } | null {
  const data = object(value);
  const processing = object(data?.processing);
  const stats = object(data?.stats);
  const keys = ["total", "pending", "ready", "answered", "declined", "needsInfo", "unconfirmed"];
  if (!data || !Array.isArray(data.items) || data.items.length > 10000 || !processing || processing.mode !== "owner-triggered" || processing.automaticAnswers !== false || processing.model !== "gpt-6.1-sol" || processing.reasoningEffort !== "high" || !stats || keys.some(key => !Number.isSafeInteger(stats[key]) || (stats[key] as number) < 0)) return null;
  const items: AdminQuestion[] = [];
  const ids = new Set<string>();
  let invalid = false;
  for (const entry of data.items) {
    const item = parseAdminQuestion(entry);
    if (!item || ids.has(item.id)) { invalid = true; continue; }
    ids.add(item.id); items.push(item);
  }
  if ((stats.total as number) !== data.items.length || (stats.pending as number) + (stats.answered as number) + (stats.declined as number) + (stats.needsInfo as number) + (stats.unconfirmed as number) !== stats.total || (stats.ready as number) > (stats.total as number)) return null;
  if (!invalid && (items.filter(item => item.status === "pending").length !== stats.pending || items.filter(item => item.draft).length !== stats.ready || ["answered", "declined", "needs-info", "unconfirmed"].some((status, index) => items.filter(item => item.status === status).length !== stats[keys[index + 3]]))) return null;
  return { items, stats: stats as AdminStats, invalid };
}
export function filterAdminQuestions(items: AdminQuestion[], filter: AdminFilter): AdminQuestion[] {
  return items.filter(item => filter === "all" || (filter === "ready" ? !!item.draft : filter === "pending" ? item.status === "pending" && !item.draft : item.status !== "pending" && !item.draft));
}
