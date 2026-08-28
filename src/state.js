// ---- DOM 元素引用 ----
export const canvas = document.getElementById('canvas');
export const ctx = canvas.getContext('2d');
export const toolbar = document.getElementById('toolbar');
export const toolbarTabs = document.getElementById('toolbar-tabs');
export const toolbarIcons = document.getElementById('toolbar-icons');
export const hintEl = document.getElementById('hint');
export const powerSummaryEl = document.getElementById('power-summary');
export const mapSelectEl = document.getElementById('map-select');
export const mapConfirmOverlayEl = document.getElementById('map-confirm-overlay');
export const mapConfirmMessageEl = document.getElementById('map-confirm-message');
export const mapConfirmCancelEl = document.getElementById('map-confirm-cancel');
export const mapConfirmOkEl = document.getElementById('map-confirm-ok');

// ---- 全局可变状态 ----
// 拆分成模块后，ES Module 的 import 绑定是只读的：别的模块不能对 import 进来的
// 变量重新赋值，所以原来"IIFE 内一个个顶层 let"的写法没法照搬到多文件场景。
// 这里改用一个共享的可变 state 对象承载所有原本的顶层 let，各模块统一通过
// `state.xxx = ...` 读写，语义和原来的扁平 let 完全等价，只是多了一层容器，
// 这是 project_status.md 重构建议里提到的可选方案，在拆模块这个场景下是必须的。
export const state = {
  // 世界坐标系参数(相机)
  scale: 0.6,
  offsetX: 0,
  offsetY: 0,

  // ---- 设备数据 ----
  // devices: { id, gridX, gridY, w, h, color, borderColor, label, kind }
  // kind='facility' 是真实基建设备(占绝大多数)，额外带 facilityId(对应
  // facilities.js 里的设备 id)和 ports(落地时从模板拷贝下来的原始端口数据，
  // 见 devices.js 的 facilityDevicePorts)；'merger'/'splitter'(含 pipe- 前缀
  // 版本)为 1x1 节点，分别额外带 mainOutEdge / mainInEdge(见 nodeDevicePorts)。
  devices: [],
  nextId: 1,

  selectedId: null,

  // ---- 传送带连线数据 ----
  // connections: { id, fromDeviceId, fromPort, fromCell, toDeviceId, toPort, toCell,
  //                waypoints, points:[{x,y}], cellPath, startDir, goalDir, invalid }
  // 起止端点二选一：fromDeviceId/fromPort 绑定某设备端口时 fromCell 为 null；
  // 否则 fromCell={col,row} 表示不属于任何设备的自由网格端点。toDeviceId/toCell 同理。
  connections: [],
  nextConnId: 1,
  selectedConnectionId: null,

  // ---- 管道连线数据(与 connections 结构完全一致的平行网络) ----
  // 管道是空中单位，可以自由与传送带同格重叠/交叉，但不能穿越设备footprint，
  // 也不能与另一条管道同朝向重叠；用独立数组而不是在 connections 里加 type
  // 字段，避免所有现有遍历都要加过滤条件(见 pathfinding.js 的 BELT_NETWORK/PIPE_NETWORK)。
  pipeConnections: [],
  nextPipeConnId: 1,
  selectedPipeConnectionId: null,

  // ---- 自由传送带模式(E 键切换)：先点起点 A，移动鼠标实时预览，再点终点 B 落地 ----
  // 放置传送带(含自动汇流/分流)只能在此模式下进行；普通模式只能操作设备、
  // 或删除/拖拽移动已经放好的传送带(选中整条连线、拖拽途经点)。
  freeBeltMode: false,
  // freeBeltStart 的 kind: 'port'(绑定某设备已知端口) | 'free'(自由网格) |
  // 'anyOutput'(绑定某设备，但具体走哪个空闲输出口留到落地时按最短路自动挑选，
  // 用于分流器新分支的起点)
  // 'free' kind 命中某条已有连线悬空的 toCell 时会额外带 continuesConn(该连线
  // 对象引用)，供 finalizeFreeConnection 落地时把新画的这一笔并入这条连线本身
  // (同一个 id)，而不是新建一条坐标重合的独立连线；生命周期完全跟随 freeBeltStart
  // 本身(模式切换/撤销清空 freeBeltStart 时一并失效)，不需要单独的重置点。
  freeBeltStart: null,
  freeBeltPreviewPts: null, // 实时预览折线(世界坐标点数组)，随鼠标移动重算
  freeBeltHoverDeviceId: null, // 悬停在某设备本体(非精确端口)上时高亮该设备

  // ---- 自由管道模式(Q 键切换)：与 freeBeltMode 同构，且与之互斥(进入一个要清空另一个) ----
  freePipeMode: false,
  freePipeStart: null, // 同 freeBeltStart 的 kind 结构
  freePipePreviewPts: null,
  freePipeHoverDeviceId: null,

  // ---- 框选批量操作：普通模式下随时可用的多选机制，不是一个需要切换进入/退出
  // 的独立工具模式(早期版本用 X 键切换专属"框选模式"，长按已选中项才能触发批量
  // 拖动，实际用起来手感很别扭——按住 Ctrl 拖出矩形是唯一的框选入口，选中之后
  // 直接按住拖拽已选中项就能整体移动，不需要等长按计时器，改动详见
  // interactions.js 里 Ctrl+mousedown 分支和 boxSelectPointerDown 的说明)。
  // 仍然和 freeBeltMode/freePipeMode 互斥：进入这两个画线工具会清空当前多选
  // (见 interactions.js 的 E/Q 键入口分支)。

  // 当前框选批量选中的设备/传送带连线/管道连线 id 集合。这是独立于普通模式下
  // selectedId/selectedConnectionId/selectedPipeConnectionId(单选)的第二套选中
  // 机制，两者可以共存(渲染上复用同一套"选中态"黄色高亮，见 render.js)；点击
  // 框选集合之外的任何东西会清空这套多选集合，退回普通单选。
  boxSelectedDeviceIds: new Set(),
  boxSelectedConnectionIds: new Set(),
  boxSelectedPipeConnectionIds: new Set(),

  // 鼠标按下时的候选态：只在按下的位置命中"已经在框选集合里"的设备/连线时才会
  // 记录，用于区分"松手前不再移动=点击切换选中"和"按下后移动=立即整体拖动"
  // 二选一，具体是哪种要等 mousemove 越过阈值或 mouseup 才能确定。命中不在框选
  // 集合内的目标(或空白处)不走这套候选态，直接按普通单选/拖拽/平移处理。
  boxSelectPointerDown: null, // { downX, downY, downWorldX, downWorldY, hitKind: 'device'|'belt'|'pipe', hitId }

  // 正在拖拽中的框选矩形(世界坐标，起止点未做 min/max 归一化，渲染/命中判定
  // 时现算)。只能由按住 Ctrl 拖动鼠标触发(mousedown 时立即以按下点为起止点建
  // 好，随 mousemove 更新)，mouseup 时用它和设备/连线做相交测试，整体替换(不是
  // 叠加)当前选中集合。
  boxSelectMarquee: null, // { startWX, startWY, curWX, curWY }

  // 批量拖动(长按已选中项触发)状态。origin 记录参与移动的每个设备开始拖动前
  // 的格坐标(devices.js 的 effectiveGridPos() 据此叠加 deltaCol/Row 实时计算
  // 显示位置，和 draggingDeviceId 单设备版本对称)；connOrigin 记录"和这次移动
  // 有关"的每条连线(见 interactions.js computeBoxDragAffectedConnIds 的取舍
  // 规则)开始拖动前的 fromCell/toCell/waypoints，供每帧从原始值重算(而非增量
  // 累加)平移后的新值，避免累积误差；deltaCol/Row 是当前整体格偏移(刚体平移，
  // 所有设备/连线共用同一个偏移，不各自独立吸附，否则相对位置会走样)。
  boxDragOrigin: null, // Map<deviceId, {gridX, gridY}>
  boxDragConnOrigin: null, // Map<connId, {network:'belt'|'pipe', fromCell, toCell, waypoints}>
  boxDragDeltaCol: 0,
  boxDragDeltaRow: 0,

  // 复制/粘贴剪贴板：Ctrl+C 时从当前选中的设备/连线深拷贝一份(不受后续编辑
  // 影响，语义上是真正的"剪贴板"，因此不受 undo()/退出框选模式的三点重置规则
  // 约束——和 activeToolbarCategory 同理，是"持久化到下次替换为止"的状态，不是
  // "进行到一半会被打断"的交互态)。anchorCol/Row 记录复制时选中设备整体包围盒
  // 左上角(格坐标)，粘贴预览据此换算成"当前悬停格 - anchor"的整体偏移，保持
  // 设备间相对位置不变。连线只保留两端(如果绑定了设备)都在被复制设备集合内的
  // 那些，落盘前已清空 points/cellPath/startDir/goalDir/invalid 等寻路衍生字段
  // (粘贴落地后统一用 computePath 重新算，不照抄复制时的几何，和其它任何新建
  // 连线的约定一致)。
  clipboard: null, // { devices, connections, pipeConnections, anchorCol, anchorRow }

  // 当前是否有一次粘贴正在"跟随鼠标悬停预览、等待左键落地/右键或 Esc 取消"。
  // pastePreview 只存悬停锚点格坐标，render.js 据此和 state.clipboard 联合现算
  // 每个待粘贴设备的实际预览位置，不额外存一份"已换算"的副本(单一数据源)。
  pastePending: false,
  pastePreview: null, // { originCol, originRow }

  // ---- 手动调整传送带路径(途经点)的状态 ----
  draggingWaypoint: null, // { connId, index, originalCell }：originalCell 为 null 表示这是本次拖拽
  // 才新插入的途经点(松手时若路径无效应整体移除)，否则是拖拽开始前该途经点的 {col,row}(松手时若路径无效应还原到这个值)
  pendingWaypointCreate: null, // { connId, segmentIndex, downX, downY }：按下但未确认是否为拖拽

  // ---- 手动调整管道路径(途经点)的状态，结构镜像上面的传送带版 ----
  draggingPipeWaypoint: null,
  pendingPipeWaypointCreate: null,

  // ---- 普通模式下拖拽已有传送带的输入端重新接线 ----
  endpointDrag: null, // { connId, originalToDeviceId, originalToPort }

  // ---- 普通模式下拖拽已有管道的输入端重新接线，结构镜像上面的传送带版 ----
  pipeEndpointDrag: null,

  // ---- 输出口拖拽改接(上面 endpointDrag/pipeEndpointDrag 的对称版本)：按住
  // 一条连线已接好的输出口，可以把这段线的起点(fromDeviceId/fromPort)改接到
  // 别的输出口，逻辑完全镜像，只是操作 from 端而不是 to 端。
  outputEndpointDrag: null, // { connId, originalFromDeviceId, originalFromPort }
  pipeOutputEndpointDrag: null,

  // ---- 同一格重叠时管道/传送带的点击优先级循环记忆 ----
  // { col, row, preferred: 'pipe'|'belt' }：记录上一次在这一格点击选中的是哪一层，
  // 同一格再次点击时切换到另一层；点击别的格子时清空、重新从"管道优先"开始。
  lastConduitClickCell: null,

  // ---- 光标旁的轻量提示(如"无法选择输入口作为起点") ----
  cursorTooltip: null, // { text, x, y, until }

  // ---- 设备警告图标(如"未通电")的悬停提示 ----
  // { deviceId, text } | null，鼠标悬停在某个设备的警告图标上时设置，随鼠标
  // 移动持续刷新，图标本身的位置由 devices.js 的 getWarningIconWorldPos 按
  // deviceId 现算，不是 cursorTooltip 那种到点自动消失的一次性通知。
  hoveredWarningId: null,

  // ---- 普通模式下悬停在"已连接、可拖拽改接"的端口(输入口或输出口)上时的
  // 高亮(见 render.js 的 drawPortMarker portState 参数 / interactions.js 的
  // Endpoint Re-attach，输入输出两侧现在都支持拖拽改接)。只在空闲 mousemove
  // 时计算(和 hoveredWarningId 同一个判定分支)，光标同时从抓手('grab')改
  // 普通指针('default')，和"悬停在设备本体上可整体拖动"区分开。
  hoveredPort: null, // { deviceId, index, portKind, portType: 'input'|'output' } | null

  // ---- 正在拖拽一段连线(端口改接，或自由传送带/管道模式画新线)时，鼠标
  // 当前划过的候选目标端口——纯粹的落点预览，和 hoveredPort 是两个概念(见
  // drawPortMarker 的 portState 参数)，理论上不会同时非空。
  dragTargetPort: null, // { deviceId, index, portKind, portType } | null

  // ---- 撤销历史(Ctrl+Z / Cmd+Z)：每次修改画布数据的操作前保存一份快照 ----
  history: [],

  // ---- 画布内交互状态 ----
  isPanning: false,
  lastMouseX: 0,
  lastMouseY: 0,

  draggingDeviceId: null,
  dragOffsetWX: 0,
  dragOffsetWY: 0,
  dragDeviceWX: 0, // 拖拽中设备左上角的实时(已吸附)世界坐标
  dragDeviceWY: 0,

  // ---- 从工具栏拖拽生成新设备的状态 ----
  spawning: false,
  spawnPreview: null, // { gridX, gridY, w, h } 悬停在画布上时的吸附预览
  spawningTemplateKey: null, // 当前正在拖拽生成的是 SPAWN_TEMPLATES 里哪一个模板(key)
  // 落地前允许用 R 键预旋转：累计顺时针 90° 步数(0~3)，落地时读取应用到新
  // 设备的 rot(facility)或 mainOutEdge/mainInEdge(汇流器/分流器)上，和已放置
  // 设备的 R 键旋转是同一套朝向编号(见 devices.js 的 getSpawnOrientedFields)。
  // 每次从工具栏重新开始拖拽新设备(mousedown)时归零。
  spawnRotSteps: 0,
  // 拖拽生成新设备期间持续跟随更新的鼠标屏幕坐标：keydown 事件本身不带鼠标
  // 坐标，R 键旋转后要用它重新计算幽灵图标尺寸/落地预览吸附位置(两者都依赖
  // "鼠标当前指向哪"，而不是旋转动作本身提供的信息)。
  spawnPointerX: 0,
  spawnPointerY: 0,

  // ---- 工具栏当前选中的分类标签页(纯 UI 导航状态) ----
  // 取值是 facilities.js 分类中文名之一，由 interactions.js 的 buildToolbarUI()
  // 在生成标签页时初始化为第一个分类。这是持久化的 UI 选择状态(和 scale/
  // offsetX/offsetY 摄像机状态同类)，不是"进行到一半会被打断"的交互态，
  // 所以不需要在 undo()/E 键切换自由传送带模式/鼠标收尾逻辑这三处重置——
  // 撤销画布数据、切换画线模式都不应该把用户正在看的工具栏标签页跳走。
  activeToolbarCategory: null,

  // ---- H 键切换：显示/隐藏所有供电桩/中继器的供电覆盖范围叠层 ----
  // 和 activeToolbarCategory 同类的持久化视图开关，不是"进行到一半会被打断"
  // 的交互态，同样不需要在 undo()/E 键切换自由传送带模式/鼠标收尾逻辑这三处
  // 重置。
  showPowerRanges: false,

  // ---- 当前地图(尺寸 + 固定核心)：和 activeToolbarCategory/showPowerRanges
  // 同类的持久化配置状态，不是"进行到一半会被打断"的交互态，因此不在
  // undo()/E 键切换画线模式/鼠标收尾逻辑这三处重置。地图矩形固定锚定在网格
  // 原点(左上角格 (0,0)，右下角格 (mapWidthCells, mapHeightCells))，边界判定
  // (mapBounds.js)、初始核心摆放(interactions.js 的 placeCoreDevice)、寻路
  // 阻挡(pathfinding.js 的 aStarOrthogonal)都基于这个约定，不支持任意偏移的
  // 地图原点。
  mapId: null,          // data/maps.js MAP_CATALOG 里的地图 id，main.js 启动时引导设为默认地图
  mapWidthCells: 0,
  mapHeightCells: 0,
  coreDeviceId: null,   // 当前地图固定核心在 state.devices 里的实例 id

  // ---- 地图切换二次确认浮层(替代原生 window.confirm()，见 interactions.js 的
  // showMapConfirmModal/hideMapConfirmModal)：待确认时记录目标地图，供"确定
  // 切换"按钮读取。和 pastePending 同类——"进行到一半、等待用户点按钮决定"的
  // 瞬时交互态，undo() 里一并重置。
  mapConfirmPending: null // { mapDef } | null
};
