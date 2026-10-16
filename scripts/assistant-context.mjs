import { CONTEXT_MAX_CHARS, QUESTION_MAX_CHARS } from '../sources/question-policy.mjs';
import { safeExternalUrl } from '../sources/public-feed.mjs';

const chars = value => Array.from(value).length;
const metadataFields = ['publishedAt', 'registrationStart', 'registrationDeadline', 'eventStart', 'eventEnd', 'freshmanAllowed', 'eligibilityEvidence', 'dateEvidence', 'eligibleYears', 'colleges', 'detailRead', 'sourceAvailable'];

/** Build only the current question and caller-verified public material; never read or execute input. */
export function buildQuestionContext(questionRecord, matchedInformation = null, verifiedSources = []) {
  if (!questionRecord || typeof questionRecord.id !== 'string' || chars(questionRecord.id) > 120 || typeof questionRecord.question !== 'string' || !questionRecord.question.trim()) throw new Error('当前问题格式不正确');
  if (chars(questionRecord.question) > QUESTION_MAX_CHARS) throw new Error(`问题不能超过 ${QUESTION_MAX_CHARS} 字符`);
  const payload = { id: questionRecord.id, question: questionRecord.question, matchedInformation: null, verifiedSources: [], truncated: false };
  const mark = item => { payload.truncated = true; if (item) item.truncated = true; };
  const bounded = (value, max, item) => {
    if (typeof value !== 'string') { mark(item); return ''; }
    const parts = Array.from(value);
    if (parts.length > max) mark(item);
    return parts.slice(0, max).join('');
  };
  const safeUrl = value => typeof value === 'string' && chars(value) <= 500 && safeExternalUrl(value) &&
    ![...new URL(value).searchParams.keys()].some(key => /^(?:accessToken|tokenHash|privateHash|api[_-]?key|secret|credential|session[_-]?id)$/i.test(key));

  if (matchedInformation != null) {
    if (typeof matchedInformation !== 'object' || Array.isArray(matchedInformation) || !safeUrl(matchedInformation.sourcePortal)) mark();
    else {
      const item = { title: '', sourcePortal: matchedInformation.sourcePortal, truncated: false };
      item.title = bounded(matchedInformation.title, 120, item);
      for (const [key, max] of [['summary', 500], ['description', 1500]]) if (matchedInformation[key] != null) item[key] = bounded(matchedInformation[key], max, item);
      for (const key of metadataFields) {
        const value = matchedInformation[key];
        if (value === undefined) continue;
        // Keep supplied dates/eligibility literally, or omit invalid/over-budget fields with an incomplete marker.
        if (value === null || typeof value === 'string' || typeof value === 'boolean' || Array.isArray(value) && value.every(entry => typeof entry === 'string')) item[key] = Array.isArray(value) ? [...value] : value;
        else mark(item);
      }
      payload.matchedInformation = item;
    }
  }
  if (!Array.isArray(verifiedSources)) mark();
  else {
    if (verifiedSources.length > 2) mark();
    for (const source of verifiedSources.slice(0, 2)) {
      if (!source || typeof source !== 'object' || !safeUrl(source.url)) { mark(); continue; }
      const item = { title: '', url: source.url, excerpt: '', truncated: false };
      item.title = bounded(source.title, 120, item);
      item.excerpt = bounded(source.excerpt, 1000, item);
      if (typeof source.checkedAt === 'string') item.checkedAt = source.checkedAt;
      payload.verifiedSources.push(item);
    }
  }

  let serialized = JSON.stringify(payload);
  const serialize = () => { serialized = JSON.stringify(payload); return chars(serialized); };
  // JSON escaping also consumes the business-content budget, so measure the actual serialized payload.
  for (const item of [payload.matchedInformation, ...payload.verifiedSources].filter(Boolean)) {
    if (chars(serialized) <= CONTEXT_MAX_CHARS) break;
    mark(item);
    for (const key of ['description', 'summary', 'excerpt', 'checkedAt', ...metadataFields]) {
      if (chars(serialized) <= CONTEXT_MAX_CHARS) break;
      if (!(key in item)) continue;
      delete item[key];
      serialize();
    }
  }
  while (chars(serialized) > CONTEXT_MAX_CHARS && payload.verifiedSources.length) { mark(); payload.verifiedSources.pop(); serialize(); }
  if (chars(serialized) > CONTEXT_MAX_CHARS && payload.matchedInformation) { mark(); payload.matchedInformation = null; serialize(); }
  if (chars(serialized) > CONTEXT_MAX_CHARS) throw new Error('问题上下文超过字符限额');
  return { payload, serialized, truncated: payload.truncated };
}
