// 任務系統(M8f-2,規格 7.9 支線:NPC 個人任務/陣營任務)
// 純邏輯、不 import three,可直接用 node 跑測試;UI 全在 main.js
//
// 三種目標:
//   collect 交出指定物品(交差時扣掉)
//   kill    擊殺 N 隻感染者(main 在擊殺時呼叫 onKill)
//   visit   前往地圖上一個標記點取回信物(座標由 Npc.pickQuestSpot 產生,再交回來)
//
// 倖存者的個人任務(unlockRecruit)交差後才願意跟你走 → 招募見 entities/Companion.js

import { ITEMS } from '../player/Items.js';

export const QUEST_DEFS = [
  // ── 倖存者個人任務:一人一個,交差後解鎖招募 ──
  {
    id: 'sv_food', giver: 'survivor', title: '三天沒吃東西了',
    desc: '「給我點吃的,什麼都好……我就還能再撐一陣子。」',
    goal: { kind: 'collect', items: { canned: 2, bottled: 1 } },
    reward: { caps: 25, xp: 20 },
    unlockRecruit: true,
    done: '「……你真的回來了。」他把罐頭抱在懷裡,像抱著一整個明天。',
  },
  {
    id: 'sv_relic', giver: 'survivor', title: '妹妹的音樂盒',
    desc: '「我逃出來時什麼都沒帶。老家在那個方向——幫我把她的音樂盒拿回來,好嗎?」',
    goal: { kind: 'visit', r: 14, item: 'musicbox' },
    reward: { caps: 30, xp: 25 },
    unlockRecruit: true,
    done: '他轉了兩圈發條,聽完整首才開口:「好了。我沒有理由留在這裡了。」',
  },
  {
    id: 'sv_revenge', giver: 'survivor', title: '替老陳討回來',
    desc: '「牠們把老陳拖進屋裡。我就躲在櫃子後面聽著,什麼都沒做。」',
    goal: { kind: 'kill', type: 'any', n: 6 },
    reward: { caps: 35, xp: 30 },
    unlockRecruit: true,
    done: '「六隻。」他點點頭,把刀擦乾淨。「下次換我走在前面。」',
  },
  // ── 陣營任務:可重複,隔天再接 ──
  {
    id: 'ark_supply', giver: 'trader', title: '商隊的補給單',
    desc: '「方舟那邊要材料。木頭跟廢鐵,你帶得回來,瓶蓋就是你的。」',
    goal: { kind: 'collect', items: { wood: 5, scrap: 3 } },
    reward: { caps: 40, xp: 20, rep: { ark: 8 } },
    repeatable: true,
    done: '「爽快。下次還有貨單,記得來拿。」',
  },
  {
    id: 'ark_meds', giver: 'medic', title: '診所缺布料',
    desc: '「繃帶用完了。乾淨的布,有多少我收多少。」',
    goal: { kind: 'collect', items: { cloth: 4 } },
    reward: { caps: 15, xp: 20, items: { bandage: 2 }, rep: { ark: 6 } },
    repeatable: true,
    done: '「這些夠撐幾天了。拿兩捲繃帶走,別跟我客氣。」',
  },
  {
    id: 'white_sample', giver: 'scientist', title: '樣本採集',
    desc: '「清掉八隻,越新鮮越好。我要的是數據,不是英雄。」',
    goal: { kind: 'kill', type: 'any', n: 8 },
    reward: { caps: 20, xp: 35, items: { antibiotic: 1 }, rep: { white: 10 } },
    repeatable: true,
    done: '「數字對上了。」他在本子上劃掉一行。「你比上一個送樣本的人活得久。」',
  },
];

export const questDef = (id) => QUEST_DEFS.find((q) => q.id === id) || null;

// 個人任務照倖存者的生成順序一人一個(NpcManager 指派)
export const PERSONAL_QUESTS = QUEST_DEFS.filter((q) => q.unlockRecruit).map((q) => q.id);

export class QuestLog {
  constructor() {
    this.active = [];    // {id, npcIdx, prog:{kill,got}, spot:{x,z}|null}
    this.finished = {};  // questId → 交差當天的天數(可重複任務隔天才能再接)
  }

  get(id) { return this.active.find((q) => q.id === id) || null; }

  // 這個 NPC 現在能給的任務(已接的、做完不可重複的、當天剛交過的都不給)
  offerFor(npc, day) {
    const wanted = npc.questId
      ? [npc.questId]                                                   // 倖存者:綁定他自己那一個
      : QUEST_DEFS.filter((d) => d.giver === npc.type && !d.unlockRecruit).map((d) => d.id);
    for (const id of wanted) {
      const def = questDef(id);
      if (!def || this.get(id)) continue;
      const fin = this.finished[id];
      if (fin !== undefined && (!def.repeatable || fin >= day)) continue;
      return def;
    }
    return null;
  }

  // 這個 NPC 身上有沒有待交的任務(玩家走回去交差用)
  pendingFor(npcIdx) {
    return this.active.find((q) => q.npcIdx === npcIdx) || null;
  }

  // spot:visit 型任務的目標座標(由呼叫端提供,純邏輯層不碰世界)
  accept(def, npcIdx, spot = null) {
    if (this.get(def.id)) return null;
    const q = { id: def.id, npcIdx, prog: { kill: 0, got: false }, spot };
    this.active.push(q);
    return q;
  }

  abandon(q) {
    const i = this.active.indexOf(q);
    if (i >= 0) this.active.splice(i, 1);
  }

  // 擊殺事件:回傳有進度更新的任務
  onKill(type) {
    const upd = [];
    for (const q of this.active) {
      const g = questDef(q.id).goal;
      if (g.kind !== 'kill' || q.prog.kill >= g.n) continue;
      if (g.type !== 'any' && g.type !== type) continue;
      q.prog.kill++;
      upd.push(q);
    }
    return upd;
  }

  // 位置事件(main 每 0.25 秒呼叫):走到標記點就拿到信物,回傳剛達成的任務
  onVisit(x, z) {
    const got = [];
    for (const q of this.active) {
      const g = questDef(q.id).goal;
      if (g.kind !== 'visit' || q.prog.got || !q.spot) continue;
      if (Math.hypot(q.spot.x - x, q.spot.z - z) <= g.r) {
        q.prog.got = true;
        got.push(q);
      }
    }
    return got;
  }

  isComplete(q, inv) {
    const g = questDef(q.id).goal;
    if (g.kind === 'collect') return Object.entries(g.items).every(([id, n]) => inv.count(id) >= n);
    if (g.kind === 'kill') return q.prog.kill >= g.n;
    if (g.kind === 'visit') return q.prog.got && inv.count(g.item) > 0;
    return false;
  }

  // 面板上的進度字串
  progressText(q, inv) {
    const g = questDef(q.id).goal;
    if (g.kind === 'collect') {
      return Object.entries(g.items)
        .map(([id, n]) => `${ITEMS[id].icon}${ITEMS[id].name} ${Math.min(inv.count(id), n)}/${n}`)
        .join('　');
    }
    if (g.kind === 'kill') return `擊殺感染者 ${q.prog.kill}/${g.n}`;
    if (g.kind === 'visit') {
      if (!q.prog.got) return `前往標記地點(${Math.round(q.spot?.x ?? 0)}, ${Math.round(q.spot?.z ?? 0)})`;
      return `已取得${ITEMS[g.item].icon}${ITEMS[g.item].name},回去交給他`;
    }
    return '';
  }

  // 交差:扣掉要交的東西、發獎勵(聲望由呼叫端套用);沒完成回傳 null
  turnIn(q, inv, day) {
    if (!this.isComplete(q, inv)) return null;
    const def = questDef(q.id);
    const g = def.goal;
    if (g.kind === 'collect') for (const [id, n] of Object.entries(g.items)) inv.remove(id, n);
    if (g.kind === 'visit') inv.remove(g.item, 1);
    this.abandon(q);
    this.finished[q.id] = day;
    const r = def.reward;
    if (r.caps) inv.add('caps', r.caps);
    for (const [id, n] of Object.entries(r.items || {})) inv.add(id, n);
    return { def, reward: r };
  }

  // 獎勵摘要(面板顯示用)
  rewardText(def) {
    const parts = [];
    if (def.reward.caps) parts.push(`🔘${def.reward.caps}`);
    for (const [id, n] of Object.entries(def.reward.items || {})) parts.push(`${ITEMS[id].icon}${ITEMS[id].name}×${n}`);
    if (def.reward.xp) parts.push(`${def.reward.xp} XP`);
    for (const [f, n] of Object.entries(def.reward.rep || {})) parts.push(`聲望 +${n}`);
    return parts.join('　');
  }

  serialize() {
    return {
      active: this.active.map((q) => ({ id: q.id, n: q.npcIdx, k: q.prog.kill, g: q.prog.got ? 1 : 0, s: q.spot })),
      fin: { ...this.finished },
    };
  }

  loadFrom(data) {
    if (!data) return; // 舊檔沒有任務 = 全新開始
    this.active = (data.active || [])
      .filter((s) => questDef(s.id))
      .map((s) => ({ id: s.id, npcIdx: s.n, prog: { kill: s.k || 0, got: !!s.g }, spot: s.s || null }));
    this.finished = { ...(data.fin || {}) };
  }
}
