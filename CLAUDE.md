# CLAUDE.md

本文件是 Claude Code 在本仓库中工作时的项目记忆库，记录项目背景、技术约束与代码规范。修改代码前请先读一遍，尤其是"代码规范与修改原则"一节。

## 项目简介

《明日方舟：终末地》（Arknights: Endfield）风格的**极简基建布局模拟器**。核心玩法是在无限网格画布上摆放生产设备（目前仅"粉碎机"一种，3×3 占地），用传送带把设备的输出口和输入口连起来，传送带路径由 A* 自动直角寻路生成，也可以手动插入途经点自由改线。设备可以旋转、传送带支持自动汇流（Merger）/自动分流（Splitter）、正交交叉生成"物流桥"、端点可重新拖拽改接，并有完整的 Ctrl+Z 撤销栈。

这是一个纯前端原型/demo，没有后端、没有持久化，刷新页面即丢失所有数据（见 `project_status.md` 的已知问题）。

## 技术栈与依赖

- **当前实际技术栈**：纯 HTML5 Canvas 2D + 原生 JavaScript（ES6+，箭头函数/`class`/解构等），**没有任何构建工具、没有 `package.json`、没有第三方依赖**。整个应用是仓库根目录下唯一的 `index.html` 一个文件：`<style>` + HTML 结构 + 一个 IIFE 包裹的 `<script>`。
- 本地预览只需任意静态文件服务器，例如：
  ```bash
  python3 -m http.server 8971
  # 浏览器打开 http://localhost:8971/index.html
  ```
  或直接双击 `index.html` 用浏览器打开（Canvas/事件逻辑不依赖同源请求，双击打开也能跑）。
- **关于 Vite**：项目目前 *没有* 引入 Vite 或任何打包器。如果后续要拆分模块化（见 `project_status.md` 的"重构建议"），Vite 会是引入 ES Module 打包 + 开发热更新的合理选择，但这是**尚未发生的改动**，不要假设当前代码里已经有 Vite 配置。

## 代码规范与修改原则

代码目前全部集中在 `index.html` 的一个 IIFE 里（`(() => { ... })()`），下面这些是**已经在用、必须延续**的约定：

### 命名规范
- **函数/变量**：`camelCase`，动词开头描述行为，例如 `hitTestDevice`、`buildBlockedSet`、`resolveFreeBeltStartClick`、`pickNearestPortByDistance`。名字要能看出"做什么"，不要用 `a`/`tmp` 这类占位名（循环内部短生命周期变量除外，如 `a`, `b` 表示线段两端点）。
- **常量**：`UPPER_SNAKE_CASE`，写在文件靠前位置或就近声明，例如 `GRID_SIZE`、`PORT_COUNT`、`TURN_PENALTY`、`DIR_E/DIR_S/DIR_W/DIR_N`、`BELT_WIDTH`、`HISTORY_LIMIT`、`HINT_NORMAL`/`HINT_BELT`。
- **方向常量**：固定用 `DIR_E=0, DIR_S=1, DIR_W=2, DIR_N=3`（顺时针编号，和屏幕旋转角度 `dir * Math.PI / 2` 对应），配套 `DIR_VECT` 位移表、`oppositeDir()`、`orientationOf()`（转 'H'/'V'）。新增方向相关逻辑必须复用这一套常量，不要另起编号体系。
- **坐标系术语**：严格区分三套坐标，命名上带前缀区分：
  - `client(X,Y)` / `screen`：屏幕像素坐标（鼠标事件坐标）。
  - `world(X,Y)`：世界坐标（未量化的浮点数，`GRID_SIZE=50` px/格）。
  - `cell` / `(col,row)`：网格整数坐标，`worldToCell()` 转换。
  转换只走 `screenToWorld` / `worldToScreen` / `worldToCell` 这三个函数，不要在别处手写换算公式。

### 全局变量习惯
- 所有可变状态都是 IIFE 顶层的 `let` 声明（`devices`、`connections`、`selectedId`、`freeBeltMode`、`draggingWaypoint`、`endpointDrag`、`cursorTooltip`、`history` 等），**没有引入状态管理框架，也没有把状态收进单一 `state` 对象**——这是当前的既定风格，新增交互状态时延续"一个新的顶层 `let` + 紧跟着的注释说明其含义/结构"这个模式，不要临时改成别的模式（比如塞进已有对象里）。
- 新增交互态变量后，必须在下面三处同步处理，否则会有状态泄漏 bug（本项目已经踩过好几次这个坑）：
  1. `undo()` 里重置（撤销可能发生在交互进行到一半时）。
  2. 进入自由传送带模式的 `E` 键分支里重置（进入画线模式是"独占工具"，要清掉其它残留交互态）。
  3. 对应的 `mouseup`/`dblclick`/`contextmenu` 收尾逻辑里正确清空。
- 常量和状态变量都不要挂到 `window`/全局作用域，保持在 IIFE 闭包内。

### 样式编写规则
- 所有全局外观都写在 `<head>` 内联的 `<style>` 里，用普通 CSS class/id 选择器，不用 CSS-in-JS、不用行内 `style=`（除了 Canvas 内 `ctx.fillStyle` 这类绘图属性，那是 Canvas API 不是 DOM 样式）。
- 颜色沿用现有调色板，不要新增无关色系：
  - 输入口蓝 `#42a5f5`，输出口橙 `#ffa726`，已连接端口绿 `#66bb6a`。
  - 选中态统一用黄色系（`#ffeb3b` 描边/`#ffeb3b` 传送带表面）。
  - 警告/无效态统一用红色系，且**半透明**，呼应设备重叠警示的 `rgba(255, 0, 0, 0.45)` / `#ff1744`（传送带无效态用的是 `rgba(255, 23, 68, 0.35/0.55)`，同一色相不同透明度）。新增任何"这个操作不合法/位置不可用"的视觉反馈，复用这个红色语义，不要发明新颜色。
  - 自由传送带模式的强调色是绿色 `rgba(102, 187, 106, ...)`（悬停高亮、拉线预览虚线、hint 胶囊的 `belt-mode` 边框），代表"当前处于放置传送带的操作中"。
- UI 浮层（hint 胶囊、toolbar、ghost-icon）一律 `position: fixed` + `pointer-events: none`（除非本身要接收鼠标事件，如 toolbar 图标），避免遮挡或吃掉 Canvas 上的交互。

### 代码模块化与注释
- 虽然是单文件，内部**必须**用 `// ---- 分节标题 ----` 这种注释块划出逻辑分区（现有分区例如：世界坐标系参数、端口、正交 A* 寻路、手动途经点、绘制、自由传送带模式、画布内鼠标交互、键盘、工具栏拖拽生成新设备）。新增一大块功能时，先想清楚它属于哪个分区或要不要开一个新分区，不要把新函数随手插在无关分区中间。
- 注释只写"为什么这么做"，不写"这行代码是干嘛的"——变量名和函数名已经说清楚 what 了。典型例子是 `removeSelfOverlap` 上面那段解释 A* 状态空间为什么会产生"多凸出一格再掉头"伪影，以及 `computePath` 里为什么**不能**对拼接后的完整路径整体去重（这是刚踩过的坑，注释原文保留，修改这块逻辑前务必先读懂这条注释）。
- 每个"点击优先级""解析规则"类的函数（如 `resolveFreeBeltStartClick`、`resolveFreeBeltEndClick`）都在函数上方用编号列表写清楚判定顺序。新增新的点击/命中判定分支时，同步更新这个列表，保持顺序描述和代码分支顺序一致。

### A* 寻路代价值规则（重要，改动前必读）
寻路核心是 `aStarOrthogonal(startCol, startRow, startDir, goalCol, goalRow, goalDir, blocked, beltOccupancy)`，状态空间是 `(col, row, dir)` 三元组，`dir` 表示"到达这一格时的移动方向"：

- **转弯代价**：直行 `stepCost = 1`；方向改变（含转弯和掉头）`stepCost = 1 + TURN_PENALTY`（当前 `TURN_PENALTY = 3`）。这个惩罚存在的意义是让 A* 优先选择"能走直线就不拐弯"的路径，视觉上更像真实传送带布局。**修改 `TURN_PENALTY` 或代价公式时，必须保证直行路径的总代价始终严格小于任何绕路/掉头方案**，否则会出现明明能走直线却绕远路的诡异路径。
- **禁止 180° 掉头产生原地反复横跳**：算法本身没有对"掉头"单独加更高的代价（掉头和普通 90° 转弯代价相同），但通过下面两层机制保证掉头不会产生糟糕路径：
  1. `closed` 集合以 `(col,row,dir)` 为 key，同一状态只处理一次，天然防止死循环。
  2. 掉头要多走 2 步 + 多付 1 次转弯代价才能抵消，A* 的最优性保证它只会在"确实必须掉头才能到达终点"时才选择掉头（比如终点端口要求笔直进入，而当前朝向正对反方向）。
  - **新增/修改路径逻辑时的硬性要求**：如果要引入新的代价规则，必须保持"掉头永远不比等价的绕路方案更便宜"这个不变量，否则会产生原地抖动的路径。
- **自我重叠去重分两层，不要合并**：
  - `removeSelfOverlap()` **只能**作用于单跳（起点到下一个途经点，或途经点到终点）自己的 A* 结果，用于消除该跳因方向约束在端点附近产生的"多凸出一格再掉头"伪影。
  - **绝对不要**对多跳拼接后的完整路径再整体跑一遍 `removeSelfOverlap`——如果路径带有手动途经点，后一跳为了绕回终点，完全可能合法地需要原路折返、经过前一跳已经用过的格子（用户故意把途经点拖到终点反方向时），整体去重会把这段折返连同途经点效果一起吃掉，导致传送带在拖拽时看起来"纹丝不动"（这是修过的真实 bug，详见 `computePath` 里的大段注释和 git log 里 `fix: waypoint drag no longer erases itself` 这次提交）。
- **不允许重叠、允许正交交叉**：`beltOccupancy`（`buildBeltOccupancy()` 产出）记录每个格子已被占用的朝向集合。同朝向直行进入已占用格子 = 非法重叠，直接跳过该邻居；仅被垂直朝向占用 = 合法交叉，渲染时会在 `computeCrossings()` 判定并画"物流桥"。新增路径规则时如果涉及占用检测，走这一套 `beltOccupancy` 机制，不要另建一套。

### 其它修改原则
- 任何会修改 `devices`/`connections`/`nextId`/`nextConnId` 的操作，**必须**在修改前调用一次 `pushHistory()`（参考现有所有调用点：设备生成/删除/拖拽落位、旋转、传送带生成/删除/汇流/分流、途经点插入/删除、端点重接）。漏掉会导致 Ctrl+Z 撤销不到这一步。
- 设备/传送带的增删改之后，只要可能影响到已有连线的路径，就要调用 `recomputeAllConnections()` 全量重算（当前实现就是全量重算，没有做增量优化，详见 `project_status.md` 的性能相关待办）。
- 新增一种设备"kind"（目前只有默认的 3×3 `crusher` 和 1×1 的 `merger`/`splitter`）时，端口计算要在 `getDevicePorts()` 里按 `kind` 分派，不要在别处对 `kind` 做散落的 if 判断。

## 运行与预览

```bash
# 在仓库根目录起一个静态服务器（任选其一）
python3 -m http.server 8971
npx serve .

# 然后浏览器打开
http://localhost:8971/index.html
```

也可以不起服务器，直接用浏览器打开 `index.html` 文件（`file://` 协议下功能完全一致，因为没有任何跨域/fetch 依赖）。

没有测试框架、没有 lint 配置、没有 CI。改完代码后建议至少跑一遍 `node -e "new Function(...)"` 之类的语法检查（把 `<script>` 内容抽出来喂给 `new Function()`），再用浏览器（或 Playwright）手动走一遍改动涉及的交互路径确认没有回归。
