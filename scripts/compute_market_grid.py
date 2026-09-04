#!/usr/bin/env python3
"""
大盤九宮格 + 法人融資交叉分析 + 市場情緒 + 拉積盤偵測:data/market-grid-latest.json。

跟七步驟/爆量/FOMO/產業流向/部位/持倉/Kelly/券商/定期定額/籌碼風險其他區塊都無關的
獨立疊加分析,使用者要求放進「籌碼/風險」分頁。純觀察型,不是 SH2 核心交易系統的
一部分,不產生任何進出場訊號,也不影響任何既有邏輯。跟個股獵人九宮格是平行但獨立
的功能,參數不共用(見 spec:大盤波動天生被市值加權壓縮,門檻比個股窄)。

四個輸入全部已經在現有 pipeline 抓得到,不需要新的資料源,不需要碰 FinMind,
更不需要碰 SH2:

  - 加權指數(算 ΔP_idx):twse_api.market_summary()(FMTQIK),risk-latest.json
    已經在抓,但那支 API 實測只回最近兩個交易日 —— 剛好夠算 ΔP_idx(只需要
    t 對 t-1),不需要更長的序列
  - 大盤成交值(算 ρ_idx 用的 Turnover):**不用** FMTQIK 的 trade_value(只有
    兩天,算不出 MA20),改成用 data/history 既有的全市場「Σ 收盤價×成交量」
    自己加總 —— 這正是 spec 自己給的 Turnover 定義,而且 data/history 現有
    KEEP_DAYS=30 天,不用等新資料長出來就有滿的 MA5/MA20
  - 上漲/下跌/平盤家數(市場情緒溫度計、拉積盤 breadth_ratio):同樣用
    data/history 比較連續兩天的收盤價自己算,不用任何新資料源。這也直接
    回答了 spec 第 8 節的疑問(要不要接 finmind.db)—— 不用,本地資料就有
  - 法人買賣超金額:twse_api.institutional_by_date()(T86),FOMO 的
    compute_fomo.py 已經在打同一支 API,這裡獨立再打一次(T86 免費、無額度
    限制,不像 FinMind 要省)。用淨股數 × 當日收盤價估算金額,跟 FOMO 既有
    的估算法一致(dataset 沒有金額欄位,顯示一律標「約」)
  - 融資餘額與增減:沿用 risk-latest.json 的 margin dict 逐檔加總,今日/前日
    都在同一份快照裡,不用歷史累積

門檻常數(spec 沒給精確值的,集中在這裡管理,方便之後調):
  - DELTA_IDX=0.5%、EPS_IDX=12.5%(spec 給 10~15% 範圍,先取中間)
  - MARGIN_SURGE_PCT=2%(spec 只說「融資餘額變化超過門檻」沒給數字,先用
    這個當預設,之後 Hugo 用歷史資料回測校準)
  - SENTIMENT_LOW/HIGH=300/600(spec 明講是舊經驗值,標記 [REVIEW],做成
    可調參數,不寫死判讀邏輯)
  - 拉積盤門檻用 spec 明確定案的最保守版本 breadth_ratio<1,不套用任何
    查無依據的百分比

抓失敗的個別來源不擋其他計算,對應欄位留 null,記進 errors。
"""

import datetime as dt
import sys

import common
import twse_api

DELTA_IDX = 0.005
EPS_IDX = 0.125
MARGIN_SURGE_PCT = 0.02
SENTIMENT_LOW = 300
SENTIMENT_HIGH = 600
TURNOVER_MA_SHORT = 5
TURNOVER_MA_LONG = 20
SENTIMENT_MA_DAYS = 5

GRID_LABELS = {
    ("漲", "增"): "資金行情啟動:全面性買盤湧入,多頭趨勢確立",
    ("漲", "平"): "指數漲量平:慣性上漲,續漲力道存疑",
    ("漲", "縮"): "指數漲量縮:無量上攻,慎防假突破或權值股獨撐",
    ("平", "增"): "指數平量增:盤面內部大量換手但指數不動,通常是產業輪動劇烈,"
                  "建議連結到既有的產業流向觀察,本頁不重複做這層分析",
    ("平", "平"): "指數平量平:完全觀望",
    ("平", "縮"): "指數平量縮:交投清淡,變盤前兆",
    ("跌", "增"): "系統性賣壓:全面性恐慌出逃,融資斷頭連動風險高,最需要提防的格",
    ("跌", "平"): "指數跌量平:緩跌,賣壓延續",
    ("跌", "縮"): "指數跌量縮:無量下跌,可能落底或流動性枯竭",
}

# (法人買超, 融資暴增) -> (顯示文字, 警示等級)
CROSS_SIGNAL = {
    (True, False): ("法人主導的健康多頭", "healthy"),
    (True, True): ("法人散戶同步進場,過熱但動能可能延續,建議同時看當沖比重", "caution"),
    (False, True): ("散戶FOMO獨撐,法人退場,強弩之末警訊", "alert"),
    (False, False): ("可能是拉積盤情境,資金沒有真的進來", "watch"),
}


def load_day(date_str):
    """{stock_id: {close, volume}}。只留上市普通股,跟 compute_quotes.py 同一套規則。"""
    blob = common.read_json(common.history_path(date_str))
    if not blob:
        return {}
    cols = blob.get("columns") or common.COLUMNS
    idx = {name: i for i, name in enumerate(cols)}
    out = {}
    for row in blob.get("rows") or []:
        try:
            sid = row[idx["id"]]
            close = row[idx["close"]]
            volume = row[idx["volume"]]
        except (IndexError, KeyError, TypeError):
            continue
        if close is None or not common.is_listed_common(sid, None):
            continue
        out[sid] = {"close": close, "volume": volume}
    return out


def avg_window(seq, n):
    """前 n 格的平均,長度不夠或窗內有缺值(all-or-nothing)一律回傳 None。"""
    if len(seq) < n:
        return None
    window = seq[:n]
    if any(v is None for v in window):
        return None
    return sum(window) / n


def price_state(dp):
    if dp is None:
        return None
    if dp > DELTA_IDX:
        return "漲"
    if dp < -DELTA_IDX:
        return "跌"
    return "平"


def vol_state(rho):
    if rho is None:
        return None
    if rho > 1 + EPS_IDX:
        return "增"
    if rho < 1 - EPS_IDX:
        return "縮"
    return "平"


def main():
    all_dates = common.history_dates()
    if not all_dates:
        print("錯誤:data/history 沒有任何資料,請先跑 fetch_prices.py", file=sys.stderr)
        return 1

    dates = list(reversed(all_dates))      # 新到舊
    target = dates[0]
    by_day = [load_day(d) for d in dates]
    if not by_day[0]:
        print("錯誤:%s 沒有收盤價" % target, file=sys.stderr)
        return 1

    errors = []

    # Turnover 自算(Σ close×volume),不用 FMTQIK 的 trade_value(只有兩天)
    turnover_series = []
    for day in by_day:
        vals = [rec["close"] * rec["volume"] for rec in day.values()
                if rec.get("close") is not None and rec.get("volume") is not None]
        turnover_series.append(sum(vals) if vals else None)

    # 上漲/下跌/平盤家數:比較連續兩天收盤價,day i 對 day i+1
    adv_series, dec_series, unch_series = [], [], []
    for i in range(len(dates) - 1):
        cur, prev = by_day[i], by_day[i + 1]
        adv = dec = unch = 0
        for code, rec in cur.items():
            p = prev.get(code)
            if not p or rec.get("close") is None or p.get("close") is None:
                continue
            if rec["close"] > p["close"]:
                adv += 1
            elif rec["close"] < p["close"]:
                dec += 1
            else:
                unch += 1
        adv_series.append(adv)
        dec_series.append(dec)
        unch_series.append(unch)

    ma5_to = avg_window(turnover_series, TURNOVER_MA_SHORT)
    ma20_to = avg_window(turnover_series, TURNOVER_MA_LONG)
    rho_idx = (ma5_to / ma20_to) if (ma5_to is not None and ma20_to) else None

    sentiment_ma5 = avg_window(adv_series, SENTIMENT_MA_DAYS)
    advancing_count = adv_series[0] if adv_series else None
    declining_count = dec_series[0] if dec_series else None
    unchanged_count = unch_series[0] if unch_series else None

    # 加權指數:FMTQIK 只回最近兩個交易日,ΔP_idx 只需要 t 對 t-1,夠用
    idx_close = idx_change = delta_p_idx = None
    try:
        market = twse_api.market_summary()
        if market:
            idx_close = market[0]["taiex"]
            idx_change = market[0]["change"]
            if len(market) > 1 and market[1]["taiex"]:
                delta_p_idx = (idx_close - market[1]["taiex"]) / market[1]["taiex"]
    except twse_api.TWSEError as e:
        msg = "大盤指數抓取失敗:%r" % (e,)
        errors.append(msg)
        print("!! %s" % msg, file=sys.stderr)

    # 融資餘額:沿用 risk-latest.json 已經抓好的逐檔快照,今日/前日都在裡面
    risk = common.read_json(common.RISK_FILE) or {}
    margin = risk.get("margin") or {}
    margin_today_vals = [v["margin_today"] for v in margin.values() if v.get("margin_today") is not None]
    margin_prev_vals = [v["margin_prev"] for v in margin.values() if v.get("margin_prev") is not None]
    margin_total = sum(margin_today_vals) if margin_today_vals else None
    margin_prev_total = sum(margin_prev_vals) if margin_prev_vals else None
    margin_delta = None
    if margin_total is not None and margin_prev_total is not None:
        margin_delta = margin_total - margin_prev_total
    margin_delta_pct = (margin_delta / margin_prev_total) if (margin_delta is not None and margin_prev_total) else None

    # 法人買賣超金額:T86,用淨股數 × 今日收盤價估算,跟 FOMO 既有估算法一致
    institutional_net = None
    try:
        ymd = target.replace("-", "")
        _t86_date, per_stock, _totals = twse_api.institutional_by_date(
            ymd, keep=lambda c: common.is_listed_common(c, None))
        if per_stock:
            today_close = by_day[0]
            total = 0.0
            got = False
            for code, rec in per_stock.items():
                close = (today_close.get(code) or {}).get("close")
                if close is None:
                    continue
                total += (rec.get("foreign") or 0.0) * close
                total += (rec.get("trust") or 0.0) * close
                got = True
            institutional_net = total if got else None
    except twse_api.TWSEError as e:
        msg = "法人買賣超抓取失敗:%r" % (e,)
        errors.append(msg)
        print("!! %s" % msg, file=sys.stderr)

    p_state = price_state(delta_p_idx)
    v_state = vol_state(rho_idx)
    grid_label = GRID_LABELS.get((p_state, v_state)) if (p_state and v_state) else None

    cross_signal = cross_signal_level = None
    if p_state == "漲" and v_state == "增" and institutional_net is not None and margin_delta_pct is not None:
        buy = institutional_net > 0
        surge = margin_delta_pct > MARGIN_SURGE_PCT
        cross_signal, cross_signal_level = CROSS_SIGNAL[(buy, surge)]

    breadth_ratio = (advancing_count / declining_count) if declining_count else None
    is_lajiban = None
    if p_state is not None and breadth_ratio is not None:
        is_lajiban = bool(p_state == "漲" and breadth_ratio < 1)

    out = {
        "date": target,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "note": "純觀察型疊加分析,不是 SH2 核心交易系統的一部分,不產生進出場訊號,"
                "所有 flag 都還沒經過 Gate 1 驗證(N>=60 pre-registered predictions)。",
        "params": {
            "delta_idx": DELTA_IDX, "eps_idx": EPS_IDX,
            "margin_surge_pct": MARGIN_SURGE_PCT,
            "sentiment_low": SENTIMENT_LOW, "sentiment_high": SENTIMENT_HIGH,
        },
        "idx_close": idx_close,
        "idx_change": idx_change,
        "delta_p_idx": delta_p_idx,
        "turnover": turnover_series[0] if turnover_series else None,
        "turnover_days": sum(1 for t in turnover_series if t is not None),
        "rho_idx": rho_idx,
        "price_state": p_state,
        "volume_state": v_state,
        "grid_label": grid_label,
        "institutional_net": institutional_net,
        "margin_total": margin_total,
        "margin_delta": margin_delta,
        "margin_delta_pct": margin_delta_pct,
        "cross_signal": cross_signal,
        "cross_signal_level": cross_signal_level,
        "advancing_count": advancing_count,
        "declining_count": declining_count,
        "unchanged_count": unchanged_count,
        "sentiment_ma5": sentiment_ma5,
        "sentiment_days": min(len(adv_series), SENTIMENT_MA_DAYS),
        "breadth_ratio": breadth_ratio,
        "is_lajiban": is_lajiban,
        "errors": errors,
    }

    common.write_json(common.MARKET_GRID_FILE, out, compact=True)
    print("== 大盤九宮格 %s ==" % target)
    print("  ΔP_idx=%s ρ_idx=%s grid=%s" % (delta_p_idx, rho_idx, grid_label))
    print("  上漲 %s / 下跌 %s / 平盤 %s,情緒 MA5=%s"
          % (advancing_count, declining_count, unchanged_count, sentiment_ma5))
    print("  法人買賣超(約)=%s 融資增減=%s 交叉=%s"
          % (institutional_net, margin_delta, cross_signal))
    print("  拉積盤警訊=%s" % is_lajiban)
    print("已寫入 %s" % common.MARKET_GRID_FILE)
    return 1 if idx_close is None else 0


if __name__ == "__main__":
    raise SystemExit(main())
