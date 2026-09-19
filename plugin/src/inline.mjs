// 把样式表内联到每个元素的 style 属性上。
//
// 这一步是整条管线的关键：微信只信任元素自身的行内 style，
// <style> 块、class、id 全部会被丢弃（见事实核查 C1）。
//
// 开 inlinePseudoElements 后 ::before / ::after 会变成真实的 span，
// 这是它们在微信里唯一能活的形态（见事实核查 A1）。

import juice from 'juice';
import postcss from 'postcss';

const BASE = {
  inlinePseudoElements: true,
  preserveImportant: true,
  // juice 12 能正确把 var(--x) 展平成字面值，微信会丢弃 var()，所以要展平
  resolveCSSVariables: true,
};

/** 未加引号的多词字体名会让 PostCSS 解析失败，先补上引号 */
export function quoteFontNames(css) {
  return css.replace(/font-family\s*:([^;}]*)/gi, (whole, value) => {
    const quoted = value
      .split(',')
      .map((part) => {
        const name = part.trim();
        if (!name || /^["']/.test(name) || !/\s/.test(name)) return part;
        return part.replace(name, `"${name}"`);
      })
      .join(',');
    return whole.replace(value, quoted);
  });
}

/** style="undefined;" 会让 PostCSS 直接抛错，先清掉 */
export const dropUndefinedStyles = (html) =>
  html.replace(/\s*style="[^"]*undefined[^"]*"/gi, '');

const stripFontFamily = (css) => css.replace(/font-family\s*:[^;}]*;?/gi, '');

/**
 * 三级降级：全量 → 关伪元素 → 剥字体 → 返回未内联原文。
 * 任何一档成功就返回，绝不因为内联失败让整篇报错。
 *
 * @returns {{ html: string, level: 'full'|'no-pseudo'|'no-font'|'none', warnings: string[] }}
 */
export function inlineCss(html, css, { _juice = juice } = {}) {
  const warnings = [];
  const clean = quoteFontNames(css);

  try {
    postcss.parse(clean, { from: undefined });
  } catch (error) {
    const location = error?.line
      ? `（第 ${error.line} 行${error.column ? `、第 ${error.column} 列` : ''}）`
      : '';
    const reason = error?.reason ?? error?.message ?? '未知语法错误';
    warnings.push(`主题 CSS 语法错误${location}：${reason}；已返回未加样式的原文`);
    return { html, level: 'none', warnings };
  }

  const ladder = [
    { level: 'full', css: clean, opts: BASE },
    {
      level: 'no-pseudo',
      css: clean,
      opts: { ...BASE, inlinePseudoElements: false },
      warn: '内联伪元素失败，已关闭该档重试；::before / ::after 装饰不会出现',
    },
    {
      level: 'no-font',
      css: stripFontFamily(clean),
      opts: { ...BASE, inlinePseudoElements: false },
      warn: '内联字体失败，已剥离 font-family 重试；字体回退为系统默认',
    },
  ];

  for (const step of ladder) {
    try {
      const out = _juice(dropUndefinedStyles(`<style>${step.css}</style>${html}`), step.opts);
      if (step.warn) warnings.push(step.warn);
      return { html: out, level: step.level, warnings };
    } catch {
      // 换下一档
    }
  }

  warnings.push('样式未能内联，已返回未加样式的原文；请检查主题 CSS 是否有语法错误');
  return { html, level: 'none', warnings };
}
