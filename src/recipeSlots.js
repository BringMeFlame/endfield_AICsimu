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

// 落地新设备时调用(interactions.js 工具栏 mouseup/核心摆放)，按种类生成初始
// 槽位数据结构，两种槽位面板各自的字段互斥，都不适用的设备两个字段都是
// undefined。'recipe' 模式落地即跑一遍 normalizeSlotValues——如果这台设备
// 全局就只有一种配方，槽位应该直接摆出那唯一的结果，不需要用户手动点一遍
// (见下方 autoFillSingletons 的说明)。
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
  normalizeSlotValues(facilityId, slotValues);
  return { slotValues };
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

// 把"收紧到只剩一个候选"的空槽位直接填上，不需要用户再手动点一次——一个萝卜
// 一个坑，唯一解就没什么好选的。返回是否有变化。
function autoFillSingletons(facilityId, slotValues) {
  let changed = false;
  for (const group of SLOT_GROUPS) {
    const arr = slotValues[group];
    if (!arr) continue;
    for (let i = 0; i < arr.length; i++) {
      if (arr[i]) continue;
      const candidates = computeSlotCandidates(facilityId, slotValues, group);
      if (candidates.size === 1) {
        arr[i] = [...candidates][0];
        changed = true;
      }
    }
  }
  return changed;
}

// 唯一还可行的配方(没有就返回 null)。和 isRecipeViable 用的是同一份已选
// 集合，只是这里要的是"还剩几条"而不是某个槽位组的候选并集。
function findSingleViableRecipe(facilityId, slotValues) {
  const selectedInputs = collectSelectedIds(slotValues, INPUT_GROUPS);
  const selectedOutputs = collectSelectedIds(slotValues, OUTPUT_GROUPS);
  const viable = (RECIPES[facilityId] || []).filter((r) => isRecipeViable(r, selectedInputs, selectedOutputs));
  return viable.length === 1 ? viable[0] : null;
}

// autoFillSingletons 只能处理"这个槽位组的候选并集只剩一个物品"的情况——如果
// 唯一可行的配方本身需要两个不同物品、而对应的槽位组恰好有两个空位，两个空位
// 各自看到的候选并集都是那两个物品(size===2)，autoFillSingletons 判断不出该填
// 哪个。这种时候只要配方本身已经锁定到唯一一条，直接按配方需求把它还缺的物品
// 挨个塞进对应槽位组里还空着的位置就行(槽位内物品互不区分先后，塞的顺序不重
// 要)——这是设备从没选任何东西开始、但整台设备本来就只有一种配方(比如气体
// 反应炉只有一条配方)时，槽位能一开就自动摆满的关键，光靠 autoFillSingletons
// 覆盖不到这种"槽位数刚好等于配方需求数、但候选并集大于一"的情况。
function autoFillFromSingleRecipe(facilityId, slotValues) {
  const recipe = findSingleViableRecipe(facilityId, slotValues);
  if (!recipe) return false;
  let changed = false;
  for (const group of SLOT_GROUPS) {
    const arr = slotValues[group];
    if (!arr) continue;
    const isInput = INPUT_GROUPS.includes(group);
    const portType = GROUP_PORT_TYPE[group];
    const already = new Set(arr.filter(Boolean));
    const need = (isInput ? recipe.inputs : recipe.outputs)
      .filter((io) => itemPortType(io.itemId) === portType && !already.has(io.itemId))
      .map((io) => io.itemId);
    let needIdx = 0;
    for (let i = 0; i < arr.length && needIdx < need.length; i++) {
      if (arr[i]) continue;
      arr[i] = need[needIdx++];
      changed = true;
    }
  }
  return changed;
}

// 每次槽位变化后收敛一遍：清掉不再合法的旧选择、按两种方式自动填上没有悬念
// 的槽位，三者交替可能互相触发(清掉一个选择可能让另一个槽位从"多个候选"变成
// "唯一候选"，反之自动填上一个也可能让原本合法的另一个选择变得不合法)，所以
// 要循环到一整轮都没有变化为止。轮数上限只是防御性的安全阀，槽位数量级(个
// 位数)决定了正常情况几轮就会收敛，不会真的撞到这个上限。
function normalizeSlotValues(facilityId, slotValues) {
  if (!slotValues || slotValues.sharedPool) return;
  let guard = 0;
  let changed = true;
  while (changed && guard++ < 50) {
    const pruned = pruneInvalidSelections(facilityId, slotValues);
    const filledWhole = autoFillFromSingleRecipe(facilityId, slotValues);
    const filledSingle = autoFillSingletons(facilityId, slotValues);
    changed = pruned || filledWhole || filledSingle;
  }
}

// 写入一个槽位值(itemId 传 null 即清空该槽)。修改前照例先 pushHistory()；写完
// 这一下之后跑一遍 normalizeSlotValues 把连带影响一次性收敛掉，一次用户操作
// 对应一次 Ctrl+Z，不会把级联的自动清空/自动填充拆成好几步历史。纯粹是设备
// 实例上的元数据，不影响传送带/管道路径，不需要 recomputeAllFlows()。
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
// 用于误触后一键复原，不用一个个槽位点掉。'recipe' 模式清完之后同样跑一遍
// normalizeSlotValues——如果这台设备本来就只有一种配方，清空会立刻自动填回
// 那个唯一解，这是符合预期的(没有第二种合法状态可以停留)，不是 bug。
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
      normalizeSlotValues(dev.facilityId, dev.slotValues);
    }
  }
}
