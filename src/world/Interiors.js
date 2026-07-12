import * as THREE from '../lib/three.js';
import { terrainHeight, colliders, noSpawnRects } from './Terrain.js';

// ── M8-室內:大樓一樓 3 種 + 鄉村房 3 種的固定室內佈局 ──
// 建築從實心箱改成「殼」:分段牆(前牆留門口)各掛一顆 AABB collider,
// 碰撞與 AI 視線(losBlocked)自動生效,感染者能從門口看見/追進室內。
// 旋轉只允許 90° 倍數,所以所有 collider 永遠軸對齊。
// 家具全部進 InstancedMesh;可搜刮家具上擺一份「雜物」instance,
// 搜刮後由 LootSpawner.hideLoot 把該 instance 縮到 0(家具本體留著)。

const T = 0.3;        // 牆厚
const DOOR_H = 2.15;  // 門洞高;上方門楣只有視覺,不掛 collider(collider 是 2D 的)

// 家具型錄:w/h/d 佔地;loot = 物資點類型;goods = 搜刮雜物尺寸與中心高(從室內地板頂算)
const FURN = {
  shelf:    { w: 1.7,  h: 1.9,  d: 0.5,  color: '#4c5257', solid: true, loot: 'shelf',    goods: { w: 1.4,  h: 0.35, d: 0.55, y: 1.05 } },
  fridge:   { w: 0.9,  h: 1.85, d: 0.75, color: '#b7bdbd', solid: true, loot: 'fridge',   goods: { w: 0.5,  h: 0.3,  d: 0.5,  y: 2.0 } },
  counter:  { w: 1.9,  h: 1.0,  d: 0.7,  color: '#6a5a44', solid: true, loot: 'counter',  goods: { w: 0.6,  h: 0.3,  d: 0.45, y: 1.15 } },
  cabinet:  { w: 1.2,  h: 0.95, d: 0.5,  color: '#7a6240', solid: true, loot: 'cabinet',  goods: { w: 0.5,  h: 0.28, d: 0.4,  y: 1.1 } },
  wardrobe: { w: 1.1,  h: 2.0,  d: 0.6,  color: '#5d4a33', solid: true, loot: 'wardrobe', goods: { w: 0.55, h: 0.3,  d: 0.45, y: 2.15 } },
  desk:     { w: 1.5,  h: 0.78, d: 0.8,  color: '#8a6f4d', solid: true, loot: 'desk',     goods: { w: 0.55, h: 0.25, d: 0.5,  y: 0.9 } },
  filecab:  { w: 0.55, h: 1.5,  d: 0.55, color: '#61686f', solid: true, loot: 'desk',     goods: { w: 0.4,  h: 0.25, d: 0.4,  y: 1.62 } },
  mailbox:  { w: 1.7,  h: 1.3,  d: 0.4,  color: '#7d8288', solid: true, loot: 'cabinet',  goods: { w: 0.45, h: 0.25, d: 0.35, y: 1.42 } },
  table:    { w: 1.5,  h: 0.75, d: 0.9,  color: '#7a6748', solid: true },
  chair:    { w: 0.45, h: 0.5,  d: 0.45, color: '#6a583e', solid: false },
  sofa:     { w: 1.8,  h: 0.75, d: 0.85, color: '#5a4a52', solid: true },
  mattress: { w: 0.95, h: 0.22, d: 1.95, color: '#8d8878', solid: false },
};

// 佈局座標系:原點 = 建築中心,+z = 門面;furn 的 r = 額外 90° 轉數(只影響佔地寬深互換)
export const TOWER_TYPES = [
  {
    id: 'store', name: '便利商店', kind: 'tower', w: 13, d: 11, h: 3.2, doorW: 2.2,
    furn: [
      { k: 'counter', x: 3.4, z: 3.4 },
      { k: 'shelf', x: -4.0, z: 1.2 }, { k: 'shelf', x: -2.2, z: 1.2 },
      { k: 'shelf', x: -4.0, z: -0.9 }, { k: 'shelf', x: -2.2, z: -0.9 },
      { k: 'shelf', x: -4.0, z: -3.0 }, { k: 'shelf', x: -2.2, z: -3.0 },
      { k: 'fridge', x: 2.2, z: -4.6 }, { k: 'fridge', x: 3.3, z: -4.6 }, { k: 'fridge', x: 4.4, z: -4.6 },
      { k: 'chair', x: 5.2, z: 2.0 },
    ],
  },
  {
    id: 'office', name: '辦公室', kind: 'tower', w: 12, d: 12, h: 3.2, doorW: 1.6,
    furn: [
      { k: 'sofa', x: 3.0, z: 4.3 },
      { k: 'desk', x: -3.0, z: 3.5 },
      { k: 'desk', x: -3.5, z: -0.6 }, { k: 'chair', x: -3.5, z: 0.3 },
      { k: 'desk', x: -3.5, z: -3.2 }, { k: 'chair', x: -3.5, z: -2.3 },
      { k: 'desk', x: 0.2, z: -0.6 }, { k: 'chair', x: 0.2, z: 0.3 },
      { k: 'desk', x: 0.2, z: -3.2 }, { k: 'chair', x: 0.2, z: -2.3 },
      { k: 'filecab', x: 3.4, z: -5.2 }, { k: 'filecab', x: 4.2, z: -5.2 }, { k: 'filecab', x: 5.0, z: -5.2 },
    ],
  },
  {
    id: 'apartment', name: '公寓大廳', kind: 'tower', w: 11, d: 13, h: 3.2, doorW: 1.6,
    furn: [
      { k: 'mailbox', x: 2.6, z: 5.9 },
      { k: 'counter', x: -3.0, z: 4.6 },
      { k: 'sofa', x: -4.0, z: 0.6, r: 1 },
      { k: 'table', x: -2.3, z: 0.6 }, { k: 'chair', x: -2.3, z: 1.6 },
      { k: 'cabinet', x: -4.3, z: -5.8 },
      { k: 'wardrobe', x: 4.5, z: -5.8 },
      { k: 'mattress', x: 4.4, z: -3.4 },
    ],
  },
];

export const HOUSE_TYPES = [
  {
    id: 'cottage', name: '小農舍', kind: 'house', w: 6.5, d: 5.5, h: 3.0, doorW: 1.3,
    furn: [
      { k: 'table', x: 0.2, z: 0.1 }, { k: 'chair', x: 1.2, z: 0.1 }, { k: 'chair', x: 0.2, z: 1.0 },
      { k: 'cabinet', x: -2.3, z: -2.1 },
      { k: 'wardrobe', x: 2.3, z: -2.05 },
      { k: 'mattress', x: -2.35, z: 1.2 },
    ],
  },
  {
    id: 'farmhouse', name: '農家', kind: 'house', w: 8.5, d: 6.5, h: 3.0, doorW: 1.4,
    // 內隔牆把左側隔成臥室,z 0.6~前牆是通道
    walls: [{ x0: 0.75, x1: 1.05, z0: -2.95, z1: 0.6 }],
    furn: [
      { k: 'fridge', x: 3.4, z: -2.4 }, { k: 'cabinet', x: 2.1, z: -2.6 },
      { k: 'table', x: 2.8, z: 0.8 }, { k: 'chair', x: 2.8, z: 1.7 },
      { k: 'mattress', x: -3.4, z: -1.8 },
      { k: 'wardrobe', x: -3.6, z: 0.5, r: 1 },
      { k: 'cabinet', x: -3.65, z: 2.2, r: 1 },
    ],
  },
  {
    id: 'toolshed', name: '工具屋', kind: 'house', w: 6, d: 5, h: 2.8, doorW: 1.3,
    furn: [
      { k: 'shelf', x: -1.7, z: -1.85 }, { k: 'shelf', x: 0.4, z: -1.85 },
      { k: 'cabinet', x: 2.05, z: -1.9 },
      { k: 'table', x: 1.9, z: 0.9 }, { k: 'chair', x: 0.9, z: 0.9 },
    ],
  },
];

// 室內房間登記:感染者繞門導航(routeViaDoor)、測試驗證用
export const interiorRooms = []; // {typeId, minX, maxX, minZ, maxZ, doorX, doorZ}
// 家具物資點:完整 lootPoints 條目,由 LootSpawner 併入(mesh 在 finishInteriors 填入)
export const furnitureLoot = []; // {type, x, z, taken, mesh, index}

// 待組裝的 instance 矩陣,finishInteriors 一次烘成 InstancedMesh
const acc = {
  houseWall: [], towerWall: [], ceil: [], houseFloor: [], towerFloor: [],
  goods: [], furn: {},
};

const roofMat = new THREE.MeshLambertMaterial({ color: '#5c4a38' });

// 90° 倍數旋轉(three.js 繞 Y 軸:x' = x cosθ + z sinθ, z' = -x sinθ + z cosθ)
function rotPt(lx, lz, rot) {
  switch (rot & 3) {
    case 1: return [lz, -lx];
    case 2: return [-lx, -lz];
    case 3: return [-lz, lx];
    default: return [lx, lz];
  }
}

// 局部矩形 → 世界軸對齊 AABB
function rectToWorld(r, rot, cx, cz) {
  const [ax, az] = rotPt(r.x0, r.z0, rot);
  const [bx, bz] = rotPt(r.x1, r.z1, rot);
  return {
    minX: cx + Math.min(ax, bx), maxX: cx + Math.max(ax, bx),
    minZ: cz + Math.min(az, bz), maxZ: cz + Math.max(az, bz),
  };
}

// AABB + 高度 → 單位方塊的 instance 矩陣
function boxMatrix(b, y0, h) {
  const m = new THREE.Matrix4().makeScale(b.maxX - b.minX, h, b.maxZ - b.minZ);
  m.setPosition((b.minX + b.maxX) / 2, y0 + h / 2, (b.minZ + b.maxZ) / 2);
  return m;
}

// 蓋一棟有室內的建築(殼牆+地板天花板+家具+物資點),回傳基準地面高
export function buildInterior(parent, type, cx, cz, rot) {
  const { w, d, h, doorW } = type;
  const yb = terrainHeight(cx, cz);
  const isHouse = type.kind === 'house';

  // 外框登記:生成迴避(樹/物資點)+ 感染者繞門導航
  const rect = rectToWorld({ x0: -w / 2, z0: -d / 2, x1: w / 2, z1: d / 2 }, rot, cx, cz);
  const [dpx, dpz] = rotPt(0, d / 2, rot);
  noSpawnRects.push(rect);
  interiorRooms.push({ typeId: type.id, ...rect, doorX: cx + dpx, doorZ: cz + dpz });

  // 牆:前牆從門口分兩段;內隔牆直接寫在 type.walls
  const wallRects = [
    { x0: -w / 2, x1: w / 2, z0: -d / 2, z1: -d / 2 + T },
    { x0: -w / 2, x1: -w / 2 + T, z0: -d / 2 + T, z1: d / 2 - T },
    { x0: w / 2 - T, x1: w / 2, z0: -d / 2 + T, z1: d / 2 - T },
    { x0: -w / 2, x1: -doorW / 2, z0: d / 2 - T, z1: d / 2 },
    { x0: doorW / 2, x1: w / 2, z0: d / 2 - T, z1: d / 2 },
    ...(type.walls || []),
  ];
  const wallAcc = isHouse ? acc.houseWall : acc.towerWall;
  for (const r of wallRects) {
    const b = rectToWorld(r, rot, cx, cz);
    colliders.boxes.push(b);
    wallAcc.push(boxMatrix(b, yb, h));
  }
  // 門楣(視覺)
  const lintel = rectToWorld({ x0: -doorW / 2, x1: doorW / 2, z0: d / 2 - T, z1: d / 2 }, rot, cx, cz);
  wallAcc.push(boxMatrix(lintel, yb + DOOR_H, h - DOOR_H));

  // 天花板 + 地板(玩家仍走解析地形,地板頂只高出 6cm,誤差可忽略)
  acc.ceil.push(boxMatrix(rect, yb + h, 0.15));
  const fRect = { minX: rect.minX + 0.05, maxX: rect.maxX - 0.05, minZ: rect.minZ + 0.05, maxZ: rect.maxZ - 0.05 };
  (isHouse ? acc.houseFloor : acc.towerFloor).push(boxMatrix(fRect, yb - 0.06, 0.12));

  // 家具與搜刮點
  for (const f of type.furn) {
    const def = FURN[f.k];
    const q = (rot + (f.r || 0)) & 3;
    const fw = q % 2 ? def.d : def.w;
    const fd = q % 2 ? def.w : def.d;
    const [px, pz] = rotPt(f.x, f.z, rot);
    const b = {
      minX: cx + px - fw / 2, maxX: cx + px + fw / 2,
      minZ: cz + pz - fd / 2, maxZ: cz + pz + fd / 2,
    };
    (acc.furn[f.k] ||= []).push(boxMatrix(b, yb + 0.06, def.h));
    if (def.solid) colliders.boxes.push({ ...b, noLos: true });
    if (def.loot) {
      const g = def.goods;
      const gm = new THREE.Matrix4().makeScale(q % 2 ? g.d : g.w, g.h, q % 2 ? g.w : g.d);
      gm.setPosition(cx + px, yb + 0.06 + g.y, cz + pz);
      furnitureLoot.push({ type: def.loot, x: cx + px, z: cz + pz, taken: false, mesh: null, index: acc.goods.length });
      acc.goods.push(gm);
    }
  }

  // 鄉村房:四角錐屋頂(大樓的上層實心樓體由 Structures 疊上去)
  if (isHouse) {
    const roof = new THREE.Mesh(new THREE.ConeGeometry(0.72, 1.8, 4), roofMat);
    roof.rotation.y = Math.PI / 4;
    roof.scale.set((rot % 2 ? d : w) + 0.6, 1, (rot % 2 ? w : d) + 0.6);
    roof.position.set(cx, yb + h + 0.9, cz);
    roof.castShadow = true;
    parent.add(roof);
  }
  return yb;
}

const unitBox = new THREE.BoxGeometry(1, 1, 1);
function bake(parent, color, matrices, shadow = true) {
  if (!matrices.length) return null;
  const mesh = new THREE.InstancedMesh(unitBox, new THREE.MeshLambertMaterial({ color }), matrices.length);
  matrices.forEach((m, i) => mesh.setMatrixAt(i, m));
  mesh.castShadow = shadow;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

// 把累積的矩陣烘成 InstancedMesh(createStructures 收尾時呼叫一次)
export function finishInteriors(parent) {
  bake(parent, '#a89878', acc.houseWall);
  bake(parent, '#75716c', acc.towerWall);
  bake(parent, '#7d786e', acc.ceil, false);
  bake(parent, '#6b563c', acc.houseFloor, false);
  bake(parent, '#595a5e', acc.towerFloor, false);
  for (const [k, arr] of Object.entries(acc.furn)) bake(parent, FURN[k].color, arr);
  const goodsMesh = bake(parent, '#8a7a55', acc.goods);
  for (const p of furnitureLoot) p.mesh = goodsMesh;
}

// 感染者導航:目標與自己一牆之隔(一內一外)時,先走到那個房間的門口
export function routeViaDoor(pos, goal) {
  for (const r of interiorRooms) {
    const pIn = pos.x > r.minX && pos.x < r.maxX && pos.z > r.minZ && pos.z < r.maxZ;
    const gIn = goal.x > r.minX && goal.x < r.maxX && goal.z > r.minZ && goal.z < r.maxZ;
    if (pIn === gIn) continue;
    if (Math.hypot(pos.x - r.doorX, pos.z - r.doorZ) > 1.2) return { x: r.doorX, z: r.doorZ };
    return goal; // 已在門口,直接穿過去
  }
  return goal;
}
