import { createHash, randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminError, adminObject, adminSecurityHeaders, exactAdminOrigin, readAdminJson, rejectAdminBody } from './admin-auth.mjs';
import { readSecret, secureDirectory } from './local-secrets.mjs';

const privateRoot = fileURLToPath(new URL('../.sites-runtime/identity/', import.meta.url));
const cookieName = 'sanjiang_identity';
const tokenPattern = /^[A-Za-z0-9_-]{43}$/;
const mismatch = '姓名或学号不匹配，请检查后重试。';
const unavailable = '身份确认暂未开放，请直接浏览。';
const digest = value => createHash('sha256').update(value).digest('hex');
const validName = value => typeof value === 'string' && [...value].length >= 1 && [...value].length <= 40 && !/\p{C}/u.test(value);
const validId = value => typeof value === 'string' && /^[0-9]{1,32}$/.test(value);

function rosterMap(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > 1000) throw new Error('Invalid private roster');
  const result = new Map();
  for (const row of rows) {
    if (!adminObject(row, ['name', 'studentId']) || !validName(row.name) || row.name !== row.name.trim()
      || !validId(row.studentId) || result.has(row.studentId)) throw new Error('Invalid private roster');
    result.set(row.studentId, row.name);
  }
  return result;
}

async function privateRoster(path) {
  path = resolve(path);
  const inside = relative(privateRoot, path);
  if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`) || !path.endsWith('.dpapi')) throw new Error('Invalid private roster path');
  // The existing helper checks reparse points and restricts access to the Windows user and SYSTEM.
  await secureDirectory(dirname(path));
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8192) throw new Error('Invalid private roster file');
  return rosterMap(JSON.parse(await readSecret(path)));
}

export async function createIdentityAuth({ roster, rosterPath, sessionMs = 8 * 60 * 60 * 1000, limits = {} } = {}) {
  const budget = { globalPerMinute: 10, globalBurst: 10, ipPerMinute: 5, ipBurst: 5, ...limits };
  if (!Number.isFinite(sessionMs) || sessionMs <= 0 || sessionMs > 8 * 60 * 60 * 1000
    || Object.values(budget).some(value => !Number.isFinite(value) || value <= 0)
    || (roster !== undefined && rosterPath !== undefined)) throw new Error('Invalid identity configuration');
  let rows = null;
  if (roster !== undefined) rows = rosterMap(roster);
  else if (rosterPath !== undefined) {
    try { rows = await privateRoster(rosterPath); }
    catch { /* Missing, inaccessible or invalid private data keeps the feature closed. */ }
  }
  const sessions = new Map();
  const addresses = new Map();
  const global = { tokens: budget.globalBurst, at: performance.now() };
  function take(bucket, capacity, perMinute, now) {
    bucket.tokens = Math.min(capacity, bucket.tokens + (now - bucket.at) * perMinute / 60000);
    bucket.at = now;
    if (bucket.tokens < 1) throw Object.assign(adminError(429, '确认尝试较频繁，请稍后再试。'), { retryAfter: Math.max(1, Math.ceil((1 - bucket.tokens) * 60 / perMinute)) });
    bucket.tokens -= 1;
  }
  function throttle(req) {
    const now = performance.now();
    take(global, budget.globalBurst, budget.globalPerMinute, now);
    // Forwarded headers are untrusted; a proxy's clients share its socket-IP limit.
    const address = req.socket?.remoteAddress || 'unknown';
    for (const [key, value] of addresses) if (now - value.at > 60000) addresses.delete(key);
    if (!addresses.has(address)) {
      if (addresses.size >= 256) throw adminError(429, '确认尝试较频繁，请稍后再试。');
      addresses.set(address, { tokens: budget.ipBurst, at: now });
    }
    take(addresses.get(address), budget.ipBurst, budget.ipPerMinute, now);
  }
  function tokenFrom(req) {
    const values = typeof req.headers.cookie === 'string' ? req.headers.cookie.split(';').map(value => value.trim()).filter(value => value.startsWith(`${cookieName}=`)) : [];
    const token = values.length === 1 ? values[0].slice(cookieName.length + 1) : null;
    return token && tokenPattern.test(token) ? token : null;
  }
  function sweep() { for (const [key, value] of sessions) if (value.expiresAt <= Date.now()) sessions.delete(key); }
  function dto(name = null) { return { enabled: Boolean(rows), confirmed: name !== null, name }; }
  return {
    session(req) {
      sweep();
      const token = tokenFrom(req);
      return dto(rows && token ? sessions.get(digest(token))?.name ?? null : null);
    },
    attempt(req) {
      if (!rows) throw adminError(503, unavailable);
      throttle(req);
    },
    confirm(input, req) {
      if (!rows) throw adminError(503, unavailable);
      if (!adminObject(input, ['name', 'studentId']) || typeof input.name !== 'string' || typeof input.studentId !== 'string'
        || !validName(input.name.trim()) || !validId(input.studentId.trim())) throw adminError(401, mismatch);
      const name = input.name.trim(), studentId = input.studentId.trim();
      if (rows.get(studentId) !== name) throw adminError(401, mismatch);
      sweep();
      const previous = tokenFrom(req);
      if (previous) sessions.delete(digest(previous));
      while (sessions.size >= 256) sessions.delete(sessions.keys().next().value);
      const token = randomBytes(32).toString('base64url');
      sessions.set(digest(token), { name, expiresAt: Date.now() + sessionMs });
      return { token, dto: dto(name) };
    },
    logout(req) { const token = tokenFrom(req); if (token) sessions.delete(digest(token)); },
    cookie(token, secure = false, clear = false) {
      return `${cookieName}=${clear ? '' : token}; HttpOnly; SameSite=Strict; Path=/api/identity; Max-Age=${clear ? 0 : Math.ceil(sessionMs / 1000)}${secure ? '; Secure' : ''}`;
    },
  };
}

export async function handleIdentityRequest(req, res, auth) {
  const path = (req.url || '').split('?')[0];
  if (path !== '/api/identity' && !path.startsWith('/api/identity/')) return false;
  adminSecurityHeaders(res);
  const send = (status, value) => {
    if (status !== 204) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeHead(status); res.end(status === 204 || req.method === 'HEAD' ? undefined : JSON.stringify(value));
  };
  try {
    if ((req.url || '').includes('?')) throw adminError(400, '身份接口不接受查询参数。');
    const origin = req.method === 'POST' ? exactAdminOrigin(req) : null;
    if (req.method === 'POST' && !origin) throw adminError(403, '仅允许本站安全提交。');
    if (req.method === 'GET' && path === '/api/identity/session') {
      rejectAdminBody(req); send(200, auth.session(req));
    } else if (req.method === 'POST' && path === '/api/identity/confirm') {
      auth.attempt(req);
      const result = auth.confirm(await readAdminJson(req), req);
      res.setHeader('Set-Cookie', auth.cookie(result.token, origin.protocol === 'https:'));
      send(200, result.dto);
    } else if (req.method === 'POST' && path === '/api/identity/logout') {
      if (!adminObject(await readAdminJson(req), [])) throw adminError(400, '退出请求格式不正确。');
      auth.logout(req);
      res.setHeader('Set-Cookie', auth.cookie('', origin.protocol === 'https:', true)); send(204);
    } else throw adminError(404, '接口不存在。');
  } catch (error) {
    const status = [400, 401, 403, 404, 413, 415, 429, 503].includes(error.statusCode) ? error.statusCode : 503;
    if ([400, 413, 415, 503].includes(status)) res.setHeader('Connection', 'close');
    if (status === 429) res.setHeader('Retry-After', String(error.retryAfter || 12));
    if (!res.headersSent) send(status, { error: status === 503 ? unavailable : error.message });
  }
  return true;
}
