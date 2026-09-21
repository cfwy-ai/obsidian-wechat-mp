import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WENXIN_SOURCE_SHA256 = '977dede6dd36112d941f9823d120f77a0481f309045422ee0393ec710a58a3b2';

/** A same-family encoding repair. Originals remain in the exported package. */
export async function prepareFontCompatibility(font, outputRoot) {
  if (font.sha256 !== WENXIN_SOURCE_SHA256) return font;
  if (!font.coverage_file) throw new Error('文心喜乐兼容处理需要原始覆盖表');
  const file = font.file.replace(/\.woff2$/i, '.compat.woff2');
  const coverageFile = font.coverage_file.replace(/\.json$/i, '.compat.json');
  const reportFile = font.file.replace(/\.woff2$/i, '.compatibility.json');
  const script = fileURLToPath(new URL('./normalize-wenxin-font.py', import.meta.url));
  const result = spawnSync(process.env.WECHAT_MP_FONT_PYTHON || 'python3', [script,
    '--source', join(outputRoot, font.file), '--coverage', join(outputRoot, font.coverage_file),
    '--output', join(outputRoot, file), '--output-coverage', join(outputRoot, coverageFile),
    '--report', join(outputRoot, reportFile)], { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`文心喜乐兼容处理失败；请配置含 fontTools 及 Brotli 的 WECHAT_MP_FONT_PYTHON。\n${result.stderr || result.error || ''}`);
  const report = JSON.parse(await readFile(join(outputRoot, reportFile), 'utf8'));
  return { ...font, file, sha256: report.output.sha256, coverage_file: coverageFile,
    compatibility: { source_file: font.file, source_sha256: font.sha256,
      source_coverage_file: font.coverage_file, source_coverage_sha256: report.source_coverage.sha256,
      report_file: reportFile } };
}
