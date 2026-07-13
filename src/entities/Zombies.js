import * as THREE from '../lib/three.js';
import {
  TERRAIN_SIZE, AREA_SCALE, terrainHeight, biomeWeights, isDeepWater,
  resolveColliders, losBlocked, insideAnyBox, insideNoSpawn, SPAWN, mulberry32,
} from '../world/Terrain.js';
import { routeViaDoor } from '../world/Interiors.js';

// 感染者類型(規格 5.1/5.2 起步集:遊蕩者、奔跑者、感染犬)
const TYPES = {
  walker: {
    name: '遊蕩者', hp: 60, wanderSpeed: 0.5, chaseSpeed: 1.2,
    viewDist: 30, hearMult: 1.4, dmg: 10, attackRange: 1.6, dog: false,
    color: '#6a755c', xp: 12,
  },
  runner: {
    name: '奔跑者', hp: 45, wanderSpeed: 0.8, chaseSpeed: 3.3,
    viewDist: 45, hearMult: 1.0, dmg: 8, attackRange: 1.5, dog: false, scream: true,
    color: '#7a6a58', xp: 15,
  },
  dog: {
    name: '感染犬', hp: 35, wanderSpeed: 1.1, chaseSpeed: 3.55,
    viewDist: 38, hearMult: 1.6, dmg: 7, attackRange: 1.3, dog: true,
    color: '#524238', xp: 10,
  },
};

const VIEW_ANGLE = Math.PI * 0.39; // 約 70 度半角的視錐

let zombieId = 0;

class Zombie {
  constructor(type, x, z) {
    this.id = zombieId++;
    this.type = type;
    this.def = TYPES[type];
    this.hp = this.def.hp;
    this.alive = true;
    this.pos = new THREE.Vector3(x, terrainHeight(x, z), z);
    this.home = { x, z };
    this.facing = Math.random() * Math.PI * 2;

    // 狀態機:wander → investigate → chase → search → wander(規格 5.3)
    this.state = 'wander';
    this.target = null;        // {x,z} 目前移動目標
    this.stateTimer = 0;
    this.lastSeenTime = -99;
    this.lastKnown = null;     // 玩家最後已知位置
    this.attackCd = 0;
    this.senseTimer = Math.random() * 0.2; // 錯開感知檢查
    this.lodDt = 0; // 遠處降頻更新的累積時間(地圖擴大後省效能)
    this.screamed = false;
    this.bobPhase = Math.random() * 10;

    // 戰鬥(M6)
    this.staggerT = 0;         // 受擊硬直
    this.hitFlash = 0;         // 受擊紅閃
    this.corpse = false;       // 死亡後留屍體
    this.corpseAt = 0;         // 死亡時刻(屍體放久了會清掉)
    this.lootedAt = 0;         // 搜刮時刻(搜完一陣子消失)
    this.looted = false;
    this.stuckArrows = 0;      // 中箭數(搜屍可回收)
    this.corpseLoot = null;

    const built = buildMesh(this.def);
    this.mesh = built.group;
    this.mats = built.mats;
    this.mesh.position.copy(this.pos);
  }

  // 被玩家攻擊;回傳是否被擊殺
  takeDamage(dmg, fromPos, manager, now) {
    if (!this.alive) return false;
    this.hp -= dmg;
    this.hitFlash = 0.25;
    if (this.hp <= 0) {
      this.die(now);
      return true;
    }
    this.staggerT = 0.35; // 硬直
    this.lastKnown = { x: fromPos.x, z: fromPos.z };
    this.startChase(manager, now); // 挨打會反擊,並帶動附近同伴
    return false;
  }

  die(now = 0) {
    this.alive = false;
    this.corpse = true;
    this.corpseAt = now;
    this.corpseLoot = this.rollCorpseLoot();
    // 倒地姿勢
    this.mesh.rotation.set(0, this.facing, Math.PI / 2);
    this.mesh.position.set(
      this.pos.x,
      terrainHeight(this.pos.x, this.pos.z) + (this.def.dog ? 0.22 : 0.28),
      this.pos.z
    );
  }

  rollCorpseLoot() {
    const got = {};
    if (this.def.dog) {
      got.rawmeat = 1 + (Math.random() < 0.5 ? 1 : 0);
    } else {
      if (Math.random() < 0.45) got.cloth = 1;
      if (Math.random() < 0.35) got.scrap = 1;
      if (Math.random() < 0.10) got.ammo9 = 2 + Math.floor(Math.random() * 3);
    }
    return got;
  }

  // 視覺偵測:距離(夜晚+50%、蹲伏減半)+ 視錐角度 + 建築遮擋
  canSee(playerPos, crouching, night) {
    const dx = playerPos.x - this.pos.x;
    const dz = playerPos.z - this.pos.z;
    const dist = Math.hypot(dx, dz);
    let view = this.def.viewDist * (1 + 0.5 * night);
    if (crouching) view *= 0.5;
    if (dist > view) return false;
    const angTo = Math.atan2(dx, dz);
    let diff = Math.abs(angTo - this.facing) % (Math.PI * 2);
    if (diff > Math.PI) diff = Math.PI * 2 - diff;
    if (diff > VIEW_ANGLE && dist > 3) return false; // 貼身一定會被發現
    return !losBlocked(this.pos.x, this.pos.z, playerPos.x, playerPos.z);
  }

  hear(x, z, radius) {
    if (!this.alive || this.state === 'chase') return;
    const d = Math.hypot(x - this.pos.x, z - this.pos.z);
    if (d < radius * this.def.hearMult) {
      this.state = 'investigate';
      this.target = { x, z };
      this.stateTimer = 0;
    }
  }

  startChase(manager, now) {
    if (this.state !== 'chase') {
      this.state = 'chase';
      // 奔跑者尖叫呼喚同伴(規格 5.1);一般感染者也會帶動半徑 20m 內的同類(規格 5.3)
      const radius = this.def.scream && !this.screamed ? 40 : 20;
      if (this.def.scream) this.screamed = true;
      manager.alert(this.pos.x, this.pos.z, radius);
    }
    this.lastSeenTime = now;
  }

  update(dt, world) {
    // 受擊紅閃(屍體也要把顏色收尾)
    if (this.hitFlash > 0) {
      this.hitFlash = Math.max(0, this.hitFlash - dt);
      const e = this.hitFlash * 3;
      for (const m of this.mats) m.emissive.setRGB(e, e * 0.08, e * 0.05);
    }
    if (!this.alive) return;
    const { playerPos, crouching, playerAlive, night, manager, now } = world;
    this.attackCd = Math.max(0, this.attackCd - dt);
    this.stateTimer += dt;

    // 感知(每 0.15 秒一次,省效能)
    this.senseTimer -= dt;
    if (this.senseTimer <= 0 && playerAlive) {
      this.senseTimer = 0.15;
      if (this.canSee(playerPos, crouching, night)) {
        this.startChase(manager, now);
        this.lastKnown = { x: playerPos.x, z: playerPos.z };
      } else if (this.def.dog && this.state !== 'chase' && world.wounded) {
        // 嗅覺:玩家帶傷會留下血味,感染犬不用視線也能循味逼近(規格 5.3)
        const d = Math.hypot(playerPos.x - this.pos.x, playerPos.z - this.pos.z);
        if (d < 22 * (1 + 0.3 * night)) {
          this.state = 'investigate';
          this.target = { x: playerPos.x, z: playerPos.z };
          this.stateTimer = 0;
        }
      }
    }

    let speed = 0;
    let goal = null;

    if (this.state === 'wander') {
      if (!this.target || this.stateTimer > 4 + (this.id % 5)) {
        this.stateTimer = 0;
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 15;
        this.target = { x: this.home.x + Math.cos(a) * r, z: this.home.z + Math.sin(a) * r };
      }
      goal = this.target;
      speed = this.def.wanderSpeed * 0.6;
    } else if (this.state === 'investigate') {
      goal = this.target;
      speed = this.def.wanderSpeed * 1.6;
      const d = Math.hypot(goal.x - this.pos.x, goal.z - this.pos.z);
      if (d < 1.5) {
        // 到達聲源:張望一下就回去
        if (this.stateTimer > 5) { this.state = 'wander'; this.target = null; }
        speed = 0;
      } else {
        this.stateTimer = 0;
      }
    } else if (this.state === 'chase') {
      goal = this.lastKnown;
      speed = this.def.chaseSpeed * (1 + 0.3 * night); // 夜晚 +30%(規格 4.1)
      if (now - this.lastSeenTime > 6) {
        this.state = 'search';
        this.stateTimer = 0;
      }
      if (!playerAlive) { this.state = 'wander'; this.target = null; }
    } else if (this.state === 'search') {
      // 失去目標:在最後位置附近搜索 30 秒(規格 5.3)
      if (!this.target || this.stateTimer % 4 < dt) {
        const a = Math.random() * Math.PI * 2;
        this.target = {
          x: this.lastKnown.x + Math.cos(a) * 8,
          z: this.lastKnown.z + Math.sin(a) * 8,
        };
      }
      goal = this.target;
      speed = this.def.wanderSpeed * 1.4;
      if (this.stateTimer > 30) { this.state = 'wander'; this.target = null; }
    }

    // 受擊硬直:短暫定身
    this.staggerT = Math.max(0, this.staggerT - dt);
    if (this.staggerT > 0) speed = 0;

    // 攻擊
    if (this.state === 'chase' && playerAlive && this.staggerT <= 0) {
      const d = Math.hypot(playerPos.x - this.pos.x, playerPos.z - this.pos.z);
      if (d < this.def.attackRange) {
        speed = 0;
        if (this.attackCd <= 0) {
          this.attackCd = 1.3;
          world.onAttack(this.def.dmg, this.def.dog ? '被感染犬撕咬致死' : '被感染者咬死');
        }
      } else if (world.buildings && this.attackCd <= 0) {
        // 搆不到玩家又被建築擋住 → 拆牆(規格 7.2 據點襲擊)
        const blocked = world.buildings.blockingStructure(this.pos, goal, 0.75);
        if (blocked) {
          this.attackCd = 1.3;
          world.buildings.damage(blocked, this.def.dmg);
          this.lastSeenTime = now; // 拆牆期間不會放棄追擊
        }
      }
    }

    // 移動;目標隔著室內牆(一內一外)時先繞到那棟建築的門口(M8)
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
          this.target = null; // 撞到湖,換個目標
        }
      } else if (this.state === 'wander') {
        this.target = null;
      }
    }

    // 邊界與碰撞
    const half = TERRAIN_SIZE / 2 - 2;
    this.pos.x = THREE.MathUtils.clamp(this.pos.x, -half, half);
    this.pos.z = THREE.MathUtils.clamp(this.pos.z, -half, half);
    resolveColliders(this.pos, 0.35);
    this.pos.y = terrainHeight(this.pos.x, this.pos.z);

    // 套用到模型:朝向 + 移動搖晃 + 追擊時前傾
    this.mesh.position.copy(this.pos);
    this.mesh.rotation.y = this.facing;
    const bob = speed > 0 ? Math.sin(now * (4 + speed) + this.bobPhase) * 0.05 : 0;
    this.mesh.position.y += Math.abs(bob);
    this.mesh.rotation.x = this.state === 'chase' && !this.def.dog ? 0.18 : 0;
  }
}

function buildMesh(def) {
  const g = new THREE.Group();
  const mat = new THREE.MeshLambertMaterial({ color: def.color });
  const skin = new THREE.MeshLambertMaterial({ color: '#9aa08a' }); // 病態膚色
  if (def.dog) {
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.42, 1.05), mat);
    body.position.y = 0.5;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.4), skin);
    head.position.set(0, 0.68, 0.62);
    body.castShadow = head.castShadow = true;
    g.add(body, head);
  } else {
    const legs = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.85, 0.3), mat);
    legs.position.y = 0.43;
    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.7, 0.32), mat);
    torso.position.y = 1.2;
    const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.32, 0.3), skin);
    head.position.y = 1.75;
    // 前伸的手臂
    const armGeo = new THREE.BoxGeometry(0.13, 0.13, 0.6);
    const armL = new THREE.Mesh(armGeo, skin);
    armL.position.set(-0.22, 1.32, 0.35);
    const armR = new THREE.Mesh(armGeo, skin);
    armR.position.set(0.22, 1.32, 0.35);
    legs.castShadow = torso.castShadow = head.castShadow = true;
    g.add(legs, torso, head, armL, armR);
  }
  return { group: g, mats: [mat, skin] };
}

export class EnemyManager {
  constructor(scene) {
    this.scene = scene;
    this.zombies = [];
    this.noiseTimer = 0;
    const rng = mulberry32(55667);

    // 各區密度:城市高、鄉村中、荒野低(規格 4.1 風險梯度);總量隨地圖面積等比
    this.spawnGroup(rng, 'walker', 12 * AREA_SCALE, (w) => w.urban > 0.7);
    this.spawnGroup(rng, 'runner', 6 * AREA_SCALE, (w) => w.urban > 0.7);
    this.spawnGroup(rng, 'walker', 6 * AREA_SCALE, (w) => w.rural > 0.7);
    this.spawnGroup(rng, 'runner', 2 * AREA_SCALE, (w) => w.rural > 0.7);
    this.spawnGroup(rng, 'walker', 3 * AREA_SCALE, (w) => w.wild > 0.8);
    this.spawnGroup(rng, 'dog', 4 * AREA_SCALE, (w) => w.wild > 0.5 || w.rural > 0.5);

    // 屍潮夜襲排程(規格 7.2:每 3~7 天一波,第 3 天起)
    this.nextHordeDay = 3;
    this.hordeHour = 21.5;

    // 死後重生:維持初始人口,死一隻過陣子在遠處補一隻(M7.5)
    this.populationTarget = this.zombies.length;
    this.respawnTimer = 40;
  }

  // 在玩家視線外的遠處補生一隻(類型隨機,權重同屍潮)
  respawnOne(playerPos) {
    const half = TERRAIN_SIZE / 2 - 10;
    for (let tries = 0; tries < 40; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = 70 + Math.random() * 60;
      const x = THREE.MathUtils.clamp(playerPos.x + Math.cos(a) * r, -half, half);
      const z = THREE.MathUtils.clamp(playerPos.z + Math.sin(a) * r, -half, half);
      if (Math.hypot(x - playerPos.x, z - playerPos.z) < 55) continue; // clamp 可能被拉近
      if (isDeepWater(x, z) || insideAnyBox(x, z, 1) || insideNoSpawn(x, z, 1)) continue;
      const roll = Math.random();
      const type = roll < 0.65 ? 'walker' : roll < 0.9 ? 'runner' : 'dog';
      const zb = new Zombie(type, x, z);
      this.zombies.push(zb);
      this.scene.add(zb.mesh);
      return zb;
    }
    return null;
  }

  removeZombie(zb) {
    this.scene.remove(zb.mesh);
    zb.mesh.traverse((o) => { o.geometry?.dispose(); o.material?.dispose(); });
  }

  // 存讀檔(M7.5):活的存血量與巢點,屍體存搜刮狀態
  serialize() {
    return {
      nextHordeDay: this.nextHordeDay,
      hordeHour: this.hordeHour,
      zombies: this.zombies.map((zb) => ({
        type: zb.type, x: zb.pos.x, z: zb.pos.z, hp: zb.hp, facing: zb.facing,
        alive: zb.alive, homeX: zb.home.x, homeZ: zb.home.z,
        looted: zb.looted, loot: zb.corpseLoot, arrows: zb.stuckArrows,
      })),
    };
  }

  loadFrom(data) {
    for (const zb of this.zombies) this.removeZombie(zb);
    this.zombies = [];
    this.nextHordeDay = data.nextHordeDay ?? 3;
    this.hordeHour = data.hordeHour ?? 21.5;
    for (const s of data.zombies || []) {
      if (!TYPES[s.type]) continue;
      const zb = new Zombie(s.type, s.x, s.z);
      zb.home = { x: s.homeX, z: s.homeZ };
      zb.facing = s.facing || 0;
      if (s.alive) {
        zb.hp = s.hp;
      } else {
        zb.die(0);
        zb.corpseLoot = s.loot || {};
        zb.looted = !!s.looted;
        zb.stuckArrows = s.arrows || 0;
      }
      this.zombies.push(zb);
      this.scene.add(zb.mesh);
    }
  }

  // 屍潮夜襲:時候到了就在玩家周圍一圈生成追擊中的感染者,回傳生成數(0 = 沒觸發)
  maybeHorde(timeSystem, playerPos, now) {
    const t = timeSystem.timeOfDay;
    if (timeSystem.day < this.nextHordeDay) return 0;
    if (t >= 5 && t < this.hordeHour) return 0; // 等到當晚的襲擊時刻(凌晨也算夜)
    const count = Math.min(24, 4 + timeSystem.day * 2); // 規模隨天數成長(規格 7.11)
    const half = TERRAIN_SIZE / 2 - 5;
    let placed = 0;
    for (let tries = 0; tries < count * 12 && placed < count; tries++) {
      const a = Math.random() * Math.PI * 2;
      const r = 55 + Math.random() * 15;
      const x = THREE.MathUtils.clamp(playerPos.x + Math.cos(a) * r, -half, half);
      const z = THREE.MathUtils.clamp(playerPos.z + Math.sin(a) * r, -half, half);
      if (isDeepWater(x, z) || insideAnyBox(x, z, 1) || insideNoSpawn(x, z, 1)) continue;
      const roll = Math.random();
      const type = roll < 0.6 ? 'walker' : roll < 0.9 ? 'runner' : 'dog';
      const zb = new Zombie(type, x, z);
      zb.state = 'chase';
      zb.lastKnown = { x: playerPos.x, z: playerPos.z };
      zb.lastSeenTime = now;
      this.zombies.push(zb);
      this.scene.add(zb.mesh);
      placed++;
    }
    this.nextHordeDay = timeSystem.day + 3 + Math.floor(Math.random() * 5);
    this.hordeHour = 21 + Math.random() * 3;
    return placed;
  }

  // 床邊重生後讓所有感染者冷靜下來
  calmAll() {
    for (const zb of this.zombies) {
      if (!zb.alive) continue;
      zb.state = 'wander';
      zb.target = null;
      zb.screamed = false;
    }
  }

  spawnGroup(rng, type, count, biomeOk) {
    const half = TERRAIN_SIZE / 2 - 15;
    let placed = 0;
    for (let tries = 0; tries < 2000 && placed < count; tries++) {
      const x = (rng() * 2 - 1) * half;
      const z = (rng() * 2 - 1) * half;
      if (!biomeOk(biomeWeights(x, z))) continue;
      if (Math.hypot(x - SPAWN.x, z - SPAWN.z) < 45) continue; // 出生點附近淨空
      if (isDeepWater(x, z) || insideAnyBox(x, z, 1) || insideNoSpawn(x, z, 1)) continue;
      const zb = new Zombie(type, x, z);
      this.zombies.push(zb);
      this.scene.add(zb.mesh);
      placed++;
    }
  }

  // 噪音事件:半徑內的感染者前來調查(規格 5.3 聽覺)
  hearNoise(x, z, radius, night) {
    const r = radius * (1 + 0.5 * night); // 夜晚偵測 +50%
    for (const zb of this.zombies) zb.hear(x, z, r);
  }

  // 警戒擴散:附近同類加入追擊(規格 5.3 群體行為)
  alert(x, z, radius) {
    for (const zb of this.zombies) {
      if (!zb.alive || zb.state === 'chase') continue;
      if (Math.hypot(x - zb.pos.x, z - zb.pos.z) < radius) {
        zb.state = 'chase';
        zb.lastSeenTime = this._now || 0;
        zb.lastKnown = { x, z };
      }
    }
  }

  update(dt, player, stats, night, now, buildings = null) {
    this._now = now;
    // 玩家腳步聲(每 0.4 秒發出一次)
    this.noiseTimer -= dt;
    if (this.noiseTimer <= 0 && stats.alive) {
      this.noiseTimer = 0.4;
      const r = player.noiseRadius;
      if (r > 0) this.hearNoise(player.position.x, player.position.z, r, night);
    }

    const world = {
      playerPos: player.position,
      crouching: player.crouching,
      playerAlive: stats.alive,
      wounded: stats.alive && stats.hp < 60, // 帶傷 = 有血味,感染犬嗅覺用
      night,
      manager: this,
      now,
      buildings,
      onAttack: (dmg, cause) => stats.applyBite(dmg, cause), // 傷害 + 感染判定(M6)
    };
    // 降頻更新:遠處(玩家 130m 外,霧裡幾乎看不到)的感染者每 0.35 秒才走一步,
    // 地圖/數量放大 4 倍後,全速更新的只剩玩家身邊那圈
    const LOD_DIST2 = 130 * 130;
    const px = player.position.x, pz = player.position.z;
    for (const zb of this.zombies) {
      const ddx = zb.pos.x - px, ddz = zb.pos.z - pz;
      zb.lodDt += dt;
      if (ddx * ddx + ddz * ddz > LOD_DIST2 && zb.lodDt < 0.35) continue;
      zb.update(zb.lodDt, world);
      zb.lodDt = 0;
    }

    // 死後重生:低於初始人口就在遠處補生;夜晚刷新加倍(規格 4.1)
    this.respawnTimer -= dt;
    if (this.respawnTimer <= 0) {
      this.respawnTimer = night > 0.5 ? 20 : 40;
      const aliveN = this.zombies.reduce((n, z) => n + (z.alive ? 1 : 0), 0);
      if (aliveN < this.populationTarget) this.respawnOne(player.position);
    }

    // 屍體清理:搜刮完 20 秒、或放著 5 分鐘後消失
    for (let i = this.zombies.length - 1; i >= 0; i--) {
      const zb = this.zombies[i];
      if (!zb.corpse) continue;
      if (zb.looted && !zb.lootedAt) zb.lootedAt = now;
      if ((zb.lootedAt && now - zb.lootedAt > 20) || now - zb.corpseAt > 300) {
        this.removeZombie(zb);
        this.zombies.splice(i, 1);
      }
    }

    // 木刺牆:踩進去持續扣血,尖刺本身也會磨損(規格 6.6)
    if (buildings) {
      for (const zb of this.zombies) {
        if (!zb.alive) continue;
        const sp = buildings.spikesAt(zb.pos);
        if (sp) {
          zb.hp -= 10 * dt;
          zb.hitFlash = Math.max(zb.hitFlash, 0.12);
          if (zb.hp <= 0) zb.die(now);
          buildings.damage(sp, 1.5 * dt);
        }
      }
    }
  }

  // 最近的追擊中感染者距離(HUD 警示用)
  nearestChaserDist(playerPos) {
    let best = Infinity;
    for (const zb of this.zombies) {
      if (!zb.alive || zb.state !== 'chase') continue;
      const d = Math.hypot(zb.pos.x - playerPos.x, zb.pos.z - playerPos.z);
      if (d < best) best = d;
    }
    return best;
  }
}
