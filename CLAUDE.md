# CLAUDE.md

本文件是 Claude Code 在本仓库中工作时的项目记忆库，记录项目背景、技术约束与代码规范。修改代码前请先读一遍，尤其是"代码规范与修改原则"一节。

## 项目简介

《明日方舟：终末地》（Arknights: Endfield）风格的**极简基建布局模拟器**。核心玩法是在无限网格画布上摆放生产设备（目前仅"粉碎机"一种，3×3 占地），用传送带把设备的输出口和输入口连起来，传送带路径由 A* 自动直角寻路生成，也可以手动插入途经点自由改线。设备可以旋转、传送带支持自动汇流（Merger）/自动分流（Splitter）、正交交叉生成"物流桥"、端点可重新拖拽改接，并有完整的 Ctrl+Z 撤销栈。

这是一个纯前端原型/demo，没有后端、没有持久化，刷新页面即丢失所有数据（见 `project_status.md` 的已知问题）。

## 技术栈与依赖

- **当前实际技术栈**：纯 HTML5 Canvas 2D + 原生 JavaScript（ES6+，箭头函数/`class`/解构等）+ **Vite** 作为开发服务器/打包工具，用 ES Module（`import`/`export`）组织代码。有 `package.json`，唯一的第三方依赖是 `vite`（devDependency），没有运行时依赖。
- **文件结构**（`project_status.md` 的"重构建议"已落地）：
  - `index.html` —— 只剩 HTML 骨架（canvas / toolbar / hint 等 DOM 节点），`<link rel="stylesheet" href="/style.css">` 引入样式，`<script type="module" src="/src/main.js"></script>` 引入入口模块。
  - `style.css` —— 原来内联在 `<style>` 里的全部样式，原样搬出，规则不变。
  - `src/constants.js` —— 所有 `UPPER_SNAKE_CASE` 常量（`GRID_SIZE`、`PORT_COUNT`、`TURN_PENALTY`、`DIR_*`、`BELT_WIDTH`、`HISTORY_LIMIT`、`HINT_*` 等）。
  - `src/state.js` —— DOM 元素引用（`canvas`/`ctx`/`toolbar`/`crusherIcon`/`ghostIcon`/`hintEl`，各自独立 `export`，**不在** `state` 对象里）+ 一个导出的可变 `state` 对象，装下原来所有顶层 `let`（`devices`、`connections`、`selectedId`、`freeBeltMode` 等，见下方"全局变量习惯"）。
  - `src/coords.js` —— `screenToWorld`/`worldToScreen`/`worldToCell`/`initView`。
  - `src/devices.js` —— 设备数据模型、端口计算（`getDevicePorts`/`edgePorts`/`nodeDevicePorts`）、碰撞检测、`spawnTemplate`。
  - `src/pathfinding.js` —— `aStarOrthogonal`、`removeSelfOverlap`、`buildBeltOccupancy`、`computePath`、`splitConnectionAtCell`、连线/途经点命中测试等。
  - `src/render.js` —— 所有 `drawXxx` 函数 + `draw()`。
  - `src/history.js` —— `cloneCanvasState`/`pushHistory`/`undo`/`revertLastHistoryStep`/`brokeExistingValidConnection`。
  - `src/interactions.js` —— 鼠标/键盘事件绑定、自由传送带模式状态机（`resolveFreeStartClick` 等，传送带/管道共用同一份实现）、工具栏拖拽生成新设备。
  - `src/main.js` —— 入口：`resize()`、`initView()`、`initInteractions()`、首次 `draw()`。
  - `src/data/facilities.js` —— 独立的真实游戏基建设备数据（`FACILITIES`，按【基础生产】【合成制造】【电力】【仓储存取】【其他】分类分组），与 `devices.js` 里 demo 用的 `SPAWN_TEMPLATES` 解耦，目前只是数据落地，尚未接入任何运行时逻辑（工具栏生成/`getDevicePorts()`/渲染），部分设备的 `footprint` 因源数据冲突而为 `null`（见文件顶部注释），`power`/`bandwidth` 字段暂缺待补。
- 依赖安装与本地预览：
  ```bash
  npm install
  npm run dev      # 启动 Vite 开发服务器(默认 http://localhost:5173，热更新)
  npm run build     # 产出到 dist/ 的生产构建
  npm run preview   # 本地预览 build 产物
  ```
  不再支持直接双击 `index.html` 用 `file://` 打开（ES Module 的 `import` 在 `file://` 协议下会被浏览器按 CORS 拦截），必须经由 Vite dev server 或任意支持 ES Module 的静态服务器访问。

## 代码规范与修改原则

代码已按功能拆分到 `src/*.js` 的 ES Module 里（见上方"文件结构"），不再是单个 IIFE；但模块拆分只是把原来 IIFE 闭包内的分区物理搬到了对应文件，**行为和下面这些约定完全没变**，新增代码前先确认该放进哪个模块（对照上面"文件结构"的职责划分，不要把新函数塞进无关模块）：

### 命名规范
- **函数/变量**：`camelCase`，动词开头描述行为，例如 `hitTestDevice`、`buildBlockedSet`、`resolveFreeStartClick`、`pickNearestPortByDistance`。名字要能看出"做什么"，不要用 `a`/`tmp` 这类占位名（循环内部短生命周期变量除外，如 `a`, `b` 表示线段两端点）。
- **常量**：`UPPER_SNAKE_CASE`，写在文件靠前位置或就近声明，例如 `GRID_SIZE`、`PORT_COUNT`、`TURN_PENALTY`、`DIR_E/DIR_S/DIR_W/DIR_N`、`BELT_WIDTH`、`HISTORY_LIMIT`、`HINT_NORMAL`/`HINT_BELT`。
- **方向常量**：固定用 `DIR_E=0, DIR_S=1, DIR_W=2, DIR_N=3`（顺时针编号，和屏幕旋转角度 `dir * Math.PI / 2` 对应），配套 `DIR_VECT` 位移表、`oppositeDir()`、`orientationOf()`（转 'H'/'V'）。新增方向相关逻辑必须复用这一套常量，不要另起编号体系。
- **坐标系术语**：严格区分三套坐标，命名上带前缀区分：
  - `client(X,Y)` / `screen`：屏幕像素坐标（鼠标事件坐标）。
  - `world(X,Y)`：世界坐标（未量化的浮点数，`GRID_SIZE=50` px/格）。
  - `cell` / `(col,row)`：网格整数坐标，`worldToCell()` 转换。
  转换只走 `screenToWorld` / `worldToScreen` / `worldToCell` 这三个函数，不要在别处手写换算公式。

### 全局变量习惯
- **模块化之后的例外**：原来是 IIFE 顶层一个个 `let`（`devices`、`connections`、`selectedId`、`freeBeltMode`、`draggingWaypoint`、`endpointDrag`、`cursorTooltip`、`history` 等）。拆成 ES Module 后，跨模块 `import` 进来的绑定是只读的——没法在别的模块里对 `import` 进来的 `let` 重新赋值，扁平 `let` 的写法没法照搬到多文件场景。因此 `src/state.js` 改用一个共享的可变 `state` 对象承载所有这些原顶层 `let`，各模块统一通过 `state.xxx = ...` 读写，语义和原来完全等价，只是多了一层容器——**这是唯一被批准偏离"扁平 let"风格的地方**，不要因为这个先例就把其它明明可以独立 `export` 的东西（比如 `canvas`/`ctx`/`spawnTemplate` 这类不会被 `undo()` 重置的"准常量"）也塞进 `state` 对象。
- 新增交互态变量时，在 `src/state.js` 的 `state` 对象里加一个新字段 + 紧跟着的注释说明其含义/结构，延续原来的注释风格。
- 新增交互态变量后，必须在下面三处同步处理，否则会有状态泄漏 bug（本项目已经踩过好几次这个坑）：
  1. `src/history.js` 的 `undo()` 里重置（撤销可能发生在交互进行到一半时）。
  2. `src/interactions.js` 里进入自由传送带模式的 `E` 键分支里重置（进入画线模式是"独占工具"，要清掉其它残留交互态）。
  3. `src/interactions.js` 里对应的 `mouseup`/`dblclick`/`contextmenu` 收尾逻辑里正确清空。
- 常量和状态变量都不要挂到 `window`/全局作用域，保持在各自模块的 `export` 范围内。

### 样式编写规则
- 所有全局外观都写在根目录的 `style.css` 里（原来内联在 `<head>` 的 `<style>`，重构时原样搬出），用普通 CSS class/id 选择器，不用 CSS-in-JS、不用行内 `style=`（除了 Canvas 内 `ctx.fillStyle` 这类绘图属性，那是 Canvas API 不是 DOM 样式）。
- **整体是白色基调的工业风**：画布背景、toolbar、hint 胶囊都是白/浅灰，不是早期版本的深色 UI。颜色沿用现有调色板，不要新增无关色系：
  - **设备统一白底黑边**（`#ffffff` 填充 + `#111` 描边），不管是粉碎机、反应池，还是汇流器/分流器/管道汇流器/管道分流器这类 1x1 节点——不再用颜色区分设备种类，靠占地大小 + 标签文字（"汇"/"分"等）分辨，见 `devices.js` 的 `SPAWN_TEMPLATES` 和 `pathfinding.js` 的 `splitConnectionAtCell`。新增任何设备种类时延续这条规则，不要为了区分而给设备发明新的填充色。
  - 设备标签（含途经点等标注文字）用加粗的思源黑体（`'Noto Sans SC'`，字重 900/Black，`index.html` 已经用 `<link>` 从 Google Fonts 引入），撑粗野主义工业风的质感；`render.js` 里的 `LABEL_FONT_FAMILY` 常量统一了字体族字符串，新增文字渲染时复用它，不要另起字体声明。
  - 端口是极简的"›"折线箭头（只描边、不填充，见 `render.js` 的 `drawPortMarker`），不是早期的实心三角/圆点。传送带口 `BELT_PORT_COLOR`(深色) / 管道口 `PIPE_PORT_COLOR`(蓝色)，是否已连接用不透明度表达（未连接半透明、已连接不透明），不要再叠加第三种颜色维度。
  - 传送带是半透明琥珀色条带（`BELT_COLOR`），额外叠一圈半透明淡灰色描边（`BELT_EDGE_COLOR`/`BELT_EDGE_WIDTH`，见 `drawConnectionPath`）模仿工业钢板边缘质感；管道保持细线条、**不叠描边**，这是两者除宽度外的另一处视觉区分，新增管道相关渲染时不要顺手也给它加描边。
  - 选中态统一用黄色系（`#ffeb3b` 描边/传送带表面）。
  - 警告/无效态统一用红色系，且**半透明**，呼应设备重叠警示的 `rgba(255, 0, 0, 0.45)` / `#ff1744`（传送带无效态用的是 `rgba(255, 23, 68, 0.35/0.55)`，同一色相不同透明度）。新增任何"这个操作不合法/位置不可用"的视觉反馈，复用这个红色语义，不要发明新颜色。
  - 自由传送带模式的强调色是绿色 `rgba(102, 187, 106, ...)`（悬停高亮、拉线预览虚线、hint 胶囊的 `belt-mode` 边框）；自由管道模式对应蓝色 `PIPE_ACCENT`，代表"当前处于放置传送带/管道的操作中"。
- **画布内一切尺寸类数值都要跟着地图缩放走**：`render.js` 里点的*位置*通过 `worldToScreen` 天然会乘 `state.scale`，但线宽/箭头大小/端口大小/圆角半径/字号这类**尺寸**不会自动跟着变，必须显式乘 `state.scale`——统一用 `render.js` 顶部的 `scaled(px)` 辅助函数（`constants.js` 里这些尺寸常量都按"缩放 1x 时的屏幕像素数"注释）。新增任何画布内绘制代码，只要用到固定像素的线宽/大小，都要过一遍 `scaled()`，不要漏改导致 zoom in 后比例失调（这是修过的真实 bug）。像 `pathfinding.js` 里 `hitTestConnection` 的命中容差这类"和视觉尺寸对应的判定阈值"也要同步乘 `state.scale`，否则缩放后点击手感会和视觉宽度对不上。
- 自由传送带/管道模式下拉线的虚线预览，起点/终点若精确落在某个设备端口上，要把该端口自身的精确世界坐标拼进预览点数组的首/尾（而不是端口外侧那一格的格心，两者差半格），否则预览虚线会和端口图形之间露出一截空隙，参考 `interactions.js` 的 `updateFreePreview` 与 `pathfinding.js` 的 `computePath` 里 `startPort`/`endPort` 的同类处理。
- UI 浮层（hint 胶囊、toolbar、ghost-icon）一律 `position: fixed` + `pointer-events: none`（除非本身要接收鼠标事件，如 toolbar 图标），避免遮挡或吃掉 Canvas 上的交互。

### 代码模块化与注释
- 代码已按上方"文件结构"拆到 `src/*.js` 多个模块，模块本身就是最外层的分区；每个模块内部仍然**必须**用 `// ---- 分节标题 ----` 这种注释块划出更细的逻辑分区（例如 `pathfinding.js` 内部区分"正交 A* 寻路"和"手动途经点"，`interactions.js` 内部区分"自由传送带模式""画布内鼠标交互""键盘""工具栏拖拽生成新设备"）。新增一大块功能时，先想清楚它属于哪个模块、模块内哪个分区，或要不要开一个新分区，不要把新函数随手插在无关模块/分区中间。
- 注释只写"为什么这么做"，不写"这行代码是干嘛的"——变量名和函数名已经说清楚 what 了。典型例子是 `removeSelfOverlap` 上面那段解释 A* 状态空间为什么会产生"多凸出一格再掉头"伪影，以及 `computePath` 里为什么**不能**对拼接后的完整路径整体去重（这是刚踩过的坑，注释原文保留，修改这块逻辑前务必先读懂这条注释）。
- 每个"点击优先级""解析规则"类的函数（如 `resolveFreeStartClick`、`resolveFreeEndClick`，传送带/管道共用同一份实现、靠 `BELT_UI`/`PIPE_UI` 描述符区分，见 `interactions.js` 顶部的说明）都在函数上方用编号列表写清楚判定顺序。新增新的点击/命中判定分支时，同步更新这个列表，保持顺序描述和代码分支顺序一致。

### A* 寻路代价值规则（重要，改动前必读）
寻路核心是 `aStarOrthogonal(startCol, startRow, startDir, goalCol, goalRow, goalDir, blocked, beltOccupancy)`，状态空间是 `(col, row, dir)` 三元组，`dir` 表示"到达这一格时的移动方向"：

- **转弯代价**：直行 `stepCost = 1`；方向改变（含转弯和掉头）`stepCost = 1 + TURN_PENALTY`（当前 `TURN_PENALTY = 3`）。这个惩罚存在的意义是让 A* 优先选择"能走直线就不拐弯"的路径，视觉上更像真实传送带布局。**修改 `TURN_PENALTY` 或代价公式时，必须保证直行路径的总代价始终严格小于任何绕路/掉头方案**，否则会出现明明能走直线却绕远路的诡异路径。
- **禁止 180° 掉头产生原地反复横跳**：算法本身没有对"掉头"单独加更高的代价（掉头和普通 90° 转弯代价相同），但通过下面两层机制保证掉头不会产生糟糕路径：
  1. `closed` 集合以 `(col,row,dir)` 为 key，同一状态只处理一次，天然防止死循环。
  2. 掉头要多走 2 步 + 多付 1 次转弯代价才能抵消，A* 的最优性保证它只会在"确实必须掉头才能到达终点"时才选择掉头（比如终点端口要求笔直进入，而当前朝向正对反方向）。
  - **新增/修改路径逻辑时的硬性要求**：如果要引入新的代价规则，必须保持"掉头永远不比等价的绕路方案更便宜"这个不变量，否则会产生原地抖动的路径。
- **自我重叠去重分两层，不要合并**：
  - `removeSelfOverlap()` **只能**作用于单跳（起点到下一个途经点，或途经点到终点）自己的 A* 结果，用于消除该跳因方向约束在端点附近产生的"多凸出一格再掉头"伪影。
  - **绝对不要**对多跳拼接后的完整路径再整体跑一遍 `removeSelfOverlap` 去**截断**路径——如果路径带有手动途经点，后一跳为了绕回终点，完全可能在几何上需要经过前一跳已经用过的格子（用户把途经点拖到终点反方向时），截断会把这段折返连同途经点效果一起吃掉，导致传送带在拖拽时看起来"纹丝不动"（这是修过的真实 bug，详见 `computePath` 里的大段注释和 git log 里 `fix: waypoint drag no longer erases itself` 这次提交）。
  - 但"不截断"不代表"允许自我重叠"：传送带物理上不能穿过自己。做法**不是**算完整条路径后再事后拒绝，而是从第二跳起就让 A* 提前知道"此路不通"：每算完一跳，就把这一跳走过的格子直接并入本次 `computePath` 调用私有的 `blocked` 集合(`buildBlockedSet()` 每次调用都返回一个全新 Set，只在这一次 `computePath` 内部累积、不会泄漏到别的连线)，后面的跳如果原本想抄近路走回这些格子，会被当成撞墙一样绕开——这正是让"以途经点为中心自动绕出一个 U 形"成为默认行为的关键，而不是把回头路整个拒掉。只有当连绕行也无路可走时(比如被设备完全围死)，那一跳的 `aStarOrthogonal` 才会真的返回 `null`，走到下面"找不到路径"的红色警示分支。`hasSelfOverlap()` 仍然保留在拼接之后做一次只读兜底校验(理论上按构造不会再触发，纯粹防止以后改这块逻辑时不小心破坏了这个不变量)；一旦真触发，仍旧复用"找不到路径"的红色警示渲染，并由拖拽途经点/端点重接的 `mouseup` 处理逻辑撤销这次改动（新插入的途经点整体移除、移动已有途经点则还原回拖拽前的位置）。（这是修过的真实 bug：一开始完全没有这层检测和绕行，导致拖拽途经点能摆出一条自我重叠、视觉上"走回头路"的传送带；第一版修复只加了事后检测+拒绝，会把本该自动绕成 U 形的合法操作也一并拒掉，详见 `project_status.md` 已知 Bug 历史记录）。
- **不允许重叠、允许正交交叉**：`beltOccupancy`（`buildBeltOccupancy()` 产出）记录每个格子已被占用的朝向集合。同朝向直行进入已占用格子 = 非法重叠，直接跳过该邻居；仅被垂直朝向占用 = 合法交叉，渲染时会在 `computeCrossings()` 判定并画"物流桥"。新增路径规则时如果涉及占用检测，走这一套 `beltOccupancy` 机制，不要另建一套。

### 其它修改原则
- 任何会修改 `devices`/`connections`/`nextId`/`nextConnId` 的操作，**必须**在修改前调用一次 `pushHistory()`（参考现有所有调用点：设备生成/删除/拖拽落位、旋转、传送带生成/删除/汇流/分流、途经点插入/删除、端点重接）。漏掉会导致 Ctrl+Z 撤销不到这一步。
- 设备/传送带的增删改之后，只要可能影响到已有连线的路径，就要调用 `recomputeAllConnections()` 全量重算（当前实现就是全量重算，没有做增量优化，详见 `project_status.md` 的性能相关待办）。
- 新增一种设备"kind"（目前只有默认的 3×3 `crusher` 和 1×1 的 `merger`/`splitter`）时，端口计算要在 `getDevicePorts()` 里按 `kind` 分派，不要在别处对 `kind` 做散落的 if 判断。
- **任何一次性操作都不能顺手弄坏一条别的、操作前还合法的连线**：`splitConnectionAtCell()`（生成汇流器/分流器）会放一个新的 1×1 设备，拖拽已有设备（`draggingDeviceId`）会挪动一个 3×3 设备的位置，这两类操作只要占用/挤占了另一条连线本来合法穿过（直行或物流桥交叉）或绕行需要用到的格子，`recomputeAllConnections()` 就可能让那条连线突然变 `invalid`——但用户视角里两条路径/两次操作根本没有冲突。`createSplitterAtClick()`、`finalizeFreeBeltConnection()` 的 `merge` 分支、以及设备拖拽的 `mouseup` 收尾逻辑，都要在改动生效、`recomputeAllConnections()` 跑完之后，用 `brokeExistingValidConnection(beforeSnapshot)` 检查这一步是否把某条操作前合法的连线拖成 `invalid`，一旦是就用 `revertLastHistoryStep()` 整体撤销、不留 Ctrl+Z 记录（这次操作从用户角度看根本没发生；设备拖拽会还原回拖拽前的格子位置）。注意设备重叠（`computeCollidingIds`）不受这条规则约束，那仍然只是警示、不阻挡放置，这里管的只是"连线被顺手拖坏"。新增任何"会移动/放置设备或连线并触发 `recomputeAllConnections()`"的操作时，照这个模式走，不要只顾着让"自己这次要做的事"合法，却不管有没有连带弄坏别的连线。

## Git 工作流与自动 Commit 规范

- **必须自动存档，不要等用户提醒**：每当成功完成一个需求、修复完一个 Bug、或重构完一段代码后，只要已经过测试确认无误（语法检查通过 + 手动/Playwright 走查过相关交互路径，参考上面"运行与预览"一节的验证方法），就必须在本地自动依次运行：
  ```bash
  git add .
  git commit -m "简短说明"
  ```
  不需要等待用户开口要求提交，也不需要为此单独确认——这是每完成一个独立的功能点/修复点/重构点之后的标准收尾动作。仍然只在测试确认无误之后才提交；没验证过的半成品不要提交。
- **Commit 信息规范**：用简洁清晰的前缀 + 一句话说明，前缀含义沿用约定俗成的写法：
  - `feat:` 新增功能，例如 `feat: 新增水管`
  - `fix:` 修复 Bug，例如 `fix: 修复传送带掉头`
  - `refactor:` 不改变行为的重构，例如 `refactor: 拆分文件`
  - 其它按需使用 `docs:`（文档）、`style:`（纯样式/格式调整）等同类前缀，保持和上面三个的写法一致。
  - 说明部分一句话讲清楚做了什么，不需要展开成段落；需要更多背景时才在提交信息正文追加。
- 是否推送到远端（`git push`）仍然按对话里的常规规则处理——自动 commit 不等于自动 push，push 前该有的确认/说明照常进行。

## 运行与预览

```bash
npm install       # 首次拉取仓库后安装依赖(vite)
npm run dev        # 启动 Vite 开发服务器(默认 http://localhost:5173，热更新)
npm run build       # 产出到 dist/ 的生产构建(用于验证打包不报错)
npm run preview      # 本地预览 build 产物
```

`index.html` 的 `<script type="module">` 依赖浏览器原生 ES Module 加载，在 `file://` 协议下会被 CORS 拦截跑不起来，**必须**通过 `npm run dev`（或任意支持正确 MIME 类型的静态服务器，比如 `npx serve .`）访问，不能再双击文件打开。

没有测试框架、没有 lint 配置、没有 CI。改完代码后建议至少跑一遍 `npm run build` 确认没有打包期语法/引用错误，再用浏览器（或 Playwright，本机 Chromium 预装在 `/opt/pw-browsers/`）手动走一遍改动涉及的交互路径确认没有回归。
