import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEditedDocumentTitle, documentTitleForDisplay, saveDocumentTitle } from '../src/document-title.mjs';

test('标题换行只保留位置，不创建第二份标题文字', () => {
  const parsed = parseEditedDocumentTitle('中文😀\n标题');
  assert.deepEqual(parsed, {name:'中文😀标题',breaks:[3]});
  assert.equal(documentTitleForDisplay(parsed.name,{title_breaks:parsed.breaks}), '中文😀\n标题');
  assert.equal(documentTitleForDisplay('文件名',{display_title:'另一份名字'}),'文件名');
  assert.equal(documentTitleForDisplay('文件名',{display_title:'文件\n名'}),'文件\n名');
  for(const value of ['', '  ', 'a/b', 'a\\b', 'a:b']) assert.throws(()=>parseEditedDocumentTitle(value));
});

test('文首编辑同步改文件名，保留其他属性，并只写换行索引', async () => {
  const file={path:'文章/旧名.md',basename:'旧名',extension:'md'};
  const frontmatter={display_title:'旧显示名',description:'保留简介'};
  const calls=[];
  const app={vault:{getAbstractFileByPath:()=>null},fileManager:{
    renameFile:async(f,p)=>{calls.push(p);f.path=p;f.basename=p.split('/').pop().slice(0,-3);},
    processFrontMatter:async(_f,update)=>update(frontmatter),
  }};
  await saveDocumentTitle(app,file,'新\n标题');
  assert.equal(file.path,'文章/新标题.md');
  assert.deepEqual(frontmatter,{description:'保留简介',title_breaks:[1]});
  await saveDocumentTitle(app,file,'新标题');
  assert.equal(calls.length,1);
  assert.deepEqual(frontmatter,{description:'保留简介'});
});

test('同名冲突不改文件也不改属性', async () => {
  const app={vault:{getAbstractFileByPath:()=>({path:'同名.md'})},fileManager:{
    renameFile:()=>{throw new Error('不应改名');},processFrontMatter:()=>{throw new Error('不应写入');},
  }};
  await assert.rejects(()=>saveDocumentTitle(app,{path:'旧名.md'},'同名'),/同名/);
});
