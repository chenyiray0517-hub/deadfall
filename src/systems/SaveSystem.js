// 存讀檔(M7.5,MVP 驗收項):整包遊戲狀態 → localStorage JSON
// 時間/數值/背包/武器耐久/建築(含箱內物品)/營火/已拿物資點/感染者/屍潮排程
// 建築與感染者的細節交給各自的 serialize()/loadFrom()

import { lootPoints, hideLoot } from '../world/LootSpawner.js';
import { campfires, placeCampfire } from './Crafting.js';
import { terrainHeight } from '../world/Terrain.js';

const KEY = 'deadfall_save_v1';

export function peekSave() {
  try {
    return JSON.parse(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

export function hasSave() {
  return !!peekSave();
}

export function clearSave() {
  try { localStorage.removeItem(KEY); } catch { /* 無痕模式等 */ }
}

// 已拿物資點:存 [type, x*10, z*10] 座標比對,不吃陣列索引——
// 世界生成微調(如 M8 加入室內物資點)後,舊檔的其他點不會錯位
const lootKey = (t, x, z) => `${t}:${Math.round(x * 10)}:${Math.round(z * 10)}`;

export function encodeTakenLoot() {
  return lootPoints.reduce((a, p) => (
    p.taken && a.push([p.type, Math.round(p.x * 10), Math.round(p.z * 10)]), a
  ), []);
}

export function applyTakenLoot(arr) {
  if (!arr || !arr.length) return;
  if (typeof arr[0] === 'number') {
    // 舊格式(純索引):只還原生成順序穩定的野莓/樹枝,其餘寧可重生也別錯藏
    for (const i of arr) {
      const p = lootPoints[i];
      if (p && (p.type === 'berry' || p.type === 'stick')) { p.taken = true; hideLoot(p); }
    }
    return;
  }
  const map = new Map(lootPoints.map((p) => [lootKey(p.type, p.x, p.z), p]));
  for (const [t, x, z] of arr) {
    const p = map.get(`${t}:${x}:${z}`);
    if (p) { p.taken = true; hideLoot(p); }
  }
}

export function saveGame({ timeSystem, stats, inventory, player, combat, buildings, enemies, skills, vehicles }) {
  const data = {
    v: 1,
    skills: skills ? skills.serialize() : null,
    time: { t: timeSystem.timeOfDay, day: timeSystem.day },
    stats: {
      hp: stats.hp, hunger: stats.hunger, thirst: stats.thirst, stamina: stats.stamina,
      exhausted: stats.exhausted, ageHours: stats.ageHours, infection: stats.infection,
      effects: stats.effects,
    },
    player: { x: player.position.x, z: player.position.z, yaw: player.yaw, pitch: player.pitch },
    inv: [...inventory.items.entries()],
    combat: { equipped: combat.equipped, dur: [...combat.dur.entries()] },
    buildings: buildings.serialize(),
    enemies: enemies.serialize(),
    loot: encodeTakenLoot(),
    fires: campfires.map((f) => ({ x: f.x, z: f.z })),
    vehicles: vehicles ? vehicles.serialize() : null, // M8c(舊檔沒有 = 全新未修狀態)
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

// data 來自 peekSave();呼叫端負責之後的 HUD 重繪
export function loadGame(data, { timeSystem, stats, inventory, player, combat, buildings, enemies, scene, skills, vehicles }) {
  timeSystem.timeOfDay = data.time.t;
  timeSystem.day = data.time.day;

  if (skills) skills.loadFrom(data.skills); // 舊檔沒有 skills = 從 Lv1 開始
  Object.assign(stats, data.stats);
  stats.alive = true;
  stats.deathCause = '';

  player.position.set(data.player.x, terrainHeight(data.player.x, data.player.z), data.player.z);
  player.yaw = data.player.yaw;
  player.pitch = data.player.pitch;
  player.velocityY = 0;
  player.onGround = true;

  inventory.items = new Map(data.inv);
  combat.dur = new Map(data.combat.dur);
  combat.equipped = data.combat.equipped;
  combat.buildViewmodel();

  buildings.loadFrom(data.buildings);
  enemies.loadFrom(data.enemies);

  if (vehicles) vehicles.loadFrom(data.vehicles);
  applyTakenLoot(data.loot);
  for (const f of data.fires) placeCampfire(scene, f.x, f.z);
}
