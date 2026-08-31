# CLAUDE.md

本文件是 Claude Code 在本仓库中工作时的项目记忆库，记录项目背景、技术约束与代码规范。修改代码前请先读一遍，尤其是"代码规范与修改原则"一节。

## 项目简介

《明日方舟：终末地》（Arknights: Endfield）风格的**极简基建布局模拟器**。核心玩法是在有限尺寸的可选地图（`src/data/maps.js` 的 `MAP_CATALOG`）上摆放真实基建设备，用传送带把设备的输出口和输入口连起来，传送带路径由 A* 自动直角寻路生成，也可以手动插入途经点自由改线。设备可以旋转、传送带支持自动汇流（Merger）/自动分流（Splitter）、正交交叉生成"物流桥"、端点（输入口/输出口均可）可重新拖拽改接，并有完整的 Ctrl+Z 撤销栈。每张地图固定内置一个不可删除/不可复制的核心设备（可正常移动/旋转/连线），部分设备种类受地图边界约束（详见下方"其它修改原则"）。

这是一个纯前端原型/demo，没有后端、没有持久化，刷新页面即丢失所有数据（见 `project_status.md` 的已知问题）。

## 技术栈与依赖

- **当前实际技术栈**：纯 HTML5 Canvas 2D + 原生 JavaScript（ES6+，箭头函数/`class`/解构等）+ **Vite** 作为开发服务器/打包工具，用 ES Module（`import`/`export`）组织代码。有 `package.json`，唯一的第三方依赖是 `vite`（devDependency），没有运行时依赖。
- **文件结构**（`project_status.md` 的"重构建议"已落地）：
  - `index.html` —— 只剩 HTML 骨架（canvas / toolbar / hint 等 DOM 节点），`<link rel="stylesheet" href="/style.css">` 引入样式，`<script type="module" src="/src/main.js"></script>` 引入入口模块。
  - `style.css` —— 原来内联在 `<style>` 里的全部样式，原样搬出，规则不变。
  - `src/constants.js` —— 所有 `UPPER_SNAKE_CASE` 常量（`GRID_SIZE`、`TURN_PENALTY`、`DIR_*`、`BELT_WIDTH`、`HISTORY_LIMIT`、`HINT_*` 等）。
  - `src/state.js` —— DOM 元素引用（`canvas`/`ctx`/`toolbar`/`toolbarTabs`/`toolbarIcons`/`hintEl`/`powerSummaryEl`/`mapSelectEl`/`mapConfirmOverlayEl`/`mapConfirmMessageEl`/`mapConfirmCancelEl`/`mapConfirmOkEl`，各自独立 `export`，**不在** `state` 对象里）+ 一个导出的可变 `state` 对象，装下原来所有顶层 `let`（`devices`、`connections`、`selectedId`、`freeBeltMode`、`activeToolbarCategory`、`mapId`/`mapWidthCells`/`mapHeightCells`/`coreDeviceId`/`mapConfirmPending`（当前地图 + 地图切换二次确认浮层状态）等，见下方"全局变量习惯"）。
  - `src/coords.js` —— `screenToWorld`/`worldToScreen`/`worldToCell`/`initView`。
  - `src/mapBounds.js` —— 地图边界几何，纯派生计算：`getMapWorldRect`/`isRectInMapBounds`/`isCellInMapBounds`，地图矩形固定锚定在网格原点（左上角格 (0,0)），供 `devices.js`/`pathfinding.js`/`interactions.js` 的边界判定统一调用。
  - `src/devices.js` —— 设备数据模型、端口计算（`getDevicePorts`/`edgePorts`/`nodeDevicePorts`/`facilityDevicePorts`）、碰撞检测（`computeCollidingIds`）、地图边界判定（`requiresMapBounds()` 判定某设备种类是否受地图矩形约束、`computeOutOfBoundsIds()` 越界设备派生计算，和碰撞检测同一套"每次从 state.devices 现算、不进撤销栈"的先例）、电力覆盖判定（`computeUnpoweredIds`/`getPowerRangeRect`/`computePowerRangeRects`，纯派生计算；`computeUnpoweredIds` 直接判定 `powerCost < 0`，不单独维护 `needsPower` 布尔字段）、设备警告图标框架（`getDeviceWarnings`/`getWarningIconWorldPos`/`findWarningIconAt`，目前的警告类型有"未通电"和热能池燃料校验——`HEAT_POOL_FUEL_ITEM_IDS` 允许表，槽位里塞了非源矿/原木/电池类物品时触发，见下方"配方+物品槽位系统"一节）；`SPAWN_TEMPLATES` 由两部分拼接而成：`src/data/facilities.js` 的 `FACILITIES` 在模块加载时 `flatMap` 生成的真实基建设备模板（各地图的核心设备已从这份列表里排除，不能重复放置，见 `interactions.js` 的地图切换编排），加上文件内手写的 `NODE_TEMPLATES`（汇流器/分流器/管道汇流器/管道分流器四种 1×1 节点，归在独立的"物流"分类标签页，和游戏里的同名分类对应——这四种不是真实游戏建筑数据，不应该也塞进 `facilities.js`）。落地新设备的代码内联在 `interactions.js` 的工具栏 mouseup 处理里，不是独立的 `spawnTemplate` 函数；`getSpawnOrientedFields`/`buildSpawnPreviewDevice` 是拖拽生成新设备落地前的预旋转辅助（把 `state.spawnRotSteps` 换算成模板当前朝向下的 w/h/rot 或 mainOutEdge/mainInEdge，以及供 `render.js` 画预览端口箭头用的"假设备"），落地预览和真正落地生成设备共用同一份，不允许出现两份重复的旋转算法。
  - `src/pathfinding.js` —— `aStarOrthogonal`、`removeSelfOverlap`、`buildBeltOccupancy`、`buildBlockedSet`（接受 `network` 参数，管道网络对 `isLowProfile` 矮桩体设备直接跳过阻挡，传送带网络仍然绕开）、`computePath`、`splitConnectionAtCell`、连线/途经点命中测试、框选批量操作辅助（`boxSelectHitConnections`/`connectionsTouchingDevices`/`detachDeviceFromConnections`）等；`aStarOrthogonal`/`pickBestPort`/`computePath` 都带一个 `network` 参数（`BELT_NETWORK`/`PIPE_NETWORK`），管道网络直接跳过地图边界拒绝，传送带网络仍然受 `mapBounds.js` 约束，和跳过矮桩体阻挡是同一种"按网络分支"写法。
  - `src/render.js` —— 所有 `drawXxx` 函数（含 `drawMapBoundary()` 画当前地图矩形的边界描边）+ `draw()`。
  - `src/history.js` —— `cloneCanvasState`/`pushHistory`/`undo`/`revertLastHistoryStep`/`brokeExistingValidConnection`。
  - `src/recipeSlots.js` —— 配方槽位系统（预览阶段，还没最终定稿，见下方"配方+物品槽位系统"一节）的匹配/写入逻辑：`getSlotPanelKind()` 判定一个设备走哪种槽位面板（`'recipe'`＝配方自动匹配、`'port'`＝端口自由选物品、`null`＝没有槽位面板）、`buildInitialSlotState()` 落地新设备时生成初始槽位数据（'recipe' 模式落地即跑一遍 `normalizeSlotValues`，只有一种配方的设备直接摆出唯一解）、`computeSlotCandidates()`（原料/产物槽位共用同一个双向收紧算法，见文件内 `isRecipeViable` 的注释）、`normalizeSlotValues()`（`pruneInvalidSelections`/`autoFillFromSingleRecipe`/`autoFillSingletons` 三步收敛循环，收紧到唯一解自动填入）、`getRelevantItemIds`（抽屉"本设备相关"标签页用）、`setSlotValue`/`clearAllSlots`（写入前照例 `pushHistory()`，写完跑一遍 `normalizeSlotValues`）。同时依赖 `devices`/`data/recipes`/`data/items` 三份数据，单独开一个模块而不是塞进 `devices.js`。
  - `src/interactions.js` —— 鼠标/键盘事件绑定、自由传送带模式状态机（`resolveFreeStartClick` 等，传送带/管道共用同一份实现）、框选批量操作状态机（不是需要切换进入/退出的独立模式，普通模式下随时可用：`Ctrl+拖拽`拉矩形框选，按住已选中项直接拖拽即整体移动/不需要长按，`R` 键批量旋转/`Delete`/`Ctrl+C+V`，与自由传送带/管道模式互斥——进入这两个画线工具会清空当前框选批量选中）、工具栏拖拽生成新设备（含按分类生成标签页+图标 DOM 的 `buildToolbarUI()`、事件委托绑定、跟随鼠标的网格吸附落地预览 `updateSpawnPreview`（`render.js` 的 `drawSpawnPreview` 按设备实际占地+当前朝向画出带端口箭头的预览方块，不再有单独的跟随鼠标幽灵图标）；落地前可以用 `R` 键预旋转，累计步数存在 `state.spawnRotSteps`，和已放置设备的 `R` 键旋转共用同一套朝向换算逻辑，见 `devices.js` 的 `getSpawnOrientedFields`/`buildSpawnPreviewDevice`；开始从工具栏拖出新设备会立即清空普通模式下残留的单选/框选批量选中，避免拖拽期间按 `R` 转错到旧的选中目标上）、`H` 键切换供电范围叠层、地图切换编排（`applyMapSelection` 切换地图目录里的一项/`placeCoreDevice` 摆放该地图固定核心/`showMapConfirmModal`/`hideMapConfirmModal` 驱动自定义二次确认浮层——不用原生 `window.confirm()`，沙盒 iframe 环境会静默拦截原生 confirm，这是修过的真实 bug）、核心设备的删除/复制保护、受边界约束设备（`requiresMapBounds()` 为真的种类）放置/拖拽/旋转时的越界检查、自由传送带/管道起止点点击的边界拒绝（只对传送带生效，管道豁免，见 `BELT_UI`/`PIPE_UI` 的 `enforceMapBounds` 字段）、右键槽位面板 + 物品选择抽屉（预览阶段，见下方"配方+物品槽位系统"一节，`showRecipePanel`/`hideRecipePanel`/`showItemPicker`/`hideItemPicker` 及配套的 `bindRecipePanelEvents`/`bindItemPickerEvents`）。
  - `src/main.js` —— 入口：`resize()`、`initView()`、`bootstrapDefaultMap()`（引导设置默认地图 + 摆放该地图固定核心）、`initInteractions()`、首次 `draw()`。
  - `src/data/maps.js` —— 地图目录静态数据（`MAP_CATALOG`，和 `facilities.js` 同类，纯数据无逻辑），每条记录含 `id`/`label`/`w`/`h`（地图矩形网格格数）/`coreFacilityId`（对应该地图固定核心在 `facilities.js` 里的记录 id）。
  - `src/data/facilities.js` —— 独立的真实游戏基建设备数据（`FACILITIES`，按【基础生产】【合成制造】【电力】【仓储存取】【其他】分类分组，同一款游戏内建筑的不同模式/配方拆成独立记录，共45条，见记忆库 `endfield-multimode-devices-convention` 这条约定），每条记录含 `footprint`/`powerCost`/`powerRange`/`bandwidth`/`isLowProfile`/`ports`（端口 grid 坐标+朝向）等真实数值（字段含义见文件顶部注释）；各分类内的记录顺序对齐官方基建列表顺序，不是随意排列，新增/调整记录时留意别打乱这个顺序。已接入 `devices.js` 的 `SPAWN_TEMPLATES`/`getDevicePorts()` 和工具栏分类标签页 UI（占地/端口/旋转/寻路走真实数据），`powerCost`/`powerRange` 已接入供电覆盖判定（`devices.js` 的 `computeUnpoweredIds`/`getPowerRangeRect`）与右上角总功率显示，`isLowProfile` 已接入管道跨越矮桩体设备的寻路豁免（`pathfinding.js` 的 `buildBlockedSet`），`bandwidth` 仍只是数据，未接入任何吞吐计算逻辑；`slots` 字段（配方槽位面板用，只有已经和用户核对过槽位数的 26 条记录才有，字段含义/两种形状见文件内该字段上方的注释）是预览阶段新加的，还没最终定稿。
  - `src/data/items.js` —— 独立的物品数据（`ITEMS`，199 条，`id`/`name`/`portType`）+ 查找表 `ITEM_BY_ID`，配方槽位系统用。数据来源见 `reference/README.md`。
  - `src/data/recipes.js` —— 独立的配方数据（`RECIPES`，按 `facilityId` 分组，25 个 facilityId、共 321 条配方——比源数据 305 条多，是因为部分配方按用户核对结果同时归属"反应池"和"扩容反应池"两条记录），字段含义见文件内注释。数据来源同上，`environmentCondition` 字段目前只是原样保留用户核对的文字，还没接入任何判定代码。
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
  - 端口是极简的"›"折线箭头（见 `render.js` 的 `drawPortMarker`），不是早期的实心三角/圆点。常态填充白色 `PORT_FILL_COLOR`，描边用传送带口 `BELT_PORT_COLOR`(深色) / 管道口 `PIPE_PORT_COLOR`(蓝色)，是否已连接用不透明度表达（未连接半透明、已连接不透明）。`drawPortMarker` 额外接受一个三态 `portState`（`null`/`'hover'`/`'target'`），只用于"可拖拽改接"场景：`'hover'`——鼠标在普通模式下悬停在一个**已连接**的输入口或输出口上（此时按住即可把这条连线的对应端拖到别处重接，光标同步变成普通指针而不是拖动设备用的抓手），填充色换成亮色（传送带黄 `PORT_HOVER_FILL_BELT` / 管道蓝 `PORT_HOVER_FILL_PIPE`），描边同时改细（约 1.4px，`#111`），和常态的粗描边区分出"这里可以点"的质感；`'target'`——正在拖拽一段连线（改接某个已有端点，或自由传送带/管道模式画新线）时，鼠标划过的候选落点端口，同样换成亮色填充，但**不改描边粗细/颜色**（用户明确要求这条纯预览不能和"hover"的粗细混淆），只有填充色变化用来提示"松手会接到这里"。四种改接方向（输入口/输出口 × 传送带/管道）都对称支持，状态源头分别是 `state.hoveredPort`（空闲态悬停，见 `interactions.js` 的 idle-hover 检测块）和 `state.dragTargetPort`（拖拽中实时检测，见 `updateFreePreview` 和四种 Endpoint Re-attach 的 `mousemove` 块）。
  - 传送带是半透明琥珀色条带（`BELT_COLOR`），额外叠一圈半透明淡灰色描边（`BELT_EDGE_COLOR`/`BELT_EDGE_WIDTH`，见 `drawConnectionPath`）模仿工业钢板边缘质感；管道保持细线条、**不叠描边**，这是两者除宽度外的另一处视觉区分，新增管道相关渲染时不要顺手也给它加描边。
  - 选中态统一用黄色系（`#ffeb3b` 描边/传送带表面）——这条specifically指 **canvas 上**设备/连线的选中态；工具栏分类标签页这类纯导航 UI 的"当前选中"是另一套语义，用下划线式标签页强调（不描边、不填充背景，选中态黑色文字+黑色底部色条，未选中灰色文字，见 `style.css` 的 `.toolbar-tab`/`.toolbar-tab.active`），和下面设备列表的"白底黑框"按钮风格刻意拉开差异，一眼能分清"这是导航"还是"这是可拖拽的设备"；不要把两种"选中"混用同一个颜色，否则会让人误以为点了标签页会影响画布选中状态。
  - 警告/无效态统一用红色系，且**半透明**（图标类是不透明的实心红，见下），呼应设备重叠警示的 `rgba(255, 0, 0, 0.45)` / `#ff1744`（传送带/管道共用的连线无效态是 `constants.js` 的 `INVALID_COLOR`（未选中）/`INVALID_COLOR_SELECTED`（选中，更饱和/更不透明），同一色相不同透明度，选中态这一档和 `BELT_COLOR`/`BELT_COLOR_SELECTED`、`PIPE_COLOR`/`PIPE_COLOR_SELECTED` 是同一种写法，`render.js` 的 `drawConnectionPath` 里 `invalid` 分支也要看 `opts.selected`——早期版本这里漏看过，导致选中一条不成立的连线和未选中完全看不出区别，属于修过的真实 bug）。新增任何"这个操作不合法/位置不可用"或"设备运行状态异常"的视觉反馈，复用这个红色语义，不要发明新颜色——设备"断电"（`powerCost < 0` 但不在任何供电范围内）同样按这条规则处理：右上角小圆点+"!"徽标（`constants.js` 的 `WARNING_COLOR = '#ff1744'`/`WARNING_ICON_RADIUS`，`render.js` 的 `drawWarningIcon`），鼠标悬停时弹出文字提示浮窗（`drawWarningTooltip`，跟随 `state.hoveredWarningId`），命中判定见 `devices.js` 的 `findWarningIconAt`。这套"图标+悬停浮窗"框架是通用的（`getDeviceWarnings` 返回文案数组），未来新增别的设备警告类型直接复用，不需要另起一套颜色/图标逻辑。
  - 供电覆盖范围叠层（`H` 键全局开关 + 拖拽供电桩/中继器时的落地预览）用半透明黄橙色 `POWER_RANGE_FILL`/`POWER_RANGE_STROKE`——这是纯信息展示层，不是警告，也不是操作模式，因此既不用警告红也不用任何一种"当前处于 XX 操作中"的强调色（绿/蓝/紫，见下一条），避免和这些既有语义混淆。
  - 自由传送带模式的强调色是绿色 `rgba(102, 187, 106, ...)`（悬停高亮、拉线预览虚线、hint 胶囊的 `belt-mode` 边框）；自由管道模式对应蓝色 `PIPE_ACCENT`——这两者代表"当前处于某种独占操作模式中"。`Ctrl+拖拽` 框选矩形对应紫色 `BOX_SELECT_ACCENT`（框选矩形本身/hint 胶囊在有框选批量选中项时的 `box-select-mode` 边框），色相上仍然和绿/蓝区分开，但框选批量选中本身**不是**一个需要切换进入/退出的独占模式（早期版本是靠 `X` 键切换的独立模式，长按已选中项才能触发批量拖动，手感别扭，已经改成普通模式下随时可用：`Ctrl+拖拽` 拉框、按住已选中项直接拖拽即整体移动）——新增同类独占工具模式时，颜色仍然要从未用过的色相里挑，不要和已有三个(绿/蓝/紫)撞色。
- **画布内一切尺寸类数值都要跟着地图缩放走**：`render.js` 里点的*位置*通过 `worldToScreen` 天然会乘 `state.scale`，但线宽/箭头大小/端口大小/圆角半径/字号这类**尺寸**不会自动跟着变，必须显式乘 `state.scale`——统一用 `render.js` 顶部的 `scaled(px)` 辅助函数（`constants.js` 里这些尺寸常量都按"缩放 1x 时的屏幕像素数"注释）。新增任何画布内绘制代码，只要用到固定像素的线宽/大小，都要过一遍 `scaled()`，不要漏改导致 zoom in 后比例失调（这是修过的真实 bug）。像 `pathfinding.js` 里 `hitTestConnection` 的命中容差这类"和视觉尺寸对应的判定阈值"也要同步乘 `state.scale`，否则缩放后点击手感会和视觉宽度对不上。
- 自由传送带/管道模式下拉线的虚线预览，起点/终点若精确落在某个设备端口上，要把该端口自身的精确世界坐标拼进预览点数组的首/尾（而不是端口外侧那一格的格心，两者差半格），否则预览虚线会和端口图形之间露出一截空隙，参考 `interactions.js` 的 `updateFreePreview` 与 `pathfinding.js` 的 `computePath` 里 `startPort`/`endPort` 的同类处理。
- UI 浮层（hint 胶囊、toolbar）一律 `position: fixed` + `pointer-events: none`（除非本身要接收鼠标事件，如 toolbar 图标、地图切换确认浮层），避免遮挡或吃掉 Canvas 上的交互。

### 代码模块化与注释
- 代码已按上方"文件结构"拆到 `src/*.js` 多个模块，模块本身就是最外层的分区；每个模块内部仍然**必须**用 `// ---- 分节标题 ----` 这种注释块划出更细的逻辑分区（例如 `pathfinding.js` 内部区分"正交 A* 寻路"和"手动途经点"，`interactions.js` 内部区分"自由传送带模式""画布内鼠标交互""键盘""工具栏拖拽生成新设备"）。新增一大块功能时，先想清楚它属于哪个模块、模块内哪个分区，或要不要开一个新分区，不要把新函数随手插在无关模块/分区中间。
- 注释只写"为什么这么做"，不写"这行代码是干嘛的"——变量名和函数名已经说清楚 what 了。典型例子是 `removeSelfOverlap` 上面那段解释 A* 状态空间为什么会产生"多凸出一格再掉头"伪影，以及 `computePath` 里为什么**不能**对拼接后的完整路径整体去重（这是刚踩过的坑，注释原文保留，修改这块逻辑前务必先读懂这条注释）。
- 每个"点击优先级""解析规则"类的函数（如 `resolveFreeStartClick`、`resolveFreeEndClick`，传送带/管道共用同一份实现、靠 `BELT_UI`/`PIPE_UI` 描述符区分，见 `interactions.js` 顶部的说明）都在函数上方用编号列表写清楚判定顺序。新增新的点击/命中判定分支时，同步更新这个列表，保持顺序描述和代码分支顺序一致。

### A* 寻路代价值规则（重要，改动前必读）
寻路核心是 `aStarOrthogonal(startCol, startRow, startDir, goalCol, goalRow, goalDir, blocked, beltOccupancy)`，状态空间是 `(col, row, dir)` 三元组，`dir` 表示"到达这一格时的移动方向"：

- **转弯代价**：直行 `stepCost = 1`；方向改变（含转弯和掉头）`stepCost = 1 + TURN_PENALTY`（当前 `TURN_PENALTY = 3`）。这个惩罚存在的意义是让 A* 优先选择"能走直线就不拐弯"的路径，视觉上更像真实传送带布局。**修改 `TURN_PENALTY` 或代价公式时，必须保证直行路径的总代价始终严格小于任何绕路/掉头方案**，否则会出现明明能走直线却绕远路的诡异路径。
- **终点"笔直接入"不是唯一允许的到达方式，只是其中一种**：`goalDir` 非空时，A* 在终点格既接受"沿 goalDir 笔直进入"，也接受"以其它方向拐进终点格、最后半格再贴边对接端口"（对接这半格线段的朝向由端口位置本身决定，与进入终点格的方向无关，视觉上入口依旧笔直，只是路径提前在终点格拐了个弯）——后者唯一的限制是终点格不能已被别的传送带占用（和普通转弯"落脚格必须空闲"的规则一致）。两种方式都会被同一次 A* 搜索探索到，堆按 f 值弹出保证第一个满足条件的终点状态就是代价最小的那个，因此**不需要**先跑一遍严格寻路、失败了再退化成宽松版本这种两阶段结构——两台设备紧邻、端口朝向刚好错开一格时，"贴边拐入"往往比"绕一圈笔直接入"省好几格，A* 会自动选它（详见 `aStarOrthogonal` 函数上方注释；这是改过的真实行为：早期版本只把"贴边拐入"当作严格寻路失败时的兜底，导致这类场景会绕出多余的直角弯）。
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
- 新增一种设备"kind"（目前有 `merger`/`splitter`/`pipe-merger`/`pipe-splitter` 这四种 1×1 节点，以及 `facility`——真实基建设备统一用这个 kind，是 `getDevicePorts()` 的默认/兜底分支，具体是哪个设备由落地时一并拷贝到实例上的 `facilityId`/`ports` 决定，不是靠 kind 本身区分）时，端口计算要在 `getDevicePorts()` 里按 `kind` 分派，不要在别处对 `kind` 做散落的 if 判断。`facility` 的端口计算（`facilityDevicePorts()`）额外要处理旋转：`dev.ports` 存的是未旋转坐标系下的显式 `(grid, dir)`，按 `dev.rot` 绕设备中心旋转（非正方形设备旋转奇数次会令 `dev.w`/`dev.h` 互换，`interactions.js` 的旋转键处理里已经统一做了这个互换，对正方形设备是无意义的等价互换，不需要按 kind 特判）。（历史遗留提醒：早期 demo 用过 `crusher`(kind 缺省)/`reactor` 这两种 kind，对应的 `edgePorts`/`reactorDevicePorts`/`REACTOR_PORT_LAYOUT`/`REACTOR_BASE_ROLES`/`PORT_COUNT` 在真实数据接入并删除 demo 模板后已整体删除，不要再假设这些符号存在。）
- **汇流器/分流器（含管道版）可以像真实基建设备一样从工具栏直接拖拽生成空节点**，不再要求必须先 Alt+点击一条已有连线"切入"生成。两种生成路径落地后的设备数据结构完全同构（1×1、`mainInEdge`/`mainOutEdge` 决定哪条边固定是入/出口，其余边留给用户在自由传送带/管道模式里逐条连接），因此可以直接对接任意设备的端口，不再依赖"先有一条现成连线可切"这个前提；工具栏生成的空节点默认朝向 `mainOutEdge=DIR_S`（汇流器）/`mainInEdge=DIR_N`（分流器），支持 `R` 键旋转（`interactions.js` 的旋转键处理按 `kind` 分派：`facility` 走 `dev.rot`+`w`/`h` 互换，这四种节点直接把 `mainOutEdge`/`mainInEdge` 顺时针 +1）。工具栏图标文字（`template.label`，如"汇流器"）和落地后画布上的短标签（`template.deviceLabel`，即"汇"/"分"，见 `devices.js` 的 `NODE_LABEL`）是两个字段：前者要能在传送带版/管道版之间区分，后者要维持和 `splitConnectionAtCell` 生成的节点一致的极简视觉。
- **"顺手弄坏一条别的、操作前还合法的连线"这条安全网，只保留在两处"生成新连线/新节点"的操作上**（用户已确认收窄范围，历史上这条规则曾经覆盖更多操作点，见下方说明）：`finalizeFreeConnection()`（自由传送带/管道画新线落地）和 `createSplitterAtClick()`（Alt+点击已有连线生成汇流器/分流器）。这两处在改动生效、`recomputeAllFlows()` 跑完之后，用 `brokeExistingValidConnection(beforeSnapshot, network, excludeIds)` 检查这一步是否把某条操作前合法的连线拖成 `invalid`，一旦是就用 `revertLastHistoryStep()` 整体撤销、不留 Ctrl+Z 记录。
- **框选批量拖拽/框选批量旋转/Ctrl+V 粘贴/单设备拖拽/单设备旋转（R 键）/工具栏落地新设备这 6 处放置类操作，不再有这层安全网，也不会因为越界而撤回**（用户已确认：这 6 处操作永远成功、留在原地，不管是弄坏了别的合法连线还是把受边界约束的设备摆到了地图外）。弄坏的连线自然显示成已有的红色 `invalid` 状态（`recomputeAllFlows()`/`computePath()` 本来就会重算），受边界约束的设备（核心/传送带版汇流器分流器/仓库存取线源桩与基段，见 `devices.js` 的 `requiresMapBounds()`）越界则复用"设备重叠"同一套半透明红色覆盖+红描边警示（`devices.js` 的 `computeOutOfBoundsIds()`，`render.js` 的 `drawDevices()` 里和 `collidingIds`/`groundConflict` 合并进同一个 `colliding` 标记）。新增这 6 类操作的同类变体时，同样只需要 `pushHistory()`（Ctrl+Z 要用）+ 正常执行 + `recomputeAllFlows()`，不需要再补 `brokeExistingValidConnection`/`revertLastHistoryStep`/越界检查。
- **管道系统（管道连线寻路 + 管道版汇流器/分流器）完全豁免地图边界**，只有传送带（寻路 + 传送带版汇流器/分流器）仍然受边界约束：`pathfinding.js` 的 `aStarOrthogonal`/`pickBestPort`/`computePath` 都带一个 `network = BELT_NETWORK` 参数，管道网络（`network.kind === 'pipe'`）直接跳过越界拒绝（和 `buildBlockedSet` 豁免管道跨越矮桩体设备是同一种"按网络分支"写法）；`interactions.js` 的 `BELT_UI`/`PIPE_UI` 描述符各带一个 `enforceMapBounds` 字段（belt=true/pipe=false），`resolveFreeStartClick`/`resolveFreeEndClick` 点击地图外空白格子的拒绝提示只在 `enforceMapBounds` 为真时触发。

### 配方 + 物品槽位系统（预览阶段，设计还没最终定稿）

右键一个有槽位数据的设备弹出居中浮层槽位面板，点槽位从屏幕右侧滑出物品选择抽屉。面板布局是原料在左、产物在右两栏，中间一个箭头，不写"固体/流体"或"输入/输出"文字——槽位形状本身（方形直角=固体、圆形=流体，和游戏一致）+ 位置（箭头左/右）已经说清楚了。数据来自 `reference/items_recipes_template.xlsx`（人工核对进度见该文件/`reference/README.md`），转成 `src/data/items.js`/`src/data/recipes.js` + `facilities.js` 的 `slots` 字段接入。这一节记的是当前**已经写代码实现**的部分和**明确还没做**的部分，避免后续改动时误以为某个能力已经存在：

- **已实现**：
  - `'recipe'` 模式——原料/产物哪个先选都行，双向对称收紧（`recipeSlots.js` 的 `isRecipeViable`：已选原料 ⊆ 配方需求 且 已选产物 ⊆ 配方产出，两个方向同一个判定，不像早期版本那样只能"先选原料"）。`computeSlotCandidates(facilityId, slotValues, group)` 是原料槽位/产物槽位共用的唯一一个候选计算函数，不再分 `computeInputCandidates`/`computeOutputCandidates` 两个函数。
  - **收紧到唯一解自动填入**（不需要用户再手动点）：`normalizeSlotValues()` 每次槽位变化后跑一轮收敛，包含三步——`pruneInvalidSelections`（清掉不再合法的旧选择）、`autoFillFromSingleRecipe`（如果当前只剩一种配方仍然可行，直接把它还缺的原料/产物按 portType 塞进对应槽位组里空着的位置，解决"槽位组候选并集有 2 个但配方本身就位数刚好等于 2"这种 `autoFillSingletons` 单靠"候选并集只剩 1 个"判断不出来的情况）、`autoFillSingletons`（槽位组候选并集只剩 1 个物品时直接填上）。三者循环到一整轮都没变化为止（轮数上限 50 只是防御性安全阀）。一次用户操作触发的整条级联算一次 `pushHistory()`，Ctrl+Z 一次性撤销整条级联，不会拆成好几步。
  - `'port'` 模式——槽位就是端口本身，自由选同 portType 物品，不做收紧。除了暗管入口/出口、多口暗管、仓库存货口/取货口、储液罐/储气罐之外，气体散布机（任意气体）、废水处理机（任意流体）、热能池（任意固体，但只有源矿/原木/各类电池是真燃料，放别的东西会触发 `devices.js` 的 `HEAT_POOL_FUEL_ITEM_IDS` 警告）也是这个模式——这三个设备没有真实配方数据，"随便接什么"本来就是它们的定位，槽位数直接取自 `ports` 数量，不需要额外维护槽位计数。**协议核心/次级核心不在 `PORT_ITEM_FACILITY_IDS` 里**——核心端口一多，槽位面板显示很乱，用户已确认暂时不需要，右键核心走浏览器默认菜单，不弹任何面板。
  - 两种模式共用同一个右键入口，槽位数据挂在 `dev.slotValues`/`dev.portItems` 上随设备一起进 `cloneCanvasState()` 的深拷贝，Ctrl+Z/框选批量拖拽/Ctrl+V 复制不需要额外处理。抽屉的"清空全部"/单槽位"×"两种粒度的撤销机制、Esc 分层关闭（先关抽屉再关面板）都已接入；重新点开一个已经填过的槽位时，`interactions.js` 的 `currentPickerCandidateIds` 会先把这个槽位自己的当前值临时置空再算候选，否则它自己的值会被当成"已选"从候选列表里排除掉（这是改双向收紧时踩过的真实 bug，修过了）。
- **明确还没做**（不要假设这些已经存在）：
  - **反应池/扩容反应池的共享槽位设计**（`facilities.js` 里 `slots.sharedPool: true` 那两条记录）——右键只显示一条"暂未支持"的提示，不接入配方匹配。是否要按方向拆分配方集合、共享池具体怎么建模，还没和用户定下来。
  - **惰气/酸气环境覆盖判定**——`recipes.js` 里 `environmentCondition` 字段目前只是原样保留的文字，没有任何代码判定。设计方向是复用 `devices.js` 的供电覆盖判定代码结构（`computePowerRangeRects`/`computeUnpoweredIds`），差异是"完全覆盖才算满足"（供电范围是"部分覆盖即通电"），未满足时复用现有"未通电"警告图标框架，浮窗文案"气体环境未满足"——但这些都还没写代码。
  - **固气/液气转化机的"催化剂"槽位**（额外接一路被消耗的液化息壤/息壤气，UI 上要单独给一个槽位展示）——同样还没接代码，未接入时的警告文案设想是"未接入液化息壤/息壤气"，复用同一套警告图标框架。
  - **物品图标**——`interactions.js` 的 `renderItemPickerGrid()`/槽位按钮已经按 `/icons/items/{item_id}.webp` 路径接好了 `<img>` + `onerror` 兜底（换成中文名前两个字），但 `public/icons/items/` 目录本身还没有真正的图标文件（见该目录的 `README.md`），抓取脚本待用户在畅通网络环境下跑。
  - **速率计算**——`recipes.js` 的 `baseTime` 字段、xlsx 里出现的流速门槛（"至少 X 单位/min"）都只是数据，本期明确不接入任何判定，包括上面"催化剂"槽位是否满足，也只按"有没有接对应物品"这个布尔值判断，不核实具体流速数字。

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
