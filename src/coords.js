// ---- 世界坐标系转换 ----
// 严格区分三套坐标：client/screen(屏幕像素) - world(未量化浮点世界坐标) -
// cell/(col,row)(网格整数坐标)。转换只走这几个函数，不要在别处手写换算公式。
import { GRID_SIZE } from './constants.js';
import { state } from './state.js';

export function screenToWorld(sx, sy) {
  return { x: (sx - state.offsetX) / state.scale, y: (sy - state.offsetY) / state.scale };
}
export function worldToScreen(wx, wy) {
  return { x: wx * state.scale + state.offsetX, y: wy * state.scale + state.offsetY };
}
export function worldToCell(wx, wy) {
  return { col: Math.floor(wx / GRID_SIZE), row: Math.floor(wy / GRID_SIZE) };
}

export function initView() {
  state.offsetX = window.innerWidth / 2;
  state.offsetY = window.innerHeight / 2;
}
