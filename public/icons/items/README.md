# 物品图标（占位）

这个目录还没有真正的图标文件，等用户在自己电脑上跑通 `scripts/fetch-item-icons.console.js`
（浏览器 F12 控制台版）或 `scripts/fetch-item-icons.mjs`（Node 版）之后，把抓下来的
`item_xxx.webp` 文件放到这个目录里，文件名直接用 `reference/item_ids.json` 里的
`item_id`（例如 `item_carbon_powder.webp`），不需要额外的映射表。

在单位电脑上试过直接 fetch 和走公共 CORS 代理转发两种办法，`static.warfarin.wiki`
这个 CDN 网络环境限制下都没通，先搁置，等有畅通网络环境时再抓。

已知有 75 个 `item_fbottle_*`/`item_gasjar_*` 这类"容器+内容物"组合物品在 wiki 上
查不到独立图标（推测游戏内是运行时叠加渲染，没有单独出图），这些 id 抓不到属于
正常情况，图标接入代码要对这个目录里没有对应文件的 item_id 做文字标签 fallback，
不能假设 199 个 id 都有图。
