// ---- 绘制 ----
import { GRID_SIZE, BELT_WIDTH, PIPE_WIDTH, BELT_CORNER_RADIUS, FLOW_ARROW_STEP, BELT_COLOR, BELT_COLOR_SELECTED, PIPE_COLOR, PIPE_COLOR_SELECTED, BELT_PORT_COLOR, PIPE_PORT_COLOR, PIPE_ACCENT } from './constants.js';
import { state, ctx } from './state.js';
import { screenToWorld, worldToScreen } from './coords.js';
import { getDeviceRectWorld, effectiveGridPos, computeCollidingIds, getDevicePorts, isInputPortUsed, isOutputPortUsed, isPipeInputPortUsed, isPipeOutputPortUsed, rectsOverlap, SPAWN_TEMPLATES } from './devices.js';
import { computeCrossings, computePipeCrossings } from './pathfinding.js';

function drawGrid() {
  const w = window.innerWidth;
  const h = window.innerHeight;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(0, 0, w, h);

  const topLeft = screenToWorld(0, 0);
  const bottomRight = screenToWorld(w, h);

  const startCol = Math.floor(topLeft.x / GRID_SIZE);
  const endCol = Math.ceil(bottomRight.x / GRID_SIZE);
  const startRow = Math.floor(topLeft.y / GRID_SIZE);
  const endRow = Math.ceil(bottomRight.y / GRID_SIZE);

  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  for (let col = startCol; col <= endCol; col++) {
    const sx = Math.round(worldToScreen(col * GRID_SIZE, 0).x) + 0.5;
    ctx.moveTo(sx, 0);
    ctx.lineTo(sx, h);
  }
  for (let row = startRow; row <= endRow; row++) {
    const sy = Math.round(worldToScreen(0, row * GRID_SIZE).y) + 0.5;
    ctx.moveTo(0, sy);
    ctx.lineTo(w, sy);
  }
  ctx.stroke();

  ctx.strokeStyle = 'rgba(255,255,255,0.2)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const originScreen = worldToScreen(0, 0);
  ctx.moveTo(originScreen.x, 0);
  ctx.lineTo(originScreen.x, h);
  ctx.moveTo(0, originScreen.y);
  ctx.lineTo(w, originScreen.y);
  ctx.stroke();
}

function drawDeviceRect(rect, dev, opts) {
  const topLeft = worldToScreen(rect.x, rect.y);
  const sw = rect.w * state.scale;
  const sh = rect.h * state.scale;

  ctx.save();
  ctx.globalAlpha = opts.dragging ? 0.85 : 1;
  ctx.fillStyle = dev.color;
  ctx.fillRect(topLeft.x, topLeft.y, sw, sh);

  ctx.lineWidth = 2;
  ctx.strokeStyle = dev.borderColor;
  ctx.strokeRect(topLeft.x, topLeft.y, sw, sh);

  // 重叠警示：半透明红色覆盖 + 红色描边
  if (opts.colliding) {
    ctx.fillStyle = 'rgba(255, 0, 0, 0.45)';
    ctx.fillRect(topLeft.x, topLeft.y, sw, sh);
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#ff1744';
    ctx.strokeRect(topLeft.x, topLeft.y, sw, sh);
  }

  // 选中高亮
  if (opts.selected) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = '#ffeb3b';
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(topLeft.x - 3, topLeft.y - 3, sw + 6, sh + 6);
    ctx.setLineDash([]);
  }

  // 自由传送带模式下悬停在设备本体(非精确端口)上：高亮提示"点击即可自动接入最近端口"
  if (opts.freeBeltHover) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(102, 187, 106, 0.9)';
    ctx.strokeRect(topLeft.x - 2, topLeft.y - 2, sw + 4, sh + 4);
  }

  // 自由管道模式下悬停在设备本体上，镜像上面的传送带版，改用管道强调色
  if (opts.freePipeHover) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = PIPE_ACCENT;
    ctx.strokeRect(topLeft.x - 2, topLeft.y - 2, sw + 4, sh + 4);
  }

  // 标签
  if (sw > 24 && sh > 16) {
    ctx.globalAlpha = 1;
    ctx.fillStyle = '#111';
    ctx.font = `${Math.max(10, Math.min(16, sh * 0.22))}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(dev.label, topLeft.x + sw / 2, topLeft.y + sh / 2);
  }

  ctx.restore();
}

function drawDevices() {
  const collidingIds = computeCollidingIds();
  for (const dev of state.devices) {
    const pos = effectiveGridPos(dev);
    const rect = getDeviceRectWorld(pos.gridX, pos.gridY, dev.w, dev.h);
    drawDeviceRect(rect, dev, {
      dragging: dev.id === state.draggingDeviceId,
      // 地面冲突警示(管道分流器/汇流器落在已有传送带地面格上)复用同一套红色
      // 重叠警示，见 interactions.js 里 groundConflict 的说明。
      colliding: collidingIds.has(dev.id) || dev.groundConflict === true,
      selected: dev.id === state.selectedId,
      freeBeltHover: dev.id === state.freeBeltHoverDeviceId,
      freePipeHover: dev.id === state.freePipeHoverDeviceId
    });
    drawDevicePorts(dev, pos);
  }
}

// 方向 -> 屏幕空间旋转角度(0°=东，与 DIR_E/S/W/N 的顺时针编号一致)
function angleForDir(dir) {
  return dir * Math.PI / 2;
}

// 极简风端口指示器：一个指向物料流动方向的实心箭头，不再是"圆点+内嵌箭头"。
// 颜色只按端口类型区分——传送带口统一白色，管道口统一浅蓝色，方便一眼看出
// 这个口能不能接管道；是否已连接不再单独换一种色相，而是用不透明度表达
// (未连接半透明、已连接不透明)，避免在这么小的元素上叠加第三条颜色轴。
function drawPortMarker(p, connected, flowDir) {
  const screen = worldToScreen(p.x, p.y);
  const color = p.portKind === 'pipe' ? PIPE_PORT_COLOR : BELT_PORT_COLOR;

  ctx.save();
  ctx.globalAlpha = connected ? 1 : 0.55;
  ctx.translate(screen.x, screen.y);
  ctx.rotate(angleForDir(flowDir));
  ctx.fillStyle = color;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(9, 0);
  ctx.lineTo(-6, -6);
  ctx.lineTo(-6, 6);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawDevicePorts(dev, pos) {
  const ports = getDevicePorts(dev, pos);
  // "是否已连接"必须按 portKind 查对应网络，否则反应池的管道口会永远查到
  // 传送带连线表、显示成"未连接"。
  for (const p of ports.inputs) {
    const connected = p.portKind === 'pipe' ? isPipeInputPortUsed(dev.id, p.index) : isInputPortUsed(dev.id, p.index);
    drawPortMarker(p, connected, p.dir);
  }
  for (const p of ports.outputs) {
    const connected = p.portKind === 'pipe' ? isPipeOutputPortUsed(dev.id, p.index) : isOutputPortUsed(dev.id, p.index);
    drawPortMarker(p, connected, p.dir);
  }
}

function pathToScreen(points) {
  return points.map(p => worldToScreen(p.x, p.y));
}

function buildScreenPath2D(screenPoints) {
  const path = new Path2D();
  path.moveTo(screenPoints[0].x, screenPoints[0].y);
  for (let i = 1; i < screenPoints.length; i++) path.lineTo(screenPoints[i].x, screenPoints[i].y);
  return path;
}

// 传送带/管道折线专用：内部拐点用 arcTo 插入一个固定小半径的圆弧，两端仍是直
// 段(moveTo/lineTo)，让转角"横平竖直"但不是绝对直角。和 roundRectPathAt 同样
// 的 arcTo 手法，只是作用在任意折线的每个拐点而不是矩形四角。半径固定为
// BELT_CORNER_RADIUS，不随线宽缩放——本项目路径顶点间距最小是一个 GRID_SIZE
// (50px)，远大于这个小半径，不会出现半径大于半段长度导致的异常拐弯。
function buildRoundedScreenPath2D(screenPoints) {
  const path = new Path2D();
  path.moveTo(screenPoints[0].x, screenPoints[0].y);
  for (let i = 1; i < screenPoints.length - 1; i++) {
    path.arcTo(screenPoints[i].x, screenPoints[i].y, screenPoints[i + 1].x, screenPoints[i + 1].y, BELT_CORNER_RADIUS);
  }
  path.lineTo(screenPoints[screenPoints.length - 1].x, screenPoints[screenPoints.length - 1].y);
  return path;
}

// 沿整条折线按固定间距(FLOW_ARROW_STEP)绘制小箭头表示流向，拐弯处也保持等
// 间距(用 carry 累计跨线段的剩余距离)。极简风格下这是传送带/管道唯一的
// 方向指示手段，替代旧版的辊轴刻线+单段箭头设计。
function drawFlowArrowsAlongPath(screenPoints, color, size) {
  ctx.save();
  ctx.fillStyle = color;
  let carry = FLOW_ARROW_STEP / 2;
  for (let i = 0; i < screenPoints.length - 1; i++) {
    const a = screenPoints[i], b = screenPoints[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const ux = dx / len, uy = dy / len;
    let d = carry;
    while (d < len) {
      const cx = a.x + ux * d, cy = a.y + uy * d;
      ctx.beginPath();
      ctx.moveTo(cx + ux * size, cy + uy * size);
      ctx.lineTo(cx - ux * size - uy * size * 0.6, cy - uy * size + ux * size * 0.6);
      ctx.lineTo(cx - ux * size + uy * size * 0.6, cy - uy * size - ux * size * 0.6);
      ctx.closePath();
      ctx.fill();
      d += FLOW_ARROW_STEP;
    }
    carry = d - len;
  }
  ctx.restore();
}

// 传送带/管道渲染为极简风格：一条半透明色带/线条 + 沿途固定间距的小箭头指示
// 方向，不再有辊轴刻线、双层描边等复杂细节。传送带是较宽(约一格 80% 宽度)的
// 浅黄色条带，管道是明显更细的蓝灰色线条，两者都半透明，重叠时能互相透视看清。
function drawConnectionPath(c, opts) {
  if (!c.points || c.points.length < 2) return;
  const screenPoints = pathToScreen(c.points);
  const path = buildRoundedScreenPath2D(screenPoints);
  const isPipe = opts.network === 'pipe';
  const width = isPipe ? PIPE_WIDTH : BELT_WIDTH;

  // 无效路径(拖拽途经点/设备到无法计算出直角路径的位置)：用半透明红色警示预览，
  // 与设备重叠时的红色警告色呼应，而不是渲染成一条正常的传送带/管道。
  let color;
  if (c.invalid) color = 'rgba(255, 23, 68, 0.55)';
  else if (isPipe) color = opts.selected ? PIPE_COLOR_SELECTED : PIPE_COLOR;
  else color = opts.selected ? BELT_COLOR_SELECTED : BELT_COLOR;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (c.invalid) ctx.setLineDash([10, 6]);
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke(path);
  ctx.setLineDash([]);
  ctx.restore();

  if (!c.invalid) {
    const arrowColor = isPipe ? 'rgba(224, 247, 255, 0.95)' : 'rgba(93, 64, 4, 0.85)';
    const arrowSize = isPipe ? 4 : 6;
    drawFlowArrowsAlongPath(screenPoints, arrowColor, arrowSize);
  }
}

function roundRectPathAt(x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// 物流桥：横向的一条贯穿桥面，纵向的一条从桥下的通道穿过，用于表示两条同网络
// 连线在此正交交叉而非物理重叠。width 传对应网络的线宽(传送带 BELT_WIDTH 或
// 管道 PIPE_WIDTH)，否则管道这种细线交叉会被套上按传送带宽度算出的巨大桥体。
function drawLogisticsBridge(col, row, overColor, width) {
  const center = worldToScreen((col + 0.5) * GRID_SIZE, (row + 0.5) * GRID_SIZE);
  const deckSize = width + 10;
  const half = deckSize / 2;
  const tw = width - Math.min(5, width * 0.4);

  ctx.save();
  ctx.translate(center.x, center.y);

  ctx.fillStyle = '#374151';
  roundRectPathAt(-half, -half, deckSize, deckSize, 4);
  ctx.fill();

  ctx.fillStyle = '#8b95a1';
  roundRectPathAt(-half + 2, -half + 2, deckSize - 4, deckSize - 4, 3);
  ctx.fill();

  // 桥下(纵向传送带)的通道口
  ctx.fillStyle = '#20242b';
  ctx.fillRect(-tw / 2, -half, tw, 3);
  ctx.fillRect(-tw / 2, half - 3, tw, 3);

  // 桥面(横向传送带)贯穿而过
  ctx.strokeStyle = overColor;
  ctx.lineWidth = tw;
  ctx.lineCap = 'butt';
  ctx.beginPath();
  ctx.moveTo(-half, 0);
  ctx.lineTo(half, 0);
  ctx.stroke();

  ctx.restore();
}

function drawConnections() {
  for (const c of state.connections) {
    drawConnectionPath(c, { selected: c.id === state.selectedConnectionId });
  }
  for (const cr of computeCrossings()) {
    const overColor = cr.overConn.id === state.selectedConnectionId ? BELT_COLOR_SELECTED : BELT_COLOR;
    drawLogisticsBridge(cr.col, cr.row, overColor, BELT_WIDTH);
  }
}

// 管道渲染逐字镜像上面的 drawConnections，只是数据源换成 state.pipeConnections、
// 调色板换成管道蓝色系；物流桥复用同一个 drawLogisticsBridge，只是传入蓝色
// overColor，不需要新的桥体绘制代码。
function drawPipeConnections() {
  for (const c of state.pipeConnections) {
    drawConnectionPath(c, { selected: c.id === state.selectedPipeConnectionId, network: 'pipe' });
  }
  for (const cr of computePipeCrossings()) {
    const overColor = cr.overConn.id === state.selectedPipeConnectionId ? PIPE_COLOR_SELECTED : PIPE_COLOR;
    drawLogisticsBridge(cr.col, cr.row, overColor, PIPE_WIDTH);
  }
}

// 手动途经点：菱形手柄，可拖拽移动、双击删除，用于自由调整传送带走向
function drawWaypointHandle(wp, dragging) {
  const screen = worldToScreen((wp.col + 0.5) * GRID_SIZE, (wp.row + 0.5) * GRID_SIZE);
  const s = 6;
  ctx.save();
  ctx.fillStyle = dragging ? '#ffeb3b' : '#e0e0e0';
  ctx.strokeStyle = '#222';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(screen.x, screen.y - s);
  ctx.lineTo(screen.x + s, screen.y);
  ctx.lineTo(screen.x, screen.y + s);
  ctx.lineTo(screen.x - s, screen.y);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

function drawWaypoints() {
  for (const c of state.connections) {
    if (!c.waypoints) continue;
    for (let i = 0; i < c.waypoints.length; i++) {
      const dragging = !!(state.draggingWaypoint && state.draggingWaypoint.connId === c.id && state.draggingWaypoint.index === i);
      drawWaypointHandle(c.waypoints[i], dragging);
    }
  }
}

// 逐字镜像上面的 drawWaypoints，数据源换成管道连线；菱形手柄颜色不按网络区分，
// 靠位置本身消歧即可。
function drawPipeWaypoints() {
  for (const c of state.pipeConnections) {
    if (!c.waypoints) continue;
    for (let i = 0; i < c.waypoints.length; i++) {
      const dragging = !!(state.draggingPipeWaypoint && state.draggingPipeWaypoint.connId === c.id && state.draggingPipeWaypoint.index === i);
      drawWaypointHandle(c.waypoints[i], dragging);
    }
  }
}

// 自由传送带模式下"起点 A → 当前悬停格"的实时 A* 预览路径(虚线折线)
function drawFreeBeltPreview() {
  if (!state.freeBeltMode || !state.freeBeltPreviewPts || state.freeBeltPreviewPts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(102, 187, 106, 0.85)';
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  const p0 = worldToScreen(state.freeBeltPreviewPts[0].x, state.freeBeltPreviewPts[0].y);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < state.freeBeltPreviewPts.length; i++) {
    const p = worldToScreen(state.freeBeltPreviewPts[i].x, state.freeBeltPreviewPts[i].y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

// 自由管道模式下"起点 A → 当前悬停格"的实时预览，镜像 drawFreeBeltPreview，
// 改用管道强调色。
function drawFreePipePreview() {
  if (!state.freePipeMode || !state.freePipePreviewPts || state.freePipePreviewPts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = PIPE_ACCENT;
  ctx.lineWidth = 3;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  const p0 = worldToScreen(state.freePipePreviewPts[0].x, state.freePipePreviewPts[0].y);
  ctx.moveTo(p0.x, p0.y);
  for (let i = 1; i < state.freePipePreviewPts.length; i++) {
    const p = worldToScreen(state.freePipePreviewPts[i].x, state.freePipePreviewPts[i].y);
    ctx.lineTo(p.x, p.y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.restore();
}

function drawSpawnPreview() {
  if (!state.spawnPreview || !state.spawningTemplateKey) return;
  const template = SPAWN_TEMPLATES.find(t => t.key === state.spawningTemplateKey);
  if (!template) return;
  const rect = getDeviceRectWorld(state.spawnPreview.gridX, state.spawnPreview.gridY, template.w, template.h);

  // 预览时也检测是否会与现有设备重叠
  const rects = state.devices.map(d => {
    const pos = effectiveGridPos(d);
    return { id: d.id, gridX: pos.gridX, gridY: pos.gridY, w: d.w, h: d.h };
  });
  const previewRect = { gridX: state.spawnPreview.gridX, gridY: state.spawnPreview.gridY, w: template.w, h: template.h };
  const wouldCollide = rects.some(r => rectsOverlap(r, previewRect));

  const topLeft = worldToScreen(rect.x, rect.y);
  const sw = rect.w * state.scale;
  const sh = rect.h * state.scale;

  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = wouldCollide ? '#ff1744' : template.color;
  ctx.fillRect(topLeft.x, topLeft.y, sw, sh);
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = wouldCollide ? '#ff1744' : template.borderColor;
  ctx.strokeRect(topLeft.x, topLeft.y, sw, sh);
  ctx.setLineDash([]);
  ctx.restore();
}

// 光标旁的轻量文字提示(如拉线规则被拒绝时的原因说明)
function drawCursorTooltip() {
  if (!state.cursorTooltip) return;
  if (performance.now() > state.cursorTooltip.until) { state.cursorTooltip = null; return; }
  ctx.save();
  ctx.font = '12px system-ui, sans-serif';
  const paddingX = 8, h = 24;
  const textWidth = ctx.measureText(state.cursorTooltip.text).width;
  const w = textWidth + paddingX * 2;
  const x = state.cursorTooltip.x + 14, y = state.cursorTooltip.y - h - 12;
  ctx.fillStyle = 'rgba(20, 20, 20, 0.92)';
  ctx.strokeStyle = '#ff7043';
  ctx.lineWidth = 1;
  roundRectPathAt(x, y, w, h, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ffcc80';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(state.cursorTooltip.text, x + paddingX, y + h / 2);
  ctx.restore();
}

export function draw() {
  drawGrid();
  drawConnections();      // 传送带 + 传送带物流桥
  drawDevices();          // 设备遮住传送带(不变)
  drawWaypoints();
  drawPipeConnections();  // 管道 + 管道物流桥 —— 画在设备之上，呼应"空中单位"语义
  drawPipeWaypoints();
  drawSpawnPreview();
  drawFreeBeltPreview();
  drawFreePipePreview();
  drawCursorTooltip();
}
