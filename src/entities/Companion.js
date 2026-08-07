// 招募與同伴(M8f-2,規格 7.8「倖存者可救援並招募回據點,各有專長,會自動工作、防守,也要吃喝」)
//
// 招募條件:先完成那個倖存者的個人任務(systems/Quests.js 的 unlockRecruit),
// 同伴上限 = 1 + 領袖魅力等級(規格 7.7 社交分支)。
// 同伴接管原本 NPC 的 mesh(npc.recruited = true,NpcManager 就不再理他),解散時放回世界。
//
// 兩種狀態:
//   follow 跟著你走、幫你打、依專長給被動
//   guard  留在原地看家,每隔一段遊戲時間依專長產出物資,存在自己的背包等你來收

import * as THREE from '../lib/three.js';
import { terrainHeight, insideAnyBox, colliders } from '../world/Terrain.js';
import { Inventory, ITEMS } from '../player/Items.js';
import { sfx } from '../core/Sound.js';

// 專長(規格 7.8:醫生/農夫/槍匠/斥候)
export const ROLES = {
  medic: {
    name: '醫護', icon: '🩺', dmg: 8, speed: 1,
    work: { bandage: 1, cloth: 1 },
    perk: '跟隨時會在你受傷後替你包紮(+12 HP)',
  },
  farmer: {
    name: '農夫', icon: '🌾', dmg: 6, speed: 1,
    work: { berry: 3, rawmeat: 1 },
    perk: '駐守時會種菜打獵,產出食物',
  },
  gunsmith: {
    name: '槍匠', icon: '🔧', dmg: 17, speed: 0.95,
    work: { arrow: 3, ammo9: 2, scrap: 1 },
    perk: '打起來最凶,駐守時做箭與彈藥',
  },
  scout: {
    name: '斥候', icon: '🧭', dmg: 11, speed: 1.3,
    work: { wood: 2, cloth: 1, caps: 5 },
    perk: '腳程最快,駐守時外出搜刮',
  },
};

export const ROLE_IDS = Object.keys(ROLES);

const HP_MAX = 80;
const FOOD_PER_HOUR = 3.5;   // 每遊戲小時掉的飽食
const STARVE_HP_PER_HOUR = 6; // 餓到 0 之後每遊戲小時扣的血
const WORK_HOURS = 2;         // 駐守每 2 遊戲小時產一次物資
const FOLLOW_DIST = 3.2;      // 跟隨保持的距離
const TELEPORT_DIST = 26;     // 掉隊太遠就直接追上(免得卡在牆後)
const ENGAGE_DIST = 13;       // 主動接戰距離
const ATTACK_RANGE = 1.7;

// 走一步,撞到建築就試著沿單軸滑過去(同伴不做完整碰撞解算,夠用就好)
const blocked = (x, z) => insideAnyBox(x, z, 0.35);

export class Companion {
  constructor(npc, npcIdx, role) {
    this.npc = npc;
    this.npcIdx = npcIdx;   // 存讀檔靠這個對回 NpcManager.npcs 的索引
    this.role = ROLES[role] ? role : 'scout';
    this.def = ROLES[this.role];
    this.name = npc.def.name;
    this.x = npc.x;
    this.z = npc.z;
    this.facing = npc.facing;
    this.hp = HP_MAX;
    this.hpMax = HP_MAX;
    this.food = 100;
    this.mode = 'follow';   // 'follow' | 'guard'
    this.bag = new Inventory();
    this.attackCd = 0;
    this.hurtCd = 0;
    this.workT = 0;
    this.healT = 0;
    this.alive = true;
    this.mesh = npc.mesh;   // 接管 NPC 本體
  }

  get pos() { return { x: this.x, z: this.z }; }

  hungry() { return this.food < 25; }

  // 最近的威脅:感染者與掠奪者一起看,優先追擊中的,其次是路過的
  nearestThreat(enemies, raiders = null) {
    let best = null;
    const bd = ENGAGE_DIST;
    const lists = [enemies?.zombies ?? [], raiders?.list ?? []];
    for (const list of lists) {
      for (const zb of list) {
        if (!zb.alive) continue;
        const d = Math.hypot(zb.pos.x - this.x, zb.pos.z - this.z);
        if (d > bd) continue;
        // 追擊中的敵人優先(距離打七折當作權重)
        const w = zb.state === 'chase' ? d * 0.7 : d;
        if (!best || w < best.w) best = { zb, d, w };
      }
    }
    return best;
  }

  moveTo(tx, tz, speed, dt) {
    const dx = tx - this.x;
    const dz = tz - this.z;
    const d = Math.hypot(dx, dz);
    if (d < 0.12) return;
    const step = Math.min(speed * dt, d);
    const nx = this.x + (dx / d) * step;
    const nz = this.z + (dz / d) * step;
    if (!blocked(nx, nz)) { this.x = nx; this.z = nz; }
    else if (!blocked(nx, this.z)) this.x = nx;
    else if (!blocked(this.x, nz)) this.z = nz;
    this.facing = Math.atan2(dx, dz);
  }

  // ctx: {playerPos, playerStats, enemies, raiders, now, gh(這一幀的遊戲小時), toast, onKill}
  update(dt, ctx) {
    if (!this.alive) return;
    const { playerPos, enemies, now, gh } = ctx;
    this.attackCd = Math.max(0, this.attackCd - dt);
    this.hurtCd = Math.max(0, this.hurtCd - dt);

    // 吃喝(規格 7.8:同伴也要吃,增加後勤壓力)
    const before = this.food;
    this.food = Math.max(0, this.food - FOOD_PER_HOUR * gh);
    if (before >= 25 && this.food < 25) ctx.toast?.(`${this.def.icon} ${this.name}餓了——按 E 餵他點東西`);
    if (this.food <= 0) {
      this.hp -= STARVE_HP_PER_HOUR * gh;
      if (this.hp <= 0) return this.die(ctx, `${this.name}餓死了`);
    }

    // 戰鬥:附近有感染者/掠奪者就迎上去打(規格 7.8「會自動防守」)
    const threat = enemies || ctx.raiders ? this.nearestThreat(enemies, ctx.raiders) : null;
    if (threat) {
      if (threat.d > ATTACK_RANGE) {
        this.moveTo(threat.zb.pos.x, threat.zb.pos.z, 3.4 * this.def.speed, dt);
      } else if (this.attackCd <= 0) {
        this.attackCd = 1.1;
        this.facing = Math.atan2(threat.zb.pos.x - this.x, threat.zb.pos.z - this.z);
        sfx.play3d('swing', this.x, this.z, { vol: 0.6 });
        const killed = threat.zb.takeDamage(this.def.dmg, this.pos, enemies, now);
        sfx.play3d('hitFlesh', this.x, this.z, { vol: 0.7 });
        if (killed) ctx.onKill?.(threat.zb, this);
      }
      // 貼身纏鬥會挨咬(掠奪者的傷害由他們自己的攻擊迴圈算,不在這裡重複扣)
      if (!threat.zb.isRaider && threat.d < 1.9 && this.hurtCd <= 0) {
        this.hurtCd = 1.5;
        this.hp -= threat.zb.def.dmg;
        sfx.play3d('hurt', this.x, this.z, { vol: 0.7 });
        if (this.hp <= 0) return this.die(ctx, `${this.name}被${threat.zb.def.name}咬死了`);
      }
    } else if (this.mode === 'follow') {
      const d = Math.hypot(playerPos.x - this.x, playerPos.z - this.z);
      if (d > TELEPORT_DIST) {
        // 掉隊太遠(卡在牆後/被留在室內):直接出現在你身後,別讓玩家倒回去找人
        this.x = playerPos.x - Math.sin(this.facing) * 2;
        this.z = playerPos.z - Math.cos(this.facing) * 2;
      } else if (d > FOLLOW_DIST) {
        const run = d > 8 ? 4.6 : 3.1;
        this.moveTo(playerPos.x, playerPos.z, run * this.def.speed, dt);
      } else {
        this.facing = Math.atan2(playerPos.x - this.x, playerPos.z - this.z);
      }
      // 🩺 醫護跟隨被動:你掛彩了就替你包紮
      if (this.role === 'medic' && this.food > 0) {
        this.healT += gh;
        if (this.healT > 0.5) {
          this.healT = 0;
          const st = ctx.playerStats;
          if (st && st.alive && st.hp < 70 && d < 12) {
            st.hp = Math.min(100, st.hp + 12);
            sfx.play('bandage');
            ctx.toast?.(`${this.def.icon} ${this.name}替你包紮了傷口(+12 HP)`);
          }
        }
      }
    } else {
      // 駐守:留在原地工作(規格 7.8「回據點工作」)
      this.workT += gh;
      if (this.workT >= WORK_HOURS) {
        this.workT = 0;
        if (this.food > 0) {
          const ids = Object.keys(this.def.work);
          const id = ids[Math.floor(Math.random() * ids.length)];
          const n = 1 + Math.floor(Math.random() * this.def.work[id]);
          this.bag.add(id, n);
        }
      }
    }

    this.syncMesh();
  }

  syncMesh() {
    this.mesh.position.set(this.x, terrainHeight(this.x, this.z), this.z);
    this.mesh.rotation.y = this.facing;
  }

  die(ctx, cause) {
    this.alive = false;
    this.hp = 0;
    sfx.play3d('zdie', this.x, this.z, { vol: 0.7 });
    ctx.toast?.(`☠ ${cause}`);
    ctx.onDeath?.(this);
  }

  // 餵食:吃的東西照 ITEMS 的回復量換算成飽食
  feed(id, inv) {
    if (inv.count(id) <= 0) return { msg: '你身上沒有這個' };
    const gain = FEED_VALUE[id];
    if (!gain) return { msg: `${this.name}不吃這個` };
    inv.remove(id, 1);
    this.food = Math.min(100, this.food + gain);
    if (FEED_HEAL[id]) this.hp = Math.min(this.hpMax, this.hp + FEED_HEAL[id]);
    return { msg: `${this.name}吃了${ITEMS[id].name}(飽食 ${Math.round(this.food)}%)`, fed: true };
  }

  // 收取駐守產出
  collectBag(inv) {
    const parts = [];
    for (const [id, n] of [...this.bag.items.entries()]) {
      inv.add(id, n);
      parts.push(`${ITEMS[id].name}×${n}`);
    }
    this.bag.items.clear();
    return parts.length ? `收下 ${parts.join('、')}` : `${this.name}還沒攢到東西`;
  }

  statusText() {
    const mode = this.mode === 'follow' ? '跟隨中' : '駐守中';
    const food = this.food < 25 ? `<span style="color:#c84a3c">飢餓 ${Math.round(this.food)}%</span>` : `飽食 ${Math.round(this.food)}%`;
    return `${this.def.icon} ${this.name}(${this.def.name}) · ${mode} · ❤${Math.round(this.hp)}/${this.hpMax} · ${food}`;
  }
}

// 能餵的東西 → 飽食回復量(生肉照樣能吃,同伴不挑;水類補得少但有用)
export const FEED_VALUE = {
  berry: 10, canned: 35, cooked: 40, rawmeat: 18,
  bottled: 12, boiled: 12, dirty: 6,
};
const FEED_HEAL = { cooked: 6, canned: 3, bandage: 0 };

export class CompanionManager {
  constructor(scene) {
    this.scene = scene;
    this.list = [];
    this.skills = null;  // main 掛上(領袖魅力 = 同伴上限)
    this.toast = null;
  }

  maxCount() { return this.skills?.partyMax() ?? 1; }

  canRecruit() { return this.list.length < this.maxCount(); }

  // npc 必須是已解鎖招募的倖存者;成功回傳 Companion
  recruit(npc, npcIdx) {
    if (!this.canRecruit()) return null;
    npc.recruited = true;
    // 站著的 NPC 有一顆碰撞圓,跟著走的同伴不擋路(不然會把你卡在牆角)
    const i = colliders.circles.indexOf(npc.collider);
    if (i >= 0) colliders.circles.splice(i, 1);
    const c = new Companion(npc, npcIdx, npc.role);
    this.list.push(c);
    return c;
  }

  // 解散:放回目前站的位置,變回可交談的 NPC
  dismiss(c) {
    const i = this.list.indexOf(c);
    if (i >= 0) this.list.splice(i, 1);
    const npc = c.npc;
    npc.recruited = false;
    npc.x = c.x;
    npc.z = c.z;
    npc.facing = c.facing;
    npc.collider = { x: c.x, z: c.z, r: 0.45, tree: false };
    colliders.circles.push(npc.collider);
    npc.mesh.position.set(c.x, terrainHeight(c.x, c.z), c.z);
    return `${c.name}留在了這裡`;
  }

  // 死亡:移除本體,那個 NPC 就永遠不在了
  removeDead(c) {
    const i = this.list.indexOf(c);
    if (i >= 0) this.list.splice(i, 1);
    this.scene.remove(c.mesh);
    c.npc.dead = true;
  }

  update(dt, ctx) {
    for (const c of [...this.list]) {
      c.update(dt, { ...ctx, onDeath: (dead) => this.removeDead(dead) });
    }
  }

  findInteraction(pos) {
    let best = null;
    let bd = 2.8;
    for (const c of this.list) {
      const d = Math.hypot(c.x - pos.x, c.z - pos.z);
      if (d < bd) { bd = d; best = c; }
    }
    if (!best) return null;
    return { kind: 'companion', comp: best, label: `對${best.name}下指令` };
  }

  // 存讀檔:靠 npcIdx 對回 NpcManager.npcs(生成順序固定)
  serialize() {
    return this.list.map((c) => ({
      i: c.npcIdx, role: c.role, hp: c.hp, food: c.food, mode: c.mode,
      x: c.x, z: c.z, bag: [...c.bag.items.entries()],
    }));
  }

  loadFrom(data, npcs) {
    for (const c of this.list) this.scene.remove(c.mesh);
    this.list = [];
    if (!data || !npcs) return; // 舊檔沒有同伴
    for (const s of data) {
      const npc = npcs.npcs[s.i];
      if (!npc) continue;
      npc.role = s.role || npc.role;
      const c = this.recruit(npc, s.i);
      if (!c) continue;
      c.hp = s.hp ?? c.hp;
      c.food = s.food ?? c.food;
      c.mode = s.mode === 'guard' ? 'guard' : 'follow';
      c.x = s.x;
      c.z = s.z;
      c.bag.items = new Map(s.bag || []);
      c.syncMesh();
      this.scene.add(c.mesh); // NpcManager.loadFrom 不會動 mesh,補一次保險
    }
  }
}
