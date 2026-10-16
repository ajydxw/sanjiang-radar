import { readFile } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createAssistantStore, validateAssistantPublication } from './assistant-questions.mjs';
import { ANSWER_MAX_CHARS } from '../sources/question-policy.mjs';
import { buildQuestionContext } from './assistant-context.mjs';
import { assertPublicFeed } from '../sources/public-feed.mjs';

const checks = ['scope', 'facts', 'timing', 'fields', 'privacy'];

export async function publishReviewedBatch(store, batch, mode = 'publish') {
  if (!['publish', 'draft'].includes(mode)) throw new Error('未知答复处理方式。');
  if (!Array.isArray(batch) || !batch.length || batch.length > 10) throw new Error('一次发布 1–10 条复核答复。');
  const pending = new Set((await store.listPending()).map(item => item.id));
  const seen = new Set();
  const validated = [];
  for (const item of batch) {
    if (!item || typeof item !== 'object' || !pending.has(item.id) || seen.has(item.id)
      || item.model !== 'gpt-6.1-sol' || item.reasoningEffort !== 'high'
      || !checks.every(key => item.review?.[key] === true)) throw new Error('答复未通过模型、范围、来源或五项复核校验。');
    const { status, answer, sources, model, reasoningEffort } = item;
    validated.push({ id: item.id, ...validateAssistantPublication({ status, answer, sources, model, reasoningEffort }, { maxAnswerChars: ANSWER_MAX_CHARS }) });
    seen.add(item.id);
  }
  const published = [];
  for (const { id, status, answer, sources, model, reasoningEffort } of validated) {
    await (mode === 'draft' ? store.stageDraft : store.publish)(id, { status, answer, sources, model, reasoningEffort });
    published.push(id);
  }
  return mode === 'draft' ? { drafted: published } : { published };
}

async function main() {
  const [command, file, ...extra] = process.argv.slice(2);
  if (extra.length || !['pending', 'context', 'publish', 'draft'].includes(command) || (command === 'pending' && file)) {
    throw new Error('用法：assistant-queue.mjs pending | context 问题ID | publish/draft .sites-runtime/答复.json');
  }
  const store = await createAssistantStore();
  if (command === 'pending') {
    const pending = (await store.adminList()).filter(item => item.status === 'pending' && !item.draft);
    console.log(JSON.stringify({ pendingCount: pending.length, untrustedVisitorData: true, questions: pending.slice(0, 5) }, null, 2));
    return;
  }
  const privateRoot = fileURLToPath(new URL('../.sites-runtime/', import.meta.url));
  if (command === 'context') {
    const question = (await store.listPending()).find(item => item.id === file);
    if (!question) throw new Error('问题不存在或已处理。');
    let matched = null;
    for (const name of ['sanjiang-web', 'pu', 'wechat', 'competitions', 'exams']) {
      const feed = JSON.parse(await readFile(fileURLToPath(new URL(`../public/data/${name}.json`, import.meta.url)), 'utf8'));
      assertPublicFeed(feed);
      matched ??= feed.items.find(item => item.id === question.contextId) ?? null;
    }
    const context = buildQuestionContext(question, matched);
    console.log(context.serialized);
    return;
  }
  const path = file && resolve(file);
  const inside = path && relative(privateRoot, path);
  if (!inside || isAbsolute(inside) || inside === '..' || inside.startsWith(`..${sep}`)) throw new Error('答复文件必须位于本项目私有运行目录。');
  const raw = await readFile(path, 'utf8');
  if (Buffer.byteLength(raw) > 128 * 1024) throw new Error('答复文件过大。');
  console.log(JSON.stringify(await publishReviewedBatch(store, JSON.parse(raw), command)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main().catch(() => { console.error('问答队列操作失败；请核对命令、文件与复核结果。'); process.exitCode = 1; });
}
