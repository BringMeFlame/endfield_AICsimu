# project_status.md

项目进度看板。每次做完一轮功能/修复后建议更新本文件（尤其是"已实现功能"和"已知 Bug"两节），保持它和代码实际状态同步。

## 当前版本

**v0.2（模块化 + Vite 版本）**

原来单个 ~2000 行 `index.html`（内联 CSS + JS）已拆分为：`style.css` + `src/{constants,state,coords,devices,pathfinding,render,history,interactions,main}.js`，用 Vite 构建（`npm install && npm run dev`）。仍然无后端、无持久化。当前分支：`claude/refactor-modularization-v0bcen`。详见 CLAUDE.md 的"技术栈与依赖"一节。

## 已实现功能

按代码里实际存在的功能逐项列出：

**画布基础**
- 无限网格画布（Canvas 2D），`GRID_SIZE=50` px/格。
- 拖拽空白处平移画布，滚轮缩放（`scale` 限制在 0.2～4 倍）。

**设备**
- 从左侧工具栏拖拽图标生成设备（目前仅"粉碎机"一种，3×3 占地），拖拽中显示跟随鼠标的幽灵图标和吸附预览（若与现有设备重叠，预览变红色警示）。
- 点击选中设备（黄色虚线高亮框），拖拽移动（网格吸附）。
- `R` 键顺时针旋转选中设备 90°（仅 `crusher` 类型可旋转；`merger`/`splitter` 朝向由被切入的传送带决定，不支持手动旋转）。
- 设备重叠实时检测与半透明红色警示（`computeCollidingIds`）。
- `Delete`/`Backspace` 删除选中设备：**只删设备本身**，相连传送带保留，断开处变为悬空的自由网格端点，仍可在普通模式下选中/删除/调整途经点。

**端口系统**
- 每台标准设备 3 个输入口 + 3 个输出口（`PORT_COUNT=3`），随设备旋转联动换边；端口箭头指向物料流动方向。
- 汇流器（Merger，1×1，黄色，标签"汇"）：3 个可用输入边 + 1 个固定输出边，容量上限 3 进 1 出。
- 分流器（Splitter，1×1，蓝色，标签"分"）：1 个固定输入边 + 3 个可用输出边，容量上限 1 进 3 出。
- 端口占用状态可视化：未占用输入口蓝色/输出口橙色，已连接变绿色。

**A* 自动寻路**
- 正交（直角）A* 寻路，状态空间 `(col, row, dir)`，转弯代价 `TURN_PENALTY=3`，优先直线路径。
- 传送带之间禁止物理重叠，但允许正交交叉，交叉处自动渲染"物流桥"（`computeCrossings` + `drawLogisticsBridge`）。
- 自我重叠消除（`removeSelfOverlap`）：按单跳去重，避免端口方向约束导致的"多凸出一格再掉头"伪影；**不对多跳拼接后的整体路径做截断式去重**（上一轮修的 bug，详见下方"已知 Bug"历史记录）。
- 自我重叠检测（`hasSelfOverlap`）：拼接完多跳路径后只读检测是否有格子被经过不止一次，一旦发现就整体判定为 `invalid`（本轮新加，详见下方"已知 Bug"历史记录）。
- 支持手动途经点（waypoints）：多段分别寻路后拼接，途经点之间转向不限制，只有最后一段进入终点仍受端口方向约束。

**传送带渲染与交互**
- 带状渲染：深色轨道 + 亮色表面 + 等距辊轴刻线 + 流向箭头。
- 选中态（黄色）/ 无效态（半透明红色警示，替代不合法路径，配色与设备重叠警示呼应；找不到路径、或拼接后的路径自我重叠时都会触发）。
- 拖拽传送带线体：插入/移动一个途经点，自由调整路线；双击途经点删除。松手时若该位置导致路径无效（自我重叠/无解），撤销这次改动——新插入的途经点整体移除，移动已有途经点则还原回拖拽前的位置。
- 端点重接（Endpoint Re-attach）：普通模式下拖拽已连接输入口的箭头，可实时重新寻路改接到同一/其它设备的另一个可用输入口；同样地，松手时若落点导致路径无效则还原回拖拽前的输入口。

**自由传送带模式（`E` 键切换）**
- 独立的"画线模式"：光标变十字，进入时清空其它交互态；右键或再按 `E` 退出。
- 两次点击流程：左键点起点 A（输出口 / 设备本体自动选最近可用输出口 / 空白格）→ 移动鼠标实时预览路径 → 左键点终点 B 落地。
- 端口拉线规则限制：**禁止以输入口为起点**、**禁止以输出口为终点**，误点触发轻量光标提示（1.4 秒自动消失）且不中断当前画线。
- 终点落在已有传送带上 → 自动在该格插入汇流器节点；终点落在已有的汇流器/分流器节点本体上 → 自动接入其下一个可用端口。
- `Alt+左键` 点击已有传送带（任意模式下均可触发）→ 原地生成分流器节点，并自动进入自由传送带模式、把该节点设为新分支起点。
- 点击设备本体（非精确端口）时的兜底逻辑：起点按点击位置几何距离选最近可用输出口；终点按到起点的寻路代价选最优可用输入口。

**撤销**
- `Ctrl+Z`（Mac `Cmd+Z`）撤销上一步操作，历史栈上限 30 步。
- 覆盖：设备生成/删除/拖拽移动/旋转，传送带生成/删除/汇流/分流/途经点增删/端点重接，几乎所有会修改画布数据的操作。
- 当前**没有 Redo**（重做）功能。

**UI**
- 左下角快捷键提示胶囊：默认显示核心快捷键（`[E] 传送带 | [R] 旋转 | [Alt+左键] 分流 | [Ctrl+Z] 撤销`），进入自由传送带模式后自动切换为该模式专属提示（带绿色高亮边框），退出后切回。

## 后续待办 (TODO)

**已知计划：高空管道**

用户已明确后续要加入"高空管道"功能。当前架构下需要预先考虑的点（先记录，未设计/未实现）：
- 需要引入类似"图层/高度"的概念区分地面传送带与高空管道，渲染上要能表现出层级差异（比如管道用不同的贴图/半透明地面阴影）。
- 碰撞检测（`buildBlockedSet`）、占用检测（`buildBeltOccupancy`）目前都是纯 2D 平面假设，管道大概率需要"不与地面传送带冲突，但仍受设备高度限制"这类新规则，建议在动手前先设计好数据结构（比如给 `connections` 加一个 `layer` 字段），避免和现有寻路/占用逻辑冲突。
- 地面传送带与高空管道之间大概率需要"上下高架"衔接点（类似现实中的坡道/立柱），这会引入新的节点类型，可以参考现有 `merger`/`splitter` 的 1×1 特殊节点模式来实现。

**建议扩充的功能/优化项**（按当前功能逻辑推导，非用户明确要求，供参考）：

1. **本地存档 / 读档**：目前刷新页面就丢失所有布局，这是最基础的缺口。建议先做最简单的版本——用 `localStorage` 序列化 `devices`/`connections`，加一个"保存"/"读取"按钮或自动保存。
2. **Redo（重做）**：已经有完整的 Undo 历史栈基础设施，加一个"重做栈"成本不高，`Ctrl+Y` / `Ctrl+Shift+Z` 是常见约定。
3. **多种设备类型**：目前设备库只有一种"粉碎机"，`spawnTemplate` 是写死的单一模板。建议把设备类型抽成一个数组/配置表（形状、颜色、标签、端口数），工具栏渲染多个图标供选择。
4. **框选 / 批量操作**：目前一次只能选中一个设备或一条传送带，批量移动/删除/旋转对搭建大型基建布局会很有用。
5. **性能优化（增量重算）**：`recomputeAllConnections()` 每次都是对所有连线整体重跑一遍 A*，设备/连线数量上去后（几十条以上）会有明显卡顿。可以考虑只重算受影响的连线（比如只重算与被移动设备直接相连、或路径与其发生实际交集的连线）。

## 重构建议（已完成，见下方"重构记录"）

~~当前 `index.html` 已经接近 2000 行……~~ 本节原为重构前的建议，已在 `claude/refactor-modularization-v0bcen` 分支上按此方向落地，实际结构与偏差记录在下方"重构记录"一节，本节原文保留作历史参照：

- **先拆 CSS**：把 `<style>` 块整体挪到独立的 `style.css`，`index.html` 里用 `<link rel="stylesheet" href="style.css">` 引入。这是收益最高、风险最低的第一步。
- **再拆 JS，按现有代码里已经存在的分区拆模块**（分区标题已经在代码注释里划好了，直接对应文件即可）：
  - `coords.js` —— 世界坐标系参数、`screenToWorld`/`worldToScreen`/`worldToCell`。
  - `devices.js` —— 设备数据模型、端口计算（`getDevicePorts`/`edgePorts`/`nodeDevicePorts`）、碰撞检测。
  - `pathfinding.js` —— `aStarOrthogonal`、`removeSelfOverlap`、`buildBeltOccupancy`、`computePath`。
  - `render.js` —— 所有 `drawXxx` 函数。
  - `interactions.js` —— 鼠标/键盘事件绑定、自由传送带模式状态机（`resolveFreeBeltStartClick` 等）。
  - `history.js` —— `pushHistory`/`undo`/`cloneCanvasState`。
- **引入 Vite** 作为开发服务器 + 打包工具，用 `<script type="module">` + ES `import`/`export` 组织上述文件，`npm run dev` 热更新会比现在手动刷新浏览器高效很多。这是目前项目里*还没有*的依赖，引入时需要新增 `package.json`。
- 如果不想引入构建工具，退而求其次的方案是继续用 `<script type="module">` + 原生 ES Module 相对路径 import（浏览器原生支持，不需要打包），只是没有热更新和打包压缩。
- 全局状态（一堆顶层 `let`）可以考虑收敛成一个 `state` 对象统一管理，但这是可选项，不是必须——如果只是拆文件、不改变现有"扁平 `let` + IIFE 闭包"的风格，跨模块共享状态会更麻烦（需要显式 import/export 每个变量），值得在真正动手前想清楚。

### 重构记录（v0.2）

- CSS 已拆到 `style.css`，逐字搬运，规则未改动。
- JS 按建议拆成 8 个模块，另加两个建议里没提到、但技术上必需的文件：
  - `src/constants.js`：把原本和"世界坐标系参数/端口/寻路/渲染/撤销/hint 文案"混在一起的 `UPPER_SNAKE_CASE` 常量集中到一处，`coords.js`/`devices.js`/`pathfinding.js`/`render.js`/`interactions.js` 各自按需 import。
  - `src/state.js`：**采用了建议里的可选方案**——原因是技术上必需，不是风格偏好。ES Module 的 `import` 绑定是只读的，`import { selectedId } from './x.js'; selectedId = 1;` 这种写法在跨模块场景下直接会报错，扁平 `let` 没法照搬到多文件。于是把原来所有顶层 `let` 收进一个共享的可变 `state` 对象，各模块用 `state.xxx = ...` 读写；`canvas`/`ctx`/`toolbar`/`crusherIcon`/`ghostIcon`/`hintEl` 这几个 DOM 引用因为不会被 `undo()` 之类逻辑重置，作为独立的具名 `export` 留在 `state.js` 里，没有塞进 `state` 对象。
  - `src/main.js`：入口模块，做 `resize()`/`initView()`/`initInteractions()`/首次 `draw()` 的启动编排，原代码里这部分散落在 IIFE 末尾几行 + `window.addEventListener('resize', ...)`。
- 模块间依赖是单向无环的：`interactions.js → {history, render, pathfinding, devices, coords, state, constants}`，`render.js`/`pathfinding.js` → `{devices, coords, state, constants}`，`devices.js`/`coords.js` → `{state, constants}`，`history.js → {render, state, constants}`。没有出现需要用延迟 import 或事件总线绕开的循环依赖。
- 用 Vite 8.x（初次 `npm install` 装的 5.4 有 esbuild 开发服务器的已知 CORS 漏洞，升级到最新大版本后 `npm audit` 0 漏洞）。`package.json` 提供 `dev`/`build`/`preview` 三个脚本，`node_modules/`、`dist/` 已加入 `.gitignore`。
- 验证方式：`npm run build` 走通生产打包（13 个模块正确 tree-shake/打包成一个 chunk）；用 Playwright（本机预装的 Chromium）跑通了设备生成、选中、`R` 旋转、`E` 进入自由传送带模式画线、A* 精确端口直连、拖拽途经点绕出 U 形绕行、Alt+左键生成分流器、`Ctrl+Z` 撤销等交互路径，浏览器控制台无报错（除了浏览器自动请求 `favicon.ico` 的良性 404，原单文件版本同样会有这个请求）。
- 重构中发现并修复了一处真实笔误：`render.js` 里一度把 `ctx`（Canvas 2D 上下文）误写成 `state.ctx`——但 `ctx` 是 `state.js` 里独立的具名 `export`，不是 `state` 对象的属性，导致所有 `drawXxx` 函数报 `Cannot read properties of undefined (reading 'clearRect')`。已改为直接 `import { ctx } from './state.js'` 并统一使用 `ctx`。这不是行为变更，只是模块拆分引入又修复的笔误，记在这里避免以后重复踩坑。

## 已知 Bug / 待优化事项

- **无本地持久化**：刷新页面即丢失所有数据（见上方 TODO 第 1 项，属于严重但非"崩溃级"的缺口）。
- **窗口 resize 不重新居中视图**：`window.addEventListener('resize', resize)` 只重设 Canvas 尺寸并重绘，没有重新调用 `initView()`，`offsetX`/`offsetY` 保持不变，缩放浏览器窗口后画布内容可能不再居中。
- **端口/途经点命中半径较小**（`PORT_HIT_RADIUS=8` 屏幕像素），在较低缩放比例或快速拖拽时可能不好精确抓取，尤其是途经点密集的复杂路径上。
- **无 Redo**：撤销后无法重做，误撤销只能重新操作。
- **全量重算无增量优化**：连线数量较多时 `recomputeAllConnections()` 可能成为性能瓶颈（见"建议扩充"第 5 项）。
- 目前暂无已知的功能性崩溃/渲染错误——上一轮排查并修复了途经点拖拽导致传送带"纹丝不动"的 bug（整体去重误吞并合法折返路径）以及自由传送带模式下点击已有汇流器/分流器节点被误判为点击传送带本身的问题；再上一轮修复了那次修复引入的回归——去掉整体截断后 `computePath` 完全没有自我重叠检测，导致拖拽途经点/端点重接能摆出一条自我重叠、视觉上"走回头路"的传送带，且被当成合法路径正常渲染成黄色。当时的修复方式是加只读检测 `hasSelfOverlap`，发现自我重叠就整体判定为 `invalid`（红色警示）、松手时撤销这次改动。
- 本轮修复了上面那次修复自己的问题：`hasSelfOverlap` 是"算完再拒绝"，对着"拖途经点拖到需要绕一圈才能不重叠"的合法操作（比如以途经点为中心绕出一个 U 形）也会一律拒绝，而不是自动找出那条本该存在的绕行路径。改成从第二跳起把前面跳走过的格子直接并入 `blocked`（`computePath` 内部私有的一份，不影响其它连线），逼 A* 主动绕行，"以途经点为中心自动形成 U 形"现在是默认行为；只有连绕行都无路可走时才会落到"找不到路径"的红色警示。同时修了一个相关问题：生成汇流器/分流器（`splitConnectionAtCell`）放置的新 1×1 设备，如果正好占了另一条连线本来合法穿过的格子（直行或物流桥交叉），`recomputeAllConnections()` 会让那条本来正常的连线突然变成 `invalid`——从用户视角看两条路径明明没有冲突。修复：`createSplitterAtClick`/`finalizeFreeBeltConnection` 在调用 `splitConnectionAtCell` 之后用 `brokeExistingValidConnection` 检查是否有操作前合法的连线被拖成 `invalid`，一旦是就用 `revertLastHistoryStep` 整体撤销（不占 Ctrl+Z 历史）。两处均已在浏览器中验证：U 形绕行能正常拖出并提交、普通生成分流器/汇流器（含制造物流桥交叉后再分流）不再误报/误撤销。
- 又发现并修复了同一类问题的第三处：拖拽**已有设备**改变位置同样会触发 `recomputeAllConnections()`，但完全没有"是否弄坏了别的合法连线"这层保护——把设备拖到新位置后，如果这个位置挤占了另一条连线绕行/直行需要的格子，那条连线会直接变成 `invalid`（红色对角线，即"找不到路径"兜底渲染）并保持这个状态，哪怕用户觉得"明明还有地方能绕"。修复：设备拖拽的 `mouseup` 收尾逻辑里，落位、`recomputeAllConnections()` 之后同样用 `brokeExistingValidConnection` 检查，一旦弄坏了操作前合法的连线就用 `revertLastHistoryStep` 整体撤销，设备落回拖拽前的格子。已验证：会弄坏其它连线的拖拽正确回退（设备弹回原位、连线保持合法），拖到空旷不冲突的位置仍然正常移动、连线正常跟着重新绕路。

---

生成后请在 Git 中打个存档，提交信息示例：

```bash
git add CLAUDE.md project_status.md
git commit -m "docs: add project memory (CLAUDE.md) and status board (project_status.md)"
git push
```
