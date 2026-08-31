// ---- 配方槽位系统：右键槽位面板背后的数据/匹配逻辑 ----
// 槽位数据本身(facilities.js 的 slots 字段)、配方数据(data/recipes.js 的
// RECIPES)、物品数据(data/items.js 的 ITEMS)都是纯数据，这个模块负责把三者
// 接起来算：某设备当前槽位状态下哪些配方还"可行"、某个还没填的槽位现在能选
// 什么、清空/写入槽位这类会修改 state.devices 的操作。是独立的新模块而不是
// 塞进 devices.js，因为这块逻辑同时依赖 devices/recipes/items 三份数据，且是
// 一整块新功能，按 CLAUDE.md "先想清楚该开一个新模块还是塞进已有模块"的要求
// 单独开一个文件。
//
// 两种槽位面板，同一个右键入口(interactions.js)按 getSlotPanelKind() 分派：
// - 'recipe'：facilities.js 有 slots 字段的设备(见该文件字段说明)，槽位数和
//   端口数量无关。原料/产物哪个先选都行(双向对称收紧，见下面 isRecipeViable)。
// - 'port'：PORT_ITEM_FACILITY_IDS 里的设备，没有配方，槽位就是端口本身，
//   用户在固体/流体限制下自由选物品，不做收紧；其中气体散布机/废水处理机/
//   热能池比较特殊——同样是"随便选同类型物品"，但热能池只有源矿/原木/各种
//   电池能真正当燃料，放别的东西会触发警告(devices.js 的 getDeviceWarnings，
//   FUEL_ITEM_IDS 允许表就近写在那边，不在这里，因为警告图标框架本来就在
//   devices.js 里，不重复建一套)。
import { FACILITIES } from './data/facilities.js';
import { RECIPES } from './data/recipes.js';
import { ITEM_BY_ID } from './data/items.js';
import { pushHistory } from './history.js';

const FACILITY_BY_ID = new Map(Object.values(FACILITIES).flat().map((f) => [f.id, f]));

// 没有配方、槽位即端口、允许自由选物品的设备。协议核心/次级核心不在这里——
// 核心的槽位面板(端口一多起来)显示太乱，用户已确认暂时不需要，右键核心不
// 触发任何槽位面板，走浏览器默认菜单。气体散布机/废水处理机/热能池同样走
// "自由选同类型物品"这条路，槽位数直接取自 ports 数量(和这三个设备"随便接
// 什么气体/液体/固体"的定位一致，不需要另外维护槽位数)。
export const PORT_ITEM_FACILITY_IDS = new Set([
  'dev_暗管入口', 'dev_暗管出口', 'dev_多口暗管入口', 'dev_多口暗管出口',
  'dev_仓库存货口', 'dev_仓库取货口',
  'dev_储液罐', 'dev_储气罐',
  'dev_气体散布机', 'dev_废水处理机', 'dev_热能池',
]);

const SLOT_GROUPS = ['inputSolid', 'inputFluid', 'outputSolid', 'outputFluid'];
export const INPUT_GROUPS = ['inputSolid', 'inputFluid'];
export const OUTPUT_GROUPS = ['outputSolid', 'outputFluid'];

// 固气转化机/液气转化机启动需要额外接入一路流体催化剂，且两组设备各自只认
// 一种物品(固气转化机认息壤气、液气转化机认液化息壤，不是共用同一份白名单)，
// 所以用 facilityId -> 必需 itemId 的 Map，而不是 Set。这个槽位叠加在正常的
// 'recipe' 模式配方槽位之上(不是替换)，key 固定是 'catalyst'，不对应任何真实
// port.id——和热能池的虚拟 'fuel' 槽位同一种写法(见 getPortSlotDescriptors)，
// 区别只是热能池整台设备都是 'port' 模式，这里是 'recipe' 模式设备额外挂一个
// 'port' 风格的虚拟槽位，两套存储(slotValues/portItems)在同一个设备实例上
// 并存，互不干扰(setSlotValue/clearAllSlots 本来就分别独立判断这两个字段)。
export const CATALYST_ITEM_BY_FACILITY = new Map([
  ['dev_固气转化机_气体产出', 'item_gas_xiranite'],    // 息壤气
  ['dev_固气转化机_固体产出', 'item_gas_xiranite'],
  ['dev_液气转化机_气体产出', 'item_liquid_xiranite'],  // 液化息壤
  ['dev_液气转化机_液体产出', 'item_liquid_xiranite'],
]);
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

// 'port' 模式默认一个端口对应一个槽位，但热能池比较特殊：虽然有 2 个传送带
// 输入口，但同一时刻只处理一种燃料(不是两个口各自独立烧不同东西)，槽位数不
// 能跟着端口数走，只给一个虚拟槽位(key 不对应任何真实 port.id，纯粹是槽位
// 面板/物品选择抽屉用来标识"这个槽位"的键)。除了这一个特例，其余 'port' 模式
// 设备都是端口数=槽位数，直接从 ports 派生。
export function getPortSlotDescriptors(facilityId) {
  if (facilityId === 'dev_热能池') {
    return [{ key: 'fuel', shape: 'square' }];
  }
  if (CATALYST_ITEM_BY_FACILITY.has(facilityId)) {
    return [{ key: 'catalyst', shape: 'circle' }];
  }
  const f = FACILITY_BY_ID.get(facilityId);
  return ((f && f.ports) || []).map((p) => ({
    key: p.id,
    shape: p.type.startsWith('fluid') ? 'circle' : 'square'
  }));
}

// 落地新设备时调用(interactions.js 工具栏 mouseup/核心摆放)，按种类生成初始
// 槽位数据结构。'port' 模式和 'recipe' 模式(slotValues)本身是互斥分支，但
// CATALYST_ITEM_BY_FACILITY 里的设备是 'recipe' 模式基础上额外叠一个虚拟
// portItems.catalyst 槽位，所以要在 slotValues 生成之后再补一次，两个字段
// 在这 4 台设备的实例上会同时存在。都不适用的设备两个字段都是 undefined。
export function buildInitialSlotState(facilityId) {
  if (PORT_ITEM_FACILITY_IDS.has(facilityId)) {
    const portItems = {};
    for (const d of getPortSlotDescriptors(facilityId)) portItems[d.key] = null;
    return { portItems };
  }
  const spec = getFacilitySlotSpec(facilityId);
  if (!spec) return {};
  const result = {};
  if (CATALYST_ITEM_BY_FACILITY.has(facilityId)) {
    const portItems = {};
    for (const d of getPortSlotDescriptors(facilityId)) portItems[d.key] = null;
    result.portItems = portItems;
  }
  if (spec.sharedPool) {
    result.slotValues = { sharedPool: new Array(spec.totalSlots).fill(null) };
    return result;
  }
  const slotValues = {};
  for (const key of SLOT_GROUPS) {
    if (spec[key] != null) slotValues[key] = new Array(spec[key]).fill(null);
  }
  result.slotValues = slotValues;
  return result;
}

function collectSelectedIds(slotValues, groups) {
  const ids = new Set();
  for (const group of groups) {
    for (const id of (slotValues && slotValues[group]) || []) if (id) ids.add(id);
  }
  return ids;
}

// 配方"仍可行"：已经选中的原料都在这条配方的输入里、已经选中的产物都在这条
// 配方的输出里(两个方向都是"已选 ⊆ 配方需求/产出"，不要求配方被完整填满)。
// 原料产物哪个先选都要走同一个判定——这正是"允许先选产出"这条需求能成立的
// 关键：只选产物、不选原料时，selectedInputs 是空集，空集天然是任何配方输入
// 的子集，所以只按产物一侧筛，反之亦然。
function isRecipeViable(recipe, selectedInputs, selectedOutputs) {
  const inputIds = new Set(recipe.inputs.map((i) => i.itemId));
  const outputIds = new Set(recipe.outputs.map((o) => o.itemId));
  for (const id of selectedInputs) if (!inputIds.has(id)) return false;
  for (const id of selectedOutputs) if (!outputIds.has(id)) return false;
  return true;
}

// 目标槽位组(如还没填的 inputFluid/outputSolid)现在能选什么：遍历"仍可行"的
// 配方，收集它们里对应 portType、且这个方向还没被选中的物品 id。原料槽位和
// 产物槽位调用的是同一个函数，只是 group 不同，双向对称。
export function computeSlotCandidates(facilityId, slotValues, group) {
  const selectedInputs = collectSelectedIds(slotValues, INPUT_GROUPS);
  const selectedOutputs = collectSelectedIds(slotValues, OUTPUT_GROUPS);
  const isInput = INPUT_GROUPS.includes(group);
  const portType = GROUP_PORT_TYPE[group];
  const already = isInput ? selectedInputs : selectedOutputs;
  const candidates = new Set();
  for (const r of RECIPES[facilityId] || []) {
    if (!isRecipeViable(r, selectedInputs, selectedOutputs)) continue;
    for (const io of isInput ? r.inputs : r.outputs) {
      if (itemPortType(io.itemId) === portType && !already.has(io.itemId)) candidates.add(io.itemId);
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

// 把已经填了的槽位里、在当前其它选择下已经不再合法的值清掉(比如先选了产出
// A，又跑去把某个原料槽位改成了 A 配方用不上的东西，A 就该被清掉重选)。
// 判断"某个已填槽位现在还合不合法"要先假装它是空的再算候选，否则它自己恒久
// 在已选集合里，没法判断"去掉它还有没有配方兼容"。返回是否有变化，供上层的
// 收敛循环判断要不要再跑一轮。
function pruneInvalidSelections(facilityId, slotValues) {
  let changed = false;
  for (const group of SLOT_GROUPS) {
    const arr = slotValues[group];
    if (!arr) continue;
    for (let i = 0; i < arr.length; i++) {
      const value = arr[i];
      if (!value) continue;
      arr[i] = null;
      const stillOk = computeSlotCandidates(facilityId, slotValues, group).has(value);
      arr[i] = stillOk ? value : null;
      if (!stillOk) changed = true;
    }
  }
  return changed;
}

// 每次槽位变化后清一遍不再合法的旧选择——清掉一个可能连带让另一个也不再合法
// (比如清掉 A 之后，本来靠 A 撑住的配方不再可行，B 也该跟着清)，所以要循环到
// 一整轮都没有变化为止。轮数上限只是防御性的安全阀，槽位数量级(个位数)决定
// 了正常情况几轮就会收敛，不会真的撞到这个上限。
//
// 用户明确要求过不要"收紧到唯一解自动填入"(试过一版，手感奇怪，已去掉)——
// 这里只做"清理不再合法的选择"，不主动帮用户填任何东西，空槽位再怎么收紧
// 也只是收紧抽屉里能点的范围，不会自己冒出一个值。
function normalizeSlotValues(facilityId, slotValues) {
  if (!slotValues || slotValues.sharedPool) return;
  let guard = 0;
  while (pruneInvalidSelections(facilityId, slotValues) && guard++ < 50) {
    // 循环体是空的：pruneInvalidSelections 本身就是"跑一轮、返回有没有变化"，
    // 复用 while 条件判断即可，不需要额外逻辑。
  }
}

// 写入一个槽位值(itemId 传 null 即清空该槽)。修改前照例先 pushHistory()；写完
// 这一下之后跑一遍 normalizeSlotValues 把连带的失效清理一次性收敛掉，一次
// 用户操作对应一次 Ctrl+Z，不会把级联清理拆成好几步历史。纯粹是设备实例上的
// 元数据，不影响传送带/管道路径，不需要 recomputeAllFlows()。
export function setSlotValue(dev, group, index, itemId) {
  pushHistory();
  if (group === 'port') {
    dev.portItems[index] = itemId;
    return;
  }
  const arr = dev.slotValues && dev.slotValues[group];
  if (!arr) return;
  arr[index] = itemId;
  normalizeSlotValues(dev.facilityId, dev.slotValues);
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
