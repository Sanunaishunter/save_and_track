#!/usr/bin/env python3
"""
報價快照:data/quotes-latest.json。

前端有兩個功能要用:
  1. 持倉損益 —— 需要最新收盤價與前一日收盤價(算今日損益)
  2. Kelly 的相關係數 —— 需要日報酬序列,才能算出「兩檔到底連不連動」

檔案用「欄位平行陣列」而不是每檔一個物件,省掉重複的鍵名;日報酬存成
基點整數(100 = +1.00%),1000 檔 × 30 天大約 200KB。基點的四捨五入誤差
是 0.005%,對相關係數的影響遠小於「只有 30 天樣本」本身的誤差。
"""

import datetime as dt
import sys

import common
import tick_indicators

# 與產業流向共用同一個顯示窗口,兩邊看到的天數一致
DAYS = tick_indicators.DISPLAY_DAYS


def load_day(date_str):
    """{stock_id: {"close":.., "high":.., "low":..}}。只留上市普通股。"""
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
            high = row[idx["high"]]
            low = row[idx["low"]]
        except (IndexError, KeyError, TypeError):
            continue
        if close is None or not common.is_listed_common(sid, None):
            continue
        out[sid] = {"close": close, "high": high, "low": low}
    return out


def main():
    all_dates = common.history_dates()
    if not all_dates:
        print("錯誤:data/history 沒有任何資料,請先跑 fetch_prices.py", file=sys.stderr)
        return 1

    dates = list(reversed(all_dates))[:DAYS]      # 新到舊,dates[0] 是最新
    target = dates[0]
    by_day = [load_day(d) for d in dates]

    if not by_day[0]:
        print("錯誤:%s 沒有收盤價" % target, file=sys.stderr)
        return 1

    names = common.read_json(common.NAMES_FILE, {}) or {}

    codes = sorted(by_day[0])
    out_names, close, prev_close, ret_bp = [], [], [], []
    daily_high, daily_low, daily_close = [], [], []
    for code in codes:
        out_names.append(names.get(code) or "")
        close.append(by_day[0][code]["close"])
        prev_rec = by_day[1].get(code) if len(by_day) > 1 else None
        prev_close.append(prev_rec["close"] if prev_rec else None)

        series = []
        for i in range(len(dates) - 1):
            cur = by_day[i].get(code)
            prev = by_day[i + 1].get(code)
            if cur is None or prev is None or prev["close"] == 0:
                series.append(None)
            else:
                series.append(int(round((cur["close"] / prev["close"] - 1.0) * 10000)))
        ret_bp.append(series)

        # 持倉「假設在某天高/低點出場」要用到的逐日 OHLC,跟 ret_bp 同一個
        # 日期範圍(新到舊),缺值(停牌/新股上市前)留 None。
        daily_high.append([(by_day[i].get(code) or {}).get("high") for i in range(len(dates))])
        daily_low.append([(by_day[i].get(code) or {}).get("low") for i in range(len(dates))])
        daily_close.append([(by_day[i].get(code) or {}).get("close") for i in range(len(dates))])

    full = sum(1 for s in ret_bp if all(v is not None for v in s))
    print("== 報價快照 %s ==" % target)
    print("  股票 %d 檔、序列 %d 天(報酬 %d 筆)"
          % (len(codes), len(dates), max(0, len(dates) - 1)))
    print("  報酬序列完整的股票:%d 檔" % full)

    common.write_json(common.QUOTES_FILE, {
        "date": target,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
        "days": dates,
        "note": "ret_bp 是日報酬的基點整數(100 = +1.00%),新到舊,長度 = days-1。"
                "daily_high/daily_low/daily_close 新到舊,長度 = days,缺值(停牌/新股上市前)為 null",
        "codes": codes,
        "names": out_names,
        "close": close,
        "prev_close": prev_close,
        "ret_bp": ret_bp,
        "daily_high": daily_high,
        "daily_low": daily_low,
        "daily_close": daily_close,
    }, compact=True)
    print("已寫入 %s" % common.QUOTES_FILE)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
