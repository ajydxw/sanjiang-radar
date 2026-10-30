import { lstat, mkdir, readdir, rmdir, unlink } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { readSecret, saveSecret, secureDirectory } from './local-secrets.mjs';

const root = fileURLToPath(new URL('../.sites-runtime/identity/', import.meta.url));
const sessionFile = /^[a-f0-9]{64}\.dpapi$/;

// One local server owns this directory; each small record fits the existing DPAPI helper.
export async function createIdentitySessionStore(directory = resolve(root, 'sessions')) {
  directory = resolve(directory);
  const part = relative(root, directory);
  if (!part || isAbsolute(part) || part === '..' || part.startsWith(`..${sep}`)) throw new Error('Invalid identity session directory');
  await secureDirectory(directory);
  const lock = resolve(directory, '.write-lock');
  const pathFor = hash => {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid identity session hash');
    return resolve(directory, `${hash}.dpapi`);
  };
  async function files() {
    const names = (await readdir(directory)).filter(name => sessionFile.test(name));
    return Promise.all(names.map(async name => {
      const path = resolve(directory, name), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8192) throw new Error('Invalid identity session file');
      return { path, modified: info.mtimeMs };
    }));
  }
  let pending = Promise.resolve();
  async function locked(action) {
    const deadline = performance.now() + 5000;
    while (true) {
      try { await mkdir(lock); break; }
      catch (error) {
        if (!['EEXIST', 'EACCES', 'EPERM'].includes(error.code) || performance.now() >= deadline) throw new Error('Identity session storage is busy');
        await delay(20);
      }
    }
    try { return await action(); }
    finally { await rmdir(lock); }
  }
  const write = action => {
    const next = pending.then(() => locked(action));
    pending = next.catch(() => {});
    return next;
  };
  async function remove(hash) {
    await unlink(pathFor(hash)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  async function read(hash) {
    try {
      const path = pathFor(hash), info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8192) throw new Error('Invalid identity session file');
      return JSON.parse(await readSecret(path));
    } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  }
  return {
    get(hash) { return write(() => read(hash)); },
    update(hash, change) {
      return write(async () => {
        const current = await read(hash);
        if (!current) return null;
        const next = change(current);
        if (!next) await remove(hash);
        else if (next !== current) await saveSecret(pathFor(hash), JSON.stringify(next));
        return next;
      });
    },
    set(hash, value) {
      return write(async () => {
        const path = pathFor(hash);
        const entries = (await files()).filter(entry => entry.path !== path).sort((a, b) => a.modified - b.modified);
        await saveSecret(path, JSON.stringify(value));
        while (entries.length >= 256) await unlink(entries.shift().path);
      });
    },
    delete(hash) { return write(() => remove(hash)); },
    clear() { return write(async () => { for (const entry of await files()) await unlink(entry.path); }); },
  };
}
