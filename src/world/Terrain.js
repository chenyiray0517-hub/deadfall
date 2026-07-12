import * as THREE from '../lib/three.js';

// 地形 500x500,高度/生態區/道路全部是解析函式,任何系統都能直接取樣
export const TERRAIN_SIZE = 500;
export const WATER_LEVEL = -1.0;
export const SPAWN = { x: -140, z: -10 }; // 出生在荒野、靠近鄉村邊界(規格:荒野是起步區)
export const LAKE = { x: -160, z: 90, r: 42 };

// 碰撞體註冊表:建立世界時填入,Player 每幀解算
// boxes: {minX,maxX,minZ,maxZ} / circles: {x,z,r}
export const colliders = { boxes: [], circles: [] };

// 室內佔地(M8):建築改成鏤空殼後,牆 collider 不再覆蓋內部,
// 生成迴避(樹/物資點/感染者出生)改查這張表(由 Interiors 填入)
export const noSpawnRects = [];
export function insideNoSpawn(x, z, margin = 0) {
  for (const r of noSpawnRects) {
    if (x > r.minX - margin && x < r.maxX + margin &&
        z > r.minZ - margin && z < r.maxZ + margin) return true;
  }
  return false;
}

function smoothstep(x, a, b) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

// ── 生態區:荒野(西) → 鄉村(中) → 城市(東),邊界帶狀扭動(規格 4.1 風險/報酬梯度)──
export function biomeWeights(x, z) {
  const u = x + 35 * Math.sin(z * 0.011 + 2.3) + 18 * Math.sin(z * 0.027 + 0.7);
  const a = smoothstep(u, -75, -40);  // 荒野→鄉村
  const b = smoothstep(u, 90, 125);   // 鄉村→城市
  return { wild: 1 - a, rural: a * (1 - b), urban: a * b };
}

export function regionName(x, z) {
  const w = biomeWeights(x, z);
  if (w.urban >= w.rural && w.urban >= w.wild) return '城市區';
  if (w.rural >= w.wild) return '鄉村區';
  return '荒野區';
}

// ── 道路 ──
// 主要公路:從鄉村蜿蜒進城市
export function mainRoadCenter(x) { return 6 * Math.sin(x * 0.02); }
function mainRoadMask(x, z) {
  if (x < -80) return 0;
  const d = Math.abs(z - mainRoadCenter(x));
  return 1 - smoothstep(d, 3.2, 5.5);
}
// 城市棋盤路網(間距 52)
const GRID = 52;
function urbanRoadMask(x, z, urbanW) {
  if (urbanW < 0.55) return 0;
  const gx = ((x % GRID) + GRID) % GRID;
  const gz = ((z % GRID) + GRID) % GRID;
  const near = Math.min(gx, GRID - gx, gz, GRID - gz);
  return (1 - smoothstep(near, 2.6, 4.5)) * smoothstep(urbanW, 0.55, 0.8);
}
export function roadMask(x, z) {
  const w = biomeWeights(x, z);
  return Math.max(mainRoadMask(x, z), urbanRoadMask(x, z, w.urban));
}

// ── 高度:荒野丘陵 / 鄉村緩坡 / 城市平地,依權重混合,再挖出湖泊 ──
export function terrainHeight(x, z) {
  const w = biomeWeights(x, z);
  let hWild =
    2.6 * Math.sin(x * 0.018) * Math.cos(z * 0.015) +
    1.4 * Math.sin(x * 0.045 + 1.7) * Math.sin(z * 0.038 + 0.6) +
    0.5 * Math.sin(x * 0.11 + 4.2) * Math.cos(z * 0.09 + 2.1);
  hWild *= 1.5;
  const hRural = 0.5 * Math.sin(x * 0.03 + 0.8) * Math.cos(z * 0.025 + 1.9);
  let h = hWild * w.wild + hRural * w.rural; // 城市 = 0

  // 湖泊窪地(荒野)
  const d = Math.hypot(x - LAKE.x, z - LAKE.z);
  if (d < LAKE.r) h -= 3.4 * (1 - smoothstep(d, LAKE.r * 0.35, LAKE.r));
  return h;
}

// 深水禁區(之後做游泳前,先擋住玩家走進湖心)
// 只在湖的範圍內判定——荒野也有低於水平面的乾涸山谷,不能誤擋
export function isDeepWater(x, z) {
  if (Math.hypot(x - LAKE.x, z - LAKE.z) > LAKE.r) return false;
  return terrainHeight(x, z) < WATER_LEVEL - 0.35;
}

export function createTerrain() {
  const group = new THREE.Group();

  const segments = 200;
  const geo = new THREE.PlaneGeometry(TERRAIN_SIZE, TERRAIN_SIZE, segments, segments);
  geo.rotateX(-Math.PI / 2);

  const pos = geo.attributes.position;
  const colors = new Float32Array(pos.count * 3);
  // 各區基色
  const cGrass = new THREE.Color('#5c6b3f');
  const cDirt = new THREE.Color('#6b5d42');
  const cDry = new THREE.Color('#7a7450');
  const cFarm = new THREE.Color('#8a8352');   // 鄉村乾草地
  const cField = new THREE.Color('#7d5f3d');  // 翻耕農田
  const cConcrete = new THREE.Color('#606064');
  const cAsphalt = new THREE.Color('#3c3c40');
  const cDirtRoad = new THREE.Color('#6b5335');
  const cSand = new THREE.Color('#7a6f52');
  const tmp = new THREE.Color();
  const mix = new THREE.Color();

  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const z = pos.getZ(i);
    const h = terrainHeight(x, z);
    pos.setY(i, h);

    const w = biomeWeights(x, z);

    // 荒野:依高度混色
    const t = THREE.MathUtils.clamp((h + 3) / 9, 0, 1);
    tmp.copy(cDirt).lerp(cGrass, Math.min(t * 2, 1));
    if (t > 0.55) tmp.lerp(cDry, (t - 0.55) / 0.45);
    mix.copy(tmp).multiplyScalar(w.wild);

    // 鄉村:草地 + 棋盤農田(帶壟溝條紋)
    tmp.copy(cFarm);
    const cell = Math.floor(x / 24) + Math.floor(z / 24) * 3;
    if (((cell % 4) + 4) % 4 === 0) {
      tmp.copy(cField);
      tmp.offsetHSL(0, 0, Math.sin(z * 1.6) * 0.02); // 壟溝
    }
    mix.r += tmp.r * w.rural; mix.g += tmp.g * w.rural; mix.b += tmp.b * w.rural;

    // 城市:水泥地
    mix.r += cConcrete.r * w.urban; mix.g += cConcrete.g * w.urban; mix.b += cConcrete.b * w.urban;

    // 道路覆蓋:鄉村段土路、城市段柏油
    const road = roadMask(x, z);
    if (road > 0.01) {
      tmp.copy(cDirtRoad).lerp(cAsphalt, w.urban);
      mix.lerp(tmp, road);
    }
    // 湖岸沙地
    if (h < WATER_LEVEL + 0.6) mix.lerp(cSand, 0.7);

    // 一點雜訊避免太平滑
    const n = Math.sin(x * 1.3) * Math.cos(z * 1.7) * 0.035;
    colors[i * 3] = mix.r + n;
    colors[i * 3 + 1] = mix.g + n;
    colors[i * 3 + 2] = mix.b + n;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();

  const ground = new THREE.Mesh(geo, new THREE.MeshLambertMaterial({ vertexColors: true }));
  ground.receiveShadow = true;
  group.add(ground);

  // 湖面
  const water = new THREE.Mesh(
    new THREE.CircleGeometry(LAKE.r + 8, 40),
    new THREE.MeshLambertMaterial({ color: '#3f6a80', transparent: true, opacity: 0.82 })
  );
  water.rotation.x = -Math.PI / 2;
  water.position.set(LAKE.x, WATER_LEVEL, LAKE.z);
  group.add(water);

  scatterNature(group);
  return group;
}

// ── 樹與石頭:荒野密、鄉村疏、城市無 ──
function scatterNature(group) {
  const rng = mulberry32(20260711);
  const half = TERRAIN_SIZE / 2 - 10;

  const TREE_MAX = 420;
  const trunkGeo = new THREE.CylinderGeometry(0.22, 0.35, 3.2, 6);
  trunkGeo.translate(0, 1.6, 0);
  const trunkMat = new THREE.MeshLambertMaterial({ color: '#4a3826' });
  const crownGeo = new THREE.ConeGeometry(1.9, 4.6, 7);
  crownGeo.translate(0, 5.2, 0);
  const crownMat = new THREE.MeshLambertMaterial({ color: '#3d4d2a' });
  const trunks = new THREE.InstancedMesh(trunkGeo, trunkMat, TREE_MAX);
  const crowns = new THREE.InstancedMesh(crownGeo, crownMat, TREE_MAX);
  trunks.castShadow = crowns.castShadow = true;

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const up = new THREE.Vector3(0, 1, 0);
  let count = 0;
  for (let tries = 0; tries < 4000 && count < TREE_MAX; tries++) {
    const x = (rng() * 2 - 1) * half;
    const z = (rng() * 2 - 1) * half;
    const w = biomeWeights(x, z);
    // 荒野必種、鄉村 15% 機率、城市不種
    if (w.urban > 0.3) continue;
    if (w.rural > w.wild && rng() > 0.15) continue;
    if (Math.hypot(x - SPAWN.x, z - SPAWN.z) < 15) continue;      // 出生點留空
    if (Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r + 4) continue; // 不種在湖裡
    if (roadMask(x, z) > 0.15) continue;                           // 不種在路上
    if (insideAnyBox(x, z, 2)) continue;                           // 不種進建築
    if (insideNoSpawn(x, z, 1)) continue;                          // 不種進室內

    const s = 0.7 + rng() * 0.9;
    q.setFromAxisAngle(up, rng() * Math.PI * 2);
    m.compose(
      new THREE.Vector3(x, terrainHeight(x, z) - 0.1, z),
      q,
      new THREE.Vector3(s, s, s)
    );
    trunks.setMatrixAt(count, m);
    crowns.setMatrixAt(count, m);
    colliders.circles.push({ x, z, r: 0.35 * s });
    count++;
  }
  trunks.count = crowns.count = count;
  group.add(trunks, crowns);

  // 石頭(荒野)
  const ROCK_COUNT = 110;
  const rockGeo = new THREE.DodecahedronGeometry(0.6, 0);
  const rockMat = new THREE.MeshLambertMaterial({ color: '#6e6a60' });
  const rocks = new THREE.InstancedMesh(rockGeo, rockMat, ROCK_COUNT);
  rocks.castShadow = true;
  let rc = 0;
  for (let tries = 0; tries < 1500 && rc < ROCK_COUNT; tries++) {
    const x = (rng() * 2 - 1) * half;
    const z = (rng() * 2 - 1) * half;
    const w = biomeWeights(x, z);
    if (w.wild < 0.6) continue;
    if (Math.hypot(x - LAKE.x, z - LAKE.z) < LAKE.r) continue;
    const s = 0.4 + rng() * 1.4;
    q.setFromEuler(new THREE.Euler(rng() * 3, rng() * 3, rng() * 3));
    m.compose(
      new THREE.Vector3(x, terrainHeight(x, z) + s * 0.2, z),
      q,
      new THREE.Vector3(s, s * (0.6 + rng() * 0.5), s)
    );
    rocks.setMatrixAt(rc, m);
    rc++;
  }
  rocks.count = rc;
  group.add(rocks);
}

// 與樹幹(圓)和建築/車輛(矩形)的推擠碰撞,玩家與敵人共用
export function resolveColliders(p, R) {
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
}

// 2D 視線遮擋:線段是否穿過任何建築(潛行/AI 視覺用)
export function losBlocked(x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  for (const b of colliders.boxes) {
    if (b.noLos) continue; // 低矮建造物(尖刺/箱/床)不擋視線
    let tmin = 0, tmax = 1;
    // slab test x
    if (Math.abs(dx) < 1e-9) {
      if (x1 < b.minX || x1 > b.maxX) continue;
    } else {
      let t1 = (b.minX - x1) / dx, t2 = (b.maxX - x1) / dx;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
    }
    // slab test z
    if (Math.abs(dz) < 1e-9) {
      if (z1 < b.minZ || z1 > b.maxZ) continue;
    } else {
      let t1 = (b.minZ - z1) / dz, t2 = (b.maxZ - z1) / dz;
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      if (tmin > tmax) continue;
    }
    return true;
  }
  return false;
}

export function insideAnyBox(x, z, margin = 0) {
  for (const b of colliders.boxes) {
    if (x > b.minX - margin && x < b.maxX + margin &&
        z > b.minZ - margin && z < b.maxZ + margin) return true;
  }
  return false;
}

// 可重現的偽隨機,確保每次載入地景一致
export function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
