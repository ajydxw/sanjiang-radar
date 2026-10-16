import { spawn } from 'node:child_process';
import { access, readFile, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const helper = resolve(dirname(fileURLToPath(import.meta.url)), 'local-secrets.ps1');
const powershell = resolve(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
const tokenPattern = /^[A-Za-z0-9._~+\/=\-]{16,512}$/;

function privateAction(action, path, input = '') {
  if (process.platform !== 'win32') throw new Error('本机凭证保护目前需要 Windows；已停止读取或保存凭证。');
  return new Promise((done, fail) => {
    const child = spawn(powershell, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, '-Action', action, '-Path', path], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], timeout: 30000 });
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', value => { output += value; if (output.length > 8192) child.kill(); });
    child.stderr.resume();
    child.stdin.on('error', () => {});
    child.once('error', () => fail(new Error('本机凭证保护工具未能启动。')));
    child.once('close', code => code === 0 ? done(output) : fail(new Error('本机凭证保护失败，已停止读取或保存凭证。')));
    child.stdin.end(input);
  });
}

export async function secureDirectory(path) { await privateAction('Protect', path); }
export async function saveSecret(path, value) { await privateAction('Seal', path, value); }
export async function readSecret(path) { await access(path); return privateAction('Open', path); }
export function validTunnelToken(value) { return typeof value === 'string' && tokenPattern.test(value); }

export async function loadTunnelToken(configFile, secretFile) {
  await secureDirectory(dirname(configFile));
  let token;
  try { token = await readSecret(secretFile); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    let saved;
    try { saved = await readFile(configFile, 'utf8'); }
    catch (error) { if (error.code === 'ENOENT') return null; throw error; }
    const value = saved.match(/^authtoken:\s*(.+)$/m)?.[1]?.trim();
    token = value?.startsWith('"') ? JSON.parse(value) : value;
    if (!validTunnelToken(token)) throw new Error('保存的连接凭证格式不正确。');
    await saveSecret(secretFile, token);
    if (await readSecret(secretFile) !== token) throw new Error('本机凭证保护校验未通过。');
  }
  if (!validTunnelToken(token)) throw new Error('保存的连接凭证格式不正确。');
  await unlink(configFile).catch(error => { if (error.code !== 'ENOENT') throw error; });
  return token;
}
