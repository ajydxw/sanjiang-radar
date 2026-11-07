import { DatabaseSync } from 'node:sqlite';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, open, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { secureDirectory } from './local-secrets.mjs';
import { ASTRA_MEMBER_BUDGET_MICROS, MEMBER_BUDGET_MICROS, MEMBER_COUNT, SESSION_MS, TOTAL_BUDGET_MICROS, assistantError, exactObject } from './class-assistant-config.mjs';

export const PRIVATE_ROOT = fileURLToPath(new URL('../.sites-runtime/class-assistant/', import.meta.url));
export const digest = value => createHash('sha256').update(value).digest('hex');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const validRequestId = value => typeof value === 'string' && uuid.test(value);
const safeInteger = (value, max = MEMBER_BUDGET_MICROS) => Number.isSafeInteger(value) && value >= 0 && value <= max;
const activeLocks = new WeakSet();
const accessCodePattern = /^(?:[A-Za-z0-9_-]{43}|[0-9]{11})$/;
const rosterRevision = rows => digest(JSON.stringify(rows.map(row => [row.memberKey, row.name]).sort(([a], [b]) => a.localeCompare(b))));

export function privatePath(path) {
  const result = resolve(path), rel = relative(PRIVATE_ROOT, result);
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('班级助手数据必须保存在专用私有目录内。');
  return result;
}

export async function protectPrivateDirectory(directory) {
  directory = privatePath(directory);
  if (process.platform === 'win32') await secureDirectory(directory);
  else {
    // Refuse symlink ancestors before creating private data on non-Windows hosts too.
    let cursor = directory;
    while (cursor.startsWith(resolve(PRIVATE_ROOT))) {
      const info = await lstat(cursor).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
      if (info?.isSymbolicLink()) throw new Error('Private data cannot use symbolic links');
      if (cursor === resolve(PRIVATE_ROOT)) break;
      cursor = dirname(cursor);
    }
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
  }
  if (resolve(await realpath(directory)).toLowerCase() !== directory.toLowerCase()) throw new Error('Private directory boundary mismatch');
  return directory;
}

export function validateRoster(rows) {
  if (!Array.isArray(rows) || rows.length !== MEMBER_COUNT) throw new Error('名单必须正好包含35名成员。');
  const keys = new Set();
  for (const row of rows) {
    if (!exactObject(row, ['name', 'memberKey']) || typeof row.name !== 'string' || row.name !== row.name.trim()
      || [...row.name].length < 1 || [...row.name].length > 40 || /\p{C}/u.test(row.name)
      || typeof row.memberKey !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(row.memberKey) || keys.has(row.memberKey)) throw new Error('名单格式或成员唯一标识无效。');
    keys.add(row.memberKey);
  }
  return rows;
}

export async function acquireClassAssistantLock(directory = PRIVATE_ROOT) {
  directory = await protectPrivateDirectory(directory);
  const path = resolve(directory, 'service.lock');
  const owner = randomUUID();
  let handle;
  try {
    handle = await open(path, 'wx', 0o600);
    await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString(), owner }));
    await handle.sync();
  } catch (error) {
    await handle?.close();
    if (error.code === 'EEXIST') throw new Error('服务或本机管理命令已锁定账本。异常退出遗留锁时，先确认相关进程停止，再人工移除专用service.lock；禁止自动夺锁。');
    throw error;
  }
  await handle.close();
  const lock = { directory, async release() {
    if (!activeLocks.has(lock)) return;
    const current = JSON.parse(await readFile(path, 'utf8'));
    if (current.owner !== owner) throw new Error('Private ledger lock ownership changed');
    await unlink(path);
    activeLocks.delete(lock);
  } };
  activeLocks.add(lock);
  return lock;
}

export async function createClassAssistantStore({ directory = PRIVATE_ROOT, recoverPending = false, lock = null, readOnly = false } = {}) {
  directory = await protectPrivateDirectory(directory);
  if (typeof recoverPending !== 'boolean' || typeof readOnly !== 'boolean' || recoverPending && (readOnly || !activeLocks.has(lock) || lock.directory !== directory)) throw new Error('恢复未决请求必须先独占锁定账本。');
  const file = resolve(directory, 'ledger.sqlite');
  const info = await lstat(file).catch(error => error.code === 'ENOENT' ? null : Promise.reject(error));
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('Invalid private ledger');
  const db = new DatabaseSync(file, { readOnly });
  if (!readOnly && process.platform !== 'win32') await chmod(file, 0o600);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  if (!readOnly) db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
    CREATE TABLE IF NOT EXISTS settings (id INTEGER PRIMARY KEY CHECK(id=1), schema_version INTEGER NOT NULL CHECK(schema_version=1),
      total_budget INTEGER NOT NULL CHECK(total_budget=${TOTAL_BUDGET_MICROS}), member_budget INTEGER NOT NULL CHECK(member_budget=${MEMBER_BUDGET_MICROS}),
      member_count INTEGER NOT NULL CHECK(member_count=${MEMBER_COUNT}), roster_hash TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, name TEXT NOT NULL, code_hash TEXT UNIQUE NOT NULL,
      budget INTEGER NOT NULL CHECK(budget=${MEMBER_BUDGET_MICROS}), spent INTEGER NOT NULL DEFAULT 0 CHECK(spent>=0),
      reserved INTEGER NOT NULL DEFAULT 0 CHECK(reserved>=0), CHECK(spent+reserved<=budget));
    CREATE TRIGGER IF NOT EXISTS roster_cap BEFORE INSERT ON members
      WHEN (SELECT count(*) FROM members)>=${MEMBER_COUNT} BEGIN SELECT RAISE(ABORT,'roster limit'); END;
    CREATE TABLE IF NOT EXISTS requests (id TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), fingerprint TEXT NOT NULL,
      model_key TEXT NOT NULL, model_id TEXT NOT NULL, prices TEXT NOT NULL, counted_input INTEGER NOT NULL,
      max_output INTEGER NOT NULL, reservation INTEGER NOT NULL CHECK(reservation>=0 AND reservation<=${MEMBER_BUDGET_MICROS}),
      status TEXT NOT NULL CHECK(status IN ('reserved','held','completed','reconciled')),
      charged INTEGER NOT NULL DEFAULT 0 CHECK(charged>=0 AND charged<=reservation), answer TEXT NOT NULL DEFAULT '',
      usage TEXT, provider_id TEXT, observed_charge INTEGER, note TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS member_requests ON requests(member_id,status);
    CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, member_id TEXT NOT NULL REFERENCES members(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS rate_limits (key TEXT PRIMARY KEY, window INTEGER NOT NULL, count INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS runtime_flags (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `);
  function transaction(fn) {
    db.exec('BEGIN IMMEDIATE');
    try { const value = fn(); db.exec('COMMIT'); return value; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  const getMember = id => db.prepare('SELECT * FROM members WHERE id=?').get(id);
  const configured = () => Boolean(db.prepare('SELECT id FROM settings WHERE id=1').get());
  const memberDto = id => {
    const member = getMember(id);
    if (!member) return null;
    return { name: member.name, budgetMicros: member.budget, spentMicros: member.spent,
      reservedMicros: member.reserved, remainingMicros: member.budget - member.spent - member.reserved };
  };
  try {
    const verify = () => {
      if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') throw new Error('Invalid private ledger integrity');
      const count = db.prepare('SELECT count(*) AS n FROM members').get().n;
      const settings = db.prepare('SELECT * FROM settings').get();
      if (settings ? settings.schema_version !== 1 || settings.total_budget !== TOTAL_BUDGET_MICROS
        || settings.member_budget !== MEMBER_BUDGET_MICROS || settings.member_count !== MEMBER_COUNT || count !== MEMBER_COUNT : count !== 0) throw new Error('Private ledger budget/roster mismatch');
      const mismatch = db.prepare(`SELECT m.id FROM members m WHERE m.budget<>${MEMBER_BUDGET_MICROS}
        OR m.spent<>COALESCE((SELECT sum(r.charged) FROM requests r WHERE r.member_id=m.id AND r.status IN ('completed','reconciled')),0)
        OR m.reserved<>COALESCE((SELECT sum(r.reservation) FROM requests r WHERE r.member_id=m.id AND r.status IN ('reserved','held')),0) LIMIT 1`).get();
      if (mismatch) throw new Error('Private ledger accounting mismatch');
      // Only an exclusively locked startup may recover a stopped process. Audit never alters live work.
      if (recoverPending) db.prepare("UPDATE requests SET status='held', note='process_restarted', updated_at=? WHERE status='reserved'").run(Date.now());
    };
    if (readOnly) verify(); else transaction(verify);
  } catch (error) { db.close(); throw error; }

  return {
    directory,
    close() { db.close(); },
    configured,
    halted() { return Boolean(db.prepare("SELECT 1 FROM runtime_flags WHERE key='billing_halt'").get()); },
    member: memberDto,
    modelQuota(memberId, modelKey) {
      const budgetMicros = modelKey === 'astra' ? ASTRA_MEMBER_BUDGET_MICROS : null;
      const member = memberDto(memberId);
      if (!member) return { budgetMicros, remainingMicros: null };
      if (budgetMicros === null) return { budgetMicros, remainingMicros: member.remainingMicros };
      // Count old settled charges and unresolved reservations; introducing a subcap never resets prior usage.
      const used = db.prepare(`SELECT COALESCE(sum(CASE WHEN status IN ('completed','reconciled') THEN charged ELSE reservation END),0) AS micros
        FROM requests WHERE member_id=? AND model_key='astra'`).get(memberId).micros;
      return { budgetMicros, remainingMicros: Math.min(member.remainingMicros, Math.max(0, budgetMicros - used)) };
    },
    blocked(id) { return Boolean(db.prepare("SELECT 1 FROM requests WHERE member_id=? AND status IN ('reserved','held') LIMIT 1").get(id)); },
    request(id, memberId, fingerprint) {
      const row = db.prepare('SELECT * FROM requests WHERE id=?').get(id);
      if (row && (row.member_id !== memberId || row.fingerprint !== fingerprint)) throw assistantError(409, 'request_conflict', '请求编号已使用，请重新提问。');
      return row;
    },
    async initialize(rows) {
      validateRoster(rows);
      if (configured()) throw new Error('名单已初始化；禁止重置余额或重新导入。');
      const revision = rosterRevision(rows);
      const credentials = rows.map(row => ({ name: row.name, memberKey: row.memberKey, accessCode: randomBytes(32).toString('base64url') }));
      const credentialsPath = resolve(directory, 'private-claim-codes.json');
      // Create the owner-only claim file before committing hashes, so a disk failure cannot lose the only codes.
      await writeFile(credentialsPath, JSON.stringify({ warning: '仅站长分发给本人；禁止上传或提交Git。', members: credentials }, null, 2), { flag: 'wx', mode: 0o600 });
      try {
        transaction(() => {
          if (configured() || db.prepare('SELECT count(*) AS n FROM members').get().n !== 0) throw new Error('名单已初始化；禁止重置。');
          db.prepare('INSERT INTO settings VALUES(1,1,?,?,?,?)').run(TOTAL_BUDGET_MICROS, MEMBER_BUDGET_MICROS, MEMBER_COUNT, revision);
          const insert = db.prepare('INSERT INTO members(id,name,code_hash,budget) VALUES(?,?,?,?)');
          for (const credential of credentials) insert.run(randomUUID(), credential.name, digest(credential.accessCode), MEMBER_BUDGET_MICROS);
        });
      } catch (error) { await unlink(credentialsPath); throw error; }
      return { count: MEMBER_COUNT, credentialsPath };
    },
    async migrateStudentIds(rows, { lock: migrationLock } = {}) {
      const requireLock = () => {
        if (readOnly || !activeLocks.has(migrationLock) || migrationLock.directory !== directory) throw new Error('迁移必须先停止服务并独占锁定原账本。');
      };
      const requireReady = () => {
        requireLock();
        if (!configured() || db.prepare("SELECT 1 FROM requests WHERE status IN ('reserved','held') LIMIT 1").get()) throw new Error('迁移需要已初始化且没有在途或冻结请求的账本。');
      };
      requireReady();
      if (!Array.isArray(rows) || rows.some(row => !exactObject(row, ['memberKey', 'name', 'studentId'])
        || typeof row.studentId !== 'string' || !/^[0-9]{11}$/.test(row.studentId))
        || new Set(rows.map(row => row.studentId)).size !== MEMBER_COUNT) throw new Error('学号映射必须包含35个唯一的11位学号。');
      validateRoster(rows.map(({ memberKey, name }) => ({ memberKey, name })));
      const revision = db.prepare('SELECT roster_hash FROM settings WHERE id=1').get().roster_hash;
      if (rosterRevision(rows) !== revision) throw new Error('学号映射与原35人姓名及成员标识不完全匹配。');
      const credentialsPath = resolve(directory, 'private-claim-codes.json');
      const info = await lstat(credentialsPath);
      if (!info.isFile() || info.isSymbolicLink() || info.size > 32768) throw new Error('原私有领取文件不可用。');
      const original = await readFile(credentialsPath, 'utf8');
      const claims = JSON.parse(original).members;
      if (!Array.isArray(claims) || claims.some(row => !exactObject(row, ['memberKey', 'name', 'accessCode'])
        || typeof row.accessCode !== 'string' || !accessCodePattern.test(row.accessCode))) throw new Error('原私有领取文件格式无效。');
      validateRoster(claims.map(({ memberKey, name }) => ({ memberKey, name })));
      if (rosterRevision(claims) !== revision) throw new Error('原领取文件与账本名单不一致。');
      const byKey = new Map(claims.map(row => [row.memberKey, row]));
      const mappings = rows.map(row => {
        const previous = byKey.get(row.memberKey);
        const member = previous && previous.name === row.name
          ? db.prepare('SELECT id,name FROM members WHERE code_hash=?').get(digest(previous.accessCode)) : null;
        if (!member || member.name !== row.name) throw new Error('领取文件无法准确定位原账户，未改动任何账户。');
        return { id: member.id, ...row };
      });
      if (new Set(mappings.map(row => row.id)).size !== MEMBER_COUNT) throw new Error('原账户映射不唯一。');
      const suffix = randomUUID();
      const temporary = resolve(directory, `.claim-migration-${suffix}.json`);
      const backup = resolve(directory, `.claim-before-migration-${suffix}.json`);
      const createdFiles = new Set();
      const saveDurably = async (path, contents) => {
        const handle = await open(path, 'wx', 0o600);
        createdFiles.add(path);
        try { await handle.writeFile(contents); await handle.sync(); } finally { await handle.close(); }
      };
      let promoted = false, committed = false, restored = false;
      try {
        await saveDurably(backup, original);
        await saveDurably(temporary, JSON.stringify({ warning: '仅供站长保管；学号即访问码，可被知晓学号的人冒用。禁止公开整份名单。', credentialType: 'studentId',
          members: rows.map(({ memberKey, name, studentId }) => ({ memberKey, name, accessCode: studentId })) }, null, 2));
        transaction(() => {
          requireReady();
          const update = db.prepare('UPDATE members SET code_hash=? WHERE id=?');
          // Clear old hashes within the same transaction so legitimate identifier corrections may swap values.
          for (const row of mappings) update.run(digest(randomBytes(32)), row.id);
          for (const row of mappings) update.run(digest(row.studentId), row.id);
          db.prepare('DELETE FROM sessions').run();
          renameSync(temporary, credentialsPath);
          promoted = true;
        });
        committed = true;
      } catch (error) {
        if (promoted) { renameSync(backup, credentialsPath); restored = true; }
        throw error;
      } finally {
        if (createdFiles.has(temporary)) await unlink(temporary).catch(() => {});
        // A crash/failed restore leaves the owner-only backup for manual recovery; never discard that evidence.
        if (createdFiles.has(backup) && (!promoted || committed || restored)) await unlink(backup).catch(() => {});
      }
      return { count: MEMBER_COUNT, credentialsPath };
    },
    throttle(key, limit, periodMs = 60000) {
      transaction(() => {
        const window = Math.floor(Date.now() / periodMs);
        const row = db.prepare('SELECT window,count FROM rate_limits WHERE key=?').get(key);
        if (row?.window === window && row.count >= limit) throw assistantError(429, 'rate_limit', '尝试较频繁，请稍后再试。');
        db.prepare('INSERT INTO rate_limits VALUES(?,?,1) ON CONFLICT(key) DO UPDATE SET window=excluded.window,count=CASE WHEN window=excluded.window THEN count+1 ELSE 1 END').run(key, window);
        db.prepare('DELETE FROM rate_limits WHERE window<?').run(window - 2);
      });
    },
    login(code, previousToken = null) {
      const hash = digest(typeof code === 'string' ? code : '');
      const member = db.prepare('SELECT id FROM members WHERE code_hash=?').get(hash);
      if (!configured() || !member || !accessCodePattern.test(code)) throw assistantError(401, 'login_failed', '学号无效或暂不可用。');
      const token = randomBytes(32).toString('base64url');
      transaction(() => {
        db.prepare('DELETE FROM sessions WHERE expires<=?').run(Date.now());
        if (previousToken) db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(previousToken));
        // Bound saved sessions and rotate old logins for this member only.
        db.prepare('DELETE FROM sessions WHERE member_id=?').run(member.id);
        db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), member.id, Date.now() + SESSION_MS);
      });
      return { token, memberId: member.id };
    },
    authenticate(token) {
      if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
      return db.prepare('SELECT member_id AS id FROM sessions WHERE hash=? AND expires>?').get(digest(token), Date.now())?.id ?? null;
    },
    logout(token) { if (typeof token === 'string') db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(token)); },
    reserve({ requestId, memberId, fingerprint, model, inputTokens, reservation }) {
      if (!validRequestId(requestId) || !safeInteger(reservation) || !Number.isSafeInteger(inputTokens) || inputTokens < 1 || inputTokens > 8000) throw new Error('Invalid reservation');
      return transaction(() => {
        const existing = this.request(requestId, memberId, fingerprint);
        if (existing) return { created: false, request: existing };
        if (this.halted()) throw assistantError(503, 'billing_halted', '费用核对异常，所有付费请求已暂停。');
        const member = getMember(memberId);
        if (!member) throw assistantError(401, 'authentication_required', '请先使用本人学号登录。');
        if (this.blocked(memberId)) throw assistantError(423, 'account_held', '上次请求尚待站长核对，暂不能继续消费。');
        if (member.budget - member.spent - member.reserved < reservation) throw assistantError(402, 'insufficient_balance', '余额不足以预留本次请求的最高费用。');
        if (model.key === 'astra' && this.modelQuota(memberId, model.key).remainingMicros < reservation) throw assistantError(402, 'model_quota_exceeded', 'GPT-6 Astra的个人终身子额度不足以预留本次请求；仍可使用其它模型的剩余总额度。');
        db.prepare('UPDATE members SET reserved=reserved+? WHERE id=?').run(reservation, memberId);
        db.prepare("INSERT INTO requests(id,member_id,fingerprint,model_key,model_id,prices,counted_input,max_output,reservation,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,'reserved',?,?)")
          .run(requestId, memberId, fingerprint, model.key, model.apiModel, JSON.stringify(model.prices), inputTokens, model.maxOutputTokens, reservation, Date.now(), Date.now());
        return { created: true, request: this.request(requestId, memberId, fingerprint) };
      });
    },
    hold(requestId, reason, providerId = null) {
      db.prepare("UPDATE requests SET status='held',note=?,provider_id=COALESCE(?,provider_id),updated_at=? WHERE id=? AND status='reserved'").run(reason, providerId, Date.now(), requestId);
    },
    halt(requestId, { reason, chargedMicros, usage, providerId }) {
      if (chargedMicros !== null && (!Number.isSafeInteger(chargedMicros) || chargedMicros < 0)) throw new Error('Invalid observed cost');
      transaction(() => {
        db.prepare("INSERT INTO runtime_flags VALUES('billing_halt',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(reason);
        db.prepare("UPDATE requests SET status='held',note=?,observed_charge=?,usage=?,provider_id=?,updated_at=? WHERE id=? AND status IN ('reserved','held')")
          .run(reason, chargedMicros, JSON.stringify(usage), providerId, Date.now(), requestId);
      });
    },
    settle(requestId, { chargedMicros, answer, usage, providerId }) {
      return transaction(() => {
        const row = db.prepare('SELECT * FROM requests WHERE id=?').get(requestId);
        if (!row || !['reserved', 'held'].includes(row.status) || !safeInteger(chargedMicros, row.reservation)) throw new Error('Invalid settlement');
        db.prepare('UPDATE members SET reserved=reserved-?,spent=spent+? WHERE id=?').run(row.reservation, chargedMicros, row.member_id);
        db.prepare("UPDATE requests SET status='completed',charged=?,answer=?,usage=?,provider_id=?,note=NULL,updated_at=? WHERE id=?")
          .run(chargedMicros, answer, JSON.stringify(usage), providerId, Date.now(), requestId);
        return { answer, status: 'completed', chargedMicros, requestId };
      });
    },
    reconcile(requestId, chargedMicros, note) {
      if (!validRequestId(requestId) || !safeInteger(chargedMicros) || typeof note !== 'string' || [...note.trim()].length < 20 || [...note].length > 1000) throw new Error('核对需要请求UUID、整数微美元及至少20字的上游账单证据说明。');
      return transaction(() => {
        const row = db.prepare('SELECT * FROM requests WHERE id=?').get(requestId);
        if (!row || row.status !== 'held' || chargedMicros > row.reservation || row.observed_charge > row.reservation) throw new Error('只能核对冻结请求，金额不能高于原预占；上游越限需先人工处理全局异常。');
        db.prepare('UPDATE members SET reserved=reserved-?,spent=spent+? WHERE id=?').run(row.reservation, chargedMicros, row.member_id);
        db.prepare("UPDATE requests SET status='reconciled',charged=?,note=?,updated_at=? WHERE id=?").run(chargedMicros, note.trim(), Date.now(), requestId);
      });
    },
    audit() {
      const totals = db.prepare('SELECT count(*) AS members,COALESCE(sum(budget),0) AS allocatedMicros,COALESCE(sum(spent),0) AS spentMicros,COALESCE(sum(reserved),0) AS reservedMicros FROM members').get();
      const held = db.prepare("SELECT id AS requestId,status,reservation AS reservedMicros,observed_charge AS observedActualMicros,provider_id AS providerId,note FROM requests WHERE status IN ('reserved','held') ORDER BY created_at").all();
      return { configured: configured(), halted: this.halted(), totalBudgetMicros: TOTAL_BUDGET_MICROS, unallocatedMicros: TOTAL_BUDGET_MICROS - totals.allocatedMicros, ...totals, held };
    },
  };
}
