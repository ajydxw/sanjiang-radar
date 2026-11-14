import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { staleOwner, validateSnapshot, verifyDeployment } from './sync-pu-to-pages.mjs';

const timestamp = '2026-11-14T04:00:00.000Z';
const startedAt = Date.parse(timestamp);
const feed = {
  schemaVersion: 1, generatedAt: timestamp, items: [],
  sources: [{ id: 'sju-pu', name: 'PU口袋校园 · 三江学院', url: 'https://class.pocketuni.net/activity',
    sourceType: 'pu', state: 'ok', count: 0, lastAttemptAt: timestamp, lastSuccessAt: timestamp,
    error: null, pagesRead: 1, complete: true }],
};
const pack = value => Buffer.from(JSON.stringify(value));
const bytes = pack(feed);

test('publishable PU has a complete successful read from this invocation', () => {
  assert.deepEqual(validateSnapshot(bytes, startedAt, startedAt + 1), feed);
  assert.throws(() => validateSnapshot(bytes, startedAt + 1), /collection-not-fresh/);
  assert.throws(() => validateSnapshot(bytes, startedAt, startedAt - 1), /collection-not-fresh/);
  for (const update of [{ state: 'partial' }, { complete: false }, { pagesRead: 0 }, { error: 'failure' }]) {
    const changed = pack({ ...feed, sources: [{ ...feed.sources[0], ...update }] });
    assert.throws(() => validateSnapshot(changed, startedAt), /collection-incomplete/);
  }
  assert.throws(() => validateSnapshot(pack({ ...feed, unexpected: true }), startedAt), /公开信息格式或链接异常/);
});

test('lock takeover requires ESRCH or an owner timestamp before this boot', () => {
  const owner = { pid: 1234, createdAt: timestamp };
  const alive = () => {};
  const missing = () => { throw Object.assign(new Error(), { code: 'ESRCH' }); };
  const unavailable = () => { throw Object.assign(new Error(), { code: 'EPERM' }); };
  assert.equal(staleOwner(owner, startedAt - 1, missing), true);
  assert.equal(staleOwner(owner, startedAt + 1, alive), true);
  assert.equal(staleOwner(owner, startedAt, alive), false);
  assert.equal(staleOwner(owner, startedAt - 1, unavailable), false);
  assert.equal(staleOwner({ pid: -1, createdAt: timestamp }, startedAt + 1, missing), false);
  assert.equal(staleOwner({ pid: 1234 }, startedAt + 1, missing), false);
});

const commit = 'b'.repeat(40);
const hash = createHash('sha256').update(bytes).digest('hex');
const run = (status, conclusion, fields = {}) => ({ head_sha: commit, head_branch: 'main', status, conclusion, ...fields });
const runs = (...workflow_runs) => Response.json({ workflow_runs });

test('checks exact main Actions run, waits for completion and compares served bytes', async () => {
  const states = [];
  const replies = [runs(run('completed', 'success', { head_sha: 'c'.repeat(40) }),
    run('completed', 'success', { head_branch: 'other' })), runs(run('queued', null)),
    runs(run('in_progress', null)), runs(run('completed', 'success')),
    new Response('old snapshot'), new Response(bytes)];
  const requested = [];
  await verifyDeployment(commit, hash, {
    request: async url => { requested.push(url); return replies.shift(); },
    pause: async () => {}, report: async state => states.push(state), timeout: 2_000,
  });
  assert.deepEqual(states, ['running', 'verifying-live']);
  assert.equal(replies.length, 0);
  assert.ok(requested.slice(0, 4).every(url => url.includes(`branch=main&head_sha=${commit}`)));
  assert.ok(requested.slice(4).every(url => url.endsWith(`/data/pu.json?pu-deployment=${commit}`)));
});

test('failed Actions run never triggers a live read', async () => {
  let calls = 0;
  await assert.rejects(verifyDeployment(commit, hash, {
    request: async () => { calls++; return runs(run('completed', 'failure')); },
    pause: async () => {}, timeout: 2_000,
  }), /pages-workflow-failed/);
  assert.equal(calls, 1);
});
