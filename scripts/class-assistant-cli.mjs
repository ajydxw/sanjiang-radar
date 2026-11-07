import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { acquireClassAssistantLock, createClassAssistantStore, privatePath } from './class-assistant-store.mjs';

export async function classAssistantCli(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const options = new Map();
  for (let i = 0; i < rest.length; i += 2) {
    if (!rest[i]?.startsWith('--') || !rest[i + 1] || options.has(rest[i])) throw new Error('CLI参数无效。');
    options.set(rest[i], rest[i + 1]);
  }
  const valid = ['init', 'migrate-student-ids'].includes(command) ? ['--roster'] : command === 'audit' ? [] : command === 'reconcile' ? ['--request-id', '--charged-micros', '--note'] : null;
  if (!valid || options.size !== valid.length || valid.some(key => !options.has(key))) throw new Error('用法：init或migrate-student-ids --roster 私有JSON路径 | audit | reconcile --request-id UUID --charged-micros 整数 --note 上游账单核对证据');
  const lock = command === 'audit' ? null : await acquireClassAssistantLock();
  let store;
  try {
    store = await createClassAssistantStore({ lock, readOnly: command === 'audit', recoverPending: command === 'reconcile' });
    if (command === 'init' || command === 'migrate-student-ids') {
      const text = await readFile(privatePath(resolve(options.get('--roster'))), 'utf8');
      if (Buffer.byteLength(text) > 32768) throw new Error('名单文件过大。');
      if (command === 'init') {
        const initialized = await store.initialize(JSON.parse(text));
        console.log(`已初始化${initialized.count}个独立账户；私有领取文件已写入 .sites-runtime/class-assistant/private-claim-codes.json。请只将每人的访问码分发给本人。`);
      } else {
        const migrated = await store.migrateStudentIds(JSON.parse(text), { lock });
        console.log(`已将${migrated.count}个既有账户切换为学号访问码，并撤销旧会话；账户及费用账本保留。私有领取文件已更新，不输出学号或凭证。`);
      }
    } else if (command === 'audit') console.log(JSON.stringify(store.audit(), null, 2));
    else {
      const amount = options.get('--charged-micros');
      if (!/^(0|[1-9]\d{0,7})$/.test(amount)) throw new Error('金额必须是非负整数微美元。');
      store.reconcile(options.get('--request-id'), Number(amount), options.get('--note'));
      console.log('已按站长提供的上游账单证据核对该冻结请求；未重新发送上游请求。');
    }
  } finally { store?.close(); await lock?.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await classAssistantCli(); }
  catch { console.error('操作未完成。请检查CLI参数、私有名单、账本状态及目录权限；不会输出名单或凭证。'); process.exitCode = 1; }
}
