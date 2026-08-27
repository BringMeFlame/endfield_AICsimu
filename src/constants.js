// ---- 世界坐标系参数 ----
export const GRID_SIZE = 50; // 每个网格单元的世界坐标尺寸(px)

// ---- 端口 / 寻路参数 ----
// 途经点拾取半径(屏幕像素，固定值不随缩放)。端口拾取判定改用整格大小(见
// devices.js 的 findPortAt)，不再用这个固定小半径，这里改名是为了不再用
// "PORT" 这个名字指代一个只服务于途经点的常量，避免混淆。
export const WAYPOINT_HIT_RADIUS = 8;
export const TURN_PENALTY = 3;      // A* 转弯惩罚(每次拐弯额外代价)
export const DIR_E = 0, DIR_S = 1, DIR_W = 2, DIR_N = 3;
export const DIR_VECT = [{ dx: 1, dy: 0 }, { dx: 0, dy: 1 }, { dx: -1, dy: 0 }, { dx: 0, dy: -1 }];
export const ALL_DIRS = [DIR_E, DIR_S, DIR_W, DIR_N];

// ---- 传送带/管道渲染参数(极简风：半透明色带/线条 + 方向箭头，无辊轴/铰链细节) ----
// 下面这些都是"世界像素"尺寸(缩放 1x 时的屏幕像素数)，实际绘制时统一乘以
// state.scale(见 render.js 的 scaled() 辅助函数)，保证缩放地图时传送带/管道/
// 箭头/端口这些尺寸跟着设备和网格一起等比例放大缩小，不会显得比例失调。
export const BELT_WIDTH = Math.round(GRID_SIZE * 0.6); // 传送带整体宽度，约占一格宽度的60%
export const PIPE_WIDTH = 8;                            // 管道线条宽度，明显细于传送带，便于两者重叠时透视
// 折线转角的圆角半径，固定小像素值、不随 BELT_WIDTH/GRID_SIZE 缩放：如果直接用
// ctx.lineJoin='round'，圆角半径恒等于 lineWidth/2，会让转角视觉体积和带宽绑死
// (带宽越宽转角越是一个大圆弧)，这里改成手动在折线拐点处插入小半径圆弧(见
// render.js 的 buildRoundedScreenPath2D)，让转角始终"横平竖直"但不是绝对直角。
export const BELT_CORNER_RADIUS = 6;
export const FLOW_ARROW_STEP = 46;                      // 方向箭头沿路径的间距，比之前更稀疏一些
// 传送带描边：在带体外侧再叠一圈半透明淡灰色描边，呼应终末地游戏本体的工业风
// (钢板边缘感)，只用于传送带，不用于管道(管道保持细线条，靠这个区别两者)。
export const BELT_EDGE_WIDTH = 4;   // 描边比带体每侧多出的宽度
export const BELT_EDGE_COLOR = 'rgba(120, 120, 120, 0.45)';

// ---- 撤销历史 ----
export const HISTORY_LIMIT = 30;

// ---- 快捷键提示：放在角落的小胶囊，只保留核心快捷键；切换模式时内容跟着换 ----
export const HINT_NORMAL = '[左键拖拽] 放置建筑　|　[Ctrl+拖拽] 框选　|　[E] 传送带　|　[Q] 管道　|　[R] 旋转　|　[H] 供电范围　|　[Alt+左键] 分流　|　[Ctrl+Z] 撤销';
export const HINT_BELT = '[左键] 拉传送带　|　[右键/E] 退出　|　[Alt+左键] 分流　|　[Ctrl+Z] 撤销';
export const HINT_PIPE = '[左键] 拉管道　|　[右键/Q] 退出　|　[Alt+左键] 分流　|　[Ctrl+Z] 撤销';
// 有框选批量选中项时替换掉 HINT_NORMAL(不是独立模式，纯粹是"当前选中了多个
// 东西"这一状态下的操作提示，见 interactions.js 的 updateHintText)。
export const HINT_BOX_SELECTED = '[拖拽已选中项] 批量移动　|　[R] 旋转　|　[Delete] 删除　|　[Ctrl+C/V] 复制粘贴　|　[点击其它位置/Esc] 取消选中';

// ---- 传送带调色板：白色基调地图上的半透明琥珀色条带，选中态更饱和/更不透明，
// 失效态复用红色警示语义 ----
export const BELT_COLOR = 'rgba(255, 179, 0, 0.5)';
export const BELT_COLOR_SELECTED = 'rgba(255, 143, 0, 0.85)';

// ---- 管道调色板：半透明蓝灰色线条(经用户确认批准，与传送带的琥珀色区分开)，
// 选中态换成更醒目的蓝色；不要拿这里的颜色去渲染传送带，也不要拿传送带的
// 颜色去渲染管道。----
export const PIPE_COLOR = 'rgba(96, 125, 139, 0.65)';
export const PIPE_COLOR_SELECTED = 'rgba(2, 136, 209, 0.9)';
// Q 模式(管道自由绘制)的强调色：沿用管道自身蓝色系而非传送带模式的绿色，
// 因为这是与传送带并列的独立工具，复用绿色会让用户分不清当前处于哪个模式。
export const PIPE_ACCENT = 'rgba(2, 136, 209, 0.85)';
// 汇流器/分流器(传送带版和管道版)统一走"设备统一白底黑边"的规则(见
// pathfinding.js 的 NODE_COLOR)，不再用颜色区分四种节点，靠 1x1 占地 + "汇"/"分"
// 标签本身分辨。

// 框选矩形(Ctrl+拖拽)的强调色：与 freeBeltMode 的绿色、freePipeMode 的蓝色都
// 不同色相——虽然框选本身不是一个独占工具模式，但拖矩形这个手势本身仍然需要
// 一个和已有工具区分开的强调色，避免让人误以为在画传送带/画管道。选紫色系，
// 不和红色警示/黄色选中冲突。
export const BOX_SELECT_ACCENT = 'rgba(94, 53, 177, 0.85)';

// ---- 端口颜色：只按"传送带口/管道口"这一个维度区分，不再用输入/输出/已连接
// 三种色相——已连接状态改用不透明度表达(未连接半透明、已连接不透明)，颜色
// 本身对同一类端口保持统一，方便一眼分辨端口能不能接管道。白色基调地图下端口
// 颜色需要足够深，才能在白底设备上保持可见。----
export const BELT_PORT_COLOR = '#1a1a1a';
export const PIPE_PORT_COLOR = '#0288d1';
// 端口箭头实心填充色：白色，呼应"设备白底彩边"的整体配色习惯，不额外发明新色相。
export const PORT_FILL_COLOR = '#ffffff';

// ---- 设备警告图标(如"未通电")参数：贴在设备包围盒右上角的小圆点+"!"，悬停
// 显示提示浮窗，复用"警告/无效态统一半透明红色"的语义，不为电力警告单开新
// 颜色。像素数是"缩放1x"时的屏幕像素，随 state.scale 缩放(见 render.js 的
// scaled())，命中判定半径也要同步换算，否则缩放后点击手感会和视觉大小对不上
// (参见 devices.js 的 portHitRadiusPx 同类写法)。----
export const WARNING_ICON_RADIUS = 18;
export const WARNING_COLOR = '#ff1744';

// ---- 供电覆盖范围叠层(H 键全局开关 + 拖拽供电桩/中继器时的落地预览)：半透明
// 黄橙色，是常驻/大面积的信息叠加层，不需要抢眼，只需要能看清边界；特意不用
// 紫色，避免和 BOX_SELECT_ACCENT(框选矩形强调色)撞色相、也避免让人误以为这是
// 另一种"操作模式"而非纯信息展示。----
export const POWER_RANGE_FILL = 'rgba(255, 193, 7, 0.12)';
export const POWER_RANGE_STROKE = 'rgba(255, 160, 0, 0.55)';
