// 技能與成長系統(規格 7.7「用進廢退 + 技能點雙軌」;社交分支等 NPC 做了再加)
// 純邏輯、不 import three,可直接用 node 跑模擬測試
//
// 技能點軌:XP 來源(main.js 呼叫 addXp)= 擊殺(依感染者 TYPES.xp)/搜刮/採集/製作/建造/每存活一天,
//          升一級 +1 技能點;K 鍵開技能樹加點
// 熟練度軌:做什麼練什麼,全自動不吃點數(跑步/烹飪/槍械/近戰),各系統呼叫 addProf 累積用量

export const SKILL_DEFS = [
  // ── 生存 ──
  { id: 'fitness',  branch: '生存', icon: '💪', name: '強健體魄', max: 2, desc: (lv) => `體力上限 +${15 * lv}` },
  { id: 'lightfoot', branch: '生存', icon: '🐾', name: '輕足',     max: 2, desc: (lv) => `腳步噪音 -${25 * lv}%` },
  { id: 'forager',  branch: '生存', icon: '🧺', name: '採集達人', max: 2, desc: (lv) => `搜刮 ${35 * lv}% 機率多拿 1 件` },
  // ── 戰鬥 ──
  { id: 'melee',    branch: '戰鬥', icon: '🪓', name: '近戰專精', max: 2, desc: (lv) => `近戰傷害 +${20 * lv}%` },
  { id: 'marksman', branch: '戰鬥', icon: '🎯', name: '神射手',   max: 2, desc: (lv) => `遠程傷害 +${15 * lv}%${lv >= 2 ? ',箭 90% 可回收' : ''}` },
  { id: 'resist',   branch: '戰鬥', icon: '🧬', name: '強韌血統', max: 2, desc: (lv) => `咬傷感染機率 -${Math.round((1 - 0.6 ** lv) * 100)}%` },
  // ── 製作 ──
  { id: 'artisan',  branch: '製作', icon: '🔨', name: '巧手工匠', max: 1, desc: () => '製作/建造材料 -20%' },
  { id: 'builder',  branch: '製作', icon: '🏗', name: '建築師',   max: 1, desc: () => '新建築耐久 +50%' },
  { id: 'medic',    branch: '製作', icon: '🩹', name: '急救專精', max: 1, desc: () => '繃帶回復 15 → 25 HP' },
];

// 熟練度軌(規格 7.7:常跑步→體力上限、常做菜→烹飪回復、常用槍→後座力;近戰是主要戰鬥手段,補一軌)
// steps = 每級需要的「用量」增量(累計),最多 Lv5;unit 只給 UI 顯示
export const PROF_DEFS = [
  { id: 'run',   icon: '🏃', name: '跑步', unit: '秒',   steps: [60, 120, 180, 240, 300], desc: (lv) => `體力上限 +${4 * lv}` },
  { id: 'cook',  icon: '🍳', name: '烹飪', unit: '次',   steps: [2, 4, 6, 9, 12],         desc: (lv) => `烹飪品效果 +${10 * lv}%` },
  { id: 'gun',   icon: '🔫', name: '槍械', unit: '發',   steps: [6, 10, 14, 18, 22],      desc: (lv) => `槍械冷卻 -${5 * lv}%` },
  { id: 'melee', icon: '🗡', name: '近戰', unit: '次命中', steps: [10, 18, 26, 34, 42],   desc: (lv) => `近戰體力消耗 -${5 * lv}%` },
];

export class Skills {
  constructor() {
    this.xp = 0;      // 目前等級內累積的 XP
    this.level = 1;
    this.points = 0;  // 未花費的技能點
    this.lv = {};     // {skillId: 已升等級}
    this.profUse = {}; // {profId: 累計用量}(等級由 profLevel 從門檻推算)
    this.onProf = null; // 熟練度升級通知(main 掛 toast;node 測試不用掛)
  }

  // 升到下一級需要的 XP(60、90、120……越後面越慢)
  xpNeed() {
    return 60 + (this.level - 1) * 30;
  }

  // 加 XP;回傳這次升了幾級(0 = 沒升)
  addXp(n) {
    if (n <= 0) return 0;
    this.xp += n;
    let ups = 0;
    while (this.xp >= this.xpNeed()) {
      this.xp -= this.xpNeed();
      this.level++;
      this.points++;
      ups++;
    }
    return ups;
  }

  levelOf(id) {
    return this.lv[id] || 0;
  }

  canUp(id) {
    const def = SKILL_DEFS.find((s) => s.id === id);
    return !!def && this.points > 0 && this.levelOf(id) < def.max;
  }

  // 加點;成功回傳訊息,失敗回傳 null
  up(id) {
    if (!this.canUp(id)) return null;
    const def = SKILL_DEFS.find((s) => s.id === id);
    this.points--;
    this.lv[id] = this.levelOf(id) + 1;
    return `${def.icon} ${def.name} Lv${this.lv[id]}:${def.desc(this.lv[id])}`;
  }

  // ── 熟練度軌 ──

  // 目前等級(0~5):用累計用量對門檻推算
  profLevel(id) {
    const def = PROF_DEFS.find((p) => p.id === id);
    if (!def) return 0;
    let used = this.profUse[id] || 0;
    let lv = 0;
    for (const need of def.steps) {
      if (used < need) break;
      used -= need;
      lv++;
    }
    return lv;
  }

  // 目前級內進度 {cur, need};滿級回傳 null
  profProgress(id) {
    const def = PROF_DEFS.find((p) => p.id === id);
    if (!def) return null;
    let used = this.profUse[id] || 0;
    for (const need of def.steps) {
      if (used < need) return { cur: used, need };
      used -= need;
    }
    return null; // 滿級
  }

  // 累積用量;升級時經由 onProf 通知(回傳這次是否升級)
  addProf(id, n) {
    if (n <= 0) return false;
    const before = this.profLevel(id);
    this.profUse[id] = (this.profUse[id] || 0) + n;
    const after = this.profLevel(id);
    if (after > before) {
      const def = PROF_DEFS.find((p) => p.id === id);
      this.onProf?.(`${def.icon} ${def.name}熟練 Lv${after}:${def.desc(after)}`);
      return true;
    }
    return false;
  }

  // ── 效果查詢(各系統呼叫;沒學 = 原值)──
  staminaBonus() { return 15 * this.levelOf('fitness') + 4 * this.profLevel('run'); } // Stats.staminaMax
  noiseMult()    { return 1 - 0.25 * this.levelOf('lightfoot'); }  // Player.noiseRadius
  bonusLootChance() { return 0.35 * this.levelOf('forager'); }     // Interaction 搜刮
  meleeMult()    { return 1 + 0.2 * this.levelOf('melee'); }       // Combat.melee
  rangedMult()   { return 1 + 0.15 * this.levelOf('marksman'); }   // Combat.shoot
  arrowRecover() { return this.levelOf('marksman') >= 2 ? 0.9 : 0.6; }
  biteMult()     { return 0.6 ** this.levelOf('resist'); }         // Stats.applyBite
  costMult()     { return this.levelOf('artisan') ? 0.8 : 1; }     // Crafting/Building 材料
  buildHpMult()  { return this.levelOf('builder') ? 1.5 : 1; }     // Buildings.place
  bandageBonus() { return this.levelOf('medic') ? 10 : 0; }        // Items bandage
  cookMult()     { return 1 + 0.1 * this.profLevel('cook'); }      // Items cooked/boiled
  gunCdMult()    { return 1 - 0.05 * this.profLevel('gun'); }      // Combat.shoot 冷卻(槍,弓不算)
  meleeStamMult() { return 1 - 0.05 * this.profLevel('melee'); }   // Combat.melee 體力消耗

  // 存讀檔
  serialize() {
    return { xp: this.xp, level: this.level, points: this.points, lv: { ...this.lv }, prof: { ...this.profUse } };
  }

  loadFrom(data) {
    if (!data) return;
    this.xp = data.xp || 0;
    this.level = data.level || 1;
    this.points = data.points || 0;
    this.lv = { ...(data.lv || {}) };
    this.profUse = { ...(data.prof || {}) }; // 舊檔沒 prof = 從零開始
  }
}

// 各行為的 XP 值(擊殺另見 Zombies TYPES.xp)
export const XP = { loot: 3, gather: 2, corpse: 2, craft: 4, build: 5, day: 25 };
