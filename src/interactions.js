// ---- 交互：画布内鼠标/键盘事件绑定、自由传送带/自由管道模式状态机、工具栏拖拽生成新设备 ----
import { GRID_SIZE, HINT_NORMAL, HINT_BELT, HINT_PIPE } from './constants.js';
import { state, canvas, toolbar, crusherIcon, reactorIcon, ghostIcon, hintEl } from './state.js';
import { screenToWorld, worldToCell } from './coords.js';
import {
  hitTestDevice, findPortAt, effectiveGridPos, getDevicePorts,
  isInputPortUsed, isOutputPortUsed, isPipeInputPortUsed, isPipeOutputPortUsed,
  flowDirOf, SPAWN_TEMPLATES
} from './devices.js';
import {
  buildBlockedSet, buildBeltOccupancy, buildPipeOccupancy, aStarOrthogonal, removeSelfOverlap,
  computePath, recomputeAllConnections, recomputeAllPipeConnections, recomputeAllFlows,
  hitTestConnection, hitTestPipeConnection, hitTestWaypoint, hitTestPipeWaypoint,
  waypointInsertIndex, splitConnectionAtCell, cellOrientationsOf, findConnectionAtCell,
  pickBestPort, pickNearestPortByDistance, resolveConnEndpoint, BELT_NETWORK, PIPE_NETWORK
} from './pathfinding.js';
import { draw } from './render.js';
import { pushHistory, undo, revertLastHistoryStep, brokeExistingValidConnection } from './history.js';

export function updateHintText() {
  hintEl.textContent = state.freeBeltMode ? HINT_BELT : state.freePipeMode ? HINT_PIPE : HINT_NORMAL;
  hintEl.classList.toggle('belt-mode', state.freeBeltMode);
  hintEl.classList.toggle('pipe-mode', state.freePipeMode);
}

// 光标旁的轻量提示，用于端口拉线规则被拒绝时的即时反馈，一段时间后自动消失。
function showCursorTooltip(text, clientX, clientY) {
  const until = performance.now() + 1400;
  state.cursorTooltip = { text, x: clientX, y: clientY, until };
  setTimeout(() => {
    if (state.cursorTooltip && state.cursorTooltip.until === until) {
      state.cursorTooltip = null;
      draw();
    }
  }, 1450);
}

// ---- 自由传送带模式：状态解析、实时预览与落地逻辑 ----

// 把 freeBeltStart 解析为寻路用的具体 (col,row,dir)。kind='anyOutput' 时，
// 在该设备当前空闲的输出口中，按到 (towardCol,towardRow) 代价最小挑选。
function resolveFreeBeltStartForPathing(towardCol, towardRow, blocked, beltOccupancy) {
  if (!state.freeBeltStart) return null;
  if (state.freeBeltStart.kind === 'free') return { col: state.freeBeltStart.col, row: state.freeBeltStart.row, dir: null };
  const dev = state.devices.find(d => d.id === state.freeBeltStart.deviceId);
  if (!dev) return null;
  const pos = effectiveGridPos(dev);
  if (state.freeBeltStart.kind === 'port') {
    const p = getDevicePorts(dev, pos).outputs.find(pp => pp.index === state.freeBeltStart.port);
    return p ? { col: p.cellCol, row: p.cellRow, dir: p.dir } : null;
  }
  const avail = getDevicePorts(dev, pos).outputs.filter(p => !isOutputPortUsed(dev.id, p.index));
  const best = pickBestPort(avail, towardCol, towardRow, null, true, blocked, beltOccupancy);
  return best ? { col: best.cellCol, row: best.cellRow, dir: best.dir } : null;
}

// 起点(A)点击优先级：
//  1) 精确点在某个未占用的输出口上 → 直接用该端口
//  2) 精确点在输入口上 → 严格禁止从输入口拉线，提示并取消
//  3) 点在设备本体(非精确端口)上 → 兜底，自动选离点击处最近的可用输出口
//  4) 点在已有传送带上 → 此阶段不处理(生成分流器走 Alt+点击)
//  5) 其余视为空白网格起点
function resolveFreeBeltStartClick(clientX, clientY) {
  const port = findPortAt(clientX, clientY, 'output');
  if (port) {
    if (isOutputPortUsed(port.deviceId, port.index)) return null;
    return { kind: 'port', deviceId: port.deviceId, port: port.index };
  }
  const inPort = findPortAt(clientX, clientY, 'input');
  if (inPort) {
    showCursorTooltip('无法选择输入口作为起点', clientX, clientY);
    return null;
  }
  const worldPos = screenToWorld(clientX, clientY);
  const hitDev = hitTestDevice(worldPos.x, worldPos.y);
  if (hitDev) {
    const pos = effectiveGridPos(hitDev);
    const avail = getDevicePorts(hitDev, pos).outputs.filter(p => !isOutputPortUsed(hitDev.id, p.index));
    if (avail.length === 0) return null;
    const cell = worldToCell(worldPos.x, worldPos.y);
    const best = pickNearestPortByDistance(avail, cell.col, cell.row);
    if (!best) return null;
    return { kind: 'port', deviceId: hitDev.id, port: best.index };
  }
  if (hitTestConnection(clientX, clientY)) return null;
  const cell = worldToCell(worldPos.x, worldPos.y);
  return { kind: 'free', col: cell.col, row: cell.row };
}

// 终点(B)点击优先级：
//  1) 精确点在某个未占用的输入口上 → 直接用该端口
//  2) 精确点在输出口上 → 严格禁止把输出口当终点，提示并保持预览状态(不结束画线)
//  3) 点在已有传送带上 → 触发自动汇流
//  4) 点在设备本体(非精确端口)上 → 兜底，自动选离起点 A 最近的可用输入口
//  5) 其余视为空白网格终点
function resolveFreeBeltEndClick(clientX, clientY) {
  const port = findPortAt(clientX, clientY, 'input');
  if (port) {
    if (isInputPortUsed(port.deviceId, port.index)) return null;
    return { kind: 'port', deviceId: port.deviceId, port: port.index };
  }
  const outPort = findPortAt(clientX, clientY, 'output');
  if (outPort) {
    showCursorTooltip('无法选择输出口作为终点', clientX, clientY);
    return null;
  }
  // 设备本体优先于传送带：落点若在某个已有设备(含汇流器/分流器节点)的
  // footprint 内，一律按设备本体兜底逻辑处理，避免设备正下方/内部残留的
  // 传送带线段抢先命中，导致点击已有汇流器节点添加输入时被误判为再次点击
  // 传送带本身。
  const worldPos = screenToWorld(clientX, clientY);
  const hitDev = hitTestDevice(worldPos.x, worldPos.y);
  if (hitDev) {
    const pos = effectiveGridPos(hitDev);
    const avail = getDevicePorts(hitDev, pos).inputs.filter(p => !isInputPortUsed(hitDev.id, p.index));
    if (avail.length === 0) return null;
    const blocked = buildBlockedSet();
    const beltOccupancy = buildBeltOccupancy(null);
    // 用第一个候选输入口的外侧格子(必定在设备footprint之外、不会被阻挡)作为
    // 解析起点(尤其是分流器 anyOutput 起点)时的寻路参照，而不是设备本体的
    // 原点格(那格本身就在设备footprint内部，会被当成障碍导致寻路失败)。
    const startResolved = resolveFreeBeltStartForPathing(avail[0].cellCol, avail[0].cellRow, blocked, beltOccupancy);
    const refCol = startResolved ? startResolved.col : pos.gridX;
    const refRow = startResolved ? startResolved.row : pos.gridY;
    const refDir = startResolved ? startResolved.dir : null;
    const best = pickBestPort(avail, refCol, refRow, refDir, false, blocked, beltOccupancy);
    if (!best) return null;
    return { kind: 'port', deviceId: hitDev.id, port: best.index };
  }
  const belt = hitTestConnection(clientX, clientY);
  if (belt) return { kind: 'merge', conn: belt.conn };
  const cell = worldToCell(worldPos.x, worldPos.y);
  return { kind: 'free', col: cell.col, row: cell.row };
}

// 鼠标每次移动都重算一次"起点 A → 当前悬停格"的 A* 预览路径(终点方向不限，
// 仅供预览；真正落地时才会按终点自身的方向要求精确寻路)。同时更新设备本体
// 悬停高亮：只在鼠标没有精确落在某个端口上、但落在设备本体上时高亮。
function updateFreeBeltPreview(hoverClientX, hoverClientY) {
  state.freeBeltPreviewPts = null;
  const worldPos = screenToWorld(hoverClientX, hoverClientY);
  if (!findPortAt(hoverClientX, hoverClientY, 'output') && !findPortAt(hoverClientX, hoverClientY, 'input')) {
    const hovered = hitTestDevice(worldPos.x, worldPos.y);
    state.freeBeltHoverDeviceId = hovered ? hovered.id : null;
  } else {
    state.freeBeltHoverDeviceId = null;
  }
  if (!state.freeBeltMode || !state.freeBeltStart) return;
  const hoverCell = worldToCell(worldPos.x, worldPos.y);
  const blocked = buildBlockedSet();
  const beltOccupancy = buildBeltOccupancy(null);

  const startResolved = resolveFreeBeltStartForPathing(hoverCell.col, hoverCell.row, blocked, beltOccupancy);
  if (!startResolved) return;

  const cellPath = aStarOrthogonal(startResolved.col, startResolved.row, startResolved.dir, hoverCell.col, hoverCell.row, null, blocked, beltOccupancy);
  if (!cellPath) return;
  const cleaned = removeSelfOverlap(cellPath);
  state.freeBeltPreviewPts = cleaned.map(c => ({ x: (c.col + 0.5) * GRID_SIZE, y: (c.row + 0.5) * GRID_SIZE }));
}

// 第二次点击落地：解析终点(落在既有传送带上时先插入汇流器节点)，再解析起点
// (分流器新分支时在空闲输出口中挑选最短路的一个)，最后生成正式连线。
function finalizeFreeBeltConnection(endResolved, clientX, clientY) {
  if (!state.freeBeltStart || !endResolved) return;
  pushHistory();
  const beforeSnapshot = state.history[state.history.length - 1];

  const blocked = buildBlockedSet();
  const beltOccupancy = buildBeltOccupancy(null);

  let toDeviceId = null, toPort = null, toCell = null;
  let roughTargetCol, roughTargetRow;
  let mergerNode = null;

  if (endResolved.kind === 'port') {
    toDeviceId = endResolved.deviceId;
    toPort = endResolved.port;
    const dev = state.devices.find(d => d.id === toDeviceId);
    const pos = effectiveGridPos(dev);
    const p = getDevicePorts(dev, pos).inputs.find(pp => pp.index === toPort);
    roughTargetCol = p.cellCol; roughTargetRow = p.cellRow;
  } else if (endResolved.kind === 'free') {
    toCell = { col: endResolved.col, row: endResolved.row };
    roughTargetCol = endResolved.col; roughTargetRow = endResolved.row;
  } else if (endResolved.kind === 'merge') {
    const worldPos = screenToWorld(clientX, clientY);
    const cell = worldToCell(worldPos.x, worldPos.y);
    const hostConn = endResolved.conn;
    if (!hostConn.cellPath) { state.freeBeltStart = null; state.freeBeltPreviewPts = null; draw(); return; }
    const hit = cellOrientationsOf(hostConn.cellPath, hostConn.startDir, hostConn.goalDir)
      .find(o => o.cell.col === cell.col && o.cell.row === cell.row);
    if (!hit) { state.freeBeltStart = null; state.freeBeltPreviewPts = null; draw(); return; }
    mergerNode = splitConnectionAtCell(hostConn, cell, hit.entryDir, hit.exitDir, 'merger');
    roughTargetCol = mergerNode.gridX; roughTargetRow = mergerNode.gridY;
  } else {
    return;
  }

  // ---- 解析起点 ----
  let fromDeviceId = null, fromPort = null, fromCell = null;
  if (state.freeBeltStart.kind === 'free') {
    fromCell = { col: state.freeBeltStart.col, row: state.freeBeltStart.row };
  } else if (state.freeBeltStart.kind === 'port') {
    fromDeviceId = state.freeBeltStart.deviceId;
    fromPort = state.freeBeltStart.port;
  } else if (state.freeBeltStart.kind === 'anyOutput') {
    const dev = state.devices.find(d => d.id === state.freeBeltStart.deviceId);
    if (!dev) { state.freeBeltStart = null; state.freeBeltPreviewPts = null; draw(); return; }
    const pos = effectiveGridPos(dev);
    const avail = getDevicePorts(dev, pos).outputs.filter(p => !isOutputPortUsed(dev.id, p.index));
    const best = pickBestPort(avail, roughTargetCol, roughTargetRow, null, true, blocked, beltOccupancy);
    if (!best) { state.freeBeltStart = null; state.freeBeltPreviewPts = null; draw(); return; }
    fromDeviceId = dev.id;
    fromPort = best.index;
  }

  // ---- 若终点是刚生成的汇流器，用已确定的起点方向挑选代价最小的空闲输入口 ----
  if (mergerNode) {
    const pos = effectiveGridPos(mergerNode);
    const availInputs = getDevicePorts(mergerNode, pos).inputs.filter(p => !isInputPortUsed(mergerNode.id, p.index));
    if (availInputs.length === 0) { state.freeBeltStart = null; state.freeBeltPreviewPts = null; draw(); return; }
    const startResolved = resolveConnEndpoint(fromDeviceId, fromPort, fromCell, true);
    if (!startResolved) { state.freeBeltStart = null; state.freeBeltPreviewPts = null; draw(); return; }
    const bestInput = pickBestPort(availInputs, startResolved.cellCol, startResolved.cellRow, startResolved.dir, false, blocked, beltOccupancy);
    if (!bestInput) { state.freeBeltStart = null; state.freeBeltPreviewPts = null; draw(); return; }
    toDeviceId = mergerNode.id;
    toPort = bestInput.index;
  }

  const conn = {
    id: state.nextConnId++,
    fromDeviceId, fromPort, fromCell,
    toDeviceId, toPort, toCell,
    waypoints: [], points: [], cellPath: null, startDir: null, goalDir: null, invalid: false
  };
  const res = computePath(conn);
  conn.points = res.points;
  conn.cellPath = res.cellPath;
  conn.startDir = res.startDir;
  conn.goalDir = res.goalDir;
  conn.invalid = res.invalid;
  state.connections.push(conn);
  state.selectedConnectionId = conn.id;

  state.freeBeltStart = null;
  state.freeBeltPreviewPts = null;
  recomputeAllConnections();
  // 新分支落地(尤其是终点落在既有传送带上、自动生成汇流器节点时)可能连带把
  // 某条本来正常的旧连线挤成 invalid——这条新连线自己是否 invalid 不受影响
  // (维持"画到不可达位置、留给用户后续调整"的既有行为)，但绝不能让这次操作
  // 顺手弄坏一条别的、原本合法的连线，所以整体撤销、退回操作前的状态。
  if (brokeExistingValidConnection(beforeSnapshot)) {
    revertLastHistoryStep();
    state.selectedConnectionId = null;
  }
  draw();
}

// Alt+左键点击已有传送带任意一格：原地生成分流器节点，并自动进入自由传送带
// 模式、把该节点设为起点 A(具体从哪个空闲输出口出发，留到落地时按最短路挑选)。
function createSplitterAtClick(clientX, clientY) {
  const belt = hitTestConnection(clientX, clientY);
  if (!belt) return false;
  const worldPos = screenToWorld(clientX, clientY);
  const cell = worldToCell(worldPos.x, worldPos.y);
  const hostConn = belt.conn;
  if (!hostConn.cellPath) return false;
  const hit = cellOrientationsOf(hostConn.cellPath, hostConn.startDir, hostConn.goalDir)
    .find(o => o.cell.col === cell.col && o.cell.row === cell.row);
  if (!hit) return false;
  pushHistory();
  const beforeSnapshot = state.history[state.history.length - 1];
  const splitter = splitConnectionAtCell(hostConn, cell, hit.entryDir, hit.exitDir, 'splitter');
  if (brokeExistingValidConnection(beforeSnapshot)) {
    revertLastHistoryStep();
    return false;
  }
  state.freeBeltMode = true;
  state.freeBeltStart = { kind: 'anyOutput', deviceId: splitter.id };
  state.freeBeltPreviewPts = null;
  state.selectedId = null;
  state.selectedConnectionId = null;
  updateHintText();
  return true;
}

// ---- 自由管道模式：状态解析、实时预览与落地逻辑(结构逐字镜像上面的传送带版) ----

// 把 freePipeStart 解析为寻路用的具体 (col,row,dir)，镜像 resolveFreeBeltStartForPathing。
function resolveFreePipeStartForPathing(towardCol, towardRow, blocked, pipeOccupancy) {
  if (!state.freePipeStart) return null;
  if (state.freePipeStart.kind === 'free') return { col: state.freePipeStart.col, row: state.freePipeStart.row, dir: null };
  const dev = state.devices.find(d => d.id === state.freePipeStart.deviceId);
  if (!dev) return null;
  const pos = effectiveGridPos(dev);
  if (state.freePipeStart.kind === 'port') {
    const p = getDevicePorts(dev, pos).outputs.find(pp => pp.index === state.freePipeStart.port);
    return p ? { col: p.cellCol, row: p.cellRow, dir: p.dir } : null;
  }
  const avail = getDevicePorts(dev, pos).outputs.filter(p => p.portKind === 'pipe' && !isPipeOutputPortUsed(dev.id, p.index));
  const best = pickBestPort(avail, towardCol, towardRow, null, true, blocked, pipeOccupancy);
  return best ? { col: best.cellCol, row: best.cellRow, dir: best.dir } : null;
}

// 管道起点(A)点击优先级：
//  1) 精确点在某个未占用的管道输出口上 → 直接用该端口
//  2) 精确点在管道输入口上 → 严格禁止从输入口拉线，提示并取消
//  3) 点在设备本体(非精确端口)上 → 兜底，自动选离点击处最近的可用管道输出口
//  4) 点在已有管道上 → 此阶段不处理(生成管道分流器走 Alt+点击)
//  5) 其余视为空白网格起点
function resolveFreePipeStartClick(clientX, clientY) {
  const port = findPortAt(clientX, clientY, 'output', 'pipe');
  if (port) {
    if (isPipeOutputPortUsed(port.deviceId, port.index)) return null;
    return { kind: 'port', deviceId: port.deviceId, port: port.index };
  }
  const inPort = findPortAt(clientX, clientY, 'input', 'pipe');
  if (inPort) {
    showCursorTooltip('无法选择输入口作为起点', clientX, clientY);
    return null;
  }
  const worldPos = screenToWorld(clientX, clientY);
  const hitDev = hitTestDevice(worldPos.x, worldPos.y);
  if (hitDev) {
    const pos = effectiveGridPos(hitDev);
    const avail = getDevicePorts(hitDev, pos).outputs.filter(p => p.portKind === 'pipe' && !isPipeOutputPortUsed(hitDev.id, p.index));
    if (avail.length === 0) return null;
    const cell = worldToCell(worldPos.x, worldPos.y);
    const best = pickNearestPortByDistance(avail, cell.col, cell.row);
    if (!best) return null;
    return { kind: 'port', deviceId: hitDev.id, port: best.index };
  }
  if (hitTestPipeConnection(clientX, clientY)) return null;
  const cell = worldToCell(worldPos.x, worldPos.y);
  return { kind: 'free', col: cell.col, row: cell.row };
}

// 管道终点(B)点击优先级：
//  1) 精确点在某个未占用的管道输入口上 → 直接用该端口
//  2) 精确点在管道输出口上 → 严格禁止把输出口当终点，提示并保持预览状态(不结束画线)
//  3) 点在已有管道上 → 触发自动汇流
//  4) 点在设备本体(非精确端口)上 → 兜底，自动选离起点 A 最近的可用管道输入口
//  5) 其余视为空白网格终点
function resolveFreePipeEndClick(clientX, clientY) {
  const port = findPortAt(clientX, clientY, 'input', 'pipe');
  if (port) {
    if (isPipeInputPortUsed(port.deviceId, port.index)) return null;
    return { kind: 'port', deviceId: port.deviceId, port: port.index };
  }
  const outPort = findPortAt(clientX, clientY, 'output', 'pipe');
  if (outPort) {
    showCursorTooltip('无法选择输出口作为终点', clientX, clientY);
    return null;
  }
  const worldPos = screenToWorld(clientX, clientY);
  const hitDev = hitTestDevice(worldPos.x, worldPos.y);
  if (hitDev) {
    const pos = effectiveGridPos(hitDev);
    const avail = getDevicePorts(hitDev, pos).inputs.filter(p => p.portKind === 'pipe' && !isPipeInputPortUsed(hitDev.id, p.index));
    if (avail.length === 0) return null;
    const blocked = buildBlockedSet();
    const pipeOccupancy = buildPipeOccupancy(null);
    const startResolved = resolveFreePipeStartForPathing(avail[0].cellCol, avail[0].cellRow, blocked, pipeOccupancy);
    const refCol = startResolved ? startResolved.col : pos.gridX;
    const refRow = startResolved ? startResolved.row : pos.gridY;
    const refDir = startResolved ? startResolved.dir : null;
    const best = pickBestPort(avail, refCol, refRow, refDir, false, blocked, pipeOccupancy);
    if (!best) return null;
    return { kind: 'port', deviceId: hitDev.id, port: best.index };
  }
  const pipe = hitTestPipeConnection(clientX, clientY);
  if (pipe) return { kind: 'merge', conn: pipe.conn };
  const cell = worldToCell(worldPos.x, worldPos.y);
  return { kind: 'free', col: cell.col, row: cell.row };
}

// 镜像 updateFreeBeltPreview，改用管道占用集合/管道悬停高亮字段。
function updateFreePipePreview(hoverClientX, hoverClientY) {
  state.freePipePreviewPts = null;
  const worldPos = screenToWorld(hoverClientX, hoverClientY);
  if (!findPortAt(hoverClientX, hoverClientY, 'output', 'pipe') && !findPortAt(hoverClientX, hoverClientY, 'input', 'pipe')) {
    const hovered = hitTestDevice(worldPos.x, worldPos.y);
    state.freePipeHoverDeviceId = hovered ? hovered.id : null;
  } else {
    state.freePipeHoverDeviceId = null;
  }
  if (!state.freePipeMode || !state.freePipeStart) return;
  const hoverCell = worldToCell(worldPos.x, worldPos.y);
  const blocked = buildBlockedSet();
  const pipeOccupancy = buildPipeOccupancy(null);

  const startResolved = resolveFreePipeStartForPathing(hoverCell.col, hoverCell.row, blocked, pipeOccupancy);
  if (!startResolved) return;

  const cellPath = aStarOrthogonal(startResolved.col, startResolved.row, startResolved.dir, hoverCell.col, hoverCell.row, null, blocked, pipeOccupancy);
  if (!cellPath) return;
  const cleaned = removeSelfOverlap(cellPath);
  state.freePipePreviewPts = cleaned.map(c => ({ x: (c.col + 0.5) * GRID_SIZE, y: (c.row + 0.5) * GRID_SIZE }));
}

// 探测 (col,row) 这一格地面是否已有一条合法的传送带经过——管道分流器/汇流器
// 需要架设在地面上，如果该格地面已经被传送带占用，允许放置但要显示地面冲突
// 警示(见 groundConflict)。这里始终检查传送带网络，与"当前正在处理管道分流器
// 还是管道汇流器"无关。
function groundHasBeltConflict(col, row) {
  return !!findConnectionAtCell(col, row, BELT_NETWORK);
}

// 第二次点击落地，镜像 finalizeFreeBeltConnection：解析终点(落在既有管道上时
// 先插入管道汇流器节点)，再解析起点，最后生成正式管道连线。
function finalizePipeConnection(endResolved, clientX, clientY) {
  if (!state.freePipeStart || !endResolved) return;
  pushHistory();
  const beforeSnapshot = state.history[state.history.length - 1];

  const blocked = buildBlockedSet();
  const pipeOccupancy = buildPipeOccupancy(null);

  let toDeviceId = null, toPort = null, toCell = null;
  let roughTargetCol, roughTargetRow;
  let mergerNode = null;

  if (endResolved.kind === 'port') {
    toDeviceId = endResolved.deviceId;
    toPort = endResolved.port;
    const dev = state.devices.find(d => d.id === toDeviceId);
    const pos = effectiveGridPos(dev);
    const p = getDevicePorts(dev, pos).inputs.find(pp => pp.index === toPort);
    roughTargetCol = p.cellCol; roughTargetRow = p.cellRow;
  } else if (endResolved.kind === 'free') {
    toCell = { col: endResolved.col, row: endResolved.row };
    roughTargetCol = endResolved.col; roughTargetRow = endResolved.row;
  } else if (endResolved.kind === 'merge') {
    const worldPos = screenToWorld(clientX, clientY);
    const cell = worldToCell(worldPos.x, worldPos.y);
    const hostConn = endResolved.conn;
    if (!hostConn.cellPath) { state.freePipeStart = null; state.freePipePreviewPts = null; draw(); return; }
    const hit = cellOrientationsOf(hostConn.cellPath, hostConn.startDir, hostConn.goalDir)
      .find(o => o.cell.col === cell.col && o.cell.row === cell.row);
    if (!hit) { state.freePipeStart = null; state.freePipePreviewPts = null; draw(); return; }
    const conflict = groundHasBeltConflict(cell.col, cell.row);
    mergerNode = splitConnectionAtCell(hostConn, cell, hit.entryDir, hit.exitDir, 'pipe-merger', PIPE_NETWORK);
    if (conflict) mergerNode.groundConflict = true;
    roughTargetCol = mergerNode.gridX; roughTargetRow = mergerNode.gridY;
  } else {
    return;
  }

  // ---- 解析起点 ----
  let fromDeviceId = null, fromPort = null, fromCell = null;
  if (state.freePipeStart.kind === 'free') {
    fromCell = { col: state.freePipeStart.col, row: state.freePipeStart.row };
  } else if (state.freePipeStart.kind === 'port') {
    fromDeviceId = state.freePipeStart.deviceId;
    fromPort = state.freePipeStart.port;
  } else if (state.freePipeStart.kind === 'anyOutput') {
    const dev = state.devices.find(d => d.id === state.freePipeStart.deviceId);
    if (!dev) { state.freePipeStart = null; state.freePipePreviewPts = null; draw(); return; }
    const pos = effectiveGridPos(dev);
    const avail = getDevicePorts(dev, pos).outputs.filter(p => p.portKind === 'pipe' && !isPipeOutputPortUsed(dev.id, p.index));
    const best = pickBestPort(avail, roughTargetCol, roughTargetRow, null, true, blocked, pipeOccupancy);
    if (!best) { state.freePipeStart = null; state.freePipePreviewPts = null; draw(); return; }
    fromDeviceId = dev.id;
    fromPort = best.index;
  }

  // ---- 若终点是刚生成的管道汇流器，用已确定的起点方向挑选代价最小的空闲输入口 ----
  if (mergerNode) {
    const pos = effectiveGridPos(mergerNode);
    const availInputs = getDevicePorts(mergerNode, pos).inputs.filter(p => !isPipeInputPortUsed(mergerNode.id, p.index));
    if (availInputs.length === 0) { state.freePipeStart = null; state.freePipePreviewPts = null; draw(); return; }
    const startResolved = resolveConnEndpoint(fromDeviceId, fromPort, fromCell, true);
    if (!startResolved) { state.freePipeStart = null; state.freePipePreviewPts = null; draw(); return; }
    const bestInput = pickBestPort(availInputs, startResolved.cellCol, startResolved.cellRow, startResolved.dir, false, blocked, pipeOccupancy);
    if (!bestInput) { state.freePipeStart = null; state.freePipePreviewPts = null; draw(); return; }
    toDeviceId = mergerNode.id;
    toPort = bestInput.index;
  }

  const conn = {
    id: state.nextPipeConnId++,
    fromDeviceId, fromPort, fromCell,
    toDeviceId, toPort, toCell,
    waypoints: [], points: [], cellPath: null, startDir: null, goalDir: null, invalid: false
  };
  const res = computePath(conn, PIPE_NETWORK);
  conn.points = res.points;
  conn.cellPath = res.cellPath;
  conn.startDir = res.startDir;
  conn.goalDir = res.goalDir;
  conn.invalid = res.invalid;
  state.pipeConnections.push(conn);
  state.selectedPipeConnectionId = conn.id;

  state.freePipeStart = null;
  state.freePipePreviewPts = null;
  recomputeAllPipeConnections();
  // 这里故意只检查 PIPE_NETWORK，不要加 BELT_NETWORK 检查——管道汇流器落在
  // 已有传送带地面格上是被批准的例外(见上面 groundConflict 的地面冲突警示)，
  // 允许这次操作弄坏地面传送带的路径；"不能弄坏别的合法连线"这条硬规则只在
  // 管道网络自身内部生效。
  if (brokeExistingValidConnection(beforeSnapshot, PIPE_NETWORK)) {
    revertLastHistoryStep();
    state.selectedPipeConnectionId = null;
  }
  draw();
}

// Alt+左键点击已有管道任意一格：原地生成管道分流器节点，镜像 createSplitterAtClick。
function createPipeSplitterAtClick(clientX, clientY) {
  const pipe = hitTestPipeConnection(clientX, clientY);
  if (!pipe) return false;
  const worldPos = screenToWorld(clientX, clientY);
  const cell = worldToCell(worldPos.x, worldPos.y);
  const hostConn = pipe.conn;
  if (!hostConn.cellPath) return false;
  const hit = cellOrientationsOf(hostConn.cellPath, hostConn.startDir, hostConn.goalDir)
    .find(o => o.cell.col === cell.col && o.cell.row === cell.row);
  if (!hit) return false;
  const conflict = groundHasBeltConflict(cell.col, cell.row);
  pushHistory();
  const beforeSnapshot = state.history[state.history.length - 1];
  const splitter = splitConnectionAtCell(hostConn, cell, hit.entryDir, hit.exitDir, 'pipe-splitter', PIPE_NETWORK);
  if (conflict) splitter.groundConflict = true;
  // 同上：故意只检查 PIPE_NETWORK，见 finalizePipeConnection 里的注释。
  if (brokeExistingValidConnection(beforeSnapshot, PIPE_NETWORK)) {
    revertLastHistoryStep();
    return false;
  }
  state.freePipeMode = true;
  state.freePipeStart = { kind: 'anyOutput', deviceId: splitter.id };
  state.freePipePreviewPts = null;
  state.selectedId = null;
  state.selectedPipeConnectionId = null;
  updateHintText();
  return true;
}

// ---- 普通模式下管道/传送带同格重叠的点击优先级(循环切换) ----
//  1) 只命中其中一种 → 直接用那种
//  2) 两种都命中 → 默认管道优先(视觉上方层)；若上次点击同一格选的正是管道，
//     这次点击退一层改选传送带，如此往复循环
function resolveConduitPreferred(cell, pipeHit, beltHit) {
  if (pipeHit && beltHit) {
    const cycleToBelt = state.lastConduitClickCell && state.lastConduitClickCell.col === cell.col
      && state.lastConduitClickCell.row === cell.row && state.lastConduitClickCell.preferred === 'pipe';
    const network = cycleToBelt ? 'belt' : 'pipe';
    state.lastConduitClickCell = { col: cell.col, row: cell.row, preferred: network };
    return network;
  }
  // 只有真正命中了(哪怕只命中一种)才重置循环记忆；完全没命中任何一种时(这是
  // 途经点命中判定在没有途经点场景下的常见情况)必须原样保留 lastConduitClickCell，
  // 不能顺手清空——mousedown 里会先调用一次途经点版的这个函数、再调用一次连线版
  // 的，如果这里对"什么都没命中"也清空共享状态，会在连线判定真正需要读取上一次
  // 点击记录之前就把它冲掉，导致循环切换永远卡在"管道优先"这一档，切不到传送带。
  if (pipeHit) { state.lastConduitClickCell = null; return 'pipe'; }
  if (beltHit) { state.lastConduitClickCell = null; return 'belt'; }
  return null;
}

function resolveConduitHitAt(clientX, clientY) {
  const pipeHit = hitTestConnection(clientX, clientY, PIPE_NETWORK);
  const beltHit = hitTestConnection(clientX, clientY, BELT_NETWORK);
  const worldPos = screenToWorld(clientX, clientY);
  const cell = worldToCell(worldPos.x, worldPos.y);
  const network = resolveConduitPreferred(cell, pipeHit, beltHit);
  if (network === 'pipe') return { network: 'pipe', hit: pipeHit };
  if (network === 'belt') return { network: 'belt', hit: beltHit };
  return null;
}

function resolveConduitWaypointHitAt(clientX, clientY) {
  const pipeHit = hitTestPipeWaypoint(clientX, clientY);
  const beltHit = hitTestWaypoint(clientX, clientY);
  const worldPos = screenToWorld(clientX, clientY);
  const cell = worldToCell(worldPos.x, worldPos.y);
  const network = resolveConduitPreferred(cell, pipeHit, beltHit);
  if (network === 'pipe') return { network: 'pipe', hit: pipeHit };
  if (network === 'belt') return { network: 'belt', hit: beltHit };
  return null;
}

// ---- 画布内鼠标交互：平移 / 选中 / 拖拽已有设备 ----

function bindCanvasMouseEvents() {
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 2) return; // 右键交给 contextmenu 处理(退出自由传送带模式)

    // Alt+左键点击已有传送带/管道：无论当前是否已在画线模式中，都优先生成分流器；
    // 管道是视觉上层，优先尝试生成管道分流器，否则退回生成传送带分流器。
    if (e.altKey && e.button === 0) {
      if (createPipeSplitterAtClick(e.clientX, e.clientY)) {
        draw();
        return;
      }
      if (createSplitterAtClick(e.clientX, e.clientY)) {
        draw();
        return;
      }
    }

    if (state.freeBeltMode) {
      if (e.button !== 0) return;
      if (!state.freeBeltStart) {
        const start = resolveFreeBeltStartClick(e.clientX, e.clientY);
        if (start) {
          state.freeBeltStart = start;
          updateFreeBeltPreview(e.clientX, e.clientY);
          draw();
        }
      } else {
        const end = resolveFreeBeltEndClick(e.clientX, e.clientY);
        if (end) finalizeFreeBeltConnection(end, e.clientX, e.clientY);
      }
      return;
    }

    if (state.freePipeMode) {
      if (e.button !== 0) return;
      if (!state.freePipeStart) {
        const start = resolveFreePipeStartClick(e.clientX, e.clientY);
        if (start) {
          state.freePipeStart = start;
          updateFreePipePreview(e.clientX, e.clientY);
          draw();
        }
      } else {
        const end = resolveFreePipeEndClick(e.clientX, e.clientY);
        if (end) finalizePipeConnection(end, e.clientX, e.clientY);
      }
      return;
    }

    // 普通模式下，按住已连接的输入口(传送带/管道末端箭头)可以把这段线的末端拖到
    // 该设备或画面上其它设备的另一个可用输入口上，实时重新寻路(Endpoint Re-attach)。
    // 管道口精确命中优先于传送带口(端口是 8px 半径的精确点命中，两个不同设备的
    // 端口之间几乎不会真正视觉重叠，不需要接入下面的重叠循环切换记忆)。
    const inPipePortHit = findPortAt(e.clientX, e.clientY, 'input', 'pipe');
    if (inPipePortHit && isPipeInputPortUsed(inPipePortHit.deviceId, inPipePortHit.index)) {
      const conn = state.pipeConnections.find(c => c.toDeviceId === inPipePortHit.deviceId && c.toPort === inPipePortHit.index);
      if (conn) {
        pushHistory();
        state.pipeEndpointDrag = { connId: conn.id, originalToDeviceId: conn.toDeviceId, originalToPort: conn.toPort };
        conn.toDeviceId = null;
        conn.toPort = null;
        const dropWorld = screenToWorld(e.clientX, e.clientY);
        conn.toCell = worldToCell(dropWorld.x, dropWorld.y);
        recomputeAllPipeConnections();
        state.selectedPipeConnectionId = conn.id;
        state.selectedConnectionId = null;
        state.selectedId = null;
        draw();
        return;
      }
    }
    const inPortHit = findPortAt(e.clientX, e.clientY, 'input');
    if (inPortHit && isInputPortUsed(inPortHit.deviceId, inPortHit.index)) {
      const conn = state.connections.find(c => c.toDeviceId === inPortHit.deviceId && c.toPort === inPortHit.index);
      if (conn) {
        pushHistory();
        state.endpointDrag = { connId: conn.id, originalToDeviceId: conn.toDeviceId, originalToPort: conn.toPort };
        conn.toDeviceId = null;
        conn.toPort = null;
        const dropWorld = screenToWorld(e.clientX, e.clientY);
        conn.toCell = worldToCell(dropWorld.x, dropWorld.y);
        recomputeAllConnections();
        state.selectedConnectionId = conn.id;
        state.selectedPipeConnectionId = null;
        state.selectedId = null;
        draw();
        return;
      }
    }

    const wpResolved = resolveConduitWaypointHitAt(e.clientX, e.clientY);
    if (wpResolved) {
      pushHistory();
      if (wpResolved.network === 'pipe') {
        const wpConn = state.pipeConnections.find(c => c.id === wpResolved.hit.connId);
        const originalCell = wpConn && wpConn.waypoints[wpResolved.hit.index] ? { ...wpConn.waypoints[wpResolved.hit.index] } : null;
        state.draggingPipeWaypoint = { connId: wpResolved.hit.connId, index: wpResolved.hit.index, originalCell };
        state.selectedId = null;
        state.selectedConnectionId = null;
        state.selectedPipeConnectionId = wpResolved.hit.connId;
      } else {
        const wpConn = state.connections.find(c => c.id === wpResolved.hit.connId);
        const originalCell = wpConn && wpConn.waypoints[wpResolved.hit.index] ? { ...wpConn.waypoints[wpResolved.hit.index] } : null;
        state.draggingWaypoint = { connId: wpResolved.hit.connId, index: wpResolved.hit.index, originalCell };
        state.selectedId = null;
        state.selectedPipeConnectionId = null;
        state.selectedConnectionId = wpResolved.hit.connId;
      }
      draw();
      return;
    }

    const worldPos = screenToWorld(e.clientX, e.clientY);
    const hit = hitTestDevice(worldPos.x, worldPos.y);

    if (hit) {
      pushHistory();
      state.draggingDeviceBeforeSnapshot = state.history[state.history.length - 1];
      state.selectedId = hit.id;
      state.selectedConnectionId = null;
      state.selectedPipeConnectionId = null;
      state.draggingDeviceId = hit.id;
      state.dragDeviceWX = hit.gridX * GRID_SIZE;
      state.dragDeviceWY = hit.gridY * GRID_SIZE;
      state.dragOffsetWX = worldPos.x - state.dragDeviceWX;
      state.dragOffsetWY = worldPos.y - state.dragDeviceWY;
      canvas.style.cursor = 'grabbing';
      draw();
      return;
    }

    const connResolved = resolveConduitHitAt(e.clientX, e.clientY);
    if (connResolved) {
      state.selectedId = null;
      if (connResolved.network === 'pipe') {
        state.selectedPipeConnectionId = connResolved.hit.conn.id;
        state.selectedConnectionId = null;
        // 先记录待定状态：真正拖动后才在该线段处插入新途经点，单纯点击仍只是选中
        state.pendingPipeWaypointCreate = { connId: connResolved.hit.conn.id, segmentIndex: connResolved.hit.segmentIndex, downX: e.clientX, downY: e.clientY };
      } else {
        state.selectedConnectionId = connResolved.hit.conn.id;
        state.selectedPipeConnectionId = null;
        state.pendingWaypointCreate = { connId: connResolved.hit.conn.id, segmentIndex: connResolved.hit.segmentIndex, downX: e.clientX, downY: e.clientY };
      }
      draw();
      return;
    }

    state.selectedId = null;
    state.selectedConnectionId = null;
    state.selectedPipeConnectionId = null;
    state.isPanning = true;
    state.lastMouseX = e.clientX;
    state.lastMouseY = e.clientY;
    canvas.style.cursor = 'grabbing';
    draw();
  });

  canvas.addEventListener('dblclick', (e) => {
    // 双击删除途经点是一次性动作，管道优先尝试、否则传送带，不接入重叠循环切换记忆
    const pipeWpHit = hitTestPipeWaypoint(e.clientX, e.clientY);
    if (pipeWpHit) {
      const conn = state.pipeConnections.find(c => c.id === pipeWpHit.connId);
      if (conn && conn.waypoints) {
        pushHistory();
        conn.waypoints.splice(pipeWpHit.index, 1);
        recomputeAllPipeConnections();
        draw();
      }
      return;
    }
    const wpHit = hitTestWaypoint(e.clientX, e.clientY);
    if (!wpHit) return;
    const conn = state.connections.find(c => c.id === wpHit.connId);
    if (conn && conn.waypoints) {
      pushHistory();
      conn.waypoints.splice(wpHit.index, 1);
      recomputeAllConnections();
      draw();
    }
  });

  // 右键：退出自由传送带/自由管道模式(阻止浏览器默认右键菜单)
  canvas.addEventListener('contextmenu', (e) => {
    if (!state.freeBeltMode && !state.freePipeMode) return;
    e.preventDefault();
    if (state.freeBeltMode) {
      state.freeBeltMode = false;
      state.freeBeltStart = null;
      state.freeBeltPreviewPts = null;
      state.freeBeltHoverDeviceId = null;
    } else {
      state.freePipeMode = false;
      state.freePipeStart = null;
      state.freePipePreviewPts = null;
      state.freePipeHoverDeviceId = null;
    }
    canvas.style.cursor = 'default';
    updateHintText();
    draw();
  });

  window.addEventListener('mousemove', (e) => {
    if (state.freeBeltMode) {
      // 无论是否已选定起点 A，都要实时更新设备本体悬停高亮；已选定 A 时还要更新路径预览
      updateFreeBeltPreview(e.clientX, e.clientY);
      canvas.style.cursor = 'crosshair';
      draw();
      return;
    }
    if (state.freePipeMode) {
      updateFreePipePreview(e.clientX, e.clientY);
      canvas.style.cursor = 'crosshair';
      draw();
      return;
    }
    if (state.pipeEndpointDrag) {
      const conn = state.pipeConnections.find(c => c.id === state.pipeEndpointDrag.connId);
      if (conn) {
        const worldPos = screenToWorld(e.clientX, e.clientY);
        conn.toCell = worldToCell(worldPos.x, worldPos.y);
        recomputeAllPipeConnections();
        draw();
      }
      return;
    }
    if (state.endpointDrag) {
      const conn = state.connections.find(c => c.id === state.endpointDrag.connId);
      if (conn) {
        const worldPos = screenToWorld(e.clientX, e.clientY);
        conn.toCell = worldToCell(worldPos.x, worldPos.y);
        recomputeAllConnections();
        draw();
      }
      return;
    }
    if (state.draggingPipeWaypoint) {
      const conn = state.pipeConnections.find(c => c.id === state.draggingPipeWaypoint.connId);
      if (conn && conn.waypoints && conn.waypoints[state.draggingPipeWaypoint.index]) {
        const worldPos = screenToWorld(e.clientX, e.clientY);
        conn.waypoints[state.draggingPipeWaypoint.index] = worldToCell(worldPos.x, worldPos.y);
        recomputeAllPipeConnections();
        draw();
      }
      return;
    }
    if (state.draggingWaypoint) {
      const conn = state.connections.find(c => c.id === state.draggingWaypoint.connId);
      if (conn && conn.waypoints && conn.waypoints[state.draggingWaypoint.index]) {
        const worldPos = screenToWorld(e.clientX, e.clientY);
        conn.waypoints[state.draggingWaypoint.index] = worldToCell(worldPos.x, worldPos.y);
        recomputeAllConnections();
        draw();
      }
      return;
    }
    if (state.pendingPipeWaypointCreate) {
      const dx = e.clientX - state.pendingPipeWaypointCreate.downX, dy = e.clientY - state.pendingPipeWaypointCreate.downY;
      if (dx * dx + dy * dy > 16) {
        const conn = state.pipeConnections.find(c => c.id === state.pendingPipeWaypointCreate.connId);
        if (conn) {
          pushHistory();
          const worldPos = screenToWorld(e.clientX, e.clientY);
          const cell = worldToCell(worldPos.x, worldPos.y);
          if (!conn.waypoints) conn.waypoints = [];
          const insertAt = waypointInsertIndex(conn, state.pendingPipeWaypointCreate.segmentIndex);
          conn.waypoints.splice(insertAt, 0, cell);
          state.draggingPipeWaypoint = { connId: conn.id, index: insertAt, originalCell: null };
          recomputeAllPipeConnections();
          draw();
        }
        state.pendingPipeWaypointCreate = null;
      }
      return;
    }
    if (state.pendingWaypointCreate) {
      const dx = e.clientX - state.pendingWaypointCreate.downX, dy = e.clientY - state.pendingWaypointCreate.downY;
      if (dx * dx + dy * dy > 16) {
        const conn = state.connections.find(c => c.id === state.pendingWaypointCreate.connId);
        if (conn) {
          pushHistory();
          const worldPos = screenToWorld(e.clientX, e.clientY);
          const cell = worldToCell(worldPos.x, worldPos.y);
          if (!conn.waypoints) conn.waypoints = [];
          const insertAt = waypointInsertIndex(conn, state.pendingWaypointCreate.segmentIndex);
          conn.waypoints.splice(insertAt, 0, cell);
          state.draggingWaypoint = { connId: conn.id, index: insertAt, originalCell: null };
          recomputeAllConnections();
          draw();
        }
        state.pendingWaypointCreate = null;
      }
      return;
    }
    if (state.draggingDeviceId !== null) {
      const worldPos = screenToWorld(e.clientX, e.clientY);
      const rawX = worldPos.x - state.dragOffsetWX;
      const rawY = worldPos.y - state.dragOffsetWY;
      state.dragDeviceWX = Math.round(rawX / GRID_SIZE) * GRID_SIZE;
      state.dragDeviceWY = Math.round(rawY / GRID_SIZE) * GRID_SIZE;
      recomputeAllFlows();
      draw();
    } else if (state.isPanning) {
      const dx = e.clientX - state.lastMouseX;
      const dy = e.clientY - state.lastMouseY;
      state.offsetX += dx;
      state.offsetY += dy;
      state.lastMouseX = e.clientX;
      state.lastMouseY = e.clientY;
      draw();
    } else if (!state.spawning) {
      const worldPos = screenToWorld(e.clientX, e.clientY);
      canvas.style.cursor = hitTestDevice(worldPos.x, worldPos.y) ? 'grab' : 'default';
    }
  });

  window.addEventListener('mouseup', (e) => {
    if (state.pipeEndpointDrag) {
      const conn = state.pipeConnections.find(c => c.id === state.pipeEndpointDrag.connId);
      if (conn) {
        let target = null;
        const portHit = findPortAt(e.clientX, e.clientY, 'input', 'pipe');
        if (portHit && !isPipeInputPortUsed(portHit.deviceId, portHit.index) && portHit.deviceId !== conn.fromDeviceId) {
          target = { deviceId: portHit.deviceId, index: portHit.index };
        } else {
          const worldPos = screenToWorld(e.clientX, e.clientY);
          const hitDev = hitTestDevice(worldPos.x, worldPos.y);
          if (hitDev && hitDev.id !== conn.fromDeviceId) {
            const pos = effectiveGridPos(hitDev);
            const avail = getDevicePorts(hitDev, pos).inputs.filter(p => p.portKind === 'pipe' && !isPipeInputPortUsed(hitDev.id, p.index));
            if (avail.length) {
              const blocked = buildBlockedSet();
              const pipeOccupancy = buildPipeOccupancy(conn.id);
              const fromResolved = resolveConnEndpoint(conn.fromDeviceId, conn.fromPort, conn.fromCell, true);
              const best = fromResolved
                ? pickBestPort(avail, fromResolved.cellCol, fromResolved.cellRow, fromResolved.dir, false, blocked, pipeOccupancy)
                : avail[0];
              if (best) target = { deviceId: hitDev.id, index: best.index };
            }
          }
        }
        if (target) {
          conn.toDeviceId = target.deviceId;
          conn.toPort = target.index;
          conn.toCell = null;
        } else {
          conn.toDeviceId = state.pipeEndpointDrag.originalToDeviceId;
          conn.toPort = state.pipeEndpointDrag.originalToPort;
          conn.toCell = null;
        }
        recomputeAllPipeConnections();
        if (target && conn.invalid) {
          conn.toDeviceId = state.pipeEndpointDrag.originalToDeviceId;
          conn.toPort = state.pipeEndpointDrag.originalToPort;
          conn.toCell = null;
          recomputeAllPipeConnections();
        }
      }
      state.pipeEndpointDrag = null;
      draw();
      return;
    }
    if (state.endpointDrag) {
      const conn = state.connections.find(c => c.id === state.endpointDrag.connId);
      if (conn) {
        // 优先精确端口；否则兜底落在设备本体上时自动选离起点最近的可用输入口；
        // 都不满足(或落在传送带自身的源设备上，避免自环)则还原到原来的输入口。
        let target = null;
        const portHit = findPortAt(e.clientX, e.clientY, 'input');
        if (portHit && !isInputPortUsed(portHit.deviceId, portHit.index) && portHit.deviceId !== conn.fromDeviceId) {
          target = { deviceId: portHit.deviceId, index: portHit.index };
        } else {
          const worldPos = screenToWorld(e.clientX, e.clientY);
          const hitDev = hitTestDevice(worldPos.x, worldPos.y);
          if (hitDev && hitDev.id !== conn.fromDeviceId) {
            const pos = effectiveGridPos(hitDev);
            const avail = getDevicePorts(hitDev, pos).inputs.filter(p => !isInputPortUsed(hitDev.id, p.index));
            if (avail.length) {
              const blocked = buildBlockedSet();
              const beltOccupancy = buildBeltOccupancy(conn.id);
              const fromResolved = resolveConnEndpoint(conn.fromDeviceId, conn.fromPort, conn.fromCell, true);
              const best = fromResolved
                ? pickBestPort(avail, fromResolved.cellCol, fromResolved.cellRow, fromResolved.dir, false, blocked, beltOccupancy)
                : avail[0];
              if (best) target = { deviceId: hitDev.id, index: best.index };
            }
          }
        }
        if (target) {
          conn.toDeviceId = target.deviceId;
          conn.toPort = target.index;
          conn.toCell = null;
        } else {
          conn.toDeviceId = state.endpointDrag.originalToDeviceId;
          conn.toPort = state.endpointDrag.originalToPort;
          conn.toCell = null;
        }
        recomputeAllConnections();
        // 落在了某个输入口上，但该位置实际算出来的路径会自我重叠(无法计算出
        // 合法的不重叠路径)：不接受这次改接，还原回拖拽前的输入口。
        if (target && conn.invalid) {
          conn.toDeviceId = state.endpointDrag.originalToDeviceId;
          conn.toPort = state.endpointDrag.originalToPort;
          conn.toCell = null;
          recomputeAllConnections();
        }
      }
      state.endpointDrag = null;
      draw();
      return;
    }
    if (state.draggingPipeWaypoint) {
      const wpConn = state.pipeConnections.find(c => c.id === state.draggingPipeWaypoint.connId);
      if (wpConn && wpConn.waypoints && wpConn.invalid) {
        if (state.draggingPipeWaypoint.originalCell) {
          wpConn.waypoints[state.draggingPipeWaypoint.index] = state.draggingPipeWaypoint.originalCell;
        } else {
          wpConn.waypoints.splice(state.draggingPipeWaypoint.index, 1);
        }
        recomputeAllPipeConnections();
      }
      state.draggingPipeWaypoint = null;
      draw();
      return;
    }
    if (state.draggingWaypoint) {
      const wpConn = state.connections.find(c => c.id === state.draggingWaypoint.connId);
      // 松手时若这个途经点位置导致路径无效(自我重叠或找不到路径)，取消这次改动：
      // 新插入的途经点直接移除，移动已有途经点则还原回拖拽前的位置。
      if (wpConn && wpConn.waypoints && wpConn.invalid) {
        if (state.draggingWaypoint.originalCell) {
          wpConn.waypoints[state.draggingWaypoint.index] = state.draggingWaypoint.originalCell;
        } else {
          wpConn.waypoints.splice(state.draggingWaypoint.index, 1);
        }
        recomputeAllConnections();
      }
      state.draggingWaypoint = null;
      draw();
      return;
    }
    if (state.pendingPipeWaypointCreate) {
      state.pendingPipeWaypointCreate = null;
      return;
    }
    if (state.pendingWaypointCreate) {
      // 未超过拖动阈值：视为单纯点击，仅保留 mousedown 时已做的选中效果
      state.pendingWaypointCreate = null;
      return;
    }
    if (state.draggingDeviceId !== null) {
      const dev = state.devices.find(d => d.id === state.draggingDeviceId);
      if (dev) {
        dev.gridX = Math.round(state.dragDeviceWX / GRID_SIZE);
        dev.gridY = Math.round(state.dragDeviceWY / GRID_SIZE);
        recomputeAllFlows();
        // 落位后如果把某条操作前合法的连线拖成 invalid(哪怕设备本身跟那条连线
        // 毫不相干，只是新位置挤占/绕开了它寻路需要用到的格子)，不接受这次移动，
        // 整体还原回拖拽前的位置和连线状态——设备重叠仍然只是警示、不阻挡放置，
        // 这里只管"别的连线被顺手拖坏"这一种情况。通用设备拖拽两个网络都要查，
        // 和 finalizePipeConnection/createPipeSplitterAtClick 那里"故意只查
        // PIPE_NETWORK"的地面冲突例外不是一回事。
        if (state.draggingDeviceBeforeSnapshot) {
          const brokeBelt = brokeExistingValidConnection(state.draggingDeviceBeforeSnapshot, BELT_NETWORK);
          const brokePipe = brokeExistingValidConnection(state.draggingDeviceBeforeSnapshot, PIPE_NETWORK);
          if (brokeBelt || brokePipe) revertLastHistoryStep();
        }
      }
    }
    state.draggingDeviceId = null;
    state.draggingDeviceBeforeSnapshot = null;
    state.isPanning = false;
    canvas.style.cursor = 'default';
    draw();
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const zoomIntensity = 0.1;
    const direction = e.deltaY > 0 ? -1 : 1;
    const factor = 1 + direction * zoomIntensity;
    const newScale = Math.min(4, Math.max(0.2, state.scale * factor));
    if (newScale === state.scale) return;

    const worldPos = screenToWorld(e.clientX, e.clientY);
    state.scale = newScale;
    state.offsetX = e.clientX - worldPos.x * state.scale;
    state.offsetY = e.clientY - worldPos.y * state.scale;
    draw();
  }, { passive: false });
}

// ---- 键盘：删除 / 旋转 ----

function bindKeyboardEvents() {
  window.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      undo();
      return;
    }

    if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      state.freeBeltMode = !state.freeBeltMode;
      state.freeBeltStart = null;
      state.freeBeltPreviewPts = null;
      state.freeBeltHoverDeviceId = null;
      if (state.freeBeltMode) {
        // 进入布线模式即为独占工具：清掉其它可能残留的交互状态，包括另一个
        // 画线工具(自由管道模式)的进行中状态——两个模式互斥。
        state.freePipeMode = false;
        state.freePipeStart = null;
        state.freePipePreviewPts = null;
        state.freePipeHoverDeviceId = null;
        state.draggingWaypoint = null;
        state.pendingWaypointCreate = null;
        state.draggingPipeWaypoint = null;
        state.pendingPipeWaypointCreate = null;
        state.draggingDeviceId = null;
        state.draggingDeviceBeforeSnapshot = null;
        state.endpointDrag = null;
        state.pipeEndpointDrag = null;
        state.isPanning = false;
        state.selectedId = null;
        state.selectedConnectionId = null;
        state.selectedPipeConnectionId = null;
        state.lastConduitClickCell = null;
        canvas.style.cursor = 'crosshair';
      } else {
        canvas.style.cursor = 'default';
      }
      updateHintText();
      draw();
      return;
    }

    if (e.key === 'q' || e.key === 'Q') {
      e.preventDefault();
      state.freePipeMode = !state.freePipeMode;
      state.freePipeStart = null;
      state.freePipePreviewPts = null;
      state.freePipeHoverDeviceId = null;
      if (state.freePipeMode) {
        // 镜像上面的 E 键处理，且互斥清空自由传送带模式的进行中状态。
        state.freeBeltMode = false;
        state.freeBeltStart = null;
        state.freeBeltPreviewPts = null;
        state.freeBeltHoverDeviceId = null;
        state.draggingWaypoint = null;
        state.pendingWaypointCreate = null;
        state.draggingPipeWaypoint = null;
        state.pendingPipeWaypointCreate = null;
        state.draggingDeviceId = null;
        state.draggingDeviceBeforeSnapshot = null;
        state.endpointDrag = null;
        state.pipeEndpointDrag = null;
        state.isPanning = false;
        state.selectedId = null;
        state.selectedConnectionId = null;
        state.selectedPipeConnectionId = null;
        state.lastConduitClickCell = null;
        canvas.style.cursor = 'crosshair';
      } else {
        canvas.style.cursor = 'default';
      }
      updateHintText();
      draw();
      return;
    }

    if (e.key === 'r' || e.key === 'R') {
      if (state.selectedId === null) return;
      const dev = state.devices.find(d => d.id === state.selectedId);
      // 汇流器/分流器(传送带版和管道版)的朝向由被切入的原连线决定，不支持手动旋转；
      // 反应池和粉碎机一样允许旋转，四组端口作为刚体整体随旋转角度转动。
      if (!dev || (dev.kind && dev.kind !== 'crusher' && dev.kind !== 'reactor')) return;
      e.preventDefault();
      pushHistory();
      dev.rot = (flowDirOf(dev) + 1) % 4;
      recomputeAllFlows();
      draw();
      return;
    }

    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (state.selectedPipeConnectionId !== null) {
      e.preventDefault();
      pushHistory();
      state.pipeConnections = state.pipeConnections.filter(c => c.id !== state.selectedPipeConnectionId);
      state.selectedPipeConnectionId = null;
      draw();
    } else if (state.selectedConnectionId !== null) {
      e.preventDefault();
      pushHistory();
      state.connections = state.connections.filter(c => c.id !== state.selectedConnectionId);
      state.selectedConnectionId = null;
      draw();
    } else if (state.selectedId !== null) {
      e.preventDefault();
      pushHistory();
      // 删除设备只移除设备本身：与它相连的传送带/管道保留下来，端点改为设备
      // 原先所在端口紧邻的那格自由网格端点，成为一段悬空的连线，仍可在普通
      // 模式下选中/删除，或拖拽途经点调整。getDevicePorts 返回的是 belt+pipe
      // 合并端口列表，按 index 查找对两种连线都适用。
      const dev = state.devices.find(d => d.id === state.selectedId);
      if (dev) {
        const pos = effectiveGridPos(dev);
        const ports = getDevicePorts(dev, pos);
        for (const c of state.connections) {
          if (c.fromDeviceId === state.selectedId) {
            const p = ports.outputs.find(pp => pp.index === c.fromPort);
            c.fromDeviceId = null;
            c.fromPort = null;
            c.fromCell = { col: p ? p.cellCol : pos.gridX, row: p ? p.cellRow : pos.gridY };
          }
          if (c.toDeviceId === state.selectedId) {
            const p = ports.inputs.find(pp => pp.index === c.toPort);
            c.toDeviceId = null;
            c.toPort = null;
            c.toCell = { col: p ? p.cellCol : pos.gridX, row: p ? p.cellRow : pos.gridY };
          }
        }
        for (const c of state.pipeConnections) {
          if (c.fromDeviceId === state.selectedId) {
            const p = ports.outputs.find(pp => pp.index === c.fromPort);
            c.fromDeviceId = null;
            c.fromPort = null;
            c.fromCell = { col: p ? p.cellCol : pos.gridX, row: p ? p.cellRow : pos.gridY };
          }
          if (c.toDeviceId === state.selectedId) {
            const p = ports.inputs.find(pp => pp.index === c.toPort);
            c.toDeviceId = null;
            c.toPort = null;
            c.toCell = { col: p ? p.cellCol : pos.gridX, row: p ? p.cellRow : pos.gridY };
          }
        }
      }
      state.devices = state.devices.filter(d => d.id !== state.selectedId);
      state.selectedId = null;
      recomputeAllFlows();
      draw();
    }
  });
}

// ---- 工具栏拖拽生成新设备 ----

function isPointInToolbar(x, y) {
  const r = toolbar.getBoundingClientRect();
  return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
}

function updateSpawnPreview(clientX, clientY) {
  if (isPointInToolbar(clientX, clientY)) {
    state.spawnPreview = null;
    return;
  }
  const template = SPAWN_TEMPLATES.find(t => t.key === state.spawningTemplateKey);
  if (!template) { state.spawnPreview = null; return; }
  const worldPos = screenToWorld(clientX, clientY);
  const rawX = worldPos.x - (template.w * GRID_SIZE) / 2;
  const rawY = worldPos.y - (template.h * GRID_SIZE) / 2;
  state.spawnPreview = {
    gridX: Math.round(rawX / GRID_SIZE),
    gridY: Math.round(rawY / GRID_SIZE)
  };
}

function bindToolbarSpawnEvents() {
  const icons = [{ el: crusherIcon, key: 'crusher' }, { el: reactorIcon, key: 'reactor' }];

  for (const { el, key } of icons) {
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      state.spawning = true;
      state.spawningTemplateKey = key;
      ghostIcon.style.display = 'flex';
      ghostIcon.textContent = SPAWN_TEMPLATES.find(t => t.key === key).label;
      ghostIcon.style.left = (e.clientX - 28) + 'px';
      ghostIcon.style.top = (e.clientY - 28) + 'px';
      updateSpawnPreview(e.clientX, e.clientY);
    });
  }

  window.addEventListener('mousemove', (e) => {
    if (!state.spawning) return;
    ghostIcon.style.left = (e.clientX - 28) + 'px';
    ghostIcon.style.top = (e.clientY - 28) + 'px';
    updateSpawnPreview(e.clientX, e.clientY);
    draw();
  });

  window.addEventListener('mouseup', (e) => {
    if (!state.spawning) return;
    state.spawning = false;
    ghostIcon.style.display = 'none';

    const template = SPAWN_TEMPLATES.find(t => t.key === state.spawningTemplateKey);
    if (state.spawnPreview && template && !isPointInToolbar(e.clientX, e.clientY)) {
      pushHistory();
      const beforeSnapshot = state.history[state.history.length - 1];
      const newDevice = {
        id: state.nextId++,
        gridX: state.spawnPreview.gridX,
        gridY: state.spawnPreview.gridY,
        w: template.w,
        h: template.h,
        rot: 0,
        kind: template.kind,
        color: template.color,
        borderColor: template.borderColor,
        label: template.label
      };
      state.devices.push(newDevice);
      state.selectedId = newDevice.id;
      recomputeAllFlows();
      // 顺手补上设备拖拽/分流器生成早就有、但工具栏生成一直没有的安全网：
      // 新设备的footprint如果顺手压垮了某条操作前合法的连线(粉碎机3x3不明显，
      // 反应池5x5更容易压中)，整体撤销这次生成，两个网络都查。
      const brokeBelt = brokeExistingValidConnection(beforeSnapshot, BELT_NETWORK);
      const brokePipe = brokeExistingValidConnection(beforeSnapshot, PIPE_NETWORK);
      if (brokeBelt || brokePipe) {
        revertLastHistoryStep();
        state.selectedId = null;
      }
    }
    state.spawnPreview = null;
    state.spawningTemplateKey = null;
    draw();
  });
}

export function initInteractions() {
  bindCanvasMouseEvents();
  bindKeyboardEvents();
  bindToolbarSpawnEvents();
}
