// ---- DOM 元素引用 ----
export const canvas = document.getElementById('canvas');
export const ctx = canvas.getContext('2d');
export const toolbar = document.getElementById('toolbar');
export const toolbarTabs = document.getElementById('toolbar-tabs');
export const toolbarIcons = document.getElementById('toolbar-icons');
export const ghostIcon = document.getElementById('ghost-icon');
export const hintEl = document.getElementById('hint');

// ---- 全局可变状态 ----
// 拆分成模块后，ES Module 的 import 绑定是只读的：别的模块不能对 import 进来的
// 变量重新赋值，所以原来"IIFE 内一个个顶层 let"的写法没法照搬到多文件场景。
// 这里改用一个共享的可变 state 对象承载所有原本的顶层 let，各模块统一通过
// `state.xxx = ...` 读写，语义和原来的扁平 let 完全等价，只是多了一层容器，
// 这是 project_status.md 重构建议里提到的可选方案，在拆模块这个场景下是必须的。
export const state = {
  // 世界坐标系参数(相机)
  scale: 1,
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

  // ---- 同一格重叠时管道/传送带的点击优先级循环记忆 ----
  // { col, row, preferred: 'pipe'|'belt' }：记录上一次在这一格点击选中的是哪一层，
  // 同一格再次点击时切换到另一层；点击别的格子时清空、重新从"管道优先"开始。
  lastConduitClickCell: null,

  // ---- 光标旁的轻量提示(如"无法选择输入口作为起点") ----
  cursorTooltip: null, // { text, x, y, until }

  // ---- 撤销历史(Ctrl+Z / Cmd+Z)：每次修改画布数据的操作前保存一份快照 ----
  history: [],

  // ---- 画布内交互状态 ----
  isPanning: false,
  lastMouseX: 0,
  lastMouseY: 0,

  draggingDeviceId: null,
  draggingDeviceBeforeSnapshot: null, // 拖拽开始前 pushHistory() 压入的那份快照,松手时用来判定/撤销"拖坏了别的合法连线"
  dragOffsetWX: 0,
  dragOffsetWY: 0,
  dragDeviceWX: 0, // 拖拽中设备左上角的实时(已吸附)世界坐标
  dragDeviceWY: 0,

  // ---- 从工具栏拖拽生成新设备的状态 ----
  spawning: false,
  spawnPreview: null, // { gridX, gridY, w, h } 悬停在画布上时的吸附预览
  spawningTemplateKey: null, // 当前正在拖拽生成的是 SPAWN_TEMPLATES 里哪一个模板(key)

  // ---- 工具栏当前选中的分类标签页(纯 UI 导航状态) ----
  // 取值是 facilities.js 分类中文名之一，由 interactions.js 的 buildToolbarUI()
  // 在生成标签页时初始化为第一个分类。这是持久化的 UI 选择状态(和 scale/
  // offsetX/offsetY 摄像机状态同类)，不是"进行到一半会被打断"的交互态，
  // 所以不需要在 undo()/E 键切换自由传送带模式/鼠标收尾逻辑这三处重置——
  // 撤销画布数据、切换画线模式都不应该把用户正在看的工具栏标签页跳走。
  activeToolbarCategory: null
};
