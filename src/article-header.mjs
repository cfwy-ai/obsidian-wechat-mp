// 文章头图只操作主题明确声明的组件，不从正文首图或 before_article 顺序猜测。
const ENTRY_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const isObject = (value) => Boolean(value && typeof value === 'object'
  && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null));
const text = (value) => typeof value === 'string' ? value.trim() : '';
const componentId = (component) => component.id ?? component.component_id;
const assetId = (asset) => asset.id ?? asset.asset_id;
const componentAssets = (component) => component.assetIds ?? component.asset_ids ?? [];

const requireId = (value, field) => {
  const id = text(value);
  if (!ENTRY_ID.test(id)) throw new Error(`article_header.${field} 格式不正确`);
  return id;
};

/** 可选的 manifest 字段；未声明时旧主题保持原行为，错误声明由主题校验报告。 */
export function normalizeArticleHeader(value, { components = [], assets = [] } = {}) {
  if (value === undefined || value === null) return null;
  if (!isObject(value)) throw new Error('article_header 必须是对象');
  const id = requireId(value.component_id ?? value.componentId, 'component_id');
  const defaultAssetId = requireId(value.default_asset_id ?? value.defaultAssetId, 'default_asset_id');
  const target = components.find((component) => componentId(component) === id);
  if (!target) throw new Error(`article_header 指定的组件不存在：${id}`);
  if (target.slot !== 'before_article') throw new Error('article_header 组件必须使用 before_article 插槽');
  if (!componentAssets(target).includes(defaultAssetId)) {
    throw new Error(`article_header 默认素材未登记在组件 ${id} 的 asset_ids 中`);
  }
  const available = new Set(assets.map(assetId));
  if (!available.has(defaultAssetId)) throw new Error(`article_header 默认素材未登记：${defaultAssetId}`);
  if (!Array.isArray(value.presets) || value.presets.length < 1 || value.presets.length > 12) {
    throw new Error('article_header.presets 必须包含 1–12 个预设');
  }
  const seen = new Set();
  const presets = [];
  for (const [index, preset] of value.presets.entries()) {
    if (!isObject(preset)) throw new Error(`article_header.presets[${index}] 必须是对象`);
    const presetAssetId = requireId(preset.asset_id ?? preset.assetId, `presets[${index}].asset_id`);
    if (!available.has(presetAssetId)) throw new Error(`article_header 预设素材未登记：${presetAssetId}`);
    const label = text(preset.label).replace(/\s+/g, ' ');
    if (!label || Array.from(label).length > 24) {
      throw new Error(`article_header.presets[${index}].label 必须为 1–24 个字符`);
    }
    if (seen.has(presetAssetId)) continue;
    seen.add(presetAssetId);
    presets.push({ assetId: presetAssetId, label });
  }
  if (!seen.has(defaultAssetId)) throw new Error('article_header 默认素材必须包含在 presets 中');
  return { componentId: id, defaultAssetId, presets };
}

// 这里只接收 Vault 附件引用。解析器仍需通过真实 TFile 核验文件是否存在。
const localImagePath = (value) => {
  let candidate = text(value);
  if (!candidate || candidate.length > 2048) return null;
  if (candidate.startsWith('[[') && candidate.endsWith(']]')) {
    candidate = candidate.slice(2, -2).trim();
    if (/[|#^]/u.test(candidate)) return null;
  }
  if (!candidate || /[\u0000-\u001f\u007f\\\[\]]/u.test(candidate)) return null;
  const unsafe = (path) => /^[a-z][a-z0-9+.-]*:/i.test(path)
    || /^[~/]/u.test(path)
    || path.split('/').some((part) => !part || part === '.' || part === '..');
  if (unsafe(candidate)) return null;
  // 不把编码后的路径重写成另一条路径，同时拒绝藏在编码中的越界引用。
  try {
    const decoded = decodeURIComponent(candidate);
    if (unsafe(decoded) || /[\u0000-\u001f\u007f\\]/u.test(decoded)) return null;
  } catch {
    // 文件名可以含字面百分号；没有有效 URL 编码时仍按 Vault 文件名解析。
  }
  return candidate;
};

const validSelection = (selection) => isObject(selection)
  && (selection.enabled === undefined || typeof selection.enabled === 'boolean')
  && (selection.preset === undefined || typeof selection.preset === 'string')
  && (selection.custom_image === undefined || typeof selection.custom_image === 'string');

/**
 * 在统一文章管线内选择头图，返回新的数组，不修改主题缓存或文章内容。
 * resolveCustom 是同步的 Vault 图片解析器；custom_image 非空时优先于 preset。
 */
export function resolveArticleHeader({
  definition,
  selection,
  components = [],
  assets = [],
  resolveCustom,
} = {}) {
  const unchanged = (warning) => ({
    components: [...components], assets: [...assets], warnings: warning ? [warning] : [],
  });
  if (!definition || selection === undefined || selection === null) return unchanged();
  if (!validSelection(selection)) return unchanged('文章头图设置格式不正确，已使用主题默认头图');
  const targets = components.filter((component) => componentId(component) === definition.componentId);
  if (targets.length !== 1 || targets[0].slot !== 'before_article') {
    return unchanged('主题指定的头图组件不可用，已保留主题原有内容');
  }
  if (selection.enabled === false) {
    return {
      components: components.filter((component) => componentId(component) !== definition.componentId),
      assets: [...assets],
      warnings: [],
    };
  }
  const target = targets[0];
  if (!componentAssets(target).includes(definition.defaultAssetId)) {
    return unchanged('主题头图组件缺少默认素材登记，已保留主题原有内容');
  }
  const defaultToken = `theme-asset://${definition.defaultAssetId}`;
  const tokenPattern = new RegExp(`${defaultToken.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z0-9._-])`, 'gi');
  if (typeof target.html !== 'string' || !tokenPattern.test(target.html)) {
    return unchanged('主题头图组件缺少可替换图片，已保留主题原有内容');
  }

  let chosenId = definition.defaultAssetId;
  let customAsset = null;
  const custom = text(selection.custom_image);
  if (custom) {
    const path = localImagePath(custom);
    if (!path) return unchanged('自定义头图必须是知识库内的图片路径，已使用主题默认头图');
    if (!/\.(?:png|jpe?g|webp|gif)$/i.test(path)) return unchanged('自定义头图文件类型不受支持，已使用主题默认头图');
    let resolved;
    try { resolved = typeof resolveCustom === 'function' ? resolveCustom(path) : null; } catch {
      return unchanged('自定义头图读取失败，已使用主题默认头图');
    }
    if (!resolved || typeof resolved.url !== 'string' || !resolved.url.trim()
      || !localImagePath(resolved.filePath) || !/\.(?:png|jpe?g|webp|gif)$/i.test(resolved.filePath)) {
      return unchanged('自定义头图不存在或不可读取，已使用主题默认头图');
    }
    chosenId = 'article-header-custom';
    const used = new Set(assets.map(assetId));
    for (let suffix = 2; used.has(chosenId); suffix += 1) chosenId = `article-header-custom-${suffix}`;
    customAsset = {
      ...resolved,
      id: chosenId,
      target: resolved.target ?? path,
      origin: 'article',
    };
  } else if (text(selection.preset)) {
    chosenId = text(selection.preset);
    if (!definition.presets.some((preset) => preset.assetId === chosenId)) {
      return unchanged('所选头图预设已不存在，已使用主题默认头图');
    }
    const selectedAsset = assets.find((asset) => assetId(asset) === chosenId);
    if (!selectedAsset?.url || !selectedAsset?.filePath) {
      return unchanged('所选头图预设不可读取，已使用主题默认头图');
    }
  }
  if (chosenId === definition.defaultAssetId) return unchanged();
  tokenPattern.lastIndex = 0;
  const nextTarget = {
    ...target,
    html: target.html.replace(tokenPattern, () => `theme-asset://${chosenId}`),
    assetIds: [...new Set(componentAssets(target).map((id) =>
      id === definition.defaultAssetId ? chosenId : id))],
  };
  return {
    components: components.map((component) => component === target ? nextTarget : component),
    assets: customAsset ? [...assets, customAsset] : [...assets],
    warnings: [],
  };
}
