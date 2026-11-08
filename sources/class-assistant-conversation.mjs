import { QUESTION_MAX_CHARS } from './question-policy.mjs';

export const HISTORY_MAX_TURNS = 20;
export const HISTORY_MAX_ENTRIES = HISTORY_MAX_TURNS * 2;
export const HISTORY_MAX_CHARS = 12000;
export const LUNA_HISTORY_MAX_TURNS = 100;
export const LUNA_HISTORY_MAX_CHARS = 60000;
export const HISTORY_USER_MAX_CHARS = QUESTION_MAX_CHARS;
export const HISTORY_ASSISTANT_MAX_CHARS = 6000;
export const CHAT_BODY_MAX_BYTES = 256 * 1024;

export function conversationLimits(modelKey) {
  return modelKey === 'luna'
    ? { maxTurns: LUNA_HISTORY_MAX_TURNS, maxChars: LUNA_HISTORY_MAX_CHARS }
    : { maxTurns: HISTORY_MAX_TURNS, maxChars: HISTORY_MAX_CHARS };
}

export function validateConversationHistory(value, modelKey) {
  if (value === undefined) return [];
  const { maxTurns, maxChars } = conversationLimits(modelKey);
  const fail = () => { throw new Error(`当前模型历史对话须为最多${maxTurns}轮成对的非空user/assistant消息，提问最多${HISTORY_USER_MAX_CHARS}字符、回答最多${HISTORY_ASSISTANT_MAX_CHARS}字符，历史合计最多${maxChars}字符。请开启新对话或减少历史。`); };
  if (!Array.isArray(value) || value.length > maxTurns * 2 || value.length % 2 !== 0) fail();
  let total = 0;
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry) || Object.keys(entry).length !== 2
      || !Object.hasOwn(entry, 'role') || !Object.hasOwn(entry, 'content') || entry.role !== (index % 2 === 0 ? 'user' : 'assistant')
      || typeof entry.content !== 'string' || !entry.content.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(entry.content)) fail();
    const length = [...entry.content].length;
    if (length > (entry.role === 'user' ? HISTORY_USER_MAX_CHARS : HISTORY_ASSISTANT_MAX_CHARS)) fail();
    total += length;
    if (total > maxChars) fail();
    return { role: entry.role, content: entry.content };
  });
}

// Only discard complete oldest pairs, so the next request keeps valid role order.
export function trimConversationHistory(entries, modelKey) {
  const { maxTurns, maxChars } = conversationLimits(modelKey);
  const next = [...entries];
  let total = next.reduce((size, entry) => size + [...entry.content].length, 0);
  while (next.length > maxTurns * 2 || total > maxChars) {
    total -= [...next[0].content].length + [...next[1].content].length;
    next.splice(0, 2);
  }
  return next;
}
