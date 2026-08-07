// 血清主線的世界端(M8f-3,規格 7.9 主線 + 4.5 特殊區域)
//
// 任務定義本身在 systems/Quests.js(純邏輯);這裡負責「世界上的那幾個地方」:
//   醫院 / 研究所 / 軍事實驗室 —— 三份血清配方的所在地(visit 型主線任務的座標)
//   研究設施 —— 終局地城,病毒起源地,走到門口就選結局
//
// 地標用固定 seed 從 structureSpots 挑既有建築,再插一塊招牌(不掛 collider,只是認路用),
// 所以座標每次載入都一樣,存檔不必存。

import * as THREE from '../lib/three.js';
import { terrainHeight, biomeWeights, isDeepWater, mulberry32, SPAWN, TERRAIN_SIZE } from '../world/Terrain.js';
import { structureSpots } from '../world/Structures.js';

export const LANDMARKS = [
  { id: 'hospital', quest: 'main_formula_a', name: '市立醫院', icon: '🏥', color: '#c84a3c', minDist: 120 },
  { id: 'lab', quest: 'main_formula_b', name: '諾瓦研究所', icon: '🥼', color: '#d8d4c2', minDist: 160 },
  { id: 'military', quest: 'main_formula_c', name: '軍事實驗室', icon: '🎖', color: '#6b7a4a', minDist: 200 },
  { id: 'facility', quest: null, name: '研究設施', icon: '☣️', color: '#4ac8c8', minDist: 260 },
];

// 三結局(規格 7.9)
export const ENDINGS = [
  {
    id: 'broadcast', icon: '📡', title: '把配方廣播出去',
    hint: '讓所有還活著的人都做得出血清——代價是所有還活著的東西也都知道你在哪裡',
    need: null,
    text: `你把血清的合成路徑,連同這棟樓的座標,一遍一遍地播了出去。
訊號傳得比你想像的遠。天亮之前,聞聲而來的不只有人。
據點的圍牆撐不了多久,但那不重要了——某個你永遠不會見到的人,
會在某個你永遠不會去的地方,照著這張配方救活他的女兒。`,
  },
  {
    id: 'haven', icon: '📻', title: '獨善其身,前往淨區',
    hint: '修好無線電呼叫「淨區」的接駁——需要無線電零件 ×3',
    need: { radio: 3 },
    text: `無線電滋滋響了三個晚上,第四天早上有人回話了。
座標、時間、只能帶一個人。
直升機來的時候,你沒有回頭看身後那片你活了那麼久的地方。
淨區的床很乾淨。你睡不著。`,
  },
  {
    id: 'settle', icon: '🌱', title: '留下來,重建',
    hint: '不廣播、不撤離——把血清留在手上,把這片地方重新變成能住人的樣子',
    need: null,
    text: `你把血清鎖進箱子,回到自己蓋的那道牆後面。
沒有廣播,沒有直升機,只有明天要澆的菜、要補的柵欄、要餵的人。
病毒還在外面。但這裡的燈,今晚照樣亮著。`,
  },
];

export const endingDef = (id) => ENDINGS.find((e) => e.id === id) || null;

export class Story {
  constructor(scene) {
    this.scene = scene;
    this.spots = {};        // landmarkId → {x, z}
    this.ending = null;     // 選過的結局 id(存檔會記)
    this.facilityAlerted = false;
    this.pickSpots();
    this.buildSigns();
  }

  // 固定 seed 挑四棟彼此夠遠、離出生點也夠遠的建築
  pickSpots() {
    const rng = mulberry32(77001);
    const chosen = [];
    const towers = structureSpots.filter((s) => s.kind === 'building');
    const houses = structureSpots.filter((s) => s.kind === 'house' || s.kind === 'barn');
    for (const lm of LANDMARKS) {
      // 醫院/研究所/研究設施優先擺城市大樓,實在挑不到就退而求其次用鄉村建築
      const pool = towers.length ? towers : houses;
      let best = null;
      for (let i = 0; i < 600; i++) {
        const s = pool[Math.floor(rng() * pool.length)];
        if (!s) break;
        if (Math.hypot(s.x - SPAWN.x, s.z - SPAWN.z) < lm.minDist) continue;
        if (chosen.some((c) => Math.hypot(c.x - s.x, c.z - s.z) < 120)) continue;
        if (isDeepWater(s.x, s.z)) continue;
        best = s;
        break;
      }
      if (!best) {
        // 退路:朝地圖對角找一塊空地
        const half = TERRAIN_SIZE / 2 - 40;
        const a = rng() * Math.PI * 2;
        best = {
          x: Math.max(-half, Math.min(half, SPAWN.x + Math.cos(a) * lm.minDist)),
          z: Math.max(-half, Math.min(half, SPAWN.z + Math.sin(a) * lm.minDist)),
        };
      }
      this.spots[lm.id] = { x: best.x, z: best.z };
      chosen.push(best);
    }
  }

  // 招牌:一根桿子 + 一塊有顏色的牌子(不擋路,純粹讓你認得出「就是這裡」)
  buildSigns() {
    const g = new THREE.Group();
    for (const lm of LANDMARKS) {
      const p = this.spots[lm.id];
      const y = terrainHeight(p.x, p.z);
      const tall = lm.id === 'facility' ? 15 : 11;
      const pole = new THREE.Mesh(
        new THREE.BoxGeometry(0.3, tall, 0.3),
        new THREE.MeshLambertMaterial({ color: '#3a3d40' })
      );
      pole.position.set(p.x + 6, y + tall / 2, p.z + 6);
      pole.castShadow = true;
      // 招牌用 Basic 材質:不吃光照,夜裡照樣認得出來(這是導航用的地標,不是裝飾)
      const board = new THREE.Mesh(
        new THREE.BoxGeometry(3.4, 1.4, 0.2),
        new THREE.MeshBasicMaterial({ color: lm.color })
      );
      board.position.set(p.x + 6, y + tall - 1.1, p.z + 6.2);
      g.add(pole, board);
    }
    this.signs = g;
    this.scene.add(g);
  }

  // visit 型主線任務的目標座標(Npc.pickQuestSpot 的地標版)
  spotFor(questId) {
    const lm = LANDMARKS.find((l) => l.quest === questId);
    return lm ? { ...this.spots[lm.id] } : null;
  }

  get facility() {
    return this.spots.facility;
  }

  // 終局地城的守衛(規格 4.5:研究設施 = 病毒起源地)——圍著設施多放一圈感染者
  guardFacility(enemies) {
    if (!enemies?.spawnAt) return 0;
    const rng = mulberry32(77002);
    const p = this.facility;
    let n = 0;
    for (let i = 0; i < 10; i++) {
      const a = rng() * Math.PI * 2;
      const r = 10 + rng() * 16;
      const x = p.x + Math.cos(a) * r;
      const z = p.z + Math.sin(a) * r;
      if (isDeepWater(x, z)) continue;
      enemies.spawnAt(rng() < 0.35 ? 'runner' : 'walker', x, z);
      n++;
    }
    return n;
  }

  // 主線走到最後一步(血清合成完)才推得開研究設施的門
  unlocked(quests) {
    return quests?.finished?.main_serum !== undefined;
  }

  findInteraction(pos, quests) {
    const p = this.facility;
    if (!p) return null;
    if (Math.hypot(pos.x - p.x, pos.z - p.z) > 5) return null;
    if (this.ending) return { kind: 'facility', done: true, label: '研究設施(你已經做出選擇了)' };
    if (!this.unlocked(quests)) return { kind: 'facility', locked: true, label: '研究設施(門鎖著——先完成白衣會的委託)' };
    return { kind: 'facility', label: '走進研究設施(決定這一切要怎麼收尾)' };
  }

  // 結局選項與是否滿足條件(UI 用)
  options(inv) {
    return ENDINGS.map((e) => {
      const miss = Object.entries(e.need || {}).find(([id, n]) => inv.count(id) < n);
      return { def: e, ok: !miss, miss: miss ? { id: miss[0], n: miss[1] } : null };
    });
  }

  // 做出選擇;回傳結局定義(條件不足回傳 null)
  choose(id, inv) {
    const opt = this.options(inv).find((o) => o.def.id === id);
    if (!opt || !opt.ok || this.ending) return null;
    this.ending = id;
    return opt.def;
  }

  serialize() {
    return { ending: this.ending };
  }

  loadFrom(data) {
    if (!data) return; // 舊檔沒有主線紀錄 = 還沒選過結局
    this.ending = data.ending || null;
  }
}
