#!/usr/bin/env python3
"""
訊號記分板(2026-09-14 加入)。

把系統每天發出、已經 commit 進 repo 的訊號清單全部撈出來:
  data/scans/*.json        爆量        看多(dir +1)
  data/crashes/*.json      暴跌        看空(dir −1)
  data/fomo/*.json         可能會漲    看多;虛漲 看空
  data/crash-fomo/*.json   真跌        看空;虛跌 看多
對每一筆訊號算「訊號日收盤 → 之後 5/10/20 個交易日」的報酬,扣掉同期加權指數
報酬得到超額報酬,命中 = dir × 超額報酬 > 0。這是事前登記(訊號當天就寫進
repo,不能事後改)、全樣本(不挑股票)、不看人為判斷的統計。

分桶(每個訊號類型 × 每個天期都再切一次):
  regime      訊號當天的大盤狀態(系統性賣壓 / 指數跌 / 指數平 / 指數漲)—— 看
              「大盤當閘門」有沒有用
  ma          訊號當天個股的均線狀態(bull / bear / mixed)—— 看「均線合流」有沒有用
  confluence  爆量/暴跌訊號當天 FOMO/暴跌FOMO 有沒有同時看到外資連買/賣 ≥3 天、
              融資連買 ≥3 天 —— 看「籌碼合流」有沒有用
  event       訊號日 ±1 個交易日內有沒有 data/events.json 的事件 —— 事件日會污染統計
  vol_ratio   爆量/暴跌的量比級距(1.5~2 / 2~3 / 3~5 / 5+)—— 給 tune_thresholds 對照

樣本不到 SCORECARD_MIN_N(60)一律標 enough=false,前端顯示成灰色「樣本不足」,
不要拿來下結論——跟 Gate 1 的 N≥60 同一個標準。

價格來自永久存檔(data/archive/prices,沒有的日子退回 data/history),指數來自
data/archive/index.json。存檔剛開始只有 30 天,記分板一開始幾乎全部「樣本不足」,
這是正常的,每天排程多一天樣本就多一天。

用法:python scripts/compute_scorecard.py   → data/scorecard-latest.json
不打任何 API。
"""

import datetime as dt
import os
import statistics
import sys

import common

HORIZONS = (5, 10, 20)
VOL_RATIO_BINS = ((1.5, 2.0, "1.5~2"), (2.0, 3.0, "2~3"), (3.0, 5.0, "3~5"), (5.0, 1e9, "5+"))
# 2026-09-18 加的 20 日乖離率分桶:乖離 = (收盤 − MA20) / MA20 × 100,MA20 含當日
# (跟 common.ma_state() / 前端 priceMaState() 同一個「含當日」定義,不是爆量
# vol_ratio 那種 shift 1)。用有正負號的五桶,看多訊號(爆量/薄股)多半落在正
# 乖離、看空訊號(暴跌)多半落在負乖離,同一組桶兩邊都讀得到。切點 ±5%、±10%
# 是坊間常用的經驗值,這裡只拿來切樣本,不是拿來當訊號;要驗的是「離均線越遠、
# 反著用是不是越強」(價格過度反應後回歸均線),數字出來才算站上驗證過。
BIAS_BINS = ((-1e9, -10.0, "< −10%"), (-10.0, -5.0, "−10 ~ −5%"), (-5.0, 5.0, "−5 ~ +5%"),
             (5.0, 10.0, "+5 ~ +10%"), (10.0, 1e9, "≥ +10%"))

SIGNAL_DEFS = {
    "scan": {"label": "爆量", "dir": 1, "dir_label": "看多"},
    "crash": {"label": "暴跌", "dir": -1, "dir_label": "看空"},
    "fomo_real": {"label": "可能會漲", "dir": 1, "dir_label": "看多"},
    "fomo_fake": {"label": "虛漲", "dir": -1, "dir_label": "看空"},
    "crashfomo_real": {"label": "真跌", "dir": -1, "dir_label": "看空"},
    "crashfomo_fake": {"label": "虛跌", "dir": 1, "dir_label": "看多"},
    # 2026-09-17 使用者要求的寬鬆版(😝):跟 fomo_real/fomo_fake 平行、獨立
    # 累積樣本的第二組判斷,見 scripts/fomo_score.py 的 judge_real_rally_loose()/
    # judge_fake_stock_rally_loose()。只做了 FOMO(可能會漲/虛漲)這一組,
    # 使用者沒有要求暴跌FOMO(真跌/虛跌)也放寬,沒有一起做。
    "fomo_real_loose": {"label": "可能會漲😝", "dir": 1, "dir_label": "看多"},
    "fomo_fake_loose": {"label": "虛漲😝", "dir": -1, "dir_label": "看空"},
    # 2026-09-17 使用者要求的「薄股測試」:爆量掃描同一個公式(vol_ratio>1.5
    # 且收紅),只是鎖定 scan 用 MIN_VOLUME_LOTS(300張)下限濾掉的薄股票,見
    # scripts/compute_thin_scan.py 開頭說明跟 common.py 的 THIN_SCAN_* 常數。
    "thin_scan": {"label": "薄股爆量", "dir": 1, "dir_label": "看多"},
}


# ---------------------------------------------------------------- 讀訊號

def _dated_files(dirpath):
    if not os.path.isdir(dirpath):
        return []
    out = []
    for name in sorted(os.listdir(dirpath)):
        if len(name) == 15 and name.endswith(".json") and name[4] == "-":
            out.append((name[:-5], os.path.join(dirpath, name)))
    return out


def load_signal_instances():
    """回傳 list of dict:{signal, date, stock_id, dir, vol_ratio, foreign_consec, margin_consec}。
    爆量/暴跌的合流資訊從同一天的 FOMO/暴跌FOMO metrics 拿(只有前 60 名有)。"""
    inst = []
    fomo_by_date = {}
    for ds, path in _dated_files(common.FOMO_DIR):
        blob = common.read_json(path) or {}
        rows = blob.get("rows") or []
        fomo_by_date[ds] = {r.get("stock_id"): r for r in rows}
        for r in rows:
            m = r.get("metrics") or {}
            base = {"date": ds, "stock_id": r.get("stock_id"),
                    "foreign_consec": m.get("foreign_consecutive_buy_days"),
                    "margin_consec": m.get("margin_consecutive_buy_days"),
                    "vol_ratio": m.get("vol_ratio")}
            if r.get("is_real_rally"):
                inst.append(dict(base, signal="fomo_real", dir=1))
            if r.get("is_fake_rally"):
                inst.append(dict(base, signal="fomo_fake", dir=-1))
            # 寬鬆版(😝)舊存查檔沒有這兩個欄位,.get() 拿到 None 自然跳過,
            # 從新欄位開始出現的那天起才會累積樣本,跟其他訊號當初上線時一樣。
            if r.get("is_real_rally_loose"):
                inst.append(dict(base, signal="fomo_real_loose", dir=1))
            if r.get("is_fake_rally_loose"):
                inst.append(dict(base, signal="fomo_fake_loose", dir=-1))
    cfomo_by_date = {}
    for ds, path in _dated_files(common.CRASH_FOMO_DIR):
        blob = common.read_json(path) or {}
        rows = blob.get("rows") or []
        cfomo_by_date[ds] = {r.get("stock_id"): r for r in rows}
        for r in rows:
            m = r.get("metrics") or {}
            base = {"date": ds, "stock_id": r.get("stock_id"),
                    "foreign_consec": m.get("foreign_consecutive_sell_days"),
                    "margin_consec": None, "vol_ratio": m.get("vol_ratio")}
            if r.get("is_real_crash"):
                inst.append(dict(base, signal="crashfomo_real", dir=-1))
            if r.get("is_fake_crash"):
                inst.append(dict(base, signal="crashfomo_fake", dir=1))
    for ds, path in _dated_files(common.SCANS_DIR):
        blob = common.read_json(path) or {}
        for r in blob.get("rows") or []:
            f = (fomo_by_date.get(ds) or {}).get(r.get("stock_id")) or {}
            m = f.get("metrics") or {}
            inst.append({"signal": "scan", "date": ds, "stock_id": r.get("stock_id"), "dir": 1,
                         "vol_ratio": r.get("vol_ratio"),
                         "foreign_consec": m.get("foreign_consecutive_buy_days") if f else None,
                         "margin_consec": m.get("margin_consecutive_buy_days") if f else None})
    for ds, path in _dated_files(common.CRASHES_DIR):
        blob = common.read_json(path) or {}
        for r in blob.get("rows") or []:
            f = (cfomo_by_date.get(ds) or {}).get(r.get("stock_id")) or {}
            m = f.get("metrics") or {}
            inst.append({"signal": "crash", "date": ds, "stock_id": r.get("stock_id"), "dir": -1,
                         "vol_ratio": r.get("vol_ratio"),
                         "foreign_consec": m.get("foreign_consecutive_sell_days") if f else None,
                         "margin_consec": None})
    # 薄股測試:跟 scan 同一個公式,只是股票群不同(量<300張),沒有 FOMO
    # 候選池可以查合流資訊(FOMO/暴跌FOMO 只挑前 60 名,薄股票通常不在裡面),
    # foreign_consec/margin_consec 留 None——confluence_label() 看到兩者都是
    # None 會回傳「無合流資料」,不是誤判成「無合流」。
    for ds, path in _dated_files(common.THIN_SCANS_DIR):
        blob = common.read_json(path) or {}
        for r in blob.get("rows") or []:
            inst.append({"signal": "thin_scan", "date": ds, "stock_id": r.get("stock_id"), "dir": 1,
                         "vol_ratio": r.get("vol_ratio"), "foreign_consec": None, "margin_consec": None})
    return inst


# ---------------------------------------------------------------- 分桶依據

def load_index_days():
    blob = common.read_json(common.ARCHIVE_INDEX_FILE) or {}
    days = blob.get("days") or {}
    if not days:
        mg = common.read_json(common.MARKET_GRID_FILE) or {}
        for e in (mg.get("history") or []):
            if e.get("date"):
                days[e["date"]] = e
    return days


def regime_label(index_day):
    if not index_day or index_day.get("idx_close") is None:
        return "無大盤資料"
    gl = index_day.get("grid_label") or ""
    if gl.startswith("系統性賣壓"):
        return "系統性賣壓"
    ps = index_day.get("price_state")
    if ps in ("漲", "平", "跌"):
        return "指數" + ps
    # 回補的舊日子沒有 price_state,用漲跌幅粗分(門檻跟 compute_market_grid 的 delta_idx 0.5% 一致)
    pct = index_day.get("idx_change_pct")
    if pct is None:
        return "無大盤資料"
    if pct >= 0.5:
        return "指數漲"
    if pct <= -0.5:
        return "指數跌"
    return "指數平"


def ma_label(prices, dates, pos, sid):
    closes = []
    for i in range(pos, max(-1, pos - 20), -1):
        closes.append((prices.get(dates[i]) or {}).get(sid, {}).get("close"))
    st = common.ma_state(closes)
    return {"bull": "多頭排列", "bear": "空頭排列", "mixed": "均線糾結"}.get(st["state"]) if st else "無均線資料"


def bias_label(prices, dates, pos, sid):
    """訊號日 20 日乖離率分桶;MA20 不足 20 天回「無均線資料」(跟 ma_label 同一種缺值處理)。"""
    closes = []
    for i in range(pos, max(-1, pos - 20), -1):
        closes.append((prices.get(dates[i]) or {}).get(sid, {}).get("close"))
    st = common.ma_state(closes)
    if not st or not st["ma20"]:
        return "無均線資料"
    bias = (closes[0] - st["ma20"]) / st["ma20"] * 100.0
    for lo, hi, label in BIAS_BINS:
        if lo <= bias < hi:
            return label
    return None


def confluence_label(item):
    if item["signal"] not in ("scan", "crash"):
        return None
    f = item.get("foreign_consec")
    mg = item.get("margin_consec")
    if f is None and mg is None:
        return "無合流資料(不在FOMO前60)"
    fo = (f or 0) >= 3
    ma = (mg or 0) >= 3
    if fo and ma:
        return "外資+融資連續≥3"
    if fo:
        return "外資連續≥3"
    if ma:
        return "融資連續≥3"
    return "無合流"


def load_events():
    blob = common.read_json(common.EVENTS_FILE) or {}
    return [e for e in (blob.get("events") or []) if e.get("date")]


def event_label(events, dates, pos, sid):
    near = set()
    for k in (-1, 0, 1):
        i = pos + k
        if 0 <= i < len(dates):
            near.add(dates[i])
    stock_hit = any(e["date"] in near and e.get("stock_id") == sid for e in events)
    market_hit = any(e["date"] in near and not e.get("stock_id") for e in events)
    if stock_hit:
        return "個股事件±1日"
    if market_hit:
        return "大盤事件±1日"
    return "無事件"


def vol_ratio_label(vr):
    if vr is None:
        return None
    for lo, hi, label in VOL_RATIO_BINS:
        if lo <= vr < hi:
            return label
    return None


# ---------------------------------------------------------------- 報酬與統計

def forward_returns(prices, dates, index_days, pos, sid):
    """回傳 {h: (raw_pct, excess_pct or None)},只包含已到期的天期。"""
    base_day = prices.get(dates[pos]) or {}
    c0 = (base_day.get(sid) or {}).get("close")
    if not c0:
        return {}
    i0 = (index_days.get(dates[pos]) or {}).get("idx_close")
    out = {}
    for h in HORIZONS:
        j = pos + h
        if j >= len(dates):
            continue
        c1 = ((prices.get(dates[j]) or {}).get(sid) or {}).get("close")
        if not c1:
            continue
        raw = (c1 - c0) / c0 * 100.0
        i1 = (index_days.get(dates[j]) or {}).get("idx_close")
        excess = raw - ((i1 - i0) / i0 * 100.0) if (i0 and i1) else None
        out[h] = (raw, excess)
    return out


def summarize(samples, direction):
    """samples: list of (raw, excess)。命中用超額報酬;沒有指數的樣本只算 raw。"""
    raws = [s[0] for s in samples]
    exc = [s[1] for s in samples if s[1] is not None]
    n = len(raws)
    if n == 0:
        return {"n": 0, "enough": False}
    hit_raw = sum(1 for r in raws if direction * r > 0) / float(n)
    out = {
        "n": n,
        "enough": n >= common.SCORECARD_MIN_N,
        "hit_rate_raw": round(hit_raw * 100, 1),
        "avg_raw": round(statistics.fmean(raws), 2),
        "median_raw": round(statistics.median(raws), 2),
    }
    if exc:
        hit = sum(1 for r in exc if direction * r > 0) / float(len(exc))
        out.update({
            "n_excess": len(exc),
            "hit_rate": round(hit * 100, 1),
            "avg_excess": round(statistics.fmean(exc), 2),
            "median_excess": round(statistics.median(exc), 2),
        })
    else:
        out.update({"n_excess": 0, "hit_rate": None, "avg_excess": None, "median_excess": None})
    return out


def _bucket_add(buckets, kind, label, h, sample):
    if label is None:
        return
    buckets.setdefault(kind, {}).setdefault(label, {}).setdefault(h, []).append(sample)


def summarize_with_fade(samples, direction):
    """
    2026-09-17 使用者要求把 scripts/backtest_signal_fade.py 探測過的「反著用」
    命中率也放進記分板本體,前端才能不用重跑 CLI 就顯示「訊號反用」分頁。
    跟 backtest_signal_fade.py 的 fade_summary() 同一套算法(直接抄,不重寫):
    同一批樣本,原本方向 summarize() 一次、方向相反再 summarize() 一次——
    hit_rate/hit_rate_raw 是真的用相反方向重算(不是 100%−原命中率,因為
    excess 剛好等於 0 的樣本兩邊都不算命中);avg_excess/avg_raw 本身不分方向,
    是「預期報酬」= 方向 × 平均超額報酬 這樣換算出來的,反著做自然是正負號
    相反。只用在頂層 horizons(5/10/20 日),不下探到 buckets——buckets organized
    by regime 等細節分桶的反著用比較留給 backtest_signal_fade.py 探索用,
    避免記分板本體資料量爆炸。
    """
    st = summarize(samples, direction)
    fade_st = summarize(samples, -direction)
    st["fade_hit_rate"] = fade_st.get("hit_rate")
    st["fade_hit_rate_raw"] = fade_st.get("hit_rate_raw")
    if st.get("avg_excess") is not None:
        st["pnl"] = round(direction * st["avg_excess"], 2)
        st["fade_pnl"] = round(-st["pnl"], 2)
    else:
        st["pnl"] = None
        st["fade_pnl"] = None
    return st


def build_scorecard(instances, prices, dates, index_days, events):
    pos_of = {d: i for i, d in enumerate(dates)}
    per_signal = {}
    for it in instances:
        sig = it["signal"]
        entry = per_signal.setdefault(sig, {"instances": 0, "skipped_no_price": 0, "pending_20d": 0,
                                            "by_h": {h: [] for h in HORIZONS}, "buckets": {},
                                            "first_date": None, "last_date": None})
        entry["instances"] += 1
        d = it["date"]
        entry["first_date"] = d if entry["first_date"] is None or d < entry["first_date"] else entry["first_date"]
        entry["last_date"] = d if entry["last_date"] is None or d > entry["last_date"] else entry["last_date"]
        pos = pos_of.get(d)
        if pos is None:
            entry["skipped_no_price"] += 1
            continue
        fr = forward_returns(prices, dates, index_days, pos, it["stock_id"])
        if not fr:
            entry["skipped_no_price"] += 1
            continue
        if 20 not in fr:
            entry["pending_20d"] += 1
        reg = regime_label(index_days.get(d))
        mal = ma_label(prices, dates, pos, it["stock_id"])
        bil = bias_label(prices, dates, pos, it["stock_id"])
        conf = confluence_label(it)
        evl = event_label(events, dates, pos, it["stock_id"])
        vrl = vol_ratio_label(it.get("vol_ratio")) if sig in ("scan", "crash", "thin_scan") else None
        for h, sample in fr.items():
            entry["by_h"][h].append(sample)
            _bucket_add(entry["buckets"], "regime", reg, h, sample)
            _bucket_add(entry["buckets"], "ma", mal, h, sample)
            _bucket_add(entry["buckets"], "bias", bil, h, sample)
            _bucket_add(entry["buckets"], "confluence", conf, h, sample)
            _bucket_add(entry["buckets"], "event", evl, h, sample)
            _bucket_add(entry["buckets"], "vol_ratio", vrl, h, sample)

    signals_out = {}
    for sig, entry in per_signal.items():
        sdef = SIGNAL_DEFS[sig]
        direction = sdef["dir"]
        horizons = {str(h): summarize_with_fade(entry["by_h"][h], direction) for h in HORIZONS}
        buckets = {}
        for kind, groups in entry["buckets"].items():
            buckets[kind] = {}
            for label, by_h in groups.items():
                buckets[kind][label] = {str(h): summarize(by_h.get(h, []), direction) for h in HORIZONS}
        signals_out[sig] = {
            "label": sdef["label"], "direction": sdef["dir_label"], "dir": direction,
            "instances": entry["instances"], "skipped_no_price": entry["skipped_no_price"],
            "pending_20d": entry["pending_20d"],
            "first_date": entry["first_date"], "last_date": entry["last_date"],
            "horizons": horizons, "buckets": buckets,
        }
    return signals_out


def main():
    prices, dates = common.load_archive_prices()
    if not dates:
        print("錯誤:沒有任何價格資料(data/archive/prices 或 data/history)", file=sys.stderr)
        return 1
    index_days = load_index_days()
    events = load_events()
    instances = load_signal_instances()
    signals = build_scorecard(instances, prices, dates, index_days, events)

    result = {
        "date": dates[-1],
        "generated_at": dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "params": {
            "horizons": list(HORIZONS), "min_n": common.SCORECARD_MIN_N,
            "hit_definition": "dir × (個股報酬 − 加權指數同期報酬) > 0;hit_rate_raw 是不扣指數的版本",
            "bucket_kinds": {"regime": "訊號日大盤狀態", "ma": "訊號日個股均線狀態",
                             "bias": "訊號日 20 日乖離率(含當日 MA20),五桶有正負號",
                             "confluence": "爆量/暴跌當天 FOMO 籌碼合流", "event": "事件日 ±1 個交易日",
                             "vol_ratio": "量比級距(只有爆量/暴跌)"},
        },
        "coverage": {"price_days": len(dates), "price_from": dates[0], "price_to": dates[-1],
                     "index_days": len(index_days), "instances": len(instances),
                     "events": len(events)},
        "signals": signals,
        "note": ("事前登記、全樣本統計。樣本不到 60 的格子 enough=false,只能看方向感,不能"
                 "下結論。存檔剛開始只有 30 天,20 日天期一開始幾乎沒有到期樣本,每天會多一天。"),
    }
    common.write_json(common.SCORECARD_FILE, result)

    print("== 訊號記分板 %s:價格 %d 天、訊號 %d 筆 ==" % (dates[-1], len(dates), len(instances)))
    for sig, s in signals.items():
        line = "  %-8s %-6s 筆數 %4d" % (sig, s["label"], s["instances"])
        for h in HORIZONS:
            st = s["horizons"][str(h)]
            line += "  | %2dd n=%-3d 命中 %s%% 超額 %s" % (
                h, st["n"], st.get("hit_rate"), st.get("avg_excess"))
        print(line)
    return 0


if __name__ == "__main__":
    sys.exit(main())
