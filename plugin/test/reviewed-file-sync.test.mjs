import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { digest } from '../scripts/template-files.mjs';
import { applyReviewedFiles, rollbackReviewedFiles } from '../tools/apply-reviewed-files.mjs';

async function fixture(fn) {
  const root = await mkdtemp(join(tmpdir(), 'wechat-reviewed-sync-'));
  try {
    const target = join(root, 'target'); await mkdir(target);
    await writeFile(join(target, 'existing.txt'), 'old content');
    await writeFile(join(target, 'retire.txt'), 'retired content');
    const source = join(root, 'reviewed.png'); await writeFile(source, 'reviewed bytes');
    const imageHash = digest('reviewed bytes');
    const plan = { schema_version:1, roots:{live:target}, expected_visual_count:1,
      visual_sources:[{file:'reviewed.png',source,sha256:imageHash,preserve_sha256:imageHash}],
      operations:[{root:'live',path:'existing.txt',action:'write',before_sha256:digest('old content'),source,sha256:imageHash},
        {root:'live',path:'new.txt',action:'write',before_sha256:null,source,sha256:imageHash},
        {root:'live',path:'retire.txt',action:'delete',before_sha256:digest('retired content')}] };
    const review = {schema_version:1,reviewed:true,reviewed_by:'fixture reviewer',visuals:[{file:'reviewed.png',sha256:imageHash,reviewed:true}]};
    await fn({root,target,source,plan,review,backup:join(root,'backup')});
  } finally { await rm(root,{recursive:true,force:true}); }
}

test('未逐图审阅或文件在审阅后改变时，同步不写入正式目标',()=>fixture(async({target,source,plan,review,backup})=>{
  await assert.rejects(applyReviewedFiles({plan,review:{...review,reviewed:false},backup}),/逐图审阅/);
  await writeFile(source,'changed bytes');
  await assert.rejects(applyReviewedFiles({plan,review,backup}),/审阅后改变/);
  assert.equal(await readFile(join(target,'existing.txt'),'utf8'),'old content');
  await assert.rejects(stat(backup),{code:'ENOENT'});
}));

test('正式目标变动时不覆盖；dry-run不创建备份或新增文件',()=>fixture(async({target,plan,review,backup})=>{
  assert.equal((await applyReviewedFiles({plan,review,dryRun:true})).dryRun,true);
  await assert.rejects(stat(join(target,'new.txt')),{code:'ENOENT'});
  await writeFile(join(target,'existing.txt'),'user edit');
  await assert.rejects(applyReviewedFiles({plan,review,backup}),/目标在制表后改变/);
  assert.equal(await readFile(join(target,'existing.txt'),'utf8'),'user edit');
}));

test('中途失败会恢复旧文件并移除新文件，尚未执行的删除保留',()=>fixture(async({target,plan,review,backup})=>{
  let count=0;
  await assert.rejects(applyReviewedFiles({plan,review,backup,afterOperation:()=>{if(++count===2)throw new Error('simulate interrupted sync')}}),/simulate interrupted sync/);
  assert.equal(await readFile(join(target,'existing.txt'),'utf8'),'old content');
  assert.equal(await readFile(join(target,'retire.txt'),'utf8'),'retired content');
  await assert.rejects(stat(join(target,'new.txt')),{code:'ENOENT'});
  assert.equal(JSON.parse(await readFile(join(backup,'transaction.json'),'utf8')).status,'rolled-back');
}));

test('成功同步可回滚，回滚遇到后续用户修改会保留该修改',()=>fixture(async({target,plan,review,backup})=>{
  const result=await applyReviewedFiles({plan,review,backup});
  assert.equal(await readFile(join(target,'new.txt'),'utf8'),'reviewed bytes');
  await assert.rejects(stat(join(target,'retire.txt')),{code:'ENOENT'});
  await writeFile(join(target,'existing.txt'),'later user edit');
  await assert.rejects(rollbackReviewedFiles(result.receipt),/后续修改/);
  assert.equal(await readFile(join(target,'existing.txt'),'utf8'),'later user edit');
  assert.equal(await readFile(join(target,'retire.txt'),'utf8'),'retired content');
  await assert.rejects(stat(join(target,'new.txt')),{code:'ENOENT'});
}));
