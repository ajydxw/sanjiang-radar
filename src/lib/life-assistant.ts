export const ASSISTANT_STORAGE_KEY = "sanjiang-radar-assistant-v1";
export const QUESTION_LIMIT = 500;
export const HISTORY_LIMIT = 20;

export type AssistantQuestion = {
  id: string;
  question: string;
  createdAt: string;
  contextId: string | null;
  accessToken?: string;
  delivery?: "unconfirmed";
};

export type AssistantResponse = Omit<AssistantQuestion, "accessToken" | "delivery"> & {
  status: "pending" | "answered" | "declined" | "needs-info" | "unconfirmed";
  answer: string | null;
  sources: { title: string; url: string }[];
  model: "gpt-6.1-sol" | null;
  reasoningEffort: "high" | null;
  answeredAt: string | null;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TOKEN = /^[A-Za-z0-9_-]{32,256}$/;

function validDate(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && Number.isFinite(Date.parse(value));
}

export function safeAssistantSourceUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function parseAssistantStatus(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const data = value as Record<string, unknown>;
  return data.acceptsQuestions === true && data.automaticAnswers === false;
}

export function parseAssistantResponse(value: unknown): AssistantResponse | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  const question = normalizeQuestion(data.question);
  if (typeof data.id !== "string" || !UUID.test(data.id) || !question || !validDate(data.createdAt) ||
      (data.contextId !== null && !validId(data.contextId)) || !Array.isArray(data.sources) || data.sources.length > 20 ||
      !["pending", "answered", "declined", "needs-info", "unconfirmed"].includes(String(data.status))) return null;
  const pending = data.status === "pending";
  if (pending ? data.answer !== null || data.model != null || data.reasoningEffort != null || data.answeredAt != null || data.sources.length !== 0
    : typeof data.answer !== "string" || !data.answer.trim() || data.answer.length > 20000 || data.model !== "gpt-6.1-sol" || data.reasoningEffort !== "high" || !validDate(data.answeredAt)) return null;
  const sources: AssistantResponse["sources"] = [];
  for (const source of data.sources) {
    if (!source || typeof source !== "object" || typeof source.title !== "string" || !source.title.trim() || source.title.length > 300) return null;
    const url = safeAssistantSourceUrl(source.url);
    if (!url) return null;
    sources.push({ title: source.title.trim(), url });
  }
  return { id: data.id, question, contextId: data.contextId as string | null, createdAt: new Date(data.createdAt).toISOString(), status: data.status as AssistantResponse["status"], answer: data.answer as string | null, sources, model: pending ? null : "gpt-6.1-sol", reasoningEffort: pending ? null : "high", answeredAt: pending ? null : new Date(data.answeredAt as string).toISOString() };
}

export function parseAssistantSubmission(value: unknown): { question: AssistantQuestion; response: AssistantResponse } | null {
  const response = parseAssistantResponse(value);
  const data = value as Record<string, unknown> | null;
  if (!response || response.status !== "pending" || typeof data?.accessToken !== "string" || !TOKEN.test(data.accessToken)) return null;
  return { question: { id: response.id, question: response.question, createdAt: response.createdAt, contextId: response.contextId, accessToken: data.accessToken }, response };
}

export function questionLength(question: string): number {
  return Array.from(question).length;
}

export function normalizeQuestion(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const question = value.trim();
  return question && questionLength(question) <= QUESTION_LIMIT ? question : null;
}

function validId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200 && value.trim() === value && !/[\u0000-\u001f\u007f]/.test(value);
}

export function parseAssistantHistory(raw: string | null): { questions: AssistantQuestion[]; invalid: boolean } {
  if (raw === null) return { questions: [], invalid: false };
  try {
    const data = JSON.parse(raw);
    if (!data || ![1, 2].includes(data.version) || !Array.isArray(data.questions)) return { questions: [], invalid: true };
    const questions: AssistantQuestion[] = [];
    const ids = new Set<string>();
    let invalid = data.questions.length > HISTORY_LIMIT;
    for (const entry of data.questions) {
      const question = normalizeQuestion(entry?.question);
      if (!entry || !validId(entry.id) || ids.has(entry.id) || !question ||
          !validDate(entry.createdAt) || (entry.contextId !== null && !validId(entry.contextId)) ||
          (data.version === 2 && entry.accessToken !== undefined && (typeof entry.accessToken !== "string" || !TOKEN.test(entry.accessToken) || !UUID.test(entry.id))) ||
          (data.version === 2 && entry.delivery !== undefined && (entry.delivery !== "unconfirmed" || entry.accessToken !== undefined))) {
        invalid = true;
        continue;
      }
      ids.add(entry.id);
      if (questions.length < HISTORY_LIMIT) questions.push({ id: entry.id, question, createdAt: new Date(entry.createdAt).toISOString(), contextId: entry.contextId,
        ...(data.version === 2 && entry.accessToken ? { accessToken: entry.accessToken } : {}),
        ...(data.version === 2 && entry.delivery ? { delivery: "unconfirmed" as const } : {}) });
    }
    return { questions, invalid };
  } catch {
    return { questions: [], invalid: true };
  }
}

export function appendAssistantQuestion(history: AssistantQuestion[], input: string, contextId: string | null, id: string, now: Date): AssistantQuestion[] | null {
  const question = normalizeQuestion(input);
  if (!question || history.length >= HISTORY_LIMIT || !validId(id) || history.some(entry => entry.id === id) ||
      (contextId !== null && !validId(contextId)) || !Number.isFinite(now.getTime())) return null;
  return [{ id, question, createdAt: now.toISOString(), contextId }, ...history];
}

export function serializeAssistantHistory(questions: AssistantQuestion[]): string {
  return JSON.stringify({ version: 2, questions: questions.map(({ id, question, createdAt, contextId, accessToken, delivery }) => ({ id, question, createdAt, contextId, ...(accessToken ? { accessToken } : {}), ...(delivery ? { delivery } : {}) })) });
}
