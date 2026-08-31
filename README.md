# 選股七步驟追蹤工具

一個完全獨立的靜態網頁小工具,用來把每一檔股票從「靈感」走到「出場」的七個步驟記錄下來。

- 純 HTML + CSS + JavaScript,**沒有後端、沒有資料庫、沒有登入、沒有建置流程**
- 不依賴任何前端框架,也沒有 npm / webpack,檔案直接打開就能跑
- 資料存在瀏覽器的 **`localStorage`**(標準瀏覽器 API),離線也能用
- 手機瀏覽器可以「加到主畫面」,用起來跟 App 差不多

```
save_and_track/
├── index.html          畫面結構
├── css/style.css       深色主題(紅漲 #e8453c / 綠跌 #26a65b)
├── js/app.js           全部邏輯:七步驟、分頁、存檔、匯出匯入
├── manifest.json       加到主畫面用的設定
├── icons/              App 圖示(icon.svg 是原稿,PNG 由它產生)
└── README.md
```

---

## 一、在本機打開

### 方法 A:直接用瀏覽器開(最快)

用檔案總管 / Finder 點兩下 `index.html`,或在瀏覽器網址列輸入:

```
file:///你的路徑/save_and_track/index.html
```

在桌機 Chrome、Edge、Firefox、Safari 都可以正常存檔(已實測 Chromium 的 `file://` 可以寫入並在重開瀏覽器後保留)。

> ⚠️ `file://` 開啟時,「加到主畫面」和 manifest 不會生效,而且手機上通常沒辦法用 `file://` 開本機檔案。手機請用下面的方法。

### 方法 B:用 Python 起一個本機伺服器

需要跟手機同一個 Wi-Fi 才能用手機連。

```bash
cd save_and_track
python3 -m http.server 8000
```

然後開:

- 電腦:<http://localhost:8000>
- 手機:`http://<電腦的區域網路 IP>:8000`(例如 `http://192.168.1.23:8000`)

查自己的 IP:

```bash
# macOS / Linux
ipconfig getifaddr en0 2>/dev/null || hostname -I
# Windows
ipconfig
```

`Ctrl + C` 停掉伺服器。這個方式只在電腦開著、而且同一個網路時才連得到,適合先試用;要長期在手機上用,建議往下看 GitHub Pages。

---

## 二、部署到 GitHub Pages(手機直接連網址)

這個 repo 已經備好了,檔案都在根目錄。GitHub Pages 只是把這幾個靜態檔案放到一個
網址上,**你填的資料一樣只存在自己手機的瀏覽器裡,不會上傳到任何地方**。

### 開啟 Pages(只要做一次)

到 repo 頁面 → **Settings** → 左側 **Pages**:

- Source 選 **Deploy from a branch**
- Branch 選 **main**、資料夾選 **/ (root)**
- 按 **Save**

等一到兩分鐘,網址就是:

```
https://sanunaishunter.github.io/save_and_track/
```

把它存進手機書籤,或照第三節加到主畫面。

> Pages 需要 repo 是 **public**(private repo 要 GitHub Pro 才能用)。

### 之後更新

`git push` 到 main 之後,Pages 會自動重新部署,通常一兩分鐘生效。
如果手機上看到的還是舊版,多半是瀏覽器快取,強制重新整理或關掉分頁再開即可。

---

## 三、加到主畫面(讓它看起來像 App)

先用瀏覽器打開部署好的網址(要是 `http://` 或 `https://`,`file://` 不行)。

### iOS(iPhone / iPad)

必須用 **Safari**(Chrome 版的 iOS 也可以,但 Safari 最完整):

1. 開啟網址
2. 按下方中間的 **分享** 按鈕(方框加上箭頭)
3. 往下滑,選 **加入主畫面**
4. 確認名稱(預設是「選股七步驟」),按 **新增**

### Android

用 **Chrome**:

1. 開啟網址
2. 按右上角 **⋮**
3. 選 **加到主畫面** 或 **安裝應用程式**
4. 按 **安裝**

加完之後,主畫面會多一個紅色階梯圖示,點下去是全螢幕、沒有網址列的模式。

> 圖示是紅色的上升階梯,呼應「一步一步走完七個步驟」。
> 原稿是 `icons/icon.svg`,兩個 PNG 由它產生;圖形都收在中心安全區內,
> Android 的圓形遮罩不會裁到內容。想換成別的圖,直接替換
> `icons/icon-192.png` 和 `icons/icon-512.png` 即可,不用改程式碼。

---

## 四、備份與還原

**資料只存在你當下用的那個瀏覽器裡。** 這代表:

- 換手機、換瀏覽器、清除瀏覽資料 → 資料不會自己跟過去
- 用 `file://` 開的資料,跟用 GitHub Pages 網址開的資料,是**兩份完全分開的資料**(瀏覽器把它們當成不同來源)

所以請養成定期備份的習慣:

| 動作 | 做法 |
| --- | --- |
| 備份 | 按右上角 **匯出**,會下載 `stock-pipeline-backup-20260831-143000.json` |
| 還原 | 按 **匯入**,選剛才的 JSON 檔,再選「合併」或「覆蓋全部」 |

- **合併**:相同 `id` 的用備份檔的內容取代,其他現有資料保留
- **覆蓋全部**:刪掉現有全部資料,換成備份檔的內容

兩種方式在動手前,都會先把「現在的資料」另外存一份到瀏覽器的
`stock_pipeline_v1__before_import`,萬一按錯還救得回來(可以在瀏覽器的開發者工具裡撈出來)。

### 換裝置 / 換網址的搬家步驟

1. 在舊的地方按 **匯出**,把 JSON 檔傳到新裝置(AirDrop、雲端硬碟、傳給自己都行)
2. 在新的地方打開網頁,按 **匯入**,選那個 JSON,選「覆蓋全部」

---

## 五、資料存在哪裡、長什麼樣

全部資料放在 `localStorage` 的單一 key:**`stock_pipeline_v1`**,內容是一個 JSON 陣列:

```jsonc
[
  {
    "id": "sp_mtgsu98o_feq9vp",
    "stock_id": "2330",
    "stock_name": "台積電",
    "status": "active",            // active | rejected | exited
    "current_step": 3,             // 1~7
    "notes": {                     // 第 1~5 步的文字筆記
      "1": "CoWoS 產能吃緊,外資調升目標價後列入觀察。",
      "2": "毛利率 53%,連四季成長。",
      "3": "", "4": "", "5": ""
    },
    "entry_reason": "突破季線帶量",        // 第 6 步
    "entry_numbers": "本益比 22 倍,部位 15%",
    "target_price": "1200",
    "invalidation_price": "880",
    "tracking": [                          // 第 7 步,新的在最前面
      { "date": "2026-08-31", "note": "法說維持全年展望。" }
    ],
    "rejected_step": null,         // 在第幾步放棄
    "rejected_reason": "",
    "created_at": "2026-08-31T05:31:00.000Z",
    "updated_at": "2026-08-31T05:32:10.000Z"
  }
]
```

七個步驟:

| 步驟 | 名稱 | 存到哪個欄位 |
| --- | --- | --- |
| 1 | 選股靈感與來源 | `notes.1` |
| 2 | 基本面體質 | `notes.2` |
| 3 | 產業地位與題材 | `notes.3` |
| 4 | 籌碼與法人動向 | `notes.4` |
| 5 | 技術面與位置 | `notes.5` |
| 6 | 進場計畫 | `entry_reason` / `entry_numbers` / `target_price` / `invalidation_price` |
| 7 | 持有追蹤與紀律 | `tracking[]` |

---

## 六、存檔失敗會怎樣

上一版最大的問題是「看起來存好了、其實沒存」。這版的處理:

- 每次寫入都包 `try/catch`,而且**寫完會立刻讀回來比對**,不一致就當作失敗
- 失敗時一定會跳紅色提示(toast),寫清楚原因:空間滿了(`QuotaExceededError`)、
  瀏覽器擋住儲存權限(無痕模式)、或其他錯誤
- 一開啟頁面就先測試能不能寫入,不能的話最上面會出現紅色橫幅警告,不會讓你白填一整頁
- 如果存起來的內容壞掉(JSON 解析失敗),**不會直接覆蓋掉**,而是另存成
  `stock_pipeline_v1__corrupt_<時間戳>` 並提示你用備份檔還原
- 離開輸入框、切到背景、關閉分頁前都會自動存一次

### 已知限制(請留意)

- **無痕 / 私密瀏覽模式**:部分瀏覽器不給寫 `localStorage`,或關掉視窗就清空。頁面會警告,但請不要在無痕模式下長期使用。
- **iOS Safari 的儲存清除機制**:Safari 對長期沒有造訪的網站,可能會在約七天後清掉 script 寫入的儲存資料。經常打開、或用「加到主畫面」的方式使用可以避免;但**最保險的還是定期按「匯出」留一份 JSON**。
- **清除瀏覽資料 / 網站資料** 會一併刪掉這個工具的內容,系統不會另外提醒你。
- 資料綁在「瀏覽器 + 網址來源」上,不會在裝置之間同步。要同步請用匯出/匯入。

---

## 七、之後要改東西的話

這個 repo 就是完整的專案,沒有 `package.json`、沒有相依套件、沒有 build step。
改完直接 push,GitHub Pages 會在一兩分鐘內自動更新。

```bash
git clone https://github.com/Sanunaishunter/save_and_track.git
cd save_and_track
# 用任何編輯器改 index.html / css/style.css / js/app.js
git add . && git commit -m "說明改了什麼" && git push
```

想在推上去之前先看效果,就在本地開 `index.html`(見第一節)。

要換圖示的話,把 `icons/icon-192.png` 和 `icons/icon-512.png` 換成同尺寸的
圖檔即可,不需要改任何程式碼。
