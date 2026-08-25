// ---- 世界坐标系参数 ----
export const GRID_SIZE = 50; // 每个网格单元的世界坐标尺寸(px)

// ---- 端口 / 寻路参数 ----
export const PORT_COUNT = 3;        // 每台设备的输入口/输出口数量
export const PORT_HIT_RADIUS = 8;   // 端口拾取半径(屏幕像素)
export const TURN_PENALTY = 3;      // A* 转弯惩罚(每次拐弯额外代价)
export const DIR_E = 0, DIR_S = 1, DIR_W = 2, DIR_N = 3;
export const DIR_VECT = [{ dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 0, dy: -1 }];
export const ALL_DIRS = [DIR_E, DIR_S, DIR_W, DIR_N];

// ---- 传送带渲染参数 ----
export const BELT_WIDTH = 14;      // 传送带整体宽度(屏幕像素，含外框)
export const BELT_RUNG_STEP = 14;  // 传送带纹路(辊轴刻线)间距

// ---- 撤销历史 ----
export const HISTORY_LIMIT = 30;

// ---- 快捷键提示：放在角落的小胶囊，只保留核心快捷键；切换模式时内容跟着换 ----
export const HINT_NORMAL = '[E] 传送带　|　[Q] 管道　|　[R] 旋转　|　[Alt+左键] 分流　|　[Ctrl+Z] 撤销';
export const HINT_BELT = '[左键] 拉传送带　|　[右键/E] 退出　|　[Alt+左键] 分流　|　[Ctrl+Z] 撤销';
export const HINT_PIPE = '[左键] 拉管道　|　[右键/Q] 退出　|　[Alt+左键] 分流　|　[Ctrl+Z] 撤销';

// ---- 反应池(5x5)端口布局 ----
// 5 格边上放 2 个端口、间隔 1 格(两端各留 1 格空隙、中间留 1 格空隙)。
export const REACTOR_PORT_LAYOUT = { count: 2, spacing: 2 };
// rot=0 时四条边的角色分配(顺时针 DIR_E/S/W/N 编号)：上=传送带入，下=传送带出，
// 左=管道入，右=管道出；旋转时四组端口作为刚体一起转动，见 devices.js 的 reactorEdgeFor。
export const REACTOR_BASE_ROLES = { beltIn: DIR_N, beltOut: DIR_S, pipeIn: DIR_W, pipeOut: DIR_E };

// ---- 管道渲染参数 / 调色板 ----
// 这是管道网络专属的第二套配色体系(经用户确认批准)，风格与传送带的辊轴纹理
// 一致，只是整体换成蓝色调；不要拿这里的颜色去渲染传送带，也不要拿传送带的
// 橙/棕色去渲染管道。
export const PIPE_RAIL_COLOR = '#0d3350';
export const PIPE_SURFACE_COLOR = '#29b6f6';
export const PIPE_RAIL_SELECTED = '#0d47a1';
export const PIPE_SURFACE_SELECTED = '#80d8ff';
// Q 模式(管道自由绘制)的强调色：沿用管道自身蓝色系而非传送带模式的绿色，
// 因为这是与传送带并列的独立工具，复用绿色会让用户分不清当前处于哪个模式。
export const PIPE_ACCENT = 'rgba(41, 182, 246, 0.85)';
// 管道分流器/汇流器节点颜色：现有传送带汇流器 #ffd54f(黄)/分流器 #4fc3f7(蓝)，
// 这两个新颜色刻意避开，保证四种 1x1 节点一眼可辨。
export const PIPE_MERGER_COLOR = '#ab47bc';
export const PIPE_SPLITTER_COLOR = '#ff7043';
