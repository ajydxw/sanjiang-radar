import { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { secureDirectory } from './local-secrets.mjs';

const derive = promisify(scrypt);
const root = fileURLToPath(new URL('../.sites-runtime/', import.meta.url));
const COOKIE = 'sanjiang_admin';
const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const USERNAME = /^[A-Za-z0-9_.-]{2,40}$/;
const digest = value => createHash('sha256').update(value).digest('hex');
export const adminError = (statusCode, message) => Object.assign(new Error(message), { statusCode });

export function adminSecurityHeaders(res, scriptHash) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-DNS-Prefetch-Control', 'off');
  res.setHeader('X-Download-Options', 'noopen');
  res.setHeader('X-Permitted-Cross-Domain-Policies', 'none');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.setHeader('Origin-Agent-Cluster', '?1');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', `default-src 'none'; script-src ${scriptHash ? `'sha256-${scriptHash}'` : "'none'"}; style-src 'unsafe-inline'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`);
}

export function exactAdminOrigin(req) {
  const { origin, host } = req.headers;
  if (typeof origin !== 'string' || typeof host !== 'string' || /[\s/@\\?#]/u.test(host)) return null;
  try {
    const url = new URL(origin);
    if (url.origin !== origin || origin !== `${url.protocol}//${host}` || url.username || url.password) return null;
    if (url.protocol === 'https:') return url;
    if (url.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(url.hostname)) return url;
  } catch {}
  return null;
}

export function rejectAdminBody(req) {
  if (Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'] !== undefined) {
    throw adminError(400, '此请求不接受正文。');
  }
}

export async function readAdminJson(req) {
  if (!/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(req.headers['content-type'] || '')) throw adminError(415, '请提交 JSON 格式。');
  if (Number(req.headers['content-length']) > 4096) throw adminError(413, '提交内容过长。');
  const body = await new Promise((done, reject) => {
    const chunks = [];
    let bytes = 0, exceeded = false;
    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > 4096) {
        if (!exceeded) { exceeded = true; reject(adminError(413, '提交内容过长。')); }
      } else if (!exceeded) chunks.push(chunk);
    });
    req.once('end', () => { if (!exceeded) done(Buffer.concat(chunks)); });
    req.once('error', () => reject(adminError(400, '提交未完成。')));
    req.once('aborted', () => reject(adminError(400, '提交未完成。')));
  });
  try { return JSON.parse(body.toString('utf8')); }
  catch { throw adminError(400, 'JSON 格式不正确。'); }
}

export function adminObject(value, keys) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).every(key => keys.includes(key));
}

function validPassword(value) {
  return typeof value === 'string' && !/[\uD800-\uDFFF]/u.test(value)
    && [...value].length >= 10 && [...value].length <= 128;
}

export async function createAdminAuth({ username = 'admin', directory = resolve(root, 'admin'), limits = {}, sessionMs = 8 * 60 * 60 * 1000 } = {}) {
  directory = resolve(directory);
  const budget = { loginsPerMinute: 5, burst: 5, ...limits };
  if (typeof username !== 'string' || !USERNAME.test(username)
      || directory.split(/[\\/]/).some(part => /^(out|public)$/i.test(part))
      || !Number.isFinite(sessionMs) || sessionMs <= 0 || sessionMs > 8 * 60 * 60 * 1000
      || !Number.isFinite(budget.loginsPerMinute) || budget.loginsPerMinute <= 0
      || !Number.isInteger(budget.burst) || budget.burst < 1) throw adminError(400, '管理员配置不正确。');
  if (process.platform === 'win32') {
    const path = relative(root, directory);
    if (isAbsolute(path) || path === '..' || path.startsWith(`..${sep}`)) throw adminError(400, '管理员存储须位于私有运行目录。');
    await secureDirectory(directory);
  } else {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    if (!(await lstat(directory)).isDirectory()) throw adminError(503, '管理员服务暂不可用。');
    await chmod(directory, 0o700);
  }
  if (!(await lstat(directory)).isDirectory()) throw adminError(503, '管理员服务暂不可用。');
  const credentialsPath = resolve(directory, 'credentials.json');
  const sessions = new Map();
  let revision = null;
  let tokens = budget.burst, tokenTime = performance.now();
  async function credentials() {
    try {
      const info = await lstat(credentialsPath);
      if (!info.isFile() || info.size > 2048) throw new Error();
      const data = await readFile(credentialsPath);
      if (data.length > 2048) throw new Error();
      const value = JSON.parse(data.toString('utf8'));
      if (!adminObject(value, ['version', 'username', 'salt', 'hash', 'revision'])
          || value.version !== 1 || typeof value.username !== 'string' || !USERNAME.test(value.username) || !UUID.test(value.revision)
          || !/^[a-f0-9]{64}$/.test(value.salt) || !/^[a-f0-9]{128}$/.test(value.hash)) throw new Error();
      if (revision !== value.revision) { sessions.clear(); revision = value.revision; }
      return value;
    } catch (error) {
      sessions.clear(); revision = null;
      if (error.code === 'ENOENT') return null;
      throw adminError(503, '管理员服务暂不可用。');
    }
  }
  function tokenFrom(req) {
    if (typeof req.headers.cookie !== 'string') return null;
    const values = req.headers.cookie.split(';').map(part => part.trim()).filter(part => part.startsWith(`${COOKIE}=`));
    if (values.length !== 1) return null;
    const token = values[0].slice(COOKIE.length + 1);
    return TOKEN.test(token) ? token : null;
  }
  async function session(req) {
    const current = await credentials();
    for (const [key, value] of sessions) if (value.expiresAt <= Date.now()) sessions.delete(key);
    const token = tokenFrom(req);
    const value = current && token ? sessions.get(digest(token)) : null;
    return { configured: Boolean(current), authenticated: Boolean(value), username: value ? current.username : null,
      csrfToken: value?.csrfToken ?? null };
  }
  return {
    session,
    async getUsername() { return (await credentials())?.username ?? username; },
    async authorize(req, requireCsrf = false) {
      const value = await session(req);
      if (!value.authenticated) throw adminError(401, '请先登录管理员账号。');
      const csrf = req.headers['x-csrf-token'];
      if (requireCsrf && (typeof csrf !== 'string' || !TOKEN.test(csrf)
          || !timingSafeEqual(Buffer.from(csrf), Buffer.from(value.csrfToken)))) throw adminError(403, '登录校验已失效，请刷新后再试。');
      return value;
    },
    async login(input) {
      const now = performance.now();
      tokens = Math.min(budget.burst, tokens + (now - tokenTime) * budget.loginsPerMinute / 60000); tokenTime = now;
      if (tokens < 1) throw Object.assign(adminError(429, '登录较频繁，请稍后再试。'), {
        retryAfter: Math.max(1, Math.ceil((1 - tokens) * 60 / budget.loginsPerMinute)),
      });
      tokens -= 1;
      if (!adminObject(input, ['username', 'password']) || typeof input.username !== 'string' || !USERNAME.test(input.username) || !validPassword(input.password)) throw adminError(401, '账号或密码不正确。');
      const current = await credentials();
      if (!current) throw adminError(401, '请先在站长电脑设置管理员密码。');
      if (input.username !== current.username) throw adminError(401, '账号或密码不正确。');
      const actual = await derive(input.password, Buffer.from(current.salt, 'hex'), 64);
      if (!timingSafeEqual(actual, Buffer.from(current.hash, 'hex'))) throw adminError(401, '账号或密码不正确。');
      if ((await credentials())?.revision !== current.revision) throw adminError(401, '密码已更新，请重新登录。');
      const token = randomBytes(32).toString('base64url');
      const csrfToken = randomBytes(32).toString('base64url');
      while (sessions.size >= 5) sessions.delete(sessions.keys().next().value);
      sessions.set(digest(token), { csrfToken, expiresAt: Date.now() + sessionMs });
      return { token, dto: { configured: true, authenticated: true, username: current.username, csrfToken } };
    },
    async logout(req) { const token = tokenFrom(req); if (token) sessions.delete(digest(token)); },
    cookie(token, secure = false, clear = false) {
      return `${COOKIE}=${clear ? '' : token}; HttpOnly; SameSite=Strict; Path=/api/admin; Max-Age=${clear ? 0 : Math.ceil(sessionMs / 1000)}${secure ? '; Secure' : ''}`;
    },
    async setPassword(password) {
      if (!validPassword(password)) throw adminError(400, '密码须为 10 至 128 个字符。');
      const currentUsername = (await credentials())?.username ?? username;
      const salt = randomBytes(32);
      const hash = await derive(password, salt, 64);
      const value = { version: 1, username: currentUsername, salt: salt.toString('hex'), hash: hash.toString('hex'), revision: randomUUID() };
      const temporary = `${credentialsPath}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
        await rename(temporary, credentialsPath);
      } finally { await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      sessions.clear(); revision = value.revision;
    },
  };
}

export async function handleAdminRequest(req, res, { auth, store }) {
  const path = (req.url || '').split('?')[0];
  if (path !== '/api/admin' && !path.startsWith('/api/admin/')) return false;
  adminSecurityHeaders(res);
  const send = (status, value) => {
    if (status !== 204) res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.writeHead(status); res.end(status === 204 || req.method === 'HEAD' ? undefined : JSON.stringify(value));
  };
  try {
    if ((req.url || '').includes('?')) throw adminError(400, '管理接口不接受查询参数。');
    const origin = ['POST', 'DELETE'].includes(req.method) ? exactAdminOrigin(req) : null;
    if (['POST', 'DELETE'].includes(req.method) && !origin) throw adminError(403, '仅允许本站安全提交。');
    if (['GET', 'DELETE'].includes(req.method)) rejectAdminBody(req);
    if (req.method === 'GET' && path === '/api/admin/session') send(200, await auth.session(req));
    else if (req.method === 'POST' && path === '/api/admin/login') {
      const result = await auth.login(await readAdminJson(req));
      res.setHeader('Set-Cookie', auth.cookie(result.token, origin.protocol === 'https:')); send(200, result.dto);
    } else if (req.method === 'POST' && path === '/api/admin/logout') {
      await auth.authorize(req, true);
      const input = await readAdminJson(req);
      if (!adminObject(input, [])) throw adminError(400, '退出请求格式不正确。');
      await auth.logout(req);
      res.setHeader('Set-Cookie', auth.cookie('', origin.protocol === 'https:', true)); send(204);
    } else if (req.method === 'GET' && path === '/api/admin/questions') {
      await auth.authorize(req);
      const items = await store.adminList();
      const stats = { total: items.length, pending: 0, ready: 0, answered: 0, declined: 0, needsInfo: 0, unconfirmed: 0 };
      for (const item of items) { stats[item.status === 'needs-info' ? 'needsInfo' : item.status] += 1; if (item.draft) stats.ready += 1; }
      send(200, { items, stats, processing: { mode: 'owner-triggered', automaticAnswers: false, model: 'gpt-6.1-sol', reasoningEffort: 'high' } });
    } else {
      const match = path.match(/^\/api\/admin\/questions\/([0-9a-f-]+)(\/publish)?$/);
      if (!match || !UUID.test(match[1]) || (match[2] ? req.method !== 'POST' : req.method !== 'DELETE')) throw adminError(404, '接口不存在。');
      await auth.authorize(req, true);
      if (!match[2]) { await store.adminDelete(match[1]); send(204); }
      else {
        const input = await readAdminJson(req);
        if (!adminObject(input, ['draftId']) || !UUID.test(input.draftId)) throw adminError(400, '草稿格式不正确。');
        send(200, await store.publishDraft(match[1], input.draftId));
      }
    }
  } catch (error) {
    const status = [400, 401, 403, 404, 409, 413, 415, 422, 429, 503].includes(error.statusCode) ? error.statusCode : 503;
    if ([400, 413, 415].includes(status)) res.setHeader('Connection', 'close');
    if (status === 429) res.setHeader('Retry-After', String(error.retryAfter || 12));
    if (!res.headersSent) send(status, { error: status === 503 ? '管理员服务暂不可用，请稍后再试。' : error.message });
  }
  return true;
}
