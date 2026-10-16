import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { mkdir, lstat, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secureDirectory } from './local-secrets.mjs';
import { ANSWER_MAX_CHARS, QUESTION_MAX_CHARS, POLITICAL_TOPIC_MESSAGE, politicalTopicReason } from '../sources/question-policy.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const RECORD_BYTES = 64 * 1024;
const BODY_BYTES = 8 * 1024;
const STATUSES = new Set(['answered', 'declined', 'needs-info', 'unconfirmed']);
const queues = new Map();
const privateRoot = fileURLToPath(new URL('../.sites-runtime/', import.meta.url));

function fail(statusCode, message) {
  return Object.assign(new Error(message), { statusCode });
}

function text(value, maximum) {
  return typeof value === 'string' && value.trim().length > 0
    && !/[\uD800-\uDFFF]/u.test(value) && [...value].length <= maximum;
}

function object(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
}

function questionInput(input) {
  if (!object(input, ['question', 'contextId']) || !text(input.question, QUESTION_MAX_CHARS)
      || (input.contextId != null && (typeof input.contextId !== 'string'
        || /[\uD800-\uDFFF]/u.test(input.contextId) || [...input.contextId].length > 200))) {
    throw fail(400, '问题格式不正确。');
  }
  return { question: input.question, contextId: input.contextId ?? null };
}

export function validateAssistantPublication(input, { maxAnswerChars = 10000 } = {}) {
  if (!object(input, ['status', 'answer', 'sources', 'model', 'reasoningEffort'])
      || !STATUSES.has(input.status) || !text(input.answer, maxAnswerChars)
      || input.model !== 'gpt-6.1-sol' || input.reasoningEffort !== 'high'
      || !Array.isArray(input.sources) || input.sources.length > 10) {
    throw fail(400, '答复格式不正确。');
  }
  const sources = input.sources.map(source => {
    if (!object(source, ['title', 'url']) || !text(source.title, 200)
        || typeof source.url !== 'string' || source.url.length > 2048
        || source.url.trim() !== source.url || /[\u0000-\u0020\u007f]/u.test(source.url)) {
      throw fail(400, '来源格式不正确。');
    }
    let url;
    try { url = new URL(source.url); } catch { throw fail(400, '来源格式不正确。'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw fail(400, '来源格式不正确。');
    }
    return { title: source.title, url: url.href };
  });
  return { status: input.status, answer: input.answer, sources,
    model: input.model, reasoningEffort: input.reasoningEffort };
}

function publicRecord(record) {
  const { id, question, contextId, createdAt, status, answer, sources } = record;
  const result = { id, question, contextId, createdAt, status, answer, sources };
  if (status !== 'pending') Object.assign(result, {
    answeredAt: record.answeredAt, model: record.model, reasoningEffort: record.reasoningEffort,
  });
  return result;
}

function serial(directory, operation) {
  const previous = queues.get(directory) || Promise.resolve();
  const pending = previous.catch(() => {}).then(async () => {
    const lock = resolve(directory, '.write-lock');
    try { await mkdir(lock, { mode: 0o700 }); }
    catch (error) {
      if (error.code === 'EEXIST') throw fail(503, '问题存储正在处理其他请求，请稍后再试。');
      throw error;
    }
    // shortcut: a crash leaves a fail-closed lock; clear it with all writers stopped, add recovery if needed.
    try { return await operation(); }
    finally { await rmdir(lock); }
  });
  queues.set(directory, pending);
  void pending.finally(() => {
    if (queues.get(directory) === pending) queues.delete(directory);
  }).catch(() => {});
  return pending;
}

export async function createAssistantStore({ directory = resolve(privateRoot, 'assistant-questions'), maxRecords = 200, limits = {} } = {}) {
  directory = resolve(directory);
  const budget = { questionsPerMinute: 10, burst: 5, ...limits };
  if (directory.split(/[\\/]/).some(part => /^(out|public)$/i.test(part))
      || !Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 200
      || !Number.isFinite(budget.questionsPerMinute) || budget.questionsPerMinute <= 0
      || !Number.isInteger(budget.burst) || budget.burst < 1) {
    throw fail(400, '问题存储配置不正确。');
  }
  if (process.platform === 'win32') {
    const path = relative(privateRoot, directory);
    if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) {
      throw fail(400, '问题存储目录必须位于项目私有运行目录。');
    }
    await secureDirectory(directory);
  } else {
    await mkdir(directory, { recursive: true, mode: 0o700 });
  }
  if (!(await lstat(directory)).isDirectory()) throw fail(503, '问题存储暂不可用。');
  let tokens = budget.burst;
  let tokenTime = performance.now();

  const recordPath = id => {
    if (typeof id !== 'string' || !UUID.test(id)) throw fail(404, '问题不存在或访问凭据无效。');
    return resolve(directory, `${id}.json`);
  };
  const ids = async () => (await readdir(directory)).filter(name => UUID.test(name.slice(0, -5)) && name.endsWith('.json')).map(name => name.slice(0, -5));
  async function read(id) {
    const path = recordPath(id);
    let record;
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > RECORD_BYTES) throw fail(503, '问题存储暂不可用。');
      const body = await readFile(path);
      if (body.length > RECORD_BYTES) throw fail(503, '问题存储暂不可用。');
      record = JSON.parse(body.toString('utf8'));
      if (record.id !== id || !/^[0-9a-f]{64}$/.test(record.tokenHash)
          || record.version !== 1 || !text(record.question, QUESTION_MAX_CHARS)
          || typeof record.createdAt !== 'string') throw fail(503, '问题存储暂不可用。');
      questionInput({ question: record.question, contextId: record.contextId });
      if (record.status === 'pending') {
        if (record.answer !== null || !Array.isArray(record.sources) || record.sources.length) throw fail(503, '问题存储暂不可用。');
      } else validateAssistantPublication({ status: record.status, answer: record.answer, sources: record.sources, model: record.model, reasoningEffort: record.reasoningEffort });
      if (record.draft !== undefined) {
        const { draftId, reviewedAt, ...publication } = record.draft;
        if (record.status !== 'pending' || !UUID.test(draftId) || typeof reviewedAt !== 'string'
            || new Date(reviewedAt).toISOString() !== reviewedAt) throw fail(503, '问题存储暂不可用。');
        validateAssistantPublication(publication);
      }
    } catch (error) {
      if (error.code === 'ENOENT') throw fail(404, '问题不存在或访问凭据无效。');
      throw fail(503, '问题存储暂不可用。');
    }
    return record;
  }
  async function save(record) {
    const body = JSON.stringify(record);
    if (Buffer.byteLength(body) > RECORD_BYTES) throw fail(400, '答复过长。');
    const path = recordPath(record.id);
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
  }
  async function authorized(id, token) {
    if (typeof token !== 'string' || !TOKEN.test(token)) throw fail(404, '问题不存在或访问凭据无效。');
    const record = await read(id);
    const actual = createHash('sha256').update(token).digest();
    if (!timingSafeEqual(actual, Buffer.from(record.tokenHash, 'hex'))) throw fail(404, '问题不存在或访问凭据无效。');
    return record;
  }

  return {
    async create(input) {
      const values = questionInput(input);
      if (politicalTopicReason(values.question)) throw fail(422, POLITICAL_TOPIC_MESSAGE);
      return serial(directory, async () => {
        if ((await ids()).length >= maxRecords) throw fail(503, '问题队列已满，请稍后再试。');
        const now = performance.now();
        tokens = Math.min(budget.burst, tokens + (now - tokenTime) * budget.questionsPerMinute / 60000);
        tokenTime = now;
        if (tokens < 1) throw Object.assign(fail(429, '提交较频繁，请稍后再试。'), {
          retryAfter: Math.max(1, Math.ceil((1 - tokens) * 60 / budget.questionsPerMinute)),
        });
        tokens -= 1;
        const id = randomUUID();
        const accessToken = randomBytes(32).toString('base64url');
        const record = { version: 1, id, tokenHash: createHash('sha256').update(accessToken).digest('hex'),
          ...values, createdAt: new Date().toISOString(), status: 'pending', answer: null, sources: [] };
        await save(record);
        return { ...publicRecord(record), accessToken };
      });
    },
    async get(id, token) { return publicRecord(await authorized(id, token)); },
    async delete(id, token) {
      return serial(directory, async () => { await authorized(id, token); await unlink(recordPath(id)); });
    },
    async listPending() {
      return serial(directory, async () => {
        const records = await Promise.all((await ids()).map(read));
        return records.filter(record => record.status === 'pending').map(publicRecord)
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      });
    },
    async adminList() {
      return serial(directory, async () => {
        const records = await Promise.all((await ids()).map(read));
        return records.map(record => ({ ...publicRecord(record),
          ...(record.draft ? { draft: record.draft } : {}) }))
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
      });
    },
    async adminDelete(id) {
      return serial(directory, async () => { await read(id); await unlink(recordPath(id)); });
    },
    async stageDraft(id, input) {
      const values = validateAssistantPublication(input, { maxAnswerChars: ANSWER_MAX_CHARS });
      return serial(directory, async () => {
        const existing = await read(id);
        if (existing.status !== 'pending') throw fail(409, '问题已处理，未覆盖已有答复。');
        if (politicalTopicReason(existing.question) && values.status !== 'declined') throw fail(422, POLITICAL_TOPIC_MESSAGE);
        const draft = { draftId: randomUUID(), ...values, reviewedAt: new Date().toISOString() };
        await save({ ...existing, draft });
        return { ...publicRecord(existing), draft };
      });
    },
    async publishDraft(id, draftId) {
      return serial(directory, async () => {
        const existing = await read(id);
        if (existing.status !== 'pending' || !UUID.test(draftId) || existing.draft?.draftId !== draftId) {
          throw fail(409, '草稿已变化或问题已处理，请刷新后再试。');
        }
        const { draft, ...record } = existing;
        const { draftId: ignoredId, reviewedAt, ...publication } = draft;
        validateAssistantPublication(publication, { maxAnswerChars: ANSWER_MAX_CHARS });
        if (politicalTopicReason(existing.question) && publication.status !== 'declined') throw fail(422, POLITICAL_TOPIC_MESSAGE);
        Object.assign(record, publication, { answeredAt: new Date().toISOString() });
        await save(record);
        return publicRecord(record);
      });
    },
    async publish(id, input) {
      const values = validateAssistantPublication(input, { maxAnswerChars: ANSWER_MAX_CHARS });
      return serial(directory, async () => {
        const existing = await read(id);
        if (existing.status !== 'pending') throw fail(409, '问题已处理，未覆盖已有答复。');
        if (politicalTopicReason(existing.question) && values.status !== 'declined') throw fail(422, POLITICAL_TOPIC_MESSAGE);
        const { draft, ...record } = existing;
        Object.assign(record, values, { answeredAt: new Date().toISOString() });
        await save(record);
        return publicRecord(record);
      });
    },
  };
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (typeof origin !== 'string' || typeof host !== 'string' || /[\s/@\\?#]/u.test(host)) return false;
  try {
    const url = new URL(origin);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && url.origin === origin && origin === `${url.protocol}//${host}`;
  } catch { return false; }
}

async function jsonBody(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(req.headers['content-type'] || '')) throw fail(415, '请提交 JSON 格式。');
  if (Number(req.headers['content-length']) > BODY_BYTES) throw fail(413, '提交内容过长。');
  const body = await new Promise((done, reject) => {
    let bytes = 0;
    const chunks = [];
    let exceeded = false;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > BODY_BYTES) {
        if (!exceeded) { exceeded = true; reject(fail(413, '提交内容过长。')); }
      } else if (!exceeded) chunks.push(chunk);
    });
    req.once('end', () => { if (!exceeded) done(Buffer.concat(chunks)); });
    req.once('error', () => reject(fail(400, '提交未完成。')));
    req.once('aborted', () => reject(fail(400, '提交未完成。')));
  });
  try { return JSON.parse(body.toString('utf8')); }
  catch { throw fail(400, 'JSON 格式不正确。'); }
}

export async function handleAssistantRequest(req, res, store) {
  const rawPath = (req.url || '').split('?')[0];
  if (rawPath !== '/api/assistant' && !rawPath.startsWith('/api/assistant/')) return false;
  const send = (status, value) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (status !== 204) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeHead(status);
    res.end(status === 204 || req.method === 'HEAD' ? undefined : JSON.stringify(value));
  };
  const rejectBody = () => {
    if (Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'] !== undefined) {
      res.setHeader('Connection', 'close');
      throw fail(400, '此请求不接受正文。');
    }
  };
  try {
    if (req.method === 'GET' && rawPath === '/api/assistant/status') {
      rejectBody();
      send(200, { acceptsQuestions: true, automaticAnswers: false });
    } else if (req.method === 'POST' && rawPath === '/api/assistant/questions') {
      if (!sameOrigin(req)) throw fail(403, '仅允许本站提交。');
      send(201, await store.create(await jsonBody(req)));
    } else {
      const id = rawPath.match(/^\/api\/assistant\/questions\/([0-9a-f-]+)$/)?.[1];
      if (!id || !UUID.test(id) || !['GET', 'DELETE'].includes(req.method)) throw fail(404, '接口不存在。');
      if (req.method === 'DELETE' && !sameOrigin(req)) throw fail(403, '仅允许本站提交。');
      rejectBody();
      const token = req.headers.authorization?.match(/^Bearer ([A-Za-z0-9_-]{43})$/)?.[1];
      if (req.method === 'GET') send(200, await store.get(id, token));
      else { await store.delete(id, token); send(204); }
    }
  } catch (error) {
    if (!res.headersSent) {
      const status = [400, 403, 404, 413, 415, 422, 429, 503].includes(error.statusCode) ? error.statusCode : 503;
      if ([413, 415].includes(status)) res.setHeader('Connection', 'close');
      if (status === 429) res.setHeader('Retry-After', String(error.retryAfter || 6));
      send(status, { error: status === 503 ? '问题服务暂不可用，请稍后再试。' : error.message });
    }
  }
  return true;
}
