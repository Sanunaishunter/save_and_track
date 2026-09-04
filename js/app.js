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

  function openForm(id) {
    formEditingId = id || null;
    var rec = id ? findById(id) : null;
    el('form-title').textContent = rec ? '編輯基本資料' : '新增股票';
    el('f-stock-id').value = rec ? rec.stock_id : '';
    el('f-stock-name').value = rec ? rec.stock_name : '';
    el('form').hidden = false;
    el('form').setAttribute('aria-hidden', 'false');
    // 同步對焦。用 setTimeout 延遲對焦會在使用者已經點到別的欄位後才搶走游標。
    el('f-stock-id').focus();
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
    }
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
      touch(rec);
      if (saveAll()) toast('已改回進行中', 'ok');
      renderDetail();
      renderList();
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

  // ---------------------------------------------------------- 匯出 / 匯入

  function exportBackup() {
    if (!data.length) {
      toast('目前沒有資料可以匯出', 'err');
      return;
    }
    var filename = 'stock-pipeline-backup-' + stampStr() + '.json';
    var text;
    try {
      text = JSON.stringify(data, null, 2);
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
      // 容許直接的陣列,或 { data: [...] } 這種包一層的格式。
      if (!Array.isArray(incoming) && incoming && Array.isArray(incoming.data)) incoming = incoming.data;
      if (!Array.isArray(incoming)) {
        toast('備份檔格式不正確:最外層必須是陣列', 'err');
        return;
      }
      var records = incoming.map(normalize);
      confirmImport(records, file.name);
    };
    reader.readAsText(file);
  }

  function confirmImport(records, filename) {
    dialog({
      title: '匯入備份',
      message: '檔案:' + filename + '\n' +
               '備份檔內有 ' + records.length + ' 筆,目前畫面上有 ' + data.length + ' 筆。\n\n' +
               '「覆蓋全部」會刪掉現有資料;「合併」會用相同 id 的備份內容取代現有的,其餘保留。\n' +
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
      tbody.innerHTML = '<tr><td colspan="8" class="scan-empty">當日沒有符合條件的股票</td></tr>';
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
        '<th class="num">純度</th><th>今日訊號</th>' +
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

  // ---------------------------------------------------------- 定期定額統計

  var DCA_URL = 'data/dca-latest.json';
  var dcaLoaded = false;

  function renderDca(res) {
    var meta = el('dca-meta');
    var tbody = el('dca-tbody');

    if (res.error) {
      meta.innerHTML = '<span class="warn">' + esc(res.error) + '</span>';
      tbody.innerHTML = '';
      el('dca-table').hidden = true;
      return;
    }

    el('dca-table').hidden = false;
    meta.textContent = 'TWSE 定期定額交易戶數統計排行月報表 · 抓取於 ' + esc(res.fetched_date) +
      '(來源沒有月份欄位,不代表資料所屬月份) · 前 ' + fmtInt(res.count || 0) + ' 名';

    var rows = res.rows || [];
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="5" class="scan-empty">沒有資料</td></tr>';
      return;
    }

    tbody.innerHTML = rows.map(function (r) {
      return '<tr>' +
        '<td class="num mono">' + fmtInt(r.rank || 0) + '</td>' +
        '<td>' + esc(r.stock_code) + ' ' + esc(r.stock_name || '') + '</td>' +
        '<td class="num mono">' + fmtInt(r.stock_accounts || 0) + '</td>' +
        '<td>' + esc(r.etf_code) + ' ' + esc(r.etf_name || '') + '</td>' +
        '<td class="num mono">' + fmtInt(r.etf_accounts || 0) + '</td>' +
      '</tr>';
    }).join('');
  }

  function loadDca(force) {
    if (dcaLoaded && !force) return;
    var meta = el('dca-meta');
    meta.textContent = '載入中…';

    if (location.protocol === 'file:') {
      renderDca({ error: '用 file:// 直接開啟時,瀏覽器不允許讀取本機 JSON。' +
                         '請用網址開啟(GitHub Pages),或在資料夾裡跑 python3 -m http.server。' });
      return;
    }

    fetch(DCA_URL, { cache: 'no-store' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (data) {
        dcaLoaded = true;
        renderDca(data);
      })
      .catch(function (e) {
        renderDca({ error: '讀不到定期定額統計(' + (e.message || e) + ')。' +
                           '每日排程尚未跑過,或檔案還沒產生。' });
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
    marginRows.sort(function (a, b) { return (b.margin_today || 0) - (a.margin_today || 0); });
    var marginTable = el('risk-margin-table');
    if (marginRows.length) {
      marginTable.hidden = false;
      el('risk-margin-tbody').innerHTML = marginRows.map(function (r) {
        return '<tr>' +
          '<td class="code mono">' + esc(r.code) + '</td>' +
          '<td>' + esc(r.name || '') + '</td>' +
          '<td class="num mono">' + (r.margin_today == null ? '—' : fmtInt(r.margin_today)) + '</td>' +
          '<td class="num mono ' + plClass(r.margin_delta) + '">' +
            (r.margin_delta == null ? '—' : signed(r.margin_delta)) + '</td>' +
          '<td class="num mono">' + (r.short_today == null ? '—' : fmtInt(r.short_today)) + '</td>' +
          '<td class="num mono ' + plClass(r.short_delta) + '">' +
            (r.short_delta == null ? '—' : signed(r.short_delta)) + '</td>' +
        '</tr>';
      }).join('');
    } else {
      marginTable.hidden = true;
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

  function loadRisk(force) {
    loadQuotes().then(renderRiskLimitTable).catch(function () {
      el('risk-limit-table').hidden = true;
    });

    if (force) marketGridData = null;
    loadMarketGrid()
      .then(function (data) { renderMarketGrid(data); })
      .catch(function () { el('market-grid-panel').hidden = true; });

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
      tbody.innerHTML = '<tr><td colspan="6" class="scan-empty">今天沒有股票觸發任何訊號</td></tr>';
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

  function switchView(v) {
    el('track-wrap').hidden = v !== 'track';
    el('tabs').hidden = v !== 'track';
    el('scan-wrap').hidden = v !== 'scan';
    el('fomo-wrap').hidden = v !== 'fomo';
    el('tick-wrap').hidden = v !== 'tick';
    el('kelly-wrap').hidden = v !== 'kelly';
    el('themes-wrap').hidden = v !== 'themes';
    el('dca-wrap').hidden = v !== 'dca';
    el('risk-wrap').hidden = v !== 'risk';
    el('signals-wrap').hidden = v !== 'signals';
    Array.prototype.forEach.call(el('views').children, function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-view') === v);
    });
    if (v === 'scan') loadScan(false);
    if (v === 'fomo') loadFomo(false);
    if (v === 'tick') loadTick(false);
    if (v === 'kelly') loadKelly();
    if (v === 'themes') loadThemes(false);
    if (v === 'dca') loadDca(false);
    if (v === 'risk') loadRisk(false);
    if (v === 'signals') loadSignals(false);
  }

  // ---------------------------------------------------------- 左右滑動切換分頁

  var VIEWS_ORDER = ['track', 'scan', 'fomo', 'tick', 'kelly', 'themes', 'dca', 'risk', 'signals'];

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

    return '<tr class="fomo-detail"><td colspan="4">' +
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
      tbody.innerHTML = '<tr><td colspan="4" class="scan-empty">沒有資料</td></tr>';
      return;
    }

    tbody.innerHTML = res.rows.map(function (r) {
      var row = '<tr class="fomo-row" data-fomo="' + esc(r.stock_id) + '">' +
        '<td class="code mono">' + esc(r.stock_id) + '</td>' +
        '<td>' + esc(r.stock_name || '') + '</td>' +
        '<td class="num ' + scoreClass(r.fomo_score) + '">' + r.fomo_score + '</td>' +
        '<td>' + badges(r) + '</td>' +
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

  // 產業列順序沿用後端排好的順序(三層 sample_count 加總,多的在前)
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
    var inds = tickIndustries();
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

    var form = '<div class="pos-add">' +
      '<div class="grid2">' +
        '<label class="field"><span class="field-label">日期</span>' +
          '<input type="date" id="pos-date" value="' + esc(todayStr()) + '"></label>' +
        '<label class="field"><span class="field-label">股數(1 張 = 1000 股)</span>' +
          '<input type="text" id="pos-shares" inputmode="numeric" placeholder="例如 1000"></label>' +
        '<label class="field"><span class="field-label">成交價</span>' +
          '<input type="text" id="pos-price" inputmode="decimal" placeholder="例如 1200"></label>' +
        '<label class="field"><span class="field-label">手續費(選填)</span>' +
          '<input type="text" id="pos-fee" inputmode="decimal" placeholder="0"></label>' +
      '</div>' +
      '<button type="button" class="btn btn-block btn-outline" id="pos-add">記錄這筆下單</button>' +
    '</div>';

    return '<div class="pos-block">' + head + summary + table + form + '</div>';
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

    el('fomo-tbody').addEventListener('click', function (e) {
      var tr = e.target.closest('.fomo-row');
      if (!tr || !fomoData) return;
      var id = tr.getAttribute('data-fomo');
      fomoOpen = (fomoOpen === id) ? null : id;
      renderFomo(fomoData);
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
    el('btn-export').addEventListener('click', exportBackup);
    el('btn-import').addEventListener('click', function () { el('import-file').click(); });
    el('import-file').addEventListener('change', function (e) {
      var f = e.target.files && e.target.files[0];
      handleImportFile(f);
      e.target.value = ''; // 讓同一個檔案可以再選一次
    });

    el('form-cancel').addEventListener('click', closeForm);
    el('form-save').addEventListener('click', submitForm);
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
