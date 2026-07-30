// NPC、陣營與交易(M8f-1,規格 7.8)
// 這一段做:NPC 實體與對話、方舟聚落商人 + 瓶蓋貨幣、三陣營聲望
// 招募/任務(7.8 後半、7.9)在 M8f-2,鏽爪幫伏擊與主線在 M8f-3
//
// UI 全在 main.js(共用 #panel);這裡只出資料與結果訊息,方便 headless 邏輯測試

import * as THREE from '../lib/three.js';
import {
  terrainHeight, biomeWeights, colliders, insideAnyBox, insideNoSpawn, isDeepWater, mulberry32,
} from '../world/Terrain.js';
import { structureSpots } from '../world/Structures.js';
import { ITEMS, Inventory } from '../player/Items.js';
import { sfx } from '../core/Sound.js';

// ── 三大陣營(規格 7.8)──
export const FACTIONS = {
  ark:   { name: '方舟聚落', icon: '🏳️', color: '#4d7a5a', start: 45, desc: '友善商人陣營' },
  white: { name: '白衣會',   icon: '🥼', color: '#b9bec8', start: 30, desc: '神祕研究者' },
  rust:  { name: '鏽爪幫',   icon: '☠️', color: '#8a3a2a', start: 15, desc: '敵對掠奪者' },
};

// 瓶蓋基準價(買價從這裡往上調、賣價往下打折;沒列的東西不能交易)
export const PRICES = {
  berry: 2, canned: 12, rawmeat: 6, cooked: 10,
  bottled: 8, dirty: 2, boiled: 6, empty: 3,
  bandage: 10, antibiotic: 30, serum: 120,
  cloth: 4, wood: 2, scrap: 5, arrow: 2, ammo9: 3, shell: 6,
  bat: 15, pipe: 20, handaxe: 25, axe: 45, bow: 35, pistol: 90, shotgun: 140,
  engine: 60, tire: 35, battery: 40, fuel: 25,
};

// 送禮加的聲望:值錢的東西加得多(每 10 瓶蓋 1 點,1~6 點)
export const giftValue = (id, n = 1) =>
  Math.max(1, Math.min(6, Math.round((PRICES[id] || 0) * n / 10)));

// ── NPC 類型 ──
export const NPC_TYPES = {
  trader: {
    name: '流浪商人', icon: '💰', faction: 'ark', coat: '#3f5f47', trade: true, caps: 140,
    stock: { canned: 4, bottled: 4, cloth: 4, arrow: 10, ammo9: 12, bandage: 3, wood: 6, scrap: 5 },
    greet: '方舟聚落的商隊在這歇腳。要看貨嗎?瓶蓋說話。',
    rumors: [
      '城市東邊的辦公室抽屜常有抗生素,但那裡的奔跑者也多。',
      '廢棄車能虹吸汽油、拆到零件——巴士修好的話,那就是會跑的家。',
      '夜裡別開槍。槍聲能把三條街外的東西叫過來。',
    ],
  },
  medic: {
    name: '方舟醫生', icon: '🩺', faction: 'ark', coat: '#5a6a7a', trade: true, caps: 90,
    stock: { bandage: 6, antibiotic: 3, boiled: 4, cloth: 3, serum: 1 },
    greet: '傷口讓我看看……抗生素能壓住感染,但只有血清能根治。',
    rumors: [
      '被咬了就趕快吃抗生素,它會凍住惡化;拖到 100% 就沒救了。',
      '髒水煮沸再喝。痢疾在這種年頭跟槍傷一樣會死人。',
    ],
  },
  scientist: {
    name: '白衣會研究員', icon: '🥼', faction: 'white', coat: '#c8ccd2', trade: true, caps: 60,
    stock: { serum: 1, antibiotic: 2 },
    greet: 'NV-7 不是天災。有人在城北的設施裡做過紀錄……你還不夠格知道。',
    rumors: [
      '血清配方分成三份。我們找到一份,另外兩份在別人手上。',
      '別去招惹鏽爪幫。他們拿人命換補給,而且他們也在找那份配方。',
    ],
  },
  survivor: {
    name: '倖存者', icon: '🙋', faction: null, coat: '#6b5a44', trade: false, caps: 0,
    stock: {},
    greet: '……你不是來搶的吧?我只是想撐到下一個天亮。',
    rumors: [
      '往西邊走有片林子,野莓多,感染者少。',
      '晚上蹲著走,它們就聽不見你。',
      '方舟聚落的人會用瓶蓋跟你換東西,他們不騙人。',
    ],
  },
};

let npcId = 0;

export class Npc {
  constructor(type, x, z, facing = 0) {
    this.id = npcId++;
    this.type = type;
    this.def = NPC_TYPES[type];
    this.x = x;
    this.z = z;
    this.facing = facing;
    this.stock = new Inventory();
    this.caps = this.def.caps;
    this.restockDay = 0;   // 最後補貨的天數
    this.rumorIdx = 0;     // 打聽消息輪流講
    this.metOnce = false;  // 第一次見面的招呼語只講一次

    for (const [id, n] of Object.entries(this.def.stock)) this.stock.add(id, n);

    this.mesh = buildNpcMesh(this.def);
    this.mesh.position.set(x, terrainHeight(x, z), z);
    this.mesh.rotation.y = facing;
    // 站著不動,擋路(標記非樹,免得被斧頭當柴砍)
    this.collider = { x, z, r: 0.45, tree: false };
    colliders.circles.push(this.collider);
  }

  // 每天補一次貨(賣光了隔天再來還有得買)
  restock(day) {
    if (day <= this.restockDay) return false;
    this.restockDay = day;
    for (const [id, n] of Object.entries(this.def.stock)) {
      const have = this.stock.count(id);
      if (have < n) this.stock.add(id, n - have);
    }
    this.caps = Math.max(this.caps, this.def.caps);
    return true;
  }
}

// 方塊人:外套顏色分陣營,商人背個貨包
function buildNpcMesh(def) {
  const g = new THREE.Group();
  const coat = new THREE.MeshLambertMaterial({ color: def.coat });
  const skin = new THREE.MeshLambertMaterial({ color: '#c9a184' }); // 活人膚色(感染者是病態灰綠)
  const dark = new THREE.MeshLambertMaterial({ color: '#2e2b26' });
  const box = (w, h, d, mat, x, y, z) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    m.castShadow = true;
    g.add(m);
    return m;
  };
  box(0.42, 0.85, 0.3, dark, 0, 0.43, 0);    // 褲子
  box(0.52, 0.72, 0.32, coat, 0, 1.21, 0);   // 外套
  box(0.3, 0.32, 0.3, skin, 0, 1.75, 0);     // 頭
  box(0.13, 0.62, 0.13, coat, -0.32, 1.25, 0); // 垂在身側的手臂(感染者是前伸的)
  box(0.13, 0.62, 0.13, coat, 0.32, 1.25, 0);
  if (def.trade) box(0.36, 0.4, 0.22, dark, 0, 1.3, 0.26); // 背後的貨包
  if (def.faction) {
    // 陣營旗:遠遠就看得出這裡有人
    box(0.07, 2.6, 0.07, dark, 0.85, 1.3, 0);
    box(0.06, 0.42, 0.62, new THREE.MeshLambertMaterial({ color: FACTIONS[def.faction].color }),
      0.9, 2.35, 0.32);
  }
  return g;
}

export class NpcManager {
  constructor(scene) {
    this.scene = scene;
    this.npcs = [];
    this.rep = {};
    for (const [id, f] of Object.entries(FACTIONS)) this.rep[id] = f.start;
    this.skills = null; // main 掛上(交易折扣/口才)
    this.spawnAll();
    for (const n of this.npcs) scene.add(n.mesh);
  }

  // 固定 seed,擺在建築門外的空地上:商人/醫生在城市、研究員在城市邊緣、倖存者在鄉村
  spawnAll() {
    const rng = mulberry32(8135);
    const place = (type, kind, biomeKey, n) => {
      const spots = structureSpots.filter((s) => s.kind === kind && biomeWeights(s.x, s.z)[biomeKey] > 0.6);
      let placed = 0;
      for (let tries = 0; tries < 400 && placed < n && spots.length; tries++) {
        const s = spots[Math.floor(rng() * spots.length)];
        const a = rng() * Math.PI * 2;
        const r = 6 + rng() * 3;
        const x = s.x + Math.cos(a) * r;
        const z = s.z + Math.sin(a) * r;
        if (insideAnyBox(x, z, 1.4) || insideNoSpawn(x, z, 1.4) || isDeepWater(x, z)) continue;
        if (this.npcs.some((o) => Math.hypot(o.x - x, o.z - z) < 25)) continue; // 別擠在一起
        this.npcs.push(new Npc(type, x, z, rng() * Math.PI * 2));
        placed++;
      }
    };
    place('trader', 'building', 'urban', 1);
    place('trader', 'house', 'rural', 1);
    place('medic', 'building', 'urban', 1);
    place('scientist', 'building', 'urban', 1);
    place('survivor', 'house', 'rural', 2);
    place('survivor', 'barn', 'rural', 1);
  }

  // 靠近時轉頭看玩家(只算附近的,便宜)
  update(dt, playerPos, day = 1) {
    for (const n of this.npcs) {
      const d = Math.hypot(n.x - playerPos.x, n.z - playerPos.z);
      if (d > 14) continue;
      n.restock(day);
      const want = Math.atan2(playerPos.x - n.x, playerPos.z - n.z);
      let diff = (want - n.facing) % (Math.PI * 2);
      if (diff > Math.PI) diff -= Math.PI * 2;
      if (diff < -Math.PI) diff += Math.PI * 2;
      n.facing += diff * Math.min(1, dt * 4);
      n.mesh.rotation.y = n.facing;
    }
  }

  // 互動判定(Interaction.findInteraction 轉呼叫)
  findInteraction(pos) {
    let best = null, bd = 2.8;
    for (const n of this.npcs) {
      const d = Math.hypot(n.x - pos.x, n.z - pos.z);
      if (d < bd) { bd = d; best = n; }
    }
    if (!best) return null;
    return { kind: 'npc', npc: best, label: `與${best.def.name}交談` };
  }

  // ── 聲望(規格 7.8:幫助/敵對行為影響態度與價格)──
  repOf(faction) {
    return faction ? (this.rep[faction] ?? 0) : 50; // 無陣營的散人 = 中立
  }

  addRep(faction, n) {
    if (!faction || !n) return 0;
    const before = this.rep[faction];
    this.rep[faction] = Math.max(0, Math.min(100, before + n));
    return this.rep[faction] - before;
  }

  repLabel(faction) {
    const r = this.repOf(faction);
    return r >= 80 ? '摯友' : r >= 60 ? '友好' : r >= 35 ? '中立' : r >= 20 ? '提防' : '敵視';
  }

  // 聲望越高買得越便宜、賣得越好;交易折扣技能再疊一層(規格 7.7 社交分支)
  buyPrice(npc, id) {
    const base = PRICES[id];
    if (!base) return null;
    const rep = this.repOf(npc.def.faction);
    const mult = (1.2 - 0.4 * (rep / 100)) * (1 - 0.1 * (this.skills?.levelOf('barter') ?? 0));
    return Math.max(1, Math.round(base * mult));
  }

  sellPrice(npc, id) {
    const base = PRICES[id];
    if (!base) return null;
    const rep = this.repOf(npc.def.faction);
    const mult = (0.45 + 0.25 * (rep / 100)) * (1 + 0.1 * (this.skills?.levelOf('barter') ?? 0));
    return Math.max(1, Math.floor(base * mult));
  }

  // 聲望太低就不做你生意
  canTrade(npc) {
    return !!npc.def.trade && this.repOf(npc.def.faction) >= 20;
  }

  // ── 交易 ──
  buy(npc, id, inv) {
    if (!this.canTrade(npc)) return { msg: `${npc.def.name}不想跟你做生意(聲望太低)` };
    const price = this.buyPrice(npc, id);
    if (price === null || npc.stock.count(id) <= 0) return { msg: '他沒有這個東西了' };
    if (inv.count('caps') < price) return { msg: `瓶蓋不夠(需要 ${price},你有 ${inv.count('caps')})` };
    inv.remove('caps', price);
    npc.stock.remove(id, 1);
    npc.caps += price;
    inv.add(id, 1);
    return { msg: `買下 ${ITEMS[id].name}(-${price} 瓶蓋)`, traded: true };
  }

  sell(npc, id, inv) {
    if (!this.canTrade(npc)) return { msg: `${npc.def.name}不想跟你做生意(聲望太低)` };
    const price = this.sellPrice(npc, id);
    if (price === null) return { msg: '這東西沒人要' };
    if (inv.count(id) <= 0) return { msg: '你身上沒有這個' };
    if (npc.caps < price) return { msg: `${npc.def.name}的瓶蓋不夠了(他只剩 ${npc.caps})` };
    inv.remove(id, 1);
    npc.caps -= price;
    npc.stock.add(id, 1);
    inv.add('caps', price);
    return { msg: `賣出 ${ITEMS[id].name}(+${price} 瓶蓋)`, traded: true };
  }

  // 送禮:食物/藥品最能收買人心,口才技能再加成
  gift(npc, id, inv) {
    if (inv.count(id) <= 0) return { msg: '你身上沒有這個' };
    if (!PRICES[id]) return { msg: '這種東西送不出手' };
    const f = npc.def.faction;
    if (!f) return { msg: `${npc.def.name}擺擺手——他不缺這個,倒是想找人搭夥` };
    const gain = Math.round(giftValue(id) * (1 + 0.5 * (this.skills?.levelOf('persuade') ?? 0)));
    inv.remove(id, 1);
    const got = this.addRep(f, gain);
    return {
      msg: got > 0
        ? `送出 ${ITEMS[id].name}——${FACTIONS[f].name}聲望 +${got}(${this.rep[f]},${this.repLabel(f)})`
        : `送出 ${ITEMS[id].name}——${FACTIONS[f].name}對你的評價已經到頂了`,
      rep: got,
    };
  }

  // 打聽消息:輪流講,第一次打聽會小加聲望
  rumor(npc) {
    const lines = npc.def.rumors;
    const line = lines[npc.rumorIdx % lines.length];
    npc.rumorIdx++;
    let gained = 0;
    if (npc.rumorIdx === 1) gained = this.addRep(npc.def.faction, 1);
    return { msg: `「${line}」`, rep: gained };
  }

  // 對話開場白(第一次見面講招呼語,之後講短的)
  greeting(npc) {
    if (!npc.metOnce) {
      npc.metOnce = true;
      return npc.def.greet;
    }
    const f = npc.def.faction;
    const rel = f ? `${FACTIONS[f].name}·${this.repLabel(f)}` : '獨行者';
    return `「又是你。」(${rel})`;
  }

  // 能賣給這個 NPC 的背包物品(給 UI 列表用)
  sellableIds(npc, inv) {
    return [...inv.items.keys()].filter((id) => id !== 'caps' && PRICES[id]);
  }

  playTradeSfx() {
    sfx.play('caps');
  }

  // ── 存讀檔:聲望 + 各 NPC 的庫存/瓶蓋/對話進度(依生成順序索引)──
  serialize() {
    return {
      rep: { ...this.rep },
      npcs: this.npcs.map((n) => ({
        t: n.type, caps: n.caps, day: n.restockDay, rum: n.rumorIdx, met: n.metOnce ? 1 : 0,
        stock: [...n.stock.items.entries()],
      })),
    };
  }

  loadFrom(data) {
    if (!data) return; // 舊檔沒有 NPC = 初始狀態
    for (const [id, v] of Object.entries(data.rep || {})) {
      if (this.rep[id] !== undefined) this.rep[id] = v;
    }
    (data.npcs || []).forEach((s, i) => {
      const n = this.npcs[i];
      if (!n || n.type !== s.t) return;
      n.caps = s.caps ?? n.caps;
      n.restockDay = s.day || 0;
      n.rumorIdx = s.rum || 0;
      n.metOnce = !!s.met;
      n.stock.items = new Map(s.stock || []);
    });
  }
}
