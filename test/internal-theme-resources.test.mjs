import assert from 'node:assert/strict';
import test from 'node:test';
import {
  escapeCssString,
  internalThemeResourcePaths,
  internalThemeResourcesCss,
  InternalThemeResourcesVisibility,
  isConfiguredThemeRepositoryChange,
} from '../plugin/internal-theme-resources.mjs';

const THEME_FOLDER = '06｜个人账号运营/2. 排版配图/5. 图文主题仓库';

const folder = (path, parent = null) => {
  const entry = {
    path,
    name: path.split('/').at(-1),
    parent,
    children: [],
  };
  parent?.children.push(entry);
  return entry;
};

const fixtureVault = () => {
  const root = folder(THEME_FOLDER);
  const first = folder(`${THEME_FOLDER}/1. 纪念碑谷`, root);
  const second = folder(`${THEME_FOLDER}/7. 钴蓝星轨`, root);
  folder(`${first.path}/普通子目录`, first);
  const nested = folder(`${second.path}/普通子目录`, second);
  folder(`${nested.path}/正文组件结构`, nested);
  const entries = new Map([[root.path, root]]);
  return {
    root,
    vault: { getAbstractFileByPath: (path) => entries.get(path) ?? null },
  };
};

test('只为配置主题仓库的直属主题生成三个精确内部目录路径', () => {
  const { vault } = fixtureVault();
  const paths = internalThemeResourcePaths({ vault, themeFolder: `${THEME_FOLDER}/` });

  assert.equal(paths.length, 6);
  assert.deepEqual(paths.slice(0, 3), [
    `${THEME_FOLDER}/1. 纪念碑谷/配套字体资源`,
    `${THEME_FOLDER}/1. 纪念碑谷/字体资源`,
    `${THEME_FOLDER}/1. 纪念碑谷/正文组件结构`,
  ]);
  assert.ok(paths.includes(`${THEME_FOLDER}/7. 钴蓝星轨/配套字体资源`));
  assert.equal(paths.some((path) => path.includes('/普通子目录/')), false);
});

test('仓库根本身和内部变化都会刷新，名称相似的相邻目录不会误触发', () => {
  assert.equal(isConfiguredThemeRepositoryChange(THEME_FOLDER, THEME_FOLDER), true);
  assert.equal(
    isConfiguredThemeRepositoryChange(`${THEME_FOLDER}/7. 钴蓝星轨`, THEME_FOLDER),
    true,
  );
  assert.equal(
    isConfiguredThemeRepositoryChange(`${THEME_FOLDER}备份/7. 钴蓝星轨`, THEME_FOLDER),
    false,
  );
});

test('隐藏 CSS 使用 file-explorer 下的 exact data-path，不使用宽泛前后缀', () => {
  const target = `${THEME_FOLDER}/7. 钴蓝星轨/配套字体资源`;
  const css = internalThemeResourcesCss([target]);

  assert.match(css, /data-type="file-explorer"/);
  assert.match(css, /:has\(> \.nav-folder-title\[data-path=/);
  assert.match(css, /7\. 钴蓝星轨\/配套字体资源/);
  assert.doesNotMatch(css, /data-path\^=|data-path\$=|data-path\*=/);
  assert.match(css, /display: none !important/);
});

test('CSS 字符串会转义引号、反斜杠和换行，不能截断选择器', () => {
  assert.equal(escapeCssString('a"b\\c\nd'), 'a\\22 b\\5c c\\a d');
});

const fakeDocument = () => {
  const elements = new Map();
  const head = {
    appendChild: (element) => {
      element.isConnected = true;
      elements.set(element.id, element);
    },
  };
  return {
    head,
    getElementById: (id) => elements.get(id) ?? null,
    createElement: () => {
      const element = {
        id: '',
        textContent: '',
        isConnected: false,
        setAttribute: () => {},
        remove() {
          this.isConnected = false;
          elements.delete(this.id);
        },
      };
      return element;
    },
  };
};

test('默认隐藏、开关显示、关闭再隐藏与 dispose 清理都即时生效', () => {
  const { vault } = fixtureVault();
  const document = fakeDocument();
  const visibility = new InternalThemeResourcesVisibility({ vault, document });

  visibility.refresh({ themeFolder: THEME_FOLDER, showInternalThemeResources: false });
  assert.match(visibility.styleEl.textContent, /配套字体资源/);

  visibility.refresh({ themeFolder: THEME_FOLDER, showInternalThemeResources: true });
  assert.equal(visibility.styleEl, null);

  visibility.refresh({ themeFolder: THEME_FOLDER, showInternalThemeResources: false });
  assert.ok(visibility.styleEl);
  visibility.dispose();
  assert.equal(visibility.styleEl, null);
});

test('主题仓库路径改变后重新枚举，新旧根目录不会同时残留', () => {
  const first = fixtureVault();
  const newRoot = folder('自定义主题仓库');
  folder('自定义主题仓库/1. 自定义风', newRoot);
  const vault = {
    getAbstractFileByPath: (path) => {
      if (path === THEME_FOLDER) return first.root;
      if (path === newRoot.path) return newRoot;
      return null;
    },
  };
  const visibility = new InternalThemeResourcesVisibility({
    vault,
    document: fakeDocument(),
  });

  visibility.refresh({ themeFolder: THEME_FOLDER, showInternalThemeResources: false });
  assert.match(visibility.styleEl.textContent, /钴蓝星轨/);
  visibility.refresh({ themeFolder: newRoot.path, showInternalThemeResources: false });
  assert.match(visibility.styleEl.textContent, /自定义风/);
  assert.doesNotMatch(visibility.styleEl.textContent, /钴蓝星轨/);
});
