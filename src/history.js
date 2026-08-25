// ---- 撤销历史(Ctrl+Z / Cmd+Z) ----
import { HISTORY_LIMIT } from './constants.js';
import { state } from './state.js';
import { draw } from './render.js';

export function cloneCanvasState() {
  return {
    devices: JSON.parse(JSON.stringify(state.devices)),
    connections: JSON.parse(JSON.stringify(state.connections)),
    nextId: state.nextId,
    nextConnId: state.nextConnId
  };
}

// 在任何会修改设备/连线数据的操作开始前调用，把"操作前"的状态压入历史栈，
// 这样 Ctrl+Z 才能精确回退到该操作之前。栈满 30 条时丢弃最旧的一条。
export function pushHistory() {
  state.history.push(cloneCanvasState());
  if (state.history.length > HISTORY_LIMIT) state.history.shift();
}

export function undo() {
  if (!state.history.length) return;
  const prev = state.history.pop();
  state.devices = prev.devices;
  state.connections = prev.connections;
  state.nextId = prev.nextId;
  state.nextConnId = prev.nextConnId;

  // 撤销可能作用在正在进行中的交互上，统一清空所有瞬时交互状态，避免悬空引用
  state.selectedId = null;
  state.selectedConnectionId = null;
  state.draggingDeviceId = null;
  state.draggingDeviceBeforeSnapshot = null;
  state.draggingWaypoint = null;
  state.pendingWaypointCreate = null;
  state.endpointDrag = null;
  state.freeBeltStart = null;
  state.freeBeltPreviewPts = null;
  state.freeBeltHoverDeviceId = null;
  state.isPanning = false;

  draw();
}

// 撤销"这一步会牵连破坏其它连线"的一次性操作：生成分流器/汇流器这类操作会在
// 画布上放一个新的 1x1 设备，这个设备占的格子如果正好是另一条连线本来合法穿过
// (直行或物流桥交叉)的地方，`recomputeAllConnections()` 就可能让那条本来正常
// 的连线突然找不到路而变 invalid——但从用户视角看，他们只是在别处分了个流，
// 两条路径压根没有冲突，这属于操作的副作用，不该被默默接受。这类操作要么整
// 体成功、要么整体不算数，所以复用 pushHistory() 刚压入的"操作前"快照直接还
// 原，并且不占用 Ctrl+Z 历史(用户角度这次操作根本没有发生)。调用者负责在还
// 原后重置自己的局部/交互状态。
export function revertLastHistoryStep() {
  if (!state.history.length) return;
  const prev = state.history.pop();
  state.devices = prev.devices;
  state.connections = prev.connections;
  state.nextId = prev.nextId;
  state.nextConnId = prev.nextConnId;
}

// 判断这次操作是否把某条"操作前就存在、且当时合法"的连线变成了 invalid(不
// 关心操作本身新生成的连线是否 invalid——比如自由传送带模式画一条到不可达位
// 置的新线，维持现有的"画出来、留给用户后续调整"行为，不在这里连带撤销)。
export function brokeExistingValidConnection(beforeSnapshot) {
  const beforeIds = new Set(beforeSnapshot.connections.map(c => c.id));
  const beforeInvalidIds = new Set(beforeSnapshot.connections.filter(c => c.invalid).map(c => c.id));
  return state.connections.some(c => beforeIds.has(c.id) && !beforeInvalidIds.has(c.id) && c.invalid);
}
