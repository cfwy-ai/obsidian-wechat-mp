import { posix } from 'node:path';
import { parseDocument } from 'htmlparser2';
import postcss from 'postcss';

import { normalizeArticleHeader } from './article-header.mjs';
import { normalizeReferenceComposition } from './reference-composition.mjs';

export const THEME_PACKAGE_SCHEMA_VERSION = 3;
export const THEME_PACKAGE_FILES = Object.freeze({
  manifest: 'manifest.json',
  css: 'theme.css',
});
export const THEME_PACKAGE_DIRECTORIES = Object.freeze({
  visualSpecs: '主题视觉规范',
  components: '正文组件结构',
  assets: '透明装饰素材',
  showcases: '主题展示案例',
});
export const THEME_FONT_DIRECTORY = '配套字体资源';
export const LEGACY_THEME_FONT_DIRECTORY = '字体资源';
export const THEME_FONT_DIRECTORIES = Object.freeze([
  THEME_FONT_DIRECTORY,
  LEGACY_THEME_FONT_DIRECTORY,
]);
export const THEME_VISUAL_SPEC_FILES = Object.freeze([
  '1. 视觉风格总则.md',
  '2. 文章封图规范.md',
  '3. 正文配图规范.md',
]);

export const THEME_COMPONENT_SLOTS = Object.freeze([
  'before_article',
  'after_article',
  'before_heading',
  'after_heading',
  'before_blockquote',
  'before_table',
  'before_codeblock',
  'after_codeblock',
]);

const BLOCK_COMPONENT_SLOTS = Object.freeze({
  blockquote: 'before_blockquote',
  table: 'before_table',
  pre: 'before_codeblock',
});

const AFTER_BLOCK_COMPONENT_SLOTS = Object.freeze({
  pre: 'after_codeblock',
});

const THEME_ID = /^[a-z0-9][a-z0-9._-]{1,63}$/;
const ENTRY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const IMAGE_EXTENSION = /\.(?:jpe?g|png)$/i;
const FONT_EXTENSION = /\.(?:ttf|otf|woff2?)$/i;
const SHA256 = /^[a-f0-9]{64}$/i;
const HEX_COLOR = /^#[a-f0-9]{6}$/i;
const CONTROL = /[\u0000-\u001f\u007f]/u;
const NUMBER_PREFIX = /^(\d+)\.\s*/;
const ASSET_TOKEN = /theme-asset:\/\/([a-z0-9][a-z0-9._-]{0,63})/gi;
const THEME_ASSET_BACKGROUND = /^url\(\s*(?:(['"])theme-asset:\/\/([a-z0-9][a-z0-9._-]{0,63})\1|theme-asset:\/\/([a-z0-9][a-z0-9._-]{0,63}))\s*\)$/i;
export const MAX_WECHAT_ASSET_URL_LENGTH = 2048;
export const MAX_THEME_FONT_BYTES = 8 * 1024 * 1024;
export const MAX_DECLARED_THEME_FONT_BYTES = 40 * 1024 * 1024;

export function themeFontByteLimit(font) {
  const maxBytes = font?.maxBytes ?? MAX_THEME_FONT_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < MAX_THEME_FONT_BYTES || maxBytes > MAX_DECLARED_THEME_FONT_BYTES) {
    throw new Error('字体文件容量声明必须在 8–40 MiB 之间');
  }
  return maxBytes;
}
export const WECHAT_ASSET_HOSTS = Object.freeze([
  'mmbiz.qpic.cn',
  'res.wx.qq.com',
]);

const cleanText = (value) =>
  typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';

const displayNameFromDirectory = (directoryName) =>
  String(directoryName ?? '').replace(NUMBER_PREFIX, '').trim().replace(/ ✅\uFE0F?$/u, '');

export const isThemeFontPath = (value) => THEME_FONT_DIRECTORIES.some(
  (directory) => String(value ?? '').startsWith(`${directory}/`),
);

export function validateThemeDirectoryName(directoryName) {
  const name = displayNameFromDirectory(directoryName);
  if (!name || [...name].length !== 4) {
    throw new Error('主题目录去掉数字序号后必须是四个字');
  }
  return name;
}

const normalizeMetadata = (value) => {
  const values = Array.isArray(value) ? value : [value];
  return values
    .map(cleanText)
    .filter(Boolean);
};

const assertPlainObject = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value;
};

/**
 * 公众号交付地址会进入行内 CSS，因此只接受有主机的 HTTPS URL。
 * 凭据、空白、控制字符与超长值一律拒绝，不做宽松修复。
 */
export function normalizeWechatAssetUrl(value, label = 'wechat_url') {
  if (typeof value !== 'string') throw new Error(`${label} 必须是 HTTPS URL`);
  const raw = value.trim();
  if (!raw) throw new Error(`${label}不能为空`);
  if (raw.length > MAX_WECHAT_ASSET_URL_LENGTH) {
    throw new Error(`${label}超过 ${MAX_WECHAT_ASSET_URL_LENGTH} 字符上限`);
  }
  if (/[\u0000-\u0020\u007f]/.test(raw)) {
    throw new Error(`${label}不能包含空白或控制字符`);
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} 不是有效 URL`);
  }
  if (parsed.protocol !== 'https:') throw new Error(`${label} 只允许 HTTPS`);
  if (!parsed.hostname) throw new Error(`${label} 必须包含主机名`);
  if (parsed.username || parsed.password) throw new Error(`${label} 不能包含用户名或密码`);
  if (parsed.port) throw new Error(`${label} 不能使用非默认端口`);
  if (!WECHAT_ASSET_HOSTS.includes(parsed.hostname.toLowerCase())) {
    throw new Error(`${label} 只允许微信官方素材主机`);
  }
  if (parsed.href.length > MAX_WECHAT_ASSET_URL_LENGTH) {
    throw new Error(`${label}超过 ${MAX_WECHAT_ASSET_URL_LENGTH} 字符上限`);
  }
  return parsed.href;
}

/**
 * 把 manifest 内的相对路径收紧为主题包内的 POSIX 路径。
 * 绝对路径、盘符、空段、`.`、`..` 与反斜杠一律拒绝，不做猜测修复。
 */
export function safeThemeRelativePath(value, label = '主题包路径') {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) throw new Error(`${label}不能为空`);
  if (raw.includes('\\')) throw new Error(`${label}不能使用反斜杠`);
  if (raw.startsWith('/') || /^[a-z]:/i.test(raw)) throw new Error(`${label}不能是绝对路径`);
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${label}不能越出主题包`);
  }
  const normalized = posix.normalize(raw);
  if (normalized !== raw || normalized.startsWith('../')) {
    throw new Error(`${label}不能越出主题包`);
  }
  return normalized;
}

/** 安全拼接 Vault 中的主题包路径；relative 已经过上面的越界检查。 */
export function themePackageFilePath(packagePath, relative, label) {
  const root = String(packagePath ?? '').replace(/^\/+|\/+$/g, '');
  if (!root) throw new Error('主题包根目录不能为空');
  return `${root}/${safeThemeRelativePath(relative, label)}`;
}

const normalizeAssets = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('assets 必须是数组');
  const seen = new Set();
  return value.map((raw, index) => {
    const item = assertPlainObject(raw, `assets[${index}]`);
    const id = cleanText(item.asset_id ?? item.id);
    if (!ENTRY_ID.test(id)) throw new Error(`assets[${index}].asset_id 格式不正确`);
    if (seen.has(id)) throw new Error(`素材 ID 重复：${id}`);
    seen.add(id);
    const file = safeThemeRelativePath(item.file, `assets[${index}].file`);
    if (!file.startsWith(`${THEME_PACKAGE_DIRECTORIES.assets}/`)) {
      throw new Error(`素材必须位于「${THEME_PACKAGE_DIRECTORIES.assets}」目录：${file}`);
    }
    if (!IMAGE_EXTENSION.test(file)) throw new Error(`主题素材只支持 PNG 或 JPG：${file}`);
    const normalized = {
      id,
      file,
      alt: cleanText(item.alt),
    };
    if (item.wechat_url !== undefined) {
      normalized.wechatUrl = normalizeWechatAssetUrl(
        item.wechat_url,
        `assets[${index}].wechat_url`,
      );
    }
    return normalized;
  });
};

const normalizePreviewImage = (value) => {
  if (value === undefined) return '';
  const file = safeThemeRelativePath(value, 'preview_image');
  if (!file.startsWith(`${THEME_PACKAGE_DIRECTORIES.showcases}/`)) {
    throw new Error(
      `preview_image 必须位于「${THEME_PACKAGE_DIRECTORIES.showcases}」目录：${file}`,
    );
  }
  if (!IMAGE_EXTENSION.test(file)) {
    throw new Error(`preview_image 只支持 PNG 或 JPG：${file}`);
  }
  return file;
};

const normalizeHeadingLevels = (value, label) => {
  if (value === undefined) return [2];
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} 必须是 1 到 6 的非空数组`);
  }
  const levels = [...new Set(value.map(Number))];
  if (levels.some((level) => !Number.isInteger(level) || level < 1 || level > 6)) {
    throw new Error(`${label} 只能包含 1 到 6`);
  }
  return levels.sort((a, b) => a - b);
};

const numberInRange = (value, fallback, min, max, label, { integer = false } = {}) => {
  const normalized = value === undefined ? fallback : Number(value);
  if (!Number.isFinite(normalized) || normalized < min || normalized > max) {
    throw new Error(`${label} 必须在 ${min}–${max} 之间`);
  }
  if (integer && !Number.isInteger(normalized)) throw new Error(`${label} 必须是整数`);
  return normalized;
};

const normalizeFonts = (value) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('fonts 必须是数组');
  const seen = new Set();
  return value.map((raw, index) => {
    const item = assertPlainObject(raw, `fonts[${index}]`);
    const id = cleanText(item.font_id ?? item.id);
    if (!ENTRY_ID.test(id)) throw new Error(`fonts[${index}].font_id 格式不正确`);
    if (seen.has(id)) throw new Error(`字体 ID 重复：${id}`);
    seen.add(id);
    const file = safeThemeRelativePath(item.file, `fonts[${index}].file`);
    if (!isThemeFontPath(file)) {
      throw new Error(
        `字体必须位于「${THEME_FONT_DIRECTORY}」目录（兼容旧「${LEGACY_THEME_FONT_DIRECTORY}」）：${file}`,
      );
    }
    if (!FONT_EXTENSION.test(file)) {
      throw new Error(`主题字体只支持 TTF、OTF、WOFF 或 WOFF2：${file}`);
    }
    const family = cleanText(item.family);
    if (!family || family.length > 128) throw new Error(`fonts[${index}].family 格式不正确`);
    const sha256 = cleanText(item.sha256).toLowerCase();
    if (!SHA256.test(sha256)) throw new Error(`fonts[${index}].sha256 必须是 64 位十六进制`);
    const style = cleanText(item.style || 'normal').toLowerCase();
    if (!['normal', 'italic', 'oblique'].includes(style)) {
      throw new Error(`fonts[${index}].style 只支持 normal、italic 或 oblique`);
    }
    let coverageFile;
    if (item.coverage_file !== undefined) {
      coverageFile = safeThemeRelativePath(item.coverage_file, `fonts[${index}].coverage_file`);
      if (!isThemeFontPath(coverageFile) || !/\.json$/i.test(coverageFile)) {
        throw new Error(`fonts[${index}].coverage_file 必须是配套字体目录内的 JSON`);
      }
    }
    const maxBytes = item.max_file_bytes === undefined ? undefined : numberInRange(
      item.max_file_bytes, MAX_THEME_FONT_BYTES, MAX_THEME_FONT_BYTES,
      MAX_DECLARED_THEME_FONT_BYTES, `fonts[${index}].max_file_bytes`, { integer: true },
    );
    return {
      id,
      file,
      family,
      sha256,
      weight: numberInRange(item.weight, 400, 100, 900, `fonts[${index}].weight`, {
        integer: true,
      }),
      style,
      ...(coverageFile ? { coverageFile } : {}),
      ...(maxBytes === undefined ? {} : { maxBytes }),
    };
  });
};

const normalizeFallbackFontIds = (value, fontIds, primaryId, label) => {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 3) throw new Error(`${label} 必须是最多三个字体 ID 的数组`);
  return [...new Set(value.map((entry) => {
    const id = cleanText(entry);
    if (!fontIds.has(id) || id === primaryId) throw new Error(`${label} 引用了无效备用字体：${id}`);
    return id;
  }))];
};

const normalizeOrderedListImages = (value, fontIds, assets = []) => {
  if (value === undefined || value === null) return null;
  const item = assertPlainObject(value, 'ordered_list_images');
  const allowed = new Set(['font_id', 'fallback_font_ids', 'font_size', 'color', 'scale', 'gap', 'depth_emblems']);
  for (const key of Object.keys(item)) if (!allowed.has(key)) throw new Error(`ordered_list_images 不支持字段：${key}`);
  const fontId = cleanText(item.font_id);
  if (!fontIds.has(fontId)) throw new Error(`ordered_list_images 引用了未登记字体：${fontId}`);
  const color = cleanText(item.color || '#59614D').toUpperCase();
  if (!HEX_COLOR.test(color)) throw new Error('ordered_list_images.color 必须是 6 位 HEX');
  let depthEmblems;
  if (item.depth_emblems !== undefined) {
    if (!Array.isArray(item.depth_emblems) || item.depth_emblems.length < 1 || item.depth_emblems.length > 6) {
      throw new Error('ordered_list_images.depth_emblems 必须包含 1–6 项');
    }
    const depths = new Set();
    depthEmblems = item.depth_emblems.map((raw, index) => {
      const label = `ordered_list_images.depth_emblems[${index}]`;
      const entry = assertPlainObject(raw, label);
      for (const key of Object.keys(entry)) if (!['depth', 'asset_id', 'width', 'height', 'gap'].includes(key)) throw new Error(`${label} 不支持字段：${key}`);
      const depth = numberInRange(entry.depth, 1, 1, 16, `${label}.depth`, { integer: true });
      if (depths.has(depth)) throw new Error(`${label}.depth 重复`);
      depths.add(depth);
      const assetId = cleanText(entry.asset_id);
      const asset = assets.find(asset => asset.id === assetId);
      if (!asset || !/\.png$/i.test(asset.file)) throw new Error(`${label}.asset_id 必须引用已登记 PNG 素材`);
      return { depth, assetId,
        width: numberInRange(entry.width, 24, 8, 64, `${label}.width`),
        height: numberInRange(entry.height, 24, 8, 64, `${label}.height`),
        gap: numberInRange(entry.gap, 4, 0, 16, `${label}.gap`),
      };
    }).sort((a, b) => a.depth - b.depth);
    if (depthEmblems[0].depth !== 1) throw new Error('ordered_list_images.depth_emblems 必须包含第 1 层');
  }
  return {
    fontId,
    fallbackFontIds: normalizeFallbackFontIds(item.fallback_font_ids, fontIds, fontId, 'ordered_list_images.fallback_font_ids') ?? [],
    fontSize: numberInRange(item.font_size, 20, 14, 28, 'ordered_list_images.font_size'),
    gap: numberInRange(item.gap, 6, 0, 16, 'ordered_list_images.gap'),
    color,
    scale: numberInRange(item.scale, 3, 2, 3, 'ordered_list_images.scale', { integer: true }),
    ...(depthEmblems ? { depthEmblems } : {}),
  };
};

const normalizeQuoteIllustration = (value, assets) => {
  if (value === undefined) return null;
  const label = 'quote_images.illustration';
  const item = assertPlainObject(value, label);
  const allowed = new Set(['asset_id', 'width_percent', 'gap_percent', 'layout']);
  for (const key of Object.keys(item)) if (!allowed.has(key)) throw new Error(`${label} 不支持字段：${key}`);
  const assetId = cleanText(item.asset_id);
  const asset = assets.find(entry => entry.id === assetId);
  if (!asset) throw new Error(`${label} 引用了未登记素材：${assetId}`);
  if (!/\.png$/i.test(asset.file)) throw new Error(`${label}.asset_id 必须引用 PNG 素材`);
  const widthPercent = numberInRange(item.width_percent, 44, 20, 60, `${label}.width_percent`);
  const gapPercent = numberInRange(item.gap_percent, 4, 0, 12, `${label}.gap_percent`);
  if (100 - widthPercent - gapPercent < 35) throw new Error(`${label} 必须为文字保留至少 35% 宽度`);
  if (item.layout !== undefined && !['table', 'image'].includes(item.layout)) throw new Error(`${label}.layout 只支持 table 或 image`);
  return { assetId, widthPercent, gapPercent, ...(item.layout ? { layout:item.layout } : {}) };
};

const normalizeResponsiveQuoteTypography = (value, fontSize) => {
  if (value === undefined) return null;
  const label = 'quote_images.responsive_typography';
  const item = assertPlainObject(value, label);
  const allowed = new Set(['min_width', 'max_width', 'max_font_size']);
  for (const key of Object.keys(item)) if (!allowed.has(key)) throw new Error(`${label} 不支持字段：${key}`);
  const minWidth = numberInRange(item.min_width, 390, 240, 999, `${label}.min_width`, { integer: true });
  const maxWidth = numberInRange(item.max_width, 677, minWidth + 1, 1000, `${label}.max_width`, { integer: true });
  const maxFontSize = numberInRange(item.max_font_size, Math.max(30, fontSize), fontSize, 48, `${label}.max_font_size`);
  return { minWidth, maxWidth, maxFontSize };
};

const normalizeQuoteImages = (value, fontIds, assets = []) => {
  if (value === undefined || value === null) return null;
  const item = assertPlainObject(value, 'quote_images');
  const allowed = new Set(['font_id', 'fallback_font_ids', 'font_size', 'line_height', 'letter_spacing', 'color', 'max_width', 'fallback_width', 'scale', 'text_paint', 'illustration', 'responsive_typography', 'inline_code_font', 'replace_native_container']);
  for (const key of Object.keys(item)) if (!allowed.has(key)) throw new Error(`quote_images 不支持字段：${key}`);
  const fontId = cleanText(item.font_id);
  if (!fontIds.has(fontId)) throw new Error(`quote_images 引用了未登记字体：${fontId}`);
  const color = cleanText(item.color || '#59432C').toUpperCase();
  if (!HEX_COLOR.test(color)) throw new Error('quote_images.color 必须是 6 位 HEX');
  const textPaint = normalizeTextPaint(item.text_paint, 'quote_images.text_paint');
  const illustration = normalizeQuoteIllustration(item.illustration, assets);
  if (textPaint && item.color === undefined) {
    throw new Error('quote_images.color 必须显式提供作为 text_paint 的单色回退');
  }
  const maxWidth = numberInRange(item.max_width, 640, 120, 677, 'quote_images.max_width', { integer: true });
  const fallbackWidth = numberInRange(item.fallback_width, 185, 120, maxWidth, 'quote_images.fallback_width', { integer: true });
  const fontSize = numberInRange(item.font_size, 18, 14, 30, 'quote_images.font_size');
  const responsiveTypography = normalizeResponsiveQuoteTypography(item.responsive_typography, fontSize);
  const inlineCodeFont = item.inline_code_font === undefined ? null : cleanText(item.inline_code_font).toLowerCase();
  if (inlineCodeFont !== null && inlineCodeFont !== 'quote') throw new Error('quote_images.inline_code_font 只支持 quote，省略时沿用原有代码字体');
  if (item.replace_native_container !== undefined && typeof item.replace_native_container !== 'boolean') {
    throw new Error('quote_images.replace_native_container 必须是布尔值');
  }
  return {
    fontId,
    fallbackFontIds: normalizeFallbackFontIds(item.fallback_font_ids, fontIds, fontId, 'quote_images.fallback_font_ids') ?? [],
    fontSize,
    lineHeight: numberInRange(item.line_height, 1.85, 1.2, 2.5, 'quote_images.line_height'),
    letterSpacing: numberInRange(item.letter_spacing, 0, 0, 4, 'quote_images.letter_spacing'),
    color, maxWidth, fallbackWidth,
    ...(textPaint ? { textPaint } : {}),
    ...(illustration ? { illustration } : {}),
    ...(responsiveTypography ? { responsiveTypography } : {}),
    ...(inlineCodeFont ? { inlineCodeFont } : {}),
    ...(item.replace_native_container === undefined ? {} : { replaceNativeContainer:item.replace_native_container }),
    scale: numberInRange(item.scale, 3, 2, 3, 'quote_images.scale', { integer: true }),
  };
};

const normalizePaintColor = (value, label) => {
  const color = cleanText(value).toUpperCase();
  if (!HEX_COLOR.test(color)) throw new Error(`${label} 必须是 6 位 HEX`);
  return color;
};

const paintNumberInRange = (value, fallback, min, max, label) => {
  const normalized = value === undefined ? fallback : value;
  if (typeof normalized !== 'number' || !Number.isFinite(normalized)) {
    throw new Error(`${label} 必须是数字`);
  }
  if (normalized < min || normalized > max) {
    throw new Error(`${label} 必须在 ${min}–${max} 之间`);
  }
  return normalized;
};

const normalizeTextPaint = (value, label) => {
  if (value === undefined) return null;
  const item = assertPlainObject(value, label);
  const type = cleanText(item.type).toLowerCase();
  if (type !== 'gilded') throw new Error(`${label}.type 只支持 gilded`);
  if (!Array.isArray(item.stops) || item.stops.length < 4 || item.stops.length > 8) {
    throw new Error(`${label}.stops 必须包含 4–8 个渐变节点`);
  }
  let previousOffset = -1;
  const stops = item.stops.map((rawStop, index) => {
    const stop = assertPlainObject(rawStop, `${label}.stops[${index}]`);
    const offset = paintNumberInRange(
      stop.offset,
      Number.NaN,
      0,
      1,
      `${label}.stops[${index}].offset`,
    );
    if (offset <= previousOffset) {
      throw new Error(`${label}.stops 的 offset 必须严格递增`);
    }
    previousOffset = offset;
    return {
      offset,
      color: normalizePaintColor(stop.color, `${label}.stops[${index}].color`),
    };
  });
  if (stops[0].offset !== 0 || stops.at(-1).offset !== 1) {
    throw new Error(`${label}.stops 必须从 0 开始并在 1 结束`);
  }

  const rawStroke = item.stroke === undefined ? {} : assertPlainObject(item.stroke, `${label}.stroke`);
  const rawHighlight = item.highlight === undefined
    ? {}
    : assertPlainObject(item.highlight, `${label}.highlight`);
  return {
    type,
    stops,
    stroke: {
      color: normalizePaintColor(rawStroke.color ?? '#442A0A', `${label}.stroke.color`),
      width: paintNumberInRange(rawStroke.width, 0.7, 0, 2, `${label}.stroke.width`),
    },
    highlight: {
      color: normalizePaintColor(
        rawHighlight.color ?? '#FFFBE8',
        `${label}.highlight.color`,
      ),
      alpha: paintNumberInRange(rawHighlight.alpha, 0.4, 0, 1, `${label}.highlight.alpha`),
      width: paintNumberInRange(rawHighlight.width, 0.35, 0, 1, `${label}.highlight.width`),
      offsetX: paintNumberInRange(
        rawHighlight.offset_x,
        -0.25,
        -1,
        1,
        `${label}.highlight.offset_x`,
      ),
      offsetY: paintNumberInRange(
        rawHighlight.offset_y,
        -0.35,
        -1,
        1,
        `${label}.highlight.offset_y`,
      ),
    },
  };
};

const normalizeHeadingImages = (value, fontIds, assetIds) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('heading_images 必须是数组');
  const seen = new Set();
  const claimedLevels = new Set();
  return value.map((raw, index) => {
    const item = assertPlainObject(raw, `heading_images[${index}]`);
    const id = cleanText(item.heading_image_id ?? item.id);
    if (!ENTRY_ID.test(id)) {
      throw new Error(`heading_images[${index}].heading_image_id 格式不正确`);
    }
    if (seen.has(id)) throw new Error(`标题图片规则 ID 重复：${id}`);
    seen.add(id);
    const headingLevels = normalizeHeadingLevels(
      item.heading_levels ?? [1],
      `heading_images[${index}].heading_levels`,
    );
    for (const level of headingLevels) {
      if (claimedLevels.has(level)) throw new Error(`标题级别 h${level} 不能重复声明图片规则`);
      claimedLevels.add(level);
    }
    const fontId = cleanText(item.font_id);
    if (!fontIds.has(fontId)) throw new Error(`标题图片规则 ${id} 引用了未登记字体：${fontId}`);
    const color = cleanText(item.color || '#253246').toUpperCase();
    if (!HEX_COLOR.test(color)) throw new Error(`heading_images[${index}].color 必须是 6 位 HEX`);
    const textPaint = normalizeTextPaint(
      item.text_paint,
      `heading_images[${index}].text_paint`,
    );
    if (textPaint && item.color === undefined) {
      throw new Error(
        `heading_images[${index}].color 必须显式提供作为 text_paint 的单色回退`,
      );
    }
    const latinFontFamily = cleanText(item.latin_font_family || 'Avenir Next');
    if (!latinFontFamily || latinFontFamily.length > 128) {
      throw new Error(`heading_images[${index}].latin_font_family 格式不正确`);
    }
    const align = cleanText(item.align || 'center').toLowerCase();
    if (!['left', 'center'].includes(align)) {
      throw new Error(`heading_images[${index}].align 只支持 left 或 center`);
    }
    const rawNumberAssets = item.number_assets ?? [];
    if (!Array.isArray(rawNumberAssets)) {
      throw new Error(`heading_images[${index}].number_assets 必须是数组`);
    }
    const numberAssets = rawNumberAssets.map((assetId, assetIndex) => {
      const normalized = cleanText(assetId);
      if (!ENTRY_ID.test(normalized)) {
        throw new Error(
          `heading_images[${index}].number_assets[${assetIndex}] 素材 ID 格式不正确`,
        );
      }
      if (!assetIds.has(normalized)) {
        throw new Error(`标题图片规则 ${id} 引用了未登记素材：${normalized}`);
      }
      return normalized;
    });
    const rawWatermarkAssets = item.watermark_assets ?? [];
    if (!Array.isArray(rawWatermarkAssets)) {
      throw new Error(`heading_images[${index}].watermark_assets 必须是数组`);
    }
    const watermarkAssets = rawWatermarkAssets.map((assetId, assetIndex) => {
      const normalized = cleanText(assetId);
      if (!ENTRY_ID.test(normalized)) {
        throw new Error(
          `heading_images[${index}].watermark_assets[${assetIndex}] 素材 ID 格式不正确`,
        );
      }
      if (!assetIds.has(normalized)) {
        throw new Error(`标题图片规则 ${id} 引用了未登记素材：${normalized}`);
      }
      return normalized;
    });
    let watermark;
    if (item.watermark !== undefined || watermarkAssets.length > 0) {
      if (watermarkAssets.length === 0) {
        throw new Error(`heading_images[${index}].watermark 需要 watermark_assets`);
      }
      const rawWatermark = item.watermark === undefined
        ? {}
        : assertPlainObject(item.watermark, `heading_images[${index}].watermark`);
      const allowed = new Set(['width', 'height', 'opacity', 'offset_x', 'offset_y']);
      for (const key of Object.keys(rawWatermark)) {
        if (!allowed.has(key)) throw new Error(`heading_images[${index}].watermark 不支持字段：${key}`);
      }
      watermark = {
        width: numberInRange(rawWatermark.width, 64, 16, 180, `heading_images[${index}].watermark.width`),
        height: numberInRange(rawWatermark.height, 44, 12, 120, `heading_images[${index}].watermark.height`),
        opacity: numberInRange(rawWatermark.opacity, 1, 0.05, 1, `heading_images[${index}].watermark.opacity`),
        offsetX: numberInRange(rawWatermark.offset_x, 0, -120, 120, `heading_images[${index}].watermark.offset_x`),
        offsetY: numberInRange(rawWatermark.offset_y, 0, -80, 80, `heading_images[${index}].watermark.offset_y`),
      };
    }
    const numberSeparator = item.number_separator === undefined ? '' : item.number_separator;
    if (typeof numberSeparator !== 'string' || CONTROL.test(numberSeparator)) {
      throw new Error(`heading_images[${index}].number_separator 必须是不含控制字符的字符串`);
    }
    const numberGap = item.number_gap === undefined ? 6 : Number(item.number_gap);
    if (!Number.isSafeInteger(numberGap) || numberGap < 0) {
      throw new Error(`heading_images[${index}].number_gap 必须是非负整数`);
    }
    const fontSize = numberInRange(
      item.font_size,
      28,
      18,
      48,
      `heading_images[${index}].font_size`,
    );
    const minEffectiveFontSize = numberInRange(
      item.min_effective_font_size,
      24,
      18,
      fontSize,
      `heading_images[${index}].min_effective_font_size`,
    );
    const maxWidth = numberInRange(
      item.max_width,
      331,
      160,
      354,
      `heading_images[${index}].max_width`,
      { integer: true },
    );
    const minDisplayWidth = numberInRange(
      item.min_display_width,
      284,
      240,
      354,
      `heading_images[${index}].min_display_width`,
      { integer: true },
    );
    if (minDisplayWidth > maxWidth) {
      throw new Error(`heading_images[${index}].min_display_width 不能大于 max_width`);
    }
    const normalized = {
      id,
      headingLevels,
      fontId,
      fontSize,
      lineHeight: numberInRange(item.line_height, 1.46, 1, 2.5, `heading_images[${index}].line_height`),
      letterSpacing: numberInRange(
        item.letter_spacing,
        1,
        0,
        8,
        `heading_images[${index}].letter_spacing`,
      ),
      color,
      maxWidth,
      minDisplayWidth,
      minEffectiveFontSize,
      scale: numberInRange(item.scale, 3, 2, 3, `heading_images[${index}].scale`, {
        integer: true,
      }),
      paddingX: numberInRange(
        item.padding_x,
        6,
        4,
        12,
        `heading_images[${index}].padding_x`,
        { integer: true },
      ),
      paddingY: numberInRange(
        item.padding_y,
        8,
        6,
        16,
        `heading_images[${index}].padding_y`,
        { integer: true },
      ),
      maxLines: numberInRange(
        item.max_lines,
        3,
        1,
        item.width_mode === 'container' ? 6 : 3,
        `heading_images[${index}].max_lines`,
        { integer: true },
      ),
      maxEquivalentCharacters: numberInRange(
        item.max_equivalent_characters,
        40,
        8,
        40,
        `heading_images[${index}].max_equivalent_characters`,
      ),
      latinFontFamily,
      align,
      numberAssets,
      numberSeparator,
      numberGap,
      ...(watermarkAssets.length > 0 ? { watermarkAssets, watermark } : {}),
    };
    const fallbackFontIds = normalizeFallbackFontIds(item.fallback_font_ids, fontIds, fontId, `heading_images[${index}].fallback_font_ids`);
    if (fallbackFontIds !== undefined) normalized.fallbackFontIds = fallbackFontIds;
    // Container sizing is opt-in; old themes retain their original rule and cache key.
    if (item.width_mode !== undefined) {
      if (item.width_mode !== 'container') {
        throw new Error(`heading_images[${index}].width_mode 只支持 container`);
      }
      normalized.widthMode = 'container';
    }
    if (textPaint) normalized.textPaint = textPaint;
    // Opt-in only: keep older themes' normalized rules byte-for-byte stable.
    if (item.side_assets !== undefined) {
      const path = `heading_images[${index}].side_assets`;
      const sides = assertPlainObject(item.side_assets, path);
      const readAsset = (key) => {
        if (sides[key] === undefined) return null;
        const assetId = cleanText(sides[key]);
        if (!ENTRY_ID.test(assetId) || !assetIds.has(assetId)) {
          throw new Error(`${path}.${key} 引用了未登记素材：${assetId}`);
        }
        return assetId;
      };
      const leftAssetId = readAsset('left_asset_id');
      const rightAssetId = readAsset('right_asset_id');
      if (!leftAssetId && !rightAssetId) throw new Error(`${path} 至少需要一侧素材`);
      normalized.sideAssets = {
        ...(leftAssetId ? { leftAssetId } : {}),
        ...(rightAssetId ? { rightAssetId } : {}),
        size: numberInRange(sides.size, 18, 10, 64, `${path}.size`),
        gap: numberInRange(sides.gap, 8, 4, 20, `${path}.gap`),
      };
    }
    return normalized;
  });
};

const normalizeComponents = (value, assetIds) => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('components 必须是数组');
  const seen = new Set();
  return value.map((raw, index) => {
    const item = assertPlainObject(raw, `components[${index}]`);
    const id = cleanText(item.component_id ?? item.id);
    if (!ENTRY_ID.test(id)) throw new Error(`components[${index}].component_id 格式不正确`);
    if (seen.has(id)) throw new Error(`组件 ID 重复：${id}`);
    seen.add(id);
    const file = safeThemeRelativePath(item.file, `components[${index}].file`);
    if (!file.startsWith(`${THEME_PACKAGE_DIRECTORIES.components}/`)) {
      throw new Error(`组件必须位于「${THEME_PACKAGE_DIRECTORIES.components}」目录：${file}`);
    }
    if (!/\.html?$/i.test(file)) throw new Error(`组件必须是 HTML 文件：${file}`);
    const slot = cleanText(item.slot).toLowerCase();
    if (!THEME_COMPONENT_SLOTS.includes(slot)) {
      throw new Error(`组件插槽不受支持：${slot || '空值'}`);
    }
    const referencedAssets = item.asset_ids === undefined ? [] : item.asset_ids;
    if (!Array.isArray(referencedAssets)) {
      throw new Error(`components[${index}].asset_ids 必须是数组`);
    }
    const normalizedAssetIds = [...new Set(referencedAssets.map((assetId) => cleanText(assetId)))];
    for (const assetId of normalizedAssetIds) {
      if (!assetIds.has(assetId)) throw new Error(`组件 ${id} 引用了未登记素材：${assetId}`);
    }
    return {
      id,
      file,
      slot,
      headingLevels:
        slot === 'before_heading' || slot === 'after_heading'
          ? normalizeHeadingLevels(item.heading_levels, `components[${index}].heading_levels`)
          : [],
      assetIds: normalizedAssetIds,
    };
  });
};

// Opt-in only: a textured theme may preserve its colors and
// isolate decoration backgrounds. Other themes keep the previous pipeline.
const normalizeWechatDarkMode = (value, assetIds) => {
  if (value === undefined || value === null) return null;
  const item = assertPlainObject(value, 'wechat_dark_mode');
  if (!['preserve-backgrounds', 'preserve-table-surfaces', 'preserve-illustrated-surfaces'].includes(item.strategy)) {
    throw new Error('wechat_dark_mode.strategy 只支持 preserve-backgrounds、preserve-table-surfaces 或 preserve-illustrated-surfaces');
  }
  if (item.strategy === 'preserve-illustrated-surfaces') {
    if (Object.keys(item).some(key => !['strategy', 'replace_native_quotes', 'materialize_decorations', 'protect_inline_paint', 'rasterize_inline_paint', 'table_rule_images'].includes(key))) {
      throw new Error('wechat_dark_mode 的 preserve-illustrated-surfaces 策略只接受 strategy、replace_native_quotes、materialize_decorations、protect_inline_paint、rasterize_inline_paint 与 table_rule_images');
    }
    if (item.replace_native_quotes !== undefined && typeof item.replace_native_quotes !== 'boolean') {
      throw new Error('wechat_dark_mode.replace_native_quotes 必须是布尔值');
    }
    if (item.materialize_decorations !== undefined && typeof item.materialize_decorations !== 'boolean') {
      throw new Error('wechat_dark_mode.materialize_decorations 必须是布尔值');
    }
    if (item.protect_inline_paint !== undefined && typeof item.protect_inline_paint !== 'boolean') throw new Error('wechat_dark_mode.protect_inline_paint 必须是布尔值');
    for (const key of ['rasterize_inline_paint', 'table_rule_images']) {
      if (item[key] !== undefined && typeof item[key] !== 'boolean') throw new Error(`wechat_dark_mode.${key} 必须是布尔值`);
    }
    return {
      strategy:item.strategy,
      ...(item.replace_native_quotes === undefined ? {} : { replaceNativeQuotes:item.replace_native_quotes }),
      ...(item.materialize_decorations === undefined ? {} : { materializeDecorations:item.materialize_decorations }),
      ...(item.protect_inline_paint === undefined ? {} : { protectInlinePaint:item.protect_inline_paint }),
      ...(item.rasterize_inline_paint === undefined ? {} : { rasterizeInlinePaint:item.rasterize_inline_paint }),
      ...(item.table_rule_images === undefined ? {} : { tableRuleImages:item.table_rule_images }),
    };
  }
  if (item.strategy === 'preserve-table-surfaces') {
    if (Object.keys(item).some(key => !['strategy', 'rounded_frame'].includes(key))) {
      throw new Error('wechat_dark_mode 的 preserve-table-surfaces 策略只接受 strategy 与 rounded_frame；配色和边线由 theme.css 定义');
    }
    if (item.rounded_frame !== undefined && typeof item.rounded_frame !== 'boolean') {
      throw new Error('wechat_dark_mode.rounded_frame 必须是布尔值');
    }
    return { strategy: item.strategy, ...(item.rounded_frame === undefined ? {} : { roundedFrame: item.rounded_frame }) };
  }
  const color = cleanText(item.table_border_color);
  if (!HEX_COLOR.test(color)) {
    throw new Error('wechat_dark_mode.table_border_color 必须是六位 HEX 颜色');
  }
  const normalized = { strategy: item.strategy, tableBorderColor: color.toUpperCase() };
  for (const [field, key] of [['transparent_code_blocks', 'transparentCodeBlocks'], ['native_table_borders', 'nativeTableBorders']]) {
    if (item[field] === undefined) continue;
    if (typeof item[field] !== 'boolean') throw new Error(`wechat_dark_mode.${field} 必须是布尔值`);
    normalized[key] = item[field];
  }
  if (normalized.nativeTableBorders && item.table_frame !== undefined) {
    throw new Error('wechat_dark_mode.native_table_borders 不能与 table_frame 同时启用');
  }
  if (item.table_frame !== undefined) {
    const frame = assertPlainObject(item.table_frame, 'wechat_dark_mode.table_frame');
    const allowedFields = new Set(['border_asset_id', 'surface_asset_id', 'border_width', 'border_radius', 'surface_padding']);
    for (const field of Object.keys(frame)) {
      if (!allowedFields.has(field)) throw new Error(`wechat_dark_mode.table_frame 不支持字段：${field}`);
    }
    const assetId = (field) => {
      const id = cleanText(frame[field]);
      if (!ENTRY_ID.test(id)) throw new Error(`wechat_dark_mode.table_frame.${field} 格式不正确`);
      if (!assetIds.has(id)) throw new Error(`wechat_dark_mode.table_frame.${field} 未登记素材：${id}`);
      return id;
    };
    const borderAssetId = assetId('border_asset_id');
    const surfaceAssetId = assetId('surface_asset_id');
    const borderWidth = frame.border_width === undefined ? 2 : frame.border_width;
    const borderRadius = frame.border_radius === undefined ? 10 : frame.border_radius;
    if (!Number.isInteger(borderWidth) || borderWidth < 1 || borderWidth > 4) {
      throw new Error('wechat_dark_mode.table_frame.border_width 必须为 1–4 的整数');
    }
    if (!Number.isInteger(borderRadius) || borderRadius < 4 || borderRadius > 20 || borderRadius <= borderWidth) {
      throw new Error('wechat_dark_mode.table_frame.border_radius 必须为 4–20 的整数且大于 border_width');
    }
    const surfacePadding = frame.surface_padding === undefined ? [6, 8, 8] : frame.surface_padding;
    if (!Array.isArray(surfacePadding) || surfacePadding.length < 1 || surfacePadding.length > 4
      || surfacePadding.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 24)) {
      throw new Error('wechat_dark_mode.table_frame.surface_padding 必须为包含 1–4 个 0–24 有限数字的数组');
    }
    normalized.tableFrame = { borderAssetId, surfaceAssetId, borderWidth, borderRadius, surfacePadding: [...surfacePadding] };
  }
  return normalized;
};

/**
 * 解析并验证 v3 manifest。文件是否真实存在由调用方按 Vault/文件系统现场核对。
 */
export function parseThemeManifest(source, { directoryName = '' } = {}) {
  let data;
  try {
    data = JSON.parse(String(source ?? ''));
  } catch (error) {
    throw new Error(`manifest.json 不是有效 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  assertPlainObject(data, 'manifest.json');
  if (Number(data.schema_version) !== THEME_PACKAGE_SCHEMA_VERSION) {
    throw new Error(`schema_version 必须是 ${THEME_PACKAGE_SCHEMA_VERSION}`);
  }
  const themeId = cleanText(data.theme_id);
  if (!THEME_ID.test(themeId)) {
    throw new Error('theme_id 只能使用 2–64 位小写字母、数字、点、下划线或连字符');
  }
  const directoryDisplayName = directoryName ? validateThemeDirectoryName(directoryName) : '';
  const name = cleanText(data.name) || directoryDisplayName;
  if (!name) throw new Error('主题名称不能为空');
  const order = data.order === undefined ? null : Number(data.order);
  if (order !== null && (!Number.isInteger(order) || order < 0)) {
    throw new Error('order 必须是非负整数');
  }
  const assets = normalizeAssets(data.assets);
  const components = normalizeComponents(data.components, new Set(assets.map((asset) => asset.id)));
  const articleHeader = normalizeArticleHeader(data.article_header, { components, assets });
  const fonts = normalizeFonts(data.fonts);
  const orderedListImages = normalizeOrderedListImages(data.ordered_list_images, new Set(fonts.map((font) => font.id)), assets);
  const quoteImages = normalizeQuoteImages(data.quote_images, new Set(fonts.map((font) => font.id)), assets);
  const headingImages = normalizeHeadingImages(
    data.heading_images,
    new Set(fonts.map((font) => font.id)),
    new Set(assets.map((asset) => asset.id)),
  );
  const previewImage = normalizePreviewImage(data.preview_image);
  const showcaseImage = normalizePreviewImage(data.showcase_image);
  const referenceComposition = normalizeReferenceComposition(data.reference_composition);
  return {
    schemaVersion: THEME_PACKAGE_SCHEMA_VERSION,
    themeId,
    name,
    order,
    palette: normalizeMetadata(data.theme_palette),
    style: normalizeMetadata(data.theme_style),
    elements: normalizeMetadata(data.theme_elements),
    scenes: normalizeMetadata(data.theme_scenes),
    previewImage,
    showcaseImage,
    showcaseStatus: data.showcase_status === 'draft' ? 'draft' : 'approved',
    assets,
    components,
    fonts,
    headingImages,
    ...(orderedListImages ? { orderedListImages } : {}),
    ...(quoteImages ? { quoteImages } : {}),
    ...(referenceComposition ? { referenceComposition } : {}),
    articleHeader,
    wechatDarkMode: normalizeWechatDarkMode(data.wechat_dark_mode, new Set(assets.map(asset => asset.id))),
  };
}

const escapeAttribute = (value) =>
  String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

const escapeCssString = (value) =>
  String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]/g, '');

const themeImageRecord = (id, asset) => ({
  target: id,
  url: asset.url,
  origin: asset.origin === 'article' ? 'article' : 'theme',
  filePath: asset.filePath,
  ...(asset.wechatUrl ? { wechatUrl: asset.wechatUrl } : {}),
});

/**
 * 只允许 theme.css 用单个 background-image 引用 manifest 已登记素材。
 *
 * 多背景、缩写 background、未登记或不可用素材都整条移除，
 * 避免在预览、复制和长图中留下裂图。语法错误仍交给 inlineCss 统一降级。
 */
export function materializeThemeCss(themeCss, assets = []) {
  const source = String(themeCss ?? '');
  let root;
  try {
    root = postcss.parse(source, { from: undefined });
  } catch {
    return { css: source, images: [], warnings: [] };
  }

  const assetMap = new Map(
    assets
      .filter((asset) => asset && typeof asset.id === 'string')
      .map((asset) => [asset.id.toLowerCase(), asset]),
  );
  const used = new Map();
  const warnings = [];
  const invalidBackgroundRules = new Set();
  const removeBackground = (declaration, warning) => {
    warnings.push(warning);
    if (declaration.parent?.type === 'rule') invalidBackgroundRules.add(declaration.parent);
    declaration.remove();
  };

  root.walkDecls((declaration) => {
    const property = declaration.prop.trim().toLowerCase();
    if (property === 'background-image' && declaration.value.trim().toLowerCase() === 'none') {
      declaration.value = 'none';
      return;
    }
    const hasThemeAssetToken = /theme-asset:\/\//i.test(declaration.value);
    if (property === 'background-image' && !hasThemeAssetToken) {
      removeBackground(
        declaration,
        '主题 CSS 背景图必须使用 theme-asset 登记，已移除该 background-image',
      );
      return;
    }
    if (!hasThemeAssetToken) return;
    if (property !== 'background-image') {
      warnings.push(
        `主题 CSS 素材只能用于 background-image，已移除 ${declaration.prop}`,
      );
      declaration.remove();
      return;
    }

    const match = THEME_ASSET_BACKGROUND.exec(declaration.value.trim());
    if (!match) {
      removeBackground(
        declaration,
        '主题 CSS 背景只支持单个 theme-asset 图片，已移除该 background-image',
      );
      return;
    }

    const id = (match[2] ?? match[3]).toLowerCase();
    const asset = assetMap.get(id);
    if (!asset?.url || !asset?.filePath) {
      removeBackground(
        declaration,
        `主题 CSS 背景素材未登记或不可用：${id}；已移除该 background-image`,
      );
      return;
    }

    declaration.value = `url("${escapeCssString(asset.url)}")`;
    used.set(id, asset);
  });

  for (const rule of invalidBackgroundRules) {
    const stillHasBackground = rule.nodes?.some((node) =>
      node.type === 'decl' && node.prop.trim().toLowerCase() === 'background-image');
    if (stillHasBackground) continue;
    rule.walkDecls(/^(?:background-repeat|background-position|background-size)$/i, (declaration) => {
      declaration.remove();
    });
  }

  return {
    css: root.toString(),
    images: [...used.entries()].map(([id, asset]) => themeImageRecord(id, asset)),
    warnings: [...new Set(warnings)],
  };
}

const materializeComponent = (component, assetMap) => {
  const used = new Map();
  const warnings = [];
  let html = String(component.html ?? '');

  html = html.replace(/<img\b[^>]*>/gi, (tag) => {
    const anySource = /\bsrc\s*=\s*(["'])(.*?)\1/i.exec(tag);
    const source = /\bsrc\s*=\s*(["'])theme-asset:\/\/([a-z0-9][a-z0-9._-]{0,63})\1/i.exec(tag);
    if (!source) {
      warnings.push(
        `组件 ${component.id} 含未登记图片地址，已移除：${anySource?.[2] || '空 src'}`,
      );
      return '';
    }
    const id = source[2].toLowerCase();
    if (Array.isArray(component.assetIds) && !component.assetIds.includes(id)) {
      warnings.push(`组件 ${component.id} 未在 asset_ids 登记素材：${id}`);
      return '';
    }
    const asset = assetMap.get(id);
    if (!asset?.url || !asset?.filePath) {
      warnings.push(`组件 ${component.id} 的素材不可用：${id}`);
      return '';
    }
    used.set(id, asset);
    let rewritten = tag.replace(ASSET_TOKEN, escapeAttribute(asset.url));
    if (asset.alt && !/\balt\s*=/i.test(rewritten)) {
      rewritten = rewritten.replace(/\s*\/?>$/, (ending) =>
        ` alt="${escapeAttribute(asset.alt)}"${ending}`);
    }
    return rewritten;
  });

  html = html.replace(ASSET_TOKEN, (_token, id) => {
    const normalized = id.toLowerCase();
    if (Array.isArray(component.assetIds) && !component.assetIds.includes(normalized)) {
      warnings.push(`组件 ${component.id} 未在 asset_ids 登记素材：${normalized}`);
      return '';
    }
    const asset = assetMap.get(normalized);
    if (!asset?.url || !asset?.filePath) {
      warnings.push(`组件 ${component.id} 的素材不可用：${normalized}`);
      return '';
    }
    used.set(normalized, asset);
    return escapeAttribute(asset.url);
  });

  return { html, used, warnings };
};

/**
 * 把已登记的组件插入 Markdown 渲染结果，并把组件实际使用的主题图片加入统一图片清单。
 * 插槽是封闭枚举，不接受任意 CSS 选择器或脚本。
 */
export function applyThemeComponents(renderedHtml, components = [], assets = []) {
  if (!Array.isArray(components) || components.length === 0) {
    return { html: renderedHtml, images: [], warnings: [] };
  }
  const assetMap = new Map(assets.map((asset) => [asset.id, asset]));
  const prepared = components.map((component) => ({
    ...component,
    ...materializeComponent(component, assetMap),
  }));
  const warnings = prepared.flatMap((component) => component.warnings);
  const inserted = new Set();
  const beforeArticle = prepared.filter((component) => component.slot === 'before_article');
  const afterArticle = prepared.filter((component) => component.slot === 'after_article');
  const beforeHeading = prepared.filter((component) => component.slot === 'before_heading');
  const afterHeading = prepared.filter((component) => component.slot === 'after_heading');
  const componentHtml = (items) => {
    for (const component of items) inserted.add(component);
    return items.map((component) => component.html).join('');
  };

  let html = String(renderedHtml ?? '');
  const hasBlockComponents = prepared.some((component) =>
    [...Object.values(BLOCK_COMPONENT_SLOTS), ...Object.values(AFTER_BLOCK_COMPONENT_SLOTS)]
      .includes(component.slot));
  if (hasBlockComponents) {
    // 只定位原文，再一次性插入：组件内的标题、表格或代码不会再次触发组件。
    // 保留原始字符串，解析器只提供位置，不重写正文、实体或属性顺序。
    const insertions = new Map();
    const addInsertion = (offset, items) => {
      if (items.length === 0) return;
      const chunks = insertions.get(offset) ?? [];
      chunks.push(componentHtml(items));
      insertions.set(offset, chunks);
    };
    const rootOpening = /^(<section\b[^>]*\bid=["']nice["'][^>]*>)/i.exec(html);
    if (rootOpening) addInsertion(rootOpening[0].length, beforeArticle);
    for (const match of html.matchAll(/<h([1-6])\b[^>]*>[\s\S]*?<\/h\1>/gi)) {
      const level = Number(match[1]);
      addInsertion(match.index, beforeHeading.filter((component) =>
        component.headingLevels.includes(level)));
      addInsertion(match.index + match[0].length, afterHeading.filter((component) =>
        component.headingLevels.includes(level)));
    }
    const document = parseDocument(html, { withStartIndices: true, withEndIndices: true });
    const article = document.children.find((node) =>
      node.type === 'tag' && node.name === 'section' && node.attribs?.id === 'nice');
    for (const node of article?.children ?? []) {
      if (node.type !== 'tag' || !Number.isInteger(node.startIndex)) continue;
      const slot = BLOCK_COMPONENT_SLOTS[node.name];
      if (slot) addInsertion(node.startIndex, prepared.filter((component) => component.slot === slot));
      const afterSlot = AFTER_BLOCK_COMPONENT_SLOTS[node.name];
      if (afterSlot && Number.isInteger(node.endIndex)) {
        addInsertion(node.endIndex + 1, prepared.filter((component) => component.slot === afterSlot));
      }
    }
    const rootClosing = /<\/section>\s*$/i.exec(html);
    if (rootClosing) addInsertion(rootClosing.index, afterArticle);
    for (const [offset, chunks] of [...insertions.entries()].sort((a, b) => b[0] - a[0])) {
      html = `${html.slice(0, offset)}${chunks.join('')}${html.slice(offset)}`;
    }
  } else {
    if (beforeHeading.length > 0 || afterHeading.length > 0) {
      html = html.replace(/<h([1-6])\b[^>]*>[\s\S]*?<\/h\1>/gi, (heading, levelText) => {
        const level = Number(levelText);
        const before = componentHtml(
          beforeHeading.filter((component) => component.headingLevels.includes(level)),
        );
        const after = componentHtml(
          afterHeading.filter((component) => component.headingLevels.includes(level)),
        );
        return `${before}${heading}${after}`;
      });
    }
    if (beforeArticle.length > 0) {
      html = html.replace(
        /^(<section\b[^>]*\bid=["']nice["'][^>]*>)/i,
        (root) => `${root}${componentHtml(beforeArticle)}`,
      );
    }
    if (afterArticle.length > 0) {
      html = html.replace(
        /<\/section>\s*$/i,
        () => `${componentHtml(afterArticle)}</section>`,
      );
    }
  }

  const usedAssets = new Map();
  for (const component of inserted) {
    for (const [id, asset] of component.used) usedAssets.set(id, asset);
  }

  const images = [...usedAssets.entries()].map(([id, asset]) => ({
    ...themeImageRecord(id, asset),
  }));
  return { html, images, warnings: [...new Set(warnings)] };
}
