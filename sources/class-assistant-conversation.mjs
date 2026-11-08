import { QUESTION_MAX_CHARS } from './question-policy.mjs';

export const HISTORY_MAX_TURNS = 6;
export const HISTORY_MAX_ENTRIES = HISTORY_MAX_TURNS * 2;
export const HISTORY_MAX_CHARS = 6000;
export const HISTORY_USER_MAX_CHARS = QUESTION_MAX_CHARS;
export const HISTORY_ASSISTANT_MAX_CHARS = 6000;
export const CHAT_BODY_MAX_BYTES = 64 * 1024;

export function validateConversationHistory(value) {
  if (value === undefined) return [];
  const fail = () => { throw new Error('历史对话须为最多6轮成对的非空user/assistant消息，提问最多500字符、回答最多6000字符，历史合计最多6000字符。请开启新对话或减少历史。'); };
  if (!Array.isArray(value) || value.length > HISTORY_MAX_ENTRIES || value.length % 2 !== 0) fail();
  let total = 0;
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 2
      || !Object.hasOwn(entry, 'role') || !Object.hasOwn(entry, 'content') || entry.role !== (index % 2 === 0 ? 'user' : 'assistant')
      || typeof entry.content !== 'string' || !entry.content.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(entry.content)) fail();
    const length = [...entry.content].length;
    if (length > (entry.role === 'user' ? HISTORY_USER_MAX_CHARS : HISTORY_ASSISTANT_MAX_CHARS)) fail();
    total += length;
    if (total > HISTORY_MAX_CHARS) fail();
    return { role: entry.role, content: entry.content };
  });
}
