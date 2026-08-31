// 从 warfarin.wiki 抓取物品图标，存到 public/icons/items/{item_id}.webp。
//
// 用法（本机跑，这里说明写在这，不需要额外装依赖，纯 Node 内置 fetch/fs）：
//   node scripts/fetch-item-icons.mjs
//
// 图标 CDN 地址规律是从 wiki 物品列表页(用户上传的 wiki_itempage.txt)源码里
// 反查出来的：https://static.warfarin.wiki/v4/itemicon/{item_id}.webp ——
// item_id 和 reference/item_ids.json / recipes.txt 里的物品 id 是同一套，
// 不需要额外的 id 映射。
//
// 不是所有 id 都能查到图标：目前已知 item_fbottle_*(灌装瓶变体)和
// item_gasjar_*(灌装耐压罐变体)这类"容器+内容物"的组合物品在 wiki 上没有
// 单独的图标资源(推测游戏内也是复用容器本体图标+内容物颜色区分，没有为
// 每个组合单独出图)，抓不到属于正常情况，脚本跑完会把这些 id 列在
// "missing" 里，不算失败，画布/面板侧后续要接入时对这些 id 走文字标签
// fallback 即可。
//
// 只抓 item_ids.json 里已经确认要用的 199 个 id，不是抓整个 wiki 图标库
// (源码里能扒出 600+ 个，其中大部分是和本项目无关的角色/装备图标)。

import { readFile, mkdir, access } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { finished } from 'node:stream/promises';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const ITEM_IDS_PATH = path.join(ROOT, 'reference/item_ids.json');
const OUT_DIR = path.join(ROOT, 'public/icons/items');
const ICON_URL = (id) => `https://static.warfarin.wiki/v4/itemicon/${id}.webp`;
const DELAY_MS = 200; // 抓取间隔，别对 wiki CDN 太猛

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function fileExists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const items = JSON.parse(await readFile(ITEM_IDS_PATH, 'utf-8'));
  await mkdir(OUT_DIR, { recursive: true });

  let downloaded = 0;
  let skipped = 0;
  const missing = [];
  const failed = [];

  for (const [i, item] of items.entries()) {
    const outPath = path.join(OUT_DIR, `${item.id}.webp`);
    if (await fileExists(outPath)) {
      skipped++;
      continue;
    }

    const url = ICON_URL(item.id);
    try {
      const res = await fetch(url);
      if (res.status === 404) {
        missing.push(item.id);
      } else if (!res.ok || !res.body) {
        failed.push({ id: item.id, status: res.status });
      } else {
        await finished(Readable.fromWeb(res.body).pipe(createWriteStream(outPath)));
        downloaded++;
      }
    } catch (err) {
      failed.push({ id: item.id, error: String(err) });
    }

    if (i < items.length - 1) await sleep(DELAY_MS);
    if ((i + 1) % 20 === 0) {
      console.log(`  ...${i + 1}/${items.length}`);
    }
  }

  console.log(`\n完成：新下载 ${downloaded} 个，已存在跳过 ${skipped} 个，共 ${items.length} 个 id。`);
  if (missing.length) {
    console.log(`\n以下 ${missing.length} 个 id 在 wiki 上没查到图标(404，多半是 fbottle/gasjar 这类容器组合物品，预期内)：`);
    console.log(missing.join(', '));
  }
  if (failed.length) {
    console.log(`\n以下 ${failed.length} 个 id 请求出错(非404，网络问题或wiki改版，建议重跑一次)：`);
    console.log(JSON.stringify(failed, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
