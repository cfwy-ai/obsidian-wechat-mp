import { safeThemeRelativePath } from '../src/theme-package.mjs';
import { discoverVaultThemes } from './theme-registry.mjs';

/**
 * The plugin's hidden resources are not Obsidian TFiles. This read-only view
 * makes them available to the existing CSS, image, font and export pipeline,
 * while all article reads still go through the real Vault.
 */
export class ThemeResources {
  constructor({ vault, pluginDir, metadataCache }) {
    this.vault = vault;
    this.metadataCache = metadataCache;
    this.root = `${safeThemeRelativePath(pluginDir, '插件目录')}/templates`;
    this.entries = new Map();
    this.catalog = null;
    this.problems = [];
    this.discovery = null;
  }

  async initialize() {
    this.entries.clear();
    this.discovery = null;
    try {
      const catalog = JSON.parse(await this.vault.adapter.read(`${this.root}/catalog.json`));
      if (catalog.schema_version !== 1 || !Array.isArray(catalog.themes) || !Array.isArray(catalog.files)) {
        throw new Error('内置模板清单格式不正确');
      }
      const folder = (path) => {
        if (this.entries.has(path)) return this.entries.get(path);
        const parentPath = path.slice(0, path.lastIndexOf('/'));
        const parent = path === this.root ? null : folder(parentPath);
        const entry = { path, name: path.split('/').at(-1), parent, children: [] };
        this.entries.set(path, entry);
        parent?.children.push(entry);
        return entry;
      };
      folder(this.root);
      for (const item of catalog.files) {
        const relative = safeThemeRelativePath(item.path, '内置模板文件');
        const path = `${this.root}/${relative}`;
        if (this.entries.has(path)) throw new Error(`内置模板文件重复：${relative}`);
        const parent = folder(path.slice(0, path.lastIndexOf('/')));
        const name = path.split('/').at(-1);
        const entry = {
          path, name, parent,
          basename: name.replace(/\.[^.]+$/, ''),
          extension: name.includes('.') ? name.split('.').at(-1) : '',
          stat: { size: item.bytes ?? 0, mtime: 0 },
        };
        this.entries.set(path, entry);
        parent.children.push(entry);
      }
      for (const theme of catalog.themes) {
        const entry = this.entries.get(`${this.root}/${safeThemeRelativePath(theme.directory)}`);
        if (!entry?.children) throw new Error(`内置模板目录缺失：${theme.theme_id}`);
        entry.name = `${String(theme.order ?? 0).padStart(2, '0')}. ${theme.name}`;
      }
      this.catalog = catalog;
      this.problems = [];
    } catch (error) {
      this.entries.clear();
      this.catalog = null;
      this.problems = [`内置模板读取失败：${error.message}。请重新安装完整插件包。`];
    }
    return this;
  }

  ownsFile(file) {
    return Boolean(file && !Array.isArray(file.children) && this.entries.get(file.path) === file);
  }

  getAbstractFileByPath(path) {
    return this.entries.get(path) ?? this.vault.getAbstractFileByPath(path);
  }

  cachedRead(file) {
    return this.ownsFile(file) ? this.vault.adapter.read(file.path) : this.vault.cachedRead(file);
  }

  read(file) {
    return this.ownsFile(file) ? this.vault.adapter.read(file.path) : this.vault.read(file);
  }

  readBinary(file) {
    return this.ownsFile(file) ? this.vault.adapter.readBinary(file.path) : this.vault.readBinary(file);
  }

  getResourcePath(file) {
    return this.ownsFile(file)
      ? this.vault.adapter.getResourcePath(file.path)
      : this.vault.getResourcePath(file);
  }

  async discover(settings) {
    if (settings.themeSource === 'vault') {
      return discoverVaultThemes({
        vault: this.vault, metadataCache: this.metadataCache, themeFolder: settings.themeFolder,
      });
    }
    if (!this.catalog) return { themes: [], problems: this.problems };
    this.discovery ??= discoverVaultThemes({
      vault: this, metadataCache: this.metadataCache, themeFolder: this.root, bundled: true,
    });
    return this.discovery;
  }
}
