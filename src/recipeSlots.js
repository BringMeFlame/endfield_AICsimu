// ---- 配方槽位系统：右键槽位面板背后的数据/匹配逻辑 ----
// 槽位数据本身(facilities.js 的 slots 字段)、配方数据(data/recipes.js 的
// RECIPES)、物品数据(data/items.js 的 ITEMS)都是纯数据，这个模块负责把三者
// 接起来算：某设备当前槽位状态下哪些配方已经"满足"(可以产出)、某个还没填的
// 槽位现在能选什么、清空/写入槽位这类会修改 state.devices 的操作。是独立的新
// 模块而不是塞进 devices.js，因为这块逻辑同时依赖 devices/recipes/items 三份
// 数据，且是一整块新功能，按 CLAUDE.md "先想清楚该开一个新模块还是塞进已有
// 模块"的要求单独开一个文件。
//
// 两种槽位面板，同一个右键入口(interactions.js)按 getSlotPanelKind() 分派：
// - 'recipe'：facilities.js 有 slots 字段的设备(见该文件字段说明)，槽位数和
//   端口数量无关，选好输入后自动匹配配方、收紧输出候选。
// - 'port'：PORT_ITEM_FACILITY_IDS 里的设备(暗管入口/出口、协议核心/次级核心、
//   仓库存货口/取货口、储液罐/储气罐)，没有配方，槽位就是端口本身，用户在
//   固体/流体限制下自由选物品，不做任何收紧。
import { FACILITIES } from './data/facilities.js';
import { RECIPES } from './data/recipes.js';
import { ITEM_BY_ID } from './data/items.js';
import { pushHistory } from './history.js';

const FACILITY_BY_ID = new Map(Object.values(FACILITIES).flat().map((f) => [f.id, f]));

// 没有配方、槽位即端口、允许自由选物品的设备，见文件头注释。
export const PORT_ITEM_FACILITY_IDS = new Set([
  'dev_暗管入口', 'dev_暗管出口', 'dev_多口暗管入口', 'dev_多口暗管出口',
  'dev_协议核心', 'dev_次级核心',
  'dev_仓库存货口', 'dev_仓库取货口',
  'dev_储液罐', 'dev_储气罐',
]);

const SLOT_GROUPS = ['inputSolid', 'inputFluid', 'outputSolid', 'outputFluid'];
const INPUT_GROUPS = ['inputSolid', 'inputFluid'];
const OUTPUT_GROUPS = ['outputSolid', 'outputFluid'];
const GROUP_PORT_TYPE = { inputSolid: 'solid', inputFluid: 'fluid', outputSolid: 'solid', outputFluid: 'fluid' };

function itemPortType(itemId) {
  const item = ITEM_BY_ID.get(itemId);
  return item ? item.portType : null;
}

export function getFacilitySlotSpec(facilityId) {
  const f = FACILITY_BY_ID.get(facilityId);
  return f ? f.slots || null : null;
}

// 'recipe' | 'port' | null(该设备没有槽位面板，右键走普通逻辑)。
export function getSlotPanelKind(dev) {
  if (!dev || dev.kind !== 'facility') return null;
  if (PORT_ITEM_FACILITY_IDS.has(dev.facilityId)) return 'port';
  if (getFacilitySlotSpec(dev.facilityId)) return 'recipe';
  return null;
}

// 落地新设备时调用(interactions.js 工具栏 mouseup)，按种类生成初始槽位数据
// 结构，两种槽位面板各自的字段互斥，都不适用的设备两个字段都是 undefined。
export function buildInitialSlotState(facilityId) {
  if (PORT_ITEM_FACILITY_IDS.has(facilityId)) {
    const f = FACILITY_BY_ID.get(facilityId);
    const portItems = {};
    for (const p of (f && f.ports) || []) portItems[p.id] = null;
    return { portItems };
  }
  const spec = getFacilitySlotSpec(facilityId);
  if (!spec) return {};
  if (spec.sharedPool) {
    return { slotValues: { sharedPool: new Array(spec.totalSlots).fill(null) } };
  }
  const slotValues = {};
  for (const key of SLOT_GROUPS) {
    if (spec[key] != null) slotValues[key] = new Array(spec[key]).fill(null);
  }
  return { slotValues };
}

function collectSelectedInputIds(slotValues) {
  const ids = new Set();
  for (const group of INPUT_GROUPS) {
    for (const id of (slotValues && slotValues[group]) || []) if (id) ids.add(id);
  }
  return ids;
}

// 配方"已满足"：配方需要的全部输入都在已选集合里(不要求数量匹配，本项目本期
// 不做速率/用量校验，见 CLAUDE.md)。用于算输出候选——已选集合里混入这条配方
// 用不上的其它物品(填在别的槽位)不影响它是否满足。
function isRecipeSatisfied(recipe, selectedIds) {
  return recipe.inputs.every((i) => selectedIds.has(i.itemId));
}

// 配方"仍可行"：已选的每一项都是这条配方需要的输入(方向和上面相反，已选 ⊆
// 配方需求)。用于收紧还没填的输入槽——只要选了一个这条配方用不上的物品，这条
// 配方就不再贡献候选，即使它本身可能已经因为其它槽位而"满足"。两个判定分工
// 不同、缺一个这套自动收紧就不成立，不要合并成一个函数。
function isRecipeViable(recipe, selectedIds) {
  const need = new Set(recipe.inputs.map((i) => i.itemId));
  for (const id of selectedIds) if (!need.has(id)) return false;
  return true;
}

export function computeActiveRecipes(facilityId, slotValues) {
  const selected = collectSelectedInputIds(slotValues);
  if (selected.size === 0) return [];
  return (RECIPES[facilityId] || []).filter((r) => isRecipeSatisfied(r, selected));
}

// 目标槽位组(如还没填的 inputFluid)现在能选什么：遍历"仍可行"的配方，收集它们
// 里对应 portType、且还没被选中的输入物品 id。
export function computeInputCandidates(facilityId, slotValues, group) {
  const selected = collectSelectedInputIds(slotValues);
  const portType = GROUP_PORT_TYPE[group];
  const candidates = new Set();
  for (const r of RECIPES[facilityId] || []) {
    if (!isRecipeViable(r, selected)) continue;
    for (const i of r.inputs) {
      if (i.portType ? i.portType === portType : itemPortType(i.itemId) === portType) {
        if (!selected.has(i.itemId)) candidates.add(i.itemId);
      }
    }
  }
  return candidates;
}

// 输出槽位候选 = 所有"已满足"配方里对应 portType 输出物品的并集。
export function computeOutputCandidates(facilityId, slotValues, group) {
  const portType = GROUP_PORT_TYPE[group];
  const candidates = new Set();
  for (const r of computeActiveRecipes(facilityId, slotValues)) {
    for (const o of r.outputs) {
      if (itemPortType(o.itemId) === portType) candidates.add(o.itemId);
    }
  }
  return candidates;
}

// 抽屉"本设备相关"标签页用：某个槽位组理论上可能用到的全部物品 id，不管当前
// 槽位状态，穷举这台设备全部配方里这个 portType 方向出现过的物品——比实时收紧
// 后的候选范围更宽，方便用户在还没选任何东西时就能小范围浏览，不用直接面对
// 全部 199 个物品。'port' 模式没有配方可参考，返回 null 交给调用方回退成
// "全部同 portType 物品"。
export function getRelevantItemIds(facilityId, group) {
  const isInput = INPUT_GROUPS.includes(group);
  const portType = GROUP_PORT_TYPE[group];
  const ids = new Set();
  for (const r of RECIPES[facilityId] || []) {
    for (const io of isInput ? r.inputs : r.outputs) {
      if (itemPortType(io.itemId) === portType) ids.add(io.itemId);
    }
  }
  return ids;
}

// 写入一个槽位值(itemId 传 null 即清空该槽)。修改前照例先 pushHistory()；写入
// 输入槽之后，顺手把已经不再落在收紧后候选范围内的输出槽清空，避免留下一个
// 摆在那儿但配方已经不支持产出的"脏"选择——不尝试"猜"用户想保留哪个，直接
// 清、让用户重选，和项目里其它"改动后失效就摆明状态"的一贯做法一致。纯粹是
// 设备实例上的元数据，不影响传送带/管道路径，不需要 recomputeAllFlows()。
export function setSlotValue(dev, group, index, itemId) {
  pushHistory();
  applySlotValue(dev, group, index, itemId);
}

function applySlotValue(dev, group, index, itemId) {
  if (group === 'port') {
    dev.portItems[index] = itemId;
    return;
  }
  const arr = dev.slotValues && dev.slotValues[group];
  if (!arr) return;
  arr[index] = itemId;
  if (!INPUT_GROUPS.includes(group)) return;
  for (const outGroup of OUTPUT_GROUPS) {
    const outArr = dev.slotValues[outGroup];
    if (!outArr) continue;
    const candidates = computeOutputCandidates(dev.facilityId, dev.slotValues, outGroup);
    for (let i = 0; i < outArr.length; i++) {
      if (outArr[i] && !candidates.has(outArr[i])) outArr[i] = null;
    }
  }
}

// 面板里的"清空全部"：一次 pushHistory()，把这个设备所有槽位/端口物品清空，
// 用于误触后一键复原，不用一个个槽位点掉。
export function clearAllSlots(dev) {
  pushHistory();
  if (dev.portItems) {
    for (const key of Object.keys(dev.portItems)) dev.portItems[key] = null;
  }
  if (dev.slotValues) {
    if (dev.slotValues.sharedPool) {
      dev.slotValues.sharedPool.fill(null);
    } else {
      for (const g of SLOT_GROUPS) if (dev.slotValues[g]) dev.slotValues[g].fill(null);
    }
  }
}
