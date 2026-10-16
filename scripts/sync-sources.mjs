import { spawn } from 'node:child_process';
import { mkdir, writeFile, open, readFile, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { projectRoot } from './feed-files.mjs';
const { values } = parseArgs({ options: { watch: { type: 'boolean', default: false }, 'skip-initial': { type: 'boolean', default: false }, minutes: { type: 'string', default: '30' } } });
const minutes = Number(values.minutes);
if (!Number.isInteger(minutes) || minutes < 15 || minutes > 720) throw new Error('同步间隔必须在 15–720 分钟之间');
const runtimeRoot = resolve(projectRoot, '.sites-runtime/sync');
await mkdir(runtimeRoot, { recursive: true });
const lockPath = resolve(runtimeRoot, 'worker.lock');
let lock;
try { lock = await open(lockPath, 'wx'); }
catch (error) {
  if (error.code !== 'EEXIST') throw error;
  const owner = Number(await readFile(lockPath, 'utf8'));
  try { process.kill(owner, 0); console.log('同步任务已经运行，不重复启动。'); process.exit(0); }
  catch (error) { if (error.code !== 'ESRCH') throw error; }
  await unlink(lockPath);
  lock = await open(lockPath, 'wx');
}
await lock.writeFile(String(process.pid)); await lock.close();
let running = false;
let timer;
let runCount = 0;
let child;
const statePath = resolve(runtimeRoot, 'status.json');
const save = async value => writeFile(statePath, JSON.stringify({ pid: process.pid, intervalMinutes: minutes, updatedAt: new Date().toISOString(), ...value }, null, 2));
async function run(script) {
  return await new Promise(done => {
    child = spawn(process.execPath, [resolve(projectRoot, 'scripts', script)], { cwd: projectRoot, stdio: 'inherit', windowsHide: true });
    child.once('error', () => done(1)); child.once('exit', code => { child = null; done(code ?? 1); });
  });
}
async function cycle() {
  if (running) return;
  running = true;
  const startedAt = new Date().toISOString();
  await save({ state: 'running', startedAt });
  const pu = await run('collect-pu.mjs');
  // School listings, known WeChat links, competitions and exams are checked hourly.
  const school = runCount % 2 === 0 ? await run('collect-school.mjs') : null;
  const wechat = runCount % 2 === 0 ? await run('collect-wechat.mjs') : null;
  const competitions = runCount % 2 === 0 ? await run('collect-competitions.mjs') : null;
  const exams = runCount % 2 === 0 ? await run('collect-exams.mjs') : null;
  runCount++;
  const nextRunAt = new Date(Date.now() + minutes * 60000).toISOString();
  await save({ state: 'waiting', startedAt, lastCompletedAt: new Date().toISOString(), result: { pu, school, wechat, competitions, exams }, nextRunAt });
  running = false;
  if (values.watch) timer = setTimeout(cycle, minutes * 60000);
}
async function close() {
  clearTimeout(timer); child?.kill();
  await save({ state: 'stopped' });
  await unlink(lockPath).catch(() => {});
  process.exit(0);
}
process.on('SIGINT', close); process.on('SIGTERM', close);
if (values.watch && values['skip-initial']) {
  await save({ state: 'waiting', nextRunAt: new Date(Date.now() + minutes * 60000).toISOString() });
  timer = setTimeout(cycle, minutes * 60000);
} else await cycle();
if (!values.watch) await unlink(lockPath).catch(() => {});
