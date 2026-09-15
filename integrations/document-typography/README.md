本文档只回答一件事：文档标题同步功能的源码在哪里，如何构建文首标题与简介插件。

---

# 源码与部署

`main.cjs` 是文首标题与简介插件的源码。
共用标题逻辑位于 `../../src/document-title.mjs`，公众号长图导出也使用此模块。
Obsidian 内的 `main.js` 是打包产物，不再手动修改。

在 `code` 目录执行以下命令，构建后重载 `changfeng-document-typography`。

```bash
node_modules/.bin/esbuild integrations/document-typography/main.cjs --bundle --platform=neutral --format=cjs --external:obsidian --outfile="/Users/cfwy/Library/Mobile Documents/com~apple~CloudDocs/Obsidian/人工智能 🧠/.obsidian/plugins/changfeng-document-typography/main.js"
```

文首标题与简介版本为 `0.3.1`，公众号插件为独立版本。

---

# 标题规则

文档文字以文件名为准。
编辑文首大标题并离开输入框后，通过 Obsidian 文件管理器改名，同步更新链接。
回车不进入文件名，只以 `title_breaks` 保存字符位置。
历史 `display_title` 只有在去掉换行后与文件名完全相同时，才用于兼容换行。
不自动将其他笔记的历史显示名批量迁移为文件名。

---

# 刷新范围

`0.3.1` 只为已打开的 Markdown 文档处理文件修改后的文首刷新。
后台主题文件与未打开笔记的修改不再触发全页签文首更新。
打开文件、切换页签、布局变化与元数据更新仍保留原有处理。
