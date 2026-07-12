import * as THREE from '../lib/three.js';
import { Inventory } from '../player/Items.js';
import { terrainHeight, colliders, isDeepWater, TERRAIN_SIZE } from '../world/Terrain.js';

// 建造系統(M7,規格 7.2 起步集)
// 放置的建築註冊到 Terrain.colliders.boxes:玩家/感染者碰撞、AI 視線遮擋全部自動生效
// low:true 的建築不擋視線(Terrain.losBlocked 會跳過 noLos 的箱子)

export const BUILDABLES = [
  { id: 'wall', name: '木牆', cost: { wood: 4 }, hp: 250, size: { w: 2.6, h: 2.2, d: 0.3 } },
  { id: 'door', name: '木門', cost: { wood: 3 }, hp: 150, size: { w: 1.4, h: 2.2, d: 0.3 }, door: true },
  { id: 'spikes', name: '木刺牆', cost: { wood: 3, scrap: 1 }, hp: 120, size: { w: 2.6, h: 0.9, d: 0.6 }, spikes: true, low: true },
  { id: 'chest', name: '儲物箱', cost: { wood: 4 }, hp: 150, size: { w: 1.0, h: 0.8, d: 0.7 }, chest: true, low: true },
  { id: 'bed', name: '床', cost: { wood: 5, cloth: 3 }, hp: 150, size: { w: 1.2, h: 0.7, d: 2.2 }, bed: true, low: true },
];

export class Buildings {
  constructor(scene) {
    this.scene = scene;
    this.list = [];
    this.placing = null;     // 建造模式中的 BUILDABLES def
    this.ghost = null;
    this.ghostMats = [];
    this.placeX = 0;
    this.placeZ = 0;
    this.placeRot = 0;
    this.placeValid = false;
    this.homeBed = null;     // 重生點(最後睡過/放置的床)
    this.onDestroyed = null; // (b) => {} 被拆毀時通知 UI
  }

  canAfford(def, inv) {
    return Object.entries(def.cost).every(([id, n]) => inv.count(id) >= n);
  }

  // 旋轉吸附 90 度,所以佔地永遠是軸對齊 AABB
  footprint(def, x, z, rot) {
    const steps = ((Math.round(rot / (Math.PI / 2)) % 4) + 4) % 4;
    const [fw, fd] = steps % 2 === 1 ? [def.size.d, def.size.w] : [def.size.w, def.size.d];
    return { minX: x - fw / 2, maxX: x + fw / 2, minZ: z - fd / 2, maxZ: z + fd / 2 };
  }

  validAt(def, x, z, rot, playerPos) {
    const half = TERRAIN_SIZE / 2 - 4;
    if (Math.abs(x) > half || Math.abs(z) > half) return false;
    if (isDeepWater(x, z)) return false;
    const fp = this.footprint(def, x, z, rot);
    // 不與既有碰撞體(建築/車/樹/其他建造物)重疊
    for (const b of colliders.boxes) {
      if (fp.minX < b.maxX + 0.1 && fp.maxX > b.minX - 0.1 &&
          fp.minZ < b.maxZ + 0.1 && fp.maxZ > b.minZ - 0.1) return false;
    }
    for (const c of colliders.circles) {
      const cx = Math.max(fp.minX, Math.min(c.x, fp.maxX));
      const cz = Math.max(fp.minZ, Math.min(c.z, fp.maxZ));
      if (Math.hypot(c.x - cx, c.z - cz) < c.r + 0.1) return false;
    }
    // 別把自己卡在裡面
    if (playerPos && Math.hypot(x - playerPos.x, z - playerPos.z) < 1.4) return false;
    return true;
  }

  startPlacing(def) {
    this.cancelPlacing();
    this.placing = def;
    const built = buildMeshFor(def);
    this.ghostMats = [];
    built.group.traverse((o) => {
      if (o.material) {
        o.material = o.material.clone();
        o.material.transparent = true;
        o.material.opacity = 0.55;
        o.castShadow = false;
        this.ghostMats.push(o.material);
      }
    });
    this.ghost = built.group;
    this.scene.add(this.ghost);
  }

  cancelPlacing() {
    if (this.ghost) {
      this.scene.remove(this.ghost);
      this.ghost.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    }
    this.ghost = null;
    this.placing = null;
  }

  // 每幀:幽靈跟著視角走,合法性染色(綠可放/紅不可)
  updateGhost(player, inv) {
    if (!this.placing) return;
    const yaw = player.yaw;
    const x = player.position.x - Math.sin(yaw) * 3.0;
    const z = player.position.z - Math.cos(yaw) * 3.0;
    const rot = Math.round(yaw / (Math.PI / 2)) * (Math.PI / 2);
    this.placeX = x;
    this.placeZ = z;
    this.placeRot = rot;
    this.placeValid = this.validAt(this.placing, x, z, rot, player.position) &&
                      this.canAfford(this.placing, inv);
    this.ghost.position.set(x, terrainHeight(x, z), z);
    this.ghost.rotation.y = rot;
    for (const m of this.ghostMats) m.color.set(this.placeValid ? '#5fbf6a' : '#c84a3c');
  }

  // 放置(建造模式中左鍵);成功回傳訊息,可連續放置
  tryPlace(inv) {
    if (!this.placing || !this.placeValid) return null;
    for (const [id, n] of Object.entries(this.placing.cost)) inv.remove(id, n);
    this.place(this.placing, this.placeX, this.placeZ, this.placeRot);
    return `建造了${this.placing.name}`;
  }

  place(def, x, z, rot = 0) {
    const built = buildMeshFor(def);
    built.group.position.set(x, terrainHeight(x, z), z);
    built.group.rotation.y = rot;
    this.scene.add(built.group);
    const b = {
      def, x, z, rot,
      hp: def.hp,
      mesh: built.group,
      mats: built.mats,
      flashT: 0,
      open: false,                                  // 門用
      box: null,
      storage: def.chest ? new Inventory() : null,  // 儲物箱內容(死亡不掉落)
    };
    b.box = { ...this.footprint(def, x, z, rot), noLos: !!def.low, buildable: b };
    colliders.boxes.push(b.box);
    this.list.push(b);
    if (def.bed) this.homeBed = b;
    return b;
  }

  toggleDoor(b) {
    if (!b.def.door) return;
    b.open = !b.open;
    const idx = colliders.boxes.indexOf(b.box);
    if (b.open) {
      if (idx !== -1) colliders.boxes.splice(idx, 1); // 開門 = 不擋路也不擋視線
      b.mesh.rotation.y = b.rot + 1.25;
    } else {
      if (idx === -1) colliders.boxes.push(b.box);
      b.mesh.rotation.y = b.rot;
    }
  }

  // 感染者攻擊建築
  damage(b, dmg) {
    if (!this.list.includes(b)) return;
    b.hp -= dmg;
    b.flashT = 0.25;
    if (b.hp <= 0) {
      this.destroy(b);
      this.onDestroyed?.(b);
    }
  }

  destroy(b) {
    this.scene.remove(b.mesh);
    b.mesh.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
    const bi = colliders.boxes.indexOf(b.box);
    if (bi !== -1) colliders.boxes.splice(bi, 1);
    const li = this.list.indexOf(b);
    if (li !== -1) this.list.splice(li, 1);
    if (this.homeBed === b) this.homeBed = null;
  }

  // 感染者被這棟建築擋住嗎?(goal = 它想去的地方,方向不對就不算擋路)
  blockingStructure(pos, goal, margin = 0.75) {
    for (const b of this.list) {
      if (b.open) continue; // 開著的門不擋
      const bx = b.box;
      if (pos.x > bx.minX - margin && pos.x < bx.maxX + margin &&
          pos.z > bx.minZ - margin && pos.z < bx.maxZ + margin) {
        if (goal) {
          const cx = (bx.minX + bx.maxX) / 2;
          const cz = (bx.minZ + bx.maxZ) / 2;
          const gd = Math.hypot(goal.x - pos.x, goal.z - pos.z);
          const bd = Math.hypot(cx - pos.x, cz - pos.z);
          if (gd > 0.01 && bd > 0.01) {
            const dot = ((goal.x - pos.x) * (cx - pos.x) + (goal.z - pos.z) * (cz - pos.z)) / (gd * bd);
            if (dot < 0.2) continue;
          }
        }
        return b;
      }
    }
    return null;
  }

  // 站在木刺牆範圍內?(感染者持續扣血)
  spikesAt(pos, margin = 0.45) {
    for (const b of this.list) {
      if (!b.def.spikes) continue;
      const bx = b.box;
      if (pos.x > bx.minX - margin && pos.x < bx.maxX + margin &&
          pos.z > bx.minZ - margin && pos.z < bx.maxZ + margin) return b;
    }
    return null;
  }

  // 存讀檔(M7.5):儲物箱內容一起存;home 標記重生床
  serialize() {
    return this.list.map((b) => ({
      id: b.def.id, x: b.x, z: b.z, rot: b.rot, hp: b.hp, open: b.open,
      storage: b.storage ? [...b.storage.items.entries()] : null,
      home: this.homeBed === b,
    }));
  }

  loadFrom(arr) {
    let home = null;
    for (const s of arr || []) {
      const def = BUILDABLES.find((d) => d.id === s.id);
      if (!def) continue;
      const b = this.place(def, s.x, s.z, s.rot);
      b.hp = s.hp;
      if (s.open) this.toggleDoor(b);
      if (s.storage) for (const [id, n] of s.storage) b.storage.add(id, n);
      if (s.home) home = b;
    }
    if (home) this.homeBed = home;
  }

  respawnPoint() {
    if (this.homeBed) return this.homeBed;
    for (let i = this.list.length - 1; i >= 0; i--) {
      if (this.list[i].def.bed) return this.list[i];
    }
    return null;
  }

  // 受擊紅閃
  update(dt) {
    for (const b of this.list) {
      if (b.flashT > 0) {
        b.flashT = Math.max(0, b.flashT - dt);
        const e = b.flashT * 2.5;
        for (const m of b.mats) m.emissive.setRGB(e, e * 0.1, e * 0.05);
      }
    }
  }
}

// 睡到清晨 6 點:快轉時間、恢復狀態、消耗飢渴(但不會睡死)
export function sleepUntilMorning(timeSystem, stats) {
  const t = timeSystem.timeOfDay;
  const skipped = t >= 20 ? 30 - t : 6 - t;
  if (t >= 20) timeSystem.day++;
  timeSystem.timeOfDay = 6;
  stats.hunger = Math.max(5, stats.hunger - 1.5 * skipped);
  stats.thirst = Math.max(5, stats.thirst - 2.5 * skipped);
  stats.stamina = stats.staminaMax;
  stats.exhausted = false;
  stats.hp = Math.min(100, stats.hp + 20); // 睡眠回血(規格 3.1)
  return skipped;
}

// 死亡懲罰:每疊掉一半(規格 7.10 劇情模式「掉落部分物品」)
export function dropHalfInventory(inv) {
  for (const [id, n] of [...inv.items.entries()]) {
    const lose = Math.floor(n / 2);
    if (lose > 0) inv.remove(id, lose);
  }
}

function buildMeshFor(def) {
  const g = new THREE.Group();
  const mats = [];
  const mat = (c) => {
    const m = new THREE.MeshLambertMaterial({ color: c });
    mats.push(m);
    return m;
  };
  const box = (w, h, d, m, x = 0, y = 0, z = 0) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), m);
    mesh.position.set(x, y, z);
    mesh.castShadow = true;
    g.add(mesh);
    return mesh;
  };
  const { w, h, d } = def.size;

  if (def.id === 'wall') {
    box(w, h, d, mat('#8a6a42'), 0, h / 2, 0);
    const beam = mat('#6e5232');
    box(w, 0.12, d + 0.06, beam, 0, h - 0.15, 0);
    box(w, 0.12, d + 0.06, beam, 0, 0.35, 0);
  } else if (def.id === 'door') {
    box(w, h, d, mat('#7a5232'), 0, h / 2, 0);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.06, 6, 5), mat('#c9b26a'));
    knob.position.set(w / 2 - 0.2, h * 0.5, d / 2 + 0.05);
    g.add(knob);
  } else if (def.id === 'spikes') {
    box(w, 0.25, d, mat('#5f4a30'), 0, 0.13, 0);
    const spikeMat = mat('#b8a888');
    for (let i = 0; i < 4; i++) {
      const cone = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.8, 5), spikeMat);
      cone.position.set(-w / 2 + (i + 0.5) * (w / 4), 0.55, 0);
      cone.rotation.x = (i % 2 === 0 ? 1 : -1) * 0.5;
      cone.castShadow = true;
      g.add(cone);
    }
  } else if (def.id === 'chest') {
    box(w, h * 0.7, d, mat('#8a6a3c'), 0, h * 0.35, 0);
    box(w + 0.06, h * 0.3, d + 0.06, mat('#6e5232'), 0, h * 0.8, 0);
  } else if (def.id === 'bed') {
    box(w, 0.35, d, mat('#6e5232'), 0, 0.3, 0);                       // 床架
    box(w - 0.1, 0.18, d - 0.2, mat('#9aa4a8'), 0, 0.55, 0);          // 床墊
    box(w - 0.3, 0.12, 0.5, mat('#d8d4c2'), 0, 0.66, -d / 2 + 0.45);  // 枕頭
    box(w - 0.1, 0.14, d * 0.55, mat('#7a4a3a'), 0, 0.62, d * 0.18);  // 毯子
  }
  return { group: g, mats };
}
