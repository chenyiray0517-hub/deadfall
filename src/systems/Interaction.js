import { ITEMS } from '../player/Items.js';
import { lootPoints, takeLoot, LOOT_LABELS } from '../world/LootSpawner.js';
import { LAKE } from '../world/Terrain.js';

const REACH = 2.6;

// 找出目前可互動的目標,回傳 {kind, label, point?/zombie?/b?} 或 null
export function findInteraction(player, inv, enemies, buildings) {
  // 自己蓋的設施:門/儲物箱/床(M7;開關門要快,擺最前面)
  if (buildings) {
    let bb = null;
    let bd = REACH;
    for (const b of buildings.list) {
      if (!b.def.door && !b.def.chest && !b.def.bed) continue;
      const d = Math.hypot(b.x - player.position.x, b.z - player.position.z);
      if (d < bd) { bd = d; bb = b; }
    }
    if (bb) {
      if (bb.def.door) return { kind: 'door', b: bb, label: bb.open ? '關門' : '開門' };
      if (bb.def.chest) return { kind: 'chest', b: bb, label: '打開儲物箱' };
      return { kind: 'bed', b: bb, label: '睡覺(夜間快轉,設重生點)' };
    }
  }

  // 最近的未搜刮屍體(M6)
  if (enemies) {
    let bz = null;
    let bd = REACH;
    for (const zb of enemies.zombies) {
      if (!zb.corpse || zb.looted) continue;
      const d = Math.hypot(zb.pos.x - player.position.x, zb.pos.z - player.position.z);
      if (d < bd) { bd = d; bz = zb; }
    }
    if (bz) return { kind: 'corpse', zombie: bz, label: `搜刮屍體(${bz.def.name})` };
  }

  // 最近的未拿取物資點
  let best = null;
  let bestD = REACH;
  for (const p of lootPoints) {
    if (p.taken) continue;
    const d = Math.hypot(p.x - player.position.x, p.z - player.position.z);
    if (d < bestD) { bestD = d; best = p; }
  }
  if (best) return { kind: 'loot', point: best, label: LOOT_LABELS[best.type] };

  // 湖邊:裝水(有空瓶)或直接喝
  const dLake = Math.hypot(player.position.x - LAKE.x, player.position.z - LAKE.z);
  if (dLake < LAKE.r + 2.5 && player.position.y < 0.6) {
    if (inv.count('empty') > 0) return { kind: 'fill', label: '裝水(空瓶)' };
    return { kind: 'drinkLake', label: '直接喝湖水(有風險)' };
  }
  return null;
}

// 執行互動,回傳訊息
export function doInteract(sel, inv, stats) {
  if (sel.kind === 'corpse') {
    const zb = sel.zombie;
    zb.looted = true;
    const got = { ...(zb.corpseLoot || {}) };
    if (zb.stuckArrows > 0) got.arrow = (got.arrow || 0) + zb.stuckArrows; // 回收插在身上的箭
    const parts = [];
    for (const [id, n] of Object.entries(got)) {
      inv.add(id, n);
      parts.push(`${ITEMS[id].name}×${n}`);
    }
    return parts.length ? `獲得 ${parts.join('、')}` : '屍體上什麼都沒有';
  }
  if (sel.kind === 'loot') {
    const got = takeLoot(sel.point);
    const parts = [];
    for (const [id, n] of Object.entries(got)) {
      inv.add(id, n);
      parts.push(`${ITEMS[id].name}×${n}`);
    }
    return `獲得 ${parts.join('、')}`;
  }
  if (sel.kind === 'fill') {
    inv.remove('empty', 1);
    inv.add('dirty', 1);
    return '裝了一瓶髒水(煮沸再喝比較安全)';
  }
  if (sel.kind === 'drinkLake') {
    stats.thirst = Math.min(100, stats.thirst + 30);
    if (Math.random() < 0.4) {
      stats.addEffect('dysentery', 3, '🤢 痢疾');
      return '+30 口渴……肚子開始絞痛(痢疾!)';
    }
    return '+30 口渴(這次運氣不錯)';
  }
  return '';
}
