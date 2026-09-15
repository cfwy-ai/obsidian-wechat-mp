/**
 * 让主题包住插件目录，而不是住 vault 里。
 *
 * 只回答一件事：怎样把插件目录下的主题包，伪装成主题加载器认识的 vault 结构。
 *
 * 背景：主题加载器（theme-registry.mjs）依赖 Obsidian 索引 API —— getAbstractFileByPath、
 * cachedRead、readBinary、getResourcePath。凡是走索引的目录都会出现在左侧文件树里。
 * 而 vault.adapter 不走索引，能读 .obsidian 下的文件，但它的 list 是异步的，
 * 加载器要的 getAbstractFileByPath 是同步的。
 *
 * 做法：先用 adapter 异步遍历一遍插件目录，建成同步索引，再用它实现一个 vault 门面。
 * 门面返回的伪文件对象保持 { path, name, parent, stat } 形状，
 * 所以复制图文、导出长图、标题图片光栅化这些下游逻辑一行都不用改。
 */

const PLUGIN_THEME_DIRECTORY = 'themes';

/** 伪文件夹：children 是数组，加载器据此判断是目录 */
const makeFolder = (path, name, parent) => ({ path, name, parent, children: [] });

/** 伪文件：没有 children，且 path 是字符串 */
const makeFile = (path, name, parent, stat) => ({
  path,
  name,
  parent,
  stat: { size: stat?.size ?? 0, mtime: stat?.mtime ?? 0, ctime: stat?.ctime ?? 0 },
});

/**
 * 递归索引一个 adapter 目录，返回 path → 伪文件/伪目录 的同步映射。
 * 遍历深度有上限，避免异常结构导致无限递归。
 */
async function indexAdapterFolder(adapter, rootPath, { maxDepth = 8 } = {}) {
  const index = new Map();
  const root = makeFolder(rootPath, rootPath.split('/').pop() ?? rootPath, null);
  index.set(rootPath, root);

  const walk = async (folder, depth) => {
    if (depth > maxDepth) return;
    let listing;
    try {
      listing = await adapter.list(folder.path);
    } catch {
      return;
    }
    for (const filePath of listing?.files ?? []) {
      const name = filePath.split('/').pop() ?? filePath;
      if (name === '.DS_Store') continue;
      let stat = null;
      try {
        stat = await adapter.stat(filePath);
      } catch {
        stat = null;
      }
      const file = makeFile(filePath, name, folder, stat);
      folder.children.push(file);
      index.set(filePath, file);
    }
    for (const dirPath of listing?.folders ?? []) {
      const name = dirPath.split('/').pop() ?? dirPath;
      const child = makeFolder(dirPath, name, folder);
      folder.children.push(child);
      index.set(dirPath, child);
      await walk(child, depth + 1);
    }
  };

  await walk(root, 0);
  return index;
}

/**
 * 主题包在插件目录下的根路径，例如
 * `.obsidian/plugins/changfeng-wechat-mp/themes`
 */
export function pluginThemeFolder(app, manifestDir) {
  const dir = manifestDir || `${app?.vault?.configDir ?? '.obsidian'}/plugins/changfeng-wechat-mp`;
  return `${dir}/${PLUGIN_THEME_DIRECTORY}`;
}

/**
 * 建一个只读 vault 门面，让加载器以为自己在读 vault，实际读的是插件目录。
 *
 * 返回 null 表示插件目录下没有主题包，调用方应回退到真实 vault（开发形态）。
 */
export async function createPluginThemeVault(app, manifestDir) {
  const adapter = app?.vault?.adapter;
  if (!adapter || typeof adapter.list !== 'function') return null;

  const rootPath = pluginThemeFolder(app, manifestDir);
  try {
    if (!(await adapter.exists(rootPath))) return null;
  } catch {
    return null;
  }

  const index = await indexAdapterFolder(adapter, rootPath);
  const root = index.get(rootPath);
  // 没有任何主题子目录时视为未安装，交给调用方回退
  if (!root || !root.children.some((child) => Array.isArray(child.children))) return null;

  return {
    /** 插件目录形态的标记，供日志与设置面板区分来源 */
    source: 'plugin',
    themeFolder: rootPath,
    configDir: app?.vault?.configDir ?? '.obsidian',
    getAbstractFileByPath: (path) => index.get(path) ?? null,
    cachedRead: (file) => adapter.read(file.path),
    read: (file) => adapter.read(file.path),
    readBinary: (file) => adapter.readBinary(file.path),
    getResourcePath: (file) => adapter.getResourcePath(file.path),
    /** 该路径是否属于本主题源，供读取路由判断走 adapter 还是走真实 vault */
    owns: (path) => index.has(path),
  };
}

/**
 * 读取路由：主题文件走主题源，文章文件走真实 vault。
 *
 * 复制图文与导出长图同时处理两类文件 —— 正文图片来自 vault，主题素材与字体可能来自
 * 插件目录。整体替换 vault 会让正文图片读不到，所以按文件逐个分派。
 * 开发形态下 themeVault 为 null，全部落回真实 vault，行为与改造前完全一致。
 */
export function createThemeAwareReader(appVault, themeVault) {
  const pick = (file) => (themeVault?.owns?.(file?.path) ? themeVault : appVault);
  return {
    readBinary: (file) => pick(file).readBinary(file),
    getResourcePath: (file) => pick(file).getResourcePath(file),
    read: (file) => {
      const vault = pick(file);
      return (vault.read ?? vault.cachedRead).call(vault, file);
    },
    cachedRead: (file) => {
      const vault = pick(file);
      return (vault.cachedRead ?? vault.read).call(vault, file);
    },
    getAbstractFileByPath: (path) => (
      themeVault?.owns?.(path)
        ? themeVault.getAbstractFileByPath(path)
        : appVault.getAbstractFileByPath(path)
    ),
  };
}
