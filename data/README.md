# data/

由 GitHub Actions(`.github/workflows/daily-scan.yml`)自動產生,不要手動編輯。
爆量、產業流向、FOMO 在同一個 workflow 的連續步驟裡跑,順序由執行序保證。

| 路徑 | 內容 |
| --- | --- |
| `history/YYYY-MM-DD.json` | 當日上市全市場 OHLCV。`columns` 定義欄位順序,`rows` 是精簡陣列。只保留最近 30 個交易日(MA20 需要 20 天;產業流向的 rebase 圖要顯示 30 天) |
| `scans/YYYY-MM-DD.json` | 當日爆量掃描結果存查 |
| `scan-latest.json` | 最新一次掃描結果,前端讀這支 |
| `stock_names.json` | 代碼 → 名稱對照(直接取自 TWSE 回應) |
| `no_trade_dates.json` | 已確認休市的日期,避免每天重複查詢 |
| `fomo-latest.json` | 最新一次 FOMO 掃描結果,前端讀這支 |
| `fomo/YYYY-MM-DD.json` | 當日 FOMO 結果存底 |
| `stock_meta.json` | 代碼 → 產業別 + 已發行普通股數(產業流向分組用) |
| `tick-latest.json` | 最新一次產業流向交叉表,前端讀這支 |
| `tick/YYYY-MM-DD.json` | 當日產業流向結果存查 |
| `tick-members-latest.json` | 各組凍結成員的逐日成交筆數(前端展開時才載入) |
| `tick-sample-members.json` | 凍結的抽樣名單。**長期狀態,不是每日產出** |

資料來源全部是 TWSE,免 token、免額度:

- 每日增量:OpenAPI `STOCK_DAY_ALL`(最新交易日全市場,一次呼叫)
- 補缺口:`STOCK_DAY_ALL` 是開放資料快取,收盤後不一定馬上更新
  (實測台北 19:53 時仍回傳前一交易日)。因此每天另外用按日期定址的
  `MI_INDEX` 檢查最近 5 個交易日有無缺漏,不受快取延遲影響,
  也能自動修復排程失敗漏掉的日子
- 歷史回補:`MI_INDEX?date=YYYYMMDD&type=ALL`(可指定過去日期)

資料範圍:**上市普通股**。篩選規則是代碼為四位數字且開頭非 0,因此排除
ETF(00 開頭)、權證(六位數)、特別股(如 2887A);當日無成交的個股也會剔除。

計算:`vol_ratio = 當日量 / MA20`,MA20 為 shift(1) 的前 20 個交易日均量(不含當日);
爆量條件為 `vol_ratio > 1.5` 且 `close > open`。


---

## FOMO 掃描(另一條線)

與爆量掃描共用同一個 workflow,排在爆量之後的步驟執行:

- **名單來源預設是爆量掃描的結果**(`scan-latest.json` 的前 30 名,依 vol_ratio)。
  兩者在同一個 job 內依序執行,FOMO 讀到的必定是同一次剛產生的爆量清單
- 檔數有上限是因為額度:每檔要打 4 次 FinMind,未註冊 300 次/小時、
  註冊 600 次/小時。爆量清單常近百檔(9/1 是 99 檔,全打要 397 次會爆掉)
- `watchlist.json`(repo 根目錄)是手動備援,讀不到掃描結果時會自動改用它;
  也可以手動指定 `--source watchlist`
- 資料來自 FinMind 四個 dataset:價量、融資融券、三大法人、PER/PBR
- 另外打一次 TWSE T86(全市場個股法人買賣超)算「佔全市場買超」的分母。
  分母用「買超個股加總」而非市場買賣差額 —— 差額可能是負數
  (實測 2026-08-31 外資淨賣超 143 億),當分母算出的百分比沒有意義
- 法人類別以 FinMind 的 name 欄位區分,實測只有五種:Foreign_Investor、
  Investment_Trust、Foreign_Dealer_Self、Dealer_self、Dealer_Hedging。
  外資取 Foreign_Investor(不含外資自營商),與 T86 的外資定義一致
- 金額為「淨買賣超股數 × 當日收盤價」的推估值,連續期間逐日累加。
  dataset 沒有金額欄位,顯示時一律標「約」
- 輸出檔的 `market_totals` 記錄當日全市場買超/賣超總額(股數),
  就是各檔「佔全市場」百分比的分母,可用來事後核算
- Token 由 GitHub Secret `FINMIND_TOKEN` 注入 runner,**不會進入任何靜態檔案**
- 門檻常數集中在 `scripts/fomo_score.py` 的 `THRESHOLDS`

⚠️ FOMO 用的是 `data/fomo/`,爆量掃描用的是 `data/history/`,兩者不共用路徑。


---

## 產業/市值 Tick 聚合(產業流向)

移植自 SH2 的 8012。純觀察型:看哪個「產業 × 市值級距」今天的成交活躍度
暴增或暴減,**不產生任何進出場訊號**,也不跟爆量/FOMO 的邏輯耦合。

### 活躍度指標

SH2 用的是 Shioaji 的逐筆 tick 數。這邊沒有 tick 資料源,改用 TWSE 每日
行情的**成交筆數**(`STOCK_DAY_ALL` 的 `Transaction` /`MI_INDEX` 的
「成交筆數」)—— 同樣是「今天成交了幾次」,不是股數也不是金額,
語意上是最接近的免費替代。實測 9/1 全市場 4,234,997 筆、1,081 檔都有值。

### 分組

- **產業別**:FinMind `TaiwanStockInfo.industry_category` 原樣落地,
  **不做任何分類合併**(SH2 那邊也沒合併)。實測回傳 57 種,SH2 記錄的
  44 種全都出現;多出來的多半是上櫃 ETF/ETN/受益證券等,四位數非 0 開頭
  的代碼篩選本來就會排掉。少數是分類本身的分歧(觀光事業 vs 觀光餐旅、
  農業科技 vs 農業科技業…),照 SH2 的做法不動它
- **市值**:`已發行普通股數 × 當日收盤價 / 1e8`(億元)。股數取自 TWSE
  OpenAPI `t187ap03_L`(上市公司基本資料),就是 SH2 沒有付費
  `market_value` 欄位時的免費 fallback
- **級距**:`assign_relative_tiers` —— **組內相對排名**,不是絕對門檻。
  單一產業內依市值由大到小排,`ceil(n/3)` / `ceil(2n/3)` 兩刀切成大/中/小。
  常數 `CAP_TIER_LARGE_MIN=1000` / `CAP_TIER_MID_MIN=100` 是 SH2 v1
  deprecated 的絕對門檻,留在程式裡對照,v2 不用

### 抽樣凍結

每組依**股票代號**排序取前 `SAMPLE_TARGET_PER_GROUP=10` 檔,不足額全取,
第一次算出來就寫進 `tick-sample-members.json` **永久凍結**。之後即使市值
變動、分層結果會不同,成員也不跟著跳 —— 序列要能前後比較就得如此。

要重抽:`python scripts/compute_tick_flow.py --refreeze`,或在 workflow
手動觸發時把 `refreeze_tick` 設成 true。**重抽會讓歷史序列不可比**。

### 聚合

- 組內每日值 = **算術平均**(不是加總、不是中位數)
- 缺值成員**排除出當日分母,不計 0**;整組當天無人有資料 → `null`
- `sample_count`(凍結組樣本數,固定)與 `reporting_count`(當天實際
  貢獻分母的成員數)分開記,避免「n=10 但只有 3 支回報」被誤讀
- `low_n_flag`:`sample_count < 10` 時為 1,前端整列變灰並標「樣本數低」

### 四種比法

公式在 `scripts/tick_indicators.py`,是 SH2 `sh2_autorollout/indicators.py`
的原樣移植(`vals` 新到舊、`vals[0]` 是今天;分母 None 或 0 整條 None;
分子分母任一 None 該格留 None、不當 0):

| 指標 | 定義 | 需要天數 |
| --- | --- | --- |
| D0-D1 | `vals[0] - vals[1]` | 2 |
| MA21 | 21 日均,窗口內缺任一天 → `null`(all-or-nothing) | 21 |
| 固定基底 w | `vals[0] / vals[w-1]`,w ∈ 20/10/5 | w |
| 滾動基底 w | `vals[0] / vals[w]`,w ∈ 20/10/5 | w+1 |

SH2 的 `WINDOWS` 已經拿掉 30(Shioaji tick 只留 28 天湊不齊),這邊沿用
20/10/5。`fixed_30`/`rolling_30` 不產生。

### 前端

`tick-latest.json` 只存**當天那一格**的各項指標值,外加每組 30 天的原始
序列(`series_raw`)。個股逐日明細是前端用同一組公式現算的 —— 為了不讓
兩份公式默默走鐘,每次載入都會把前端算出來的當日值跟後端的逐格比對,
對不上就在表格下方標紅字說明。

染色:D0-D1 以 0 為基準、rebase 以 1 為基準,高於基準紅、低於基準綠
(沿用本站「紅漲綠跌」的慣例;SH2 8012 原本是綠正紅負)。MA21 與原始
筆數是水準值恆為正,不染色。**沒有絕對值分級門檻**,純看方向。
