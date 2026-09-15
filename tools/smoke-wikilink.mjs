import { convertEmbeds } from '../src/wikilink.mjs';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const VAULT = process.env.WECHAT_MP_VAULT ?? '';
const ART = [
  join(VAULT, '06｜个人账号运营/3. 原创文章'),
  join(VAULT, '06｜个人账号运营/4. 原创文章'),
].find(existsSync);
const ATT = join(VAULT, '00｜本库附件');

const resolve = (t) => existsSync(join(ATT, t))
  ? { url: `local://${t}`, filePath: join(ATT, t) }
  : null;

let totalImg = 0, totalWarn = 0;
for (const f of readdirSync(ART).filter(f => f.endsWith('.md'))) {
  const { images, warnings } = convertEmbeds(readFileSync(join(ART, f), 'utf8'), resolve);
  totalImg += images.length; totalWarn += warnings.length;
  if (warnings.length) {
    console.log(`\n【${f.slice(0, 30)}】`);
    warnings.forEach(w => console.log('  ⚠ ' + w));
  }
}
console.log(`\n合计：解析到图片 ${totalImg} 张，警告 ${totalWarn} 条`);
