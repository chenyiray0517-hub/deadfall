# 殘存之境 Deadfall — 開發筆記

3D 喪屍生存遊戲。完整規格見 `殘存之境_遊戲規格書.html`（01 故事 + 03~08 機制為準；02 的技術選型不採用）。

## 技術

- Three.js 0.170.0,由 `src/lib/three.js` 用完整 CDN 網址 re-export(需網路),**免 build、免 npm**。所有檔案都從 `lib/three.js` import,升級版本只改那一行。
  - 刻意不用 importmap:用戶的 Safari 15.6 不支援(要 16.4+),曾因此整個遊戲跑不起來。實測 Chrome OK。
- 純 ES modules,結構依規格書 2.2 的目錄雛形。
- 執行方式:在專案根目錄開靜態 server,例如:
  ```
  python3 -m http.server 8000
  ```
  然後開 http://localhost:8000 (不能直接雙擊 index.html,ES modules 需要 http)。

## 進度(規格書 2.3 里程碑)

- [x] **M1 基礎**:3D 場景 + 第一人稱移動(WASD/Shift 跑/Space 跳/Ctrl 蹲/滑鼠視角)+ 日夜循環(一天 = 現實 40 分鐘,T 鍵 x120 加速測試)+ FPS 顯示
- [x] **M2 生存**:四大數值(HP/飽食/口渴/體力,規格第 3 章數值)+ HUD 數值條 + 低血泛紅/口渴視野模糊 + 墜落傷害 + 死亡畫面(重新開始 = reload;之後 M7 有床再做重生點)
- [x] **M3 世界**:三大生態區(荒野西/鄉村中/城市東,邊界帶狀扭動)+ 湖泊 + 公路/城市路網 + 農舍/穀倉/大樓/廢棄車 + 物資點(野果叢/補給箱/垃圾堆,互動等 M4)+ 基本碰撞 + HUD 區域名稱
- [x] **M4 互動**:10 種物品 + 背包/快捷欄(1-6 使用)+ E 互動拾取(野果/樹枝/補給箱/垃圾堆)+ 湖邊喝水/裝水 + Tab 製作面板(繃帶/營火/煮沸水)+ 痢疾狀態效果
- [x] **M5 敵人**:感染者 AI——遊蕩者/奔跑者/感染犬共 33 隻,視覺(視錐+建築遮擋+蹲伏減半+夜晚+50%)/聽覺(奔跑>行走>蹲行)偵測,狀態機 wander→investigate→chase→search,奔跑者尖叫聚眾、20m 群體警戒、夜晚移速+30%,攻擊玩家(還不能反擊,M6)
- [x] **M6 戰鬥**:近戰×3(木棒可製作/鐵管/消防斧,含耐久與體力消耗)+ 遠程×3(自製弓無聲箭可回收/手槍/獵槍距離衰減)+ 感染者受傷/硬直/死亡屍體可搜刮 + 槍聲引怪 + 感染值系統(咬傷判定/抗生素凍結/血清清零/滿 100 轉化死亡)
- [x] **M7 建造**:B 鍵建造模式(木牆/木門/木刺牆/儲物箱/床,幽靈預覽綠紅染色、左鍵放置可連放)+ 感染者拆牆(建築有耐久)+ 尖刺傷敵 + 床(夜間睡覺快轉+重生點,死亡掉一半物品、箱內不掉)+ 屍潮夜襲(第 3 天起每 3~7 天,規模隨天數成長)+ 斧頭砍樹取木柴
- [x] **M7.5 補坑**(2026-07-12):存讀檔(MVP 驗收項)+ 感染者死後重生(夜晚刷新×2)+ 屍體清理 + 感染犬嗅覺(帶傷追蹤)+ 修 Stats.removeEffect 缺失(抗生素會 crash)
- [x] **M8a 建築室內**(2026-07-12):大樓一樓 3 種(便利商店/辦公室/公寓大廳)+ 鄉村房 3 種(小農舍/農家/工具屋),同種內部佈局固定;可搜刮家具 6 類(貨架/冰箱/櫃台/櫥櫃/衣櫃/辦公桌)各自掉落表;感染者會繞到門口追進室內;存檔的已拿物資點改座標比對
- [ ] M8 其餘深度:NPC、任務、載具、技能樹、劇情

## 架構備忘

- `src/world/Terrain.js`:地形高度是**解析函式** `terrainHeight(x,z)`,任何實體貼地直接呼叫它取樣,不用 raycast。地景擺設用 InstancedMesh + 固定 seed 偽隨機(每次載入一致)。
- `src/core/TimeSystem.js`:`timeOfDay`(0~24)為全遊戲時間源,之後 M2 的數值消耗、M5 的夜晚敵人 buff(速度+30%/偵測+50%)都從這裡讀。太陽陰影相機跟著玩家移動。
- `src/player/Player.js`:玩家位置存 `position`(腳底),相機 = position + eyeHeight。按鍵用 `e.code`。
- 日夜視覺用 `SKY_KEYS` 關鍵影格插值(天空色/霧色/太陽強度)。
- `src/player/Stats.js`:四大數值。**純邏輯、不 import three**,可直接用 node 跑模擬測試(專案有 `package.json` type:module)。飢渴消耗吃「遊戲小時」(`timeSystem.hoursPerRealSecond` 換算,T 鍵加速會同步加快),體力與歸零扣血吃現實秒。Player 每幀把 `activity.running/moving` 回報給 Stats。
- 測試用 URL 參數:`?hp=20&hunger=10&thirst=5&stamina=50` 設初始數值;`?pos=x,z&yaw=角度` 傳送與轉向。
- M3 世界架構:
  - 生態區/道路/高度全是**解析函式**(`biomeWeights`/`roadMask`/`terrainHeight`),不存資料,任何系統直接取樣。荒野=丘陵密林+湖、鄉村=農田+農舍沿公路、城市=棋盤路網(格距 52)+大樓。
  - 碰撞:`Terrain.colliders`(boxes+circles)由建築/樹填入,Player.resolveCollisions 推擠解算。**建立順序:Structures → Terrain(樹避開建築)→ LootSpawner(箱子靠建築)**。
  - 物資點在 `LootSpawner.lootPoints`(type/x/z/taken),M4 拾取系統從這讀。建築位置在 `Structures.structureSpots`。
  - 湖泊深水區用 `isDeepWater` 擋玩家(僅限湖範圍!荒野有乾涸低谷,別只看高度)。
  - `_test_worldgen.html`:世界生成驗證頁,headless Chrome 開 `/_test_worldgen.html` 用 --dump-dom 看統計。
- M4/M5 架構:
  - 物品定義在 `player/Items.js`(ITEMS + QUICKBAR 順序 + Inventory);配方在 `systems/Crafting.js`(RECIPES + campfires 陣列);互動判定在 `systems/Interaction.js`(findInteraction/doInteract)。
  - 拾取表/隱藏已拿 instance 在 `LootSpawner.rollLoot/takeLoot`。
  - 感染者在 `entities/Zombies.js`:TYPES(walker/runner/dog)+ Zombie 狀態機 + EnemyManager(生成/噪音/群體警戒)。玩家噪音半徑 `player.noiseRadius`(跑18/走9/蹲3),EnemyManager 每 0.4s 廣播。視線遮擋用 `Terrain.losBlocked`(2D slab test)。
  - 鍵位:E 互動、Tab 面板(開著時數字=製作,關著時數字=快捷欄)、1-6 用物品。
  - `_test_m45.html`:M4/M5 邏輯測試頁(21 條,含物品/製作/拾取/AI 感知),同樣用 headless --dump-dom 跑。
  - 尚未做:嗅覺(流血追蹤)、夜晚刷新量×2、感染者死後重生、存讀檔(MVP 驗收項,建議 M8 前補)。
- M6 架構:
  - 戰鬥在 `systems/Combat.js`:近戰=面前扇形取最近(±53°),遠程=視線射線對感染者中心點最近距離(半徑 0.55),都不用 three raycast。武器數值直接放在 `Items.js` 的 ITEMS 內(weapon:'melee'/'ranged' + dmg/cd/stam/range/dur/ammo/noise/falloff)。
  - 快捷欄改動態:`Items.quickbarIds(inv)` = 持有武器(WEAPON_ORDER)優先 + 消耗品(QUICKBAR_PRIORITY),最多 8 格;數字鍵武器=裝備、消耗品=使用。第一人稱武器模型掛在 camera 上(main 有 `scene.add(camera)`)。
  - 感染者 `takeDamage(dmg, fromPos, manager, now)`:硬直 0.35s+紅閃(mats emissive)+反擊追擊;死亡 `die()` 倒地變屍體(corpse/looted/corpseLoot/stuckArrows),搜屍走 Interaction 的 'corpse' 分支(感染犬掉生肉、弓箭 60% 插身可回收)。
  - 近戰耐久記在 `Combat.dur`(Map,依武器 id 跨裝備累計),打中才磨損,壞了移除物品。
  - 感染值在 `Stats.infection`:`applyBite()` 被咬 30% 機率 +8~14,每遊戲時 +1.2 惡化,'antibiotic' 效果凍結、血清(serum)清零、滿 100 死亡。EnemyManager 的 onAttack 已改走 applyBite。
  - 槍聲經 `EnemyManager.hearNoise`(手槍 60/獵槍 90/近戰 8/弓 0)。
  - `_test_m6.html`:M6 邏輯測試頁(20 條),headless --dump-dom 跑。
- M7 架構:
  - 建造在 `systems/Building.js`:BUILDABLES(wall/door/spikes/chest/bed)+ Buildings 類。放置的建築把 AABB 推進 `Terrain.colliders.boxes`,碰撞/AI 視線自動生效;`low:true` 的(尖刺/箱/床)box 帶 `noLos`,losBlocked 會跳過。旋轉吸附 90°,所以佔地永遠軸對齊。
  - 建造模式:B 開建造選單(共用 #panel,panelMode: null/'craft'/'build'/'chest')→ 數字選 → 幽靈預覽(綠=可放紅=不可,含材料判定)→ 左鍵放置(可連放)、右鍵/B 取消。放置中左鍵不會揮武器。
  - 感染者拆牆:Zombie.update 追擊中搆不到玩家時 `buildings.blockingStructure(pos, goal)` 找擋路建築,attackCd 打牆並刷新 lastSeenTime(不會中途放棄);`buildings.damage` 歸零 → destroy(拆 mesh+collider)+ onDestroyed 通知 toast。
  - 尖刺:EnemyManager.update 內對踩在 `spikesAt` 範圍的感染者 10HP/s,尖刺自身 1.5HP/s 磨損。
  - 門:toggleDoor 開 = 從 colliders.boxes splice 掉(不擋路不擋視線)+ mesh 轉 1.25rad。
  - 床:E 睡覺(20:00~05:00 且 45m 內無追擊者)→ `sleepUntilMorning`(快轉到 6 點、+20HP、扣飢渴但不會睡死)+ 設 homeBed。死亡若有床 → `doRespawn`:`dropHalfInventory`(每疊掉一半)+ 感染歸零 + enemies.calmAll。儲物箱 storage 是獨立 Inventory,死亡不掉。
  - 屍潮:`EnemyManager.maybeHorde(timeSystem, playerPos, now)`,main 每 0.25s 檢查;第 3 天起、夜間時刻觸發,在玩家 55~70m 外生成 4+day×2 隻(上限 24)直接 chase,之後 3~7 天冷卻。
  - 斧頭砍樹:Combat.melee 揮空且裝備 axe → 檢查面前 `colliders.circles`(目前只有樹)→ +2 木柴、磨耐久。
  - 測試參數:`?day=N` 設天數(配 `?t=22` 直接觸發屍潮)。
  - `_test_m7.html`:M7 邏輯測試頁(25 條),headless --dump-dom 跑。
- M7.5 架構:
  - 存讀檔在 `systems/SaveSystem.js`:整包狀態 → localStorage `deadfall_save_v1`(時間/數值/背包/武器耐久/建築含箱內/營火/已拿物資點/感染者含屍體/屍潮排程)。建築與感染者細節走各自的 `serialize()/loadFrom()`;物資點還原用 `LootSpawner.hideLoot`(從 takeLoot 拆出)。
  - 自動存檔:20 秒一次 + 睡覺 + 床邊重生後 + beforeunload(都要 `stats.alive`)。死亡且沒床 → 清存檔;有床 → 保留最後一次自動存檔。開始畫面有存檔時顯示「繼續上次/重新開始」按鈕(`awaitingChoice` 擋 overlay 點擊)。**`?nosave=1` = 不讀不存**,測試/截圖一律要帶,免得污染正常存檔。
  - 感染者死後重生:`EnemyManager.populationTarget`(= 初始 33)+ `respawnTimer`(白天 40s/夜晚 20s = 刷新×2),低於人口就 `respawnOne`(玩家 55m 外)。屍體搜刮完 20 秒、或放 5 分鐘消失(`corpseAt/lootedAt`,`die(now)` 要帶時間)。
  - 感染犬嗅覺:玩家 HP<60 = 帶傷(`world.wounded`),22m×(1+0.3×夜) 內不用視線直接 investigate 玩家位置,持續追味。
  - `_test_save.html`:M7.5 邏輯測試頁(29 條),會先備份再還原真實 localStorage 存檔。
- M8a 室內架構:
  - 室內全在 `world/Interiors.js`:`TOWER_TYPES`/`HOUSE_TYPES` 定義佈局(局部座標,+z = 門面),`buildInterior` 蓋殼(分段牆各掛 AABB collider,前牆留門口,門楣只有視覺——collider 是 2D 的裝不了)。旋轉只允許 90° 倍數,collider 永遠軸對齊。牆/地板/天花板/家具/雜物全烘成 InstancedMesh(`finishInteriors`)。
  - 大樓 = 一樓室內殼 + 上層實心 Box(不掛 collider,靠牆段擋人);鄉村房 = 殼 + 錐頂;穀倉仍實心。天花板/地板不掛 collider(跳躍最高 0.94m 撞不到 2.15m 門楣)。
  - 家具 collider 帶 `noLos`;可搜刮家具上有一份「雜物」instance,`furnitureLoot` 準備好完整 lootPoints 條目由 LootSpawner 併入(放陣列尾端,讓野莓/樹枝索引穩定),搜刮走原本的 hideLoot 縮 0,家具本體留著。掉落表在 LootSpawner 的 `FURN_TABLES`。
  - 建築鏤空後 `insideAnyBox` 蓋不到內部:生成迴避(樹/樹枝/垃圾/箱子/感染者出生)改查 `Terrain.noSpawnRects`(`insideNoSpawn`,由 buildInterior 填)。
  - 感染者導航:`Interiors.routeViaDoor(pos, goal)`——目標與自己一內一外時先走該房門口(`interiorRooms` 有每間房的 AABB+門口座標),不然玩家躲屋裡會變無敵。
  - 存檔已拿物資點改存 `[type, x*10, z*10]` 座標比對(`encodeTakenLoot/applyTakenLoot`),世界生成微調不再讓舊檔錯位;舊格式(索引)只還原野莓/樹枝。
  - `_test_interiors.html`:M8a 邏輯測試頁(21 條),headless --dump-dom 跑(記得 --virtual-time-budget=15000,CDN import 要時間)。
- headless 截圖驗證的限制:rAF 迴圈幾乎不前進,只能驗第一幀畫面;跨時間的邏輯(死亡流程等)改用 node 模擬 Stats 驗證。
- headless 跑主頁面(WebGL)要用 `--use-angle=swiftshader`,不能 `--disable-gpu`(WebGL context 會建不起來);邏輯測試頁不受影響。

## 注意

- 用戶會邊開著遊戲邊請你改 code——改檔前先提醒他會需要重新整理。
