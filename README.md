# 长风无月 Obsidian 插件：公众号排版一键发布

> [!TIP]
> **把下面这段话发给你的 Agent，它会帮你装好。**

```text
请帮我安装「长风无月 · 公众号排版」这个 Obsidian 插件。
安装步骤见 https://github.com/cfwy-ai/obsidian-wechat-mp/blob/main/plugin/docs/1.%20安装.md
请先确认我电脑上装了 Obsidian，再问我要装到哪一个 Vault（笔记库），
确认之后再动手，不要覆盖我已有的配置和笔记。
装完告诉我怎么启用，并核对是不是 10 套模板都在。
```

**动手之前有两件事：**

1. 还没装 Obsidian 的话，先去 [官网](https://obsidian.md/download) 下载安装。本插件需要 Obsidian 1.8.0 以上，**仅支持电脑端**。
2. Agent 会问你装到哪个 Vault。你可以在发上面那段话时就直接说明，例如「装到我的『XX』库，路径是 XX」，能少一轮来回。

---

# 这个插件解决什么问题

**把时间还给创作。**

在 Obsidian 里装好之后，内置 10 种风格各异的模板，写完文章点一下「复制图文」，直接粘贴到公众号长文编辑页面。

- 粘过去就是你选的那套风格，字体、字号、间距、配色这些排版设计都保留
- 支持更换文章头图
- 支持导出长图，电脑宽版和手机窄版两种都有

同时还配了两个 Agent Skill，把排版和配图这两件最费时间的事也接过去：

- **排版 Skill**：一个字都不改你的原文，只调整分段和层级，把文章排成更适合手机阅读的公众号版式
- **配图 Skill**：按你选定的那套模板风格，生成两张文章封图（横版、方版各一张）和正文配图；文章头图从模板自带的几套里挑，在插件里直接换

所以说，你只要把时间用在创作上，**把时间还给创作**。

不需要配置 AppID、AppSecret，也不会往你的笔记目录里塞模板文件。
插件不会替你发布文章，最后一步仍然由你在公众号后台确认。

---

# 十套模板

每套都提供一整篇文章的完整正文样式，从标题、正文、引用、表格到代码块。

下面每张图里的正文部分，都是插件真实渲染出来的，不是效果图。

### 🖊️ 简笔手绘

纯白打底，黑色马克笔轮廓保留笔压，荧光黄只用来划重点。

![简笔手绘](<templates/03. 简笔手绘/主题展示案例/模板介绍图.png>)

### 🌑 星尘手记

黑白中性灰的抽象几何印刷，圆盘、月相与细轨线构成有重量的墨面。

![星尘手记](<templates/02. 星尘手记/主题展示案例/模板介绍图.png>)

### ✏️ 铅笔写意

软铅侧锋与松散擦痕，同一笔里能看见浓黑、灰粉和纸齿，群青只点一下。

![铅笔写意](<templates/10. 铅笔写意/主题展示案例/模板介绍图.png>)

### 🏜️ 沙丘版画

浅砂纸上只落少量橙色与墨黑印痕，靠刻线和缺墨边缘交代形体。

![沙丘版画](<templates/09. 沙丘版画/主题展示案例/模板介绍图.png>)

### 🏛️ 解构插画

连续暖纸白上用薄水彩、淡墨与断续干笔，概括疏落的建筑关系。

![解构插画](<templates/07. 解构插画/主题展示案例/模板介绍图.png>)

### 🏔️ 纪念碑谷

雾灰、月白与暗绿，干净的大平面建筑配空气透视，留白产生距离。

![纪念碑谷](<templates/01. 纪念碑谷/主题展示案例/模板介绍图.png>)

### 🌙 黑夜女神

深夜黑与骨白的古典夜幕壁画气质，香槟金稀少，只连关键处。

![黑夜女神](<templates/04. 黑夜女神/主题展示案例/模板介绍图.png>)

### 🖍️ 蜡笔手绘

奶油暖黄底上的蜡笔干性笔触，有笔压、叠色、飞白和不齐的边缘。

![蜡笔手绘](<templates/05. 蜡笔手绘/主题展示案例/模板介绍图.png>)

### 🎨 手绘卡通

中性灰纸露底，粗黑蜡笔轮廓配大块平涂，形体概括清楚。

![手绘卡通](<templates/06. 手绘卡通/主题展示案例/模板介绍图.png>)

### 🧩 暖瓷像素

暖白纸面上由肉眼可辨的薄哑光方纸片拼成物件，片间留着狭缝。

![暖瓷像素](<templates/08. 暖瓷像素/主题展示案例/模板介绍图.png>)
---

# 仓库里有什么

```text
obsidian-wechat-mp/
├── plugin/        插件本体：源码、安装文档与版本记录
├── templates/     10 套模板：样式、字体、素材与展示案例
├── skills/        两个可选的 Agent Skill：文章排版、文章配图
└── LICENSE        MIT 许可证
```

| 你想做什么 | 去哪里 |
| --- | --- |
| 安装插件 | [plugin/docs/1. 安装.md](<plugin/docs/1. 安装.md>) |
| 看每套模板的完整案例 | [templates/README.md](templates/README.md) |
| 了解每个版本改了什么 | [plugin/docs/3. 版本记录.md](<plugin/docs/3. 版本记录.md>) |
| 让 Agent 帮你排版和配图 | [skills/README.md](skills/README.md) |

模板跟着插件走，装完不会出现在你的笔记列表里。
两个 Skill 是可选的：不装也能正常使用插件。

---

# 使用前请知道

公众号后台保存之后的实际效果仍然需要你自己过一眼，表格、图片和手机深色模式尤其值得确认。
插件只负责把排好的内容交给你，不替你点发布。

---

# 许可

插件源码采用 [MIT 许可证](LICENSE)。

模板中的字体各自保留原有授权，相关声明随字体文件一起放在每套模板的 `配套字体资源/` 目录里。
本项目的 MIT 许可不改变任何字体自身的授权条款。

```text
MIT License

Copyright (c) 2026 长风无月

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
