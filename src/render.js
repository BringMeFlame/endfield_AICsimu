// ---- 绘制 ----
import { GRID_SIZE, BELT_WIDTH, PIPE_WIDTH, BELT_CORNER_RADIUS, BELT_EDGE_WIDTH, BELT_EDGE_COLOR, FLOW_ARROW_STEP, BELT_COLOR, BELT_COLOR_SELECTED, PIPE_COLOR, PIPE_COLOR_SELECTED, BELT_PORT_COLOR, PIPE_PORT_COLOR, PORT_FILL_COLOR, PIPE_ACCENT } from './constants.js';
import { state, ctx } from './state.js';
import { screenToWorld, worldToScreen } from './coords.js';
import { getDeviceRectWorld, effectiveGridPos, computeCollidingIds, getDevicePorts, isInputPortUsed, isOutputPortUsed, isPipeInputPortUsed, isPipeOutputPortUsed, rectsOverlap, SPAWN_TEMPLATES } from './devices.js';
import { computeCrossings, computePipeCrossings } from './pathfinding.js';

// 设备标签用的思源黑体 Black 字重(index.html 已引入 Google Fonts 的 Noto Sans SC)，
// 配合无衬线粗体撑出粗野主义工业风；找不到该字体时按声明顺序退回到系统黑体。
const LABEL_FONT_FAMILY = "'Noto Sans SC', 'PingFang SC', 'Microsoft YaHei', sans-serif";

// 把一个"缩放 1x 时的屏幕像素数"换算成当前缩放下的实际屏幕像素——传送带/管道/
// 箭头/端口/途经点这些尺寸都要经过这个函数，才能在地图缩放时跟着设备和网格一起
// 等比例放大缩小(否则只有点位置通过 worldToScreen 缩放，尺寸类数值还是缩放前的
// 固定像素值，zoom in 后比例就会失调)。
function scaled(px) {
  return px * state.scale;
}

function drawGrid() {
  const w = window.innerWidth;
  const h = window.innerHeight;

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = '#eeeeec';
  ctx.fillRect(0, 0, w, h);

  const topLeft = screenToWorld(0, 0);
  const bottomRight = screenToWorld(w, h);

  const startCol = Math.floor(topLeft.x / GRID_SIZE);
  const endCol = Math.ceil(bottomRight.x / GRID_SIZE);
  const startRow = Math.floor(topLeft.y / GRID_SIZE);
  const endRow = Math.ceil(bottomRight.y / GRID_SIZE);

  ctx.strokeStyle = 'rgba(0, 0, 0, 0.08)';
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

  ctx.strokeStyle = 'rgba(0, 0, 0, 0.22)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  const originScreen = worldToScreen(0, 0);
  ctx.moveTo(originScreen.x, 0);
  ctx.lineTo(originScreen.x, h);
  ctx.moveTo(0, originScreen.y);
  ctx.lineTo(w, originScreen.y);
  ctx.stroke();
}

// 沿矩形内部画一组 45° 斜纹(裁剪到矩形范围内)。选中态的设备本体、以及选中态
// 标签文字的强调效果，两处都复用这同一个辅助函数，只是描边颜色/间距/裁剪区域
// (矩形 vs 文字字形，见 drawHatchClippedText)不同。
function drawDiagonalHatch(x, y, w, h, spacing, color, lineWidth) {
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();
  for (let d = -h; d < w + h; d += spacing) {
    ctx.moveTo(x + d, y);
    ctx.lineTo(x + d + h, y + h);
  }
  ctx.stroke();
}

// 选中态：设备保持白底不变，内部叠一层裁剪在矩形范围内的浅灰斜纹——纯色块(淡
// 黄底色)试过对比度不够不够醒目，斜纹本身的线条感更贴合工业风、也不需要靠色相
// 才能看清。
function drawSelectionMarks(topLeft, sw, sh) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(topLeft.x, topLeft.y, sw, sh);
  ctx.clip();
  drawDiagonalHatch(topLeft.x, topLeft.y, sw, sh, scaled(10), 'rgba(17, 17, 17, 0.18)', scaled(2));
  ctx.restore();
}

// 选中态下给标签文字本身也叠一层灰色斜纹强调：先在一块独立的离屏 canvas 上把
// 文字画成纯黑色，再用 globalCompositeOperation='source-atop' 画斜纹——这个
// 合成模式只在"已经有不透明像素"的地方叠色，效果就是斜纹只出现在文字笔画内部
// (而不是文字外面的空白处)，最后把这块离屏 canvas 整体贴回主画布。离屏 canvas
// 的合成运算只应该影响这一小块文字位图，不能直接在主 canvas 上用 source-atop
// (那样会把斜纹叠到文字所在矩形范围内所有已经画好的像素上，包括设备边框/底色)。
function drawHatchedLabel(text, font, cx, cy) {
  ctx.font = font;
  const metrics = ctx.measureText(text);
  const padding = scaled(4);
  const w = Math.max(1, Math.ceil(metrics.width + padding * 2));
  const h = Math.max(1, Math.ceil((metrics.actualBoundingBoxAscent || 12) + (metrics.actualBoundingBoxDescent || 4) + padding * 2));

  const off = document.createElement('canvas');
  off.width = w;
  off.height = h;
  const octx = off.getContext('2d');
  octx.font = font;
  octx.fillStyle = '#111';
  octx.textAlign = 'center';
  octx.textBaseline = 'middle';
  octx.fillText(text, w / 2, h / 2);

  octx.globalCompositeOperation = 'source-atop';
  octx.strokeStyle = 'rgba(140, 140, 140, 0.9)';
  octx.lineWidth = Math.max(1, scaled(1.4));
  octx.beginPath();
  const spacing = Math.max(2, scaled(3));
  for (let d = -h; d < w + h; d += spacing) {
    octx.moveTo(d, 0);
    octx.lineTo(d + h, h);
  }
  octx.stroke();

  ctx.drawImage(off, cx - w / 2, cy - h / 2);
}

// 标签自动换行：设备名称带上模式后缀(如"（气液）")后，在占地较小的设备上
// 单行会画出矩形边界、甚至盖住端口箭头。中日韩文本没有空格可断词，这里按
// 字符边界贪心换行——只要加上下一个字符会超宽就另起一行。优先在"（"前断行
// (设备名一行、模式后缀单独一行，视觉上比在名字中间硬断更整齐)：先把文本
// 切成"括号前"/"括号及之后"两段各自换行，而不是整段一起贪心，这样只要两段
// 各自能塞进一行，"（"前就一定会换行；某一段本身还是太宽时，段内继续按字符
// 贪心换行兜底。
function wrapLabelLines(text, font, maxWidth) {
  ctx.font = font;
  const bracketIdx = text.indexOf('（');
  const segments = bracketIdx > 0 ? [text.slice(0, bracketIdx), text.slice(bracketIdx)] : [text];
  const lines = [];
  for (const seg of segments) {
    let line = '';
    for (const ch of seg) {
      const next = line + ch;
      if (line && ctx.measureText(next).width > maxWidth) {
        lines.push(line);
        line = ch;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function drawDeviceRect(rect, dev, opts) {
  const topLeft = worldToScreen(rect.x, rect.y);
  const sw = rect.w * state.scale;
  const sh = rect.h * state.scale;

  ctx.save();
  ctx.globalAlpha = opts.dragging ? 0.85 : 1;
  ctx.fillStyle = dev.color;
  ctx.fillRect(topLeft.x, topLeft.y, sw, sh);

  ctx.lineWidth = scaled(3);
  ctx.strokeStyle = dev.borderColor;
  ctx.strokeRect(topLeft.x, topLeft.y, sw, sh);

  // 重叠警示：半透明红色覆盖 + 红色描边
  if (opts.colliding) {
    ctx.fillStyle = 'rgba(255, 0, 0, 0.45)';
    ctx.fillRect(topLeft.x, topLeft.y, sw, sh);
    ctx.lineWidth = scaled(3);
    ctx.strokeStyle = '#ff1744';
    ctx.strokeRect(topLeft.x, topLeft.y, sw, sh);
  }

  // 选中高亮：不再用黄色虚线扩边框(那是深色地图时代的配色，白色基调下对比度不
  // 够)，也不叠斜纹/边缘标记(视觉上太抢)，改成设备内部一层极淡的黄色底色。
  if (opts.selected) {
    drawSelectionMarks(topLeft, sw, sh);
  }

  // 自由传送带模式下悬停在设备本体(非精确端口)上：高亮提示"点击即可自动接入最近端口"
  if (opts.freeBeltHover) {
    ctx.lineWidth = scaled(3);
    ctx.strokeStyle = 'rgba(102, 187, 106, 0.9)';
    const o = scaled(2);
    ctx.strokeRect(topLeft.x - o, topLeft.y - o, sw + o * 2, sh + o * 2);
  }

  // 自由管道模式下悬停在设备本体上，镜像上面的传送带版，改用管道强调色
  if (opts.freePipeHover) {
    ctx.lineWidth = scaled(3);
    ctx.strokeStyle = PIPE_ACCENT;
    const o = scaled(2);
    ctx.strokeRect(topLeft.x - o, topLeft.y - o, sw + o * 2, sh + o * 2);
  }

  // 标签：加粗黑体思源黑体，撑出工业风铭牌的感觉；选中态额外叠一层灰色斜纹
  // 强调(drawHatchedLabel)，呼应设备本体的斜纹选中效果。
  if (sw > 24 && sh > 16) {
    ctx.globalAlpha = 1;
    const fontSize = Math.max(10, Math.min(16, sh * 0.22));
    const font = `900 ${fontSize}px ${LABEL_FONT_FAMILY}`;
    const cx = topLeft.x + sw / 2, cy = topLeft.y + sh / 2;
    const maxWidth = Math.max(1, sw - scaled(8));
    let lines = wrapLabelLines(dev.label, font, maxWidth);
    const lineHeight = fontSize * 1.15;
    // 换行只解决横向超宽，缩到极限时占地本身矮到连换行后的行数都塞不下
    // (比如"塑形机（气体）"这种带模式后缀的长标签)——这种程度基本只看得清
    // 大概的方块布局，具体标注已经没有辨识意义，直接缩略成"首字+…"。
    const maxLines = Math.max(1, Math.floor((sh - scaled(4)) / lineHeight));
    if (lines.length > maxLines) {
      lines = [Array.from(dev.label)[0] + '…'];
    }
    const startY = cy - (lines.length - 1) * lineHeight / 2;
    if (opts.selected) {
      lines.forEach((ln, i) => drawHatchedLabel(ln, font, cx, startY + i * lineHeight));
    } else {
      ctx.fillStyle = '#111';
      ctx.font = font;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      lines.forEach((ln, i) => ctx.fillText(ln, cx, startY + i * lineHeight));
    }
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

// 极简风端口指示器：一个指向物料流动方向的实心箭头——形状仍是原来那个扁扁的
// "›"折线(尖端 s*0.6，两翼 ±s)，只是在两翼末端之间多补一条边把它闭合成三角形，
// 内部填白(PORT_FILL_COLOR，呼应"设备白底彩边"的配色习惯，不发明新色相)，边框
// 仍按端口类型区分——传送带口深色，管道口蓝色，方便一眼看出这个口能不能接管道；
// 是否已连接不再单独换一种色相，而是用不透明度表达(未连接半透明、已连接不透明)。
function drawPortMarker(p, connected, flowDir) {
  const screen = worldToScreen(p.x, p.y);
  const color = p.portKind === 'pipe' ? PIPE_PORT_COLOR : BELT_PORT_COLOR;
  const s = scaled(8);

  ctx.save();
  ctx.globalAlpha = connected ? 1 : 0.55;
  ctx.translate(screen.x, screen.y);
  ctx.rotate(angleForDir(flowDir));
  ctx.fillStyle = PORT_FILL_COLOR;
  ctx.strokeStyle = color;
  // 缩小地图时如果单纯乘 state.scale，线宽会跟着无限变细直到肉眼难辨——这里
  // 设一个不随缩放继续变薄的下限(2px)，保证缩得再小箭头依旧看得清；放大时仍然
  // 正常跟着 scaled() 一起变粗。
  ctx.lineWidth = Math.max(2, scaled(3.2));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(-s * 0.5, -s);
  ctx.lineTo(s * 0.6, 0);
  ctx.lineTo(-s * 0.5, s);
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
// 的 arcTo 手法，只是作用在任意折线的每个拐点而不是矩形四角。radius 由调用方
// 传入(已经乘过 scaled())——本项目路径顶点间距最小是一个 GRID_SIZE*scale，
// 缩放范围内都远大于这个小半径，不会出现半径大于半段长度导致的异常拐弯。
function buildRoundedScreenPath2D(screenPoints, radius) {
  const path = new Path2D();
  path.moveTo(screenPoints[0].x, screenPoints[0].y);
  for (let i = 1; i < screenPoints.length - 1; i++) {
    path.arcTo(screenPoints[i].x, screenPoints[i].y, screenPoints[i + 1].x, screenPoints[i + 1].y, radius);
  }
  path.lineTo(screenPoints[screenPoints.length - 1].x, screenPoints[screenPoints.length - 1].y);
  return path;
}

// 沿整条折线按固定间距(FLOW_ARROW_STEP，随缩放换算)绘制小箭头表示流向，拐弯处
// 也保持等间距(用 carry 累计跨线段的剩余距离)。极简风格下这是传送带/管道唯一的
// 方向指示手段，替代旧版的辊轴刻线+单段箭头设计。
function drawFlowArrowsAlongPath(screenPoints, color, size) {
  ctx.save();
  ctx.fillStyle = color;
  const step = scaled(FLOW_ARROW_STEP);
  let carry = step / 2;
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
      d += step;
    }
    carry = d - len;
  }
  ctx.restore();
}

// 传送带/管道渲染为极简风格：一条半透明色带/线条 + 沿途固定间距的小箭头指示
// 方向，不再有辊轴刻线、双层描边等复杂细节。传送带是较宽(约一格 60% 宽度)的
// 琥珀色条带，额外叠一圈半透明淡灰色描边模仿工业钢板边缘；管道是明显更细的
// 蓝灰色线条(不叠描边，靠这个和传送带区分)，两者都半透明，重叠时能互相透视看清。
function drawConnectionPath(c, opts) {
  if (!c.points || c.points.length < 2) return;
  const screenPoints = pathToScreen(c.points);
  const isPipe = opts.network === 'pipe';
  const baseWidth = isPipe ? PIPE_WIDTH : BELT_WIDTH;
  const width = scaled(baseWidth);
  const path = buildRoundedScreenPath2D(screenPoints, scaled(BELT_CORNER_RADIUS));

  // 无效路径(拖拽途经点/设备到无法计算出直角路径的位置)：用半透明红色警示预览，
  // 与设备重叠时的红色警告色呼应，而不是渲染成一条正常的传送带/管道。
  let color;
  if (c.invalid) color = 'rgba(255, 23, 68, 0.55)';
  else if (isPipe) color = opts.selected ? PIPE_COLOR_SELECTED : PIPE_COLOR;
  else color = opts.selected ? BELT_COLOR_SELECTED : BELT_COLOR;

  ctx.save();
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (c.invalid) ctx.setLineDash([scaled(10), scaled(6)]);

  // 传送带描边：先在带体外侧画一圈更宽的半透明淡灰色，再在上面画正常宽度的
  // 带体本身，靠宽度差让灰色描边从两侧"露出来"，不需要额外裁剪路径。无效态
  // (红色警示虚线)不叠描边，保持警示色纯粹。
  if (!isPipe && !c.invalid) {
    ctx.strokeStyle = BELT_EDGE_COLOR;
    ctx.lineWidth = width + scaled(BELT_EDGE_WIDTH) * 2;
    ctx.stroke(path);
  }

  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.stroke(path);
  ctx.setLineDash([]);
  ctx.restore();

  if (!c.invalid) {
    const arrowColor = isPipe ? 'rgba(30, 42, 48, 0.85)' : 'rgba(93, 64, 4, 0.85)';
    const arrowSize = scaled(isPipe ? 4 : 6);
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
// 连线在此正交交叉而非物理重叠。width 传对应网络"缩放 1x"时的线宽(传送带
// BELT_WIDTH 或管道 PIPE_WIDTH)，函数内部统一 scaled()，否则管道这种细线交叉
// 会被套上按传送带宽度算出的巨大桥体。
function drawLogisticsBridge(col, row, overColor, baseWidth) {
  const center = worldToScreen((col + 0.5) * GRID_SIZE, (row + 0.5) * GRID_SIZE);
  const width = scaled(baseWidth);
  const deckSize = width + scaled(10);
  const half = deckSize / 2;
  const tw = width - Math.min(scaled(5), width * 0.4);

  ctx.save();
  ctx.translate(center.x, center.y);

  ctx.fillStyle = '#374151';
  roundRectPathAt(-half, -half, deckSize, deckSize, scaled(4));
  ctx.fill();

  ctx.fillStyle = '#8b95a1';
  roundRectPathAt(-half + scaled(2), -half + scaled(2), deckSize - scaled(4), deckSize - scaled(4), scaled(3));
  ctx.fill();

  // 桥下(纵向传送带)的通道口
  const notch = scaled(3);
  ctx.fillStyle = '#20242b';
  ctx.fillRect(-tw / 2, -half, tw, notch);
  ctx.fillRect(-tw / 2, half - notch, tw, notch);

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

// 手动途经点：菱形手柄，可拖拽移动、双击删除，用于自由调整传送带走向。白底黑边，
// 和设备的"白底黑边"视觉语言保持一致。
function drawWaypointHandle(wp, dragging) {
  const screen = worldToScreen((wp.col + 0.5) * GRID_SIZE, (wp.row + 0.5) * GRID_SIZE);
  const s = scaled(6);
  ctx.save();
  ctx.fillStyle = dragging ? '#ffeb3b' : '#ffffff';
  ctx.strokeStyle = '#222';
  ctx.lineWidth = scaled(1.5);
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

// 自由传送带模式下"起点 A → 当前悬停格"的实时 A* 预览路径(虚线折线)。
// state.freeBeltPreviewPts 的首/尾点在起点绑定了设备端口、或悬停终点精确落在
// 某个空闲输入口时，会是端口本身的精确世界坐标(而不是端口外侧格的格心)，见
// interactions.js 的 updateFreePreview——这里只管画，不用关心这个细节，画出来
// 自然就是紧贴端口的。
function drawFreeBeltPreview() {
  if (!state.freeBeltMode || !state.freeBeltPreviewPts || state.freeBeltPreviewPts.length < 2) return;
  ctx.save();
  ctx.strokeStyle = 'rgba(102, 187, 106, 0.85)';
  ctx.lineWidth = scaled(3);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.setLineDash([scaled(6), scaled(5)]);
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
  ctx.lineWidth = scaled(3);
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.setLineDash([scaled(6), scaled(5)]);
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
  ctx.lineWidth = scaled(2);
  ctx.setLineDash([scaled(6), scaled(4)]);
  ctx.strokeStyle = wouldCollide ? '#ff1744' : template.borderColor;
  ctx.strokeRect(topLeft.x, topLeft.y, sw, sh);
  ctx.setLineDash([]);
  ctx.restore();
}

// 光标旁的轻量文字提示(如拉线规则被拒绝时的原因说明)：固定屏幕像素大小，不随
// 地图缩放变化——这是贴在光标旁的 UI 提示文字，不是地图内容，缩放会导致文字
// 忽大忽小、反而降低可读性。
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
