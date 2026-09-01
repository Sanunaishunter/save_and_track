# data/

由 GitHub Actions(`.github/workflows/daily-scan.yml`)自動產生,不要手動編輯。

| 路徑 | 內容 |
| --- | --- |
| `history/YYYY-MM-DD.json` | 當日上市全市場 OHLCV。`columns` 定義欄位順序,`rows` 是精簡陣列。只保留最近 25 個交易日(MA20 需要 20 天 + 緩衝) |
| `scans/YYYY-MM-DD.json` | 當日爆量掃描結果存查 |
| `scan-latest.json` | 最新一次掃描結果,前端讀這支 |
| `stock_names.json` | 代碼 → 名稱對照(直接取自 TWSE 回應) |

資料來源全部是 TWSE,免 token、免額度:

- 每日增量:OpenAPI `STOCK_DAY_ALL`(最新交易日全市場,一次呼叫)
- 歷史回補:`MI_INDEX?date=YYYYMMDD&type=ALL`(可指定過去日期)

資料範圍:**上市普通股**。篩選規則是代碼為四位數字且開頭非 0,因此排除
ETF(00 開頭)、權證(六位數)、特別股(如 2887A);當日無成交的個股也會剔除。

計算:`vol_ratio = 當日量 / MA20`,MA20 為 shift(1) 的前 20 個交易日均量(不含當日);
爆量條件為 `vol_ratio > 1.5` 且 `close > open`。
