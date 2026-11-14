import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { assertPublicFeed } from '../sources/public-feed.mjs';
import { projectRoot } from './feed-files.mjs';
import { secureDirectory } from './local-secrets.mjs';
import { pidState } from './watch-private-services.mjs';

const remote = 'https://github.com/ajydxw/sanjiang-radar.git';
const actions = 'https://api.github.com/repos/ajydxw/sanjiang-radar/actions/workflows/pages.yml/runs';
const liveUrl = 'https://ajydxw.github.io/sanjiang-radar/data/pu.json';
const publicPath = 'public/data/pu.json';
const maximumFeedBytes = 5 * 1024 * 1024;
const minute = 60_000;
const powershell = resolve(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const runFile = promisify(execFile);
const sha = value => createHash('sha256').update(value).digest('hex');
const shaPattern = /^[a-f\d]{40}$/;
const notFound = error => { if (error.code !== 'ENOENT') throw error; };

async function atomicWrite(target, bytes) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await rename(temporary, target);
  } finally { await unlink(temporary).catch(notFound); }
}

export function validateSnapshot(bytes, startedAt, finishedAt = Date.now()) {
  if (bytes.length > maximumFeedBytes) throw new Error('feed-invalid');
  const feed = JSON.parse(bytes.toString('utf8'));
  assertPublicFeed(feed);
  const [source] = feed.sources;
  if (feed.sources.length !== 1 || source?.id !== 'sju-pu' || source.sourceType !== 'pu' ||
      source.state !== 'ok' || source.complete !== true || source.error != null || !(source.pagesRead > 0)) {
    throw new Error('collection-incomplete');
  }
  const timestamp = Date.parse(feed.generatedAt);
  if (!Number.isFinite(timestamp) || timestamp < startedAt || timestamp > finishedAt ||
      source.lastAttemptAt !== feed.generatedAt || source.lastSuccessAt !== feed.generatedAt) {
    throw new Error('collection-not-fresh');
  }
  if (source.count !== feed.items.length || feed.items.some(item => item.sourceType !== 'pu' || item.demo)) {
    throw new Error('feed-invalid');
  }
  return feed;
}

export function staleOwner(owner, bootAt, probe = process.kill) {
  const timestamp = Date.parse(owner?.createdAt);
  return Number.isSafeInteger(owner?.pid) && owner.pid > 0 && Number.isFinite(timestamp) &&
    (pidState(owner.pid, probe) === 'dead' || Number.isFinite(bootAt) && timestamp < bootAt);
}

async function acquireLock(runtime, bootAt) {
  const directory = resolve(runtime, 'worker.lock');
  const ownerName = `${randomUUID()}.json`;
  const contender = resolve(runtime, `${ownerName}.pending`);
  await mkdir(contender);
  try {
    await writeFile(resolve(contender, ownerName), JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }), { flag: 'wx' });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        await rename(contender, directory);
        return async () => {
          await unlink(resolve(directory, ownerName));
          await rmdir(directory).catch(notFound);
        };
      } catch (error) {
        if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
        const info = await lstat(directory).catch(notFound);
        if (!info) continue;
        if (!info.isDirectory() || info.isSymbolicLink()) return null;
        const entries = await readdir(directory);
        if (entries.length) {
          if (entries.length !== 1 || !/^[a-f\d-]{36}\.json$/.test(entries[0])) return null;
          const path = resolve(directory, entries[0]);
          const lockInfo = await lstat(path).catch(notFound);
          if (!lockInfo) continue;
          if (!lockInfo.isFile() || lockInfo.isSymbolicLink() || lockInfo.size > 512) return null;
          const raw = await readFile(path, 'utf8').catch(notFound);
          if (!raw) continue;
          let owner;
          try { owner = JSON.parse(raw); } catch { return null; }
          if (!staleOwner(owner, bootAt)) return null;
          await unlink(path).catch(notFound);
        }
        // The next owner moves an already populated directory into place atomically.
        await rmdir(directory).catch(error => {
          if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM'].includes(error.code)) throw error;
        });
      }
    }
    return null;
  } finally {
    await unlink(resolve(contender, ownerName)).catch(notFound);
    await rmdir(contender).catch(notFound);
  }
}

async function windowsSnapshot() {
  const command = String.raw`
    $ErrorActionPreference = 'Stop'
    $boot = (Get-CimInstance Win32_OperatingSystem).LastBootUpTime.ToUniversalTime().ToString('o')
    $busy = @(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {
      $_.CommandLine -match '(?:^|[\\/\s"''])(?:collect-pu|sync-sources|login-pu)\.mjs(?:[\s"'']|$)'
    }).Count -gt 0
    [pscustomobject]@{ bootAt = $boot; busy = $busy } | ConvertTo-Json -Compress`;
  const { stdout } = await runFile(powershell, ['-NoProfile', '-NonInteractive', '-Command', command], {
    windowsHide: true, timeout: 15_000, maxBuffer: 4096,
  });
  const snapshot = JSON.parse(stdout);
  if (!Number.isFinite(Date.parse(snapshot.bootAt)) || typeof snapshot.busy !== 'boolean') throw new Error('process-check-failed');
  return snapshot;
}

function collect(collector, timeout = 20 * minute) {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [resolve(collector, 'scripts/collect-pu.mjs'), '--max-pages', '50'], {
      cwd: collector, windowsHide: true, stdio: 'ignore',
    });
    let timedOut = false;
    let cleanup;
    const timer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
      timedOut = true;
      const taskkill = resolve(process.env.SystemRoot || 'C:/Windows', 'System32/taskkill.exe');
      cleanup = runFile(taskkill, ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, timeout: 15_000, maxBuffer: 4096,
      }).catch(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
    }, timeout);
    child.once('error', () => { clearTimeout(timer); fail(new Error('collection-failed')); });
    child.once('close', async code => {
      clearTimeout(timer);
      await cleanup;
      if (timedOut) fail(new Error('collection-timeout'));
      else if (code !== 0) fail(new Error('collection-failed'));
      else done();
    });
  });
}

function git(cwd, args) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)));
  return runFile('git', [
    '-c', 'user.name=ajydxw', '-c', 'user.email=137271330+ajydxw@users.noreply.github.com',
    '-c', 'core.hooksPath=.git/pu-publisher-no-hooks', '-c', 'commit.gpgsign=false', ...args,
  ], {
    cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
    windowsHide: true, timeout: 90_000, maxBuffer: 128 * 1024,
  });
}

async function assertPath(path, expectedType) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info[expectedType]() || resolve(await realpath(path)) !== path) throw new Error('unsafe-path');
}

async function ownedRepo(runtime) {
  const repo = resolve(runtime, 'repo');
  const marker = resolve(repo, '.pu-publisher-owner');
  const markerValue = `${repo}\n${remote}\n`;
  try {
    await mkdir(repo);
    await writeFile(marker, markerValue, { flag: 'wx' });
  } catch (error) { if (error.code !== 'EEXIST') throw error; }
  await assertPath(repo, 'isDirectory');
  await assertPath(marker, 'isFile');
  if (await readFile(marker, 'utf8') !== markerValue) throw new Error('unsafe-repo');
  const gitDir = resolve(repo, '.git');
  if (!await lstat(gitDir).catch(notFound)) await git(repo, ['init', '--initial-branch=main']);
  await assertPath(gitDir, 'isDirectory');
  const { stdout } = await git(repo, ['rev-parse', '--show-toplevel', '--absolute-git-dir']);
  const [top, metadata] = stdout.trim().split(/\r?\n/).map(path => resolve(path));
  if (top !== repo || metadata !== gitDir) throw new Error('unsafe-repo');
  return repo;
}

async function fetchMain(repo) {
  await git(repo, ['fetch', '--no-tags', '--depth=1', remote, '+refs/heads/main:refs/remotes/origin/main']);
  const { stdout } = await git(repo, ['rev-parse', 'refs/remotes/origin/main']);
  const head = stdout.trim();
  if (!shaPattern.test(head)) throw new Error('git-sync-failed');
  return head;
}

async function pushFeed(runtime, bytes) {
  const repo = await ownedRepo(runtime);
  let head = await fetchMain(repo);
  for (let attempt = 0; attempt <= 2; attempt++) {
    if (await readFile(resolve(repo, '.pu-publisher-owner'), 'utf8') !== `${repo}\n${remote}\n`) throw new Error('unsafe-repo');
    await git(repo, ['reset', '--hard', head]);
    const target = resolve(repo, publicPath);
    await assertPath(dirname(target), 'isDirectory');
    await assertPath(target, 'isFile');
    if ((await readFile(target)).equals(bytes)) return head;
    await atomicWrite(target, bytes);
    await git(repo, ['add', '--', publicPath]);
    const { stdout } = await git(repo, ['diff', '--cached', '--name-only']);
    if (stdout.trim() !== publicPath) throw new Error('unexpected-git-diff');
    await git(repo, ['commit', '-m', 'Refresh public PU activity feed']);
    const commit = (await git(repo, ['rev-parse', 'HEAD'])).stdout.trim();
    if (!shaPattern.test(commit)) throw new Error('git-sync-failed');
    try {
      await git(repo, ['push', '--porcelain', remote, 'HEAD:refs/heads/main']);
      return commit;
    } catch (error) {
      const advanced = await fetchMain(repo);
      if (advanced === commit) return commit;
      if (advanced === head || attempt === 2) throw new Error('git-push-failed');
      head = advanced;
    }
  }
}

export async function verifyDeployment(commit, hash, { request = fetch, pause = sleep, timeout = 8 * minute, report = async () => {} } = {}) {
  const deadline = performance.now() + timeout;
  let workflowSucceeded = false;
  let state = 'queued';
  const get = url => request(url, { cache: 'no-store', signal: AbortSignal.timeout(Math.ceil(Math.min(15_000, Math.max(1, deadline - performance.now())))) });
  while (performance.now() < deadline) {
    if (!workflowSucceeded) {
      const response = await get(`${actions}?branch=main&head_sha=${commit}&per_page=10`).catch(() => null);
      const result = response?.ok ? await response.json().catch(() => null) : null;
      const run = result?.workflow_runs?.find(run => run.head_sha === commit && run.head_branch === 'main');
      if (run?.status === 'completed') {
        if (run.conclusion !== 'success') throw new Error('pages-workflow-failed');
        workflowSucceeded = true;
      }
      const observed = workflowSucceeded ? 'verifying-live' : run?.status === 'in_progress' ? 'running' : state;
      if (observed !== state) { state = observed; await report(state); }
    }
    if (workflowSucceeded) {
      const response = await get(`${liveUrl}?pu-deployment=${commit}`).catch(() => null);
      const content = response?.ok ? await response.arrayBuffer().catch(() => null) : null;
      if (content && content.byteLength <= maximumFeedBytes && sha(Buffer.from(content)) === hash) return;
    }
    await pause(Math.max(0, Math.min(10_000, deadline - performance.now())));
  }
  throw new Error(workflowSucceeded ? 'pages-live-mismatch' : 'pages-workflow-timeout');
}

const errors = new Set([
  'collection-incomplete', 'collection-not-fresh', 'collection-failed', 'collection-timeout', 'collector-busy',
  'feed-invalid', 'git-push-failed', 'git-sync-failed', 'unsafe-path', 'unsafe-repo', 'unexpected-git-diff',
  'pages-workflow-failed', 'pages-live-mismatch', 'pages-workflow-timeout', 'process-check-failed',
]);

export async function syncPu() {
  const runtime = resolve(projectRoot, '.sites-runtime/pu-publisher');
  const collector = resolve(projectRoot, '../sanjiang-radar');
  if (!await lstat(runtime).catch(notFound)) await secureDirectory(runtime);
  await assertPath(runtime, 'isDirectory');
  const statusPath = resolve(runtime, 'status.json');
  let release;
  let stage = 'process-check';
  let result = { startedAt: new Date().toISOString() };
  const save = async (state, error) => atomicWrite(statusPath, JSON.stringify({
    state, stage, ...result, updatedAt: new Date().toISOString(), ...(error && { error }),
  }, null, 2) + '\n');
  try {
    const firstCheck = await windowsSnapshot();
    release = await acquireLock(runtime, Date.parse(firstCheck.bootAt));
    if (!release) return 'publisher-busy';
    const previous = await readFile(statusPath, 'utf8').then(JSON.parse).catch(() => null);
    if (shaPattern.test(previous?.lastPublished?.commit || '') && /^[a-f\d]{64}$/.test(previous?.lastPublished?.sha256 || '') &&
        Number.isFinite(Date.parse(previous?.lastPublished?.at))) {
      const { commit, sha256, at } = previous.lastPublished;
      result.lastPublished = { commit, sha256, at: new Date(at).toISOString() };
    }
    if (firstCheck.busy || (await windowsSnapshot()).busy) throw new Error('collector-busy');
    stage = 'collect';
    await save('running');
    const startedAt = Date.now();
    await collect(collector);
    stage = 'validate';
    const bytes = await readFile(resolve(collector, publicPath));
    let feed;
    try { feed = validateSnapshot(bytes, startedAt); }
    catch (error) { throw new Error(errors.has(error.message) ? error.message : 'feed-invalid'); }
    result = { ...result, collectedAt: feed.generatedAt, itemCount: feed.items.length, sha256: sha(bytes) };
    stage = 'local-copy';
    await save('running');
    for (const directory of ['public/data', 'out/data', '.sites-runtime/identity-web/out/data']) {
      const path = resolve(projectRoot, directory);
      await assertPath(path, 'isDirectory');
      await atomicWrite(resolve(path, 'pu.json'), bytes);
    }
    stage = 'push';
    await save('running');
    result.commit = await pushFeed(runtime, bytes);
    stage = 'pages';
    await save('queued');
    await verifyDeployment(result.commit, result.sha256, { report: state => save(state) });
    result.lastPublished = { commit: result.commit, sha256: result.sha256, at: new Date().toISOString() };
    await save('published');
    return 'published';
  } catch (error) {
    const code = errors.has(error.message) ? error.message : `${stage}-failed`;
    if (release) await save('failed', code);
    throw new Error(code);
  } finally { await release?.(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  syncPu().then(state => console.log(`PU: ${state}`)).catch(error => {
    console.error(`PU: ${errors.has(error.message) || /^(?:process-check|collect|validate|local-copy|push|pages)-failed$/.test(error.message) ? error.message : 'publisher-failed'}`);
    process.exitCode = 1;
  });
}
