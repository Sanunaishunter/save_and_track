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
`crash_source` / `crash_top`(預設 60)/ `crash_limit`。

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
