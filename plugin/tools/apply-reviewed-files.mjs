import { mkdir, readFile, writeFile, lstat, rename, rm, cp } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { digest, option } from '../scripts/template-files.mjs';
import { safeThemeRelativePath } from '../src/theme-package.mjs';

const existsBytes = async path => {
  try { return await readFile(path); } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};
const fileHash = async path => { const bytes = await existsBytes(path); return bytes === null ? null : digest(bytes); };

async function safeTarget(root, relative) {
  safeThemeRelativePath(relative);
  const absolute = join(resolve(root), relative);
  let cursor = absolute;
  while (cursor !== resolve(root)) {
    try { if ((await lstat(cursor)).isSymbolicLink()) throw new Error(`目标不能经由软链接：${cursor}`); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    cursor = dirname(cursor);
  }
  if ((await lstat(resolve(root))).isSymbolicLink()) throw new Error('目标根不能是软链接');
  return absolute;
}

async function atomicWrite(path, bytes) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = join(dirname(path), `.visual-sync-${randomUUID()}`);
  try { await writeFile(temporary, bytes, { flag: 'wx' }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

/** Review and byte checks all complete before any live/public mutation. */
export async function preflightReviewedFiles(plan, review) {
  if (plan.schema_version !== 1 || !Array.isArray(plan.operations) || !plan.operations.length) throw new Error('无有效同步计划');
  if (review.schema_version !== 1 || review.reviewed !== true || !review.reviewed_by) throw new Error('必须先完成逐图审阅');
  if (!Number.isInteger(plan.expected_visual_count) || plan.expected_visual_count < 1
    || !Array.isArray(plan.visual_sources) || plan.visual_sources.length !== plan.expected_visual_count) throw new Error('视觉源清单数量不完整');
  if (new Set(plan.visual_sources.map(item => item.file)).size !== plan.visual_sources.length) throw new Error('视觉源清单存在重复文件');
  const approved = new Map((review.visuals ?? []).filter(item => item.reviewed === true).map(item => [item.file, item.sha256]));
  for (const visual of plan.visual_sources) {
    safeThemeRelativePath(visual.file, '审阅图片');
    if (!visual.sha256 || approved.get(visual.file) !== visual.sha256) throw new Error(`未审阅当前图片：${visual.file}`);
    if (await fileHash(visual.source) !== visual.sha256) throw new Error(`图片在审阅后改变：${visual.file}`);
    if (visual.preserve_sha256 && visual.sha256 !== visual.preserve_sha256) throw new Error(`已批准图片必须原样保留：${visual.file}`);
  }
  const targets = new Set();
  for (const operation of plan.operations) {
    if (!['write', 'delete'].includes(operation.action) || !Object.hasOwn(operation, 'before_sha256')) throw new Error('操作缺少明确动作或原文件指纹');
    if (!Object.hasOwn(plan.roots, operation.root)) throw new Error('未登记目标根');
    const target = await safeTarget(plan.roots[operation.root], operation.path);
    if (targets.has(target)) throw new Error(`目标重复：${target}`);
    targets.add(target);
    if (await fileHash(target) !== operation.before_sha256) throw new Error(`目标在制表后改变：${operation.path}`);
    if (operation.action === 'write' && (!operation.sha256 || await fileHash(operation.source) !== operation.sha256)) {
      throw new Error(`待同步内容改变：${operation.path}`);
    }
  }
  return { operations: plan.operations.length, visuals: plan.visual_sources.length, reviewedBy: review.reviewed_by };
}

/** Restore only known transaction bytes; do not overwrite later user edits. */
export async function rollbackReviewedFiles(receiptPath) {
  const receipt = JSON.parse(await readFile(receiptPath, 'utf8'));
  const restored = [], conflicts = [];
  for (const operation of [...receipt.plan.operations].reverse()) {
    const target = await safeTarget(receipt.plan.roots[operation.root], operation.path);
    const current = await fileHash(target);
    if (current === operation.before_sha256) continue;
    const expectedAfter = operation.action === 'delete' ? null : operation.sha256;
    if (current !== expectedAfter) { conflicts.push(operation.path); continue; }
    const backup = join(receipt.backup, 'files', operation.root, operation.path);
    if (operation.before_sha256 === null) await rm(target, { force: true });
    else {
      const bytes = await readFile(backup);
      if (digest(bytes) !== operation.before_sha256) throw new Error(`回滚备份损坏：${operation.path}`);
      await atomicWrite(target, bytes);
    }
    restored.push(operation.path);
  }
  receipt.status = conflicts.length ? 'rollback-needs-review' : 'rolled-back';
  receipt.rollback = { restored, conflicts };
  await atomicWrite(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
  if (conflicts.length) throw new Error(`回滚保留了后续修改，需检查：${conflicts.join('、')}`);
  return receipt.rollback;
}

export async function applyReviewedFiles({ plan, review, backup, dryRun = false, afterOperation } = {}) {
  const checked = await preflightReviewedFiles(plan, review);
  if (dryRun) return { ...checked, dryRun: true };
  const backupRoot = resolve(backup);
  for (const root of Object.values(plan.roots)) if (backupRoot === resolve(root) || backupRoot.startsWith(resolve(root) + '/')) throw new Error('备份必须位于正式目标目录以外');
  await mkdir(backupRoot, { recursive: true });
  const lock = join(backupRoot, '.transaction-lock');
  await writeFile(lock, String(process.pid), { flag: 'wx' });
  const receiptPath = join(backupRoot, 'transaction.json');
  let receipt;
  try {
    if (await existsBytes(receiptPath)) throw new Error('该备份目录已有事务，请使用新的目录');
    for (const item of plan.archive_directories ?? []) {
      const source = await safeTarget(plan.roots[item.root], item.path);
      await cp(source, join(backupRoot, 'archives', item.root, item.path), { recursive: true, errorOnExist: true, force: false, dereference: false });
    }
    for (const operation of plan.operations) {
      if (operation.before_sha256 === null) continue;
      const source = await safeTarget(plan.roots[operation.root], operation.path);
      const bytes = await readFile(source);
      if (digest(bytes) !== operation.before_sha256) throw new Error('备份期间目标发生变化');
      await atomicWrite(join(backupRoot, 'files', operation.root, operation.path), bytes);
    }
    receipt = { schema_version: 1, status: 'prepared', backup: backupRoot, review, plan, completed: [] };
    await atomicWrite(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    await preflightReviewedFiles(plan, review);
    for (const operation of plan.operations) {
      const target = await safeTarget(plan.roots[operation.root], operation.path);
      if (await fileHash(target) !== operation.before_sha256) throw new Error(`执行前目标发生变化：${operation.path}`);
      if (operation.action === 'delete') await rm(target);
      else {
        const bytes = await readFile(operation.source);
        if (digest(bytes) !== operation.sha256) throw new Error('执行期间源内容发生变化');
        await atomicWrite(target, bytes);
      }
      receipt.completed.push(`${operation.root}/${operation.path}`);
      receipt.status = 'applying';
      await atomicWrite(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
      await afterOperation?.(operation);
    }
    for (const operation of plan.operations) {
      const expected = operation.action === 'delete' ? null : operation.sha256;
      if (await fileHash(join(plan.roots[operation.root], operation.path)) !== expected) throw new Error(`同步后的文件校验失败：${operation.path}`);
    }
    receipt.status = 'complete';
    await atomicWrite(receiptPath, JSON.stringify(receipt, null, 2) + '\n');
    return { ...checked, backup: backupRoot, receipt: receiptPath, status: 'complete' };
  } catch (error) {
    if (receipt) {
      try { await rollbackReviewedFiles(receiptPath); }
      catch (rollbackError) { throw new AggregateError([error, rollbackError], '同步中断；部分回滚需要检查，备份完整保留。'); }
    }
    throw error;
  } finally { await rm(lock, { force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const rollback = option('--rollback');
  if (rollback) console.log(JSON.stringify(await rollbackReviewedFiles(resolve(rollback)), null, 2));
  else {
    const planPath = option('--plan'), reviewPath = option('--review'), backup = option('--backup');
    if (!planPath || !reviewPath || (!backup && !process.argv.includes('--dry-run'))) throw new Error('需要 --plan、--review 和 --backup（或 --dry-run）');
    console.log(JSON.stringify(await applyReviewedFiles({ plan: JSON.parse(await readFile(planPath, 'utf8')),
      review: JSON.parse(await readFile(reviewPath, 'utf8')), backup, dryRun: process.argv.includes('--dry-run') }), null, 2));
  }
}
