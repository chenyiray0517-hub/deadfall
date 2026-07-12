// 四大生存數值(規格書第 3 章)
// 飢餓/口渴以「遊戲小時」計算消耗;體力與歸零扣血以現實秒計算

const HP_LOW_THRESHOLD = 30;      // HP < 30%:畫面泛紅、移速 -15%
const STAMINA_EXHAUST_RECOVER = 25; // 體力歸零後要回到這值才能再奔跑

export class Stats {
  constructor() {
    this.hp = 100;
    this.hunger = 100;
    this.thirst = 100;
    this.stamina = 100;
    this.alive = true;
    this.deathCause = '';
    this.exhausted = false;   // 體力耗盡狀態(強制停跑)
    this.lastDamageCause = '';
    this.ageHours = 0;        // 累計遊戲時數(狀態效果計時用)
    this.effects = [];        // {id, label, until(遊戲時)}
    this.infection = 0;       // 感染值 0~100,滿了轉化死亡(規格 3.5)

    // 由 Player 每幀回報目前行為
    this.activity = { running: false, moving: false };
  }

  get staminaMax() {
    return this.hunger <= 0 ? 50 : 100; // 飢餓歸零:體力上限減半
  }

  // HP < 30% 移動速度 -15%
  get speedMultiplier() {
    return this.hp < HP_LOW_THRESHOLD ? 0.85 : 1;
  }

  get canSprint() {
    return !this.exhausted && this.stamina > 0;
  }

  damage(amount, cause) {
    if (!this.alive || amount <= 0) return;
    this.hp = Math.max(0, this.hp - amount);
    this.lastDamageCause = cause;
    if (this.hp <= 0) this.die(cause);
  }

  // 感染者攻擊:傷害 + 咬傷感染判定(規格 3.5)
  applyBite(amount, cause) {
    this.damage(amount, cause);
    if (this.alive && Math.random() < 0.3) {
      this.infection = Math.min(100, this.infection + 8 + Math.random() * 6);
    }
  }

  trySpendStamina(amount) {
    if (this.stamina < amount) return false;
    this.stamina -= amount;
    if (this.stamina <= 0) this.exhausted = true;
    return true;
  }

  die(cause) {
    this.alive = false;
    this.deathCause = cause;
  }

  addEffect(id, hours, label) {
    const existing = this.effects.find((e) => e.id === id);
    const until = this.ageHours + hours;
    if (existing) existing.until = Math.max(existing.until, until);
    else this.effects.push({ id, label, until });
  }

  hasEffect(id) {
    return this.effects.some((e) => e.id === id);
  }

  removeEffect(id) {
    this.effects = this.effects.filter((e) => e.id !== id);
  }

  // dt:現實秒;gameHourDt:這一幀經過的遊戲小時數
  update(dt, gameHourDt) {
    if (!this.alive) return;
    const { running, moving } = this.activity;

    // 狀態效果計時與清理
    this.ageHours += gameHourDt;
    this.effects = this.effects.filter((e) => e.until > this.ageHours);

    // ── 飽食度:靜止 -1.5/遊戲時,勞動(奔跑) -3(規格 3.2)──
    this.hunger -= (running ? 3 : 1.5) * gameHourDt;
    // ── 口渴度:-2.5/遊戲時,奔跑 ×2;痢疾 ×3(規格 3.3/3.5)──
    const dysentery = this.hasEffect('dysentery') ? 3 : 1;
    this.thirst -= 2.5 * (running ? 2 : 1) * dysentery * gameHourDt;
    this.hunger = Math.max(0, this.hunger);
    this.thirst = Math.max(0, this.thirst);

    // ── 歸零懲罰(現實秒)──
    if (this.hunger <= 0) this.damage(dt / 5, '餓死');   // 每 5 秒 -1 HP
    if (this.thirst <= 0) this.damage(dt / 3, '渴死');   // 每 3 秒 -1 HP(更致命)

    // ── 體力(現實秒,規格 3.4)──
    if (running && moving) {
      // 奔跑 -5/秒;口渴 < 25% 時體力消耗 +30%
      const drainMult = this.thirst < 25 ? 1.3 : 1;
      this.stamina -= 5 * drainMult * dt;
      if (this.stamina <= 0) {
        this.stamina = 0;
        this.exhausted = true;
      }
    } else {
      // 恢復:站立 +8/秒、行走 +4/秒
      let regen = moving ? 4 : 8;
      if (this.hunger < 25) regen *= 0.5;      // 低飽食:恢復 -50%
      else if (this.hunger > 80) regen *= 1.25; // 高飽食:恢復 +25%
      this.stamina = Math.min(this.staminaMax, this.stamina + regen * dt);
      if (this.exhausted && this.stamina >= STAMINA_EXHAUST_RECOVER) {
        this.exhausted = false;
      }
    }
    this.stamina = Math.min(this.stamina, this.staminaMax);

    // ── 自然回血:飽食度 > 60% 才啟動,> 80% 加速(規格 3.1/3.2)──
    if (this.hp > 0 && this.hp < 100 && this.hunger > 60 && this.thirst > 0) {
      const rate = this.hunger > 80 ? 4.5 : 3; // HP/遊戲時
      this.hp = Math.min(100, this.hp + rate * gameHourDt);
    }

    // ── 感染值:一旦感染就緩慢惡化,抗生素凍結,血清清零;滿 100 轉化(規格 3.5)──
    if (this.infection > 0 && this.alive) {
      if (!this.hasEffect('antibiotic')) {
        this.infection = Math.min(100, this.infection + 1.2 * gameHourDt);
      }
      if (this.infection >= 100) this.die('感染全面發作,轉化為感染者');
    }
  }
}
