// 音效引擎:全部用 Web Audio API 程序化合成,不需要任何音檔素材(免下載、免 build)
// - import 時零副作用(不建 AudioContext);要等使用者手勢後呼叫 sfx.unlock() 才會出聲,
//   所以 _test_*.html 與 headless 環境 import 本檔完全安全,沒 unlock 前所有呼叫都是 no-op。
// - 2D 音:sfx.play(name, {vol, pan, rate});世界音:sfx.play3d(name, x, z, {vol, dist}),
//   依 sfx.setListener(x, z, yaw)(main 每幀更新)做距離衰減 + 左右聲道定位。
// - 持續音(引擎/營火/心跳)用 setLoop(name, on, {vol, rate}),緩衝區程序化生成、無縫循環。
// - M 鍵靜音由 main 呼叫 toggleMute(),偏好存 localStorage(獨立於遊戲存檔,?nosave 不影響)。

const MASTER_VOL = 0.5;
const MUTE_KEY = 'deadfall_muted';

let ctx = null;
let master = null;
let noiseBuf = null;
let muted = false;
try { muted = localStorage.getItem(MUTE_KEY) === '1'; } catch { /* 無 localStorage 環境 */ }

const listener = { x: 0, z: 0, yaw: 0 };
const lastAt = {};                  // 每種音效的節流(避免同幀疊爆)
let cur = { vol: 1, pan: 0, rate: 1 }; // play() 呼叫期間的音量/聲道係數(generator 同步取用)

const rnd = (a, b) => a + Math.random() * (b - a);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

// ── 基礎合成元件 ──

function env(g, t, vol, attack, dur) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(Math.max(0.0001, vol), t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
}

// 輸出端:有聲道偏移就插一顆 StereoPanner(播完會被 GC)
function destFor(pan) {
  const p = clamp(pan, -1, 1);
  if (p && ctx.createStereoPanner) {
    const node = ctx.createStereoPanner();
    node.pan.value = p;
    node.connect(master);
    return node;
  }
  return master;
}

// 單音:f0→f1 掃頻、可加顫音(vib 深度 Hz/vibHz 速率)與低通(lp)
function tone({ f0, f1 = null, type = 'sine', dur = 0.2, vol = 0.3, delay = 0, attack = 0.005, vib = 0, vibHz = 6, lp = 0 }) {
  const t = ctx.currentTime + delay;
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(Math.max(1, f0), t);
  if (f1 !== null) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
  if (vib > 0) {
    const lfo = ctx.createOscillator();
    const lg = ctx.createGain();
    lfo.frequency.value = vibHz;
    lg.gain.value = vib;
    lfo.connect(lg).connect(o.frequency);
    lfo.start(t);
    lfo.stop(t + dur + 0.05);
  }
  const g = ctx.createGain();
  env(g, t, vol * cur.vol, attack, dur);
  let node = o;
  if (lp > 0) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = lp;
    node.connect(f);
    node = f;
  }
  node.connect(g).connect(destFor(cur.pan));
  o.start(t);
  o.stop(t + dur + 0.05);
}

// 噪音爆:可過濾波器(type/f0→f1/q)
function noise({ dur = 0.2, vol = 0.3, delay = 0, attack = 0.003, type = null, f0 = 1000, f1 = null, q = 1 }) {
  const t = ctx.currentTime + delay;
  const src = ctx.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  const g = ctx.createGain();
  env(g, t, vol * cur.vol, attack, dur);
  let node = src;
  if (type) {
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(f0, t);
    if (f1) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
    node.connect(f);
    node = f;
  }
  node.connect(g).connect(destFor(cur.pan));
  src.start(t, Math.random() * 1.5); // 隨機起點,連放也不會聽起來一樣
  src.stop(t + dur + 0.1);
}

// ── 音效表:名稱 → 合成函式 ──

const SOUNDS = {
  // ── 移動/身體 ──
  step: () => noise({ dur: 0.07, vol: 0.3, type: 'lowpass', f0: rnd(380, 700) }),
  jump: () => noise({ dur: 0.18, vol: 0.18, type: 'bandpass', f0: 350, f1: 900, q: 1.2 }),
  land: () => {
    tone({ f0: 130, f1: 50, dur: 0.12, vol: 0.35 });
    noise({ dur: 0.09, vol: 0.28, type: 'lowpass', f0: 320 });
  },
  pant: () => {
    for (let i = 0; i < 2; i++) noise({ delay: i * 0.42, dur: 0.28, vol: 0.16, attack: 0.08, type: 'bandpass', f0: 550, q: 0.8 });
  },
  hurt: () => {
    tone({ f0: rnd(150, 180), f1: 85, type: 'sawtooth', dur: 0.18, vol: 0.3, lp: 900 });
    noise({ dur: 0.1, vol: 0.15, type: 'bandpass', f0: 750, q: 1 });
  },
  bite: () => {
    noise({ dur: 0.12, vol: 0.4, type: 'bandpass', f0: 1400, q: 2 });
    tone({ f0: 110, f1: 55, dur: 0.16, vol: 0.32 });
  },
  death: () => {
    tone({ f0: 110, f1: 32, type: 'sawtooth', dur: 1.5, vol: 0.4, lp: 500 });
    noise({ dur: 1.2, vol: 0.2, attack: 0.15, type: 'lowpass', f0: 260 });
  },
  infection: () => {
    for (let i = 0; i < 3; i++) tone({ delay: i * 0.4, f0: 72 - i * 4, dur: 0.32, vol: 0.3, attack: 0.05 });
  },
  // ── 吃喝/用品 ──
  eat: () => {
    for (let i = 0; i < 3; i++) noise({ delay: i * 0.16, dur: 0.09, vol: 0.3, type: 'bandpass', f0: rnd(900, 1400), q: 2 });
  },
  drink: () => {
    for (let i = 0; i < 3; i++) tone({ delay: i * 0.22, f0: rnd(300, 380), f1: rnd(150, 200), dur: 0.12, vol: 0.25 });
  },
  bandage: () => {
    noise({ dur: 0.3, vol: 0.2, attack: 0.06, type: 'highpass', f0: 1500 });
    noise({ delay: 0.35, dur: 0.25, vol: 0.16, attack: 0.06, type: 'highpass', f0: 1800 });
  },
  pill: () => {
    for (let i = 0; i < 4; i++) noise({ delay: i * 0.05, dur: 0.03, vol: 0.14, type: 'bandpass', f0: 3000, q: 3 });
    tone({ delay: 0.3, f0: 330, f1: 170, dur: 0.12, vol: 0.22 });
  },
  inject: () => {
    noise({ dur: 0.2, vol: 0.12, attack: 0.04, type: 'highpass', f0: 3500 });
    tone({ delay: 0.16, f0: 500, f1: 300, dur: 0.06, vol: 0.15 });
  },
  // ── 戰鬥 ──
  swing: () => noise({ dur: 0.16, vol: 0.3, type: 'bandpass', f0: 400, f1: 1400, q: 1.5 }),
  hitFlesh: () => {
    tone({ f0: 140, f1: 70, dur: 0.1, vol: 0.42 });
    noise({ dur: 0.08, vol: 0.35, type: 'bandpass', f0: 520, q: 1 });
  },
  chop: () => {
    tone({ f0: 170, f1: 90, type: 'triangle', dur: 0.09, vol: 0.45 });
    noise({ dur: 0.05, vol: 0.3, type: 'bandpass', f0: 900, q: 1 });
  },
  break: () => {
    noise({ dur: 0.12, vol: 0.4, type: 'bandpass', f0: 2200, q: 1.5 });
    tone({ f0: 300, f1: 100, type: 'sawtooth', dur: 0.1, vol: 0.2 });
  },
  bow: () => {
    tone({ f0: 220, f1: 90, type: 'triangle', dur: 0.12, vol: 0.35 });
    noise({ dur: 0.14, vol: 0.2, type: 'bandpass', f0: 600, f1: 1400, q: 1.5 });
  },
  dryfire: () => noise({ dur: 0.03, vol: 0.25, type: 'bandpass', f0: 2500, q: 4 }),
  pistol: () => {
    noise({ dur: 0.16, vol: 0.85, type: 'highpass', f0: 300 });
    tone({ f0: 180, f1: 45, dur: 0.18, vol: 0.7 });
  },
  shotgun: () => {
    noise({ dur: 0.3, vol: 1.0, type: 'lowpass', f0: 3800 });
    tone({ f0: 120, f1: 32, dur: 0.35, vol: 0.9 });
  },
  equip: () => {
    noise({ dur: 0.06, vol: 0.18, type: 'bandpass', f0: 1800, q: 1.5 });
    noise({ delay: 0.07, dur: 0.04, vol: 0.15, type: 'bandpass', f0: 2600, q: 3 });
  },
  // ── 感染者 ──
  growl: () => tone({ f0: rnd(72, 108), dur: rnd(0.6, 1.0), type: 'sawtooth', vol: 0.3, attack: 0.1, vib: 12, vibHz: 5, lp: 420 }),
  dogGrowl: () => {
    for (let i = 0; i < 2; i++) tone({ delay: i * 0.2, f0: rnd(140, 180), f1: rnd(190, 230), type: 'sawtooth', dur: 0.16, vol: 0.28, lp: 900 });
  },
  scream: () => {
    tone({ f0: 280, f1: 640, type: 'sawtooth', dur: 0.35, vol: 0.42, vib: 25, vibHz: 9, lp: 2400 });
    tone({ delay: 0.35, f0: 640, f1: 210, type: 'sawtooth', dur: 0.45, vol: 0.4, vib: 25, vibHz: 9, lp: 2400 });
  },
  zhurt: () => tone({ f0: rnd(120, 165), f1: 80, type: 'sawtooth', dur: 0.25, vol: 0.3, lp: 700 }),
  zdie: () => tone({ f0: 100, f1: 38, type: 'sawtooth', dur: 1.0, vol: 0.35, attack: 0.04, vib: 8, vibHz: 4, lp: 480 }),
  horde: () => {
    tone({ f0: 52, dur: 2.6, vol: 0.3, attack: 0.5 }); // 低鳴打底
    for (let i = 0; i < 6; i++) {
      cur.pan = rnd(-0.7, 0.7);
      tone({ delay: rnd(0, 2), f0: rnd(70, 110), dur: rnd(0.7, 1.1), type: 'sawtooth', vol: 0.22, attack: 0.12, vib: 12, vibHz: 5, lp: 420 });
    }
  },
  // ── 建造/互動 ──
  knock: () => {
    tone({ f0: 120, f1: 70, type: 'triangle', dur: 0.1, vol: 0.5 });
    noise({ dur: 0.06, vol: 0.3, type: 'lowpass', f0: 420 });
  },
  crash: () => {
    for (let i = 0; i < 3; i++) tone({ delay: i * 0.11, f0: rnd(110, 160), f1: 65, type: 'triangle', dur: 0.1, vol: 0.4 });
    noise({ dur: 0.5, vol: 0.45, type: 'lowpass', f0: 650 });
  },
  place: () => {
    for (let i = 0; i < 2; i++) {
      tone({ delay: i * 0.16, f0: 200, f1: 120, type: 'triangle', dur: 0.06, vol: 0.35 });
      noise({ delay: i * 0.16, dur: 0.04, vol: 0.2, type: 'bandpass', f0: 1100, q: 1 });
    }
  },
  door: () => {
    tone({ f0: 85, f1: 150, type: 'sawtooth', dur: 0.4, vol: 0.1, attack: 0.06, vib: 18, vibHz: 11, lp: 800 });
    noise({ delay: 0.4, dur: 0.04, vol: 0.2, type: 'bandpass', f0: 1600, q: 2 });
  },
  chestOpen: () => {
    noise({ dur: 0.2, vol: 0.24, attack: 0.03, type: 'bandpass', f0: 700, q: 1 });
    noise({ delay: 0.16, dur: 0.04, vol: 0.2, type: 'bandpass', f0: 1500, q: 2 });
  },
  craft: () => {
    for (let i = 0; i < 2; i++) noise({ delay: i * 0.13, dur: 0.05, vol: 0.25, type: 'bandpass', f0: rnd(1000, 1600), q: 2 });
    noise({ delay: 0.28, dur: 0.14, vol: 0.18, type: 'highpass', f0: 1400 });
  },
  sizzle: () => noise({ dur: 0.9, vol: 0.24, attack: 0.12, type: 'highpass', f0: 2500 }),
  ignite: () => {
    noise({ dur: 0.5, vol: 0.35, type: 'bandpass', f0: 200, f1: 1000, q: 1 });
    for (let i = 0; i < 4; i++) noise({ delay: 0.2 + i * 0.09, dur: 0.03, vol: 0.2, type: 'bandpass', f0: rnd(2000, 3600), q: 3 });
  },
  pickup: () => noise({ dur: 0.12, vol: 0.25, type: 'bandpass', f0: 1100, q: 1.5 }),
  rustle: () => noise({ dur: 0.25, vol: 0.22, attack: 0.04, type: 'highpass', f0: 1200 }),
  splash: () => {
    noise({ dur: 0.3, vol: 0.35, type: 'bandpass', f0: 900, q: 1 });
    for (let i = 0; i < 2; i++) tone({ delay: 0.18 + i * 0.12, f0: rnd(550, 750), f1: rnd(850, 1000), dur: 0.05, vol: 0.12 });
  },
  // ── UI/系統 ──
  ui: () => tone({ f0: 660, dur: 0.07, vol: 0.15 }),
  uiOff: () => tone({ f0: 440, dur: 0.07, vol: 0.12 }),
  skill: () => {
    tone({ f0: 880, dur: 0.3, vol: 0.2 });
    tone({ delay: 0.07, f0: 1320, dur: 0.25, vol: 0.15 });
  },
  prof: () => tone({ f0: 740, dur: 0.25, vol: 0.18 }),
  levelup: () => {
    [523, 659, 784].forEach((f, i) => tone({ delay: i * 0.12, f0: f, dur: 0.35, vol: 0.2 }));
  },
  day: () => {
    tone({ f0: 660, dur: 0.5, vol: 0.12, attack: 0.05 });
    for (let i = 0; i < 4; i++) tone({ delay: 0.15 + i * 0.18, f0: rnd(2200, 3200), f1: rnd(1800, 2400), dur: 0.08, vol: 0.1 });
  },
  sleep: () => {
    noise({ dur: 0.8, vol: 0.2, attack: 0.3, type: 'lowpass', f0: 500 });
    tone({ f0: 300, f1: 150, dur: 0.8, vol: 0.1, attack: 0.2 });
  },
  // ── 載具 ──
  wrench: () => {
    for (let i = 0; i < 2; i++) {
      tone({ delay: i * 0.18, f0: 900, type: 'square', dur: 0.04, vol: 0.16 });
      noise({ delay: i * 0.18, dur: 0.25, vol: 0.2, type: 'bandpass', f0: 1800, q: 8 });
    }
  },
  carDoor: () => {
    tone({ f0: 150, f1: 90, dur: 0.08, vol: 0.4 });
    noise({ dur: 0.06, vol: 0.3, type: 'lowpass', f0: 500 });
  },
  refuel: () => {
    for (let i = 0; i < 4; i++) tone({ delay: i * 0.18, f0: rnd(150, 220), f1: rnd(90, 120), dur: 0.12, vol: 0.22 });
  },
  thudMetal: () => {
    tone({ f0: 95, f1: 55, dur: 0.1, vol: 0.4 });
    noise({ dur: 0.3, vol: 0.2, type: 'bandpass', f0: 1400, q: 7 });
  },
  crashMetal: () => {
    noise({ dur: 0.25, vol: 0.6, type: 'bandpass', f0: 900, q: 1 });
    noise({ dur: 0.5, vol: 0.3, type: 'bandpass', f0: 2400, q: 10 });
    tone({ f0: 110, f1: 45, dur: 0.2, vol: 0.5 });
  },
  sputter: () => {
    const gaps = [0, 0.12, 0.28, 0.5, 0.8];
    for (const d of gaps) tone({ delay: d, f0: 90, f1: 55, type: 'sawtooth', dur: 0.07, vol: 0.28, lp: 600 });
  },
};

// ── 持續音(無縫循環緩衝區,程序化生成後快取)──

const LOOP_VOL = { engine: 0.3, bike: 0.22, campfire: 0.5, heartbeat: 0.45 };
const loopBufs = {};
const loops = {}; // name → {src, g}

function makeLoopBuf(name) {
  const sr = ctx.sampleRate;
  let len, fill;
  if (name === 'engine') {
    // 引擎:低頻諧波 × 27Hz 汽缸脈動 + 一點噪音(頻率都取整數週期,循環無縫)
    len = sr;
    fill = (d) => {
      for (let i = 0; i < len; i++) {
        const t = i / sr;
        const pulse = 0.55 + 0.45 * (0.5 + 0.5 * Math.sin(2 * Math.PI * 27 * t));
        d[i] = (Math.sin(2 * Math.PI * 55 * t) * 0.6 + Math.sin(2 * Math.PI * 110 * t) * 0.25 +
                Math.sin(2 * Math.PI * 165 * t) * 0.12 + (Math.random() * 2 - 1) * 0.13) * pulse * 0.5;
      }
    };
  } else if (name === 'bike') {
    // 腳踏車:飛輪喀噠聲 + 微弱滾動沙沙,playbackRate 隨車速
    len = Math.floor(sr * 0.35);
    fill = (d) => {
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * 0.02;
      for (let i = 0; i < 500; i++) d[i] += (Math.random() * 2 - 1) * Math.exp(-i / 90) * 0.5;
    };
  } else if (name === 'campfire') {
    // 營火:悶燒底噪 + 隨機爆裂聲
    len = sr * 2;
    fill = (d) => {
      let b = 0;
      for (let i = 0; i < len; i++) {
        b = (b + 0.02 * (Math.random() * 2 - 1)) / 1.02;
        d[i] = b * 1.4;
      }
      for (let p = 0; p < 18; p++) {
        const at = Math.floor(Math.random() * (len - 600));
        const amp = rnd(0.25, 0.7);
        for (let j = 0; j < 500; j++) d[at + j] += (Math.random() * 2 - 1) * Math.exp(-j / 70) * amp;
      }
    };
  } else {
    // heartbeat:撲通(lub-dub)一輪 1.1 秒,rate 隨危急程度加快
    len = Math.floor(sr * 1.1);
    fill = (d) => {
      const thump = (at, amp) => {
        const start = Math.floor(at * sr);
        for (let j = 0; j < sr * 0.1 && start + j < len; j++) {
          const tj = j / sr;
          d[start + j] += Math.sin(2 * Math.PI * 52 * tj) * Math.exp(-tj * 34) * amp;
        }
      };
      thump(0.02, 0.9);
      thump(0.24, 0.55);
    };
  }
  const buf = ctx.createBuffer(1, len, sr);
  fill(buf.getChannelData(0));
  return buf;
}

// ── 對外介面 ──

export const sfx = {
  get muted() { return muted; },

  // 使用者手勢後啟動(可重複呼叫,冪等)
  unlock() {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      ctx = new AC();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : MASTER_VOL;
      master.connect(ctx.destination);
      noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
  },

  toggleMute() {
    muted = !muted;
    try { localStorage.setItem(MUTE_KEY, muted ? '1' : '0'); } catch { /* ignore */ }
    if (master) master.gain.setTargetAtTime(muted ? 0 : MASTER_VOL, ctx.currentTime, 0.02);
    return muted;
  },

  // main 每幀更新(世界音的衰減與定位基準)
  setListener(x, z, yaw) {
    listener.x = x;
    listener.z = z;
    listener.yaw = yaw;
  },

  play(name, o = {}) {
    if (!ctx || ctx.state !== 'running') return;
    const gen = SOUNDS[name];
    if (!gen) return;
    const now = ctx.currentTime;
    if (now - (lastAt[name] || -9) < 0.05) return; // 同名節流
    lastAt[name] = now;
    cur = { vol: o.vol ?? 1, pan: o.pan ?? 0, rate: o.rate ?? 1 };
    gen(cur);
  },

  // 世界音:距離線性衰減至 dist 歸零;左右聲道 = 音源在視角的哪一側
  play3d(name, x, z, o = {}) {
    if (!ctx || ctx.state !== 'running') return;
    const dist = o.dist ?? 45;
    const dx = x - listener.x;
    const dz = z - listener.z;
    const d = Math.hypot(dx, dz);
    if (d >= dist) return;
    const fall = 1 - d / dist;
    const pan = d > 1 ? clamp((dx * Math.cos(listener.yaw) - dz * Math.sin(listener.yaw)) / d, -1, 1) * 0.7 : 0;
    this.play(name, { vol: (o.vol ?? 1) * fall * fall, pan });
  },

  // 持續音開關:engine / bike / campfire / heartbeat
  setLoop(name, on, { vol = 1, rate = 1 } = {}) {
    if (!ctx || ctx.state !== 'running') return;
    let L = loops[name];
    if (!on) {
      if (L) {
        L.g.gain.setTargetAtTime(0, ctx.currentTime, 0.06);
        L.src.stop(ctx.currentTime + 0.4);
        delete loops[name];
      }
      return;
    }
    if (!L) {
      loopBufs[name] = loopBufs[name] || makeLoopBuf(name);
      const src = ctx.createBufferSource();
      src.buffer = loopBufs[name];
      src.loop = true;
      const g = ctx.createGain();
      g.gain.value = 0;
      src.connect(g).connect(master);
      src.start();
      L = loops[name] = { src, g };
    }
    L.src.playbackRate.value = rate;
    L.g.gain.setTargetAtTime(vol * (LOOP_VOL[name] ?? 0.3) * (muted ? 0 : 1), ctx.currentTime, 0.08);
  },

  // 試聽頁用
  names() { return Object.keys(SOUNDS); },
};
