import * as THREE from '../lib/three.js';

// 日夜循環:一天 = 現實 40 分鐘(規格 4.1)
const DAY_LENGTH_SEC = 40 * 60;

// 天空色關鍵影格(依 24 小時制)
const SKY_KEYS = [
  { t: 0,    sky: '#070b14', fog: '#0a0e14', sun: 0.0 },   // 深夜
  { t: 4.5,  sky: '#070b14', fog: '#0a0e14', sun: 0.0 },
  { t: 6,    sky: '#b7683f', fog: '#8f6a4e', sun: 0.35 },  // 日出
  { t: 8,    sky: '#7fa8c9', fog: '#a8b8b0', sun: 0.9 },
  { t: 13,   sky: '#8fb8d8', fog: '#b8c4b4', sun: 1.0 },   // 正午
  { t: 17.5, sky: '#7fa0bd', fog: '#a89f8a', sun: 0.8 },
  { t: 19,   sky: '#a5502f', fog: '#6e4a38', sun: 0.3 },   // 日落
  { t: 20.5, sky: '#0b1020', fog: '#0d1118', sun: 0.0 },
  { t: 24,   sky: '#070b14', fog: '#0a0e14', sun: 0.0 },
];

export class TimeSystem {
  constructor(scene) {
    this.scene = scene;
    this.timeOfDay = 6;   // 從清晨 6 點開始
    this.day = 1;
    this.timeScale = 1;   // T 鍵切換加速

    this.sun = new THREE.DirectionalLight('#fff3d6', 1);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.camera.left = -60;
    this.sun.shadow.camera.right = 60;
    this.sun.shadow.camera.top = 60;
    this.sun.shadow.camera.bottom = -60;
    this.sun.shadow.camera.far = 300;
    this.sun.shadow.bias = -0.0002;
    this.sun.shadow.normalBias = 0.05;
    scene.add(this.sun, this.sun.target);

    this.moon = new THREE.DirectionalLight('#5a6f9e', 0.12);
    scene.add(this.moon, this.moon.target);

    this.hemi = new THREE.HemisphereLight('#8fb8d8', '#4a4436', 0.5);
    scene.add(this.hemi);

    this.stars = createStars();
    scene.add(this.stars);

    scene.background = new THREE.Color();
    scene.fog = new THREE.Fog('#a8b8b0', 60, 380);

    this._skyColor = new THREE.Color();
    this._fogColor = new THREE.Color();
    this._c1 = new THREE.Color();
    this._c2 = new THREE.Color();
  }

  // playerPos:讓太陽陰影相機跟著玩家走
  update(dt, playerPos) {
    this.timeOfDay += (dt * this.timeScale) * (24 / DAY_LENGTH_SEC);
    if (this.timeOfDay >= 24) {
      this.timeOfDay -= 24;
      this.day++;
    }
    const t = this.timeOfDay;

    // 太陽軌道:6 點升起、18 點落下
    const sunAngle = ((t - 6) / 24) * Math.PI * 2;
    const sunDir = new THREE.Vector3(
      Math.cos(sunAngle) * 0.6,
      Math.sin(sunAngle),
      0.35
    ).normalize();

    this.sun.position.copy(playerPos).addScaledVector(sunDir, 120);
    this.sun.target.position.copy(playerPos);
    this.moon.position.copy(playerPos).addScaledVector(sunDir, -120);
    this.moon.target.position.copy(playerPos);

    // 天空/霧色與光強插值
    const key = sampleKeys(t, this._c1, this._c2);
    this._skyColor.copy(key.sky);
    this._fogColor.copy(key.fog);
    this.scene.background.copy(this._skyColor);
    this.scene.fog.color.copy(this._fogColor);

    this.sunStrength = key.sun; // 供 nightFactor 使用
    this.sun.intensity = key.sun * 1.6;
    this.sun.visible = key.sun > 0.01;
    this.moon.intensity = (1 - key.sun) * 0.14;
    this.hemi.intensity = 0.16 + key.sun * 0.72;

    // 夜晚星星淡入
    const night = 1 - THREE.MathUtils.smoothstep(key.sun, 0, 0.3);
    this.stars.material.opacity = night * 0.9;
    this.stars.visible = night > 0.02;
    this.stars.position.copy(playerPos);
  }

  // 0=白天 1=深夜,感染者夜晚加成用(規格 4.1)
  get nightFactor() {
    const s = this.sunStrength ?? 1;
    return 1 - Math.min(1, s / 0.35);
  }

  // 每現實秒經過幾個遊戲小時(含 T 鍵加速),供 Stats 換算飢渴消耗
  get hoursPerRealSecond() {
    return this.timeScale * 24 / DAY_LENGTH_SEC;
  }

  toggleSpeed() {
    this.timeScale = this.timeScale === 1 ? 120 : 1;
    return this.timeScale;
  }

  get clockText() {
    const h = Math.floor(this.timeOfDay);
    const m = Math.floor((this.timeOfDay - h) * 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
  }
}

// 在 SKY_KEYS 之間做線性插值
function sampleKeys(t, c1, c2) {
  let a = SKY_KEYS[0], b = SKY_KEYS[SKY_KEYS.length - 1];
  for (let i = 0; i < SKY_KEYS.length - 1; i++) {
    if (t >= SKY_KEYS[i].t && t <= SKY_KEYS[i + 1].t) {
      a = SKY_KEYS[i];
      b = SKY_KEYS[i + 1];
      break;
    }
  }
  const f = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t);
  return {
    sky: c1.set(a.sky).lerp(new THREE.Color(b.sky), f),
    fog: c2.set(a.fog).lerp(new THREE.Color(b.fog), f),
    sun: a.sun + (b.sun - a.sun) * f,
  };
}

function createStars() {
  const COUNT = 1200;
  const positions = new Float32Array(COUNT * 3);
  for (let i = 0; i < COUNT; i++) {
    // 均勻灑在上半球
    const theta = Math.random() * Math.PI * 2;
    const phi = Math.acos(Math.random());
    const r = 420;
    positions[i * 3] = r * Math.sin(phi) * Math.cos(theta);
    positions[i * 3 + 1] = r * Math.cos(phi) + 5;
    positions[i * 3 + 2] = r * Math.sin(phi) * Math.sin(theta);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({
    color: '#cdd6e8', size: 1.4, sizeAttenuation: false,
    transparent: true, opacity: 0, fog: false, depthWrite: false,
  });
  return new THREE.Points(geo, mat);
}
