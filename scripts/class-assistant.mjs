import { assistantError, costMicros, exactObject, SESSION_MS } from './class-assistant-config.mjs';
import { createClassAssistantProvider } from './class-assistant-provider.mjs';
import { digest, validRequestId } from './class-assistant-store.mjs';
import { QUESTION_MAX_CHARS } from '../sources/question-policy.mjs';
import { CHAT_BODY_MAX_BYTES, validateConversationHistory } from '../sources/class-assistant-conversation.mjs';

const cookieName = 'sanjiang_class_assistant';
const prefix = '/api/class-assistant/';
const endpoints = new Set(['session', 'login', 'logout', 'chat']);
const bodyLimit = CHAT_BODY_MAX_BYTES;

export function validatePublicOrigin(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error('PUBLIC_ORIGIN必须是固定的同源URL。'); }
  if (url.origin !== value || url.username || url.password || !['http:', 'https:'].includes(url.protocol)
    || url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('公网PUBLIC_ORIGIN必须使用HTTPS；本机可使用HTTP。');
  return url;
}

function tokenFrom(req) {
  const values = typeof req.headers.cookie === 'string' ? req.headers.cookie.split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`)) : [];
  return values.length === 1 && /^[A-Za-z0-9_-]{43}$/.test(values[0].slice(cookieName.length + 1)) ? values[0].slice(cookieName.length + 1) : null;
}

async function readJson(req) {
  if (req.headers['transfer-encoding'] || !/^application\/json(?:;\s*charset=utf-8)?$/i.test(req.headers['content-type'] || '')
    || Number(req.headers['content-length'] || 0) > bodyLimit) throw assistantError(415, 'invalid_body', '请求必须使用限长的JSON格式。');
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > bodyLimit) throw assistantError(413, 'body_too_large', '请求内容过长。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw assistantError(400, 'invalid_json', 'JSON请求格式不正确。'); }
}

export function createClassAssistantHandler({ config, store, publicOrigin, apiKey = process.env[config.apiKeyEnv] || '', fetchImpl, publicItems = [], allowedMemberIds }) {
  const origin = validatePublicOrigin(publicOrigin);
  if (allowedMemberIds !== undefined && (!(allowedMemberIds instanceof Set) || allowedMemberIds.size < 1
    || [...allowedMemberIds].some(id => typeof id !== 'string' || !store.member(id)))) throw new Error('测试访问策略无效，服务不会开放。');
  const allowed = allowedMemberIds === undefined ? undefined : new Set(allowedMemberIds);
  const permits = memberId => allowed === undefined || allowed.has(memberId);
  const contextOwner = memberId => digest(`class-assistant-conversation-owner:${memberId}`);
  const provider = createClassAssistantProvider({ config, apiKey, fetchImpl, publicItems });
  let stopping = false;
  const inFlight = new Set();
  const cookie = (token, clear = false) => `${cookieName}=${clear ? '' : token}; Path=/api/class-assistant; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : SESSION_MS / 1000}${origin.protocol === 'https:' ? '; Secure' : ''}`;
  function readiness(memberId = null) {
    if (!store.configured()) return '班级名单尚未初始化。';
    if (store.halted()) return '费用核对异常，所有付费请求已暂停，请联系站长。';
    if (!config.enabled) return '付费服务尚未启用。';
    if (!config.pricingConfirmed) return '站长尚未确认模型价格。';
    if (!apiKey) return '模型服务尚未配置，仍可查看本人额度。';
    if (memberId && store.blocked(memberId)) return '上次请求尚待站长核对，暂不能继续消费。';
    return null;
  }
  function session(memberId = null) {
    if (memberId && !permits(memberId)) memberId = null;
    const member = memberId ? store.member(memberId) : null;
    const reason = readiness(memberId);
    const enabled = reason === null;
    return { configured: store.configured(), authenticated: Boolean(member), enabled, ...(reason ? { reason } : {}), ...(member ? { member, contextOwner: contextOwner(memberId) } : {}),
      models: config.models.map(model => {
        const estimate = costMicros(model.prices, 1000, 0, 500);
        const quota = store.modelQuota(memberId, model.key);
        const affordable = !member || quota.remainingMicros >= costMicros(model.prices, 1, 0, model.maxOutputTokens);
        const modelReason = !model.enabled ? '此模型已停用。' : reason || (!affordable
          ? model.key === 'astra' ? 'Astra终身子额度或总余额不足以预留输出上限，可选择其它模型。' : '余额不足以预留此模型的输出上限。' : null);
        return { key: model.key, label: model.label, available: enabled && model.enabled && affordable,
          ...(modelReason ? { reason: modelReason } : {}), inputPerMillion: model.inputPerMillion,
          cachedInputPerMillion: model.cachedInputPerMillion, outputPerMillion: model.outputPerMillion,
          maxOutputTokens: model.maxOutputTokens, ...quota, estimatedMessages: member ? Math.floor(quota.remainingMicros / estimate) : 0 };
      }), estimatedInputTokens: 1000, estimatedOutputTokens: 500 };
  }
  const result = (memberId, row) => ({ ...session(memberId), requestId: row.id, answer: row.answer || '该请求已由站长依据上游账单核对。', status: row.status, chargedMicros: row.charged });
  function previous(memberId, row) {
    if (!row) return null;
    if (row.status === 'reserved') throw assistantError(409, 'request_pending', '同一请求正在处理中，请勿重复提交。');
    if (row.status === 'held') throw assistantError(423, 'request_held', '本次请求结果待核对，费用预留未释放，请联系站长。');
    return result(memberId, row);
  }
  async function chat(memberId, input) {
    if (stopping) throw assistantError(503, 'service_stopping', '服务正在停止，请稍后再试。');
    if (!permits(memberId)) throw assistantError(401, 'authentication_required', '请先使用本人学号登录。');
    const keys = ['modelKey', 'message', 'requestId'];
    if (input && Object.hasOwn(input, 'history')) keys.push('history');
    if (input && Object.hasOwn(input, 'contextOwner')) keys.push('contextOwner');
    if (!exactObject(input, keys) || !validRequestId(input.requestId)
      || typeof input.message !== 'string' || !input.message.trim() || [...input.message].length > QUESTION_MAX_CHARS
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(input.message)
      || typeof input.modelKey !== 'string' || !config.models.some(model => model.key === input.modelKey)) throw assistantError(400, 'invalid_question', '请提交500字符以内的问题、允许的模型和唯一请求编号。');
    let history;
    try { history = validateConversationHistory(input.history); }
    catch (error) { throw assistantError(400, 'invalid_history', error.message); }
    if ((history.length || Object.hasOwn(input, 'contextOwner')) && input.contextOwner !== contextOwner(memberId)) {
      throw assistantError(409, 'context_owner_changed', '对话账户已变化或无法确认，请开启新对话并刷新登录后再试；未发送付费请求。');
    }
    const message = input.message.trim();
    const fingerprint = digest(JSON.stringify(history.length ? [input.modelKey, message, history] : [input.modelKey, message]));
    const replay = previous(memberId, store.request(input.requestId, memberId, fingerprint));
    if (replay) return replay;
    const reason = readiness(memberId);
    if (reason) throw assistantError(store.blocked(memberId) ? 423 : 503, store.blocked(memberId) ? 'account_held' : 'service_disabled', reason);
    const model = config.models.find(item => item.key === input.modelKey);
    if (!model.enabled) throw assistantError(400, 'model_disabled', '此模型暂不可用。');
    store.throttle(`chat:${memberId}`, 10);
    const { modelInput } = provider.payload(message, input.requestId, model, history);
    const inputTokens = await provider.count(model, modelInput);
    if (stopping) throw assistantError(503, 'service_stopping', '服务正在停止，未发送付费请求。');
    const reservation = costMicros(model.prices, inputTokens, 0, model.maxOutputTokens);
    const reserved = store.reserve({ requestId: input.requestId, memberId, fingerprint, model, inputTokens, reservation });
    if (!reserved.created) return previous(memberId, reserved.request);
    let response;
    try {
      // Exactly one transmission. An ambiguous result is held durably and never retried automatically.
      response = await provider.respond(model, modelInput);
      const settlement = provider.settlement(response, model, inputTokens);
      if (settlement.chargedMicros > reservation) {
        store.halt(input.requestId, { ...settlement, reason: 'actual_cost_exceeds_reservation' });
        throw new Error('billing_halted');
      }
      const outcome = store.settle(input.requestId, settlement);
      return { ...session(memberId), ...outcome };
    } catch (error) {
      if (error.billingHalt) {
        store.halt(input.requestId, { reason: 'unexpected_cache_write', chargedMicros: null,
          usage: error.rawUsage, providerId: typeof error.providerId === 'string' ? error.providerId.slice(0, 210) : null });
      } else if (Number.isSafeInteger(error.observedCharge) && error.observedCharge > reservation) {
        store.halt(input.requestId, { reason: 'actual_cost_exceeds_reservation', chargedMicros: error.observedCharge,
          usage: error.usage, providerId: typeof error.providerId === 'string' ? error.providerId : null });
      } else store.hold(input.requestId, 'upstream_result_unconfirmed', typeof response?.id === 'string' ? response.id.slice(0, 210) : null);
      throw assistantError(423, 'request_held', '本次结果或费用无法确认，预留款项已冻结；请联系站长，勿重新付费重试。');
    }
  }
  const handleRequest = async (req, res) => {
    const rawPath = req.url?.split('?')[0] || '';
    if (rawPath !== '/api/class-assistant' && !rawPath.startsWith(prefix)) return false;
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const send = (status, body) => { if (res.destroyed || res.writableEnded) return; res.writeHead(status); res.end(JSON.stringify(body)); };
    try {
      const endpoint = rawPath.slice(prefix.length);
      if (!endpoints.has(endpoint) || req.url !== rawPath) throw assistantError(404, 'not_found', '接口不存在。');
      if (req.headers.host !== origin.host || req.headers.origin !== undefined && req.headers.origin !== origin.origin
        || req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) throw assistantError(403, 'origin_rejected', '请求来源不受允许。');
      const expectedMethod = endpoint === 'session' ? 'GET' : 'POST';
      if (req.method !== expectedMethod) { res.setHeader('Allow', expectedMethod); throw assistantError(405, 'method_not_allowed', '请求方法不受支持。'); }
      const token = tokenFrom(req);
      const memberId = store.authenticate(token, { allowedMemberIds: allowed });
      if (endpoint === 'session') {
        if (req.headers['transfer-encoding'] || Number(req.headers['content-length'] || 0) > 0) throw assistantError(400, 'invalid_body', '此接口不接受请求体。');
        send(200, session(memberId));
        return true;
      }
      if (req.headers.origin !== origin.origin) throw assistantError(403, 'origin_rejected', '请求来源不受允许。');
      if (endpoint === 'login') {
        store.throttle('login:global', 30);
        store.throttle(`login:ip:${digest(req.socket?.remoteAddress || 'unknown')}`, 10);
      }
      const input = await readJson(req);
      if (endpoint === 'login') {
        if (!exactObject(input, ['accessCode']) || typeof input.accessCode !== 'string' || input.accessCode.length > 512) throw assistantError(401, 'login_failed', '学号无效或暂不可用。');
        const logged = store.login(input.accessCode, token, { allowedMemberIds: allowed });
        res.setHeader('Set-Cookie', cookie(logged.token));
        send(200, session(logged.memberId));
      } else if (endpoint === 'logout') {
        if (!exactObject(input, [])) throw assistantError(400, 'invalid_body', '退出请求格式不正确。');
        store.logout(token);
        res.setHeader('Set-Cookie', cookie('', true));
        send(200, session());
      } else {
        if (!memberId) throw assistantError(401, 'authentication_required', '请先使用本人学号登录。');
        send(200, await chat(memberId, input));
      }
    } catch (error) {
      send(Number.isInteger(error.status) ? error.status : 500, { error: error.status ? error.message : '班级助手暂不可用。', code: error.code && error.status ? error.code : 'internal_error' });
    }
    return true;
  };
  const handler = (req, res) => {
    const task = handleRequest(req, res);
    inFlight.add(task);
    task.then(() => inFlight.delete(task), () => inFlight.delete(task));
    return task;
  };
  handler.session = session;
  handler.stop = () => { stopping = true; };
  handler.drain = async () => { stopping = true; await Promise.allSettled([...inFlight]); };
  return handler;
}
