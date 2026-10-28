# 台北捷運轉乘快查

網站：https://dylan1211-hub.github.io/taipei-metro/

在地圖上點選起訖站，同時比較「最快／最順／少走路」三種走法，時間拆成進站、等車、搭車、轉乘、出站分段計算，並顯示首末班車。資料來自交通部 [TDX 運輸資料流通服務平臺](https://tdx.transportdata.tw/)。

## 檔案
- `index.html`：網頁本體。同資料夾有 `metro-data.js` 就用 TDX 正式資料，沒有就用估計值。
- `fetch-tdx.mjs`：從 TDX 抓資料並產生 `metro-data.js`（需要 Node.js 18 以上）。
- `tdx-raw/`：TDX 原始資料。
- `.env.example`：金鑰設定範例，複製成 `.env` 後填入。
- `.github/workflows/update-tdx.yml`：每週一 03:17（台北時間）自動更新資料。
- `CLAUDE.md`：開發交接說明。

## 第一次執行
1. 複製 `.env.example` 為 `.env`，填入 Client ID 與 Client Secret。
2. 執行 `node fetch-tdx.mjs`。
3. 用瀏覽器打開 `index.html`，地圖下方會顯示「資料：TDX」。

## 其他指令
- `node fetch-tdx.mjs --force`：不管有沒有變動都重抓。
- `node fetch-tdx.mjs --offline`：不連線，用 `tdx-raw/` 已存的資料重新轉檔。

`.env` 已列在 `.gitignore`，不會被提交。呼叫次數記在 `tdx-usage.json`，超過 `TDX_MONTHLY_BUDGET` 會自動停止。

## 資料說明
- 站間時間、班距、轉乘步行、首末班、車站座標與路線線型來自 TDX；進出站步行時間為估計值。
- 標示「示意」的車廂位置尚未實地確認。
- 底圖：Esri 深灰底圖；行政區界：內政部。
