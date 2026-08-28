// ---- 地图边界几何：地图矩形固定锚定在网格原点(左上角格 (0,0)) ----
// 纯派生计算，和 devices.js 的 rectsOverlap/getPowerRangeRect 同一类——
// pathfinding.js/render.js/interactions.js 都要用到，独立成模块避免塞进
// 无关文件。
import { GRID_SIZE } from './constants.js';
import { state } from './state.js';

export function getMapWorldRect() {
  return { x: 0, y: 0, w: state.mapWidthCells * GRID_SIZE, h: state.mapHeightCells * GRID_SIZE };
}

// 设备占地(整格坐标)是否完全落在当前地图矩形内。只用于"强边界"限制的设备种类
// (核心/仓库存取线源桩与基段/汇流器分流器，见 devices.js 的 requiresMapBounds)。
export function isRectInMapBounds(gridX, gridY, w, h) {
  return gridX >= 0 && gridY >= 0 &&
         gridX + w <= state.mapWidthCells && gridY + h <= state.mapHeightCells;
}

// 供 A* 寻路(pathfinding.js)和自由传送带/管道起止点点击判定(interactions.js)
// 用的单格边界检查。
export function isCellInMapBounds(col, row) {
  return col >= 0 && row >= 0 && col < state.mapWidthCells && row < state.mapHeightCells;
}
