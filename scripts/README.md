# scripts/

一次性/本地数据准备工具，不参与 `npm run build`，不是运行时代码。

## fetch-item-icons.mjs（Node 版）

```bash
npm run fetch:icons
```

读 `reference/item_ids.json`，按 `https://static.warfarin.wiki/v4/itemicon/{item_id}.webp`
逐个下载，存到 `public/icons/items/{item_id}.webp`，已存在的跳过（可重复
跑、可中断续传）。抓不到的 id（404）跑完会打印列表。

**这个脚本目前还没实际跑通过**——Claude Code 沙盒环境的出网代理策略不
允许访问 `static.warfarin.wiki`，用户的工作电脑网络也拦了（直连和走
CORS 代理都不行），所以脚本本身经过了语法检查、没有实跑验证过下载
流程本身（zip 打包/文件写入逻辑在 console 版里单独测过，见下）。等有
畅通网络环境时再实测。

## fetch-item-icons.console.js（浏览器控制台版）

给没有 Node/无法跑本地脚本的场景用（比如公司电脑限制多）。把整段代码
粘进浏览器 F12 → Console 回车跑，产出一个 `item_icons.zip` 触发浏览器
下载，解压后按 `public/icons/items/{item_id}.webp` 放进项目。

- 自带一个极简 ZIP 打包实现（仅 store，不压缩），不依赖任何第三方库，
  已经用本地 mock 服务器验证过打包出的 zip 能被 `unzip` 正常解压、字节
  内容和原文件一致。
- `static.warfarin.wiki` 这个 CDN 不下发 CORS 头，浏览器里直接 `fetch`
  会被拦（已实测确认），所以改成走 `PROXIES` 数组里列的几个公共 CORS
  代理转发，按顺序 failover，一个不通换下一个。这层 failover 逻辑也用
  本地 mock 代理测过（模拟"前几个代理连不上，最后一个成功"和"上游确实
  404"两种情况）。
- 如果所在网络把这几个公共代理也一并墙了（用户的公司电脑就是这种情况），
  这个办法就走不通了，只能换一个网络环境。

## 两者怎么选

能跑 Node 就用 `fetch-item-icons.mjs`（`npm run fetch:icons`），更简单、
可断点续传；跑不了 Node（浏览器可用但本地工具链受限）才用
`fetch-item-icons.console.js`。两者抓的目标和产出路径是一致的，抓完
可以直接把 `public/icons/items/` 下的文件混在一起用，不冲突。
