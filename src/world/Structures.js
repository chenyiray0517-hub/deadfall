import * as THREE from '../lib/three.js';
import {
  TERRAIN_SIZE, WORLD_SCALE, AREA_SCALE, terrainHeight, biomeWeights, roadMask, mainRoadCenter,
  colliders, insideAnyBox, mulberry32,
} from './Terrain.js';
import { HOUSE_TYPES, TOWER_TYPES, buildInterior, finishInteriors, interiorRooms } from './Interiors.js';

// 建築位置登記,供 LootSpawner 在附近放物資點
export const structureSpots = []; // {x, z, kind: 'house'|'barn'|'building'|'car'}

const matBarn = new THREE.MeshLambertMaterial({ color: '#7a3b30' });
const matBarnRoof = new THREE.MeshLambertMaterial({ color: '#4a3a30' });

function addBoxCollider(x, z, w, d) {
  colliders.boxes.push({ minX: x - w / 2, maxX: x + w / 2, minZ: z - d / 2, maxZ: z + d / 2 });
}

// 已放建築的門前淨空區:之後的建築/車輛不能壓進來,不然門口會被擋死
const doorZones = [];
function reserveDoorZone() {
  const room = interiorRooms[interiorRooms.length - 1];
  if (!room) return;
  const cx = (room.minX + room.maxX) / 2, cz = (room.minZ + room.maxZ) / 2;
  const nx = room.doorX - cx, nz = room.doorZ - cz;
  const d = Math.hypot(nx, nz) || 1;
  const ox = room.doorX + (nx / d) * 2.2, oz = room.doorZ + (nz / d) * 2.2;
  doorZones.push({
    minX: Math.min(room.doorX, ox) - 1.4, maxX: Math.max(room.doorX, ox) + 1.4,
    minZ: Math.min(room.doorZ, oz) - 1.4, maxZ: Math.max(room.doorZ, oz) + 1.4,
  });
}
function hitsDoorZone(x, z, w, d) {
  return doorZones.some((r) =>
    x + w / 2 > r.minX && x - w / 2 < r.maxX &&
    z + d / 2 > r.minZ && z - d / 2 < r.maxZ);
}

// 四角錐屋頂(Cone 4 邊轉 45 度壓成矩形)
function makeRoof(w, d, h, mat) {
  const roof = new THREE.Mesh(new THREE.ConeGeometry(0.72, h, 4), mat);
  roof.rotation.y = Math.PI / 4;
  roof.scale.set(w, 1, d);
  return roof;
}

function makeHouse(w, d, hWall, wallMat, roofMat) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(w, hWall, d), wallMat);
  body.position.y = hWall / 2;
  body.castShadow = body.receiveShadow = true;
  const roof = makeRoof(w + 0.6, d + 0.6, 1.8, roofMat);
  roof.position.y = hWall + 0.9;
  roof.castShadow = true;
  g.add(body, roof);
  return g;
}

export function createStructures() {
  const group = new THREE.Group();
  const rng = mulberry32(97531);
  const half = TERRAIN_SIZE / 2 - 15;

  // ── 鄉村:農舍 + 穀倉,沿公路兩側散布 ──
  const HOUSE_MAX = 10 * AREA_SCALE;
  const BARN_MAX = 4 * AREA_SCALE;
  let houses = 0, barns = 0;
  for (let tries = 0; tries < 3000 * AREA_SCALE && (houses < HOUSE_MAX || barns < BARN_MAX); tries++) {
    const x = (rng() * 2 - 1) * half;
    const z = (rng() * 2 - 1) * half;
    const w = biomeWeights(x, z);
    if (w.rural < 0.85) continue;
    const distRoad = Math.abs(z - mainRoadCenter(x));
    if (distRoad < 10 || distRoad > 70) continue; // 靠路但不壓路
    if (insideAnyBox(x, z, 8)) continue;

    const isBarn = barns < BARN_MAX && rng() < 0.35;
    if (!isBarn && houses >= HOUSE_MAX) continue;
    if (isBarn) {
      if (hitsDoorZone(x, z, 9, 7)) continue;
      // 穀倉維持實心(室內之後有需要再開)
      const b = makeHouse(8, 6, 4.5, matBarn, matBarnRoof);
      b.position.set(x, terrainHeight(x, z), z);
      group.add(b);
      addBoxCollider(x, z, 8, 6);
      structureSpots.push({ x, z, kind: 'barn' });
      barns++;
    } else {
      // 鄉村房 3 種,有室內可搜刮(M8);門面朝向公路那一側
      const type = HOUSE_TYPES[Math.floor(rng() * HOUSE_TYPES.length)];
      const rot = z > mainRoadCenter(x) ? 2 : 0;
      if (hitsDoorZone(x, z, type.w + 1, type.d + 1)) continue;
      buildInterior(group, type, x, z, rot);
      reserveDoorZone();
      structureSpots.push({ x, z, kind: 'house' });
      houses++;
    }
  }

  // ── 城市:棋盤街區裡的大樓 ──
  const GRID = 52;
  const greys = ['#6e6e72', '#7a7570', '#5f6266', '#8a8580', '#65605c'];
  const buildingMats = greys.map((c) => new THREE.MeshLambertMaterial({ color: c }));
  const start = -Math.floor(half / GRID) * GRID;
  for (let bx = start; bx < half; bx += GRID) {
    for (let bz = start; bz < half; bz += GRID) {
      // 街區中心(路網在格線上,中心即格心)
      const cx = bx + GRID / 2;
      const cz = bz + GRID / 2;
      if (Math.abs(cx) > half || Math.abs(cz) > half) continue;
      const w = biomeWeights(cx, cz);
      if (w.urban < 0.8) continue;
      if (Math.abs(cz - mainRoadCenter(cx)) < 14) continue; // 讓開主幹道

      const n = 1 + Math.floor(rng() * 2);
      for (let i = 0; i < n; i++) {
        const ox = (rng() - 0.5) * 16;
        const oz = (rng() - 0.5) * 16;
        const x = cx + ox, z = cz + oz;
        // 大樓 3 種,一樓有室內可搜刮(M8);上層維持實心樓體
        const type = TOWER_TYPES[Math.floor(rng() * TOWER_TYPES.length)];
        const bh2 = 8 + rng() * 20;
        const rot = Math.floor(rng() * 4);
        const uw = rot % 2 ? type.d : type.w;
        const ud = rot % 2 ? type.w : type.d;
        // 間距按實際樓寬算(留 2.5m 縫),並避開別棟的門前淨空區
        if (insideAnyBox(x, z, Math.max(uw, ud) / 2 + 2.5)) continue;
        if (hitsDoorZone(x, z, uw + 1, ud + 1)) continue;
        const yb = buildInterior(group, type, x, z, rot);
        reserveDoorZone();
        const upper = new THREE.Mesh(
          new THREE.BoxGeometry(uw, bh2 - type.h, ud),
          buildingMats[Math.floor(rng() * buildingMats.length)]
        );
        upper.position.set(x, yb + type.h + (bh2 - type.h) / 2, z);
        upper.castShadow = upper.receiveShadow = true;
        group.add(upper);
        structureSpots.push({ x, z, kind: 'building' });
      }
    }
  }

  // ── 廢棄車:沿主幹道 ──
  const carBody = new THREE.BoxGeometry(4.2, 1.1, 1.9);
  const carCabin = new THREE.BoxGeometry(2.2, 0.8, 1.7);
  const carColors = ['#6a4a3a', '#4a5a6a', '#5a5040', '#703830'];
  for (let x = -60 * WORLD_SCALE; x < half; x += 22 + rng() * 30) {
    if (rng() < 0.45) continue;
    const z = mainRoadCenter(x) + (rng() - 0.5) * 5;
    if (hitsDoorZone(x, z, 5.5, 4)) continue;
    const y = terrainHeight(x, z);
    const mat = new THREE.MeshLambertMaterial({ color: carColors[Math.floor(rng() * carColors.length)] });
    const body = new THREE.Mesh(carBody, mat);
    body.position.set(x, y + 0.75, z);
    body.rotation.y = (rng() - 0.5) * 0.6;
    body.castShadow = true;
    const cabin = new THREE.Mesh(carCabin, mat);
    cabin.position.set(-0.3, 0.9, 0);
    body.add(cabin);
    group.add(body);
    addBoxCollider(x, z, 4.4, 3);
    structureSpots.push({ x, z, kind: 'car' });
  }

  finishInteriors(group); // 室內牆/家具烘成 InstancedMesh
  return group;
}
