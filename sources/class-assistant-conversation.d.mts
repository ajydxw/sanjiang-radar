export type ConversationEntry = { role: 'user' | 'assistant'; content: string };
export const HISTORY_MAX_TURNS: number;
export const HISTORY_MAX_ENTRIES: number;
export const HISTORY_MAX_CHARS: number;
export const HISTORY_USER_MAX_CHARS: number;
export const HISTORY_ASSISTANT_MAX_CHARS: number;
export const CHAT_BODY_MAX_BYTES: number;
export function validateConversationHistory(value: unknown): ConversationEntry[];
