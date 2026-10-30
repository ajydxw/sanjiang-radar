import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createIdentityAuth } from './identity-auth.mjs';
import { createRadarServer } from './serve-radar.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));

export async function createIdentityServer({ root = resolve(project, '.sites-runtime/identity-web/out'), rosterPath, testMode = false } = {}) {
  if (typeof testMode !== 'boolean' || testMode === Boolean(rosterPath)) throw new Error('请明确选择合成测试模式，或配置一个本机私有名单路径。');
  const identityAuth = await createIdentityAuth(testMode ? {
    roster: [{ name: '测试同学', studentId: '000000001' }], testMode: true,
    sessionDirectory: resolve(project, '.sites-runtime/identity/test-sessions'),
  } : { rosterPath });
  if (!(await identityAuth.session({ headers: {} })).enabled) throw new Error('身份服务未配置成功，已停止开放入口。');
  return createRadarServer({ root, identityAuth, identityOnly: true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const testMode = process.env.RADAR_IDENTITY_TEST_MODE === '1';
  const port = Number(process.env.RADAR_IDENTITY_PORT || 4312);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid identity port');
  const server = await createIdentityServer({ rosterPath: process.env.RADAR_IDENTITY_ROSTER_PATH || undefined, testMode });
  server.listen(port, '127.0.0.1', () => console.log(`Identity ${testMode ? 'TEST' : 'private-roster'} service: http://127.0.0.1:${port}`));
}
