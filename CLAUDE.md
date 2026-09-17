# 給下一個模型的交接(2026-09-14 重整版)

個人用的台股工具。**純靜態網頁 + GitHub Actions 排程 + commit 進 repo 的 JSON**,
沒有後端、沒有資料庫、沒有登入。這份檔案是每次開 session 自動載入的,讀完就要能
直接動手;更早的逐條變更史(34 條,含每次的測試細節)原封搬到
`docs/CLAUDE-history-2026-09-14.md`,想知道「當初為什麼這樣做」再去翻。

- Repo:`Sanunaishunter/save_and_track`(public),分支 `main`,GitHub Pages 自動 build
- 資料每個交易日由 `.github/workflows/daily-scan.yml` 更新後 commit 回 repo
- 使用教學(給人看的):`docs/使用教學.md`;資料格式與 API 探測結論:`data/README.md`

---

## 1. 使用者立過的規矩(沒有重新確認前不要違反)

1. **不接 SH2 的任何資料庫、API 或服務。** 只能「移植公式」,不能連線。
2. **不動七個步驟(`STEPS`)的欄位定義、標籤文字、資料結構**,除非先問。新功能都做成
   獨立欄位/獨立區塊(持倉、方向、出場設定、思考路徑都是這樣加的)。
3. **FinMind token 只存 GitHub Secret `FINMIND_TOKEN`,只在 Actions runner 讀。** 絕不
   出現在前端 JS/HTML/靜態檔(那些會被 Pages 公開)。
4. 沒有後端、沒有登入、不用框架、沒有 build step。前端只用 `localStorage`,所有存取
   都 try/catch,失敗要有畫面提示。前端是 **ES5**(沒有箭頭函式、樣板字串、
   `Object.assign`、ES module),要能用 `file://` 直接開。
5. 只做上市普通股(四位數、開頭非 0),上櫃(TPEx)、ETF、權證明確排除。
6. 新檔案先看現有慣例再決定放哪,不要假設空 repo 從零建。
7. **改完、測完,直接 push 工作分支跟 main,不用問「要不要推 main」**(2026-09-13
   使用者明講)。前提是真的測過:語法檢查 + Playwright/離線測試對照手算值。
8. **回覆一律用繁體中文,不要用簡體字/簡體用語**(2026-09-17 使用者明講)。

## 2. 工作方式(前幾任養成、證明有用的)

- **先探測再實作。** 容器 proxy 擋掉 TWSE / FinMind / github.io / 主流台媒,連不到。
  任何新的外部 API,先寫一次性 probe 腳本、請使用者在 Actions 跑、讀 log 拿到真實
  回應再動手。probe 用完即刪,結論寫進 `data/README.md`。曾經照文件猜、猜錯(FinMind
  免費版不能查全市場)。唯一例外是 `fetch_valuation.py`(BWIBBU_ALL),使用者要一次做完
  才先上,腳本軟失敗 + 印欄位名 + workflow `continue-on-error`,**第一次跑完要看 log**。
- **每個功能都要有測試,測試要對照手算值**,不是「跑得動」。Playwright 走真實 UI 路徑
  (例如自動出場要經過 `checkAutoExits()`,不要單獨呼叫函式)。
- **寫程式碼時照抄驗證過的版本,不要憑印象重打。** 記在文件裡的坑一樣會再踩
  (`.tp-row` 的 `position` 就踩過兩次)。
- **改動要記在這裡,但記「決定與坑」,不記流水帳。** 測試細節寫在 commit 訊息或
  `docs/CLAUDE-history-*.md`。
- 容器是 ephemeral,沒 push 的東西會不見。GitHub token 不能觸發 workflow(403),
  要請使用者自己按 Run workflow。

---

## 3. 系統地圖

### 分頁(`index.html` 的 `#views`,順序 = `js/app.js` 的 `VIEWS_ORDER`)

| 分頁 | 資料 | 一句話 |
| --- | --- | --- |
| 大盤狀況 | `market-grid-latest.json`、`risk-latest.json`、`fx-futures-latest.json`、`events.json` | 九宮格(ΔP_idx × 成交值 5/20 日比)、30 日追蹤表、法人融資交叉、拉積盤、注意股/除權息、**事件日曆** |
| 追蹤 | localStorage | 七步驟紀錄 + 持倉損益 + 出場設定 + 自動出場/全出統計 + 進場訊號準度統計 |
| 思考路徑 | localStorage `stock_pipeline_v1__thinking_paths` | 分岔/合併的鐵軌圖,一檔股票一條;估值試算/進出場計算兩個計算機 |
| 兵棋推演 | 追蹤紀錄 + `quotes-latest.json` | 移動停利模式部位的總覽:啟動狀態、距峰回落、ATR 停損緩衝 |
| 法人軌跡 | 三份 `stock-lookup*-latest.json` | 量縮蓄勢候選的方向三票(融資/外資投信/收盤位置) |
| 訊號記分板 | `scorecard-latest.json` | 歷史訊號之後 5/10/20 日超額報酬、命中率,五種分桶,N<60 灰 |
| 訊號反用 | `scorecard-latest.json`(同一份) | 每個訊號正用(原方向)vs. 反用(反方向重算)命中率/預期報酬並排比較,見第 5 節 |
| 爆量掃描 / 暴跌掃描 | `scan-latest.json` / `crash-latest.json` | `量/MA20(shift 1) > 1.5` 且 `close > open`(暴跌對稱 `<`),≥300 張;每列有 `ma_state` |
| 薄股測試 | `thin-scan-latest.json` | 跟爆量掃描同公式,鎖定量 < 300 張(爆量掃描門檻濾掉的薄股票)這群,見第 5 節 |
| ~~FOMO / 暴跌FOMO~~ | `fomo-latest.json` / `crash-fomo-latest.json` | 對爆量/暴跌前 60 名判定可能會漲/虛漲、真跌/虛跌(有 PE/PBR、外資融資連續天數)。**2026-09-16 使用者要求 no show,兩個分頁按鈕 `hidden`、拿出 `VIEWS_ORDER`**(見第 4 節),資料照樣每天產生,個股查詢的 🔔🕐🔻🔥 標記跟記分板/backtest 工具都還在吃 |
| 產業流向 | `tick-latest.json`、`tick-members-latest.json` | 移植 SH2 8012:產業 × 市值級距的成交筆數,凍結抽樣每組 10 檔 |
| 部位 | `quotes-latest.json` | Kelly 部位 + 零股試算 |
| 📖 利率試算 | `quotes-latest.json`、`valuation-latest.json` | 輸入代號+Δ殖利率+傳導係數,反推股利折現模型隱含 r/g,算利率變動下的合理股價參考(見第 5 節) |
| 題材分類 | `themes.json` | 手動維護的靜態清單 |
| 量價訊號 | `stock-lookup-fullscan-latest.json` | 獵人六訊號 |
| 四個個股查詢 | `stock-lookup{,-scan,-crashfomo,-fullscan}-latest.json` | 手動清單的逐日大表格(OHLCV + 融資融券 + 外資投信),標記 🔔🔽🔻🔥🕐‼️、融資維持率、均線狀態、PE/PB、📅 |

### 每日流程(`daily-scan.yml`,台北 16:13,單一 job、順序由執行序保證)

```
fetch_prices.py        TWSE 全市場 OHLCV+成交筆數 → data/history/(只留 30 天)
compute_scan.py / compute_crash.py    爆量 / 暴跌(含 ma_state)→ *-latest + scans/ crashes/ 存查
compute_thin_scan.py   薄股測試(同公式,量<300張)→ thin-scan-latest + thin-scans/ 存查
fetch_stock_meta.py    產業別(FinMind)+ 股數(TWSE)+ 套 industry_overrides.json
fetch_stock_lookup.py ×3   三份個股查詢清單(FinMind 融資融券/法人,60 日曆天)
compute_tick_flow.py   產業流向(凍結抽樣)
compute_quotes.py      報價快照(30 天 OHLCV 序列)
fetch_risk_flags.py / compute_market_grid.py / fetch_fx_futures.py
archive_prices.py      永久存檔 data/archive/(價格按月、指數逐日,不裁掉)
fetch_valuation.py     全市場 PE/PB/殖利率(BWIBBU_ALL,continue-on-error)
compute_fomo.py / compute_crash_fomo.py   吃上面剛產的 scan/crash 清單
compute_scorecard.py   訊號記分板(讀 scans/crashes/fomo/crash-fomo 存查檔 + 存檔)
git commit + push      if: always()
```
手動參數:`backfill_days`(爆量基線)、`market_backfill_days`、`archive_backfill_days`
(第一次填 250)、`refreeze_tick`(平常別動)、FOMO 的 `source/top/limit`、
`crash_source/crash_top/crash_limit`。另有 `update-stock-lookup.yml`(打代號就抓,
不在清單會自動加)、`scan-full-candidates.yml`(9/8 全掃快照,常駐可重跑)。

### 資料檔速查(全部在 `data/`)

- `history/YYYY-MM-DD.json`:全市場 `[id, volume, open, high, low, close, transaction]`,30 天滾動
- `archive/prices/YYYY-MM.json`、`archive/index.json`、`archive/valuation/YYYY-MM.json`:永久
- `quotes-latest.json`:`codes/close/prev_close/ret_bp/daily_{high,low,close,volume}`(新到舊)
- `stock_meta.json`:`industry`(可能被 `industry_override`)、`shares`、`twse_industry_code`
- `stock-lookup*-latest.json`:`data[code].rows`(舊到新):`open high low close volume margin_balance margin_change short_balance short_change foreign_net trust_net`
- `market-grid-latest.json`:今日快照 + `history[]`(新到舊 30 天),指數只有收盤沒有開高低
- `scorecard-latest.json`:`signals[key].horizons["5"|"10"|"20"]` + `buckets{regime,ma,confluence,event,vol_ratio}`
- `events.json`(手動)、`industry_overrides.json`(手動)、`stock_lookup*.json`(手動清單)、`themes.json`(手動)

---

## 4. 開發硬規則與踩過的坑(別再踩)

**資料源**
- FinMind 免費版不帶 `data_id` 查全市場回 400;只有 `TaiwanStockInfo` 跟逐檔查詢在用。
  未註冊額度 300/小時,一輪 daily-scan 約 500 次,`FINMIND_TOKEN` 設了才有 600。
- TWSE `STOCK_DAY_ALL` 是快取,收盤後不一定馬上更新;所以每天用 `MI_INDEX?date=` 補最近 5 個交易日缺口。
- `FMTQIK`(`twse_api.market_summary()`)跟 `STOCK_DAY_ALL` 同一種快取延遲問題,docstring
  早就寫「實測回應只含最近兩個交易日」。`compute_market_grid.py` 2026-09-10 已經改用日期
  可定址的 `market_index_by_date()`(`market-grid-latest.json` 沒事),但 `fetch_risk_flags.py`
  的 `risk-latest.json.market`(「籌碼/風險」頁那張獨立的「大盤」小卡片,欄位
  `taiex/change/trade_value/trade_volume/transaction`)當時沒有一起改,漏網了快 一週,
  2026-09-16 使用者截圖抓到:九宮格已經是當天,這張小卡片還停在前一天。2026-09-16 修好:
  `fetch_risk_flags.py` 抓完 `market_summary()` 後,今天這天不在回應裡就用
  `market_index_by_date(今天)` 補一筆蓋上去,抓不到(非交易日/TWSE 還沒更新)就維持原樣、
  不擋其他資料來源,離線 mock 測過四種情況(已新鮮/需要補/補不到 None/補的時候丟例外)。
  這個 container 連不到 TWSE,補丁只在下次 Actions 真的跑 `daily-scan.yml` 時才會生效——
  當天要立刻看到修正,要請使用者手動按一次 Run workflow,不能等到隔天排程。
- `BFI82U` 市場買賣差額可能為負,不能當分母;用 T86 買超個股加總。
- FinMind 的產業分類會自己漂(凍結時跟現在不同的有 44 檔),也把漢翔/亞航/長榮航太放
  「航運業」(TWSE 代碼 15 也是),只有 `industry_overrides.json` 手動覆蓋能解。
- 外網:WebFetch 對 udn/ltn/cmoney/statementdog/fugle 全被擋;WebSearch 的 AI 摘要會
  **把查詢字串裡的日期回填進結果**(2026-09-14 實測:查「9/14 無人機預算」就說 9/14
  通過,實際是 8/14),摘要不算證據,看來源網址/內文日期並對 repo 價量。

**前端**
- `[hidden] { display: none !important; }` 那行不能拿掉(`.btn-block` 會蓋掉 hidden)。
- 自動存檔/連動欄位**絕不重繪 DOM**(會吃掉使用者正在打的字):`autoSave()` 不重繪、
  `saveOpenStep` 有 `keepDom`、Kelly 輸入列只在筆數變時重建、出場設定的 %⇄價格連動直接改 `value`。
- `.tp-row`、`.tp-row-group` **絕不能設 `position`**:思考路徑連線用 `offsetTop/offsetLeft`
  算座標,`.tp-canvas` 必須是唯一的 `position:relative` 祖先。SVG 疊在方塊下靠 DOM 順序。
- 出場規則新增一種 `exit_result.rule` 值時,**三處要一起改**:`normalizeExitResult` 白名單、
  `EXIT_RULE_LABELS`、`EXIT_RULE_ORDER`(還有 `exitRuleLabelFor()` 依方向換字);漏改會讓
  舊資料載入時被判成壞格式丟掉。
- 思考路徑的 `nodes/edges` 沒有 normalize 白名單,舊資料缺欄位(`created_at`、`updates`)
  要用 `x || []` 這種防禦式讀取,不能假設存在。
- 訊號準度統計比對舊文字時要同時比「真漲」跟「可能會漲」(舊紀錄存的是舊字)。
- `signed()` 內部會 `Math.round`,小數金額不要用它包。
- **2026-09-16 修過的坑:追蹤頂部「持有期間各自最佳/最差出場」看空時標籤跟數字對不起來**
  ——`positionRangeStats()` 的 `range.high`/`range.low` 是字面上的期間最高/最低**價格**,
  不因方向互換(這是刻意的,`evalExitPlan()`/兵棋推演都靠這個字面意義,自己用
  `dir > 0 ? high : low` 抓峰值);但 `renderPosSummary()`/`renderPosBreakdown()` 舊版
  直接把 `.high.pl` 當「最佳出場」、`.low.pl` 當「最差出場」,對看多是對的(價格最高點
  = 最賺),但看空時價格最高點其實是最慘出場,兩個標籤剛好貼反,使用者截圖抓到「最佳
  出場」顯示負值、「最差出場」顯示正值。修法是新增 `bestWorstExit(rec, range)`,依
  `rec.direction` 選 `dir>0 ? {best:high,worst:low} : {best:low,worst:high}`,跟
  `evalExitPlan()` 抓峰值同一種 `dir` 判斷,套用在彙總的 `bestSum`/`worstSum` 跟展開明細
  表兩個地方;`positionRangeStats()` 本身不用改,字面高/低的語意保留給其他呼叫端用。
  Playwright 用真實 UI(在 localStorage 種一筆看空、一筆看多的同一檔持倉)驗證過:看空
  最佳出場對應價格最低那天、最差出場對應價格最高那天,方向跟看多剛好相反,加總對得起來。
- **隱藏一個分頁只加 `hidden` 屬性到 nav 按鈕、同步把它從 `VIEWS_ORDER` 拿掉,不要刪
  `<main>` 區塊或 `switchView()`/`loadXxx()` 的邏輯**:2026-09-16 使用者要求 FOMO/暴跌FOMO
  no show 就是這樣做——按鈕 `hidden` 讓使用者點不到,`VIEWS_ORDER` 拿掉讓左右滑動手勢也
  跳過(不然按鈕看不到、手勢還是滑得進去),但 `data/fomo*.json`/`data/crash-fomo*.json`
  照樣每天產生、`switchView()` 裡對應的 `if (v==='fomo') loadFomo(false)` 這幾行也留著
  沒刪——個股查詢的 🔔🕐🔻🔥 標記、記分板、`backtest_signal_fade.py` 都還在吃這份資料,
  只是拿掉「單獨的整頁列表」這個入口,不是砍功能。

**產業流向(SH2 8012 移植)**
- 抽樣一凍結就不重算(`tick-sample-members.json` 是長期狀態)。`--refreeze` 會讓序列
  不可比,平常別動。產業覆蓋只移動覆蓋清單裡的代號、只補被移出的那幾組,其餘凍結不動。
- 染色跟 SH2 相反(本站紅漲綠跌);rebase 以 1.0、D0-D1 以 0 為基準;MA21/原始筆數不染色。

---

## 5. 各功能的設計決定與門檻(都是經驗值,沒有一個回測過)

**追蹤 / 持倉**
- `rec.direction` `long|short`,損益 `pl = dir × (市值 − 成本)`;「+ 追蹤」會問方向,預設依來源分頁。
  市值加總沒有跟著方向反轉語意(使用者只要求損益對)。
- 出場設定 `exit_plan`:`mode` = `hold|daytrade|profit|days|trail`,加三個獨立生效的欄位
  `max_drawdown_pct`(基準期間高低點)、`stop_loss_pct`(基準持倉均價,alert 排最前,同日
  命中時它贏)、ATR 停損(`trail` 模式附帶,峰值 − 2.5 × ATR14 簡單平均)。移動停利
  `trail`:持有期間最高價(逐日高點)到過目標 % 就啟動,之後 `量/MA5(shift 1) < 0.7` 或
  單日 ≥ 9% 出場。所有觸發都用 `dir` 鏡射,看空是跌停/反彈,不複製空頭版本。
- 自動出場只改 app 狀態、不下單;假設成交價存 `exit_result`(停損類用停損價,不處理跳空)。
  「全出」是手動批次,存 `manual_exit_result`,不進自動出場統計。`doReactivate()` 清兩者。
- 目標 % / 停損 % 旁邊有 ≈ 價格欄位雙向連動,只存 %。
- 固定停損 %、ATR 2.5×停損都是教科書公式(沒有站上自己的驗證),2026-09-15 用
  `scripts/backtest_exit_rules.py` 對存檔(281 天)+ 既有訊號(scan/crash 等)配對回測過
  一次:爆量訊號 5 日 n=433、10 日 n=100(都 ≥60)兩個門檻都是「停損比不停損好」
  (value_add +0.35%~+0.96%);暴跌訊號 5 日 n=116(≥60)反而是「不停損比較好」
  (value_add −0.18%~−0.36%,dir=−1 的訊號提早停損容易錯過後續反轉)。訊號存查
  (`data/scans` 等)才存 2 週多,10/20 日天期樣本還很少,這只是第一次跑、不是定論,
  之後要用更多資料再驗。工具不寫檔,純 CLI 探測,跟 `tune_thresholds.py` 同一種用法。
- 2026-09-15 使用者要求:凡是「教科書公式、沒有站上自己驗證」的指標(均線多頭/空頭排列、
  固定停損%、ATR 2.5×停損、Kelly)在畫面上的標籤前面統一加 `TEXTBOOK_ICON`(📖)當純視覺
  標記,跟系統自己驗證過的訊號(記分板、爆量/暴跌門檻)區分開來。純加字首,不改資料結構、
  不影響 `normalizeExitResult`/`EXIT_RULE_LABELS` 等白名單比對,`js/app.js` 搜
  `TEXTBOOK_ICON` 可以看到全部四個套用點(均線卡片、個股查詢均線欄、固定停損 alert、
  ATR 移動停損 alert)+ `index.html` 的 Kelly 分頁標題。之後新增同類「沒回測過的教科書
  公式」指標,照這個慣例加。

**部位(Kelly,`kellySolo()`/`corrHaircut()`)**
- Kelly 公式本身是課本標準式(`f = p − q/R`),沒有自創門檻;多筆持倉的相關係數折減
  `1/(1+(n-1)ρ)` 也是統計課本內容,`ρ` 原本寫死用「印象值」:同產業 0.5~0.75、跨產業 0.3。
  2026-09-15 用 `scripts/backtest_kelly_rho.py` 拿存檔 281 天逐日報酬實測:同產業
  46,484 對平均 ρ=0.234、跨產業抽樣 4,000 對平均 ρ=0.147,**都遠低於假設值**——代表
  現在 Kelly 算出來的建議部位比理論上該給的更保守(偏安全,不是偏危險)。沒有動
  `js/app.js` 裡的假設值,要不要換成實測值、要不要因產業而異,問過使用者再決定。

**📖 利率試算(獨立分頁,`yieldCalcCompute()`)**
- 2026-09-16 使用者要求的獨立功能,不是思考路徑裡的小工具。用股利折現模型
  (Gordon Growth)反解隱含 r/g,不用猜無風險利率/β/風險溢酬這些抓不準的東西:
  `ROE=PB/PE`、`配息率=殖利率×PE`、`g=ROE×(1−配息率)`、
  `r_implied = g + 配息率×(1+g)/PE`(這組 r 是「用現價反推、跟股價自洽」的隱含值,
  不是外部估的);再疊加使用者輸入的 `Δ殖利率 × 傳導係數` 算 `r_new`,重新代回同一個
  公式算新合理 PE/股價,跟現價比較出估值修正參考百分比。只吃 `quotes-latest.json`
  (現價)+ `valuation-latest.json`(PE/PB/殖利率),沒有新增資料源、沒有連線。
  配息率算出來 <2%(接近 0)的股票會擋掉不給算——這個模型是股利折現法,殖利率
  太低時分母對 g/r 極度敏感、數學上不穩,通常是不太配息的成長股,勉強套用會給出
  誤導的數字;`r_new ≤ g` 也會擋掉,提示調小輸入。這整套是使用者自己在這次對話
  推導出來的簡化公式,連「教科書公式」都算不上(教科書 DCF 是真的預測未來多年
  現金流,這個是拿現在的價格反推隱含值再做敏感度,兩者不一樣),沒有任何回測,
  `r−g` 越薄(通常對應本益比越高)的股票對輸入越敏感是模型特性不是 bug,UI 上
  用跟其他教科書指標一致的 📖 標記+分頁名稱提醒。

**FOMO(`scripts/fomo_score.py`)**
- 「可能會漲」(內部仍叫 `real_rally`):外資連買 ≥3 天 **且** 融資連買 ≥3 天都是必要條件,
  總分 ≥60。虛漲、真跌/虛跌沒動。已知舊版「真漲」N=28 命中 11%,新版沒回測。
- **2026-09-17 加 `is_conflict`(可能會漲/虛漲、真跌/虛跌各自一組):兩個判斷是各自獨立
  打分,沒有互斥檢查**,使用者截圖抓到 2305 在 9/14 兩個旗標同時 True(`real_rally_score`/
  `fake_rally_score` 都是 60)。根本原因:「融資連續買超≥3天」(可能會漲的必要條件)跟
  「融資5日增幅>15%」(虛漲的加分項)是同一件事(散戶瘋狂追價)的兩種量法,常常一起
  觸發;PBR 對可能會漲只是加分項不是必要條件,外資+融資兩個必要條件湊滿 60 分就不需要
  PBR 過關,所以 PBR 偏高(虛漲的訊號)完全不會卡住可能會漲成立。使用者決定**不做互斥**
  (不強制二選一,原因見上——這兩個判斷各自都有累積比對記分板的歷史命中率,合併會牽動
  比較基礎),只加 `is_conflict` 布林旗標,`score_stock()`/`score_stock_crash()` 都加了,
  前端 `badges()`/`fomoTriggerNote()`/`fomoDetailHtml()`(跟 crash 對應版本)加⚠️
  訊號衝突標記+說明文字,`renderFomo()`/`renderCrashFomo()` 的統計列也加衝突檔數。
  `compute_fomo.py`/`compute_crash_fomo.py` 把 `score_stock()` 整包 dict 存檔,不用另外
  改就會帶出新欄位。**FOMO/暴跌FOMO 分頁目前是 hidden(no show)**,這個修正在資料層
  跟隱藏分頁裡都做了,但沒有其他還看得到的地方會顯示這個警示——如果之後要在個股查詢
  或別的地方也看得到,要再另外接。離線用 2305 的真實數字(9/14 metrics)+ 兩個乾淨案例
  驗證過 `is_conflict` 算得對,Playwright 走真實 UI(暫時拿掉 hidden 屬性點進去)確認
  badge、統計列、展開明細的說明文字都正確顯示,無 JS 錯誤。
- **2026-09-17 加寬鬆版「可能會漲😝/虛漲😝」(`judge_real_rally_loose()`/
  `judge_fake_stock_rally_loose()`)**:使用者要求跟原版(嚴格版)平行、獨立存在的
  第二組判斷,不是取代——想看看放寬門檻後樣本會不會變多、命中率會不會因此變差,
  兩組各自累積歷史命中率,不能混著看。門檻:可能會漲😝 只留外資/融資連續買超兩個
  必要條件、天數從 ≥3 降到 ≥2(40+20=60,拿掉券資比/PBR 加分項);虛漲😝 融資5日
  增幅門檻從 >15% 降到 >10%(`MARGIN_CHANGE_NOTICE`)、PBR 門檻從 >2.5 降到 >2.0
  (新增 `PBR_LOOSE_HIGH`),拿掉外資買賣超加分項,只留融資增幅+PBR+今日量縮三項
  (30+20+10=60)。兩組門檻縮減後,60 分的湊法只有一種,結構上就同時保證了必要
  條件,不用像原版那樣另外寫「達分但未過閘門」的檢查。`score_stock()` 新增
  `is_real_rally_loose`/`real_rally_loose_score`/`is_fake_rally_loose`/
  `fake_rally_loose_score`/`is_conflict_loose`(跟 `is_conflict` 同道理,兩個放寬版
  判斷也沒有互斥,只加衝突旗標)。**只做了 FOMO(可能會漲/虛漲)這一組,使用者沒有
  要求暴跌FOMO(真跌/虛跌)也出寬鬆版,`score_stock_crash()` 沒有動。**
  前端 `badges()`/`fomoTriggerNote()`/`fomoDetailHtml()`/`renderFomo()` 統計列都加了
  😝 版本的 badge/文字/理由清單/檔數,跟 `is_conflict` 一樣目前只有隱藏的 FOMO 分頁
  在用。**這個寬鬆版有额外要求要進「準度分析」**,分兩層都接了:①後端訊號記分板
  (`compute_scorecard.py`)新增 `SIGNAL_DEFS` 的 `fomo_real_loose`/`fomo_fake_loose`
  兩個訊號,`load_signal_instances()` 從同一批 FOMO 存查檔案多讀 `is_real_rally_loose`/
  `is_fake_rally_loose` 兩個欄位出實例(舊存查檔案沒有這兩個欄位,`.get()` 拿 None
  自然跳過,從新欄位開始出現那天起才累積樣本,跟其他訊號當初上線時一樣);②前端
  追蹤分頁「進場訊號準度統計」的 `ENTRY_TAG_RULES` 加了 `real_rally_loose`/
  `fake_rally_loose` 兩條規則(比對「可能會漲😝」/「虛漲😝」字面),**位置排在原本
  `real_rally`/`fake_rally` 規則前面**——寬鬆版的自動文字本身就包含「可能會漲」/
  「虛漲」子字串,`entryGroupKey()` 取第一個命中的規則,順序放後面永遠會被前面的
  規則先攔截、分類不到寬鬆版那組。`ENTRY_TAG_DIRECTION` 也加了對應的方向預期。
  離線用使用者截圖的 2305 真實數字(外資連買4天、融資連買6天、融資5日+38.7%、
  PBR 3.76)驗證過兩個 judge 函式算出 60/60 分且都成立,跟使用者手算的分解一致;
  `load_signal_instances()` 用假 fixture 驗證過會正確吐出 `fomo_real_loose`(dir=1)/
  `fomo_fake_loose`(dir=-1)兩筆實例;Playwright 走真實 UI(FOMO 列表 → 展開明細
  → 加入追蹤 → 重新整理讓 `init()` 抓報價 → 追蹤分頁)確認 badge、統計列、明細
  理由、加入追蹤帶出的文字、「進場訊號準度統計」分類都正確顯示「可能會漲😝」,
  無 JS 錯誤。跑 `compute_scorecard.py` 只用來確認新 `SIGNAL_DEFS` 不會讓既有資料
  跑出例外,沒有拿本機容器的 `data/scorecard-latest.json` 覆蓋 commit(那份要等
  Actions 真的跑出新一天的 FOMO 資料後,由排程重新產生)。

**薄股測試(`scripts/compute_thin_scan.py`,2026-09-17 加入)**
- 起因:使用者拿 6957 裕慶-KY 的真實線圖追出來,問「有沒有機會抓到噴出前的
  狀態」。第一次分析時我判斷是「量縮蓄勢」(9/1~9/9 量確實很安靜),但使用者
  糾正:「234 前已經有量了,跟前面蹲的時候有差別了」——查真實資料才發現
  9/10(119張)、9/11(162張)vol_ratio 已經是 1.64/2.18,早就超過爆量掃描
  1.5 的門檻,不是「還沒到門檻的早期訊號」,是**已經達標但被 300 張絕對量
  下限(`common.MIN_VOLUME_LOTS`)擋住看不到**——6957 一路到量衝上 390 張
  (9/16)才第一次進爆量掃描名單,隔天(9/17)噴出 274。
- 全市場回測(`data/archive/prices`,284 天、不打 API)先測了兩個方向:①
  「連續兩天量放大但還沒到爆量門檻」這個原始構想(vol_ramp)——結果 6957
  自己的 9/10、9/11 因為當天 vol_ratio 已經 >1.5,反而被這個定義的「還沒到
  爆量門檻」排除條件濾掉,構想本身跟這次案例對不上;②改用「爆量掃描原始
  公式,不設量下限」直接測,才發現真正的分野在量下限,不在 vol_ratio 夠不夠
  ——量<300張這群(N=4028,遠超過記分板 60 門檻)5 日命中率 33.4%、平均超額
  −1.40%,量≥300張這群(現行爆量掃描)是 38.1%/−0.62%,兩群都是看多會輸,
  薄股這群輸得更多,20 日天期差距更大(−5.82% vs −2.88%)。這**不是新發現的
  獨立優勢**,是已經驗證過的「爆量看多容易輸」的加強版;6957 自己過去一年
  也觸發過同一公式好幾次(2025-08-19 起),這次是同一種型態裡剛好中獎的
  一次,不是系統第一次錯過的獨一無二訊號(存活者偏誤)。
- 使用者聽完數據後的決定(不是要否決功能,是重新定義用途):「這就是台灣人
  熱愛的炒股票,我們要做的是跟著散戶一起抬轎,然後有紀律地下車」——不是拿
  這個訊號當保證勝率的進場依據,是照樣做成正式訊號、進記分板算勝率
  (`SIGNAL_DEFS['thin_scan']`,`dir=1`),讓使用者自己盯著數字決定要不要跟、
  跟多重,系統負責誠實揭露勝率,不負責幫他下結論說穩賺。因為已經驗證過
  (不是沒驗證過的教科書公式),前端刻意不加 📖(那個標記是給「沒驗證過的
  教科書公式」,這裡已經驗證過、數字就是偏負,標📖反而誤導)。
- 實作:`compute_thin_scan.py` 跟 `compute_scan.py` 公式完全一致(`vol_ratio >
  1.5` 且 `close > open`),只多一個量的範圍限制(`THIN_SCAN_MIN_VOLUME_LOTS`
  10 張 `<=` 量 `<` `MIN_VOLUME_LOTS` 300 張),兩個掃描互補、同一天同一檔不會
  同時出現在兩份清單。多了 `--backfill-archive` 一次性模式,用既有
  `data/archive/prices`(2025-07 起)直接回補 `data/thin-scans/*.json`
  ——這是重新計算既有資料,不是補抓新資料,所以（跟 scan/crash/FOMO 這幾個
  從上線那天才開始累積樣本的訊號不同)這個訊號一上線記分板就有 4000+ 筆
  到期樣本,不用等好幾週。`compute_scorecard.py` 的 `load_signal_instances()`
  加讀 `THIN_SCANS_DIR`(`foreign_consec`/`margin_consec` 留 None,因為薄股票
  通常不在 FOMO 前 60 名候選池裡,沒有合流資訊可查,`confluence_label()` 看到
  兩者皆 None 會正確回報「無合流資料」,不是誤判)。前端新分頁「薄股測試」
  (排在暴跌掃描後面)`renderThinScan()`/`loadThinScan()` 跟 `renderScan()`
  幾乎一樣,多一欄「量(張)」;`quickAddBtnHtml`/`bindQuickAdd` 記得掛在
  `thinscan-tbody`(照抄 scan/crash 那三行時漏掉會讓「+ 追蹤」按鈕沒反應,
  這次有記得加);`ENTRY_TAG_RULES` 加 `thin_scan` 規則(比對「薄股測試」
  字面,擺在 `surge`/`thinrally` 之間,沒有子字串衝突不用擔心順序)、
  `ENTRY_TAG_DIRECTION` 加對應方向;`SC_SIGNAL_ORDER` 加 `thin_scan`
  (`FADE_SIGNAL_ORDER` 是從它 `.concat()` 出來的,自動一起帶到訊號反用分頁,
  不用另外改)。
- 驗證:`compute_thin_scan.py --backfill-archive` 回補後,`data/thin-scans/`
  裡 6957 的 vol_ratio(2026-08-28 1.75、09-10 1.64、09-11 2.18、09-14 2.45、
  09-15 1.99,09-16 起正確消失,因為量已經 >=300 張改進爆量掃描)跟手算
  一字不差對上;`compute_scorecard.py` 跑出來的 `thin_scan` 5/10/20 日
  n=4026/3931/3806、命中 33.4/28.9/21.4%、超額 −1.4/−2.65/−5.82%,跟
  上線前用獨立探測腳本(`backtest_thin_scan.py`,一次性、沒進 repo)算出來的
  數字幾乎一致(差 2 筆是這裡多了 10 張的雜訊下限)。Playwright 走真實 UI
  確認薄股測試分頁渲染 19 檔候選、無 JS 錯誤,訊號記分板/訊號反用兩個分頁
  都正確顯示「薄股爆量」區塊;「+ 追蹤」流程確認過 localStorage 存的
  `notes[1]` 正確帶出「薄股測試(量比 x.xx x、漲 +x.xx%、量 xx.x張)」文字。

**個股查詢標記(`createLookupPanel()`,四個分頁共用)**
- 🔔量縮轉買、🔽量縮、🔻外資出貨、🔥連續增溫、🕐蓄勢中:量比 = 量 / 前 10 日峰量,
  `< 0.6` 算量縮;蓄勢 = 近 10 日 ≥ 8 天量縮且平均振幅 `(高−低)/收盤 ≥ 3.5%`,且還沒
  觸發轉買(投信整段為 0 的股票只看外資)。整檔 30 天沒任何標記會被濾出清單。
- ‼️接近前高:現價 ≥ 近 30 日最高收盤(不含當天)的 85%。
- 融資維持率估計:現價 / (視窗內量最大日最高價) / 0.6;130 警戒、120 危險。
- 均線狀態:MA5/10/20 含當日簡單平均;多頭排列 `close>MA5>MA10>MA20`、空頭相反、其餘糾結。
  Python 版 `common.ma_state()` 與前端 `priceMaState()` 同定義,用 2634 真實資料對過。
- PE/PB/殖利率來自 `valuation-latest.json`;📅 = 5 天內有事件。

**法人軌跡**:蓄勢候選的三票——融資 10 日變動 ≤−5% 偏多 / ≥+5% 偏空;外資+投信合計正負;
平均收盤位置 ≥60% 偏多 / ≤40% 偏空。≥2 票且明顯多於另一邊才定標籤。純觀察,不接追蹤。

**思考路徑**
- 一條路徑綁一檔股票;方塊 `{id, text, cat, created_at, updates[]}`,`cat` 八種:
  `macro/flow/catalyst/valuation/bull/bear/conclude/note`;`edges {from,to}`;深度決定第幾層。
- 分岔 = 對同一父方塊按兩次「+ 接續」;合併 = 多選後「合併成新方塊」;刪除連同下游子樹。
- 方塊建立後**文字鎖住**,只能用「新增更新」疊加(commit 式,立即存檔);方塊上顯示最新一則。
- 常用詞 `TP_TAGS` 34 個;估值試算(EPS × 本益比上下界,會自動帶入收盤價與 TWSE PE 反推的
  TTM EPS,只填空欄位)、進出場計算(風險報酬比、`floor(預算/進場價)` 股、不算手續費)。
- 匯出/匯入含 `thinking_paths`、`lookup_notes`、`events`,合併匯入依 id 覆蓋。

**大盤九宮格**:ΔP_idx ±0.5%、ρ_idx = 成交值 5 日/20 日均;拉積盤、法人+融資交叉、情緒
溫度計都是純觀察,還沒過 Gate 1(N≥60)。指數只有收盤。

**訊號記分板 / 存檔 / 估值 / 事件 / 產業覆蓋**(2026-09-14 一起加的,細節見 `data/README.md` 末節)
- 記分板:六種訊號 × 5/10/20 日,超額 = 個股報酬 − 指數同期,命中 = dir × 超額 > 0;
  分桶 regime / ma / confluence / event / vol_ratio;`N < 60` 一律 `enough=false`。
  **第一次跑(2026-09-11 資料、30 天)的基準:爆量 5 日 n=362 命中 21.5%、超額 −3.26%;
  可能會漲 5 日 n=47 命中 17%;暴跌 5 日 n=38 命中 68%。** 弱勢盤裡單因子爆量是反指標,
  樣本太少不能推廣,但要盯著。**2026-09-16 樣本長到 N≥60、用 `scripts/backtest_signal_fade.py`
  (原名 backtest_scan_fade.py,通用化後改名,可以帶訊號名稱當參數:
  `scan|crash|fomo_real|fomo_fake|crashfomo_real|crashfomo_fake`)正式驗證過「反著用」**:
  爆量 5 日 n=510(命中 29.6%、預期報酬 −2.24%)、10 日 n=273(命中 33.7%、預期報酬
  −2.43%),兩個天期都遠低於 50%,不是樣本太少的雜訊。把 scan 的 dir 從 +1(看多)改成
  −1(訊號出現後放空)重算同一批樣本:5 日命中率變 70.4%、預期報酬 +2.24%;10 日命中
  66.3%、+2.43%。按訊號當天大盤狀態分桶(5 日):指數漲 n=223 放空命中 65.0%、指數平
  n=177 放空命中 68.4%、系統性賣壓 n=110 放空命中 84.5%——**三種大盤狀態下反著做都成立,
  不是只有弱勢盤才有效,但系統性賣壓時效果最強**,支持「短期單日爆量+高量比是過度反應、
  隔幾天會修正」這個機制性解釋,不只是這段期間剛好偏空造成的巧合。**暴跌(crash)訊號
  反著用結果不一樣,沒有同樣的反轉優勢**:5 日 n=206,原本(看空)命中 49.0%、預期報酬
  −0.18%,反著做(看多)命中 51.0%、預期報酬 +0.18%——本來就接近拋硬幣,反著做也還是
  接近拋硬幣,不是「爆量的結論可以套用到所有訊號」。分桶後指數漲/指數平兩組正負號還
  相反(指數漲天看空 predicted +0.46%、指數平天看空 −1.01%),樣本更小(116/90)、方向
  不一致,比較像雜訊不是規律;crash 10/20 日天期目前 n=0(訊號從 9/4 才開始記,還沒有
  10 天後到期的樣本),之後樣本夠了要重跑再確認。工具沒有算融券成本/券源/盯市風險,純粹
  驗證訊號方向,**不是可以直接下單的策略**,也還沒決定要不要真的把 `scan` 的 `dir` 或
  前端顯示方式改成看空(要問過使用者)。
- **剩下四種訊號(fomo_real/fomo_fake/crashfomo_real/crashfomo_fake)也用
  `backtest_signal_fade.py` 測過反著用,只有 `fomo_real` 5 日過 N≥60(n=74)**:原本
  (看多)命中 33.8%、預期報酬 −2.1%,反著做(看空)命中 66.2%、+2.1%——方向上跟爆量
  同一個故事(短期噴出容易被修正),但要注意 `fomo_real` 的候選本來就是從爆量清單前 60
  名再篩外資/融資連買 ≥3 天(見 `load_signal_instances()`),**樣本跟 scan 高度重疊,
  不是獨立的第二次驗證,只能當同一個機制的延伸觀察**。2026-09-16 用
  `backtest_signal_fade.py` 新增的第二參數(排除跟另一個訊號同一天同一檔重疊的樣本)
  實測拆過:`fomo_real` 81 筆裡 79 筆跟 scan 同一天同一檔重複,拿掉之後只剩 2 筆獨立
  樣本;`crashfomo_real` 78 筆裡 77 筆跟 crash 重複,只剩 1 筆——**幾乎是完全重疊,
  fomo_real/crashfomo_real 目前沒有可以獨立驗證的樣本,那個 66.2% 命中率就是 scan
  的效果換個篩選條件再出現一次,不是額外的證據**,不能當成第二個訊號來源看待。剩下
  的 2/1 筆是 fomo 候選清單跟當天 scan 清單沒有完全對齊的邊緣情況(候選清單來源/更新
  時機可能跟當天 scan 有落差,沒有深究),樣本太小看不出意義。要等這種「fomo 篩到但
  scan 沒篩到」的獨立樣本累積出量才能真的測。其他天期/桶都 N<60:`fomo_real`
  10 日 n=25、`fomo_fake` 全部(5 日 n=16、10 日 n=6)、`crashfomo_real` 5 日 n=31、
  `crashfomo_fake` 只有 1 筆歷史紀錄(幾乎沒被觸發過)——這四個目前都沒有足夠樣本可以
  下任何結論,不是「測了發現沒用」,是「還測不出來」,樣本數會隨每天排程慢慢長,之後
  再回頭跑。
- 閘門橫幅:看多分頁在系統性賣壓/指數跌、看空分頁在指數漲的日子提醒,引用記分板同狀態命中率。
- `tune_thresholds.py`:一次動一個參數、N<60 不下結論、調完要用之後的新資料再驗。
- 事件:`data/events.json` 進記分板;瀏覽器裡新增的個人事件不進(刻意)。
- 記分板沒納入個股查詢的 🔔🕐🔻🔥(前端算的,沒有每日存查檔)。
- **2026-09-17 加「訊號反用」分頁(`index.html` 的 `data-view="fade"`,排在訊號記分板
  後面)**:使用者要求把 `backtest_signal_fade.py` 探測出來的「反著用」命中率跟「正用」
  放在同一張表比較,不用每次手動跑 CLI。做法是把反用統計直接算進 `scorecard-latest.json`
  本體,不是另外開一支腳本或另一份存查檔:`compute_scorecard.py` 新增
  `summarize_with_fade(samples, direction)`,直接抄 `backtest_signal_fade.py` 的
  `fade_summary()` 演算法(同一批樣本各呼叫 `summarize()` 一次,方向相反那次的
  `hit_rate`/`hit_rate_raw` 是真的重算,不是 100%−正用命中率;`pnl`/`fade_pnl` 是
  `方向 × avg_excess` 換算出來的,互為正負號相反),只套在**頂層 horizons(5/10/20 日)**,
  沒有下探到 buckets(regime/ma/confluence/event/vol_ratio 的反著用細節分桶還是要用
  `backtest_signal_fade.py` 才看得到,記分板本體資料量控制住)。前端 `js/app.js` 新增
  `FADE_SIGNAL_ORDER`(= `SC_SIGNAL_ORDER` 加上 `fomo_real_loose`/`fomo_fake_loose`
  兩個寬鬆版😝訊號)、`scFadeRow()`、`renderFade()`、`loadFadeView()`,沿用
  `loadScorecard()` 的快取(跟訊號記分板讀同一份 `scorecard-latest.json`,不多打一次
  fetch);沒有資料(`instances=0`)的訊號直接不顯示,不會出現空表格或報錯。用本機
  真實存檔資料重跑 `compute_scorecard.py`(在 scratchpad 隔離環境,沒有覆蓋 commit 進
  repo 的 `data/scorecard-latest.json`)驗證過算出來的反用數字跟之前 CLI 探測、已經寫
  進本節上面的數字**逐一對得上**:爆量 5 日反著做命中 70.4%/+2.24%、可能會漲 66.2%/
  +2.10%、虛漲 37.5%/−3.46%、暴跌 51.0%/+0.18%、真跌 38.7%/−0.98%。Playwright 走
  真實 UI 確認分頁切換、六個訊號區塊(爆量/可能會漲/虛漲/暴跌/真跌/虛跌)都正確顯示
  正用/反用命中率+預期報酬並排比較,無 JS 錯誤。`fomo_real_loose`/`fomo_fake_loose`
  目前 0 筆(等下一次 daily-scan 產生帶新欄位的 FOMO 存查檔才會開始累積,見上面
  FOMO 寬鬆版那條)。

## 6. 已知限制 / 還沒決定的事

1. `FINMIND_TOKEN` 沒設,額度緊。
2. 產業流向 111 組裡 70 幾組樣本數低(只做上市 + 組內切三層的必然);抽樣要不要保留
   (免費全市場資料其實不用抽)使用者還沒決定,改了就跟 SH2 對不起來。
3. 所有門檻都是使用者經驗值,記分板是唯一的驗證管道;樣本累積到 60 以上、10/20 日到期
   之後再談調整。
4. `data/archive/prices` 一年約 12MB 進 git,之後看 repo 大小。
5. FinMind `TaiwanStockPER` 可改用免費的 `BWIBBU_ALL`(現在兩邊都有),省額度,還沒做。

---

## 7. 個股「全套分析」操作手冊(思考路徑)

使用者開口「幫我分析 X」「用思考路徑做 X」就照這節做,不需要另外的 prompt。
**交付物**:`data/thinking-paths/<代號>-<拼音>-<日期>.json`,格式
`{ "data": [], "thinking_paths": { "currentPathId": "<id>", "paths": [ {...} ] } }`,path/node
結構見第 5 節思考路徑那段,範例 `data/thinking-paths/2634-hanxiang-2026-09-14.json`。
寫完用 Playwright 走真實匯入(`#import-file` → 「合併」)確認方塊數/連線數/無 JS 錯誤,
commit、push 分支跟 main,回覆附:結論一句話、關鍵讀數表、資料缺口、來源清單。

### 7.1 步驟(每步先讀 repo,之後才准上網)
1. **大盤**:`market-grid-latest.json`(今日 + 30 天 history)、`archive/index.json`。寫
   `grid_label`、漲跌家數、法人淨額、近期有無系統性賣壓/拉積盤。
2. **產業流向**:`stock_meta.json` 查 `industry`;`tick-latest.json` 對應組的
   `rolling_5/fixed_20/d0_d1`;`tick-members-latest.json` 這檔自己的 `ticks`。分組不合理就明講不採用。
3. **個股量價**:`quotes-latest.json`(30 天)或 `archive/prices/`。算 MA5/10/20(`common.ma_state`
   定義)、30 日高低、量 vs MA20(shift 1)、ATR14、‼️前高比。**引用系統訊號就照系統公式重算**
   (量縮 = 量/前 10 日峰量 < 0.6、振幅 (高−低)/收盤),不要用順手的近似。
4. **籌碼**(只有在個股查詢清單裡才有):外資連續買/賣天數與累計、投信是否缺席、融資
   10 日變動、融資維持率估計、10 日平均收盤位置、法人軌跡三票。不在清單就寫「無籌碼資料」。
5. **系統既有判定**:scan/crash(`ma_state`)、fomo/crash-fomo(`per/pbr`、連續天數)、
   risk(注意股、除權息)、events、valuation、scorecard(這類訊號的歷史命中率)。
6. **WebSearch 只補 repo 沒有的**(EPS/營收、催化劑、券商觀點):數字兩個獨立來源一致才
   算可信,否則標「單一來源」;**每條有日期的新聞都對 repo 那天的價量**,對不上先停;
   券商目標價看它用的是哪一年 EPS。
7. **估值三方法交叉**:TTM PE(推算過程寫清楚)、Forward PE(假設寫清楚)、券商/同業;
   PB 沒淨值就留空;有 `valuation-latest.json` 用 TWSE PE 反推 TTM EPS 當第一個錨。
8. **看多/看空分岔**:各 4~6 條,每條對得到前面某一步的數字。
9. **決策可執行**:分「已持有(含入手價)」「未進場」;進場條件、停損價(優先用系統有的
   固定停損 / ATR / 最大回撤)、目標價、風險報酬比。停損紀律 > 訊號強度。
10. **資料缺口 + 檢討 checkpoint**:沒有的資料留白不硬填;寫 3~5 個之後要回頭驗證的日期/事件。

### 7.2 留給事後驗證的東西(每條路徑都要有,這是精進的唯一辦法)
- 路徑第一格或 `note` 方塊寫明**資料截止日**(repo 資料到哪天、WebSearch 哪天做的)。
- 決策方塊裡的**三個價**(進場/停損/目標)跟**觸發條件**要具體到可以事後判對錯。
- 最後一格 checkpoint 列**日期 + 要看什麼**(營收公布日、財報日、外資何時轉買、標案發包)。
- **事後檢討怎麼做**:到期時用「新增更新」把實際結果疊在對應方塊上(不覆蓋原文),
  然後在下面「分析教訓」列補一條:命中/沒命中、哪一步的判斷錯、下次改什麼。只有樣本
  累積到一定數量的教訓才升格成第 7.1 節的規則,單次巧合不算。
- 系統面的驗證看記分板,不看單一路徑;路徑是「判斷過程」的樣本,記分板是「訊號」的樣本。

### 7.3 分析教訓(有日期、有樣本數,累積中)
- 2026-09-13 2357:停損紀律比訊號強度重要——產業流向 rolling_5 2.22 三天內崩到 0.27,
  示範停損 3.8% 出場 vs 不停損 −9.9%。樣本 1。
- 2026-09-13 2357/3376:沒資料留白比硬填安全;WebSearch 的股價會過期,先看 repo。樣本 2。
- 2026-09-14 2634:WebSearch 摘要日期會被查詢字串汙染(9/14 vs 8/14);券商目標價用舊
  EPS;量縮天數要用系統公式(10/10、3.11%,不是自算的 9/10、3.07%)。樣本 1。
- 2026-09-14 記分板第一次跑:爆量後 5 天平均跑輸大盤 3.3 個百分點(n=362,弱勢盤)。待累積。
- 2026-09-14 2634 續篇(收盤後補 9/14 資料):①融資 10 日窗口用當時數字算 −4.8%,同一天
  收盤後用新抓的資料重算變 −2.96%,方向沒變但數字對不上,懷疑是 TWSE 融資資料當天稍後
  被修正過,兩個數字都留著、不覆蓋原文,只在 updates 註記差異。②WebSearch 又抓到一篇
  「股價小幅走強至 73.1 元」的即時新聞,這次沒有直接採信,先比對 repo 8 月價格(8/18 收
  73.3)才發現是舊聞被摘要成即時新聞——呼應樣本 1 的教訓,這次守住了。樣本 2。
每個數字指得出來源?新聞日期都對過 repo 價量?籌碼有算?EPS 是最新一季後的口徑?
決策有三個價、入手價有出現?系統公式重算的數字跟前端一致?匯入測試跑過、檔案 commit 了?

---

## 8. 測試怎麼跑

Playwright 在 `/opt/node22/lib/node_modules`,`export NODE_PATH=/opt/node22/lib/node_modules`;
把 repo 複製到 scratchpad、`python3 -m http.server`,測試要點掉 `#splash`、把
`#version-page` 設 hidden。Python 離線測試 mock `twse_api.by_date` / `finmind_api.request`,
不連網。既有測試組:追蹤 24 項、產業流向 27 項(前端 JS 與後端 Python 逐格比對 552 格)、
部位 44 項、記分板/存檔/產業覆蓋 40 項、前端大改 28 項,都對照手算值。
