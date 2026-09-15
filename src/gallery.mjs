// Obsidian gallery callout → 公众号可复制的静态等高行。
//
// 微信粘贴不能依赖 flex/grid/calc，因而在渲染时按每张图的固有比例
// 计算百分比宽度，再让 Juice 把这些受信规则内联到具体元素。

import {
  fenceText,
  isImageTarget,
  stripMarkdownContainers,
} from './wikilink.mjs';

const GALLERY_HEADER = /^ {0,3}>\s*\[!blank\|gallery\]\s*$/i;
const QUOTED_LINE = /^ {0,3}>\s?/;
const EMBED = /!\[\[([^\]]+)\]\]/g;
const GALLERY_GAP_PERCENT = 1.5;

const formatPercent = (value) => Number(value.toFixed(6)).toString();

const targetFromEmbed = (inner) => {
  const bar = inner.indexOf('|');
  return (bar === -1 ? inner : inner.slice(0, bar)).trim();
};

const imageTargetsInRow = (lines) => {
  const targets = [];
  for (const line of lines) {
    const matches = [...line.matchAll(EMBED)];
    if (matches.length === 0 || line.replace(EMBED, '').trim()) return null;
    targets.push(
      ...matches.map((match) => targetFromEmbed(match[1])).filter(isImageTarget),
    );
  }
  return targets.length > 0 ? targets : null;
};

const resolvedDimensions = (value) => {
  if (!value || typeof value !== 'object') return null;
  const width = Number(value.width);
  const height = Number(value.height);
  return Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? { width, height }
    : null;
};

const rowCss = (id, ratios) => {
  const selector = `#nice [data-wechat-gallery-row="${id}"]`;
  const base = [
    `${selector}{display:block!important;font-size:0!important;line-height:0!important;` +
    'text-align:left!important;text-indent:0!important;}',
  ];

  if (!ratios) {
    base.push(
      `${selector}>img{display:block!important;width:100%!important;max-width:100%!important;` +
      'height:auto!important;margin-left:auto!important;margin-right:auto!important;vertical-align:top!important;' +
      'border-width:0!important;padding:0!important;}',
    );
    return base.join('\n');
  }

  const count = ratios.length;
  const gapPercent = count > 1
    ? Math.min(GALLERY_GAP_PERCENT, 24 / (count - 1))
    : 0;
  const available = 100 - gapPercent * Math.max(0, count - 1);
  const sum = ratios.reduce((total, ratio) => total + ratio, 0);
  let used = 0;
  base.push(
    `${selector}>img{display:inline-block!important;height:auto!important;vertical-align:top!important;` +
    'border-width:0!important;padding:0!important;}',
  );
  for (let index = 0; index < count; index += 1) {
    const width = index === count - 1
      ? available - used
      : available * ratios[index] / sum;
    used += width;
    const gap = index === 0 ? 0 : gapPercent;
    const value = formatPercent(width);
    base.push(
      `${selector}>img:nth-child(${index + 1}){width:${value}%!important;max-width:${value}%!important;` +
      `margin-left:${formatPercent(gap)}%!important;margin-right:0!important;}`,
    );
  }
  return base.join('\n');
};

const splitRows = (quotedLines) => {
  const rows = [];
  let current = [];
  const flush = () => {
    if (current.length > 0) rows.push(current);
    current = [];
  };
  for (const line of quotedLines) {
    if (!line.trim()) flush();
    else current.push(line);
  }
  flush();
  return rows;
};

const openingFence = (line) => {
  const container = stripMarkdownContainers(line);
  const run = /^(`{3,}|~{3,})/.exec(fenceText(line))?.[1] ?? null;
  return run ? { run, insideContainer: container.hasContainer } : null;
};
const closesFence = (line, fence) => {
  if (!fence) return false;
  const marker = fence.run[0] === '`' ? '`' : '~';
  return new RegExp(`^${marker}{${fence.run.length},}[ \\t]*$`).test(
    fenceText(line, fence.insideContainer),
  );
};

/** 返回 gallery callout 中按源码分行出现的图片目标。 */
export function collectGalleryImageTargets(markdown) {
  const targets = [];
  const seen = new Set();
  const lines = String(markdown ?? '').split(/\r?\n/);
  let fence = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (fence) {
      if (closesFence(lines[index], fence)) fence = null;
      continue;
    }
    fence = openingFence(lines[index]);
    if (fence) continue;
    if (!GALLERY_HEADER.test(lines[index])) continue;
    while (index + 1 < lines.length && QUOTED_LINE.test(lines[index + 1])) {
      index += 1;
      const body = lines[index].replace(QUOTED_LINE, '');
      for (const match of body.matchAll(EMBED)) {
        const target = targetFromEmbed(match[1]);
        if (!target || !isImageTarget(target) || seen.has(target)) continue;
        seen.add(target);
        targets.push(target);
      }
    }
  }
  return targets;
}

/**
 * @param {string} markdown
 * @param {(target: string) => string|{url: string, width?: number, height?: number}|null} resolve
 * @returns {{markdown: string, css: string, warnings: string[]}}
 */
export function materializeGalleryCallouts(markdown, resolve) {
  const lines = markdown.split(/\r?\n/);
  const output = [];
  const styles = [];
  const warnings = [];
  let rowNumber = 0;
  let fence = null;

  for (let index = 0; index < lines.length; index += 1) {
    if (fence) {
      output.push(lines[index]);
      if (closesFence(lines[index], fence)) fence = null;
      continue;
    }
    fence = openingFence(lines[index]);
    if (fence) {
      output.push(lines[index]);
      continue;
    }
    if (!GALLERY_HEADER.test(lines[index])) {
      output.push(lines[index]);
      continue;
    }

    const quoted = [];
    while (index + 1 < lines.length && QUOTED_LINE.test(lines[index + 1])) {
      index += 1;
      quoted.push(lines[index].replace(QUOTED_LINE, ''));
    }

    for (const row of splitRows(quoted)) {
      const targets = imageTargetsInRow(row);
      if (!targets) {
        output.push(...row);
        continue;
      }

      rowNumber += 1;
      const id = `gallery-${rowNumber}`;
      const found = targets.map((target) => resolvedDimensions(resolve(target)));
      const complete = found.every(Boolean);
      const candidateRatios = complete ? found.map(({ width, height }) => width / height) : null;
      const ratios = candidateRatios?.every((ratio) => Number.isFinite(ratio) && ratio > 0)
        ? candidateRatios
        : null;
      const layout = ratios ? 'justified' : 'stacked';
      if (output.length > 0 && output.at(-1) !== '') output.push('');
      output.push(
        `<section data-wechat-gallery-row="${id}" data-wechat-gallery-layout="${layout}">` +
        `${row.join('')}</section>`,
        '',
      );
      styles.push(rowCss(id, ratios));
      if (!ratios) {
        const missing = targets.filter((_target, targetIndex) => !found[targetIndex]);
        warnings.push(
          `画廊图片尺寸不可用，已改为逐张显示：${(missing.length ? missing : targets).join('、')}`,
        );
      }
    }
  }

  return { markdown: output.join('\n'), css: styles.join('\n'), warnings };
}
