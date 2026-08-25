// ---- 世界坐标系参数 ----
export const GRID_SIZE = 50; // 每个网格单元的世界坐标尺寸(px)

// ---- 端口 / 寻路参数 ----
export const PORT_COUNT = 3;        // 每台设备的输入口/输出口数量
// 途经点拾取半径(屏幕像素，固定值不随缩放)。端口拾取判定改用整格大小(见
// devices.js 的 findPortAt)，不再用这个固定小半径，这里改名是为了不再用
// "PORT" 这个名字指代一个只服务于途经点的常量，避免混淆。
export const WAYPOINT_HIT_RADIUS = 8;
export const TURN_PENALTY = 3;      // A* 转弯惩罚(每次拐弯额外代价)
export const DIR_E = 0, DIR_S = 1, DIR_W = 2, DIR_N = 3;
export const DIR_VECT = [{ dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 0, dy: -1 }];
export const ALL_DIRS = [DIR_E, DIR_S, DIR_W, DIR_N];

// ---- 传送带/管道渲染参数(极简风：半透明色带/线条 + 方向箭头，无辊轴/铰链细节) ----
export const BELT_WIDTH = Math.round(GRID_SIZE * 0.8); // 传送带整体宽度，约占一格宽度的80%
export const PIPE_WIDTH = 8;                            // 管道线条宽度，明显细于传送带，便于两者重叠时透视
export const FLOW_ARROW_STEP = 30;                      // 方向箭头沿路径的间距(屏幕像素)

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

// ---- 传送带调色板：半透明浅黄色条带，选中态更饱和/更不透明，失效态复用红色警示语义 ----
export const BELT_COLOR = 'rgba(255, 224, 130, 0.45)';
export const BELT_COLOR_SELECTED = 'rgba(255, 202, 40, 0.75)';

// ---- 管道调色板：半透明蓝灰色线条(经用户确认批准，与传送带的浅黄区分开)，
// 选中态换成更醒目的蓝色；不要拿这里的颜色去渲染传送带，也不要拿传送带的
// 颜色去渲染管道。----
export const PIPE_COLOR = 'rgba(120, 144, 156, 0.6)';
export const PIPE_COLOR_SELECTED = 'rgba(41, 182, 246, 0.9)';
// Q 模式(管道自由绘制)的强调色：沿用管道自身蓝色系而非传送带模式的绿色，
// 因为这是与传送带并列的独立工具，复用绿色会让用户分不清当前处于哪个模式。
export const PIPE_ACCENT = 'rgba(41, 182, 246, 0.85)';
// 管道分流器/汇流器节点颜色：现有传送带汇流器 #ffd54f(黄)/分流器 #4fc3f7(蓝)，
// 这两个新颜色刻意避开，保证四种 1x1 节点一眼可辨。
export const PIPE_MERGER_COLOR = '#ab47bc';
export const PIPE_SPLITTER_COLOR = '#ff7043';

// ---- 端口颜色：只按"传送带口/管道口"这一个维度区分，不再用输入/输出/已连接
// 三种色相——已连接状态改用不透明度表达(未连接半透明、已连接不透明)，颜色
// 本身对同一类端口保持统一，方便一眼分辨端口能不能接管道。----
export const BELT_PORT_COLOR = '#ffffff';
export const PIPE_PORT_COLOR = '#81d4fa';
