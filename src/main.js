import * as THREE from './lib/three.js';
import { createTerrain, regionName, terrainHeight } from './world/Terrain.js';
import { createStructures } from './world/Structures.js';
import { spawnLoot } from './world/LootSpawner.js';
import { TimeSystem } from './core/TimeSystem.js';
import { Player } from './player/Player.js';
import { Stats } from './player/Stats.js';
import { Skills, SKILL_DEFS, PROF_DEFS, XP } from './player/Skills.js';
import { Inventory, ITEMS, quickbarIds } from './player/Items.js';
import { RECIPES, costText, canCraft, craft, isNearFire, updateCampfires, campfires } from './systems/Crafting.js';
import { sfx } from './core/Sound.js';
import { findInteraction, doInteract } from './systems/Interaction.js';
import { EnemyManager } from './entities/Zombies.js';
import { Combat } from './systems/Combat.js';
import { Buildings, BUILDABLES, sleepUntilMorning, dropHalfInventory } from './systems/Building.js';
import { peekSave, clearSave, saveGame, loadGame } from './systems/SaveSystem.js';
import { VehicleManager } from './systems/Vehicles.js';
import { NpcManager, FACTIONS, PRICES, giftValue } from './entities/Npc.js';
import { QuestLog, questDef } from './systems/Quests.js';
import { CompanionManager, ROLES, FEED_VALUE } from './entities/Companion.js';
import { RaiderManager } from './entities/Raiders.js';
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
stats.onDamage = () => sfx.play('hurt'); // 受到明顯傷害悶哼一聲
skills.onProf = (msg) => { toast(`⬆ ${msg}`); sfx.play('prof'); }; // 熟練度升級提示(規格 7.7 用進廢退軌)

// 音效引擎:瀏覽器要求使用者手勢後才能出聲(點擊/按鍵都算,冪等)
addEventListener('click', () => sfx.unlock());
addEventListener('keydown', () => sfx.unlock());
const inventory = new Inventory();
const player = new Player(camera, renderer.domElement, stats);
const enemies = new EnemyManager(scene);
const buildings = new Buildings(scene);
buildings.skills = skills;
buildings.onDestroyed = (b) => toast(`⚠ ${b.def.name}被摧毀了!`);
const vehicles = new VehicleManager(scene); // 載具(M8c;要在 createStructures 之後,拿廢棄車位置)
vehicles.toast = toast;
const npcs = new NpcManager(scene); // NPC 與陣營(M8f;同樣要在 createStructures 之後)
npcs.skills = skills;               // 交易折扣/口才
const quests = new QuestLog();      // 任務(M8f-2,規格 7.9)
const companions = new CompanionManager(scene); // 招募的同伴(規格 7.8)
companions.skills = skills;         // 領袖魅力 = 同伴上限
companions.toast = toast;
// 鏽爪幫掠奪者(M8f-3,規格 7.8;要在 createStructures 之後,營地要挑建築旁的空地)
const raiders = new RaiderManager(scene);
raiders.skills = skills;                      // 🤞 談判
raiders.enemies = enemies;                    // 槍手開槍會引來感染者
raiders.toast = toast;
raiders.rustRep = () => npcs.repOf('rust');   // 聲望夠高他們就不動你
raiders.onCampCleared = () => {
  toast('☠️ 鏽爪幫營地清空了!補給箱可以搬了');
  sfx.play('levelup');
  gainXp(150);
  for (const [f, n] of Object.entries({ rust: -30, ark: 12, white: 8 })) {
    const got = npcs.addRep(f, n);
    if (got) toast(`${FACTIONS[f].icon} ${FACTIONS[f].name}聲望 ${got > 0 ? '+' : ''}${got}(${npcs.repOf(f)})`);
  }
};
enemies.interceptAttack = (dmg) => vehicles.interceptAttack(dmg); // 開車時感染者打車體
scene.add(camera); // 第一人稱武器模型掛在相機上
const combat = new Combat({
  camera, player, stats, inventory, enemies, raiders, toast, skills, models: itemModels,
  isNight: () => timeSystem.nightFactor,
  onHit: (killed, zb) => {
    hitmark(killed);
    if (killed) onEnemyKilled(zb);
  },
});

// 擊殺結算(玩家自己殺的、撞死的、同伴殺的都走這裡;xpMult 給同伴的半功勞用)
function onEnemyKilled(zb, xpMult = 1, msg = null) {
  toast(msg ?? `擊殺了${zb.def.name}`);
  gainXp(Math.round((zb.def.xp || 10) * xpMult));
  questKill(zb.type);
  if (zb.isRaider) {
    // 動手就是結仇:鏽爪聲望掉,方舟/白衣會樂見其成(規格 7.8 幫助/敵對行為影響態度)
    npcs.addRep('rust', -4);
    npcs.addRep('ark', 1);
  }
}

// 擊殺型任務進度(玩家自己殺的、撞死的、同伴殺的都算)
function questKill(type) {
  for (const q of quests.onKill(type)) {
    const g = questDef(q.id).goal;
    if (q.prog.kill >= g.n) toast(`📜 ${questDef(q.id).title}:目標達成,回去覆命`);
    else if (q.prog.kill % 2 === 0) toast(`📜 ${questDef(q.id).title} ${q.prog.kill}/${g.n}`);
  }
}

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
  if (skills.addXp(n) > 0) {
    toast(`⬆ 升到 Lv${skills.level}!獲得技能點——按 K 打開技能樹`);
    sfx.play('levelup');
  }
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
const promptEl = $('prompt'), toastsEl = $('toasts'), panelEl = $('panel'), partyEl = $('party');
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
  if (respawnSpot()) doRespawn();
  else location.reload();
});
$('restart-btn').addEventListener('click', () => location.reload());

// 重生點:最後睡過的地方——巴士臥鋪(跟著車移動)優先於自己蓋的床
function respawnSpot() {
  const v = vehicles.homeBunk;
  if (v) return { x: v.x, z: v.z, bunk: v };
  return buildings.respawnPoint();
}

// 床邊/臥鋪重生(規格 7.10 劇情模式:掉落部分物品)
function doRespawn() {
  const bed = respawnSpot();
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
  toast(bed.bunk ? '你在巴士臥鋪上醒來……身上的東西掉了一半' : '你在床邊醒來……身上的東西掉了一半');
  sfx.play('day');
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
let chestRef = null;  // {storage} —— 儲物箱,或皮卡/巴士的車廂(M8e 移動倉庫)
let chestTitle = '儲物箱';
let chestActions = [];
// 面板格子鍵:技能樹加了社交分支後超過 9 項,往後延伸到 0 - =(面板會標出鍵)
const PANEL_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7', 'Digit8', 'Digit9', 'Digit0', 'Minus', 'Equal', 'BracketLeft', 'BracketRight'];
const KEY_LABELS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0', '-', '=', '[', ']'];

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
    return `${header}<div class="recipe ${ok ? '' : 'no'}"><span class="k">[${KEY_LABELS[i] ?? '·'}]</span> ${s.icon} ${s.name} Lv${lv}/${s.max} <span class="req">${state}</span></div>`;
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
    <div class="hint">按左邊標示的鍵加點(每點 1 技能點) · K/Tab 關閉</div>`;
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
  panelEl.innerHTML = `<h2>${chestTitle}</h2><div class="mats">按數字整疊存入/取出(死亡不會掉落裡面的東西)</div>
    <div class="mats">背包:</div>${invRows}<div class="mats">箱內:</div>${boxRows}<div class="hint">Tab 關閉</div>`;
}

// ── NPC 對話 / 交易 / 送禮(M8f,規格 7.8)──
let talkNpc = null;
let talkLine = '';       // 面板上方那句話(招呼語或剛打聽到的消息)
let talkActions = [];    // 數字鍵 → 動作

// 每次 push 完動作馬上呼叫,標出對應的鍵(交易清單可能超過 9 項,延伸到 0 - =)
const actionRow = (label) =>
  `<div class="recipe"><span class="k">[${KEY_LABELS[talkActions.length - 1] ?? '·'}]</span> ${label}</div>`;

function repLine(npc) {
  const f = npc.def.faction;
  const rel = f
    ? `${FACTIONS[f].icon} ${FACTIONS[f].name} · ${npcs.repLabel(f)}(${npcs.repOf(f)}/100)`
    : '🙋 獨行者 · 中立';
  return `${rel}　你的瓶蓋 🔘${inventory.count('caps')}`;
}

function renderTalkPanel() {
  const npc = talkNpc;
  talkActions = [];
  const rows = [];
  // 委託(M8f-2):待交的先問,沒有再看他有沒有新的要給
  const idx = npcs.npcs.indexOf(npc);
  const pending = quests.pendingFor(idx);
  if (pending) {
    const def = questDef(pending.id);
    const ok = quests.isComplete(pending, inventory);
    talkActions.push({ act: 'questTurn', q: pending });
    rows.push(actionRow(`${ok ? '✅' : '📜'} 回報「${def.title}」 <span class="req">${quests.progressText(pending, inventory)}</span>`));
  } else {
    const offer = quests.offerFor(npc, timeSystem.day);
    if (offer) {
      talkActions.push({ act: 'questOffer', def: offer });
      rows.push(actionRow(`📜 他有事想拜託你 <span class="req">「${offer.title}」</span>`));
    }
  }
  if (npc.recruitable && !npc.recruited) {
    talkActions.push({ act: 'recruit' });
    rows.push(actionRow(`🤝 邀他同行 <span class="req">(${ROLES[npc.role]?.name ?? '倖存者'} · 同伴 ${companions.list.length}/${companions.maxCount()})</span>`));
  }
  if (npc.def.trade) {
    talkActions.push({ act: 'trade' });
    rows.push(actionRow(npcs.canTrade(npc) ? '交易(看貨)' : '交易 <span class="req">(聲望 20 以上才談)</span>'));
  }
  talkActions.push({ act: 'rumor' });
  rows.push(actionRow('打聽消息'));
  if (npc.def.faction) {
    talkActions.push({ act: 'gift' });
    rows.push(actionRow('送禮 <span class="req">(提升陣營聲望)</span>'));
  }
  talkActions.push({ act: 'close' });
  rows.push(actionRow('離開'));
  panelEl.innerHTML = `<h2>${npc.def.icon} ${npc.def.name}</h2>
    <div class="mats">${talkLine}</div>
    <div class="mats">${repLine(npc)}</div>
    ${rows.join('')}
    <div class="hint">按數字選擇 · E/Tab 離開</div>`;
}

function renderTradePanel() {
  const npc = talkNpc;
  talkActions = [];
  const buyRows = [...npc.stock.items.entries()].filter(([id]) => PRICES[id]).slice(0, 5).map(([id, n]) => {
    talkActions.push({ act: 'buy', id });
    return actionRow(`${ITEMS[id].icon}${ITEMS[id].name} ×${n} <span class="req">🔘${npcs.buyPrice(npc, id)}</span>`);
  }).join('') || '<div class="recipe no">(貨賣光了,明天再來)</div>';
  const sellRows = npcs.sellableIds(npc, inventory).slice(0, 4).map((id) => {
    talkActions.push({ act: 'sell', id });
    return actionRow(`${ITEMS[id].icon}${ITEMS[id].name} ×${inventory.count(id)} <span class="req">→ 🔘${npcs.sellPrice(npc, id)}</span>`);
  }).join('') || '<div class="recipe no">(你沒有他要的東西)</div>';
  talkActions.push({ act: 'back' });
  panelEl.innerHTML = `<h2>${npc.def.icon} ${npc.def.name} · 交易</h2>
    <div class="mats">你 🔘${inventory.count('caps')}　他 🔘${npc.caps}　聲望越高買越便宜、賣越好</div>
    <div class="mats">他賣:</div>${buyRows}
    <div class="mats">你賣(一次一件):</div>${sellRows}
    ${actionRow('結束交易')}`;
}

function renderGiftPanel() {
  const npc = talkNpc;
  talkActions = [];
  const rows = [...inventory.items.keys()].filter((id) => id !== 'caps' && PRICES[id]).slice(0, 8)
    .map((id) => {
      talkActions.push({ act: 'giftItem', id });
      return actionRow(`${ITEMS[id].icon}${ITEMS[id].name} ×${inventory.count(id)} <span class="req">→ 聲望 +${Math.round(giftValue(id) * (1 + 0.5 * skills.levelOf('persuade')))}</span>`);
    }).join('') || '<div class="recipe no">(身上沒有拿得出手的東西)</div>';
  talkActions.push({ act: 'back' });
  panelEl.innerHTML = `<h2>${npc.def.icon} 送禮</h2>
    <div class="mats">${repLine(npc)}</div>${rows}${actionRow('算了')}`;
}

// ── 任務(M8f-2,規格 7.9)──
// 標記點光柱:visit 型任務接下後在目標處立一道光,拿到信物就撤掉
const questMarkers = new Map();
function addQuestMarker(q) {
  if (!q.spot || questMarkers.has(q.id)) return;
  const m = new THREE.Mesh(
    new THREE.CylinderGeometry(1.2, 1.2, 70, 8, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xe5a13c, transparent: true, opacity: 0.2,
      side: THREE.DoubleSide, depthWrite: false,
    })
  );
  m.position.set(q.spot.x, terrainHeight(q.spot.x, q.spot.z) + 34, q.spot.z);
  scene.add(m);
  questMarkers.set(q.id, m);
}
function removeQuestMarker(id) {
  const m = questMarkers.get(id);
  if (!m) return;
  scene.remove(m);
  m.geometry.dispose();
  m.material.dispose();
  questMarkers.delete(id);
}

// 方位提示(沒有地圖,至少告訴你往哪走);-z = 北
function bearingText(x, z) {
  const dx = x - player.position.x;
  const dz = z - player.position.z;
  const dirs = ['北', '東北', '東', '東南', '南', '西南', '西', '西北'];
  const a = Math.atan2(dx, -dz);
  const i = Math.round(((a + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 4)) % 8;
  return `${dirs[i]}方 ${Math.round(Math.hypot(dx, dz))}m`;
}

// J 鍵:任務日誌
function renderQuestsPanel() {
  const rows = quests.active.map((q) => {
    const def = questDef(q.id);
    const npc = npcs.npcs[q.npcIdx];
    const ok = quests.isComplete(q, inventory);
    const where = def.goal.kind === 'visit' && q.spot && !q.prog.got ? `　<span class="req">${bearingText(q.spot.x, q.spot.z)}</span>` : '';
    return `<div class="recipe ${ok ? '' : 'no'}">${ok ? '✅' : '📜'} ${def.title}
      <span class="req">— ${npc ? npc.def.name : '委託人'}</span>
      <div class="req" style="padding-left:20px">${quests.progressText(q, inventory)}${where}</div>
      <div class="req" style="padding-left:20px">報酬 ${quests.rewardText(def)}${ok ? '　<span style="color:#8a9a6b">回去交差</span>' : ''}</div>
    </div>`;
  }).join('') || '<div class="recipe no">(沒有進行中的任務——去找 NPC 聊聊)</div>';
  const party = companions.list.map((c) => `<div class="recipe">${c.statusText()}</div>`).join('')
    || `<div class="recipe no">(還沒有同伴——完成倖存者的委託就能邀他同行)</div>`;
  panelEl.innerHTML = `<h2>任務日誌</h2>
    <div class="mats">已完成 ${Object.keys(quests.finished).length} 件委託</div>
    ${rows}
    <div class="mats" style="margin:14px 0 2px">── 同伴(${companions.list.length}/${companions.maxCount()})──</div>
    ${party}
    <div class="hint">J/Tab 關閉 · 🎖 領袖魅力可以提高同伴上限</div>`;
}

// NPC 對話裡的「委託」子畫面
let questOffer = null; // 目前正在看的任務 def
function renderQuestPanel() {
  const npc = talkNpc;
  talkActions = [];
  const def = questOffer;
  const rows = [];
  if (def) {
    talkActions.push({ act: 'questAccept' });
    rows.push(actionRow('接下這個委託'));
  }
  talkActions.push({ act: 'back' });
  rows.push(actionRow('再想想'));
  panelEl.innerHTML = `<h2>📜 ${def ? def.title : '委託'}</h2>
    <div class="mats">${def ? def.desc : ''}</div>
    <div class="mats">目標:${def ? goalText(def) : ''}<br>報酬:${def ? quests.rewardText(def) : ''}</div>
    ${rows.join('')}
    <div class="hint">${npc.def.name} · E/Tab 離開</div>`;
}

function goalText(def) {
  const g = def.goal;
  if (g.kind === 'collect') {
    return Object.entries(g.items).map(([id, n]) => `${ITEMS[id].icon}${ITEMS[id].name}×${n}`).join('、');
  }
  if (g.kind === 'kill') return `擊殺 ${g.n} 隻感染者`;
  if (g.kind === 'visit') return `前往標記地點取回${ITEMS[g.item].icon}${ITEMS[g.item].name}`;
  return '';
}

// ── 同伴指令(M8f-2,規格 7.8)──
let compRef = null;
function renderCompanionPanel() {
  const c = compRef;
  talkActions = [];
  const rows = [];
  talkActions.push({ act: 'compMode' });
  rows.push(actionRow(c.mode === 'follow' ? '待在這裡看家(駐守工作)' : '跟我走'));
  talkActions.push({ act: 'compBag' });
  const bagN = [...c.bag.items.values()].reduce((a, b) => a + b, 0);
  rows.push(actionRow(`收取他攢下的物資 <span class="req">(${bagN} 件)</span>`));
  talkActions.push({ act: 'compFeed' });
  rows.push(actionRow('餵他吃東西 <span class="req">(飽食歸零會開始扣血)</span>'));
  talkActions.push({ act: 'compDismiss' });
  rows.push(actionRow('讓他留在這裡 <span class="req">(解散)</span>'));
  talkActions.push({ act: 'close' });
  rows.push(actionRow('沒事'));
  panelEl.innerHTML = `<h2>${c.def.icon} ${c.name} · ${c.def.name}</h2>
    <div class="mats">${c.statusText()}</div>
    <div class="mats">專長:${c.def.perk}<br>駐守產出:${Object.keys(c.def.work).map((id) => ITEMS[id].icon + ITEMS[id].name).join('、')}</div>
    ${rows.join('')}
    <div class="hint">按數字選擇 · E/Tab 離開</div>`;
}

function renderFeedPanel() {
  const c = compRef;
  talkActions = [];
  const rows = [...inventory.items.keys()].filter((id) => FEED_VALUE[id]).slice(0, 8).map((id) => {
    talkActions.push({ act: 'feedItem', id });
    return actionRow(`${ITEMS[id].icon}${ITEMS[id].name} ×${inventory.count(id)} <span class="req">→ 飽食 +${FEED_VALUE[id]}</span>`);
  }).join('') || '<div class="recipe no">(身上沒有能吃的東西)</div>';
  talkActions.push({ act: 'backComp' });
  panelEl.innerHTML = `<h2>${c.def.icon} 餵食 ${c.name}</h2>
    <div class="mats">${c.statusText()}</div>${rows}${actionRow('算了')}`;
}

function doTalkAction(i) {
  const a = talkActions[i - 1];
  if (!a) return;
  const npc = talkNpc;
  if (a.act === 'close') { setPanel(null); return; }
  if (a.act === 'back') { setPanel('talk'); return; }
  if (a.act === 'backComp') { setPanel('companion'); return; }
  // ── 任務 ──
  if (a.act === 'questOffer') { questOffer = a.def; setPanel('quest'); return; }
  if (a.act === 'questAccept') {
    const def = questOffer;
    const idx = npcs.npcs.indexOf(npc);
    const spot = def.goal.kind === 'visit' ? npcs.pickQuestSpot(npc) : null;
    const q = quests.accept(def, idx, spot);
    if (q) {
      if (spot) { addQuestMarker(q); toast(`📜 接下「${def.title}」——${bearingText(spot.x, spot.z)}有一道光柱`); }
      else toast(`📜 接下「${def.title}」(按 J 看任務日誌)`);
      sfx.play('talk');
      talkLine = `「${def.desc.replace(/[「」]/g, '')}」`;
    }
    setPanel('talk');
    return;
  }
  if (a.act === 'questTurn') {
    const q = a.q;
    const def = questDef(q.id);
    const res = quests.turnIn(q, inventory, timeSystem.day);
    if (!res) {
      talkLine = `「${quests.progressText(q, inventory)}——還沒好呢。」`;
      sfx.play('uiOff');
      renderTalkPanel();
      return;
    }
    removeQuestMarker(q.id);
    for (const [f, n] of Object.entries(res.reward.rep || {})) {
      const got = npcs.addRep(f, n);
      if (got > 0) toast(`${FACTIONS[f].icon} ${FACTIONS[f].name}聲望 +${got}(${npcs.repOf(f)})`);
    }
    gainXp(res.reward.xp || XP.quest);
    toast(`✅ 完成「${def.title}」　${quests.rewardText(def)}`);
    sfx.play('levelup');
    if (def.unlockRecruit) {
      npc.recruitable = true;
      toast(`🤝 ${npc.def.name}願意跟你走了——選單多了「邀他同行」`);
    }
    talkLine = def.done || '「謝了。」';
    updateQuickbar();
    setPanel('talk');
    return;
  }
  if (a.act === 'recruit') {
    if (!companions.canRecruit()) {
      talkLine = `「你已經帶著${companions.list.length}個人了。」(同伴上限 ${companions.maxCount()},🎖 領袖魅力可以提高)`;
      sfx.play('uiOff');
      renderTalkPanel();
      return;
    }
    const c = companions.recruit(npc, npcs.npcs.indexOf(npc));
    if (c) {
      toast(`🤝 ${c.name}(${c.def.name})加入了你——${c.def.perk}`);
      sfx.play('levelup');
      setPanel(null);
    }
    return;
  }
  // ── 同伴指令 ──
  if (a.act === 'compMode') {
    compRef.mode = compRef.mode === 'follow' ? 'guard' : 'follow';
    toast(compRef.mode === 'guard' ? `${compRef.name}留下來看家了` : `${compRef.name}跟上來了`);
    sfx.play('ui');
    renderCompanionPanel();
    return;
  }
  if (a.act === 'compBag') {
    toast(compRef.collectBag(inventory));
    sfx.play('pickup');
    updateQuickbar();
    renderCompanionPanel();
    return;
  }
  if (a.act === 'compFeed') { setPanel('feed'); return; }
  if (a.act === 'feedItem') {
    const res = compRef.feed(a.id, inventory);
    toast(res.msg);
    sfx.play(res.fed ? 'eat' : 'uiOff');
    updateQuickbar();
    renderFeedPanel();
    return;
  }
  if (a.act === 'compDismiss') {
    toast(companions.dismiss(compRef));
    sfx.play('uiOff');
    setPanel(null);
    return;
  }
  if (a.act === 'gift') { setPanel('gift'); return; }
  if (a.act === 'trade') {
    if (!npcs.canTrade(npc)) {
      talkLine = '「先證明你不是麻煩,再來談生意。」';
      sfx.play('uiOff');
      renderTalkPanel();
    } else {
      setPanel('trade');
    }
    return;
  }
  if (a.act === 'rumor') {
    talkLine = npcs.rumor(npc).msg;
    sfx.play('talk');
    renderTalkPanel();
    return;
  }
  if (a.act === 'buy' || a.act === 'sell') {
    const res = a.act === 'buy' ? npcs.buy(npc, a.id, inventory) : npcs.sell(npc, a.id, inventory);
    toast(res.msg);
    if (res.traded) { sfx.play('caps'); gainXp(XP.trade); } else sfx.play('uiOff');
    renderTradePanel();
    updateQuickbar();
    return;
  }
  if (a.act === 'giftItem') {
    const res = npcs.gift(npc, a.id, inventory);
    toast(res.msg);
    if (res.rep > 0) { sfx.play('talk'); gainXp(XP.gift); } else sfx.play('uiOff');
    talkLine = res.rep > 0 ? '「……謝了。這年頭沒人白給東西。」' : talkLine;
    setPanel('talk');
    updateQuickbar();
  }
}

function setPanel(mode) {
  if (mode && !panelMode) sfx.play('ui');
  else if (!mode && panelMode) sfx.play('uiOff');
  panelMode = mode;
  panelEl.classList.toggle('hidden', !mode);
  if (mode) buildings.cancelPlacing(); // 開面板就退出建造模式
  if (mode === 'craft') renderCraftPanel();
  else if (mode === 'build') renderBuildPanel();
  else if (mode === 'chest') renderChestPanel();
  else if (mode === 'skills') renderSkillsPanel();
  else if (mode === 'talk') renderTalkPanel();
  else if (mode === 'trade') renderTradePanel();
  else if (mode === 'gift') renderGiftPanel();
  else if (mode === 'quest') renderQuestPanel();
  else if (mode === 'quests') renderQuestsPanel();
  else if (mode === 'companion') renderCompanionPanel();
  else if (mode === 'feed') renderFeedPanel();
}

// 走數字鍵 → doTalkAction 的面板(對話、交易、任務、同伴指令)
const TALK_MODES = ['talk', 'trade', 'gift', 'quest', 'companion', 'feed'];

function doChestTransfer(digit) {
  const act = chestActions[digit - 1];
  if (!act) return;
  const from = act.dir === 'in' ? inventory : chestRef.storage;
  const to = act.dir === 'in' ? chestRef.storage : inventory;
  const n = from.count(act.id);
  if (n > 0) {
    from.remove(act.id, n);
    to.add(act.id, n);
    sfx.play('pickup');
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
  if (e.code === 'KeyM') {
    // 靜音切換(隨時可按,偏好會記住)
    toast(sfx.toggleMute() ? '🔇 已靜音(再按 M 開啟)' : '🔊 音效開啟');
    return;
  }
  if (!player.locked || !stats.alive) return;

  // 開車中:只吃 E(下車)/R(加油),其餘按鍵不作用(M8c)
  if (vehicles.driving) {
    if (e.code === 'KeyE') {
      toast(vehicles.exitVehicle(player));
      sfx.play('carDoor');
      vehicleEl.classList.add('hidden');
      combat.viewmodel.visible = true;
      updateQuickbar();
    } else if (e.code === 'KeyR') {
      const msg = vehicles.refuel(inventory);
      if (msg) {
        toast(msg);
        if (msg.startsWith('⛽')) sfx.play('refuel');
      }
    }
    return;
  }
  if (e.code === 'KeyK') {
    // 技能樹(規格 7.7)
    setPanel(panelMode === 'skills' ? null : 'skills');
    return;
  }
  if (e.code === 'KeyJ') {
    // 任務日誌(規格 7.9)
    setPanel(panelMode === 'quests' ? null : 'quests');
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
    // 對話中按 E = 離開對話(不然會原地重開一次)
    if (TALK_MODES.includes(panelMode)) { setPanel(null); return; }
    const sel = findInteraction(player, inventory, enemies, buildings, vehicles, npcs, companions, raiders);
    if (!sel) return;
    if (sel.kind === 'companion') { // 同伴下指令(M8f-2)
      compRef = sel.comp;
      sfx.play('talk');
      setPanel('companion');
      return;
    }
    if (sel.kind === 'npc') { // NPC 交談(M8f)
      talkNpc = sel.npc;
      talkLine = npcs.greeting(sel.npc);
      sfx.play('talk');
      setPanel('talk');
      return;
    }
    if (sel.kind === 'door') { buildings.toggleDoor(sel.b); return; }
    if (sel.kind === 'vehicle' || sel.kind === 'carwreck') {
      const wasDriving = !!vehicles.driving;
      const res = vehicles.interact(sel, inventory, player, stats);
      if (res.msg) toast(res.msg);
      if (res.xp) gainXp(res.xp);
      if (vehicles.driving && !wasDriving) sfx.play('carDoor'); // 上車
      else if (res.msg) sfx.play('wrench');                    // 拆車/裝零件/修車體
      if (vehicles.driving) combat.viewmodel.visible = false; // 第三人稱視角藏起手上武器
      updateQuickbar();
      return;
    }
    if (sel.kind === 'raidcrate') { // 鏽爪幫營地補給箱(M8f-3;守衛清光才搬得動)
      if (sel.locked) {
        toast('☠️ 守衛還在,搬不走');
        sfx.play('uiOff');
        return;
      }
      const got = raiders.lootCrate();
      if (got) {
        const parts = [];
        for (const [id, n] of Object.entries(got)) { inventory.add(id, n); parts.push(`${ITEMS[id].name}×${n}`); }
        toast(`搬空補給箱:${parts.join('、')}`);
        sfx.play('chestOpen');
        gainXp(XP.loot * 6);
        updateQuickbar();
      }
      return;
    }
    if (sel.kind === 'chest') { chestRef = sel.b; chestTitle = '儲物箱'; sfx.play('chestOpen'); setPanel('chest'); return; }
    if (sel.kind === 'vehicleStorage') { // 皮卡貨斗/巴士車廂 = 移動倉庫(規格 7.5)
      chestRef = { storage: sel.v.cargo };
      chestTitle = `${sel.v.def.name}車廂`;
      sfx.play('chestOpen');
      setPanel('chest');
      return;
    }
    if (sel.kind === 'vehicleBunk') { trySleep(null, sel.v); return; } // 巴士臥鋪 = 移動據點
    if (sel.kind === 'bed') { trySleep(sel.b); return; }
    const msg = doInteract(sel, inventory, stats);
    if (msg) {
      toast(msg);
      const INTERACT_SFX = { corpse: 'rustle', loot: 'pickup', fill: 'splash', drinkLake: 'drink' };
      if (INTERACT_SFX[sel.kind]) sfx.play(INTERACT_SFX[sel.kind]);
      if (sel.kind === 'corpse') gainXp(XP.corpse);
      else if (sel.kind === 'loot') {
        gainXp(sel.point.type === 'berry' || sel.point.type === 'stick' ? XP.gather : XP.loot);
      }
    }
    if (panelMode === 'craft') renderCraftPanel();
    return;
  }
  // 技能樹超過 9 項後,格子鍵延伸到 0 - =(面板會標出對應的鍵);其餘面板仍只吃 1-9
  const slot = PANEL_KEYS.indexOf(e.code) + 1;
  const digit = slot >= 1 && slot <= 9 ? slot : 0;
  if (slot >= 1 && TALK_MODES.includes(panelMode)) {
    doTalkAction(slot);
    return;
  }
  if (slot >= 1 && panelMode === 'skills') {
    // 格子鍵 = 技能加點(1-9 0 - =)
    const def = SKILL_DEFS[slot - 1];
    if (def) {
      const msg = skills.up(def.id);
      if (msg) { toast(msg); sfx.play('skill'); }
      else { toast(skills.points <= 0 ? '沒有技能點——升級才會獲得' : '這個技能已滿級'); sfx.play('uiOff'); }
      renderSkillsPanel();
    }
    return;
  }
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
          sfx.play(recipe.place ? 'ignite' : recipe.needFire ? 'sizzle' : 'craft');
          gainXp(XP.craft);
          if (recipe.needFire) skills.addProf('cook', 1); // 🍳 營火烹飪練熟練
        } else {
          sfx.play('uiOff');
        }
        renderCraftPanel();
      }
    } else if (panelMode === 'build') {
      // 數字 = 選擇建造物,進入放置模式
      const def = BUILDABLES[digit - 1];
      if (def) {
        buildings.startPlacing(def);
        panelMode = null;
        panelEl.classList.add('hidden');
        toast(`左鍵放置${def.name},右鍵/B 取消`);
        sfx.play('ui');
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
          const USE_SFX = { bottled: 'drink', dirty: 'drink', boiled: 'drink', bandage: 'bandage', antibiotic: 'pill', serum: 'inject' };
          sfx.play(USE_SFX[id] || 'eat'); // 野莓/罐頭/生肉/烤肉都是咀嚼聲
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
        sfx.play('place');
        gainXp(XP.build);
        updateQuickbar();
      } else {
        sfx.play('uiOff'); // 位置不合法或材料不足
      }
    } else {
      combat.tryAttack(elapsed);
    }
  } else if (e.button === 2 && buildings.placing) {
    buildings.cancelPlacing();
    toast('取消建造');
    sfx.play('uiOff');
  }
});
addEventListener('contextmenu', (e) => {
  if (player.locked) e.preventDefault();
});

// 睡覺:夜晚快轉到清晨,睡的地方 = 重生點(規格 7.2;bunk = 巴士臥鋪,會跟著車跑)
function trySleep(bed, bunk = null) {
  const t = timeSystem.timeOfDay;
  if (t >= 5 && t < 20) {
    toast('還不睏——天黑(20:00)後才能睡');
    return;
  }
  if (enemies.nearestChaserDist(player.position) < 45) {
    toast('感染者就在附近,睡不著!');
    return;
  }
  // 重生點 = 最後睡過的地方,床與臥鋪二選一
  vehicles.homeBunk = bunk;
  if (!bunk) buildings.homeBed = bed;
  sleepUntilMorning(timeSystem, stats);
  sfx.play('sleep');
  setTimeout(() => sfx.play('day'), 800); // 醒來的晨光鳥鳴
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
if (params.has('repair')) vehicles.repairAll();             // 全載具修好加滿油(試駕/截圖用)
if (params.has('camp')) { // ?camp=1 直接傳送到鏽爪幫營地門口(試營地戰用)
  const c = raiders.camp;
  player.position.set(c.x + 16, terrainHeight(c.x + 16, c.z), c.z);
  player.yaw = Math.PI / 2; // 面朝營地(-x 方向)
}
if (params.has('ambush')) { // ?ambush=3 立刻在身邊放 N 個伏擊者
  const n = parseInt(params.get('ambush')) || 3;
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const r = raiders.spawn(i === 0 ? 'gunner' : 'thug',
      player.position.x + Math.cos(a) * 12, player.position.z + Math.sin(a) * 12, 'ambush');
    r.lastKnown = { x: player.position.x, z: player.position.z };
  }
}
if (params.has('rep')) { // ?rep=ark:80,rust:5 直接設陣營聲望(測交易價格用)
  for (const part of params.get('rep').split(',')) {
    const [f, v] = part.split(':');
    if (npcs.rep[f] !== undefined) npcs.rep[f] = Math.max(0, Math.min(100, parseInt(v) || 0));
  }
}
// ?quest=sv_food,ark_supply 直接從委託人手上接下任務(測任務面板用)
if (params.has('quest')) {
  for (const id of params.get('quest').split(',')) {
    const def = questDef(id);
    if (!def) continue;
    const npc = npcs.npcs.find((n) => (n.questId ? n.questId === id : n.type === def.giver));
    if (!npc) continue;
    const q = quests.accept(def, npcs.npcs.indexOf(npc), def.goal.kind === 'visit' ? npcs.pickQuestSpot(npc) : null);
    if (q?.spot) addQuestMarker(q);
  }
}
// ?party=1 直接招募第一個倖存者(試同伴 AI/截圖用)
if (params.has('party')) {
  const n = parseInt(params.get('party')) || 1;
  for (const npc of npcs.npcs) {
    if (companions.list.length >= n || npc.type !== 'survivor' || npc.recruited) continue;
    npc.recruitable = true;
    const c = companions.recruit(npc, npcs.npcs.indexOf(npc));
    if (c) { c.x = player.position.x + 2; c.z = player.position.z + 1; c.syncMesh(); }
  }
  updatePartyHud();
}
// 直接開指定面板(截圖驗證 UI 用);要在 items/equip/quest/party 之後,面板才看得到內容
if (params.has('panel')) {
  const pm = params.get('panel');
  if (['talk', 'trade', 'gift', 'quest'].includes(pm) && npcs.npcs.length) {
    talkNpc = npcs.npcs[parseInt(params.get('npc')) || 0] || npcs.npcs[0];
    talkLine = npcs.greeting(talkNpc);
    if (pm === 'quest') questOffer = quests.offerFor(talkNpc, timeSystem.day);
  }
  if (['companion', 'feed'].includes(pm)) compRef = companions.list[0];
  if (!(['companion', 'feed'].includes(pm) && !compRef)) setPanel(pm);
}

// ── 存讀檔(M7.5)──
// 自動存檔(20 秒/睡覺/關頁面);有存檔時開始畫面可選「繼續上次」
// ?nosave=1 = 不讀不存(測試/截圖用,免得污染正常存檔)
const canSave = !params.has('nosave');
const saveCtx = { timeSystem, stats, inventory, player, combat, buildings, enemies, scene, skills, vehicles, npcs, quests, companions, raiders };
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
    for (const q of quests.active) if (q.spot && !q.prog.got) addQuestMarker(q); // 補回任務光柱
    updateQuickbar();
    updatePartyHud();
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

// ── 持續音效:每幀更新聽者位置與各種循環音(心跳/營火/引擎)──
let prevExhausted = false;
function updateAudio() {
  sfx.setListener(player.position.x, player.position.z, player.yaw);

  // 力竭喘氣(進入力竭的那一刻)
  if (stats.exhausted && !prevExhausted) sfx.play('pant');
  prevExhausted = stats.exhausted;

  // 低血心跳:HP < 25 漸強漸快
  const lowHp = started && stats.alive && stats.hp < 25;
  sfx.setLoop('heartbeat', lowHp, lowHp ? {
    vol: 0.4 + (1 - stats.hp / 25) * 0.6,
    rate: 1 + (1 - stats.hp / 25) * 0.7,
  } : undefined);

  // 營火劈啪:靠近最近的營火才聽得到
  let fireD = Infinity;
  for (const f of campfires) {
    const d = Math.hypot(player.position.x - f.x, player.position.z - f.z);
    if (d < fireD) fireD = d;
  }
  sfx.setLoop('campfire', fireD < 9, { vol: Math.max(0, 1 - fireD / 9) });

  // 引擎/腳踏車/摩托(開車中;音量與音高的參數放在各車型的 def.sound)
  const v = vehicles.driving;
  const sp = v ? Math.abs(v.speed) / v.def.maxSpeed : 0;
  const powered = !!v && v.hp > 0 && (v.def.fuelMax === 0 || v.fuel > 0);
  for (const name of ['engine', 'bike', 'moto']) {
    const s = v && v.def.sound.name === name ? v.def.sound : null;
    // coast(人力車)= 有在動就響;引擎車 = 有油有車體才響
    const on = !!s && (s.coast ? Math.abs(v.speed) > 0.4 : powered);
    sfx.setLoop(name, on, on ? { vol: s.vol[0] + sp * s.vol[1], rate: s.rate[0] + sp * s.rate[1] } : undefined);
  }
}

// 同伴狀態列(M8f-2):跟著你的人的血與飽食
function updatePartyHud() {
  partyEl.classList.toggle('hidden', companions.list.length === 0);
  partyEl.innerHTML = companions.list.map((c) => {
    const hp = Math.round(c.hp);
    const hpCol = hp < c.hpMax * 0.35 ? '#c84a3c' : '#d8d4c2';
    const food = c.hungry() ? `<span style="color:#c84a3c">🍖${Math.round(c.food)}%</span>` : `🍖${Math.round(c.food)}%`;
    return `<div>${c.def.icon} ${c.name} <span style="color:${hpCol}">❤${hp}</span> ${food} <span style="color:#8a9a6b">${c.mode === 'guard' ? '駐守' : '跟隨'}</span></div>`;
  }).join('');
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
      sfx.play('infection');
    }
  }
  effectsEl.innerHTML = parts.join('　');
}

let deathShown = false;
function showDeath() {
  deathShown = true;
  sfx.play('death');
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
  const bed = respawnSpot();
  if (canSave && !bed) clearSave(); // 沒重生點 = 這一輪結束;有床/臥鋪則保留最後一次自動存檔
  $('respawn-btn').textContent = bed
    ? (bed.bunk ? '在巴士臥鋪醒來(掉落一半物品)' : '在床邊醒來(掉落一半物品)')
    : '重新開始';
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
    player, stats, enemies, raiders, camera, now: elapsed,
    onRam: (killed, zb) => {
      hitmark(killed);
      sfx.play('hitFlesh');
      sfx.play('thudMetal', { vol: 0.6 });
      if (killed) onEnemyKilled(zb, 1, `💥 撞飛了${zb.def.name}!`);
    },
  });
  stats.update(dt, dt * timeSystem.hoursPerRealSecond);
  timeSystem.update(dt, player.position);
  enemies.update(dt, player, stats, timeSystem.nightFactor, elapsed, buildings);
  npcs.update(dt, player.position, timeSystem.day); // 靠近時轉頭看你 + 每天補貨
  companions.update(dt, {                            // 同伴:跟隨/駐守工作/自動迎敵(M8f-2)
    playerPos: player.position, playerStats: stats, enemies, raiders, now: elapsed,
    gh: dt * timeSystem.hoursPerRealSecond, toast,
    onKill: (zb, c) => onEnemyKilled(zb, 0.5, `${c.def.icon} ${c.name}解決了${zb.def.name}`), // 同伴殺的算你一半功勞
  });
  raiders.update(dt, {                               // 鏽爪幫掠奪者(M8f-3)
    playerPos: player.position, playerStats: stats, crouching: player.crouching,
    night: timeSystem.nightFactor, now: elapsed, buildings, companions: companions.list,
    hearNoise: (x, z, r, n) => enemies.hearNoise(x, z, r, n), // 槍手的槍聲一樣引怪
    onAttack: (dmg, cause) => {
      if (vehicles.interceptAttack(dmg)) return; // 開車時挨打的是車體
      stats.damage(dmg, cause);                  // 掠奪者是活人,不會傳染感染值
    },
    onHitCompanion: (c, dmg, name) => {
      c.hp -= dmg;
      sfx.play3d('hurt', c.x, c.z, { vol: 0.7 });
      if (c.hp <= 0) c.die({ toast, onDeath: (dead) => companions.removeDead(dead) }, `${c.name}被${name}打死了`);
    },
  });
  combat.update(dt);
  updateConsumeFx(dt);
  buildings.update(dt);
  if (buildings.placing) buildings.updateGhost(player, inventory);
  updateCampfires(elapsed);
  updateStatsHud();
  updateAudio();

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
      const sel = findInteraction(player, inventory, enemies, buildings, vehicles, npcs, companions, raiders);
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
      // 任務標記點:走到了就拿到信物(規格 7.9 取回遺物)
      for (const q of quests.onVisit(player.position.x, player.position.z)) {
        const g = questDef(q.id).goal;
        inventory.add(g.item, 1);
        removeQuestMarker(q.id);
        toast(`📜 找到了${ITEMS[g.item].icon}${ITEMS[g.item].name}——帶回去給他`);
        sfx.play('pickup');
      }
      updatePartyHud();
      // 鏽爪幫:路上伏擊 + 夜襲據點(規格 7.8)
      if (raiders.maybeAmbush(timeSystem, player.position, elapsed)) {
        toast('☠️ 「東西留下,人可以走!」——鏽爪幫圍上來了');
      }
      if (raiders.maybeRaid(timeSystem, player.position, buildings, elapsed)) {
        toast('☠️ 有人在砸你的牆——鏽爪幫來搶據點了!');
      }
      // 屍潮夜襲檢查(規格 7.2)
      const horde = enemies.maybeHorde(timeSystem, player.position, elapsed);
      if (horde) {
        toast('🧟 屍潮來襲!成群的嘶吼從黑暗中逼近……');
        sfx.play('horde');
      }
      // 每撐過一天給 XP(睡覺快轉也算)
      if (lastXpDay === 0) lastXpDay = timeSystem.day;
      if (timeSystem.day > lastXpDay) {
        gainXp(XP.day * (timeSystem.day - lastXpDay));
        lastXpDay = timeSystem.day;
        toast(`🌅 又撐過一天 +${XP.day} XP`);
        sfx.play('day');
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
    fpsEl.textContent = `FPS ${Math.round(fpsFrames / fpsTimer)}`;
    const chaser = Math.min(enemies.nearestChaserDist(player.position), raiders.nearestChaserDist(player.position));
    const warn = chaser < 40 ? `<br><span style="color:#c84a3c">⚠ 被追擊中!</span>` : '';
    clockEl.innerHTML = `<span class="day">第 ${timeSystem.day} 天</span><br><span class="time">${timeSystem.clockText}</span><br><span class="region">${regionName(player.position.x, player.position.z)}</span>${warn}`;
    fpsFrames = 0;
    fpsTimer = 0;
  }

  renderer.render(scene, camera);
}
loop();
