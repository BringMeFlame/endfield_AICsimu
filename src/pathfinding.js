// ---- 正交 A* 寻路(带转弯惩罚)、连线路径计算与命中测试 ----
import { GRID_SIZE, DIR_E, DIR_S, DIR_W, DIR_N, DIR_VECT, ALL_DIRS, TURN_PENALTY, PORT_HIT_RADIUS, BELT_WIDTH } from './constants.js';
import { state } from './state.js';
import { effectiveGridPos, getDevicePorts, oppositeDir } from './devices.js';
import { worldToScreen } from './coords.js';

class MinHeap {
  constructor() { this.items = []; }
  get size() { return this.items.length; }
  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].f <= a[i].f) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }
  pop() {
    const a = this.items;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      while (true) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let smallest = i;
        if (l < a.length && a[l].f < a[smallest].f) smallest = l;
        if (r < a.length && a[r].f < a[smallest].f) smallest = r;
        if (smallest === i) break;
        [a[smallest], a[i]] = [a[i], a[smallest]];
        i = smallest;
      }
    }
    return top;
  }
}

function manhattan(c1, r1, c2, r2) {
  return Math.abs(c1 - c2) + Math.abs(r1 - r2);
}

export function buildBlockedSet() {
  const set = new Set();
  for (const dev of state.devices) {
    const pos = effectiveGridPos(dev);
    for (let dx = 0; dx < dev.w; dx++) {
      for (let dy = 0; dy < dev.h; dy++) {
        set.add((pos.gridX + dx) + ',' + (pos.gridY + dy));
      }
    }
  }
  return set;
}

export function orientationOf(dir) {
  return (dir === DIR_E || dir === DIR_W) ? 'H' : 'V';
}

// 相邻格 a -> b 的移动方向
function dirBetween(a, b) {
  if (b.col === a.col + 1) return DIR_E;
  if (b.col === a.col - 1) return DIR_W;
  if (b.row === a.row + 1) return DIR_S;
  return DIR_N;
}

// 给定一条连线的格子路径，得到它经过每个格子时使用的朝向('H'/'V')。
// 起点视为沿 startDir 方向进入，终点视为沿 goalDir 方向进入端口
// (两者取自源/目标设备当前的物料流动方向，随设备旋转而变化)。
export function cellOrientationsOf(cellPath, startDir, goalDir) {
  const list = [];
  for (let i = 0; i < cellPath.length; i++) {
    const entryDir = i === 0 ? startDir : dirBetween(cellPath[i - 1], cellPath[i]);
    const exitDir = i === cellPath.length - 1 ? goalDir : dirBetween(cellPath[i], cellPath[i + 1]);
    list.push({ cell: cellPath[i], entryDir, exitDir });
  }
  return list;
}

// 汇总其它传送带占用的格子及朝向，用于新路径的"不可重叠、但允许交叉"约束。
// excludeConnId 用于在重新计算某条连线自身路径时，排除它自己之前占用的格子。
export function buildBeltOccupancy(excludeConnId) {
  const map = new Map();
  for (const c of state.connections) {
    if (c.id === excludeConnId || !c.cellPath) continue;
    for (const { cell, entryDir, exitDir } of cellOrientationsOf(c.cellPath, c.startDir, c.goalDir)) {
      const key = cell.col + ',' + cell.row;
      let set = map.get(key);
      if (!set) { set = new Set(); map.set(key, set); }
      set.add(orientationOf(entryDir));
      set.add(orientationOf(exitDir));
    }
  }
  return map;
}

// 状态空间为 (col, row, dir)：dir 表示到达该格时的移动方向，用于计算转弯惩罚。
// startDir 是进入起点格时视为的移动方向(用于计算第一步是否转弯)，为 null 表示
// 起点没有固定朝向(自由网格起点)——此时第一步无论往哪个方向走都不算转弯，
// 通过同时给 4 个方向都种下代价为 0 的初始状态实现。goalDir 为 null 表示以
// 任意方向到达终点格即可(途经点/自由网格终点)，否则必须恰好沿 goalDir 方向
// 进入终点格(真正的输入口要求笔直接入)。
// beltOccupancy 记录其它传送带占用的格子及朝向：同朝向直行视为重叠(禁止)，
// 仅垂直方向穿过视为合法交叉(允许，渲染时生成物流桥)；已被占用的格子内不允许转弯。
export function aStarOrthogonal(startCol, startRow, startDir, goalCol, goalRow, goalDir, blocked, beltOccupancy) {
  if (startCol === goalCol && startRow === goalRow) {
    return [{ col: startCol, row: startRow }];
  }
  let margin = 16;
  for (let attempt = 0; attempt < 2; attempt++, margin *= 2) {
    const minC = Math.min(startCol, goalCol) - margin, maxC = Math.max(startCol, goalCol) + margin;
    const minR = Math.min(startRow, goalRow) - margin, maxR = Math.max(startRow, goalRow) + margin;

    const gScore = new Map();
    const cameFrom = new Map();
    const heap = new MinHeap();
    const startDirs = startDir === null ? ALL_DIRS : [startDir];
    for (const d0 of startDirs) {
      const key0 = startCol + ',' + startRow + ',' + d0;
      gScore.set(key0, 0);
      heap.push({ key: key0, col: startCol, row: startRow, dir: d0, f: manhattan(startCol, startRow, goalCol, goalRow) });
    }
    const closed = new Set();

    while (heap.size) {
      const node = heap.pop();
      if (closed.has(node.key)) continue;
      closed.add(node.key);

      if (node.col === goalCol && node.row === goalRow && (goalDir === null || node.dir === goalDir)) {
        const path = [];
        let curKey = node.key;
        while (curKey) {
          const [c, r] = curKey.split(',').map(Number);
          path.push({ col: c, row: r });
          curKey = cameFrom.get(curKey);
        }
        path.reverse();
        return path;
      }

      for (let d = 0; d < 4; d++) {
        const nc = node.col + DIR_VECT[d].dx;
        const nr = node.row + DIR_VECT[d].dy;
        if (nc < minC || nc > maxC || nr < minR || nr > maxR) continue;
        if (blocked.has(nc + ',' + nr)) continue;
        const turn = d === node.dir ? 0 : 1;

        if (turn) {
          // 转弯必须发生在没有其它传送带占用的格子，避免拐角与既有带体重叠
          const curOcc = beltOccupancy.get(node.col + ',' + node.row);
          if (curOcc && curOcc.size > 0) continue;
        } else {
          // 直行：目标格若已被同朝向占用视为重叠，禁止；仅被垂直朝向占用则视为合法交叉
          const nOcc = beltOccupancy.get(nc + ',' + nr);
          if (nOcc && nOcc.has(orientationOf(d))) continue;
        }

        const stepCost = 1 + turn * TURN_PENALTY;
        const ng = gScore.get(node.key) + stepCost;
        const nkey = nc + ',' + nr + ',' + d;
        if (!gScore.has(nkey) || ng < gScore.get(nkey)) {
          gScore.set(nkey, ng);
          cameFrom.set(nkey, node.key);
          const h = manhattan(nc, nr, goalCol, goalRow);
          heap.push({ key: nkey, col: nc, row: nr, dir: d, f: ng + h });
        }
      }
    }
  }
  return null;
}

function dedupePoints(pts) {
  const out = [pts[0]];
  for (let i = 1; i < pts.length; i++) {
    const a = out[out.length - 1], b = pts[i];
    if (Math.abs(a.x - b.x) > 0.01 || Math.abs(a.y - b.y) > 0.01) out.push(b);
  }
  return out;
}

// 消除格子路径中的自我重叠：A* 的状态是 (格子, 方向)，当某个格子(尤其是端口
// 入口格)必须以特定方向进入时，算法可能先以别的方向"撞"到该格、再退回一格
// 掉头重新笔直接入，导致同一个格子被经过两次，视觉上出现多余的凸出/回头。
// 这里按"先到先得"截断：格子第二次出现时，直接删掉两次出现之间的所有路段，
// 保证同一条路径里每个格子只出现一次，得到最简的直角走线。
export function removeSelfOverlap(cellPath) {
  if (cellPath.length < 3) return cellPath;
  const result = [];
  const indexOf = new Map();
  for (const cell of cellPath) {
    const key = cell.col + ',' + cell.row;
    if (indexOf.has(key)) {
      const idx = indexOf.get(key);
      result.length = idx + 1;
      for (const [k, v] of indexOf) {
        if (v > idx) indexOf.delete(k);
      }
    } else {
      indexOf.set(key, result.length);
      result.push(cell);
    }
  }
  return result;
}

// 检测一条(可能由多跳拼接而成的)完整格子路径里是否有任何格子被经过不止一次。
// 用于 computePath 判定"传送带不能自我重叠"这条硬性规则——注意这里只做只读检测、
// 不做任何截断/修改，不能和 removeSelfOverlap 混用：截断会把用户故意拖出来的
// 折返造型连同途经点效果一起吃掉(见下方 computePath 里的大段注释)，而这里只是
// 把"会自我重叠的路径"标成 invalid，交给拖拽结束时的还原逻辑去处理。
export function hasSelfOverlap(cellPath) {
  const seen = new Set();
  for (const cell of cellPath) {
    const key = cell.col + ',' + cell.row;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

// 合并折线中方向相同的连续共线点，得到干净的直角拐点序列
function simplifyCollinear(pts) {
  if (pts.length < 3) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const prev = out[out.length - 1], cur = pts[i], next = pts[i + 1];
    const dx1 = cur.x - prev.x, dy1 = cur.y - prev.y;
    const dx2 = next.x - cur.x, dy2 = next.y - cur.y;
    const collinear =
      (dx1 === 0 && dx2 === 0 && Math.sign(dy1) === Math.sign(dy2)) ||
      (dy1 === 0 && dy2 === 0 && Math.sign(dx1) === Math.sign(dx2));
    if (!collinear) out.push(cur);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// 解析连线一端的实际位置：若绑定了设备端口，取该端口(自带 dir，钢体/汇流器/
// 分流器统一适用)；若是自由网格端点(cell)，取格子中心，dir=null 表示不限方向。
export function resolveConnEndpoint(deviceId, port, cell, isOutput) {
  if (deviceId !== null && deviceId !== undefined) {
    const dev = state.devices.find(d => d.id === deviceId);
    if (!dev) return null;
    const pos = effectiveGridPos(dev);
    const list = isOutput ? getDevicePorts(dev, pos).outputs : getDevicePorts(dev, pos).inputs;
    const p = list.find(pp => pp.index === port);
    if (!p) return null;
    return { x: p.x, y: p.y, cellCol: p.cellCol, cellRow: p.cellRow, dir: p.dir };
  }
  if (cell) {
    return { x: (cell.col + 0.5) * GRID_SIZE, y: (cell.row + 0.5) * GRID_SIZE, cellCol: cell.col, cellRow: cell.row, dir: null };
  }
  return null;
}

// 在一组候选端口(如汇流器空闲的输入口、分流器空闲的输出口)中，选出到
// (otherCol,otherRow,otherDir) 寻路代价最小(以格数近似)的一个。
// isCandidateOutput=true 表示候选端口是路径的起点(如分流器新分支的起点)，
// 否则候选端口是路径的终点(如汇流器新分支的终点)。
export function pickBestPort(candidates, otherCol, otherRow, otherDir, isCandidateOutput, blocked, beltOccupancy) {
  let best = null, bestLen = Infinity;
  for (const port of candidates) {
    const path = isCandidateOutput
      ? aStarOrthogonal(port.cellCol, port.cellRow, port.dir, otherCol, otherRow, otherDir, blocked, beltOccupancy)
      : aStarOrthogonal(otherCol, otherRow, otherDir, port.cellCol, port.cellRow, port.dir, blocked, beltOccupancy);
    if (path && path.length < bestLen) { bestLen = path.length; best = port; }
  }
  return best;
}

// 按格子曼哈顿距离选最近端口(不寻路)。用于"点在设备本体上"的兜底选择：
// 此时参照点(点击处)本身落在设备footprint内部、是被阻挡的格子，无法用 A*
// 计算路径距离，因此改用几何距离——这也更符合"点哪就选哪一侧端口"的直觉。
export function pickNearestPortByDistance(candidates, refCol, refRow) {
  let best = null, bestDist = Infinity;
  for (const port of candidates) {
    const d = Math.abs(port.cellCol - refCol) + Math.abs(port.cellRow - refRow);
    if (d < bestDist) { bestDist = d; best = port; }
  }
  return best;
}

// 计算一条连线从起点到终点的最佳直角路径。起点/终点既可以是设备端口
// (钢体的固定朝向输出/输入口，或汇流器/分流器某条边上的端口)，也可以是
// 不属于任何设备的自由网格端点(conn.fromCell/toCell)，此时不限制笔直方向。
// 传送带之间不允许重叠，但允许十字交叉(交叉处渲染物流桥)，因此需要排除
// 该连线自身之前占用的格子后，再依据其它连线的占用情况进行寻路。
// 若连线带有手动途经点(conn.waypoints)，则依次对"起点→途经点1→…→终点"
// 的每一段分别寻路再首尾相接，途经点之间的转向不做方向限制，只有最终进入
// 终点那一段仍遵循终点自身的方向要求，从而让用户能强制路线绕开某片区域、
// 自由摆造型，同时仍复用同一套避障/转弯惩罚/不重叠规则。
export function computePath(conn) {
  const startPort = resolveConnEndpoint(conn.fromDeviceId, conn.fromPort, conn.fromCell, true);
  const endPort = resolveConnEndpoint(conn.toDeviceId, conn.toPort, conn.toCell, false);
  if (!startPort || !endPort) return { points: [], cellPath: null, startDir: null, goalDir: null, invalid: true };

  const startDir = startPort.dir;
  const goalDir = endPort.dir;

  const blocked = buildBlockedSet();
  const beltOccupancy = buildBeltOccupancy(conn.id);

  const checkpoints = [
    { col: startPort.cellCol, row: startPort.cellRow },
    ...(conn.waypoints || []),
    { col: endPort.cellCol, row: endPort.cellRow }
  ];

  // 注意：这里绝对不能对拼接后的完整路径整体做 removeSelfOverlap 去"截断"路径
  // (那是修过的真实 bug："拖不动"：截断会把用户故意拖出来的折返造型连同
  // 途经点效果一起吃掉，详见 git log 里 `fix: waypoint drag no longer erases
  // itself`)。但传送带物理上也不能自我重叠——所以正确的做法不是"算完再拒绝"，
  // 而是让后面的跳一开始就知道前面的跳已经用过哪些格子：从第二跳起，把前面
  // 所有跳走过的格子临时并入 blocked，逼 A* 在"确实需要往回走"的位置改为绕
  // 一圈找一条不重叠的路(比如以途经点为中心绕出一个 U 形)，而不是走代价更
  // 低、但会原路重叠的直线。只有当绕行也无路可走(比如被四周设备完全围死)时，
  // 这一跳才会真的返回 null，落到下面"找不到路径"的红色警示分支。
  let fullCellPath = null;
  let curDir = startDir;
  for (let i = 0; i < checkpoints.length - 1; i++) {
    const a = checkpoints[i], b = checkpoints[i + 1];
    const hopGoalDir = i === checkpoints.length - 2 ? goalDir : null;
    let hopPath = aStarOrthogonal(a.col, a.row, curDir, b.col, b.row, hopGoalDir, blocked, beltOccupancy);
    if (!hopPath) { fullCellPath = null; break; }
    hopPath = removeSelfOverlap(hopPath);
    fullCellPath = fullCellPath === null ? hopPath : fullCellPath.concat(hopPath.slice(1));
    if (hopPath.length >= 2) curDir = dirBetween(hopPath[hopPath.length - 2], hopPath[hopPath.length - 1]);
    for (const c of hopPath) blocked.add(c.col + ',' + c.row);
  }

  if (!fullCellPath) {
    return { points: [{ x: startPort.x, y: startPort.y }, { x: endPort.x, y: endPort.y }], cellPath: null, startDir, goalDir, invalid: true };
  }
  // 上面逐跳把已走过的格子并入 blocked 之后，拼接出来的完整路径按构造就不可能
  // 自我重叠了；这里仍然保留一次只读校验作为兜底(不影响任何合法路径，纯粹是
  // 防止后续改动这块逻辑时不小心破坏了这个不变量却没人发现)。
  if (hasSelfOverlap(fullCellPath)) {
    const previewPts = [{ x: startPort.x, y: startPort.y }];
    for (const c of fullCellPath) {
      previewPts.push({ x: (c.col + 0.5) * GRID_SIZE, y: (c.row + 0.5) * GRID_SIZE });
    }
    previewPts.push({ x: endPort.x, y: endPort.y });
    return { points: dedupePoints(previewPts), cellPath: null, startDir, goalDir, invalid: true };
  }

  const pts = [{ x: startPort.x, y: startPort.y }];
  for (const c of fullCellPath) {
    pts.push({ x: (c.col + 0.5) * GRID_SIZE, y: (c.row + 0.5) * GRID_SIZE });
  }
  pts.push({ x: endPort.x, y: endPort.y });

  return { points: simplifyCollinear(dedupePoints(pts)), cellPath: fullCellPath, startDir, goalDir, invalid: false };
}

// 设备布局发生任何变化(拖动/新增/删除)都可能影响其他连线的最佳绕行路径，
// 因此统一重新计算全部连线，而不仅是与该设备直接相连的连线。
export function recomputeAllConnections() {
  for (const c of state.connections) {
    const res = computePath(c);
    c.points = res.points;
    c.cellPath = res.cellPath;
    c.startDir = res.startDir;
    c.goalDir = res.goalDir;
    c.invalid = res.invalid;
  }
}

// 在所有连线中查找经过 (col,row) 这一格的连线及其在该格的进入/离开方向，
// 用于自动汇流(终点落在已有传送带上)和 Alt+点击生成分流器。
export function findConnectionAtCell(col, row) {
  for (const c of state.connections) {
    if (!c.cellPath) continue;
    for (const { cell, entryDir, exitDir } of cellOrientationsOf(c.cellPath, c.startDir, c.goalDir)) {
      if (cell.col === col && cell.row === row) return { conn: c, entryDir, exitDir };
    }
  }
  return null;
}

// 在既有传送带的 (col,row) 格处插入一个汇流器/分流器节点：把原连线按 entryDir/
// exitDir 拆成"起点→节点输入口"与"节点输出口→终点"两段，节点占用
// mainInEdge=oppositeDir(entryDir)、mainOutEdge=exitDir 两条边(原流向保持不变)，
// 其余边留给新的合流/分流分支使用(汇流器多出 2 个空闲输入边，分流器多出 2 个
// 空闲输出边，天然满足"3 进 1 出"/"1 进 3 出"的容量上限)。
export function splitConnectionAtCell(hostConn, cell, entryDir, exitDir, kind) {
  const mainInEdge = oppositeDir(entryDir);
  const mainOutEdge = exitDir;
  const node = {
    id: state.nextId++,
    kind,
    gridX: cell.col, gridY: cell.row, w: 1, h: 1,
    mainInEdge, mainOutEdge,
    color: kind === 'merger' ? '#ffd54f' : '#4fc3f7',
    borderColor: '#111',
    label: kind === 'merger' ? '汇' : '分'
  };
  state.devices.push(node);

  const connA = {
    id: state.nextConnId++,
    fromDeviceId: hostConn.fromDeviceId, fromPort: hostConn.fromPort, fromCell: hostConn.fromCell,
    toDeviceId: node.id, toPort: mainInEdge, toCell: null,
    waypoints: [], points: [], cellPath: null, startDir: null, goalDir: null, invalid: false
  };
  const connB = {
    id: state.nextConnId++,
    fromDeviceId: node.id, fromPort: mainOutEdge, fromCell: null,
    toDeviceId: hostConn.toDeviceId, toPort: hostConn.toPort, toCell: hostConn.toCell,
    waypoints: [], points: [], cellPath: null, startDir: null, goalDir: null, invalid: false
  };

  state.connections = state.connections.filter(c => c.id !== hostConn.id);
  state.connections.push(connA, connB);
  recomputeAllConnections();
  return node;
}

// 找出所有传送带的合法交叉点(一条水平直行 + 一条垂直直行共用同一格)，
// 用于在绘制时生成物流桥。约定：水平方向的传送带走"桥面"，垂直方向的走"桥下"。
export function computeCrossings() {
  const cellMap = new Map();
  for (const c of state.connections) {
    if (!c.cellPath) continue;
    for (const { cell, entryDir, exitDir } of cellOrientationsOf(c.cellPath, c.startDir, c.goalDir)) {
      if (entryDir !== exitDir) continue; // 拐弯格不可能与其它传送带共用，跳过
      const key = cell.col + ',' + cell.row;
      let arr = cellMap.get(key);
      if (!arr) { arr = []; cellMap.set(key, arr); }
      arr.push({ conn: c, orientation: orientationOf(entryDir) });
    }
  }
  const crossings = [];
  for (const [key, arr] of cellMap) {
    const h = arr.find(e => e.orientation === 'H');
    const v = arr.find(e => e.orientation === 'V');
    if (h && v) {
      const [col, row] = key.split(',').map(Number);
      crossings.push({ col, row, overConn: h.conn });
    }
  }
  return crossings;
}

function distPointToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

// 返回 { conn, segmentIndex }：segmentIndex 是命中的 conn.points[j]-conn.points[j+1] 线段下标，
// 供手动拖拽新增途经点时判断插入顺序。
export function hitTestConnection(clientX, clientY) {
  const THRESH = BELT_WIDTH / 2 + 2;
  for (let i = state.connections.length - 1; i >= 0; i--) {
    const c = state.connections[i];
    if (!c.points || c.points.length < 2) continue;
    for (let j = 0; j < c.points.length - 1; j++) {
      const a = worldToScreen(c.points[j].x, c.points[j].y);
      const b = worldToScreen(c.points[j + 1].x, c.points[j + 1].y);
      if (distPointToSegment(clientX, clientY, a.x, a.y, b.x, b.y) <= THRESH) return { conn: c, segmentIndex: j };
    }
  }
  return null;
}

// ---- 手动途经点(拖拽调整传送带路径) ----

export function hitTestWaypoint(clientX, clientY) {
  for (const c of state.connections) {
    if (!c.waypoints) continue;
    for (let i = 0; i < c.waypoints.length; i++) {
      const wp = c.waypoints[i];
      const s = worldToScreen((wp.col + 0.5) * GRID_SIZE, (wp.row + 0.5) * GRID_SIZE);
      const dx = clientX - s.x, dy = clientY - s.y;
      if (dx * dx + dy * dy <= PORT_HIT_RADIUS * PORT_HIT_RADIUS) return { connId: c.id, index: i };
    }
  }
  return null;
}

// 新途经点应插入 conn.waypoints 的下标：数出在被点击线段之前(含)出现的既有途经点数。
export function waypointInsertIndex(conn, segmentIndex) {
  if (!conn.waypoints || conn.waypoints.length === 0) return 0;
  let count = 0;
  for (const wp of conn.waypoints) {
    const wx = (wp.col + 0.5) * GRID_SIZE, wy = (wp.row + 0.5) * GRID_SIZE;
    const idx = conn.points.findIndex(p => Math.abs(p.x - wx) < 0.01 && Math.abs(p.y - wy) < 0.01);
    if (idx !== -1 && idx <= segmentIndex) count++;
  }
  return count;
}
