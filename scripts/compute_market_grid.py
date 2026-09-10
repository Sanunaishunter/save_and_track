#!/usr/bin/env python3
"""
大盤九宮格 + 法人融資交叉分析 + 市場情緒 + 拉積盤偵測 + 大盤 30 日追蹤表:
data/market-grid-latest.json。

跟七步驟/爆量/FOMO/產業流向/部位/持倉/Kelly/題材分類/籌碼風險其他區塊都無關的
獨立疊加分析,使用者要求放進「籌碼/風險」分頁。純觀察型,不是 SH2 核心交易系統的
一部分,不產生任何進出場訊號,也不影響任何既有邏輯。跟個股獵人九宮格是平行但獨立
的功能,參數不共用(見 spec:大盤波動天生被市值加權壓縮,門檻比個股窄)。

2026-09-10 改版:原本 ΔP_idx/Turnover/漲跌家數都是「只算今天、不存歷史」——
ΔP_idx 靠 FMTQIK(只回兩個交易日),Turnover/漲跌家數是拿 data/history 的個股
資料自己加總近似出來的,不是真正的指數本身、也不是官方數字。使用者看到籌碼分頁
標「拉積盤」提醒後,想要一張「大盤 30 日追蹤表」,逼我們把這幾個問題一次解決:

  - probe 確認(scripts/probe_market_index_history.py,結論見 data/README.md)
    MI_INDEX?date=&type=ALL 除了個股報價表,還有大盤指數本身的收盤(「發行量
    加權股價指數」那一列)、官方成交金額/股數/筆數、官方漲跌家數——這支 API
    是日期可定址的,個股回補資料本來就在用,現在拿來回補大盤這幾個數字一樣可行。
  - **TWSE 的日報表沒有公布指數的開高低,只有收盤**——這是官方資料本身的限制,
    不是這支腳本漏抓,問過使用者後決定開高低留空,不硬湊。
  - 官方成交金額/漲跌家數比原本自己近似算的準,改用官方數字(使用者確認)。
  - 法人買賣超(T86)本來就是逐日可定址的 API,一併回補。融資餘額/增減沒有
    官方的「大盤總額」歷史資料源(risk-latest.json 的 margin dict 只有今日/
    前日快照),**維持只有「今天」有值**,history 裡舊的日子這個欄位是 null,
    不是漏算。

三個輸入,除了新增的官方指數/成交/漲跌數字,原本這三個仍然可用:
  - **融資餘額與增減**:沿用 risk-latest.json 的 margin dict 逐檔加總,
    今日/前日都在同一份快照裡,不用歷史累積,只有「今天」這格有值。

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

import argparse
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
KEEP_DAYS = common.KEEP_DAYS  # 30,跟 data/history 同一個視窗長度,方便對照

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


def load_close_by_code(date_str):
    """{stock_id: close}。只留上市普通股,跟 compute_quotes.py 同一套規則。
    法人買賣超金額估算要用當天收盤價,回補歷史日期時需要那天的 data/history。"""
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
        except (IndexError, KeyError, TypeError):
            continue
        if close is not None and common.is_listed_common(sid, None):
            out[sid] = close
    return out


def institutional_net_for_date(date_str, errors):
    """T86 法人買賣超金額(外資+投信,用淨股數 × 當日收盤價估算),
    跟 FOMO 既有的估算法一致。close_by_code 拿不到就整天回傳 None
    (那天的 data/history 可能還沒抓到)。"""
    close_by_code = load_close_by_code(date_str)
    if not close_by_code:
        return None
    try:
        ymd = date_str.replace("-", "")
        _t86_date, per_stock, _totals = twse_api.institutional_by_date(
            ymd, keep=lambda c: common.is_listed_common(c, None))
    except twse_api.TWSEError as e:
        errors.append("法人買賣超抓取失敗(%s):%r" % (date_str, e))
        return None
    if not per_stock:
        return None
    total = 0.0
    got = False
    for code, rec in per_stock.items():
        close = close_by_code.get(code)
        if close is None:
            continue
        total += (rec.get("foreign") or 0.0) * close
        total += (rec.get("trust") or 0.0) * close
        got = True
    return total if got else None


def fetch_index_day(date_str, errors):
    """單一交易日的官方指數/成交/漲跌家數快照。抓不到回傳全 None 的 dict,
    不中斷其他日期的回補。"""
    out = {
        "date": date_str, "idx_close": None, "idx_change": None, "idx_change_pct": None,
        "turnover_amount": None, "advancing_count": None, "declining_count": None,
        "unchanged_count": None,
    }
    try:
        snap = twse_api.market_index_by_date(date_str.replace("-", ""))
    except twse_api.TWSEError as e:
        errors.append("大盤指數抓取失敗(%s):%r" % (date_str, e))
        return out
    if not snap:
        return out
    out["idx_close"] = snap.get("idx_close")
    out["idx_change"] = snap.get("idx_change")
    out["idx_change_pct"] = snap.get("idx_change_pct")
    out["turnover_amount"] = snap.get("turnover_amount")
    out["advancing_count"] = snap.get("advancing")
    out["declining_count"] = snap.get("declining")
    out["unchanged_count"] = snap.get("unchanged")
    return out


def derive_grid_fields(entry, turnover_series_from_here):
    """依單一日期的 idx_change_pct(不需要歷史視窗)算 price_state/breadth_ratio/
    is_lajiban;volume_state/grid_label 需要 MA5/MA20 的 Turnover 歷史視窗,
    視窗不夠長就留 None(隨著 history 累積會自然補上,不是錯誤)。
    turnover_series_from_here:從這一天(含)往舊排的 turnover_amount 序列。"""
    dp = entry["idx_change_pct"] / 100.0 if entry["idx_change_pct"] is not None else None
    p_state = price_state(dp)

    ma5 = avg_window(turnover_series_from_here, TURNOVER_MA_SHORT)
    ma20 = avg_window(turnover_series_from_here, TURNOVER_MA_LONG)
    rho = (ma5 / ma20) if (ma5 is not None and ma20) else None
    v_state = vol_state(rho)
    grid_label = GRID_LABELS.get((p_state, v_state)) if (p_state and v_state) else None

    adv, dec = entry["advancing_count"], entry["declining_count"]
    breadth_ratio = (adv / dec) if (adv is not None and dec) else None
    is_lajiban = None
    if p_state is not None and breadth_ratio is not None:
        is_lajiban = bool(p_state == "漲" and breadth_ratio < 1)

    entry["delta_p_idx"] = dp
    entry["rho_idx"] = rho
    entry["price_state"] = p_state
    entry["volume_state"] = v_state
    entry["grid_label"] = grid_label
    entry["breadth_ratio"] = breadth_ratio
    entry["is_lajiban"] = is_lajiban


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backfill-days", type=int, default=0,
                     help="額外回補過去幾個交易日的大盤 30 日追蹤史(0 = 只算今天,"
                          "第一次想馬上看到滿的 30 天可以填 29)")
    args = ap.parse_args()

    all_dates = common.history_dates()
    if not all_dates:
        print("錯誤:data/history 沒有任何資料,請先跑 fetch_prices.py", file=sys.stderr)
        return 1

    n = 1 + max(0, args.backfill_days)
    target_dates = all_dates[-n:]  # 舊到新,只取最近 n 個交易日
    target = target_dates[-1]

    errors = []

    # 先抓官方指數/成交/漲跌家數 + 法人買賣超(依日期定址,可回補)
    fetched_by_date = {}
    for d in target_dates:
        entry = fetch_index_day(d, errors)
        entry["institutional_net"] = institutional_net_for_date(d, errors)
        fetched_by_date[d] = entry

    # 跟舊檔案裡存的 history 合併——同一天以這次抓到的為準(可能是補值),
    # 沒有重抓到的舊日子照樣保留,一起裁到 KEEP_DAYS。這樣即使今天沒有
    # backfill,history 也會逐日累積長滿,不用每次都指定 backfill-days。
    old = common.read_json(common.MARKET_GRID_FILE) or {}
    merged_by_date = {}
    for e in (old.get("history") or []):
        if isinstance(e, dict) and e.get("date"):
            merged_by_date[e["date"]] = e
    merged_by_date.update(fetched_by_date)

    history = sorted(merged_by_date.values(), key=lambda e: e["date"], reverse=True)[:KEEP_DAYS]

    # 依日期新到舊算 grid 欄位,每一天用「這天(含)往舊」的 turnover 序列
    # 當 MA5/MA20 視窗——序列本身也是新到舊,天然對得上。
    turnover_all = [e.get("turnover_amount") for e in history]
    for i, e in enumerate(history):
        derive_grid_fields(e, turnover_all[i:])

    today = history[0] if history else {}

    # 融資餘額:沿用 risk-latest.json 已經抓好的逐檔快照,今日/前日都在裡面。
    # 沒有歷史來源,只有「今天」這格有值。
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

    cross_signal = cross_signal_level = None
    if (today.get("price_state") == "漲" and today.get("volume_state") == "增"
            and today.get("institutional_net") is not None and margin_delta_pct is not None):
        buy = today["institutional_net"] > 0
        surge = margin_delta_pct > MARGIN_SURGE_PCT
        cross_signal, cross_signal_level = CROSS_SIGNAL[(buy, surge)]

    sentiment_series = [e.get("advancing_count") for e in history]
    sentiment_ma5 = avg_window(sentiment_series, SENTIMENT_MA_DAYS)

    out = {
        "date": target,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "note": "純觀察型疊加分析,不是 SH2 核心交易系統的一部分,不產生進出場訊號,"
                "所有 flag 都還沒經過 Gate 1 驗證(N>=60 pre-registered predictions)。"
                "指數開高低 TWSE 日報表沒有公布,只有收盤,history 裡沒有這兩個欄位不是漏抓。",
        "params": {
            "delta_idx": DELTA_IDX, "eps_idx": EPS_IDX,
            "margin_surge_pct": MARGIN_SURGE_PCT,
            "sentiment_low": SENTIMENT_LOW, "sentiment_high": SENTIMENT_HIGH,
        },
        # 今日快照,欄位名稱跟改版前一致,前端既有的「今日九宮格」區塊不用改
        "idx_close": today.get("idx_close"),
        "idx_change": today.get("idx_change"),
        "delta_p_idx": today.get("delta_p_idx"),
        "turnover": today.get("turnover_amount"),
        "turnover_days": sum(1 for t in turnover_all if t is not None),
        "rho_idx": today.get("rho_idx"),
        "price_state": today.get("price_state"),
        "volume_state": today.get("volume_state"),
        "grid_label": today.get("grid_label"),
        "institutional_net": today.get("institutional_net"),
        "margin_total": margin_total,
        "margin_delta": margin_delta,
        "margin_delta_pct": margin_delta_pct,
        "cross_signal": cross_signal,
        "cross_signal_level": cross_signal_level,
        "advancing_count": today.get("advancing_count"),
        "declining_count": today.get("declining_count"),
        "unchanged_count": today.get("unchanged_count"),
        "sentiment_ma5": sentiment_ma5,
        "sentiment_days": min(len(sentiment_series), SENTIMENT_MA_DAYS),
        "breadth_ratio": today.get("breadth_ratio"),
        "is_lajiban": today.get("is_lajiban"),
        # 大盤 30 日追蹤表:新到舊,每天一筆,見 derive_grid_fields() 註解——
        # 沒有 idx_open/idx_high/idx_low(TWSE 沒公布),institutional_net
        # 之外的法人/融資欄位只有 history[0](今天)有值。
        "history": history,
        "errors": errors,
    }

    common.write_json(common.MARKET_GRID_FILE, out, compact=True)
    print("== 大盤九宮格 %s(history %d 天,回補 %d 天)==" % (target, len(history), args.backfill_days))
    print("  ΔP_idx=%s ρ_idx=%s grid=%s" % (today.get("delta_p_idx"), today.get("rho_idx"), today.get("grid_label")))
    print("  上漲 %s / 下跌 %s / 平盤 %s,情緒 MA5=%s"
          % (today.get("advancing_count"), today.get("declining_count"), today.get("unchanged_count"), sentiment_ma5))
    print("  法人買賣超(約)=%s 融資增減=%s 交叉=%s"
          % (today.get("institutional_net"), margin_delta, cross_signal))
    print("  拉積盤警訊=%s" % today.get("is_lajiban"))
    print("已寫入 %s" % common.MARKET_GRID_FILE)
    return 1 if today.get("idx_close") is None else 0


if __name__ == "__main__":
    raise SystemExit(main())
