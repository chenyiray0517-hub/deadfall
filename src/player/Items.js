// 物品定義(規格第 6 章的子集,夠活下去就好,之後逐步擴充)
// use(stats, inv) 回傳訊息字串;沒有 use 的是材料

const clamp = (v) => Math.min(100, v);

export const ITEMS = {
  berry: {
    name: '野莓', icon: '🫐', consumable: true,
    use(s) { s.hunger = clamp(s.hunger + 8); s.thirst = clamp(s.thirst + 3); return '+8 飽食 +3 口渴'; },
  },
  canned: {
    name: '罐頭', icon: '🥫', consumable: true,
    use(s) { s.hunger = clamp(s.hunger + 30); return '+30 飽食'; },
  },
  bottled: {
    name: '瓶裝水', icon: '🥤', consumable: true,
    use(s, inv) { s.thirst = clamp(s.thirst + 50); inv.add('empty', 1); return '+50 口渴,留下空瓶'; },
  },
  dirty: {
    name: '髒水瓶', icon: '🫗', consumable: true,
    use(s, inv) {
      s.thirst = clamp(s.thirst + 30);
      inv.add('empty', 1);
      // 直接喝髒水:40% 痢疾(規格 3.3)
      if (Math.random() < 0.4) {
        s.addEffect('dysentery', 3, '🤢 痢疾');
        return '+30 口渴……肚子開始絞痛(痢疾!)';
      }
      return '+30 口渴(這次運氣不錯)';
    },
  },
  boiled: {
    name: '煮沸水', icon: '♨️', consumable: true,
    use(s, inv) { s.thirst = clamp(s.thirst + 40); inv.add('empty', 1); return '+40 口渴'; },
  },
  bandage: {
    name: '繃帶', icon: '🩹', consumable: true,
    use(s) {
      const heal = 15 + (s.skills ? s.skills.bandageBonus() : 0); // 🩹 急救專精
      s.hp = clamp(s.hp + heal);
      return `+${heal} HP`;
    },
  },
  rawmeat: {
    name: '生肉', icon: '🥩', consumable: true,
    use(s) {
      s.hunger = clamp(s.hunger + 15);
      // 生食 55% 食物中毒(規格 6.1)
      if (Math.random() < 0.55) {
        s.addEffect('foodpoison', 2, '🤮 食物中毒');
        return '+15 飽食……胃在翻騰(食物中毒!)';
      }
      return '+15 飽食(還是烤過再吃吧)';
    },
  },
  cooked: {
    name: '烤肉', icon: '🍖', consumable: true,
    use(s) { s.hunger = clamp(s.hunger + 35); s.hp = clamp(s.hp + 5); return '+35 飽食 +5 HP'; },
  },
  antibiotic: {
    name: '抗生素', icon: '💊', consumable: true,
    use(s) {
      s.removeEffect('dysentery');
      s.removeEffect('foodpoison');
      s.addEffect('antibiotic', 2, '💊 抗生素');
      return '治癒腸胃疾病,感染凍結 2 小時';
    },
  },
  serum: {
    name: '抗病毒血清', icon: '💉', consumable: true,
    use(s) { s.infection = 0; return '感染值清零!撿回一條命'; },
  },
  // ── 武器(規格 6.4/6.5 起步集)──
  // melee:dmg 傷害/cd 冷卻秒/stam 體力/range 揮擊距離/dur 耐久/noise 噪音半徑
  // ranged:ammo 彈藥 id;noise 0 = 無聲;falloff = 距離衰減(霰彈)
  bat: {
    name: '木棒', icon: '🏏', weapon: 'melee',
    dmg: 15, cd: 0.6, stam: 8, range: 2.2, dur: 40, noise: 8,
  },
  pipe: {
    name: '鐵管', icon: '🔧', weapon: 'melee',
    dmg: 25, cd: 0.8, stam: 10, range: 2.2, dur: 60, noise: 8,
  },
  handaxe: {
    name: '自製斧', icon: '🪓', weapon: 'melee',
    dmg: 30, cd: 1.0, stam: 12, range: 2.4, dur: 120, noise: 8,
  },
  axe: {
    name: '消防斧', icon: '🪓', weapon: 'melee',
    dmg: 45, cd: 1.1, stam: 15, range: 2.6, dur: 80, noise: 8,
  },
  bow: {
    name: '自製弓', icon: '🏹', weapon: 'ranged',
    dmg: 30, cd: 1.2, stam: 3, range: 45, ammo: 'arrow', noise: 0,
  },
  pistol: {
    name: '手槍', icon: '🔫', weapon: 'ranged',
    dmg: 35, cd: 0.5, range: 50, ammo: 'ammo9', noise: 60,
  },
  shotgun: {
    name: '獵槍', icon: '💥', weapon: 'ranged',
    dmg: 90, cd: 1.2, range: 22, ammo: 'shell', noise: 90, falloff: true,
  },
  empty: { name: '空瓶', icon: '🧴' },
  cloth: { name: '布料', icon: '🧵' },
  wood: { name: '木柴', icon: '🪵' },
  scrap: { name: '廢金屬', icon: '⚙️' },
  arrow: { name: '木箭', icon: '➶' },
  // ── 載具零件與燃料(M8c,規格 7.5)──
  engine: { name: '引擎零件', icon: '🔩' },
  tire: { name: '輪胎', icon: '🛞' },
  battery: { name: '電瓶', icon: '🔋' },
  fuel: { name: '汽油桶', icon: '⛽' },
  ammo9: { name: '9mm 彈', icon: '•' },
  shell: { name: '霰彈', icon: '🔴' },
};

// 快捷欄:依此優先序顯示「持有的」消耗品,最多 8 格
export const QUICKBAR_PRIORITY = [
  'berry', 'canned', 'rawmeat', 'cooked', 'bottled', 'dirty', 'boiled', 'bandage', 'antibiotic', 'serum',
];

// 武器在快捷欄的排序(數字鍵 = 裝備/收起)
export const WEAPON_ORDER = ['bat', 'pipe', 'handaxe', 'axe', 'bow', 'pistol', 'shotgun'];

// 快捷欄動態組成:持有的武器優先,再來是消耗品,最多 8 格
export function quickbarIds(inv) {
  const ids = [];
  for (const id of [...WEAPON_ORDER, ...QUICKBAR_PRIORITY]) {
    if (inv.count(id) > 0) ids.push(id);
  }
  return ids.slice(0, 8);
}

export class Inventory {
  constructor() { this.items = new Map(); }
  add(id, n = 1) { this.items.set(id, (this.items.get(id) || 0) + n); }
  count(id) { return this.items.get(id) || 0; }
  remove(id, n = 1) {
    const c = this.count(id);
    if (c < n) return false;
    if (c === n) this.items.delete(id); else this.items.set(id, c - n);
    return true;
  }
  // 使用一個消耗品,回傳訊息或 null
  use(id, stats) {
    const def = ITEMS[id];
    if (!def || !def.consumable || this.count(id) <= 0) return null;
    this.remove(id, 1);
    return def.use(stats, this);
  }
}
