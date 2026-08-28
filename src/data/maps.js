// ---- 地图目录：可选地图尺寸 + 每张地图固定内置的核心设备 ----
// 和 facilities.js 同类的静态数据文件，不含任何逻辑。w/h 是地图矩形的网格格数，
// 地图矩形固定锚定在网格原点(左上角格 (0,0)，右下角格 (w,h))，不支持任意偏移
// 的地图原点——简化边界判定(mapBounds.js)/相机居中(interactions.js 的
// applyMapSelection)逻辑。coreFacilityId 对应 src/data/facilities.js 的
// FACILITIES['其他'] 里的一条记录(协议核心=主基地核心，次级核心=副基地核心)。
export const MAP_CATALOG = [
  { id: 'map_四号谷地_主基地', label: '四号谷地主基地', w: 70, h: 70, coreFacilityId: 'dev_协议核心' },
  { id: 'map_四号谷地_副基地', label: '四号谷地副基地', w: 40, h: 40, coreFacilityId: 'dev_次级核心' },
  { id: 'map_武陵_主基地', label: '武陵主基地', w: 80, h: 80, coreFacilityId: 'dev_协议核心' },
  { id: 'map_武陵_副基地', label: '武陵副基地', w: 50, h: 50, coreFacilityId: 'dev_次级核心' },
];
