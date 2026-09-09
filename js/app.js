/*
 * 選股七步驟追蹤工具
 * 純前端 / 無後端 / 無框架。資料存在瀏覽器的 localStorage。
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'stock_pipeline_v1';
  var IMPORT_BACKUP_KEY = 'stock_pipeline_v1__before_import';

  var STEPS = [
    { n: 1, title: '觸發', type: 'text',
      hint: '爆量／無量上漲來源，美股新聞背景（大盤現況、大公司動態）' },
    { n: 2, title: '個股新聞', type: 'text',
      hint: '該股新聞摘要，判斷是否有直接催化劑' },
    { n: 3, title: '法說／財報', type: 'text',
      hint: '丟給 Claude 分析法說會與財報的摘要結論' },
    { n: 4, title: 'K線劇本', type: 'choice', hint: '對照劇本判斷（可複選）', choices: [
      { v: 'A', label: '劇本 A', desc: '點火後量縮價跌，主力緩慢出貨 → 不進場' },
      { v: 'B', label: '劇本 B', desc: '點火後放量連跌，主力積極出貨 → 不進場' },
      { v: 'C', label: '劇本 C', desc: '點火後量能持續、價格續漲，主力鎖倉 → 進場做多' },
      { v: 'D', label: '劇本 D', desc: '放量急跌點火，恐慌性賣壓出清，主力吸籌後反彈 → 反彈進場' },
      { v: 'E', label: '劇本 E', desc: '消息面驅動型，散戶佔比>60%，新聞+法人買入同天觸發 → 短進短出' }
    ] },
    { n: 5, title: '獵人理論', type: 'choice', hint: '判斷力量對比（可複選，暫定分類）', choices: [
      { v: 'prey_retail', label: '主力吃散戶', desc: '法人默默吸籌，散戶尚未察覺' },
      { v: 'prey_institution', label: '散戶吃主力', desc: '法人流動性賣壓，散戶承接，隔日反彈型' },
      { v: 'aligned', label: '同向不對抗', desc: '法人與散戶方向一致，沒有明顯力量差' },
      { v: 'unclear', label: '力量不明', desc: '指標矛盾或不足以判斷' }
    ] },
    { n: 6, title: '進出場設定', type: 'entry', hint: '進場理由與目標／失效價位' },
    { n: 7, title: '追蹤', type: 'tracking', hint: '持續追蹤紀錄' }
  ];

  var STATUS_LABEL = { active: '進行中', exited: '已出場', rejected: '已放棄' };

  // ---------------------------------------------------------------- 狀態

  var data = [];            // 全部紀錄
  var currentTab = 'active';
  var currentId = null;     // 詳情頁正在看的 id
  var openStep = 1;         // 詳情頁展開中的步驟
  var storageOk = true;     // localStorage 是否可用

  // ---------------------------------------------------------------- 工具

  function $(sel) { return document.querySelector(sel); }
  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function uid() {
    return 'sp_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
  }

  function nowISO() { return new Date().toISOString(); }

  function pad(n) { return n < 10 ? '0' + n : String(n); }

  function todayStr(d) {
    d = d || new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function stampStr(d) {
    d = d || new Date();
    return String(d.getFullYear()) + pad(d.getMonth() + 1) + pad(d.getDate()) +
           '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate()) +
           ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function toast(msg, type, ms) {
    var t = el('toast');
    t.textContent = msg;
    t.className = 'toast' + (type ? ' ' + type : '');
    t.hidden = false;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { t.hidden = true; }, ms || (type === 'err' ? 6000 : 2400));
  }

  // ---------------------------------------------------------- 儲存層

  function storageProbe() {
    try {
      var k = '__sp_probe__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e };
    }
  }

  function describeStorageError(e) {
    if (!e) return '未知錯誤。';
    var name = e.name || '';
    if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') {
      return '瀏覽器儲存空間已滿(QuotaExceededError)。請先「匯出備份」,再刪掉一些舊紀錄。';
    }
    if (name === 'SecurityError') {
      return '瀏覽器阻擋了本頁的儲存權限。請確認不是無痕模式,且未封鎖網站資料。';
    }
    return (name ? name + ':' : '') + (e.message || String(e));
  }

  /** 讀取全部資料。讀取或解析失敗時回報,並保留原始字串不覆蓋。 */
  function loadAll() {
    var raw;
    try {
      raw = window.localStorage.getItem(STORAGE_KEY);
    } catch (e) {
      storageOk = false;
      showStorageBanner('讀取失敗 — ' + describeStorageError(e));
      return [];
    }
    if (!raw) return [];

    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      // 內容壞掉:另存一份保留原始資料,不要直接覆蓋掉使用者的東西。
      var salvageKey = STORAGE_KEY + '__corrupt_' + stampStr();
      try { window.localStorage.setItem(salvageKey, raw); } catch (e2) { /* 空間不足就算了 */ }
      showStorageBanner('儲存的資料無法解析,已備份到 ' + salvageKey + ',請匯入備份檔還原。');
      toast('資料損毀,無法讀取。原始內容已另存為 ' + salvageKey, 'err', 9000);
      return [];
    }

    if (!Array.isArray(parsed)) {
      showStorageBanner('儲存的資料格式不正確(不是陣列),已略過。');
      return [];
    }
    return parsed.map(normalize);
  }

  /** 寫入全部資料。回傳是否成功;失敗一定會有畫面提示。 */
  function saveAll() {
    var payload;
    try {
      payload = JSON.stringify(data);
    } catch (e) {
      toast('存檔失敗(資料無法序列化):' + (e.message || e), 'err');
      return false;
    }
    try {
      window.localStorage.setItem(STORAGE_KEY, payload);
    } catch (e) {
      storageOk = false;
      showStorageBanner('寫入失敗 — ' + describeStorageError(e));
      toast('存檔失敗!' + describeStorageError(e), 'err', 9000);
      return false;
    }
    // 寫完立刻讀回來確認,避免像舊版一樣「看起來有存、其實沒存」。
    try {
      if (window.localStorage.getItem(STORAGE_KEY) !== payload) {
        toast('存檔失敗:寫入後讀回的內容不一致,請匯出備份並改用其他瀏覽器。', 'err', 9000);
        return false;
      }
    } catch (e) {
      toast('存檔後無法驗證:' + describeStorageError(e), 'err', 9000);
      return false;
    }
    if (!storageOk) { storageOk = true; hideStorageBanner(); }
    return true;
  }

  // ---------------------------------------------------------- 開場動畫

  var SPLASH_SEEN_KEY = 'stock_pipeline_splash_seen';
  var SPLASH_EVERY_LAUNCH = true; // 目前先每次啟動都跑,之後要改回一天一次把這個切回 false

  function splashSeenToday() {
    try {
      return window.localStorage.getItem(SPLASH_SEEN_KEY) === todayStr();
    } catch (e) {
      return true; // 存不到就別每次都擋著使用者
    }
  }

  function markSplashSeen() {
    try { window.localStorage.setItem(SPLASH_SEEN_KEY, todayStr()); }
    catch (e) { /* 存不到頂多下次還會再跳一次,不影響功能 */ }
  }

  function hideSplash() {
    var s = el('splash');
    if (!s || s.hidden) return;
    s.removeEventListener('click', hideSplash);
    s.classList.add('is-hiding');
    setTimeout(function () {
      s.hidden = true;
      showVersionPage();
    }, 400);
  }

  function initSplash() {
    var s = el('splash');
    if (!s) return;
    // 版本頁接在 hideSplash() 裡面,今天已經看過、直接跳過動畫的這條路徑
    // 不會經過 hideSplash(),版本頁也就不會跳出來 —— 之後把
    // SPLASH_EVERY_LAUNCH 改回 false 時要一併想一下版本頁要不要獨立判斷。
    if (!SPLASH_EVERY_LAUNCH && splashSeenToday()) { s.hidden = true; return; }
    markSplashSeen();
    s.hidden = false;
    s.addEventListener('click', hideSplash);
    setTimeout(hideSplash, 11800);
  }

  // ---------------------------------------------------------- 版本資訊
  // 接在開場動畫後面。內容直接抓 GitHub commit 紀錄(public repo,不用 token,
  // 瀏覽器可以直接 fetch),不用另外手動維護一份說明,永遠是最新的。
  // 用 localStorage 快取 1 小時,避免短時間內重整好幾次撞到匿名額度(60 次/小時)。

  var VERSION_API_URL =
    'https://api.github.com/repos/Sanunaishunter/save_and_track/commits?per_page=20';
  var VERSION_CACHE_KEY = 'stock_pipeline_version_cache_v1';
  var VERSION_CACHE_TTL_MS = 60 * 60 * 1000;

  function readVersionCache() {
    try {
      var raw = window.localStorage.getItem(VERSION_CACHE_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      if (!obj || !obj.at || !obj.items) return null;
      if (Date.now() - obj.at > VERSION_CACHE_TTL_MS) return null;
      return obj.items;
    } catch (e) {
      return null;
    }
  }

  function writeVersionCache(items) {
    try {
      window.localStorage.setItem(VERSION_CACHE_KEY, JSON.stringify({ at: Date.now(), items: items }));
    } catch (e) { /* 存不到就算了,下次重新抓一次 */ }
  }

  function fmtVersionDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.getFullYear() + '/' + pad(d.getMonth() + 1) + '/' + pad(d.getDate());
  }

  function renderVersionList(items) {
    var list = el('version-list');
    var note = el('version-note');
    if (!items || !items.length) {
      note.textContent = '讀不到更新紀錄,不影響使用,直接進 App 就好。';
      list.innerHTML = '';
      return;
    }
    note.textContent = '最近 ' + items.length + ' 筆,直接讀 GitHub commit 紀錄。';
    list.innerHTML = items.map(function (it) {
      return '<div class="version-item">' +
        '<span class="version-item-date">' + esc(fmtVersionDate(it.date)) +
          (it.sha ? ' · ' + esc(it.sha) : '') + '</span>' +
        '<span class="version-item-msg">' + esc(it.summary) + '</span>' +
      '</div>';
    }).join('');
  }

  function loadVersionInfo() {
    var cached = readVersionCache();
    if (cached) { renderVersionList(cached); return; }

    el('version-note').textContent = '載入中…';
    el('version-list').innerHTML = '';

    fetch(VERSION_API_URL, { headers: { 'Accept': 'application/vnd.github+json' } })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        var items = (data || []).map(function (c) {
          var msg = (c.commit && c.commit.message) || '';
          var date = c.commit && c.commit.author && c.commit.author.date;
          return { sha: (c.sha || '').slice(0, 7), date: date, summary: msg.split('\n')[0] };
        });
        writeVersionCache(items);
        renderVersionList(items);
      })
      .catch(function (e) {
        el('version-note').textContent =
          '讀不到更新紀錄(' + (e.message || String(e)) + ')。不影響使用,直接進 App 就好。';
        el('version-list').innerHTML = '';
      });
  }

  function showVersionPage() {
    var v = el('version-page');
    if (!v) return;
    v.hidden = false;
    loadVersionInfo();
  }

  function hideVersionPage() {
    var v = el('version-page');
    if (v) v.hidden = true;
  }

  function showStorageBanner(msg) {
    var b = el('storage-banner');
    el('storage-banner-msg').textContent = msg;
    b.hidden = false;
  }
  function hideStorageBanner() { el('storage-banner').hidden = true; }

  // ---------------------------------------------------------- 資料模型

  function blankChoice() { return { options: [], note: '' }; }

  function blankNotes() {
    return { 1: '', 2: '', 3: '', 4: blankChoice(), 5: blankChoice() };
  }

  /**
   * 第 4、5 步是多選 + 補充說明。舊資料若把它存成純字串(或只有選項陣列),
   * 一律轉成 {options, note} 並保留原文字,不丟資料。
   */
  function normalizeChoice(v) {
    function strs(a) {
      return Array.isArray(a) ? a.filter(function (o) { return typeof o === 'string'; }) : [];
    }
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return { options: strs(v.options), note: typeof v.note === 'string' ? v.note : '' };
    }
    if (Array.isArray(v)) return { options: strs(v), note: '' };
    if (typeof v === 'string') return { options: [], note: v };
    return blankChoice();
  }

  function blankExitPlan() {
    return { mode: 'hold', target_pct: '', max_days: '', max_drawdown_pct: '' };
  }

  function newRecord(stockId, stockName) {
    var ts = nowISO();
    return {
      id: uid(),
      stock_id: stockId,
      stock_name: stockName,
      status: 'active',
      current_step: 1,
      notes: blankNotes(),
      entry_reason: '',
      entry_numbers: '',
      target_price: '',
      invalidation_price: '',
      tracking: [],
      positions: [],
      exit_plan: blankExitPlan(),
      exit_result: null,
      rejected_step: null,
      rejected_reason: '',
      created_at: ts,
      updated_at: ts
    };
  }

  /** 補齊缺欄位,讓舊的/外部匯入的資料也能安全使用。 */
  function normalize(r) {
    r = (r && typeof r === 'object') ? r : {};
    var notes = blankNotes();
    if (r.notes && typeof r.notes === 'object') {
      for (var i = 1; i <= 5; i++) {
        var v = r.notes[i] != null ? r.notes[i] : r.notes[String(i)];
        if (i <= 3) {
          notes[i] = typeof v === 'string' ? v : (v == null ? '' : String(v));
        } else {
          notes[i] = normalizeChoice(v);
        }
      }
    }
    var step = parseInt(r.current_step, 10);
    if (!(step >= 1 && step <= 7)) step = 1;

    var status = (r.status === 'exited' || r.status === 'rejected') ? r.status : 'active';

    var tracking = Array.isArray(r.tracking) ? r.tracking.filter(function (t) {
      return t && typeof t === 'object';
    }).map(function (t) {
      return { date: String(t.date || ''), note: String(t.note || '') };
    }) : [];

    return {
      id: r.id ? String(r.id) : uid(),
      stock_id: String(r.stock_id || ''),
      stock_name: String(r.stock_name || ''),
      status: status,
      current_step: step,
      notes: notes,
      entry_reason: String(r.entry_reason || ''),
      entry_numbers: String(r.entry_numbers || ''),
      target_price: String(r.target_price == null ? '' : r.target_price),
      invalidation_price: String(r.invalidation_price == null ? '' : r.invalidation_price),
      tracking: tracking,
      positions: normalizePositions(r.positions),
      exit_plan: normalizeExitPlan(r.exit_plan),
      exit_result: normalizeExitResult(r.exit_result),
      rejected_step: (r.rejected_step == null || r.rejected_step === '') ? null : parseInt(r.rejected_step, 10) || null,
      rejected_reason: String(r.rejected_reason || ''),
      created_at: r.created_at || nowISO(),
      updated_at: r.updated_at || r.created_at || nowISO()
    };
  }

  function findById(id) {
    for (var i = 0; i < data.length; i++) if (data[i].id === id) return data[i];
    return null;
  }

  function touch(rec) { rec.updated_at = nowISO(); }

  function stepFilled(rec, n) {
    if (n <= 3) return !!(rec.notes[n] && rec.notes[n].trim());
    if (n === 4 || n === 5) {
      var c = rec.notes[n] || blankChoice();
      return (c.options && c.options.length > 0) || !!(c.note && c.note.trim());
    }
    if (n === 6) {
      return !!((rec.entry_reason && rec.entry_reason.trim()) ||
                (rec.entry_numbers && rec.entry_numbers.trim()) ||
                (rec.target_price && rec.target_price.trim()) ||
                (rec.invalidation_price && rec.invalidation_price.trim()));
    }
    return rec.tracking.length > 0;
  }

  function displayTitle(rec) {
    if (rec.stock_id && rec.stock_name) return rec.stock_id + ' ' + rec.stock_name;
    return rec.stock_id || rec.stock_name || '(未命名)';
  }

  // ------------------------------------------- 一鍵加入追蹤(爆量掃描/FOMO/量價訊號/題材分類共用)
  //
  // 不改七步驟的欄位定義,只是把「+新增」表單原本要手動輸入代號/名稱的動作
  // 自動化:直接呼叫既有的 newRecord(),新紀錄從第 1 步開始,跟手動新增
  // 完全一樣。不自動跳轉到追蹤詳情頁,因為使用者是從別的分頁點的,跳頁
  // 會打斷正在看的掃描清單。

  /** 代號是否已經有一筆「追蹤中」的紀錄,用來決定按鈕要不要顯示成已加入。*/
  function isTracked(stockId) {
    stockId = String(stockId || '').trim();
    if (!stockId) return false;
    return data.some(function (r) { return r.stock_id === stockId && r.status === 'active'; });
  }

  /**
   * 產生一顆「+ 追蹤」按鈕,已經在追蹤中就顯示成灰色不可點。
   * note 選填:加入追蹤時要預先帶進第 1 步「觸發」的預設內容(例如 FOMO 的真漲/虛漲判定)。
   */
  function quickAddBtnHtml(code, name, note) {
    code = String(code || '').trim();
    if (!code) return '';
    if (isTracked(code)) return '<button type="button" class="btn-quickadd is-added" disabled>已追蹤</button>';
    return '<button type="button" class="btn-quickadd" data-qa-code="' + esc(code) +
      '" data-qa-name="' + esc(name || '') + '"' +
      (note ? ' data-qa-note="' + esc(note) + '"' : '') +
      '>+ 追蹤</button>';
  }

  function quickAddTracking(stockId, stockName, triggerNote) {
    stockId = String(stockId || '').trim();
    stockName = String(stockName || '').trim();
    if (!stockId && !stockName) return;
    var fresh = newRecord(stockId, stockName);
    if (triggerNote) fresh.notes[1] = triggerNote;
    data.push(fresh);
    if (saveAll()) toast('已加入追蹤:' + displayTitle(fresh), 'ok');
    renderList();
    promptQuickAddPosition(fresh);
  }

  /** 掛在任何一個容器上,委派處理裡面所有「+ 追蹤」按鈕的點擊。*/
  function bindQuickAdd(container) {
    container.addEventListener('click', function (e) {
      var btn = e.target.closest('.btn-quickadd');
      if (!btn || btn.disabled) return;
      e.stopPropagation();
      quickAddTracking(btn.getAttribute('data-qa-code'), btn.getAttribute('data-qa-name'),
        btn.getAttribute('data-qa-note'));
      btn.textContent = '已追蹤';
      btn.disabled = true;
      btn.classList.add('is-added');
    });
  }

  // ---------------------------------------------------------- 對話框

  /**
   * 通用對話框。回傳 Promise,解析為 { action, input }。
   * 按背景或取消 → action === null。
   */
  function dialog(opts) {
    return new Promise(function (resolve) {
      var backdrop = el('modal');
      el('modal-title').textContent = opts.title || '';
      el('modal-msg').textContent = opts.message || '';
      el('modal-msg').hidden = !opts.message;

      var wrap = el('modal-input-wrap');
      var input = el('modal-input');
      if (opts.input) {
        el('modal-input-label').textContent = opts.input.label || '';
        input.value = opts.input.value || '';
        input.placeholder = opts.input.placeholder || '';
        wrap.hidden = false;
      } else {
        wrap.hidden = true;
        input.value = '';
      }

      var actions = el('modal-actions');
      actions.innerHTML = '';
      var buttons = opts.actions || [{ label: '確定', value: 'ok', cls: 'btn-primary' }];

      function close(val) {
        backdrop.hidden = true;
        backdrop.removeEventListener('click', onBackdrop);
        resolve({ action: val, input: input.value });
      }
      function onBackdrop(e) { if (e.target === backdrop) close(null); }

      buttons.forEach(function (b) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-block ' + (b.cls || 'btn-outline');
        btn.textContent = b.label;
        btn.addEventListener('click', function () { close(b.value); });
        actions.appendChild(btn);
      });
      var cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.className = 'btn btn-block btn-ghost';
      cancel.textContent = opts.cancelLabel || '取消';
      cancel.addEventListener('click', function () { close(null); });
      actions.appendChild(cancel);

      backdrop.hidden = false;
      backdrop.addEventListener('click', onBackdrop);
      if (opts.input) input.focus();
    });
  }

  // ---------------------------------------------------------- 清單畫面

  function counts() {
    var c = { active: 0, exited: 0, rejected: 0, all: data.length };
    data.forEach(function (r) { c[r.status] = (c[r.status] || 0) + 1; });
    return c;
  }

  function visibleRecords() {
    var list = currentTab === 'all'
      ? data.slice()
      : data.filter(function (r) { return r.status === currentTab; });
    list.sort(function (a, b) {
      return String(b.updated_at).localeCompare(String(a.updated_at));
    });
    return list;
  }

  function dotsHtml(rec) {
    var cls = rec.status === 'exited' ? 'done-exited' : (rec.status === 'rejected' ? 'done-rejected' : 'done');
    var out = '';
    for (var i = 1; i <= 7; i++) {
      out += '<div class="dot ' + (stepFilled(rec, i) ? cls : '') + '"></div>';
    }
    return '<div class="dots">' + out + '</div>';
  }

  /** 卡片上的持倉一行。沒有持倉就完全不佔位置。 */
  function cardPosHtml(rec) {
    var st = positionStats(rec);
    if (!st) return '';
    var body = fmtInt(st.shares) + ' 股 · 成本 ' + fmtMoney(st.cost);
    if (!st.priced) {
      return '<div class="card-pos">' + esc(body) + ' · <span class="dim">無報價</span></div>';
    }
    return '<div class="card-pos">' + esc(body) +
      ' · <span class="' + plClass(st.pl) + '">' + signed(st.pl) +
      (st.plPct == null ? '' : ' (' + fmtPct(st.plPct, 1) + ')') + '</span></div>';
  }

  function cardHtml(rec) {
    var stepTitle = STEPS[rec.current_step - 1].title;
    var sub;
    if (rec.status === 'rejected') {
      sub = '第 ' + (rec.rejected_step || rec.current_step) + ' 步放棄' +
            (rec.rejected_reason ? ' — ' + rec.rejected_reason.split('\n')[0] : '');
    } else if (rec.status === 'exited') {
      sub = '已出場 · 共 ' + rec.tracking.length + ' 筆追蹤紀錄';
    } else {
      sub = '最後更新 ' + fmtDateTime(rec.updated_at);
    }
    return '' +
      '<article class="card" data-id="' + esc(rec.id) + '">' +
        '<div class="card-head">' +
          '<span class="card-code mono">' + esc(rec.stock_id || '—') + '</span>' +
          '<span class="card-name">' + esc(rec.stock_name) + '</span>' +
          '<span class="pill pill-' + rec.status + '">' + STATUS_LABEL[rec.status] + '</span>' +
        '</div>' +
        dotsHtml(rec) +
        '<div class="card-step">第 ' + rec.current_step + ' 步 · ' + esc(stepTitle) + '</div>' +
        cardPosHtml(rec) +
        '<div class="card-sub">' + esc(sub) + '</div>' +
      '</article>';
  }

  function renderList() {
    var c = counts();
    ['active', 'exited', 'rejected', 'all'].forEach(function (k) {
      var node = document.querySelector('[data-count="' + k + '"]');
      if (node) node.textContent = c[k] || 0;
    });

    var list = visibleRecords();
    el('list').innerHTML = list.map(cardHtml).join('');
    el('empty').hidden = list.length > 0;
  }

  // ---------------------------------------------------------- 詳情畫面

  function stepBodyHtml(rec, n) {
    if (n <= 3) {
      return '' +
        '<p class="step-hint">' + esc(STEPS[n - 1].hint) + '</p>' +
        '<textarea data-note="' + n + '" rows="6" placeholder="' + esc(STEPS[n - 1].hint) + '">' + esc(rec.notes[n]) + '</textarea>' +
        stepFooterHtml(rec, n);
    }
    if (n === 4 || n === 5) {
      var def = STEPS[n - 1];
      var c = rec.notes[n] || blankChoice();
      var chips = def.choices.map(function (ch) {
        var on = c.options.indexOf(ch.v) >= 0;
        return '<button type="button" class="chip' + (on ? ' sel' : '') + '"' +
                 ' data-chip="' + n + '" data-choice="' + esc(ch.v) + '"' +
                 ' aria-pressed="' + (on ? 'true' : 'false') + '">' +
                 '<span class="chip-label">' + esc(ch.label) + '</span>' +
                 '<span class="chip-desc">' + esc(ch.desc) + '</span>' +
               '</button>';
      }).join('');
      return '' +
        '<p class="step-hint">' + esc(def.hint) + '</p>' +
        '<div class="chipgrid">' + chips + '</div>' +
        '<textarea data-choicenote="' + n + '" rows="3" placeholder="補充說明（選填）">' + esc(c.note) + '</textarea>' +
        stepFooterHtml(rec, n);
    }
    if (n === 6) {
      return '' +
        '<p class="step-hint">' + esc(STEPS[5].hint) + '</p>' +
        '<label class="field"><span class="field-label">進場理由</span>' +
          '<textarea data-f="entry_reason" rows="3" placeholder="為什麼是現在買?">' + esc(rec.entry_reason) + '</textarea></label>' +
        '<label class="field"><span class="field-label">關鍵數字</span>' +
          '<textarea data-f="entry_numbers" rows="3" placeholder="本益比、成長率、進場價位、部位大小…">' + esc(rec.entry_numbers) + '</textarea></label>' +
        '<label class="field"><span class="field-label">目標價</span>' +
          '<input type="text" data-f="target_price" inputmode="decimal" value="' + esc(rec.target_price) + '" placeholder="例如 1200"></label>' +
        '<label class="field"><span class="field-label">失效價(跌破就承認看錯)</span>' +
          '<input type="text" data-f="invalidation_price" inputmode="decimal" value="' + esc(rec.invalidation_price) + '" placeholder="例如 880"></label>' +
        stepFooterHtml(rec, n);
    }
    // 第 7 步:追蹤紀錄
    var items = rec.tracking.map(function (t, i) {
      return '<li class="track-item">' +
        '<span class="track-date mono">' + esc(t.date || '—') + '</span>' +
        '<span class="track-note">' + esc(t.note) + '</span>' +
        '<button type="button" class="track-del" data-del-track="' + i + '" title="刪除這筆">×</button>' +
      '</li>';
    }).join('');
    return '' +
      '<p class="step-hint">' + esc(STEPS[6].hint) + '</p>' +
      '<div class="track-add">' +
        '<input type="date" id="track-date" value="' + esc(todayStr()) + '">' +
      '</div>' +
      '<textarea id="track-note" rows="3" placeholder="今天觀察到什麼?持有理由還成立嗎?"></textarea>' +
      '<div class="step-actions"><button type="button" class="btn btn-primary btn-sm" id="track-add">新增追蹤紀錄</button></div>' +
      (rec.tracking.length ? '<ul class="track-list">' + items + '</ul>' : '<p class="step-hint" style="margin-top:12px">還沒有追蹤紀錄。</p>') +
      stepFooterHtml(rec, n);
  }

  function stepFooterHtml(rec, n) {
    var out = '<div class="step-actions">';
    if (n !== 7) out += '<button type="button" class="btn btn-primary btn-sm" data-save="' + n + '">儲存</button>';
    out += '<span class="spacer"></span>';
    if (rec.status === 'active') {
      if (rec.current_step === n && n < 7) {
        out += '<button type="button" class="btn btn-sm" data-next="' + n + '">完成,進入第 ' + (n + 1) + ' 步</button>';
      } else if (rec.current_step !== n) {
        out += '<button type="button" class="btn btn-sm btn-outline" data-goto="' + n + '">設為目前步驟</button>';
      }
    }
    out += '</div>';
    return out;
  }

  function renderDetail() {
    var rec = findById(currentId);
    if (!rec) { closeDetail(); return; }

    el('detail-code').textContent = rec.stock_id || '—';
    el('detail-name').textContent = rec.stock_name || '';

    var meta = '建立於 ' + fmtDateTime(rec.created_at) + ' · 最後更新 ' + fmtDateTime(rec.updated_at) +
               ' · 狀態:' + STATUS_LABEL[rec.status];
    var metaHtml = esc(meta);
    if (rec.status === 'rejected') {
      metaHtml += '<span class="rej">在第 ' + (rec.rejected_step || rec.current_step) + ' 步放棄' +
                  (rec.rejected_reason ? '\n' + esc(rec.rejected_reason) : '') + '</span>';
    }
    el('detail-meta').innerHTML = metaHtml;
    renderPositions();
    renderGridDetail();
    renderMarginDetail();

    el('detail-steps').innerHTML = STEPS.map(function (s) {
      var isOpen = s.n === openStep;
      var cls = 'step' +
        (stepFilled(rec, s.n) ? ' is-filled' : '') +
        (rec.current_step === s.n && rec.status === 'active' ? ' is-current' : '');
      return '' +
        '<section class="' + cls + '" data-step="' + s.n + '">' +
          '<header class="step-head" data-toggle="' + s.n + '">' +
            '<span class="step-no">' + s.n + '</span>' +
            '<span class="step-title">' + esc(s.title) + '</span>' +
            (rec.current_step === s.n && rec.status === 'active' ? '<span class="step-flag">目前</span>' : '') +
            '<span class="step-caret">' + (isOpen ? '▲' : '▼') + '</span>' +
          '</header>' +
          (isOpen ? '<div class="step-body">' + stepBodyHtml(rec, s.n) + '</div>' : '') +
        '</section>';
    }).join('');

    el('btn-exit').hidden = rec.status !== 'active';
    el('btn-reject').hidden = rec.status !== 'active';
    el('btn-reactivate').hidden = rec.status === 'active';
  }

  function openDetail(id) {
    var rec = findById(id);
    if (!rec) return;
    currentId = id;
    openStep = rec.current_step;
    renderDetail();
    el('detail').hidden = false;
    el('detail').setAttribute('aria-hidden', 'false');
    el('detail').querySelector('.sheet-body').scrollTop = 0;
  }

  function closeDetail() {
    el('detail').hidden = true;
    el('detail').setAttribute('aria-hidden', 'true');
    currentId = null;
    renderList();
  }

  /** 把目前展開步驟裡尚未儲存的輸入寫回紀錄(不落地),回傳是否有變動。 */
  function collectOpenStep(rec) {
    var changed = false;
    var body = el('detail-steps').querySelector('.step-body');
    if (!body) return false;

    var noteBox = body.querySelector('[data-note]');
    if (noteBox) {
      var n = parseInt(noteBox.getAttribute('data-note'), 10);
      if (rec.notes[n] !== noteBox.value) { rec.notes[n] = noteBox.value; changed = true; }
    }
    var choiceNote = body.querySelector('[data-choicenote]');
    if (choiceNote) {
      var cn = parseInt(choiceNote.getAttribute('data-choicenote'), 10);
      if (!rec.notes[cn] || typeof rec.notes[cn] !== 'object') rec.notes[cn] = blankChoice();
      if (rec.notes[cn].note !== choiceNote.value) { rec.notes[cn].note = choiceNote.value; changed = true; }
    }
    ['entry_reason', 'entry_numbers', 'target_price', 'invalidation_price'].forEach(function (f) {
      var node = body.querySelector('[data-f="' + f + '"]');
      if (node && rec[f] !== node.value) { rec[f] = node.value; changed = true; }
    });
    return changed;
  }

  /**
   * 把展開中步驟的內容存檔。
   *   silent  — 自動存檔,沒變更就不寫、不跳提示
   *   keepDom — 不要重繪。使用者可能正在打字,重繪會把輸入框整個換掉。
   */
  function saveOpenStep(opts) {
    opts = opts || {};
    var rec = findById(currentId);
    if (!rec) return false;
    var changed = collectOpenStep(rec);
    if (opts.silent && !changed) return true;
    if (changed) touch(rec);
    var ok = saveAll();
    if (ok && !opts.silent) toast('已儲存', 'ok');
    if (!opts.keepDom) renderDetail();
    return ok;
  }

  function autoSave() { return saveOpenStep({ silent: true, keepDom: true }); }

  // ---------------------------------------------------------- 新增 / 編輯

  var formEditingId = null;

  // 股票代號 → 名稱自動帶入(2026-09-09 加入)。data/stock_names.json 是
  // 排程本來就會維護的全市場代號對照表(fetch_stock_meta.py 產出),
  // 純唯讀查表,不影響手動輸入或既有紀錄——查不到、抓不到都不擋填表。
  var STOCK_NAMES_URL = 'data/stock_names.json';
  var stockNamesMap = null;
  var stockNamesLoading = false;
  var fStockNameAutofilled = false;   // 名稱欄目前的值是不是自動帶的,使用者手動改過就不再覆蓋

  function loadStockNamesMap() {
    if (stockNamesMap || stockNamesLoading) return;
    if (location.protocol === 'file:') return;   // file:// 下 fetch 不能用,直接跳過,不影響手動輸入
    stockNamesLoading = true;
    fetch(STOCK_NAMES_URL, { cache: 'no-store' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        stockNamesMap = (d && typeof d === 'object' && !Array.isArray(d)) ? d : {};
        tryAutofillStockName();   // 資料剛好在使用者打完代號後才載入完成,補一次
      })
      .catch(function () { stockNamesMap = {}; })
      .then(function () { stockNamesLoading = false; });
  }

  function tryAutofillStockName() {
    if (!stockNamesMap) return;
    var sid = el('f-stock-id').value.trim();
    var name = stockNamesMap[sid];
    if (!name) return;
    var nameField = el('f-stock-name');
    if (nameField.value.trim() === '' || fStockNameAutofilled) {
      nameField.value = name;
      fStockNameAutofilled = true;
    }
  }

  function openForm(id) {
    formEditingId = id || null;
    var rec = id ? findById(id) : null;
    el('form-title').textContent = rec ? '編輯基本資料' : '新增股票';
    el('f-stock-id').value = rec ? rec.stock_id : '';
    el('f-stock-name').value = rec ? rec.stock_name : '';
    fStockNameAutofilled = false;   // 編輯既有紀錄時名稱已經有值,不要無故被查表蓋掉
    el('form').hidden = false;
    el('form').setAttribute('aria-hidden', 'false');
    // 同步對焦。用 setTimeout 延遲對焦會在使用者已經點到別的欄位後才搶走游標。
    el('f-stock-id').focus();
    loadStockNamesMap();
  }

  function closeForm() {
    el('form').hidden = true;
    el('form').setAttribute('aria-hidden', 'true');
    formEditingId = null;
  }

  function submitForm() {
    var sid = el('f-stock-id').value.trim();
    var name = el('f-stock-name').value.trim();
    if (!sid && !name) { toast('代號與名稱至少要填一個', 'err'); return; }

    if (formEditingId) {
      var rec = findById(formEditingId);
      if (!rec) { closeForm(); return; }
      rec.stock_id = sid;
      rec.stock_name = name;
      touch(rec);
      if (saveAll()) toast('已更新', 'ok');
      closeForm();
      renderDetail();
      renderList();
    } else {
      var fresh = newRecord(sid, name);
      data.push(fresh);
      if (saveAll()) toast('已新增 ' + displayTitle(fresh), 'ok');
      closeForm();
      renderList();
      openDetail(fresh.id);
      promptQuickAddPosition(fresh);
    }
  }

  /** 新增紀錄後順手問一句要不要直接入倉,省得每次都要點進第 6 步慢慢設。 */
  function promptQuickAddPosition(rec) {
    dialog({
      title: '順便幫 ' + displayTitle(rec) + ' 入倉?',
      message: '用預設 1000 股、抓目前收盤價下單,出場設定直接套用「獲利出場 4.5%」。' +
        '之後隨時可以在第 6 步改股數、價位或出場條件。',
      actions: [{ label: '順便入倉', value: 'yes', cls: 'btn-primary' }],
      cancelLabel: '先不要'
    }).then(function (res) {
      if (res.action !== 'yes') return;
      loadQuotes().catch(function () { return null; }).then(function () {
        var q = quoteOf(rec.stock_id);
        if (!q || !(q.close > 0)) {
          toast('查不到 ' + (rec.stock_id || '這檔') + ' 的收盤價,請到第 6 步手動輸入成交價', 'err');
          return;
        }
        rec.positions.push({ id: uid(), date: todayStr(), shares: 1000, price: q.close, fee: 0, note: '' });
        rec.exit_plan = { mode: 'profit', target_pct: '4.5', max_days: '', max_drawdown_pct: '' };
        touch(rec);
        if (!saveAll()) return;
        toast('已入倉 1000 股 @ ' + q.close + ',出場設定:獲利 4.5%', 'ok');
        if (currentId === rec.id) renderPositions();
        renderList();
        renderPosSummary();
      });
    });
  }

  // ---------------------------------------------------------- 狀態變更

  function doReject() {
    var rec = findById(currentId);
    if (!rec) return;
    collectOpenStep(rec);
    dialog({
      title: '放棄 ' + displayTitle(rec) + '?',
      message: '會記錄在第 ' + rec.current_step + ' 步放棄。之前填的內容都會保留,可以在「已放棄」分頁回頭看。',
      input: { label: '放棄原因', placeholder: '例如:毛利率連兩季下滑,跟原本的假設不符' },
      actions: [{ label: '確認放棄', value: 'reject', cls: 'btn-danger' }]
    }).then(function (res) {
      if (res.action !== 'reject') return;
      rec.status = 'rejected';
      rec.rejected_step = rec.current_step;
      rec.rejected_reason = (res.input || '').trim();
      touch(rec);
      if (saveAll()) toast('已放棄', 'ok');
      renderDetail();
      renderList();
      renderPosSummary();
    });
  }

  function doExit() {
    var rec = findById(currentId);
    if (!rec) return;
    collectOpenStep(rec);
    dialog({
      title: '標記 ' + displayTitle(rec) + ' 為已出場?',
      message: '出場備註會存成一筆追蹤紀錄(可留空)。',
      input: { label: '出場備註', placeholder: '例如:到達目標價 1200,分批出清' },
      actions: [{ label: '確認出場', value: 'exit', cls: 'btn-primary' }]
    }).then(function (res) {
      if (res.action !== 'exit') return;
      var note = (res.input || '').trim();
      if (note) rec.tracking.unshift({ date: todayStr(), note: '【出場】' + note });
      rec.status = 'exited';
      rec.current_step = 7;
      touch(rec);
      if (saveAll()) toast('已標記為出場', 'ok');
      renderDetail();
      renderList();
      renderPosSummary();
    });
  }

  function doReactivate() {
    var rec = findById(currentId);
    if (!rec) return;
    dialog({
      title: '重新設為進行中?',
      message: '會把狀態改回「進行中」,並清掉放棄原因。',
      actions: [{ label: '確認', value: 'ok', cls: 'btn-primary' }]
    }).then(function (res) {
      if (res.action !== 'ok') return;
      rec.status = 'active';
      rec.rejected_step = null;
      rec.rejected_reason = '';
      rec.exit_result = null;
      touch(rec);
      if (saveAll()) toast('已改回進行中', 'ok');
      renderDetail();
      renderList();
      renderPosSummary();
    });
  }

  function doDelete() {
    var rec = findById(currentId);
    if (!rec) return;
    dialog({
      title: '刪除 ' + displayTitle(rec) + '?',
      message: '這筆紀錄(含七個步驟的內容與追蹤紀錄)會永久消失,無法復原。建議先匯出備份。',
      actions: [{ label: '確定刪除', value: 'del', cls: 'btn-danger' }]
    }).then(function (res) {
      if (res.action !== 'del') return;
      data = data.filter(function (r) { return r.id !== rec.id; });
      if (saveAll()) toast('已刪除', 'ok');
      closeDetail();
    });
  }

  var DELETE_ALL_PHRASE = '刪除全部';

  function doDeleteAll() {
    if (!data.length) { toast('目前沒有任何追蹤紀錄', 'err'); return; }
    dialog({
      title: '刪除全部追蹤紀錄?',
      message: '目前共有 ' + data.length + ' 筆紀錄(進行中/已出場/已放棄都算),' +
        '包含七個步驟內容、追蹤備註與持倉紀錄會一次永久消失,無法復原。強烈建議先「匯出」備份。\n\n' +
        '請在下方輸入「' + DELETE_ALL_PHRASE + '」以確認。',
      input: { label: '輸入「' + DELETE_ALL_PHRASE + '」確認', placeholder: DELETE_ALL_PHRASE },
      actions: [{ label: '確定刪除全部', value: 'delAll', cls: 'btn-danger' }]
    }).then(function (res) {
      if (res.action !== 'delAll') return;
      if ((res.input || '').trim() !== DELETE_ALL_PHRASE) {
        toast('輸入的文字不符,取消刪除', 'err');
        return;
      }
      data = [];
      if (saveAll()) toast('已刪除全部追蹤紀錄', 'ok');
      closeDetail();
      renderPosSummary();
    });
  }

  // ---------------------------------------------------------- 匯出 / 匯入

  function exportBackup() {
    if (!data.length) {
      toast('目前沒有資料可以匯出', 'err');
      return;
    }
    var filename = 'stock-pipeline-backup-' + stampStr() + '.json';
    var text;
    try {
      text = JSON.stringify({ data: data, lookup_notes: loadLookupNotesMap() }, null, 2);
    } catch (e) {
      toast('匯出失敗:' + (e.message || e), 'err');
      return;
    }
    try {
      var blob = new Blob([text], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.rel = 'noopener';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
      toast('已匯出 ' + filename + '(共 ' + data.length + ' 筆)', 'ok', 4000);
    } catch (e) {
      toast('匯出失敗:' + (e.message || e), 'err');
    }
  }

  function handleImportFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onerror = function () { toast('讀取檔案失敗', 'err'); };
    reader.onload = function () {
      var incoming;
      try {
        incoming = JSON.parse(String(reader.result));
      } catch (e) {
        toast('這個檔案不是有效的 JSON:' + (e.message || e), 'err');
        return;
      }
      // 容許直接的陣列,或 { data: [...], lookup_notes: {...} } 這種包一層的格式。
      // lookup_notes 是個股查詢的螢光筆標色/筆記,舊版備份檔沒有這個欄位,
      // importedNotes 保持 null 代表「這份檔案沒提到」,匯入時不去動現有筆記。
      var importedNotes = null;
      if (!Array.isArray(incoming) && incoming && Array.isArray(incoming.data)) {
        importedNotes = incoming.lookup_notes || null;
        incoming = incoming.data;
      }
      if (!Array.isArray(incoming)) {
        toast('備份檔格式不正確:最外層必須是陣列', 'err');
        return;
      }
      var records = incoming.map(normalize);
      confirmImport(records, file.name, importedNotes);
    };
    reader.readAsText(file);
  }

  function confirmImport(records, filename, importedNotes) {
    dialog({
      title: '匯入備份',
      message: '檔案:' + filename + '\n' +
               '備份檔內有 ' + records.length + ' 筆,目前畫面上有 ' + data.length + ' 筆。\n\n' +
               '「覆蓋全部」會刪掉現有資料;「合併」會用相同 id 的備份內容取代現有的,其餘保留。\n' +
               '個股查詢的標色/筆記(如果這份備份檔有)也會照同樣方式處理。\n' +
               '兩種方式都會先把現有資料另存一份到瀏覽器,萬一按錯還救得回來。',
      actions: [
        { label: '合併(保留現有,更新同 id)', value: 'merge', cls: 'btn-primary' },
        { label: '覆蓋全部(刪掉現有 ' + data.length + ' 筆)', value: 'replace', cls: 'btn-danger' }
      ]
    }).then(function (res) {
      if (res.action !== 'merge' && res.action !== 'replace') return;

      // 動手前先把現況丟進另一個 key,當作後悔藥。
      try {
        window.localStorage.setItem(IMPORT_BACKUP_KEY, JSON.stringify(data));
      } catch (e) { /* 存不下就繼續,下面的匯入結果仍會回報 */ }

      if (res.action === 'replace') {
        data = records;
      } else {
        var byId = {};
        data.forEach(function (r) { byId[r.id] = r; });
        records.forEach(function (r) { byId[r.id] = r; });
        data = Object.keys(byId).map(function (k) { return byId[k]; });
      }

      if (importedNotes) {
        if (res.action === 'replace') {
          saveLookupNotesMap(importedNotes);
        } else {
          var mergedNotes = loadLookupNotesMap();
          Object.keys(importedNotes).forEach(function (k) { mergedNotes[k] = importedNotes[k]; });
          saveLookupNotesMap(mergedNotes);
        }
      }

      if (saveAll()) {
        toast('匯入成功,目前共 ' + data.length + ' 筆', 'ok', 4000);
      }
      closeDetail();
      renderList();
    });
  }

  // ---------------------------------------------------------- 爆量掃描

  var SCAN_URL = 'data/scan-latest.json';
  var scanLoaded = false;
  var scanData = null;

  function fmtInt(n) {
    return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function renderScan(res) {
    var meta = el('scan-meta');
    var tbody = el('scan-tbody');

    if (res.error) {
      meta.innerHTML = '<span class="warn">' + esc(res.error) + '</span>';
      tbody.innerHTML = '';
      el('scan-table').hidden = true;
      return;
    }

    el('scan-table').hidden = false;
    var p = res.params || {};
    meta.textContent = res.date + ' 收盤 · 掃描 ' + fmtInt(res.universe || 0) + ' 檔上市股票,' +
      '符合 ' + (res.count || 0) + ' 檔(' + (p.condition || '') + ')';

    if (!res.rows || !res.rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="scan-empty">當日沒有符合條件的股票</td></tr>';
      return;
    }

    tbody.innerHTML = res.rows.map(function (r) {
      var chg = r.change_pct;
      var chgCls = chg == null ? '' : (chg >= 0 ? 'up' : 'down');
      var chgTxt = chg == null ? '—' : (chg > 0 ? '+' : '') + chg.toFixed(2) + '%';
      var mg = marginOf(r.stock_id);
      var marginDelta = (mg && mg.margin_today != null && mg.margin_prev != null)
        ? mg.margin_today - mg.margin_prev : null;
      var hu = hunterOf(r.stock_id);
      var sig = hu && hu.signal;
      return '<tr>' +
        '<td class="code mono">' + esc(r.stock_id) + '</td>' +
        '<td>' + esc(r.stock_name || '') + '</td>' +
        '<td class="num ratio">' + Number(r.vol_ratio).toFixed(2) + '</td>' +
        '<td class="num ' + chgCls + '">' + chgTxt + '</td>' +
        '<td>' + (sig ? (sig + ' ' + esc(HUNTER_SIGNAL_LABELS[sig])) : '—') + '</td>' +
        '<td class="num mono">' + (mg && mg.margin_today != null ? fmtInt(mg.margin_today) : '—') + '</td>' +
        '<td class="num mono ' + plClass(marginDelta) + '">' +
          (marginDelta == null ? '—' : signed(marginDelta)) + '</td>' +
        '<td class="num mono">' + (mg && mg.short_today != null ? fmtInt(mg.short_today) : '—') + '</td>' +
        '<td>' + quickAddBtnHtml(r.stock_id, r.stock_name) + '</td>' +
      '</tr>';
    }).join('');
  }

  function loadScan(force) {
    // 融資融券、獵人訊號欄位跟掃描結果各自獨立抓取,晚到就補一次重繪,不擋主表先顯示
    loadRiskData().then(function () {
      if (scanData) renderScan(scanData);
    }).catch(function () { /* 表格已經有 — 佔位,不強求 */ });
    loadQuotes().then(function () {
      if (scanData) renderScan(scanData);
    }).catch(function () { /* 同上 */ });

    if (scanLoaded && !force) return;
    var meta = el('scan-meta');
    meta.textContent = '載入中…';

    // file:// 開啟時瀏覽器會擋掉本機 JSON 的讀取(CORS),這不是資料有問題。
    if (location.protocol === 'file:') {
      renderScan({ error: '用 file:// 直接開啟時,瀏覽器不允許讀取掃描結果檔。' +
                          '請用網址開啟(GitHub Pages),或在資料夾裡跑 python3 -m http.server。' });
      return;
    }

    fetch(SCAN_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        scanLoaded = true;
        scanData = data;
        renderScan(data);
      })
      .catch(function (e) {
        renderScan({ error: '讀不到掃描結果(' + (e.message || e) + ')。' +
                            '每日排程尚未跑過,或檔案還沒產生。' });
      });
  }

  // ---------------------------------------------------------- 暴跌掃描
  // 跟爆量掃描完全對稱(同一個 vol_ratio 門檻),差別只在 close < open。

  var CRASH_URL = 'data/crash-latest.json';
  var crashLoaded = false;
  var crashData = null;

  function renderCrash(res) {
    var meta = el('crash-meta');
    var tbody = el('crash-tbody');

    if (res.error) {
      meta.innerHTML = '<span class="warn">' + esc(res.error) + '</span>';
      tbody.innerHTML = '';
      el('crash-table').hidden = true;
      return;
    }

    el('crash-table').hidden = false;
    var p = res.params || {};
    meta.textContent = res.date + ' 收盤 · 掃描 ' + fmtInt(res.universe || 0) + ' 檔上市股票,' +
      '符合 ' + (res.count || 0) + ' 檔(' + (p.condition || '') + ')';

    if (!res.rows || !res.rows.length) {
      tbody.innerHTML = '<tr><td colspan="9" class="scan-empty">當日沒有符合條件的股票</td></tr>';
      return;
    }

    tbody.innerHTML = res.rows.map(function (r) {
      var chg = r.change_pct;
      var chgCls = chg == null ? '' : (chg >= 0 ? 'up' : 'down');
      var chgTxt = chg == null ? '—' : (chg > 0 ? '+' : '') + chg.toFixed(2) + '%';
      var mg = marginOf(r.stock_id);
      var marginDelta = (mg && mg.margin_today != null && mg.margin_prev != null)
        ? mg.margin_today - mg.margin_prev : null;
      var hu = hunterOf(r.stock_id);
      var sig = hu && hu.signal;
      return '<tr>' +
        '<td class="code mono">' + esc(r.stock_id) + '</td>' +
        '<td>' + esc(r.stock_name || '') + '</td>' +
        '<td class="num ratio">' + Number(r.vol_ratio).toFixed(2) + '</td>' +
        '<td class="num ' + chgCls + '">' + chgTxt + '</td>' +
        '<td>' + (sig ? (sig + ' ' + esc(HUNTER_SIGNAL_LABELS[sig])) : '—') + '</td>' +
        '<td class="num mono">' + (mg && mg.margin_today != null ? fmtInt(mg.margin_today) : '—') + '</td>' +
        '<td class="num mono ' + plClass(marginDelta) + '">' +
          (marginDelta == null ? '—' : signed(marginDelta)) + '</td>' +
        '<td class="num mono">' + (mg && mg.short_today != null ? fmtInt(mg.short_today) : '—') + '</td>' +
        '<td>' + quickAddBtnHtml(r.stock_id, r.stock_name) + '</td>' +
      '</tr>';
    }).join('');
  }

  function loadCrash(force) {
    loadRiskData().then(function () {
      if (crashData) renderCrash(crashData);
    }).catch(function () { /* 表格已經有 — 佔位,不強求 */ });
    loadQuotes().then(function () {
      if (crashData) renderCrash(crashData);
    }).catch(function () { /* 同上 */ });

    if (crashLoaded && !force) return;
    var meta = el('crash-meta');
    meta.textContent = '載入中…';

    if (location.protocol === 'file:') {
      renderCrash({ error: '用 file:// 直接開啟時,瀏覽器不允許讀取掃描結果檔。' +
                          '請用網址開啟(GitHub Pages),或在資料夾裡跑 python3 -m http.server。' });
      return;
    }

    fetch(CRASH_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        crashLoaded = true;
        crashData = data;
        renderCrash(data);
      })
      .catch(function (e) {
        renderCrash({ error: '讀不到掃描結果(' + (e.message || e) + ')。' +
                            '每日排程尚未跑過,或檔案還沒產生。' });
      });
  }

  // ---------------------------------------------------------- 題材分類
  //
  // 手動維護的靜態清單(data/themes.json),不是掃描/計分結果,沒有每日排程,
  // Hugo 自己判斷資料再請 Claude Code 加進檔案。每個題材是一組(<details>
  // 收合),組頭顯示今天觸發幾檔訊號,點開才看到全部成員 —— 訊號用的是
  // hunterOf()/爆量六訊號(跟「量價訊號」分頁同一套算法,涵蓋爆量、暴跌等
  // 六種情境,不是只有爆量掃描那種單一方向的條件)。

  var THEMES_URL = 'data/themes.json';
  var themesLoaded = false;

  function renderThemes(res, quotesOk) {
    var meta = el('themes-meta');
    var list = el('themes-list');

    if (res.error) {
      meta.innerHTML = '<span class="warn">' + esc(res.error) + '</span>';
      list.innerHTML = '';
      return;
    }

    var rows = (res.rows || res || []).slice();
    if (!rows.length) {
      meta.textContent = '共 0 檔';
      list.innerHTML = '<p class="dim">沒有資料</p>';
      return;
    }

    rows.forEach(function (r) {
      var hu = hunterOf(r.stock_code);
      r._sig = hu && hu.signal;
    });

    // 依題材分組(依 category 字串排序),組內觸發訊號的排前面,再依純度高到低
    var groups = {}, order = [];
    rows.forEach(function (r) {
      var c = r.category || '(未分類)';
      if (!groups[c]) { groups[c] = []; order.push(c); }
      groups[c].push(r);
    });
    // 純字串排序會把 "10." 排在 "2." 前面,題材編號要照數字大小排
    order.sort(function (a, b) {
      var na = parseInt(a, 10), nb = parseInt(b, 10);
      if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
      return a < b ? -1 : (a > b ? 1 : 0);
    });
    order.forEach(function (c) {
      groups[c].sort(function (a, b) {
        if (!!a._sig !== !!b._sig) return a._sig ? -1 : 1;
        return (Number(b.purity_rating) || 0) - (Number(a.purity_rating) || 0);
      });
    });

    var hitCategories = [];
    order.forEach(function (c) {
      var n = groups[c].filter(function (r) { return r._sig; }).length;
      if (n) hitCategories.push(c + '(' + n + ')');
    });

    meta.innerHTML = '共 ' + fmtInt(rows.length) + ' 檔、' + order.length + ' 個題材' +
      (quotesOk === false ? ' · <span class="warn">訊號資料讀不到,以下先看題材清單本身</span>'
        : hitCategories.length
          ? ' · <span class="up">今日觸發訊號:' + hitCategories.map(esc).join('、') + '</span>'
          : ' · 今天沒有題材成員觸發訊號');

    list.innerHTML = order.map(function (c) {
      var members = groups[c];
      var hitCount = members.filter(function (r) { return r._sig; }).length;

      var body = '<table class="scan-table"><thead><tr>' +
        '<th>代碼</th><th>名稱</th><th>市場別</th><th>受惠原因</th>' +
        '<th class="num">純度</th><th>今日訊號</th><th>追蹤</th>' +
        '</tr></thead><tbody>' +
        members.map(function (r) {
          var rating = Number(r.purity_rating);
          var stars = rating > 0 ? '★'.repeat(rating) + '☆'.repeat(Math.max(0, 5 - rating)) : '—';
          var sigTxt = r._sig ? (r._sig + ' ' + esc(HUNTER_SIGNAL_LABELS[r._sig])) : '—';
          return '<tr class="' + (r._sig ? 'is-hit' : '') + '">' +
            '<td class="code mono">' + esc(r.stock_code || '') + '</td>' +
            '<td>' + esc(r.company_name || '') + '</td>' +
            '<td>' + esc(r.market_type || '') + '</td>' +
            '<td>' + esc(r.benefit_reason || '') + '</td>' +
            '<td class="num mono">' + stars + '</td>' +
            '<td>' + sigTxt + '</td>' +
            '<td>' + quickAddBtnHtml(r.stock_code, r.company_name) + '</td>' +
          '</tr>';
        }).join('') +
        '</tbody></table>';

      return '<details class="theme-set">' +
        '<summary class="theme-set-head">' +
          '<span class="theme-set-title">' + esc(c) + '</span>' +
          '<span class="theme-set-badge' + (hitCount ? ' has-hit' : '') + '">' +
            (hitCount ? hitCount + ' 檔觸發訊號' : '無訊號') +
          '</span>' +
        '</summary>' +
        '<div class="theme-set-body table-scroll">' + body + '</div>' +
      '</details>';
    }).join('');
  }

  function loadThemes(force) {
    if (themesLoaded && !force) return;
    var meta = el('themes-meta');
    meta.textContent = '載入中…';

    if (location.protocol === 'file:') {
      renderThemes({ error: '用 file:// 直接開啟時,瀏覽器不允許讀取本機 JSON。' +
                            '請用網址開啟(GitHub Pages),或在資料夾裡跑 python3 -m http.server。' });
      return;
    }

    Promise.all([
      fetch(THEMES_URL, { cache: 'no-store' }).then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      }),
      loadQuotes().then(function () { return true; }).catch(function () { return false; })
    ])
      .then(function (results) {
        themesLoaded = true;
        renderThemes(results[0], results[1]);
      })
      .catch(function (e) {
        renderThemes({ error: '讀不到題材分類資料(' + (e.message || e) + ')。' });
      });
  }

  // ---------------------------------------------------------- 籌碼/風險

  var RISK_URL = 'data/risk-latest.json';
  var riskData = null;
  var riskDataPending = null;

  /**
   * 抓 data/risk-latest.json 並快取,跟 loadQuotes() 同一個模式。
   * 爆量掃描的融資融券欄位、追蹤詳情頁的融資融券區塊都吃這份快取,
   * 不用各自重抓一次。
   */
  function loadRiskData() {
    if (riskData) return Promise.resolve(riskData);
    if (riskDataPending) return riskDataPending;
    if (location.protocol === 'file:') {
      return Promise.reject(new Error('用 file:// 直接開啟時,瀏覽器不允許讀取本機 JSON。'));
    }
    riskDataPending = fetch(RISK_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        riskData = data;
        riskDataPending = null;
        return data;
      })
      .catch(function (e) {
        riskDataPending = null;
        throw e;
      });
    return riskDataPending;
  }

  /** 個股融資融券(TWSE MI_MARGN,只留上市普通股)。查不到回傳 null。*/
  function marginOf(code) {
    if (!riskData || !riskData.margin) return null;
    return riskData.margin[String(code || '').trim()] || null;
  }

  function tickSize(price) {
    if (price < 10) return 0.01;
    if (price < 50) return 0.05;
    if (price < 100) return 0.1;
    if (price < 500) return 0.5;
    if (price < 1000) return 1;
    return 5;
  }

  /**
   * 台股漲跌停價:昨收 ±10%,依「結果價位所在級距」的檔位捨入
   * (漲停無條件捨去、跌停無條件進位)。探測過 TWSE 官方的 TWT84U
   * 想直接拿旗標,但 Today/PreviousDay 兩組欄位跨日的對應關係沒辦法
   * 從單次探測完全驗證,改成自己算 —— 用 3518 的真實案例核對過:
   * 8/31 收盤 28.55 算出的漲停價 31.40,跟 9/1 實際收盤一致;9/2 收盤
   * 31.90 算出的漲停/跌停價 35.05 / 28.75,跟 TWT84U 官方數字也一致。
   */
  function limitUpPrice(prevClose) {
    var raw = prevClose * 1.1;
    var t = tickSize(raw);
    return Math.round(Math.floor(raw / t + 1e-9) * t * 100) / 100;
  }
  function limitDownPrice(prevClose) {
    var raw = prevClose * 0.9;
    var t = tickSize(raw);
    return Math.round(Math.ceil(raw / t - 1e-9) * t * 100) / 100;
  }

  // ---------------------------------------------------------- 獵人九宮格 + 爆量六訊號
  //
  // 兩層系統共用 quotes-latest.json 的 daily_close/daily_volume,純前端算,
  // 不落地成資料檔(跟上面漲跌停的做法一致)。
  //   ρ = MA5V/MA20V,兩者都含當日 —— 慢變量,九宮格用,描述中期量能趨勢
  //   S = 當日量/MA20V(不含當日)—— 快變量,六訊號用,跟爆量掃描的
  //       vol_ratio 是同一個公式,可以互相對照
  // day 是 quotes.days 的索引,0 = 最新一天,數字愈大愈舊。

  var HUNTER_DELTA = 0.01;    // δ,價的門檻(九宮格、六訊號共用)
  var HUNTER_EPS = 0.12;      // ε,九宮格量的門檻(spec 給 10~15%,先取中間,之後要調就改這裡)
  var HUNTER_DELTA2 = 0.05;   // δ',六訊號的暴漲/暴跌門檻
  var HUNTER_K = 1.5;         // k,六訊號的爆量門檻,跟爆量掃描的 vol_ratio 門檻同一個數字

  /** [start, start+count) 這段的平均,任何一格是 null 或超出範圍就回傳 null。*/
  function avgSlice(arr, start, count) {
    if (!arr || start < 0 || start + count > arr.length) return null;
    var sum = 0;
    for (var i = start; i < start + count; i++) {
      if (arr[i] == null) return null;
      sum += arr[i];
    }
    return sum / count;
  }

  /** ΔP:day 對 day+1 的單日報酬率。*/
  function hunterDeltaP(closeArr, day) {
    if (!closeArr || day + 1 >= closeArr.length) return null;
    var c = closeArr[day], p = closeArr[day + 1];
    if (c == null || !p) return null;
    return (c - p) / p;
  }

  /** ρ = MA5V/MA20V,兩者都含當日。*/
  function hunterRho(volArr, day) {
    var ma5 = avgSlice(volArr, day, 5);
    var ma20 = avgSlice(volArr, day, 20);
    if (ma5 == null || !ma20) return null;
    return ma5 / ma20;
  }

  /** S = 當日量 / MA20V(不含當日,day+1 ~ day+20)。*/
  function hunterS(volArr, day) {
    if (!volArr || day >= volArr.length || volArr[day] == null) return null;
    var ma20 = avgSlice(volArr, day + 1, 20);
    if (!ma20) return null;
    return volArr[day] / ma20;
  }

  var HUNTER_GRID_LABELS = {
    '漲增': '價量齊揚', '漲平': '價漲量平', '漲縮': '價漲量縮',
    '平增': '價平量增', '平平': '價平量平', '平縮': '價平量縮',
    '跌增': '價跌量增', '跌平': '價跌量平', '跌縮': '價跌量縮'
  };

  function hunterPriceState(dp) {
    if (dp > HUNTER_DELTA) return '漲';
    if (dp < -HUNTER_DELTA) return '跌';
    return '平';
  }
  function hunterVolState(rho) {
    if (rho > 1 + HUNTER_EPS) return '增';
    if (rho < 1 - HUNTER_EPS) return '縮';
    return '平';
  }

  /** 獵人九宮格分類,dp/rho 任一 null 就回傳 null。*/
  function hunterGrid(dp, rho) {
    if (dp == null || rho == null) return null;
    var p = hunterPriceState(dp), v = hunterVolState(rho);
    return { price: p, vol: v, label: HUNTER_GRID_LABELS[p + v] };
  }

  var HUNTER_SIGNAL_LABELS = {
    '①': '量價同步爆量(暴漲)', '②': '量增價不太動', '③': '量增暴跌',
    '④': '無量暴跌', '⑤': '量增溫和上漲', '⑥': '量增溫和下跌'
  };

  /**
   * 爆量六訊號分類。①②③⑤⑥ 在 S>HUNTER_K 母體內無縫覆蓋整個 ΔP 範圍,
   * ④ 來自 S<=HUNTER_K 母體,是唯一的無量情境;其餘無量情境回傳 null,
   * 留在九宮格框架裡處理(spec 明確講的已知未涵蓋範圍,不是漏寫)。
   */
  function hunterSignal(dp, s) {
    if (dp == null || s == null) return null;
    if (s > HUNTER_K) {
      if (dp > HUNTER_DELTA2) return '①';
      if (dp < -HUNTER_DELTA2) return '③';
      if (dp > HUNTER_DELTA) return '⑤';
      if (dp < -HUNTER_DELTA) return '⑥';
      return '②';
    }
    if (dp < -HUNTER_DELTA2) return '④';
    return null;
  }

  /** 給定代號的今日(day=0)獵人九宮格 + 六訊號。查不到回傳 null。*/
  function hunterOf(code) {
    if (!quotes || !quotesIdx) return null;
    var i = quotesIdx[String(code || '').trim()];
    if (i == null) return null;
    var dp = hunterDeltaP(quotes.daily_close[i], 0);
    var rho = hunterRho(quotes.daily_volume[i], 0);
    var s = hunterS(quotes.daily_volume[i], 0);
    return { dp: dp, rho: rho, s: s, grid: hunterGrid(dp, rho), signal: hunterSignal(dp, s) };
  }

  /** 今日鎖漲跌停清單,純前端算,只需要 quotes-latest.json,不用額外資料檔。*/
  function renderRiskLimitTable() {
    var tbody = el('risk-limit-tbody');
    var table = el('risk-limit-table');
    if (!quotes || !quotes.codes) { table.hidden = true; return; }

    var rows = [];
    for (var i = 0; i < quotes.codes.length; i++) {
      var close = quotes.close[i], prev = quotes.prev_close[i];
      if (!(close > 0) || !(prev > 0)) continue;
      var chg = (close - prev) / prev;
      if (close >= limitUpPrice(prev) - 0.001) {
        rows.push({ code: quotes.codes[i], name: quotes.names[i] || '', close: close, chg: chg, hit: 'up' });
      } else if (close <= limitDownPrice(prev) + 0.001) {
        rows.push({ code: quotes.codes[i], name: quotes.names[i] || '', close: close, chg: chg, hit: 'down' });
      }
    }
    rows.sort(function (a, b) { return b.chg - a.chg; });

    table.hidden = false;
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="scan-empty">今日沒有鎖漲跌停的股票</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function (r) {
      var cls = r.hit === 'up' ? 'up' : 'down';
      return '<tr>' +
        '<td class="code mono">' + esc(r.code) + '</td>' +
        '<td>' + esc(r.name) + '</td>' +
        '<td class="num mono">' + r.close + '</td>' +
        '<td class="num ' + cls + '">' + (r.chg >= 0 ? '+' : '') + (r.chg * 100).toFixed(2) + '%</td>' +
        '<td class="' + cls + '">' + (r.hit === 'up' ? '鎖漲停' : '鎖跌停') + '</td>' +
      '</tr>';
    }).join('');
  }

  function renderRisk(res) {
    var meta = el('risk-meta');

    if (res.error) {
      meta.innerHTML = '<span class="warn">' + esc(res.error) + '</span>';
      el('risk-market-panel').hidden = true;
      el('risk-attention-table').hidden = true;
      el('risk-margin-table').hidden = true;
      el('risk-short-table').hidden = true;
      el('risk-suspension-table').hidden = true;
      el('risk-exdiv-table').hidden = true;
      el('risk-attention-note').textContent = '';
      return;
    }

    meta.textContent = '資料日期 ' + (res.date || '—');

    var market = res.market || [];
    if (market.length) {
      el('risk-market-panel').hidden = false;
      var m0 = market[0], m1 = market[1];
      el('risk-market').innerHTML =
        '<div><span>日期</span><b>' + esc(m0.date) + '</b></div>' +
        '<div><span>加權指數</span><b>' + (m0.taiex == null ? '—' : m0.taiex.toFixed(2)) + '</b></div>' +
        '<div><span>漲跌</span><b class="' + plClass(m0.change) + '">' + signed(m0.change) + '</b></div>' +
        '<div><span>成交金額(億)</span><b>' +
          (m0.trade_value == null ? '—' : fmtInt(Math.round(m0.trade_value / 1e8))) + '</b></div>' +
        '<div><span>成交筆數</span><b>' + (m0.transaction == null ? '—' : fmtInt(m0.transaction)) + '</b></div>' +
        (m1 ? '<div><span>前一日指數</span><b>' + (m1.taiex == null ? '—' : m1.taiex.toFixed(2)) + '</b></div>' : '');
    } else {
      el('risk-market-panel').hidden = true;
    }

    var attention = res.attention || [];
    var attTable = el('risk-attention-table');
    if (attention.length) {
      attTable.hidden = false;
      el('risk-attention-note').textContent = '共 ' + attention.length + ' 檔';
      el('risk-attention-tbody').innerHTML = attention.map(function (a) {
        return '<tr>' +
          '<td class="code mono">' + esc(a.code) + '</td>' +
          '<td>' + esc(a.name || '') + '</td>' +
          '<td class="num mono">' + (a.closing_price == null ? '—' : a.closing_price) + '</td>' +
          '<td class="num mono">' + (a.pe == null ? '—' : a.pe) + '</td>' +
          '<td class="num mono">' + (a.notice_count == null ? '—' : fmtInt(a.notice_count)) + '</td>' +
          '<td>' + esc(a.reason || '') + '</td>' +
        '</tr>';
      }).join('');
    } else {
      attTable.hidden = true;
      el('risk-attention-note').textContent =
        '今日沒有公布注意股票,或 TWSE 還沒公布 —— 這個端點沒辦法分辨這兩種情況。';
    }

    var margin = res.margin || {};
    var marginRows = [];
    Object.keys(margin).forEach(function (code) {
      var v = margin[code];
      marginRows.push({
        code: code,
        name: v.name,
        margin_today: v.margin_today,
        margin_delta: (v.margin_today == null || v.margin_prev == null) ? null : v.margin_today - v.margin_prev,
        short_today: v.short_today,
        short_delta: (v.short_today == null || v.short_prev == null) ? null : v.short_today - v.short_prev
      });
    });
    var marginTop10 = marginRows.slice().sort(function (a, b) {
      return (b.margin_today || 0) - (a.margin_today || 0);
    }).slice(0, 10);
    var marginTable = el('risk-margin-table');
    if (marginTop10.length) {
      marginTable.hidden = false;
      el('risk-margin-tbody').innerHTML = marginTop10.map(function (r) {
        return '<tr>' +
          '<td class="code mono">' + esc(r.code) + '</td>' +
          '<td>' + esc(r.name || '') + '</td>' +
          '<td class="num mono">' + (r.margin_today == null ? '—' : fmtInt(r.margin_today)) + '</td>' +
          '<td class="num mono ' + plClass(r.margin_delta) + '">' +
            (r.margin_delta == null ? '—' : signed(r.margin_delta)) + '</td>' +
        '</tr>';
      }).join('');
    } else {
      marginTable.hidden = true;
    }

    var shortTop10 = marginRows.slice().sort(function (a, b) {
      return (b.short_today || 0) - (a.short_today || 0);
    }).slice(0, 10);
    var shortTable = el('risk-short-table');
    if (shortTop10.length) {
      shortTable.hidden = false;
      el('risk-short-tbody').innerHTML = shortTop10.map(function (r) {
        return '<tr>' +
          '<td class="code mono">' + esc(r.code) + '</td>' +
          '<td>' + esc(r.name || '') + '</td>' +
          '<td class="num mono">' + (r.short_today == null ? '—' : fmtInt(r.short_today)) + '</td>' +
          '<td class="num mono ' + plClass(r.short_delta) + '">' +
            (r.short_delta == null ? '—' : signed(r.short_delta)) + '</td>' +
        '</tr>';
      }).join('');
    } else {
      shortTable.hidden = true;
    }

    var susTable = el('risk-suspension-table');
    // 依起始日期從近到遠(ISO 字串本身就是可比較的字典序)
    var suspension = (res.suspension || []).slice().sort(function (a, b) {
      return (a.start || '').localeCompare(b.start || '');
    });
    if (suspension.length) {
      susTable.hidden = false;
      el('risk-suspension-tbody').innerHTML = suspension.map(function (s) {
        return '<tr>' +
          '<td class="code mono">' + esc(s.code) + '</td>' +
          '<td>' + esc(s.name || '') + '</td>' +
          '<td class="mono">' + esc(s.start || '—') + '</td>' +
          '<td class="mono">' + esc(s.end || '—') + '</td>' +
          '<td>' + esc(s.reason || '') + '</td>' +
        '</tr>';
      }).join('');
    } else {
      susTable.hidden = true;
    }

    var exdivTable = el('risk-exdiv-table');
    // 依現金股利由大到小,查不到股利的排最後
    var exdiv = (res.exdividend || []).slice().sort(function (a, b) {
      if (a.cash_dividend == null && b.cash_dividend == null) return 0;
      if (a.cash_dividend == null) return 1;
      if (b.cash_dividend == null) return -1;
      return b.cash_dividend - a.cash_dividend;
    });
    if (exdiv.length) {
      exdivTable.hidden = false;
      el('risk-exdiv-tbody').innerHTML = exdiv.map(function (x) {
        return '<tr>' +
          '<td class="code mono">' + esc(x.code) + '</td>' +
          '<td>' + esc(x.name || '') + '</td>' +
          '<td class="mono">' + esc(x.date || '—') + '</td>' +
          '<td>' + esc(x.kind || '') + '</td>' +
          '<td class="num mono">' + (x.cash_dividend == null ? '—' : x.cash_dividend) + '</td>' +
        '</tr>';
      }).join('');
    } else {
      exdivTable.hidden = true;
    }
  }

  // ---------------------------------------------------------- 大盤九宮格(籌碼/風險分頁)
  //
  // 跟個股獵人九宮格平行但獨立:ΔP_idx/ρ_idx 門檻、法人融資交叉、情緒溫度計、
  // 拉積盤 breadth_ratio 全部由後端 compute_market_grid.py 算好,前端只負責顯示,
  // 不像獵人九宮格需要前端現算(這裡沒有逐檔明細鑽取的需求,不用複算)。

  var MARKET_GRID_URL = 'data/market-grid-latest.json';
  var marketGridData = null;
  var marketGridPending = null;

  function loadMarketGrid() {
    if (marketGridData) return Promise.resolve(marketGridData);
    if (marketGridPending) return marketGridPending;
    if (location.protocol === 'file:') {
      return Promise.reject(new Error('用 file:// 直接開啟時,瀏覽器不允許讀取本機 JSON。'));
    }
    marketGridPending = fetch(MARKET_GRID_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        marketGridData = data;
        marketGridPending = null;
        return data;
      })
      .catch(function (e) {
        marketGridPending = null;
        throw e;
      });
    return marketGridPending;
  }

  var MARKET_PRICE_ROWS = ['漲', '平', '跌'];
  var MARKET_VOL_COLS = ['增', '平', '縮'];
  var MARKET_GRID_SHORT_LABELS = {
    '漲增': '資金行情啟動', '漲平': '指數漲量平', '漲縮': '指數漲量縮',
    '平增': '指數平量增', '平平': '指數平量平', '平縮': '指數平量縮',
    '跌增': '系統性賣壓', '跌平': '指數跌量平', '跌縮': '指數跌量縮'
  };

  function renderMarketGrid(res) {
    var panel = el('market-grid-panel');
    if (!res || res.error) { panel.hidden = true; return; }
    panel.hidden = false;

    var cells = '';
    MARKET_PRICE_ROWS.forEach(function (p) {
      MARKET_VOL_COLS.forEach(function (v) {
        var isCur = (p === res.price_state && v === res.volume_state);
        cells += '<div class="hunter-cell' + (isCur ? ' is-current' : '') + '">' +
          esc(MARKET_GRID_SHORT_LABELS[p + v]) + '</div>';
      });
    });
    el('market-grid-cells').innerHTML = cells;

    var sumHtml = '<div><span>今日位置</span><b>' + esc(res.grid_label || '資料不足') + '</b></div>';
    if (res.delta_p_idx != null) {
      sumHtml += '<div><span>ΔP_idx</span><b class="' + plClass(res.delta_p_idx) + '">' +
        (res.delta_p_idx >= 0 ? '+' : '') + (res.delta_p_idx * 100).toFixed(2) + '%</b></div>';
    }
    sumHtml += res.rho_idx != null
      ? '<div><span>ρ_idx</span><b>' + res.rho_idx.toFixed(2) + '</b></div>'
      : '<div><span>ρ_idx</span><b class="dim">資料不足(' + (res.turnover_days || 0) + '/20 天)</b></div>';
    if (res.idx_close != null) {
      sumHtml += '<div><span>加權指數</span><b>' + res.idx_close.toFixed(2) + '</b></div>';
    }
    el('market-grid-sum').innerHTML = sumHtml;

    var crossBox = el('market-cross-signal');
    if (res.cross_signal) {
      crossBox.hidden = false;
      crossBox.className = 'cross-box level-' + (res.cross_signal_level || 'watch');
      crossBox.innerHTML = '<div class="cross-title">法人 + 融資交叉分析(僅「量價齊揚」格顯示)</div>' +
        esc(res.cross_signal) +
        '<div class="dim" style="margin-top:4px;">法人買賣超(約)' +
          signed(Math.round((res.institutional_net || 0) / 1e4)) + ' 萬元 · 融資增減 ' +
          (res.margin_delta == null ? '—' : signed(res.margin_delta)) + '</div>';
    } else {
      crossBox.hidden = true;
    }

    var sentBox = el('market-sentiment');
    if (res.sentiment_ma5 != null && res.params) {
      sentBox.hidden = false;
      var lo = res.params.sentiment_low, hi = res.params.sentiment_high;
      var scaleMax = 1000;
      var pct = Math.max(0, Math.min(100, (res.sentiment_ma5 / scaleMax) * 100));
      var mood = res.sentiment_ma5 < lo ? '偏悲觀' : (res.sentiment_ma5 > hi ? '偏樂觀' : '中性');
      sentBox.innerHTML =
        '<div class="sentiment-head"><span>市場情緒溫度計 —— 上漲家數 5日均</span><span>' +
          Math.round(res.sentiment_ma5) + ' 家 · ' + mood + '</span></div>' +
        '<div class="sentiment-gauge"><div class="sentiment-marker" style="left:' + pct + '%"></div></div>' +
        '<div class="sentiment-ticks"><span>0</span><span>' + lo + '</span><span>' + hi + '</span><span>' + scaleMax + '</span></div>' +
        '<p class="dim" style="margin-top:6px;">跌破 ' + lo + ' 家偏悲觀、突破 ' + hi + ' 家偏樂觀,' +
          '門檻是舊經驗值,隨掛牌家數增加可能已不準,僅供參考。</p>';
    } else {
      sentBox.hidden = true;
    }

    var lajibanBox = el('market-lajiban');
    if (res.is_lajiban) {
      lajibanBox.hidden = false;
      var chg = res.delta_p_idx != null ? ((res.delta_p_idx >= 0 ? '+' : '') + (res.delta_p_idx * 100).toFixed(2) + '%') : '—';
      lajibanBox.innerHTML = '⚠ 拉積盤警訊:指數漲 ' + chg + ',但下跌家數 ' +
        fmtInt(res.declining_count) + ' 家 > 上漲家數 ' + fmtInt(res.advancing_count) +
        ' 家 —— 可能是少數權值股獨撐指數,並非全面性上漲。';
    } else {
      lajibanBox.hidden = true;
    }
  }

  // ---------------------------------------------------------- 匯率 / 期貨三大法人
  //
  // 央行匯率 + 台指期貨(TX)三大法人未平倉,獨立區塊,放在籌碼/風險分頁。
  // 一天更新一次,不是即時報價。

  var FX_FUTURES_URL = 'data/fx-futures-latest.json';
  var fxFuturesData = null;
  var fxFuturesPending = null;

  function loadFxFutures() {
    if (fxFuturesData) return Promise.resolve(fxFuturesData);
    if (fxFuturesPending) return fxFuturesPending;
    if (location.protocol === 'file:') {
      return Promise.reject(new Error('file:// 不能讀本機 JSON'));
    }
    fxFuturesPending = fetch(FX_FUTURES_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        fxFuturesData = data;
        fxFuturesPending = null;
        return data;
      })
      .catch(function (e) {
        fxFuturesPending = null;
        throw e;
      });
    return fxFuturesPending;
  }

  function renderFxFutures(res) {
    var panel = el('fx-futures-panel');
    var fx = res && res.fx;
    var fut = res && res.futures;
    if (!res || (!fx && !fut)) { panel.hidden = true; return; }
    panel.hidden = false;

    var html = '';
    if (fx && fx.rate != null) {
      var chg = (fx.prev_rate != null) ? fx.rate - fx.prev_rate : null;
      html += '<div><span>USD/TWD</span><b>' + fx.rate.toFixed(3) + '</b></div>' +
        '<div><span>較前一筆</span><b class="' + plClass(chg) + '">' +
          (chg == null ? '—' : (chg > 0 ? '+' : '') + chg.toFixed(3)) + '</b>' +
          '<span class="dim">' + esc(fx.date || '') + '</span></div>';
    }
    if (fut && fut.foreign_long_oi != null && fut.foreign_short_oi != null) {
      var net = fut.foreign_long_oi - fut.foreign_short_oi;
      html += '<div><span>外資多單未平倉(' + esc(fut.futures_id || '') + ')</span><b class="mono">' +
          fmtInt(fut.foreign_long_oi) + '</b></div>' +
        '<div><span>外資空單未平倉</span><b class="mono">' + fmtInt(fut.foreign_short_oi) + '</b></div>' +
        '<div><span>外資淨部位</span><b class="' + plClass(net) + '">' +
          (net > 0 ? '+' : '') + fmtInt(net) + '</b>' +
          '<span class="dim">' + (net < 0 ? '淨空單' : (net > 0 ? '淨多單' : '')) +
          ' · ' + esc(fut.date || '') + '</span></div>';
    }
    el('fx-futures-sum').innerHTML = html;
  }

  function loadRisk(force) {
    loadQuotes().then(renderRiskLimitTable).catch(function () {
      el('risk-limit-table').hidden = true;
    });

    if (force) marketGridData = null;
    loadMarketGrid()
      .then(function (data) { renderMarketGrid(data); })
      .catch(function () { el('market-grid-panel').hidden = true; });

    if (force) fxFuturesData = null;
    loadFxFutures()
      .then(function (data) { renderFxFutures(data); })
      .catch(function () { el('fx-futures-panel').hidden = true; });

    if (force) riskData = null;
    if (riskData) { renderRisk(riskData); return; }
    var meta = el('risk-meta');
    meta.textContent = '載入中…';

    loadRiskData()
      .then(function (data) { renderRisk(data); })
      .catch(function (e) {
        renderRisk({ error: '讀不到籌碼/風險資料(' + (e.message || e) + ')。' +
                            '每日排程尚未跑過,或檔案還沒產生。' });
      });
  }

  // ---------------------------------------------------------- 量價訊號(六訊號全市場篩選)

  // 由多頭到空頭排,方便從上面往下看
  var HUNTER_SIGNAL_ORDER = ['①', '⑤', '②', '⑥', '③', '④'];

  function renderSignals(errMsg) {
    var meta = el('signals-meta');
    var table = el('signals-table');
    var tbody = el('signals-tbody');

    if (errMsg) {
      meta.innerHTML = '<span class="warn">' + esc(errMsg) + '</span>';
      table.hidden = true;
      return;
    }
    if (!quotes || !quotes.codes) {
      meta.textContent = '載入中…';
      table.hidden = true;
      return;
    }

    var rows = [];
    for (var i = 0; i < quotes.codes.length; i++) {
      var dp = hunterDeltaP(quotes.daily_close[i], 0);
      var s = hunterS(quotes.daily_volume[i], 0);
      var sig = hunterSignal(dp, s);
      if (!sig) continue;
      rows.push({
        code: quotes.codes[i], name: quotes.names[i] || '',
        close: quotes.close[i], dp: dp, s: s, sig: sig
      });
    }

    table.hidden = false;
    meta.textContent = quotes.date + ' 收盤 · 掃描 ' + fmtInt(quotes.codes.length) +
      ' 檔上市股票,觸發 ' + fmtInt(rows.length) + ' 檔';

    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="scan-empty">今天沒有股票觸發任何訊號</td></tr>';
      return;
    }

    rows.sort(function (a, b) {
      var ia = HUNTER_SIGNAL_ORDER.indexOf(a.sig), ib = HUNTER_SIGNAL_ORDER.indexOf(b.sig);
      if (ia !== ib) return ia - ib;
      return b.dp - a.dp;
    });

    tbody.innerHTML = rows.map(function (r) {
      return '<tr>' +
        '<td class="code mono">' + esc(r.code) + '</td>' +
        '<td>' + esc(r.name) + '</td>' +
        '<td class="num mono">' + r.close + '</td>' +
        '<td class="num ' + plClass(r.dp) + '">' +
          (r.dp >= 0 ? '+' : '') + (r.dp * 100).toFixed(2) + '%</td>' +
        '<td class="num mono">' + r.s.toFixed(2) + '</td>' +
        '<td title="' + esc(HUNTER_SIGNAL_LABELS[r.sig]) + '">' + r.sig + ' ' +
          esc(HUNTER_SIGNAL_LABELS[r.sig]) + '</td>' +
        '<td>' + quickAddBtnHtml(r.code, r.name) + '</td>' +
      '</tr>';
    }).join('');
  }

  function loadSignals(force) {
    if (force) quotes = null;
    if (quotes) { renderSignals(); return; }
    renderSignals();   // 顯示「載入中…」
    loadQuotes()
      .then(function () { renderSignals(); })
      .catch(function (e) {
        renderSignals('讀不到報價資料(' + (e.message || e) + ')。每日排程尚未跑過,或檔案還沒產生。');
      });
  }

  // ---------------------------------------------------------- 個股查詢
  // 手動維護的代號清單(stock_lookup.json),沒有後端沒辦法即時查任意一檔。
  // 開高低收量沿用 data/history,融資融券/外資投信來自 FinMind,
  // 見 scripts/fetch_stock_lookup.py。

  // 兩個分頁(FOMO個股查詢 / 爆量個股查詢)共用同一套邏輯,靠 createLookupPanel()
  // 用閉包各自持有 loaded/data/code/openDate 等狀態,差別只在 id 前綴跟資料來源網址。

  function lookupNum(v, digits) {
    if (v == null) return '—';
    return digits == null ? fmtInt(Math.round(v)) : v.toFixed(digits);
  }

  // 量、外資/投信買賣超原始資料是「股」(data/stock-lookup-latest.json 不動),
  // 這裡只轉換顯示——1 張 = 1,000 股。融資融券欄位本來就是張,不用轉。
  function lookupLots(v) {
    if (v == null) return '—';
    return fmtInt((v / 1000).toFixed(1));
  }

  function lookupSignedLots(v) {
    if (v == null) return '—';
    var lots = v / 1000;
    return (lots > 0 ? '+' : lots < 0 ? '-' : '') + fmtInt(Math.abs(lots).toFixed(1));
  }

  // ------------------------------------------- 個股查詢的螢光筆標色 + 文字筆記
  // 存在 localStorage,不是排程產出的資料(那份每天會被覆寫)。
  // key 用「代號|日期」,表格視窗往前滑動、舊日期滑出去之後筆記自然看不到,
  // 跟資料本身的行為一致,不需要額外清理。

  var LOOKUP_NOTES_KEY = 'stock_pipeline_lookup_notes';
  var LOOKUP_COLORS = ['yellow', 'red', 'green', 'purple'];

  function lookupNoteKey(code, date) { return code + '|' + date; }

  function loadLookupNotesMap() {
    try {
      var raw = window.localStorage.getItem(LOOKUP_NOTES_KEY);
      var obj = raw ? JSON.parse(raw) : null;
      return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function saveLookupNotesMap(map) {
    try {
      window.localStorage.setItem(LOOKUP_NOTES_KEY, JSON.stringify(map));
      return true;
    } catch (e) {
      toast('筆記存不進瀏覽器儲存空間:' + (e.message || e), 'err');
      return false;
    }
  }

  function setLookupColor(code, date, color) {
    var map = loadLookupNotesMap();
    var key = lookupNoteKey(code, date);
    var entry = map[key] || {};
    if (color) entry.color = color; else delete entry.color;
    if (entry.color || entry.note) map[key] = entry; else delete map[key];
    saveLookupNotesMap(map);
  }

  function setLookupNote(code, date, note) {
    var map = loadLookupNotesMap();
    var key = lookupNoteKey(code, date);
    var entry = map[key] || {};
    note = (note || '').trim();
    if (note) entry.note = note; else delete entry.note;
    if (entry.color || entry.note) map[key] = entry; else delete map[key];
    if (saveLookupNotesMap(map)) toast('已儲存筆記', 'ok');
  }

  // ------------------------------------------- 個股查詢的欄/列暫時隱藏
  // 跟螢光筆標色一樣存在 localStorage,但這是「暫時不看」的檢視偏好,不是資料,
  // 所以不放進「匯出」備份 —— 換一台瀏覽器或清快取,表格會自然恢復全部顯示。
  // 每個分頁(id 前綴)各自存一份,互不影響 —— createLookupPanel() 裡用。

  var LOOKUP_COL_COUNT = 13;

  function loadLookupHiddenMap(key) {
    try {
      var raw = window.localStorage.getItem(key);
      var obj = raw ? JSON.parse(raw) : null;
      return (obj && typeof obj === 'object' && !Array.isArray(obj)) ? obj : {};
    } catch (e) {
      return {};
    }
  }

  function saveLookupHiddenMap(key, map, label) {
    try {
      window.localStorage.setItem(key, JSON.stringify(map));
    } catch (e) {
      toast(label + '存不進瀏覽器儲存空間:' + (e.message || e), 'err');
    }
  }

  // ------------------------------------------- 個股查詢的「量縮轉買」參考標記
  // 討論脈絡(2313):使用者自己手算的方法是「量縮至少 10 天,題材一到位
  // 就會往上一波」——不是等單日觸發,是先確認蹲了夠久的量縮,再等進場的
  // 那一天。8/12~8/25(10 個交易日)裡有 8 天量縮,8/26 外資投信同步
  // 轉買、量能放大,就是這個方法抓到的真實案例。純前端算,吃這台表格
  // 既有的 volume/foreign_net/trust_net,不用新資料源。
  //
  // 「量縮」的基準是近期高點(trailing 10 天內最高量),不是滾動均量——
  // 實測過滾動均量(MA5/10/15/20)當基準,2313 這段量縮完全測不出來
  // (均量本身會跟著量縮一起往下掉,比值不會低到門檻以下)。改跟近期高點比
  // 才量得出「跟爆量的高點比,縮了多少」這種直覺感受。
  //
  // 條件(照使用者手算的方法定案,2026-09-08 從 5 天窗口改成 10 天):
  //   1. 觸發日前 10 個交易日裡,至少 8 天「量/近期高點(前10天)」< 0.6
  //   2. 觸發日當天外資、投信買賣超同步 > 0
  //   3. 觸發日量能 ≥ 那 10 天窗口均量的 1.2 倍
  // 原本窗口只抓 5 天、門檻 3 天,套 2313 資料會多抓到一個 8/20 的假訊號
  // (符合條件但隔天就被外資翻臉倒貨)。改成 10 天窗口、8 天門檻之後
  // 8/20 自然被濾掉、只剩 8/26 這一天——不是額外加「隔天不能反轉」的
  // 過濾規則,是窗口拉長到跟使用者手算的方法一致之後自然的結果。
  //
  // ⚠️ 只有 2313 這一次樣本驗證過,沒有回測,純參考,跟 fomo_score.py 的
  // 真跌/虛跌一樣不是驗證過的訊號。
  //
  // 「量縮」單獨也是一個標記(2026-09-08 加入):不等轉買訊號成立,
  // 只要當天量 / 近期高點 < 門檻就標,讓使用者自己盯著量縮期間、自己判斷
  // 什麼時候要進場,不是只有轉買那天才看得到量縮訊號。這個門檻(0.3)
  // 跟轉買邏輯用來算「窗口裡幾天量縮」的門檻(0.6)是兩個獨立常數,不要
  // 合併——對 FOMO+暴跌FOMO 隨機 20 檔批次測試過,0.6 當單日標記命中率
  // 高達 64%(244/380 格),太吵,所以單日顯示標記另外收緊到 0.3
  // (命中率降到 27%);轉買邏輯的 0.6 不能動,動了會讓 8/26 那個訊號消失。
  var LOOKUP_BREAKOUT_PEAK_WINDOW = 10;   // 近期高點抓前幾個交易日
  var LOOKUP_BREAKOUT_LOOKBACK = 10;      // 轉買觸發日往前看幾天判斷量縮(= 使用者手算的「至少10天」)
  var LOOKUP_BREAKOUT_MIN_SHRINK = 8;     // 這幾天裡至少要有幾天量縮,才算轉買觸發
  var LOOKUP_BREAKOUT_SHRINK_RATIO = 0.6; // 轉買訊號用的量縮門檻,不要動(動了 8/26 會消失)
  var LOOKUP_SHRINK_DISPLAY_RATIO = 0.3;  // 🔽量縮單日標記用的門檻,比轉買門檻嚴格
  var LOOKUP_BREAKOUT_SURGE_MULT = 1.2;   // 轉買觸發日量能要比窗口均量高這個倍數以上

  // 「有效振幅」過濾(2026-09-08 加入):使用者盯著批次測試結果發現,
  // 21 檔裡只有 2313/4576/6168/2409/3006 這幾隻「量縮的時候價錢還是有
  // 真正在動」,其餘量縮的股票其實是死盤(整段期間每日高低差距都壓在
  // 1~2% 左右,根本沒有價格發現)。試過「振幅逐漸收窄」(K 線實體變短)
  // 對不上 2313 自己的資料(8/12~8/25 振幅是 2.63%→6.60%→4.18%→...
  // 上下跳動,不是單調收斂);改用「窗口內平均日振幅」才對得上——
  // 使用者點名的 5 檔量縮窗口平均振幅都在 3.6% 以上,「死盤」那幾檔
  // (1325/2102/9902/1441 等)都在 1.1~1.7% 之間,中間有清楚的落差。
  var LOOKUP_MIN_RANGE_PCT = 3.5;   // 窗口內平均日振幅((高-低)/收盤×100)至少要這麼多%

  function lookupAvgRangePct(rowsAsc, lo, hi) {
    var sum = 0, n = 0;
    for (var i = lo; i < hi; i++) {
      var r = rowsAsc[i];
      if (r.high == null || r.low == null || !r.close) continue;
      sum += (r.high - r.low) / r.close * 100;
      n++;
    }
    return n ? sum / n : null;
  }

  function lookupVolRatios(rowsAsc) {
    // 每天的量 / 近期高點(前 LOOKUP_BREAKOUT_PEAK_WINDOW 個交易日內最高量),
    // 基準不足或缺量的日子回傳 null。轉買訊號跟量縮訊號共用同一份比值,
    // 避免兩邊各算一次卻走不同定義。
    var vols = rowsAsc.map(function (r) { return r.volume; });
    return vols.map(function (v, i) {
      var from = i - LOOKUP_BREAKOUT_PEAK_WINDOW;
      if (from < 0 || v == null) return null;
      var peak = null;
      for (var k = from; k < i; k++) {
        if (vols[k] == null) return null;
        if (peak == null || vols[k] > peak) peak = vols[k];
      }
      return peak ? v / peak : null;
    });
  }

  function computeLookupShrinkDays(rowsAsc) {
    // 2026-09-08 加「有效振幅」門檻(跟 🔔量縮轉買/🕐蓄勢觀察名單同一套邏輯):
    // 只看量縮比值會把「量縮但死盤」的股票也標出來,使用者盯著三個分頁發現
    // 這種標記沒有意義——量縮期間振幅太窄(< 3.5%)代表根本沒有價格發現,
    // 不值得提醒「這天值得多看一眼」。窗口用跟量縮比值同一份(前 10 天,
    // 不含當天,跟 lookupVolRatios() 的「近期高點」基準窗口一致)。
    var ratios = lookupVolRatios(rowsAsc);
    var out = {};
    ratios.forEach(function (ratio, i) {
      if (ratio == null || ratio >= LOOKUP_SHRINK_DISPLAY_RATIO) return;
      var lo = i - LOOKUP_BREAKOUT_PEAK_WINDOW;
      var avgRange = lookupAvgRangePct(rowsAsc, lo, i);
      if (avgRange == null || avgRange < LOOKUP_MIN_RANGE_PCT) return;
      out[rowsAsc[i].date] = { ratio: ratio, peakWindow: LOOKUP_BREAKOUT_PEAK_WINDOW, avgRangePct: avgRange };
    });
    return out;
  }

  function computeLookupBreakouts(rowsAsc) {
    var vols = rowsAsc.map(function (r) { return r.volume; });
    var ratios = lookupVolRatios(rowsAsc);
    var out = {};

    for (var i = LOOKUP_BREAKOUT_LOOKBACK; i < rowsAsc.length; i++) {
      var lo = i - LOOKUP_BREAKOUT_LOOKBACK;
      var shrinkCount = 0;
      var windowVols = [];
      var ok = true;
      for (var j = lo; j < i; j++) {
        if (ratios[j] == null) { ok = false; break; }
        windowVols.push(vols[j]);
        if (ratios[j] < LOOKUP_BREAKOUT_SHRINK_RATIO) shrinkCount++;
      }
      if (!ok || shrinkCount < LOOKUP_BREAKOUT_MIN_SHRINK) continue;

      var avgRange = lookupAvgRangePct(rowsAsc, lo, i);
      if (avgRange == null || avgRange < LOOKUP_MIN_RANGE_PCT) continue;

      var r = rowsAsc[i];
      if (!(r.foreign_net > 0 && r.trust_net > 0) || vols[i] == null) continue;

      var avgWindow = windowVols.reduce(function (a, b) { return a + b; }, 0) / windowVols.length;
      if (!avgWindow) continue;
      var surgeMult = vols[i] / avgWindow;
      if (surgeMult < LOOKUP_BREAKOUT_SURGE_MULT) continue;

      out[r.date] = {
        shrinkCount: shrinkCount, lookback: LOOKUP_BREAKOUT_LOOKBACK,
        surgeMult: surgeMult, avgRangePct: avgRange
      };
    }
    return out;
  }

  // 「目前是不是蹲在量縮蓄勢裡,還沒等到轉買」(2026-09-08 加入)。
  // 用跟 computeLookupBreakouts 完全一樣的窗口/門檻,只是不要求「今天」
  // 有外資投信同步買超+量增——只看「最新一天之前的 10 個交易日裡,
  // 量縮天數夠不夠、振幅夠不夠」,回答「這檔現在算不算蹲好了,可以開始
  // 盯進場」。
  function computeLookupShrinkZone(rowsAsc) {
    var ratios = lookupVolRatios(rowsAsc);
    var i = rowsAsc.length - 1;
    if (i < LOOKUP_BREAKOUT_LOOKBACK) return null;

    var lo = i - LOOKUP_BREAKOUT_LOOKBACK;
    var shrinkCount = 0;
    for (var j = lo; j < i; j++) {
      if (ratios[j] == null) return null;
      if (ratios[j] < LOOKUP_BREAKOUT_SHRINK_RATIO) shrinkCount++;
    }
    if (shrinkCount < LOOKUP_BREAKOUT_MIN_SHRINK) return null;

    var avgRange = lookupAvgRangePct(rowsAsc, lo, i);
    if (avgRange == null || avgRange < LOOKUP_MIN_RANGE_PCT) return null;

    return {
      date: rowsAsc[i].date,
      shrinkCount: shrinkCount,
      lookback: LOOKUP_BREAKOUT_LOOKBACK,
      avgRangePct: avgRange,
      alreadyTriggered: !!(rowsAsc[i].foreign_net > 0 && rowsAsc[i].trust_net > 0)
    };
  }

  // 外資出貨下殺標記(2026-09-08 加入,跟量縮/量縮轉買同一批,純前端)。
  // 討論脈絡:2313 7/30 當天跌 6.95%、外資賣超。跟 7/29 對照才看得出重點
  // 不是「賣超金額大小」——7/29 也跌得很重(-6.30%)但外資是買超(接刀),
  // 7/30 外資賣超金額(-202 萬)其實是抓到的三天裡最小的一筆,不是賣最多。
  // 所以規則只看方向(當天賣超)配大跌幅,不設賣超金額門檻。
  var LOOKUP_SELLOFF_DROP_PCT = -4;   // 跌幅門檻(%),(close-open)/open 要低於這個值

  function computeLookupSelloffDays(rowsAsc) {
    var out = {};
    rowsAsc.forEach(function (r) {
      if (r.open == null || r.close == null || r.foreign_net == null) return;
      if (r.foreign_net >= 0) return;
      var chgPct = (r.close - r.open) / r.open * 100;
      if (chgPct <= LOOKUP_SELLOFF_DROP_PCT) {
        out[r.date] = { chgPct: chgPct, foreignNet: r.foreign_net };
      }
    });
    return out;
  }

  // 連續增溫標記(2026-09-09 加入)。討論脈絡:6657(華安)9/9 噴出漲停附近
  // 之前,🔔量縮轉買、🕐蓄勢觀察名單都沒抓到——量縮天數(6/8)、窗口平均
  // 振幅(2.65%/3.5%)都差一點沒到門檻,而且這檔投信買賣超 30 天全是 0,
  // 🔔要求的「外資投信同步買超」永遠不會成立(不是門檻問題,是這檔投信
  // 根本不交易)。但回頭看量比序列,9/7(1.59)、9/8(1.62)已經連續
  // 兩天站上近期高點、外資也連續兩天買超,是很明顯的「量能連續墊高」——
  // 只是不符合「先蹲後爆」的假設。
  //
  // 這個標記刻意跟🔔量縮轉買獨立、互補,不要求先有安靜期,只看外資
  // (不看投信,解決上面那個「投信不交易的股票永遠篩不到」的問題)。
  // 用同一份 lookupVolRatios()(量 / 前 10 天最高量),不必再定義一套
  // 新的基準線。
  var LOOKUP_WARMING_STREAK_DAYS = 2;   // 連續幾天才算「增溫」
  var LOOKUP_WARMING_RATIO_MIN = 1.0;   // 量比門檻:當天量 >= 前10天最高量

  function computeLookupWarmingDays(rowsAsc) {
    var ratios = lookupVolRatios(rowsAsc);
    var out = {};
    var streak = 0;
    rowsAsc.forEach(function (r, i) {
      var ok = ratios[i] != null && ratios[i] >= LOOKUP_WARMING_RATIO_MIN && r.foreign_net > 0;
      streak = ok ? streak + 1 : 0;
      if (streak >= LOOKUP_WARMING_STREAK_DAYS) {
        out[r.date] = { streak: streak, ratio: ratios[i], foreignNet: r.foreign_net };
      }
    });
    return out;
  }

  // 低活躍度過濾(2026-09-09 加入):跟量縮/轉買那套「參考標記」不一樣,
  // 這條是直接把日子從表格裡拿掉,不進 badge 判斷、不進「顯示已隱藏」
  // 那套使用者手動隱藏的機制——單純是資料太薄(當天外資幾乎沒動作、
  // 成交量也小),沒什麼好看的。三個分頁共用同一組門檻。
  // 用「且」不是「或」:量縮期間本來成交量就會小,只有外資也幾乎沒進出的
  // 那幾天才算真的沒訊號可看;任一邊有量,還是留著讓使用者自己判斷。
  var LOOKUP_LOW_ACTIVITY_VOLUME_LOTS = 300;   // 當天成交量(張)低於這個值
  var LOOKUP_LOW_ACTIVITY_FOREIGN_LOTS = 100;  // 當天外資買賣超絕對值(張)低於這個值

  // 2026-09-09 改:資料缺漏(null)當低活躍度算,不是「不濾」。原本
  // 想避免把「FinMind 抓不到資料」誤判成「沒活動」而直接放行,結果
  // 1441(大東)因為 8/21、9/4 外資買賣超剛好是 null,兩天被排除在
  // 低活躍度判斷之外,導致「整檔 30 天都低活躍度」永遠不成立,即使
  // 其餘 28 天全部都是每天量不到 40 張的極薄股票也照樣留在清單裡。
  // 缺漏的那一項當它符合低活躍度(用另一項還有值的欄位正常判斷),
  // 兩項都缺才整天都算低活躍度。
  function lookupIsLowActivity(r) {
    var volLots = r.volume != null ? r.volume / 1000 : null;
    var foreignLots = r.foreign_net != null ? Math.abs(r.foreign_net) / 1000 : null;
    var volLow = volLots == null || volLots < LOOKUP_LOW_ACTIVITY_VOLUME_LOTS;
    var foreignLow = foreignLots == null || foreignLots < LOOKUP_LOW_ACTIVITY_FOREIGN_LOTS;
    return volLow && foreignLow;
  }

  // 整檔都沒有任何參考標記(2026-09-09 加入)。討論脈絡:暴跌FOMO個股查詢
  // 的 2062(橋椿)雖然沒被低活躍度濾掉(量還算夠),但 30 天裡🔽/🔔/🕐
  // 四個都沒觸發過——查了資料才發現:振幅一直在 0.8~2.6%(離 3.5% 門檻
  // 遠),投信買賣超每天都是 0(FinMind 完全沒抓到這檔的投信交易紀錄),
  // 單日跌幅最重也只有 -0.78%(離 🔻的 -4% 門檻遠)。股價太平穩、投信沒
  // 在交易,四個標記天生都踩不到,留著也是白算 badge。這種股票直接從
  // 下拉選單移除,判定用「整段歷史一次都沒觸發過」,不是看目前這一天。
  function lookupHasAnySignal(rec) {
    var rows = rec.rows || [];
    if (Object.keys(computeLookupBreakouts(rows)).length) return true;
    if (Object.keys(computeLookupShrinkDays(rows)).length) return true;
    if (Object.keys(computeLookupSelloffDays(rows)).length) return true;
    if (Object.keys(computeLookupWarmingDays(rows)).length) return true;
    var zone = computeLookupShrinkZone(rows);
    if (zone && !zone.alreadyTriggered) return true;
    return false;
  }

  // 個股查詢分頁工廠:idPrefix 決定 DOM id('lookup' / 'lookup-scan'),
  // url 是各自的資料來源。標色/筆記(loadLookupNotesMap 那組)是照「代號|日期」存,
  // 兩個分頁共用同一份沒關係——講的是同一檔股票。欄/列隱藏偏好各自存一份
  // (localStorage key 用 idPrefix 隔開),互不影響。
  function createLookupPanel(idPrefix, url) {
    var hiddenColsKey = 'stock_pipeline_' + idPrefix.replace(/-/g, '_') + '_hidden_cols';
    var hiddenRowsKey = 'stock_pipeline_' + idPrefix.replace(/-/g, '_') + '_hidden_rows';

    var loaded = false;
    var data = null;
    var code = null;
    var openDate = null;        // 目前展開中的筆記編輯列(日期字串)
    var showHiddenRows = false; // 展開已隱藏列的檢視開關,切換代號時重置,不落地儲存
    var hiddenCols = loadLookupHiddenMap(hiddenColsKey);   // { colIndex: true },這個分頁所有代號共用
    var hiddenRows = loadLookupHiddenMap(hiddenRowsKey);   // { "代號|日期": true }

    function visibleColCount() {
      var n = LOOKUP_COL_COUNT;
      for (var k in hiddenCols) { if (hiddenCols[k]) n--; }
      return n;
    }

    function toggleCol(idx) {
      if (idx === 0) return;   // 日期欄是列的身分識別,不給隱藏
      if (hiddenCols[idx]) delete hiddenCols[idx]; else hiddenCols[idx] = true;
      saveLookupHiddenMap(hiddenColsKey, hiddenCols, '欄位顯示設定');
      render();
    }

    function resetHiddenCols() {
      hiddenCols = {};
      saveLookupHiddenMap(hiddenColsKey, hiddenCols, '欄位顯示設定');
      render();
    }

    function isRowHidden(date) {
      return !!hiddenRows[lookupNoteKey(code, date)];
    }

    function setRowHidden(c, date, hidden) {
      var key = lookupNoteKey(c, date);
      if (hidden) hiddenRows[key] = true; else delete hiddenRows[key];
      saveLookupHiddenMap(hiddenRowsKey, hiddenRows, '列顯示設定');
    }

    function colHiddenAttr(idx) { return hiddenCols[idx] ? ' hidden' : ''; }

    function applyColVisibility(table) {
      Array.prototype.forEach.call(table.querySelectorAll('th[data-col]'), function (th) {
        th.hidden = !!hiddenCols[th.getAttribute('data-col')];
      });
      var hiddenCount = LOOKUP_COL_COUNT - visibleColCount();
      var resetBtn = el(idPrefix + '-cols-reset');
      resetBtn.hidden = hiddenCount <= 0;
      if (hiddenCount > 0) resetBtn.textContent = '顯示已隱藏 ' + hiddenCount + ' 欄';
    }

    function updateRowHint(hiddenCount) {
      var toggleBtn = el(idPrefix + '-rows-toggle');
      toggleBtn.hidden = hiddenCount <= 0;
      if (hiddenCount > 0) {
        toggleBtn.textContent = (showHiddenRows ? '收起已隱藏 ' : '顯示已隱藏 ') + hiddenCount + ' 列';
      }
    }

    function editorHtml(c, date, entry) {
      var swatches = LOOKUP_COLORS.map(function (col) {
        return '<button type="button" class="lookup-swatch swatch-' + col +
          (entry.color === col ? ' is-active' : '') + '" data-lookup-color="' + col + '"></button>';
      }).join('') +
        '<button type="button" class="lookup-swatch swatch-clear" data-lookup-color="">✕</button>';

      return '<tr class="lookup-editor-row"><td colspan="' + visibleColCount() + '"><div class="lookup-editor">' +
        '<div class="lookup-editor-head">' + esc(date) + ' 標色與筆記</div>' +
        '<div class="lookup-swatches">' + swatches + '</div>' +
        '<label class="field"><span class="field-label">筆記</span>' +
          '<textarea id="' + idPrefix + '-note-input" rows="3" placeholder="例如:融資單日暴增,疑似作帳">' +
            esc(entry.note || '') + '</textarea></label>' +
        '<button type="button" class="btn btn-block btn-outline" id="' + idPrefix + '-note-save">儲存筆記</button>' +
      '</div></td></tr>';
    }

    function render() {
      var meta = el(idPrefix + '-meta');
      var controls = el(idPrefix + '-controls');
      var select = el(idPrefix + '-select');
      var table = el(idPrefix + '-table');
      var tbody = el(idPrefix + '-tbody');

      if (!data || data.error) {
        meta.innerHTML = data && data.error
          ? '<span class="warn">' + esc(data.error) + '</span>' : '載入中…';
        controls.hidden = true;
        table.hidden = true;
        return;
      }

      var codes = data.codes || [];
      var fetchedCodes = codes.filter(function (c) { return data.data && data.data[c]; });

      if (!fetchedCodes.length) {
        meta.innerHTML = '<span class="warn">查詢清單裡的代號都抓不到資料,' +
          '看 failures 欄位或排程 log。</span>';
        controls.hidden = true;
        table.hidden = true;
        return;
      }

      // 整檔全部交易日都低活躍度(每天都外資<100張且量<300張)就直接從
      // 下拉選單移除,不是只濾掉那幾天——這種股票留著也沒東西可看。
      var activeCodes = fetchedCodes.filter(function (c) {
        var rows = data.data[c].rows || [];
        return rows.some(function (r) { return !lookupIsLowActivity(r); });
      });
      var deadCodeCount = fetchedCodes.length - activeCodes.length;

      // 有活躍度但 30 天裡🔽/🔔/🔻/🕐 一個都沒觸發過,一樣沒東西好看,
      // 也從下拉選單移除(2026-09-09 加,見 lookupHasAnySignal 註解)。
      var okCodes = activeCodes.filter(function (c) {
        return lookupHasAnySignal(data.data[c]);
      });
      var noSignalCount = activeCodes.length - okCodes.length;

      if (!okCodes.length) {
        meta.innerHTML = '<span class="warn">查詢清單裡的代號整檔都是低活躍度或完全沒觸發過任何標記,' +
          '已全部濾掉。</span>';
        controls.hidden = true;
        table.hidden = true;
        return;
      }

      if (!code || !data.data[code] || okCodes.indexOf(code) === -1) code = okCodes[0];

      controls.hidden = false;
      select.innerHTML = okCodes.map(function (c) {
        var name = data.data[c].stock_name || '';
        return '<option value="' + esc(c) + '"' + (c === code ? ' selected' : '') + '>' +
          esc(c) + ' ' + esc(name) + '</option>';
      }).join('');

      var range = data.history_range || {};
      var failNote = (data.failures || []).length
        ? '、抓失敗 ' + data.failures.length + ' 檔' : '';
      var deadCodeNote = deadCodeCount > 0
        ? '、整檔低活躍度濾掉 ' + deadCodeCount + ' 檔' : '';
      var noSignalNote = noSignalCount > 0
        ? '、整檔無標記濾掉 ' + noSignalCount + ' 檔' : '';

      applyColVisibility(table);

      var rec = data.data[code];
      var breakoutMap = computeLookupBreakouts(rec.rows || []);
      var shrinkMap = computeLookupShrinkDays(rec.rows || []);
      var selloffMap = computeLookupSelloffDays(rec.rows || []);
      var warmingMap = computeLookupWarmingDays(rec.rows || []);
      var shrinkZone = computeLookupShrinkZone(rec.rows || []);

      var zoneNote = '';
      if (shrinkZone && !shrinkZone.alreadyTriggered) {
        zoneNote = '  ·  🕐 目前蹲在量縮蓄勢中(近' + shrinkZone.lookback + '天有' +
          shrinkZone.shrinkCount + '天量縮,平均日振幅 ' + shrinkZone.avgRangePct.toFixed(1) +
          '%),還沒等到轉買訊號';
      }
      var allRows = (rec.rows || []).slice().reverse();   // 最新的日期排最上面
      var rawRowCount = allRows.length;
      allRows = allRows.filter(function (r) { return !lookupIsLowActivity(r); });
      var lowActivityCount = rawRowCount - allRows.length;
      var lowActivityNote = lowActivityCount > 0
        ? '  ·  已濾掉 ' + lowActivityCount + ' 天低活躍度(外資買賣超 < ' +
          LOOKUP_LOW_ACTIVITY_FOREIGN_LOTS + ' 張且成交量 < ' + LOOKUP_LOW_ACTIVITY_VOLUME_LOTS + ' 張)'
        : '';
      meta.textContent = '資料範圍 ' + (range.from || '?') + ' ~ ' + (range.to || '?') +
        '(' + okCodes.length + ' 檔可查' + failNote + deadCodeNote + noSignalNote + ')' + zoneNote + lowActivityNote;

      table.hidden = false;
      if (!allRows.length) {
        tbody.innerHTML = '<tr><td colspan="' + visibleColCount() + '" class="scan-empty">沒有資料</td></tr>';
        updateRowHint(0);
        return;
      }

      var notesMap = loadLookupNotesMap();
      var hiddenRowCount = 0;
      var rows = [];
      allRows.forEach(function (r) {
        var isHidden = isRowHidden(r.date);
        if (isHidden) hiddenRowCount++;
        if (!isHidden || showHiddenRows) rows.push(r);
      });
      updateRowHint(hiddenRowCount);

      tbody.innerHTML = rows.map(function (r) {
        var rowKey = lookupNoteKey(code, r.date);
        var entry = notesMap[rowKey] || {};
        var isHidden = isRowHidden(r.date);
        var hlCls = entry.color ? ' hl-' + entry.color : '';
        var hiddenCls = isHidden ? ' is-hidden-row' : '';
        var noteCell = entry.note
          ? esc(entry.note.length > 24 ? entry.note.slice(0, 24) + '…' : entry.note)
          : '<span class="dim">＋</span>';
        var hideBtn = '<button type="button" class="lookup-hide-btn" data-hide-date="' + esc(r.date) +
          '" title="' + (isHidden ? '取消隱藏此列' : '暫時隱藏此列') + '">' +
          (isHidden ? '👁' : '🙈') + '</button>';
        var breakout = breakoutMap[r.date];
        var breakoutBadge = breakout
          ? ' <span class="lookup-breakout-badge" title="近' + breakout.lookback + '天有' +
            breakout.shrinkCount + '天量縮(&lt;近期高點 60%,平均日振幅 ' +
            breakout.avgRangePct.toFixed(1) + '%),當天外資投信同步買超,量能放大' +
            breakout.surgeMult.toFixed(2) + ' 倍(參考用,只驗證過一次樣本,沒有回測)">' +
            '🔔量縮轉買</span>'
          : '';
        var shrink = shrinkMap[r.date];
        var shrinkBadge = shrink
          ? ' <span class="lookup-shrink-badge" title="量 / 近期高點(前' + shrink.peakWindow +
            '天內最高量)= ' + (shrink.ratio * 100).toFixed(0) +
            '%,前' + shrink.peakWindow + '天平均日振幅 ' + shrink.avgRangePct.toFixed(1) +
            '%(排除量縮但沒在動的死盤),量縮中(參考用,不代表接下來會轉買)">🔽量縮</span>'
          : '';
        var selloff = selloffMap[r.date];
        var selloffBadge = selloff
          ? ' <span class="lookup-selloff-badge" title="當天跌幅 ' + selloff.chgPct.toFixed(2) +
            '%,外資賣超 ' + lookupLots(Math.abs(selloff.foreignNet)) +
            ' 張(參考用,只看方向不看賣超金額大小,只驗證過一次樣本,沒有回測)">🔻外資出貨</span>'
          : '';
        var warming = warmingMap[r.date];
        var warmingBadge = warming
          ? ' <span class="lookup-warming-badge" title="連續 ' + warming.streak +
            ' 天量創近期新高(量/前10天最高量 = ' + (warming.ratio * 100).toFixed(0) +
            '%)且外資同步買超,不要求先蹲量,跟🔔量縮轉買是獨立的兩套邏輯' +
            '(參考用,只驗證過一次樣本,沒有回測)">🔥連續增溫</span>'
          : '';
        var row = '<tr class="lookup-row' + hlCls + hiddenCls + '" data-lookup-date="' + esc(r.date) + '">' +
          '<td class="mono">' + esc(r.date) + breakoutBadge + shrinkBadge + selloffBadge + warmingBadge + '</td>' +
          '<td' + colHiddenAttr(1) + ' class="num mono">' + lookupNum(r.open, 2) + '</td>' +
          '<td' + colHiddenAttr(2) + ' class="num mono">' + lookupNum(r.high, 2) + '</td>' +
          '<td' + colHiddenAttr(3) + ' class="num mono">' + lookupNum(r.low, 2) + '</td>' +
          '<td' + colHiddenAttr(4) + ' class="num mono">' + lookupNum(r.close, 2) + '</td>' +
          '<td' + colHiddenAttr(5) + ' class="num mono">' + lookupLots(r.volume) + '</td>' +
          '<td' + colHiddenAttr(6) + ' class="num mono">' + lookupNum(r.margin_balance) + '</td>' +
          '<td' + colHiddenAttr(7) + ' class="num mono ' + plClass(r.margin_change) + '">' +
            (r.margin_change == null ? '—' : signed(r.margin_change)) + '</td>' +
          '<td' + colHiddenAttr(8) + ' class="num mono">' + lookupNum(r.short_balance) + '</td>' +
          '<td' + colHiddenAttr(9) + ' class="num mono ' + plClass(r.short_change) + '">' +
            (r.short_change == null ? '—' : signed(r.short_change)) + '</td>' +
          '<td' + colHiddenAttr(10) + ' class="num mono ' + plClass(r.foreign_net) + '">' +
            (r.foreign_net == null ? '—' : lookupSignedLots(r.foreign_net)) + '</td>' +
          '<td' + colHiddenAttr(11) + ' class="num mono ' + plClass(r.trust_net) + '">' +
            (r.trust_net == null ? '—' : lookupSignedLots(r.trust_net)) + '</td>' +
          '<td' + colHiddenAttr(12) + ' class="lookup-note-cell">' + hideBtn + noteCell + '</td>' +
        '</tr>';
        if (openDate === r.date) row += editorHtml(code, r.date, entry);
        return row;
      }).join('');
    }

    function load(force) {
      if (loaded && !force) return;
      el(idPrefix + '-meta').textContent = '載入中…';

      if (location.protocol === 'file:') {
        data = { error: '用 file:// 直接開啟時,瀏覽器不允許讀取本機 JSON。' +
                        '請用網址開啟(GitHub Pages),或在資料夾裡跑 python3 -m http.server。' };
        render();
        return;
      }

      fetch(url, { cache: 'no-store' })
        .then(function (r) {
          if (!r.ok) throw new Error('HTTP ' + r.status);
          return r.json();
        })
        .then(function (json) {
          loaded = true;
          data = json;
          render();
        })
        .catch(function (e) {
          data = { error: '讀不到查詢結果(' + (e.message || e) + ')。' +
                          '每日排程尚未跑過,或清單還沒加代號。' };
          render();
        });
    }

    return {
      idPrefix: idPrefix,
      load: load,
      render: render,
      toggleCol: toggleCol,
      resetHiddenCols: resetHiddenCols,
      setRowHidden: setRowHidden,
      isRowHidden: isRowHidden,
      getCode: function () { return code; },
      setCode: function (c) { code = c; },
      getOpenDate: function () { return openDate; },
      setOpenDate: function (d) { openDate = d; },
      resetShowHiddenRows: function () { showHiddenRows = false; },
      toggleShowHiddenRows: function () { showHiddenRows = !showHiddenRows; }
    };
  }

  var lookupPanel = createLookupPanel('lookup', 'data/stock-lookup-latest.json');
  var lookupScanPanel = createLookupPanel('lookup-scan', 'data/stock-lookup-scan-latest.json');
  var lookupCrashFomoPanel = createLookupPanel('lookup-crashfomo', 'data/stock-lookup-crashfomo-latest.json');

  function bindLookupPanelEvents(panel) {
    var prefix = panel.idPrefix;

    el(prefix + '-select').addEventListener('change', function (e) {
      panel.setCode(e.target.value);
      panel.setOpenDate(null);
      panel.resetShowHiddenRows();
      panel.render();
    });

    el(prefix + '-table').addEventListener('click', function (e) {
      var th = e.target.closest('th[data-col]');
      if (!th) return;
      panel.toggleCol(parseInt(th.getAttribute('data-col'), 10));
    });

    el(prefix + '-cols-reset').addEventListener('click', function () {
      panel.resetHiddenCols();
    });

    el(prefix + '-rows-toggle').addEventListener('click', function () {
      panel.toggleShowHiddenRows();
      panel.render();
    });

    el(prefix + '-tbody').addEventListener('click', function (e) {
      var hideBtn = e.target.closest('.lookup-hide-btn');
      if (hideBtn) {
        var hideDate = hideBtn.getAttribute('data-hide-date');
        var wasHidden = panel.isRowHidden(hideDate);
        panel.setRowHidden(panel.getCode(), hideDate, !wasHidden);
        panel.render();
        return;
      }
      var swatch = e.target.closest('.lookup-swatch');
      if (swatch) {
        setLookupColor(panel.getCode(), panel.getOpenDate(), swatch.getAttribute('data-lookup-color') || null);
        panel.render();
        return;
      }
      if (e.target.closest('#' + prefix + '-note-save')) {
        setLookupNote(panel.getCode(), panel.getOpenDate(), el(prefix + '-note-input').value);
        panel.render();
        return;
      }
      if (e.target.closest('.lookup-editor')) return;   // 點編輯區其他地方(textarea 等)不要觸發收合
      var tr = e.target.closest('.lookup-row');
      if (!tr) return;
      var date = tr.getAttribute('data-lookup-date');
      panel.setOpenDate(panel.getOpenDate() === date ? null : date);
      panel.render();
    });
  }

  function switchView(v) {
    el('track-wrap').hidden = v !== 'track';
    el('tabs').hidden = v !== 'track';
    el('scan-wrap').hidden = v !== 'scan';
    el('crash-wrap').hidden = v !== 'crash';
    el('fomo-wrap').hidden = v !== 'fomo';
    el('crashfomo-wrap').hidden = v !== 'crashfomo';
    el('tick-wrap').hidden = v !== 'tick';
    el('kelly-wrap').hidden = v !== 'kelly';
    el('themes-wrap').hidden = v !== 'themes';
    el('risk-wrap').hidden = v !== 'risk';
    el('signals-wrap').hidden = v !== 'signals';
    el('lookup-wrap').hidden = v !== 'lookup';
    el('lookup-scan-wrap').hidden = v !== 'lookup-scan';
    el('lookup-crashfomo-wrap').hidden = v !== 'lookup-crashfomo';
    Array.prototype.forEach.call(el('views').children, function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-view') === v);
    });
    if (v === 'scan') loadScan(false);
    if (v === 'crash') loadCrash(false);
    if (v === 'fomo') loadFomo(false);
    if (v === 'crashfomo') loadCrashFomo(false);
    if (v === 'tick') loadTick(false);
    if (v === 'kelly') loadKelly();
    if (v === 'themes') loadThemes(false);
    if (v === 'risk') loadRisk(false);
    if (v === 'signals') loadSignals(false);
    if (v === 'lookup') lookupPanel.load(false);
    if (v === 'lookup-scan') lookupScanPanel.load(false);
    if (v === 'lookup-crashfomo') lookupCrashFomoPanel.load(false);
  }

  // ---------------------------------------------------------- 左右滑動切換分頁

  var VIEWS_ORDER = ['track', 'scan', 'crash', 'fomo', 'crashfomo', 'tick', 'kelly', 'themes', 'risk', 'signals', 'lookup', 'lookup-scan', 'lookup-crashfomo'];

  function currentViewName() {
    var active = el('views').querySelector('.viewbtn.is-active');
    return active ? active.getAttribute('data-view') : VIEWS_ORDER[0];
  }

  /**
   * 手指起點沿著祖先往上找,只要有任何一層「往滑動方向還能捲」的水平捲軸
   * (產業流向的交叉表、持倉紀錄表格…),就讓瀏覽器自己處理,不搶手勢。
   * dx > 0 是手指往右移(內容要往回捲),dx < 0 是手指往左移(內容要往前捲)。
   */
  function ancestorCanScrollX(node, dx) {
    while (node && node !== document.body) {
      if (node.scrollWidth > node.clientWidth + 1) {
        var atLeft = node.scrollLeft <= 0;
        var atRight = node.scrollLeft + node.clientWidth >= node.scrollWidth - 1;
        if ((dx > 0 && !atLeft) || (dx < 0 && !atRight)) return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  function bindSwipe() {
    var startX = null, startY = null, target = null, tracking = false, blocked = false;
    var THRESHOLD = 60;         // 至少要滑這麼多 px 才算數,單純點擊不誤觸
    var DIR_RATIO = 1.5;        // 水平位移要明顯大於垂直位移,才不會跟捲動打架

    document.addEventListener('touchstart', function (e) {
      if (e.touches.length !== 1 || !el('modal').hidden) { tracking = false; return; }
      var tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') { tracking = false; return; }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      target = e.target;
      tracking = true;
      blocked = false;
    }, { passive: true });

    document.addEventListener('touchmove', function (e) {
      if (!tracking || blocked) return;
      var dx = e.touches[0].clientX - startX;
      var dy = e.touches[0].clientY - startY;
      if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return;
      if (Math.abs(dy) > Math.abs(dx) || ancestorCanScrollX(target, dx)) blocked = true;
    }, { passive: true });

    document.addEventListener('touchend', function (e) {
      if (!tracking || blocked) { tracking = false; return; }
      tracking = false;
      var dx = e.changedTouches[0].clientX - startX;
      var dy = e.changedTouches[0].clientY - startY;
      if (Math.abs(dx) < THRESHOLD || Math.abs(dx) < Math.abs(dy) * DIR_RATIO) return;
      var idx = VIEWS_ORDER.indexOf(currentViewName());
      if (idx < 0) return;
      if (dx < 0 && idx < VIEWS_ORDER.length - 1) switchView(VIEWS_ORDER[idx + 1]);
      else if (dx > 0 && idx > 0) switchView(VIEWS_ORDER[idx - 1]);
    }, { passive: true });
  }

  // ---------------------------------------------------------- FOMO 掃描

  var FOMO_URL = 'data/fomo-latest.json';
  var fomoLoaded = false;
  var fomoOpen = null;          // 目前展開理由的股票代碼

  function scoreClass(n) {
    if (n >= 60) return 'fomo-score-hi';
    if (n >= 30) return 'fomo-score-mid';
    return 'fomo-score-lo';
  }

  function badges(r) {
    var out = '';
    if (r.is_real_rally) out += '<span class="badge badge-real">真漲</span>';
    if (r.is_fake_rally) out += '<span class="badge badge-fake">虛漲</span>';
    if (r.is_divergence) out += '<span class="badge badge-diverge">背離</span>';
    if (!out) out = '<span class="badge badge-none">—</span>';
    return out;
  }

  /** 加入追蹤時,第 1 步「觸發」預設帶入 FOMO 的判定結果,不用再手動打一次。*/
  function fomoTriggerNote(r) {
    var tags = [];
    if (r.is_real_rally) tags.push('真漲');
    if (r.is_fake_rally) tags.push('虛漲');
    if (r.is_divergence) tags.push('背離');
    return 'FOMO(' + r.fomo_score + ' 分):' + (tags.length ? tags.join('+') : '無明顯真漲/虛漲訊號');
  }

  function reasonList(title, arr) {
    if (!arr || !arr.length) {
      return '<h4>' + esc(title) + '</h4><div class="none">無</div>';
    }
    return '<h4>' + esc(title) + '</h4><ul>' +
      arr.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
  }

  function fomoDetailHtml(r) {
    var m = r.metrics || {};
    var facts = [];
    if (m.vol_ratio != null) facts.push('量比 ' + m.vol_ratio);
    if (m.pbr != null) facts.push('PBR ' + m.pbr);
    if (m.margin_change_5d_pct != null) facts.push('融資5日 ' + m.margin_change_5d_pct + '%');
    if (m.short_margin_ratio != null) facts.push('券資比 ' + m.short_margin_ratio + '%');
    if (m.foreign_consecutive_buy_days != null) facts.push('外資連買 ' + m.foreign_consecutive_buy_days + ' 天');

    var notes = '';
    if (r.foreign_note) {
      notes += '<div class="note note-foreign">' + esc(r.foreign_note) + '</div>';
    }
    if (r.trust_note) {
      notes += '<div class="note note-trust">' + esc(r.trust_note) + '</div>';
    }
    if (r.is_divergence && r.divergence_reason) {
      notes += '<div class="note note-diverge">' + esc(r.divergence_reason) + '</div>';
    }

    return '<tr class="fomo-detail"><td colspan="5">' +
      notes +
      (facts.length ? '<div>' + esc(facts.join('　·　')) + '</div>' : '') +
      reasonList('FOMO 依據(' + r.fomo_score + ' 分)', r.reasons.fomo) +
      reasonList('真漲依據(' + r.real_rally_score + ' 分)', r.reasons.real_rally) +
      reasonList('虛漲依據(' + r.fake_rally_score + ' 分)', r.reasons.fake_rally) +
      (r.missing && r.missing.length
        ? '<h4>缺少資料</h4><div class="none">' + esc(r.missing.join('、')) + '</div>'
        : '') +
      '</td></tr>';
  }

  function renderFomo(res) {
    var meta = el('fomo-meta');
    var tbody = el('fomo-tbody');

    if (res.error) {
      meta.innerHTML = '<span class="warn">' + esc(res.error) + '</span>';
      tbody.innerHTML = '';
      el('fomo-table').hidden = true;
      return;
    }
    el('fomo-table').hidden = false;

    var real = 0, fake = 0;
    res.rows.forEach(function (r) {
      if (r.is_real_rally) real++;
      if (r.is_fake_rally) fake++;
    });
    var src = res.source_list === 'watchlist' ? '手動名單' : '爆量前段班';
    meta.textContent = res.date + ' · ' + src + ' ' + res.scored_count + ' 檔' +
      ' · 真漲 ' + real + ' 檔 · 虛漲 ' + fake + ' 檔(點列可看理由)';

    if (!res.rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="scan-empty">沒有資料</td></tr>';
      return;
    }

    tbody.innerHTML = res.rows.map(function (r) {
      var row = '<tr class="fomo-row" data-fomo="' + esc(r.stock_id) + '">' +
        '<td class="code mono">' + esc(r.stock_id) + '</td>' +
        '<td>' + esc(r.stock_name || '') + '</td>' +
        '<td class="num ' + scoreClass(r.fomo_score) + '">' + r.fomo_score + '</td>' +
        '<td>' + badges(r) + '</td>' +
        '<td>' + quickAddBtnHtml(r.stock_id, r.stock_name, fomoTriggerNote(r)) + '</td>' +
      '</tr>';
      if (fomoOpen === r.stock_id) row += fomoDetailHtml(r);
      return row;
    }).join('');
  }

  var fomoData = null;

  function loadFomo(force) {
    if (fomoLoaded && !force) return;
    el('fomo-meta').textContent = '載入中…';

    if (location.protocol === 'file:') {
      renderFomo({ error: '用 file:// 直接開啟時,瀏覽器不允許讀取本機 JSON。' +
                          '請用網址開啟(GitHub Pages),或在資料夾裡跑 python3 -m http.server。' });
      return;
    }

    fetch(FOMO_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        fomoLoaded = true;
        fomoData = data;
        renderFomo(data);
      })
      .catch(function (e) {
        renderFomo({ error: '讀不到 FOMO 結果(' + (e.message || e) + ')。' +
                            '每日排程尚未跑過,或檔案還沒產生。' });
      });
  }

  // ---------------------------------------------------------- 暴跌 FOMO
  // FOMO 掃描的鏡射:真跌/虛跌取代真漲/虛漲。顏色跟 FOMO 相反 ——
  // 真跌(會續跌)用危險色(badge-crash-real),虛跌(可能是抄底機會)用安全色。

  var CRASH_FOMO_URL = 'data/crash-fomo-latest.json';
  var crashFomoLoaded = false;
  var crashFomoOpen = null;
  var crashFomoData = null;

  function crashBadges(r) {
    var out = '';
    if (r.is_real_crash) out += '<span class="badge badge-crash-real">真跌</span>';
    if (r.is_fake_crash) out += '<span class="badge badge-crash-fake">虛跌</span>';
    if (r.is_divergence) out += '<span class="badge badge-diverge">背離</span>';
    if (!out) out = '<span class="badge badge-none">—</span>';
    return out;
  }

  /** 加入追蹤時,第 1 步「觸發」預設帶入暴跌 FOMO 的判定結果。*/
  function crashFomoTriggerNote(r) {
    var tags = [];
    if (r.is_real_crash) tags.push('真跌');
    if (r.is_fake_crash) tags.push('虛跌');
    if (r.is_divergence) tags.push('背離');
    return '暴跌FOMO(' + r.crash_score + ' 分):' + (tags.length ? tags.join('+') : '無明顯真跌/虛跌訊號');
  }

  function crashFomoDetailHtml(r) {
    var m = r.metrics || {};
    var facts = [];
    if (m.vol_ratio != null) facts.push('量比 ' + m.vol_ratio);
    if (m.pbr != null) facts.push('PBR ' + m.pbr);
    if (m.margin_change_5d_pct != null) facts.push('融資5日 ' + m.margin_change_5d_pct + '%');
    if (m.short_margin_ratio != null) facts.push('券資比 ' + m.short_margin_ratio + '%');
    if (m.foreign_consecutive_sell_days != null) facts.push('外資連賣 ' + m.foreign_consecutive_sell_days + ' 天');

    var notes = '';
    if (r.foreign_note) {
      notes += '<div class="note note-foreign">' + esc(r.foreign_note) + '</div>';
    }
    if (r.trust_note) {
      notes += '<div class="note note-trust">' + esc(r.trust_note) + '</div>';
    }
    if (r.is_divergence && r.divergence_reason) {
      notes += '<div class="note note-diverge">' + esc(r.divergence_reason) + '</div>';
    }

    return '<tr class="fomo-detail"><td colspan="5">' +
      notes +
      (facts.length ? '<div>' + esc(facts.join('　·　')) + '</div>' : '') +
      reasonList('真跌依據(' + r.real_crash_score + ' 分)', r.reasons.real_crash) +
      reasonList('虛跌依據(' + r.fake_crash_score + ' 分)', r.reasons.fake_crash) +
      (r.missing && r.missing.length
        ? '<h4>缺少資料</h4><div class="none">' + esc(r.missing.join('、')) + '</div>'
        : '') +
      '</td></tr>';
  }

  function renderCrashFomo(res) {
    var meta = el('crashfomo-meta');
    var tbody = el('crashfomo-tbody');

    if (res.error) {
      meta.innerHTML = '<span class="warn">' + esc(res.error) + '</span>';
      tbody.innerHTML = '';
      el('crashfomo-table').hidden = true;
      return;
    }
    el('crashfomo-table').hidden = false;

    var real = 0, fake = 0;
    res.rows.forEach(function (r) {
      if (r.is_real_crash) real++;
      if (r.is_fake_crash) fake++;
    });
    var src = res.source_list === 'watchlist' ? '手動名單' : '暴跌前段班';
    meta.textContent = res.date + ' · ' + src + ' ' + res.scored_count + ' 檔' +
      ' · 真跌 ' + real + ' 檔 · 虛跌 ' + fake + ' 檔(點列可看理由)';

    if (!res.rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="scan-empty">沒有資料</td></tr>';
      return;
    }

    tbody.innerHTML = res.rows.map(function (r) {
      var row = '<tr class="fomo-row" data-fomo="' + esc(r.stock_id) + '">' +
        '<td class="code mono">' + esc(r.stock_id) + '</td>' +
        '<td>' + esc(r.stock_name || '') + '</td>' +
        '<td class="num ' + scoreClass(r.crash_score) + '">' + r.crash_score + '</td>' +
        '<td>' + crashBadges(r) + '</td>' +
        '<td>' + quickAddBtnHtml(r.stock_id, r.stock_name, crashFomoTriggerNote(r)) + '</td>' +
      '</tr>';
      if (crashFomoOpen === r.stock_id) row += crashFomoDetailHtml(r);
      return row;
    }).join('');
  }

  function loadCrashFomo(force) {
    if (crashFomoLoaded && !force) return;
    el('crashfomo-meta').textContent = '載入中…';

    if (location.protocol === 'file:') {
      renderCrashFomo({ error: '用 file:// 直接開啟時,瀏覽器不允許讀取本機 JSON。' +
                          '請用網址開啟(GitHub Pages),或在資料夾裡跑 python3 -m http.server。' });
      return;
    }

    fetch(CRASH_FOMO_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        crashFomoLoaded = true;
        crashFomoData = data;
        renderCrashFomo(data);
      })
      .catch(function (e) {
        renderCrashFomo({ error: '讀不到暴跌 FOMO 結果(' + (e.message || e) + ')。' +
                            '每日排程尚未跑過,或檔案還沒產生。' });
      });
  }

  // ------------------------------------------- 產業/市值 Tick 聚合(8012)

  // 這四支跟 scripts/tick_indicators.py 是同一組公式的 JS 版。
  // 後端只把「當天那一格」算好寫進 JSON,個股逐日明細要在前端現算,
  // 所以這裡必須有一份 —— 兩邊會不會走鐘,由 tickSelfCheck() 每次載入時比對。
  var TICK_DISPLAY_DAYS = 30;

  function tiFixed(vals, w) {
    var out = [], i;
    for (i = 0; i < TICK_DISPLAY_DAYS; i++) out.push(null);
    if (w - 1 >= vals.length) return out;
    var base = vals[w - 1];
    if (base === null || base === undefined || base === 0) return out;
    for (i = 0; i < Math.min(w, TICK_DISPLAY_DAYS); i++) {
      var v = i < vals.length ? vals[i] : null;
      out[i] = (v === null || v === undefined) ? null : v / base;
    }
    return out;
  }

  function tiRolling(vals, w) {
    var out = [], i;
    for (i = 0; i < TICK_DISPLAY_DAYS; i++) out.push(null);
    for (i = 0; i < Math.min(w, TICK_DISPLAY_DAYS); i++) {
      if (i >= vals.length || i + w >= vals.length) continue;
      var v = vals[i], base = vals[i + w];
      if (v !== null && v !== undefined &&
          base !== null && base !== undefined && base !== 0) {
        out[i] = v / base;
      }
    }
    return out;
  }

  function tiD0D1(vals) {
    var out = [], i;
    for (i = 0; i < TICK_DISPLAY_DAYS; i++) out.push(null);
    for (i = 0; i < Math.min(vals.length, TICK_DISPLAY_DAYS); i++) {
      if (i + 1 >= vals.length) continue;
      var v = vals[i], prev = vals[i + 1];
      if (v !== null && v !== undefined && prev !== null && prev !== undefined) {
        out[i] = v - prev;
      }
    }
    return out;
  }

  function tiMa(vals, w) {
    var out = [], i, j;
    for (i = 0; i < TICK_DISPLAY_DAYS; i++) out.push(null);
    for (i = 0; i < TICK_DISPLAY_DAYS; i++) {
      if (i + w > vals.length) continue;
      var sum = 0, ok = true;
      for (j = i; j < i + w; j++) {
        if (vals[j] === null || vals[j] === undefined) { ok = false; break; }
        sum += vals[j];
      }
      if (ok) out[i] = sum / w;
    }
    return out;
  }

  // 依目前選的指標,把一條「新到舊」的原始序列換算成該指標的逐日序列
  function tickSeries(vals) {
    if (tickMetric === 'd0_d1') return tiD0D1(vals);
    if (tickMetric === 'ma21') return tiMa(vals, 21);
    if (tickMetric === 'fixed') return tiFixed(vals, tickWindow);
    return tiRolling(vals, tickWindow);
  }

  var TICK_URL = 'data/tick-latest.json';
  var TICK_MEMBERS_URL = 'data/tick-members-latest.json';

  var tickData = null;
  var tickMembers = null;
  var tickLoaded = false;
  var tickMetric = 'd0_d1';
  var tickWindow = 20;
  var tickShowRaw = false;
  var tickOpenGroup = null;      // '產業|層'
  var tickOpenStock = null;      // 展開中的個股代碼

  var TICK_TIERS = ['大', '中', '小'];

  function tickMetricKey() {
    if (tickMetric === 'd0_d1' || tickMetric === 'ma21') return tickMetric;
    return tickMetric + '_' + tickWindow;
  }

  // 染色基準:D0-D1 比 0(今天比昨天),rebase 比 1(等於基期)。
  // MA21 與原始筆數是「水準值」不是「變化量」,恆為正,染色沒有意義 → 不染。
  function tickBaseline() {
    if (tickMetric === 'd0_d1') return 0;
    if (tickMetric === 'ma21') return null;
    return 1;
  }

  function tickFmt(v) {
    if (v === null || v === undefined) return '無資料';
    if (tickMetric === 'd0_d1') return (v > 0 ? '+' : '') + fmtInt(Math.round(v));
    if (tickMetric === 'ma21') return fmtInt(Math.round(v));
    return v.toFixed(3);
  }

  function tickCls(v) {
    var base = tickBaseline();
    if (v === null || v === undefined || base === null) return '';
    if (v > base) return 'up';
    if (v < base) return 'down';
    return '';
  }

  function tickGroupMap() {
    var map = {};
    var rows = (tickData && tickData.rows) || [];
    for (var i = 0; i < rows.length; i++) {
      map[rows[i].industry + '|' + rows[i].cap_tier] = rows[i];
    }
    return map;
  }

  // 後端排好的原始順序(三層 sample_count 加總,多的在前)——renderTick() 拿到
  // 之後會再依「大」這個市值級距當前指標值由大到小重排一次,這裡只負責去重取列表。
  function tickIndustries() {
    var seen = {}, out = [];
    var rows = (tickData && tickData.rows) || [];
    for (var i = 0; i < rows.length; i++) {
      if (!seen[rows[i].industry]) { seen[rows[i].industry] = 1; out.push(rows[i].industry); }
    }
    return out;
  }

  // 後端算好的當日值 vs 前端用同一組公式現算的值,對不上就講出來,
  // 不要讓兩份公式默默走鐘。
  function tickSelfCheck() {
    var rows = (tickData && tickData.rows) || [];
    var checked = 0, bad = [];
    var combos = [['d0_d1', 0], ['ma21', 0], ['fixed', 20], ['fixed', 10], ['fixed', 5],
                  ['rolling', 20], ['rolling', 10], ['rolling', 5]];
    var savedM = tickMetric, savedW = tickWindow;
    for (var i = 0; i < rows.length; i++) {
      var vals = rows[i].series_raw || [];
      for (var c = 0; c < combos.length; c++) {
        tickMetric = combos[c][0];
        tickWindow = combos[c][1] || 20;
        var mine = tickSeries(vals)[0];
        var theirs = rows[i][tickMetricKey()];
        checked++;
        var same = (mine === null || mine === undefined)
          ? (theirs === null || theirs === undefined)
          : (theirs !== null && theirs !== undefined &&
             Math.abs(mine - theirs) <= Math.max(1e-9, Math.abs(theirs) * 1e-9));
        if (!same) bad.push(rows[i].industry + '|' + rows[i].cap_tier + ' ' + tickMetricKey());
      }
    }
    tickMetric = savedM; tickWindow = savedW;
    return { checked: checked, bad: bad };
  }

  function tickCellHtml(row, key) {
    if (!row) return '<td class="num tick-cell tick-none">—</td>';
    var v = row[tickMetricKey()];
    var cls = tickCls(v);
    var under = row.reporting_count < row.sample_count;
    var html = '<td class="num tick-cell' + (row.low_n_flag ? ' low-n' : '') +
      '" data-group="' + esc(key) + '">' +
      '<span class="tick-val ' + cls + '">' + esc(tickFmt(v)) + '</span>' +
      '<span class="tick-n' + (under ? ' n-under' : '') + '">n=' + row.sample_count +
      (under ? '(實報' + row.reporting_count + ')' : '') + '</span>';
    if (tickShowRaw) {
      html += '<span class="tick-raw">' +
        (row.avg_tick_count_raw === null || row.avg_tick_count_raw === undefined
          ? '—' : fmtInt(Math.round(row.avg_tick_count_raw))) + ' 筆</span>';
    }
    return html + '</td>';
  }

  function tickBarsHtml(series, days) {
    var base = tickBaseline();
    var i, max = 0;
    for (i = 0; i < days.length; i++) {
      var v = series[i];
      if (v === null || v === undefined) continue;
      var d = base === null ? v : v - base;
      if (Math.abs(d) > max) max = Math.abs(d);
    }
    var out = '<div class="bars">';
    for (i = 0; i < days.length; i++) {
      var val = series[i];
      var txt = tickFmt(val);
      var w = 0, sign = 'pos';
      if (val !== null && val !== undefined && max > 0) {
        var diff = base === null ? val : val - base;
        w = Math.abs(diff) / max * 50;
        sign = diff < 0 ? 'neg' : 'pos';
      }
      out += '<div class="bar-row">' +
        '<span class="bar-date">' + esc(days[i].slice(5)) + '</span>' +
        '<span class="bar-track">' +
          '<i class="bar-fill ' + sign + '" style="width:' + w.toFixed(1) + '%"></i>' +
        '</span>' +
        '<span class="bar-val ' + tickCls(val) + '">' + esc(txt) + '</span>' +
      '</div>';
    }
    return out + '</div>';
  }

  function tickMembersHtml(key) {
    if (!tickMembers) return '<div class="tick-detail">成員明細載入中…</div>';
    var list = (tickMembers.groups || {})[key];
    if (!list || !list.length) return '<div class="tick-detail">這組沒有凍結成員。</div>';
    var days = tickMembers.days || [];
    var html = '<div class="tick-detail">' +
      '<div class="tick-detail-head">' + esc(key.replace('|', ' · ')) +
      ' 凍結成員 ' + list.length + ' 檔(最新 ' + esc(tickMembers.date || '') + ')</div>' +
      '<table class="member-table"><thead><tr>' +
      '<th>代碼</th><th>名稱</th><th class="num">市值(億)</th>' +
      '<th class="num">當日筆數</th><th class="num">' + esc(tickMetricLabel()) + '</th>' +
      '</tr></thead><tbody>';
    for (var i = 0; i < list.length; i++) {
      var m = list[i];
      var ticks = m.ticks || [];
      var mv = tickSeries(ticks)[0];
      var latest = ticks.length ? ticks[0] : null;
      var open = tickOpenStock === m.code;
      html += '<tr class="member-row' + (open ? ' is-open' : '') +
        '" data-stock="' + esc(m.code) + '">' +
        '<td class="code mono">' + esc(m.code) + '</td>' +
        '<td>' + esc(m.name || '') + '</td>' +
        '<td class="num">' + (m.frozen_cap_yi === null || m.frozen_cap_yi === undefined
            ? '—' : fmtInt(Math.round(m.frozen_cap_yi))) + '</td>' +
        '<td class="num">' + (latest === null || latest === undefined
            ? '—' : fmtInt(latest)) + '</td>' +
        '<td class="num ' + tickCls(mv) + '">' + esc(tickFmt(mv)) + '</td>' +
      '</tr>';
      if (open) {
        html += '<tr class="member-detail-row"><td colspan="5">' +
          tickBarsHtml(tickSeries(ticks), days) + '</td></tr>';
      }
    }
    return html + '</tbody></table></div>';
  }

  function tickMetricLabel() {
    if (tickMetric === 'd0_d1') return 'D0-D1';
    if (tickMetric === 'ma21') return 'MA21';
    return (tickMetric === 'fixed' ? '固定基底' : '滾動基底') + tickWindow;
  }

  function renderTick(res) {
    var meta = el('tick-meta');
    var tbody = el('tick-tbody');

    if (res && res.error) {
      meta.innerHTML = '<span class="warn">' + esc(res.error) + '</span>';
      tbody.innerHTML = '';
      el('tick-table').hidden = true;
      el('tick-controls').hidden = true;
      el('tick-foot').hidden = true;
      return;
    }

    el('tick-table').hidden = false;
    el('tick-controls').hidden = false;
    el('tick-windows').hidden = (tickMetric === 'd0_d1' || tickMetric === 'ma21');

    var p = tickData.params || {};
    meta.textContent = tickData.date + ' 收盤 · ' + tickData.group_count +
      ' 組(產業 × 市值級距),每組最多 ' + (p.sample_target_per_group || '?') +
      ' 檔凍結樣本,序列 ' + ((tickData.days || []).length) + ' 個交易日';

    var map = tickGroupMap();
    var inds = tickIndustries().slice().sort(function (a, b) {
      var ra = map[a + '|大'], rb = map[b + '|大'];
      var va = ra ? ra[tickMetricKey()] : null;
      var vb = rb ? rb[tickMetricKey()] : null;
      if (va === null || va === undefined) return (vb === null || vb === undefined) ? 0 : 1;
      if (vb === null || vb === undefined) return -1;
      return vb - va; // 以「大」這個市值級距當基準,由大排到小
    });
    var html = '';
    for (var i = 0; i < inds.length; i++) {
      var ind = inds[i];
      var lowAll = true;
      for (var t = 0; t < TICK_TIERS.length; t++) {
        var r0 = map[ind + '|' + TICK_TIERS[t]];
        if (r0 && !r0.low_n_flag) lowAll = false;
      }
      html += '<tr class="tick-row' + (lowAll ? ' low-n-row' : '') + '">' +
        '<td class="tick-ind">' + esc(ind) +
        (lowAll ? '<span class="low-note">樣本數低,僅供參考</span>' : '') + '</td>';
      for (t = 0; t < TICK_TIERS.length; t++) {
        var key = ind + '|' + TICK_TIERS[t];
        html += tickCellHtml(map[key], key);
      }
      html += '</tr>';
      if (tickOpenGroup && tickOpenGroup.indexOf(ind + '|') === 0) {
        html += '<tr class="tick-detail-row"><td colspan="4">' +
          tickMembersHtml(tickOpenGroup) + '</td></tr>';
      }
    }
    tbody.innerHTML = html;

    var chk = tickSelfCheck();
    var foot = el('tick-foot');
    foot.hidden = false;
    if (chk.bad.length) {
      foot.className = 'tick-foot warn';
      foot.textContent = '注意:前端公式與後端算出來的當日值有 ' + chk.bad.length +
        ' 格對不上(共比對 ' + chk.checked + ' 格),例如 ' + chk.bad.slice(0, 3).join('、') +
        '。表格內的個股明細是前端現算的,請以後端 JSON 為準。';
    } else {
      foot.className = 'tick-foot';
      foot.textContent = '純觀察用,不是進出場訊號。前端公式已與後端當日值逐格比對一致(' +
        chk.checked + ' 格)。點格子展開凍結成員,再點個股看逐日明細。';
    }
  }

  function loadTickMembers() {
    if (tickMembers) return Promise.resolve(tickMembers);
    return fetch(TICK_MEMBERS_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) { tickMembers = d; return d; });
  }

  function loadTick(force) {
    if (tickLoaded && !force) return;
    el('tick-meta').textContent = '載入中…';

    if (location.protocol === 'file:') {
      renderTick({ error: '用 file:// 直接開啟時,瀏覽器不允許讀取本機 JSON。' +
                          '請用網址開啟(GitHub Pages),或在資料夾裡跑 python3 -m http.server。' });
      return;
    }

    fetch(TICK_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        tickLoaded = true;
        tickData = data;
        renderTick();
      })
      .catch(function (e) {
        renderTick({ error: '讀不到產業流向結果(' + (e.message || e) + ')。' +
                            '每日排程尚未跑過,或檔案還沒產生。' });
      });
  }

  // ------------------------------------------------- 報價快照(持倉與相關係數共用)

  var QUOTES_URL = 'data/quotes-latest.json';
  var quotes = null;          // 原始檔
  var quotesIdx = null;       // code -> 陣列索引
  var quotesPending = null;   // 進行中的請求
  var quotesErr = null;

  function loadQuotes() {
    if (quotes) return Promise.resolve(quotes);
    if (quotesPending) return quotesPending;
    if (location.protocol === 'file:') {
      quotesErr = '用 file:// 直接開啟時,瀏覽器不允許讀取本機 JSON。';
      return Promise.reject(new Error(quotesErr));
    }
    quotesPending = fetch(QUOTES_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (d) {
        quotes = d;
        quotesIdx = {};
        for (var i = 0; i < (d.codes || []).length; i++) quotesIdx[d.codes[i]] = i;
        quotesErr = null;
        quotesPending = null;
        return d;
      })
      .catch(function (e) {
        quotesPending = null;          // 讓下次還能重試
        quotesErr = e.message || String(e);
        throw e;
      });
    return quotesPending;
  }

  /** {code, name, close, prev} 或 null。 */
  function quoteOf(code) {
    if (!quotes || !quotesIdx) return null;
    var i = quotesIdx[String(code || '').trim()];
    if (i == null) return null;
    return {
      code: quotes.codes[i],
      name: quotes.names[i] || '',
      close: quotes.close[i],
      prev: quotes.prev_close[i]
    };
  }

  /**
   * 兩檔的日報酬相關係數。回傳 {rho, n} 或 null(資料不足)。
   * ret_bp 是基點整數,缺值為 null —— 兩邊都要有值那天才算。
   */
  function corrOf(a, b) {
    if (!quotes || !quotesIdx) return null;
    var ia = quotesIdx[a], ib = quotesIdx[b];
    if (ia == null || ib == null) return null;
    var xs = quotes.ret_bp[ia], ys = quotes.ret_bp[ib];
    var px = [], py = [], i;
    for (i = 0; i < Math.min(xs.length, ys.length); i++) {
      if (xs[i] == null || ys[i] == null) continue;
      px.push(xs[i]); py.push(ys[i]);
    }
    var n = px.length;
    if (n < 5) return null;
    var mx = 0, my = 0;
    for (i = 0; i < n; i++) { mx += px[i]; my += py[i]; }
    mx /= n; my /= n;
    var sxy = 0, sxx = 0, syy = 0;
    for (i = 0; i < n; i++) {
      var dx = px[i] - mx, dy = py[i] - my;
      sxy += dx * dy; sxx += dx * dx; syy += dy * dy;
    }
    if (sxx <= 0 || syy <= 0) return null;
    return { rho: sxy / Math.sqrt(sxx * syy), n: n };
  }

  // ------------------------------------------------------------ Kelly 計算

  /**
   * 單筆 Kelly。
   *
   * 本金 C、部位佔比 x、停損幅度 s、目標獲利幅度 w:
   *   贏 → C(1 + x·w)   輸 → C(1 - x·s)
   * 最大化 E[log] 得 x = p/s - q/w,兩邊乘 s 就是「該拿多少比例的本金去冒險」
   *   f_risk = x·s = p - q/R,  R = w/s(賠率)
   * 這是課本 Kelly 的標準式,沒有自創門檻。
   */
  function kellySolo(p, s, w) {
    if (!(p > 0 && p < 1) || !(s > 0) || !(w > 0)) return null;
    var x = p / s - (1 - p) / w;
    return {
      x: x,                       // 部位佔本金比例(可能 > 1,代表要融資才做得到)
      riskFrac: x * s,            // 停損時會虧掉的本金比例
      R: w / s,                   // 賠率
      edge: p * w - (1 - p) * s   // 每投入 1 元的期望報酬
    };
  }

  /**
   * n 筆同時持有時的折減係數。
   *
   * 這就是「拆兩筆買不同產業怎麼算」的答案:不是除以 2。
   * 常態近似下,n 個報酬條件相同、兩兩相關係數為 ρ 的部位,
   * 最適解是每筆 = 單筆Kelly / (1 + (n-1)ρ)。
   *   ρ=1(完全連動,等於同一筆下兩次)→ 除以 n,才是「各半」
   *   ρ=0(完全獨立)→ 不用折,各自下滿,因為一筆爆掉不影響另一筆
   * 台股同產業實測約 0.5~0.75,跨產業約 0.3,防禦股對電子接近 0。
   *
   * 分母設下限,免得 ρ 很負時算出爆炸性的槓桿。
   */
  function corrHaircut(n, rho) {
    if (n <= 1) return 1;
    return Math.max(0.2, 1 + (n - 1) * rho);
  }

  var kMult = 0.5;
  var kLegs = 2;
  var kRho = 0.35;

  var K_DEFAULTS = { code: '', p: '55', s: '8', w: '16' };

  function kLegRowHtml(i, vals) {
    return '' +
      '<div class="k-leg" data-leg="' + i + '">' +
        '<div class="k-leg-head">第 ' + (i + 1) + ' 筆</div>' +
        '<div class="grid2">' +
          '<label class="field"><span class="field-label">股票代號(選填)</span>' +
            '<input type="text" data-kf="code" data-i="' + i + '" inputmode="numeric" ' +
            'autocomplete="off" value="' + esc(vals.code) + '" placeholder="例如 2330"></label>' +
          '<label class="field"><span class="field-label">勝率 %</span>' +
            '<input type="text" data-kf="p" data-i="' + i + '" inputmode="decimal" ' +
            'value="' + esc(vals.p) + '"></label>' +
          '<label class="field"><span class="field-label">停損 %</span>' +
            '<input type="text" data-kf="s" data-i="' + i + '" inputmode="decimal" ' +
            'value="' + esc(vals.s) + '"></label>' +
          '<label class="field"><span class="field-label">目標獲利 %</span>' +
            '<input type="text" data-kf="w" data-i="' + i + '" inputmode="decimal" ' +
            'value="' + esc(vals.w) + '"></label>' +
        '</div>' +
        '<div class="k-leg-info" data-leg-info="' + i + '"></div>' +
      '</div>';
  }

  /** 只在筆數改變時重建輸入框 —— 打字途中絕不重繪,免得輸入被吃掉。 */
  function renderKellyLegs() {
    var old = readKellyLegs();
    var html = '';
    for (var i = 0; i < kLegs; i++) {
      var prev = old[i] || old[old.length - 1] || K_DEFAULTS;
      html += kLegRowHtml(i, {
        code: i < old.length ? prev.code : '',    // 新增的那筆不要複製代號
        p: prev.p, s: prev.s, w: prev.w
      });
    }
    el('k-legs').innerHTML = html;
  }

  function readKellyLegs() {
    var out = [];
    var nodes = el('k-legs').querySelectorAll('.k-leg');
    Array.prototype.forEach.call(nodes, function (node) {
      function v(f) {
        var input = node.querySelector('[data-kf="' + f + '"]');
        return input ? input.value.trim() : '';
      }
      out.push({ code: v('code'), p: v('p'), s: v('s'), w: v('w') });
    });
    return out;
  }

  function num(v) {
    var n = parseFloat(String(v).replace(/,/g, ''));
    return isFinite(n) ? n : null;
  }

  function fmtMoney(n) {
    if (n == null || !isFinite(n)) return '—';
    return fmtInt(Math.round(n));
  }

  function fmtPct(x, digits) {
    if (x == null || !isFinite(x)) return '—';
    return (x * 100).toFixed(digits == null ? 1 : digits) + '%';
  }

  /** 目前這組 leg 的平均兩兩相關係數。 */
  function kellyRho(legs) {
    var codes = [], i, j;
    for (i = 0; i < legs.length; i++) {
      var c = legs[i].code;
      if (c && quoteOf(c)) codes.push(c);
    }
    if (codes.length < 2) return { rho: kRho, source: 'manual', pairs: 0, minN: 0 };
    var sum = 0, pairs = 0, minN = Infinity, missing = 0;
    for (i = 0; i < codes.length; i++) {
      for (j = i + 1; j < codes.length; j++) {
        var r = corrOf(codes[i], codes[j]);
        if (!r) { missing++; continue; }
        sum += r.rho; pairs++;
        if (r.n < minN) minN = r.n;
      }
    }
    if (!pairs) return { rho: kRho, source: 'manual', pairs: 0, minN: 0 };
    return {
      rho: sum / pairs,
      source: 'data',
      pairs: pairs,
      minN: minN === Infinity ? 0 : minN,
      missing: missing,
      codes: codes
    };
  }

  function recalcKelly() {
    var capital = num(el('k-capital').value);
    var legs = readKellyLegs();
    var out = el('k-out');
    var corrBox = el('k-corr');

    // --- 相關係數 ---
    var rhoInfo = kellyRho(legs);
    var rho = rhoInfo.rho;
    var hair = corrHaircut(legs.length, rho);

    if (legs.length < 2) {
      corrBox.innerHTML = '<span class="dim">只有一筆,不需要考慮相關性。</span>';
    } else if (rhoInfo.source === 'data') {
      var pairTxt = rhoInfo.codes.map(function (c) {
        var q = quoteOf(c);
        return esc(c + (q && q.name ? ' ' + q.name : ''));
      }).join('、');
      corrBox.innerHTML =
        '<div><b>實測相關係數 ρ = ' + rho.toFixed(2) + '</b>' +
        '(' + pairTxt + ',' + rhoInfo.pairs + ' 組配對,樣本 ' + rhoInfo.minN + ' 天)</div>' +
        '<div class="dim">每筆折減成單筆 Kelly 的 ' + Math.round(100 / hair) + '%' +
        '(除以 1+(n-1)ρ = ' + hair.toFixed(2) + ')。' +
        'ρ=1 才是「各半」,ρ=0 則各自下滿。</div>' +
        (rhoInfo.minN < 30
          ? '<div class="warn-sm">樣本只有 ' + rhoInfo.minN +
            ' 天,相關係數的誤差約 ±' + (1 / Math.sqrt(rhoInfo.minN)).toFixed(2) +
            ',只能當粗略參考。</div>'
          : '');
    } else {
      corrBox.innerHTML = '<div class="dim">沒有填足兩個查得到的代號,改用下面手動設定的 ρ = ' +
        rho.toFixed(2) + '(折減成 ' + Math.round(100 / hair) + '%)。</div>';
    }
    el('k-rho-row').hidden = (legs.length < 2) || (rhoInfo.source === 'data');

    // --- 每筆 Kelly ---
    var rows = [], i, anyNeg = false;
    for (i = 0; i < legs.length; i++) {
      var L = legs[i];
      var p = num(L.p), s = num(L.s), w = num(L.w);
      var solo = (p == null || s == null || w == null)
        ? null : kellySolo(p / 100, s / 100, w / 100);
      var q = L.code ? quoteOf(L.code) : null;
      var info = el('k-legs').querySelector('[data-leg-info="' + i + '"]');
      if (info) {
        if (L.code && q) {
          info.innerHTML = '<span class="dim">' + esc(q.name) + ' 現價 ' +
            q.close + '(' + esc(quotes.date) + ')</span>';
        } else if (L.code) {
          info.innerHTML = '<span class="warn-sm">查不到 ' + esc(L.code) +
            '(只收錄上市普通股)</span>';
        } else {
          info.innerHTML = '';
        }
      }
      if (solo && solo.x <= 0) anyNeg = true;
      rows.push({ leg: i, solo: solo, s: s, quote: q, code: L.code });
    }

    // --- 折減 + 倍數 + 本金上限 ---
    var total = 0;
    for (i = 0; i < rows.length; i++) {
      var r = rows[i];
      r.x = (r.solo && r.solo.x > 0) ? (r.solo.x / hair) * kMult : 0;
      total += r.x;
    }
    var capped = total > 1;
    var scale = capped ? 1 / total : 1;
    for (i = 0; i < rows.length; i++) rows[i].xFinal = rows[i].x * scale;

    // --- 輸出 ---
    if (capital == null || capital <= 0) {
      out.innerHTML = '<p class="warn">請填本金。</p>';
      return;
    }

    var html = '<table class="k-table"><thead><tr>' +
      '<th>筆</th><th class="num">賠率</th><th class="num">單筆Kelly</th>' +
      '<th class="num">部位金額</th><th class="num">佔本金</th><th class="num">停損時虧</th>' +
      '</tr></thead><tbody>';
    var sumAmt = 0, sumRisk = 0;
    for (i = 0; i < rows.length; i++) {
      var R2 = rows[i];
      var amt = R2.xFinal * capital;
      var risk = R2.s == null ? null : amt * R2.s / 100;
      sumAmt += amt;
      if (risk) sumRisk += risk;
      var label = '第 ' + (i + 1) + ' 筆' +
        (R2.quote ? '<br><span class="dim">' + esc(R2.quote.name) + '</span>' : '');
      if (!R2.solo) {
        html += '<tr><td>' + label + '</td><td colspan="5" class="dim">欄位未填完</td></tr>';
        continue;
      }
      if (R2.solo.x <= 0) {
        html += '<tr><td>' + label + '</td><td class="num">' + R2.solo.R.toFixed(2) +
          '</td><td colspan="4" class="down">沒有優勢(期望值 ' + fmtPct(R2.solo.edge, 2) +
          '),Kelly 建議不進場</td></tr>';
        continue;
      }
      var shares = (R2.quote && R2.quote.close > 0) ? Math.floor(amt / R2.quote.close) : null;
      html += '<tr>' +
        '<td>' + label + '</td>' +
        '<td class="num">' + R2.solo.R.toFixed(2) + '</td>' +
        '<td class="num">' + fmtPct(R2.solo.x, 0) + '</td>' +
        '<td class="num">' + fmtMoney(amt) +
          (shares != null ? '<br><span class="dim">' + fmtInt(shares) + ' 股</span>' : '') +
        '</td>' +
        '<td class="num">' + fmtPct(R2.xFinal, 1) + '</td>' +
        '<td class="num down">' + (risk ? '-' + fmtMoney(risk) : '—') + '</td>' +
      '</tr>';
    }
    html += '</tbody></table>';

    html += '<div class="k-sum">' +
      '<div><span>總部位</span><b>' + fmtMoney(sumAmt) + '</b>' +
        '<span class="dim">(' + fmtPct(sumAmt / capital, 1) + ' 本金)</span></div>' +
      '<div><span>全數停損時</span><b class="down">-' + fmtMoney(sumRisk) + '</b>' +
        '<span class="dim">(' + fmtPct(sumRisk / capital, 1) + ' 本金)</span></div>' +
      '<div><span>留在手上</span><b>' + fmtMoney(Math.max(0, capital - sumAmt)) + '</b></div>' +
    '</div>';

    if (capped) {
      html += '<p class="warn-sm">Kelly 算出來的部位合計是本金的 ' +
        fmtPct(total, 0) + ' —— 停損夠緊時 Kelly 本來就會要求融資。' +
        '這裡不假設你有槓桿,已按比例壓到剛好用完本金。</p>';
    }
    html += '<p class="panel-note">Kelly 假設停損一定在你設的價位成交、勝率與賠率也估得準。' +
      '真實市場會跳空穿過停損,勝率也多半沒有你以為的高 —— ' +
      '這兩件事都會讓實際風險大於上表。</p>';
    if (anyNeg) {
      html += '<p class="warn-sm">有筆數的期望值是負的:勝率 × 目標 小於 敗率 × 停損,' +
        '再怎麼調部位大小都是慢性虧損。</p>';
    }
    out.innerHTML = html;
  }

  // ------------------------------------------------------------ 零股試算

  /**
   * 預算 budget、股價 price 之下買得起幾股(含買進手續費)。
   * fee = max(最低手續費, 成交金額 × 費率 × 折數)
   */
  function oddLotShares(budget, price, ratePct, discount, minFee) {
    if (!(budget > 0) || !(price > 0)) return null;
    var rate = (ratePct / 100) * discount;
    function costOf(n) {
      var v = n * price;
      return v + Math.max(minFee, v * rate);
    }
    var k = Math.floor(budget / price);
    var guard = 0;
    while (k > 0 && costOf(k) > budget && guard++ < 100000) k--;
    if (k <= 0) return { shares: 0, cost: 0, fee: 0, left: budget };
    var v = k * price;
    var fee = Math.max(minFee, v * rate);
    return { shares: k, value: v, fee: fee, cost: v + fee, left: budget - v - fee };
  }

  function recalcOddLot() {
    var budget = num(el('odd-budget').value);
    var price = num(el('odd-price').value);
    var rate = num(el('odd-rate').value);
    var disc = num(el('odd-disc').value);
    var minFee = num(el('odd-min').value);
    var out = el('odd-out');

    if (budget == null || price == null) {
      out.innerHTML = '<p class="dim">填入可花金額與股價。</p>';
      return;
    }
    if (rate == null || disc == null || minFee == null) {
      out.innerHTML = '<p class="warn">手續費欄位要填數字。</p>';
      return;
    }
    var r = oddLotShares(budget, price, rate, disc, minFee);
    if (!r || r.shares <= 0) {
      out.innerHTML = '<p class="warn">這個金額買不到 1 股(含手續費)。</p>';
      return;
    }
    var lots = Math.floor(r.shares / 1000), odd = r.shares % 1000;
    out.innerHTML = '<div class="k-sum">' +
      '<div><span>可買</span><b>' + fmtInt(r.shares) + ' 股</b>' +
        // 不足一張時再寫一次「N 股」只是重複,不顯示
        (lots ? '<span class="dim">' + lots + ' 張 ' + odd + ' 股</span>' : '') + '</div>' +
      '<div><span>股票價金</span><b>' + fmtMoney(r.value) + '</b></div>' +
      '<div><span>手續費</span><b>' + r.fee.toFixed(2) + '</b>' +
        (r.fee <= minFee + 1e-9 ? '<span class="dim">(最低收費)</span>' : '') + '</div>' +
      '<div><span>實際支出</span><b>' + r.cost.toFixed(2) + '</b></div>' +
      '<div><span>剩餘</span><b>' + r.left.toFixed(2) + '</b></div>' +
    '</div>' +
    '<p class="panel-note">賣出時還會有一次手續費加 0.3% 證券交易稅,這裡只算買進。</p>';
  }

  // ------------------------------------------------------------ 部位畫面

  var kellyReady = false;

  function loadKelly() {
    if (kellyReady) { recalcKelly(); recalcOddLot(); return; }
    kellyReady = true;
    renderKellyLegs();
    recalcOddLot();
    el('k-rho-val').textContent = kRho.toFixed(2);

    el('kelly-meta').textContent = '載入報價中…';
    loadQuotes().then(function (d) {
      el('kelly-meta').textContent = d.date + ' 收盤 · 收錄 ' + fmtInt(d.codes.length) +
        ' 檔上市股票,相關係數用最近 ' + Math.max(0, d.days.length - 1) + ' 個交易日的日報酬計算';
      recalcKelly();
    }).catch(function () {
      el('kelly-meta').innerHTML = '<span class="warn">讀不到報價(' + esc(quotesErr || '') +
        ')。Kelly 還是能算,但沒有實測相關係數,請用下面的手動 ρ。</span>';
      recalcKelly();
    });
  }

  // ------------------------------------------------------------ 持倉(下單紀錄)

  // 只是紀錄,不會真的下單。存在同一份 localStorage 的紀錄裡,
  // 匯出備份會一併帶走。
  var EXIT_MODES = ['hold', 'daytrade', 'profit', 'days'];

  function normalizeExitPlan(v) {
    v = (v && typeof v === 'object') ? v : {};
    var mode = EXIT_MODES.indexOf(v.mode) >= 0 ? v.mode : 'hold';
    return {
      mode: mode,
      target_pct: String(v.target_pct == null ? '' : v.target_pct),
      max_days: String(v.max_days == null ? '' : v.max_days),
      max_drawdown_pct: String(v.max_drawdown_pct == null ? '' : v.max_drawdown_pct)
    };
  }

  /** 自動出場當下的快照(觸發規則/假設成交價/當時損益),事後算勝率要用這份,不能用「現在」的報價回推。*/
  function normalizeExitResult(v) {
    if (!v || typeof v !== 'object') return null;
    var rule = ['target', 'days', 'drawdown'].indexOf(v.rule) >= 0 ? v.rule : null;
    if (!rule) return null;
    return {
      date: String(v.date || ''),
      price: Number(v.price) || 0,
      reason: String(v.reason || ''),
      rule: rule,
      pl: Number(v.pl) || 0,
      pl_pct: (v.pl_pct == null || v.pl_pct === '') ? null : Number(v.pl_pct)
    };
  }

  function normalizePositions(v) {
    if (!Array.isArray(v)) return [];
    return v.filter(function (p) { return p && typeof p === 'object'; })
      .map(function (p) {
        return {
          id: p.id ? String(p.id) : uid(),
          date: String(p.date || ''),
          shares: Number(p.shares) || 0,
          price: Number(p.price) || 0,
          fee: Number(p.fee) || 0,
          note: String(p.note || '')
        };
      })
      .filter(function (p) { return p.shares > 0 && p.price > 0; });
  }

  /**
   * 整個持有期間(從最早一筆下單日到報價日)逐日高/低的極值,以及「當時
   * 出場」的假設損益。用來回答「爆量隔天最高點沒賣到,到底少賺多少」——
   * 只看得到高/低,不代表當時真的來得及賣在那個價位。
   * 回傳 {high:{date,price,pl}, low:{date,price,pl}} 或 null(缺報價序列)。
   */
  function positionRangeStats(rec, shares, cost) {
    if (!quotes || !quotesIdx || !shares) return null;
    var i = quotesIdx[String(rec.stock_id || '').trim()];
    if (i == null) return null;
    var highs = quotes.daily_high && quotes.daily_high[i];
    var lows = quotes.daily_low && quotes.daily_low[i];
    var days = quotes.days;
    if (!highs || !lows || !days) return null;

    var earliest = null, k;
    for (k = 0; k < (rec.positions || []).length; k++) {
      var d = rec.positions[k].date;
      if (d && (earliest == null || d < earliest)) earliest = d;
    }
    if (!earliest) return null;

    var bestDate = null, bestPrice = null, worstDate = null, worstPrice = null;
    for (k = 0; k < days.length; k++) {
      if (days[k] < earliest) continue;
      var h = highs[k], l = lows[k];
      if (h != null && (bestPrice == null || h > bestPrice)) { bestPrice = h; bestDate = days[k]; }
      if (l != null && (worstPrice == null || l < worstPrice)) { worstPrice = l; worstDate = days[k]; }
    }
    if (bestPrice == null || worstPrice == null) return null;

    return {
      high: { date: bestDate, price: bestPrice, pl: shares * bestPrice - cost },
      low: { date: worstDate, price: worstPrice, pl: shares * worstPrice - cost }
    };
  }

  /**
   * 從最早一筆下單日到報價日,實際交易日數(用 quotes.days 數,不是日曆天)。
   * quotes.days 只保留 KEEP_DAYS(30)天,持倉超過這個天數的舊倉位會被低估,
   * 這是既有 30 天視窗的限制,不是這裡另外造成的。查不到就回傳 null。
   */
  function heldTradingDays(rec) {
    if (!quotes || !quotes.days) return null;
    var earliest = null, i;
    for (i = 0; i < (rec.positions || []).length; i++) {
      var d = rec.positions[i].date;
      if (d && (earliest == null || d < earliest)) earliest = d;
    }
    if (!earliest) return null;
    var n = 0;
    for (i = 0; i < quotes.days.length; i++) {
      if (quotes.days[i] >= earliest) n++;
    }
    return n;
  }

  /**
   * 出場設定達成狀況。純提醒,不會自動下單 —— 這個 app 沒有接券商 API,
   * 沒辦法真的送出委託。而且資料一天只在排程跑完後更新一次,不是即時
   * 報價,「當沖」模式的目標價判斷用的也是當日收盤/現價快照,不是盤中
   * 逐筆。回傳 alert 陣列(每個 alert 有 hit 是否已觸發)或 null。
   */
  function evalExitPlan(rec, st) {
    var plan = rec.exit_plan;
    if (!plan || !st || !st.priced) return null;
    var alerts = [];

    if ((plan.mode === 'daytrade' || plan.mode === 'profit') && plan.target_pct) {
      var pct = Number(plan.target_pct);
      if (pct > 0 && st.avg > 0) {
        var target = st.avg * (1 + pct / 100);
        alerts.push({
          key: 'target',
          hit: st.close >= target,
          price: target,
          label: (plan.mode === 'daytrade' ? '當沖出場' : '獲利出場') + ' +' + pct + '%',
          detail: '目標價 ' + target.toFixed(2) + '(現價 ' + st.close + ')'
        });
      }
    }

    if (plan.mode === 'days' && plan.max_days) {
      var maxDays = Number(plan.max_days);
      var held = heldTradingDays(rec);
      if (maxDays > 0 && held != null) {
        alerts.push({
          key: 'days',
          hit: held >= maxDays,
          price: st.close,
          label: '持倉上限 ' + maxDays + ' 個交易日',
          detail: '已持有 ' + held + ' 個交易日'
        });
      }
    }

    if (plan.max_drawdown_pct && st.range) {
      var ddPct = Number(plan.max_drawdown_pct);
      var peak = st.range.high.price;
      if (ddPct > 0 && peak > 0) {
        var dd = (st.close - peak) / peak;
        var stopPrice = peak * (1 - ddPct / 100);
        alerts.push({
          key: 'drawdown',
          hit: dd <= -ddPct / 100,
          price: stopPrice,
          label: '最大回撤 -' + ddPct + '%(獨立生效,不受模式影響)',
          detail: '目前回撤 ' + (dd * 100).toFixed(1) + '%(期間高點 ' + peak + ')'
        });
      }
    }

    return alerts.length ? alerts : null;
  }

  /**
   * 出場設定一旦觸發,直接把紀錄轉成「已出場」,不用等使用者手動點。
   * 只在 loadQuotes() 剛載入之後跑一次(quotes 一天只更新一次,不會反覆觸發)。
   *
   * 用觸發當下的目標價/停損價當「假設成交價」記錄下來(見 evalExitPlan 的
   * alert.price),不是用「之後某次打開網頁時」的現價回推 —— 不然勝率統計會
   * 隨著使用者多久沒開網頁而亂跳。多個規則同時觸發時,取第一個命中的。
   *
   * 這不是真的下單,這個 app 沒有接券商 API —— 只是把 app 自己的狀態欄位
   * 改成「已出場」,跟使用者手動點「標記出場」是同一個 rec.status 欄位,
   * 差別只在這裡是自動觸發、且會多存一份 exit_result 快照給勝率統計用。
   */
  function checkAutoExits() {
    var changed = false;
    data.forEach(function (rec) {
      if (rec.status !== 'active') return;
      var st = positionStats(rec);
      if (!st || !st.priced || !st.shares) return;
      var alerts = evalExitPlan(rec, st);
      if (!alerts) return;
      var hit = alerts.filter(function (a) { return a.hit; })[0];
      if (!hit) return;

      var pl = st.shares * hit.price - st.cost;
      rec.exit_result = {
        date: quotes.date, price: hit.price, reason: hit.label,
        rule: hit.key, pl: pl, pl_pct: st.cost > 0 ? pl / st.cost : null
      };
      rec.status = 'exited';
      rec.current_step = 7;
      rec.tracking.unshift({
        date: quotes.date,
        note: '【自動出場】' + hit.label + '(' + hit.detail + '),假設成交價 ' + hit.price.toFixed(2)
      });
      touch(rec);
      changed = true;
      toast('已自動標記出場:' + displayTitle(rec) + '(' + hit.label + ')', 'ok', 5000);
    });
    if (changed) saveAll();
    return changed;
  }

  /**
   * 自動出場紀錄的勝率統計,依觸發規則分組。用 exit_result 這份「觸發當下」
   * 的快照算,不會因為之後報價變動而跑掉。
   */
  function exitStatsHtml() {
    var exited = data.filter(function (r) { return r.exit_result; });
    if (!exited.length) return '';

    var groups = {};
    exited.forEach(function (r) {
      var k = r.exit_result.rule;
      if (!groups[k]) groups[k] = [];
      groups[k].push(r);
    });

    var ruleLabels = { target: '獲利/當沖目標', days: '持倉天數到期', drawdown: '最大回撤停損' };
    var rows = Object.keys(groups).map(function (k) {
      var recs = groups[k];
      var wins = recs.filter(function (r) { return r.exit_result.pl > 0; }).length;
      var avgPct = recs.reduce(function (s, r) { return s + (r.exit_result.pl_pct || 0); }, 0) / recs.length;
      return '<div class="exit-stat-row">' +
        '<span>' + esc(ruleLabels[k] || k) + '</span>' +
        '<span class="mono">N=' + recs.length + '</span>' +
        '<span class="mono">勝率 ' + Math.round(wins / recs.length * 100) + '%</span>' +
        '<span class="mono ' + plClass(avgPct) + '">平均 ' + fmtPct(avgPct, 1) + '</span>' +
      '</div>';
    }).join('');

    var totalWins = exited.filter(function (r) { return r.exit_result.pl > 0; }).length;
    return '<div class="pos-block">' +
      '<div class="pos-head"><span>自動出場統計</span>' +
        '<span class="dim">N=' + exited.length + '、整體勝率 ' +
          Math.round(totalWins / exited.length * 100) + '%</span></div>' +
      '<p class="dim">樣本數還很少(見 CLAUDE.md 已知限制),當參考,不是驗證過的勝率。</p>' +
      '<div class="exit-stats">' + rows + '</div>' +
    '</div>';
  }

  /**
   * 一筆紀錄的持倉損益。沒有報價時 priced 為 false —— 成本仍然算得出來,
   * 但市值與損益一律留 null,不要拿成本當市值假裝沒事。
   */
  function positionStats(rec) {
    var ps = rec.positions || [];
    if (!ps.length) return null;

    var shares = 0, cost = 0, i;
    for (i = 0; i < ps.length; i++) {
      shares += ps[i].shares;
      cost += ps[i].shares * ps[i].price + ps[i].fee;
    }
    var out = {
      count: ps.length, shares: shares, cost: cost,
      avg: shares > 0 ? cost / shares : null,
      priced: false, close: null, value: null, pl: null, plPct: null, today: null,
      range: positionRangeStats(rec, shares, cost)
    };
    var q = quoteOf(rec.stock_id);
    if (!q || !(q.close > 0)) return out;

    out.priced = true;
    out.close = q.close;
    out.value = shares * q.close;
    out.pl = out.value - cost;
    out.plPct = cost > 0 ? out.pl / cost : null;
    if (q.prev > 0) out.today = shares * (q.close - q.prev);
    return out;
  }

  function plClass(v) {
    if (v == null) return '';
    if (v > 0) return 'up';
    if (v < 0) return 'down';
    return '';
  }

  function signed(v) {
    if (v == null) return '—';
    return (v > 0 ? '+' : v < 0 ? '-' : '') + fmtInt(Math.round(Math.abs(v)));
  }

  /** 追蹤畫面頂部:所有還沒出場的紀錄的持倉合計。 */
  var posSummaryExpanded = false;

  /**
   * 每檔分別的明細表。加總數字會把「哪一檔在拉高/拉低」跟「最佳/最差
   * 出場是哪一天」都抹掉,尤其最佳/最差出場本來就是不同檔各自的日期
   * 加總、不是同一天發生的 —— 展開明細才看得回這些細節。
   */
  function renderPosBreakdown(rows) {
    var trs = rows.map(function (r) {
      var rec = r.rec, st = r.st;
      return '<tr>' +
        '<td class="code mono">' + esc(rec.stock_id) + '</td>' +
        '<td>' + esc(rec.stock_name || '') + '</td>' +
        '<td class="num mono">' + fmtMoney(st.cost) + '</td>' +
        '<td class="num mono">' + (st.priced ? fmtMoney(st.value) : '—') + '</td>' +
        '<td class="num mono ' + plClass(st.priced ? st.pl : null) + '">' +
          (st.priced ? signed(st.pl) : '—') + '</td>' +
        '<td class="num mono ' + plClass(st.today) + '">' +
          (st.today != null ? signed(st.today) : '—') + '</td>' +
        '<td class="num mono ' + plClass(st.range && st.range.high.pl) + '">' +
          (st.range ? signed(st.range.high.pl) + ' (' + esc(st.range.high.date) + ')' : '—') + '</td>' +
        '<td class="num mono ' + plClass(st.range && st.range.low.pl) + '">' +
          (st.range ? signed(st.range.low.pl) + ' (' + esc(st.range.low.date) + ')' : '—') + '</td>' +
      '</tr>';
    }).join('');

    return '<div class="table-scroll">' +
      '<table class="scan-table" id="pos-breakdown-table">' +
        '<thead><tr>' +
          '<th>代碼</th><th>名稱</th><th class="num">成本</th><th class="num">市值</th>' +
          '<th class="num">損益</th><th class="num">今日</th>' +
          '<th class="num">最佳出場</th><th class="num">最差出場</th>' +
        '</tr></thead>' +
        '<tbody>' + trs + '</tbody>' +
      '</table>' +
    '</div>';
  }

  function renderPosSummary() {
    var box = el('pos-summary');
    var cost = 0, value = 0, today = 0, n = 0, unpriced = 0, hasToday = false;
    var bestSum = 0, worstSum = 0, hasRange = false, noRange = 0;
    var rows = [];
    for (var i = 0; i < data.length; i++) {
      if (data[i].status === 'rejected') continue;
      var st = positionStats(data[i]);
      if (!st) continue;
      n++;
      cost += st.cost;
      if (st.priced) {
        value += st.value;
        if (st.today != null) { today += st.today; hasToday = true; }
      } else {
        unpriced++;
      }
      if (st.range) {
        bestSum += st.range.high.pl; worstSum += st.range.low.pl; hasRange = true;
      } else {
        noRange++;
      }
      rows.push({ rec: data[i], st: st });
    }
    if (!n) { box.hidden = true; return; }
    box.hidden = false;

    // 有報價不到的個股時,市值與損益只涵蓋得到報價的部分,要講清楚
    var pl = unpriced ? null : value - cost;
    box.innerHTML = '' +
      '<div class="pos-sum-row">' +
        '<div><span>持倉成本</span><b>' + fmtMoney(cost) + '</b></div>' +
        '<div><span>目前市值</span><b>' + (unpriced === n ? '—' : fmtMoney(value)) + '</b></div>' +
        '<div><span>總損益</span><b class="' + plClass(pl) + '">' +
          (pl == null ? '—' : signed(pl)) + '</b></div>' +
        '<div><span>今日(非當下損益)</span><b class="' + plClass(hasToday ? today : null) + '">' +
          (hasToday ? signed(today) : '—') + '</b></div>' +
        '<div><span>持有期間各自最佳出場</span><b class="' + plClass(hasRange ? bestSum : null) + '">' +
          (hasRange ? signed(bestSum) : '—') + '</b></div>' +
        '<div><span>持有期間各自最差出場</span><b class="' + plClass(hasRange ? worstSum : null) + '">' +
          (hasRange ? signed(worstSum) : '—') + '</b></div>' +
      '</div>' +
      '<div class="pos-sum-note">' + n + ' 檔有持倉' +
        (quotes ? ' · 報價 ' + esc(quotes.date) : ' · 尚未載入報價') +
        (unpriced ? ' · ' + unpriced + ' 檔查不到報價,未計入市值' : '') +
        (noRange ? ' · ' + noRange + ' 檔缺逐日高低,未計入最佳/最差出場' : '') +
        (n > 1 ? ' · <button type="button" class="link-btn" id="pos-sum-toggle">' +
          (posSummaryExpanded ? '收合每檔明細 ▲' : '看每檔明細 ▼') + '</button>' : '') +
      '</div>' +
      '<div class="pos-sum-note">最佳/最差出場是「每檔各自在持有期間內的最高/最低點出場」加總,' +
        '不是同一天;只代表當時的高低價曾經出現,不代表真的來得及成交。</div>' +
      (posSummaryExpanded && n > 1 ? renderPosBreakdown(rows) : '');

    var exitBox = el('exit-stats');
    if (exitBox) exitBox.innerHTML = exitStatsHtml();
  }

  var EXIT_MODE_LABELS = {
    hold: '留倉不賣', daytrade: '當沖出場', profit: '獲利出場', days: '持倉天數到期'
  };

  /** 出場設定目前的達成狀況,觸發的用紅色標出來。純提醒,不會自動下單。*/
  function positionAlertsHtml(rec, st, plan) {
    if (plan.mode === 'hold' && !plan.max_drawdown_pct) return '';
    var alerts = evalExitPlan(rec, st);
    if (!alerts) {
      return '<p class="dim">出場設定:' + esc(EXIT_MODE_LABELS[plan.mode]) +
        (plan.max_drawdown_pct ? ' + 最大回撤 -' + esc(plan.max_drawdown_pct) + '%' : '') +
        '(還沒填完數字,或還沒有報價可以判斷)</p>';
    }
    return '<div class="exit-alerts">' + alerts.map(function (a) {
      return '<div class="exit-alert' + (a.hit ? ' is-hit' : '') + '">' +
        '<span>' + (a.hit ? '⚠ ' : '') + esc(a.label) + '</span>' +
        '<span class="dim">' + esc(a.detail) + '</span>' +
      '</div>';
    }).join('') + '</div>';
  }

  /** 出場設定表單,值從 rec.exit_plan 帶入。*/
  function exitPlanFormHtml(plan) {
    var showTarget = plan.mode === 'daytrade' || plan.mode === 'profit';
    var showDays = plan.mode === 'days';
    return '<div class="pos-exit">' +
      '<div class="pos-head"><span>出場設定</span>' +
        '<span class="dim">只是提醒,不會自動下單;資料一天更新一次,不是即時報價</span></div>' +
      '<div class="grid2">' +
        '<label class="field"><span class="field-label">模式</span>' +
          '<select id="exit-mode">' +
            EXIT_MODES.map(function (m) {
              return '<option value="' + m + '"' + (plan.mode === m ? ' selected' : '') + '>' +
                esc(EXIT_MODE_LABELS[m]) + '</option>';
            }).join('') +
          '</select></label>' +
        '<label class="field" id="exit-target-field"' + (showTarget ? '' : ' hidden') + '>' +
          '<span class="field-label">目標漲幅 %(對均價)</span>' +
          '<input type="text" id="exit-target-pct" inputmode="decimal" placeholder="例如 5" value="' +
            esc(plan.target_pct) + '"></label>' +
        '<label class="field" id="exit-days-field"' + (showDays ? '' : ' hidden') + '>' +
          '<span class="field-label">持倉上限(交易日)</span>' +
          '<input type="text" id="exit-max-days" inputmode="numeric" placeholder="例如 10" value="' +
            esc(plan.max_days) + '"></label>' +
        '<label class="field"><span class="field-label">最大回撤 %(選填,獨立生效)</span>' +
          '<input type="text" id="exit-max-drawdown" inputmode="decimal" placeholder="例如 8" value="' +
            esc(plan.max_drawdown_pct) + '"></label>' +
      '</div>' +
      '<button type="button" class="btn btn-block btn-outline" id="exit-save">儲存出場設定</button>' +
    '</div>';
  }

  function positionsHtml(rec) {
    var ps = rec.positions || [];
    var st = positionStats(rec);
    var head = '<div class="pos-head"><span>持倉紀錄</span>' +
      '<span class="dim">只是紀錄,不會真的下單</span></div>';

    var rows = '';
    for (var i = 0; i < ps.length; i++) {
      var p = ps[i];
      var c = p.shares * p.price + p.fee;
      var v = st && st.priced ? p.shares * st.close : null;
      var pl = v == null ? null : v - c;
      rows += '<tr>' +
        '<td class="mono">' + esc(p.date || '—') + '</td>' +
        '<td class="num">' + fmtInt(p.shares) + '</td>' +
        '<td class="num">' + p.price + '</td>' +
        '<td class="num">' + fmtMoney(c) + '</td>' +
        '<td class="num ' + plClass(pl) + '">' + (pl == null ? '—' : signed(pl)) + '</td>' +
        '<td><button type="button" class="track-del" data-del-pos="' + esc(p.id) +
          '" title="刪除這筆">×</button></td>' +
      '</tr>';
    }

    var table = ps.length
      ? '<table class="pos-table"><thead><tr><th>日期</th><th class="num">股數</th>' +
        '<th class="num">成交價</th><th class="num">成本</th><th class="num">損益</th><th></th>' +
        '</tr></thead><tbody>' + rows + '</tbody></table>'
      : '<p class="dim">還沒有下單紀錄。</p>';

    var summary = '';
    if (st) {
      summary = '<div class="k-sum">' +
        '<div><span>總股數</span><b>' + fmtInt(st.shares) + '</b></div>' +
        '<div><span>平均成本</span><b>' + (st.avg == null ? '—' : st.avg.toFixed(2)) + '</b></div>' +
        '<div><span>現價</span><b>' + (st.priced ? st.close : '—') + '</b>' +
          (st.priced && quotes ? '<span class="dim">' + esc(quotes.date) + '</span>' : '') + '</div>' +
        '<div><span>市值</span><b>' + (st.priced ? fmtMoney(st.value) : '—') + '</b></div>' +
        '<div><span>損益</span><b class="' + plClass(st.pl) + '">' + signed(st.pl) +
          (st.plPct == null ? '' : '<span class="dim">' + fmtPct(st.plPct, 1) + '</span>') +
          '</b></div>' +
        '<div><span>今日(非當下損益)</span><b class="' + plClass(st.today) + '">' + signed(st.today) + '</b></div>' +
        '<div><span>期間最高</span><b>' + (st.range ? st.range.high.price : '—') + '</b>' +
          (st.range ? '<span class="dim">' + esc(st.range.high.date) + '</span>' : '') + '</div>' +
        '<div><span>若在最高點出場</span><b class="' + plClass(st.range && st.range.high.pl) + '">' +
          (st.range ? signed(st.range.high.pl) : '—') + '</b></div>' +
        '<div><span>期間最低</span><b>' + (st.range ? st.range.low.price : '—') + '</b>' +
          (st.range ? '<span class="dim">' + esc(st.range.low.date) + '</span>' : '') + '</div>' +
        '<div><span>若在最低點出場</span><b class="' + plClass(st.range && st.range.low.pl) + '">' +
          (st.range ? signed(st.range.low.pl) : '—') + '</b></div>' +
      '</div>';
      if (st.range) {
        summary += '<p class="dim">「期間」指從最早一筆下單日到報價日;高低點只代表當天曾經出現過那個價,' +
          '不代表真的來得及在那個價位成交。</p>';
      }
      if (!st.priced) {
        summary += '<p class="warn-sm">查不到 ' + esc(rec.stock_id || '這檔') +
          ' 的報價(只收錄上市普通股,或報價檔還沒載入),所以只顯示成本。</p>';
      }
    }

    var plan = rec.exit_plan || blankExitPlan();
    var alerts = positionAlertsHtml(rec, st, plan);
    var exitForm = exitPlanFormHtml(plan);

    var todayQuote = quoteOf(rec.stock_id);
    var defaultPrice = (todayQuote && todayQuote.close > 0) ? String(todayQuote.close) : '';
    var form = '<div class="pos-add">' +
      '<div class="grid2">' +
        '<label class="field"><span class="field-label">日期</span>' +
          '<input type="date" id="pos-date" value="' + esc(todayStr()) + '"></label>' +
        '<label class="field"><span class="field-label">股數(1 張 = 1000 股)</span>' +
          '<input type="text" id="pos-shares" inputmode="numeric" placeholder="例如 1000" value="1000"></label>' +
        '<label class="field"><span class="field-label">成交價</span>' +
          '<input type="text" id="pos-price" inputmode="decimal" placeholder="例如 1200" value="' + esc(defaultPrice) + '"></label>' +
        '<label class="field"><span class="field-label">手續費(選填)</span>' +
          '<input type="text" id="pos-fee" inputmode="decimal" placeholder="0"></label>' +
      '</div>' +
      '<p class="dim">股數預設 1000、成交價預設今日收盤價,兩個都可以直接改。</p>' +
      '<button type="button" class="btn btn-block btn-outline" id="pos-add">記錄這筆下單</button>' +
    '</div>';

    return '<div class="pos-block">' + head + summary + alerts + table + form + exitForm + '</div>';
  }

  function renderPositions() {
    var rec = findById(currentId);
    var box = el('detail-positions');
    if (!rec) { box.innerHTML = ''; return; }
    box.innerHTML = positionsHtml(rec);
  }

  var HUNTER_PRICE_ROWS = ['漲', '平', '跌'];
  var HUNTER_VOL_COLS = ['增', '平', '縮'];

  /** 獵人九宮格卡片:3x3 格子 + 目前位置 + ΔP/ρ 數值。*/
  function hunterGridDetailHtml(rec, errMsg) {
    var head = '<h2 class="panel-title">獵人九宮格</h2>' +
      '<p class="panel-note">ρ(MA5V/MA20V)是中期量能趨勢,慢變量;' +
      '中間那排(價平)是過渡態,雜訊高,不單獨當進出場依據。</p>';

    if (errMsg) {
      return '<section class="panel">' + head + '<p class="warn-sm">' + esc(errMsg) + '</p></section>';
    }
    if (!quotes) {
      return '<section class="panel">' + head + '<p class="dim">載入中…</p></section>';
    }

    var hu = hunterOf(rec.stock_id);
    if (!hu) {
      return '<section class="panel">' + head +
        '<p class="dim">查不到 ' + esc(rec.stock_id || '這檔') + ' 的報價資料。</p></section>';
    }
    if (!hu.grid) {
      return '<section class="panel">' + head +
        '<p class="dim">資料天數不足(ρ 需要 20 個交易日的成交量),算不出來。</p></section>';
    }

    var cells = '';
    HUNTER_PRICE_ROWS.forEach(function (p) {
      HUNTER_VOL_COLS.forEach(function (v) {
        var isCur = (p === hu.grid.price && v === hu.grid.vol);
        cells += '<div class="hunter-cell' + (isCur ? ' is-current' : '') + '">' +
          esc(HUNTER_GRID_LABELS[p + v]) + '</div>';
      });
    });

    return '<section class="panel">' + head +
      '<div class="hunter-grid-3x3">' + cells + '</div>' +
      '<div class="k-sum">' +
        '<div><span>目前位置</span><b>' + esc(hu.grid.label) + '</b></div>' +
        '<div><span>ΔP</span><b class="' + plClass(hu.dp) + '">' +
          (hu.dp >= 0 ? '+' : '') + (hu.dp * 100).toFixed(2) + '%</b></div>' +
        '<div><span>ρ</span><b>' + hu.rho.toFixed(2) + '</b></div>' +
        (hu.signal ? '<div><span>今日觸發訊號</span><b>' + hu.signal + ' ' +
          esc(HUNTER_SIGNAL_LABELS[hu.signal]) + '</b></div>' : '') +
      '</div>' +
    '</section>';
  }

  /** 近期六訊號時間軸,受 history 保留天數限制,能回溯幾天就顯示幾天。*/
  function hunterTimelineHtml(rec, errMsg) {
    var head = '<h2 class="panel-title">近期訊號時間軸</h2>';

    if (errMsg) {
      return '<section class="panel">' + head + '<p class="warn-sm">' + esc(errMsg) + '</p></section>';
    }
    if (!quotes) {
      return '<section class="panel">' + head + '<p class="dim">載入中…</p></section>';
    }
    var i = quotesIdx[String(rec.stock_id || '').trim()];
    if (i == null) {
      return '<section class="panel">' + head +
        '<p class="dim">查不到 ' + esc(rec.stock_id || '這檔') + ' 的報價資料。</p></section>';
    }

    var closeArr = quotes.daily_close[i], volArr = quotes.daily_volume[i];
    var maxDay = Math.min(closeArr.length, volArr.length) - 21;   // 六訊號的 S 每天都要 20 天基準
    if (maxDay < 0) {
      return '<section class="panel">' + head +
        '<p class="dim">資料天數不足,目前只有 ' + quotes.days.length +
        ' 天,六訊號至少要 21 天才能算出第一天。</p></section>';
    }

    var items = [];
    for (var d = 0; d <= maxDay; d++) {
      var dp = hunterDeltaP(closeArr, d);
      var s = hunterS(volArr, d);
      var sig = hunterSignal(dp, s);
      if (sig) items.push({ date: quotes.days[d], sig: sig, dp: dp });
    }

    var note = '<p class="panel-note">目前資料只能回溯 ' + (maxDay + 1) +
      ' 個交易日(六訊號每天都要 20 天的成交量基準,受 history 保留天數限制)。</p>';

    if (!items.length) {
      return '<section class="panel">' + head + note +
        '<p class="dim">這段期間沒有觸發任何訊號。</p></section>';
    }

    var rows = items.map(function (it) {
      return '<div class="hunter-signal-item">' +
        '<span class="mono">' + esc(it.date) + '</span>' +
        '<span>' + it.sig + ' ' + esc(HUNTER_SIGNAL_LABELS[it.sig]) + '</span>' +
        '<span class="mono ' + plClass(it.dp) + '">' +
          (it.dp >= 0 ? '+' : '') + (it.dp * 100).toFixed(2) + '%</span>' +
      '</div>';
    }).join('');

    return '<section class="panel">' + head + note +
      '<div class="hunter-signal-list">' + rows + '</div>' +
    '</section>';
  }

  function renderGridDetail() {
    var rec = findById(currentId);
    var box = el('detail-grid');
    if (!rec || !rec.stock_id) { box.innerHTML = ''; return; }
    box.innerHTML = hunterGridDetailHtml(rec) + hunterTimelineHtml(rec);
    if (quotes) return;

    loadQuotes()
      .then(function () {
        if (findById(currentId) === rec) {
          box.innerHTML = hunterGridDetailHtml(rec) + hunterTimelineHtml(rec);
        }
      })
      .catch(function (e) {
        if (findById(currentId) === rec) {
          var msg = '讀不到報價資料(' + (e.message || e) + ')。每日排程尚未跑過,或檔案還沒產生。';
          box.innerHTML = hunterGridDetailHtml(rec, msg) + hunterTimelineHtml(rec, msg);
        }
      });
  }

  /** 融資融券獨立區塊,跟持倉紀錄無關,查不到就照實講,不留白也不裝懂。*/
  function marginDetailHtml(rec, errMsg) {
    var head = '<div class="pos-head"><span>融資融券</span>' +
      '<span class="dim">資料來源 TWSE,只收錄上市普通股</span></div>';

    if (errMsg) {
      return '<section class="panel">' + head + '<p class="warn-sm">' + esc(errMsg) + '</p></section>';
    }
    if (!riskData) {
      return '<section class="panel">' + head + '<p class="dim">載入中…</p></section>';
    }
    var mg = marginOf(rec.stock_id);
    if (!mg) {
      return '<section class="panel">' + head +
        '<p class="dim">查不到 ' + esc(rec.stock_id || '這檔') +
        ' 的融資融券資料(可能不是上市普通股,或資料當天還沒更新)。</p></section>';
    }

    var marginDelta = (mg.margin_today != null && mg.margin_prev != null)
      ? mg.margin_today - mg.margin_prev : null;
    var shortDelta = (mg.short_today != null && mg.short_prev != null)
      ? mg.short_today - mg.short_prev : null;

    return '<section class="panel">' + head +
      '<div class="k-sum">' +
        '<div><span>融資餘額</span><b>' +
          (mg.margin_today != null ? fmtInt(mg.margin_today) : '—') + '</b></div>' +
        '<div><span>融資增減</span><b class="' + plClass(marginDelta) + '">' +
          (marginDelta == null ? '—' : signed(marginDelta)) + '</b></div>' +
        '<div><span>融券餘額</span><b>' +
          (mg.short_today != null ? fmtInt(mg.short_today) : '—') + '</b></div>' +
        '<div><span>融券增減</span><b class="' + plClass(shortDelta) + '">' +
          (shortDelta == null ? '—' : signed(shortDelta)) + '</b></div>' +
        '<div><span>資券互抵</span><b>' + (mg.offset != null ? fmtInt(mg.offset) : '—') + '</b></div>' +
      '</div>' +
    '</section>';
  }

  function renderMarginDetail() {
    var rec = findById(currentId);
    var box = el('detail-margin');
    if (!rec || !rec.stock_id) { box.innerHTML = ''; return; }
    box.innerHTML = marginDetailHtml(rec);
    if (riskData) return;

    loadRiskData()
      .then(function () {
        if (findById(currentId) === rec) box.innerHTML = marginDetailHtml(rec);
      })
      .catch(function (e) {
        if (findById(currentId) === rec) {
          box.innerHTML = marginDetailHtml(rec, '讀不到融資融券資料(' + (e.message || e) + ')。' +
            '每日排程尚未跑過,或檔案還沒產生。');
        }
      });
  }

  function addPosition() {
    var rec = findById(currentId);
    if (!rec) return;
    var shares = num(el('pos-shares').value);
    var price = num(el('pos-price').value);
    var fee = num(el('pos-fee').value);
    if (!(shares > 0)) { toast('股數要大於 0', 'err'); return; }
    if (!(price > 0)) { toast('成交價要大於 0', 'err'); return; }

    rec.positions.push({
      id: uid(),
      date: el('pos-date').value || todayStr(),
      shares: shares,
      price: price,
      fee: fee == null ? 0 : fee,
      note: ''
    });
    rec.updated_at = nowISO();
    if (!saveAll()) return;
    toast('已記錄 ' + fmtInt(shares) + ' 股 @ ' + price);
    renderPositions();
    renderList();
    renderPosSummary();
  }

  function deletePosition(pid) {
    var rec = findById(currentId);
    if (!rec) return;
    dialog({
      title: '刪除這筆下單紀錄?',
      message: '刪掉後不影響其他紀錄,也不影響七步驟的內容。',
      actions: [{ label: '刪除', value: 'del', cls: 'btn-danger' }]
    }).then(function (r) {
      if (r.action !== 'del') return;
      rec.positions = rec.positions.filter(function (p) { return p.id !== pid; });
      rec.updated_at = nowISO();
      if (!saveAll()) return;
      renderPositions();
      renderList();
      renderPosSummary();
    });
  }

  function saveExitPlan() {
    var rec = findById(currentId);
    if (!rec) return;
    var mode = el('exit-mode').value;
    if (EXIT_MODES.indexOf(mode) < 0) mode = 'hold';
    rec.exit_plan = {
      mode: mode,
      target_pct: el('exit-target-pct').value.trim(),
      max_days: el('exit-max-days').value.trim(),
      max_drawdown_pct: el('exit-max-drawdown').value.trim()
    };
    touch(rec);
    if (!saveAll()) return;
    toast('已儲存出場設定', 'ok');
    renderPositions();
  }

  // ---------------------------------------------------------- 事件綁定

  function bind() {
    el('tabs').addEventListener('click', function (e) {
      var tab = e.target.closest('.tab');
      if (!tab) return;
      currentTab = tab.getAttribute('data-tab');
      Array.prototype.forEach.call(el('tabs').children, function (t) {
        t.classList.toggle('is-active', t === tab);
      });
      renderList();
    });

    el('views').addEventListener('click', function (e) {
      var b = e.target.closest('.viewbtn');
      if (b) switchView(b.getAttribute('data-view'));
    });

    bindSwipe();

    el('list').addEventListener('click', function (e) {
      var card = e.target.closest('.card');
      if (card) openDetail(card.getAttribute('data-id'));
    });

    el('pos-summary').addEventListener('click', function (e) {
      if (!e.target.closest('#pos-sum-toggle')) return;
      posSummaryExpanded = !posSummaryExpanded;
      renderPosSummary();
    });

    bindQuickAdd(el('scan-tbody'));
    bindQuickAdd(el('crash-tbody'));
    bindQuickAdd(el('signals-tbody'));
    bindQuickAdd(el('themes-list'));

    el('fomo-tbody').addEventListener('click', function (e) {
      var qa = e.target.closest('.btn-quickadd');
      if (qa) {
        if (qa.disabled) return;
        quickAddTracking(qa.getAttribute('data-qa-code'), qa.getAttribute('data-qa-name'),
          qa.getAttribute('data-qa-note'));
        qa.textContent = '已追蹤';
        qa.disabled = true;
        qa.classList.add('is-added');
        return;
      }
      var tr = e.target.closest('.fomo-row');
      if (!tr || !fomoData) return;
      var id = tr.getAttribute('data-fomo');
      fomoOpen = (fomoOpen === id) ? null : id;
      renderFomo(fomoData);
    });

    bindLookupPanelEvents(lookupPanel);
    bindLookupPanelEvents(lookupScanPanel);
    bindLookupPanelEvents(lookupCrashFomoPanel);

    el('crashfomo-tbody').addEventListener('click', function (e) {
      var qa = e.target.closest('.btn-quickadd');
      if (qa) {
        if (qa.disabled) return;
        quickAddTracking(qa.getAttribute('data-qa-code'), qa.getAttribute('data-qa-name'),
          qa.getAttribute('data-qa-note'));
        qa.textContent = '已追蹤';
        qa.disabled = true;
        qa.classList.add('is-added');
        return;
      }
      var tr = e.target.closest('.fomo-row');
      if (!tr || !crashFomoData) return;
      var id = tr.getAttribute('data-fomo');
      crashFomoOpen = (crashFomoOpen === id) ? null : id;
      renderCrashFomo(crashFomoData);
    });

    el('tick-metrics').addEventListener('click', function (e) {
      var b = e.target.closest('.tchip');
      if (!b || !tickData) return;
      tickMetric = b.getAttribute('data-metric');
      Array.prototype.forEach.call(el('tick-metrics').children, function (c) {
        c.classList.toggle('is-active', c === b);
      });
      renderTick();
    });

    el('tick-windows').addEventListener('click', function (e) {
      var b = e.target.closest('.tchip');
      if (!b || !tickData) return;
      tickWindow = parseInt(b.getAttribute('data-window'), 10);
      Array.prototype.forEach.call(el('tick-windows').querySelectorAll('.tchip'), function (c) {
        c.classList.toggle('is-active', c === b);
      });
      renderTick();
    });

    el('tick-raw').addEventListener('change', function (e) {
      tickShowRaw = !!e.target.checked;
      if (tickData) renderTick();
    });

    el('tick-tbody').addEventListener('click', function (e) {
      if (!tickData) return;

      // 個股逐日明細(在展開的成員表裡)
      var mrow = e.target.closest('.member-row');
      if (mrow) {
        var code = mrow.getAttribute('data-stock');
        tickOpenStock = (tickOpenStock === code) ? null : code;
        renderTick();
        return;
      }

      var cell = e.target.closest('.tick-cell');
      if (!cell) return;
      var key = cell.getAttribute('data-group');
      if (!key) return;
      if (tickOpenGroup === key) {
        tickOpenGroup = null;
        tickOpenStock = null;
        renderTick();
        return;
      }
      tickOpenGroup = key;
      tickOpenStock = null;
      renderTick();                       // 先展開,成員明細到了再補上
      loadTickMembers()
        .then(function () { if (tickOpenGroup === key) renderTick(); })
        .catch(function (err) {
          toast('讀不到成員明細(' + (err.message || err) + ')');
        });
    });

    el('detail-positions').addEventListener('click', function (e) {
      var del = e.target.closest('[data-del-pos]');
      if (del) { deletePosition(del.getAttribute('data-del-pos')); return; }
      if (e.target.closest('#pos-add')) addPosition();
      if (e.target.closest('#exit-save')) saveExitPlan();
    });

    el('detail-positions').addEventListener('change', function (e) {
      if (!e.target.closest('#exit-mode')) return;
      var mode = e.target.value;
      var targetField = el('exit-target-field');
      var daysField = el('exit-days-field');
      if (targetField) targetField.hidden = !(mode === 'daytrade' || mode === 'profit');
      if (daysField) daysField.hidden = (mode !== 'days');
    });

    el('k-capital').addEventListener('input', recalcKelly);
    el('k-legs').addEventListener('input', recalcKelly);

    el('kelly-wrap').addEventListener('click', function (e) {
      var m = e.target.closest('[data-kmult]');
      if (m) {
        kMult = parseFloat(m.getAttribute('data-kmult'));
        Array.prototype.forEach.call(
          el('kelly-wrap').querySelectorAll('[data-kmult]'), function (b) {
            b.classList.toggle('is-active', b === m);
          });
        recalcKelly();
        return;
      }
      var n = e.target.closest('[data-klegs]');
      if (n) {
        kLegs = parseInt(n.getAttribute('data-klegs'), 10);
        Array.prototype.forEach.call(
          el('kelly-wrap').querySelectorAll('[data-klegs]'), function (b) {
            b.classList.toggle('is-active', b === n);
          });
        renderKellyLegs();
        recalcKelly();
      }
    });

    el('k-rho').addEventListener('input', function (e) {
      kRho = parseInt(e.target.value, 10) / 100;
      el('k-rho-val').textContent = kRho.toFixed(2);
      recalcKelly();
    });

    ['odd-budget', 'odd-price', 'odd-rate', 'odd-disc', 'odd-min'].forEach(function (id) {
      el(id).addEventListener('input', recalcOddLot);
    });

    el('btn-new').addEventListener('click', function () { openForm(null); });
    el('btn-delete-all').addEventListener('click', doDeleteAll);
    el('version-continue').addEventListener('click', hideVersionPage);
    el('btn-export').addEventListener('click', exportBackup);
    el('btn-import').addEventListener('click', function () { el('import-file').click(); });
    el('import-file').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      handleImportFile(f);
      e.target.value = ''; // 讓同一個檔案可以再選一次
    });

    el('form-cancel').addEventListener('click', closeForm);
    el('form-save').addEventListener('click', submitForm);
    el('f-stock-id').addEventListener('input', tryAutofillStockName);
    el('f-stock-name').addEventListener('input', function () {
      fStockNameAutofilled = false;   // 使用者自己動手改了,以後代號欄再變也不要蓋掉
    });
    el('f-stock-name').addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); submitForm(); }
    });

    el('detail-back').addEventListener('click', function () {
      autoSave();
      closeDetail();
    });
    el('detail-edit').addEventListener('click', function () { openForm(currentId); });
    el('btn-exit').addEventListener('click', doExit);
    el('btn-reject').addEventListener('click', doReject);
    el('btn-reactivate').addEventListener('click', doReactivate);
    el('btn-delete').addEventListener('click', doDelete);

    el('detail-steps').addEventListener('click', function (e) {
      var rec = findById(currentId);
      if (!rec) return;
      var t = e.target;

      var head = t.closest('[data-toggle]');
      if (head) {
        var n = parseInt(head.getAttribute('data-toggle'), 10);
        autoSave();                               // 收合前先把內容存起來
        openStep = (openStep === n) ? 0 : n;
        renderDetail();
        return;
      }

      var saveBtn = t.closest('[data-save]');
      if (saveBtn) { saveOpenStep(); return; }

      var nextBtn = t.closest('[data-next]');
      if (nextBtn) {
        collectOpenStep(rec);
        rec.current_step = Math.min(7, parseInt(nextBtn.getAttribute('data-next'), 10) + 1);
        touch(rec);
        if (saveAll()) toast('進入第 ' + rec.current_step + ' 步', 'ok');
        openStep = rec.current_step;
        renderDetail();
        return;
      }

      var gotoBtn = t.closest('[data-goto]');
      if (gotoBtn) {
        collectOpenStep(rec);
        rec.current_step = parseInt(gotoBtn.getAttribute('data-goto'), 10);
        touch(rec);
        if (saveAll()) toast('目前步驟改為第 ' + rec.current_step + ' 步', 'ok');
        renderDetail();
        return;
      }

      var chipBtn = t.closest('[data-chip]');
      if (chipBtn) {
        var cs = parseInt(chipBtn.getAttribute('data-chip'), 10);
        var val = chipBtn.getAttribute('data-choice');
        collectOpenStep(rec);
        if (!rec.notes[cs] || typeof rec.notes[cs] !== 'object') rec.notes[cs] = blankChoice();
        var opts = rec.notes[cs].options;
        var at = opts.indexOf(val);
        if (at >= 0) opts.splice(at, 1); else opts.push(val);
        // 只切換這顆按鈕的樣式,不整段重繪 — 重繪會把旁邊正在打字的補充說明換掉。
        chipBtn.classList.toggle('sel', at < 0);
        chipBtn.setAttribute('aria-pressed', at < 0 ? 'true' : 'false');
        touch(rec);
        saveAll();
        return;
      }

      if (t.id === 'track-add') {
        var date = el('track-date').value || todayStr();
        var note = el('track-note').value.trim();
        if (!note) { toast('請先寫點內容再新增', 'err'); return; }
        rec.tracking.unshift({ date: date, note: note });
        touch(rec);
        if (saveAll()) toast('已新增追蹤紀錄', 'ok');
        renderDetail();
        return;
      }

      var delBtn = t.closest('[data-del-track]');
      if (delBtn) {
        var idx = parseInt(delBtn.getAttribute('data-del-track'), 10);
        var item = rec.tracking[idx];
        if (!item) return;
        dialog({
          title: '刪除這筆追蹤紀錄?',
          message: (item.date || '') + '\n' + item.note,
          actions: [{ label: '刪除', value: 'del', cls: 'btn-danger' }]
        }).then(function (res) {
          if (res.action !== 'del') return;
          rec.tracking.splice(idx, 1);
          touch(rec);
          if (saveAll()) toast('已刪除', 'ok');
          renderDetail();
        });
      }
    });

    // 離開輸入框就自動存,手機上不會因為切走而掉資料
    el('detail-steps').addEventListener('focusout', function (e) {
      if (e.target.matches('[data-note], [data-f], [data-choicenote]')) autoSave();
    });

    // 切到背景 / 關閉分頁前,把還沒存的內容落地
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden' && currentId) autoSave();
    });
    window.addEventListener('pagehide', function () { if (currentId) autoSave(); });

    // Esc 關閉最上層畫面
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      if (!el('modal').hidden) return;            // 對話框自己處理
      if (!el('form').hidden) { closeForm(); return; }
      if (!el('detail').hidden) { autoSave(); closeDetail(); }
    });
  }

  // ---------------------------------------------------------- 啟動

  function init() {
    initSplash();
    var probe = storageProbe();
    if (!probe.ok) {
      storageOk = false;
      showStorageBanner(describeStorageError(probe.error) +
        ' 現在填的內容關掉頁面就會不見,請先解決儲存權限,或至少隨時「匯出」保存。');
    }
    data = loadAll();
    bind();
    renderList();
    renderPosSummary();

    // 有持倉才去抓報價 —— 沒持倉的人不用為了首頁多下載一份 130KB
    if (data.some(function (r) { return (r.positions || []).length; })) {
      loadQuotes().then(function () {
        checkAutoExits();             // 出場設定觸發就自動轉已出場,一天跑一次
        renderList();
        renderPosSummary();
        if (currentId) renderPositions();
      }).catch(function () {
        renderPosSummary();          // 讓「尚未載入報價」的提示出現
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
