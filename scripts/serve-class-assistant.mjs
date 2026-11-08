import { resolve } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig } from './class-assistant-config.mjs';
import { acquireClassAssistantLock, createClassAssistantStore, privatePath } from './class-assistant-store.mjs';
import { createClassAssistantHandler, validatePublicOrigin } from './class-assistant.mjs';
import { loadPublicAssistantItems } from './class-assistant-provider.mjs';
import { createRadarServer } from './serve-radar.mjs';

export async function loadClassAssistantAccessPolicy(path, store) {
  if (path === undefined) return undefined;
  if (typeof path !== 'string' || !path.trim()) throw new Error('测试访问策略路径无效，服务不会开放。');
  const file = privatePath(resolve(path));
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) throw new Error('测试访问策略文件无效，服务不会开放。');
  return store.resolveAllowedMembers(JSON.parse(await readFile(file, 'utf8')));
}

export async function startClassAssistantServer() {
  const port = Number(process.env.CLASS_ASSISTANT_PORT || 4314);
  const host = process.env.CLASS_ASSISTANT_HOST || '127.0.0.1';
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !['127.0.0.1', 'localhost', '::1', '0.0.0.0', '::'].includes(host)) throw new Error('Invalid class assistant address');
  const publicOrigin = process.env.PUBLIC_ORIGIN || `http://127.0.0.1:${port}`;
  const origin = validatePublicOrigin(publicOrigin);
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && (origin.protocol !== 'https:' || !process.env.PUBLIC_ORIGIN)) throw new Error('非本机监听必须显式设置HTTPS PUBLIC_ORIGIN。');
  const config = await loadConfig(process.env.CLASS_ASSISTANT_CONFIG || 'config/class-assistant.example.json');
  const lock = await acquireClassAssistantLock();
  let store;
  let classAssistantHandler;
  let stop;
  let cleanupPromise;
  const cleanup = () => cleanupPromise ??= (async () => {
    classAssistantHandler?.stop();
    // A disconnected client can leave an upstream promise running after the HTTP server closes.
    await classAssistantHandler?.drain();
    if (stop) { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
    store?.close();
    await lock.release();
  })();
  try {
    store = await createClassAssistantStore({ recoverPending: true, lock });
    const allowedMemberIds = await loadClassAssistantAccessPolicy(process.env.CLASS_ASSISTANT_ACCESS_POLICY, store);
    classAssistantHandler = createClassAssistantHandler({ config, store, publicOrigin, allowedMemberIds, publicItems: await loadPublicAssistantItems() });
    const server = await createRadarServer({ root: resolve('out'), identityOnly: true, classAssistantHandler });
    server.timeout = 400000;
    stop = () => { classAssistantHandler.stop(); server.close(); };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    server.once('close', () => { void cleanup(); });
    server.drainClassAssistant = async () => { stop(); await cleanup(); };
    await new Promise((done, fail) => {
      server.once('error', fail);
      server.listen(port, host, () => { server.off('error', fail); done(); });
    });
    console.log(`班级助手本机服务 ${publicOrigin}/assistant/；仅本地启动，未部署。`);
    return server;
  } catch (error) { await cleanup(); throw error; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await startClassAssistantServer(); }
  catch { console.error('班级助手未启动。请检查Node24、私有目录、配置及静态构建；未输出密钥或名单。'); process.exitCode = 1; }
}
