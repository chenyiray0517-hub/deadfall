import * as THREE from '../lib/three.js';
import { ITEMS } from '../player/Items.js';
import { losBlocked, colliders } from '../world/Terrain.js';

// 玩家戰鬥(M6):近戰揮擊/遠程射擊、近戰耐久、槍聲噪音、第一人稱武器模型
// 命中判定不用 raycast 物件求交:近戰是面前扇形取最近,遠程是視線射線對感染者圓柱心的最近距離
export class Combat {
  constructor({ camera, player, stats, inventory, enemies, toast, isNight, onHit, skills, models }) {
    this.player = player;
    this.stats = stats;
    this.inventory = inventory;
    this.enemies = enemies;
    this.toast = toast;
    this.isNight = isNight;
    this.onHit = onHit || (() => {});
    this.skills = skills || null; // 技能加成(近戰/遠程傷害、箭回收率)
    this.models = models || {};   // 物品 GLB 模型(木棒/消防斧,沒有就退回方塊拼裝)

    this.equipped = null;   // 目前手持武器 id
    this.cd = 0;            // 攻擊冷卻
    this.dur = new Map();   // 近戰耐久(依武器 id 持續累計,壞了歸零重來)

    // 第一人稱武器模型(掛在相機上;main 需 scene.add(camera))
    this.viewmodel = new THREE.Group();
    camera.add(this.viewmodel);
    this.muzzle = new THREE.PointLight('#ffc27a', 0, 10);
    this.muzzle.position.set(0.28, -0.15, -0.9);
    camera.add(this.muzzle);
    this.animKind = null;
    this.animT = 0;
    this.animDur = 0.25;
  }

  // 數字鍵:裝備/收起
  equip(id) {
    if (!ITEMS[id]?.weapon || this.inventory.count(id) <= 0) return;
    this.equipped = this.equipped === id ? null : id;
    this.buildViewmodel();
  }

  durabilityOf(id) {
    return this.dur.get(id) ?? ITEMS[id].dur;
  }

  // HUD 右下角文字
  hudText() {
    if (!this.equipped) return '';
    const def = ITEMS[this.equipped];
    if (def.weapon === 'melee') {
      return `${def.icon} ${def.name}　耐久 ${this.durabilityOf(this.equipped)}/${def.dur}`;
    }
    const a = ITEMS[def.ammo];
    return `${def.icon} ${def.name}　${a.icon} ${a.name} ×${this.inventory.count(def.ammo)}`;
  }

  // 視角方向(與 Player 的 YXZ 尤拉角一致)
  aimDir() {
    const { yaw, pitch } = this.player;
    const cp = Math.cos(pitch);
    return new THREE.Vector3(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
  }

  tryAttack(now) {
    if (this.cd > 0 || !this.equipped || !this.stats.alive) return;
    const def = ITEMS[this.equipped];
    if (def.weapon === 'melee') this.melee(def, now);
    else this.shoot(def, now);
  }

  melee(def, now) {
    const stam = Math.round(def.stam * (this.skills?.meleeStamMult() ?? 1)); // 🗡 近戰熟練省體力
    if (!this.stats.trySpendStamina(stam)) {
      this.toast('喘不過氣,揮不動了');
      return;
    }
    this.cd = def.cd;
    this.startAnim('swing');
    const p = this.player.position;
    if (def.noise) this.enemies.hearNoise(p.x, p.z, def.noise, this.isNight());

    // 面前扇形內最近的感染者
    const fx = -Math.sin(this.player.yaw);
    const fz = -Math.cos(this.player.yaw);
    let best = null;
    let bestD = def.range + 0.35;
    for (const zb of this.enemies.zombies) {
      if (!zb.alive) continue;
      const dx = zb.pos.x - p.x;
      const dz = zb.pos.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > bestD || d < 0.01) continue;
      if ((dx * fx + dz * fz) / d < 0.6) continue; // 約 ±53 度
      best = zb;
      bestD = d;
    }
    if (!best) {
      // 揮空:斧頭(自製斧/消防斧)可以砍樹取木柴(規格 6.4/6.7 砍樹兼用)
      if ((this.equipped === 'axe' || this.equipped === 'handaxe') && this.chopTree(p, fx, fz)) this.wearMelee(def);
      return;
    }
    const dmg = Math.round(def.dmg * (this.skills?.meleeMult() ?? 1)); // 🪓 近戰專精
    const killed = best.takeDamage(dmg, p, this.enemies, now);
    this.skills?.addProf('melee', 1); // 打中才算熟練(規格 7.7 用進廢退)
    this.onHit(killed, best);
    this.wearMelee(def);
  }

  // 面前有樹(碰撞圓)就砍下木柴
  chopTree(p, fx, fz) {
    for (const c of colliders.circles) {
      const dx = c.x - p.x;
      const dz = c.z - p.z;
      const d = Math.hypot(dx, dz);
      if (d > 2.8 || d < 0.01) continue;
      if ((dx * fx + dz * fz) / d < 0.5) continue;
      this.inventory.add('wood', 2);
      this.toast('🪓 砍下木柴 ×2');
      return true;
    }
    return false;
  }

  // 近戰耐久:打中東西才磨損
  wearMelee(def) {
    const left = this.durabilityOf(this.equipped) - 1;
    if (left <= 0) {
      this.inventory.remove(this.equipped, 1);
      this.dur.delete(this.equipped);
      this.toast(`${def.name} 壞掉了!`);
      this.equipped = null;
      this.buildViewmodel();
    } else {
      this.dur.set(this.equipped, left);
    }
  }

  shoot(def, now) {
    if (this.inventory.count(def.ammo) <= 0) {
      this.toast(`沒有${ITEMS[def.ammo].name}了`);
      return;
    }
    if (def.stam && !this.stats.trySpendStamina(def.stam)) {
      this.toast('太喘了,拉不開弓');
      return;
    }
    this.inventory.remove(def.ammo, 1);
    const isGun = def.ammo !== 'arrow';
    // 🔫 槍械熟練:冷卻縮短(規格「後座力下降」的等效);開槍就算用量,弓不算
    this.cd = isGun ? def.cd * (this.skills?.gunCdMult() ?? 1) : def.cd;
    if (isGun) this.skills?.addProf('gun', 1);
    this.startAnim('shoot');
    const p = this.player.position;
    if (def.noise) {
      this.enemies.hearNoise(p.x, p.z, def.noise, this.isNight()); // 槍聲引怪(規格 5.3)
      this.muzzle.intensity = 4; // 槍口火光
    }

    // 射線 vs 感染者(取最近命中)
    const origin = new THREE.Vector3(p.x, p.y + this.player.eyeHeight, p.z);
    const dir = this.aimDir();
    let best = null;
    let bestT = def.range;
    for (const zb of this.enemies.zombies) {
      if (!zb.alive) continue;
      const cy = zb.pos.y + (zb.def.dog ? 0.45 : 1.1); // 胸口/軀幹中心
      const vx = zb.pos.x - origin.x;
      const vy = cy - origin.y;
      const vz = zb.pos.z - origin.z;
      const t = vx * dir.x + vy * dir.y + vz * dir.z;
      if (t < 0.5 || t > bestT) continue;
      const ox = vx - t * dir.x;
      const oy = vy - t * dir.y;
      const oz = vz - t * dir.z;
      if (ox * ox + oy * oy + oz * oz > 0.55 * 0.55) continue;
      if (losBlocked(origin.x, origin.z, zb.pos.x, zb.pos.z)) continue;
      best = zb;
      bestT = t;
    }
    if (!best) return;

    let dmg = def.dmg;
    if (def.falloff && bestT > 6) {
      dmg = Math.max(def.dmg * 0.25, def.dmg * (1 - (bestT - 6) / 20)); // 霰彈距離衰減
    }
    dmg = Math.round(dmg * (this.skills?.rangedMult() ?? 1)); // 🎯 神射手
    if (def.ammo === 'arrow' && Math.random() < (this.skills?.arrowRecover() ?? 0.6)) {
      best.stuckArrows += 1; // 箭插在身上,搜屍可回收(規格 6.5;神射手 Lv2 提高到 90%)
    }
    const killed = best.takeDamage(dmg, p, this.enemies, now);
    this.onHit(killed, best);
  }

  startAnim(kind) {
    this.animKind = kind;
    this.animT = 0;
  }

  buildViewmodel() {
    const g = this.viewmodel;
    while (g.children.length) {
      const c = g.children.pop();
      c.traverse((o) => {
        if (o.userData.shared) return; // GLB 模型的幾何/貼圖是共用的,不能 dispose
        o.geometry?.dispose();
        o.material?.dispose();
      });
    }
    g.rotation.set(0, 0, 0);
    g.position.set(0, 0, 0);
    if (!this.equipped) return;

    const box = (w, h, d, color) =>
      new THREE.Mesh(new THREE.BoxGeometry(w, h, d), new THREE.MeshLambertMaterial({ color }));
    const grip = new THREE.Group();
    grip.position.set(0.32, -0.28, -0.5); // 右下持握位

    const def = ITEMS[this.equipped];
    const glb = this.models[this.equipped];
    if (def.weapon === 'melee' && glb) {
      // GLB 手持模型(Euler XYZ:先轉 y 對齊長軸到 z,再 x 斜握;pos 是斜握後的局部位移)
      const pose = {
        bat: { scale: 0.8, rot: [0.5, Math.PI, 0], pos: [0, 0.08, -0.1] },   // 長軸在 z,翻 180° 讓粗頭朝上前方
        axe: { scale: 0.95, rot: [-0.5, Math.PI / 2, 0], pos: [0, -0.02, -0.2] }, // 長軸在 x
      }[this.equipped];
      const mesh = new THREE.Mesh(glb.geometry, glb.material);
      mesh.userData.shared = true;
      mesh.scale.setScalar(pose.scale);
      mesh.rotation.set(...pose.rot);
      mesh.position.set(...pose.pos);
      grip.add(mesh);
    } else if (def.weapon === 'melee') {
      const handle = box(0.055, 0.055, 0.6, this.equipped === 'pipe' ? '#7d838a' : '#7a5a38');
      handle.rotation.x = -0.5; // 斜握
      handle.position.set(0, 0.05, -0.15);
      grip.add(handle);
      if (this.equipped === 'axe' || this.equipped === 'handaxe') {
        const head = box(0.04, 0.2, 0.14, this.equipped === 'axe' ? '#8a2f28' : '#6e6a63');
        head.rotation.x = -0.5;
        head.position.set(0, 0.24, -0.36);
        grip.add(head);
      }
    } else if (this.equipped === 'bow') {
      const limb = box(0.035, 0.85, 0.035, '#6a4c30');
      limb.position.set(0, 0, -0.2);
      grip.add(limb);
    } else {
      const len = this.equipped === 'shotgun' ? 0.62 : 0.3;
      const barrel = box(0.05, 0.06, len, '#3a3d40');
      barrel.position.set(0, 0.02, -len / 2);
      const handGrip = box(0.045, 0.16, 0.06, this.equipped === 'shotgun' ? '#5a4128' : '#2c2e31');
      handGrip.position.set(0, -0.1, 0.02);
      grip.add(barrel, handGrip);
    }
    g.add(grip);
  }

  update(dt) {
    this.cd = Math.max(0, this.cd - dt);
    this.muzzle.intensity = Math.max(0, this.muzzle.intensity - dt * 45);

    // 揮擊/後座動畫
    if (this.animKind) {
      this.animT += dt;
      const k = Math.min(1, this.animT / this.animDur);
      const s = Math.sin(k * Math.PI);
      if (this.animKind === 'swing') {
        this.viewmodel.rotation.x = -1.2 * s;
        this.viewmodel.rotation.z = -0.25 * s;
      } else {
        this.viewmodel.position.z = 0.09 * s;
        this.viewmodel.rotation.x = 0.22 * s;
      }
      if (k >= 1) {
        this.animKind = null;
        this.viewmodel.rotation.set(0, 0, 0);
        this.viewmodel.position.set(0, 0, 0);
      }
    }
  }
}
