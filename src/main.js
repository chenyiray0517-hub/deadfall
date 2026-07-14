import * as THREE from './lib/three.js';
import { createTerrain, regionName, terrainHeight } from './world/Terrain.js';
import { createStructures } from './world/Structures.js';
import { spawnLoot } from './world/LootSpawner.js';
import { TimeSystem } from './core/TimeSystem.js';
import { Player } from './player/Player.js';
import { Stats } from './player/Stats.js';
import { Skills, SKILL_DEFS, PROF_DEFS, XP } from './player/Skills.js';
import { Inventory, ITEMS, quickbarIds } from './player/Items.js';
import { RECIPES, costText, canCraft, craft, isNearFire, updateCampfires } from './systems/Crafting.js';
import { findInteraction, doInteract } from './systems/Interaction.js';
import { EnemyManager } from './entities/Zombies.js';
import { Combat } from './systems/Combat.js';
import { Buildings, BUILDABLES, sleepUntilMorning, dropHalfInventory } from './systems/Building.js';
import { peekSave, clearSave, saveGame, loadGame } from './systems/SaveSystem.js';
import { VehicleManager } from './systems/Vehicles.js';
import { loadItemModels } from './lib/glb.js';

// ── 基礎場景 ──
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
document.body.appendChild(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(72, innerWidth / innerHeight, 0.1, 600);

// 物品 3D 模型(莓果串/罐頭/烤肉,assets/models/*.glb);載入失敗自動退回程序化外觀
const itemModels = await loadItemModels();

// 順序:先建築(登記碰撞箱)→ 地形(樹避開建築)→ 物資點(靠建築擺)→ 敵人(避開全部)
scene.add(createStructures());
scene.add(createTerrain());
scene.add(spawnLoot(itemModels));
const timeSystem = new TimeSystem(scene);
const stats = new Stats();
const skills = new Skills();
stats.skills = skills; // Items/Player/Stats 內部經由 stats 取用技能加成
skills.onProf = (msg) => toast(`⬆ ${msg}`); // 熟練度升級提示(規格 7.7 用進廢退軌)
const inventory = new Inventory();
const player = new Player(camera, renderer.domElement, stats);
const enemies = new EnemyManager(scene);
const buildings = new Buildings(scene);
buildings.skills = skills;
buildings.onDestroyed = (b) => toast(`⚠ ${b.def.name}被摧毀了!`);
const vehicles = new VehicleManager(scene); // 載具(M8c;要在 createStructures 之後,拿廢棄車位置)
vehicles.toast = toast;
enemies.interceptAttack = (dmg) => vehicles.interceptAttack(dmg); // 開車時感染者打車體
scene.add(camera); // 第一人稱武器模型掛在相機上
const combat = new Combat({
  camera, player, stats, inventory, enemies, toast, skills, models: itemModels,
  isNight: () => timeSystem.nightFactor,
  onHit: (killed, zb) => {
    hitmark(killed);
    if (killed) {
      toast(`擊殺了${zb.def.name}`);
      gainXp(zb.def.xp || 10);
    }
  },
});

// 吃/喝時第一人稱手上短暫舉起物品模型(莓果/罐頭/烤肉/水壺)
const CONSUME_POSE = {
  berry: { scale: 0.2, rot: [0, 0, 0] },
  canned: { scale: 0.12, rot: [0, 0.4, 0] },
  cooked: { scale: 0.36, rot: [0.3, 1.15, 0] }, // 烤肉串斜握
  bottled: { scale: 0.2, rot: [0, 0.5, 0] },    // 軍用水壺(背帶)
  dirty: { scale: 0.18, rot: [0, 0.5, 0] },     // 軟木塞水壺
  boiled: { scale: 0.18, rot: [0, 0.5, 0] },
};
const CONSUME_DUR = 0.9;
const consumeProp = new THREE.Group();
consumeProp.visible = false;
camera.add(consumeProp);
let consumeT = -1; // >= 0 表示動畫進行中
function showConsumeFx(id) {
  const model = itemModels?.[id];
  const pose = CONSUME_POSE[id];
  if (!model || !pose) return;
  while (consumeProp.children.length) consumeProp.remove(consumeProp.children[0]);
  const mesh = new THREE.Mesh(model.geometry, model.material);
  mesh.scale.setScalar(pose.scale);
  mesh.rotation.set(...pose.rot);
  consumeProp.add(mesh);
  consumeProp.visible = true;
  consumeT = 0;
}
function updateConsumeFx(dt) {
  if (consumeT < 0) return;
  consumeT += dt;
  const k = Math.min(1, consumeT / CONSUME_DUR);
  const s = Math.sin(k * Math.PI); // 舉到嘴邊再放下
  consumeProp.position.set(0.26 - 0.12 * s, -0.42 + 0.2 * s, -0.55 + 0.1 * s);
  consumeProp.rotation.z = 0.15 * s;
  if (k >= 1) {
    consumeT = -1;
    consumeProp.visible = false;
  }
}

// 加 XP;升級就提示(技能樹 M8)
function gainXp(n) {
  if (skills.addXp(n) > 0) toast(`⬆ 升到 Lv${skills.level}!獲得技能點——按 K 打開技能樹`);
}

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ── HUD 元素 ──
const $ = (id) => document.getElementById(id);
const fpsEl = $('fps'), clockEl = $('clock'), crosshairEl = $('crosshair'), xpEl = $('xp');
const overlayEl = $('start-overlay'), statsEl = $('stats'), deathEl = $('death-overlay');
const vigHpEl = $('vig-hp'), vigThirstEl = $('vig-thirst');
const effectsEl = $('effects'), quickbarEl = $('quickbar');
const promptEl = $('prompt'), toastsEl = $('toasts'), panelEl = $('panel');
const weaponEl = $('weapon'), hitmarkEl = $('hitmark'), vehicleEl = $('vehicle');
const bars = {
  hp: document.querySelector('#bar-hp i'),
  hunger: document.querySelector('#bar-hunger i'),
  thirst: document.querySelector('#bar-thirst i'),
  stamina: document.querySelector('#bar-stamina i'),
};

overlayEl.addEventListener('click', () => {
  if (!awaitingChoice) player.lock(); // 有存檔時先選「繼續/重來」
});
$('respawn-btn').addEventListener('click', () => {
  if (buildings.respawnPoint()) doRespawn();
  else location.reload();
});
$('restart-btn').addEventListener('click', () => location.reload());

// 床邊重生(規格 7.10 劇情模式:掉落部分物品)
function doRespawn() {
  const bed = buildings.respawnPoint();
  dropHalfInventory(inventory);
  stats.hp = 50;
  stats.stamina = 60;
  stats.exhausted = false;
  stats.hunger = Math.max(stats.hunger, 30);
  stats.thirst = Math.max(stats.thirst, 30);
  stats.infection = 0;
  stats.effects = [];
  stats.alive = true;
  stats.deathCause = '';
  player.position.set(bed.x, terrainHeight(bed.x, bed.z), bed.z);
  player.velocityY = 0;
  player.onGround = true;
  enemies.calmAll();
  deathShown = false;
  deathEl.classList.add('hidden');
  overlayEl.classList.remove('hidden'); // 點擊重新鎖定滑鼠
  updateQuickbar();
  toast('你在床邊醒來……身上的東西掉了一半');
  if (canSave) saveGame(saveCtx); // 重生後立刻存,關頁面也不會退回死前狀態
}
document.addEventListener('pointerlockchange', () => {
  const locked = document.pointerLockElement === renderer.domElement;
  if (stats.alive) overlayEl.classList.toggle('hidden', locked);
  crosshairEl.classList.toggle('hidden', !locked);
});

function toast(msg) {
  const div = document.createElement('div');
  div.className = 'toast';
  div.textContent = msg;
  toastsEl.appendChild(div);
  setTimeout(() => div.remove(), 2400);
}

// 命中標記(擊殺時變紅)
function hitmark(killed) {
  hitmarkEl.style.color = killed ? '#c84a3c' : '#e5a13c';
  hitmarkEl.classList.remove('hidden');
  clearTimeout(hitmark._t);
  hitmark._t = setTimeout(() => hitmarkEl.classList.add('hidden'), 120);
}

// ── 面板(製作/建造/儲物箱/技能樹共用同一塊 UI)──
let panelMode = null; // null | 'craft' | 'build' | 'chest' | 'skills'
let chestRef = null;
let chestActions = [];

function matsLine() {
  return [...inventory.items.entries()]
    .map(([id, n]) => `${ITEMS[id].icon}${ITEMS[id].name}×${n}`)
    .join('　') || '(空空如也)';
}

function renderCraftPanel() {
  const nearFire = isNearFire(player.position);
  const recipes = RECIPES.map((r, i) => {
    const ok = canCraft(r, inventory, nearFire, skills);
    const fire = r.needFire ? (nearFire ? '(營火旁 ✓)' : '(需靠近營火)') : '';
    return `<div class="recipe ${ok ? '' : 'no'}"><span class="k">[${i + 1}]</span> ${r.name} <span class="req">${costText(r, skills)} ${fire}</span></div>`;
  }).join('');
  panelEl.innerHTML = `<h2>背包 / 製作</h2><div class="mats">${matsLine()}</div>${recipes}<div class="hint">按數字鍵製作 · Tab 關閉</div>`;
}

function renderBuildPanel() {
  const hpMult = skills.buildHpMult();
  const rows = BUILDABLES.map((b, i) => {
    const ok = buildings.canAfford(b, inventory);
    return `<div class="recipe ${ok ? '' : 'no'}"><span class="k">[${i + 1}]</span> ${b.name} <span class="req">${costText(b, skills)} · 耐久 ${Math.round(b.hp * hpMult)}</span></div>`;
  }).join('');
  panelEl.innerHTML = `<h2>建造</h2><div class="mats">${matsLine()}</div>${rows}<div class="hint">按數字選擇 → 左鍵放置(可連放) · 右鍵/B 取消 · Tab 關閉</div>`;
}

function renderSkillsPanel() {
  let lastBranch = null;
  const rows = SKILL_DEFS.map((s, i) => {
    const lv = skills.levelOf(s.id);
    const maxed = lv >= s.max;
    const ok = skills.canUp(s.id);
    const header = s.branch !== lastBranch ? `<div class="mats" style="margin:10px 0 2px">── ${s.branch} ──</div>` : '';
    lastBranch = s.branch;
    const state = maxed ? '<span style="color:#8a9a6b">已滿級</span>' : s.desc(lv + 1);
    return `${header}<div class="recipe ${ok ? '' : 'no'}"><span class="k">[${i + 1}]</span> ${s.icon} ${s.name} Lv${lv}/${s.max} <span class="req">${state}</span></div>`;
  }).join('');
  // 熟練度軌:做什麼練什麼,不吃點數(規格 7.7 雙軌的另一半)
  const profRows = PROF_DEFS.map((p) => {
    const lv = skills.profLevel(p.id);
    const prog = skills.profProgress(p.id);
    const state = prog
      ? `${p.desc(lv + 1)}(${Math.floor(prog.cur)}/${prog.need} ${p.unit})`
      : '<span style="color:#8a9a6b">已滿級</span>';
    const now = lv > 0 ? ` <span style="color:#8a9a6b">${p.desc(lv)}</span>` : '';
    return `<div class="recipe no">${p.icon} ${p.name} Lv${lv}/5${now} <span class="req">下一級:${state}</span></div>`;
  }).join('');
  panelEl.innerHTML = `<h2>技能樹</h2>
    <div class="mats">Lv${skills.level} · XP ${Math.floor(skills.xp)}/${skills.xpNeed()} · 技能點 <span style="color:#e5a13c">${skills.points}</span></div>
    ${rows}
    <div class="mats" style="margin:10px 0 2px">── 熟練度(做什麼練什麼)──</div>${profRows}
    <div class="hint">按數字鍵加點(每點 1 技能點) · K/Tab 關閉</div>`;
}

function renderChestPanel() {
  chestActions = [];
  let k = 0;
  const line = (id, n, act) => {
    chestActions.push(act);
    return `<div class="recipe"><span class="k">[${++k}]</span> ${ITEMS[id].icon}${ITEMS[id].name}×${n}</div>`;
  };
  const invRows = [...inventory.items.entries()].slice(0, 5)
    .map(([id, n]) => line(id, n, { dir: 'in', id })).join('') || '<div class="recipe no">(空)</div>';
  const boxRows = [...chestRef.storage.items.entries()].slice(0, 9 - k)
    .map(([id, n]) => line(id, n, { dir: 'out', id })).join('') || '<div class="recipe no">(空)</div>';
  panelEl.innerHTML = `<h2>儲物箱</h2><div class="mats">按數字整疊存入/取出(死亡不會掉落箱內物品)</div>
    <div class="mats">背包:</div>${invRows}<div class="mats">箱內:</div>${boxRows}<div class="hint">Tab 關閉</div>`;
}

function setPanel(mode) {
  panelMode = mode;
  panelEl.classList.toggle('hidden', !mode);
  if (mode) buildings.cancelPlacing(); // 開面板就退出建造模式
  if (mode === 'craft') renderCraftPanel();
  else if (mode === 'build') renderBuildPanel();
  else if (mode === 'chest') renderChestPanel();
  else if (mode === 'skills') renderSkillsPanel();
}

function doChestTransfer(digit) {
  const act = chestActions[digit - 1];
  if (!act) return;
  const from = act.dir === 'in' ? inventory : chestRef.storage;
  const to = act.dir === 'in' ? chestRef.storage : inventory;
  const n = from.count(act.id);
  if (n > 0) {
    from.remove(act.id, n);
    to.add(act.id, n);
  }
  renderChestPanel();
  updateQuickbar();
}

// ── 鍵盤 ──
addEventListener('keydown', (e) => {
  if (e.code === 'Tab') {
    e.preventDefault();
    if (player.locked && stats.alive && !vehicles.driving) setPanel(panelMode ? null : 'craft');
    return;
  }
  if (!player.locked || !stats.alive) return;

  if (e.code === 'KeyT') {
    const scale = timeSystem.toggleSpeed();
    toast(`時間流速 x${scale}`);
    return;
  }
  // 開車中:只吃 E(下車)/R(加油),其餘按鍵不作用(M8c)
  if (vehicles.driving) {
    if (e.code === 'KeyE') {
      toast(vehicles.exitVehicle(player));
      vehicleEl.classList.add('hidden');
      combat.viewmodel.visible = true;
      updateQuickbar();
    } else if (e.code === 'KeyR') {
      const msg = vehicles.refuel(inventory);
      if (msg) toast(msg);
    }
    return;
  }
  if (e.code === 'KeyK') {
    // 技能樹(規格 7.7)
    setPanel(panelMode === 'skills' ? null : 'skills');
    return;
  }
  if (e.code === 'KeyB') {
    // 建造(規格第 8 章)
    if (buildings.placing) {
      buildings.cancelPlacing();
      toast('取消建造');
    } else {
      setPanel(panelMode === 'build' ? null : 'build');
    }
    return;
  }
  if (e.code === 'KeyE') {
    const sel = findInteraction(player, inventory, enemies, buildings, vehicles);
    if (!sel) return;
    if (sel.kind === 'door') { buildings.toggleDoor(sel.b); return; }
    if (sel.kind === 'vehicle' || sel.kind === 'carwreck') {
      const res = vehicles.interact(sel, inventory, player, stats);
      if (res.msg) toast(res.msg);
      if (res.xp) gainXp(res.xp);
      if (vehicles.driving) combat.viewmodel.visible = false; // 第三人稱視角藏起手上武器
      updateQuickbar();
      return;
    }
    if (sel.kind === 'chest') { chestRef = sel.b; setPanel('chest'); return; }
    if (sel.kind === 'bed') { trySleep(sel.b); return; }
    const msg = doInteract(sel, inventory, stats);
    if (msg) {
      toast(msg);
      if (sel.kind === 'corpse') gainXp(XP.corpse);
      else if (sel.kind === 'loot') {
        gainXp(sel.point.type === 'berry' || sel.point.type === 'stick' ? XP.gather : XP.loot);
      }
    }
    if (panelMode === 'craft') renderCraftPanel();
    return;
  }
  const digit = e.code.startsWith('Digit') ? parseInt(e.code.slice(5)) : 0;
  if (digit >= 1) {
    if (panelMode === 'craft') {
      // 數字 = 製作
      const recipe = RECIPES[digit - 1];
      if (recipe) {
        const msg = craft(recipe, inventory, {
          nearFire: isNearFire(player.position),
          playerPos: player.position,
          yaw: player.yaw,
          scene,
          skills,
        });
        toast(msg || '材料不足或需要靠近營火');
        if (msg) {
          gainXp(XP.craft);
          if (recipe.needFire) skills.addProf('cook', 1); // 🍳 營火烹飪練熟練
        }
        renderCraftPanel();
      }
    } else if (panelMode === 'skills') {
      // 數字 = 技能加點
      const def = SKILL_DEFS[digit - 1];
      if (def) {
        const msg = skills.up(def.id);
        if (msg) toast(msg);
        else toast(skills.points <= 0 ? '沒有技能點——升級才會獲得' : '這個技能已滿級');
        renderSkillsPanel();
      }
    } else if (panelMode === 'build') {
      // 數字 = 選擇建造物,進入放置模式
      const def = BUILDABLES[digit - 1];
      if (def) {
        buildings.startPlacing(def);
        panelMode = null;
        panelEl.classList.add('hidden');
        toast(`左鍵放置${def.name},右鍵/B 取消`);
      }
    } else if (panelMode === 'chest') {
      doChestTransfer(digit);
    } else {
      // 快捷欄:武器 = 裝備/收起,消耗品 = 使用
      const id = quickbarIds(inventory)[digit - 1];
      if (!id) return;
      if (ITEMS[id].weapon) {
        combat.equip(id);
        updateQuickbar();
      } else {
        const msg = inventory.use(id, stats);
        if (msg) {
          toast(`${ITEMS[id].name}:${msg}`);
          showConsumeFx(id);
        }
      }
    }
  }
});

// 滑鼠左鍵:建造模式 = 放置,平時 = 攻擊(規格第 8 章)
addEventListener('mousedown', (e) => {
  if (!player.locked || !stats.alive || panelMode || vehicles.driving) return;
  if (e.button === 0) {
    if (buildings.placing) {
      const msg = buildings.tryPlace(inventory);
      if (msg) {
        toast(msg);
        gainXp(XP.build);
        updateQuickbar();
      }
    } else {
      combat.tryAttack(elapsed);
    }
  } else if (e.button === 2 && buildings.placing) {
    buildings.cancelPlacing();
    toast('取消建造');
  }
});
addEventListener('contextmenu', (e) => {
  if (player.locked) e.preventDefault();
});

// 睡覺:夜晚快轉到清晨,床 = 重生點(規格 7.2)
function trySleep(bed) {
  const t = timeSystem.timeOfDay;
  if (t >= 5 && t < 20) {
    toast('還不睏——天黑(20:00)後才能睡');
    return;
  }
  if (enemies.nearestChaserDist(player.position) < 45) {
    toast('感染者就在附近,睡不著!');
    return;
  }
  buildings.homeBed = bed;
  sleepUntilMorning(timeSystem, stats);
  toast(`睡了一覺——第 ${timeSystem.day} 天清晨,重生點已更新`);
  if (canSave && saveGame(saveCtx)) toast('💾 已存檔');
}

// ── 開發用參數 ──
const params = new URLSearchParams(location.search);
if (params.has('t')) timeSystem.timeOfDay = parseFloat(params.get('t')) || 6;
if (params.has('day')) timeSystem.day = parseInt(params.get('day')) || 1;
if (params.has('noui')) { overlayEl.classList.add('hidden'); statsEl.classList.remove('hidden'); quickbarEl.classList.remove('hidden'); }
for (const k of ['hp', 'hunger', 'thirst', 'stamina', 'infection']) {
  if (params.has(k)) stats[k] = Math.max(0, Math.min(100, parseFloat(params.get(k)) || 0));
}
if (params.has('pos')) {
  const [px, pz] = params.get('pos').split(',').map(Number);
  if (Number.isFinite(px) && Number.isFinite(pz)) player.position.set(px, 0, pz);
}
if (params.has('yaw')) player.yaw = (parseFloat(params.get('yaw')) || 0) * Math.PI / 180;
if (params.has('xp')) skills.addXp(parseInt(params.get('xp')) || 0); // 測試技能樹用
if (params.has('panel')) setPanel(params.get('panel')); // 直接開指定面板(截圖驗證 UI 用)
if (params.has('prop')) { // 吃東西手持模型凍在動畫中段(截圖驗證用)
  showConsumeFx(params.get('prop'));
  consumeT = CONSUME_DUR * 0.5;
  updateConsumeFx(0);
}
if (params.has('items')) { // ?items=cloth:4,wood:5
  for (const part of params.get('items').split(',')) {
    const [id, n] = part.split(':');
    if (ITEMS[id]) inventory.add(id, parseInt(n) || 1);
  }
}
if (params.has('equip')) combat.equip(params.get('equip')); // 配 ?items= 用,截圖驗證手持模型

// ── 存讀檔(M7.5)──
// 自動存檔(20 秒/睡覺/關頁面);有存檔時開始畫面可選「繼續上次」
// ?nosave=1 = 不讀不存(測試/截圖用,免得污染正常存檔)
const canSave = !params.has('nosave');
const saveCtx = { timeSystem, stats, inventory, player, combat, buildings, enemies, scene, skills, vehicles };
const savedData = canSave ? peekSave() : null;
let awaitingChoice = !!savedData;

function chooseDone() {
  awaitingChoice = false;
  $('save-btns').classList.add('hidden');
  $('click-hint').classList.remove('hidden');
  player.lock();
}
if (savedData) {
  $('save-btns').classList.remove('hidden');
  $('click-hint').classList.add('hidden');
  $('continue-btn').textContent = `▶ 繼續上次(第 ${savedData.time.day} 天)`;
  $('continue-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    loadGame(savedData, saveCtx);
    if (stats.infection > 0) infectionWarned = true; // 讀檔別再跳一次感染警告
    updateQuickbar();
    chooseDone();
    toast(`歡迎回來——第 ${timeSystem.day} 天 ${timeSystem.clockText}`);
  });
  $('newgame-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    clearSave();
    chooseDone();
  });
}
addEventListener('beforeunload', () => {
  if (canSave && started && stats.alive) saveGame(saveCtx);
});

// ── HUD 更新 ──
function updateStatsHud() {
  bars.hp.style.transform = `scaleX(${stats.hp / 100})`;
  bars.hunger.style.transform = `scaleX(${stats.hunger / 100})`;
  bars.thirst.style.transform = `scaleX(${stats.thirst / 100})`;
  bars.stamina.style.transform = `scaleX(${stats.stamina / stats.staminaMax})`; // 上限會被技能提高
  bars.hp.parentElement.classList.toggle('low', stats.hp < 25);
  bars.hunger.parentElement.classList.toggle('low', stats.hunger < 25);
  bars.thirst.parentElement.classList.toggle('low', stats.thirst < 25);
  bars.stamina.parentElement.classList.toggle('low', stats.exhausted);
  vigHpEl.style.opacity = stats.hp < 30 ? (1 - stats.hp / 30) * 0.9 : 0;
  vigThirstEl.style.opacity = stats.thirst < 25 ? (1 - stats.thirst / 25) * 0.85 : 0;
}

function updateQuickbar() {
  quickbarEl.innerHTML = quickbarIds(inventory).map((id, i) => {
    const n = inventory.count(id);
    const sel = combat.equipped === id ? ' sel' : '';
    return `<div class="slot${sel}"><span class="key">${i + 1}</span>${ITEMS[id].icon}<span class="cnt">${ITEMS[id].weapon ? '' : n}</span></div>`;
  }).join('');
  weaponEl.textContent = combat.hudText();
  weaponEl.classList.toggle('hidden', !combat.equipped);
}

let infectionWarned = false;
function updateEffects() {
  const parts = stats.effects
    .map((e) => `${e.label}(剩 ${Math.max(0, e.until - stats.ageHours).toFixed(1)} 小時)`);
  if (stats.infection > 0) {
    const frozen = stats.hasEffect('antibiotic') ? '(凍結中)' : '';
    parts.unshift(`<span style="color:#c84a3c">🦠 感染 ${Math.ceil(stats.infection)}%${frozen}</span>`);
    if (!infectionWarned) {
      infectionWarned = true;
      toast('🦠 傷口感染了!抗生素能凍結惡化,血清才能根治');
    }
  }
  effectsEl.innerHTML = parts.join('　');
}

let deathShown = false;
function showDeath() {
  deathShown = true;
  document.exitPointerLock();
  if (vehicles.driving) { // 死在車上:先下車,重生才不會卡在駕駛狀態
    vehicles.exitVehicle(player);
    vehicleEl.classList.add('hidden');
    combat.viewmodel.visible = true;
  }
  buildings.cancelPlacing();
  panelMode = null;
  deathEl.querySelector('.cause').textContent = `死因:${stats.deathCause}`;
  deathEl.querySelector('.days').textContent = `存活了 ${timeSystem.day} 天`;
  const bed = buildings.respawnPoint();
  if (canSave && !bed) clearSave(); // 沒床 = 這一輪結束;有床則保留最後一次自動存檔
  $('respawn-btn').textContent = bed ? '在床邊醒來(掉落一半物品)' : '重新開始';
  $('restart-btn').classList.toggle('hidden', !bed);
  deathEl.classList.remove('hidden');
  overlayEl.classList.add('hidden');
  crosshairEl.classList.add('hidden');
  promptEl.classList.add('hidden');
  panelEl.classList.add('hidden');
}

// ── 遊戲迴圈 ──
const clock = new THREE.Clock();
let started = false;
let fpsFrames = 0, fpsTimer = 0, slowTimer = 0;
let lastXpDay = 0; // 存活天數 XP 的基準(0 = 首次進 loop 時初始化,讀檔天數也適用)
let elapsed = 0;
let autosaveTimer = 0;

function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(clock.getDelta(), 0.1);
  elapsed += dt;

  if (!started && player.locked) {
    started = true;
    statsEl.classList.remove('hidden');
    quickbarEl.classList.remove('hidden');
  }

  player.update(dt);
  vehicles.update(dt, {
    player, stats, enemies, camera, now: elapsed,
    onRam: (killed, zb) => {
      hitmark(killed);
      if (killed) {
        toast(`💥 撞飛了${zb.def.name}!`);
        gainXp(zb.def.xp || 10);
      }
    },
  });
  stats.update(dt, dt * timeSystem.hoursPerRealSecond);
  timeSystem.update(dt, player.position);
  enemies.update(dt, player, stats, timeSystem.nightFactor, elapsed, buildings);
  combat.update(dt);
  updateConsumeFx(dt);
  buildings.update(dt);
  if (buildings.placing) buildings.updateGhost(player, inventory);
  updateCampfires(elapsed);
  updateStatsHud();

  // 互動提示(每幀,便宜);建造模式改顯示放置說明;開車改顯示駕駛 HUD
  if (player.locked && stats.alive) {
    if (vehicles.driving) {
      const fuelHint = vehicles.driving.def.fuelMax > 0 ? ` · <b>R</b> 加油(⛽×${inventory.count('fuel')})` : '';
      promptEl.classList.remove('hidden');
      promptEl.innerHTML = `<b>E</b> 下車${fuelHint}`;
      vehicleEl.classList.remove('hidden');
      vehicleEl.textContent = vehicles.hudText();
    } else if (buildings.placing) {
      promptEl.classList.remove('hidden');
      promptEl.innerHTML = `<b>左鍵</b> 放置${buildings.placing.name}(${costText(buildings.placing)}) · <b>B</b> 取消`;
    } else {
      const sel = findInteraction(player, inventory, enemies, buildings, vehicles);
      promptEl.classList.toggle('hidden', !sel);
      if (sel) promptEl.innerHTML = `<b>E</b> ${sel.label}`;
    }
  } else {
    promptEl.classList.add('hidden');
  }
  if (!vehicles.driving) vehicleEl.classList.add('hidden');

  if (!stats.alive && !deathShown) showDeath();

  // 慢速 HUD(0.5 秒一次)
  fpsFrames++;
  fpsTimer += dt;
  slowTimer += dt;
  if (slowTimer >= 0.25) {
    slowTimer = 0;
    updateQuickbar();
    updateEffects();
    if (stats.alive && started) {
      // 屍潮夜襲檢查(規格 7.2)
      const horde = enemies.maybeHorde(timeSystem, player.position, elapsed);
      if (horde) toast('🧟 屍潮來襲!成群的嘶吼從黑暗中逼近……');
      // 每撐過一天給 XP(睡覺快轉也算)
      if (lastXpDay === 0) lastXpDay = timeSystem.day;
      if (timeSystem.day > lastXpDay) {
        gainXp(XP.day * (timeSystem.day - lastXpDay));
        lastXpDay = timeSystem.day;
        toast(`🌅 又撐過一天 +${XP.day} XP`);
      }
    }
    // 左上角經驗值;有沒花的技能點就亮起提醒
    const pts = skills.points > 0 ? ` · <span style="color:#e5a13c">技能點 ×${skills.points}(按 K)</span>` : '';
    xpEl.innerHTML = `Lv${skills.level} · ${Math.floor(skills.xp)}/${skills.xpNeed()} XP${pts}`;
  }
  // 自動存檔(20 秒一次)
  autosaveTimer += dt;
  if (autosaveTimer >= 20) {
    autosaveTimer = 0;
    if (canSave && started && stats.alive) saveGame(saveCtx);
  }
  if (fpsTimer >= 0.5) {
    fpsEl.textContent = `FPS ${Math.round(fpsFrames / fpsTimer)}${timeSystem.timeScale > 1 ? ' · 時間x120' : ''}`;
    const chaser = enemies.nearestChaserDist(player.position);
    const warn = chaser < 40 ? `<br><span style="color:#c84a3c">⚠ 被追擊中!</span>` : '';
    clockEl.innerHTML = `<span class="day">第 ${timeSystem.day} 天</span><br><span class="time">${timeSystem.clockText}</span><br><span class="region">${regionName(player.position.x, player.position.z)}</span>${warn}`;
    fpsFrames = 0;
    fpsTimer = 0;
  }

  renderer.render(scene, camera);
}
loop();
