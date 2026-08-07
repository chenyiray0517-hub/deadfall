// 鏽爪幫掠奪者(M8f-3,規格 7.8「敵對掠奪者,會伏擊玩家、突襲據點,可攻打其營地」)
//
// 掠奪者是「會用槍的活人」,不吃感染者那一套視錐/低吼規則:靠距離 + 視線判斷,
// 會追人、會打你的同伴、會拆你的牆,而且槍手開槍的聲音一樣會把附近的感染者引過來。
//
// 三種來源(mode):
//   camp   固定營地的守衛——全部清光 = 拿下營地(頭目掉軍用鑰匙卡,主線要用)
//   ambush 路上伏擊(第 4 天起,每 2~4 天一次;鏽爪聲望高或 🤞 談判技能可以免掉)
//   raid   夜襲你的據點(第 6 天起,直接砸你蓋的建築)
//
// 實體刻意做成跟 Zombie 一樣的鴨子介面(alive/pos/def/takeDamage/corpse/stuckArrows…),
// Combat 的命中判定、搜屍互動、同伴 AI 都能原封不動地把他們當目標處理。

import * as THREE from '../lib/three.js';
import {
  TERRAIN_SIZE, SPAWN, terrainHeight, biomeWeights, isDeepWater, losBlocked,
  resolveColliders, insideAnyBox, insideNoSpawn, colliders, mulberry32,
} from '../world/Terrain.js';
import { routeViaDoor } from '../world/Interiors.js';
import { structureSpots } from '../world/Structures.js';
import { sfx } from '../core/Sound.js';

export const RAIDER_TYPES = {
  thug: {
    name: '鏽爪打手', hp: 70, speed: 2.7, dmg: 12, range: 1.9, cd: 1.2,
    sight: 26, xp: 25, coat: '#8a3a2a', build: 1,
  },
  gunner: {
    name: '鏽爪槍手', hp: 55, speed: 2.2, dmg: 14, range: 26, cd: 2.1,
    sight: 34, xp: 30, coat: '#6a4a2a', build: 1, ranged: true, accuracy: 0.62,
  },
  boss: {
    name: '鏽爪頭目', hp: 260, speed: 2.5, dmg: 24, range: 2.3, cd: 1.5,
    sight: 30, xp: 120, coat: '#5a1f18', build: 1.18, boss: true,
  },
};

// 營地守衛編制(打完 = 營地清空)
const CAMP_GUARDS = ['thug', 'thug', 'thug', 'thug', 'gunner', 'gunner', 'boss'];

const AMBUSH_FIRST_DAY = 4;  // 第幾天起會在路上遇到伏擊
const RAID_FIRST_DAY = 6;    // 第幾天起會來砸據點
const CALM_REP = 60;         // 鏽爪聲望到這個數字就不再找你麻煩

let raiderId = 0;

class Raider {
  constructor(type, x, z, mgr, mode = 'camp') {
    this.id = raiderId++;
    this.type = type;
    this.def = RAIDER_TYPES[type];
    this.mgr = mgr;
    this.mode = mode;
    this.isRaider = true; // Combat/main 用來分辨(感染者沒有這個旗標)
    this.hp = this.def.hp;
    this.alive = true;
    this.pos = new THREE.Vector3(x, terrainHeight(x, z), z);
    this.home = { x, z };
    this.facing = Math.random() * Math.PI * 2;

    this.state = mode === 'camp' ? 'guard' : 'chase'; // guard | chase | flee | raid
    this.target = null;
    this.lastKnown = null;
    this.lastSeenTime = -99;
    this.stateTimer = 0;
    this.senseTimer = Math.random() * 0.2;
    this.attackCd = 0;
    this.fleeT = 0;
    this.lodDt = 0;
    this.bobPhase = Math.random() * 10;

    // 受擊/屍體(跟感染者同一套,搜屍走 Interaction 的 corpse 分支)
    this.staggerT = 0;
    this.hitFlash = 0;
    this.corpse = false;
    this.corpseAt = 0;
    this.lootedAt = 0;
    this.looted = false;
    this.stuckArrows = 0;
    this.corpseLoot = null;

    const built = buildRaiderMesh(this.def);
    this.mesh = built.group;
    this.mats = built.mats;
    this.mesh.position.copy(this.pos);
  }

  // 被打;回傳是否被擊殺(簽名與 Zombie 相同,manager 參數用不到——自己身上有 mgr)
  takeDamage(dmg, fromPos, _manager, now = 0) {
    if (!this.alive) return false;
    this.hp -= dmg;
    this.hitFlash = 0.25;
    if (this.hp <= 0) {
      this.die(now);
      sfx.play3d('hurt', this.pos.x, this.pos.z, { vol: 1.1 });
      return true;
    }
    sfx.play3d('hurt', this.pos.x, this.pos.z, { vol: 0.8 });
    this.staggerT = 0.3;
    this.lastKnown = { x: fromPos.x, z: fromPos.z };
    this.alertSelf(now);
    this.mgr.alert(this.pos.x, this.pos.z, 22, this.lastKnown, now); // 同夥聞聲圍過來
    return false;
  }

  alertSelf(now) {
    if (this.state === 'chase') return;
    if (this.state !== 'flee') {
      sfx.play3d('yell', this.pos.x, this.pos.z, { dist: 60 });
      this.state = 'chase';
      this.stateTimer = 0;
      this.lastSeenTime = now;
    }
  }

  die(now = 0) {
    this.alive = false;
    this.corpse = true;
    this.corpseAt = now;
    this.corpseLoot = this.rollLoot();
    this.mesh.rotation.set(0, this.facing, Math.PI / 2);
    this.mesh.position.set(this.pos.x, terrainHeight(this.pos.x, this.pos.z) + 0.3, this.pos.z);
  }

  // 掉落:活人身上有瓶蓋、彈藥、藥品;頭目掉軍用鑰匙卡(主線要用)
  rollLoot() {
    const r = Math.random;
    const got = {};
    if (this.def.boss) {
      got.caps = 45 + Math.floor(r() * 30);
      got.keycard = 1;
      got.shell = 4 + Math.floor(r() * 4);
      got.antibiotic = 1;
      if (r() < 0.5) got.shotgun = 1;
      return got;
    }
    got.caps = 5 + Math.floor(r() * (this.def.ranged ? 16 : 11));
    if (r() < 0.5) got.cloth = 1;
    if (this.def.ranged) {
      got.ammo9 = 3 + Math.floor(r() * 5);
      if (r() < 0.18) got.pistol = 1;
    } else {
      if (r() < 0.3) got.scrap = 1;
      if (r() < 0.15) got.pipe = 1;
    }
    if (r() < 0.2) got.bandage = 1;
    return got;
  }

  // 活人的偵測:距離 + 視線(蹲伏減四成、夜晚再減兩成),沒有視錐——他們是警戒中的人
  canSee(playerPos, crouching, night) {
    const d = Math.hypot(playerPos.x - this.pos.x, playerPos.z - this.pos.z);
    let sight = this.def.sight * (1 - 0.2 * night);
    if (crouching) sight *= 0.6;
    if (d > sight) return false;
    return !losBlocked(this.pos.x, this.pos.z, playerPos.x, playerPos.z);
  }

  // 打誰:預設打玩家,同伴明顯更近的話先解決同伴
  pickTarget(world) {
    const p = world.playerPos;
    let best = {
      x: p.x, z: p.z, comp: null,
      d: world.playerStats.alive ? Math.hypot(p.x - this.pos.x, p.z - this.pos.z) : Infinity,
    };
    for (const c of world.companions || []) {
      if (!c.alive) continue;
      const d = Math.hypot(c.x - this.pos.x, c.z - this.pos.z);
      if (d < best.d * 0.8) best = { x: c.x, z: c.z, comp: c, d };
    }
    return best;
  }

  attack(world, tgt) {
    this.attackCd = this.def.cd;
    this.facing = Math.atan2(tgt.x - this.pos.x, tgt.z - this.pos.z);
    let hit = true;
    if (this.def.ranged) {
      sfx.play3d('pistol', this.pos.x, this.pos.z, { dist: 90 });
      // 槍聲照樣是噪音,附近的感染者會被引過來(規格 5.3)
      world.hearNoise?.(this.pos.x, this.pos.z, 45, world.night);
      hit = Math.random() < this.def.accuracy;
    } else {
      sfx.play3d('swing', this.pos.x, this.pos.z, { vol: 0.8 });
    }
    if (!hit) return;
    if (tgt.comp) {
      world.onHitCompanion?.(tgt.comp, this.def.dmg, this.def.name);
      return;
    }
    sfx.play3d('hitFlesh', this.pos.x, this.pos.z, { vol: 0.8 });
    world.onAttack(this.def.dmg, `被${this.def.name}打死`);
  }

  // world: {playerPos, playerStats, crouching, night, now, buildings, companions,
  //         onAttack, onHitCompanion, hearNoise}
  update(dt, world) {
    if (this.hitFlash > 0) {
      this.hitFlash = Math.max(0, this.hitFlash - dt);
      const e = this.hitFlash * 3;
      for (const m of this.mats) m.emissive.setRGB(e, e * 0.08, e * 0.05);
    }
    if (!this.alive) return;
    const { playerPos, playerStats, now } = world;
    this.attackCd = Math.max(0, this.attackCd - dt);
    this.staggerT = Math.max(0, this.staggerT - dt);
    this.stateTimer += dt;

    // 感知(每 0.2 秒)
    this.senseTimer -= dt;
    if (this.senseTimer <= 0 && playerStats.alive) {
      this.senseTimer = 0.2;
      if (this.canSee(playerPos, world.crouching, world.night)) {
        this.lastKnown = { x: playerPos.x, z: playerPos.z };
        this.lastSeenTime = now;
        if (this.state === 'guard' || this.state === 'raid') {
          this.alertSelf(now);
          this.mgr.alert(this.pos.x, this.pos.z, 18, this.lastKnown, now);
        }
      }
    }

    // 見血就跑:打手/槍手剩兩成半的血會脫離戰鬥喘口氣,頭目不跑
    if (this.alive && !this.def.boss && this.state === 'chase'
        && this.hp < this.def.hp * 0.25 && this.fleeT <= 0 && Math.random() < 0.02) {
      this.state = 'flee';
      this.fleeT = 6;
    }

    let goal = null;
    let speed = 0;
    const tgt = this.pickTarget(world);

    if (this.state === 'flee') {
      this.fleeT -= dt;
      goal = {
        x: this.pos.x + (this.pos.x - playerPos.x),
        z: this.pos.z + (this.pos.z - playerPos.z),
      };
      speed = this.def.speed * 1.1;
      if (this.fleeT <= 0) this.state = this.mode === 'camp' ? 'guard' : 'chase';
    } else if (this.state === 'chase') {
      goal = this.lastKnown || { x: tgt.x, z: tgt.z };
      speed = this.def.speed;
      if (tgt.comp && tgt.d < 18) goal = { x: tgt.x, z: tgt.z }; // 正在跟同伴纏鬥就盯著他打
      // 打不到人就砸擋路的建築(規格 7.2 據點襲擊)
      if (tgt.d <= this.def.range && this.attackCd <= 0 && this.staggerT <= 0) {
        const clear = !this.def.ranged
          || !losBlocked(this.pos.x, this.pos.z, tgt.x, tgt.z);
        if (clear) {
          speed = 0;
          this.attack(world, tgt);
        }
      } else if (world.buildings && this.attackCd <= 0) {
        const blocked = world.buildings.blockingStructure(this.pos, goal, 0.75);
        if (blocked) {
          this.attackCd = this.def.cd;
          world.buildings.damage(blocked, this.def.dmg * 1.5);
          sfx.play3d('knock', this.pos.x, this.pos.z, { vol: 0.8 });
          this.lastSeenTime = now;
        }
      }
      // 追丟太久:守衛回營地,伏擊/夜襲的改去砸建築或散開
      if (now - (this.lastSeenTime ?? -99) > 12) {
        this.state = this.mode === 'camp' ? 'guard' : this.mode === 'raid' ? 'raid' : 'guard';
        this.stateTimer = 0;
      }
    } else if (this.state === 'raid') {
      // 夜襲:專挑玩家蓋的東西砸
      const b = world.buildings ? nearestStructure(world.buildings, this.pos) : null;
      if (b) {
        goal = { x: b.x, z: b.z };
        speed = this.def.speed * 0.85;
        const d = Math.hypot(b.x - this.pos.x, b.z - this.pos.z);
        if (d < 2.4) {
          speed = 0;
          if (this.attackCd <= 0) {
            this.attackCd = this.def.cd;
            world.buildings.damage(b, this.def.dmg * 1.5);
            sfx.play3d('knock', this.pos.x, this.pos.z, { vol: 0.9 });
          }
        }
      } else {
        this.state = 'guard'; // 沒東西可砸了
      }
    } else {
      // guard:在營地(或落腳處)附近晃
      if (!this.target || this.stateTimer > 5 + (this.id % 4)) {
        this.stateTimer = 0;
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 6;
        this.target = { x: this.home.x + Math.cos(a) * r, z: this.home.z + Math.sin(a) * r };
      }
      goal = this.target;
      speed = this.def.speed * 0.3;
    }

    if (this.staggerT > 0) speed = 0;

    // 移動(目標隔著室內牆時先繞到門口,跟感染者共用同一套 M8a 導航)
    if (goal && speed > 0) {
      const via = routeViaDoor(this.pos, goal);
      const dx = via.x - this.pos.x;
      const dz = via.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.3) {
        const nx = this.pos.x + (dx / d) * speed * dt;
        const nz = this.pos.z + (dz / d) * speed * dt;
        if (!isDeepWater(nx, nz)) {
          this.pos.x = nx;
          this.pos.z = nz;
          this.facing = Math.atan2(dx, dz);
        } else {
          this.target = null;
        }
      } else if (this.state === 'guard') {
        this.target = null;
      }
    }

    const half = TERRAIN_SIZE / 2 - 2;
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, -half, half);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, -half, half);
    resolveColliders(this.pos, 0.35);
    this.pos.y = terrainHeight(this.pos.x, this.pos.z);

    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.facing;
    const bob = speed > 0 ? Math.sin(now * (4 + speed) + this.bobPhase) * 0.05 : 0;
    this.mesh.position.y += Math.abs(bob);
  }
}

// 玩家蓋的建築裡離自己最近的一棟(夜襲目標)
function nearestStructure(buildings, pos) {
  let best = null;
  let bd = Infinity;
  for (const b of buildings.list) {
    const d = Math.hypot(b.x - pos.x, b.z - pos.z);
    if (d < bd) { bd = d; best = b; }
  }
  return best;
}

// 方塊人:鏽紅外套 + 紅頭巾,槍手背槍、頭目多一副護肩(遠遠就看得出來惹不起)
function buildRaiderMesh(def) {
  const g = new THREE.Group();
  const coat = new THREE.MeshLambertMaterial({ color: def.coat });
  const skin = new THREE.MeshLambertMaterial({ color: '#b8927a' });
  const dark = new THREE.MeshLambertMaterial({ color: '#2b2622' });
  const rag = new THREE.MeshLambertMaterial({ color: '#a83c2c' });
  const s = def.build;
  const box = (w, h, d, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  box(0.44 * s, 0.85, 0.32 * s, dark, 0, 0.43, 0);          // 褲子
  box(0.54 * s, 0.72, 0.34 * s, coat, 0, 1.21, 0);          // 外套
  box(0.3, 0.32, 0.3, skin, 0, 1.75, 0);                    // 頭
  box(0.33, 0.1, 0.33, rag, 0, 1.86, 0);                    // 紅頭巾
  box(0.13, 0.62, 0.13, coat, -0.33 * s, 1.25, 0.06);       // 手臂(略前伸,像端著東西)
  box(0.13, 0.62, 0.13, coat, 0.33 * s, 1.25, 0.06);
  if (def.ranged) box(0.06, 0.06, 0.75, dark, 0.3, 1.32, 0.3); // 背在身前的長槍
  else box(0.07, 0.5, 0.07, dark, 0.36, 1.05, 0.16);           // 手上的鐵棍
  if (def.boss) {
    box(0.74, 0.14, 0.4, rag, 0, 1.53, 0);   // 護肩
    box(0.1, 2.4, 0.1, dark, 0.9, 1.2, 0);   // 插在旁邊的旗桿
    box(0.06, 0.4, 0.6, rag, 0.94, 2.15, 0.3);
  }
  return { group: g, mats: [coat, skin, dark, rag] };
}

export class RaiderManager {
  constructor(scene) {
    this.scene = scene;
    this.list = [];
    this.camp = null;          // {x, z, cleared, crateLooted}
    this.campGroup = null;
    this.skills = null;        // main 掛上(🤞 談判)
    this.enemies = null;       // main 掛上(槍聲引怪)
    this.toast = null;
    this.onCampCleared = null; // main 掛上(聲望/XP/提示)
    this.rustRep = () => 0;    // main 掛上(讀鏽爪聲望)
    this.nextAmbushDay = AMBUSH_FIRST_DAY;
    this.ambushHour = 9 + Math.random() * 8;
    this.nextRaidDay = RAID_FIRST_DAY;
    this.buildCamp();
  }

  // ── 營地(規格 7.8「可攻打其營地」)──
  pickCampSpot() {
    const rng = mulberry32(31337);
    const barns = structureSpots.filter((s) => s.kind === 'barn');
    for (let i = 0; i < 400; i++) {
      const s = barns[Math.floor(rng() * barns.length)];
      if (!s) break;
      if (Math.hypot(s.x - SPAWN.x, s.z - SPAWN.z) < 150) continue; // 別擺在新手村門口
      const a = rng() * Math.PI * 2;
      const r = 16 + rng() * 8;
      const x = s.x + Math.cos(a) * r;
      const z = s.z + Math.sin(a) * r;
      if (isDeepWater(x, z) || insideAnyBox(x, z, 11) || insideNoSpawn(x, z, 11)) continue;
      return { x, z };
    }
    // 退路:鄉村/荒野隨便找一片遠處空地
    const half = TERRAIN_SIZE / 2 - 40;
    for (let i = 0; i < 600; i++) {
      const x = (rng() * 2 - 1) * half;
      const z = (rng() * 2 - 1) * half;
      const w = biomeWeights(x, z);
      if (w.urban > 0.3) continue;
      if (Math.hypot(x - SPAWN.x, z - SPAWN.z) < 150) continue;
      if (isDeepWater(x, z) || insideAnyBox(x, z, 11) || insideNoSpawn(x, z, 11)) continue;
      return { x, z };
    }
    return { x: SPAWN.x + 180, z: SPAWN.z + 180 };
  }

  buildCamp() {
    const spot = this.pickCampSpot();
    this.camp = { x: spot.x, z: spot.z, cleared: false, crateLooted: false };
    const rng = mulberry32(31338);
    const g = new THREE.Group();
    const canvasMat = new THREE.MeshLambertMaterial({ color: '#6b4a32' });
    const plankMat = new THREE.MeshLambertMaterial({ color: '#4e3b2c' });
    const crateMat = new THREE.MeshLambertMaterial({ color: '#7a6a3a' });
    const rustMat = new THREE.MeshLambertMaterial({ color: '#8a3a2a' });
    const y0 = terrainHeight(spot.x, spot.z);

    const addBox = (mesh, x, z, w, d) => {
      g.add(mesh);
      colliders.boxes.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
    };

    // 三頂帳篷(錐頂,擋視線也擋路)
    for (let i = 0; i < 3; i++) {
      const a = (i / 3) * Math.PI * 2 + 0.4;
      const x = spot.x + Math.cos(a) * 6.5;
      const z = spot.z + Math.sin(a) * 6.5;
      const tent = new THREE.Mesh(new THREE.ConeGeometry(2.1, 2.6, 4), canvasMat);
      tent.rotation.y = Math.PI / 4;
      tent.position.set(x, terrainHeight(x, z) + 1.3, z);
      tent.castShadow = true;
      addBox(tent, x, z, 2.6, 2.6);
    }

    // 外圍的木板路障:半開放的一圈,留缺口讓人走進去
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2;
      if (i === 2 || i === 7) continue; // 缺口
      const x = spot.x + Math.cos(a) * 11;
      const z = spot.z + Math.sin(a) * 11;
      if (isDeepWater(x, z)) continue;
      const w = new THREE.Mesh(new THREE.BoxGeometry(3.2, 1.5, 0.35), plankMat);
      w.position.set(x, terrainHeight(x, z) + 0.75, z);
      w.rotation.y = -a;
      w.castShadow = true;
      const uw = Math.abs(Math.cos(a)) > 0.5 ? 0.6 : 3.2;
      const ud = Math.abs(Math.cos(a)) > 0.5 ? 3.2 : 0.6;
      addBox(w, x, z, uw, ud);
    }

    // 中央火堆(純視覺)+ 旗桿
    const fire = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.3, 0.3, 8), plankMat);
    fire.position.set(spot.x, y0 + 0.15, spot.z);
    g.add(fire);
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.12, 4.2, 0.12), plankMat);
    pole.position.set(spot.x + 2.2, y0 + 2.1, spot.z);
    const flag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.8, 1.3), rustMat);
    flag.position.set(spot.x + 2.28, y0 + 3.5, spot.z + 0.65);
    g.add(pole, flag);

    // 補給箱:清空營地後可以搬走(互動走 findInteraction)
    const crate = new THREE.Mesh(new THREE.BoxGeometry(1.5, 1.1, 1.2), crateMat);
    const cx = spot.x - 3.4;
    const cz = spot.z + 1.6;
    crate.position.set(cx, terrainHeight(cx, cz) + 0.55, cz);
    crate.castShadow = true;
    addBox(crate, cx, cz, 1.6, 1.3);
    this.camp.crateX = cx;
    this.camp.crateZ = cz;

    this.campGroup = g;
    this.scene.add(g);

    // 守衛:圍著營火站一圈
    CAMP_GUARDS.forEach((type, i) => {
      const a = (i / CAMP_GUARDS.length) * Math.PI * 2 + 0.9;
      const r = type === 'boss' ? 2.6 : 4 + (i % 3);
      const x = spot.x + Math.cos(a) * r;
      const z = spot.z + Math.sin(a) * r;
      this.spawn(type, x, z, 'camp');
    });
  }

  spawn(type, x, z, mode = 'camp') {
    const r = new Raider(type, x, z, this, mode);
    this.list.push(r);
    this.scene.add(r.mesh);
    return r;
  }

  remove(r) {
    this.scene.remove(r.mesh);
    r.mesh.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  }

  // 同夥聞聲趕來
  alert(x, z, radius, lastKnown, now = 0) {
    for (const r of this.list) {
      if (!r.alive || r.state === 'chase' || r.state === 'flee') continue;
      if (Math.hypot(x - r.pos.x, z - r.pos.z) > radius) continue;
      r.state = 'chase';
      r.lastKnown = lastKnown ? { ...lastKnown } : { x, z };
      r.lastSeenTime = now;
    }
  }

  aliveCount(mode = null) {
    return this.list.reduce((n, r) => n + (r.alive && (!mode || r.mode === mode) ? 1 : 0), 0);
  }

  nearestChaserDist(pos) {
    let best = Infinity;
    for (const r of this.list) {
      if (!r.alive || r.state !== 'chase') continue;
      const d = Math.hypot(r.pos.x - pos.x, r.pos.z - pos.z);
      if (d < best) best = d;
    }
    return best;
  }

  // ── 伏擊(規格 7.8「會伏擊玩家」)──
  // 回傳生成數;0 = 沒觸發(時候未到/談判掉了/太靠近營地)
  maybeAmbush(timeSystem, playerPos, now) {
    if (timeSystem.day < this.nextAmbushDay) return 0;
    if (timeSystem.timeOfDay < this.ambushHour) return 0;
    if (this.camp && Math.hypot(playerPos.x - this.camp.x, playerPos.z - this.camp.z) < 90) return 0;
    this.rescheduleAmbush(timeSystem.day);

    // 聲望夠高就沒人動你;🤞 談判技能則是當場勸退
    if (this.rustRep() >= CALM_REP) {
      this.toast?.('☠️ 幾個鏽爪幫的人遠遠看了你一眼,轉身走了');
      return 0;
    }
    const calm = this.skills?.raiderCalmChance() ?? 0;
    if (calm > 0 && Math.random() < calm) {
      sfx.play('whistle');
      this.toast?.('🤞 你先開了口——他們罵了兩句,收起傢伙走了');
      return 0;
    }

    const count = Math.min(5, 2 + Math.floor(timeSystem.day / 6));
    const half = TERRAIN_SIZE / 2 - 5;
    let placed = 0;
    for (let tries = 0; tries < count * 14 && placed < count; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = 26 + Math.random() * 14;
      const x = THREE.MathUtils.clamp(playerPos.x + Math.cos(a) * r, -half, half);
      const z = THREE.MathUtils.clamp(playerPos.z + Math.sin(a) * r, -half, half);
      if (Math.hypot(x - playerPos.x, z - playerPos.z) < 20) continue;
      if (isDeepWater(x, z) || insideAnyBox(x, z, 1) || insideNoSpawn(x, z, 1)) continue;
      const type = placed === 0 || Math.random() < 0.35 ? 'gunner' : 'thug';
      const rd = this.spawn(type, x, z, 'ambush');
      rd.lastKnown = { x: playerPos.x, z: playerPos.z };
      rd.lastSeenTime = now;
      placed++;
    }
    if (placed) sfx.play('whistle');
    return placed;
  }

  rescheduleAmbush(day) {
    this.nextAmbushDay = day + 2 + Math.floor(Math.random() * 3);
    this.ambushHour = 8 + Math.random() * 10; // 掠奪者搶的是白天趕路的人
  }

  // ── 夜襲據點(規格 7.8「突襲據點」)──
  maybeRaid(timeSystem, playerPos, buildings, now) {
    if (timeSystem.day < this.nextRaidDay) return 0;
    const t = timeSystem.timeOfDay;
    if (t >= 5 && t < 21) return 0;              // 夜裡才來
    if (!buildings || buildings.list.length < 3) return 0; // 沒據點就沒得搶
    const base = buildings.respawnPoint() || buildings.list[0];
    if (Math.hypot(playerPos.x - base.x, playerPos.z - base.z) > 60) return 0; // 人不在家就不演了

    this.nextRaidDay = timeSystem.day + 4 + Math.floor(Math.random() * 5);
    if (this.rustRep() >= CALM_REP) return 0;

    const count = Math.min(6, 3 + Math.floor(timeSystem.day / 8));
    const half = TERRAIN_SIZE / 2 - 5;
    let placed = 0;
    for (let tries = 0; tries < count * 14 && placed < count; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = 32 + Math.random() * 12;
      const x = THREE.MathUtils.clamp(base.x + Math.cos(a) * r, -half, half);
      const z = THREE.MathUtils.clamp(base.z + Math.sin(a) * r, -half, half);
      if (isDeepWater(x, z) || insideAnyBox(x, z, 1) || insideNoSpawn(x, z, 1)) continue;
      const type = Math.random() < 0.3 ? 'gunner' : 'thug';
      const rd = this.spawn(type, x, z, 'raid');
      rd.state = 'raid';
      rd.lastSeenTime = now;
      placed++;
    }
    if (placed) sfx.play('whistle');
    return placed;
  }

  // 營地補給箱(清空守衛後才搬得走)
  findInteraction(pos) {
    const c = this.camp;
    if (c && !c.crateLooted && Math.hypot(pos.x - c.crateX, pos.z - c.crateZ) < 2.6) {
      return c.cleared
        ? { kind: 'raidcrate', label: '搬空鏽爪幫的補給箱' }
        : { kind: 'raidcrate', locked: true, label: '鏽爪幫補給箱(先解決守衛)' };
    }
    // 屍體:跟感染者共用 Interaction 的 corpse 分支
    let best = null;
    let bd = 2.6;
    for (const r of this.list) {
      if (!r.corpse || r.looted) continue;
      const d = Math.hypot(r.pos.x - pos.x, r.pos.z - pos.z);
      if (d < bd) { bd = d; best = r; }
    }
    if (best) return { kind: 'corpse', zombie: best, label: `搜刮屍體(${best.def.name})` };
    return null;
  }

  // 搬空補給箱的內容(一次性)
  lootCrate() {
    const c = this.camp;
    if (!c || c.crateLooted || !c.cleared) return null;
    c.crateLooted = true;
    const r = Math.random;
    return {
      caps: 60 + Math.floor(r() * 40),
      canned: 3 + Math.floor(r() * 3),
      bandage: 2, antibiotic: 1,
      ammo9: 10 + Math.floor(r() * 10),
      shell: 4 + Math.floor(r() * 4),
      scrap: 4, cloth: 3,
    };
  }

  update(dt, world) {
    // 遠處降頻(跟感染者同一套:130m 外每 0.35 秒走一步)
    const LOD2 = 130 * 130;
    const px = world.playerPos.x;
    const pz = world.playerPos.z;
    for (const r of this.list) {
      const dx = r.pos.x - px;
      const dz = r.pos.z - pz;
      r.lodDt += dt;
      if (dx * dx + dz * dz > LOD2 && r.lodDt < 0.35) continue;
      r.update(r.lodDt, world);
      r.lodDt = 0;
    }

    // 營地清空判定
    if (this.camp && !this.camp.cleared && this.aliveCount('camp') === 0) {
      this.camp.cleared = true;
      this.onCampCleared?.(this.camp);
    }

    // 屍體清理(搜刮完 30 秒、或放著 8 分鐘)
    const now = world.now;
    for (let i = this.list.length - 1; i >= 0; i--) {
      const r = this.list[i];
      if (!r.corpse) continue;
      if (r.looted && !r.lootedAt) r.lootedAt = now;
      if ((r.lootedAt && now - r.lootedAt > 30) || now - r.corpseAt > 480) {
        this.remove(r);
        this.list.splice(i, 1);
      }
    }
  }

  // ── 存讀檔 ──
  serialize() {
    return {
      camp: this.camp
        ? { cleared: this.camp.cleared ? 1 : 0, crate: this.camp.crateLooted ? 1 : 0 }
        : null,
      nextAmbushDay: this.nextAmbushDay,
      ambushHour: this.ambushHour,
      nextRaidDay: this.nextRaidDay,
      list: this.list.map((r) => ({
        t: r.type, x: r.pos.x, z: r.pos.z, hp: r.hp, alive: r.alive ? 1 : 0,
        mode: r.mode, hx: r.home.x, hz: r.home.z, facing: r.facing,
        looted: r.looted ? 1 : 0, loot: r.corpseLoot, arrows: r.stuckArrows,
      })),
    };
  }

  loadFrom(data) {
    if (!data) return; // 舊檔沒有鏽爪幫 = 維持初始營地
    for (const r of this.list) this.remove(r);
    this.list = [];
    if (this.camp && data.camp) {
      this.camp.cleared = !!data.camp.cleared;
      this.camp.crateLooted = !!data.camp.crate;
    }
    this.nextAmbushDay = data.nextAmbushDay ?? AMBUSH_FIRST_DAY;
    this.ambushHour = data.ambushHour ?? 12;
    this.nextRaidDay = data.nextRaidDay ?? RAID_FIRST_DAY;
    for (const s of data.list || []) {
      if (!RAIDER_TYPES[s.t]) continue;
      const r = this.spawn(s.t, s.x, s.z, s.mode || 'camp');
      r.home = { x: s.hx ?? s.x, z: s.hz ?? s.z };
      r.facing = s.facing || 0;
      if (s.alive) {
        r.hp = s.hp;
        r.state = r.mode === 'camp' ? 'guard' : r.mode === 'raid' ? 'raid' : 'chase';
      } else {
        r.die(0);
        r.corpseLoot = s.loot || {};
        r.looted = !!s.looted;
        r.stuckArrows = s.arrows || 0;
      }
    }
  }
}
