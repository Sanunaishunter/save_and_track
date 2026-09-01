# data/

由 GitHub Actions(`.github/workflows/daily-scan.yml`)自動產生,不要手動編輯。

| 路徑 | 內容 |
| --- | --- |
| `history/YYYY-MM-DD.json` | 當日上市全市場 OHLCV。`columns` 定義欄位順序,`rows` 是精簡陣列。只保留最近 25 個交易日(MA20 需要 20 天 + 緩衝) |
| `scans/YYYY-MM-DD.json` | 當日爆量掃描結果存查 |
| `scan-latest.json` | 最新一次掃描結果,前端讀這支 |
| `stock_names.json` | 代碼 → 名稱對照(直接取自 TWSE 回應) |
| `fomo-latest.json` | 最新一次 FOMO 掃描結果,前端讀這支 |
| `fomo/YYYY-MM-DD.json` | 當日 FOMO 結果存底 |

資料來源全部是 TWSE,免 token、免額度:

- 每日增量:OpenAPI `STOCK_DAY_ALL`(最新交易日全市場,一次呼叫)
- 歷史回補:`MI_INDEX?date=YYYYMMDD&type=ALL`(可指定過去日期)

資料範圍:**上市普通股**。篩選規則是代碼為四位數字且開頭非 0,因此排除
ETF(00 開頭)、權證(六位數)、特別股(如 2887A);當日無成交的個股也會剔除。

計算:`vol_ratio = 當日量 / MA20`,MA20 為 shift(1) 的前 20 個交易日均量(不含當日);
爆量條件為 `vol_ratio > 1.5` 且 `close > open`。


---

## FOMO 掃描(另一條線)

與爆量掃描完全獨立,由 `.github/workflows/fomo-scan.yml` 產生:

- 觀察名單在 repo 根目錄的 `watchlist.json`(手動維護,10~30 檔)
- 資料來自 FinMind 四個 dataset:價量、融資融券、三大法人、PER/PBR
- 另外打一次 TWSE T86(全市場個股法人買賣超)算「佔全市場買超」的分母。
  分母用「買超個股加總」而非市場買賣差額 —— 差額可能是負數
  (實測 2026-08-31 外資淨賣超 143 億),當分母算出的百分比沒有意義
- 法人類別以 FinMind 的 name 欄位區分,實測只有五種:Foreign_Investor、
  Investment_Trust、Foreign_Dealer_Self、Dealer_self、Dealer_Hedging。
  外資取 Foreign_Investor(不含外資自營商),與 T86 的外資定義一致
- 金額為「淨買賣超股數 × 收盤價」的推估值,dataset 沒有金額欄位,顯示時標「約」
- Token 由 GitHub Secret `FINMIND_TOKEN` 注入 runner,**不會進入任何靜態檔案**
- 門檻常數集中在 `scripts/fomo_score.py` 的 `THRESHOLDS`

⚠️ FOMO 用的是 `data/fomo/`,爆量掃描用的是 `data/history/`,兩者不共用路徑。
