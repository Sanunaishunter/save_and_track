# data/

由 GitHub Actions(`.github/workflows/daily-scan.yml`)自動產生,不要手動編輯。

| 路徑 | 內容 |
| --- | --- |
| `history/YYYY-MM-DD.json` | 當日上市全市場 OHLCV。`columns` 定義欄位順序,`rows` 是精簡陣列。只保留最近 25 個交易日(MA20 需要 20 天 + 緩衝) |
| `scans/YYYY-MM-DD.json` | 當日爆量掃描結果存查 |
| `scan-latest.json` | 最新一次掃描結果,前端讀這支 |
| `stock_names.json` | 代碼 → 名稱對照(來自 FinMind `TaiwanStockInfo`) |

資料範圍:**上市普通股**。篩選規則是 FinMind `type == "twse"` 且代碼為四位數字、開頭非 0
(因此排除上櫃、00 開頭的 ETF、六位數權證)。

計算:`vol_ratio = 當日量 / MA20`,MA20 為 shift(1) 的前 20 個交易日均量(不含當日);
爆量條件為 `vol_ratio > 1.5` 且 `close > open`。
