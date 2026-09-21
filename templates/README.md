本文档只回答一件事：10 套公开模板有哪些、怎样使用，以及与作者开发版有什么区别。

---

# 模板一览

模板随插件安装，普通用户无需把本目录复制到笔记区。
每套模板以 `manifest.json` 的 `theme_id` 定位；正文样式、登记素材、字体和视觉规范在同一目录。

| 模板 | 目录 |
| --- | --- |
| 纪念碑谷 | [monument-valley](monument-valley/) |
| 星尘手记 | [cobalt-orbit](cobalt-orbit/) |
| 简笔手绘 | [simple-sketch](simple-sketch/) |
| 黑夜女神 | [nyx-night](nyx-night/) |
| 蜡笔手绘 | [crayon-sketch](crayon-sketch/) |
| 手绘卡通 | [cartoon-doodle](cartoon-doodle/) |
| 解构插画 | [deconstructed-illustration](deconstructed-illustration/) |
| 暖瓷像素 | [feng-guo-shu-ye](feng-guo-shu-ye/) |
| 沙丘版画 | [dune-echo](dune-echo/) |
| 铅笔写意 | [pencil-impression](pencil-impression/) |

`catalog.json` 记录发布文件与哈希。
介绍图独立登记在 `showcase_image`，历史文章和旧样张未纳入公开包。

---

# 视觉样张（待确认）

下面两张用于比较视觉方向，尚未定稿。
正文模板仍可正常使用，其余介绍图会在方向确认后制作。

![简笔手绘：视觉样张（待确认）](simple-sketch/主题展示案例/模板介绍图.png)

![沙丘版画：视觉样张（待确认）](dune-echo/主题展示案例/模板介绍图.png)

---

# 字体与许可

各模板使用其 `manifest.json` 指定的原定字体，发布导出不改写字体选择。
附带的原始许可与说明文件保留在各字体目录；已登记的许可路径可在 `fonts[].license_file` 查看。
本项目的 MIT 许可不改变各字体自身的许可。
「简笔手绘」使用 HarmonyOS Sans 字体。

| 模板 | 原定字体 |
| --- | --- |
| 星尘手记 | 一级标题：方正清刻本悦宋简体 |
| 蜡笔手绘 | 一级、二级标题与金句：文心喜乐体 |
| 解构插画 | 一级标题：汇文明朝；二级标题：京华老宋体；金句：朱雀仿宋 |

配图 Skill 以用户正在使用的模板 `manifest.json` 为字体依据。
文心喜乐使用同轮廓的浏览器兼容文件，修复个别字显示为空白的问题；原字库、原覆盖表和转换验证记录同目录保留。
