// ---- 撤销历史(Ctrl+Z / Cmd+Z) ----
import { HISTORY_LIMIT } from './constants.js';
import { state } from './state.js';
import { draw } from './render.js';
import { BELT_NETWORK } from './pathfinding.js';

export function cloneCanvasState() {
  return {
    devices: JSON.parse(JSON.stringify(state.devices)),
    connections: JSON.parse(JSON.stringify(state.connections)),
    nextId: state.nextId,
    nextConnId: state.nextConnId,
    pipeConnections: JSON.parse(JSON.stringify(state.pipeConnections)),
    nextPipeConnId: state.nextPipeConnId
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
  state.pipeConnections = prev.pipeConnections;
  state.nextPipeConnId = prev.nextPipeConnId;

  // 撤销可能作用在正在进行中的交互上，统一清空所有瞬时交互状态，避免悬空引用
  // (注意 freeBeltMode/freePipeMode 这两个模式开关本身不在此重置之列，只重置
  // "进行中"的状态，和现有 freeBeltMode 的处理方式保持一致)
  state.selectedId = null;
  state.selectedConnectionId = null;
  state.selectedPipeConnectionId = null;
  state.draggingDeviceId = null;
  state.draggingDeviceBeforeSnapshot = null;
  state.draggingWaypoint = null;
  state.pendingWaypointCreate = null;
  state.endpointDrag = null;
  state.draggingPipeWaypoint = null;
  state.pendingPipeWaypointCreate = null;
  state.pipeEndpointDrag = null;
  state.freeBeltStart = null;
  state.freeBeltPreviewPts = null;
  state.freeBeltHoverDeviceId = null;
  state.freePipeStart = null;
  state.freePipePreviewPts = null;
  state.freePipeHoverDeviceId = null;
  state.lastConduitClickCell = null;
  state.spawningTemplateKey = null;
  state.spawnRotSteps = 0;
  state.isPanning = false;

  // 框选批量操作的进行中状态同样要清空(clipboard 除外，它是持久剪贴板数据，
  // 不是"进行到一半"的交互态)。
  state.boxSelectedDeviceIds = new Set();
  state.boxSelectedConnectionIds = new Set();
  state.boxSelectedPipeConnectionIds = new Set();
  state.boxSelectPointerDown = null;
  state.boxSelectMarquee = null;
  state.boxDragBeforeSnapshot = null;
  state.boxDragOrigin = null;
  state.boxDragConnOrigin = null;
  state.boxDragDeltaCol = 0;
  state.boxDragDeltaRow = 0;
  state.pastePending = false;
  state.pastePreview = null;

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
  state.pipeConnections = prev.pipeConnections;
  state.nextPipeConnId = prev.nextPipeConnId;
}

// 判断这次操作是否把某条"操作前就存在、且当时合法"的连线变成了 invalid(不
// 关心操作本身新生成的连线是否 invalid——比如自由传送带模式画一条到不可达位
// 置的新线，维持现有的"画出来、留给用户后续调整"行为，不在这里连带撤销)。
// network 默认为传送带网络；管道分流器/汇流器落在已有传送带地面格上是唯一被
// 批准可以弄坏传送带而不触发这里的例外(那里改用仅检查管道网络自身，见
// interactions.js 里 createSplitterAtClick/finalizeFreeConnection 传 PIPE_UI 时的注释)。
// excludeIds：接续悬空端点时(extendDanglingConnection/fuseDanglingConnections)
// 会复用旧连线的 id 直接原地改写，这条连线本身变 invalid 属于"这次操作的落点
// 不可达，留给用户调整"，和新建连线画到不可达位置是同一类情况，不该被当成
// "顺手弄坏了一条别的连线"——调用方把这次操作主动改写的连线 id 传进来排除掉，
// 这里只关心除它之外、其它连线是否被连带牵连。
export function brokeExistingValidConnection(beforeSnapshot, network = BELT_NETWORK, excludeIds = null) {
  const beforeConns = network.kind === 'pipe' ? beforeSnapshot.pipeConnections : beforeSnapshot.connections;
  const beforeIds = new Set(beforeConns.map(c => c.id));
  const beforeInvalidIds = new Set(beforeConns.filter(c => c.invalid).map(c => c.id));
  return network.getConns().some(c =>
    beforeIds.has(c.id) && !beforeInvalidIds.has(c.id) && c.invalid && !(excludeIds && excludeIds.has(c.id)));
}
