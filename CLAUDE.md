# 給下一個 Claude 的交接

個人用的台股工具。**純靜態網頁 + GitHub Actions 排程 + commit 進 repo 的 JSON**,
沒有後端、沒有資料庫、沒有登入。

- Repo:`Sanunaishunter/save_and_track`(public),分支 `main`
- 線上:GitHub Pages(push 到 main 之後自動 build)
- 資料每個交易日由 `.github/workflows/daily-scan.yml` 更新後 commit 回 repo

---

## 使用者立過的規矩(沒有重新確認前不要違反)

1. **不要接 SH2 的任何資料庫、API 或既有服務。** 這個 repo 完全獨立,
   SH2 那邊的東西只能「移植公式」,不能連線。
2. **不要更動七個步驟的欄位定義、標籤文字或資料結構**,除非先問過。
   (持倉功能因此是獨立區塊,沒有動到 `STEPS`。)
3. **FinMind token 只能存成 GitHub Secret `FINMIND_TOKEN`,只在 Actions runner 內讀取。**
   絕對不能出現在任何前端 JS/HTML/靜態檔案裡 —— 那些會被打包進 Pages 公開。
4. 沒有後端、沒有登入、不用框架、不要 build step。前端只用 `localStorage`
   (不是 `window.storage`),所有存取都要 try/catch 且失敗要有畫面提示。
5. 上櫃(TPEx)明確排除,只做上市普通股。
6. 新檔案先看現有慣例再決定放哪,不要假設空 repo 從零建。

## 我(前一個 Claude)自己養成的做法

- **先探測再實作。** 容器的 proxy 擋掉對外 TLS(TWSE / FinMind / github.io 都連不到),
  所以任何外部 API 的欄位與行為,一律先寫一支一次性 probe 腳本、請使用者在 Actions 上跑、
  我讀 log 拿到真實回應之後才動手。曾經照文件猜結果猜錯(見下面 FinMind 那條),之後就不再這樣做。
- probe 用完即刪,結論寫進 `data/README.md`。
- 每個功能都要有測試,而且測試要對照**手算值**,不要只是「跑得動」。

---

## 五個分頁

| 分頁 | 資料來源 | 說明 |
| --- | --- | --- |
| 追蹤 | localStorage | 七步驟紀錄 + 持倉損益 |
| 爆量掃描 | `data/scan-latest.json` | `vol_ratio = 量 / MA20(shift 1) > 1.5` 且 `close > open` |
| 暴跌掃描 | `data/crash-latest.json` | 跟爆量掃描對稱,`vol_ratio > 1.5` 且 `close < open` |
| FOMO | `data/fomo-latest.json` | 對爆量前 60 名判斷真漲/虛漲 |
| 暴跌FOMO | `data/crash-fomo-latest.json` | 對暴跌前 60 名判斷真跌/虛跌,是真漲/虛漲的鏡射(不是單純反號誌,見 `data/README.md`) |
| 產業流向 | `data/tick-latest.json` | 移植自 SH2 8012:產業 × 市值級距的成交筆數聚合 |
| 部位 | `data/quotes-latest.json` | Kelly 部位 + 零股試算 |
| 個股查詢 | `data/stock-lookup-latest.json` | 手動維護清單(`stock_lookup.json`),開高低收量+融資融券+外資投信逐日大表格,沒有後端不能即時查任意一檔 |

## 每日流程(單一 workflow,順序由執行序保證)

台北 16:13(`cron: '13 8 * * 1-5'`,UTC)。合併成一個 job 是因為
GitHub 排程會延遲(實測延遲過 5 小時 23 分),拆成兩支時 FOMO 會讀到前一天的爆量清單。

```
fetch_prices.py        TWSE 全市場收盤(含成交筆數)→ data/history/YYYY-MM-DD.json
compute_scan.py        爆量清單
compute_crash.py       暴跌清單(跟爆量對稱,共用 data/history)
fetch_stock_meta.py    產業別(FinMind)+ 發行股數(TWSE)→ data/stock_meta.json
compute_tick_flow.py   產業流向聚合
compute_quotes.py      報價快照(收盤價 + 日報酬)
compute_fomo.py        FOMO 計分(吃上一步的 scan-latest.json)
compute_crash_fomo.py  暴跌FOMO 計分(吃上一步的 crash-latest.json)
fetch_stock_lookup.py  個股查詢(讀 stock_lookup.json 手動清單,融資融券+外資投信)
git commit + push      if: always(),某步失敗也保存已算出的資料
```

手動觸發參數:`backfill_days` / `source` / `top`(預設 60)/ `limit` / `refreeze_tick` /
`crash_source` / `crash_top`(預設 60)/ `crash_limit` / `market_backfill_days`。

---

## 踩過的坑(**別再踩一次**)

- **FinMind 免費版不能查全市場。** 不帶 `data_id` 的查詢回 HTTP 400
  「Your level is free」。我一開始以為可以,錯了,後來全面改用 TWSE。
  現在只有 `TaiwanStockInfo`(全市場但免費可用)與 FOMO 的逐檔查詢在用 FinMind。
- **TWSE `STOCK_DAY_ALL` 是開放資料快取,收盤後不會馬上更新**(實測台北 19:53 還是前一交易日)。
  所以另外用按日期定址的 `MI_INDEX` 每天補最近 5 個交易日的缺口。
- **`BFI82U` 的市場買賣差額可能是負數**(8/31 外資淨賣超 143 億),不能當佔比的分母。
  改用 T86 的「買超個股加總」。
- **`.btn-block { display: block }` 會蓋掉 `hidden` 屬性** → CSS 有一行全域
  `[hidden] { display: none !important; }`,不要拿掉。
- **自動存檔時重繪 DOM 會把使用者正在打的字吃掉。** `saveOpenStep` 有 `keepDom` 選項,
  `autoSave()` 絕不重繪。Kelly 的輸入列也是同樣原則:只在「筆數」改變時重建。
- 前端是 **ES5**(沒有箭頭函式、樣板字串、ES module),因為要能用 `file://` 直接開。

## 已知限制 / 還沒決定的事

1. **`FINMIND_TOKEN` 目前沒設。** 未註冊額度 300 次/小時,FOMO 60 檔要 244 次(81%),
   同一小時內重跑會撞牆。設了 token 額度變 600,才有空間再往上加檔數。
2. **FinMind 的產業分類對上市股太粗。** 1,089 檔裡有 247 檔掛在「電子工業」大類 ——
   台積電、鴻海、聯發科、大立光、中華電全在同一格;半導體業只有 19 檔、化學工業只有 3 檔。
   細分類幾乎只用在上櫃與新上市股。SH2 的 44 種清單也是大類與細分類並存,所以沒有自行合併。
   `t187ap03_L` 的 TWSE 官方產業數字代碼已存進 `stock_meta.json` 的 `twse_industry_code`
   **備用,目前不參與分組** —— 要不要換由使用者決定(換掉就不是 SH2 的分類了)。
3. **產業流向 107 組裡有 70 組是「樣本數低」。** 只做上市 + 組內相對切三層的必然結果
   (資訊服務業只有 2 檔上市股)。行為符合 SH2 規格。
4. **抽樣要不要保留。** 目前照 SH2 原樣:每組取 10 檔(`SAMPLE_TARGET_PER_GROUP`)並凍結。
   免費全市場資料其實讓抽樣沒必要,但改成全組聚合就跟 SH2 對不起來。**使用者還沒決定。**
5. **產業流向的染色跟 SH2 相反。** SH2 8012 是綠正紅負,這裡沿用本站的紅漲綠跌;
   而且 rebase 以 1.0 為基準、D0-D1 以 0 為基準(照字面「純看正負號」的話比值會全綠)。
   MA21 與原始筆數是水準值,不染色。這是我的決定,已跟使用者說明。
6. `data/history` 目前 25 天,`KEEP_DAYS` 已改成 30,每天加一天會自然長到 30。
   想立刻補滿:手動觸發時 `backfill_days` 填 30。
7. 相關係數只有 24 天樣本,標準誤約 ±0.20,畫面上有標。
8. 可以考慮用免費的 TWSE `BWIBBU_ALL` 取代 FinMind `TaiwanStockPER` 拿 PBR,
   每檔省一次呼叫 —— 還沒跟使用者提過。
9. **持倉的「出場設定」(當沖/獲利出場/持倉天數到期/留倉不賣 + 最大回撤)觸發時會自動把
   `rec.status` 轉成 `exited`(`checkAutoExits()`,在 `loadQuotes()` 之後跑一次),但這不是
   真的下單** —— 這個 app 沒有接券商 API,沒辦法送出委託,只是把 app 自己的狀態欄位改掉,
   使用者還是要自己去券商那邊實際成交。資料也是排程跑完才更新一次,不是即時報價,「當沖」
   模式判斷用的還是當日收盤/現價快照。觸發當下的假設成交價存進 `rec.exit_result`(不是事後
   用當時的報價回推,避免多久沒開網頁而讓勝率跟著亂跳),追蹤分頁的「自動出場統計」用這份
   快照算勝率/平均報酬,依觸發規則(target/days/drawdown)分組。門檻數字(%多少清倉、回撤
   壓多少)是使用者自己判斷,沒有經過統計驗證(`data/history` 目前不到 30 個交易日,連
   Gate 1 的 N≥60 都不夠格),勝率統計本身也一樣,樣本數會很小,UI 上有提醒。持倉天數用
   `quotes.days` 數,受 30 天視窗限制,超過這個天數的舊倉位天數會被低估。使用者用
   `doReactivate()`(「重新設為進行中」)可以撤銷自動出場,這時 `exit_result` 會被清空,
   不會算進統計。
10. **2026-09-10 新增「移動停利」出場模式**(`exit_plan.mode = 'trail'`),使用者發現固定
    4.5% 停利常常太早出場(把已出場的 7 檔拿現價回推,平均少賺快 5 個百分點),要求先試
    這組固定值:沿用「目標漲幅 %」欄位當啟動門檻,**持有期間最高價(逐日高點,不是收盤價)
    曾經到過門檻就算啟動**(之後拉回也不取消);啟動後只要「今日成交量 / MA5(前 5 個交易日,
    shift 1、不含當日)< 0.7」或「單日漲幅 ≥ 9%(視為漲停)」任一命中就出場。兩個門檻
    (`TRAIL_VOL_SHRINK_RATIO`、`TRAIL_LIMITUP_PCT`,寫死在 `js/app.js`)目前不開放 UI
    調整,也完全沒有驗證過比固定 4.5% 好——現有資料量連比較兩種模式勝率的基本樣本數都不夠,
    純粹是使用者要求先試試看。`exit_result.rule` 因此多了 `trail_vol`/`trail_limit` 兩種值,
    改了 `normalizeExitResult` 的白名單和 `EXIT_RULE_LABELS`/`EXIT_RULE_ORDER`——這三處要一起
    改,不然用 trail 模式出場的舊資料重新載入時 `exit_result` 會被判定成不合法格式直接丟掉。
11. **2026-09-10 FOMO 的「真漲」改名顯示成「可能會漲」,判斷邏輯也跟著改了。**
    起因是拿已追蹤股票對照 `signalOutcomeFor()` 的訊號準度統計,發現「真漲」訊號
    (N=28)後續真的漲的只有 11%,使用者認為問題出在舊邏輯只看外資連續買超、還把
    融資增加當扣分項(散戶追價=警訊);使用者的看法是「真漲」還需要散戶融資也連續
    進場撐盤,單靠外資撐不住。於是:
    - `scripts/fomo_score.py` 的 `judge_real_rally()` 拿掉「融資5日增幅 <10%(散戶未過度
      追價)」+20分那項,改成「融資連續買超 ≥3 天(`MARGIN_CONSECUTIVE`,散戶跟著進場)」
      +20分,且跟外資連續買超一樣變成**必要條件**——兩個 gate(外資連買、融資連買)都要
      過、總分也要 ≥60,才算「可能會漲」。
    - `scripts/compute_fomo.py` 的 `extract_metrics()` 新增 `margin_consecutive_buy_days`
      指標,算法跟外資連續買超同一套(從最新一天往回比對前一天餘額,中斷就停)。
    - 顯示文字全面從「真漲」改成「可能會漲」:`js/app.js` 的 badge、FOMO 明細理由標題、
      訊號準度統計文案、`quickAddTracking()` 帶入第 1 步的預設文字都改了,語氣上從斷言
      改成機率判斷。**程式內部欄位名稱維持 `is_real_rally`/`real_rally_score`/`real_rally`
      (reasons key、entry tag key)沒有跟著改**,只改使用者看得到的中文字,降低牽動範圍。
    - `ENTRY_TAG_RULES` 的 `real_rally` 規則同時比對「真漲」跟「可能會漲」兩種文字——
      舊的追蹤紀錄裡存的還是「真漲」這個舊字,拿掉舊字比對的話,分類、訊號準度統計都會
      悄悄把舊紀錄歸類成「未分類」,所以兩種文字都留著比對(`exclude` 同理)。
    - 這次改動**沒有回測驗證過新邏輯的命中率比舊的好**,跟移動停利那次一樣純粹是使用者
      的假設,先試這組,樣本夠了再回頭驗證。虛漲(`fake_rally`)、真跌/虛跌(暴跌 FOMO
      鏡射)邏輯沒有動。
12. **2026-09-10 個股查詢(FOMO個股查詢/爆量個股查詢/暴跌FOMO個股查詢/9-8全掃,四個
    分頁共用 `createLookupPanel()`)加了「融資維持率估計」**,使用者自己看 2313 的方法:
    假設「資料視窗裡成交量最大那天的最高價」是大多數融資買盤追高的套牢價,套融資成數
    的標準假設(六成、自備四成)反推維持率 = 現價 / 套牢價 / 融資成數 × 100%,判斷現在
    的下跌是「主力/外資測試性甩轎」(維持率還在安全區)還是「真的逼近融資斷頭」
    (跌破警戒/斷頭線)。`computeLookupMarginMaintenance()`,純前端算,吃這個表格既有的
    open/high/low/close/volume,不用新資料源,跟🔔量縮轉買那組是同一批(同樣只有 2313
    驗證過,沒有回測)。門檻 `LOOKUP_MARGIN_MAINT_WARN`(130)、`LOOKUP_MARGIN_MAINT_DANGER`
    (120)、融資成數假設 `LOOKUP_MARGIN_RATIO_ASSUMED`(0.6)都是固定值,不開放調整。
    顯示位置是選到某檔股票後 `#lookup-meta` 那行的附加文字(跟🕐蓄勢中的 zoneNote 同一種
    「目前狀態」呈現方式,不是逐日的表格欄位或下拉選單 badge);量最大的剛好是最新一天
    (視窗內抓不到過去套牢點)或資料不足兩天,就不顯示。用 2313(2026-08-28 量最大、
    最高 260,對照 2026-09-10 收 225.5)驗證過手算值(144.6%,安全),另外寫了 6 組邊界
    案例(安全/警戒/危險/剛好卡在斷頭線 120%/找不到套牢點/資料不足)全部通過。
13. **2026-09-10 追蹤分頁頂部加「全出」按鈕**(放在「匯入」跟「全刪」中間,`btn-exit-all`
    / `doExitAll()`),把所有 `status === 'active'`(進行中)的紀錄一次批次標記成
    `exited`,跟單筆「標記出場」(`doExit()`)是同一個欄位、同樣**不設 `exit_result`**
    ——這是手動批次動作,不是 `checkAutoExits()` 的自動出場,不該混進「自動出場統計」
    的勝率計算。每筆會補一則 `【全出】手動批次標記出場` 的追蹤紀錄留痕,已經是
    `exited`/`rejected` 的紀錄不會被動到。要復原只能單筆用 `doReactivate()`
    (「重新設為進行中」)個別救回來,沒有「全部復原」——跟「全刪」不一樣,這個沒有
    要求輸入確認字串,只有一般確認對話框(七個步驟內容、持倉紀錄都保留,不是刪除)。
    用 Playwright 驗證過:active 的兩筆正確轉成 exited 並補上追蹤紀錄,已經是
    exited/rejected 的紀錄完全沒被動到,`exit_result` 維持 null。
14. **2026-09-10 加「全出統計」,獨立於「自動出場統計」之外。** `doExitAll()` 按下
    「全出」的當下,對每筆有報價的紀錄用 `positionStats()` 存一份快照到新欄位
    `manual_exit_result`(date/price/pl/pl_pct,形狀跟 `exit_result`類似但**刻意獨立**,
    `normalizeManualExitResult()` 沒有 `rule` 白名單問題)。`manualExitStatsHtml()` 用這份
    快照算彙總勝率/平均報酬,畫面上是「自動出場統計」下面單獨一塊(`#manual-exit-stats`),
    只有一組數字,不像自動出場統計依 target/days/drawdown/trail_vol/trail_limit 分組
    ——「全出」永遠只有一種觸發來源,分組沒有意義。`doReactivate()`(「重新設為進行中」)
    連 `exit_result` 一起把 `manual_exit_result` 也清空,兩邊統計都會跟著調整。沒有報價
    或還沒入倉的紀錄按全出時拿不到快照,不會計入這份統計(只是照樣標記出場)。用
    Playwright 灌了一組會贏、一組會賠的假資料驗證過:快照的 pl/pl_pct/price 對上手算值、
    統計區塊 N/勝率/平均正確、展開明細正確、reactivate 後快照清空且統計數字跟著更新。
15. **2026-09-10 新增「大盤 30 日追蹤表」,順便把大盤九宮格的資料來源換成官方數字。**
    起因:使用者看到籌碼分頁的拉積盤提示後想要一張追蹤表,結果發現原本的大盤九宮格
    (`compute_market_grid.py`)只算「今天」,不存歷史——ΔP_idx 靠 FMTQIK(只回兩個
    交易日)、Turnover/漲跌家數是拿 `data/history` 自己加總近似出來的。先 probe
    `MI_INDEX?date=&type=ALL`(結論寫進 `data/README.md`,probe 腳本已刪)確認除了
    現有在用的個股報價表,還有大盤指數本身的收盤(`指數` 欄位等於「發行量加權股價
    指數」那一列)、官方成交金額/股數/筆數、官方漲跌家數三張表沒被用過,而且這支
    API 日期可定址,可以回補歷史。跟使用者確認兩件事:**指數開高低 TWSE 日報表沒
    公布,只留收盤**;成交金額/漲跌家數**改用官方數字**,取代原本的近似值。
    - `scripts/twse_api.py` 新增 `market_index_by_date()`,解析那三張表(TAIEX 收盤/
      漲跌、官方 Turnover、官方漲跌家數),不影響 `by_date()` 原本在用的個股報價表。
    - `scripts/compute_market_grid.py` 改成累積式:`data/market-grid-latest.json` 新增
      `history` 陣列(新到舊,每天一筆),跟 `data/history` 一樣「逐日累積長到
      `KEEP_DAYS`(30)天,同一天以新抓到的為準跟舊檔案合併,不用每次回補」。加了
      `--backfill-days`(daily-scan.yml 對應 `market_backfill_days` 手動觸發參數),
      第一次想馬上填滿 30 天可以用。法人買賣超(T86)一起逐日回補;**融資餘額/增減
      只有「今天」有值**,沒有大盤融資總額的歷史資料源,`history` 裡舊日子這幾個
      欄位是 null。`price_state`/`breadth_ratio`/`is_lajiban` 不需要歷史視窗,從第一天
      就有值;`volume_state`/`grid_label`(完整九宮格分類)需要前 20 天 Turnover,天數
      不夠時是 null,會隨每天排程補上。
    - 頂層的「今日快照」欄位名稱維持不變(`idx_close`/`price_state`/`grid_label`/
      `is_lajiban`/`advancing_count`⋯),前端既有的九宮格區塊不用改,只是數值來源
      從自算近似值換成官方數字——9/10 那天官方漲跌家數(259/744/69)跟原本自算的
      (259/753/69)差 9 家,不算大差但官方更準。
    - `js/app.js` 新增「大盤 30 日追蹤表」(`#market-history-panel`,籌碼分頁裡九宮格
      正下方):逐日收盤/漲跌%/成交金額(億)/漲跌家數/九宮格短標籤/拉積盤警告/
      外資+投信約(億),純渲染 `history` 陣列,不現算。
    - `twse_api.market_index_by_date()` 拿 probe 抓到的真實 9/10 資料手算過(10 項全過);
      `compute_market_grid.py` 的 `avg_window`/`price_state`/`vol_state`/
      `derive_grid_fields` 純邏輯測過(22 項),`main()` 的回補/合併/裁切邏輯用暫存
      資料夾整合測過(15 項,含「第二次沒給 backfill 也不會弄丟舊天數」這個關鍵行為);
      前端 `renderMarketHistory()` 用 Playwright 端對端測過(10 項)。過程中這份測試
      抓到一個真的 bug——`instTxt` 一開始用 `signed()` 包小數金額,但 `signed()`
      內部會 `Math.round` 成整數,小數會被吃掉,改成手動組字串才對。
16. **2026-09-10 追蹤新增「看多/看空」方向,持倉損益、自動出場、進場訊號統計、
    全出統計都依方向拆開算。** 起因:使用者發現暴跌掃描/暴跌FOMO 的訊號本質是
    「預期會跌」,應該對應做空,但持倉損益(`positionStats()`)原本一律用做多公式
    (`pl = 市值 − 成本`),暴跌訊號進場如果真的照這個公式記錄部位,股價跌了反而
    顯示賠錢——方向完全反了。
    - 每筆紀錄新增 `rec.direction`(`'long'`/`'short'`,預設 `'long'`),獨立欄位,
      沒有動到 `STEPS`/七步驟(`newRecord()`/`normalize()` 補齊)。「+ 追蹤」按下時
      跳出對話框問看多還是看空(`handleQuickAddClick()`,取代原本 `bindQuickAdd()`
      跟 FOMO/暴跌FOMO tbody 各自重複一份的點擊邏輯),取消就不建立紀錄。對話框
      哪個選項排前面(=預設)依來源分頁:爆量掃描/FOMO/題材分類→多、暴跌掃描/
      暴跌FOMO→空、量價訊號(獵人)依訊號本身(`hunterSigDefaultDir()`:①⑤→多、
      ③④⑥→空、②沒有明顯方向也預設多)——使用者當下仍可覆寫。加入後可以在
      追蹤詳情頁「持倉紀錄」區塊用 `toggleDirection()`(`#pos-dir-toggle`)隨時切換,
      不用重建紀錄。
    - `positionStats()`/`positionRangeStats()`/`checkAutoExits()`/持倉逐筆明細
      (`positionsHtml()`)全部乘上 `dir`(多 `+1`、空 `-1`)反轉損益:
      `pl = dir × (市值 − 成本)`。`evalExitPlan()`(出場設定觸發判斷)也跟著方向
      對稱改寫——看空的「獲利/當沖目標」是價格要跌到門檻(`close <= target`)、
      移動停利(`trail`)的「期間最有利價」是期間最低不是最高、量縮/噴出出場條件
      用「跌停(單日 ≤ −9%)」取代「漲停」、最大回撤(`max_drawdown_pct`)的基準
      是「從期間最低點反彈」不是「從最高點拉回」——整段邏輯用 `dir` 乘出來,不是
      複製一份空頭版本(跟 `compute_crash.py` 對稱 `compute_scan.py` 的精神一樣)。
      `exitPlanFormHtml()` 的欄位文字(目標「漲」幅/「跌」幅⋯)也依方向換字。
    - 發現並修掉一個既有 bug(不是這次新增的):`renderPosSummary()` 原本總損益
      是 `value 總和 − cost 總和` 重算一次,而不是加總每筆已經算好的 `st.pl`——
      混了看空的紀錄之後這個重算完全是錯的(看空的市值加總沒有意義),改成
      累加 `st.pl`。
    - 統計依方向拆開:`signalAccuracyHtml()`(進場訊號準度統計)、`exitStatsHtml()`
      (自動出場統計)、`manualExitStatsHtml()`(全出統計)都先按 `rec.direction`
      分兩組(看多/看空),組內邏輯不變(`exitStatsHtml()` 組內還是依觸發規則細分,
      `manualExitStatsHtml()` 組內只有一組彙總數字)。展開明細的記憶體狀態
      (`exitStatsExpanded`/`manualExitStatsExpanded`)key 從純規則名改成
      `方向:規則`(例如 `'short:target'`),避免看多看空的同名規則組共用展開狀態。
      注意:「命中率」的方向預期(`ENTRY_TAG_DIRECTION`,例如可能會漲該漲)講的是
      **訊號本身**該漲該跌,跟這裡用來分組的 `rec.direction`(**使用者選的交易方向**)
      是兩件事,沒有互相依賴——分組只是把兩種交易情境的樣本分開看。
    - 順手修掉一個因為測試才發現的既有標籤 bug:`EXIT_RULE_LABELS.trail_limit`
      固定寫死「移動停利(漲停出場)」,對看空的紀錄是錯的(看空觸發的是跌停),
      新增 `exitRuleLabelFor(key, dirKey)` 依分組方向換字,只有 `trail_limit`
      需要換,其餘規則文字跟方向無關。
    - 追蹤卡片(`cardHtml()`)加一個小標籤(`.pill-dir`,「多」/「空」)方便一眼
      看出每筆紀錄的方向,不影響原本的狀態 pill。
    - 用 Playwright 端對端測過(41 項全過,用真實的 checkAutoExits() 觸發路徑,
      不是單獨呼叫函式):看空的目標獲利/移動停利(跌停版)/最大回撤三種自動出場
      各自對照手算損益(依序 3,000/10,000/2,800,配一筆看多的目標獲利當回歸測試
      確認沒改壞原本邏輯)、持倉明細跟切換方向後的損益正負號、進場訊號統計/
      自動出場統計/全出統計三個區塊都正確拆成看多看空兩組、「+ 追蹤」在爆量/
      暴跌分頁預設選項正確、全出統計的兩筆快照金額正確。
    - **沒有處理的範圍**:「市值」加總(`renderPosSummary()` 的「目前市值」)沒有
      跟著方向反轉語意(看空部位的「市值」其實比較像是回補負債,不是資產),
      維持原樣單純加總 `shares × close`,只有「損益」數字修正——使用者只要求
      損益方向要對,沒有要求改市值的呈現方式,合不合理由使用者之後決定要不要
      再談。手動新增(「+新增」表單)不會跳出多空對話框,新紀錄一律預設看多,
      要改方向請用「持倉紀錄」區塊的切換按鈕。
17. **2026-09-10 `fetch_stock_lookup.py` 加 `--only`,可以只重抓清單裡的某幾檔。**
    起因:使用者把 2634(漢翔)加進 `stock_lookup.json` 之後問「能不能只抓這一檔,
    不要整個 daily-scan 流程重跑一次」——整份 daily-scan.yml 是單一 job、步驟寫死
    照順序跑,沒辦法只挑一步執行;而且就算只挑 `fetch_stock_lookup.py` 這一步,
    原本的寫法也是整份清單(目前 22 檔)重打一次 FinMind,不是只抓新加的那檔。
    - `--only 代號1,代號2`:先驗證代號都在 `--list-file` 清單裡(不在就報錯,
      避免手滑抓到清單外的代號),只對這幾檔打 FinMind;其餘代號的資料從舊的
      `--out-file` 讀出來原封不動保留(`merged_data = dict(base_data); merged_data.update(data)`),
      輸出的 `codes` 欄位還是完整清單,前端看不出差異。沒給 `--only` 就是舊行為
      (整份清單重抓、直接覆蓋),完全不影響 `daily-scan.yml` 既有呼叫方式。
    - 新增 `.github/workflows/update-stock-lookup.yml`(常駐,不是探測用的
      probe、用完不用刪):`list` 選 fomo/scan/crashfomo 三選一(對應三份
      `stock_lookup*.json`/`stock-lookup*-latest.json`),`only` 留空就是整份重抓。
      以後清單裡加新代號都可以用這支,不用等明天排程或整份重跑。
    - 離線測試(mock FinMind 呼叫,不用連網):`--only` 合併邏輯 12 項全過
      (未重抓的代號原封不動、新代號正確合併、`margin_change` 第一天正確是
      `None`、舊的失敗記錄被這次的成功結果蓋掉、`failures`/`codes` 欄位正確),
      另外 2 項回歸測試確認不給 `--only` 時完全是舊行為(整份清單真的被重新
      抓過,不是誤用了新的合併邏輯跳過重抓)。
18. **2026-09-10 新增獨立分頁「移動停利」(`js/app.js` 的 trailWatch* 系列函式,
    `index.html` 的 `#trail-wrap`),彙總所有「進行中」且出場設定為移動停利模式
    (`exit_plan.mode === 'trail'`)的紀錄,一次掃過去看每檔的啟動狀況,方便判斷
    該不該手動清倉。** 起因:移動停利原本只能在追蹤詳情頁逐檔點開看
    (`positionAlertsHtml()`),持有多檔移動停利部位時沒有總覽,得一檔一檔點。
    - 純觀察,不新增任何出場判斷邏輯——命中/自動出場仍然只有既有的
      `evalExitPlan()`/`checkAutoExits()` 這一套,`trailWatchRecords()` 收攏符合
      條件的紀錄後,直接呼叫 `evalExitPlan(rec, st)` 重用結果,不重複算一次量縮
      /漲跌停公式。新增的 `trailIndicators()` 只多算「是否已啟動」(期間峰值
      是否到過啟動門檻)跟「距峰回落幅度」這個連續指標(dir 依看多/看空鏡射,
      看多是從期間最高拉回、看空是從期間最低反彈)——這是既有 alert 只有
      命中/未命中兩態不會顯示的,讓使用者在真的觸發量縮/漲跌停之前,能先看到
      「已經從高點掉了多少」自己判斷要不要提早出場。
    - 每列狀態分四種:`尚無報價`(還沒載入報價或缺報價)/`未啟動`(期間峰值還沒
      到啟動門檻)/`觀察中`(已啟動,量縮/漲跌停都還沒命中)/`⚠ 出場訊號`
      (`evalExitPlan()` 至少一項 alert.hit 為真,含移動停利本身的量縮/漲跌停,
      也含獨立生效的最大回撤),命中的列額外加 `is-hit`(沿用 `.scan-table
      tr.is-hit` 既有樣式標紅底)。點列展開明細沿用出場設定同一套 `.exit-alerts`
      /`.exit-alert.is-hit` 樣式,列出啟動門檻價、期間峰值(價+日期)、距峰回落、
      量/MA5、今日漲跌,展開列底部「在追蹤分頁管理這筆」直接呼叫既有的
      `openDetail(rec.id)` 開個股詳情面板,沿用裡面的標記出場/切換方向/編輯
      出場設定按鈕,沒有另外做一套操作 UI。
    - 掛進 `VIEWS_ORDER`(追蹤後面、爆量掃描前面)吃到既有的左右滑動切換;
      `switchView('trail')` 觸發 `loadTrailWatch()`,跟 Kelly/籌碼分頁同一種
      「先用現有 `quotes` 渲染一次、`loadQuotes()` resolve/reject 後再渲染一次」
      的作法,不用等報價回來才有畫面。
    - 測試時發現一個既有機制的互動細節(不是 bug,行為符合預期,寫下來給
      下一個 Claude 省事):`checkAutoExits()` 只在 `init()` 裡報價第一次載入成功
      後跑一次,所以正常情況下,一旦某筆移動停利紀錄命中量縮/漲跌停,
      幾乎不可能在這個分頁看到「⚠ 出場訊號」列還停留在「進行中」狀態太久
      ——同一個 session 裡,init() 的自動報價請求通常搶先把它轉成
      `exited`,這個分頁再渲染時那筆已經從「進行中」清單消失了。純觀察分頁
      本來就不需要處理這個,「⚠ 出場訊號」主要是給罕見的競速窗口或未來報價
      提早失敗又重試成功的情境用,不影響主要用途(啟動前/啟動後未命中的
      「未啟動」「觀察中」兩態,以及距峰回落指標)。
    - 用 Playwright 端對端測過(33 項全過,4 檔假紀錄涵蓋未啟動/觀察中/
      量縮出場命中/空方跌停出場命中,損益、距峰回落、量/MA5 比值都對照手算值;
      為了在同一個 session 驗證「命中但還沒被 checkAutoExits 轉掉」這個狀態,
      測試用 route 攔截讓 init() 那次報價請求失敗、換這個分頁自己重試成功,
      藉此繞過 `checkAutoExits()`,不是修改生產邏輯):非移動停利模式與已出場
      的紀錄正確被排除、四種狀態徽章與列高亮正確、展開明細的量縮/跌停文字與
      比值正確、只有預期的那一項 alert 帶 `is-hit`、「在追蹤分頁管理這筆」正確
      開到對應股票的個股詳情面板。
19. **2026-09-11 `--only` 遇到清單裡沒有的代號,從「報錯」改成「自動加進清單再抓」。**
    起因:使用者想用「更新個股查詢資料」workflow 直接抓 6834,結果撞到
    item 17 那個故意做的防呆(`--only` 的代號要先在 `stock_lookup*.json`
    清單裡,不在就報錯)——使用者的預期是這支工具「打代號就能抓」,原本
    「先手動編輯 JSON 加代號、再觸發抓取」的兩步驟對這個用途來說是多餘的
    摩擦。跟使用者確認後,把行為改成打代號直接抓(選項:改成自動加清單、
    維持現狀、只抓不留底三選一,使用者選第一個)。
    - 技術上本來就沒有回補限制:開高低收量來自 `data/history`(每天存
      **全市場**,不管清單裡有沒有那檔),融資融券/外資投信是抓 FinMind
      過去 60 個日曆天的區間(`LOOKBACK_CALENDAR_DAYS`,不是只抓「今天」)
      ——新代號一樣拿得到完整歷史,不會缺一截。卡住的純粹是那個人為的
      「必須先在清單裡」檢查。
    - 防手滑的方式從「代號必須已經在清單裡」改成「代號格式必須是合法的
      上市普通股(`common.LISTED_CODE`,4 碼、開頭非 0)」——格式明顯不對
      (常見情況是 TPEx 或 ETF 常用的 0 開頭代號)還是會擋下來並印出錯誤,
      只是不再要求代號已經被加過。格式通過但清單裡沒有的代號,會先
      `common.write_json` 寫回 `--list-file`(用清單原本的陣列格式,新代號
      加在最後面),再照原本的流程抓取,之後每天排程也會繼續追這檔。
    - 離線測試(mock FinMind 呼叫,不用連網)14 項全過:清單裡沒有的合法
      代號正確被寫進清單並抓到資料、格式不合法的代號(用 `0050` 測)報錯
      且清單/輸出檔都沒被動到、代號本來就在清單裡時行為跟舊版一樣(不寫
      清單,也不印「已自動加進」)、一次給多個代號時只有真的缺的那個被
      加進清單。
20. **2026-09-11 清掉三支已經用完的一次性 workflow(使用者要求)。** 刪了
    `.github/workflows/init-lookup-crashfomo.yml`(初始化暴跌FOMO個股查詢,
    `daily-scan.yml` 早就接手每天更新)、`probe-signal-batch.yml`(量縮系列
    標記批次測試)、`probe-stock-history.yml`(探測 TWSE STOCK_DAY 能不能查
    到比 `data/history` 更早的價格)——三支的 workflow 檔名/標題都自己寫
    「一次性,用完即刪/可刪」,而且刪之前逐一 grep 過整個 repo,除了自己
    的 workflow 檔案沒有任何地方引用,刪掉不影響任何現有功能。
    - `probe-stock-history.yml` 對應的腳本 `scripts/probe_stock_history.py`
      一起刪了(自成一支、沒被其他程式 import)。**但沒找到這支 probe 的
      結論被寫進 `data/README.md`**——照理說 probe 用完要把結論記下來,
      這支好像沒記到(或者根本沒被跑過)。git 歷史還在,想找回來用
      `git log --all --full-history -- scripts/probe_stock_history.py`。
    - `probe-signal-batch.yml` 只刪了 workflow,**腳本 `scripts/probe_signal_batch.py`
      沒有刪**——`scripts/analyze_signal_outcomes.py` 直接 `import
      probe_signal_batch as p` 拿裡面的判斷函式,不是真的用完即丟的
      probe,只是命名跟著 probe-*.yml 系列取的。
    - **沒有刪 `scan-full-candidates.yml`**,雖然它的標題也寫「一次性」、
      `data/README.md` 也說它跟 `probe-*.yml` 系列同一個慣例——但
      grep 出來發現 `index.html` 的「9/8全掃」分頁使用說明裡**直接教
      使用者「想補新的一天要再手動觸發一次 `scan-full-candidates.yml`」**,
      `scripts/append_fullscan_price.py` 的錯誤訊息也是同一句話。這支
      實際上是「隨時可以重新觸發拿新快照」的常駐工具,不是真的一次性,
      刪掉會讓 app 內建的操作說明變成空話,所以留著。
21. **2026-09-12 新增獨立分頁「思考路徑」**(`js/app.js` 的 thinking* 系列函式,
    `index.html` 的 `#thinking-wrap`/`#tp-sheet-backdrop`,`css/style.css` 的
    `.tp-*` 系列),用分岔/合併的鐵軌圖記錄一檔股票的推理過程——使用者的
    原話是「思考會斷鏈,但思考又像大樓一樣需要一層一層疊加」,想要一個
    方塊接方塊、可以分岔也可以合併的視覺化工具,不是文字紀錄。先用
    Artifact 做了一個可以互動的設計原型讓使用者試玩(分岔/合併/刪除/
    切換路徑),定案後才動手寫進正式 ES5 codebase,確認了 5 個決定:
    - **每條路徑一定要綁一檔股票**(`thinkingOpenPathSheet()` 建立路徑時
      股票代號為必填,沒填會被 `toast` 擋下來,名稱選填)。
    - **方塊文字是固定選單**(`TP_TAGS` 十個詞:大牛市/盤整/拉積盤/要看多/
      要看空/外資進場/投信進場/新技術/新聞看到的/預計出場)**+ 可以自訂
      文字**——選單只是快捷,文字輸入框本來就能自由打字,選單詞會連動
      帶出對應分類(`TP_TAG_CAT`),自訂文字沒對到任何詞就歸類「其他筆記」。
    - **分岔/合併用按鈕 + 多選,不是拖曳畫線**——手機觸控做拖曳連接點準度
      很差。分岔不是獨立操作:對同一個父方塊連續按兩次「+ 接續」自然長出
      兩條岔路;合併是多選兩個以上的方塊後按「合併成新方塊」,新方塊會
      同時接住所有選取方塊的線。
    - **刪除連同下游整條子樹一起刪**(`thinkingCollectDescendants()` 遞迴收集
      所有下游方塊 id 一起移除)——跟追蹤分頁單筆刪除不同(那邊子代不受
      影響),因為思考路徑的方塊沒有獨立意義,留著沒接住上游的孤兒方塊
      沒有用。刪除前用既有的 `dialog()` 二次確認,樣式跟全刪/全出一致,
      訊息裡會先算出總共會刪幾格。
    - **先不跟追蹤分頁互相牽動**——沒有從「預計出場」方塊跳去「+ 追蹤」
      之類的整合,完全獨立,也沒有動到 `STEPS`/七步驟的任何欄位。
    - 分類配色:看多/看空直接沿用 `--up`/`--down`(跟全站紅漲綠跌一致),
      另外四類(大盤總經/籌碼流向/消息技術/其他筆記)新增
      `--tp-macro`/`--tp-flow`/`--tp-catalyst`/`--tp-note` 四個 CSS 變數,
      結論/出場不佔用另一個顏色,改用虛線框 + `--text` 圓點區別「這是
      終點」,不是用顏色堆疊出第七種分類。
    - 版面是**由上往下**(不是左右)的分層鐵軌圖:`thinkingComputeRows()`
      沿 edges 算每個方塊的深度(最長路徑),同深度分一列,列數隨路徑長多
      少而長多少,不是固定格子;分岔在同一列往左右展開。連線用
      `thinkingDrawTracks()` 量測方塊實際的 `offsetTop/offsetLeft` 畫 SVG
      三次貝茲曲線,不追求嚴格對齊的圖論排版,靠曲線本身的彈性呈現「分岔
      /會合」的鐵軌感。手機寬度考量,畫布左右上下都能捲動(跟其他表格
      `.table-scroll` 同一個 `overflow:auto` 慣例)。
    - **踩過的坑,別再踩一次**:`.tp-row`(方塊那一列)絕對不能設
      `position: relative`——一旦設了,方塊的 `offsetParent` 會變成那一列
      自己,`offsetTop` 全部歸零重算,連線座標整個錯位(方塊疊在畫布最上緣
      附近,不是接在正確位置)。SVG 疊在方塊下面純粹靠 DOM 順序(svg 插在
      每次重繪最前面,方塊在後面自然蓋住線的尾端),沒有用 z-index。
    - 儲存:獨立 localStorage key `stock_pipeline_v1__thinking_paths`
      (`{ currentPathId, paths:[{id,name,stock_id,stock_name,created_at,
      nodes,edges}] }`),選取狀態 `thinkingSelected` 只存記憶體、離開分頁
      不落地。**已經接進「匯出/匯入」備份**(`exportBackup()`/
      `confirmImport()`),多一個 `thinking_paths` 欄位,合併匯入時依路徑
      id 覆蓋、覆蓋匯入時整份取代,行為跟既有的 `lookup_notes` 完全對稱,
      舊版備份檔沒有這個欄位時保持現狀不動。
    - 分頁位置排在「追蹤」後面、「移動停利」前面,`VIEWS_ORDER` 陣列跟
      `index.html` 的 `#views` 按鈕順序同步改。
    - Playwright 端對端測過:綁股票代號必填(空白擋下)、分岔長出兩列、
      合併收斂成一列且 SVG 連線數正確、重整後資料還在、串聯刪除正確算出
      並移除整條子樹(4 格)、匯出的 JSON 檔案裡 `thinking_paths` 內容正確。

---

## 測試

Playwright 在 `/opt/node22/lib/node_modules`,要 `export NODE_PATH=/opt/node22/lib/node_modules`。
把 repo 複製一份出來 `python3 -m http.server` 再跑。目前三組:

- 追蹤(七步驟、存檔、匯出匯入、損毀救援):24 項
- 產業流向:27 項,**其中會把前端 JS 公式與後端 Python 的當日值逐格比對**
  (552 格)—— 個股明細必須前端現算,所以兩份公式都存在,靠這個比對防止走鐘
- 部位(Kelly / 零股 / 持倉):44 項,每個數字都對照手算值

Python 側的離線測試散在 scratchpad,`tick_flow` 49 項、`fetch_stock_meta` 23 項、
`compute_fomo` 額度 16 項。

## 環境限制

- 容器 proxy 擋掉 TWSE / FinMind / github.io → 對外資料一律走 Actions,我讀 log
- GitHub token **不能**觸發 workflow(403),要請使用者自己按 Run workflow
- 容器是 ephemeral,沒 push 的東西會不見
