// ---- 设备数据模型、端口计算、碰撞检测 ----
import { GRID_SIZE, PORT_COUNT, DIR_E, DIR_S, DIR_W, DIR_N, DIR_VECT, ALL_DIRS, REACTOR_PORT_LAYOUT, REACTOR_BASE_ROLES } from './constants.js';
import { state } from './state.js';
import { worldToScreen } from './coords.js';
import { FACILITIES } from './data/facilities.js';

// ---- 工具栏拖拽生成新设备的模板注册表 ----
// key 对应工具栏图标/state.spawningTemplateKey。所有设备统一白底黑边(工业风)，
// 不再用颜色区分设备种类，靠标签文字 + 占地大小分辨(见 render.js drawDeviceRect
// 的字体规则)。
// 由 FACILITIES(src/data/facilities.js 的真实基建数据)在模块加载时计算生成，
// 不再手写——这是一层"薄适配层"，只把 facilities.js 的 footprint/ports 字段
// 换成工具栏/渲染需要的 w/h/color/kind 等字段，真实数值自始至终只在
// facilities.js 里维护一份，这里不允许出现第二份手抄的设备数值表。
// category 是 facilities.js 的中文分类名，工具栏据此把图标分到对应标签页。
export const SPAWN_TEMPLATES = Object.entries(FACILITIES).flatMap(([category, list]) =>
  list.map(f => ({
    key: f.id,
    kind: 'facility',
    category,
    w: f.footprint.w,
    h: f.footprint.h,
    color: '#ffffff',
    borderColor: '#111111',
    label: f.name,
    ports: f.ports
  }))
);

export function getDeviceRectWorld(gridX, gridY, w, h) {
  return { x: gridX * GRID_SIZE, y: gridY * GRID_SIZE, w: w * GRID_SIZE, h: h * GRID_SIZE };
}

// 获取某设备当前的"有效"网格位置(若正在被拖拽则用拖拽中的实时位置)
export function effectiveGridPos(dev) {
  if (dev.id === state.draggingDeviceId) {
    return { gridX: Math.round(state.dragDeviceWX / GRID_SIZE), gridY: Math.round(state.dragDeviceWY / GRID_SIZE) };
  }
  return { gridX: dev.gridX, gridY: dev.gridY };
}

export function rectsOverlap(a, b) {
  return !(a.gridX + a.w <= b.gridX || b.gridX + b.w <= a.gridX ||
           a.gridY + a.h <= b.gridY || b.gridY + b.h <= a.gridY);
}

// 计算当前所有设备中互相重叠(碰撞)的设备 id 集合
export function computeCollidingIds() {
  const colliding = new Set();
  const rects = state.devices.map(d => {
    const pos = effectiveGridPos(d);
    return { id: d.id, gridX: pos.gridX, gridY: pos.gridY, w: d.w, h: d.h };
  });
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      if (rectsOverlap(rects[i], rects[j])) {
        colliding.add(rects[i].id);
        colliding.add(rects[j].id);
      }
    }
  }
  return colliding;
}

export function hitTestDevice(worldX, worldY) {
  // 从后往上(数组末尾即最上层)遍历，返回命中的设备
  for (let i = state.devices.length - 1; i >= 0; i--) {
    const dev = state.devices[i];
    const pos = effectiveGridPos(dev);
    const rect = getDeviceRectWorld(pos.gridX, pos.gridY, dev.w, dev.h);
    if (worldX >= rect.x && worldX <= rect.x + rect.w &&
        worldY >= rect.y && worldY <= rect.y + rect.h) {
      return dev;
    }
  }
  return null;
}

// ---- 端口(输入口/输出口) ----

// 设备的朝向(rot: 0~3，每次 R 键旋转 +1，代表顺时针 90°*rot)决定物料流动方向
// (flowDir，与 DIR_E/S/W/N 编号一致：0°→东，90°→南，180°→西，270°→北)。
// 输出口位于 flowDir 指向的那条边，输入口位于其正对边，两者的端口箭头都指向 flowDir。
export function flowDirOf(dev) {
  return ((dev.rot || 0) % 4 + 4) % 4;
}
export function oppositeDir(d) {
  return (d + 2) % 4;
}

// 沿设备某一条边取端口世界坐标。edge 用 DIR_E/S/W/N 表示该边朝外的方向
// (DIR_E=右边缘、DIR_S=下边缘、DIR_W=左边缘、DIR_N=上边缘)。
// dir 是该端口在寻路中使用的方向：输出口=离开设备的方向，输入口=必须笔直
// 进入的方向；每个端口都带上自己的 dir，而不是整台设备共用一个，
// 这样汇流器/分流器上分布在不同边的多个端口才能各自拥有正确的朝向。
// cellCol/cellRow 是紧贴该端口、位于设备外侧的网格单元，作为寻路的起止格。
// layout 可选：缺省时和历史行为完全一致(从偏移 0 开始连续放 min(PORT_COUNT,边长)
// 个端口)；传 {count,spacing} 时改为居中、间隔 spacing 格放置 count 个端口，
// 用于反应池"5 格边上放 2 个、间隔 1 格"这种非连续布局。
function edgePorts(dev, pos, edge, dir, layout) {
  const leftX = pos.gridX * GRID_SIZE, rightX = (pos.gridX + dev.w) * GRID_SIZE;
  const topY = pos.gridY * GRID_SIZE, bottomY = (pos.gridY + dev.h) * GRID_SIZE;
  const isVertical = edge === DIR_W || edge === DIR_E;
  const edgeLen = isVertical ? dev.h : dev.w;
  let offsets;
  if (layout) {
    const count = Math.min(layout.count, edgeLen);
    const span = (count - 1) * layout.spacing + 1;
    const margin = Math.floor((edgeLen - span) / 2);
    offsets = Array.from({ length: count }, (_, i) => margin + i * layout.spacing);
  } else {
    const count = Math.min(PORT_COUNT, edgeLen);
    offsets = Array.from({ length: count }, (_, i) => i);
  }
  const ports = [];
  if (isVertical) {
    const x = edge === DIR_W ? leftX : rightX;
    const outsideCol = edge === DIR_W ? pos.gridX - 1 : pos.gridX + dev.w;
    offsets.forEach((off, i) => {
      ports.push({ index: i, x, y: topY + (off + 0.5) * GRID_SIZE, cellCol: outsideCol, cellRow: pos.gridY + off, dir });
    });
  } else {
    const y = edge === DIR_N ? topY : bottomY;
    const outsideRow = edge === DIR_N ? pos.gridY - 1 : pos.gridY + dev.h;
    offsets.forEach((off, i) => {
      ports.push({ index: i, x: leftX + (off + 0.5) * GRID_SIZE, y, cellCol: pos.gridX + off, cellRow: outsideRow, dir });
    });
  }
  return ports;
}

// 1x1 节点(汇流器/分流器)在指定边上的单个端口。index 直接用边的方向常量
// 表示(每条边最多一个端口，天然不会冲突)，dir 是该端口寻路时使用的方向。
function singleCellPort(pos, edge, dir, index) {
  const cx = pos.gridX * GRID_SIZE + GRID_SIZE / 2, cy = pos.gridY * GRID_SIZE + GRID_SIZE / 2;
  const half = GRID_SIZE / 2;
  const vec = DIR_VECT[edge];
  return {
    index,
    x: cx + vec.dx * half,
    y: cy + vec.dy * half,
    cellCol: pos.gridX + vec.dx,
    cellRow: pos.gridY + vec.dy,
    dir
  };
}

// 汇流器(Merger)：占地 1x1，继承原传送带/管道的输出边(mainOutEdge)与流向不变，
// 其余 3 条边都可以作为输入口接入新传送带/管道(最多 3 进 1 出)。
// 分流器(Splitter)：占地 1x1，继承原传送带/管道的输入边(mainInEdge)与流向不变，
// 其余 3 条边都可以作为输出口分出新传送带/管道(最多 1 进 3 出)。
// portKind('belt'|'pipe')只决定打在每个端口上的标签，形状逻辑对两种节点完全一致
// (belt/pipe 汇流器都是"3 边输入 + 1 边输出"，分流器都是"1 边输入 + 3 边输出")。
function nodeDevicePorts(dev, pos, portKind) {
  if (dev.kind === 'merger' || dev.kind === 'pipe-merger') {
    const outEdge = dev.mainOutEdge;
    return {
      inputs: ALL_DIRS.filter(e => e !== outEdge).map(e => ({ ...singleCellPort(pos, e, oppositeDir(e), e), portKind })),
      outputs: [{ ...singleCellPort(pos, outEdge, outEdge, outEdge), portKind }]
    };
  }
  // splitter / pipe-splitter
  const inEdge = dev.mainInEdge;
  return {
    inputs: [{ ...singleCellPort(pos, inEdge, oppositeDir(inEdge), inEdge), portKind }],
    outputs: ALL_DIRS.filter(e => e !== inEdge).map(e => ({ ...singleCellPort(pos, e, e, e), portKind }))
  };
}

// 反应池(5x5)的边角色随旋转刚体转动：REACTOR_BASE_ROLES 定义 rot=0 时每条边
// 的角色(上=传送带入/下=传送带出/左=管道入/右=管道出)，旋转时四条边一起按
// (角色基准方向 + rot) % 4 转动，和粉碎机 flowDirOf 决定输出边是同一个技巧，
// 只是从 1 组角色推广到 4 组；REACTOR_BASE_ROLES 是到 ALL_DIRS 的双射，任何
// 旋转下四条边都保持两两不同，角色不会冲突。
function reactorEdgeFor(dev, role) {
  return (REACTOR_BASE_ROLES[role] + flowDirOf(dev)) % 4;
}

// 反应池：上下两条边各放 2 个传送带端口(输入/输出)，左右两条边各放 2 个管道
// 端口(输入/输出)，每条边内部"两端各留 1 格、中间留 1 格"(REACTOR_PORT_LAYOUT)。
// pipe 端口的 index 特意偏移到 belt 端口之后，让同一设备 inputs/outputs 合并
// 数组里每个 index 全局唯一——resolveConnEndpoint 是按 index 在合并数组里查
// 端口的，belt 连线和 pipe 连线各自只会用到自己那一段 index，不会查串。
function reactorDevicePorts(dev, pos) {
  const beltInEdge = reactorEdgeFor(dev, 'beltIn');
  const beltOutEdge = reactorEdgeFor(dev, 'beltOut');
  const pipeInEdge = reactorEdgeFor(dev, 'pipeIn');
  const pipeOutEdge = reactorEdgeFor(dev, 'pipeOut');

  const beltInputs = edgePorts(dev, pos, beltInEdge, oppositeDir(beltInEdge), REACTOR_PORT_LAYOUT)
    .map(p => ({ ...p, portKind: 'belt' }));
  const beltOutputs = edgePorts(dev, pos, beltOutEdge, beltOutEdge, REACTOR_PORT_LAYOUT)
    .map(p => ({ ...p, portKind: 'belt' }));
  const pipeInputs = edgePorts(dev, pos, pipeInEdge, oppositeDir(pipeInEdge), REACTOR_PORT_LAYOUT)
    .map((p, i) => ({ ...p, index: beltInputs.length + i, portKind: 'pipe' }));
  const pipeOutputs = edgePorts(dev, pos, pipeOutEdge, pipeOutEdge, REACTOR_PORT_LAYOUT)
    .map((p, i) => ({ ...p, index: beltOutputs.length + i, portKind: 'pipe' }));

  return { inputs: beltInputs.concat(pipeInputs), outputs: beltOutputs.concat(pipeOutputs) };
}

// ---- 真实基建设备(facilities.js)的显式端口 ----

// facilities.js 里 dir 是字符串(端口朝外的朝向)，转成本项目的 DIR_E/S/W/N。
const FACILITY_DIR_TO_DIR = { up: DIR_N, right: DIR_E, down: DIR_S, left: DIR_W };

// facilities.js 里 type 是 'item_input'/'item_output'/'fluid_input'/'fluid_output'，
// 前半段决定 portKind(item→belt, fluid→pipe)，后半段就是 io 本身，直接复用。
// 已对 facilities.js 全文核实过，231 个端口的 type 只有这 4 种取值，没有别的变体。
function parsePortType(type) {
  const [kindWord, ioWord] = type.split('_');
  return { portKind: kindWord === 'item' ? 'belt' : 'pipe', io: ioWord };
}

// 把 facilities.js 里"设备未旋转时"的格子坐标(col,row)和朝向 dir，绕设备中心
// 顺时针旋转 rot 个 90°，得到当前朝向下的格子坐标和朝向。baseW/baseH 是旋转前
// (rot=0 时)的宽高——footprint 不是正方形时，旋转奇数次会让宽高互换，所以
// 旋转前后的坐标系维度不一样，必须先知道原始维度才能算对。
// 方向的旋转就是简单地 (dir + rot) % 4，和 DIR_E/S/W/N 的顺时针编号、以及
// render.js 里 dir*Math.PI/2 的旋转方向完全一致。
function rotateFacilityPort(col, row, dir, baseW, baseH, rot) {
  switch (rot) {
    case 1: return { col: baseH - 1 - row, row: col, dir: (dir + 1) % 4 };
    case 2: return { col: baseW - 1 - col, row: baseH - 1 - row, dir: (dir + 2) % 4 };
    case 3: return { col: row, row: baseW - 1 - col, dir: (dir + 3) % 4 };
    default: return { col, row, dir };
  }
}

// 显式端口坐标转世界坐标，公式和 singleCellPort/edgePorts 完全一致(格子中心
// 沿朝外方向推半格到边界)，只是格子坐标是数据里显式给的，不是遍历一整条边
// 推出来的；cellCol/cellRow 同理是"沿 dir 方向再往外一格"，和 edgePorts 的
// outsideCol/outsideRow 是同一个推导(可以验证：col=0,dir=DIR_W 时退化成
// leftX/pos.gridX-1，和 edgePorts 的 W 边分支完全一样)。
function facilityCellPort(pos, col, row, dir, index, portKind) {
  const cx = (pos.gridX + col + 0.5) * GRID_SIZE;
  const cy = (pos.gridY + row + 0.5) * GRID_SIZE;
  const vec = DIR_VECT[dir];
  return {
    index,
    x: cx + vec.dx * (GRID_SIZE / 2),
    y: cy + vec.dy * (GRID_SIZE / 2),
    cellCol: pos.gridX + col + vec.dx,
    cellRow: pos.gridY + row + vec.dy,
    dir,
    portKind
  };
}

// facilities.js 真实设备的端口计算：dev.ports 是落地时从模板原样拷贝下来的
// facilities.js 端口数组(未旋转坐标系)，这里按 dev.rot 转成当前朝向下的世界坐标。
// index 分别在 inputs/outputs 数组内部从 0 计数(和其它 *DevicePorts 函数的
// 约定一致，见 reactorDevicePorts 顶部注释)，不是 dev.ports 里的原始下标。
function facilityDevicePorts(dev, pos) {
  const rot = flowDirOf(dev);
  // dev.w/dev.h 是"当前(已旋转)"的占地；rot 为奇数时它们已经是互换过的，
  // 反推回旋转前的原始宽高才能喂给 rotateFacilityPort。
  const baseW = rot % 2 === 0 ? dev.w : dev.h;
  const baseH = rot % 2 === 0 ? dev.h : dev.w;
  const inputs = [];
  const outputs = [];
  for (const p of dev.ports || []) {
    const { portKind, io } = parsePortType(p.type);
    const baseDir = FACILITY_DIR_TO_DIR[p.dir];
    const rotated = rotateFacilityPort(p.grid[0], p.grid[1], baseDir, baseW, baseH, rot);
    const list = io === 'input' ? inputs : outputs;
    list.push(facilityCellPort(pos, rotated.col, rotated.row, rotated.dir, list.length, portKind));
  }
  return { inputs, outputs };
}

export function getDevicePorts(dev, pos) {
  if (dev.kind === 'merger' || dev.kind === 'splitter') return nodeDevicePorts(dev, pos, 'belt');
  if (dev.kind === 'pipe-merger' || dev.kind === 'pipe-splitter') return nodeDevicePorts(dev, pos, 'pipe');
  if (dev.kind === 'reactor') return reactorDevicePorts(dev, pos);
  if (dev.kind === 'facility') return facilityDevicePorts(dev, pos);
  const flowDir = flowDirOf(dev);
  return {
    inputs: edgePorts(dev, pos, oppositeDir(flowDir), flowDir).map(p => ({ ...p, portKind: 'belt' })),
    outputs: edgePorts(dev, pos, flowDir, flowDir).map(p => ({ ...p, portKind: 'belt' }))
  };
}

// 端口拾取判定半径：放大到该端口所在的整个网格格子(直径一格，即半径为半格)，
// 而不是过去固定的 8px 小圆——端口视觉尺寸很小，精确点选很容易点空，放大判定
// 区域大幅提升可用性。半径要随当前缩放等比例换算成屏幕像素，否则缩小视图时
// 判定区域会显得过大、放大视图时又显得过小。
function portHitRadiusPx() {
  return (GRID_SIZE * state.scale) / 2;
}

export function findPortAt(clientX, clientY, portType, portKind = 'belt') {
  const radius = portHitRadiusPx();
  for (let i = state.devices.length - 1; i >= 0; i--) {
    const dev = state.devices[i];
    const pos = effectiveGridPos(dev);
    const ports = getDevicePorts(dev, pos);
    const list = (portType === 'output' ? ports.outputs : ports.inputs).filter(p => p.portKind === portKind);
    for (const p of list) {
      const s = worldToScreen(p.x, p.y);
      const dx = clientX - s.x, dy = clientY - s.y;
      if (dx * dx + dy * dy <= radius * radius) {
        return { deviceId: dev.id, index: p.index, x: p.x, y: p.y, cellCol: p.cellCol, cellRow: p.cellRow };
      }
    }
  }
  return null;
}

export function isOutputPortUsed(deviceId, index) {
  return state.connections.some(c => c.fromDeviceId === deviceId && c.fromPort === index);
}
export function isInputPortUsed(deviceId, index) {
  return state.connections.some(c => c.toDeviceId === deviceId && c.toPort === index);
}
export function isPipeOutputPortUsed(deviceId, index) {
  return state.pipeConnections.some(c => c.fromDeviceId === deviceId && c.fromPort === index);
}
export function isPipeInputPortUsed(deviceId, index) {
  return state.pipeConnections.some(c => c.toDeviceId === deviceId && c.toPort === index);
}
