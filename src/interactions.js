// ---- 交互：画布内鼠标/键盘事件绑定、自由传送带/自由管道模式状态机、工具栏拖拽生成新设备 ----
import { GRID_SIZE, HINT_NORMAL, HINT_BELT, HINT_PIPE, HINT_BOX_SELECT, BOX_SELECT_LONG_PRESS_MS } from './constants.js';
import { state, canvas, toolbar, toolbarTabs, toolbarIcons, ghostIcon, hintEl } from './state.js';
import { screenToWorld, worldToCell } from './coords.js';
import {
  hitTestDevice, findPortAt, effectiveGridPos, getDevicePorts, getDeviceRectWorld, rectsOverlapPx,
  isInputPortUsed, isOutputPortUsed, isPipeInputPortUsed, isPipeOutputPortUsed,
  flowDirOf, SPAWN_TEMPLATES
} from './devices.js';
import {
  buildBlockedSet, buildBeltOccupancy, buildPipeOccupancy, aStarOrthogonal, removeSelfOverlap,
  computePath, recomputeAllConnections, recomputeAllPipeConnections, recomputeAllForNetwork, recomputeAllFlows,
  hitTestConnection, hitTestPipeConnection, hitTestWaypoint, hitTestPipeWaypoint,
  waypointInsertIndex, splitConnectionAtCell, cellOrientationsOf, findConnectionAtCell,
  findDanglingConnAtCell, extendDanglingConnection, fuseDanglingConnections,
  pickBestPort, pickNearestPortByDistance, resolveConnEndpoint, clearWaypointsForDevice,
  boxSelectHitConnections, connectionsTouchingDevices, detachDeviceFromConnections,
  BELT_NETWORK, PIPE_NETWORK
} from './pathfinding.js';
import { draw } from './render.js';
import { pushHistory, undo, revertLastHistoryStep, brokeExistingValidConnection } from './history.js';

export function updateHintText() {
  hintEl.textContent = state.freeBeltMode ? HINT_BELT
    : state.freePipeMode ? HINT_PIPE
    : state.boxSelectMode ? HINT_BOX_SELECT
    : HINT_NORMAL;
  hintEl.classList.toggle('belt-mode', state.freeBeltMode);
  hintEl.classList.toggle('pipe-mode', state.freePipeMode);
  hintEl.classList.toggle('box-select-mode', state.boxSelectMode);
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

// ---- 自由传送带/自由管道模式：状态解析、实时预览与落地逻辑 ----
// 传送带和管道走同一套实现，靠下面 BELT_UI/PIPE_UI 这两个小描述符提供两者的
// 差异点(状态字段读写、端口占用判断、分流器/汇流器设备 kind 等)，写法上和
// pathfinding.js 里 BELT_NETWORK/PIPE_NETWORK 的 network 参数化风格保持一致；
// 这里的描述符只放"自由画线交互层"专属的差异，不塞进 pathfinding.js 的
// network 描述符(那个被 render.js/history.js 等其它模块共用，不该掺入 UI 状态)。

// 探测 (col,row) 这一格地面是否已有一条合法的传送带经过——管道分流器/汇流器
// 需要架设在地面上，如果该格地面已经被传送带占用，允许放置但要显示地面冲突
// 警示(见 groundConflict)。这里始终检查传送带网络，与"当前正在处理管道分流器
// 还是管道汇流器"无关；传送带侧没有对应检查(不存在"传送带需要检查地面是否被
// 管道占用"这种反向规则，管道是空中单位)。
function groundHasBeltConflict(col, row) {
  return !!findConnectionAtCell(col, row, BELT_NETWORK);
}

const BELT_UI = {
  network: BELT_NETWORK,
  portKind: 'belt',
  getStart: () => state.freeBeltStart,
  setStart: v => { state.freeBeltStart = v; },
  getPreviewPts: () => state.freeBeltPreviewPts,
  setPreviewPts: v => { state.freeBeltPreviewPts = v; },
  setHoverDeviceId: v => { state.freeBeltHoverDeviceId = v; },
  isOutputPortUsed, isInputPortUsed,
  hitTestConn: hitTestConnection,
  splitterKind: 'splitter', mergerKind: 'merger',
  checkGroundConflict: null, // 传送带侧没有地面冲突检查，见 groundHasBeltConflict 的注释
  enterMode: () => { state.freeBeltMode = true; },
  setSelected: id => { state.selectedId = null; state.selectedConnectionId = id; },
};
const PIPE_UI = {
  network: PIPE_NETWORK,
  portKind: 'pipe',
  getStart: () => state.freePipeStart,
  setStart: v => { state.freePipeStart = v; },
  getPreviewPts: () => state.freePipePreviewPts,
  setPreviewPts: v => { state.freePipePreviewPts = v; },
  setHoverDeviceId: v => { state.freePipeHoverDeviceId = v; },
  isOutputPortUsed: isPipeOutputPortUsed, isInputPortUsed: isPipeInputPortUsed,
  hitTestConn: hitTestPipeConnection,
  splitterKind: 'pipe-splitter', mergerKind: 'pipe-merger',
  checkGroundConflict: groundHasBeltConflict,
  enterMode: () => { state.freePipeMode = true; },
  setSelected: id => { state.selectedId = null; state.selectedPipeConnectionId = id; },
};

// 把 ui 对应模式的"起点"状态解析为寻路用的具体 (col,row,dir)，绑定了设备端口
// 时顺带带上端口自身的精确世界坐标 (x,y)(自由网格起点没有端口，不带这两个字段)。
// kind='anyOutput' 时，在该设备当前空闲的输出口中，按到 (towardCol,towardRow)
// 代价最小挑选。x/y 只有 updateFreePreview 会用到，用来让预览虚线紧贴端口本身
// 而不是端口外侧那一格的格心(两者之间差半格，见 updateFreePreview 的注释)。
function resolveFreeStartForPathing(ui, towardCol, towardRow, blocked, occupancy) {
  const start = ui.getStart();
  if (!start) return null;
  if (start.kind === 'free') return { col: start.col, row: start.row, dir: null };
  const dev = state.devices.find(d => d.id === start.deviceId);
  if (!dev) return null;
  const pos = effectiveGridPos(dev);
  if (start.kind === 'port') {
    const p = getDevicePorts(dev, pos).outputs.find(pp => pp.index === start.port);
    return p ? { col: p.cellCol, row: p.cellRow, dir: p.dir, x: p.x, y: p.y } : null;
  }
  const avail = getDevicePorts(dev, pos).outputs.filter(p => p.portKind === ui.portKind && !ui.isOutputPortUsed(dev.id, p.index));
  const best = pickBestPort(avail, towardCol, towardRow, null, true, blocked, occupancy);
  return best ? { col: best.cellCol, row: best.cellRow, dir: best.dir, x: best.x, y: best.y } : null;
}

// 起点(A)点击优先级：
//  1) 精确点在某个未占用的输出口上 → 直接用该端口
//  2) 精确点在输入口上 → 严格禁止从输入口拉线，提示并取消
//  3) 点在设备本体(非精确端口)上 → 兜底，自动选离点击处最近的可用输出口
//     (只在该网络自己的端口里挑，另一种网络的口不算数)
//  4) 点在某条已有连线"悬空的自由端点"(fromCell/toCell 未接设备)所在格子上
//     → 视为空白网格起点，可以从这个未完成的悬空端点继续延伸出新路径；如果
//     命中的正是悬空的 toCell(该连线已有真实源头，只是下游还没接完)，额外
//     记下 continuesConn，供 finalizeFreeConnection 落地时把新画的这一笔并入
//     这条连线本身(同一个 id)，而不是新建一条只是坐标凑巧重合的独立连线。
//     命中悬空的 fromCell 时不记——那种情况下两条线只是碰巧共享一个空白格
//     坐标，流向并不连续，不该被静默合并(见 pathfinding.js 里
//     findDanglingConnAtCell 的注释)。
//  5) 点在已有连线其它位置上 → 此阶段不处理(生成分流器走 Alt+点击)
//  6) 其余视为空白网格起点
function resolveFreeStartClick(ui, clientX, clientY) {
  const port = findPortAt(clientX, clientY, 'output', ui.portKind);
  if (port) {
    if (ui.isOutputPortUsed(port.deviceId, port.index)) return null;
    return { kind: 'port', deviceId: port.deviceId, port: port.index };
  }
  const inPort = findPortAt(clientX, clientY, 'input', ui.portKind);
  if (inPort) {
    showCursorTooltip('无法选择输入口作为起点', clientX, clientY);
    return null;
  }
  const worldPos = screenToWorld(clientX, clientY);
  const hitDev = hitTestDevice(worldPos.x, worldPos.y);
  if (hitDev) {
    const pos = effectiveGridPos(hitDev);
    const avail = getDevicePorts(hitDev, pos).outputs.filter(p => p.portKind === ui.portKind && !ui.isOutputPortUsed(hitDev.id, p.index));
    if (avail.length === 0) return null;
    const cell = worldToCell(worldPos.x, worldPos.y);
    const best = pickNearestPortByDistance(avail, cell.col, cell.row);
    if (!best) return null;
    return { kind: 'port', deviceId: hitDev.id, port: best.index };
  }
  const cell = worldToCell(worldPos.x, worldPos.y);
  const dangling = findDanglingConnAtCell(cell.col, cell.row, ui.network);
  if (dangling) {
    return dangling.end === 'to'
      ? { kind: 'free', col: cell.col, row: cell.row, continuesConn: dangling.conn }
      : { kind: 'free', col: cell.col, row: cell.row };
  }
  if (ui.hitTestConn(clientX, clientY)) return null;
  return { kind: 'free', col: cell.col, row: cell.row };
}

// 终点(B)点击优先级：
//  1) 精确点在某个未占用的输入口上 → 直接用该端口
//  2) 精确点在输出口上 → 严格禁止把输出口当终点，提示并保持预览状态(不结束画线)
//  3) 点在设备本体(非精确端口)上 → 兜底，自动选离起点 A 最近的可用输入口
//  4) 点落在某条已有连线"悬空的自由端点(fromCell)"所在格子 → 记下
//     continuesConn，供 finalizeFreeConnection 把这条连线的源头接上(镜像上面
//     resolveFreeStartClick 第 4 条命中 toCell 的情况)；命中 toCell 的情况不记，
//     理由同上，落到第 5 条按"点在已有连线上"处理。这一条必须排在第 5 条
//     "点在已有连线上→自动汇流"前面：悬空端点本身必然也是该连线渲染路径上的
//     一个点，hitTestConn 的像素距离命中会无差别地先逮到它，如果顺序反了，
//     点悬空端点永远会被判成"点在已有连线上"、自动插一个汇流器，续接分支就
//     变成永远走不到的死代码。
//  5) 点在已有连线其它位置上 → 触发自动汇流
//  6) 其余视为空白网格终点
function resolveFreeEndClick(ui, clientX, clientY) {
  const port = findPortAt(clientX, clientY, 'input', ui.portKind);
  if (port) {
    if (ui.isInputPortUsed(port.deviceId, port.index)) return null;
    return { kind: 'port', deviceId: port.deviceId, port: port.index };
  }
  const outPort = findPortAt(clientX, clientY, 'output', ui.portKind);
  if (outPort) {
    showCursorTooltip('无法选择输出口作为终点', clientX, clientY);
    return null;
  }
  // 设备本体优先于连线：落点若在某个已有设备(含汇流器/分流器节点)的
  // footprint 内，一律按设备本体兜底逻辑处理，避免设备正下方/内部残留的
  // 连线线段抢先命中，导致点击已有汇流器节点添加输入时被误判为再次点击
  // 连线本身。
  const worldPos = screenToWorld(clientX, clientY);
  const hitDev = hitTestDevice(worldPos.x, worldPos.y);
  if (hitDev) {
    const pos = effectiveGridPos(hitDev);
    const avail = getDevicePorts(hitDev, pos).inputs.filter(p => p.portKind === ui.portKind && !ui.isInputPortUsed(hitDev.id, p.index));
    if (avail.length === 0) return null;
    const blocked = buildBlockedSet();
    const occupancy = ui.network.buildOccupancy(null);
    // 用第一个候选输入口的外侧格子(必定在设备footprint之外、不会被阻挡)作为
    // 解析起点(尤其是分流器 anyOutput 起点)时的寻路参照，而不是设备本体的
    // 原点格(那格本身就在设备footprint内部，会被当成障碍导致寻路失败)。
    const startResolved = resolveFreeStartForPathing(ui, avail[0].cellCol, avail[0].cellRow, blocked, occupancy);
    const refCol = startResolved ? startResolved.col : pos.gridX;
    const refRow = startResolved ? startResolved.row : pos.gridY;
    const refDir = startResolved ? startResolved.dir : null;
    const best = pickBestPort(avail, refCol, refRow, refDir, false, blocked, occupancy);
    if (!best) return null;
    return { kind: 'port', deviceId: hitDev.id, port: best.index };
  }
  const cell = worldToCell(worldPos.x, worldPos.y);
  const dangling = findDanglingConnAtCell(cell.col, cell.row, ui.network);
  if (dangling && dangling.end === 'from') return { kind: 'free', col: cell.col, row: cell.row, continuesConn: dangling.conn };
  const hitConn = ui.hitTestConn(clientX, clientY);
  if (hitConn) return { kind: 'merge', conn: hitConn.conn };
  return { kind: 'free', col: cell.col, row: cell.row };
}

// 鼠标每次移动都重算一次"起点 A → 当前悬停格"的 A* 预览路径(终点方向不限，
// 仅供预览；真正落地时才会按终点自身的方向要求精确寻路)。同时更新设备本体
// 悬停高亮：只在鼠标没有精确落在某个端口上、但落在设备本体上时高亮。
// 预览虚线紧贴端口的处理：A* 的格子路径天然只能精确到"端口外侧那一格的格心"，
// 而端口图形实际画在设备边界线上，两者之间总差半格——最终落地的连线不会有这个
// 问题，是因为 computePath 会显式把 startPort/endPort 的精确坐标拼进 points
// 数组首尾(见 pathfinding.js)。预览这里镜像同样的处理：起点绑定了设备端口时，
// 把 startResolved.x/y(端口精确坐标)当成 points 数组的第一个点；悬停处精确落在
// 某个未占用的输入口上时，同样把该端口的精确坐标追加为最后一个点——不这样处理
// 的话，虚线预览会在半格之外就停下，和端口图形之间露出一截空隙，视觉上像是没
// 连上。
function updateFreePreview(ui, hoverClientX, hoverClientY) {
  ui.setPreviewPts(null);
  const worldPos = screenToWorld(hoverClientX, hoverClientY);
  const hoverInPortRaw = findPortAt(hoverClientX, hoverClientY, 'input', ui.portKind);
  const hoverInPort = hoverInPortRaw && !ui.isInputPortUsed(hoverInPortRaw.deviceId, hoverInPortRaw.index) ? hoverInPortRaw : null;
  if (!findPortAt(hoverClientX, hoverClientY, 'output', ui.portKind) && !hoverInPortRaw) {
    const hovered = hitTestDevice(worldPos.x, worldPos.y);
    ui.setHoverDeviceId(hovered ? hovered.id : null);
  } else {
    ui.setHoverDeviceId(null);
  }
  if (!ui.getStart()) return;
  const hoverCell = hoverInPort ? { col: hoverInPort.cellCol, row: hoverInPort.cellRow } : worldToCell(worldPos.x, worldPos.y);
  const blocked = buildBlockedSet();
  const occupancy = ui.network.buildOccupancy(null);

  const startResolved = resolveFreeStartForPathing(ui, hoverCell.col, hoverCell.row, blocked, occupancy);
  if (!startResolved) return;

  const cellPath = aStarOrthogonal(startResolved.col, startResolved.row, startResolved.dir, hoverCell.col, hoverCell.row, null, blocked, occupancy);
  if (!cellPath) return;
  const cleaned = removeSelfOverlap(cellPath);
  const pts = cleaned.map(c => ({ x: (c.col + 0.5) * GRID_SIZE, y: (c.row + 0.5) * GRID_SIZE }));
  if (startResolved.x !== undefined) pts.unshift({ x: startResolved.x, y: startResolved.y });
  if (hoverInPort) pts.push({ x: hoverInPort.x, y: hoverInPort.y });
  ui.setPreviewPts(pts);
}

// 第二次点击落地：解析终点(落在既有连线上时先插入汇流器节点)，再解析起点
// (分流器新分支时在空闲输出口中挑选最短路的一个)，最后生成正式连线——如果
// 起点/终点命中了悬空端点续接(见 resolveFreeStartClick/resolveFreeEndClick)，
// 改成把新画的这一笔并入被续接的旧连线本身，而不是新建一条。
function finalizeFreeConnection(ui, endResolved, clientX, clientY) {
  const start = ui.getStart();
  if (!start || !endResolved) return;
  pushHistory();
  const beforeSnapshot = state.history[state.history.length - 1];

  const blocked = buildBlockedSet();
  const occupancy = ui.network.buildOccupancy(null);

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
    if (!hostConn.cellPath) { ui.setStart(null); ui.setPreviewPts(null); draw(); return; }
    const hit = cellOrientationsOf(hostConn.cellPath, hostConn.startDir, hostConn.goalDir)
      .find(o => o.cell.col === cell.col && o.cell.row === cell.row);
    if (!hit) { ui.setStart(null); ui.setPreviewPts(null); draw(); return; }
    // 管道汇流器落在已有传送带地面格上是被批准的例外(见 groundHasBeltConflict
    // 的地面冲突警示)，传送带侧 ui.checkGroundConflict 为 null，跳过。
    const conflict = ui.checkGroundConflict ? ui.checkGroundConflict(cell.col, cell.row) : false;
    mergerNode = splitConnectionAtCell(hostConn, cell, hit.entryDir, hit.exitDir, ui.mergerKind, ui.network);
    if (conflict) mergerNode.groundConflict = true;
    roughTargetCol = mergerNode.gridX; roughTargetRow = mergerNode.gridY;
  } else {
    return;
  }

  // ---- 解析起点 ----
  let fromDeviceId = null, fromPort = null, fromCell = null;
  if (start.kind === 'free') {
    fromCell = { col: start.col, row: start.row };
  } else if (start.kind === 'port') {
    fromDeviceId = start.deviceId;
    fromPort = start.port;
  } else if (start.kind === 'anyOutput') {
    const dev = state.devices.find(d => d.id === start.deviceId);
    if (!dev) { ui.setStart(null); ui.setPreviewPts(null); draw(); return; }
    const pos = effectiveGridPos(dev);
    const avail = getDevicePorts(dev, pos).outputs.filter(p => p.portKind === ui.portKind && !ui.isOutputPortUsed(dev.id, p.index));
    const best = pickBestPort(avail, roughTargetCol, roughTargetRow, null, true, blocked, occupancy);
    if (!best) { ui.setStart(null); ui.setPreviewPts(null); draw(); return; }
    fromDeviceId = dev.id;
    fromPort = best.index;
  }

  // ---- 若终点是刚生成的汇流器，用已确定的起点方向挑选代价最小的空闲输入口 ----
  if (mergerNode) {
    const pos = effectiveGridPos(mergerNode);
    const availInputs = getDevicePorts(mergerNode, pos).inputs.filter(p => !ui.isInputPortUsed(mergerNode.id, p.index));
    if (availInputs.length === 0) { ui.setStart(null); ui.setPreviewPts(null); draw(); return; }
    const startResolved = resolveConnEndpoint(fromDeviceId, fromPort, fromCell, true);
    if (!startResolved) { ui.setStart(null); ui.setPreviewPts(null); draw(); return; }
    const bestInput = pickBestPort(availInputs, startResolved.cellCol, startResolved.cellRow, startResolved.dir, false, blocked, occupancy);
    if (!bestInput) { ui.setStart(null); ui.setPreviewPts(null); draw(); return; }
    toDeviceId = mergerNode.id;
    toPort = bestInput.index;
  }

  // ---- 悬空端点续接：起点/终点若命中了别的连线的悬空端点，把这一笔并入那条
  // 连线本身(同一个 id)，而不是新建一条；两头都命中且分属两条不同连线时，
  // 三段一次融合成一条(见 pathfinding.js 的 fuseDanglingConnections)。两头
  // 命中的是同一条连线(自环，没有物理意义)时按普通新建连线处理。----
  const startMatch = start.continuesConn || null;
  const endMatch = endResolved.continuesConn || null;
  const selfLoop = startMatch && endMatch && startMatch === endMatch;
  let mergedConn = null;
  if (!selfLoop && startMatch && endMatch) {
    fuseDanglingConnections(startMatch, endMatch, ui.network);
    mergedConn = startMatch;
  } else if (!selfLoop && startMatch) {
    extendDanglingConnection(startMatch, 'to', { deviceId: toDeviceId, port: toPort, cell: toCell }, ui.network);
    mergedConn = startMatch;
  } else if (!selfLoop && endMatch) {
    extendDanglingConnection(endMatch, 'from', { deviceId: fromDeviceId, port: fromPort, cell: fromCell }, ui.network);
    mergedConn = endMatch;
  }

  let newConnId;
  if (mergedConn) {
    newConnId = mergedConn.id;
  } else {
    const conn = {
      id: ui.network.nextId(),
      fromDeviceId, fromPort, fromCell,
      toDeviceId, toPort, toCell,
      waypoints: [], points: [], cellPath: null, startDir: null, goalDir: null, invalid: false
    };
    const res = computePath(conn, ui.network);
    conn.points = res.points;
    conn.cellPath = res.cellPath;
    conn.startDir = res.startDir;
    conn.goalDir = res.goalDir;
    conn.invalid = res.invalid;
    ui.network.getConns().push(conn);
    newConnId = conn.id;
  }
  ui.setSelected(newConnId);

  ui.setStart(null);
  ui.setPreviewPts(null);
  recomputeAllForNetwork(ui.network);
  // 新分支落地(尤其是终点落在既有连线上、自动生成汇流器节点时)可能连带把
  // 某条本来正常的旧连线挤成 invalid——这条新连线自己是否 invalid 不受影响
  // (维持"画到不可达位置、留给用户后续调整"的既有行为，接续/融合场景下这
  // 条规则同样适用于被续接的旧连线本身，所以下面显式排除 newConnId 自己)，
  // 但绝不能让这次操作顺手弄坏一条别的、原本合法的连线，所以整体撤销、退回
  // 操作前的状态。
  if (brokeExistingValidConnection(beforeSnapshot, ui.network, new Set([newConnId]))) {
    revertLastHistoryStep();
    ui.setSelected(null);
  }
  draw();
}

// Alt+左键点击已有连线任意一格：原地生成分流器节点，并自动进入对应的自由画线
// 模式、把该节点设为起点 A(具体从哪个空闲输出口出发，留到落地时按最短路挑选)。
function createSplitterAtClick(ui, clientX, clientY) {
  const hitConn = ui.hitTestConn(clientX, clientY);
  if (!hitConn) return false;
  const worldPos = screenToWorld(clientX, clientY);
  const cell = worldToCell(worldPos.x, worldPos.y);
  const hostConn = hitConn.conn;
  if (!hostConn.cellPath) return false;
  const hit = cellOrientationsOf(hostConn.cellPath, hostConn.startDir, hostConn.goalDir)
    .find(o => o.cell.col === cell.col && o.cell.row === cell.row);
  if (!hit) return false;
  const conflict = ui.checkGroundConflict ? ui.checkGroundConflict(cell.col, cell.row) : false;
  pushHistory();
  const beforeSnapshot = state.history[state.history.length - 1];
  const splitter = splitConnectionAtCell(hostConn, cell, hit.entryDir, hit.exitDir, ui.splitterKind, ui.network);
  if (conflict) splitter.groundConflict = true;
  if (brokeExistingValidConnection(beforeSnapshot, ui.network)) {
    revertLastHistoryStep();
    return false;
  }
  ui.enterMode();
  ui.setStart({ kind: 'anyOutput', deviceId: splitter.id });
  ui.setPreviewPts(null);
  ui.setSelected(null);
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

// ---- 框选批量操作模式(X 键切换)：多选/批量移动/批量旋转/批量删除/复制粘贴 ----
// 与 freeBeltMode/freePipeMode 同级的独占工具，三者互斥。核心状态机：鼠标按下
// 时先记一个"候选态"(boxSelectPointerDown)，具体是"点击切换选中"、"长按启动
// 批量拖动"还是"拖拽退化成框选矩形"三选一，要等后续 mousemove 越过阈值/计时器
// 触发/mouseup 才能确定(见 handleBoxSelectMouseDown 及下面 mousemove 里的分支)。

// 撤销/退出框选模式共用的重置块：清空所有"进行中"的框选交互态。boxSelectMode
// 本身和 clipboard 不在此列(前者是模式开关、后者是持久剪贴板数据，同 E/Q 键
// 的 freeBeltMode/history.js 的 undo() 对这两类状态的处理方式一致)。仅本文件内
// 使用(history.js 的 undo() 按现有风格独立内联自己的一份，不共享)。
function resetBoxSelectTransientState() {
  state.boxSelectedDeviceIds = new Set();
  state.boxSelectedConnectionIds = new Set();
  state.boxSelectedPipeConnectionIds = new Set();
  state.boxSelectPointerDown = null;
  if (state.boxSelectLongPressTimer) clearTimeout(state.boxSelectLongPressTimer);
  state.boxSelectLongPressTimer = null;
  state.boxSelectLongPressToken++;
  state.boxSelectMarquee = null;
  state.boxDragBeforeSnapshot = null;
  state.boxDragOrigin = null;
  state.boxDragConnOrigin = null;
  state.boxDragDeltaCol = 0;
  state.boxDragDeltaRow = 0;
  state.pastePending = false;
  state.pastePreview = null;
}

// E/Q 键入口互相强制关闭对方进行中状态的那个重置块，X 键入口需要同样强制关闭
// 这两个自由画线模式——内联复制一份(和 E/Q 入口目前互相内联对方重置块的写法
// 保持一致，不引入新的跨用途共享抽象)。
function exitFreeBeltAndPipeModes() {
  state.freeBeltMode = false;
  state.freeBeltStart = null;
  state.freeBeltPreviewPts = null;
  state.freeBeltHoverDeviceId = null;
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
  state.lastConduitClickCell = null;
}

function toggleInSet(set, id) {
  if (set.has(id)) set.delete(id); else set.add(id);
}

function boxSelectedConnIdsForNetwork(network) {
  return network === BELT_NETWORK ? state.boxSelectedConnectionIds : state.boxSelectedPipeConnectionIds;
}

// 框选批量移动/旋转时"跟着一起变"的连线集合：端点绑定在被选中设备上的连线
// (设备一动，它自然要跟着走)，并上被显式框选中的连线本身(哪怕它两端都没绑
// 定在被选中的设备上，用户直接选中了这条线，长按它也能单独拖动/随旋转变换)。
// 这个集合同时也是 brokeExistingValidConnection 的 excludeIds：这次操作导致
// 它们变化是预期之内的直接后果，不是牵连到了别的无关连线。
function computeBoxDragAffectedConnIds(network) {
  const merged = connectionsTouchingDevices(state.boxSelectedDeviceIds, network);
  for (const id of boxSelectedConnIdsForNetwork(network)) merged.add(id);
  return merged;
}

// ---- 鼠标按下候选态：点击 / 长按批量拖动 / 退化成框选矩形 三选一 ----

function handleBoxSelectMouseDown(clientX, clientY) {
  const worldPos = screenToWorld(clientX, clientY);
  const hitDev = hitTestDevice(worldPos.x, worldPos.y);
  let hitKind = null, hitId = null, wasSelected = false;
  if (hitDev) {
    hitKind = 'device';
    hitId = hitDev.id;
    wasSelected = state.boxSelectedDeviceIds.has(hitId);
  } else {
    const connResolved = resolveConduitHitAt(clientX, clientY);
    if (connResolved) {
      hitKind = connResolved.network;
      hitId = connResolved.hit.conn.id;
      wasSelected = hitKind === 'pipe'
        ? state.boxSelectedPipeConnectionIds.has(hitId)
        : state.boxSelectedConnectionIds.has(hitId);
    }
  }
  state.boxSelectPointerDown = {
    downX: clientX, downY: clientY,
    downWorldX: worldPos.x, downWorldY: worldPos.y,
    hitKind, hitId, wasSelected
  };
  if (wasSelected) {
    const token = ++state.boxSelectLongPressToken;
    state.boxSelectLongPressTimer = setTimeout(() => onBoxSelectLongPressFire(token), BOX_SELECT_LONG_PRESS_MS);
  }
}

function onBoxSelectLongPressFire(token) {
  if (token !== state.boxSelectLongPressToken) return; // 已被 mouseup/移动阈值取消，过期回调
  if (!state.boxSelectPointerDown) return;
  startBoxSelectDrag();
  draw();
}

function resolveBoxSelectClickToggle() {
  const down = state.boxSelectPointerDown;
  if (!down) return;
  if (down.hitKind === null) {
    state.boxSelectedDeviceIds = new Set();
    state.boxSelectedConnectionIds = new Set();
    state.boxSelectedPipeConnectionIds = new Set();
  } else if (down.hitKind === 'device') {
    toggleInSet(state.boxSelectedDeviceIds, down.hitId);
  } else if (down.hitKind === 'belt') {
    toggleInSet(state.boxSelectedConnectionIds, down.hitId);
  } else if (down.hitKind === 'pipe') {
    toggleInSet(state.boxSelectedPipeConnectionIds, down.hitId);
  }
  if (state.boxSelectLongPressTimer) { clearTimeout(state.boxSelectLongPressTimer); state.boxSelectLongPressTimer = null; }
  state.boxSelectPointerDown = null;
}

// ---- 框选矩形拖拽 ----

function updateBoxSelectMarquee(clientX, clientY) {
  if (!state.boxSelectMarquee) return;
  const worldPos = screenToWorld(clientX, clientY);
  state.boxSelectMarquee.curWX = worldPos.x;
  state.boxSelectMarquee.curWY = worldPos.y;
}

function commitBoxSelectMarquee() {
  const { startWX, startWY, curWX, curWY } = state.boxSelectMarquee;
  const rect = {
    x: Math.min(startWX, curWX), y: Math.min(startWY, curWY),
    w: Math.abs(curWX - startWX), h: Math.abs(curWY - startWY)
  };
  const deviceIds = new Set();
  for (const dev of state.devices) {
    const pos = effectiveGridPos(dev);
    const devRect = getDeviceRectWorld(pos.gridX, pos.gridY, dev.w, dev.h);
    if (rectsOverlapPx(rect, devRect)) deviceIds.add(dev.id);
  }
  // 框选矩形整体替换(不是叠加)当前选中集合——单击才是增/删切换。
  state.boxSelectedDeviceIds = deviceIds;
  state.boxSelectedConnectionIds = boxSelectHitConnections(rect, BELT_NETWORK);
  state.boxSelectedPipeConnectionIds = boxSelectHitConnections(rect, PIPE_NETWORK);
  state.boxSelectMarquee = null;
}

// ---- 长按批量拖动：镜像单设备拖拽的安全网套路，但作用于整个选区 ----

function startBoxSelectDrag() {
  pushHistory();
  state.boxDragBeforeSnapshot = state.history[state.history.length - 1];

  state.boxDragOrigin = new Map();
  for (const id of state.boxSelectedDeviceIds) {
    const dev = state.devices.find(d => d.id === id);
    if (dev) state.boxDragOrigin.set(id, { gridX: dev.gridX, gridY: dev.gridY });
  }

  state.boxDragConnOrigin = new Map();
  for (const network of [BELT_NETWORK, PIPE_NETWORK]) {
    for (const connId of computeBoxDragAffectedConnIds(network)) {
      const conn = network.getConns().find(c => c.id === connId);
      if (!conn) continue;
      state.boxDragConnOrigin.set(connId, {
        network: network.kind,
        fromCell: conn.fromCell ? { ...conn.fromCell } : null,
        toCell: conn.toCell ? { ...conn.toCell } : null,
        waypoints: (conn.waypoints || []).map(wp => ({ ...wp }))
      });
    }
  }

  state.boxDragDeltaCol = 0;
  state.boxDragDeltaRow = 0;
  // 保留 boxSelectPointerDown(不清空)：它的 downWorldX/downWorldY 是这次批量拖动
  // 的位移基准点，updateBoxSelectDrag 每帧据此算整体格偏移；mousemove 的分支
  // 顺序已经把 boxDragOrigin 检查排在 boxSelectPointerDown 前面，不会互相打架。
  if (state.boxSelectLongPressTimer) { clearTimeout(state.boxSelectLongPressTimer); state.boxSelectLongPressTimer = null; }
  canvas.style.cursor = 'grabbing';
}

function updateBoxSelectDrag(clientX, clientY) {
  if (!state.boxDragOrigin || !state.boxSelectPointerDown) return;
  const worldPos = screenToWorld(clientX, clientY);
  const rawDX = worldPos.x - state.boxSelectPointerDown.downWorldX;
  const rawDY = worldPos.y - state.boxSelectPointerDown.downWorldY;
  state.boxDragDeltaCol = Math.round(rawDX / GRID_SIZE);
  state.boxDragDeltaRow = Math.round(rawDY / GRID_SIZE);

  // 从原始值(而非累加)重算每条受影响连线的自由端点/途经点，避免累积误差；
  // 设备本身的实时位置由 devices.js 的 effectiveGridPos() 据 boxDragOrigin +
  // boxDragDeltaCol/Row 现算，这里不用管。
  for (const [connId, origin] of state.boxDragConnOrigin) {
    const network = origin.network === 'pipe' ? PIPE_NETWORK : BELT_NETWORK;
    const conn = network.getConns().find(c => c.id === connId);
    if (!conn) continue;
    conn.fromCell = origin.fromCell ? { col: origin.fromCell.col + state.boxDragDeltaCol, row: origin.fromCell.row + state.boxDragDeltaRow } : null;
    conn.toCell = origin.toCell ? { col: origin.toCell.col + state.boxDragDeltaCol, row: origin.toCell.row + state.boxDragDeltaRow } : null;
    conn.waypoints = origin.waypoints.map(wp => ({ col: wp.col + state.boxDragDeltaCol, row: wp.row + state.boxDragDeltaRow }));
  }
  recomputeAllFlows();
}

function commitBoxSelectDrag() {
  for (const [deviceId, origin] of state.boxDragOrigin) {
    const dev = state.devices.find(d => d.id === deviceId);
    if (dev) {
      dev.gridX = origin.gridX + state.boxDragDeltaCol;
      dev.gridY = origin.gridY + state.boxDragDeltaRow;
    }
  }
  recomputeAllFlows();

  const excludeBelt = new Set(), excludePipe = new Set();
  for (const [connId, origin] of state.boxDragConnOrigin) {
    (origin.network === 'pipe' ? excludePipe : excludeBelt).add(connId);
  }

  if (state.boxDragBeforeSnapshot) {
    const brokeBelt = brokeExistingValidConnection(state.boxDragBeforeSnapshot, BELT_NETWORK, excludeBelt);
    const brokePipe = brokeExistingValidConnection(state.boxDragBeforeSnapshot, PIPE_NETWORK, excludePipe);
    if (brokeBelt || brokePipe) revertLastHistoryStep();
  }

  state.boxDragBeforeSnapshot = null;
  state.boxDragOrigin = null;
  state.boxDragConnOrigin = null;
  state.boxDragDeltaCol = 0;
  state.boxDragDeltaRow = 0;
  state.boxSelectPointerDown = null;
  canvas.style.cursor = 'default';
}

// ---- 批量旋转(R 键)：整个选区绕包围盒中心整体转 90°，不是每个设备各自原地自转 ----
// (用户已确认选这种"整体转向"，代价是非正方形设备混合选中时取整可能有半格漂移)

function performBoxSelectRotate() {
  const ids = state.boxSelectedDeviceIds;
  if (ids.size === 0) return;
  const devs = state.devices.filter(d => ids.has(d.id));
  if (devs.length === 0) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const dev of devs) {
    minX = Math.min(minX, dev.gridX);
    minY = Math.min(minY, dev.gridY);
    maxX = Math.max(maxX, dev.gridX + dev.w);
    maxY = Math.max(maxY, dev.gridY + dev.h);
  }
  const pivotX = (minX + maxX) / 2, pivotY = (minY + maxY) / 2;

  pushHistory();
  const beforeSnapshot = state.history[state.history.length - 1];

  for (const dev of devs) {
    const cx = dev.gridX + dev.w / 2, cy = dev.gridY + dev.h / 2;
    const relX = cx - pivotX, relY = cy - pivotY;
    // 顺时针 90°：(dx,dy) -> (-dy,dx)，和现有 dev.rot=(flowDirOf(dev)+1)%4 /
    // ctx.rotate(dir*PI/2) 的旋转方向一致。
    const newCx = pivotX - relY, newCy = pivotY + relX;
    const newW = dev.h, newH = dev.w;
    dev.gridX = Math.round(newCx - newW / 2);
    dev.gridY = Math.round(newCy - newH / 2);
    dev.w = newW;
    dev.h = newH;
    if (!dev.kind || dev.kind === 'facility') {
      dev.rot = (flowDirOf(dev) + 1) % 4;
    } else {
      // 汇流器/分流器没有 rot 概念(见单设备 R 键的同款限制)，但它们的
      // mainInEdge/mainOutEdge 是固定的朝外方向，作为刚体一起转的一部分，
      // 这两条边也要跟着转 90°，否则组内相对朝向会错位。
      dev.mainInEdge = (dev.mainInEdge + 1) % 4;
      dev.mainOutEdge = (dev.mainOutEdge + 1) % 4;
    }
  }
  for (const dev of devs) clearWaypointsForDevice(dev.id);

  recomputeAllFlows();

  const excludeBelt = computeBoxDragAffectedConnIds(BELT_NETWORK);
  const excludePipe = computeBoxDragAffectedConnIds(PIPE_NETWORK);
  const brokeBelt = brokeExistingValidConnection(beforeSnapshot, BELT_NETWORK, excludeBelt);
  const brokePipe = brokeExistingValidConnection(beforeSnapshot, PIPE_NETWORK, excludePipe);
  if (brokeBelt || brokePipe) revertLastHistoryStep();
  draw();
}

// ---- 批量删除(Delete/Backspace)----
// 两端都在被删设备集合内的连线整体移除；只有一端在内的降级为悬空 stub(复用
// pathfinding.js 抽出来的 detachDeviceFromConnections，和单设备删除同一套逻辑)；
// 被显式框选中的连线本身无论端点如何一律整体移除。

function performBoxSelectDelete() {
  const deviceIds = state.boxSelectedDeviceIds;
  const explicitBelt = state.boxSelectedConnectionIds;
  const explicitPipe = state.boxSelectedPipeConnectionIds;
  if (deviceIds.size === 0 && explicitBelt.size === 0 && explicitPipe.size === 0) return;

  pushHistory();

  for (const network of [BELT_NETWORK, PIPE_NETWORK]) {
    const explicit = boxSelectedConnIdsForNetwork(network);
    const removeIds = new Set(explicit);
    for (const c of network.getConns()) {
      const fromIn = c.fromDeviceId !== null && deviceIds.has(c.fromDeviceId);
      const toIn = c.toDeviceId !== null && deviceIds.has(c.toDeviceId);
      if (fromIn && toIn) removeIds.add(c.id);
    }
    network.setConns(network.getConns().filter(c => !removeIds.has(c.id)));
  }

  // 只剩"只有一端在被删集合内"的连线：分离成悬空端点，必须在移除设备本身之前
  // 做(detachDeviceFromConnections 要读取设备当前端口位置)。
  for (const deviceId of deviceIds) {
    detachDeviceFromConnections(deviceId, BELT_NETWORK);
    detachDeviceFromConnections(deviceId, PIPE_NETWORK);
  }

  state.devices = state.devices.filter(d => !deviceIds.has(d.id));
  resetBoxSelectTransientState();
  recomputeAllFlows();
  draw();
}

// ---- 复制(Ctrl+C) / 粘贴(Ctrl+V，跟随鼠标预览，左键落地/右键或 Esc 取消) ----

// 连线是否有资格进入剪贴板：两端(如果绑定了设备)都必须在被复制的设备集合内
// (否则粘贴时会指向一个不存在于剪贴板里的设备，无法重新映射)；此外普通情况
// 下还要求至少有一端绑定在被复制的设备上——单纯"被显式框选中的连线本身"是
// 唯一的例外(即使它两端都是自由网格端点、没有绑定任何设备)，让用户能专门
// 复制一段悬空的传送带/管道 stub。
function connectionQualifiesForClipboard(conn, deviceIds, explicitlySelected) {
  const fromOk = conn.fromDeviceId === null || deviceIds.has(conn.fromDeviceId);
  const toOk = conn.toDeviceId === null || deviceIds.has(conn.toDeviceId);
  if (!fromOk || !toOk) return false;
  if (explicitlySelected.has(conn.id)) return true;
  return (conn.fromDeviceId !== null && deviceIds.has(conn.fromDeviceId)) ||
         (conn.toDeviceId !== null && deviceIds.has(conn.toDeviceId));
}

// 只保留拓扑信息(端点/途经点)，points/cellPath/startDir/goalDir/invalid 等寻路
// 衍生字段一律不带走——粘贴落地后统一靠 computePath 按新位置重新算。
function cloneConnForClipboard(conn) {
  return {
    fromDeviceId: conn.fromDeviceId, fromPort: conn.fromPort,
    fromCell: conn.fromCell ? { ...conn.fromCell } : null,
    toDeviceId: conn.toDeviceId, toPort: conn.toPort,
    toCell: conn.toCell ? { ...conn.toCell } : null,
    waypoints: (conn.waypoints || []).map(wp => ({ ...wp }))
  };
}

function buildClipboardFromSelection() {
  const deviceIds = state.boxSelectedDeviceIds;
  if (deviceIds.size === 0 && state.boxSelectedConnectionIds.size === 0 && state.boxSelectedPipeConnectionIds.size === 0) return;

  const devices = state.devices.filter(d => deviceIds.has(d.id)).map(d => JSON.parse(JSON.stringify(d)));
  const connections = BELT_NETWORK.getConns()
    .filter(c => connectionQualifiesForClipboard(c, deviceIds, state.boxSelectedConnectionIds))
    .map(cloneConnForClipboard);
  const pipeConnections = PIPE_NETWORK.getConns()
    .filter(c => connectionQualifiesForClipboard(c, deviceIds, state.boxSelectedPipeConnectionIds))
    .map(cloneConnForClipboard);

  let anchorCol = Infinity, anchorRow = Infinity;
  for (const d of devices) {
    anchorCol = Math.min(anchorCol, d.gridX);
    anchorRow = Math.min(anchorRow, d.gridY);
  }
  if (!isFinite(anchorCol)) { anchorCol = 0; anchorRow = 0; }

  state.clipboard = { devices, connections, pipeConnections, anchorCol, anchorRow };
}

function updatePastePreview(clientX, clientY) {
  const worldPos = screenToWorld(clientX, clientY);
  const cell = worldToCell(worldPos.x, worldPos.y);
  state.pastePreview = { originCol: cell.col, originRow: cell.row };
}

function cancelPastePending() {
  state.pastePending = false;
  state.pastePreview = null;
}

function commitPaste() {
  if (!state.clipboard || !state.pastePreview) return;
  const dCol = state.pastePreview.originCol - state.clipboard.anchorCol;
  const dRow = state.pastePreview.originRow - state.clipboard.anchorRow;

  pushHistory();
  const beforeSnapshot = state.history[state.history.length - 1];

  const idMap = new Map();
  const newDeviceIds = new Set();
  for (const dev of state.clipboard.devices) {
    const newId = state.nextId++;
    idMap.set(dev.id, newId);
    newDeviceIds.add(newId);
    state.devices.push({ ...dev, id: newId, gridX: dev.gridX + dCol, gridY: dev.gridY + dRow });
  }

  const newBeltIds = new Set();
  const newPipeIds = new Set();
  for (const network of [BELT_NETWORK, PIPE_NETWORK]) {
    const clipConns = network === BELT_NETWORK ? state.clipboard.connections : state.clipboard.pipeConnections;
    const newIds = network === BELT_NETWORK ? newBeltIds : newPipeIds;
    for (const c of clipConns) {
      const newId = network.nextId();
      newIds.add(newId);
      network.getConns().push({
        id: newId,
        fromDeviceId: c.fromDeviceId !== null ? idMap.get(c.fromDeviceId) : null,
        fromPort: c.fromPort,
        fromCell: c.fromCell ? { col: c.fromCell.col + dCol, row: c.fromCell.row + dRow } : null,
        toDeviceId: c.toDeviceId !== null ? idMap.get(c.toDeviceId) : null,
        toPort: c.toPort,
        toCell: c.toCell ? { col: c.toCell.col + dCol, row: c.toCell.row + dRow } : null,
        waypoints: c.waypoints.map(wp => ({ col: wp.col + dCol, row: wp.row + dRow })),
        points: [], cellPath: null, startDir: null, goalDir: null, invalid: false
      });
    }
  }

  recomputeAllFlows();

  // 粘贴设备属于"放置操作"，和工具栏生成新设备走同一条硬性规则：不能顺手压垮
  // 一条操作前合法的连线，坏了整体撤销这次粘贴；新粘贴的连线自己是否 invalid
  // 不受影响(维持"画/贴到不可达位置，留给用户调整"的既有行为)。
  const brokeBelt = brokeExistingValidConnection(beforeSnapshot, BELT_NETWORK, newBeltIds);
  const brokePipe = brokeExistingValidConnection(beforeSnapshot, PIPE_NETWORK, newPipeIds);
  if (brokeBelt || brokePipe) {
    revertLastHistoryStep();
  } else {
    // 成功落地后新粘贴的这批直接成为当前框选选中集合，方便接着微调。
    state.boxSelectedDeviceIds = newDeviceIds;
    state.boxSelectedConnectionIds = newBeltIds;
    state.boxSelectedPipeConnectionIds = newPipeIds;
  }
  state.pastePending = false;
  state.pastePreview = null;
}

// ---- 画布内鼠标交互：平移 / 选中 / 拖拽已有设备 ----

function bindCanvasMouseEvents() {
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 2) return; // 右键交给 contextmenu 处理(退出自由传送带模式/框选模式/取消待粘贴)

    if (state.pastePending) {
      if (e.button === 0) commitPaste();
      draw();
      return;
    }

    if (state.boxSelectMode) {
      if (e.button !== 0) return;
      handleBoxSelectMouseDown(e.clientX, e.clientY);
      draw();
      return;
    }

    // Alt+左键点击已有传送带/管道：无论当前是否已在画线模式中，都优先生成分流器；
    // 管道是视觉上层，优先尝试生成管道分流器，否则退回生成传送带分流器。
    if (e.altKey && e.button === 0) {
      if (createSplitterAtClick(PIPE_UI, e.clientX, e.clientY)) {
        draw();
        return;
      }
      if (createSplitterAtClick(BELT_UI, e.clientX, e.clientY)) {
        draw();
        return;
      }
    }

    if (state.freeBeltMode) {
      if (e.button !== 0) return;
      if (!state.freeBeltStart) {
        const start = resolveFreeStartClick(BELT_UI, e.clientX, e.clientY);
        if (start) {
          state.freeBeltStart = start;
          updateFreePreview(BELT_UI, e.clientX, e.clientY);
          draw();
        }
      } else {
        const end = resolveFreeEndClick(BELT_UI, e.clientX, e.clientY);
        if (end) finalizeFreeConnection(BELT_UI, end, e.clientX, e.clientY);
      }
      return;
    }

    if (state.freePipeMode) {
      if (e.button !== 0) return;
      if (!state.freePipeStart) {
        const start = resolveFreeStartClick(PIPE_UI, e.clientX, e.clientY);
        if (start) {
          state.freePipeStart = start;
          updateFreePreview(PIPE_UI, e.clientX, e.clientY);
          draw();
        }
      } else {
        const end = resolveFreeEndClick(PIPE_UI, e.clientX, e.clientY);
        if (end) finalizeFreeConnection(PIPE_UI, end, e.clientX, e.clientY);
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
    const inPortHit = findPortAt(e.clientX, e.clientY, 'input', 'belt');
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

  // 右键：退出自由传送带/自由管道/框选模式，或取消待粘贴(阻止浏览器默认右键菜单)
  canvas.addEventListener('contextmenu', (e) => {
    if (state.pastePending) {
      e.preventDefault();
      cancelPastePending();
      draw();
      return;
    }
    if (state.boxSelectMode) {
      e.preventDefault();
      resetBoxSelectTransientState();
      state.boxSelectMode = false;
      canvas.style.cursor = 'default';
      updateHintText();
      draw();
      return;
    }
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
    if (state.pastePending) {
      updatePastePreview(e.clientX, e.clientY);
      draw();
      return;
    }
    if (state.boxDragOrigin) {
      updateBoxSelectDrag(e.clientX, e.clientY);
      draw();
      return;
    }
    if (state.boxSelectMarquee) {
      updateBoxSelectMarquee(e.clientX, e.clientY);
      draw();
      return;
    }
    if (state.boxSelectPointerDown) {
      const dx = e.clientX - state.boxSelectPointerDown.downX, dy = e.clientY - state.boxSelectPointerDown.downY;
      if (dx * dx + dy * dy > 16) {
        if (state.boxSelectLongPressTimer) { clearTimeout(state.boxSelectLongPressTimer); state.boxSelectLongPressTimer = null; }
        const wx = state.boxSelectPointerDown.downWorldX, wy = state.boxSelectPointerDown.downWorldY;
        state.boxSelectPointerDown = null;
        state.boxSelectMarquee = { startWX: wx, startWY: wy, curWX: wx, curWY: wy };
        updateBoxSelectMarquee(e.clientX, e.clientY);
        draw();
      }
      return;
    }
    if (state.freeBeltMode) {
      // 无论是否已选定起点 A，都要实时更新设备本体悬停高亮；已选定 A 时还要更新路径预览
      updateFreePreview(BELT_UI, e.clientX, e.clientY);
      canvas.style.cursor = 'crosshair';
      draw();
      return;
    }
    if (state.freePipeMode) {
      updateFreePreview(PIPE_UI, e.clientX, e.clientY);
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
    if (state.boxDragOrigin) {
      commitBoxSelectDrag();
      draw();
      return;
    }
    if (state.boxSelectMarquee) {
      commitBoxSelectMarquee();
      draw();
      return;
    }
    if (state.boxSelectPointerDown) {
      resolveBoxSelectClickToggle();
      draw();
      return;
    }
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
        const portHit = findPortAt(e.clientX, e.clientY, 'input', 'belt');
        if (portHit && !isInputPortUsed(portHit.deviceId, portHit.index) && portHit.deviceId !== conn.fromDeviceId) {
          target = { deviceId: portHit.deviceId, index: portHit.index };
        } else {
          const worldPos = screenToWorld(e.clientX, e.clientY);
          const hitDev = hitTestDevice(worldPos.x, worldPos.y);
          if (hitDev && hitDev.id !== conn.fromDeviceId) {
            const pos = effectiveGridPos(hitDev);
            const avail = getDevicePorts(hitDev, pos).inputs.filter(p => p.portKind === 'belt' && !isInputPortUsed(hitDev.id, p.index));
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
        const prevGridX = dev.gridX, prevGridY = dev.gridY;
        dev.gridX = Math.round(state.dragDeviceWX / GRID_SIZE);
        dev.gridY = Math.round(state.dragDeviceWY / GRID_SIZE);
        const actuallyMoved = dev.gridX !== prevGridX || dev.gridY !== prevGridY;
        // 只在设备真的挪到了新格子时才清空手动途经点：单纯点击选中(松手时格子
        // 坐标和拖拽前一致)不应该顺手抹掉用户为这台设备的连线摆的造型。
        if (actuallyMoved) clearWaypointsForDevice(dev.id);
        recomputeAllFlows();
        // 落位后如果把某条操作前合法的连线拖成 invalid(哪怕设备本身跟那条连线
        // 毫不相干，只是新位置挤占/绕开了它寻路需要用到的格子)，不接受这次移动，
        // 整体还原回拖拽前的位置和连线状态——设备重叠仍然只是警示、不阻挡放置，
        // 这里只管"别的连线被顺手拖坏"这一种情况。通用设备拖拽两个网络都要查，
        // 和 finalizeFreeConnection/createSplitterAtClick 传 PIPE_UI 时"故意只查
        // PIPE_NETWORK"的地面冲突例外不是一回事。
        let reverted = false;
        if (state.draggingDeviceBeforeSnapshot) {
          const brokeBelt = brokeExistingValidConnection(state.draggingDeviceBeforeSnapshot, BELT_NETWORK);
          const brokePipe = brokeExistingValidConnection(state.draggingDeviceBeforeSnapshot, PIPE_NETWORK);
          if (brokeBelt || brokePipe) {
            revertLastHistoryStep();
            reverted = true;
          }
        }
        // 真的挪动过位置(不是单纯点击选中)且这次移动被接受时，落位后自动取消选中，
        // 不需要用户再点一下空白处才能清掉高亮——单纯点击选中的手感不受影响。
        if (actuallyMoved && !reverted) state.selectedId = null;
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

    // 复制/粘贴只在框选批量操作模式内生效，不在普通模式/自由画线模式下抢占
    // Ctrl+C/V(这两个模式各自没有"复制"的概念)。
    if (state.boxSelectMode && (e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      buildClipboardFromSelection();
      return;
    }
    if (state.boxSelectMode && !state.pastePending && state.clipboard && (e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault();
      state.pastePending = true;
      state.pastePreview = null;
      draw();
      return;
    }

    if (e.key === 'Escape') {
      if (state.pastePending) {
        e.preventDefault();
        cancelPastePending();
        draw();
        return;
      }
      if (state.boxSelectMode) {
        e.preventDefault();
        resetBoxSelectTransientState();
        state.boxSelectMode = false;
        canvas.style.cursor = 'default';
        updateHintText();
        draw();
        return;
      }
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
        // 画线工具(自由管道模式)和框选批量操作模式的进行中状态——三者互斥。
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
        resetBoxSelectTransientState();
        state.boxSelectMode = false;
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
        // 镜像上面的 E 键处理，且互斥清空自由传送带模式和框选批量操作模式的
        // 进行中状态。
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
        resetBoxSelectTransientState();
        state.boxSelectMode = false;
        canvas.style.cursor = 'crosshair';
      } else {
        canvas.style.cursor = 'default';
      }
      updateHintText();
      draw();
      return;
    }

    if (e.key === 'x' || e.key === 'X') {
      e.preventDefault();
      state.boxSelectMode = !state.boxSelectMode;
      resetBoxSelectTransientState();
      if (state.boxSelectMode) {
        // 进入框选模式即为独占工具：强制退出另外两个自由画线模式(镜像 E/Q 入口
        // 互相强制关闭对方的写法)，并清空普通模式下的单选态。
        exitFreeBeltAndPipeModes();
        state.selectedId = null;
        state.selectedConnectionId = null;
        state.selectedPipeConnectionId = null;
        canvas.style.cursor = 'crosshair';
      } else {
        canvas.style.cursor = 'default';
      }
      updateHintText();
      draw();
      return;
    }

    if (e.key === 'r' || e.key === 'R') {
      if (state.boxSelectMode && state.boxSelectedDeviceIds.size > 0) {
        e.preventDefault();
        performBoxSelectRotate();
        return;
      }
      if (state.selectedId === null) return;
      const dev = state.devices.find(d => d.id === state.selectedId);
      // 汇流器/分流器(传送带版和管道版)的朝向由被切入的原连线决定，不支持手动旋转；
      // 真实基建设备(facility)允许旋转，端口作为刚体整体随旋转角度转动。
      if (!dev || (dev.kind && dev.kind !== 'facility')) return;
      e.preventDefault();
      pushHistory();
      const beforeSnapshot = state.history[state.history.length - 1];
      dev.rot = (flowDirOf(dev) + 1) % 4;
      // facility 设备大多不是正方形(拆解机6x4、协议核心9x9等)，旋转是真的绕
      // 中心转外形，宽高会互换；正方形设备(如粉碎机)互换后数值不变，这里不用
      // 分情况处理。
      const tmp = dev.w;
      dev.w = dev.h;
      dev.h = tmp;
      recomputeAllFlows();
      // 旋转会改变非正方形 facility 设备实际占用的格子，理论上可能像"设备拖拽/
      // 生成新设备"一样顺手压中另一条操作前合法的连线，按 CLAUDE.md 的规矩这里
      // 也要做同样的安全网检查，坏了就整体撤销这次旋转。
      const brokeBelt = brokeExistingValidConnection(beforeSnapshot, BELT_NETWORK);
      const brokePipe = brokeExistingValidConnection(beforeSnapshot, PIPE_NETWORK);
      if (brokeBelt || brokePipe) {
        revertLastHistoryStep();
      }
      draw();
      return;
    }

    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (state.boxSelectMode && (state.boxSelectedDeviceIds.size > 0 || state.boxSelectedConnectionIds.size > 0 || state.boxSelectedPipeConnectionIds.size > 0)) {
      e.preventDefault();
      performBoxSelectDelete();
      return;
    }
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
      // 模式下选中/删除，或拖拽途经点调整。两个网络的分离逻辑抽成了
      // pathfinding.js 的 detachDeviceFromConnections，批量删除(performBoxSelectDelete)
      // 复用同一份。
      const dev = state.devices.find(d => d.id === state.selectedId);
      if (dev) {
        detachDeviceFromConnections(state.selectedId, BELT_NETWORK);
        detachDeviceFromConnections(state.selectedId, PIPE_NETWORK);
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

// 按 SPAWN_TEMPLATES 的 category 生成标签栏(去重、保留 FACILITIES 的分类顺序)
// 和每个分类的设备图标，一次性全部造好挂进 DOM，用 CSS display 按当前选中的
// state.activeToolbarCategory 切换显示——这样只需要绑定一次事件(见下面的事件
// 委托)，不用每次切换标签页重新生成/重新绑定。
function buildToolbarUI() {
  const categories = [...new Set(SPAWN_TEMPLATES.map(t => t.category))];
  state.activeToolbarCategory = categories[0];

  for (const category of categories) {
    const tab = document.createElement('div');
    tab.className = 'toolbar-tab';
    tab.textContent = category;
    tab.dataset.category = category;
    toolbarTabs.appendChild(tab);
  }
  for (const template of SPAWN_TEMPLATES) {
    const icon = document.createElement('div');
    icon.className = 'device-icon';
    icon.textContent = template.label;
    icon.dataset.key = template.key;
    icon.dataset.category = template.category;
    toolbarIcons.appendChild(icon);
  }
  refreshToolbarActiveTab();
}

function refreshToolbarActiveTab() {
  for (const tab of toolbarTabs.children) {
    tab.classList.toggle('active', tab.dataset.category === state.activeToolbarCategory);
  }
  for (const icon of toolbarIcons.children) {
    icon.style.display = icon.dataset.category === state.activeToolbarCategory ? 'flex' : 'none';
  }
}

function bindToolbarSpawnEvents() {
  buildToolbarUI();

  toolbarTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.toolbar-tab');
    if (!tab) return;
    state.activeToolbarCategory = tab.dataset.category;
    refreshToolbarActiveTab();
  });

  // 事件委托：图标是动态生成的，数量随 FACILITIES 增减也不用改这里，一个
  // mousedown 监听器管全部图标，按被点中图标的 dataset.key 查 SPAWN_TEMPLATES。
  toolbarIcons.addEventListener('mousedown', (e) => {
    const icon = e.target.closest('.device-icon');
    if (!icon) return;
    e.preventDefault();
    const key = icon.dataset.key;
    state.spawning = true;
    state.spawningTemplateKey = key;
    ghostIcon.style.display = 'flex';
    ghostIcon.textContent = SPAWN_TEMPLATES.find(t => t.key === key).label;
    ghostIcon.style.left = (e.clientX - 28) + 'px';
    ghostIcon.style.top = (e.clientY - 28) + 'px';
    updateSpawnPreview(e.clientX, e.clientY);
  });

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
        label: template.label,
        // facility 设备专属：facilityId 标记它是 facilities.js 里哪个设备种类
        // (和 dev.id 这个"实例编号"是两回事)；ports 是该种类的原始端口数据，
        // 落地时整体拷贝一份到实例上，供 getDevicePorts() 的 facilityDevicePorts
        // 分支使用，不用在渲染/寻路时反过来查 FACILITIES——这样 cloneCanvasState()
        // 的无差别深拷贝天然就能把它带过 Ctrl+Z 撤销栈，不用额外处理。
        ...(template.kind === 'facility' ? { facilityId: template.key, ports: template.ports } : {})
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
