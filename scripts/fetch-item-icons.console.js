// ============================================================
// 终末地基建模拟器 - 物品图标批量抓取(浏览器控制台版)
// 用法：在能打开 static.warfarin.wiki 的浏览器里(建议就在 wiki 物品页
// 面上)按 F12 打开开发者工具，切到 Console 面板，粘贴整段代码回车。
// Chrome/Edge 首次粘贴可能会提示"不要粘贴不了解的代码"，需要先手动
// 输入 allow pasting 再回车确认一次，之后才能正常粘贴。
// 跑完会自动下载一个 item_icons.zip，里面是抓到的所有 webp 图标，
// 解压后把整个文件夹丢给我(或者你自己按 public/icons/items/ 这个路径
// 放进项目里)就行。抓不到的 id(404)会在控制台打印出来，预期是
// item_fbottle_*/item_gasjar_* 这类容器+内容物组合物品，wiki 上大概率
// 是运行时叠加渲染、没有单独出图，属于正常情况。
// ============================================================
(async () => {
  const ITEM_IDS = ["item_activity_xiranite_bottle", "item_activity_xiranite_cmpt", "item_activity_xiranite_enr_bottle", "item_activity_xiranite_enr_cmpt", "item_activity_xiranite_enr_hulu", "item_activity_xiranite_enr_tool", "item_activity_xiranite_hulu", "item_bottled_food_1", "item_bottled_food_2", "item_bottled_food_3", "item_bottled_food_4", "item_bottled_food_5", "item_bottled_rec_hp_1", "item_bottled_rec_hp_2", "item_bottled_rec_hp_3", "item_bottled_rec_hp_4", "item_bottled_rec_hp_5", "item_carbon_enr", "item_carbon_enr_powder", "item_carbon_mtl", "item_carbon_powder", "item_copper_bottle", "item_copper_cmpt", "item_copper_enr", "item_copper_enr2", "item_copper_enr2_cmpt", "item_copper_enr_bottle", "item_copper_enr_cmpt", "item_copper_jar", "item_copper_nugget", "item_copper_ore", "item_copper_powder", "item_crystal_enr", "item_crystal_enr_powder", "item_crystal_powder", "item_crystal_shell", "item_equip_script_1", "item_equip_script_2", "item_equip_script_3", "item_equip_script_4", "item_equip_script_4_1", "item_equip_script_4_2", "item_equip_script_4_3", "item_fbottle_copper_acid", "item_fbottle_copper_copper", "item_fbottle_copper_copper_enr", "item_fbottle_copper_grass_1", "item_fbottle_copper_grass_2", "item_fbottle_copper_sewage", "item_fbottle_copper_water", "item_fbottle_copper_xiranite", "item_fbottle_copper_xiranite_enr", "item_fbottle_copper_xiranite_lowpoly", "item_fbottle_copper_xiranite_poly", "item_fbottle_copperenr_acid", "item_fbottle_copperenr_copper", "item_fbottle_copperenr_copper_enr", "item_fbottle_copperenr_grass_1", "item_fbottle_copperenr_grass_2", "item_fbottle_copperenr_sewage", "item_fbottle_copperenr_water", "item_fbottle_copperenr_xiranite", "item_fbottle_copperenr_xiranite_enr", "item_fbottle_copperenr_xiranite_lowpoly", "item_fbottle_copperenr_xiranite_poly", "item_fbottle_glass_acid", "item_fbottle_glass_copper", "item_fbottle_glass_copper_enr", "item_fbottle_glass_grass_1", "item_fbottle_glass_grass_2", "item_fbottle_glass_sewage", "item_fbottle_glass_water", "item_fbottle_glass_xiranite", "item_fbottle_glass_xiranite_enr", "item_fbottle_glass_xiranite_lowpoly", "item_fbottle_glass_xiranite_poly", "item_fbottle_glassenr_acid", "item_fbottle_glassenr_copper", "item_fbottle_glassenr_copper_enr", "item_fbottle_glassenr_grass_1", "item_fbottle_glassenr_grass_2", "item_fbottle_glassenr_sewage", "item_fbottle_glassenr_water", "item_fbottle_glassenr_xiranite", "item_fbottle_glassenr_xiranite_enr", "item_fbottle_glassenr_xiranite_lowpoly", "item_fbottle_glassenr_xiranite_poly", "item_fbottle_iron_acid", "item_fbottle_iron_copper", "item_fbottle_iron_copper_enr", "item_fbottle_iron_grass_1", "item_fbottle_iron_grass_2", "item_fbottle_iron_sewage", "item_fbottle_iron_water", "item_fbottle_iron_xiranite", "item_fbottle_iron_xiranite_enr", "item_fbottle_iron_xiranite_lowpoly", "item_fbottle_iron_xiranite_poly", "item_fbottle_ironenr_acid", "item_fbottle_ironenr_copper", "item_fbottle_ironenr_copper_enr", "item_fbottle_ironenr_grass_1", "item_fbottle_ironenr_grass_2", "item_fbottle_ironenr_sewage", "item_fbottle_ironenr_water", "item_fbottle_ironenr_xiranite", "item_fbottle_ironenr_xiranite_enr", "item_fbottle_ironenr_xiranite_lowpoly", "item_fbottle_ironenr_xiranite_poly", "item_fbottle_xiranenr_grass_2", "item_filter_core", "item_gas_acid", "item_gas_copper", "item_gas_copper_enr", "item_gas_copper_enr2", "item_gas_inert", "item_gas_water", "item_gas_xiranite", "item_gas_xiranite_enr", "item_gasjar_copper_gas_acid", "item_gasjar_copper_gas_copper", "item_gasjar_copper_gas_copper_enr", "item_gasjar_copper_gas_copper_enr2", "item_gasjar_copper_gas_inert", "item_gasjar_copper_gas_water", "item_gasjar_copper_gas_xiranite", "item_gasjar_copper_gas_xiranite_enr", "item_glass_bottle", "item_glass_cmpt", "item_glass_enr_bottle", "item_glass_enr_cmpt", "item_iron_bottle", "item_iron_cmpt", "item_iron_enr", "item_iron_enr_bottle", "item_iron_enr_cmpt", "item_iron_enr_powder", "item_iron_nugget", "item_iron_ore", "item_iron_powder", "item_liquid_acid", "item_liquid_copper", "item_liquid_copper_enr", "item_liquid_plant_grass_1", "item_liquid_plant_grass_2", "item_liquid_sewage", "item_liquid_water", "item_liquid_xiranite", "item_liquid_xiranite_enr", "item_liquid_xiranite_lowpoly", "item_liquid_xiranite_poly", "item_muck_feces_1", "item_muck_xiranite_1", "item_originium_enr_powder", "item_originium_ore", "item_originium_powder", "item_plant_bbflower_1", "item_plant_bbflower_powder_1", "item_plant_bbflower_seed_1", "item_plant_grass_1", "item_plant_grass_2", "item_plant_grass_powder_1", "item_plant_grass_powder_2", "item_plant_grass_seed_1", "item_plant_grass_seed_2", "item_plant_moss_1", "item_plant_moss_2", "item_plant_moss_3", "item_plant_moss_enr_powder_1", "item_plant_moss_enr_powder_2", "item_plant_moss_powder_1", "item_plant_moss_powder_2", "item_plant_moss_powder_3", "item_plant_moss_seed_1", "item_plant_moss_seed_2", "item_plant_moss_seed_3", "item_plant_sp_1", "item_plant_sp_2", "item_plant_sp_3", "item_plant_sp_4", "item_plant_sp_seed_1", "item_plant_sp_seed_2", "item_plant_sp_seed_3", "item_plant_sp_seed_4", "item_plant_tundra_wood", "item_proc_battery_1", "item_proc_battery_2", "item_proc_battery_3", "item_proc_battery_4", "item_proc_battery_5", "item_proc_bomb_1", "item_quartz_enr", "item_quartz_enr_powder", "item_quartz_glass", "item_quartz_powder", "item_quartz_sand", "item_xiranite_enr_powder", "item_xiranite_poly", "item_xiranite_powder"];
  const ICON_URL = (id) => `https://static.warfarin.wiki/v4/itemicon/${id}.webp`;

  // ---- 极简 ZIP 打包(仅 store，不压缩，纯浏览器原生 API，不依赖任何库) ----
  const CRC_TABLE = (() => {
    const table = [];
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
    return table;
  })();
  function crc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ bytes[i]) & 0xFF];
    return (crc ^ 0xFFFFFFFF) >>> 0;
  }
  function buildZip(files) {
    const encoder = new TextEncoder();
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    for (const file of files) {
      const nameBytes = encoder.encode(file.name);
      const data = file.data;
      const crc = crc32(data);
      const size = data.length;

      const localHeader = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(localHeader.buffer);
      lv.setUint32(0, 0x04034b50, true);
      lv.setUint16(4, 20, true);
      lv.setUint16(6, 0, true);
      lv.setUint16(8, 0, true);
      lv.setUint16(10, 0, true);
      lv.setUint16(12, 0x5821, true); // mod date: 固定写死 2024-01-01，避免部分解压工具对日期为0报"非法日期"警告
      lv.setUint32(14, crc, true);
      lv.setUint32(18, size, true);
      lv.setUint32(22, size, true);
      lv.setUint16(26, nameBytes.length, true);
      lv.setUint16(28, 0, true);
      localHeader.set(nameBytes, 30);
      localParts.push(localHeader, data);

      const centralHeader = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(centralHeader.buffer);
      cv.setUint32(0, 0x02014b50, true);
      cv.setUint16(4, 20, true);
      cv.setUint16(6, 20, true);
      cv.setUint16(8, 0, true);
      cv.setUint16(10, 0, true);
      cv.setUint16(12, 0, true);
      cv.setUint16(14, 0x5821, true); // mod date，同上
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);
      cv.setUint32(24, size, true);
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);
      cv.setUint16(32, 0, true);
      cv.setUint16(34, 0, true);
      cv.setUint16(36, 0, true);
      cv.setUint32(38, 0, true);
      cv.setUint32(42, offset, true);
      centralHeader.set(nameBytes, 46);
      centralParts.push(centralHeader);

      offset += localHeader.length + data.length;
    }
    const centralSize = centralParts.reduce((s, p) => s + p.length, 0);
    const centralOffset = offset;
    const end = new Uint8Array(22);
    const ev = new DataView(end.buffer);
    ev.setUint32(0, 0x06054b50, true);
    ev.setUint16(4, 0, true);
    ev.setUint16(6, 0, true);
    ev.setUint16(8, files.length, true);
    ev.setUint16(10, files.length, true);
    ev.setUint32(12, centralSize, true);
    ev.setUint32(16, centralOffset, true);
    ev.setUint16(20, 0, true);
    return new Blob([...localParts, ...centralParts, end], { type: 'application/zip' });
  }

  // ---- 逐个抓取 ----
  const files = [];
  const missing = [];
  const failed = [];
  for (let i = 0; i < ITEM_IDS.length; i++) {
    const id = ITEM_IDS[i];
    try {
      const res = await fetch(ICON_URL(id));
      if (res.status === 404) {
        missing.push(id);
      } else if (!res.ok) {
        failed.push({ id, status: res.status });
      } else {
        const buf = new Uint8Array(await res.arrayBuffer());
        files.push({ name: `${id}.webp`, data: buf });
      }
    } catch (e) {
      failed.push({ id, error: String(e) });
    }
    if ((i + 1) % 20 === 0) console.log(`...${i + 1}/${ITEM_IDS.length}`);
  }

  console.log(`完成：成功 ${files.length} 个，404缺失 ${missing.length} 个，出错 ${failed.length} 个（共 ${ITEM_IDS.length} 个 id）`);
  if (missing.length) console.log('缺失(预期是fbottle/gasjar组合物品，正常)：', missing);
  if (failed.length) console.log('出错(建议重跑一次)：', failed);

  if (files.length === 0) {
    console.error('一个都没抓到，大概率是 CORS 被拦或者网络不通，看上面报错信息。');
    return;
  }

  const zipBlob = buildZip(files);
  const url = URL.createObjectURL(zipBlob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'item_icons.zip';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  console.log('已触发下载 item_icons.zip');
})();
