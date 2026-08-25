// ---- 绘制 ----
import { GRID_SIZE, BELT_WIDTH, BELT_RUNG_STEP } from './constants.js';
import { state, ctx } from './state.js';
import { screenToWorld, worldToScreen } from './coords.js';
import { getDeviceRectWorld, effectiveGridPos, computeCollidingIds, getDevicePorts, isInputPortUsed, isOutputPortUsed, rectsOverlap, spawnTemplate } from './devices.js';
import { computeCrossings } from './pathfinding.js';

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
      colliding: collidingIds.has(dev.id),
      selected: dev.id === state.selectedId,
      freeBeltHover: dev.id === state.freeBeltHoverDeviceId
    });
    drawDevicePorts(dev, pos);
  }
}

// 方向 -> 屏幕空间旋转角度(0°=东，与 DIR_E/S/W/N 的顺时针编号一致)
function angleForDir(dir) {
  return dir * Math.PI / 2;
}

function drawPortMarker(p, type, deviceId, connected, flowDir) {
  const screen = worldToScreen(p.x, p.y);

  let fill = type === 'input' ? '#42a5f5' : '#ffa726';
  if (connected) fill = '#66bb6a';

  ctx.save();
  ctx.fillStyle = fill;
  ctx.strokeStyle = '#111';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();

  // 方向箭头：指向该设备当前的物料流动方向(随旋转变化)
  ctx.translate(screen.x, screen.y);
  ctx.rotate(angleForDir(flowDir));
  ctx.fillStyle = '#111';
  ctx.beginPath();
  ctx.moveTo(5, 0);
  ctx.lineTo(-2, -4);
  ctx.lineTo(-2, 4);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

function drawDevicePorts(dev, pos) {
  const ports = getDevicePorts(dev, pos);
  // 每个端口用自己的 dir 绘制箭头：钢体所有端口共用同一朝向，
  // 汇流器/分流器上分布在不同边的端口则各自朝向不同。
  for (const p of ports.inputs) drawPortMarker(p, 'input', dev.id, isInputPortUsed(dev.id, p.index), p.dir);
  for (const p of ports.outputs) drawPortMarker(p, 'output', dev.id, isOutputPortUsed(dev.id, p.index), p.dir);
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

// 沿折线绘制均匀分布的垂直刻线，模拟传送带辊轴纹理(拐弯处也保持等间距)
function drawBeltRungs(screenPoints, color) {
  const rungLen = BELT_WIDTH * 0.8;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  let carry = BELT_RUNG_STEP / 2;
  for (let i = 0; i < screenPoints.length - 1; i++) {
    const a = screenPoints[i], b = screenPoints[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 1e-6) continue;
    const ux = dx / len, uy = dy / len;
    const px = -uy, py = ux;
    let d = carry;
    while (d < len) {
      const cx = a.x + ux * d, cy = a.y + uy * d;
      ctx.moveTo(cx + px * rungLen / 2, cy + py * rungLen / 2);
      ctx.lineTo(cx - px * rungLen / 2, cy - py * rungLen / 2);
      d += BELT_RUNG_STEP;
    }
    carry = d - len;
  }
  ctx.stroke();
  ctx.restore();
}

function drawFlowArrows(screenPoints) {
  for (let i = 0; i < screenPoints.length - 1; i++) {
    const a = screenPoints[i], b = screenPoints[i + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.hypot(dx, dy);
    if (len < 20) continue;
    const ux = dx / len, uy = dy / len;
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const size = 5;
    ctx.save();
    ctx.fillStyle = '#fff3e0';
    ctx.beginPath();
    ctx.moveTo(mx + ux * size, my + uy * size);
    ctx.lineTo(mx - ux * size - uy * size * 0.6, my - uy * size + ux * size * 0.6);
    ctx.lineTo(mx - ux * size + uy * size * 0.6, my - uy * size - ux * size * 0.6);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
}

// 传送带渲染为一条带状：深色外框(轨道) + 主色表面 + 等距辊轴刻线 + 流向箭头
function drawConnectionPath(c, opts) {
  if (!c.points || c.points.length < 2) return;
  const screenPoints = pathToScreen(c.points);
  const path = buildScreenPath2D(screenPoints);

  let railColor, surfaceColor;
  // 无效路径(拖拽途经点/设备到无法计算出直角路径的位置)：用半透明红色警示预览，
  // 与设备重叠时的红色警告色呼应，而不是渲染成一条正常的传送带。
  if (c.invalid) { railColor = 'rgba(255, 23, 68, 0.35)'; surfaceColor = 'rgba(255, 23, 68, 0.55)'; }
  else if (opts.selected) { railColor = '#8a6f00'; surfaceColor = '#ffeb3b'; }
  else { railColor = '#5c3d12'; surfaceColor = '#ffa726'; }

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (c.invalid) ctx.setLineDash([10, 6]);

  ctx.strokeStyle = railColor;
  ctx.lineWidth = BELT_WIDTH;
  ctx.stroke(path);

  ctx.strokeStyle = surfaceColor;
  ctx.lineWidth = BELT_WIDTH - 5;
  ctx.stroke(path);

  ctx.setLineDash([]);
  ctx.restore();

  if (!c.invalid) {
    drawBeltRungs(screenPoints, railColor);
    drawFlowArrows(screenPoints);
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

// 物流桥：横向传送带贯穿桥面，纵向传送带从桥下的通道穿过，用于表示两条
// 传送带在此正交交叉而非物理重叠。
function drawLogisticsBridge(col, row, overColor) {
  const center = worldToScreen((col + 0.5) * GRID_SIZE, (row + 0.5) * GRID_SIZE);
  const deckSize = BELT_WIDTH + 10;
  const half = deckSize / 2;
  const tw = BELT_WIDTH - 5;

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
    const overColor = cr.overConn.id === state.selectedConnectionId ? '#ffeb3b' : '#ffa726';
    drawLogisticsBridge(cr.col, cr.row, overColor);
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

function drawSpawnPreview() {
  if (!state.spawnPreview) return;
  const rect = getDeviceRectWorld(state.spawnPreview.gridX, state.spawnPreview.gridY, spawnTemplate.w, spawnTemplate.h);

  // 预览时也检测是否会与现有设备重叠
  const rects = state.devices.map(d => {
    const pos = effectiveGridPos(d);
    return { id: d.id, gridX: pos.gridX, gridY: pos.gridY, w: d.w, h: d.h };
  });
  const previewRect = { gridX: state.spawnPreview.gridX, gridY: state.spawnPreview.gridY, w: spawnTemplate.w, h: spawnTemplate.h };
  const wouldCollide = rects.some(r => rectsOverlap(r, previewRect));

  const topLeft = worldToScreen(rect.x, rect.y);
  const sw = rect.w * state.scale;
  const sh = rect.h * state.scale;

  ctx.save();
  ctx.globalAlpha = 0.5;
  ctx.fillStyle = wouldCollide ? '#ff1744' : spawnTemplate.color;
  ctx.fillRect(topLeft.x, topLeft.y, sw, sh);
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 4]);
  ctx.strokeStyle = wouldCollide ? '#ff1744' : spawnTemplate.borderColor;
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
  drawConnections();
  drawDevices();
  drawWaypoints();
  drawSpawnPreview();
  drawFreeBeltPreview();
  drawCursorTooltip();
}
