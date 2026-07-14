// 迷你 GLB 載入器:只支援本專案資產的格式(單一 mesh/primitive、緊湊排列、內嵌貼圖)。
// 刻意不用 three/examples 的 GLTFLoader——它 import 裸字串 'three',沒 importmap 載不了(同 lib/three.js 的考量)。
// 資產由 tools/convert_model.py 從 FBX 轉出(減面+貼圖縮 512+最大邊正規化為 1、原點在底部中心)。
import * as THREE from './three.js';

export async function loadGLB(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('不是 GLB 檔');
  const jsonLen = dv.getUint32(12, true);
  const json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, jsonLen)));
  const binStart = 20 + jsonLen + 8; // 跳過 BIN chunk header

  const slice = (acc, Type, itemSize) => {
    const bv = json.bufferViews[acc.bufferView];
    return new Type(buf, binStart + (bv.byteOffset || 0) + (acc.byteOffset || 0), acc.count * itemSize);
  };
  const prim = json.meshes[0].primitives[0];
  const A = json.accessors;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(slice(A[prim.attributes.POSITION], Float32Array, 3), 3));
  geometry.setAttribute('normal', new THREE.BufferAttribute(slice(A[prim.attributes.NORMAL], Float32Array, 3), 3));
  geometry.setAttribute('uv', new THREE.BufferAttribute(slice(A[prim.attributes.TEXCOORD_0], Float32Array, 2), 2));
  const ia = A[prim.indices];
  geometry.setIndex(new THREE.BufferAttribute(slice(ia, ia.componentType === 5125 ? Uint32Array : Uint16Array, 1), 1));

  // 內嵌貼圖 → Lambert 材質(配合全遊戲的光照風格);glTF 的 UV 原點在左上,flipY 要關
  let material = new THREE.MeshLambertMaterial();
  const im = json.images?.[0];
  if (im) {
    const bv = json.bufferViews[im.bufferView];
    const blob = new Blob([new Uint8Array(buf, binStart + (bv.byteOffset || 0), bv.byteLength)], { type: im.mimeType });
    const img = await new Promise((ok, err) => {
      const el = new Image();
      el.onload = () => { URL.revokeObjectURL(el.src); ok(el); };
      el.onerror = err;
      el.src = URL.createObjectURL(blob);
    });
    const tex = new THREE.Texture(img);
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.needsUpdate = true;
    material = new THREE.MeshLambertMaterial({ map: tex });
  }
  return { geometry, material };
}

// 物品 3D 模型;個別載入失敗回 null,遊戲退回程序化外觀不會壞
// 多個 id 可共用同一檔(髒水瓶/煮沸水共用軟木塞水壺),同檔只抓一次
export async function loadItemModels(base = 'assets/models/') {
  const files = {
    berry: 'berries.glb', canned: 'canned.glb', cooked: 'cookedmeat.glb',
    bat: 'bat.glb', axe: 'fireaxe.glb',
    bottled: 'canteen.glb', dirty: 'flask.glb', boiled: 'flask.glb',
  };
  const cache = new Map();
  const out = {};
  await Promise.all(Object.entries(files).map(async ([id, f]) => {
    try {
      if (!cache.has(f)) cache.set(f, loadGLB(base + f));
      out[id] = await cache.get(f);
    } catch (e) { console.warn('物品模型載入失敗:', f, e); out[id] = null; }
  }));
  return out;
}
