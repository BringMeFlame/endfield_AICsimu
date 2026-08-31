// ---- 绘制 ----
import { GRID_SIZE, BELT_WIDTH, PIPE_WIDTH, BELT_CORNER_RADIUS, BELT_EDGE_WIDTH, BELT_EDGE_COLOR, FLOW_ARROW_STEP, BELT_COLOR, BELT_COLOR_SELECTED, PIPE_COLOR, PIPE_COLOR_SELECTED, INVALID_COLOR, INVALID_COLOR_SELECTED, BELT_PORT_COLOR, PIPE_PORT_COLOR, PORT_FILL_COLOR, PORT_HOVER_FILL_BELT, PORT_HOVER_FILL_PIPE, PIPE_ACCENT, BOX_SELECT_ACCENT, WARNING_ICON_RADIUS, WARNING_COLOR, POWER_RANGE_FILL, POWER_RANGE_STROKE, GAS_ENV_INERT_FILL, GAS_ENV_INERT_STROKE, GAS_ENV_ACID_FILL, GAS_ENV_ACID_STROKE } from './constants.js';
import { state, ctx, powerSummaryEl } from './state.js';
import { screenToWorld, worldToScreen } from './coords.js';
import { getDeviceRectWorld, effectiveGridPos, computeCollidingIds, computeOutOfBoundsIds, computeUnpoweredIds, getPowerRangeRect, computePowerRangeRects, getGasEnvRangeRect, computeGasEnvRangeRects, computeGasEnvWarnings, getDeviceWarnings, getWarningIconWorldPos, getDevicePorts, isInputPortUsed, isOutputPortUsed, isPipeInputPortUsed, isPipeOutputPortUsed, rectsOverlap, SPAWN_TEMPLATES, buildSpawnPreviewDevice } from './devices.js';
import { computeCrossings, computePipeCrossings } from './pathfinding.js';
import { getMapWorldRect } from './mapBounds.js';

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

// 地图边界(固定尺寸地图矩形)：常驻显示，不像供电范围叠层那样有开关。只画描边
// 轮廓，不叠半透明底色——地图外仍然可以合法摆放大部分设备(只有核心/汇流器
// 分流器/仓库存取线源桩与基段这几类受硬边界限制，见 devices.js 的
// requiresMapBounds)，加底色遮罩容易让人误以为界外整体不可用。黑色加粗实线
// (用户反馈半透明灰不够清晰)，和警示红/选中黄/三种操作模式强调色(绿/蓝/紫)
// 区分开，因为这纯粹是静态参考线，不代表任何交互状态。
const MAP_BOUNDARY_COLOR = '#000000';

function drawMapBoundary() {
  if (!state.mapWidthCells || !state.mapHeightCells) return;
  const rect = getMapWorldRect();
  const topLeft = worldToScreen(rect.x, rect.y);
  ctx.save();
  ctx.lineWidth = scaled(4);
  ctx.strokeStyle = MAP_BOUNDARY_COLOR;
  ctx.strokeRect(topLeft.x, topLeft.y, rect.w * state.scale, rect.h * state.scale);
  ctx.restore();
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

// 设备警告图标：贴在设备包围盒右上角的小红点+"!"，复用"警告/无效态统一红色"
// 语义(不为电力警告单开新颜色，见 constants.js WARNING_COLOR)。位置计算复用
// devices.js 的 getWarningIconWorldPos(悬停命中判定也用同一个函数，两处不会
// 因为各写一份坐标算法而错位)。警告类型(未通电/惰气酸气环境未覆盖/...)都在
// devices.js 的 getDeviceWarnings 里判定，新增警告类型时这里不需要改动。
function drawWarningIcon(dev, unpoweredIds, gasEnvWarnings) {
  if (!getDeviceWarnings(dev, unpoweredIds, gasEnvWarnings).length) return;
  const pos = getWarningIconWorldPos(dev);
  const screen = worldToScreen(pos.x, pos.y);
  const r = scaled(WARNING_ICON_RADIUS);

  ctx.save();
  ctx.beginPath();
  ctx.arc(screen.x, screen.y, r, 0, Math.PI * 2);
  ctx.fillStyle = WARNING_COLOR;
  ctx.fill();
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = Math.max(1, scaled(1.5));
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.font = `900 ${Math.max(9, r * 1.3)}px ${LABEL_FONT_FAMILY}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText('!', screen.x, screen.y + r * 0.05);
  ctx.restore();
}

// 悬停在警告图标上的提示浮窗，样式镜像 drawCursorTooltip(深色底+彩色描边)，
// 但描边色换成警告红、且不会自动到点消失——只要 state.hoveredWarningId 还在
// (鼠标仍悬停在图标上)就持续显示，位置紧跟图标本身(随缩放/平移现算，不用
// 记录点击时的静态坐标)。
function drawWarningTooltip() {
  if (!state.hoveredWarningId) return;
  const dev = state.devices.find(d => d.id === state.hoveredWarningId.deviceId);
  if (!dev) return;
  const pos = getWarningIconWorldPos(dev);
  const screen = worldToScreen(pos.x, pos.y);

  ctx.save();
  ctx.font = '12px system-ui, sans-serif';
  const paddingX = 8, h = 24;
  const text = state.hoveredWarningId.text;
  const textWidth = ctx.measureText(text).width;
  const w = textWidth + paddingX * 2;
  const x = screen.x + scaled(WARNING_ICON_RADIUS) + 8, y = screen.y - h / 2;
  ctx.fillStyle = 'rgba(20, 20, 20, 0.92)';
  ctx.strokeStyle = WARNING_COLOR;
  ctx.lineWidth = 1;
  roundRectPathAt(x, y, w, h, 5);
  ctx.fill();
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + paddingX, y + h / 2);
  ctx.restore();
}

function drawDevices() {
  const collidingIds = computeCollidingIds();
  const outOfBoundsIds = computeOutOfBoundsIds();
  const unpoweredIds = computeUnpoweredIds();
  const gasEnvWarnings = computeGasEnvWarnings();
  for (const dev of state.devices) {
    const pos = effectiveGridPos(dev);
    const rect = getDeviceRectWorld(pos.gridX, pos.gridY, dev.w, dev.h);
    drawDeviceRect(rect, dev, {
      dragging: dev.id === state.draggingDeviceId,
      // 地面冲突警示(管道分流器/汇流器落在已有传送带地面格上)、地图边界越界
      // 都复用同一套红色重叠警示，见 interactions.js 里 groundConflict 的说明
      // 和 devices.js 的 computeOutOfBoundsIds。
      colliding: collidingIds.has(dev.id) || dev.groundConflict === true || outOfBoundsIds.has(dev.id),
      // 框选批量选中和普通单选共用同一套黄色斜纹选中视觉(CLAUDE.md："选中态
      // 统一用黄色系")，不为多选另起一种颜色。
      selected: dev.id === state.selectedId || state.boxSelectedDeviceIds.has(dev.id),
      freeBeltHover: dev.id === state.freeBeltHoverDeviceId,
      freePipeHover: dev.id === state.freePipeHoverDeviceId
    });
    drawDevicePorts(dev, pos);
    drawWarningIcon(dev, unpoweredIds, gasEnvWarnings);
  }
}

// 方向 -> 屏幕空间旋转角度(0°=东，与 DIR_E/S/W/N 的顺时针编号一致)
function angleForDir(dir) {
  return dir * Math.PI / 2;
}

// 极简风端口指示器：一个指向物料流动方向的实心箭头——形状仍是原来那个扁扁的
// "›"折线(尖端 s*0.6，两翼 ±s)，只是在两翼末端之间多补一条边把它闭合成三角形，
// 内部填白(PORT_FILL_COLOR，呼应"设备白底彩边"的配色习惯，不发明新色相)，边框
// 仍按端口类型区分——传送带口深色，管道口蓝色，方便一眼看出这个口能不能接管道。
// 内部填充始终完全不透明(不能被半透明的斜纹选中态/网格线透出来，那样线条会
// 显得很乱)；"是否已连接"改成只体现在边框描边的不透明度上(未连接半透明、
// 已连接不透明)，不再对整个箭头(含填充)一起降低透明度。
// portState 三态：null(常态) / 'hover'(空闲态悬停在可拖拽改接的端口上，见
// interactions.js 的 Endpoint Re-attach，输入输出两侧都支持) / 'target'(正在
// 拖拽一段连线、划过的候选目标端口预览)。'hover' 用实心细线描边+亮色填充；
// 'target' 只换填充色、描边粗细和常态完全一致(不代表"这里能发起拖拽"，纯粹
// 提示"松手会接到这里")。
function drawPortMarker(p, connected, flowDir, portState) {
  const screen = worldToScreen(p.x, p.y);
  const color = p.portKind === 'pipe' ? PIPE_PORT_COLOR : BELT_PORT_COLOR;
  const hoverFill = p.portKind === 'pipe' ? PORT_HOVER_FILL_PIPE : PORT_HOVER_FILL_BELT;
  const s = scaled(8);

  ctx.save();
  ctx.translate(screen.x, screen.y);
  ctx.rotate(angleForDir(flowDir));
  ctx.beginPath();
  ctx.moveTo(-s * 0.5, -s);
  ctx.lineTo(s * 0.6, 0);
  ctx.lineTo(-s * 0.5, s);
  ctx.closePath();

  ctx.globalAlpha = 1;
  // hover 和 target 都用亮色填充(传送带黄/管道蓝)取代常态白色；两者的区别
  // 只体现在下面的描边粗细上。
  ctx.fillStyle = portState ? hoverFill : PORT_FILL_COLOR;
  ctx.fill();

  ctx.globalAlpha = connected ? 1 : 0.55; // hover/target 时 connected 恒为 true，不冲突
  // hover(空闲态"这里能拖")用统一深色细线，不用 portKind 本身的颜色(蓝色
  // 描边叠蓝色填充没有对比度)；target(拖拽中候选落点预览)不改描边，保持和
  // 常态完全一致的粗细/颜色，只有 fillStyle 变了。
  ctx.strokeStyle = portState === 'hover' ? '#111111' : color;
  // 缩小地图时如果单纯乘 state.scale，线宽会跟着无限变细直到肉眼难辨——这里
  // 设一个不随缩放继续变薄的下限，保证缩得再小箭头依旧看得清；放大时仍然
  // 正常跟着 scaled() 一起变粗。
  ctx.lineWidth = portState === 'hover' ? Math.max(1, scaled(1.4)) : Math.max(2, scaled(3.2));
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.stroke();
  ctx.restore();
}

function drawDevicePorts(dev, pos) {
  const ports = getDevicePorts(dev, pos);
  // "是否已连接"必须按 portKind 查对应网络，否则反应池的管道口会永远查到
  // 传送带连线表、显示成"未连接"。hoveredPort/dragTargetPort 现在输入输出
  // 两侧都要判(见 state.js 的字段说明)，target 优先于 hover(理论上不会
  // 同时命中：一个只在空闲态算，一个只在拖拽中算)。
  const hp = state.hoveredPort;
  const tp = state.dragTargetPort;
  const stateFor = (p, portType) => {
    if (tp && tp.deviceId === dev.id && tp.index === p.index && tp.portKind === p.portKind && tp.portType === portType) return 'target';
    if (hp && hp.deviceId === dev.id && hp.index === p.index && hp.portKind === p.portKind && hp.portType === portType) return 'hover';
    return null;
  };
  for (const p of ports.inputs) {
    const connected = p.portKind === 'pipe' ? isPipeInputPortUsed(dev.id, p.index) : isInputPortUsed(dev.id, p.index);
    drawPortMarker(p, connected, p.dir, stateFor(p, 'input'));
  }
  for (const p of ports.outputs) {
    const connected = p.portKind === 'pipe' ? isPipeOutputPortUsed(dev.id, p.index) : isOutputPortUsed(dev.id, p.index);
    drawPortMarker(p, connected, p.dir, stateFor(p, 'output'));
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
  // 与设备重叠时的红色警告色呼应，而不是渲染成一条正常的传送带/管道；选中态
  // 同样调更饱和/不透明，和下面 pipe/belt 分支是同一种写法(之前遗漏了这一条，
  // 导致选中的不成立连线和未选中的完全看不出区别)。
  let color;
  if (c.invalid) color = opts.selected ? INVALID_COLOR_SELECTED : INVALID_COLOR;
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
    const selected = c.id === state.selectedConnectionId || state.boxSelectedConnectionIds.has(c.id);
    drawConnectionPath(c, { selected });
  }
  for (const cr of computeCrossings()) {
    const selected = cr.overConn.id === state.selectedConnectionId || state.boxSelectedConnectionIds.has(cr.overConn.id);
    const overColor = selected ? BELT_COLOR_SELECTED : BELT_COLOR;
    drawLogisticsBridge(cr.col, cr.row, overColor, BELT_WIDTH);
  }
}

// 管道渲染逐字镜像上面的 drawConnections，只是数据源换成 state.pipeConnections、
// 调色板换成管道蓝色系；物流桥复用同一个 drawLogisticsBridge，只是传入蓝色
// overColor，不需要新的桥体绘制代码。
function drawPipeConnections() {
  for (const c of state.pipeConnections) {
    const selected = c.id === state.selectedPipeConnectionId || state.boxSelectedPipeConnectionIds.has(c.id);
    drawConnectionPath(c, { selected, network: 'pipe' });
  }
  for (const cr of computePipeCrossings()) {
    const selected = cr.overConn.id === state.selectedPipeConnectionId || state.boxSelectedPipeConnectionIds.has(cr.overConn.id);
    const overColor = selected ? PIPE_COLOR_SELECTED : PIPE_COLOR;
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

// 选中供电桩/中继器时画出它的方形供电范围，方便规划布局；不常驻显示，避免
// 单个供电覆盖范围方块的绘制，H 键全局叠层(drawPowerRanges)和工具栏拖拽生成
// 供电桩/中继器时的落地预览(drawSpawnPreview)共用，保证两处视觉一致。
function drawPowerRangeRect(r) {
  const rect = getDeviceRectWorld(r.gridX, r.gridY, r.w, r.h);
  const topLeft = worldToScreen(rect.x, rect.y);
  const sw = rect.w * state.scale;
  const sh = rect.h * state.scale;
  ctx.fillStyle = POWER_RANGE_FILL;
  ctx.fillRect(topLeft.x, topLeft.y, sw, sh);
  ctx.lineWidth = scaled(2);
  ctx.setLineDash([scaled(8), scaled(5)]);
  ctx.strokeStyle = POWER_RANGE_STROKE;
  ctx.strokeRect(topLeft.x, topLeft.y, sw, sh);
  ctx.setLineDash([]);
}

// 供电覆盖范围叠层(H 键全局开关)：半透明黄橙色方块，覆盖 devices.js
// computePowerRangeRects() 算出的每个供电桩/中继器覆盖范围，多个范围重叠处
// 颜色自然叠加变深，直观体现覆盖强度。不常驻显示，按 H 键切换。
function drawPowerRanges() {
  if (state.showPowerRanges) {
    ctx.save();
    for (const r of computePowerRangeRects()) drawPowerRangeRect(r);
    ctx.restore();
    return;
  }
  // H 键关闭时，仍然给"正在被拖拽"的供电类设备(powerRange 字段非空)一个实时
  // 预览，不需要用户专门开一次全局叠层才能看清刚挪动的供电桩范围有没有对齐——
  // 和工具栏拖出新供电设备时 drawSpawnPreview() 已有的免按 H 预览体验对齐。
  // getPowerRangeRect 内部走 effectiveGridPos(dev)，本来就能正确取到单设备
  // 拖拽(draggingDeviceId)和框选批量拖拽(boxDragOrigin)两种情况下的实时位置，
  // 这里只需要把"正在拖拽的设备"筛出来。
  const draggedIds = new Set();
  if (state.draggingDeviceId !== null) draggedIds.add(state.draggingDeviceId);
  if (state.boxDragOrigin) for (const id of state.boxDragOrigin.keys()) draggedIds.add(id);
  if (draggedIds.size === 0) return;
  ctx.save();
  for (const dev of state.devices) {
    if (!draggedIds.has(dev.id)) continue;
    const r = getPowerRangeRect(dev);
    if (r) drawPowerRangeRect(r);
  }
  ctx.restore();
}

// 单个惰气/酸气环境覆盖范围方块的绘制，画法和 drawPowerRangeRect 完全同构，
// 只是按 r.type 换一套颜色(惰气蓝/酸气橙，见 constants.js 的说明)。
function drawGasEnvRangeRect(r) {
  const rect = getDeviceRectWorld(r.gridX, r.gridY, r.w, r.h);
  const topLeft = worldToScreen(rect.x, rect.y);
  const sw = rect.w * state.scale;
  const sh = rect.h * state.scale;
  ctx.fillStyle = r.type === 'inert' ? GAS_ENV_INERT_FILL : GAS_ENV_ACID_FILL;
  ctx.fillRect(topLeft.x, topLeft.y, sw, sh);
  ctx.lineWidth = scaled(2);
  ctx.setLineDash([scaled(8), scaled(5)]);
  ctx.strokeStyle = r.type === 'inert' ? GAS_ENV_INERT_STROKE : GAS_ENV_ACID_STROKE;
  ctx.strokeRect(topLeft.x, topLeft.y, sw, sh);
  ctx.setLineDash([]);
}

// 惰气/酸气环境覆盖范围叠层：和供电范围共用同一个 H 键开关(state.showPowerRanges，
// 都是"纯信息展示层"，不需要为此另开一个快捷键/状态变量)。H 键关闭时同样保留
// "正在拖拽的气体散布机"实时预览，和 drawPowerRanges 的同类逻辑一致——区别是
// 范围类型取决于当前已选的气体(getGasEnvRangeRect 内部判断)，不是设备一放置
// 就自带的固定值，所以没有配套的 drawSpawnPreview 落地前预览(落地时还没选气体)。
function drawGasEnvRanges() {
  if (state.showPowerRanges) {
    ctx.save();
    for (const r of computeGasEnvRangeRects()) drawGasEnvRangeRect(r);
    ctx.restore();
    return;
  }
  const draggedIds = new Set();
  if (state.draggingDeviceId !== null) draggedIds.add(state.draggingDeviceId);
  if (state.boxDragOrigin) for (const id of state.boxDragOrigin.keys()) draggedIds.add(id);
  if (draggedIds.size === 0) return;
  ctx.save();
  for (const dev of state.devices) {
    if (!draggedIds.has(dev.id)) continue;
    const r = getGasEnvRangeRect(dev);
    if (r) drawGasEnvRangeRect(r);
  }
  ctx.restore();
}

// 右上角常驻的总功率读数：所有已放置设备 powerCost 之和(正=供电、负=耗电)，
// 纯派生数据，draw() 本身就是"每次状态变化后都会被调用"的统一入口，这里跟着
// 现算现刷新即可，不需要像 recomputeAllFlows() 那样另外找调用点。
function updatePowerSummary() {
  if (!powerSummaryEl) return;
  const total = state.devices.reduce((sum, d) => sum + (d.powerCost || 0), 0);
  const sign = total > 0 ? '+' : '';
  powerSummaryEl.textContent = `总功率: ${sign}${total}`;
}

function drawSpawnPreview() {
  if (!state.spawnPreview || !state.spawningTemplateKey) return;
  const template = SPAWN_TEMPLATES.find(t => t.key === state.spawningTemplateKey);
  if (!template) return;
  // 落地前允许用 R 键预旋转(见 devices.js 的 getSpawnOrientedFields)：预览的
  // 占地尺寸、供电范围、端口箭头都要按当前旋转步数现算，不能直接用
  // template.w/h(那是未旋转的原始尺寸)。
  const previewDev = buildSpawnPreviewDevice(template, state.spawnPreview.gridX, state.spawnPreview.gridY, state.spawnRotSteps);
  const rect = getDeviceRectWorld(state.spawnPreview.gridX, state.spawnPreview.gridY, previewDev.w, previewDev.h);

  // 预览时也检测是否会与现有设备重叠
  const rects = state.devices.map(d => {
    const pos = effectiveGridPos(d);
    return { id: d.id, gridX: pos.gridX, gridY: pos.gridY, w: d.w, h: d.h };
  });
  const previewRect = { gridX: state.spawnPreview.gridX, gridY: state.spawnPreview.gridY, w: previewDev.w, h: previewDev.h };
  const wouldCollide = rects.some(r => rectsOverlap(r, previewRect));

  // 拖拽生成供电桩/中继器时顺带预览一下即将生效的供电覆盖范围，不用等落地后
  // 再按 H 键才能看到——getPowerRangeRect 只认 powerRange 字段，非供电类设备
  // (大多数)这里直接返回 null，不需要额外判断是否是供电桩/中继器。
  const rangeRect = getPowerRangeRect({ powerRange: template.powerRange, gridX: state.spawnPreview.gridX, gridY: state.spawnPreview.gridY, w: previewDev.w, h: previewDev.h });
  if (rangeRect) {
    ctx.save();
    drawPowerRangeRect(rangeRect);
    ctx.restore();
  }

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

  // 端口箭头：让用户在落地前就能看清朝向，配合 R 键预旋转一起用。previewDev
  // 没有 id，drawDevicePorts 里"是否已连接"的查询天然查不到任何连线，全部按
  // "未连接"绘制，符合预览语义。
  drawDevicePorts(previewDev, { gridX: state.spawnPreview.gridX, gridY: state.spawnPreview.gridY });
}

// Ctrl+拖拽 框选时正在拖拽中的矩形选框：仿 drawSpawnPreview 的虚线矩形手感，
// 用框选矩形自己的紫色强调色(BOX_SELECT_ACCENT)，和绿色(传送带)/蓝色(管道)/
// 黄色(选中)/红色(警示)都区分开——这是"框选操作本身进行中"的视觉，不是"选中"
// 本身(那部分复用现有的黄色选中态，见 drawDevices/drawConnections)。
function drawBoxSelectMarquee() {
  if (!state.boxSelectMarquee) return;
  const { startWX, startWY, curWX, curWY } = state.boxSelectMarquee;
  const x = Math.min(startWX, curWX), y = Math.min(startWY, curWY);
  const w = Math.abs(curWX - startWX), h = Math.abs(curWY - startWY);
  const topLeft = worldToScreen(x, y);
  const sw = w * state.scale, sh = h * state.scale;

  ctx.save();
  ctx.fillStyle = 'rgba(94, 53, 177, 0.12)'; // 同色相、低不透明度的框选填充，边框用 BOX_SELECT_ACCENT 本身
  ctx.fillRect(topLeft.x, topLeft.y, sw, sh);
  ctx.lineWidth = scaled(2);
  ctx.setLineDash([scaled(6), scaled(4)]);
  ctx.strokeStyle = BOX_SELECT_ACCENT;
  ctx.strokeRect(topLeft.x, topLeft.y, sw, sh);
  ctx.setLineDash([]);
  ctx.restore();
}

// 粘贴预览：跟随鼠标的半透明 ghost 设备组，仿 drawSpawnPreview 的手感，但只画
// 矩形+标签(不画端口/连线预览，见 CLAUDE.md 复制粘贴设计里"粘贴预览只画设备
// ghost"的取舍)。每个 ghost 的位置由 state.clipboard 的相对布局 + 当前悬停格
// 与复制时锚点的偏移现算，不额外存一份"已换算"的坐标副本。
function drawPastePreview() {
  if (!state.pastePending || !state.pastePreview || !state.clipboard) return;
  const dCol = state.pastePreview.originCol - state.clipboard.anchorCol;
  const dRow = state.pastePreview.originRow - state.clipboard.anchorRow;
  ctx.save();
  ctx.globalAlpha = 0.5;
  for (const dev of state.clipboard.devices) {
    const rect = getDeviceRectWorld(dev.gridX + dCol, dev.gridY + dRow, dev.w, dev.h);
    const topLeft = worldToScreen(rect.x, rect.y);
    const sw = rect.w * state.scale, sh = rect.h * state.scale;
    ctx.fillStyle = dev.color;
    ctx.fillRect(topLeft.x, topLeft.y, sw, sh);
    ctx.lineWidth = scaled(2);
    ctx.setLineDash([scaled(6), scaled(4)]);
    ctx.strokeStyle = dev.borderColor;
    ctx.strokeRect(topLeft.x, topLeft.y, sw, sh);
    ctx.setLineDash([]);
  }
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
  drawMapBoundary();      // 地图边界轮廓，画在网格之上、其它一切之下
  drawPowerRanges();      // 供电覆盖范围叠层，画在最底层，不遮挡传送带/设备
  drawGasEnvRanges();     // 惰气/酸气环境覆盖范围叠层，同一层级、同一个 H 键开关
  drawConnections();      // 传送带 + 传送带物流桥
  drawDevices();          // 设备遮住传送带(不变)，含警告图标
  drawWaypoints();
  drawPipeConnections();  // 管道 + 管道物流桥 —— 画在设备之上，呼应"空中单位"语义
  drawPipeWaypoints();
  drawSpawnPreview();
  drawBoxSelectMarquee();
  drawPastePreview();
  drawFreeBeltPreview();
  drawFreePipePreview();
  drawWarningTooltip();
  drawCursorTooltip();
  updatePowerSummary();
}
