// ---- 交互：画布内鼠标/键盘事件绑定、自由传送带/自由管道模式状态机、工具栏拖拽生成新设备 ----
import { GRID_SIZE, HINT_NORMAL, HINT_BELT, HINT_PIPE, HINT_BOX_SELECTED } from './constants.js';
import {
  state, canvas, toolbar, toolbarTabs, toolbarIcons, hintEl, mapSelectEl,
  mapConfirmOverlayEl, mapConfirmMessageEl, mapConfirmCancelEl, mapConfirmOkEl,
  recipePanelOverlayEl, recipePanelTitleEl, recipePanelBodyEl, recipePanelClearAllEl, recipePanelCloseEl,
  itemPickerOverlayEl, itemPickerDrawerEl, itemPickerSearchEl, itemPickerCancelEl, itemPickerTabsEl, itemPickerGridEl,
  itemLookupPopoverEl, itemLookupTitleEl, itemLookupProducersEl, itemLookupConsumersEl
} from './state.js';
import { screenToWorld, worldToCell } from './coords.js';
import {
  hitTestDevice, findPortAt, effectiveGridPos, getDevicePorts, getDeviceRectWorld, rectsOverlapPx,
  isInputPortUsed, isOutputPortUsed, isPipeInputPortUsed, isPipeOutputPortUsed,
  flowDirOf, SPAWN_TEMPLATES, findWarningIconAt, getSpawnOrientedFields
} from './devices.js';
import { MAP_CATALOG } from './data/maps.js';
import { FACILITIES } from './data/facilities.js';
import { isCellInMapBounds } from './mapBounds.js';
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
import {
  getSlotPanelKind, getFacilitySlotSpec, buildInitialSlotState, computeSlotCandidates,
  getRelevantItemIds, setSlotValue, clearAllSlots, INPUT_GROUPS, OUTPUT_GROUPS, getPortSlotDescriptors,
  CATALYST_ITEM_BY_FACILITY, getItemUpstreamDownstream
} from './recipeSlots.js';
import { ITEMS, ITEM_BY_ID } from './data/items.js';

// 框选批量选中不是一个需要切换进入的独立模式，是否显示它的提示纯粹看当前
// 是否有多选内容(三个 boxSelected*Ids 集合任一非空)，因此单独抽出这个判断,
// 供 updateHintText 和 mousedown 里"点别处清空多选"的分支共用。
function hasBoxSelection() {
  return state.boxSelectedDeviceIds.size > 0 || state.boxSelectedConnectionIds.size > 0 || state.boxSelectedPipeConnectionIds.size > 0;
}

export function updateHintText() {
  hintEl.textContent = state.freeBeltMode ? HINT_BELT
    : state.freePipeMode ? HINT_PIPE
    : hasBoxSelection() ? HINT_BOX_SELECTED
    : HINT_NORMAL;
  hintEl.classList.toggle('belt-mode', state.freeBeltMode);
  hintEl.classList.toggle('pipe-mode', state.freePipeMode);
  hintEl.classList.toggle('box-select-mode', hasBoxSelection());
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
  getStartDownPos: () => state.freeBeltStartDownPos,
  setStartDownPos: v => { state.freeBeltStartDownPos = v; },
  getPreviewPts: () => state.freeBeltPreviewPts,
  setPreviewPts: v => { state.freeBeltPreviewPts = v; },
  setHoverDeviceId: v => { state.freeBeltHoverDeviceId = v; },
  isOutputPortUsed, isInputPortUsed,
  hitTestConn: hitTestConnection,
  splitterKind: 'splitter', mergerKind: 'merger',
  checkGroundConflict: null, // 传送带侧没有地面冲突检查，见 groundHasBeltConflict 的注释
  enforceMapBounds: true, // 传送带仍然受地图边界约束，管道全面豁免(见 PIPE_UI)
  enterMode: () => { state.freeBeltMode = true; },
  setSelected: id => { state.selectedId = null; state.selectedConnectionId = id; },
};
const PIPE_UI = {
  network: PIPE_NETWORK,
  portKind: 'pipe',
  getStart: () => state.freePipeStart,
  setStart: v => { state.freePipeStart = v; },
  getStartDownPos: () => state.freePipeStartDownPos,
  setStartDownPos: v => { state.freePipeStartDownPos = v; },
  getPreviewPts: () => state.freePipePreviewPts,
  setPreviewPts: v => { state.freePipePreviewPts = v; },
  setHoverDeviceId: v => { state.freePipeHoverDeviceId = v; },
  isOutputPortUsed: isPipeOutputPortUsed, isInputPortUsed: isPipeInputPortUsed,
  hitTestConn: hitTestPipeConnection,
  splitterKind: 'pipe-splitter', mergerKind: 'pipe-merger',
  checkGroundConflict: groundHasBeltConflict,
  enforceMapBounds: false, // 管道系统全面豁免地图边界(用户已确认)
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
  const best = pickBestPort(avail, towardCol, towardRow, null, true, blocked, occupancy, ui.network);
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
  if (ui.enforceMapBounds && !isCellInMapBounds(cell.col, cell.row)) {
    showCursorTooltip('无法在地图边界外起始画线', clientX, clientY);
    return null;
  }
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
    const blocked = buildBlockedSet(ui.network);
    const occupancy = ui.network.buildOccupancy(null);
    // 用第一个候选输入口的外侧格子(必定在设备footprint之外、不会被阻挡)作为
    // 解析起点(尤其是分流器 anyOutput 起点)时的寻路参照，而不是设备本体的
    // 原点格(那格本身就在设备footprint内部，会被当成障碍导致寻路失败)。
    const startResolved = resolveFreeStartForPathing(ui, avail[0].cellCol, avail[0].cellRow, blocked, occupancy);
    const refCol = startResolved ? startResolved.col : pos.gridX;
    const refRow = startResolved ? startResolved.row : pos.gridY;
    const refDir = startResolved ? startResolved.dir : null;
    const best = pickBestPort(avail, refCol, refRow, refDir, false, blocked, occupancy, ui.network);
    if (!best) return null;
    return { kind: 'port', deviceId: hitDev.id, port: best.index };
  }
  const cell = worldToCell(worldPos.x, worldPos.y);
  const dangling = findDanglingConnAtCell(cell.col, cell.row, ui.network);
  if (dangling && dangling.end === 'from') return { kind: 'free', col: cell.col, row: cell.row, continuesConn: dangling.conn };
  const hitConn = ui.hitTestConn(clientX, clientY);
  if (hitConn) return { kind: 'merge', conn: hitConn.conn };
  if (ui.enforceMapBounds && !isCellInMapBounds(cell.col, cell.row)) {
    showCursorTooltip('无法在地图边界外结束画线', clientX, clientY);
    return null;
  }
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
  // 划过候选目标端口时实时预览填色(见 render.js drawPortMarker 的 'target' 态)；
  // 新连线只能落在输入口上，portType 恒为 'input'。每次调用都无条件刷新，
  // 天然自愈，不需要额外的清空逻辑。
  state.dragTargetPort = hoverInPort
    ? { deviceId: hoverInPort.deviceId, index: hoverInPort.index, portKind: ui.portKind, portType: 'input' }
    : null;
  if (!findPortAt(hoverClientX, hoverClientY, 'output', ui.portKind) && !hoverInPortRaw) {
    const hovered = hitTestDevice(worldPos.x, worldPos.y);
    ui.setHoverDeviceId(hovered ? hovered.id : null);
  } else {
    ui.setHoverDeviceId(null);
  }
  if (!ui.getStart()) return;
  const hoverCell = hoverInPort ? { col: hoverInPort.cellCol, row: hoverInPort.cellRow } : worldToCell(worldPos.x, worldPos.y);
  const blocked = buildBlockedSet(ui.network);
  const occupancy = ui.network.buildOccupancy(null);

  const startResolved = resolveFreeStartForPathing(ui, hoverCell.col, hoverCell.row, blocked, occupancy);
  if (!startResolved) return;

  const cellPath = aStarOrthogonal(startResolved.col, startResolved.row, startResolved.dir, hoverCell.col, hoverCell.row, null, blocked, occupancy, ui.network);
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

  const blocked = buildBlockedSet(ui.network);
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
    const best = pickBestPort(avail, roughTargetCol, roughTargetRow, null, true, blocked, occupancy, ui.network);
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
    const bestInput = pickBestPort(availInputs, startResolved.cellCol, startResolved.cellRow, startResolved.dir, false, blocked, occupancy, ui.network);
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

// "起点按下拖拽→终点松手"手感支持：配合 mousedown 里设起点 A 时记下的
// state.freeBeltStartDownPos/freePipeStartDownPos(见 state.js 该字段注释)，
// 在紧跟着的下一次 mouseup 里判断这段时间鼠标是否真的挪动过——挪动超过阈值
// 才当作一次拖拽画线，直接解析终点并落地；原地不动(或抖动量在阈值内)则视为
// 单纯"点一下设起点"的第一次点击，不做任何事，保留起点等用户后续再点一次终点
// (即"点击起点→点击终点"这套既有手感)。阈值沿用项目里框选批量拖拽同款的
// dx*dx+dy*dy>16(4px)。downPos 每次调用都会被消费掉(置回 null)，所以只有
// "刚设完起点、还没经历过一次 mouseup"这一次窗口期内会触发，第二次点击终点
// 那次 click 已经在 mousedown 的 else 分支里同步完成，不会重复触发这里。
function resolveDragReleaseEnd(ui, clientX, clientY) {
  const downPos = ui.getStartDownPos();
  ui.setStartDownPos(null);
  if (!downPos || !ui.getStart()) return;
  const dx = clientX - downPos.x, dy = clientY - downPos.y;
  if (dx * dx + dy * dy <= 16) return;
  const end = resolveFreeEndClick(ui, clientX, clientY);
  if (end) finalizeFreeConnection(ui, end, clientX, clientY);
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

// ---- 框选批量操作：多选/批量移动/批量旋转/批量删除/复制粘贴 ----
// 不是一个需要 X 键切换进入/退出的独立模式(早期版本是，长按已选中项才能触发
// 批量拖动，实测手感别扭，已改掉)——普通模式下随时可用：按住 Ctrl 拖动鼠标拉
// 出矩形框选，选中后直接按住已选中项拖拽就能整体移动，不需要等长按计时器。
// 核心状态机：鼠标按下时，只有落在"已经被框选中"的设备/连线上才会记一个候选态
// (boxSelectPointerDown)，区分接下来是"没挪动=点击切换选中"还是"挪动过阈值=
// 立即整体拖动"，具体是哪种要等 mousemove 越过阈值或 mouseup 才能确定(见下面
// mousedown 里对 boxSelectedDeviceIds/boxSelectedConnectionIds/boxSelectedPipeConnectionIds
// 的命中判断，以及 mousemove 里的分支)。仍然和 freeBeltMode/freePipeMode 互斥，
// 进入这两个画线工具会清空当前多选(见 E/Q 键入口分支)。

// 清空框选多选状态的公共重置块：点击框选集合之外的任何东西、进入画线工具、
// 批量删除、Esc/右键都会用到。clipboard 不在此列，它是持久剪贴板数据，不是
// "进行到一半"的交互态(同 E/Q 键的 freeBeltMode/history.js 的 undo() 对这两类
// 状态的处理方式一致)。仅本文件内使用(history.js 的 undo() 按现有风格独立内联
// 自己的一份，不共享)。调用后立即刷新提示胶囊文字，因为"是否有框选选中项"
// 直接决定显示哪条提示。
function resetBoxSelectTransientState() {
  state.boxSelectedDeviceIds = new Set();
  state.boxSelectedConnectionIds = new Set();
  state.boxSelectedPipeConnectionIds = new Set();
  state.boxSelectPointerDown = null;
  state.boxSelectMarquee = null;
  state.boxDragOrigin = null;
  state.boxDragConnOrigin = null;
  state.boxDragDeltaCol = 0;
  state.boxDragDeltaRow = 0;
  state.pastePending = false;
  state.pastePreview = null;
  updateHintText();
}

function toggleInSet(set, id) {
  if (set.has(id)) set.delete(id); else set.add(id);
}

function boxSelectedConnIdsForNetwork(network) {
  return network === BELT_NETWORK ? state.boxSelectedConnectionIds : state.boxSelectedPipeConnectionIds;
}

// 框选批量拖拽时"跟着一起变"的连线集合：端点绑定在被选中设备上的连线(设备
// 一动，它自然要跟着走)，并上被显式框选中的连线本身(哪怕它两端都没绑定在被
// 选中的设备上，用户直接选中了这条线，拖拽它也能单独移动)。供 startBoxSelectDrag
// 记录这些连线开始拖动前的 fromCell/toCell/waypoints，供每帧从原始值重算。
function computeBoxDragAffectedConnIds(network) {
  const merged = connectionsTouchingDevices(state.boxSelectedDeviceIds, network);
  for (const id of boxSelectedConnIdsForNetwork(network)) merged.add(id);
  return merged;
}

// ---- 鼠标按下候选态：点击切换选中 / 立即整体拖动 二选一 ----
// 只有 mousedown 命中的目标已经在框选集合里时，调用方(见下面 bindCanvasMouseEvents
// 里设备/连线命中分支)才会调这个函数记候选态；命中不在集合内的目标不算数，
// 直接退回普通单选/拖拽，不经过这里。

function startGroupSelectionPointerDown(clientX, clientY, hitKind, hitId) {
  const worldPos = screenToWorld(clientX, clientY);
  state.boxSelectPointerDown = {
    downX: clientX, downY: clientY,
    downWorldX: worldPos.x, downWorldY: worldPos.y,
    hitKind, hitId
  };
}

function resolveBoxSelectClickToggle() {
  const down = state.boxSelectPointerDown;
  if (!down) return;
  if (down.hitKind === 'device') {
    toggleInSet(state.boxSelectedDeviceIds, down.hitId);
  } else if (down.hitKind === 'belt') {
    toggleInSet(state.boxSelectedConnectionIds, down.hitId);
  } else if (down.hitKind === 'pipe') {
    toggleInSet(state.boxSelectedPipeConnectionIds, down.hitId);
  }
  state.boxSelectPointerDown = null;
  updateHintText();
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
  canvas.style.cursor = 'default';
  updateHintText();
}

// ---- 批量拖动(按住已选中项直接拖动触发，不需要长按)：镜像单设备拖拽的安全网
// 套路，但作用于整个选区 ----

function startBoxSelectDrag() {
  pushHistory();

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
  // 批量拖动进行中(boxDragOrigin 非空)时禁止旋转：拖动预览和松手落位都是靠
  // boxDragOrigin 记录的"拖动开始前坐标" + boxDragDeltaCol/Row 现算(见
  // effectiveGridPos/commitBoxSelectDrag)，如果这时旋转直接改写 dev.gridX/gridY，
  // 这份快照并不知情——松手时 commitBoxSelectDrag 仍会用旧快照+偏移把位置覆盖
  // 回去，旋转带来的整体位置变化就被吃掉了，只留下每个设备自己的朝向
  // (rot/mainInEdge/mainOutEdge)被转了，看起来像"每个设备各转各的"而不是整体
  // 绕包围盒中心转向(这是改过的真实 bug)。与其去同步刷新拖动快照，不如直接
  // 禁掉，逼用户松手落位后再旋转，从根上避免这个快照过期问题。
  if (state.boxDragOrigin) return;
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
  draw();
}

// ---- 批量删除(Delete/Backspace)----
// 两端都在被删设备集合内的连线整体移除；只有一端在内的降级为悬空 stub(复用
// pathfinding.js 抽出来的 detachDeviceFromConnections，和单设备删除同一套逻辑)；
// 被显式框选中的连线本身无论端点如何一律整体移除。

function performBoxSelectDelete() {
  // 核心(dev.locked)即使被框选中也不参与这次删除：过滤到一个局部 Set，不改
  // state.boxSelectedDeviceIds 本身(那是选中高亮，删除后照旧整体清空)。
  const deviceIds = new Set(
    [...state.boxSelectedDeviceIds].filter(id => {
      const dev = state.devices.find(d => d.id === id);
      return !(dev && dev.locked);
    })
  );
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
  // 核心(dev.locked)不可复制：过滤出剪贴板要用的设备 id 集合，核心永远进不去
  // state.clipboard，commitPaste() 因此不需要额外的复制保护。
  const deviceIds = new Set(
    [...state.boxSelectedDeviceIds].filter(id => {
      const dev = state.devices.find(d => d.id === id);
      return !(dev && dev.locked);
    })
  );
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

  // 粘贴落地后新粘贴的这批直接成为当前框选选中集合，方便接着微调。压坏别的
  // 合法连线不再整体撤销这次粘贴，压坏的连线自然显示成红色 invalid(和其它
  // 放置类操作统一改成"操作永远成功，只留下红色警示")。
  state.boxSelectedDeviceIds = newDeviceIds;
  state.boxSelectedConnectionIds = newBeltIds;
  state.boxSelectedPipeConnectionIds = newPipeIds;
  state.pastePending = false;
  state.pastePreview = null;
  updateHintText();
}

// ---- 画布内鼠标交互：平移 / 选中 / 拖拽已有设备 ----

function bindCanvasMouseEvents() {
  canvas.addEventListener('mousedown', (e) => {
    if (e.button === 2) return; // 右键交给 contextmenu 处理(退出自由传送带模式/清空框选批量选中/取消待粘贴)

    if (state.pastePending) {
      if (e.button === 0) commitPaste();
      draw();
      return;
    }

    // Ctrl+左键拖拽：框选矩形，普通模式下随时可用，不需要先切换到任何"框选
    // 模式"。矩形起点就是按下点本身(不像批量拖动候选态那样需要等移动阈值)，
    // 因为 Ctrl 键本身已经是明确的"我要框选"意图，没有歧义要消化。命中判定/
    // 替换选中集合的逻辑见 mouseup 里的 commitBoxSelectMarquee。
    if (e.button === 0 && (e.ctrlKey || e.metaKey)) {
      const worldPos = screenToWorld(e.clientX, e.clientY);
      state.selectedId = null;
      state.selectedConnectionId = null;
      state.selectedPipeConnectionId = null;
      state.boxSelectMarquee = { startWX: worldPos.x, startWY: worldPos.y, curWX: worldPos.x, curWY: worldPos.y };
      canvas.style.cursor = 'crosshair';
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
          state.freeBeltStartDownPos = { x: e.clientX, y: e.clientY };
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
          state.freePipeStartDownPos = { x: e.clientX, y: e.clientY };
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
    // 该设备或画面上其它设备的另一个可用输入口上，实时重新寻路(Endpoint Re-attach)；
    // 按住已连接的输出口同理可以把这段线的起点改接到别的输出口(对称版本，见
    // state.outputEndpointDrag/pipeOutputEndpointDrag)。管道口精确命中优先于
    // 传送带口，输出口判定优先于输入口判定(和 resolveFreeStartClick"起点默认判
    // 输出口"的直觉一致)——端口是 8px 半径的精确点命中，两个不同设备/不同类型
    // 的端口之间几乎不会真正视觉重叠，不需要接入下面的重叠循环切换记忆。
    const outPipePortHit = findPortAt(e.clientX, e.clientY, 'output', 'pipe');
    if (outPipePortHit && isPipeOutputPortUsed(outPipePortHit.deviceId, outPipePortHit.index)) {
      const conn = state.pipeConnections.find(c => c.fromDeviceId === outPipePortHit.deviceId && c.fromPort === outPipePortHit.index);
      if (conn) {
        pushHistory();
        state.hoveredPort = null;
        state.dragTargetPort = null;
        state.pipeOutputEndpointDrag = { connId: conn.id, originalFromDeviceId: conn.fromDeviceId, originalFromPort: conn.fromPort };
        conn.fromDeviceId = null;
        conn.fromPort = null;
        const dropWorld = screenToWorld(e.clientX, e.clientY);
        conn.fromCell = worldToCell(dropWorld.x, dropWorld.y);
        recomputeAllPipeConnections();
        state.selectedPipeConnectionId = conn.id;
        state.selectedConnectionId = null;
        state.selectedId = null;
        draw();
        return;
      }
    }
    const inPipePortHit = findPortAt(e.clientX, e.clientY, 'input', 'pipe');
    if (inPipePortHit && isPipeInputPortUsed(inPipePortHit.deviceId, inPipePortHit.index)) {
      const conn = state.pipeConnections.find(c => c.toDeviceId === inPipePortHit.deviceId && c.toPort === inPipePortHit.index);
      if (conn) {
        pushHistory();
        state.hoveredPort = null;
        state.dragTargetPort = null;
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
    const outPortHit = findPortAt(e.clientX, e.clientY, 'output', 'belt');
    if (outPortHit && isOutputPortUsed(outPortHit.deviceId, outPortHit.index)) {
      const conn = state.connections.find(c => c.fromDeviceId === outPortHit.deviceId && c.fromPort === outPortHit.index);
      if (conn) {
        pushHistory();
        state.hoveredPort = null;
        state.dragTargetPort = null;
        state.outputEndpointDrag = { connId: conn.id, originalFromDeviceId: conn.fromDeviceId, originalFromPort: conn.fromPort };
        conn.fromDeviceId = null;
        conn.fromPort = null;
        const dropWorld = screenToWorld(e.clientX, e.clientY);
        conn.fromCell = worldToCell(dropWorld.x, dropWorld.y);
        recomputeAllConnections();
        state.selectedConnectionId = conn.id;
        state.selectedPipeConnectionId = null;
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
        state.hoveredPort = null;
        state.dragTargetPort = null;
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
      // 命中的设备已经在框选批量选中集合里：记候选态，交给 mousemove/mouseup
      // 判定接下来是"没挪动=点击切换选中"还是"挪动过阈值=立即整体拖动"，不
      // 落入下面单设备拖拽的分支。
      if (state.boxSelectedDeviceIds.has(hit.id)) {
        startGroupSelectionPointerDown(e.clientX, e.clientY, 'device', hit.id);
        draw();
        return;
      }
      // 点了框选集合之外的设备：视为放弃当前这批多选，退回普通单选/拖拽
      // (和大多数框选工具"点选区外的东西即清空选区"的习惯一致)。
      if (hasBoxSelection()) resetBoxSelectTransientState();
      pushHistory();
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
      const groupSet = connResolved.network === 'pipe' ? state.boxSelectedPipeConnectionIds : state.boxSelectedConnectionIds;
      if (groupSet.has(connResolved.hit.conn.id)) {
        startGroupSelectionPointerDown(e.clientX, e.clientY, connResolved.network, connResolved.hit.conn.id);
        draw();
        return;
      }
      if (hasBoxSelection()) resetBoxSelectTransientState();
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

    if (hasBoxSelection()) resetBoxSelectTransientState();
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

  // 右键：清空框选批量选中/退出自由传送带/自由管道模式，或取消待粘贴(阻止
  // 浏览器默认右键菜单)
  canvas.addEventListener('contextmenu', (e) => {
    if (state.pastePending) {
      e.preventDefault();
      cancelPastePending();
      draw();
      return;
    }
    if (hasBoxSelection() || state.boxSelectMarquee || state.boxDragOrigin) {
      e.preventDefault();
      resetBoxSelectTransientState();
      canvas.style.cursor = 'default';
      draw();
      return;
    }
    if (!state.freeBeltMode && !state.freePipeMode) {
      // 普通模式下右键一个设备：有槽位面板('recipe'/'port'两种之一)就打开，
      // 命中别的东西或空白处一律不拦截，走浏览器默认右键菜单(和现有行为一致，
      // 这条项目里之前从来没处理过普通右键，是纯增量)。
      const world = screenToWorld(e.clientX, e.clientY);
      const dev = hitTestDevice(world.x, world.y);
      if (dev && getSlotPanelKind(dev)) {
        e.preventDefault();
        showRecipePanel(dev.id);
      }
      return;
    }
    e.preventDefault();
    if (state.freeBeltMode) {
      state.freeBeltMode = false;
      state.freeBeltStart = null;
      state.freeBeltStartDownPos = null;
      state.freeBeltPreviewPts = null;
      state.freeBeltHoverDeviceId = null;
    } else {
      state.freePipeMode = false;
      state.freePipeStart = null;
      state.freePipeStartDownPos = null;
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
      // 按在已框选中的项上，挪动超过阈值即刻整体拖动——不再有长按等待，也不会
      // 像早期版本那样把快速拖动误判成"退化成框选矩形"(框选矩形现在只能由
      // Ctrl+拖拽触发，和这里的"拖动已选中项"完全分开，两者不会互相打架)。
      const dx = e.clientX - state.boxSelectPointerDown.downX, dy = e.clientY - state.boxSelectPointerDown.downY;
      if (dx * dx + dy * dy > 16) {
        startBoxSelectDrag();
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
        // 候选目标端口实时预览(只做命中检测，不解析/寻路，完整解析留给 mouseup)。
        const candidate = findPortAt(e.clientX, e.clientY, 'input', 'pipe');
        state.dragTargetPort = (candidate && !isPipeInputPortUsed(candidate.deviceId, candidate.index) && candidate.deviceId !== conn.fromDeviceId)
          ? { deviceId: candidate.deviceId, index: candidate.index, portKind: 'pipe', portType: 'input' }
          : null;
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
        const candidate = findPortAt(e.clientX, e.clientY, 'input', 'belt');
        state.dragTargetPort = (candidate && !isInputPortUsed(candidate.deviceId, candidate.index) && candidate.deviceId !== conn.fromDeviceId)
          ? { deviceId: candidate.deviceId, index: candidate.index, portKind: 'belt', portType: 'input' }
          : null;
        draw();
      }
      return;
    }
    if (state.pipeOutputEndpointDrag) {
      const conn = state.pipeConnections.find(c => c.id === state.pipeOutputEndpointDrag.connId);
      if (conn) {
        const worldPos = screenToWorld(e.clientX, e.clientY);
        conn.fromCell = worldToCell(worldPos.x, worldPos.y);
        recomputeAllPipeConnections();
        const candidate = findPortAt(e.clientX, e.clientY, 'output', 'pipe');
        state.dragTargetPort = (candidate && !isPipeOutputPortUsed(candidate.deviceId, candidate.index) && candidate.deviceId !== conn.toDeviceId)
          ? { deviceId: candidate.deviceId, index: candidate.index, portKind: 'pipe', portType: 'output' }
          : null;
        draw();
      }
      return;
    }
    if (state.outputEndpointDrag) {
      const conn = state.connections.find(c => c.id === state.outputEndpointDrag.connId);
      if (conn) {
        const worldPos = screenToWorld(e.clientX, e.clientY);
        conn.fromCell = worldToCell(worldPos.x, worldPos.y);
        recomputeAllConnections();
        const candidate = findPortAt(e.clientX, e.clientY, 'output', 'belt');
        state.dragTargetPort = (candidate && !isOutputPortUsed(candidate.deviceId, candidate.index) && candidate.deviceId !== conn.toDeviceId)
          ? { deviceId: candidate.deviceId, index: candidate.index, portKind: 'belt', portType: 'output' }
          : null;
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
      // 悬停在设备警告图标(如"未通电")上时弹出提示浮窗；只在悬停结果变化时
      // 才重绘，避免普通模式下鼠标空移也逐帧触发整个画布重绘。
      const iconHit = findWarningIconAt(e.clientX, e.clientY);
      const prevHoverId = state.hoveredWarningId ? state.hoveredWarningId.deviceId : null;
      const nextHoverId = iconHit ? iconHit.deviceId : null;
      state.hoveredWarningId = iconHit;

      // 悬停在"已连接、可拖拽改接"的端口(输入口或输出口)上时给出专属高亮(见
      // drawPortMarker 的 portState 参数)，光标改普通指针(不是抓手)，和"悬停在
      // 设备本体上可整体拖动"的抓手区分开。命中优先级镜像 mousedown 里
      // Endpoint Re-attach 判定的顺序：管道输出 → 管道输入 → 传送带输出 →
      // 传送带输入。
      let hoveredPort = null;
      if (!iconHit) {
        const pipeOutHit = findPortAt(e.clientX, e.clientY, 'output', 'pipe');
        const pipeInHit = findPortAt(e.clientX, e.clientY, 'input', 'pipe');
        const beltOutHit = findPortAt(e.clientX, e.clientY, 'output', 'belt');
        const beltInHit = findPortAt(e.clientX, e.clientY, 'input', 'belt');
        if (pipeOutHit && isPipeOutputPortUsed(pipeOutHit.deviceId, pipeOutHit.index)) {
          hoveredPort = { deviceId: pipeOutHit.deviceId, index: pipeOutHit.index, portKind: 'pipe', portType: 'output' };
        } else if (pipeInHit && isPipeInputPortUsed(pipeInHit.deviceId, pipeInHit.index)) {
          hoveredPort = { deviceId: pipeInHit.deviceId, index: pipeInHit.index, portKind: 'pipe', portType: 'input' };
        } else if (beltOutHit && isOutputPortUsed(beltOutHit.deviceId, beltOutHit.index)) {
          hoveredPort = { deviceId: beltOutHit.deviceId, index: beltOutHit.index, portKind: 'belt', portType: 'output' };
        } else if (beltInHit && isInputPortUsed(beltInHit.deviceId, beltInHit.index)) {
          hoveredPort = { deviceId: beltInHit.deviceId, index: beltInHit.index, portKind: 'belt', portType: 'input' };
        }
      }
      const prevPortKey = state.hoveredPort && `${state.hoveredPort.deviceId}:${state.hoveredPort.index}:${state.hoveredPort.portKind}:${state.hoveredPort.portType}`;
      const nextPortKey = hoveredPort && `${hoveredPort.deviceId}:${hoveredPort.index}:${hoveredPort.portKind}:${hoveredPort.portType}`;
      state.hoveredPort = hoveredPort;

      const worldPos = screenToWorld(e.clientX, e.clientY);
      canvas.style.cursor = iconHit ? 'help' : hoveredPort ? 'default' : (hitTestDevice(worldPos.x, worldPos.y) ? 'grab' : 'default');
      if (prevHoverId !== nextHoverId || prevPortKey !== nextPortKey) draw();
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
    // "起点按下拖拽→终点松手"手感：只有紧跟着设起点 A 那次 mousedown 的这一次
    // mouseup 才会命中(downPos 非空)，具体阈值判断和落地逻辑见 resolveDragReleaseEnd。
    if (state.freeBeltMode && state.freeBeltStartDownPos) {
      resolveDragReleaseEnd(BELT_UI, e.clientX, e.clientY);
      draw();
      return;
    }
    if (state.freePipeMode && state.freePipeStartDownPos) {
      resolveDragReleaseEnd(PIPE_UI, e.clientX, e.clientY);
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
              const blocked = buildBlockedSet(PIPE_NETWORK);
              const pipeOccupancy = buildPipeOccupancy(conn.id);
              const fromResolved = resolveConnEndpoint(conn.fromDeviceId, conn.fromPort, conn.fromCell, true);
              const best = fromResolved
                ? pickBestPort(avail, fromResolved.cellCol, fromResolved.cellRow, fromResolved.dir, false, blocked, pipeOccupancy, PIPE_NETWORK)
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
      state.dragTargetPort = null;
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
              const blocked = buildBlockedSet(BELT_NETWORK);
              const beltOccupancy = buildBeltOccupancy(conn.id);
              const fromResolved = resolveConnEndpoint(conn.fromDeviceId, conn.fromPort, conn.fromCell, true);
              const best = fromResolved
                ? pickBestPort(avail, fromResolved.cellCol, fromResolved.cellRow, fromResolved.dir, false, blocked, beltOccupancy, BELT_NETWORK)
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
      state.dragTargetPort = null;
      draw();
      return;
    }
    if (state.pipeOutputEndpointDrag) {
      const conn = state.pipeConnections.find(c => c.id === state.pipeOutputEndpointDrag.connId);
      if (conn) {
        let target = null;
        const portHit = findPortAt(e.clientX, e.clientY, 'output', 'pipe');
        if (portHit && !isPipeOutputPortUsed(portHit.deviceId, portHit.index) && portHit.deviceId !== conn.toDeviceId) {
          target = { deviceId: portHit.deviceId, index: portHit.index };
        } else {
          const worldPos = screenToWorld(e.clientX, e.clientY);
          const hitDev = hitTestDevice(worldPos.x, worldPos.y);
          if (hitDev && hitDev.id !== conn.toDeviceId) {
            const pos = effectiveGridPos(hitDev);
            const avail = getDevicePorts(hitDev, pos).outputs.filter(p => p.portKind === 'pipe' && !isPipeOutputPortUsed(hitDev.id, p.index));
            if (avail.length) {
              const blocked = buildBlockedSet(PIPE_NETWORK);
              const pipeOccupancy = buildPipeOccupancy(conn.id);
              const toResolved = resolveConnEndpoint(conn.toDeviceId, conn.toPort, conn.toCell, false);
              const best = toResolved
                ? pickBestPort(avail, toResolved.cellCol, toResolved.cellRow, toResolved.dir, true, blocked, pipeOccupancy, PIPE_NETWORK)
                : avail[0];
              if (best) target = { deviceId: hitDev.id, index: best.index };
            }
          }
        }
        if (target) {
          conn.fromDeviceId = target.deviceId;
          conn.fromPort = target.index;
          conn.fromCell = null;
        } else {
          conn.fromDeviceId = state.pipeOutputEndpointDrag.originalFromDeviceId;
          conn.fromPort = state.pipeOutputEndpointDrag.originalFromPort;
          conn.fromCell = null;
        }
        recomputeAllPipeConnections();
        if (target && conn.invalid) {
          conn.fromDeviceId = state.pipeOutputEndpointDrag.originalFromDeviceId;
          conn.fromPort = state.pipeOutputEndpointDrag.originalFromPort;
          conn.fromCell = null;
          recomputeAllPipeConnections();
        }
      }
      state.pipeOutputEndpointDrag = null;
      state.dragTargetPort = null;
      draw();
      return;
    }
    if (state.outputEndpointDrag) {
      const conn = state.connections.find(c => c.id === state.outputEndpointDrag.connId);
      if (conn) {
        let target = null;
        const portHit = findPortAt(e.clientX, e.clientY, 'output', 'belt');
        if (portHit && !isOutputPortUsed(portHit.deviceId, portHit.index) && portHit.deviceId !== conn.toDeviceId) {
          target = { deviceId: portHit.deviceId, index: portHit.index };
        } else {
          const worldPos = screenToWorld(e.clientX, e.clientY);
          const hitDev = hitTestDevice(worldPos.x, worldPos.y);
          if (hitDev && hitDev.id !== conn.toDeviceId) {
            const pos = effectiveGridPos(hitDev);
            const avail = getDevicePorts(hitDev, pos).outputs.filter(p => p.portKind === 'belt' && !isOutputPortUsed(hitDev.id, p.index));
            if (avail.length) {
              const blocked = buildBlockedSet(BELT_NETWORK);
              const beltOccupancy = buildBeltOccupancy(conn.id);
              const toResolved = resolveConnEndpoint(conn.toDeviceId, conn.toPort, conn.toCell, false);
              const best = toResolved
                ? pickBestPort(avail, toResolved.cellCol, toResolved.cellRow, toResolved.dir, true, blocked, beltOccupancy, BELT_NETWORK)
                : avail[0];
              if (best) target = { deviceId: hitDev.id, index: best.index };
            }
          }
        }
        if (target) {
          conn.fromDeviceId = target.deviceId;
          conn.fromPort = target.index;
          conn.fromCell = null;
        } else {
          conn.fromDeviceId = state.outputEndpointDrag.originalFromDeviceId;
          conn.fromPort = state.outputEndpointDrag.originalFromPort;
          conn.fromCell = null;
        }
        recomputeAllConnections();
        if (target && conn.invalid) {
          conn.fromDeviceId = state.outputEndpointDrag.originalFromDeviceId;
          conn.fromPort = state.outputEndpointDrag.originalFromPort;
          conn.fromCell = null;
          recomputeAllConnections();
        }
      }
      state.outputEndpointDrag = null;
      state.dragTargetPort = null;
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
        // 移动后保留选中状态(不像工具栏拖出新设备那样清空)，方便用户挪完接着
        // 旋转/继续操作。压坏别的合法连线/越界不再整体撤回，压坏的连线显示红色
        // invalid、越界的设备标红(见 devices.js 的 computeOutOfBoundsIds)，
        // 操作本身永远成功。
      }
    }
    state.draggingDeviceId = null;
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
    // 地图切换确认浮层打开时，除了 Escape(等效"取消")之外的所有快捷键一律
    // 不生效，避免用户在浮层还开着的时候意外触发画布操作(Ctrl+Z/E/Q/R/Delete
    // 等)。鼠标事件不需要类似判断，浮层铺满全屏拦住了 canvas 的点击/滚轮。
    if (state.mapConfirmPending) {
      if (e.key === 'Escape') { e.preventDefault(); hideMapConfirmModal(); }
      return;
    }
    // 物品选择抽屉/槽位面板打开时同上，同一个"浮层开着时只认 Escape"的
    // 先例：Escape 先关抽屉(如果开着)，再关面板，一次按键只收一层，避免手滑
    // 直接把面板和抽屉一起关掉。
    if (state.itemPickerTarget) {
      if (e.key === 'Escape') { e.preventDefault(); hideItemPicker(); }
      return;
    }
    if (state.recipePanelDeviceId) {
      if (e.key === 'Escape') { e.preventDefault(); hideRecipePanel(); }
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      undo();
      return;
    }

    // 复制/粘贴作用于当前框选批量选中的内容，不要求先进入某个"模式"；
    // buildClipboardFromSelection 内部在选中集合为空时直接空跑，不需要在这里
    // 额外判断"是否有选中内容"。
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault();
      buildClipboardFromSelection();
      return;
    }
    if (!state.pastePending && state.clipboard && (e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
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
      if (hasBoxSelection() || state.boxSelectMarquee || state.boxDragOrigin) {
        e.preventDefault();
        resetBoxSelectTransientState();
        canvas.style.cursor = 'default';
        draw();
        return;
      }
      return;
    }

    if (e.key === 'h' || e.key === 'H') {
      // 纯视图开关，和 activeToolbarCategory 同类：不需要在 undo()/E 键切换
      // 画线模式/鼠标收尾逻辑里重置，撤销画布数据、切换画线工具都不应该把
      // 用户刚打开的供电范围叠层关掉。
      e.preventDefault();
      state.showPowerRanges = !state.showPowerRanges;
      draw();
      return;
    }

    if (e.key === 'e' || e.key === 'E') {
      e.preventDefault();
      state.freeBeltMode = !state.freeBeltMode;
      state.freeBeltStart = null;
      state.freeBeltStartDownPos = null;
      state.freeBeltPreviewPts = null;
      state.freeBeltHoverDeviceId = null;
      if (state.freeBeltMode) {
        // 进入布线模式即为独占工具：清掉其它可能残留的交互状态，包括另一个
        // 画线工具(自由管道模式)和框选批量选中——两个画线工具互斥，框选批量
        // 选中虽然不是独立模式，但和画线工具同时存在没有意义，进入画线工具
        // 一律清空。
        state.freePipeMode = false;
        state.freePipeStart = null;
        state.freePipeStartDownPos = null;
        state.freePipePreviewPts = null;
        state.freePipeHoverDeviceId = null;
        state.draggingWaypoint = null;
        state.pendingWaypointCreate = null;
        state.draggingPipeWaypoint = null;
        state.pendingPipeWaypointCreate = null;
        state.draggingDeviceId = null;
        state.endpointDrag = null;
        state.pipeEndpointDrag = null;
        state.outputEndpointDrag = null;
        state.pipeOutputEndpointDrag = null;
        state.isPanning = false;
        state.selectedId = null;
        state.selectedConnectionId = null;
        state.selectedPipeConnectionId = null;
        state.lastConduitClickCell = null;
        state.hoveredWarningId = null;
        state.hoveredPort = null;
        state.dragTargetPort = null;
        resetBoxSelectTransientState();
        hideItemPicker();
        hideRecipePanel();
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
      state.freePipeStartDownPos = null;
      state.freePipePreviewPts = null;
      state.freePipeHoverDeviceId = null;
      if (state.freePipeMode) {
        // 镜像上面的 E 键处理，且同样清空自由传送带模式和框选批量选中。
        state.freeBeltMode = false;
        state.freeBeltStart = null;
        state.freeBeltStartDownPos = null;
        state.freeBeltPreviewPts = null;
        state.freeBeltHoverDeviceId = null;
        state.draggingWaypoint = null;
        state.pendingWaypointCreate = null;
        state.draggingPipeWaypoint = null;
        state.pendingPipeWaypointCreate = null;
        state.draggingDeviceId = null;
        state.endpointDrag = null;
        state.pipeEndpointDrag = null;
        state.outputEndpointDrag = null;
        state.pipeOutputEndpointDrag = null;
        state.isPanning = false;
        state.selectedId = null;
        state.selectedConnectionId = null;
        state.selectedPipeConnectionId = null;
        state.lastConduitClickCell = null;
        state.hoveredWarningId = null;
        state.hoveredPort = null;
        state.dragTargetPort = null;
        resetBoxSelectTransientState();
        hideItemPicker();
        hideRecipePanel();
        canvas.style.cursor = 'crosshair';
      } else {
        canvas.style.cursor = 'default';
      }
      updateHintText();
      draw();
      return;
    }

    if (e.key === 'r' || e.key === 'R') {
      // 正在从工具栏拖拽生成新设备(鼠标还没松开)时，R 键旋转的是手上这个还
      // 没落地的模板本身，优先级要排在批量/单设备旋转前面——mousedown 时已经
      // 清空了旧的单选/框选批量选中(见 toolbarIcons 的 mousedown 处理)，但
      // 防御性地把这个分支放在最前面，即使将来那处清空逻辑被改掉也不会转错
      // 目标。keydown 不带鼠标坐标，用 state.spawnPointerX/Y(mousemove 里持续
      // 更新)重新计算落地预览位置。
      if (state.spawning) {
        e.preventDefault();
        state.spawnRotSteps = (state.spawnRotSteps + 1) % 4;
        const template = SPAWN_TEMPLATES.find(t => t.key === state.spawningTemplateKey);
        if (template) {
          updateSpawnPreview(state.spawnPointerX, state.spawnPointerY);
        }
        draw();
        return;
      }
      if (state.boxSelectedDeviceIds.size > 0) {
        e.preventDefault();
        performBoxSelectRotate();
        return;
      }
      if (state.selectedId === null) return;
      const dev = state.devices.find(d => d.id === state.selectedId);
      const isNode = dev && (dev.kind === 'merger' || dev.kind === 'splitter' || dev.kind === 'pipe-merger' || dev.kind === 'pipe-splitter');
      if (!dev || !(dev.kind === 'facility' || isNode)) return;
      e.preventDefault();
      pushHistory();
      if (isNode) {
        // 汇流器/分流器(含管道版)是 1x1 节点，没有 facility 那套 rot+w/h 互换机制，
        // nodeDevicePorts 直接读 mainOutEdge/mainInEdge 这一条边——旋转就是把这条
        // 边顺时针转 90°，其余 3 条边(输入/输出角色)跟着自动挪到下一条边。由
        // splitConnectionAtCell 切入已有连线生成的节点，这两个字段是延续被切入
        // 连线的走向定出来的，旋转会改变它已经接好的那 1 进/1 出的位置，因此和
        // facility 旋转一样必须过下面同一套"顺手压坏别的合法连线"安全网检查——
        // 唯一区别是节点旋转不用像 facility 那样互换 w/h(1x1 恒等)。
        if (dev.kind === 'merger' || dev.kind === 'pipe-merger') {
          dev.mainOutEdge = (dev.mainOutEdge + 1) % 4;
        } else {
          dev.mainInEdge = (dev.mainInEdge + 1) % 4;
        }
      } else {
        dev.rot = (flowDirOf(dev) + 1) % 4;
        // facility 设备大多不是正方形(拆解机6x4、协议核心9x9等)，旋转是真的绕
        // 中心转外形，宽高会互换；正方形设备(如粉碎机)互换后数值不变，这里不用
        // 分情况处理。
        const tmp = dev.w;
        dev.w = dev.h;
        dev.h = tmp;
      }
      recomputeAllFlows();
      draw();
      return;
    }

    if (e.key !== 'Delete' && e.key !== 'Backspace') return;
    if (hasBoxSelection()) {
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
      const dev = state.devices.find(d => d.id === state.selectedId);
      if (dev && dev.locked) { e.preventDefault(); return; } // 核心不可删除
      e.preventDefault();
      pushHistory();
      // 删除设备只移除设备本身：与它相连的传送带/管道保留下来，端点改为设备
      // 原先所在端口紧邻的那格自由网格端点，成为一段悬空的连线，仍可在普通
      // 模式下选中/删除，或拖拽途经点调整。两个网络的分离逻辑抽成了
      // pathfinding.js 的 detachDeviceFromConnections，批量删除(performBoxSelectDelete)
      // 复用同一份。
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

// ---- 地图选择(下拉框)：切换地图会清空画布，需 confirm() 二次确认 ----
// 地图矩形固定锚定在网格原点，核心摆放在地图中心，见 mapBounds.js/data/maps.js
// 顶部注释。

// 在当前地图上放置固定核心：不经过 pushHistory()——地图(重新)选择是"新开一张
// 图"的语义，核心的存在不该出现在 Ctrl+Z 历史里(undo() 会把它连同别的设备一起
// 撤销掉，这个模块不需要为此另写一份"核心缺失时补回来"的兜底逻辑，只要保证
// 核心摆放本身永远不落进 state.history 即可，见 applyMapSelection 里
// state.history = [] 的说明)。
function placeCoreDevice(mapDef) {
  const facility = FACILITIES['其他'].find(f => f.id === mapDef.coreFacilityId);
  const cx = Math.floor((mapDef.w - facility.footprint.w) / 2);
  const cy = Math.floor((mapDef.h - facility.footprint.h) / 2);
  const core = {
    id: state.nextId++,
    gridX: cx, gridY: cy,
    w: facility.footprint.w, h: facility.footprint.h, rot: 0,
    kind: 'facility',
    color: '#ffffff', borderColor: '#111111',
    label: facility.name,
    facilityId: facility.id,
    ports: facility.ports,
    powerCost: facility.powerCost,
    powerRange: facility.powerRange,
    isLowProfile: facility.isLowProfile,
    locked: true, // 核心：禁止删除/复制(见 keydown 的 Delete 分支、buildClipboardFromSelection、
                 // performBoxSelectDelete)，但可以正常移动/旋转/接线，不受这个标记影响。
    // 协议核心/次级核心的槽位面板体验不好(端口一多显示很乱)，用户已确认
    // 暂时不需要，没有把这两个 id 放进 recipeSlots.js 的 PORT_ITEM_FACILITY_IDS，
    // buildInitialSlotState 对它们返回 {}；这行调用留着是为了和工具栏拖拽生成
    // 新设备那条路径保持同一个入口，不是特意要给核心塞槽位数据。
    ...buildInitialSlotState(facility.id)
  };
  state.devices.push(core);
  state.coreDeviceId = core.id;
}

// 实际执行一次地图切换(清空画布 + 摆放核心 + 相机居中)，不做任何确认判断——
// 调用方(bootstrapDefaultMap 或确认浮层"确定切换"按钮)负责确保这一步已经被
// 批准。清空画布不经过 pushHistory()/undo()，和刷新页面丢失数据是同一语义
// (本项目没有持久化，见 CLAUDE.md 的已知问题)——地图切换本来就是"新开一张
// 图"，不应该能撤销回上一张地图的内容。
function performMapSwitch(mapDef) {
  state.devices = [];
  state.connections = [];
  state.pipeConnections = [];
  state.nextId = 1;
  state.nextConnId = 1;
  state.nextPipeConnId = 1;
  state.history = [];
  state.selectedId = null;
  state.selectedConnectionId = null;
  state.selectedPipeConnectionId = null;
  resetBoxSelectTransientState();
  state.clipboard = null; // 旧地图坐标系下的剪贴板内容跨地图没有意义

  state.mapId = mapDef.id;
  state.mapWidthCells = mapDef.w;
  state.mapHeightCells = mapDef.h;
  placeCoreDevice(mapDef);

  // 相机居中到新地图中心，而不是网格原点(旧 initView() 的行为)
  state.offsetX = window.innerWidth / 2 - (mapDef.w * GRID_SIZE / 2) * state.scale;
  state.offsetY = window.innerHeight / 2 - (mapDef.h * GRID_SIZE / 2) * state.scale;

  recomputeAllFlows();
  draw();
}

// 地图切换二次确认浮层：不用原生 window.confirm()——部分嵌入式/沙盒环境(如
// iframe 预览)没有 allow-modals 权限时会静默拦截原生对话框、直接当作用户点了
// 取消，导致切换看起来完全没反应；而且原生弹窗本身也和整个应用自绘的白底黑边
// 工业风 UI 不搭。自绘浮层用 state.mapConfirmPending 记录待切换的目标地图，
// #map-confirm-overlay 铺满全屏(style.css)天然拦住画布下面的鼠标事件。
function showMapConfirmModal(mapDef) {
  state.mapConfirmPending = { mapDef };
  mapConfirmMessageEl.textContent = `切换到"${mapDef.label}"会清空当前画布上的所有设备和连线，且无法恢复，确定要切换吗？`;
  mapConfirmOverlayEl.style.display = 'flex';
}

function hideMapConfirmModal() {
  state.mapConfirmPending = null;
  mapConfirmOverlayEl.style.display = 'none';
}

function bindMapSelectorEvents() {
  for (const m of MAP_CATALOG) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.label;
    mapSelectEl.appendChild(opt);
  }
  mapSelectEl.addEventListener('change', (e) => {
    const mapDef = MAP_CATALOG.find(m => m.id === e.target.value);
    if (!mapDef) return;
    if (state.devices.length === 0) {
      performMapSwitch(mapDef);
      return;
    }
    // 先把下拉框视觉还原成切换前的地图，真正的切换要等用户在确认浮层里点
    // "确定切换"才发生(见 bindMapConfirmModalEvents)。
    mapSelectEl.value = state.mapId;
    showMapConfirmModal(mapDef);
  });
}

function bindMapConfirmModalEvents() {
  mapConfirmOkEl.addEventListener('click', () => {
    if (!state.mapConfirmPending) return;
    const { mapDef } = state.mapConfirmPending;
    hideMapConfirmModal();
    performMapSwitch(mapDef);
    mapSelectEl.value = mapDef.id;
  });
  mapConfirmCancelEl.addEventListener('click', () => {
    hideMapConfirmModal(); // 下拉框在 change 事件里已经还原，这里不需要再改
  });
}

// main.js 启动时调用：首次加载 state.devices 为空，performMapSwitch 不需要
// 经过确认浮层这一层判断。
export function bootstrapDefaultMap() {
  performMapSwitch(MAP_CATALOG[0]);
  mapSelectEl.value = MAP_CATALOG[0].id;
}

// ---- 右键槽位面板 + 物品选择抽屉 ----
// 右键一个有槽位数据的设备(recipeSlots.js 的 getSlotPanelKind 判定)弹出居中
// 浮层(仿 map-confirm-overlay 那套 display 切换)，列出全部槽位——方形=固体、
// 圆形=流体，和游戏保持一致。点一个槽位从屏幕右侧滑出物品选择抽屉，选中后
// 立即写回并关闭抽屉，'recipe' 模式下顺带把其它槽位的候选范围重算一遍(见
// recipeSlots.js 的收紧算法)。两层浮层各自独立开合：关抽屉不代表关面板，关
// 面板会连带关掉可能还开着的抽屉；抽屉本身只有点了具体某个物品才会写入槽位，
// 点遮罩/取消按钮/Escape 都是纯关闭、不改任何数据，对应"取消该次选择"的诉求；
// 面板里已经选好的槽位有单独的"×"清空按钮，外加一个"清空全部"，对应"防止
// 误触"的诉求，两种粒度都覆盖到。

function findRecipePanelDevice() {
  return state.devices.find((d) => d.id === state.recipePanelDeviceId) || null;
}

function showRecipePanel(deviceId) {
  state.recipePanelDeviceId = deviceId;
  hideItemPicker(); // 换了设备，之前开着的抽屉(如果有)已经对不上号
  renderRecipePanel();
  recipePanelOverlayEl.style.display = 'flex';
}

function hideRecipePanel() {
  state.recipePanelDeviceId = null;
  hideItemPicker();
  hideItemLookupPopover();
  recipePanelOverlayEl.style.display = 'none';
}

// 槽位组的形状(方=固体、圆=流体，和游戏一致)，四个 recipe 模式槽位组共用；
// 'port' 模式的形状直接看端口本身的 belt/fluid 类型，不查这张表。不再维护
// 中文标题文字——原料在左、产物在右、中间一个箭头，方向本身已经说明白了
// "这是原料还是产物"，不需要额外文字(用户明确要求)。
const SLOT_GROUP_SHAPE = {
  inputSolid: 'square', inputFluid: 'circle', outputSolid: 'square', outputFluid: 'circle'
};

// ---- 已选中物品的槽位悬停 1 秒查看"物品上下游"提示 ----
// 纯展示型悬浮提示，不进 state 对象、不参与撤销栈/模式切换同步——和已有的
// state.cursorTooltip/state.hoveredWarningId 是同一类"瞬时展示态"，那两个
// 字段本来就不在 undo()/E-Q 模式重置的同步列表里，这里同理。计时器是纯 UI
// 细节，一个模块级变量足够，不需要挂在 state 上。
let itemLookupHoverTimer = null;

function showItemLookupPopover(itemId, anchorEl) {
  const item = ITEM_BY_ID.get(itemId);
  if (!item) return;
  const { producers, consumers } = getItemUpstreamDownstream(itemId);
  itemLookupTitleEl.textContent = item.name;
  itemLookupProducersEl.textContent = producers.length ? producers.join('、') : '（暂无已知配方产出）';
  itemLookupConsumersEl.textContent = consumers.length ? consumers.join('、') : '（暂无已知配方消耗）';
  itemLookupPopoverEl.style.display = 'block';
  const rect = anchorEl.getBoundingClientRect();
  const popRect = itemLookupPopoverEl.getBoundingClientRect();
  let left = rect.left + rect.width / 2 - popRect.width / 2;
  let top = rect.top - popRect.height - 8; // 默认显示在槽位正上方
  left = Math.max(8, Math.min(left, window.innerWidth - popRect.width - 8));
  if (top < 8) top = rect.bottom + 8; // 上方放不下(槽位太靠近视口顶部)时改显示在槽位下方
  itemLookupPopoverEl.style.left = `${left}px`;
  itemLookupPopoverEl.style.top = `${top}px`;
}

function hideItemLookupPopover() {
  clearTimeout(itemLookupHoverTimer);
  itemLookupPopoverEl.style.display = 'none';
}

function buildSlotButton(shape, itemId, onClear, onOpen) {
  const btn = document.createElement('div');
  btn.className = `recipe-slot recipe-slot-${shape}` + (itemId ? ' filled' : '');
  const label = document.createElement('span');
  label.className = 'recipe-slot-label';
  if (itemId) {
    const item = ITEM_BY_ID.get(itemId);
    label.textContent = item ? item.name : itemId;
    // 不再设 btn.title——下面的悬停 1 秒提示已经完整覆盖物品名(还带上下游
    // 信息)，留着原生 title 属性会导致浏览器自带的系统提示框和新提示先后/
    // 同时出现，双重打扰。
    btn.addEventListener('mouseenter', () => {
      itemLookupHoverTimer = setTimeout(() => showItemLookupPopover(itemId, btn), 1000);
    });
    btn.addEventListener('mouseleave', hideItemLookupPopover);
  } else {
    label.textContent = '+';
    btn.title = '点击选择物品';
  }
  btn.appendChild(label);
  if (itemId) {
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'recipe-slot-clear';
    clearBtn.textContent = '×';
    clearBtn.title = '清空该槽位';
    clearBtn.addEventListener('click', (e) => { e.stopPropagation(); onClear(); });
    btn.appendChild(clearBtn);
  }
  btn.addEventListener('click', onOpen);
  return btn;
}

function buildSlotColumn(els) {
  const col = document.createElement('div');
  col.className = 'recipe-slot-column';
  for (const el of els) col.appendChild(el);
  return col;
}

function renderRecipePanel() {
  // 面板每次重新渲染都会替换掉可能正被悬停的槽位按钮节点，浏览器不会对着一个
  // 被替换掉的节点补发 mouseleave，不主动清一次会导致悬浮提示卡在屏幕上关不掉。
  hideItemLookupPopover();
  const dev = findRecipePanelDevice();
  recipePanelBodyEl.innerHTML = '';
  if (!dev) return;
  recipePanelTitleEl.textContent = dev.label || '';
  const kind = getSlotPanelKind(dev);

  if (kind === 'port') {
    // 'port' 模式目前没有哪个设备会同时有输入口和输出口(核心那种"进出都有"
    // 的设备已经不走这条槽位面板了，见 recipeSlots.js 的 PORT_ITEM_FACILITY_IDS
    // 注释)，单列平铺即可，不需要两栏+箭头。槽位描述符走 getPortSlotDescriptors
    // 而不是直接遍历 dev.ports——大多数设备一个端口对应一个槽位，但热能池
    // 只有一个虚拟槽位(2 个传送带口同时只烧一种东西，槽位数不跟端口数走)。
    const els = getPortSlotDescriptors(dev.facilityId).map((d) => {
      const itemId = dev.portItems[d.key];
      return buildSlotButton(
        d.shape,
        itemId,
        () => { setSlotValue(dev, 'port', d.key, null); renderRecipePanel(); },
        () => showItemPicker(dev.id, 'port', d.key)
      );
    });
    recipePanelBodyEl.appendChild(buildSlotColumn(els));
    return;
  }

  const spec = getFacilitySlotSpec(dev.facilityId);
  if (!spec) return; // getSlotPanelKind 已经保证不会走到这里
  if (spec.sharedPool) {
    const note = document.createElement('div');
    note.className = 'recipe-panel-note';
    note.textContent =
      `该设备是共享槽位设计(共 ${spec.totalSlots} 个槽位，原料和产物共用同一个槽位池)，` +
      '和其它设备"固定输入/输出槽位数"的模型不一样，槽位面板暂时还没接入这种设计，先留到后续单独实现。';
    recipePanelBodyEl.appendChild(note);
    return;
  }

  // 原料在左、产物在右，中间一个箭头——不再按固体/流体分组标题堆叠成一整
  // 列，两栏并排把右侧空白利用起来(用户明确要求)；哪个先选都行(见
  // recipeSlots.js 的 isRecipeViable)，UI 上不需要区分"必须先选哪边"。
  const buildEls = (group) => {
    const arr = dev.slotValues[group];
    if (!arr) return [];
    const shape = SLOT_GROUP_SHAPE[group];
    return arr.map((itemId, index) => buildSlotButton(
      shape,
      itemId,
      () => { setSlotValue(dev, group, index, null); renderRecipePanel(); },
      () => showItemPicker(dev.id, group, index)
    ));
  };
  const inputEls = INPUT_GROUPS.flatMap(buildEls);
  const outputEls = OUTPUT_GROUPS.flatMap(buildEls);

  // 固气/液气转化机额外叠加的催化剂圆槽位(见 recipeSlots.js 的
  // CATALYST_ITEM_BY_FACILITY)：存在 dev.portItems.catalyst 里，不属于任何
  // INPUT_GROUPS/OUTPUT_GROUPS，抽屉侧走 group='port' 的既有分支(和热能池
  // 燃料槽位同一套)。这一行排在 columns 之前 append，DOM 顺序上位于两栏+
  // 箭头那一行之上；这 4 台设备的输入/输出都只有 1 个槽位，两栏等宽，
  // .recipe-panel-columns 的 justify-content:center 会让箭头精确落在内容区
  // 水平中点，这里同样居中就能让圆槽位正好落在箭头正上方。
  if (CATALYST_ITEM_BY_FACILITY.has(dev.facilityId)) {
    const catalystRow = document.createElement('div');
    catalystRow.className = 'recipe-panel-catalyst-row';
    catalystRow.appendChild(buildSlotButton(
      'circle', dev.portItems.catalyst,
      () => { setSlotValue(dev, 'port', 'catalyst', null); renderRecipePanel(); },
      () => showItemPicker(dev.id, 'port', 'catalyst')
    ));
    recipePanelBodyEl.appendChild(catalystRow);
  }

  const columns = document.createElement('div');
  columns.className = 'recipe-panel-columns';
  columns.appendChild(buildSlotColumn(inputEls));
  const arrow = document.createElement('div');
  arrow.className = 'recipe-panel-arrow';
  arrow.textContent = '→';
  columns.appendChild(arrow);
  columns.appendChild(buildSlotColumn(outputEls));
  recipePanelBodyEl.appendChild(columns);
}

function bindRecipePanelEvents() {
  recipePanelCloseEl.addEventListener('click', () => hideRecipePanel());
  recipePanelOverlayEl.addEventListener('click', (e) => {
    if (e.target === recipePanelOverlayEl) hideRecipePanel(); // 只有点遮罩本身(不是里面的框)才关
  });
  recipePanelClearAllEl.addEventListener('click', () => {
    const dev = findRecipePanelDevice();
    if (!dev) return;
    clearAllSlots(dev);
    renderRecipePanel();
  });
}

// ---- 物品选择抽屉 ----

function currentPickerPortType() {
  const t = state.itemPickerTarget;
  if (!t) return null;
  if (t.group === 'port') {
    const dev = state.devices.find((d) => d.id === t.deviceId);
    const descriptor = dev && getPortSlotDescriptors(dev.facilityId).find((d) => d.key === t.index);
    return descriptor && descriptor.shape === 'circle' ? 'fluid' : 'solid';
  }
  return t.group.endsWith('Fluid') ? 'fluid' : 'solid';
}

// 抽屉里点击可选中的候选范围：'port' 模式没有配方可收紧，全部同 portType 物品
// 都能选；'recipe' 模式下原料槽位/产物槽位调用同一个双向收紧算法(见
// recipeSlots.js 的 computeSlotCandidates)，哪个先选都行。
function currentPickerCandidateIds() {
  const t = state.itemPickerTarget;
  if (!t) return new Set();
  const dev = state.devices.find((d) => d.id === t.deviceId);
  if (!dev) return new Set();
  if (t.group === 'port') {
    const portType = currentPickerPortType();
    return new Set(ITEMS.filter((i) => i.portType === portType).map((i) => i.id));
  }
  // 重新点开一个已经填过的槽位时，要按"这个槽位当前是空的"来算候选，否则它
  // 自己现在的值会被 computeSlotCandidates 当成"已选"从候选里排除掉，导致
  // 点开一个已经填了"碳粉末"的槽位，"碳粉末"本身反而不在可选列表里这种怪现象。
  const arr = dev.slotValues[t.group];
  const original = arr[t.index];
  arr[t.index] = null;
  const candidates = computeSlotCandidates(dev.facilityId, dev.slotValues, t.group);
  arr[t.index] = original;
  return candidates;
}

// 抽屉里"浏览"用的物品池，和上面能不能点选(candidateIds)是两回事：'全部物品'
// 标签页/'port'模式(没有相关配方概念)一律是同 portType 的全部 199 个物品里
// 挑出来的那部分；'本设备相关'标签页收窄成这台设备配方里出现过的物品，方便
// 不用一上来就面对全部物品，具体见 recipeSlots.js 的 getRelevantItemIds。
function currentPickerBrowsePool() {
  const t = state.itemPickerTarget;
  const portType = currentPickerPortType();
  if (t.group === 'port' || state.itemPickerTab === 'all') {
    return new Set(ITEMS.filter((i) => i.portType === portType).map((i) => i.id));
  }
  const dev = state.devices.find((d) => d.id === t.deviceId);
  return getRelevantItemIds(dev.facilityId, t.group);
}

function showItemPicker(deviceId, group, index) {
  state.itemPickerTarget = { deviceId, group, index };
  state.itemPickerTab = 'relevant';
  state.itemPickerSearch = '';
  itemPickerSearchEl.value = '';
  renderItemPickerTabs();
  renderItemPickerGrid();
  itemPickerOverlayEl.style.display = 'block';
  itemPickerDrawerEl.classList.add('open');
}

function hideItemPicker() {
  state.itemPickerTarget = null;
  itemPickerOverlayEl.style.display = 'none';
  itemPickerDrawerEl.classList.remove('open');
}

function renderItemPickerTabs() {
  const t = state.itemPickerTarget;
  itemPickerTabsEl.innerHTML = '';
  if (!t || t.group === 'port') {
    // 'port' 模式没有配方可言，"本设备相关"这个概念不成立，不显示标签页，
    // 直接按全部同类型物品浏览(currentPickerBrowsePool 已经处理了这个分支)。
    itemPickerTabsEl.style.display = 'none';
    return;
  }
  itemPickerTabsEl.style.display = '';
  for (const [key, label] of [['relevant', '本设备相关'], ['all', '全部物品']]) {
    const tab = document.createElement('div');
    tab.className = 'item-picker-tab' + (state.itemPickerTab === key ? ' active' : '');
    tab.textContent = label;
    tab.dataset.tab = key;
    itemPickerTabsEl.appendChild(tab);
  }
}

function iconFallbackEl(name) {
  const span = document.createElement('span');
  span.className = 'item-picker-icon-fallback';
  span.textContent = (name || '').slice(0, 2); // 图标还没抓到时的兜底：中文名前两个字
  return span;
}

function renderItemPickerGrid() {
  const t = state.itemPickerTarget;
  itemPickerGridEl.innerHTML = '';
  if (!t) return;
  const dev = state.devices.find((d) => d.id === t.deviceId);
  if (!dev) return;
  const portType = currentPickerPortType();
  const candidates = currentPickerCandidateIds();
  const pool = currentPickerBrowsePool();
  const search = state.itemPickerSearch.trim();
  const list = ITEMS.filter((i) => pool.has(i.id) &&
    (!search || i.name.includes(search) || i.id.includes(search)));

  if (list.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'item-picker-empty';
    empty.textContent = search ? '没有匹配的物品'
      : (t.group === 'outputSolid' || t.group === 'outputFluid'
        ? '还没有配方被满足，先去填输入槽位'
        : '暂无可选物品');
    itemPickerGridEl.appendChild(empty);
    return;
  }

  for (const item of list) {
    const enabled = candidates.has(item.id);
    const cell = document.createElement('div');
    cell.className = `item-picker-cell item-picker-cell-${portType}` + (enabled ? '' : ' disabled');
    cell.title = enabled ? item.name : `${item.name}（当前选择下不可用）`;
    const icon = document.createElement('img');
    icon.className = 'item-picker-icon';
    icon.alt = item.name;
    icon.onerror = () => icon.replaceWith(iconFallbackEl(item.name));
    icon.src = `/icons/items/${item.id}.webp`;
    cell.appendChild(icon);
    const label = document.createElement('span');
    label.className = 'item-picker-cell-label';
    label.textContent = item.name;
    cell.appendChild(label);
    if (enabled) {
      cell.addEventListener('click', () => {
        setSlotValue(dev, t.group, t.index, item.id);
        hideItemPicker();
        renderRecipePanel();
      });
    }
    itemPickerGridEl.appendChild(cell);
  }
}

function bindItemPickerEvents() {
  itemPickerCancelEl.addEventListener('click', () => hideItemPicker());
  itemPickerOverlayEl.addEventListener('click', () => hideItemPicker());
  itemPickerSearchEl.addEventListener('input', (e) => {
    state.itemPickerSearch = e.target.value;
    renderItemPickerGrid();
  });
  itemPickerTabsEl.addEventListener('click', (e) => {
    const tab = e.target.closest('.item-picker-tab');
    if (!tab) return;
    state.itemPickerTab = tab.dataset.tab;
    renderItemPickerTabs();
    renderItemPickerGrid();
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
  const oriented = getSpawnOrientedFields(template, state.spawnRotSteps);
  const worldPos = screenToWorld(clientX, clientY);
  const rawX = worldPos.x - (oriented.w * GRID_SIZE) / 2;
  const rawY = worldPos.y - (oriented.h * GRID_SIZE) / 2;
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
    const template = SPAWN_TEMPLATES.find(t => t.key === key);
    // 从工具栏拖出新设备是一次新的、独立的操作，清空普通模式下残留的单选/
    // 框选批量选中——否则拖拽期间按 R 预旋转正在生成的这个设备时，会被
    // keydown 'r' 处理里排在前面的批量/单设备旋转分支抢先命中，转到了别的、
    // 早就选中的旧设备上而不是手上这个新设备(见下面 keydown 'r' 分支的
    // 优先级)。
    state.selectedId = null;
    state.selectedConnectionId = null;
    state.selectedPipeConnectionId = null;
    resetBoxSelectTransientState();
    state.spawning = true;
    state.spawningTemplateKey = key;
    state.spawnRotSteps = 0;
    state.spawnPointerX = e.clientX;
    state.spawnPointerY = e.clientY;
    updateSpawnPreview(e.clientX, e.clientY);
    draw();
  });

  window.addEventListener('mousemove', (e) => {
    if (!state.spawning) return;
    state.spawnPointerX = e.clientX;
    state.spawnPointerY = e.clientY;
    updateSpawnPreview(e.clientX, e.clientY);
    draw();
  });

  window.addEventListener('mouseup', (e) => {
    if (!state.spawning) return;
    state.spawning = false;

    const template = SPAWN_TEMPLATES.find(t => t.key === state.spawningTemplateKey);
    if (state.spawnPreview && template && !isPointInToolbar(e.clientX, e.clientY)) {
      pushHistory();
      // 落地时把预览阶段按 R 键累积的旋转(state.spawnRotSteps)固化到新设备的
      // w/h/rot(facility)或 mainOutEdge/mainInEdge(汇流器/分流器)上，和预览
      // (updateSpawnPreview/render.js 的 drawSpawnPreview)共用同一份换算逻辑。
      const oriented = getSpawnOrientedFields(template, state.spawnRotSteps);
      const newDevice = {
        id: state.nextId++,
        gridX: state.spawnPreview.gridX,
        gridY: state.spawnPreview.gridY,
        w: oriented.w,
        h: oriented.h,
        rot: oriented.rot || 0,
        kind: template.kind,
        color: template.color,
        borderColor: template.borderColor,
        // 汇流器/分流器(含管道版)工具栏图标显示全称(template.label)方便识别，
        // 但落到画布上的节点标签沿用 splitConnectionAtCell 那一路"汇"/"分"短标签
        // (template.deviceLabel，见 devices.js 的 NODE_TEMPLATES)，facility 设备
        // 没有这个字段，直接退回 template.label(本来就是同一个全称)。
        label: template.deviceLabel || template.label,
        // facility 设备专属：facilityId 标记它是 facilities.js 里哪个设备种类
        // (和 dev.id 这个"实例编号"是两回事)；ports 是该种类的原始端口数据，
        // 落地时整体拷贝一份到实例上，供 getDevicePorts() 的 facilityDevicePorts
        // 分支使用，不用在渲染/寻路时反过来查 FACILITIES——这样 cloneCanvasState()
        // 的无差别深拷贝天然就能把它带过 Ctrl+Z 撤销栈，不用额外处理。
        ...(template.kind === 'facility' ? {
          facilityId: template.key,
          ports: template.ports,
          powerCost: template.powerCost,
          powerRange: template.powerRange,
          isLowProfile: template.isLowProfile,
          // 配方槽位面板('recipe')或自由选物品面板('port')用的槽位数据，见
          // recipeSlots.js 的 buildInitialSlotState；两种面板都用不上的设备
          // (没有 slots 字段、也不在 PORT_ITEM_FACILITY_IDS 里)得到 {}，右键
          // 不会命中任何面板分支。落地后随 dev 一起进 cloneCanvasState() 的
          // JSON 深拷贝，Ctrl+Z/框选批量拖拽/Ctrl+V 复制都天然带上，不用
          // 额外处理。
          ...buildInitialSlotState(template.key)
        } : {}),
        // 汇流器/分流器(含管道版)专属：mainOutEdge/mainInEdge 决定哪条边固定是
        // 出口/入口，其余边留给用户在自由传送带/管道模式里逐条连接(见
        // nodeDevicePorts)。落地前已经可以用 R 键预旋转(oriented 已经算上了
        // state.spawnRotSteps)，落地后仍可继续用 R 键旋转调整(与 facility 共用
        // 同一套 R 键处理，见下方 keydown 里的分支)。
        ...(oriented.mainOutEdge !== undefined ? { mainOutEdge: oriented.mainOutEdge } : {}),
        ...(oriented.mainInEdge !== undefined ? { mainInEdge: oriented.mainInEdge } : {})
      };
      state.devices.push(newDevice);
      state.selectedId = newDevice.id;
      recomputeAllFlows();
    }
    state.spawnPreview = null;
    state.spawningTemplateKey = null;
    state.spawnRotSteps = 0;
    draw();
  });
}

export function initInteractions() {
  bindCanvasMouseEvents();
  bindKeyboardEvents();
  bindToolbarSpawnEvents();
  bindMapSelectorEvents();
  bindMapConfirmModalEvents();
  bindRecipePanelEvents();
  bindItemPickerEvents();
}
