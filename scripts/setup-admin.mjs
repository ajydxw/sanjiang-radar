import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { adminError, adminObject, adminSecurityHeaders, createAdminAuth, exactAdminOrigin, readAdminJson, rejectAdminBody } from './admin-auth.mjs';

export function createAdminSetupServer({ auth } = {}) {
  if (!auth) throw new Error('需要本机管理员存储。');
  const csrfToken = randomBytes(32).toString('base64url');
  const script = `const form=document.getElementById('setup');const status=document.getElementById('status');form.addEventListener('submit',async event=>{event.preventDefault();const button=form.querySelector('button');const password=document.getElementById('password').value;const confirmPassword=document.getElementById('confirm').value;if(password!==confirmPassword){status.textContent='两次密码不一致。';return;}button.disabled=true;status.textContent='正在保存…';try{const response=await fetch('/setup',{method:'POST',headers:{'Content-Type':'application/json','X-CSRF-Token':${JSON.stringify(csrfToken)}},body:JSON.stringify({password,confirmPassword})});const result=await response.json();if(!response.ok)throw new Error(result.error);form.reset();status.textContent='管理员密码已设置；之前的登录已失效。现在可返回网站后台登录。';}catch(error){status.textContent=error.message||'保存失败，请稍后再试。';}finally{button.disabled=false;}});`;
  const scriptHash = createHash('sha256').update(script).digest('base64');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>三江雷达 · 本机设置管理员</title><style>body{font:17px/1.6 system-ui,sans-serif;background:#f2f5f3;color:#1b302b;margin:0;padding:24px}main{max-width:480px;margin:5vh auto;background:white;padding:28px;border-radius:20px}h1{font-size:26px}label{display:block;margin:18px 0}input,button{box-sizing:border-box;width:100%;font:inherit;padding:12px;border:1px solid #a6b9af;border-radius:8px}button{background:#185e43;color:white;cursor:pointer}button:disabled{opacity:.6}#status{min-height:3em}</style><main><h1>设置管理员密码</h1><p>账号：<strong>{{username}}</strong>。本页仅在站长电脑开放；设置或重设后，之前的登录立即失效。</p><form id="setup"><label for="password">新密码（10–128 个字符）</label><input id="password" type="password" autocomplete="new-password" required minlength="10" maxlength="256"><label for="confirm">再次输入新密码</label><input id="confirm" type="password" autocomplete="new-password" required minlength="10" maxlength="256"><p><button type="submit">保存管理员密码</button></p></form><p id="status" role="status" aria-live="polite"></p></main><script>${script}</script></html>`;
  const server = http.createServer(async (req, res) => {
    adminSecurityHeaders(res, scriptHash);
    const send = (status, value) => { res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.writeHead(status); res.end(JSON.stringify(value)); };
    try {
      const port = server.address()?.port;
      if (req.socket.remoteAddress !== '127.0.0.1' || ![`127.0.0.1:${port}`, `localhost:${port}`].includes(req.headers.host)) throw adminError(403, '仅允许本机设置。');
      if ((req.url || '').includes('?')) throw adminError(400, '设置接口不接受查询参数。');
      if (req.method === 'GET' && req.url === '/') {
        rejectAdminBody(req);
        res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.writeHead(200); res.end(html.replace("{{username}}", await auth.getUsername()));
      } else if (req.method === 'POST' && req.url === '/setup') {
        const origin = exactAdminOrigin(req);
        if (!origin || origin.protocol !== 'http:') throw adminError(403, '仅允许本机设置。');
        const csrf = req.headers['x-csrf-token'];
        if (typeof csrf !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(csrf)
            || !timingSafeEqual(Buffer.from(csrf), Buffer.from(csrfToken))) throw adminError(403, '设置校验已失效，请刷新页面。');
        const input = await readAdminJson(req);
        if (!adminObject(input, ['password', 'confirmPassword']) || typeof input.password !== 'string' || input.password !== input.confirmPassword) throw adminError(400, '两次密码不一致。');
        await auth.setPassword(input.password); send(200, { configured: true });
      } else throw adminError(404, '接口不存在。');
    } catch (error) {
      const status = [400, 403, 404, 413, 415, 503].includes(error.statusCode) ? error.statusCode : 503;
      if ([400, 413, 415].includes(status)) res.setHeader('Connection', 'close');
      if (!res.headersSent) send(status, { error: status === 503 ? '本机设置暂不可用，请稍后再试。' : error.message });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

export async function startAdminSetupServer({ auth, port = 4398 } = {}) {
  auth ??= await createAdminAuth();
  const server = createAdminSetupServer({ auth });
  await new Promise((done, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', done); });
  return server;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  startAdminSetupServer().then(server => {
    console.log(`本机管理员设置：http://127.0.0.1:${server.address().port}/`);
  }).catch(() => { console.error('本机管理员设置未能启动。'); process.exitCode = 1; });
}
