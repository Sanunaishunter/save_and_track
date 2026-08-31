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
      tbody.innerHTML = '<tr><td colspan="4" class="scan-empty">當日沒有符合條件的股票</td></tr>';
      return;
    }

    tbody.innerHTML = res.rows.map(function (r) {
      var chg = r.change_pct;
      var chgCls = chg == null ? '' : (chg >= 0 ? 'up' : 'down');
      var chgTxt = chg == null ? '—' : (chg > 0 ? '+' : '') + chg.toFixed(2) + '%';
      return '<tr>' +
        '<td class="code mono">' + esc(r.stock_id) + '</td>' +
        '<td>' + esc(r.stock_name || '') + '</td>' +
        '<td class="num ratio">' + Number(r.vol_ratio).toFixed(2) + '</td>' +
        '<td class="num ' + chgCls + '">' + chgTxt + '</td>' +
      '</tr>';
    }).join('');
  }

  function loadScan(force) {
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
        renderScan(data);
      })
      .catch(function (e) {
        renderScan({ error: '讀不到掃描結果(' + (e.message || e) + ')。' +
                            '每日排程尚未跑過,或檔案還沒產生。' });
      });
  }

  function switchView(v) {
    var isScan = v === 'scan';
    el('scan-wrap').hidden = !isScan;
    el('track-wrap').hidden = isScan;
    el('tabs').hidden = isScan;
    Array.prototype.forEach.call(el('views').children, function (b) {
      b.classList.toggle('is-active', b.getAttribute('data-view') === v);
    });
    if (isScan) loadScan(false);
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

    el('list').addEventListener('click', function (e) {
      var card = e.target.closest('.card');
      if (card) openDetail(card.getAttribute('data-id'));
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
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
