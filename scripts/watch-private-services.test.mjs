import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { checkService, clearDeadLock, clearSessionWriteLock, pidState } from './watch-private-services.mjs';

const absent = () => { throw Object.assign(new Error(), { code: 'ESRCH' }); };
test('only ESRCH proves a positive PID dead; permission failures preserve it', () => {
  assert.equal(pidState(123, absent), 'dead');
  assert.equal(pidState(123, () => {}), 'alive');
  assert.equal(pidState(123, () => { throw Object.assign(new Error(), { code: 'EPERM' }); }), 'unknown');
  assert.equal(pidState(-1, absent), 'unknown');
});

test('clear only a definitively dead lock and preserve unrelated private data', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'radar-watch-test-'));
  const path = resolve(directory, 'service.lock');
  const source = JSON.stringify({ pid: 123, createdAt: new Date().toISOString(), owner: 'test-owner' });
  try {
    await writeFile(resolve(directory, 'ledger.sqlite'), 'untouched ledger');
    await writeFile(path, source);
    assert.equal(await clearDeadLock(path, () => {}), 'blocked');
    assert.equal(await readFile(path, 'utf8'), source);
    assert.equal(await clearDeadLock(path, absent), 'removed');
    assert.equal(await clearDeadLock(path, absent), 'missing');
    assert.equal(await readFile(resolve(directory, 'ledger.sqlite'), 'utf8'), 'untouched ledger');
    await writeFile(path, '{invalid');
    assert.equal(await clearDeadLock(path, absent), 'blocked');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('reachable services, live children and existing processes are never restarted', async () => {
  const service = () => ({ name: 'test', port: 1, scriptPattern: /serve-example\.mjs/, args: [] });
  const fail = () => { assert.fail('unexpected start or lock cleanup'); };
  await checkService(service(), { ready: async () => true, scripts: fail, launch: fail, clearLock: fail });
  await checkService({ ...service(), child: { pid: process.pid } }, { ready: async () => false, scripts: fail, launch: fail });
  await checkService(service(), { ready: async () => false, scripts: async () => ['node serve-example.mjs'], launch: fail });
});

test('identity recovery removes only an empty write-lock directory', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'radar-watch-test-'));
  const lock = resolve(directory, '.write-lock');
  try {
    await writeFile(resolve(directory, 'session.dpapi'), 'preserved');
    await mkdir(lock);
    assert.equal(await clearSessionWriteLock(lock), 'removed');
    assert.equal(await clearSessionWriteLock(lock), 'missing');
    await mkdir(lock);
    await writeFile(resolve(lock, 'unexpected'), 'preserved');
    assert.equal(await clearSessionWriteLock(lock), 'blocked');
    assert.equal(await readFile(resolve(lock, 'unexpected'), 'utf8'), 'preserved');
    assert.equal(await readFile(resolve(directory, 'session.dpapi'), 'utf8'), 'preserved');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a preserved ledger lock blocks restart; a dead service launches hidden without output', async () => {
  const service = { name: 'test', port: 1, scriptPattern: /example/, args: ['test.mjs'], lockPath: 'mock.lock' };
  const hooks = { ready: async () => false, scripts: async () => [] };
  await checkService(service, { ...hooks, clearLock: async () => 'blocked', launch: () => assert.fail('live lock') });
  let launches = 0;
  const child = new EventEmitter();
  child.pid = process.pid;
  await checkService(service, { ...hooks, clearLock: async () => 'removed', launch: (exe, args, options) => {
    launches++;
    assert.equal(exe, process.execPath);
    assert.deepEqual(args, ['test.mjs']);
    assert.equal(options.windowsHide, true);
    assert.equal(options.stdio, 'ignore');
    return child;
  } });
  await checkService(service, { ...hooks, launch: () => assert.fail('duplicate live child') });
  assert.equal(launches, 1);
  child.emit('exit');
  assert.equal(service.child, null);
});
