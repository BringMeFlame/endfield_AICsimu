// ---- 设备数据模型、端口计算、碰撞检测 ----
import { GRID_SIZE, DIR_E, DIR_S, DIR_W, DIR_N, DIR_VECT, ALL_DIRS } from './constants.js';
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

// 设备的朝向：rot(0~3) 每次 R 键旋转 +1，代表绕设备中心顺时针转了 rot 个 90°。
// 汇流器/分流器不使用这个函数(朝向由被切入的原连线的边决定，见 nodeDevicePorts)；
// facilityDevicePorts 用它来把 facilities.js 里"未旋转坐标系"下的显式端口
// (grid+dir) 转到当前朝向。
export function flowDirOf(dev) {
  return ((dev.rot || 0) % 4 + 4) % 4;
}
export function oppositeDir(d) {
  return (d + 2) % 4;
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

// 显式端口坐标转世界坐标，公式和 singleCellPort 完全一致(格子中心沿朝外方向
// 推半格到边界)，只是格子坐标是数据里显式给的具体 (col,row)，不是设备中心；
// cellCol/cellRow 同理是"沿 edge 方向再往外一格"，即紧贴该端口、位于设备外侧
// 的网格单元，作为寻路的起止格。
// edge(端口朝外的边)和 dir(寻路/箭头方向)是两个不同的量，和 singleCellPort 的
// edge/dir 两参数同一个道理：位置摆放永远沿 edge(朝外)半格；但 dir 对输出口
// 等于 edge(物料沿朝外方向离开设备)，对输入口必须是 oppositeDir(edge)(物料
// 沿朝内方向进入设备)——调用方(facilityDevicePorts)已经按 io 算好这个区分，
// 这里只管照单接收，不重新推导。
function facilityCellPort(pos, col, row, edge, dir, index, portKind) {
  const cx = (pos.gridX + col + 0.5) * GRID_SIZE;
  const cy = (pos.gridY + row + 0.5) * GRID_SIZE;
  const vec = DIR_VECT[edge];
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
// index 分别在 inputs/outputs 数组内部从 0 计数(和 nodeDevicePorts 的约定一致)，
// 不是 dev.ports 里的原始下标。
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
    // 输出口沿朝外方向(edge)离开设备；输入口沿朝内方向(oppositeDir(edge))
    // 进入设备——和 nodeDevicePorts/singleCellPort 里汇流器/分流器的规则一致。
    const flowDir = io === 'input' ? oppositeDir(rotated.dir) : rotated.dir;
    list.push(facilityCellPort(pos, rotated.col, rotated.row, rotated.dir, flowDir, list.length, portKind));
  }
  return { inputs, outputs };
}

// 'facility'(真实基建设备)是唯一的默认分支，不用显式 kind 判断——除了下面
// 两种 1x1 节点，所有能从工具栏生成的设备现在都是 facility。
export function getDevicePorts(dev, pos) {
  if (dev.kind === 'merger' || dev.kind === 'splitter') return nodeDevicePorts(dev, pos, 'belt');
  if (dev.kind === 'pipe-merger' || dev.kind === 'pipe-splitter') return nodeDevicePorts(dev, pos, 'pipe');
  return facilityDevicePorts(dev, pos);
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
