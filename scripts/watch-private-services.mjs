import { spawn, execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { appendFile, lstat, open, readFile, rmdir, unlink } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { secureDirectory } from './local-secrets.mjs';

const project = fileURLToPath(new URL('../', import.meta.url));
const privateRoot = resolve(project, '.sites-runtime');
const watchRoot = resolve(privateRoot, 'service-watch');
const runFile = promisify(execFile);

export function pidState(pid, probe = process.kill) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return 'unknown';
  try { probe(pid, 0); return 'alive'; }
  catch (error) { return error.code === 'ESRCH' ? 'dead' : 'unknown'; }
}

// A live or unreadable lock is never taken over, even when its port is unavailable.
export async function clearDeadLock(path, probe = process.kill) {
  let source;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 4096) return 'blocked';
    source = await readFile(path, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return 'missing'; throw error; }
  let lock;
  try { lock = JSON.parse(source); } catch { return 'blocked'; }
  if (!lock || typeof lock.owner !== 'string' || !lock.owner || typeof lock.createdAt !== 'string'
    || pidState(lock.pid, probe) !== 'dead') return 'blocked';
  // Recheck the owner and process immediately before touching only this lock file.
  if (await readFile(path, 'utf8') !== source || pidState(lock.pid, probe) !== 'dead') return 'blocked';
  await unlink(path);
  return 'removed';
}

export async function clearSessionWriteLock(path) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) return 'blocked';
    await rmdir(path); // Never remove session records or a nonempty lock directory.
    return 'removed';
  } catch (error) {
    if (error.code === 'ENOENT') return 'missing';
    if (['ENOTEMPTY', 'EEXIST'].includes(error.code)) return 'blocked';
    throw error;
  }
}

async function acquireWatchLock(path) {
  if (await clearDeadLock(path) === 'blocked') return null;
  const owner = randomUUID();
  let handle;
  try { handle = await open(path, 'wx', 0o600); }
  catch (error) { if (error.code === 'EEXIST') return null; throw error; }
  try { await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), owner })); }
  finally { await handle.close(); }
  return async () => {
    const current = JSON.parse(await readFile(path, 'utf8'));
    if (current.owner === owner) await unlink(path);
  };
}

export function portReady(port) {
  return new Promise(done => {
    const socket = createConnection({ host: '127.0.0.1', port });
    const finish = ready => { socket.destroy(); done(ready); };
    socket.setTimeout(2000);
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    socket.once('timeout', () => finish(false));
  });
}

async function existingServiceScripts() {
  const powershell = resolve(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
  const { stdout } = await runFile(powershell, ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; @(Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | ForEach-Object { $_.CommandLine }) | ConvertTo-Json -Compress"],
  { windowsHide: true, timeout: 15000, maxBuffer: 1024 * 1024 });
  const parsed = JSON.parse(stdout.trim() || '[]');
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(line => typeof line === 'string');
}

export async function checkService(service, { ready = portReady, scripts = existingServiceScripts,
  clearLock = clearDeadLock, clearWriteLock = clearSessionWriteLock, launch = spawn, log = async () => {} } = {}) {
  const status = async state => {
    if (service.state !== state) { service.state = state; await log(`${service.name} ${state}`); }
  };
  if (await ready(service.port)) { await status('listening'); return; }
  if (service.child && pidState(service.child.pid) !== 'dead') { await status('process-alive-port-unavailable'); return; }
  // Process discovery must succeed before starting an untracked service.
  const running = await scripts();
  if (running.some(line => service.scriptPattern.test(line))) { await status('existing-process-port-unavailable'); return; }
  if (service.lockPath && await clearLock(service.lockPath) === 'blocked') { await status('lock-preserved'); return; }
  if (await ready(service.port)) { await status('listening'); return; }
  if (service.writeLockPath && await clearWriteLock(service.writeLockPath) === 'blocked') { await status('lock-preserved'); return; }
  const child = launch(process.execPath, service.args, {
    cwd: project, env: { ...process.env, ...service.env }, windowsHide: true, stdio: 'ignore',
  });
  service.child = child;
  child.once('error', () => { service.child = null; void status('start-failed').catch(() => {}); });
  child.once('exit', () => { service.child = null; void status('exited').catch(() => {}); });
  await status('starting');
}

export async function watchPrivateServices() {
  if (process.platform !== 'win32') throw new Error('Windows supervisor required');
  await secureDirectory(watchRoot);
  const release = await acquireWatchLock(resolve(watchRoot, 'supervisor.lock'));
  if (!release) return;
  const log = line => appendFile(resolve(watchRoot, 'lifecycle.log'), `${new Date().toISOString()} ${line}\n`, { mode: 0o600 });
  const services = [
    { name: 'identity', port: 4312, scriptPattern: /(?:^|[\\/\s"'])serve-identity\.mjs(?:[\s"']|$)/,
      writeLockPath: resolve(privateRoot, 'identity/sessions/.write-lock'),
      args: [resolve(project, 'scripts/serve-identity.mjs')], env: {
        RADAR_IDENTITY_ROSTER_PATH: resolve(privateRoot, 'identity/roster.dpapi'),
        RADAR_IDENTITY_TEST_MODE: '0', RADAR_IDENTITY_PORT: '4312',
      } },
    { name: 'assistant', port: 4314, scriptPattern: /(?:^|[\\/\s"'])serve-class-assistant\.mjs(?:[\s"']|$)/,
      lockPath: resolve(privateRoot, 'class-assistant/service.lock'),
      args: [`--env-file=${resolve(privateRoot, 'class-assistant/api.env')}`, resolve(project, 'scripts/serve-class-assistant.mjs')],
      env: { CLASS_ASSISTANT_PORT: '4314', CLASS_ASSISTANT_HOST: '127.0.0.1' } },
  ];
  let stopped = false;
  let wake;
  const stop = () => { stopped = true; wake?.(); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await log('supervisor started');
    while (!stopped) {
      for (const service of services) {
        if (stopped) break;
        try { await checkService(service, { log }); }
        catch {
          if (service.state !== 'check-failed') { service.state = 'check-failed'; await log(`${service.name} check-failed`); }
        }
      }
      if (!stopped) await new Promise(done => { const timer = setTimeout(done, 25000); wake = () => { clearTimeout(timer); done(); }; });
    }
  } finally {
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await release();
    await log('supervisor stopped');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  watchPrivateServices().catch(() => { console.error('Private service supervisor stopped; check local permissions and lifecycle log.'); process.exitCode = 1; });
}
