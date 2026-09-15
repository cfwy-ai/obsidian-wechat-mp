// 端到端冒烟：真文章 + 真主题走完前四块，看产出是否合理。
// 这不是单元测试，是用来肉眼核对的验证工具。

import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderArticle } from '../src/pipeline.mjs';
import { listThemes } from '../src/theme.mjs';
import { createFilesystemImageResolver } from './filesystem-image-resolver.mjs';

const VAULT = process.env.WECHAT_MP_VAULT ?? '';
const firstExisting = (paths) => paths.find(existsSync) ?? paths[0];
const ART = firstExisting([
  join(VAULT, '06｜个人账号运营/3. 原创文章'),
  join(VAULT, '06｜个人账号运营/4. 原创文章'),
]);
const ATT = join(VAULT, '00｜本库附件');
const THEMES = firstExisting([
  join(VAULT, '06｜个人账号运营/2. 排版配图/5. 图文主题仓库'),
  join(VAULT, '06｜个人账号运营/3. 正文排版/模板仓库'),
  join(VAULT, '06｜个人账号运营/3. 正文排版'),
]);
const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');

const [, , articleArg, themeArg] = process.argv;
const article = articleArg || '1. Claude 藏了三个模式，90% 的人只会用第一个.md';
const wanted = themeArg || '莫兰迪晨';

// 预览阶段图片不上传，直接用本地路径
const resolve = createFilesystemImageResolver(ATT);

const raw = readFileSync(join(ART, article), 'utf8');
const { themes } = listThemes(THEMES);
const theme = themes.find((t) => t.name === wanted) ?? themes[0];
const result = renderArticle({
  source: raw,
  themeCss: theme.css,
  themeComponents: theme.components,
  themeAssets: theme.assets,
  resolve,
});
const { html: inlined, images, inlineLevel: level, warnings } = result;

console.log(`文章  ${article}`);
console.log(`主题  ${theme.name}`);
console.log(`图片  ${images.length} 张`);
console.log(`内联  ${level}`);
warnings.forEach((w) => console.log(`  ⚠ ${w}`));

const count = (re, s = inlined) => (s.match(re) || []).length;

// 伪元素带来的增量 = 开与关两次内联的 span 差值，这是唯一可靠的量法
const { html: withoutPseudo } = renderArticle({
  source: raw,
  themeCss: theme.css.replace(/[^{}]*::(before|after)\s*\{[^}]*\}/g, ''),
  themeComponents: theme.components,
  themeAssets: theme.assets,
  resolve,
});
const pseudoGain = count(/<span /g) - count(/<span /g, withoutPseudo);

console.log('\n产出结构：');
console.log(`  带 style 的元素   ${count(/style="/g)}`);
console.log(`  img 标签          ${count(/<img /g)}`);
console.log(`  h2 + content span ${count(/<h2\b[^>]*>(?:(?!<\/h2>)[\s\S])*?<span class="content"/g)}`);
console.log(`  伪元素生成的 span ${pseudoGain}`);
console.log(`  残留 <style> 块   ${count(/<style/g)}`);
console.log(`  残留 var\\(\\)       ${count(/var\(/g)}`);

// 预览外壳模拟手机视口。box-sizing 只加在外壳上，不进导出的 HTML，
// 否则等于偷偷替微信补了它没有的规则，预览就不诚实了。
writeFileSync(join(OUT, 'preview.html'),
  `<!doctype html><meta charset="utf-8"><title>${theme.name}</title>` +
  `<style>body{margin:0;background:#e9e9e9}` +
  `.shell{width:375px;background:#fff;overflow:hidden}` +
  `.shell #nice,.shell #nice *{box-sizing:border-box;max-width:100%}</style>` +
  `<div class="shell">${inlined}</div>`);
console.log(`\n已写出 out/preview.html`);
