// ---- 设备数据模型、端口计算、碰撞检测 ----
import { GRID_SIZE, PORT_COUNT, PORT_HIT_RADIUS, DIR_E, DIR_S, DIR_W, DIR_N, DIR_VECT, ALL_DIRS } from './constants.js';
import { state } from './state.js';
import { worldToScreen } from './coords.js';

// ---- 工具栏拖拽生成新设备的模板 ----
export const spawnTemplate = { w: 3, h: 3, color: '#ffffff', borderColor: '#111111', label: '粉碎机' };

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
function edgePorts(dev, pos, edge, dir) {
  const leftX = pos.gridX * GRID_SIZE, rightX = (pos.gridX + dev.w) * GRID_SIZE;
  const topY = pos.gridY * GRID_SIZE, bottomY = (pos.gridY + dev.h) * GRID_SIZE;
  const ports = [];
  if (edge === DIR_W || edge === DIR_E) {
    const x = edge === DIR_W ? leftX : rightX;
    const outsideCol = edge === DIR_W ? pos.gridX - 1 : pos.gridX + dev.w;
    const count = Math.min(PORT_COUNT, dev.h);
    for (let i = 0; i < count; i++) {
      ports.push({ index: i, x, y: topY + (i + 0.5) * GRID_SIZE, cellCol: outsideCol, cellRow: pos.gridY + i, dir });
    }
  } else {
    const y = edge === DIR_N ? topY : bottomY;
    const outsideRow = edge === DIR_N ? pos.gridY - 1 : pos.gridY + dev.h;
    const count = Math.min(PORT_COUNT, dev.w);
    for (let i = 0; i < count; i++) {
      ports.push({ index: i, x: leftX + (i + 0.5) * GRID_SIZE, y, cellCol: pos.gridX + i, cellRow: outsideRow, dir });
    }
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

// 汇流器(Merger)：占地 1x1，继承原传送带的输出边(mainOutEdge)与流向不变，
// 其余 3 条边都可以作为输入口接入新传送带(最多 3 进 1 出)。
// 分流器(Splitter)：占地 1x1，继承原传送带的输入边(mainInEdge)与流向不变，
// 其余 3 条边都可以作为输出口分出新传送带(最多 1 进 3 出)。
function nodeDevicePorts(dev, pos) {
  if (dev.kind === 'merger') {
    const outEdge = dev.mainOutEdge;
    return {
      inputs: ALL_DIRS.filter(e => e !== outEdge).map(e => singleCellPort(pos, e, oppositeDir(e), e)),
      outputs: [singleCellPort(pos, outEdge, outEdge, outEdge)]
    };
  }
  // splitter
  const inEdge = dev.mainInEdge;
  return {
    inputs: [singleCellPort(pos, inEdge, oppositeDir(inEdge), inEdge)],
    outputs: ALL_DIRS.filter(e => e !== inEdge).map(e => singleCellPort(pos, e, e, e))
  };
}

export function getDevicePorts(dev, pos) {
  if (dev.kind === 'merger' || dev.kind === 'splitter') return nodeDevicePorts(dev, pos);
  const flowDir = flowDirOf(dev);
  return {
    inputs: edgePorts(dev, pos, oppositeDir(flowDir), flowDir),
    outputs: edgePorts(dev, pos, flowDir, flowDir)
  };
}

export function findPortAt(clientX, clientY, portType) {
  for (let i = state.devices.length - 1; i >= 0; i--) {
    const dev = state.devices[i];
    const pos = effectiveGridPos(dev);
    const ports = getDevicePorts(dev, pos);
    const list = portType === 'output' ? ports.outputs : ports.inputs;
    for (const p of list) {
      const s = worldToScreen(p.x, p.y);
      const dx = clientX - s.x, dy = clientY - s.y;
      if (dx * dx + dy * dy <= PORT_HIT_RADIUS * PORT_HIT_RADIUS) {
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
