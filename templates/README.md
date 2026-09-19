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

`catalog.json` 记录发布文件、哈希和必要的字体替代。
介绍图独立登记在 `showcase_image`，历史文章和旧样张未纳入公开包。

---

# 视觉样张（待确认）

下面两张用于比较视觉方向，尚未定稿。
正文模板仍可正常使用，其余介绍图会在方向确认后制作。

![简笔手绘：视觉样张（待确认）](simple-sketch/主题展示案例/模板介绍图.png)

![沙丘版画：视觉样张（待确认）](dune-echo/主题展示案例/模板介绍图.png)

---

# 字体与许可

各字体保留原许可，具体路径见对应 `manifest.json` 的 `fonts[].license_file`。
本项目的 MIT 许可不替代字体自身许可。
「简笔手绘」使用 HarmonyOS Sans 字体。

以下字体缺少足够的再分发材料，公开版采用已附许可的相近字体。
作者 Vault 的可编辑版本不受影响。

| 模板 | 开发版字体 | 公开版字体 |
| --- | --- | --- |
| 星尘手记 | 方正清刻本悦宋 | 朱雀仿宋 |
| 蜡笔手绘 | 文心喜乐体 | 站酷快乐体 |
| 解构插画 | 京华老宋体 | 朱雀仿宋 |

替代会改变相应标题或引用的字形；配色、版式结构和主题素材保持原有设计。
配图 Skill 以用户正在使用的模板 `manifest.json` 为字体依据。
