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
export const HINT_NORMAL = '[E] 传送带　|　[R] 旋转　|　[Alt+左键] 分流　|　[Ctrl+Z] 撤销';
export const HINT_BELT = '[左键] 拉传送带　|　[右键/E] 退出　|　[Alt+左键] 分流　|　[Ctrl+Z] 撤销';
