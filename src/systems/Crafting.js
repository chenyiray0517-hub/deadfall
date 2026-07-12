import * as THREE from '../lib/three.js';
import { ITEMS } from '../player/Items.js';
import { terrainHeight } from '../world/Terrain.js';

// 配方(規格 7.1 的起步集,之後靠說明書解鎖更多)
export const RECIPES = [
  { id: 'bandage', name: '繃帶', cost: { cloth: 2 }, gives: { bandage: 1 } },
  { id: 'campfire', name: '營火', cost: { wood: 3 }, place: true },
  { id: 'boil', name: '煮沸水', cost: { dirty: 1 }, gives: { boiled: 1 }, needFire: true },
  { id: 'bat', name: '木棒', cost: { wood: 2 }, gives: { bat: 1 } },
  { id: 'bow', name: '自製弓', cost: { wood: 3, cloth: 1 }, gives: { bow: 1 } },
  { id: 'arrows', name: '木箭×3', cost: { wood: 1 }, gives: { arrow: 3 } },
];

export function costText(recipe) {
  return Object.entries(recipe.cost)
    .map(([id, n]) => `${ITEMS[id].name}×${n}`)
    .join(' + ');
}

export function canCraft(recipe, inv, nearFire) {
  if (recipe.needFire && !nearFire) return false;
  return Object.entries(recipe.cost).every(([id, n]) => inv.count(id) >= n);
}

// 場上的營火 {x, z, light, flame, phase}
export const campfires = [];

export function isNearFire(pos, dist = 3.5) {
  return campfires.some((f) => Math.hypot(pos.x - f.x, pos.z - f.z) < dist);
}

// 製作;成功回傳訊息,失敗回傳 null
export function craft(recipe, inv, { nearFire, playerPos, yaw, scene }) {
  if (!canCraft(recipe, inv, nearFire)) return null;
  for (const [id, n] of Object.entries(recipe.cost)) inv.remove(id, n);

  if (recipe.place) {
    // 營火直接放在面前
    const x = playerPos.x - Math.sin(yaw) * 2;
    const z = playerPos.z - Math.cos(yaw) * 2;
    placeCampfire(scene, x, z);
    return '生起了營火';
  }
  const gained = [];
  for (const [id, n] of Object.entries(recipe.gives)) {
    inv.add(id, n);
    gained.push(`${ITEMS[id].name}×${n}`);
  }
  return `製作了 ${gained.join('、')}`;
}

export function placeCampfire(scene, x, z) {
  const y = terrainHeight(x, z);
  const g = new THREE.Group();
  // 三根柴堆
  const logGeo = new THREE.CylinderGeometry(0.07, 0.09, 0.9, 5);
  const logMat = new THREE.MeshLambertMaterial({ color: '#4a3826' });
  for (let i = 0; i < 3; i++) {
    const log = new THREE.Mesh(logGeo, logMat);
    log.rotation.set(Math.PI / 2.4, 0, (i / 3) * Math.PI * 2);
    log.position.y = 0.18;
    g.add(log);
  }
  // 火焰
  const flame = new THREE.Mesh(
    new THREE.ConeGeometry(0.22, 0.6, 6),
    new THREE.MeshBasicMaterial({ color: '#ff9a3c', transparent: true, opacity: 0.9 })
  );
  flame.position.y = 0.45;
  g.add(flame);
  const light = new THREE.PointLight('#ff9a3c', 1.4, 14);
  light.position.y = 0.8;
  g.add(light);
  g.position.set(x, y, z);
  scene.add(g);
  campfires.push({ x, z, light, flame, phase: Math.random() * 10 });
}

// 火光搖曳
export function updateCampfires(t) {
  for (const f of campfires) {
    f.light.intensity = 1.3 + Math.sin(t * 9 + f.phase) * 0.25 + Math.sin(t * 23 + f.phase) * 0.1;
    f.flame.scale.setScalar(1 + Math.sin(t * 11 + f.phase) * 0.12);
  }
}
