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

export function saveGame({ timeSystem, stats, inventory, player, combat, buildings, enemies }) {
  const data = {
    v: 1,
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
    loot: lootPoints.reduce((a, p, i) => (p.taken && a.push(i), a), []),
    fires: campfires.map((f) => ({ x: f.x, z: f.z })),
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

// data 來自 peekSave();呼叫端負責之後的 HUD 重繪
export function loadGame(data, { timeSystem, stats, inventory, player, combat, buildings, enemies, scene }) {
  timeSystem.timeOfDay = data.time.t;
  timeSystem.day = data.time.day;

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

  for (const i of data.loot) {
    const p = lootPoints[i];
    if (p) { p.taken = true; hideLoot(p); }
  }
  for (const f of data.fires) placeCampfire(scene, f.x, f.z);
}
