import * as THREE from '../lib/three.js';
import {
  TERRAIN_SIZE, WORLD_SCALE, terrainHeight, mainRoadCenter, biomeWeights,
  colliders, isDeepWater, insideAnyBox, mulberry32,
} from '../world/Terrain.js';
import { structureSpots } from '../world/Structures.js';
import { ITEMS } from '../player/Items.js';
import { sfx } from '../core/Sound.js';

// 載具(M8c,規格 7.5 起步集:腳踏車 + 皮卡;摩托/巴士之後再加)
// 修理需要零件(引擎/輪胎/電瓶,從廢棄車拆或補給箱找)+ 廢金屬;皮卡另需汽油(廢棄車虹吸)
export const VEHICLE_TYPES = {
  bike: {
    name: '腳踏車', icon: '🚲',
    needs: { tire: 1, scrap: 2 },
    maxSpeed: 8.5, reverse: 2, accel: 5.5, turn: 2.3,
    hp: 40, fuelMax: 0, fuelUse: 0, noise: 0,      // 無聲、不耗油(前期神器)
    radius: 0.55, boxHalf: 0.6, camBack: 4.6, camUp: 2.5, ram: false,
    color: '#8a4030',
  },
  pickup: {
    name: '皮卡車', icon: '🛻',
    needs: { engine: 1, tire: 2, battery: 1, scrap: 4 },
    maxSpeed: 16, reverse: 4.5, accel: 7, turn: 1.6,
    hp: 100, fuelMax: 40, fuelUse: 0.25, noise: 35, // 引擎聲沿路引怪
    radius: 1.4, boxHalf: 1.6, camBack: 8, camUp: 3.8, ram: true,
    color: '#7a5030',
  },
};

export const FUEL_PER_CAN = 15; // 一桶汽油加多少
const BROKEN_COLOR = '#4a4640';

function needText(needs) {
  return Object.entries(needs).map(([id, n]) => `${ITEMS[id].name}×${n}`).join(' + ');
}

export class Vehicle {
  constructor(type, x, z, heading = 0) {
    this.type = type;
    this.def = VEHICLE_TYPES[type];
    this.x = x;
    this.z = z;
    this.heading = heading;
    this.speed = 0;
    this.fuel = 0;
    this.hp = 0;              // 修好才有車體耐久
    this.repaired = false;
    this.installed = {};      // 已裝入的零件數
    this.noiseNow = 0;

    const built = buildVehicleMesh(type, this.def);
    this.mesh = built.group;
    this.bodyMat = built.bodyMat;
    // 移動碰撞箱:軸對齊方形近似,開動時每幀跟著更新
    this.box = { minX: 0, maxX: 0, minZ: 0, maxZ: 0, noLos: type === 'bike' };
    colliders.boxes.push(this.box);
    this.syncBox();
    this.syncMesh();
  }

  // 還缺哪些零件 {id: n}
  missing() {
    const out = {};
    for (const [id, n] of Object.entries(this.def.needs)) {
      const left = n - (this.installed[id] || 0);
      if (left > 0) out[id] = left;
    }
    return out;
  }

  missingText() {
    return Object.entries(this.missing()).map(([id, n]) => `${ITEMS[id].name}×${n}`).join(' ');
  }

  setRepaired() {
    this.repaired = true;
    this.hp = this.def.hp;
    this.bodyMat.color.set(this.def.color);
  }

  syncBox() {
    const h = this.def.boxHalf;
    this.box.minX = this.x - h; this.box.maxX = this.x + h;
    this.box.minZ = this.z - h; this.box.maxZ = this.z + h;
  }

  syncMesh() {
    const L = 2.4; // 前後取樣距離(貼地傾斜用)
    const fx = -Math.sin(this.heading), fz = -Math.cos(this.heading);
    const hC = terrainHeight(this.x, this.z);
    const hF = terrainHeight(this.x + fx * L / 2, this.z + fz * L / 2);
    const hB = terrainHeight(this.x - fx * L / 2, this.z - fz * L / 2);
    this.mesh.position.set(this.x, hC, this.z);
    this.mesh.rotation.set(Math.atan2(hF - hB, L), this.heading, 0, 'YXZ');
  }
}

// ── 模型:方塊拼的皮卡/腳踏車,修好後 setRepaired 換回車色 ──
function buildVehicleMesh(type, def) {
  const g = new THREE.Group();
  const bodyMat = new THREE.MeshLambertMaterial({ color: BROKEN_COLOR });
  const darkMat = new THREE.MeshLambertMaterial({ color: '#26262a' });
  const box = (w, h, d, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  if (type === 'pickup') {
    box(1.9, 0.5, 4.2, bodyMat, 0, 0.75, 0);            // 底盤(車頭朝 -z)
    box(1.75, 0.75, 1.6, bodyMat, 0, 1.35, -0.5);       // 駕駛艙
    box(1.5, 0.35, 1.1, darkMat, 0, 1.5, -0.55);        // 車窗
    box(0.12, 0.45, 1.7, bodyMat, -0.89, 1.2, 1.2);     // 貨斗左緣
    box(0.12, 0.45, 1.7, bodyMat, 0.89, 1.2, 1.2);      // 貨斗右緣
    const wheelGeo = new THREE.CylinderGeometry(0.42, 0.42, 0.3, 10);
    for (const [wx, wz] of [[-0.95, -1.35], [0.95, -1.35], [-0.95, 1.35], [0.95, 1.35]]) {
      const w = new THREE.Mesh(wheelGeo, darkMat);
      w.rotation.z = Math.PI / 2;
      w.position.set(wx, 0.42, wz);
      w.castShadow = true;
      g.add(w);
    }
  } else {
    const wheelGeo = new THREE.TorusGeometry(0.33, 0.045, 6, 14);
    for (const wz of [-0.55, 0.55]) {
      const w = new THREE.Mesh(wheelGeo, darkMat);
      w.rotation.y = Math.PI / 2;
      w.position.set(0, 0.33, wz);
      g.add(w);
    }
    const frame = box(0.06, 0.06, 1.05, bodyMat, 0, 0.62, 0); // 主樑
    frame.rotation.x = 0.18;
    box(0.06, 0.5, 0.06, bodyMat, 0, 0.72, -0.5);             // 前叉
    box(0.5, 0.05, 0.06, darkMat, 0, 0.98, -0.5);             // 手把
    box(0.22, 0.05, 0.3, darkMat, 0, 0.92, 0.35);             // 座墊
  }
  return { group: g, bodyMat };
}

export class VehicleManager {
  constructor(scene) {
    this.scene = scene;
    this.vehicles = [];
    this.driving = null;
    this.toast = null; // main 掛上;測試環境不用
    // 廢棄車搜刮點(虹吸汽油 + 拆零件,每輛一次)
    this.carSpots = structureSpots
      .filter((s) => s.kind === 'car')
      .map((s) => ({ x: s.x, z: s.z, taken: false }));
    this.spawnAll();
    for (const v of this.vehicles) scene.add(v.mesh);
  }

  // 固定 seed 沿主幹道路肩生成:腳踏車×2(鄉村)、皮卡×1 鄉村 ×1 城市
  spawnAll() {
    const rng = mulberry32(424242);
    const half = TERRAIN_SIZE / 2 - 20;
    const place = (type, biomeKey, n) => {
      let placed = 0;
      for (let tries = 0; tries < 600 && placed < n; tries++) {
        const x = (rng() * 2 - 1) * half;
        if (x < -78 * WORLD_SCALE) continue; // 主幹道從這裡才開始
        const z = mainRoadCenter(x) + (rng() < 0.5 ? -1 : 1) * (6.5 + rng() * 2);
        if (biomeWeights(x, z)[biomeKey] < 0.7) continue;
        if (insideAnyBox(x, z, 2.6) || isDeepWater(x, z)) continue;
        this.vehicles.push(new Vehicle(type, x, z, Math.PI / 2 + (rng() - 0.5) * 0.7));
        placed++;
      }
    };
    place('bike', 'rural', 2);
    place('pickup', 'rural', 1);
    place('pickup', 'urban', 1);
  }

  nearestVehicle(pos, reach = 3.2) {
    let best = null, bd = reach;
    for (const v of this.vehicles) {
      const d = Math.hypot(v.x - pos.x, v.z - pos.z);
      if (d < bd) { bd = d; best = v; }
    }
    return best;
  }

  // 互動判定(Interaction.findInteraction 轉呼叫)
  findInteraction(pos) {
    const v = this.nearestVehicle(pos);
    if (v) {
      if (!v.repaired) return { kind: 'vehicle', v, label: `修理${v.def.name}(缺 ${v.missingText()})` };
      if (v.hp <= 0) return { kind: 'vehicle', v, label: `修復${v.def.name}車體(廢金屬×3)` };
      const dry = v.def.fuelMax > 0 && v.fuel <= 0 ? '(沒油——R 加油)' : '';
      return { kind: 'vehicle', v, label: `駕駛${v.def.name}${dry}` };
    }
    let spot = null, bd = 3.2;
    for (const s of this.carSpots) {
      if (s.taken) continue;
      const d = Math.hypot(s.x - pos.x, s.z - pos.z);
      if (d < bd) { bd = d; spot = s; }
    }
    if (spot) return { kind: 'carwreck', spot, label: '搜刮廢棄車(汽油與零件)' };
    return null;
  }

  // 執行互動;回傳 {msg, xp}
  interact(sel, inv, player, stats) {
    if (sel.kind === 'carwreck') return this.salvageCar(sel.spot, inv);
    const v = sel.v;
    if (!v.repaired) return this.tryInstall(v, inv);
    if (v.hp <= 0) return this.fixBody(v, inv);
    return this.enterVehicle(v, player, stats);
  }

  // 拆廢棄車:必得汽油與廢金屬,零件看運氣
  salvageCar(spot, inv) {
    spot.taken = true;
    const got = { fuel: 1 + (Math.random() < 0.5 ? 1 : 0), scrap: 1 + (Math.random() < 0.6 ? 1 : 0) };
    if (Math.random() < 0.30) got.tire = 1;
    if (Math.random() < 0.22) got.battery = 1;
    if (Math.random() < 0.16) got.engine = 1;
    const parts = [];
    for (const [id, n] of Object.entries(got)) {
      inv.add(id, n);
      parts.push(`${ITEMS[id].name}×${n}`);
    }
    return { msg: `拆下了 ${parts.join('、')}`, xp: 3 };
  }

  // 裝零件:身上有多少裝多少,湊齊就修好
  tryInstall(v, inv) {
    let installed = 0;
    for (const [id, need] of Object.entries(v.missing())) {
      const take = Math.min(inv.count(id), need);
      if (take > 0) {
        inv.remove(id, take);
        v.installed[id] = (v.installed[id] || 0) + take;
        installed += take;
      }
    }
    if (Object.keys(v.missing()).length === 0) {
      v.setRepaired();
      return { msg: `🔧 ${v.def.name}修好了!${v.def.fuelMax > 0 ? 'R 鍵加油後就能開' : 'E 上車'}`, xp: 20 };
    }
    if (installed > 0) return { msg: `裝上了零件,還缺:${v.missingText()}` };
    return { msg: `零件不足——需要 ${v.missingText()}(廢棄車能拆到)` };
  }

  // 車體被打爛後用廢金屬修回一半耐久
  fixBody(v, inv) {
    if (inv.count('scrap') < 3) return { msg: '需要廢金屬×3 才能修復車體' };
    inv.remove('scrap', 3);
    v.hp = Math.round(v.def.hp * 0.5);
    return { msg: `🔧 修復了${v.def.name}(耐久 ${v.hp}/${v.def.hp})` };
  }

  enterVehicle(v, player, stats) {
    this.driving = v;
    player.driving = v;
    player.crouching = false;
    stats.activity.moving = false;
    stats.activity.running = false;
    const hint = v.def.fuelMax > 0 ? ' · R 加油' : '';
    return { msg: `上了${v.def.name}——WASD 駕駛 · E 下車${hint}` };
  }

  exitVehicle(player) {
    const v = this.driving;
    if (!v) return '';
    v.speed = 0;
    v.noiseNow = 0;
    v.syncBox();
    v.syncMesh();
    // 下到車的右側,讓玩家自己的碰撞解算推開
    player.position.set(
      v.x + Math.cos(v.heading) * (v.def.boxHalf + 0.9),
      terrainHeight(v.x, v.z),
      v.z - Math.sin(v.heading) * (v.def.boxHalf + 0.9)
    );
    player.yaw = v.heading;
    player.driving = null;
    this.driving = null;
    return `下了${v.def.name}`;
  }

  // R 加油:開著車或站在車旁都行
  refuel(inv) {
    const v = this.driving;
    if (!v || v.def.fuelMax <= 0) return null;
    if (inv.count('fuel') <= 0) return '沒有汽油桶——廢棄車可以虹吸';
    if (v.fuel >= v.def.fuelMax - 0.01) return '油箱已滿';
    inv.remove('fuel', 1);
    v.fuel = Math.min(v.def.fuelMax, v.fuel + FUEL_PER_CAN);
    return `⛽ 加了一桶油(${Math.round(v.fuel)}/${v.def.fuelMax})`;
  }

  // 感染者攻擊被車體吸收(EnemyManager.interceptAttack 掛這裡);回傳是否攔下
  interceptAttack(dmg) {
    const v = this.driving;
    if (!v || v.hp <= 0) return false;
    sfx.play('thudMetal'); // 感染者搥打車體
    this.damageVehicle(v, dmg);
    return true;
  }

  damageVehicle(v, dmg) {
    if (v.hp <= 0) return;
    v.hp = Math.max(0, v.hp - dmg);
    if (v.hp <= 0) {
      this.toast?.(`💥 ${v.def.name}拋錨了!需要廢金屬×3 修復車體`);
      sfx.play('sputter');
    }
  }

  // 碰撞解算(跳過自己的碰撞箱),回傳被推開的距離
  resolveSelf(v) {
    const p = { x: v.x, z: v.z };
    const R = v.def.radius;
    for (const c of colliders.circles) {
      const dx = p.x - c.x, dz = p.z - c.z;
      const r = c.r + R;
      const d2 = dx * dx + dz * dz;
      if (d2 < r * r && d2 > 1e-8) {
        const d = Math.sqrt(d2);
        p.x = c.x + (dx / d) * r;
        p.z = c.z + (dz / d) * r;
      }
    }
    for (const b of colliders.boxes) {
      if (b === v.box) continue;
      if (p.x > b.minX - R && p.x < b.maxX + R && p.z > b.minZ - R && p.z < b.maxZ + R) {
        const pushLeft = p.x - (b.minX - R);
        const pushRight = (b.maxX + R) - p.x;
        const pushNear = p.z - (b.minZ - R);
        const pushFar = (b.maxZ + R) - p.z;
        const min = Math.min(pushLeft, pushRight, pushNear, pushFar);
        if (min === pushLeft) p.x = b.minX - R;
        else if (min === pushRight) p.x = b.maxX + R;
        else if (min === pushNear) p.z = b.minZ - R;
        else p.z = b.maxZ + R;
      }
    }
    const disp = Math.hypot(p.x - v.x, p.z - v.z);
    v.x = p.x;
    v.z = p.z;
    return disp;
  }

  // 駕駛物理:每幀由 main 呼叫;沒在開車就什麼都不做
  // ctx = { player, stats, enemies, camera, now, onRam(killed, zb) }
  update(dt, ctx) {
    const v = this.driving;
    if (!v) return;
    const { player, enemies, camera, now = 0 } = ctx;
    const k = player.keys || {};

    // 油門/煞車;沒油或拋錨只能滑行
    const canPower = v.hp > 0 && (v.def.fuelMax === 0 || v.fuel > 0);
    const throttle = canPower ? (k['KeyW'] ? 1 : 0) - (k['KeyS'] ? 1 : 0) : 0;
    if (throttle > 0) v.speed = Math.min(v.def.maxSpeed, v.speed + v.def.accel * dt);
    else if (throttle < 0) v.speed = Math.max(-v.def.reverse, v.speed - v.def.accel * 0.9 * dt);
    else {
      v.speed *= Math.max(0, 1 - 1.5 * dt);
      if (Math.abs(v.speed) < 0.05) v.speed = 0;
    }

    // 轉向(低速轉不動;倒車方向自然反過來)
    const steer = (k['KeyA'] ? 1 : 0) - (k['KeyD'] ? 1 : 0);
    if (steer && Math.abs(v.speed) > 0.3) {
      v.heading += steer * v.def.turn * dt * Math.sign(v.speed) * Math.min(1, Math.abs(v.speed) / 5);
    }

    // 油耗
    if (throttle !== 0 && v.def.fuelUse > 0) {
      const before = v.fuel;
      v.fuel = Math.max(0, v.fuel - v.def.fuelUse * dt);
      if (before > 0 && v.fuel <= 0) {
        this.toast?.('⛽ 沒油了!R 加油(廢棄車可虹吸)');
        sfx.play('sputter');
      }
    }

    // 位移
    const fx = -Math.sin(v.heading), fz = -Math.cos(v.heading);
    const px = v.x, pz = v.z;
    v.x += fx * v.speed * dt;
    v.z += fz * v.speed * dt;
    const half = TERRAIN_SIZE / 2 - 3;
    v.x = THREE.MathUtils.clamp(v.x, -half, half);
    v.z = THREE.MathUtils.clamp(v.z, -half, half);
    if (isDeepWater(v.x, v.z)) {
      v.x = px; v.z = pz; v.speed = 0;
    }

    // 撞牆/撞樹:高速損車體,低速只減速
    const disp = this.resolveSelf(v);
    if (disp > 0.02) {
      if (Math.abs(v.speed) > 6) {
        const dmg = Math.round((Math.abs(v.speed) - 5) * 2.5);
        sfx.play('crashMetal');
        this.damageVehicle(v, dmg);
        this.toast?.(`💥 撞上了!${v.def.name} -${dmg} 耐久`);
        v.speed *= -0.15;
      } else {
        v.speed *= 0.5;
      }
    }

    // 皮卡衝撞感染者(規格 7.5;每隻 0.8 秒內只判一次)
    if (v.def.ram && enemies && Math.abs(v.speed) > 4.5) {
      const hx = v.x + fx * Math.sign(v.speed) * 2.1;
      const hz = v.z + fz * Math.sign(v.speed) * 2.1;
      for (const zb of enemies.zombies) {
        if (!zb.alive || now - (zb._ramT ?? -9) < 0.8) continue;
        if (Math.hypot(zb.pos.x - hx, zb.pos.z - hz) > 1.7) continue;
        zb._ramT = now;
        const dmg = Math.round(12 + Math.abs(v.speed) * 4);
        const killed = zb.takeDamage(dmg, { x: v.x, z: v.z }, enemies, now);
        this.damageVehicle(v, 2);
        v.speed *= 0.88;
        ctx.onRam?.(killed, zb);
      }
    }

    // 引擎噪音(腳踏車 0;Player.noiseRadius 開車時讀這個)
    v.noiseNow = v.def.noise > 0 && canPower && (throttle !== 0 || Math.abs(v.speed) > 1) ? v.def.noise : 0;

    // 同步玩家位置(感染者追的是玩家座標)與模型/碰撞箱
    player.position.set(v.x, terrainHeight(v.x, v.z), v.z);
    player.yaw = v.heading;
    v.syncBox();
    v.syncMesh();

    // 第三人稱跟車相機
    if (camera) {
      const bx = v.x + Math.sin(v.heading) * v.def.camBack;
      const bz = v.z + Math.cos(v.heading) * v.def.camBack;
      const by = Math.max(
        terrainHeight(v.x, v.z) + v.def.camUp,
        terrainHeight(bx, bz) + 1.3
      );
      const t = Math.min(1, dt * 5);
      camera.position.x += (bx - camera.position.x) * t;
      camera.position.y += (by - camera.position.y) * t;
      camera.position.z += (bz - camera.position.z) * t;
      camera.lookAt(v.x, terrainHeight(v.x, v.z) + 1.3, v.z);
    }
  }

  // HUD 一行字(速度/油量/耐久)
  hudText() {
    const v = this.driving;
    if (!v) return '';
    const kmh = Math.round(Math.abs(v.speed) * 3.6);
    const fuel = v.def.fuelMax > 0 ? ` · ⛽ ${Math.round(v.fuel)}/${v.def.fuelMax}` : '';
    return `${v.def.icon} ${kmh} km/h${fuel} · 🔧 ${Math.round(v.hp)}/${v.def.hp}`;
  }

  // ── 存讀檔:載具依生成順序(固定 seed)用索引還原;廢棄車用座標比對 ──
  serialize() {
    return {
      v: this.vehicles.map((v) => ({
        t: v.type, x: Math.round(v.x * 10) / 10, z: Math.round(v.z * 10) / 10,
        h: Math.round(v.heading * 100) / 100,
        fuel: Math.round(v.fuel * 10) / 10, hp: Math.round(v.hp * 10) / 10,
        rep: v.repaired ? 1 : 0, inst: v.installed,
      })),
      cars: this.carSpots.reduce((a, s) => (
        s.taken && a.push([Math.round(s.x * 10), Math.round(s.z * 10)]), a
      ), []),
    };
  }

  loadFrom(data) {
    if (!data) return; // 舊檔沒有載具 = 維持初始狀態
    (data.v || []).forEach((s, i) => {
      const v = this.vehicles[i];
      if (!v || v.type !== s.t) return;
      v.x = s.x; v.z = s.z; v.heading = s.h || 0;
      v.fuel = s.fuel || 0;
      v.installed = s.inst || {};
      if (s.rep) v.setRepaired();
      v.hp = s.hp || 0;
      v.speed = 0;
      v.syncBox();
      v.syncMesh();
    });
    const taken = new Set((data.cars || []).map(([x, z]) => `${x}:${z}`));
    for (const s of this.carSpots) {
      if (taken.has(`${Math.round(s.x * 10)}:${Math.round(s.z * 10)}`)) s.taken = true;
    }
  }
}
