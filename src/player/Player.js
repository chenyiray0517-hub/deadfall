import * as THREE from '../lib/three.js';
import { terrainHeight, TERRAIN_SIZE, SPAWN, resolveColliders, isDeepWater } from '../world/Terrain.js';

const EYE_HEIGHT = 1.7;
const CROUCH_HEIGHT = 1.0;
const WALK_SPEED = 4.2;
const RUN_SPEED = 7.5;
const CROUCH_SPEED = 2.0;
const JUMP_SPEED = 5.5;
const JUMP_STAMINA = 10;   // 跳躍 -10 體力(規格 3.4)
const GRAVITY = 16;
const MOUSE_SENS = 0.0022;
const SAFE_FALL_SPEED = 10;   // 落地速度超過此值開始摔傷
const FALL_DMG_PER_SPEED = 6;

export class Player {
  constructor(camera, domElement, stats) {
    this.camera = camera;
    this.domElement = domElement;
    this.stats = stats;

    this.position = new THREE.Vector3(0, 0, 0);
    this.velocityY = 0;
    this.yaw = 0;
    this.pitch = 0;
    this.onGround = true;
    this.crouching = false;
    this.eyeHeight = EYE_HEIGHT;

    this.keys = {};
    this.locked = false;

    this.position.set(SPAWN.x, terrainHeight(SPAWN.x, SPAWN.z), SPAWN.z);

    addEventListener('keydown', (e) => {
      this.keys[e.code] = true;
      // 避免空白鍵捲動頁面
      if (e.code === 'Space') e.preventDefault();
    });
    addEventListener('keyup', (e) => { this.keys[e.code] = false; });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.domElement;
    });
    document.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.stats.alive) return;
      this.yaw -= e.movementX * MOUSE_SENS;
      this.pitch -= e.movementY * MOUSE_SENS;
      const lim = Math.PI / 2 - 0.05;
      this.pitch = THREE.MathUtils.clamp(this.pitch, -lim, lim);
    });
  }

  lock() {
    this.domElement.requestPointerLock();
  }

  // 目前製造的噪音半徑(感染者聽覺偵測用,規格 5.3:奔跑>行走>蹲行)
  get noiseRadius() {
    const { running, moving } = this.stats.activity;
    if (!moving) return 0;
    if (running) return 18;
    if (this.crouching) return 3;
    return 9;
  }

  update(dt) {
    const stats = this.stats;
    const controllable = this.locked && stats.alive;

    // 蹲伏:平滑升降視線高度
    this.crouching = controllable && !!(this.keys['ControlLeft'] || this.keys['ControlRight']);
    const targetEye = this.crouching ? CROUCH_HEIGHT : EYE_HEIGHT;
    this.eyeHeight += (targetEye - this.eyeHeight) * Math.min(dt * 12, 1);

    // 移動方向(相對視角)
    const input = new THREE.Vector3(
      (this.keys['KeyD'] ? 1 : 0) - (this.keys['KeyA'] ? 1 : 0),
      0,
      (this.keys['KeyS'] ? 1 : 0) - (this.keys['KeyW'] ? 1 : 0)
    );

    const moving = input.lengthSq() > 0 && controllable;
    const wantRun = (this.keys['ShiftLeft'] || this.keys['ShiftRight']) && !this.crouching;
    // 體力耗盡會被強制停跑,要回復到一定值才能再衝刺
    const running = moving && wantRun && stats.canSprint;

    if (moving) {
      input.normalize().applyAxisAngle(new THREE.Vector3(0, 1, 0), this.yaw);
      let speed = this.crouching ? CROUCH_SPEED : (running ? RUN_SPEED : WALK_SPEED);
      speed *= stats.speedMultiplier; // HP < 30% 移速 -15%
      const prevX = this.position.x, prevZ = this.position.z;
      this.position.addScaledVector(input, speed * dt);
      // 深水禁區:先擋住(游泳之後再做)
      if (isDeepWater(this.position.x, this.position.z)) {
        this.position.x = prevX;
        this.position.z = prevZ;
      }
    }
    resolveColliders(this.position, 0.4);

    // 回報行為給數值系統(飢渴消耗、體力增減都在 Stats 內計算)
    stats.activity.moving = moving;
    stats.activity.running = running;

    // 地圖邊界
    const half = TERRAIN_SIZE / 2 - 2;
    this.position.x = THREE.MathUtils.clamp(this.position.x, -half, half);
    this.position.z = THREE.MathUtils.clamp(this.position.z, -half, half);

    // 跳躍與重力,貼合地形高度
    const groundY = terrainHeight(this.position.x, this.position.z);
    if (this.onGround && controllable && this.keys['Space'] && !this.crouching) {
      if (stats.trySpendStamina(JUMP_STAMINA)) {
        this.velocityY = JUMP_SPEED;
        this.onGround = false;
      }
    }
    if (!this.onGround) {
      this.velocityY -= GRAVITY * dt;
      this.position.y += this.velocityY * dt;
      if (this.position.y <= groundY) {
        // 落地:超過安全速度造成摔傷
        const impact = -this.velocityY;
        if (impact > SAFE_FALL_SPEED) {
          stats.damage((impact - SAFE_FALL_SPEED) * FALL_DMG_PER_SPEED, '墜落');
        }
        this.position.y = groundY;
        this.velocityY = 0;
        this.onGround = true;
      }
    } else {
      // 走在起伏地形上直接貼地
      this.position.y = groundY;
    }

    // 套用到相機
    this.camera.position.set(
      this.position.x,
      this.position.y + this.eyeHeight,
      this.position.z
    );
    this.camera.quaternion.setFromEuler(new THREE.Euler(this.pitch, this.yaw, 0, 'YXZ'));
  }
}
