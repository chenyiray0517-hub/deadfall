import * as THREE from '../lib/three.js';
import {
  TERRAIN_SIZE, terrainHeight, biomeWeights, roadMask, isDeepWater,
  insideAnyBox, insideNoSpawn, mulberry32,
} from './Terrain.js';
import { structureSpots } from './Structures.js';
import { furnitureLoot } from './Interiors.js';

// 全部物資點:互動系統從這裡讀
// {type, x, z, taken, mesh, index}(berry 另有 berriesMesh 藏果實用)
export const lootPoints = [];

// 互動提示文字
export const LOOT_LABELS = {
  berry: '採集野莓',
  stick: '撿樹枝',
  crate: '搜刮補給箱',
  trash: '翻找垃圾堆',
  // 室內家具(M8)
  shelf: '搜刮貨架',
  fridge: '翻找冰箱',
  counter: '搜刮櫃台',
  cabinet: '翻找櫥櫃',
  wardrobe: '翻找衣櫃',
  desk: '翻找辦公桌',
};

// 拾取表
const weighted = (table) => {
  const total = table.reduce((s, e) => s + e.w, 0);
  let r = Math.random() * total;
  for (const e of table) { r -= e.w; if (r <= 0) return e.id; }
  return table[0].id;
};
const CRATE_TABLE = [
  { id: 'canned', w: 30 }, { id: 'bottled', w: 20 }, { id: 'cloth', w: 20 },
  { id: 'wood', w: 15 }, { id: 'scrap', w: 15 },
  // M6:武器與彈藥(手槍/獵槍/血清偏稀有)
  { id: 'ammo9', w: 10 }, { id: 'shell', w: 5 }, { id: 'pipe', w: 6 },
  { id: 'axe', w: 2 }, { id: 'pistol', w: 3 }, { id: 'shotgun', w: 1 },
  { id: 'antibiotic', w: 3 }, { id: 'serum', w: 1 },
];
const TRASH_TABLE = [
  { id: 'cloth', w: 40 }, { id: 'scrap', w: 40 }, { id: 'canned', w: 20 },
  { id: 'bat', w: 12 }, { id: 'ammo9', w: 8 },
];
// 室內家具掉落表(M8):商店吃喝多、辦公桌雜物彈藥多、衣櫃布料多
const FURN_TABLES = {
  shelf: [
    { id: 'canned', w: 30 }, { id: 'bottled', w: 22 }, { id: 'cloth', w: 12 },
    { id: 'scrap', w: 10 }, { id: 'empty', w: 8 }, { id: 'ammo9', w: 6 },
    { id: 'bat', w: 4 }, { id: 'antibiotic', w: 3 },
  ],
  fridge: [
    { id: 'canned', w: 30 }, { id: 'bottled', w: 35 }, { id: 'rawmeat', w: 18 }, { id: 'empty', w: 10 },
  ],
  counter: [
    { id: 'canned', w: 12 }, { id: 'bottled', w: 12 }, { id: 'scrap', w: 18 },
    { id: 'ammo9', w: 12 }, { id: 'cloth', w: 10 }, { id: 'shell', w: 5 },
    { id: 'antibiotic', w: 4 }, { id: 'pistol', w: 3 },
  ],
  cabinet: [
    { id: 'canned', w: 20 }, { id: 'bottled', w: 14 }, { id: 'cloth', w: 18 },
    { id: 'scrap', w: 14 }, { id: 'wood', w: 10 }, { id: 'bandage', w: 8 }, { id: 'antibiotic', w: 4 },
  ],
  wardrobe: [
    { id: 'cloth', w: 45 }, { id: 'bandage', w: 10 }, { id: 'scrap', w: 8 },
    { id: 'empty', w: 6 }, { id: 'ammo9', w: 5 }, { id: 'pistol', w: 2 },
  ],
  desk: [
    { id: 'scrap', w: 22 }, { id: 'ammo9', w: 12 }, { id: 'cloth', w: 10 },
    { id: 'empty', w: 10 }, { id: 'bandage', w: 6 }, { id: 'antibiotic', w: 6 },
    { id: 'pistol', w: 2 }, { id: 'serum', w: 1 },
  ],
};

// 彈藥一次撿一小把
const rollCount = (id) =>
  id === 'ammo9' ? 4 + Math.floor(Math.random() * 3)
  : id === 'shell' ? 2 + Math.floor(Math.random() * 2)
  : 1;

export function rollLoot(type) {
  const items = {};
  const push = (id, n) => { items[id] = (items[id] || 0) + n; };
  if (type === 'berry') push('berry', 2 + (Math.random() < 0.5 ? 1 : 0));
  else if (type === 'stick') push('wood', 1 + (Math.random() < 0.4 ? 1 : 0));
  else if (type === 'crate') {
    const n = 2 + (Math.random() < 0.4 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const id = weighted(CRATE_TABLE);
      push(id, rollCount(id));
    }
  } else if (type === 'trash') {
    const n = 1 + (Math.random() < 0.5 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const id = weighted(TRASH_TABLE);
      push(id, rollCount(id));
    }
  } else if (FURN_TABLES[type]) {
    const n = 1 + (Math.random() < 0.6 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      const id = weighted(FURN_TABLES[type]);
      push(id, rollCount(id));
    }
  }
  return items;
}

// 隱藏場景中的那一份(instance 縮到 0);讀檔還原已拿點也走這裡
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
export function hideLoot(point) {
  if (point.type === 'berry') {
    // 果叢留著,只藏果實
    for (let j = 0; j < 3; j++) point.berriesMesh.setMatrixAt(point.index * 3 + j, ZERO);
    point.berriesMesh.instanceMatrix.needsUpdate = true;
  } else {
    point.mesh.setMatrixAt(point.index, ZERO);
    point.mesh.instanceMatrix.needsUpdate = true;
  }
}

export function takeLoot(point) {
  point.taken = true;
  hideLoot(point);
  return rollLoot(point.type);
}

export function spawnLoot() {
  const group = new THREE.Group();
  const rng = mulberry32(11223);
  const half = TERRAIN_SIZE / 2 - 12;

  // ── 野果叢(荒野採集,規格 4.2)──
  const BERRY_MAX = 26;
  const bushGeo = new THREE.IcosahedronGeometry(0.7, 0);
  bushGeo.scale(1, 0.75, 1);
  const bushMat = new THREE.MeshLambertMaterial({ color: '#2f4526' });
  const berryGeo = new THREE.SphereGeometry(0.09, 6, 5);
  const berryMat = new THREE.MeshLambertMaterial({ color: '#b03a3a' });
  const bushes = new THREE.InstancedMesh(bushGeo, bushMat, BERRY_MAX);
  const berries = new THREE.InstancedMesh(berryGeo, berryMat, BERRY_MAX * 3);
  bushes.castShadow = true;

  const m = new THREE.Matrix4();
  let bc = 0;
  for (let tries = 0; tries < 1200 && bc < BERRY_MAX; tries++) {
    const x = (rng() * 2 - 1) * half;
    const z = (rng() * 2 - 1) * half;
    if (biomeWeights(x, z).wild < 0.75) continue;
    if (isDeepWater(x, z) || terrainHeight(x, z) < -0.4) continue;
    const y = terrainHeight(x, z);
    m.makeScale(0.8 + rng() * 0.5, 0.8 + rng() * 0.4, 0.8 + rng() * 0.5);
    m.setPosition(x, y + 0.45, z);
    bushes.setMatrixAt(bc, m);
    for (let j = 0; j < 3; j++) {
      const a = rng() * Math.PI * 2;
      m.makeTranslation(x + Math.cos(a) * 0.5, y + 0.6 + rng() * 0.3, z + Math.sin(a) * 0.5);
      berries.setMatrixAt(bc * 3 + j, m);
    }
    lootPoints.push({ type: 'berry', x, z, taken: false, berriesMesh: berries, index: bc });
    bc++;
  }
  bushes.count = bc;
  berries.count = bc * 3;
  group.add(bushes, berries);

  // ── 樹枝(荒野/鄉村地上,撿了當木柴)──
  const STICK_MAX = 26;
  const stickGeo = new THREE.CylinderGeometry(0.05, 0.08, 1.2, 5);
  const stickMat = new THREE.MeshLambertMaterial({ color: '#5a4530' });
  const sticks = new THREE.InstancedMesh(stickGeo, stickMat, STICK_MAX);
  const e = new THREE.Euler();
  const q = new THREE.Quaternion();
  const one = new THREE.Vector3(1, 1, 1);
  let sc = 0;
  for (let tries = 0; tries < 1200 && sc < STICK_MAX; tries++) {
    const x = (rng() * 2 - 1) * half;
    const z = (rng() * 2 - 1) * half;
    const w = biomeWeights(x, z);
    if (w.urban > 0.2 || isDeepWater(x, z)) continue;
    if (roadMask(x, z) > 0.3 || insideAnyBox(x, z, 0.5) || insideNoSpawn(x, z, 0.6)) continue;
    q.setFromEuler(e.set(Math.PI / 2, 0, rng() * Math.PI * 2, 'ZYX'));
    m.compose(new THREE.Vector3(x, terrainHeight(x, z) + 0.08, z), q, one);
    sticks.setMatrixAt(sc, m);
    lootPoints.push({ type: 'stick', x, z, taken: false, mesh: sticks, index: sc });
    sc++;
  }
  sticks.count = sc;
  group.add(sticks);

  // ── 補給箱:放在建築/車輛旁 ──
  const crateGeo = new THREE.BoxGeometry(0.9, 0.9, 0.9);
  const crateMat = new THREE.MeshLambertMaterial({ color: '#9a7a4a' });
  const CRATE_MAX = structureSpots.length;
  const crates = new THREE.InstancedMesh(crateGeo, crateMat, CRATE_MAX);
  crates.castShadow = true;
  let cc = 0;
  for (const spot of structureSpots) {
    if (rng() > 0.55) continue;
    for (let attempt = 0; attempt < 8; attempt++) {
      const a = rng() * Math.PI * 2;
      const r = 4 + rng() * 4;
      const x = spot.x + Math.cos(a) * r;
      const z = spot.z + Math.sin(a) * r;
      if (insideAnyBox(x, z, 0.8) || insideNoSpawn(x, z, 0.6) || roadMask(x, z) > 0.3) continue;
      q.setFromEuler(e.set(0, rng() * Math.PI, 0));
      m.compose(new THREE.Vector3(x, terrainHeight(x, z) + 0.45, z), q, one);
      crates.setMatrixAt(cc, m);
      lootPoints.push({ type: 'crate', x, z, taken: false, mesh: crates, index: cc });
      cc++;
      break;
    }
  }
  crates.count = cc;
  group.add(crates);

  // ── 垃圾堆(城市搜刮)──
  const TRASH_MAX = 18;
  const trashGeo = new THREE.DodecahedronGeometry(0.75, 0);
  trashGeo.scale(1, 0.55, 1);
  const trashMat = new THREE.MeshLambertMaterial({ color: '#55524c' });
  const trash = new THREE.InstancedMesh(trashGeo, trashMat, TRASH_MAX);
  let tc = 0;
  for (let tries = 0; tries < 800 && tc < TRASH_MAX; tries++) {
    const x = (rng() * 2 - 1) * half;
    const z = (rng() * 2 - 1) * half;
    if (biomeWeights(x, z).urban < 0.8) continue;
    if (insideAnyBox(x, z, 0.8) || insideNoSpawn(x, z, 0.6)) continue;
    q.setFromEuler(e.set(0, rng() * Math.PI, 0));
    m.compose(new THREE.Vector3(x, terrainHeight(x, z) + 0.3, z), q, one);
    trash.setMatrixAt(tc, m);
    lootPoints.push({ type: 'trash', x, z, taken: false, mesh: trash, index: tc });
    tc++;
  }
  trash.count = tc;
  group.add(trash);

  // ── 室內家具物資點(M8):條目由 Interiors 準備好,直接併入 ──
  // 放在最後,讓野莓/樹枝維持在陣列前段(舊存檔的索引相容靠這個順序)
  lootPoints.push(...furnitureLoot);

  return group;
}
